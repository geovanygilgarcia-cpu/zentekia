/*
  Conectores de WhatsApp (fase 2 omnicanal). Cada BSP implementa la misma interfaz;
  lo que queda fuera del conector (estados, ruteo, bandeja, IA) vive en channels/process.ts e inbox/core.ts.

  360dialog · https://waba-v2.360dialog.io · encabezado D360-API-KEY (una llave por número)
    - webhook por número: POST /v1/configs/webhook { url, headers } → mandamos un token propio en X-Zentekia-Token
      (y si hay D360_PLATFORM_SECRET también se valida x-360dialog-signature: HMAC-SHA256 hex del cuerpo)
    - formato de eventos de la Cloud API de Meta (entry[].changes[].value.messages / statuses)
  YCloud · https://api.ycloud.com/v2 · encabezado X-API-Key (una llave por cuenta, puede tener varios números)
    - webhook por cuenta: POST /webhookEndpoints → devuelve el secreto; firma YCloud-Signature: t=…,s=…
      con HMAC-SHA256(secreto, `${t}.${cuerpo}`) en hex
    - eventos whatsapp.inbound_message.received y whatsapp.message.updated

  Teléfonos: internamente solo dígitos (E.164 sin «+»). YCloud recibe «+dígitos».
*/
import type { Env } from '../env'

export type WaProvider = '360dialog' | 'ycloud'
export const WA_PROVIDERS: WaProvider[] = ['360dialog', 'ycloud']

export interface WaCreds {
  apiKey: string
  /** Número del negocio, solo dígitos */
  phone: string
  wabaId?: string | null
}

export interface WaNumber {
  phone: string
  display: string
  externalId: string | null
  wabaId: string | null
  verifiedName: string | null
  quality: string | null
  status: string | null
}

export interface WaMedia {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  id?: string | null
  link?: string | null
  mime?: string | null
  caption?: string | null
  filename?: string | null
}

export interface WaInbound {
  kind: 'message'
  /** wamid: llave de deduplicación */
  id: string
  /** Número del cliente (dígitos) */
  from: string
  /** Número del negocio que lo recibió (dígitos) si el BSP lo informa */
  to: string | null
  name: string | null
  at: number
  type: string
  /** Texto para la bandeja y para el modelo */
  text: string
  media?: WaMedia
}

export interface WaStatus {
  kind: 'status'
  /** wamid (o id del BSP) del mensaje saliente */
  id: string
  altId?: string | null
  status: 'sent' | 'delivered' | 'read' | 'failed'
  at: number
  error?: string | null
  /** Número del negocio que lo envió (dígitos) si el BSP lo informa */
  from: string | null
}

export type WaEvent = WaInbound | WaStatus

export interface WaTemplate {
  name: string
  language: string
  category: string | null
  body: string
  /** Variables {{1}}…{{n}} del cuerpo */
  variables: number
  /** false si necesita algo que todavía no mandamos (encabezado con imagen, botones con URL variable…) */
  supported: boolean
}

export interface WaConnector {
  provider: WaProvider
  /** Valida la llave y devuelve los números que puede usar */
  numbers(env: Env, apiKey: string): Promise<WaNumber[]>
  /** Apunta el webhook del BSP a nuestra URL; devuelve el secreto con el que se verificará */
  registerWebhook(env: Env, creds: WaCreds, url: string, ourToken: string): Promise<{ webhookId: string | null; secret: string }>
  unregisterWebhook(env: Env, creds: WaCreds, webhookId: string | null): Promise<void>
  verify(env: Env, headers: Headers, raw: string, secret: string): Promise<boolean>
  parse(body: unknown): WaEvent[]
  sendText(env: Env, creds: WaCreds, to: string, text: string): Promise<string>
  sendTemplate(env: Env, creds: WaCreds, to: string, t: { name: string; language: string; params: string[] }): Promise<string>
  templates(env: Env, creds: WaCreds): Promise<WaTemplate[]>
  media(env: Env, creds: WaCreds, m: WaMedia): Promise<{ body: ArrayBuffer; type: string } | null>
}

/** Error del BSP con mensaje para el cliente (nunca incluye la llave) */
export class WaError extends Error {
  constructor(
    message: string,
    public status = 502,
    public detail?: string,
  ) {
    super(message)
  }
}

export const digits = (s: string | null | undefined) => (s || '').replace(/\D/g, '')
/** WhatsApp corta en 4096 caracteres */
export const WA_MAX_TEXT = 4096

const enc = new TextEncoder()
async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

async function call(url: string, init: RequestInit, label: string): Promise<unknown> {
  let r: Response
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new WaError(`${label}: no se pudo conectar con el proveedor.`)
  }
  const text = await r.text()
  let j: unknown = null
  try {
    j = text ? JSON.parse(text) : null
  } catch {
    /* respuesta no JSON */
  }
  if (!r.ok) {
    const e = j as { error?: { message?: string; error_user_msg?: string } | string; message?: string; meta?: { developer_message?: string } } | null
    const msg = (typeof e?.error === 'object' ? e?.error?.error_user_msg || e?.error?.message : e?.error) || e?.message || e?.meta?.developer_message || ''
    if (r.status === 401 || r.status === 403) throw new WaError(`${label}: la API key no es válida o no tiene permiso.`, 400, msg)
    throw new WaError(`${label}: el proveedor respondió ${r.status}${msg ? ` (${String(msg).slice(0, 200)})` : ''}.`, 502, msg)
  }
  return j
}

/** Texto legible de un mensaje en formato de la Cloud API (también lo usa YCloud) */
function cloudText(m: Record<string, any>): { type: string; text: string; media?: WaMedia } {
  const type = String(m.type || 'unknown')
  switch (type) {
    case 'text':
      return { type, text: String(m.text?.body ?? '') }
    case 'button':
      return { type, text: String(m.button?.text ?? m.button?.payload ?? '') }
    case 'interactive': {
      const r = m.interactive?.button_reply || m.interactive?.list_reply
      return { type, text: String(r?.title ?? r?.id ?? '') }
    }
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const o = m[type] || {}
      const label = { image: 'Imagen', video: 'Video', audio: 'Audio', document: 'Documento', sticker: 'Sticker' }[type]
      const caption = o.caption ? String(o.caption) : ''
      return {
        type,
        text: `[${label}${o.filename ? `: ${o.filename}` : ''}]${caption ? ` ${caption}` : ''}`,
        media: { kind: type, id: o.id ?? null, link: o.link ?? null, mime: o.mime_type ?? null, caption: caption || null, filename: o.filename ?? null },
      }
    }
    case 'location': {
      const l = m.location || {}
      return { type, text: `[Ubicación] ${[l.name, l.address].filter(Boolean).join(', ')} (${l.latitude}, ${l.longitude})`.trim() }
    }
    case 'contacts':
      return { type, text: `[Contacto compartido] ${(m.contacts || []).map((c: any) => c?.name?.formatted_name).filter(Boolean).join(', ')}` }
    default:
      return { type, text: '[Mensaje no compatible]' }
  }
}

const tsMs = (v: unknown) => {
  if (v == null) return Date.now()
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  const s = String(v)
  if (/^\d+$/.test(s)) return Number(s) * (s.length <= 10 ? 1000 : 1)
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : Date.now()
}

function templateFrom(t: { name?: string; language?: string; category?: string; components?: Array<Record<string, any>> }): WaTemplate {
  const comps = t.components || []
  const body = comps.find((c) => String(c.type).toUpperCase() === 'BODY')?.text ?? ''
  const vars = new Set([...String(body).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((x) => x[1])).size
  const header = comps.find((c) => String(c.type).toUpperCase() === 'HEADER')
  const headerOk = !header || String(header.format || 'TEXT').toUpperCase() === 'TEXT' && !/\{\{/.test(String(header.text || ''))
  const buttons = comps.find((c) => String(c.type).toUpperCase() === 'BUTTONS')?.buttons ?? []
  const buttonsOk = !buttons.some((b: any) => /\{\{/.test(String(b?.url || '')) || String(b?.type).toUpperCase() === 'COPY_CODE')
  return { name: String(t.name), language: String(t.language), category: t.category ? String(t.category) : null, body: String(body), variables: vars, supported: headerOk && buttonsOk }
}

const templateComponents = (params: string[]) => (params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [])

/* ---------------- 360dialog ---------------- */
const d360Base = (env: Env) => (env.WA_360_BASE || 'https://waba-v2.360dialog.io').replace(/\/+$/, '')

export const dialog360: WaConnector = {
  provider: '360dialog',
  async numbers(env, apiKey) {
    const j = (await call(`${d360Base(env)}/health_status?fields=display_phone_number,quality_rating,verified_name,status`, { headers: { 'D360-API-KEY': apiKey } }, '360dialog')) as Record<string, any>
    const phone = digits(j?.display_phone_number)
    if (!phone) throw new WaError('360dialog: la llave es válida pero no informó el número. Revisa que el número ya esté activo en 360dialog.', 400)
    return [{ phone, display: String(j.display_phone_number), externalId: null, wabaId: null, verifiedName: j.verified_name ?? null, quality: j.quality_rating ?? null, status: j.status ?? j.health_status?.can_send_message ?? null }]
  },
  async registerWebhook(env, creds, url, ourToken) {
    await call(`${d360Base(env)}/v1/configs/webhook`, { method: 'POST', headers: { 'D360-API-KEY': creds.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ url, headers: { 'X-Zentekia-Token': ourToken } }) }, '360dialog')
    return { webhookId: null, secret: ourToken }
  },
  async unregisterWebhook() {
    // La llave es del número: al desconectar, el cliente puede apuntar el webhook a otro lado desde 360dialog
  },
  async verify(env, headers, raw, secret) {
    const token = headers.get('X-Zentekia-Token') || ''
    if (!token || !sameText(token, secret)) return false
    const sig = headers.get('x-360dialog-signature')
    if (env.D360_PLATFORM_SECRET && sig) return sameText(sig.toLowerCase(), await hmacHex(env.D360_PLATFORM_SECRET, raw))
    return true
  },
  parse(body) {
    const out: WaEvent[] = []
    for (const e of (body as any)?.entry ?? []) {
      for (const c of e?.changes ?? []) {
        const v = c?.value ?? {}
        const to = digits(v.metadata?.display_phone_number) || null
        const names = new Map<string, string>((v.contacts ?? []).map((x: any) => [digits(x?.wa_id), x?.profile?.name]))
        for (const m of v.messages ?? []) {
          if (!m?.id || !m?.from || m.type === 'reaction') continue
          const t = cloudText(m)
          out.push({ kind: 'message', id: String(m.id), from: digits(m.from), to, name: names.get(digits(m.from)) ?? null, at: tsMs(m.timestamp), ...t })
        }
        for (const s of v.statuses ?? []) {
          const st = String(s?.status)
          if (!s?.id || !['sent', 'delivered', 'read', 'failed'].includes(st)) continue
          const err = s.errors?.[0]
          out.push({ kind: 'status', id: String(s.id), status: st as WaStatus['status'], at: tsMs(s.timestamp), error: err ? `${err.code ?? ''} ${err.title ?? err.message ?? ''}`.trim() : null, from: to })
        }
      }
    }
    return out
  },
  async sendText(env, creds, to, text) {
    const j = (await call(`${d360Base(env)}/messages`, { method: 'POST', headers: { 'D360-API-KEY': creds.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(to), type: 'text', text: { body: text.slice(0, WA_MAX_TEXT), preview_url: false } }) }, '360dialog')) as any
    const id = j?.messages?.[0]?.id
    if (!id) throw new WaError('360dialog no devolvió el id del mensaje.')
    return String(id)
  },
  async sendTemplate(env, creds, to, t) {
    const j = (await call(`${d360Base(env)}/messages`, { method: 'POST', headers: { 'D360-API-KEY': creds.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(to), type: 'template', template: { name: t.name, language: { code: t.language }, components: templateComponents(t.params) } }) }, '360dialog')) as any
    const id = j?.messages?.[0]?.id
    if (!id) throw new WaError('360dialog no devolvió el id del mensaje.')
    return String(id)
  },
  async templates(env, creds) {
    const j = (await call(`${d360Base(env)}/message_templates?limit=250`, { headers: { 'D360-API-KEY': creds.apiKey } }, '360dialog')) as any
    const list: any[] = j?.data ?? j?.waba_templates ?? []
    return list.filter((t) => String(t?.status).toUpperCase() === 'APPROVED').map(templateFrom)
  },
  async media(env, creds, m) {
    if (!m.id) return null
    const info = (await call(`${d360Base(env)}/${encodeURIComponent(m.id)}`, { headers: { 'D360-API-KEY': creds.apiKey } }, '360dialog')) as any
    if (!info?.url) return null
    // La URL de Meta (lookaside.fbsbx.com) se descarga a través de 360dialog con la misma llave
    const u = new URL(String(info.url).replace(/\\/g, ''))
    const base = new URL(d360Base(env))
    u.protocol = base.protocol
    u.host = base.host
    const r = await fetch(u.toString(), { headers: { 'D360-API-KEY': creds.apiKey }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return null
    return { body: await r.arrayBuffer(), type: info.mime_type || m.mime || 'application/octet-stream' }
  },
}

/* ---------------- YCloud ---------------- */
const ycBase = (env: Env) => (env.WA_YCLOUD_BASE || 'https://api.ycloud.com/v2').replace(/\/+$/, '')
const YC_EVENTS = ['whatsapp.inbound_message.received', 'whatsapp.message.updated']
/** Tolerancia de la marca de tiempo de la firma (contra reenvíos) */
const YC_TOLERANCE_S = 300

export const ycloud: WaConnector = {
  provider: 'ycloud',
  async numbers(env, apiKey) {
    const j = (await call(`${ycBase(env)}/whatsapp/phoneNumbers?limit=100`, { headers: { 'X-API-Key': apiKey } }, 'YCloud')) as any
    return (j?.items ?? []).map((p: any) => ({
      phone: digits(p.phoneNumber),
      display: String(p.displayPhoneNumber || p.phoneNumber || ''),
      externalId: p.id ?? null,
      wabaId: p.wabaId ?? null,
      verifiedName: p.verifiedName ?? null,
      quality: p.qualityRating ?? null,
      status: p.status ?? null,
    }))
  },
  async registerWebhook(env, creds, url) {
    const j = (await call(`${ycBase(env)}/webhookEndpoints`, { method: 'POST', headers: { 'X-API-Key': creds.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ url, enabledEvents: YC_EVENTS, description: `Zentekia · WhatsApp +${creds.phone}` }) }, 'YCloud')) as any
    if (!j?.secret) throw new WaError('YCloud no devolvió el secreto del webhook.')
    return { webhookId: j.id ?? null, secret: String(j.secret) }
  },
  async unregisterWebhook(env, creds, webhookId) {
    if (!webhookId) return
    await call(`${ycBase(env)}/webhookEndpoints/${encodeURIComponent(webhookId)}`, { method: 'DELETE', headers: { 'X-API-Key': creds.apiKey } }, 'YCloud').catch(() => null)
  },
  async verify(_env, headers, raw, secret) {
    const h = headers.get('YCloud-Signature') || ''
    let t = ''
    const sigs: string[] = []
    for (const part of h.split(',')) {
      const [k, ...v] = part.trim().split('=')
      if (k === 't') t = v.join('=')
      else if (k === 's') sigs.push(v.join('=').toLowerCase())
    }
    if (!/^\d+$/.test(t) || !sigs.length) return false
    if (Math.abs(Date.now() / 1000 - Number(t)) > YC_TOLERANCE_S) return false
    const expected = await hmacHex(secret, `${t}.${raw}`)
    return sigs.some((s) => sameText(s, expected))
  },
  parse(body) {
    const b = body as any
    if (b?.type === 'whatsapp.inbound_message.received' && b.whatsappInboundMessage) {
      const m = b.whatsappInboundMessage
      if (!m.wamid && !m.id) return []
      if (m.type === 'reaction') return []
      const t = cloudText(m)
      return [{ kind: 'message', id: String(m.wamid || m.id), from: digits(m.from), to: digits(m.to) || null, name: m.customerProfile?.name ?? null, at: tsMs(m.sendTime), ...t }]
    }
    if (b?.type === 'whatsapp.message.updated' && b.whatsappMessage) {
      const m = b.whatsappMessage
      const st = String(m.status)
      if (!['sent', 'delivered', 'read', 'failed'].includes(st)) return []
      const at = tsMs(m.readTime || m.deliverTime || m.sendTime || m.updateTime || b.createTime)
      return [{ kind: 'status', id: String(m.wamid || m.id), altId: m.id ?? null, status: st as WaStatus['status'], at, error: st === 'failed' ? `${m.errorCode ?? ''} ${m.errorMessage ?? ''}`.trim() || null : null, from: digits(m.from) || null }]
    }
    return []
  },
  async sendText(env, creds, to, text) {
    const j = (await call(`${ycBase(env)}/whatsapp/messages/sendDirectly`, { method: 'POST', headers: { 'X-API-Key': creds.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: `+${creds.phone}`, to: `+${digits(to)}`, type: 'text', text: { body: text.slice(0, WA_MAX_TEXT) } }) }, 'YCloud')) as any
    if (j?.status === 'failed') throw new WaError(`YCloud no pudo enviar: ${j.errorMessage || j.errorCode || 'error'}.`)
    const id = j?.wamid || j?.id
    if (!id) throw new WaError('YCloud no devolvió el id del mensaje.')
    return String(id)
  },
  async sendTemplate(env, creds, to, t) {
    const j = (await call(`${ycBase(env)}/whatsapp/messages/sendDirectly`, { method: 'POST', headers: { 'X-API-Key': creds.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: `+${creds.phone}`, to: `+${digits(to)}`, type: 'template', template: { name: t.name, language: { code: t.language, policy: 'deterministic' }, components: templateComponents(t.params) } }) }, 'YCloud')) as any
    if (j?.status === 'failed') throw new WaError(`YCloud no pudo enviar la plantilla: ${j.errorMessage || j.errorCode || 'error'}.`)
    const id = j?.wamid || j?.id
    if (!id) throw new WaError('YCloud no devolvió el id del mensaje.')
    return String(id)
  },
  async templates(env, creds) {
    const q = new URLSearchParams({ limit: '100', 'filter.status': 'APPROVED' })
    if (creds.wabaId) q.set('filter.wabaId', creds.wabaId)
    const j = (await call(`${ycBase(env)}/whatsapp/templates?${q}`, { headers: { 'X-API-Key': creds.apiKey } }, 'YCloud')) as any
    return (j?.items ?? []).filter((t: any) => String(t?.status).toUpperCase() === 'APPROVED').map(templateFrom)
  },
  async media(_env, creds, m) {
    if (!m.link) return null
    const r = await fetch(m.link, { headers: { 'X-API-Key': creds.apiKey }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return null
    return { body: await r.arrayBuffer(), type: r.headers.get('Content-Type') || m.mime || 'application/octet-stream' }
  },
}

export const connectorFor = (p: string): WaConnector | null => (p === '360dialog' ? dialog360 : p === 'ycloud' ? ycloud : null)
