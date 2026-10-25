/*
  API del portal del cliente. El tenant sale de la sesión (y debe coincidir con el slug del host/ruta).
  Roles: owner (todo) · editor (agente, conocimiento, widget, instalación, conversaciones; sin API keys ni facturación).
*/
import { z } from 'zod'
import type { Env } from '../env'
import { decryptForTenant, encryptForTenant } from '../auth/crypto'
import { guard, loadSession } from '../auth/session'
import { PlatformRepo } from '../db/platform-repo'
import { TenantRepo } from '../db/tenant-repo'
import { HOSTED_DEFAULT_MODEL, PLANS } from '../db/seed'
import { chatEnabled, parseJson, periodOf, periodRange, type AgentConfig, type AgentRow, type TenantRow, type VoiceConfig, type WidgetTheme } from '../db/types'
import { effectivePrice } from '../billing/pricing'
import { monthSpend } from '../billing/meter'
import { enabledModels, providerFor } from '../models/router'
import { ALLOWED_EXT, MAX_FILE_BYTES, deleteVectors, extractFile, processSource } from '../rag/kb'
import { chatOrigin, normalizeOrigin, portalHostLabel, portalUrl } from '../lib/hosts'
import { analyzeConversation, cleanEmail, cleanPhone } from '../leads/analyze'
import type { ConvFilter } from '../db/tenant-repo'
import { clientIp, fail, json, readJson } from '../lib/http'
import { createInvite, newWidgetKey } from '../lib/provision'
import { sendEmail } from '../lib/email'
import { addLibraryVoice, DEFAULT_VOICE_MODEL, listMexicanVoices, listVoices, syncVoiceAgent, VOICE_LLM, voiceAvailable, voiceCfg, VoiceError } from '../lib/elevenlabs'
import { match, toCsv } from '../lib/router'
import { TEMPLATES } from '../templates/industry'
import { contrastProblems, DEFAULT_THEME, mergedTheme } from '../widget-theme'

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'color en formato #RRGGBB')

const agentSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  welcome_message: z.string().max(600).optional(),
  language: z.enum(['es', 'en', 'pt']).optional(),
  system_prompt: z.string().max(20_000).optional(),
  temperature: z.number().min(0).max(1).optional(),
  tone: z.string().max(120).optional(),
  fallback_response: z.string().max(400).optional(),
  suggested_questions: z.array(z.string().trim().max(80)).max(4).optional(),
  business_name: z.string().max(120).optional(),
  business_description: z.string().max(2000).optional(),
  show_sources: z.boolean().optional(),
  auto_end: z.boolean().optional(),
  end_when: z.string().max(1000).optional(),
  template: z.string().max(40).optional(),
  lead_criteria: z.string().max(1500).optional(),
  lead_fields: z.array(z.enum(['name', 'phone', 'email', 'company'])).max(4).optional(),
  lead_alerts: z.enum(['off', 'hot', 'warm']).optional(),
})

const themeSchema = z
  .object({
    appearance: z.enum(['oscuro', 'claro']),
    assistant_name: z.string().trim().min(1).max(60),
    header_title: z.string().max(60),
    header_subtitle: z.string().max(80),
    primary: hex,
    secondary: hex,
    background: hex,
    text: hex,
    user_bubble: hex,
    user_text: hex,
    agent_bubble: hex,
    agent_text: hex,
    position: z.enum(['right', 'left']),
    margin_x: z.number().int().min(0).max(120),
    margin_y: z.number().int().min(0).max(120),
    button_size: z.number().int().min(44).max(80),
    placeholder: z.string().max(80),
    error_message: z.string().max(200),
    privacy_notice: z.string().max(1000),
    privacy_required: z.boolean(),
    auto_open_delay: z.number().int().min(0).max(120),
    sound: z.boolean(),
    show_powered_by: z.boolean(),
    hours_enabled: z.boolean(),
    hours_timezone: z.string().max(60),
    hours_days: z.array(z.number().int().min(0).max(6)).max(7),
    hours_start: z.string().regex(/^\d{2}:\d{2}$/),
    hours_end: z.string().regex(/^\d{2}:\d{2}$/),
    offline_message: z.string().max(300),
  })
  .partial()

export async function portalRoutes(env: Env, request: Request, url: URL, tenant: TenantRow, sub: string): Promise<Response> {
  const ctx = await loadSession(env, request, 'portal', tenant)
  const m = request.method
  const repo = new TenantRepo(env.DB, tenant.id)
  const platform = new PlatformRepo(env.DB)
  const ip = clientIp(request)
  const any = () => guard(request, env, ctx, { roles: ['owner', 'editor'] })
  const owner = () => guard(request, env, ctx, { roles: ['owner'] })
  const audit = (action: string, detail?: unknown) =>
    platform.audit({ actor_id: ctx!.user.id, actor_email: ctx!.session.impersonator_id ? `soporte:${ctx!.user.email}` : ctx!.user.email, tenant_id: tenant.id, action, detail, ip })
  const role = () => (ctx!.session.impersonator_id ? 'owner' : ctx!.user.role)
  let p: Record<string, string> | null

  /* ---------- resumen ---------- */
  if (sub === 'overview' && m === 'GET') {
    any()
    const agents = await repo.listAgents()
    const widgets = await repo.widgets()
    const alerts = role() === 'owner' ? await repo.alerts(10) : []
    const stats = await repo.conversationStats(Date.now() - 30 * 86_400_000)
    return json({
      tenant: { name: tenant.name, slug: tenant.slug, status: tenant.status, plan: PLANS[tenant.plan_id]?.name ?? tenant.plan_id, onboarded: Boolean(tenant.onboarded), portal: portalHostLabel(env, url, tenant.slug) },
      agents: agents.map((a) => {
        const w = widgets.find((x) => x.agent_id === a.id)
        const theme = w ? mergedTheme(w) : null
        return {
          id: a.id,
          name: a.name,
          model_id: a.model_id,
          created_at: a.created_at,
          conversations_30d: stats.find((x) => x.agent_id === a.id)?.n ?? 0,
          last_conversation_at: stats.find((x) => x.agent_id === a.id)?.last_at ?? null,
          widget_key: w?.widget_key,
          color: theme?.primary ?? null,
          logo_url: w && (w.logo_data || theme?.logo_version) ? `${chatOrigin(env, url)}/v1/widget/logo?key=${w.widget_key}&v=${theme?.logo_version ?? w.version}` : null,
          // Canales del asistente: hoy solo chat; voz y WhatsApp se activan después
          channels: { chat: w && chatEnabled(a) ? 'active' : 'off', voice: voiceAvailable(env) ? (voiceCfg(a).enabled && voiceCfg(a).el_agent_id ? 'active' : 'available') : 'soon', whatsapp: 'soon' },
        }
      }),
      alerts,
      chat_origin: chatOrigin(env, url),
      can_hide_powered_by: PLANS[tenant.plan_id]?.canHidePoweredBy ?? false,
      voice_available: voiceAvailable(env),
    })
  }
  if (sub === 'alerts/read' && m === 'POST') {
    owner()
    await repo.markAlertsRead()
    return json({ ok: true })
  }
  if (sub === 'onboarding/complete' && m === 'POST') {
    owner()
    await repo.updateSettings({ onboarded: 1 })
    await audit('portal.onboarding_completed')
    return json({ ok: true })
  }
  if (sub === 'templates' && m === 'GET') {
    any()
    return json({ templates: TEMPLATES.map((t) => ({ ...t, welcome: t.welcome.replace('{negocio}', tenant.name) })) })
  }

  /* ---------- agentes ---------- */
  // El cliente pide un asistente nuevo; Zentekia lo da de alta (queda en Auditoría y llega por correo)
  if (sub === 'agents/request' && m === 'POST') {
    owner()
    const b = await readJson(
      request,
      z.object({
        name: z.string().trim().min(1).max(80),
        channels: z.array(z.enum(['chat', 'voice', 'whatsapp'])).min(1).max(3),
        notes: z.string().trim().max(1500).optional(),
      }),
    )
    await audit('agent.requested', b)
    const to = [...new Set([env.ALERT_EMAIL, env.ADMIN_EMAIL, ...(await platform.superadminEmails())].filter((x): x is string => Boolean(x)))]
    const names: Record<string, string> = { chat: 'Chat', voice: 'Voz', whatsapp: 'WhatsApp' }
    await sendEmail(
      env,
      to,
      `Solicitud de asistente · ${tenant.name}`,
      [`${ctx!.user.email} (${tenant.name}, ${tenant.slug}) solicitó un asistente nuevo.`, '', `Nombre: ${b.name}`, `Canales: ${b.channels.map((c) => names[c]).join(', ')}`, b.notes ? `Notas: ${b.notes}` : '', '', 'Dalo de alta desde el panel de administración.'].filter((l, i, a) => l || a[i - 1]).join('\n'),
    )
    return json({ ok: true })
  }
  if (sub === 'agents' && m === 'POST') {
    owner()
    const b = await readJson(request, z.object({ name: z.string().trim().min(1).max(80) }))
    const current = await repo.listAgents()
    if (current.length >= 10) fail(400, 'limit', 'Máximo 10 agentes por cliente.')
    const id = await repo.createAgent({ name: b.name, system_prompt: '', welcome_message: `Hola, soy ${b.name}. ¿En qué te ayudo?`, language: 'es', temperature: 0.4, model_id: HOSTED_DEFAULT_MODEL, provider_key_id: null, config_json: JSON.stringify({ business_name: tenant.name }) })
    await repo.createWidget(id, newWidgetKey(), JSON.stringify({ assistant_name: b.name }), parseJson<string[]>((await repo.widgets())[0]?.allowed_origins, []))
    await audit('agent.created', { agent_id: id })
    return json({ id })
  }
  // Prender o apagar el chat (texto) de un asistente
  if ((p = match('agents/:id/channels', sub)) && m === 'PUT') {
    owner()
    const a = await repo.agent(p.id!)
    if (!a) fail(404, 'not_found', 'Agente no encontrado.')
    const b = await readJson(request, z.object({ chat: z.boolean() }))
    const cfg = parseJson<AgentConfig>(a!.config_json, {})
    cfg.chat_enabled = b.chat
    await repo.updateAgent(a!.id, { config_json: JSON.stringify(cfg) })
    await audit(b.chat ? 'chat.enabled' : 'chat.disabled', { agent_id: a!.id })
    return json({ ok: true })
  }
  if ((p = match('agents/:id', sub))) {
    if (m === 'GET') {
      any()
      const a = await repo.agent(p.id!)
      if (!a) fail(404, 'not_found', 'Agente no encontrado.')
      const cfg = parseJson<AgentConfig>(a!.config_json, {})
      return json({ id: a!.id, name: a!.name, welcome_message: a!.welcome_message, language: a!.language, system_prompt: a!.system_prompt, temperature: a!.temperature, model_id: a!.model_id, ...cfg })
    }
    if (m === 'PUT') {
      any()
      const a = await repo.agent(p.id!)
      if (!a) fail(404, 'not_found', 'Agente no encontrado.')
      const b = await readJson(request, agentSchema)
      const cfg = parseJson<AgentConfig>(a!.config_json, {})
      for (const k of ['tone', 'fallback_response', 'suggested_questions', 'business_name', 'business_description', 'show_sources', 'auto_end', 'end_when', 'template', 'lead_criteria', 'lead_fields', 'lead_alerts'] as const) {
        if (b[k] !== undefined) (cfg as Record<string, unknown>)[k] = b[k]
      }
      await repo.updateAgent(a!.id, { name: b.name, welcome_message: b.welcome_message, language: b.language, system_prompt: b.system_prompt, temperature: b.temperature, config_json: JSON.stringify(cfg) })
      await audit('agent.updated', { agent_id: a!.id, fields: Object.keys(b) })
      // Si tiene voz, la llamada usa las instrucciones nuevas
      const voiceWarning = await resyncVoice(a!.id)
      return json({ ok: true, voice_warning: voiceWarning })
    }
  }

  /* ---------- voz (ElevenLabs) ---------- */
  async function saveVoice(agent: AgentRow, v: VoiceConfig) {
    const cfg = parseJson<AgentConfig>(agent.config_json, {})
    cfg.voice = v
    await repo.updateAgent(agent.id, { config_json: JSON.stringify(cfg) })
  }
  async function resyncVoice(agentId: string): Promise<string | null> {
    if (!voiceAvailable(env)) return null
    const a = await repo.agent(agentId)
    const v = a ? voiceCfg(a) : null
    if (!a || !v?.enabled || !v.el_agent_id) return null
    try {
      await saveVoice(a, await syncVoiceAgent(env, chatOrigin(env, url), tenant, a, v))
      return null
    } catch (e) {
      const msg = e instanceof VoiceError ? e.message : 'No se pudo actualizar la voz.'
      await saveVoice(a, { ...v, sync_error: msg })
      return `Se guardó, pero la voz no se actualizó: ${msg}`
    }
  }
  if (sub === 'voice' && m === 'GET') {
    any()
    const a = await repo.agent(url.searchParams.get('agent') || '')
    if (!a) fail(404, 'not_found', 'Agente no encontrado.')
    const v = voiceCfg(a!)
    return json({
      available: voiceAvailable(env),
      llm: VOICE_LLM,
      price_per_min: Number(env.VOICE_PRICE_PER_MIN || '0.15'),
      config: {
        enabled: Boolean(v.enabled),
        voice_id: v.voice_id || null,
        voice_name: v.voice_name || null,
        model: v.model || DEFAULT_VOICE_MODEL,
        speed: v.speed ?? 1,
        eagerness: v.eagerness || 'eager',
        first_message: v.first_message ?? '',
        ready: Boolean(v.enabled && v.el_agent_id),
        synced_at: v.synced_at || null,
        sync_error: v.sync_error || null,
      },
      welcome: a!.welcome_message,
    })
  }
  if (sub === 'voice/voices' && m === 'GET') {
    any()
    if (!voiceAvailable(env)) return json({ voices: [] })
    try {
      if (url.searchParams.get('source') !== 'all') {
        // Por defecto solo voces mexicanas
        const { voices: mx, diag } = await listMexicanVoices(env)
        mx.sort((x, y) => (x.gender || '').localeCompare(y.gender || '') || x.name.localeCompare(y.name))
        return json({ voices: mx, diag })
      }
      const voices = await listVoices(env, (url.searchParams.get('q') || '').slice(0, 60) || undefined)
      // Primero las que hablan español
      voices.sort((x, y) => Number(y.spanish) - Number(x.spanish) || x.name.localeCompare(y.name))
      return json({ voices })
    } catch (e) {
      fail(502, 'voice', e instanceof VoiceError ? e.message : 'No se pudieron cargar las voces.')
    }
  }
  if ((p = match('voice/:id', sub)) && m === 'PUT') {
    owner()
    if (!voiceAvailable(env)) fail(400, 'voice_unavailable', 'La voz todavía no está disponible en tu cuenta. Contacta a Zentekia.')
    const a = await repo.agent(p.id!)
    if (!a) fail(404, 'not_found', 'Agente no encontrado.')
    const b = await readJson(
      request,
      z.object({
        enabled: z.boolean(),
        voice_id: z.string().regex(/^[A-Za-z0-9]{8,40}$/).optional(),
        voice_name: z.string().max(80).optional(),
        model: z.enum(['eleven_flash_v2_5', 'eleven_v4_turbo']).optional(),
        speed: z.number().min(0.7).max(1.2).optional(),
        eagerness: z.enum(['patient', 'normal', 'eager']).optional(),
        first_message: z.string().max(400).optional(),
        /** Si la voz viene de la biblioteca (voces mexicanas), su dueño público para agregarla a la cuenta */
        library_owner_id: z.string().regex(/^[A-Za-z0-9]{6,80}$/).optional(),
      }),
    )
    const cur = voiceCfg(a!)
    if (b.enabled && b.library_owner_id && b.voice_id && b.voice_id !== cur.voice_id) {
      try {
        b.voice_id = await addLibraryVoice(env, b.library_owner_id, b.voice_id, b.voice_name || 'Voz')
      } catch (e) {
        fail(502, 'voice', e instanceof VoiceError ? e.message : 'No se pudo agregar la voz.')
      }
    }
    delete b.library_owner_id
    let next: VoiceConfig = { ...cur, ...b }
    if (b.enabled) {
      if (!next.voice_id) fail(400, 'voice_id', 'Elige una voz.')
      try {
        next = await syncVoiceAgent(env, chatOrigin(env, url), tenant, a!, next)
      } catch (e) {
        const msg = e instanceof VoiceError ? e.message : 'No se pudo activar la voz.'
        await saveVoice(a!, { ...next, enabled: cur.enabled, sync_error: msg })
        fail(502, 'voice', msg)
      }
    }
    await saveVoice(a!, next)
    await audit(b.enabled ? 'voice.updated' : 'voice.disabled', { agent_id: a!.id, voice: next.voice_name, model: next.model })
    return json({ ok: true, ready: Boolean(next.enabled && next.el_agent_id) })
  }

  /* ---------- modelo ---------- */
  if (sub === 'models' && m === 'GET') {
    owner()
    const enabled = enabledModels(tenant)
    const models = (await platform.models(true)).filter((x) => !enabled.length || enabled.includes(x.id))
    const keys = await repo.listProviderKeys()
    const out = []
    for (const mo of models) {
      const price = await effectivePrice(platform, repo, mo)
      out.push({ id: mo.id, provider: mo.provider, name: mo.display_name, type: mo.type, model_name: mo.provider === 'openai-compatible' ? null : mo.model_name, price_in_per_1m_micro: price.in_per_1m, price_out_per_1m_micro: price.out_per_1m, discounted: price.source === 'override' })
    }
    const [from, to] = periodRange(periodOf(Date.now()))
    const spend = await repo.spendBetween(from, to)
    return json({ models: out, keys, fallback_to_hosted: Boolean(tenant.fallback_to_hosted), month: { tokens: (spend?.tin ?? 0) + (spend?.tout ?? 0), cost_micro: spend?.cost ?? 0, limit_micro: tenant.monthly_limit_micro } })
  }
  if ((p = match('agents/:id/model', sub)) && m === 'PUT') {
    owner()
    const a = await repo.agent(p.id!)
    if (!a) fail(404, 'not_found', 'Agente no encontrado.')
    const b = await readJson(request, z.object({ model_id: z.string().max(60), fallback_to_hosted: z.boolean().optional() }))
    const mo = await platform.model(b.model_id)
    const enabled = enabledModels(tenant)
    if (!mo || !mo.active || (enabled.length && !enabled.includes(mo.id))) fail(400, 'model', 'Ese modelo no está habilitado para tu cuenta.')
    if (mo!.type === 'byok' && !(await repo.providerKeyFor(mo!.provider))) fail(400, 'key_required', 'Primero guarda la API key de ese proveedor.')
    const key = mo!.type === 'byok' ? await repo.providerKeyFor(mo!.provider) : null
    await repo.updateAgent(a!.id, { model_id: mo!.id, provider_key_id: key?.id ?? null })
    if (b.fallback_to_hosted !== undefined) await repo.updateSettings({ fallback_to_hosted: b.fallback_to_hosted ? 1 : 0 })
    await audit('agent.model_changed', { agent_id: a!.id, model_id: mo!.id })
    return json({ ok: true })
  }
  if ((p = match('keys/:provider', sub)) && m === 'PUT') {
    owner()
    const provider = z.enum(['anthropic', 'openai', 'openai-compatible']).parse(p.provider)
    const b = await readJson(request, z.object({ api_key: z.string().trim().min(8).max(400).optional(), base_url: z.string().trim().max(300).optional(), model_name: z.string().trim().max(120).optional() }))
    if (provider === 'openai-compatible' && b.base_url && !/^https:\/\//.test(b.base_url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(b.base_url)) fail(400, 'base_url', 'La URL base debe empezar con https://')
    if (!b.api_key) {
      // Solo actualizar URL base / modelo de una llave existente
      const existing = await repo.providerKeyFor(provider)
      if (!existing) fail(400, 'key_required', 'Escribe la API key.')
      await repo.updateProviderKeyMeta(existing!.id, { base_url: b.base_url, model_name: b.model_name })
      await audit('provider_key.updated', { provider })
      return json({ ok: true, id: existing!.id })
    }
    if (!tenant.data_key_enc) fail(500, 'no_data_key', 'Falta la llave de cifrado del cliente.')
    const id = crypto.randomUUID()
    const secret_enc = await encryptForTenant(env, tenant.id, tenant.data_key_enc!, id, b.api_key)
    await repo.insertProviderKey({ id, provider, secret_enc, last4: b.api_key.slice(-4), base_url: b.base_url || null, model_name: b.model_name || null })
    await audit('provider_key.saved', { provider, last4: b.api_key.slice(-4) })
    return json({ ok: true, id })
  }
  if ((p = match('keys/:id/test', sub)) && m === 'POST') {
    owner()
    const k = await repo.providerKeyWithSecret(p.id!)
    if (!k) fail(404, 'not_found', 'Llave no encontrada.')
    const apiKey = await decryptForTenant(env, tenant.id, tenant.data_key_enc!, k!.id, k!.secret_enc)
    const res = await providerFor(env, k!.provider as 'anthropic').testConnection({ apiKey, baseUrl: k!.base_url ?? undefined })
    await repo.setProviderKeyStatus(k!.id, res.ok ? 'ok' : 'error')
    await audit('provider_key.tested', { provider: k!.provider, ok: res.ok })
    return json(res)
  }
  if ((p = match('keys/:id', sub)) && m === 'DELETE') {
    owner()
    const k = await repo.providerKeyWithSecret(p.id!)
    if (!k) fail(404, 'not_found', 'Llave no encontrada.')
    // Los agentes que usaban esa llave regresan a Qwen hosted
    for (const a of await repo.listAgents()) {
      const mo = await platform.model(a.model_id)
      if (mo?.provider === k!.provider) await repo.updateAgent(a.id, { model_id: HOSTED_DEFAULT_MODEL, provider_key_id: null })
    }
    await repo.deleteProviderKey(k!.id)
    await audit('provider_key.deleted', { provider: k!.provider })
    return json({ ok: true })
  }

  /* ---------- base de conocimiento ---------- */
  if (sub === 'kb' && m === 'GET') {
    any()
    const agentId = url.searchParams.get('agent') || ''
    if (!(await repo.agent(agentId))) fail(404, 'not_found', 'Agente no encontrado.')
    // Avanza fuentes pendientes mientras el portal consulta el estado
    const sources = await repo.listSources(agentId)
    const pending = sources.filter((s) => s.status === 'queued' || s.status === 'processing').slice(0, 1)
    for (const s of pending) await processSource(env, repo, s.id, 8_000)
    const plan = PLANS[tenant.plan_id] ?? PLANS.basico!
    const totals = await repo.kbTotals()
    return json({ sources: pending.length ? await repo.listSources(agentId) : sources, limits: { max_sources: plan.maxSources, max_chars: plan.maxKbChars, used_sources: totals?.sources ?? 0, used_chars: totals?.chars ?? 0 }, vector_search: Boolean(env.VECTORIZE) })
  }
  if ((sub === 'kb/text' || sub === 'kb/url' || sub === 'kb/file') && m === 'POST') {
    any()
    const plan = PLANS[tenant.plan_id] ?? PLANS.basico!
    const totals = await repo.kbTotals()
    if ((totals?.sources ?? 0) >= plan.maxSources) fail(400, 'limit', `Tu plan permite hasta ${plan.maxSources} fuentes. Borra alguna o pide a Zentekia ampliar tu plan.`)
    let agentId: string
    let sourceId: string
    if (sub === 'kb/file') {
      const form = await request.formData()
      agentId = String(form.get('agent_id') || '')
      const file = form.get('file')
      if (!file || typeof file === 'string') fail(400, 'file', 'Selecciona un archivo.')
      const f = file as unknown as File
      const ext = (f.name.split('.').pop() || '').toLowerCase()
      if (!ALLOWED_EXT.includes(ext)) fail(400, 'file_type', 'Formatos permitidos: PDF, DOCX, TXT, MD, CSV y HTML.')
      if (f.size > MAX_FILE_BYTES) fail(400, 'file_size', 'El archivo pesa más de 10 MB.')
      if (!(await repo.agent(agentId))) fail(404, 'not_found', 'Agente no encontrado.')
      const bytes = new Uint8Array(await f.arrayBuffer())
      let text: string
      try {
        text = await extractFile(env, f.name, bytes, f.type)
      } catch (e) {
        fail(400, 'parse', e instanceof Error ? e.message : 'No pude leer el archivo.')
        return json({})
      }
      if ((totals?.chars ?? 0) + text.length > plan.maxKbChars) fail(400, 'limit', 'Superas el tamaño total de conocimiento de tu plan.')
      const safeName = f.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120)
      let r2Key: string | null = null
      sourceId = await repo.createSource({ agent_id: agentId, type: ext === 'pdf' ? 'pdf' : ext === 'docx' ? 'docx' : 'file', name: safeName, url: null, r2_key: null, raw_text: text })
      if (env.FILES) {
        r2Key = `tenants/${tenant.id}/kb/${sourceId}/${safeName}`
        await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: f.type || 'application/octet-stream' } })
      }
    } else if (sub === 'kb/url') {
      const b = await readJson(request, z.object({ agent_id: z.string().max(64), url: z.string().trim().url().max(500) }))
      agentId = b.agent_id
      if (!(await repo.agent(agentId))) fail(404, 'not_found', 'Agente no encontrado.')
      sourceId = await repo.createSource({ agent_id: agentId, type: 'url', name: b.url, url: b.url, r2_key: null, raw_text: null })
    } else {
      const b = await readJson(request, z.object({ agent_id: z.string().max(64), name: z.string().trim().min(1).max(120), text: z.string().min(20).max(500_000) }), 600_000)
      agentId = b.agent_id
      if (!(await repo.agent(agentId))) fail(404, 'not_found', 'Agente no encontrado.')
      if ((totals?.chars ?? 0) + b.text.length > plan.maxKbChars) fail(400, 'limit', 'Superas el tamaño total de conocimiento de tu plan.')
      sourceId = await repo.createSource({ agent_id: agentId, type: 'text', name: b.name, url: null, r2_key: null, raw_text: b.text })
    }
    await processSource(env, repo, sourceId, 12_000)
    await audit('kb.source_added', { source_id: sourceId, kind: sub })
    return json({ id: sourceId, source: await repo.source(sourceId).then((s) => s && { id: s.id, status: s.status, error: s.error }) })
  }
  if ((p = match('kb/:id/reprocess', sub)) && m === 'POST') {
    any()
    const s = await repo.source(p.id!)
    if (!s) fail(404, 'not_found', 'Fuente no encontrada.')
    const plan = PLANS[tenant.plan_id] ?? PLANS.basico!
    const period = periodOf(Date.now())
    let recrawl = s!.recrawl_period === period ? s!.recrawl_count : 0
    if (s!.type === 'url') {
      if (recrawl >= plan.recrawlsPerMonth) fail(400, 'limit', `Llegaste a ${plan.recrawlsPerMonth} re-rastreos este mes.`)
      recrawl++
    }
    await deleteVectors(env, await repo.deleteChunks(s!.id))
    await repo.updateSource(s!.id, { status: 'queued', error: null, raw_text: s!.type === 'url' ? null : s!.raw_text, chunk_count: 0, recrawl_count: recrawl, recrawl_period: period })
    await processSource(env, repo, s!.id, 12_000)
    await audit('kb.source_reprocessed', { source_id: s!.id })
    return json({ ok: true })
  }
  if ((p = match('kb/:id', sub)) && m === 'DELETE') {
    any()
    const s = await repo.source(p.id!)
    if (!s) fail(404, 'not_found', 'Fuente no encontrada.')
    await deleteVectors(env, await repo.deleteSource(s!.id))
    if (env.FILES && s!.r2_key) await env.FILES.delete(s!.r2_key)
    await audit('kb.source_deleted', { source_id: s!.id })
    return json({ ok: true })
  }

  /* ---------- widget ---------- */
  if (sub === 'widget' && m === 'GET') {
    any()
    const agentId = url.searchParams.get('agent') || ''
    const a = await repo.agent(agentId)
    const w = a ? await repo.widgetForAgent(a.id) : null
    if (!a || !w) fail(404, 'not_found', 'Widget no encontrado.')
    const theme = mergedTheme(w!)
    return json({
      id: w!.id,
      widget_key: w!.widget_key,
      version: w!.version,
      theme,
      has_logo: Boolean(w!.logo_data || theme.logo_version),
      logo_url: w!.logo_data || theme.logo_version ? `${chatOrigin(env, url)}/v1/widget/logo?key=${w!.widget_key}&v=${theme.logo_version ?? w!.version}` : null,
      can_hide_powered_by: PLANS[tenant.plan_id]?.canHidePoweredBy ?? false,
      welcome: a!.welcome_message,
      suggested: parseJson<AgentConfig>(a!.config_json, {}).suggested_questions || [],
      defaults: DEFAULT_THEME,
    })
  }
  if ((p = match('widget/:id', sub)) && m === 'PUT') {
    any()
    const w = (await repo.widgets()).find((x) => x.id === p!.id)
    if (!w) fail(404, 'not_found', 'Widget no encontrado.')
    const b = await readJson(request, themeSchema)
    const current = parseJson<WidgetTheme>(w!.theme_json, {})
    const next = { ...current, ...b }
    if (!(PLANS[tenant.plan_id]?.canHidePoweredBy ?? false)) next.show_powered_by = true
    const problems = contrastProblems({ ...DEFAULT_THEME, ...next })
    if (problems.length) fail(400, 'contrast', `Poco contraste para leer bien: ${problems.join('; ')}.`)
    await repo.updateWidget(w!.id, { theme_json: JSON.stringify(next) })
    await audit('widget.updated', { widget_id: w!.id, fields: Object.keys(b) })
    return json({ ok: true })
  }
  if ((p = match('widget/:id/logo', sub)) && (m === 'POST' || m === 'DELETE')) {
    any()
    const w = (await repo.widgets()).find((x) => x.id === p!.id)
    if (!w) fail(404, 'not_found', 'Widget no encontrado.')
    const theme = parseJson<WidgetTheme>(w!.theme_json, {})
    if (m === 'DELETE') {
      if (env.FILES) await env.FILES.delete(`tenants/${tenant.id}/brand/logo`)
      delete theme.logo_version
      await repo.updateWidget(w!.id, { logo_data: null, theme_json: JSON.stringify(theme) })
      return json({ ok: true })
    }
    const b = await readJson(request, z.object({ data_url: z.string().max(700_000) }), 800_000)
    const mm = b.data_url.match(/^data:(image\/(png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/)
    if (!mm) fail(400, 'logo_type', 'El logo debe ser PNG, JPG, WEBP o SVG.')
    const bytes = Uint8Array.from(atob(mm![3]!), (c) => c.charCodeAt(0))
    if (bytes.length > 300_000) fail(400, 'logo_size', 'El logo pesa más de 300 KB.')
    if (mm![2] === 'svg+xml') {
      const svg = new TextDecoder().decode(bytes)
      if (/<script|on\w+\s*=|javascript:|<foreignObject|<iframe|<embed|<object|xlink:href\s*=\s*["']https?:|href\s*=\s*["']https?:/i.test(svg)) fail(400, 'logo_svg', 'El SVG trae código o enlaces externos. Expórtalo como PNG o como SVG simple.')
    }
    theme.logo_version = Date.now()
    if (env.FILES) {
      await env.FILES.put(`tenants/${tenant.id}/brand/logo`, bytes, { httpMetadata: { contentType: mm![1] } })
      await repo.updateWidget(w!.id, { logo_data: null, theme_json: JSON.stringify(theme) })
    } else {
      await repo.updateWidget(w!.id, { logo_data: b.data_url, theme_json: JSON.stringify(theme) })
    }
    await audit('widget.logo_updated', { widget_id: w!.id })
    return json({ ok: true })
  }

  /* ---------- instalación ---------- */
  if (sub === 'install/verify' && m === 'POST') {
    any()
    const b = await readJson(request, z.object({ url: z.string().trim().max(500), agent_id: z.string().max(64) }))
    const w = await repo.widgetForAgent(b.agent_id)
    if (!w) fail(404, 'not_found', 'Widget no encontrado.')
    const origin = normalizeOrigin(b.url)
    if (!origin) fail(400, 'url', 'Escribe la dirección de tu sitio, por ejemplo https://misitio.com')
    const target = b.url.startsWith('http') ? b.url : `https://${b.url}`
    let html = ''
    try {
      const r = await fetch(target, { headers: { 'User-Agent': 'ZentekiaChatVerifier/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) })
      html = (await r.text()).slice(0, 3_000_000)
    } catch {
      return json({ found: false, message: 'No pude abrir tu sitio. Revisa que la dirección sea pública.' })
    }
    const found = html.includes(w!.widget_key)
    const allowed = parseJson<string[]>(w!.allowed_origins, []).includes(origin!)
    return json({
      found,
      domain_allowed: allowed,
      message: found
        ? allowed
          ? '¡Listo! Encontramos el widget en tu sitio.'
          : `Encontramos el código, pero ${origin} no está en tus dominios permitidos (Seguridad).`
        : 'No encontramos el código en esa página. Si usas caché o un constructor (Wix, Shopify), publica los cambios y vuelve a intentar.',
    })
  }

  /* ---------- conversaciones ---------- */
  const convFilter = (): ConvFilter => {
    const sp = url.searchParams
    const pick = <T extends string>(k: string, ok: readonly T[]): T | undefined => (ok.includes(sp.get(k) as T) ? (sp.get(k) as T) : undefined)
    return {
      search: (sp.get('q') || '').trim().slice(0, 100) || undefined,
      agentId: sp.get('agent') || undefined,
      from: Number(sp.get('from') || 0) || undefined,
      to: Number(sp.get('to') || 0) || undefined,
      status: pick('status', ['open', 'ended'] as const),
      lead: pick('lead', ['prospect', 'hot', 'warm', 'cold', 'none', 'pending'] as const),
      contact: pick('contact', ['any', 'phone', 'email', 'missing'] as const),
      stage: pick('stage', ['new', 'contacted', 'won', 'lost'] as const),
      channel: pick('channel', ['chat', 'voice'] as const),
      minRating: Math.min(5, Math.max(0, Number(sp.get('rating') || 0))) || undefined,
    }
  }
  if (sub === 'conversations' && m === 'GET') {
    any()
    const page = Math.max(0, Number(url.searchParams.get('page') || 0))
    const res = await repo.listConversations({ ...convFilter(), limit: 30, offset: page * 30 })
    return json(res)
  }
  // Indicadores de prospectos (mismos filtros de agente, periodo y canal)
  if (sub === 'conversations/stats' && m === 'GET') {
    any()
    return json(await repo.leadStats(convFilter()))
  }
  // Analiza a mano las que falten (historial anterior o las que siguen abiertas); con límite de tiempo
  if (sub === 'conversations/analyze-pending' && m === 'POST') {
    any()
    const agentId = url.searchParams.get('agent') || undefined
    const start = Date.now()
    let done = 0
    for (const cid of await repo.pendingAnalysisIds(agentId, 15)) {
      if (Date.now() - start > 20_000) break
      const r = await analyzeConversation(env, tenant, repo, cid, { manual: true, portalBase: portalUrl(env, url, tenant.slug) })
      if (r.ok) done++
    }
    const left = (await repo.pendingAnalysisIds(agentId, 500)).length
    return json({ analyzed: done, pending: left })
  }
  if (sub === 'leads/export.csv' && m === 'GET') {
    owner()
    const f = convFilter()
    const rows = await repo.exportLeads({ ...f, lead: f.lead ?? 'prospect' })
    await audit('leads.exported', { rows: rows.length })
    const T: Record<string, string> = { hot: 'Caliente', warm: 'Tibio', cold: 'Frío', none: 'No prospecto' }
    const S: Record<string, string> = { new: 'Por contactar', contacted: 'Contactado', won: 'Ganado', lost: 'Perdido' }
    const csv = toCsv([
      ['fecha', 'asistente', 'canal', 'temperatura', 'puntaje', 'seguimiento', 'nombre', 'telefono', 'correo', 'empresa', 'interes', 'siguiente_paso', 'resumen', 'conversacion'],
      ...rows.map((r) => [new Date(r.last_message_at).toISOString(), r.agent_name, r.channel === 'voice' ? 'Llamada' : 'Chat', T[r.lead_status || ''] || 'Sin analizar', r.lead_score, S[r.lead_stage || 'new'], r.contact_name, r.contact_phone, r.contact_email, r.contact_company, r.interest, r.next_step, r.summary, r.id]),
    ])
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="prospectos-${tenant.slug}.csv"`, 'Cache-Control': 'no-store' } })
  }
  if ((p = match('conversations/:id/analyze', sub)) && m === 'POST') {
    any()
    if (!(await repo.conversation(p.id!))) fail(404, 'not_found', 'Conversación no encontrada.')
    const r = await analyzeConversation(env, tenant, repo, p.id!, { manual: true, portalBase: portalUrl(env, url, tenant.slug) })
    if (!r.ok) fail(502, 'analysis_failed', 'No se pudo analizar la conversación. Intenta de nuevo en un momento.')
    return json({ ok: true, warning: r.error ?? null, conversation: await repo.conversation(p.id!) })
  }
  // Seguimiento del prospecto: etapa, temperatura y datos de contacto (por si el equipo los corrige)
  if ((p = match('conversations/:id/lead', sub)) && m === 'PUT') {
    any()
    if (!(await repo.conversation(p.id!))) fail(404, 'not_found', 'Conversación no encontrada.')
    const opt = (n: number) => z.string().trim().max(n).nullable().optional()
    const b = await readJson(
      request,
      z.object({
        lead_stage: z.enum(['new', 'contacted', 'won', 'lost']).optional(),
        lead_status: z.enum(['hot', 'warm', 'cold', 'none']).optional(),
        contact_name: opt(80),
        contact_email: opt(120),
        contact_phone: opt(40),
        contact_company: opt(100),
      }),
    )
    const blank = (v: string | null | undefined) => (v === undefined ? undefined : v ? v : null)
    if (b.contact_email && !cleanEmail(b.contact_email)) fail(400, 'invalid', 'El correo no es válido.')
    if (b.contact_phone && !cleanPhone(b.contact_phone)) fail(400, 'invalid', 'El teléfono debe tener entre 8 y 15 dígitos.')
    await repo.updateLead(p.id!, {
      lead_stage: b.lead_stage,
      lead_status: b.lead_status,
      contact_name: blank(b.contact_name),
      contact_email: b.contact_email === undefined ? undefined : cleanEmail(b.contact_email),
      contact_phone: b.contact_phone === undefined ? undefined : cleanPhone(b.contact_phone),
      contact_company: blank(b.contact_company),
    })
    return json({ ok: true, conversation: await repo.conversation(p.id!) })
  }
  if (sub === 'conversations/export.csv' && m === 'GET') {
    owner()
    const now = Date.now()
    const from = Number(url.searchParams.get('from') || 0) || now - 30 * 86_400_000
    const to = Number(url.searchParams.get('to') || 0) || now + 1
    const rows = await repo.exportMessages(from, to)
    await audit('conversations.exported', { from, to, rows: rows.length })
    const csv = toCsv([['conversacion', 'agente', 'sitio', 'rol', 'mensaje', 'fecha'], ...rows.map((r) => [r.conversation_id, r.agent, r.origin, r.role === 'user' ? 'visitante' : 'agente', r.content, new Date(r.created_at).toISOString()])])
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="conversaciones-${tenant.slug}.csv"`, 'Cache-Control': 'no-store' } })
  }
  if ((p = match('conversations/:id', sub))) {
    if (m === 'GET') {
      any()
      const c = await repo.conversation(p.id!)
      if (!c) fail(404, 'not_found', 'Conversación no encontrada.')
      const msgs = await repo.messages(c!.id)
      return json({ conversation: c, messages: msgs.map((x) => ({ id: x.id, role: x.role, content: x.content, created_at: x.created_at, model_id: x.model_id, tokens_in: x.tokens_in, tokens_out: x.tokens_out, feedback: x.feedback })) })
    }
    if (m === 'DELETE') {
      owner()
      if (!(await repo.conversation(p.id!))) fail(404, 'not_found', 'Conversación no encontrada.')
      await repo.deleteConversation(p.id!)
      await audit('conversation.deleted', { conversation_id: p.id })
      return json({ ok: true })
    }
  }

  /* ---------- consumo y costos ---------- */
  if (sub === 'usage' && m === 'GET') {
    owner()
    const period = /^\d{4}-\d{2}$/.test(url.searchParams.get('period') || '') ? url.searchParams.get('period')! : periodOf(Date.now())
    const [from, to] = periodRange(period)
    const daily = await repo.dailyUsage(from, to)
    const byModel = await repo.usageByModel(from, to)
    const totals = await repo.spendBetween(from, to)
    const isCurrent = period === periodOf(Date.now())
    const daysInMonth = Math.round((to - from) / 86_400_000)
    const elapsedDays = isCurrent ? Math.max(1, (Date.now() - from) / 86_400_000) : daysInMonth
    const projection = isCurrent ? Math.round(((totals?.cost ?? 0) / elapsedDays) * daysInMonth) : totals?.cost ?? 0
    const enabled = enabledModels(tenant)
    const models = (await platform.models(true)).filter((x) => !enabled.length || enabled.includes(x.id))
    const prices = []
    for (const mo of models) {
      const pr = await effectivePrice(platform, repo, mo)
      prices.push({ id: mo.id, name: mo.display_name, type: mo.type, in_per_1m_micro: pr.in_per_1m, out_per_1m_micro: pr.out_per_1m })
    }
    const avg = await repo.avgTokensPerConversation(Date.now() - 30 * 86_400_000)
    const agents = await repo.listAgents()
    return json({
      period,
      daily,
      by_model: byModel.map((b) => ({ ...b, name: b.model_id === 'voice:elevenlabs' ? 'Llamadas de voz' : models.find((x) => x.id === b.model_id)?.display_name ?? b.model_id })),
      totals: { tokens_in: totals?.tin ?? 0, tokens_out: totals?.tout ?? 0, cost_micro: totals?.cost ?? 0 },
      projection_micro: projection,
      limit_micro: tenant.monthly_limit_micro,
      limit_behavior: tenant.limit_behavior,
      prices,
      current_model: agents[0]?.model_id,
      avg_per_conversation: avg && avg.convs > 0 ? { tokens_in: Math.round(avg.tin / avg.convs), tokens_out: Math.round(avg.tout / avg.convs), sample: avg.convs } : { tokens_in: 6000, tokens_out: 900, sample: 0 },
      statements: (await repo.statements()).map((s) => ({ period: s.period, total_micro: s.total_micro, status: s.status, tokens_in: s.tokens_in, tokens_out: s.tokens_out })),
    })
  }
  if ((p = match('statements/:period', sub)) && m === 'GET') {
    owner()
    const s = await repo.statement(p.period!)
    if (!s) fail(404, 'not_found', 'Estado de cuenta no encontrado.')
    const lines = parseJson<Array<{ model: string; type: string; tokens_in: number; tokens_out: number; in_per_1m_micro: number; out_per_1m_micro: number; cost_micro: number }>>(s!.lines_json, [])
    if (url.searchParams.get('format') === 'csv') {
      const csv = toCsv([
        ['periodo', 'modelo', 'tipo', 'tokens_entrada', 'tokens_salida', 'tarifa_entrada_usd_1M', 'tarifa_salida_usd_1M', 'importe_usd'],
        ...lines.map((l) => [s!.period, l.model, l.type === 'byok' ? 'fee de plataforma (BYOK)' : 'hosted', l.tokens_in, l.tokens_out, (l.in_per_1m_micro / 1e6).toFixed(4), (l.out_per_1m_micro / 1e6).toFixed(4), (l.cost_micro / 1e6).toFixed(4)]),
        [s!.period, 'TOTAL', '', s!.tokens_in, s!.tokens_out, '', '', (s!.total_micro / 1e6).toFixed(2)],
      ])
      return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="estado-${tenant.slug}-${s!.period}.csv"` } })
    }
    return json({ statement: { ...s, lines }, tenant: { name: tenant.name } })
  }

  /* ---------- equipo ---------- */
  if (sub === 'team' && m === 'GET') {
    owner()
    return json({ users: await repo.users(), me: ctx!.user.id })
  }
  if (sub === 'team/invite' && m === 'POST') {
    owner()
    const b = await readJson(request, z.object({ email: z.string().trim().toLowerCase().email().max(200), role: z.enum(['owner', 'editor']) }))
    let u = await repo.userByEmail(b.email)
    if (u && u.status === 'active') fail(400, 'exists', 'Esa persona ya tiene acceso.')
    if (!u) {
      const id = crypto.randomUUID()
      await repo.createUser({ id, email: b.email, name: null, role: b.role })
      u = await repo.user(id)
    }
    const inv = await createInvite(env, url, tenant, u!.id, b.email)
    await audit('team.invited', { email: b.email, role: b.role })
    return json({ link: inv.link, emailed: inv.emailed })
  }
  if ((p = match('team/:id', sub))) {
    owner()
    const u = await repo.user(p.id!)
    if (!u) fail(404, 'not_found', 'Usuario no encontrado.')
    if (u!.id === ctx!.user.id) fail(400, 'self', 'No puedes cambiar tu propio acceso.')
    if (u!.role === 'owner' && u!.status === 'active' && (await repo.ownerCount()) <= 1) fail(400, 'last_owner', 'Debe quedar al menos un owner.')
    if (m === 'PUT') {
      const b = await readJson(request, z.object({ role: z.enum(['owner', 'editor']) }))
      await repo.setUserRole(u!.id, b.role)
      await audit('team.role_changed', { user_id: u!.id, role: b.role })
      return json({ ok: true })
    }
    if (m === 'DELETE') {
      await repo.deleteUser(u!.id)
      await audit('team.removed', { email: u!.email })
      return json({ ok: true })
    }
  }

  /* ---------- seguridad ---------- */
  if (sub === 'security' && m === 'GET') {
    owner()
    const widgets = await repo.widgets()
    return json({ allowed_origins: parseJson<string[]>(widgets[0]?.allowed_origins, []), retention_days: tenant.retention_days, audit: await platform.tenantAudit(tenant.id, 30) })
  }
  if (sub === 'security' && m === 'PUT') {
    owner()
    const b = await readJson(request, z.object({ allowed_origins: z.array(z.string().max(200)).max(20).optional(), retention_days: z.number().int().min(7).max(3650).optional() }))
    if (b.allowed_origins) {
      const norm = b.allowed_origins.map(normalizeOrigin)
      const bad = b.allowed_origins.filter((_, i) => !norm[i])
      if (bad.length) fail(400, 'origin', `Revisa estos dominios: ${bad.join(', ')}`)
      await repo.setAllowedOrigins([...new Set(norm as string[])])
    }
    if (b.retention_days) await repo.updateSettings({ retention_days: b.retention_days })
    await audit('security.updated', b)
    return json({ ok: true })
  }

  return fail(404, 'not_found', 'Ruta no encontrada.')
}

export { monthSpend }
