import { z } from 'zod'

/** Error con formato uniforme: { error: { code, message } } */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message)
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extra,
    },
  })
}

export function errorResponse(e: unknown, extra: Record<string, string> = {}): Response {
  if (e instanceof HttpError) {
    return json({ error: { code: e.code, message: e.message } }, e.status, extra)
  }
  if (e instanceof z.ZodError) {
    const first = e.issues[0]
    const campo = first?.path.join('.') || 'datos'
    return json({ error: { code: 'invalid_input', message: `Revisa el campo «${campo}»: ${first?.message ?? 'inválido'}` } }, 400, extra)
  }
  // Nunca se manda el detalle interno al cliente; en los logs va sin contenido sensible
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled', error: e instanceof Error ? e.message : String(e) }))
  return json({ error: { code: 'internal', message: 'Error interno. Intenta de nuevo en un momento.' } }, 500, extra)
}

export async function readJson<T extends z.ZodTypeAny>(request: Request, schema: T, maxBytes = 200_000): Promise<z.infer<T>> {
  const len = Number(request.headers.get('Content-Length') || 0)
  if (len > maxBytes) fail(413, 'too_large', 'La solicitud es demasiado grande.')
  const text = await request.text()
  if (text.length > maxBytes) fail(413, 'too_large', 'La solicitud es demasiado grande.')
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    fail(400, 'invalid_json', 'El cuerpo debe ser JSON válido.')
  }
  return schema.parse(data)
}

export const now = () => Date.now()

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return b64url(b)
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

export function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

export function fromB64(s: string): Uint8Array {
  const b = atob(s)
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** Comparación en tiempo constante */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a[i]! ^ b[i]!
  return r === 0
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0'
}

export const log = (data: Record<string, unknown>) => console.log(JSON.stringify({ level: 'info', ...data }))
