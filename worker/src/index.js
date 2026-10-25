/*
  Worker del agente virtual
  =========================
  Rutas:
    GET  /health           → estado (modelo, IA y base de datos conectadas)
    POST /chat             → chat del widget, responde en streaming (pide sesión de admin)
    GET  /admin            → panel administrativo (login, historial, prompts)
    *    /admin/api/...    → API del panel (pide sesión)

  Conexiones (bindings) que necesita en Cloudflare:
    AI  → Workers AI            (obligatoria)
    DB  → base de datos D1      (para historial y prompts del panel)
  Secretos/variables:
    ADMIN_PASSWORD   contraseña del panel (secreto, mínimo 8 caracteres)
    ADMIN_USER       usuario del panel (opcional, por defecto "admin")
    MODEL            modelo (opcional, por defecto Qwen3 30B)
    ALLOWED_ORIGINS  sitios que pueden usar el chat (opcional)
    CHAT_PUBLICO     "true" para abrir el chat a cualquier visitante (por defecto solo admins)
*/
import { chat, MODELO_DEFAULT } from './chat.js'
import { adminApi } from './admin-api.js'
import { leerToken } from './auth.js'
import { prepararDB } from './db.js'
import { ADMIN_HTML } from './admin-page.js'

const LIMITE_POR_MINUTO = 20 // mensajes de chat por visitante (IP) por minuto
const ORIGENES_DEFAULT =
  // Agrega aquí (o en la variable ALLOWED_ORIGINS) el dominio donde pongas el widget de Prakticall
  'http://localhost:5173,http://localhost:4173'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const ruta = url.pathname.replace(/\/+$/, '') || '/'
    const esAdmin = ruta === '/admin' || ruta.startsWith('/admin/')
    const cors = encabezadosCors(request, env)
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      })

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

    try {
      if (env.DB && (ruta === '/chat' || ruta.startsWith('/admin/api'))) await prepararDB(env.DB)

      if (ruta === '/health') {
        return json({ ok: true, model: env.MODEL || MODELO_DEFAULT, ai: Boolean(env.AI), db: Boolean(env.DB) })
      }

      if (ruta === '/admin') {
        return new Response(ADMIN_HTML, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
          },
        })
      }

      if (esAdmin && ruta.startsWith('/admin/api')) {
        return await adminApi(request, env, ruta.slice('/admin/api'.length) || '/', json)
      }

      if (ruta === '/chat' && request.method === 'POST') {
        // Solo sitios autorizados (el navegador manda el encabezado Origin)
        if (!cors['Access-Control-Allow-Origin']) return json({ error: 'Origen no autorizado' }, 403)
        // Por ahora solo admins: se entra con el mismo usuario y contraseña del panel
        if (env.CHAT_PUBLICO !== 'true' && !(await leerToken(env, request))) {
          return json({ error: 'Inicia sesión como administrador para usar el chat.' }, 401)
        }
        const ip = request.headers.get('CF-Connecting-IP') || 'anon'
        if (excedeLimite(ip)) return json({ error: 'Demasiados mensajes seguidos. Espera un minuto.' }, 429)
        return await chat(request, env, ctx, json, cors)
      }

      return json({ error: 'Ruta no encontrada' }, 404)
    } catch (e) {
      console.error('Error inesperado:', e)
      return json({ error: 'Error interno del agente. Revisa los logs del Worker.' }, 500)
    }
  },
}

function encabezadosCors(request, env) {
  const origen = request.headers.get('Origin') || ''
  const permitidos = (env.ALLOWED_ORIGINS || ORIGENES_DEFAULT).split(',').map((s) => s.trim()).filter(Boolean)
  const ok = permitidos.includes('*') || permitidos.includes(origen)
  return ok
    ? {
        'Access-Control-Allow-Origin': origen || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' }
}

// Límite en memoria: "mejor esfuerzo" (cada servidor de Cloudflare lleva su cuenta)
const visitas = new Map()
function excedeLimite(ip) {
  const ahora = Date.now()
  const recientes = (visitas.get(ip) || []).filter((t) => ahora - t < 60_000)
  recientes.push(ahora)
  visitas.set(ip, recientes)
  if (visitas.size > 5000) visitas.clear()
  return recientes.length > LIMITE_POR_MINUTO
}
