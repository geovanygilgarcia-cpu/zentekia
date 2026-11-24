/*
  WhatsApp entrante (fase 2 omnicanal).

  1. POST /v1/wa/<proveedor>/<canal>: se valida la firma con el secreto del canal y se responde 200 de inmediato.
  2. Cada mensaje se procesa en el ConversationDO del contacto (idFromName(`${tenant}:wa:${canal}:${número}`)):
     uno a la vez por contacto, así dos mensajes seguidos no crean dos conversaciones ni dos respuestas.
     Spec 8.3 pide una cola (Cloudflare Queues, plan de pago); el DO cumple el mismo papel de serializar
     y desacoplar el webhook del procesamiento.
  3. Deduplicación por id de WhatsApp (ux_msg_channel): los reintentos del BSP no duplican mensajes.
  4. Estados de entrega (sent, delivered, read, failed) actualizan messages.delivery_status y avisan a la bandeja.
*/
import type { Env } from '../env'
import { ChannelRepo, channelById, type ChannelRow } from '../db/channel-repo'
import { PlatformRepo } from '../db/platform-repo'
import { TenantRepo } from '../db/tenant-repo'
import { budgetAllows, checkThresholds } from '../billing/meter'
import { generateReply } from '../models/reply'
import { analyzeConversation } from '../leads/analyze'
import { onHandoff } from '../tools'
import { mergedTheme, withinHours } from '../widget-theme'
import { aiAllowed, aiTurnsSinceEscalation, asksForHuman, closedElsewhere, contactCenterOn, escalate, inboxEvent, inboxSettings, type EscalationReason } from '../inbox/core'
import { json } from '../lib/http'
import { channelCreds, sendTextToContact, webhookSecret } from './outbound'
import { connectorFor, digits, type WaInbound } from './whatsapp'

const WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_BODY = 1_000_000
const MAX_MEDIA = 10 * 1024 * 1024

const CHANNEL_HINT =
  '[CANAL: WHATSAPP]\nEstás respondiendo por WhatsApp: mensajes cortos, sin tablas ni encabezados. Para resaltar usa *texto*. Escribe las ligas completas.'

/** Webhook del BSP (público; se valida la firma con el secreto del canal) */
export async function handleWaWebhook(env: Env, request: Request, ctx: ExecutionContext, provider: string, channelId: string): Promise<Response> {
  const conn = connectorFor(provider)
  const ch = /^[0-9a-f-]{36}$/.test(channelId) ? await channelById(env.DB, channelId) : null
  if (!conn || !ch || ch.provider !== provider) return json({ error: { code: 'not_found', message: 'No encontrado.' } }, 404)
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return json({ error: { code: 'too_large' } }, 413)
  const raw = await request.text()
  if (raw.length > MAX_BODY) return json({ error: { code: 'too_large' } }, 413)
  const secret = await webhookSecret(env, ch)
  if (!secret || !(await conn.verify(env, request.headers, raw, secret))) return json({ error: { code: 'signature', message: 'Firma inválida.' } }, 401)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: { code: 'invalid_json' } }, 400)
  }
  const events = conn.parse(body)
  ctx.waitUntil(dispatchEvents(env, ctx, ch, events).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'wa_events', tenant_id: ch.tenant_id, channel_id: ch.id, error: e instanceof Error ? e.message : String(e) }))))
  return json({ ok: true })
}

async function dispatchEvents(env: Env, ctx: ExecutionContext, ch: ChannelRow, events: ReturnType<NonNullable<ReturnType<typeof connectorFor>>['parse']>) {
  const repo = new ChannelRepo(env.DB, ch.tenant_id)
  for (const ev of events) {
    if (ev.kind === 'status') {
      // Una cuenta de YCloud puede tener varios números: solo los de este canal
      if (ev.from && ev.from !== ch.phone) continue
      const hit = await repo.updateDelivery([ev.id, ev.altId ?? ''], ev.status)
      if (hit) await inboxEvent(env, ch.tenant_id, 'message.status', { conversation_id: hit.conversation_id, message_id: hit.id, status: ev.status })
      if (ev.status === 'failed' && ev.error) await repo.update(ch.id, { last_error: `Un mensaje no se entregó: ${ev.error}`.slice(0, 300) })
      continue
    }
    if (ev.to && ev.to !== ch.phone) continue
    if (!ev.from) continue
    if (env.CONVERSATION_DO) {
      const stub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(`${ch.tenant_id}:wa:${ch.id}:${ev.from}`))
      await stub.fetch('https://do/process', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tenant': ch.tenant_id }, body: JSON.stringify({ kind: 'wa_inbound', tenant_id: ch.tenant_id, channel_id: ch.id, event: ev }) })
    } else {
      await processInbound(env, ctx, ch.tenant_id, ch.id, ev)
    }
  }
}

/** Un mensaje del contacto. Lo llama el ConversationDO del contacto, uno a la vez. */
export async function processInbound(env: Env, ctx: ExecutionContext, tenantId: string, channelId: string, ev: WaInbound) {
  const platform = new PlatformRepo(env.DB)
  const tenant = await platform.tenantById(tenantId)
  const chRepo = new ChannelRepo(env.DB, tenantId)
  const ch = await chRepo.get(channelId)
  if (!tenant || !ch) return
  const repo = new TenantRepo(env.DB, tenantId)
  const agent = await repo.agent(ch.agent_id)
  if (!agent) return

  const phone = digits(ev.from)
  const visitor = `wa:${phone}`
  let conv = await chRepo.openConversation(ch.id, visitor)
  let fresh = false
  if (!conv) {
    const id = crypto.randomUUID()
    await repo.createConversation({ id, agent_id: agent.id, visitor_id: visitor, origin: `whatsapp:+${ch.phone}`, country: null, channel: 'whatsapp', started_at: Math.min(ev.at, Date.now()) })
    await chRepo.attach(id, ch.id, { phone, name: ev.name })
    conv = await chRepo.openConversation(ch.id, visitor)
    fresh = true
    if (!conv) return
  }
  const msgId = crypto.randomUUID()
  const inserted = await chRepo.insertInbound({ id: msgId, conversation_id: conv.id, content: ev.text.slice(0, 4000) || '(vacío)', channel_message_id: ev.id, created_at: Math.min(ev.at, Date.now()), media_json: ev.media ? JSON.stringify({ ...ev.media, link: null }) : null })
  if (!inserted) {
    // Reintento del BSP: ya se procesó
    if (fresh) await repo.deleteConversation(conv.id)
    return
  }
  await chRepo.renewWindow(conv.id, ev.at + WINDOW_MS)
  await chRepo.update(ch.id, { last_inbound_at: Date.now() })
  if (ev.media) ctx.waitUntil(storeMedia(env, ch, conv.id, msgId, ev).catch((e) => console.error('wa_media', e)))

  // La cuenta suspendida no contesta (el mensaje queda guardado)
  if (tenant.status === 'suspended') return

  // Con una persona (o esperándola) la IA no responde: solo se avisa a la bandeja
  if (conv.status === 'waiting_human' || conv.status === 'human_active') {
    await inboxEvent(env, tenantId, 'message.created', { conversation_id: conv.id, message_id: msgId })
    return
  }
  if (fresh) await inboxEvent(env, tenantId, 'conversation.created', { conversation_id: conv.id })

  const reply = async (text: string) => {
    const id = crypto.randomUUID()
    await repo.insertMessage({ id, conversation_id: conv!.id, role: 'assistant', content: text, tokens_in: 0, tokens_out: 0, model_id: null, estimated: 0, sources_json: null })
    await sendTextToContact(env, tenantId, { ...conv!, channel: 'whatsapp', channel_id: ch.id }, id, text).catch(() => {})
  }

  const w = await repo.widgetForAgent(agent.id)
  const theme = w ? mergedTheme(w) : null
  if (theme && !withinHours(theme)) return reply(theme.offline_message)

  const s = inboxSettings(agent)
  const portalBase = undefined
  // Sin IA (número del contact center o cliente sin agentes virtuales): directo a la cola de personas
  if (!aiAllowed(tenant, agent)) {
    if (contactCenterOn(env, tenant)) await escalate(env, ctx, tenant, agent, conv.id, 'direct', { portalBase })
    return
  }
  if (s.enabled && contactCenterOn(env, tenant)) {
    let reason: EscalationReason | null = null
    if (asksForHuman(ev.text, s)) reason = 'keyword'
    else if (!fresh && s.max_ai_turns > 0 && (await aiTurnsSinceEscalation(env.DB, tenantId, conv)) >= s.max_ai_turns) reason = 'max_turns'
    if (reason) {
      const r = await escalate(env, ctx, tenant, agent, conv.id, reason, { portalBase })
      if (r.escalated && r.status !== 'ai_active') return
    }
  }

  if (!(await budgetAllows(repo, tenant))) {
    ctx.waitUntil(checkThresholds(env, repo, tenant).catch(() => {}))
    return reply('Por ahora no puedo responder. Te contactaremos en cuanto sea posible.')
  }

  let r: Awaited<ReturnType<typeof generateReply>>
  try {
    r = await generateReply(env, tenant, agent, repo, conv.id, ev.text, CHANNEL_HINT)
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', msg: 'wa_model_error', tenant_id: tenantId, error: e instanceof Error ? e.message : String(e) }))
    await repo.addAlert('provider_error', new Date().toISOString().slice(0, 10), 'El modelo no pudo responder un mensaje de WhatsApp. Revisa la configuración en la sección Modelo.').catch(() => {})
    const t = theme?.error_message
    if (t) await reply(t)
    return
  }
  await sendTextToContact(env, tenantId, { ...conv, channel: 'whatsapp', channel_id: ch.id }, r.messageId, r.content).catch(() => {})
  await inboxEvent(env, tenantId, 'message.created', { conversation_id: conv.id, message_id: r.messageId })

  if (r.ended && (await repo.endConversation(conv.id, 'agent'))) {
    await closedElsewhere(env, tenantId, conv.id)
    ctx.waitUntil(analyzeConversation(env, tenant, repo, conv.id).catch((e) => console.error('analysis', e)))
    return
  }
  if (r.handoff) {
    if (s.enabled && contactCenterOn(env, tenant)) await escalate(env, ctx, tenant, agent, conv.id, 'ai_tool', { portalBase })
    ctx.waitUntil(onHandoff(env, tenant, repo, agent, conv.id, '').catch((e) => console.error('handoff', e)))
  }
}

/** Adjuntos: se descargan del BSP y se guardan en R2 (si el Worker tiene R2) */
async function storeMedia(env: Env, ch: ChannelRow, convId: string, msgId: string, ev: WaInbound) {
  if (!env.FILES || !ev.media) return
  const conn = connectorFor(ch.provider)!
  const m = await conn.media(env, await channelCreds(env, ch), ev.media)
  if (!m || m.body.byteLength > MAX_MEDIA) return
  const key = `tenants/${ch.tenant_id}/wa/${convId}/${msgId}`
  await env.FILES.put(key, m.body, { httpMetadata: { contentType: m.type } })
  await new ChannelRepo(env.DB, ch.tenant_id).setMedia(msgId, { ...ev.media, link: null, id: null, r2: key, mime: m.type, size: m.body.byteLength })
}
