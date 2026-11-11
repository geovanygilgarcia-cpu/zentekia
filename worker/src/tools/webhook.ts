/*
  Webhook saliente de un asistente.
  - Solo HTTPS y solo dominios públicos (no IPs privadas, localhost ni .local/.internal).
  - Cada envío va firmado: X-Zentekia-Signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<cuerpo>")>
    y X-Zentekia-Timestamp, para que el receptor verifique que viene de Zentekia y no es una repetición.
  - Un intento, 8 segundos máximo; el resultado se guarda para mostrarlo en el portal.
*/

export interface WebhookResult {
  ok: boolean
  status: number | null
  error: string | null
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost|0\.0\.0\.0|\[?::1?\]?)$/i
const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

/** Devuelve el URL normalizado o un mensaje de error para el usuario */
export function checkWebhookUrl(raw: string): { url: string } | { error: string } {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { error: 'Escribe un URL completo, por ejemplo https://hooks.zapier.com/…' }
  }
  if (u.protocol !== 'https:') return { error: 'El webhook debe usar https://' }
  const h = u.hostname.toLowerCase()
  if (PRIVATE_HOST.test(h) || PRIVATE_V4.test(h) || h.startsWith('[') || !h.includes('.')) return { error: 'Ese dominio no está permitido: usa un URL público.' }
  if (u.username || u.password) return { error: 'No pongas usuario ni contraseña dentro del URL.' }
  return { url: u.toString() }
}

export function newWebhookSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return 'whsec_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text))
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function sendWebhook(url: string, secret: string, payload: { event: string } & Record<string, unknown>): Promise<WebhookResult> {
  const checked = checkWebhookUrl(url)
  if ('error' in checked) return { ok: false, status: null, error: checked.error }
  const ts = Math.floor(Date.now() / 1000).toString()
  const body = JSON.stringify({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...payload })
  try {
    const r = await fetch(checked.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Zentekia-Webhook/1.0',
        'X-Zentekia-Event': payload.event,
        'X-Zentekia-Timestamp': ts,
        'X-Zentekia-Signature': `sha256=${await hmacHex(secret, `${ts}.${body}`)}`,
      },
      body,
      signal: AbortSignal.timeout(8_000),
    })
    return { ok: r.ok, status: r.status, error: r.ok ? null : `El servidor respondió HTTP ${r.status}.` }
  } catch (e) {
    const timeout = e instanceof Error && /timeout|abort/i.test(e.name + e.message)
    return { ok: false, status: null, error: timeout ? 'El servidor tardó más de 8 segundos en responder.' : 'No se pudo conectar con el servidor.' }
  }
}
