/*
  Agente de voz (modelos gratuitos de Workers AI)
  ===============================================
  Un turno de la llamada:
    audio del visitante ──► Whisper (voz → texto)
                        ──► Qwen con el prompt de voz del agente
                        ──► MeloTTS (texto → voz) ──► audio de respuesta

  Rutas:
    POST /voice/turn  body { agent, conversationId, messages, audio (base64), mime }
                      → { transcript, reply, action: null | "hangup" | "transfer", audio (base64 mp3) }
    POST /voice/say   body { text }  → { audio }   (para el saludo inicial)

  El prompt de voz marca el final de la llamada con [COLGAR] o [TRANSFERIR];
  aquí se quitan del texto y se devuelven como "action" para que el widget cuelgue o transfiera.
*/
import { SYSTEM_PROMPT } from './prompt.js'
import { promptActivo, guardarMensaje } from './db.js'
import { MODELO_DEFAULT } from './chat.js'

export const MODELO_STT = '@cf/openai/whisper-large-v3-turbo'
export const MODELO_STT_RESPALDO = '@cf/openai/whisper'
export const MODELO_TTS = '@cf/myshell-ai/melotts'

const AGENTE_VALIDO = /^[a-z0-9-]{1,40}$/
const ID_VALIDO = /^[A-Za-z0-9-]{4,64}$/
const MAX_AUDIO_B64 = 4_000_000 // ~3 MB de audio, de sobra para un turno de 20 s
const MAX_MENSAJES = 20
const MAX_TEXTO_VOZ = 600

export async function vozTurno(request, env, ctx, json) {
  if (!env.AI) return json({ error: 'Falta conectar Workers AI al Worker (binding llamado AI).' }, 500)
  const body = await request.json().catch(() => null)
  if (!body) return json({ error: 'El cuerpo debe ser JSON' }, 400)

  const agent = AGENTE_VALIDO.test(body.agent || '') ? body.agent : 'prakticall-ventas-voz'
  const conversationId = ID_VALIDO.test(body.conversationId || '') ? body.conversationId : crypto.randomUUID()
  const audio = typeof body.audio === 'string' ? body.audio : ''
  if (audio.length > MAX_AUDIO_B64) return json({ error: 'El audio es demasiado largo.' }, 413)

  // 1) Voz → texto
  let transcript = ''
  if (audio) {
    try {
      transcript = await transcribir(env, audio)
    } catch (e) {
      console.error('Whisper falló:', e)
      return json({ error: 'No pude entender el audio. Intenta de nuevo.' }, 502)
    }
  }
  const textoUsuario = transcript || '[silencio]'

  // 2) Texto → respuesta del agente
  let prompt = SYSTEM_PROMPT
  if (env.DB) {
    try {
      prompt = (await promptActivo(env.DB, agent)) || SYSTEM_PROMPT
    } catch (e) {
      console.error('No pude leer el prompt de D1:', e)
    }
  }
  const historial = limpiar(body.messages)
  const messages = [
    { role: 'system', content: prompt },
    ...historial,
    { role: 'user', content: textoUsuario + ' /no_think' },
  ]
  let crudo = ''
  try {
    const r = await env.AI.run(env.MODEL || MODELO_DEFAULT, { messages, max_tokens: 220, temperature: 0.4 })
    crudo = textoDe(r)
  } catch (e) {
    console.error('Qwen falló:', e)
    return json({ error: 'El modelo no está disponible en este momento.' }, 502)
  }
  const { texto: reply, action } = extraerAccion(crudo)
  const decir = paraVoz(reply)

  // 3) Respuesta → voz
  let audioRespuesta = null
  if (decir) {
    try {
      audioRespuesta = await sintetizar(env, decir)
    } catch (e) {
      console.error('MeloTTS falló:', e)
    }
  }

  // Guardar en el historial (sin hacer esperar la respuesta)
  if (env.DB) {
    const datos = { conversationId, agent, origin: request.headers.get('Origin') || '', country: request.cf?.country || '' }
    ctx.waitUntil(
      (async () => {
        await guardarMensaje(env.DB, { ...datos, role: 'user', content: transcript ? transcript : '[silencio]' })
        if (reply) await guardarMensaje(env.DB, { ...datos, role: 'assistant', content: reply + (action ? ` [${action === 'hangup' ? 'colgó' : 'transfirió'}]` : '') })
      })().catch((e) => console.error('No pude guardar en D1:', e))
    )
  }

  return json({ transcript, reply, action, audio: audioRespuesta, mime: 'audio/mpeg', conversationId })
}

export async function vozDecir(request, env, json) {
  if (!env.AI) return json({ error: 'Falta conectar Workers AI al Worker (binding llamado AI).' }, 500)
  const body = await request.json().catch(() => null)
  const texto = paraVoz(String(body?.text || '')).slice(0, MAX_TEXTO_VOZ)
  if (!texto) return json({ error: 'Falta el texto.' }, 400)
  try {
    return json({ audio: await sintetizar(env, texto), mime: 'audio/mpeg' })
  } catch (e) {
    console.error('MeloTTS falló:', e)
    return json({ error: 'No pude generar la voz en este momento.' }, 502)
  }
}

/* ---------------- piezas ---------------- */

async function transcribir(env, audioB64) {
  try {
    const r = await env.AI.run(MODELO_STT, { audio: audioB64, language: 'es', vad_filter: true })
    return limpiarTranscripcion(r?.text)
  } catch (e) {
    // Respaldo: Whisper clásico recibe los bytes como arreglo de números
    console.warn('Whisper turbo falló, uso Whisper clásico:', e?.message)
    const bytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0))
    const r = await env.AI.run(MODELO_STT_RESPALDO, { audio: [...bytes] })
    return limpiarTranscripcion(r?.text)
  }
}

// Whisper a veces "escucha" frases fantasma en el silencio
const FANTASMAS = /^(gracias( por (ver|mirar)( el video| este video|lo)?)?|suscr[ií]bete.*|subt[ií]tulos.*|amara org.*|)$/i
function limpiarTranscripcion(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  const base = s.replace(/[.,!¡?¿…]/g, '').trim()
  return FANTASMAS.test(base) ? '' : s
}

export async function sintetizar(env, texto) {
  const r = await env.AI.run(MODELO_TTS, { prompt: texto, lang: 'es' })
  if (r && typeof r.audio === 'string') return r.audio
  let bytes
  if (r instanceof ArrayBuffer) bytes = new Uint8Array(r)
  else if (r instanceof Uint8Array) bytes = r
  else bytes = new Uint8Array(await new Response(r).arrayBuffer())
  return aBase64(bytes)
}

function aBase64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function textoDe(r) {
  let t = r?.response ?? r?.choices?.[0]?.message?.content ?? ''
  if (typeof t !== 'string') t = String(t ?? '')
  return t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\/?think>/g, '').trim()
}

export function extraerAccion(texto) {
  let action = null
  if (/\[\s*TRANSFERIR\s*\]/i.test(texto)) action = 'transfer'
  else if (/\[\s*COLGAR\s*\]/i.test(texto)) action = 'hangup'
  const limpio = texto
    .replace(/\[\s*(TRANSFERIR|COLGAR)\s*\]/gi, '')
    .replace(/\b(Transfer_to_agent|Hangup)\b/g, '')
    .trim()
  return { texto: limpio, action }
}

// Quita formato que no se debe "leer" en voz alta
export function paraVoz(t) {
  return String(t || '')
    .replace(/\*\*|__|[*_#`>]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/→/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function limpiar(lista) {
  if (!Array.isArray(lista)) return []
  return lista
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-MAX_MENSAJES)
}
