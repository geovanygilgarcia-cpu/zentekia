/*
  API pública del widget (se sirve desde chat.<dominio> o desde el host único en workers.dev)
    GET  /widget.js  (alias /snippet.js)      loader de la burbuja (<10 KB)
    GET  /w/frame?key=pk_live_…               iframe del chat (frame-ancestors = dominios permitidos)
    GET  /v1/widget/config?key=pk_live_…      tema y textos (cacheado en el edge, versionado)
    GET  /v1/widget/logo?key=…&v=             logo del cliente
    POST /v1/session                          valida llave + origen → token de conversación (30 min)
    POST /v1/chat            (SSE)            mensaje del visitante → respuesta en streaming
    GET  /v1/conversation?id=                 historial de la conversación de ese visitante
    POST /v1/feedback                         pulgar arriba/abajo
  El tenant SIEMPRE sale de la widget_key validada o del token firmado, nunca del body.
*/
import { z } from 'zod'
import type { Env } from '../env'
import { signToken, verifyToken } from '../auth/crypto'
import { PlatformRepo } from '../db/platform-repo'
import { TenantRepo } from '../db/tenant-repo'
import { PLANS } from '../db/seed'
import { chatEnabled, parseJson, periodOf, type AgentRow, type TenantRow, type WidgetRow } from '../db/types'
import { budgetAllows, checkThresholds, recordUsage } from '../billing/meter'
import { buildSystem, END_RE } from '../models/context'
import { estimateTokens, ProviderError, type ChatMessage } from '../models/provider'
import { resolveModel, type Resolved } from '../models/router'
import { retrieve } from '../rag/kb'
import { chatOrigin, normalizeOrigin, portalOrigin, portalUrl } from '../lib/hosts'
import { analyzeConversation } from '../leads/analyze'
import { clientIp, fail, json, randomToken, readJson, SECURITY_HEADERS } from '../lib/http'
import { hit } from '../lib/ratelimit'
import { mergedTheme, publicConfig, withinHours } from '../widget-theme'
import { asset } from '../assets'
import { voiceReady, voiceToolRoute, voiceWidgetRoutes } from './voice'

const TOKEN_TTL = 30 * 60 * 1000
const MAX_INPUT = 2000
const HISTORY = 16
const MAX_OUTPUT_TOKENS = 700
const KEY_RE = /^pk_live_[A-Za-z0-9]{16,40}$/

interface WidgetToken {
  t: string // tenant
  w: string // widget
  a: string // agent
  v: string // visitante
  o: string // origen del sitio
  exp: number
}

async function lookupKey(env: Env, key: string | null) {
  if (!key || !KEY_RE.test(key)) return null
  const platform = new PlatformRepo(env.DB)
  const w = await platform.widgetByKey(key)
  if (!w) return null
  const tenant = await platform.tenantById(w.tenant_id)
  if (!tenant) return null
  const repo = new TenantRepo(env.DB, tenant.id)
  const agent = await repo.agent(w.agent_id)
  if (!agent) return null
  return { w, tenant, agent, repo }
}

function allowedOrigins(env: Env, url: URL, tenant: TenantRow, w: WidgetRow): string[] {
  const list = parseJson<string[]>(w.allowed_origins, [])
  // El portal del cliente siempre puede mostrar la vista previa
  return [...new Set([...list, portalOrigin(env, url, tenant.slug)])]
}

function corsFor(origin: string | null, allowed: string[]): Record<string, string> {
  if (origin && allowed.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600', Vary: 'Origin' }
  }
  return { Vary: 'Origin' }
}

export async function widgetRoutes(env: Env, request: Request, url: URL, path: string, ctx: ExecutionContext): Promise<Response | null> {
  const m = request.method
  const ownOrigin = chatOrigin(env, url)

  if ((path === '/widget.js' || path === '/snippet.js') && m === 'GET') {
    const a = asset('loader.js')!
    return new Response(a.body, { headers: { 'Content-Type': a.type, 'Cache-Control': 'public, max-age=300', ...SECURITY_HEADERS, 'Access-Control-Allow-Origin': '*' } })
  }

  if (path === '/w/frame' && m === 'GET') {
    const found = await lookupKey(env, url.searchParams.get('key'))
    if (!found) return new Response('Widget no encontrado', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    const ancestors = allowedOrigins(env, url, found.tenant, found.w)
    const turn = found.tenant.turnstile && env.TURNSTILE_SITE_KEY ? ' https://challenges.cloudflare.com' : ''
    const csp = [
      "default-src 'none'",
      `script-src 'self' blob: data: https://cdn.jsdelivr.net${turn}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data:",
      // Voz (ElevenLabs): WebRTC/WebSocket con ElevenLabs y los worklets de audio del SDK
      "connect-src 'self' https://*.elevenlabs.io wss://*.elevenlabs.io",
      "media-src 'self' blob: mediastream:",
      "worker-src 'self' blob:",
      `frame-src${turn || " 'none'"}`,
      `frame-ancestors ${ancestors.join(' ')}`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ')
    const html = `<!doctype html><html lang="${found.agent.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Chat</title><link rel="icon" href="/favicon.ico" sizes="any"><link rel="stylesheet" href="/assets/frame.css"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@400;500&display=swap"></head><body><div id="root" data-key="${found.w.widget_key}" data-turnstile="${turn ? env.TURNSTILE_SITE_KEY : ''}"></div><script src="/assets/frame.js"></script></body></html>`
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'Permissions-Policy': 'microphone=(self), autoplay=(self)', 'Cache-Control': 'no-store', ...SECURITY_HEADERS } })
  }

  // Herramienta de conocimiento para la voz: la llama ElevenLabs (servidor), no el navegador
  if (path === '/v1/voice/tool/kb' && m === 'POST') return voiceToolRoute(env, request, url)

  if (path === '/v1/widget/config' && (m === 'GET' || m === 'OPTIONS')) {
    const key = url.searchParams.get('key')
    const found = await lookupKey(env, key)
    const origin = request.headers.get('Origin')
    if (!found) return json({ error: { code: 'not_found', message: 'Widget no encontrado' } }, 404, { 'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin' })
    const allowed = [...allowedOrigins(env, url, found.tenant, found.w), ownOrigin]
    const cors = corsFor(origin, allowed)
    if (m === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: { code: 'origin', message: 'Dominio no autorizado para este widget.' } }, 403, cors)
    const t = mergedTheme(found.w)
    const logo = found.w.logo_data || (t.logo_version && env.FILES) ? `${ownOrigin}/v1/widget/logo?key=${found.w.widget_key}&v=${t.logo_version ?? found.w.version}` : null
    const cfg = publicConfig(found.tenant, found.w, found.agent, logo)
    cfg.turnstile = Boolean(found.tenant.turnstile && env.TURNSTILE_SITE_KEY)
    return json({ ...cfg, online: withinHours(t), chat: chatEnabled(found.agent), voice: voiceReady(env, found.agent) }, 200, { ...cors, 'Cache-Control': 'public, max-age=60' })
  }

  if (path === '/v1/widget/logo' && m === 'GET') {
    const found = await lookupKey(env, url.searchParams.get('key'))
    if (!found) return new Response(null, { status: 404 })
    let body: Uint8Array | ReadableStream | null = null
    let type = 'image/png'
    if (env.FILES) {
      const obj = await env.FILES.get(`tenants/${found.tenant.id}/brand/logo`)
      if (obj) {
        body = obj.body
        type = obj.httpMetadata?.contentType || type
      }
    }
    if (!body && found.w.logo_data) {
      const mm = found.w.logo_data.match(/^data:(image\/(?:png|jpeg|svg\+xml|webp));base64,(.+)$/)
      if (mm) {
        type = mm[1]!
        body = Uint8Array.from(atob(mm[2]!), (c) => c.charCodeAt(0))
      }
    }
    if (!body) return new Response(null, { status: 404 })
    return new Response(body, {
      headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", ...SECURITY_HEADERS, 'Cross-Origin-Resource-Policy': 'cross-origin' },
    })
  }

  // De aquí en adelante, solo el iframe propio (mismo origen) llama a la API
  if (path === '/v1/session' || path === '/v1/chat' || path === '/v1/feedback' || path === '/v1/conversation' || path === '/v1/end' || path.startsWith('/v1/voice/')) {
    const origin = request.headers.get('Origin')
    if (m === 'OPTIONS') return new Response(null, { status: 204 })
    if (m !== 'GET' && origin !== ownOrigin) fail(403, 'origin', 'Origen no permitido.')
    const ip = clientIp(request)
    if (!hit(`ip:${ip}`, 40)) fail(429, 'rate_limited', 'Demasiadas solicitudes. Espera un momento.')

    if (path === '/v1/session' && m === 'POST') return session(env, request, url)
    const auth = request.headers.get('Authorization') || ''
    const tok = auth.startsWith('Bearer ') ? await verifyToken<WidgetToken>(env, 'widget', auth.slice(7)) : null
    if (!tok) fail(401, 'session_expired', 'La sesión del chat venció. Recarga para continuar.')
    const t = tok!
    const platform = new PlatformRepo(env.DB)
    const tenant = await platform.tenantById(t.t)
    if (!tenant) fail(401, 'session_expired', 'La sesión del chat venció. Recarga para continuar.')
    const repo = new TenantRepo(env.DB, tenant!.id)
    const w = await repo.widget(t.w)
    if (!w || w.agent_id !== t.a) fail(401, 'session_expired', 'La sesión del chat venció. Recarga para continuar.')
    const agent = await repo.agent(w!.agent_id)
    if (!agent) fail(404, 'not_found', 'Agente no encontrado.')

    if (path === '/v1/conversation' && m === 'GET') {
      const id = url.searchParams.get('id') || ''
      const conv = await repo.conversation(id)
      if (!conv || conv.visitor_id !== t.v) return json({ messages: [] })
      const msgs = await repo.messages(id, 200)
      return json({ ended: Boolean(conv.ended_at), rating: conv.rating, messages: msgs.map((x) => ({ id: x.id, role: x.role, content: x.content, feedback: x.feedback, sources: parseJson(x.sources_json, []) })) })
    }
    if (path === '/v1/feedback' && m === 'POST') {
      const b = await readJson(request, z.object({ conversation_id: z.string().max(64), message_id: z.string().max(64), value: z.union([z.literal(1), z.literal(-1), z.null()]) }))
      const conv = await repo.conversation(b.conversation_id)
      if (!conv || conv.visitor_id !== t.v) fail(404, 'not_found', 'Conversación no encontrada.')
      await repo.setFeedback(b.conversation_id, b.message_id, b.value)
      return json({ ok: true })
    }
    if (path === '/v1/end' && m === 'POST') {
      const b = await readJson(request, z.object({ conversation_id: z.string().max(64), rating: z.number().int().min(1).max(5).optional() }))
      const conv = await repo.conversation(b.conversation_id)
      if (!conv || conv.visitor_id !== t.v) fail(404, 'not_found', 'Conversación no encontrada.')
      const closed = await repo.endConversation(conv!.id, 'visitor')
      if (b.rating) await repo.rateConversation(conv!.id, b.rating)
      // Resumen y prospecto en segundo plano (el visitante no espera)
      if (closed) ctx.waitUntil(analyzeConversation(env, tenant!, repo, conv!.id, { portalBase: portalUrl(env, url, tenant!.slug) }).catch((e) => console.error('analysis', e)))
      return json({ ok: true })
    }
    if (path === '/v1/chat' && m === 'POST') return chat(env, request, ctx, t, tenant!, w!, agent!, repo)
    if (path.startsWith('/v1/voice/')) {
      const r = await voiceWidgetRoutes(env, request, ctx, path, { t, tenant: tenant!, agent: agent!, repo })
      if (r) return r
    }
  }

  return null
}

async function session(env: Env, request: Request, url: URL): Promise<Response> {
  const b = await readJson(
    request,
    z.object({ key: z.string().max(60), origin: z.string().max(300), visitor_id: z.string().max(64).optional(), turnstile: z.string().max(4096).optional() }),
  )
  const found = await lookupKey(env, b.key)
  if (!found) fail(404, 'not_found', 'Widget no encontrado.')
  const { tenant, w } = found!
  const origin = normalizeOrigin(b.origin)
  // Defensa adicional: el navegador ya bloquea el iframe fuera de los dominios permitidos (frame-ancestors)
  if (!origin || !allowedOrigins(env, url, tenant, w).includes(origin)) fail(403, 'origin', 'Este widget no está autorizado en este sitio.')
  if (tenant.status === 'suspended') fail(403, 'suspended', tenant.suspended_message || 'El chat no está disponible por el momento.')
  if (tenant.turnstile && env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env, b.turnstile || '', clientIp(request))
    if (!ok) fail(403, 'turnstile', 'No pudimos verificar que eres una persona. Intenta de nuevo.')
  }
  const visitor = b.visitor_id && /^v_[A-Za-z0-9_-]{10,40}$/.test(b.visitor_id) ? b.visitor_id : `v_${randomToken(16)}`
  const token = await signToken(env, 'widget', { t: tenant.id, w: w.id, a: w.agent_id, v: visitor, o: origin!, exp: Date.now() + TOKEN_TTL } satisfies WidgetToken)
  return json({ token, visitor_id: visitor, expires_in: TOKEN_TTL / 1000 })
}

async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  if (!token) return false
  const form = new FormData()
  form.append('secret', env.TURNSTILE_SECRET!)
  form.append('response', token)
  form.append('remoteip', ip)
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
    const j = (await r.json()) as { success?: boolean }
    return Boolean(j.success)
  } catch {
    return false
  }
}

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

function staticReply(text: string, convId: string | null): Response {
  const body = sse({ type: 'meta', conversation_id: convId }) + sse({ type: 'delta', text }) + sse({ type: 'done', notice: true })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS } })
}

async function chat(env: Env, request: Request, ctx: ExecutionContext, t: WidgetToken, tenant: TenantRow, w: WidgetRow, agent: AgentRow, repo: TenantRepo): Promise<Response> {
  const b = await readJson(request, z.object({ conversation_id: z.string().max(64).nullable().optional(), message: z.string().max(MAX_INPUT * 2) }))
  const text = b.message.trim().slice(0, MAX_INPUT)
  if (!text) fail(400, 'empty', 'Escribe un mensaje.')
  if (!chatEnabled(agent)) fail(403, 'chat_off', 'El chat por texto no está disponible para este asistente.')
  const plan = PLANS[tenant.plan_id] ?? PLANS.basico!
  if (!hit(`sess:${t.v}`, 12)) fail(429, 'rate_limited', 'Vas muy rápido. Espera unos segundos.')
  if (!hit(`tenant:${tenant.id}`, plan.tenantPerMinute)) fail(429, 'rate_limited', 'El chat está muy ocupado. Intenta en un momento.')
  const theme = mergedTheme(w)

  if (tenant.status === 'suspended') return staticReply(tenant.suspended_message || 'El chat no está disponible por el momento.', null)

  // Conversación: se reutiliza solo si es del mismo tenant y del mismo visitante
  let convId = b.conversation_id ?? null
  let conv = convId ? await repo.conversation(convId) : null
  // Una conversación finalizada no se reabre: el siguiente mensaje inicia otra
  if (!conv || conv.visitor_id !== t.v || conv.agent_id !== agent.id || conv.ended_at) {
    convId = crypto.randomUUID()
    await repo.createConversation({ id: convId, agent_id: agent.id, visitor_id: t.v, origin: t.o, country: (request as Request & { cf?: { country?: string } }).cf?.country ?? null })
    conv = null
  }
  const cid = convId!
  if (conv && conv.message_count >= plan.maxMessagesPerConversation * 2) {
    return staticReply('Llegamos al máximo de mensajes en esta conversación. Inicia una nueva para seguir.', cid)
  }

  const userMsgId = crypto.randomUUID()
  await repo.insertMessage({ id: userMsgId, conversation_id: cid, role: 'user', content: text, tokens_in: 0, tokens_out: 0, model_id: null, estimated: 0, sources_json: null })

  if (!withinHours(theme)) return staticReply(theme.offline_message, cid)
  if (!(await budgetAllows(repo, tenant))) {
    ctx.waitUntil(checkThresholds(env, repo, tenant).catch(() => {}))
    return staticReply('Por ahora no puedo responder. Déjanos tus datos o intenta más tarde, por favor.', cid)
  }

  const history: ChatMessage[] = (await repo.recentMessages(cid, HISTORY)).map((x) => ({ role: x.role, content: x.content }))
  let kb: Awaited<ReturnType<typeof retrieve>> = []
  try {
    kb = await retrieve(env, repo, agent.id, text)
  } catch {
    kb = []
  }
  const system = buildSystem(tenant, agent, kb)
  const sources = kb.map((c) => ({ name: c.source_name, url: c.source_url })).filter((s, i, arr) => arr.findIndex((x) => x.name === s.name) === i)
  const agentCfg = parseJson<{ show_sources?: boolean; auto_end?: boolean }>(agent.config_json, {})
  const showSources = agentCfg.show_sources === true
  const autoEnd = agentCfg.auto_end === true

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  const abort = new AbortController()
  let clientGone = false
  const write = async (o: unknown) => {
    if (clientGone) return
    try {
      await writer.write(enc.encode(sse(o)))
    } catch {
      clientGone = true
      abort.abort()
    }
  }
  const assistantId = crypto.randomUUID()

  const run = async () => {
    await write({ type: 'meta', conversation_id: cid, message_id: assistantId })
    const st: { full: string; usage: { in: number; out: number } | null; resolved: Resolved | null; ended: boolean } = { full: '', usage: null, resolved: null, ended: false }
    const attempt = async (forceHosted: boolean) => {
      const r = await resolveModel(env, repo, tenant, agent, forceHosted)
      st.resolved = r
      // La marca [FINALIZAR] nunca llega al visitante: se detecta aunque venga partida en varios pedazos
      const filter = new EndMarkFilter()
      const emit = async (text: string) => {
        if (!text) return
        st.full += text
        await write({ type: 'delta', text })
      }
      for await (const ch of r.provider.stream({ model: r.modelName, system, messages: history, temperature: agent.temperature, maxTokens: MAX_OUTPUT_TOKENS }, r.creds, abort.signal)) {
        if (ch.type === 'delta') {
          if (filter.ended) continue
          await emit(filter.push(ch.text))
        } else st.usage = { in: ch.input_tokens, out: ch.output_tokens }
      }
      await emit(filter.flush())
      st.ended = autoEnd && filter.ended
    }
    const inputEstimate = () => estimateTokens(system + history.map((h) => h.content).join(' '))
    try {
      try {
        await attempt(false)
      } catch (e) {
        // Respaldo opcional a Qwen hosted solo si todavía no se mandó texto
        if (!st.full && tenant.fallback_to_hosted && st.resolved?.model.type === 'byok') {
          await notifyOwner(repo, e)
          await attempt(true)
        } else throw e
      }
      const r = st.resolved!
      const estimated = !st.usage
      const tin = st.usage ? st.usage.in : inputEstimate()
      const tout = st.usage ? st.usage.out : estimateTokens(st.full)
      const content = st.full.trim() || (st.ended ? GOODBYE[agent.language] || GOODBYE.es! : '…')
      if (!st.full.trim() && st.ended) await write({ type: 'delta', text: content })
      await repo.insertMessage({ id: assistantId, conversation_id: cid, role: 'assistant', content, tokens_in: tin, tokens_out: tout, model_id: r.model.id, estimated: estimated ? 1 : 0, sources_json: showSources && sources.length ? JSON.stringify(sources) : null })
      await recordUsage(env, repo, tenant, { model: r.model, tokensIn: tin, tokensOut: tout, estimated, messageId: assistantId, conversationId: cid })
      if (st.ended && (await repo.endConversation(cid, 'agent'))) {
        ctx.waitUntil(analyzeConversation(env, tenant, repo, cid, { portalBase: portalUrl(env, new URL(request.url), tenant.slug) }).catch((e) => console.error('analysis', e)))
      }
      await write({ type: 'done', message_id: assistantId, sources: showSources ? sources : [], ended: st.ended })
    } catch (e) {
      await notifyOwner(repo, e)
      if (st.full && st.resolved) {
        // Se cortó a la mitad: se guarda y se cobra lo generado (estimado)
        const tin = inputEstimate()
        const tout = estimateTokens(st.full)
        await repo.insertMessage({ id: assistantId, conversation_id: cid, role: 'assistant', content: st.full, tokens_in: tin, tokens_out: tout, model_id: st.resolved.model.id, estimated: 1, sources_json: null })
        await recordUsage(env, repo, tenant, { model: st.resolved.model, tokensIn: tin, tokensOut: tout, estimated: true, messageId: assistantId, conversationId: cid })
      }
      // Al visitante nunca se le manda el detalle del proveedor
      await write({ type: 'error', message: theme.error_message })
    } finally {
      try {
        await writer.close()
      } catch {
        /* cliente desconectado */
      }
    }
  }
  ctx.waitUntil(run())
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS } })
}

const GOODBYE: Record<string, string> = { es: 'Gracias por escribirnos. ¡Hasta pronto!', en: 'Thanks for reaching out. Goodbye!', pt: 'Obrigado pelo contato. Até logo!' }

/** Quita la marca [FINALIZAR] del texto que va saliendo; guarda un pedazo si podría ser el inicio de la marca */
export class EndMarkFilter {
  ended = false
  private pending = ''
  push(text: string): string {
    if (this.ended) return ''
    const buf = this.pending + text
    this.pending = ''
    const m = END_RE.exec(buf)
    if (m) {
      this.ended = true
      return buf.slice(0, m.index).replace(/\s+$/, '')
    }
    const open = buf.lastIndexOf('[')
    if (open >= 0 && !buf.includes(']', open) && buf.length - open <= 16) {
      const tail = buf.slice(open).replace(/\s+/g, '').toLowerCase()
      if ('[finalizar'.startsWith(tail)) {
        this.pending = buf.slice(open)
        return buf.slice(0, open)
      }
    }
    return buf
  }
  flush(): string {
    const p = this.pending
    this.pending = ''
    return this.ended ? '' : p
  }
}

async function notifyOwner(repo: TenantRepo, e: unknown) {
  const msg =
    e instanceof ProviderError
      ? e.message
      : 'El modelo no pudo responder. Revisa la configuración en la sección Modelo.'
  const day = new Date().toISOString().slice(0, 10)
  await repo.addAlert(`provider_${e instanceof ProviderError ? e.kind : 'error'}`, day, msg).catch(() => {})
  console.error(JSON.stringify({ level: 'warn', msg: 'provider_error', tenant_id: repo.tenantId, kind: e instanceof ProviderError ? e.kind : 'unknown' }))
}

export { periodOf }
