/*
  Login del panel
  ===============
  - Usuario: variable ADMIN_USER (si no existe, "admin").
  - Contraseña: secreto ADMIN_PASSWORD (se configura en Cloudflare, nunca en el código).
  - Al entrar se entrega un token firmado que dura 12 horas.
    Si cambias la contraseña, todas las sesiones abiertas se cierran solas.
*/

const DURACION_MS = 12 * 60 * 60 * 1000
const enc = new TextEncoder()

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const desdeB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function sha256(texto) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(texto)))
}

// Comparación en tiempo constante (no revela cuántos caracteres coinciden)
function iguales(a, b) {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]
  return r === 0
}

async function claveFirma(env) {
  const material = await sha256('agente-admin-sesion:' + env.ADMIN_PASSWORD)
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export function loginConfigurado(env) {
  return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 8
}

export async function credencialesValidas(env, usuario, contrasena) {
  const u = await sha256(String(usuario || ''))
  const p = await sha256(String(contrasena || ''))
  const okU = iguales(u, await sha256(env.ADMIN_USER || 'admin'))
  const okP = iguales(p, await sha256(env.ADMIN_PASSWORD))
  return okU && okP
}

export async function crearToken(env, usuario) {
  const datos = b64url(enc.encode(JSON.stringify({ u: usuario, exp: Date.now() + DURACION_MS })))
  const firma = await crypto.subtle.sign('HMAC', await claveFirma(env), enc.encode(datos))
  return `${datos}.${b64url(firma)}`
}

export async function leerToken(env, request) {
  if (!loginConfigurado(env)) return null
  const h = request.headers.get('Authorization') || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const [datos, firma] = token.split('.')
  if (!datos || !firma) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await claveFirma(env), desdeB64url(firma), enc.encode(datos))
    if (!ok) return null
    const sesion = JSON.parse(new TextDecoder().decode(desdeB64url(datos)))
    return sesion.exp > Date.now() ? sesion : null
  } catch {
    return null
  }
}

// Máximo 5 intentos de login por IP cada 5 minutos
const intentos = new Map()
export function demasiadosIntentos(ip) {
  const ahora = Date.now()
  const lista = (intentos.get(ip) || []).filter((t) => ahora - t < 5 * 60_000)
  lista.push(ahora)
  intentos.set(ip, lista)
  if (intentos.size > 2000) intentos.clear()
  return lista.length > 5
}
