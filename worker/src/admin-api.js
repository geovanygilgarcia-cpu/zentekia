/*
  API del panel administrativo  (/admin/api/...)
  Todas las rutas piden sesión, menos /login.
*/
import { credencialesValidas, crearToken, leerToken, loginConfigurado, demasiadosIntentos } from './auth.js'
import { limpiarCachePrompts } from './db.js'
import { responderModelo } from './chat.js'

const AGENTE_VALIDO = /^[a-z0-9-]{1,40}$/

export async function adminApi(request, env, ruta, json) {
  const db = env.DB
  const metodo = request.method

  if (ruta === '/login' && metodo === 'POST') {
    if (!loginConfigurado(env)) {
      return json({ error: 'El login no está configurado: falta el secreto ADMIN_PASSWORD (mínimo 8 caracteres).' }, 503)
    }
    const ip = request.headers.get('CF-Connecting-IP') || 'anon'
    if (demasiadosIntentos(ip)) return json({ error: 'Demasiados intentos. Espera 5 minutos.' }, 429)
    const body = await request.json().catch(() => ({}))
    if (!(await credencialesValidas(env, body.usuario, body.contrasena))) {
      return json({ error: 'Usuario o contraseña incorrectos.' }, 401)
    }
    return json({ token: await crearToken(env, body.usuario), usuario: body.usuario })
  }

  const sesion = await leerToken(env, request)
  if (!sesion) return json({ error: 'Tu sesión expiró. Vuelve a entrar.' }, 401)
  if (!db) return json({ error: 'Falta conectar la base de datos D1 al Worker (binding llamado DB).' }, 503)

  if (ruta === '/me') return json({ usuario: sesion.u })

  /* ---------- resumen ---------- */
  if (ruta === '/stats' && metodo === 'GET') {
    const hoy = inicioDelDia()
    const [total, convHoy, msgHoy, agentes] = await db.batch([
      db.prepare('SELECT COUNT(*) AS n FROM conversations'),
      db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE started_at >= ?').bind(hoy),
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND role = 'user'").bind(hoy),
      db.prepare(
        'SELECT agent FROM prompts UNION SELECT agent FROM conversations ORDER BY agent'
      ),
    ])
    return json({
      conversaciones: total.results[0].n,
      conversacionesHoy: convHoy.results[0].n,
      preguntasHoy: msgHoy.results[0].n,
      agentes: agentes.results.map((r) => r.agent),
    })
  }

  /* ---------- conversaciones ---------- */
  if (ruta === '/conversations' && metodo === 'GET') {
    const u = new URL(request.url)
    const q = (u.searchParams.get('q') || '').trim()
    const agente = u.searchParams.get('agent') || ''
    const pagina = Math.max(0, parseInt(u.searchParams.get('page') || '0', 10) || 0)
    const condiciones = []
    const params = []
    if (agente) {
      condiciones.push('c.agent = ?')
      params.push(agente)
    }
    if (q) {
      condiciones.push('EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?)')
      params.push(`%${q}%`)
    }
    const where = condiciones.length ? 'WHERE ' + condiciones.join(' AND ') : ''
    const { results } = await db
      .prepare(
        `SELECT c.id, c.agent, c.title, c.origin, c.country, c.started_at, c.updated_at, c.message_count,
          (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
         FROM conversations c ${where}
         ORDER BY c.updated_at DESC LIMIT 31 OFFSET ?`
      )
      .bind(...params, pagina * 30)
      .all()
    return json({ conversaciones: results.slice(0, 30), hayMas: results.length > 30 })
  }

  const convMatch = ruta.match(/^\/conversations\/([A-Za-z0-9-]{4,64})$/)
  if (convMatch) {
    const id = convMatch[1]
    if (metodo === 'GET') {
      const conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').bind(id).first()
      if (!conv) return json({ error: 'No encontré esa conversación.' }, 404)
      const { results } = await db
        .prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id')
        .bind(id)
        .all()
      return json({ conversacion: conv, mensajes: results })
    }
    if (metodo === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(id),
        db.prepare('DELETE FROM conversations WHERE id = ?').bind(id),
      ])
      return json({ ok: true })
    }
  }

  /* ---------- prompts ---------- */
  if (ruta === '/prompts' && metodo === 'GET') {
    const { results } = await db.prepare('SELECT * FROM prompts ORDER BY agent, is_active DESC, updated_at DESC').all()
    return json({ prompts: results })
  }

  if (ruta === '/prompts' && metodo === 'POST') {
    const body = await request.json().catch(() => ({}))
    const error = validarPrompt(body)
    if (error) return json({ error }, 400)
    const ahora = Date.now()
    const { count } = await db.prepare('SELECT COUNT(*) AS count FROM prompts WHERE agent = ?').bind(body.agent).first()
    const activar = body.activate || count === 0 // el primer prompt de un agente queda activo
    const stmts = []
    if (activar) stmts.push(db.prepare('UPDATE prompts SET is_active = 0 WHERE agent = ?').bind(body.agent))
    stmts.push(
      db
        .prepare('INSERT INTO prompts (agent, name, content, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
        .bind(body.agent, body.name.trim(), body.content.trim(), activar ? 1 : 0, ahora, ahora)
    )
    const res = await db.batch(stmts)
    limpiarCachePrompts()
    return json({ prompt: res[res.length - 1].results[0] }, 201)
  }

  const pMatch = ruta.match(/^\/prompts\/(\d+)(\/activate)?$/)
  if (pMatch) {
    const id = Number(pMatch[1])
    const actual = await db.prepare('SELECT * FROM prompts WHERE id = ?').bind(id).first()
    if (!actual) return json({ error: 'No encontré ese prompt.' }, 404)

    if (pMatch[2] && metodo === 'POST') {
      await db.batch([
        db.prepare('UPDATE prompts SET is_active = 0 WHERE agent = ?').bind(actual.agent),
        db.prepare('UPDATE prompts SET is_active = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id),
      ])
      limpiarCachePrompts()
      return json({ ok: true })
    }
    if (!pMatch[2] && metodo === 'PUT') {
      const body = await request.json().catch(() => ({}))
      const error = validarPrompt({ ...body, agent: actual.agent })
      if (error) return json({ error }, 400)
      const prompt = await db
        .prepare('UPDATE prompts SET name = ?, content = ?, updated_at = ? WHERE id = ? RETURNING *')
        .bind(body.name.trim(), body.content.trim(), Date.now(), id)
        .first()
      limpiarCachePrompts()
      return json({ prompt })
    }
    if (!pMatch[2] && metodo === 'DELETE') {
      if (actual.is_active) return json({ error: 'No se puede borrar el prompt activo. Activa otro primero.' }, 409)
      await db.prepare('DELETE FROM prompts WHERE id = ?').bind(id).run()
      return json({ ok: true })
    }
  }

  /* ---------- probar un prompt sin guardar nada ---------- */
  if (ruta === '/test' && metodo === 'POST') {
    const body = await request.json().catch(() => ({}))
    const prompt = String(body.prompt || '').trim()
    const mensaje = String(body.message || '').trim().slice(0, 2000)
    if (!prompt || !mensaje) return json({ error: 'Escribe un prompt y un mensaje de prueba.' }, 400)
    return responderModelo(env, prompt, [{ role: 'user', content: mensaje }], {})
  }


  return json({ error: 'Ruta no encontrada' }, 404)
}

function validarPrompt(b) {
  if (!b || typeof b.agent !== 'string' || !AGENTE_VALIDO.test(b.agent)) {
    return 'El agente solo puede tener minúsculas, números y guiones (ej. prakticall-ventas).'
  }
  if (typeof b.name !== 'string' || !b.name.trim()) return 'Ponle un nombre al prompt.'
  if (b.name.length > 80) return 'El nombre es muy largo (máximo 80 caracteres).'
  if (typeof b.content !== 'string' || b.content.trim().length < 20) return 'El prompt es muy corto (mínimo 20 caracteres).'
  if (b.content.length > 12000) return 'El prompt es muy largo (máximo 12,000 caracteres).'
  return null
}

// Medianoche de hoy en hora del centro de México (UTC-6)
function inicioDelDia() {
  const offset = 6 * 60 * 60 * 1000
  const local = new Date(Date.now() - offset)
  local.setUTCHours(0, 0, 0, 0)
  return local.getTime() + offset
}
