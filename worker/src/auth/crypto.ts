/*
  Criptografía con WebCrypto (nativo en Workers, sin librerías).
  - Contraseñas: PBKDF2-SHA256, 100,000 iteraciones (máximo que permite Workers) con sal de 16 bytes.
    Argon2id/scrypt no existen en WebCrypto; PBKDF2 es la alternativa nativa.
  - API keys de clientes: cifrado por sobre (envelope) con AES-256-GCM.
      MASTER_KEY (secreto de Workers) protege una data key por cliente; la data key cifra las API keys.
  - Firmas HMAC-SHA256 para tokens del widget.
*/
import type { Env } from '../env'
import { b64, fromB64, b64url, fromB64url, fail, safeEqual } from '../lib/http'

const enc = new TextEncoder()
const dec = new TextDecoder()
const PBKDF2_ITER = 100_000

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const bits = await pbkdf2(password, salt, PBKDF2_ITER)
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(bits)}`
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Trabajo equivalente para no revelar por tiempo si el usuario existe
    await pbkdf2(password, new Uint8Array(16), PBKDF2_ITER)
    return false
  }
  const [alg, iter, salt, hash] = stored.split('$')
  if (alg !== 'pbkdf2' || !iter || !salt || !hash) return false
  const bits = await pbkdf2(password, fromB64(salt), Number(iter))
  return safeEqual(bits, fromB64(hash))
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
  return new Uint8Array(bits)
}

export function passwordPolicy(p: string): string | null {
  if (p.length < 10) return 'La contraseña debe tener al menos 10 caracteres.'
  if (p.length > 200) return 'La contraseña es demasiado larga.'
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Usa letras y números.'
  return null
}

/* ---------------- envelope encryption ---------------- */

async function masterKey(env: Env): Promise<CryptoKey> {
  if (!env.MASTER_KEY) fail(503, 'master_key_missing', 'Falta configurar el secreto MASTER_KEY en el Worker.')
  let raw: Uint8Array
  try {
    raw = fromB64(env.MASTER_KEY!.trim())
  } catch {
    return fail(503, 'master_key_invalid', 'MASTER_KEY debe ser base64 de 32 bytes.')
  }
  if (raw.length !== 32) fail(503, 'master_key_invalid', 'MASTER_KEY debe ser base64 de 32 bytes.')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function aesEncrypt(key: CryptoKey, plain: Uint8Array, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain)
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`
}

async function aesDecrypt(key: CryptoKey, payload: string, aad: string): Promise<Uint8Array> {
  const [v, iv, ct] = payload.split('.')
  if (v !== 'v1' || !iv || !ct) throw new Error('formato cifrado inválido')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: enc.encode(aad) }, key, fromB64(ct))
  return new Uint8Array(pt)
}

/** Nueva data key de un cliente, ya protegida con la MASTER_KEY */
export async function newWrappedDataKey(env: Env, tenantId: string): Promise<string> {
  const mk = await masterKey(env)
  const dk = crypto.getRandomValues(new Uint8Array(32))
  return aesEncrypt(mk, dk, `dk:${tenantId}`)
}

async function unwrapDataKey(env: Env, tenantId: string, wrapped: string): Promise<CryptoKey> {
  const mk = await masterKey(env)
  const raw = await aesDecrypt(mk, wrapped, `dk:${tenantId}`)
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Cifra un secreto del cliente. El AAD liga el texto cifrado a ese cliente y a ese registro. */
export async function encryptForTenant(env: Env, tenantId: string, wrapped: string, recordId: string, secret: string): Promise<string> {
  const dk = await unwrapDataKey(env, tenantId, wrapped)
  return aesEncrypt(dk, enc.encode(secret), `${tenantId}:${recordId}`)
}

/** Descifra solo en memoria, justo antes de llamar al proveedor. Nunca se registra en logs. */
export async function decryptForTenant(env: Env, tenantId: string, wrapped: string, recordId: string, payload: string): Promise<string> {
  const dk = await unwrapDataKey(env, tenantId, wrapped)
  return dec.decode(await aesDecrypt(dk, payload, `${tenantId}:${recordId}`))
}

/** Para el secreto TOTP de superadmin (sin tenant) se usa la master key directa */
export async function encryptPlatform(env: Env, label: string, secret: string): Promise<string> {
  return aesEncrypt(await masterKey(env), enc.encode(secret), `platform:${label}`)
}
export async function decryptPlatform(env: Env, label: string, payload: string): Promise<string> {
  return dec.decode(await aesDecrypt(await masterKey(env), payload, `platform:${label}`))
}

/* ---------------- HMAC (tokens del widget) ---------------- */

async function hmacKey(env: Env, purpose: string): Promise<CryptoKey> {
  if (!env.MASTER_KEY) fail(503, 'master_key_missing', 'Falta configurar el secreto MASTER_KEY en el Worker.')
  const base = await crypto.subtle.importKey('raw', enc.encode(env.MASTER_KEY!), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('zentekia-chat'), info: enc.encode(purpose) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
}

export async function signToken(env: Env, purpose: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env, purpose), enc.encode(body))
  return `${body}.${b64url(sig)}`
}

export async function verifyToken<T>(env: Env, purpose: string, token: string): Promise<T | null> {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env, purpose), fromB64url(sig), enc.encode(body))
    if (!ok) return null
    const p = JSON.parse(dec.decode(fromB64url(body))) as T & { exp?: number }
    if (typeof p.exp === 'number' && p.exp < Date.now()) return null
    return p
  } catch {
    return null
  }
}

/* ---------------- TOTP (RFC 6238, SHA-1, 6 dígitos, 30 s) ---------------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function newTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  let bits = ''
  for (const b of bytes) bits += b.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]
  return out
}

function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '')
  let bits = ''
  for (const c of clean) {
    const v = B32.indexOf(c)
    if (v < 0) continue
    bits += v.toString(2).padStart(5, '0')
  }
  const out = new Uint8Array(Math.floor(bits.length / 8))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  return out
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const buf = new ArrayBuffer(8)
  const view = new DataView(buf)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter >>> 0)
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf))
  const off = h[h.length - 1]! & 0xf
  const code = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!
  return String(code % 1_000_000).padStart(6, '0')
}

export async function verifyTotp(secretB32: string, code: string, at = Date.now()): Promise<boolean> {
  const c = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) return false
  const secret = base32Decode(secretB32)
  const step = Math.floor(at / 30_000)
  for (const d of [-1, 0, 1]) {
    if (safeEqual(enc.encode(await hotp(secret, step + d)), enc.encode(c))) return true
  }
  return false
}

export async function totpNow(secretB32: string, at = Date.now()): Promise<string> {
  return hotp(base32Decode(secretB32), Math.floor(at / 30_000))
}
