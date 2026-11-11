/*
  Canal de voz en el widget (ElevenLabs Agents)
    POST /v1/voice/session          token del widget → token de llamada de ElevenLabs (WebRTC)
    POST /v1/voice/start  {call_id} registra la llamada para guardarla aunque el visitante cierre la pestaña
    POST /v1/voice/end    {call_id} guarda transcripción + consumo (en segundo plano)
    POST /v1/voice/tool/kb?s=…      herramienta "buscar_informacion" (la llama ElevenLabs, no el navegador)
*/
import { z } from 'zod'
import type { Env } from '../env'
import { verifyToken } from '../auth/crypto'
import { PlatformRepo } from '../db/platform-repo'
import { TenantRepo } from '../db/tenant-repo'
import type { AgentRow, TenantRow, VoiceCallRow } from '../db/types'
import { budgetAllows, checkThresholds } from '../billing/meter'
import { retrieve } from '../rag/kb'
import { conversationToken, getConversation, type ElConversation, voiceAvailable, voiceCfg } from '../lib/elevenlabs'
import { tenantRates, voiceCost } from '../billing/rates'
import { fail, json, readJson } from '../lib/http'
import { analyzeConversation } from '../leads/analyze'
import { hit } from '../lib/ratelimit'

export interface VoiceCtx {
  t: { t: string; w: string; a: string; v: string; o: string }
  tenant: TenantRow
  agent: AgentRow
  repo: TenantRepo
}

/** ¿Este asistente tiene voz lista para usarse en el widget? */
export function voiceReady(env: Env, agent: AgentRow): boolean {
  const v = voiceCfg(agent)
  return voiceAvailable(env) && Boolean(v.enabled && v.el_agent_id && v.voice_id)
}

export async function voiceWidgetRoutes(env: Env, request: Request, ctx: ExecutionContext, path: string, c: VoiceCtx): Promise<Response | null> {
  const { t, tenant, agent, repo } = c
  if (path === '/v1/voice/session' && request.method === 'POST') {
    if (tenant.status === 'suspended') fail(403, 'suspended', tenant.suspended_message || 'El asistente no está disponible por el momento.')
    if (!voiceReady(env, agent)) fail(400, 'voice_off', 'La voz no está activada para este asistente.')
    if (!hit(`voice:${t.v}`, 4) || !hit(`voice-tenant:${tenant.id}`, 30)) fail(429, 'rate_limited', 'Espera un momento antes de volver a llamar.')
    if (!(await budgetAllows(repo, tenant))) fail(402, 'budget', 'Por ahora no podemos atender por voz. Escríbenos por chat, por favor.')
    const token = await conversationToken(env, voiceCfg(agent).el_agent_id!).catch(() => fail(502, 'voice_unavailable', 'La llamada no está disponible en este momento. Intenta de nuevo.'))
    return json({ token, connection: 'webrtc' })
  }
  if (path === '/v1/voice/start' && request.method === 'POST') {
    const b = await readJson(request, z.object({ call_id: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/) }))
    await repo.addVoiceCall({ id: b.call_id, agent_id: agent.id, visitor_id: t.v, origin: t.o })
    return json({ ok: true })
  }
  if (path === '/v1/voice/end' && request.method === 'POST') {
    const b = await readJson(request, z.object({ call_id: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/) }))
    const call = await repo.voiceCall(b.call_id)
    if (!call || call.visitor_id !== t.v) fail(404, 'not_found', 'Llamada no encontrada.')
    // ElevenLabs tarda unos segundos en cerrar la transcripción: se intenta ahora y, si no, la guarda el cron
    ctx.waitUntil(saveWithRetry(env, tenant, repo, call!))
    return json({ ok: true })
  }
  return null
}

async function saveWithRetry(env: Env, tenant: TenantRow, repo: TenantRepo, call: VoiceCallRow) {
  for (const wait of [3000, 6000, 10000]) {
    await new Promise((r) => setTimeout(r, wait))
    const st = await saveVoiceCall(env, tenant, repo, call).catch(() => 'pending' as const)
    if (st !== 'pending') return
  }
}

/** Herramienta de conocimiento: ElevenLabs manda { pregunta } y recibe el texto relevante */
export async function voiceToolRoute(env: Env, request: Request, url: URL): Promise<Response> {
  const tok = await verifyToken<{ t: string; a: string }>(env, 'voicetool', url.searchParams.get('s') || '')
  if (!tok) fail(401, 'unauthorized', 'No autorizado.')
  if (!hit(`voicetool:${tok!.a}`, 120)) fail(429, 'rate_limited', 'Demasiadas consultas.')
  const b = await readJson(request, z.object({ pregunta: z.string().max(1000) }).passthrough())
  const repo = new TenantRepo(env.DB, tok!.t)
  const agent = await repo.agent(tok!.a)
  if (!agent) fail(404, 'not_found', 'Asistente no encontrado.')
  let chunks: Awaited<ReturnType<typeof retrieve>> = []
  try {
    chunks = await retrieve(env, repo, agent!.id, b.pregunta, 4)
  } catch {
    chunks = []
  }
  if (!chunks.length) return json({ resultado: 'No encontré información sobre eso en la base de conocimiento del negocio.' })
  const resultado = chunks
    .map((c) => `[${c.source_name}] ${c.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n\n')
    .slice(0, 4000)
  return json({ resultado })
}

/**
 * Pasa una llamada terminada a Conversaciones y a Consumo.
 * Devuelve 'pending' si ElevenLabs todavía está procesándola.
 */
export async function saveVoiceCall(env: Env, tenant: TenantRow, repo: TenantRepo, call: VoiceCallRow): Promise<'saved' | 'pending' | 'failed'> {
  if (call.status === 'saved' || call.status === 'failed') return call.status
  if (call.status === 'saving') return 'pending'
  const agent = await repo.agent(call.agent_id)
  if (!agent) {
    await repo.markVoiceCall(call.id, 'failed')
    return 'failed'
  }
  const conv = await getConversation(env, call.id)
  // La llamada debe ser de ESTE asistente (evita que alguien registre llamadas ajenas)
  if (conv.agent_id !== voiceCfg(agent).el_agent_id) {
    await repo.markVoiceCall(call.id, 'failed')
    return 'failed'
  }
  if (conv.status !== 'done' && conv.status !== 'failed') {
    await repo.markVoiceCall(call.id, 'pending')
    return 'pending'
  }
  // Solo uno la guarda aunque el cron y el navegador lleguen juntos
  if (!(await repo.claimVoiceCall(call.id))) return 'saved'
  try {
    return await writeCall(env, tenant, repo, call, agent, conv)
  } catch (e) {
    await repo.markVoiceCall(call.id, 'pending')
    throw e
  }
}

async function writeCall(env: Env, tenant: TenantRow, repo: TenantRepo, call: VoiceCallRow, agent: AgentRow, conv: ElConversation): Promise<'saved'> {
  const start = (conv.metadata.start_time_unix_secs || Math.floor(call.created_at / 1000)) * 1000
  const lines = (conv.transcript || []).filter((x) => x.message && x.message.trim())
  const convId = crypto.randomUUID()
  await repo.createConversation({ id: convId, agent_id: agent.id, visitor_id: call.visitor_id, origin: call.origin, country: null, channel: 'voice', started_at: start })
  for (const x of lines) {
    await repo.insertMessage({
      id: crypto.randomUUID(),
      conversation_id: convId,
      role: x.role === 'user' ? 'user' : 'assistant',
      content: x.message!.trim(),
      tokens_in: 0,
      tokens_out: 0,
      model_id: x.role === 'agent' ? 'voice:elevenlabs' : null,
      estimated: 0,
      sources_json: null,
      created_at: start + (x.time_in_call_secs || 0) * 1000,
    })
  }
  if (!lines.length) await repo.insertMessage({ id: crypto.randomUUID(), conversation_id: convId, role: 'assistant', content: '(Llamada sin conversación)', tokens_in: 0, tokens_out: 0, model_id: 'voice:elevenlabs', estimated: 0, sources_json: null, created_at: start })
  await repo.endConversation(convId, conv.metadata.termination_reason?.toLowerCase().includes('end_call') ? 'agent' : 'visitor')
  await repo.markVoiceCall(call.id, 'saved', convId)

  // Consumo: segundos de llamada × precio por minuto (especial del cliente o el general)
  const secs = Math.max(0, Math.round(conv.metadata.call_duration_secs || 0))
  if (secs > 0) {
    const rates = await tenantRates(env, tenant)
    await repo.insertLedger({
      message_id: null,
      conversation_id: convId,
      model_id: 'voice:elevenlabs',
      model_type: 'voice',
      kind: 'voice',
      // Los tokens quedan en 0 para no mezclar segundos con tokens en los totales; la duración está en price_version
      tokens_in: 0,
      tokens_out: 0,
      cost_micro: voiceCost(secs, rates.minute_micro),
      price_version: `min:${rates.minute_micro}:${rates.minute_source}:${secs}s`,
      estimated: 0,
      billing: 'minute',
      units: secs,
      unit_price_micro: rates.minute_micro,
      // La voz no tiene costo en tokens: ElevenLabs se lo cobra a la cuenta de la plataforma aparte
      token_cost_micro: null,
    })
    await checkThresholds(env, repo, tenant).catch(() => {})
  }
  // Resumen y prospecto de la llamada
  await analyzeConversation(env, tenant, repo, convId).catch((e) => console.error('analysis', e))
  return 'saved'
}

/** Cron: guarda las llamadas que quedaron pendientes */
export async function sweepVoiceCalls(env: Env) {
  if (!voiceAvailable(env)) return
  const platform = new PlatformRepo(env.DB)
  for (const call of await platform.pendingVoiceCalls(Date.now() - 60_000)) {
    const tenant = await platform.tenantById(call.tenant_id)
    if (!tenant) continue
    const repo = new TenantRepo(env.DB, tenant.id)
    try {
      const st = await saveVoiceCall(env, tenant, repo, call)
      if (st === 'pending' && call.attempts >= 5) await repo.markVoiceCall(call.id, 'failed')
    } catch {
      await repo.markVoiceCall(call.id, call.attempts >= 5 ? 'failed' : 'pending')
    }
  }
}
