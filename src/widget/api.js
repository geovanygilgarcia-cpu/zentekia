/*
  Conexión con el modelo.
  - Sin apiUrl: modo demo, respuestas de ejemplo que se escriben palabra por palabra.
  - Con apiUrl: POST {apiUrl}/chat con { messages } y se lee la respuesta en streaming (SSE).
    Acepta el formato de Workers AI  →  data: {"response":"texto"}
    y el formato tipo OpenAI         →  data: {"choices":[{"delta":{"content":"texto"}}]}
    El stream termina con            →  data: [DONE]
  - token: sesión de admin (se manda como Authorization: Bearer)
*/

export async function* responder({ apiUrl, token, messages, signal, agent, conversationId }) {
  if (!apiUrl) {
    yield* respuestaDemo(messages, signal)
    return
  }

  const res = await fetch(apiUrl.replace(/\/+$/, '') + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      agent,
      conversationId,
      messages: messages.map(({ role, content }) => ({ role, content })),
    }),
    signal,
  })
  if (!res.ok || !res.body) {
    const detalle = await res.json().then((j) => j.error).catch(() => null)
    const err = new Error(detalle || `El servidor respondió ${res.status}.`)
    err.status = res.status
    throw err
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const linea = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!linea.startsWith('data:')) continue
      const data = linea.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const j = JSON.parse(data)
        const t = j.response ?? j.choices?.[0]?.delta?.content ?? ''
        if (t) yield t
      } catch {
        /* línea incompleta o ajena: se ignora */
      }
    }
  }
}

/* ---------------- modo demo ---------------- */

const espera = (ms, signal) =>
  new Promise((ok, mal) => {
    const t = setTimeout(ok, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      mal(new DOMException('Cancelado', 'AbortError'))
    })
  })

const RESPUESTAS = []

async function* respuestaDemo(messages, signal) {
  const ultimo = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
  const elegida =
    RESPUESTAS.find((r) => r.si.test(ultimo))?.texto ||
    `Estoy en **modo demo**, sin conexión al modelo. Pon la URL de tu Worker en la configuración y responderé de verdad sobre «${ultimo.slice(0, 60)}».`

  await espera(650, signal) // "pensando"
  const trozos = elegida.match(/\S+\s*|\n/g) || []
  for (const t of trozos) {
    await espera(18 + Math.random() * 45, signal)
    yield t
  }
}

/* ---------------- login (mismas credenciales del panel /admin) ---------------- */

export async function iniciarSesion({ apiUrl, usuario, contrasena }) {
  let res
  try {
    res = await fetch(apiUrl.replace(/\/+$/, '') + '/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario, contrasena }),
    })
  } catch {
    throw new Error('No pude conectar con el servidor. Revisa tu conexión.')
  }
  const datos = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(datos.error || `El servidor respondió ${res.status}.`)
  return datos // { token, usuario }
}
