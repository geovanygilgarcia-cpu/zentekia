/*
  Base de datos (Cloudflare D1)
  =============================
  Tablas:
    conversations  una fila por conversación del widget
    messages       cada mensaje (usuario y agente)
    prompts        instrucciones de cada agente; una activa por agente
  Las tablas se crean solas la primera vez (no hay que correr SQL a mano).
*/
import { PROMPTS_INICIALES } from './prompts-iniciales.js'

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    title TEXT,
    origin TEXT,
    country TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id)`,
  `CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prompts_agent ON prompts(agent, is_active)`,
]

let preparada = null
export function prepararDB(db) {
  if (!preparada) {
    preparada = (async () => {
      await db.batch(ESQUEMA.map((sql) => db.prepare(sql)))
      // Siembra los prompts iniciales solo para los agentes que todavía no tienen ninguno
      const { results } = await db.prepare('SELECT DISTINCT agent FROM prompts').all()
      const existentes = new Set(results.map((r) => r.agent))
      const faltan = PROMPTS_INICIALES.filter((p) => !existentes.has(p.agent))
      if (faltan.length) {
        const ahora = Date.now()
        await db.batch(
          faltan.map((p) =>
            db
              .prepare('INSERT INTO prompts (agent, name, content, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
              .bind(p.agent, p.name, p.content, ahora, ahora)
          )
        )
      }
    })().catch((e) => {
      preparada = null
      throw e
    })
  }
  return preparada
}

/* ---------- prompts ---------- */

// Caché corta para no consultar la base en cada mensaje
const cache = new Map()
const CACHE_MS = 30_000

export function limpiarCachePrompts() {
  cache.clear()
}

export async function promptActivo(db, agent) {
  const c = cache.get(agent)
  if (c && Date.now() - c.t < CACHE_MS) return c.content
  const fila = await db
    .prepare('SELECT content FROM prompts WHERE agent = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1')
    .bind(agent)
    .first()
  const content = fila?.content || null
  cache.set(agent, { content, t: Date.now() })
  return content
}

/* ---------- historial ---------- */

export async function guardarMensaje(db, { conversationId, agent, role, content, origin, country }) {
  const ahora = Date.now()
  const titulo = role === 'user' ? content.replace(/\s+/g, ' ').trim().slice(0, 80) : null
  await db.batch([
    db
      .prepare(
        `INSERT INTO conversations (id, agent, title, origin, country, started_at, updated_at, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = excluded.updated_at,
           message_count = message_count + 1,
           title = COALESCE(conversations.title, excluded.title)`
      )
      .bind(conversationId, agent, titulo, origin || null, country || null, ahora, ahora),
    db
      .prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .bind(conversationId, role, content, ahora),
  ])
}
