/*
  Chat del widget  (POST /chat)
  body: { messages: [{ role, content }], agent?: "prakticall-ventas", conversationId?: "..." }
*/
import { SYSTEM_PROMPT } from './prompt.js'
import { normalizarStream } from './stream.js'
import { promptActivo, guardarMensaje } from './db.js'

const MAX_MENSAJES = 20 // historial que se manda al modelo (los más recientes)
const MAX_CARACTERES = 2000 // por mensaje del visitante
const MAX_TOKENS = 600 // largo máximo de cada respuesta
export const MODELO_DEFAULT = '@cf/qwen/qwen3-30b-a3b-fp8'

const AGENTE_VALIDO = /^[a-z0-9-]{1,40}$/
const ID_VALIDO = /^[A-Za-z0-9-]{4,64}$/

export async function chat(request, env, ctx, json, cors) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'El cuerpo debe ser JSON' }, 400)
  }

  const historial = limpiarMensajes(body?.messages)
  if (!historial.length || historial[historial.length - 1].role !== 'user') {
    return json({ error: 'Falta el mensaje del usuario' }, 400)
  }

  const agent = AGENTE_VALIDO.test(body?.agent || '') ? body.agent : 'prakticall-ventas'
  const conversationId = ID_VALIDO.test(body?.conversationId || '') ? body.conversationId : crypto.randomUUID()

  // Prompt activo del agente (desde el panel); si no hay base de datos o prompt, el original
  let prompt = SYSTEM_PROMPT
  if (env.DB) {
    try {
      prompt = (await promptActivo(env.DB, agent)) || SYSTEM_PROMPT
    } catch (e) {
      console.error('No pude leer el prompt de D1:', e)
    }
  }

  // Guardar la pregunta y, al terminar, la respuesta (sin hacer esperar al visitante)
  const datos = {
    conversationId,
    agent,
    origin: request.headers.get('Origin') || '',
    country: request.cf?.country || '',
  }
  const guardar = (role, content) => {
    if (!env.DB || !content) return
    ctx.waitUntil(guardarMensaje(env.DB, { ...datos, role, content }).catch((e) => console.error('No pude guardar en D1:', e)))
  }
  guardar('user', historial[historial.length - 1].content)

  return responderModelo(env, prompt, historial, cors, (respuesta) => guardar('assistant', respuesta), conversationId)
}

// Llama al modelo y devuelve la respuesta en streaming (lo usa también "Probar" del panel)
export async function responderModelo(env, prompt, historial, cors, onFin, conversationId) {
  if (!env.AI) {
    return new Response(JSON.stringify({ error: 'Falta conectar Workers AI al Worker (binding llamado AI).' }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    })
  }
  const messages = [{ role: 'system', content: prompt }, ...historial]
  // Qwen3 "piensa" antes de responder; /no_think lo desactiva para que conteste rápido
  messages[messages.length - 1] = {
    ...messages[messages.length - 1],
    content: messages[messages.length - 1].content + ' /no_think',
  }

  let streamModelo
  try {
    streamModelo = await env.AI.run(env.MODEL || MODELO_DEFAULT, {
      messages,
      stream: true,
      max_tokens: MAX_TOKENS,
      temperature: 0.4,
    })
  } catch (e) {
    console.error('Workers AI falló:', e)
    return new Response(JSON.stringify({ error: 'El modelo no está disponible en este momento.' }), {
      status: 502,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  const headers = {
    ...cors,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  }
  if (conversationId) {
    headers['X-Conversation-Id'] = conversationId
    if (cors['Access-Control-Allow-Origin']) headers['Access-Control-Expose-Headers'] = 'X-Conversation-Id'
  }
  return new Response(normalizarStream(streamModelo, onFin), { headers })
}

// Solo se aceptan roles user/assistant con texto; el system prompt lo pone el Worker, nunca el visitante
function limpiarMensajes(lista) {
  if (!Array.isArray(lista)) return []
  return lista
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CARACTERES) }))
    .slice(-MAX_MENSAJES)
}
