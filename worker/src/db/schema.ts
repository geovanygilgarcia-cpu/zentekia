/*
  Esquema de D1. Se crea solo la primera vez (no hay que correr SQL a mano).
  Regla: toda tabla con datos de un cliente lleva tenant_id NOT NULL e índice compuesto.
  Importes en micro-USD (1 USD = 1,000,000) como enteros.
*/
import { SEED_MODELS } from './seed'

const DDL = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    plan_id TEXT NOT NULL DEFAULT 'basico',
    monthly_limit_micro INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    limit_behavior TEXT NOT NULL DEFAULT 'block',
    enabled_models TEXT NOT NULL DEFAULT '[]',
    retention_days INTEGER NOT NULL DEFAULT 90,
    suspended_message TEXT,
    fallback_to_hosted INTEGER NOT NULL DEFAULT 0,
    turnstile INTEGER NOT NULL DEFAULT 0,
    data_key_enc TEXT,
    onboarded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT,
    email TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL,
    password_hash TEXT,
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'invited',
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_tenant_email ON users(COALESCE(tenant_id, ''), email)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    tenant_id TEXT,
    kind TEXT NOT NULL,
    csrf TEXT NOT NULL,
    mfa_ok INTEGER NOT NULL DEFAULT 0,
    impersonator_id TEXT,
    read_only INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    ip TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS one_time_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    user_id TEXT,
    tenant_id TEXT,
    data TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    welcome_message TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'es',
    temperature REAL NOT NULL DEFAULT 0.4,
    model_id TEXT NOT NULL,
    provider_key_id TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_agents_tenant ON agents(tenant_id, id)`,
  `CREATE TABLE IF NOT EXISTS widget_configs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    widget_key TEXT NOT NULL UNIQUE,
    allowed_origins TEXT NOT NULL DEFAULT '[]',
    theme_json TEXT NOT NULL DEFAULT '{}',
    logo_data TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_widget_tenant ON widget_configs(tenant_id, id)`,
  `CREATE TABLE IF NOT EXISTS provider_keys (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    last4 TEXT NOT NULL,
    base_url TEXT,
    model_name TEXT,
    status TEXT NOT NULL DEFAULT 'untested',
    tested_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_pkeys_tenant ON provider_keys(tenant_id, provider)`,
  `CREATE TABLE IF NOT EXISTS kb_sources (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    r2_key TEXT,
    raw_text TEXT,
    tokens_est INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    recrawl_count INTEGER NOT NULL DEFAULT 0,
    recrawl_period TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_kbs_tenant ON kb_sources(tenant_id, agent_id)`,
  `CREATE INDEX IF NOT EXISTS ix_kbs_status ON kb_sources(status)`,
  `CREATE TABLE IF NOT EXISTS kb_chunks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    title TEXT,
    text TEXT NOT NULL,
    vector_id TEXT,
    embedded INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS ix_kbc_tenant ON kb_chunks(tenant_id, agent_id)`,
  `CREATE INDEX IF NOT EXISTS ix_kbc_source ON kb_chunks(tenant_id, source_id, seq)`,
  `CREATE INDEX IF NOT EXISTS ix_kbc_pending ON kb_chunks(embedded, tenant_id)`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    origin TEXT,
    country TEXT,
    title TEXT,
    started_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    ended_at INTEGER,
    ended_by TEXT,
    rating INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS ix_conv_tenant ON conversations(tenant_id, last_message_at DESC)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    model_id TEXT,
    estimated INTEGER NOT NULL DEFAULT 0,
    feedback INTEGER,
    sources_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_msg_tenant_conv ON messages(tenant_id, conversation_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    type TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    context_window INTEGER NOT NULL DEFAULT 32000,
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS price_list (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    input_per_1m_micro INTEGER NOT NULL DEFAULT 0,
    output_per_1m_micro INTEGER NOT NULL DEFAULT 0,
    fee_input_per_1m_micro INTEGER NOT NULL DEFAULT 0,
    fee_output_per_1m_micro INTEGER NOT NULL DEFAULT 0,
    effective_from INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_price_model ON price_list(model_id, effective_from DESC)`,
  `CREATE TABLE IF NOT EXISTS tenant_price_overrides (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    input_per_1m_micro INTEGER,
    output_per_1m_micro INTEGER,
    fee_input_per_1m_micro INTEGER,
    fee_output_per_1m_micro INTEGER,
    discount_pct INTEGER,
    effective_from INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_override_tenant ON tenant_price_overrides(tenant_id, model_id, effective_from DESC)`,
  `CREATE TABLE IF NOT EXISTS usage_ledger (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    message_id TEXT,
    conversation_id TEXT,
    model_id TEXT NOT NULL,
    model_type TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chat',
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    cost_micro INTEGER NOT NULL,
    price_version TEXT NOT NULL,
    estimated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_tenant ON usage_ledger(tenant_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS statements (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    period TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    total_micro INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    lines_json TEXT NOT NULL DEFAULT '[]',
    generated_at INTEGER NOT NULL,
    paid_at INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_statements ON statements(tenant_id, period)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor_id TEXT,
    actor_email TEXT,
    tenant_id TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_log(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS ix_audit_tenant ON audit_log(tenant_id, created_at DESC)`,
  // Auditoría inmutable: la base rechaza cualquier cambio o borrado
  `CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log es inmutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log es inmutable'); END`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    period TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_alerts ON alerts(tenant_id, kind, period)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS voice_calls (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    origin TEXT,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ix_voice_pending ON voice_calls(status, created_at)`,
]

const SCHEMA_VERSION = '7'

let ready: Promise<void> | null = null

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const v = await db
        .prepare("SELECT v FROM meta WHERE k = 'schema'")
        .first<{ v: string }>()
        .catch(() => null)
      if (v?.v === SCHEMA_VERSION) return
      await migrateLegacy(db)
      await db.batch(DDL.map((s) => db.prepare(s)))
      await migrateV2(db)
      await migrateV3(db)
      await migrateV4(db)
      await migrateV5(db)
      await migrateV6(db)
      await migrateV7(db)
      await seedModels(db)
      await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").bind(SCHEMA_VERSION).run()
    })().catch((e) => {
      ready = null
      throw e
    })
  }
  return ready
}

/** La versión anterior (un solo cliente) usaba conversations/messages/prompts sin tenant_id.
 *  Se renombran a legacy_* para no perder nada y no chocar con el esquema nuevo. */
async function migrateLegacy(db: D1Database) {
  for (const t of ['conversations', 'messages']) {
    const cols = await db.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()
    if (cols.results.length && !cols.results.some((c) => c.name === 'tenant_id')) {
      await db.prepare(`ALTER TABLE ${t} RENAME TO legacy_${t}`).run()
    }
  }
  const p = await db.prepare(`PRAGMA table_info(prompts)`).all<{ name: string }>()
  if (p.results.length) await db.prepare('ALTER TABLE prompts RENAME TO legacy_prompts').run()
}

/** v2: cierre de conversación por el visitante (ended_at, ended_by, rating) */
async function migrateV2(db: D1Database) {
  const cols = await db.prepare('PRAGMA table_info(conversations)').all<{ name: string }>()
  const have = new Set(cols.results.map((c) => c.name))
  for (const [name, type] of [['ended_at', 'INTEGER'], ['ended_by', 'TEXT'], ['rating', 'INTEGER']] as const) {
    if (!have.has(name)) await db.prepare(`ALTER TABLE conversations ADD COLUMN ${name} ${type}`).run()
  }
}

/** v3: canal de la conversación (null = chat, 'voice' = llamada) */
async function migrateV3(db: D1Database) {
  const cols = await db.prepare('PRAGMA table_info(conversations)').all<{ name: string }>()
  if (!cols.results.some((c) => c.name === 'channel')) await db.prepare('ALTER TABLE conversations ADD COLUMN channel TEXT').run()
}

/** v4: resumen y prospecto de cada conversación (lo llena el análisis con IA) */
async function migrateV4(db: D1Database) {
  const cols = await db.prepare('PRAGMA table_info(conversations)').all<{ name: string }>()
  const have = new Set(cols.results.map((c) => c.name))
  const add: Array<[string, string]> = [
    ['summary', 'TEXT'],
    ['lead_status', 'TEXT'], // hot · warm · cold · none
    ['lead_score', 'INTEGER'],
    ['lead_stage', "TEXT NOT NULL DEFAULT 'new'"], // new · contacted · won · lost (lo mueve el cliente)
    ['contact_name', 'TEXT'],
    ['contact_email', 'TEXT'],
    ['contact_phone', 'TEXT'],
    ['contact_company', 'TEXT'],
    ['interest', 'TEXT'],
    ['next_step', 'TEXT'],
    ['analyzed_at', 'INTEGER'],
    ['analysis_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['lead_notified', 'INTEGER NOT NULL DEFAULT 0'],
  ]
  for (const [name, type] of add) {
    if (!have.has(name)) await db.prepare(`ALTER TABLE conversations ADD COLUMN ${name} ${type}`).run()
  }
  await db.prepare('CREATE INDEX IF NOT EXISTS ix_conv_lead ON conversations(tenant_id, lead_status, last_message_at DESC)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS ix_conv_pending ON conversations(analyzed_at, last_message_at)').run()
}

/** v5: cobro por mensaje (chat) y por minuto (voz).
 *  - tenants.price_*_micro: precio especial del cliente (null = usa el general, guardado en meta).
 *  - usage_ledger: qué se cobró (billing), cuántas unidades (1 mensaje o N segundos), a qué precio,
 *    y cuánto habría costado por tokens (para comparar en el admin). */
async function migrateV5(db: D1Database) {
  const tcols = await db.prepare('PRAGMA table_info(tenants)').all<{ name: string }>()
  const th = new Set(tcols.results.map((c) => c.name))
  for (const name of ['price_message_micro', 'price_minute_micro']) {
    if (!th.has(name)) await db.prepare(`ALTER TABLE tenants ADD COLUMN ${name} INTEGER`).run()
  }
  const lcols = await db.prepare('PRAGMA table_info(usage_ledger)').all<{ name: string }>()
  const lh = new Set(lcols.results.map((c) => c.name))
  const add: Array<[string, string]> = [
    ['billing', 'TEXT'], // message · minute · token · included
    ['units', 'INTEGER'], // mensajes: 1 · voz: segundos
    ['unit_price_micro', 'INTEGER'], // por mensaje o por minuto
    ['token_cost_micro', 'INTEGER'], // lo que habría costado por tokens
  ]
  for (const [name, type] of add) {
    if (!lh.has(name)) await db.prepare(`ALTER TABLE usage_ledger ADD COLUMN ${name} ${type}`).run()
  }
}

/** v6: tokens incluidos por mensaje (especial del cliente; null = el general) y excedente cobrado */
async function migrateV6(db: D1Database) {
  const tcols = await db.prepare('PRAGMA table_info(tenants)').all<{ name: string }>()
  const th = new Set(tcols.results.map((c) => c.name))
  for (const name of ['msg_included_in', 'msg_included_out']) {
    if (!th.has(name)) await db.prepare(`ALTER TABLE tenants ADD COLUMN ${name} INTEGER`).run()
  }
  const lcols = await db.prepare('PRAGMA table_info(usage_ledger)').all<{ name: string }>()
  if (!lcols.results.some((c) => c.name === 'overage_micro')) await db.prepare('ALTER TABLE usage_ledger ADD COLUMN overage_micro INTEGER').run()
}

/** v7: precios de reventa del cliente (lo que él cobra a sus clientes) */
async function migrateV7(db: D1Database) {
  const tcols = await db.prepare('PRAGMA table_info(tenants)').all<{ name: string }>()
  if (!tcols.results.some((c) => c.name === 'resale_json')) await db.prepare('ALTER TABLE tenants ADD COLUMN resale_json TEXT').run()
}

async function seedModels(db: D1Database) {
  const n = await db.prepare('SELECT COUNT(*) AS n FROM models').first<{ n: number }>()
  if (n && n.n > 0) return
  const t = Date.now()
  const stmts: D1PreparedStatement[] = []
  SEED_MODELS.forEach((m, i) => {
    stmts.push(
      db
        .prepare('INSERT INTO models (id, provider, model_name, display_name, type, active, context_window, sort) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
        .bind(m.id, m.provider, m.model_name, m.display_name, m.type, m.context_window, i),
    )
    stmts.push(
      db
        .prepare(
          'INSERT INTO price_list (id, model_id, input_per_1m_micro, output_per_1m_micro, fee_input_per_1m_micro, fee_output_per_1m_micro, effective_from) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(crypto.randomUUID(), m.id, m.price[0], m.price[1], m.fee[0], m.fee[1], t),
    )
  })
  await db.batch(stmts)
}
