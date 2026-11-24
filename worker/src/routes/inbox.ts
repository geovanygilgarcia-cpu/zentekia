/*
  API de la bandeja (portal del cliente) · fase 1 omnicanal
    GET  inbox/bootstrap                       quién soy, presencia, colas, equipo, respuestas rápidas
    GET  inbox/conversations?view=&queue=&agent=   view: mine · unassigned · waiting · ai · all · closed
    GET  inbox/conversations/:id               conversación, timeline (con notas y eventos) e historial del contacto
    POST inbox/conversations/:id/messages      { type: 'text' | 'note', text }
    POST inbox/conversations/:id/take          tomar (dos agentes a la vez: solo uno gana)
    POST inbox/conversations/:id/assign        { user_id }  (supervisor o admin)
    POST inbox/conversations/:id/transfer      { queue_id } o { user_id }
    POST inbox/conversations/:id/handback      devolver a la IA
    POST inbox/conversations/:id/close
    POST inbox/conversations/:id/intervene     tomar una conversación que atiende la IA (supervisor o admin)
    PUT  inbox/presence                        { status: online · away · offline, max_chats }
    GET|POST inbox/queues · PUT|DELETE inbox/queues/:id
    GET|POST inbox/quick-replies · PUT|DELETE inbox/quick-replies/:id
    GET  inbox/metrics?days=
    GET  inbox/ws                              WebSocket de la bandeja (InboxHubDO)

  Roles: owner y editor (admins) y supervisor ven todo y reasignan; agent ve las suyas,
  las de sus colas y las que no tienen cola. El tenant sale de la sesión.
*/
import { z } from 'zod'
import type { Env } from '../env'
import { guard, loadSession, type AuthContext } from '../auth/session'
import { InboxRepo, type InboxConversation, type InboxView } from '../db/inbox-repo'
import { TenantRepo } from '../db/tenant-repo'
import { PlatformRepo } from '../db/platform-repo'
import type { TenantRow } from '../db/types'
import { portalUrl } from '../lib/hosts'
import { clientIp, fail, json, readJson } from '../lib/http'
import { match } from '../lib/router'
import { addNote, aiAllowed, assignTo, closeByUser, handbackByUser, humanReply, inboxEvent, InboxError, inboxReady, requestDispatch, sendWaTemplate, take, transferToQueue, waTemplatesFor } from '../inbox/core'
import { ChannelRepo } from '../db/channel-repo'
import { parseJson } from '../db/types'
import { contactNumber, isWhatsApp, windowOpen, type WaConvRef } from '../channels/outbound'
import { WaError } from '../channels/whatsapp'
import { productsOf } from '../lib/products'

const INBOX_ROLES = ['owner', 'editor', 'supervisor', 'agent'] as const
const VIEWS: InboxView[] = ['mine', 'unassigned', 'waiting', 'ai', 'all', 'closed']

export async function inboxRoutes(env: Env, request: Request, url: URL, tenant: TenantRow, sub: string, ctx: ExecutionContext): Promise<Response> {
  const auth = await loadSession(env, request, 'portal', tenant)
  const m = request.method
  // La bandeja es el producto Contact Center: sin él no hay nada aquí
  if (!auth) fail(401, 'unauthenticated', 'Tu sesión terminó. Vuelve a entrar.')
  if (!productsOf(tenant).cc) fail(403, 'no_product', 'Tu cuenta no tiene el Contact Center. Pídelo a Zentekia.')
  const inbox = new InboxRepo(env.DB, tenant.id)
  const platform = new PlatformRepo(env.DB)
  const any = () => guard(request, env, auth, { roles: [...INBOX_ROLES] })
  const admin = () => guard(request, env, auth, { roles: ['owner', 'editor'] })
  const role = (c: AuthContext) => (c.session.impersonator_id ? 'owner' : c.user.role)
  const isLead = (c: AuthContext) => ['owner', 'editor', 'supervisor'].includes(role(c))
  const audit = (c: AuthContext, action: string, detail?: unknown) =>
    platform.audit({ actor_id: c.user.id, actor_email: c.session.impersonator_id ? `soporte:${c.user.email}` : c.user.email, tenant_id: tenant.id, action, detail, ip: clientIp(request) })
  /** Colas que limitan lo que ve la persona (null = ve todo) */
  const scope = async (c: AuthContext) => (isLead(c) ? null : await inbox.queuesOf(c.user.id))
  const canView = async (c: AuthContext, conv: InboxConversation) => {
    const q = await scope(c)
    return !q || conv.assignee_user_id === c.user.id || !conv.queue_id || q.includes(conv.queue_id)
  }
  const load = async (c: AuthContext, id: string) => {
    const conv = await inbox.conversation(id)
    if (!conv || !(await canView(c, conv))) fail(404, 'not_found', 'Conversación no encontrada.')
    return conv!
  }
  const ready = () => {
    if (!inboxReady(env)) fail(503, 'inbox_unavailable', 'La bandeja no está activada en este servidor (faltan los Durable Objects). Avísale a Zentekia.')
  }
  const wrap = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      if (e instanceof InboxError) fail(e.status, e.code, e.message)
      throw e
    }
  }
  let p: Record<string, string> | null

  /* ---------- WebSocket de la bandeja ---------- */
  if (sub === 'ws' && m === 'GET') {
    const c = any()
    ready()
    // Evita que otro sitio abra el WebSocket con la cookie del agente
    const origin = request.headers.get('Origin')
    if (origin !== url.origin) fail(403, 'origin', 'Origen no permitido.')
    if (request.headers.get('Upgrade') !== 'websocket') fail(426, 'upgrade', 'Se esperaba un WebSocket.')
    const stub = env.INBOX_HUB!.get(env.INBOX_HUB!.idFromName(tenant.id))
    const h = new Headers(request.headers)
    h.set('x-tenant', tenant.id)
    h.set('x-user', c.user.id)
    return stub.fetch('https://do/ws', { headers: h })
  }

  if (sub === 'bootstrap' && m === 'GET') {
    const c = any()
    const [presence, queues, members, team, quick, loads] = await Promise.all([inbox.presence(), inbox.queues(), inbox.members(), inbox.team(), inbox.quickReplies(), inbox.loads()])
    const mine = presence.find((x) => x.user_id === c.user.id)
    const agents = (await new TenantRepo(env.DB, tenant.id).listAgents()).map((a) => ({ id: a.id, name: a.name }))
    return json({
      ready: inboxReady(env),
      me: { id: c.user.id, name: c.user.name, email: c.user.email, role: role(c), lead: isLead(c), read_only: Boolean(c.session.read_only) },
      presence: { status: mine?.status ?? 'offline', max_chats: mine?.max_chats ?? 4 },
      queues: queues.map((q) => ({ id: q.id, name: q.name, members: members.filter((x) => x.queue_id === q.id).map((x) => x.user_id) })),
      team: team.map((u) => {
        const pr = presence.find((x) => x.user_id === u.id)
        return { id: u.id, name: u.name, email: u.email, role: u.role, status: pr?.status ?? 'offline', max_chats: pr?.max_chats ?? 4, load: loads.find((l) => l.user_id === u.id)?.n ?? 0 }
      }),
      quick_replies: quick,
      agents,
      counts: await inbox.counts(c.user.id, await scope(c)),
    })
  }

  if (sub === 'conversations' && m === 'GET') {
    const c = any()
    const v = url.searchParams.get('view') as InboxView
    const view: InboxView = VIEWS.includes(v) ? v : 'mine'
    const q = await scope(c)
    const items = await inbox.list({ view, userId: c.user.id, queues: q, queueId: url.searchParams.get('queue') || undefined, agentId: url.searchParams.get('agent') || undefined, limit: 100 })
    return json({
      items: items.map((x) => ({
        id: x.id,
        status: x.status,
        agent_id: x.agent_id,
        agent_name: x.agent_name,
        title: x.title,
        contact_name: x.contact_name,
        contact_email: x.contact_email,
        contact_phone: x.contact_phone,
        last_text: x.last_text ? x.last_text.slice(0, 140) : null,
        last_message_at: x.last_message_at,
        escalated_at: x.escalated_at,
        assigned_at: x.assigned_at,
        assignee_user_id: x.assignee_user_id,
        assignee_name: x.assignee_name || x.assignee_email,
        queue_id: x.queue_id,
        queue_name: x.queue_name,
        escalation_reason: x.escalation_reason,
        channel: x.channel === 'whatsapp' ? 'whatsapp' : 'web',
      })),
      counts: await inbox.counts(c.user.id, q),
    })
  }

  if ((p = match('conversations/:id', sub)) && m === 'GET') {
    const c = any()
    const conv = await load(c, p.id!)
    const repo = new TenantRepo(env.DB, tenant.id)
    const [timeline, agent, history] = await Promise.all([inbox.timeline(conv.id), repo.agent(conv.agent_id), inbox.visitorHistory(conv.visitor_id, conv.id)])
    const wa = conv as InboxConversation & WaConvRef
    const isWa = isWhatsApp(wa)
    const ch = isWa ? await new ChannelRepo(env.DB, tenant.id).get(wa.channel_id!) : null
    const mine = conv.status === 'human_active' && conv.assignee_user_id === c.user.id && !c.session.read_only
    return json({
      conversation: { ...conv, agent_name: agent?.name ?? null },
      messages: timeline.map((x) => {
        const media = parseJson<{ kind?: string; mime?: string; filename?: string; r2?: string } | null>((x as { media_json?: string | null }).media_json, null)
        return {
          id: x.id,
          role: x.role,
          sender: x.sender,
          kind: x.kind,
          content: x.content,
          created_at: x.created_at,
          author_id: x.author_id,
          author_name: x.author_name || x.author_email,
          delivery: (x as { delivery_status?: string | null }).delivery_status ?? null,
          media: media ? { kind: media.kind ?? 'document', mime: media.mime ?? null, filename: media.filename ?? null, stored: Boolean(media.r2) } : null,
        }
      }),
      history,
      channel: isWa ? { type: 'whatsapp', provider: ch?.provider ?? null, phone: ch?.display_phone || (ch ? `+${ch.phone}` : null), contact: `+${contactNumber(wa)}`, window_open: windowOpen(wa), window_expires_at: wa.wa_window_expires_at ?? null } : { type: 'web' },
      can_reply: mine && (!isWa || windowOpen(wa)),
      // false en canales sin IA o clientes sin agentes virtuales: no hay a quién devolverla
      ai_available: Boolean(agent && aiAllowed(tenant, agent)),
      can_template: mine && isWa,
    })
  }

  if ((p = match('conversations/:id/messages', sub)) && m === 'POST') {
    const c = any()
    const conv = await load(c, p.id!)
    const b = await readJson(request, z.object({ type: z.enum(['text', 'note']), text: z.string().trim().min(1).max(4000) }))
    let id = ''
    await wrap(async () => {
      if (b.type === 'note') id = (await addNote(env, tenant.id, conv.id, c.user.id, b.text)).id
      else id = (await humanReply(env, tenant.id, conv.id, c.user, b.text)).id
    })
    return json({ ok: true, id })
  }

  /* ---------- WhatsApp: plantillas y adjuntos ---------- */
  if ((p = match('conversations/:id/templates', sub)) && m === 'GET') {
    const c = any()
    const conv = await load(c, p.id!)
    try {
      const list = await waTemplatesFor(env, tenant.id, conv as InboxConversation & WaConvRef)
      return json({ items: list })
    } catch (e) {
      fail(502, 'templates', e instanceof WaError ? e.message : 'No se pudieron leer las plantillas del proveedor.')
    }
  }
  if ((p = match('conversations/:id/template', sub)) && m === 'POST') {
    const c = any()
    const conv = await load(c, p.id!)
    const b = await readJson(request, z.object({ name: z.string().trim().min(1).max(512), language: z.string().trim().min(2).max(15), params: z.array(z.string().max(1000)).max(20) }))
    await wrap(() => sendWaTemplate(env, tenant.id, conv.id, c.user, b))
    await audit(c, 'inbox.template_sent', { conversation_id: conv.id, template: b.name, language: b.language })
    return json({ ok: true })
  }
  if ((p = match('conversations/:id/media/:mid', sub)) && m === 'GET') {
    const c = any()
    const conv = await load(c, p.id!)
    const msg = await new ChannelRepo(env.DB, tenant.id).message(conv.id, p.mid!)
    const media = parseJson<{ r2?: string; mime?: string; filename?: string } | null>(msg?.media_json, null)
    if (!media?.r2 || !env.FILES || !media.r2.startsWith(`tenants/${tenant.id}/`)) fail(404, 'not_found', 'Adjunto no disponible.')
    const obj = await env.FILES!.get(media!.r2!)
    if (!obj) fail(404, 'not_found', 'Adjunto no disponible.')
    const type = obj!.httpMetadata?.contentType || media!.mime || 'application/octet-stream'
    // Se descarga como archivo (nunca se interpreta HTML/SVG dentro del portal)
    return new Response(obj!.body, {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `${/^(image\/(png|jpeg|webp|gif)|audio\/|video\/)/.test(type) ? 'inline' : 'attachment'}; filename="${(media!.filename || 'adjunto').replace(/[^\w.\- ]/g, '_')}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=300',
      },
    })
  }

  if ((p = match('conversations/:id/take', sub)) && m === 'POST') {
    const c = any()
    ready()
    const conv = await load(c, p.id!)
    await wrap(() => take(env, tenant.id, conv.id, c.user.id))
    await audit(c, 'inbox.taken', { conversation_id: conv.id })
    return json({ ok: true })
  }

  if ((p = match('conversations/:id/intervene', sub)) && m === 'POST') {
    const c = any()
    ready()
    if (!isLead(c)) fail(403, 'forbidden', 'Solo supervisores y administradores pueden intervenir una conversación de la IA.')
    const conv = await load(c, p.id!)
    if (conv.status !== 'ai_active' || conv.ended_at) fail(409, 'state', 'La conversación ya no la atiende la IA.')
    if (!(await inbox.escalate(conv.id, { reason: 'manual', note: null, queueId: null }))) fail(409, 'state', 'La conversación cambió; recarga.')
    await wrap(() => take(env, tenant.id, conv.id, c.user.id))
    await audit(c, 'inbox.intervened', { conversation_id: conv.id })
    return json({ ok: true })
  }

  if ((p = match('conversations/:id/assign', sub)) && m === 'POST') {
    const c = any()
    ready()
    if (!isLead(c)) fail(403, 'forbidden', 'Solo supervisores y administradores pueden reasignar.')
    const conv = await load(c, p.id!)
    const b = await readJson(request, z.object({ user_id: z.string().max(64) }))
    await wrap(() => assignTo(env, tenant.id, conv.id, b.user_id, c.user.id))
    await audit(c, 'inbox.assigned', { conversation_id: conv.id, user_id: b.user_id })
    return json({ ok: true })
  }

  if ((p = match('conversations/:id/transfer', sub)) && m === 'POST') {
    const c = any()
    ready()
    const conv = await load(c, p.id!)
    if (!isLead(c) && conv.assignee_user_id !== c.user.id) fail(403, 'forbidden', 'Solo puedes transferir las conversaciones que atiendes.')
    const b = await readJson(request, z.object({ queue_id: z.string().max(64).nullable().optional(), user_id: z.string().max(64).optional() }))
    if (b.user_id) await wrap(() => assignTo(env, tenant.id, conv.id, b.user_id!, c.user.id))
    else await wrap(() => transferToQueue(env, tenant.id, conv.id, b.queue_id ?? null, c.user.id))
    await audit(c, 'inbox.transferred', { conversation_id: conv.id, queue_id: b.queue_id ?? null, user_id: b.user_id ?? null })
    return json({ ok: true })
  }

  if ((p = match('conversations/:id/handback', sub)) && m === 'POST') {
    const c = any()
    ready()
    const conv = await load(c, p.id!)
    if (!isLead(c) && conv.assignee_user_id !== c.user.id) fail(403, 'forbidden', 'Solo puedes devolver a la IA las conversaciones que atiendes.')
    await wrap(() => handbackByUser(env, tenant.id, conv, c.user.id))
    await audit(c, 'inbox.handback', { conversation_id: conv.id })
    return json({ ok: true })
  }

  if ((p = match('conversations/:id/close', sub)) && m === 'POST') {
    const c = any()
    const conv = await load(c, p.id!)
    if (!isLead(c) && conv.assignee_user_id !== c.user.id && conv.status !== 'waiting_human') fail(403, 'forbidden', 'Solo puedes cerrar las conversaciones que atiendes.')
    await wrap(() => closeByUser(env, ctx, tenant, conv.id, c.user.id, portalUrl(env, url, tenant.slug)))
    await audit(c, 'inbox.closed', { conversation_id: conv.id })
    return json({ ok: true })
  }

  /* ---------- presencia ---------- */
  if (sub === 'presence' && m === 'PUT') {
    const c = any()
    const b = await readJson(request, z.object({ status: z.enum(['online', 'away', 'offline']).optional(), max_chats: z.number().int().min(1).max(20).optional() }))
    await inbox.setPresence(c.user.id, b)
    await inboxEvent(env, tenant.id, 'presence.changed', { user_id: c.user.id, status: b.status ?? null })
    // Al conectarse (o tener más capacidad) se reparten las que esperan
    if (b.status === 'online' || b.max_chats) ctx.waitUntil(requestDispatch(env, tenant.id).catch(() => null))
    return json({ ok: true })
  }

  /* ---------- colas ---------- */
  const queueSchema = z.object({ name: z.string().trim().min(1).max(60), members: z.array(z.string().max(64)).max(200).optional() })
  if (sub === 'queues' && m === 'GET') {
    any()
    const [queues, members] = await Promise.all([inbox.queues(), inbox.members()])
    return json({ queues: queues.map((q) => ({ id: q.id, name: q.name, members: members.filter((x) => x.queue_id === q.id).map((x) => x.user_id) })) })
  }
  if (sub === 'queues' && m === 'POST') {
    const c = admin()
    const b = await readJson(request, queueSchema)
    if ((await inbox.queues()).length >= 30) fail(400, 'limit', 'Máximo 30 colas.')
    const id = await inbox.createQueue(b.name)
    if (b.members) await inbox.setMembers(id, b.members)
    await audit(c, 'inbox.queue_created', { queue_id: id, name: b.name })
    return json({ id })
  }
  if ((p = match('queues/:id', sub))) {
    const c = admin()
    if (!(await inbox.queue(p.id!))) fail(404, 'not_found', 'Cola no encontrada.')
    if (m === 'PUT') {
      const b = await readJson(request, queueSchema)
      await inbox.renameQueue(p.id!, b.name)
      if (b.members) await inbox.setMembers(p.id!, b.members)
      await audit(c, 'inbox.queue_updated', { queue_id: p.id, name: b.name, members: b.members?.length ?? null })
      return json({ ok: true })
    }
    if (m === 'DELETE') {
      await inbox.deleteQueue(p.id!)
      await audit(c, 'inbox.queue_deleted', { queue_id: p.id })
      return json({ ok: true })
    }
  }

  /* ---------- respuestas rápidas ---------- */
  const qrSchema = z.object({ shortcut: z.string().trim().min(1).max(30).regex(/^[\p{L}\p{N}_-]+$/u, 'solo letras, números, guion y guion bajo'), text: z.string().trim().min(1).max(1000) })
  if (sub === 'quick-replies' && m === 'GET') {
    any()
    return json({ items: await inbox.quickReplies() })
  }
  if (sub === 'quick-replies' && m === 'POST') {
    const c = guard(request, env, auth, { roles: ['owner', 'editor', 'supervisor'] })
    const b = await readJson(request, qrSchema)
    if ((await inbox.quickReplies()).length >= 200) fail(400, 'limit', 'Máximo 200 respuestas rápidas.')
    const id = await inbox.createQuickReply(b.shortcut.toLowerCase(), b.text)
    await audit(c, 'inbox.quick_reply_created', { id })
    return json({ id })
  }
  if ((p = match('quick-replies/:id', sub))) {
    const c = guard(request, env, auth, { roles: ['owner', 'editor', 'supervisor'] })
    if (m === 'PUT') {
      const b = await readJson(request, qrSchema)
      if (!(await inbox.updateQuickReply(p.id!, b.shortcut.toLowerCase(), b.text))) fail(404, 'not_found', 'Respuesta no encontrada.')
      return json({ ok: true })
    }
    if (m === 'DELETE') {
      if (!(await inbox.deleteQuickReply(p.id!))) fail(404, 'not_found', 'Respuesta no encontrada.')
      await audit(c, 'inbox.quick_reply_deleted', { id: p.id })
      return json({ ok: true })
    }
  }

  /* ---------- métricas ---------- */
  if (sub === 'metrics' && m === 'GET') {
    guard(request, env, auth, { roles: ['owner', 'editor', 'supervisor'] })
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') || 7)))
    return json(await inbox.metrics(Date.now() - days * 86_400_000))
  }

  return fail(404, 'not_found', 'Ruta no encontrada.')
}
