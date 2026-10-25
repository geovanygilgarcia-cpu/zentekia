/*
  Canal de voz con ElevenLabs Agents.
  - Cada asistente con voz activada tiene un "agente" espejo en ElevenLabs (privado: solo entra con un token que da este Worker).
  - El prompt, el saludo y la voz se copian desde Zentekia cada vez que se guardan.
  - El conocimiento NO se copia: ElevenLabs lo consulta en vivo con la herramienta "buscar_informacion",
    que llama a este Worker (misma base de conocimiento que el chat).
  - Al colgar, la transcripción se guarda en Conversaciones y el tiempo se cobra en Consumo.
*/
import type { Env } from '../env'
import { signToken } from '../auth/crypto'
import { parseJson, type AgentConfig, type AgentRow, type TenantRow, type VoiceConfig } from '../db/types'
import { buildVoiceSystem } from '../models/context'

const API = 'https://api.elevenlabs.io'
/** Modelo de lenguaje que usa ElevenLabs para pensar la respuesta (rápido y barato) */
export const VOICE_LLM = 'gemini-2.5-flash'
export const VOICE_MODELS = ['eleven_flash_v2_5', 'eleven_v4_turbo'] as const
export const DEFAULT_VOICE_MODEL = 'eleven_flash_v2_5'

/** Error de ElevenLabs con mensaje en español para el portal */
export class VoiceError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message)
  }
}

export const voiceAvailable = (env: Env) => Boolean(env.ELEVENLABS_API_KEY)

async function el<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.ELEVENLABS_API_KEY) throw new VoiceError('La voz no está configurada en la plataforma (falta ELEVENLABS_API_KEY).')
  let r: Response
  try {
    r = await fetch(API + path, {
      ...init,
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new VoiceError('No hubo respuesta de ElevenLabs. Intenta de nuevo en un momento.')
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    console.error(JSON.stringify({ level: 'warn', msg: 'elevenlabs_error', path: path.split('?')[0], status: r.status, body: body.slice(0, 500) }))
    if (r.status === 401) throw new VoiceError('ElevenLabs rechazó la llave (ELEVENLABS_API_KEY).', 401)
    if (r.status === 429) throw new VoiceError('ElevenLabs está ocupado o se acabó el saldo de minutos. Intenta en un momento.', 429)
    throw new VoiceError(`ElevenLabs respondió con error ${r.status}.`, r.status)
  }
  return (await r.json()) as T
}

/* ---------------- voces ---------------- */
export interface VoiceInfo {
  voice_id: string
  name: string
  category: string
  preview_url: string | null
  gender: string | null
  accent: string | null
  description: string | null
  spanish: boolean
  /** Voz de la biblioteca pública (se agrega a la cuenta al activarla) */
  owner_id?: string
  in_account?: boolean
}

interface ElVoice {
  voice_id: string
  name: string
  category?: string
  preview_url?: string | null
  labels?: Record<string, string>
  description?: string | null
  verified_languages?: Array<{ language?: string; accent?: string | null; preview_url?: string | null; locale?: string | null }>
}

export async function listVoices(env: Env, search?: string): Promise<VoiceInfo[]> {
  const q = new URLSearchParams({ page_size: '100' })
  if (search) q.set('search', search)
  const r = await el<{ voices: ElVoice[] }>(env, `/v2/voices?${q}`)
  return r.voices.map((v) => {
    const es = v.verified_languages?.find((l) => l.language === 'es')
    return {
      voice_id: v.voice_id,
      name: v.name,
      category: v.category || 'premade',
      // Si la voz tiene muestra en español, esa es la que se oye en el portal
      preview_url: es?.preview_url || v.preview_url || null,
      gender: v.labels?.gender ?? null,
      accent: es?.accent || es?.locale || v.labels?.accent || null,
      description: v.labels?.description || v.labels?.descriptive || v.labels?.use_case || null,
      spanish: Boolean(es),
    }
  })
}

/* ---------------- biblioteca: voces mexicanas ---------------- */
interface SharedVoice {
  public_owner_id: string
  voice_id: string
  name: string
  accent?: string | null
  gender?: string | null
  age?: string | null
  descriptive?: string | null
  use_case?: string | null
  category?: string | null
  locale?: string | null
  preview_url?: string | null
  fiat_rate?: number | null
  rate?: number | null
  is_added_by_user?: boolean
  description?: string | null
  verified_languages?: Array<{ language?: string; accent?: string | null; locale?: string | null; preview_url?: string | null }>
}

/** Etiquetas de ElevenLabs en español para el portal */
const ES_LABEL: Record<string, string> = {
  young: 'joven', middle_aged: 'adulta', 'middle-aged': 'adulta', old: 'madura',
  warm: 'cálida', calm: 'tranquila', confident: 'segura', casual: 'casual', professional: 'profesional', friendly: 'amable',
  deep: 'grave', soft: 'suave', energetic: 'enérgica', upbeat: 'animada', clear: 'clara', natural: 'natural', smooth: 'suave',
  conversational: 'conversación', narrative_story: 'narración', narration: 'narración', social_media: 'redes sociales',
  characters_animation: 'personajes', informative_educational: 'informativa', advertisement: 'comercial', entertainment_tv: 'entretenimiento',
}
const esLabel = (x?: string | null) => (x ? ES_LABEL[x.toLowerCase()] || x.replace(/_/g, ' ') : null)

const isMx = (v: SharedVoice & { description?: string | null }) =>
  /mex/i.test(v.accent || '') ||
  /es-mx/i.test(v.locale || '') ||
  Boolean(v.verified_languages?.some((l) => /es-mx/i.test(l.locale || '') || /mex/i.test(l.accent || ''))) ||
  /mexic|méxic/i.test(`${v.name} ${v.description || ''}`)

export interface MxDiag {
  queries: number
  failed: number
  errors: string[]
  raw: number
  mexican: number
  paid_skipped: number
}

/**
 * Solo voces con acento mexicano: las de la biblioteca de ElevenLabs + las que ya estén en la cuenta.
 * Se hacen varias búsquedas en paralelo porque ElevenLabs etiqueta el acento de formas distintas.
 */
export async function listMexicanVoices(env: Env): Promise<{ voices: VoiceInfo[]; diag: MxDiag }> {
  const queries: Array<Record<string, string>> = [
    { language: 'es', accent: 'mexican' },
    { language: 'es', locale: 'es-MX' },
    { language: 'es', search: 'mexican' },
    { search: 'mexicano' },
    { search: 'mexico' },
  ]
  const results = await Promise.allSettled(
    queries.map((extra) => el<{ voices: SharedVoice[] }>(env, `/v1/shared-voices?${new URLSearchParams({ page_size: '100', ...extra })}`)),
  )
  const diag: MxDiag = { queries: queries.length, failed: 0, errors: [], raw: 0, mexican: 0, paid_skipped: 0 }
  const seen = new Map<string, SharedVoice>()
  for (const r of results) {
    if (r.status === 'rejected') {
      diag.failed++
      diag.errors.push(r.reason instanceof VoiceError ? r.reason.message : 'error')
      continue
    }
    diag.raw += r.value.voices?.length || 0
    for (const v of r.value.voices || []) if (isMx(v) && !seen.has(v.voice_id)) seen.set(v.voice_id, v)
  }
  // Si TODAS las búsquedas fallaron, el portal muestra el motivo real (por ejemplo, falta un permiso en la llave)
  if (diag.failed === queries.length) throw new VoiceError(diag.errors[0] || 'No se pudo consultar la biblioteca de voces de ElevenLabs.')
  diag.mexican = seen.size

  const out: VoiceInfo[] = []
  for (const v of seen.values()) {
    // Solo se dejan fuera las voces con precio propio en dólares (cobro extra por uso)
    if (v.fiat_rate && v.fiat_rate > 0) {
      diag.paid_skipped++
      continue
    }
    const es = v.verified_languages?.find((l) => /es-mx/i.test(l.locale || '') || /mex/i.test(l.accent || '')) || v.verified_languages?.find((l) => l.language === 'es')
    out.push({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category || 'library',
      preview_url: es?.preview_url || v.preview_url || null,
      gender: (v.gender || '').toLowerCase() || null,
      accent: 'mexicano',
      description: [esLabel(v.age), esLabel(v.descriptive), esLabel(v.use_case)].filter(Boolean).join(', ') || null,
      spanish: true,
      owner_id: v.public_owner_id,
      in_account: Boolean(v.is_added_by_user),
    })
  }

  // Voces mexicanas que ya estén en la cuenta (por ejemplo, agregadas a mano en ElevenLabs)
  try {
    const mine = await listVoices(env)
    for (const v of mine) {
      if (/mex|es-mx/i.test(`${v.accent || ''} ${v.description || ''} ${v.name}`) && !out.some((x) => x.voice_id === v.voice_id)) {
        out.push({ ...v, accent: 'mexicano', in_account: true })
      }
    }
  } catch {
    /* sin permiso para leer las voces de la cuenta: se muestran solo las de la biblioteca */
  }
  return { voices: out, diag }
}

/** Agrega una voz de la biblioteca a la cuenta de ElevenLabs y devuelve el id que se usa en el agente */
export async function addLibraryVoice(env: Env, ownerId: string, voiceId: string, name: string): Promise<string> {
  try {
    const r = await el<{ voice_id: string }>(env, `/v1/voices/add/${encodeURIComponent(ownerId)}/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      body: JSON.stringify({ new_name: `${name} (MX)`.slice(0, 80) }),
    })
    return r.voice_id
  } catch (e) {
    if (e instanceof VoiceError && (e.status === 400 || e.status === 422)) {
      throw new VoiceError('No se pudo agregar esa voz a tu cuenta de ElevenLabs (puede que ya no tengas espacios para voces de la biblioteca en tu plan). Prueba con otra o libera espacio en ElevenLabs → Voces.', e.status)
    }
    throw e
  }
}

/* ---------------- sincronizar el asistente ---------------- */
export function voiceCfg(agent: AgentRow): VoiceConfig {
  return parseJson<AgentConfig>(agent.config_json, {}).voice || {}
}

/** URL firmada de la herramienta de conocimiento: ElevenLabs la llama, y solo sirve para este asistente */
async function toolUrl(env: Env, chat: string, tenant: TenantRow, agent: AgentRow) {
  const sig = await signToken(env, 'voicetool', { t: tenant.id, a: agent.id })
  return `${chat}/v1/voice/tool/kb?s=${encodeURIComponent(sig)}`
}

function agentBody(tenant: TenantRow, agent: AgentRow, v: VoiceConfig, toolId: string | undefined) {
  const cfg = parseJson<AgentConfig>(agent.config_json, {})
  const first = (v.first_message ?? '').trim() || agent.welcome_message.replace(/\*\*/g, '').trim()
  return {
    name: `${tenant.slug} · ${agent.name}`.slice(0, 120),
    tags: ['zentekia', `tenant:${tenant.id}`, `agent:${agent.id}`],
    conversation_config: {
      agent: {
        first_message: first,
        language: agent.language || 'es',
        prompt: {
          prompt: buildVoiceSystem(tenant, agent),
          llm: VOICE_LLM,
          temperature: Math.min(1, Math.max(0, agent.temperature)),
          tool_ids: toolId ? [toolId] : [],
          built_in_tools: {
            // Colgar: siempre disponible (despedida, o cuando se cumpla "cuándo finalizar")
            end_call: { type: 'system', name: 'end_call', description: '', params: { system_tool_type: 'end_call' } },
          },
        },
      },
      tts: {
        voice_id: v.voice_id,
        model_id: VOICE_MODELS.includes(v.model as (typeof VOICE_MODELS)[number]) ? v.model : DEFAULT_VOICE_MODEL,
        speed: Math.min(1.2, Math.max(0.7, v.speed ?? 1)),
        stability: 0.5,
        similarity_boost: 0.8,
      },
      turn: {
        turn_eagerness: ['patient', 'normal', 'eager'].includes(v.eagerness || '') ? v.eagerness : 'eager',
      },
      asr: { keywords: [cfg.business_name || tenant.name, agent.name].filter(Boolean).slice(0, 10) },
      conversation: {
        max_duration_seconds: 600,
        client_events: ['audio', 'interruption', 'user_transcript', 'agent_response', 'agent_response_correction', 'ping'],
      },
    },
    // Privado: solo se conecta con el token de corta vida que entrega /v1/voice/session
    platform_settings: { auth: { enable_auth: true } },
  }
}

async function ensureTool(env: Env, chat: string, tenant: TenantRow, agent: AgentRow, v: VoiceConfig): Promise<string> {
  const tool_config = {
    type: 'webhook',
    name: 'buscar_informacion',
    description:
      'Busca en la base de conocimiento del negocio (precios, productos, políticas, horarios, preguntas frecuentes). Úsala ANTES de responder cualquier dato concreto del negocio que no esté en tus instrucciones.',
    response_timeout_secs: 8,
    api_schema: {
      url: await toolUrl(env, chat, tenant, agent),
      method: 'POST',
      request_headers: { 'Content-Type': 'application/json' },
      request_body_schema: {
        type: 'object',
        description: 'La consulta a buscar',
        properties: { pregunta: { type: 'string', description: 'Lo que el cliente quiere saber, en pocas palabras' } },
        required: ['pregunta'],
      },
    },
  }
  if (v.el_tool_id) {
    try {
      await el(env, `/v1/convai/tools/${v.el_tool_id}`, { method: 'PATCH', body: JSON.stringify({ tool_config }) })
      return v.el_tool_id
    } catch (e) {
      if (!(e instanceof VoiceError) || e.status !== 404) throw e
    }
  }
  const r = await el<{ id: string }>(env, '/v1/convai/tools', { method: 'POST', body: JSON.stringify({ tool_config }) })
  return r.id
}

/** Crea o actualiza el agente espejo. Devuelve la configuración con los ids de ElevenLabs. */
export async function syncVoiceAgent(env: Env, chat: string, tenant: TenantRow, agent: AgentRow, v: VoiceConfig): Promise<VoiceConfig> {
  if (!v.voice_id) throw new VoiceError('Elige una voz.')
  const toolId = await ensureTool(env, chat, tenant, agent, v)
  const body = agentBody(tenant, agent, v, toolId)
  let agentId = v.el_agent_id
  if (agentId) {
    try {
      await el(env, `/v1/convai/agents/${agentId}`, { method: 'PATCH', body: JSON.stringify(body) })
    } catch (e) {
      // Si lo borraron en ElevenLabs, se crea otro
      if (e instanceof VoiceError && e.status === 404) agentId = undefined
      else throw e
    }
  }
  if (!agentId) agentId = (await el<{ agent_id: string }>(env, '/v1/convai/agents/create', { method: 'POST', body: JSON.stringify(body) })).agent_id
  return { ...v, el_agent_id: agentId, el_tool_id: toolId, synced_at: Date.now(), sync_error: null }
}

/** Token de una sola llamada (WebRTC) para el navegador del visitante */
export async function conversationToken(env: Env, elAgentId: string): Promise<string> {
  const r = await el<{ token: string }>(env, `/v1/convai/conversation/token?agent_id=${encodeURIComponent(elAgentId)}`)
  return r.token
}

export interface ElConversation {
  conversation_id: string
  agent_id: string
  status: 'initiated' | 'in-progress' | 'processing' | 'done' | 'failed'
  transcript: Array<{ role: 'user' | 'agent'; message?: string | null; time_in_call_secs: number }>
  metadata: { start_time_unix_secs: number; call_duration_secs: number; cost_fiat?: number | null; termination_reason?: string | null }
  analysis?: { call_successful?: string; transcript_summary?: string; call_summary_title?: string | null } | null
}

export function getConversation(env: Env, id: string) {
  return el<ElConversation>(env, `/v1/convai/conversations/${encodeURIComponent(id)}`)
}

/** Precio por minuto que se le cobra al cliente (micro-USD por segundo) */
export function voiceMicroPerSecond(env: Env): number {
  const perMin = Number(env.VOICE_PRICE_PER_MIN || '0.15')
  return Math.round(((Number.isFinite(perMin) && perMin >= 0 ? perMin : 0.15) * 1e6) / 60)
}
