/*
  Capa de acceso a datos de UN cliente.
  Toda consulta lleva "tenant_id = ?" con el id que se fijó al construir el repositorio,
  y ese id siempre sale del servidor (widget_key validada o sesión del portal), nunca del cliente.
  Los handlers no escriben SQL: todo pasa por aquí.
*/
import type {
  AgentRow,
  AlertRow,
  ConversationRow,
  KbChunkRow,
  KbSourceRow,
  MessageRow,
  OverrideRow,
  ProviderKeyRow,
  StatementRow,
  TenantRow,
  UserRow,
  VoiceCallRow,
  WidgetRow,
} from './types'

const id = () => crypto.randomUUID()

/** Arma "col = ?" solo con columnas permitidas (nunca con llaves que vengan del cliente) */
function setClause(f: Record<string, unknown>, allowed: readonly string[]): { sets: string[]; vals: unknown[] } {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const k of allowed) {
    const v = f[k]
    if (v === undefined) continue
    sets.push(`${k} = ?`)
    vals.push(v)
  }
  return { sets, vals }
}

export interface ConvFilter {
  search?: string
  agentId?: string
  from?: number
  to?: number
  status?: 'open' | 'ended'
  /** prospect = caliente, tibio o frío · hot/warm/cold/none = esa temperatura · pending = sin analizar */
  lead?: 'prospect' | 'hot' | 'warm' | 'cold' | 'none' | 'pending'
  /** any = correo o teléfono · phone · email · missing = prospecto sin datos */
  contact?: 'any' | 'phone' | 'email' | 'missing'
  stage?: 'new' | 'contacted' | 'won' | 'lost'
  channel?: 'chat' | 'voice'
  minRating?: number
}

export interface Analysis {
  summary: string
  lead_status: 'hot' | 'warm' | 'cold' | 'none'
  lead_score: number
  interest: string | null
  next_step: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  contact_company: string | null
}

/** Filtros de la lista de conversaciones (se arma el WHERE con parámetros, nunca con texto del usuario) */
function convWhere(f: ConvFilter, where: string[], vals: unknown[]) {
  if (f.status === 'ended') where.push('c.ended_at IS NOT NULL')
  if (f.status === 'open') where.push('c.ended_at IS NULL')
  if (f.agentId) {
    where.push('c.agent_id = ?')
    vals.push(f.agentId)
  }
  if (f.from) {
    where.push('c.last_message_at >= ?')
    vals.push(f.from)
  }
  if (f.to) {
    where.push('c.last_message_at < ?')
    vals.push(f.to)
  }
  if (f.lead === 'prospect') where.push("c.lead_status IN ('hot','warm','cold')")
  else if (f.lead === 'pending') where.push('(c.analyzed_at IS NULL OR c.analyzed_at < c.last_message_at)')
  else if (f.lead) {
    where.push('c.lead_status = ?')
    vals.push(f.lead)
  }
  if (f.contact === 'any') where.push('(c.contact_email IS NOT NULL OR c.contact_phone IS NOT NULL)')
  if (f.contact === 'phone') where.push('c.contact_phone IS NOT NULL')
  if (f.contact === 'email') where.push('c.contact_email IS NOT NULL')
  if (f.contact === 'missing') where.push("c.lead_status IN ('hot','warm','cold') AND c.contact_email IS NULL AND c.contact_phone IS NULL")
  if (f.stage) {
    where.push('c.lead_stage = ?')
    vals.push(f.stage)
  }
  if (f.channel === 'voice') where.push("c.channel = 'voice'")
  if (f.channel === 'chat') where.push("(c.channel IS NULL OR c.channel <> 'voice')")
  if (f.minRating) {
    where.push('c.rating >= ?')
    vals.push(f.minRating)
  }
  if (f.search) {
    where.push(
      '(c.title LIKE ? OR c.summary LIKE ? OR c.contact_name LIKE ? OR c.contact_email LIKE ? OR c.contact_phone LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.content LIKE ?))',
    )
    const like = `%${f.search}%`
    vals.push(like, like, like, like, like, like)
  }
}

export class TenantRepo {
  constructor(
    private db: D1Database,
    readonly tenantId: string,
  ) {
    if (!tenantId) throw new Error('TenantRepo requiere tenantId')
  }

  private q(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).bind(...params)
  }

  /* ---------- tenant ---------- */
  tenant() {
    return this.q('SELECT * FROM tenants WHERE id = ?', this.tenantId).first<TenantRow>()
  }
  async updateSettings(f: { retention_days?: number; onboarded?: number; fallback_to_hosted?: number; name?: string; resale_json?: string | null }) {
    const { sets, vals } = setClause(f, ['retention_days', 'onboarded', 'fallback_to_hosted', 'name', 'resale_json'])
    if (!sets.length) return
    await this.q(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, ...vals, this.tenantId).run()
  }

  /* ---------- agentes ---------- */
  listAgents() {
    return this.q('SELECT * FROM agents WHERE tenant_id = ? ORDER BY created_at', this.tenantId).all<AgentRow>().then((r) => r.results)
  }
  agent(agentId: string) {
    return this.q('SELECT * FROM agents WHERE tenant_id = ? AND id = ?', this.tenantId, agentId).first<AgentRow>()
  }
  async createAgent(a: Omit<AgentRow, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>): Promise<string> {
    const aid = id()
    const t = Date.now()
    await this.q(
      `INSERT INTO agents (id, tenant_id, name, system_prompt, welcome_message, language, temperature, model_id, provider_key_id, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      aid, this.tenantId, a.name, a.system_prompt, a.welcome_message, a.language, a.temperature, a.model_id, a.provider_key_id, a.config_json, t, t,
    ).run()
    return aid
  }
  async updateAgent(agentId: string, f: Partial<Pick<AgentRow, 'name' | 'system_prompt' | 'welcome_message' | 'language' | 'temperature' | 'model_id' | 'provider_key_id' | 'config_json'>>) {
    const { sets, vals } = setClause(f, ['name', 'system_prompt', 'welcome_message', 'language', 'temperature', 'model_id', 'provider_key_id', 'config_json'])
    if (!sets.length) return
    await this.q(`UPDATE agents SET ${sets.join(', ')}, updated_at = ? WHERE tenant_id = ? AND id = ?`, ...vals, Date.now(), this.tenantId, agentId).run()
  }

  /* ---------- widget ---------- */
  widgets() {
    return this.q('SELECT * FROM widget_configs WHERE tenant_id = ? ORDER BY updated_at', this.tenantId).all<WidgetRow>().then((r) => r.results)
  }
  widget(widgetId: string) {
    return this.q('SELECT * FROM widget_configs WHERE tenant_id = ? AND id = ?', this.tenantId, widgetId).first<WidgetRow>()
  }
  widgetForAgent(agentId: string) {
    return this.q('SELECT * FROM widget_configs WHERE tenant_id = ? AND agent_id = ? LIMIT 1', this.tenantId, agentId).first<WidgetRow>()
  }
  async createWidget(agentId: string, widgetKey: string, theme: string, origins: string[]) {
    await this.q(
      'INSERT INTO widget_configs (id, tenant_id, agent_id, widget_key, allowed_origins, theme_json, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      id(), this.tenantId, agentId, widgetKey, JSON.stringify(origins), theme, Date.now(),
    ).run()
  }
  async updateWidget(widgetId: string, f: { theme_json?: string; allowed_origins?: string; logo_data?: string | null }) {
    const { sets, vals } = setClause(f, ['theme_json', 'allowed_origins', 'logo_data'])
    // Cada guardado sube la versión: el widget instalado toma la config nueva sin reinstalar
    await this.q(
      `UPDATE widget_configs SET ${[...sets, 'version = version + 1', 'updated_at = ?'].join(', ')} WHERE tenant_id = ? AND id = ?`,
      ...vals, Date.now(), this.tenantId, widgetId,
    ).run()
  }
  async setAllowedOrigins(origins: string[]) {
    await this.q('UPDATE widget_configs SET allowed_origins = ?, version = version + 1, updated_at = ? WHERE tenant_id = ?', JSON.stringify(origins), Date.now(), this.tenantId).run()
  }

  /* ---------- API keys (BYOK) ---------- */
  listProviderKeys() {
    // Nunca se selecciona secret_enc para listados
    return this.q(
      'SELECT id, provider, last4, base_url, model_name, status, tested_at, created_at FROM provider_keys WHERE tenant_id = ? ORDER BY created_at',
      this.tenantId,
    ).all<Omit<ProviderKeyRow, 'secret_enc' | 'tenant_id'>>().then((r) => r.results)
  }
  /** Uso interno (llamada al proveedor). Incluye el secreto cifrado. */
  providerKeyWithSecret(keyId: string) {
    return this.q('SELECT * FROM provider_keys WHERE tenant_id = ? AND id = ?', this.tenantId, keyId).first<ProviderKeyRow>()
  }
  providerKeyFor(provider: string) {
    return this.q('SELECT * FROM provider_keys WHERE tenant_id = ? AND provider = ? ORDER BY created_at DESC LIMIT 1', this.tenantId, provider).first<ProviderKeyRow>()
  }
  async insertProviderKey(k: { id: string; provider: string; secret_enc: string; last4: string; base_url: string | null; model_name: string | null }) {
    await this.q('DELETE FROM provider_keys WHERE tenant_id = ? AND provider = ?', this.tenantId, k.provider).run()
    await this.q(
      'INSERT INTO provider_keys (id, tenant_id, provider, secret_enc, last4, base_url, model_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      k.id, this.tenantId, k.provider, k.secret_enc, k.last4, k.base_url, k.model_name, 'untested', Date.now(),
    ).run()
  }
  async setProviderKeyStatus(keyId: string, status: string) {
    await this.q('UPDATE provider_keys SET status = ?, tested_at = ? WHERE tenant_id = ? AND id = ?', status, Date.now(), this.tenantId, keyId).run()
  }
  async updateProviderKeyMeta(keyId: string, f: { base_url?: string | null; model_name?: string | null }) {
    await this.q('UPDATE provider_keys SET base_url = COALESCE(?, base_url), model_name = COALESCE(?, model_name) WHERE tenant_id = ? AND id = ?', f.base_url ?? null, f.model_name ?? null, this.tenantId, keyId).run()
  }
  async deleteProviderKey(keyId: string) {
    await this.q('UPDATE agents SET provider_key_id = NULL WHERE tenant_id = ? AND provider_key_id = ?', this.tenantId, keyId).run()
    await this.q('DELETE FROM provider_keys WHERE tenant_id = ? AND id = ?', this.tenantId, keyId).run()
  }

  /* ---------- base de conocimiento ---------- */
  listSources(agentId: string) {
    return this.q(
      'SELECT id, agent_id, type, name, url, status, error, tokens_est, chunk_count, recrawl_count, created_at, updated_at FROM kb_sources WHERE tenant_id = ? AND agent_id = ? ORDER BY created_at DESC',
      this.tenantId, agentId,
    ).all<KbSourceRow>().then((r) => r.results)
  }
  source(sourceId: string) {
    return this.q('SELECT * FROM kb_sources WHERE tenant_id = ? AND id = ?', this.tenantId, sourceId).first<KbSourceRow>()
  }
  kbTotals() {
    return this.q('SELECT COUNT(*) AS sources, COALESCE(SUM(LENGTH(raw_text)), 0) AS chars FROM kb_sources WHERE tenant_id = ?', this.tenantId).first<{ sources: number; chars: number }>()
  }
  async createSource(s: Pick<KbSourceRow, 'agent_id' | 'type' | 'name' | 'url' | 'r2_key' | 'raw_text'>): Promise<string> {
    const sid = id()
    const t = Date.now()
    await this.q(
      'INSERT INTO kb_sources (id, tenant_id, agent_id, type, name, url, status, r2_key, raw_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      sid, this.tenantId, s.agent_id, s.type, s.name, s.url, 'queued', s.r2_key, s.raw_text, t, t,
    ).run()
    return sid
  }
  async updateSource(sourceId: string, f: Partial<Pick<KbSourceRow, 'status' | 'error' | 'raw_text' | 'tokens_est' | 'chunk_count' | 'recrawl_count' | 'recrawl_period'>>) {
    const { sets, vals } = setClause(f, ['status', 'error', 'raw_text', 'tokens_est', 'chunk_count', 'recrawl_count', 'recrawl_period'])
    await this.q(`UPDATE kb_sources SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE tenant_id = ? AND id = ?`, ...vals, Date.now(), this.tenantId, sourceId).run()
  }
  /** Devuelve los vector_id de los chunks borrados para quitarlos también de Vectorize */
  async deleteChunks(sourceId: string): Promise<string[]> {
    const r = await this.q('SELECT vector_id FROM kb_chunks WHERE tenant_id = ? AND source_id = ? AND vector_id IS NOT NULL', this.tenantId, sourceId).all<{ vector_id: string }>()
    await this.q('DELETE FROM kb_chunks WHERE tenant_id = ? AND source_id = ?', this.tenantId, sourceId).run()
    return r.results.map((x) => x.vector_id)
  }
  async deleteSource(sourceId: string): Promise<string[]> {
    const vids = await this.deleteChunks(sourceId)
    await this.q('DELETE FROM kb_sources WHERE tenant_id = ? AND id = ?', this.tenantId, sourceId).run()
    return vids
  }
  async insertChunks(sourceId: string, agentId: string, chunks: { title: string | null; text: string }[]) {
    const stmts = chunks.map((c, i) =>
      this.db
        .prepare('INSERT INTO kb_chunks (id, tenant_id, source_id, agent_id, seq, title, text, embedded) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
        .bind(id(), this.tenantId, sourceId, agentId, i, c.title, c.text),
    )
    for (let i = 0; i < stmts.length; i += 50) await this.db.batch(stmts.slice(i, i + 50))
  }
  pendingChunks(sourceId: string, limit: number) {
    return this.q('SELECT * FROM kb_chunks WHERE tenant_id = ? AND source_id = ? AND embedded = 0 ORDER BY seq LIMIT ?', this.tenantId, sourceId, limit).all<KbChunkRow>().then((r) => r.results)
  }
  countPending(sourceId: string) {
    return this.q('SELECT COUNT(*) AS n FROM kb_chunks WHERE tenant_id = ? AND source_id = ? AND embedded = 0', this.tenantId, sourceId).first<{ n: number }>().then((r) => r?.n ?? 0)
  }
  async markEmbedded(ids: string[]) {
    const stmts = ids.map((cid) => this.db.prepare('UPDATE kb_chunks SET embedded = 1, vector_id = id WHERE tenant_id = ? AND id = ?').bind(this.tenantId, cid))
    for (let i = 0; i < stmts.length; i += 50) await this.db.batch(stmts.slice(i, i + 50))
  }
  /** Recupera chunks por id, filtrando SIEMPRE por tenant y agente (segunda barrera tras Vectorize) */
  async chunksByIds(agentId: string, ids: string[]) {
    if (!ids.length) return []
    const ph = ids.map(() => '?').join(',')
    const r = await this.q(
      `SELECT c.id, c.text, c.title, c.source_id, s.name AS source_name, s.url AS source_url
       FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id AND s.tenant_id = c.tenant_id
       WHERE c.tenant_id = ? AND c.agent_id = ? AND c.id IN (${ph})`,
      this.tenantId, agentId, ...ids,
    ).all<{ id: string; text: string; title: string | null; source_id: string; source_name: string; source_url: string | null }>()
    return r.results
  }
  /** Búsqueda por palabras (respaldo si no hay Vectorize) */
  async keywordCandidates(agentId: string, terms: string[], limit = 400) {
    if (!terms.length) return []
    const where = terms.map(() => 'c.text LIKE ?').join(' OR ')
    const r = await this.q(
      `SELECT c.id, c.text, c.title, c.source_id, s.name AS source_name, s.url AS source_url
       FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id AND s.tenant_id = c.tenant_id
       WHERE c.tenant_id = ? AND c.agent_id = ? AND s.status = 'ready' AND (${where}) LIMIT ?`,
      this.tenantId, agentId, ...terms.map((t) => `%${t}%`), limit,
    ).all<{ id: string; text: string; title: string | null; source_id: string; source_name: string; source_url: string | null }>()
    return r.results
  }
  hasReadyKb(agentId: string) {
    return this.q("SELECT 1 AS x FROM kb_sources WHERE tenant_id = ? AND agent_id = ? AND status = 'ready' LIMIT 1", this.tenantId, agentId).first().then(Boolean)
  }

  /* ---------- conversaciones ---------- */
  conversation(convId: string) {
    return this.q('SELECT * FROM conversations WHERE tenant_id = ? AND id = ?', this.tenantId, convId).first<ConversationRow>()
  }
  async createConversation(c: { id: string; agent_id: string; visitor_id: string; origin: string | null; country: string | null; channel?: string | null; started_at?: number }) {
    const t = c.started_at ?? Date.now()
    await this.q(
      'INSERT INTO conversations (id, tenant_id, agent_id, visitor_id, origin, country, started_at, last_message_at, message_count, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
      c.id, this.tenantId, c.agent_id, c.visitor_id, c.origin, c.country, t, t, c.channel ?? null,
    ).run()
  }

  /* ---------- llamadas de voz ---------- */
  async addVoiceCall(v: { id: string; agent_id: string; visitor_id: string; origin: string | null }) {
    await this.q('INSERT OR IGNORE INTO voice_calls (id, tenant_id, agent_id, visitor_id, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)', v.id, this.tenantId, v.agent_id, v.visitor_id, v.origin, Date.now()).run()
  }
  voiceCall(id: string) {
    return this.q('SELECT * FROM voice_calls WHERE tenant_id = ? AND id = ?', this.tenantId, id).first<VoiceCallRow>()
  }
  /** Toma la llamada para guardarla (solo uno a la vez: cron o navegador) */
  async claimVoiceCall(id: string): Promise<boolean> {
    const r = await this.q("UPDATE voice_calls SET status = 'saving' WHERE tenant_id = ? AND id = ? AND status = 'pending'", this.tenantId, id).run()
    return r.meta.changes > 0
  }
  async markVoiceCall(id: string, status: 'pending' | 'saving' | 'saved' | 'failed', conversationId?: string | null) {
    await this.q('UPDATE voice_calls SET status = ?, attempts = attempts + 1, conversation_id = COALESCE(?, conversation_id) WHERE tenant_id = ? AND id = ?', status, conversationId ?? null, this.tenantId, id).run()
  }
  async listConversations(f: ConvFilter & { limit: number; offset: number }) {
    const where = ['c.tenant_id = ?']
    const vals: unknown[] = [this.tenantId]
    convWhere(f, where, vals)
    const r = await this.q(
      `SELECT c.*, a.name AS agent_name FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id AND a.tenant_id = c.tenant_id
       WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC LIMIT ? OFFSET ?`,
      ...vals, f.limit, f.offset,
    ).all<ConversationRow & { agent_name: string | null }>()
    const total = await this.q(`SELECT COUNT(*) AS n FROM conversations c WHERE ${where.join(' AND ')}`, ...vals).first<{ n: number }>()
    return { items: r.results, total: total?.n ?? 0 }
  }
  /* ---------- prospectos ---------- */
  async saveAnalysis(convId: string, a: Analysis, analyzedAt: number) {
    await this.q(
      `UPDATE conversations SET summary = ?, lead_status = ?, lead_score = ?, interest = ?, next_step = ?,
         contact_name = ?, contact_email = ?, contact_phone = ?, contact_company = ?, analyzed_at = ?, analysis_attempts = 0
       WHERE tenant_id = ? AND id = ?`,
      a.summary, a.lead_status, a.lead_score, a.interest, a.next_step, a.contact_name, a.contact_email, a.contact_phone, a.contact_company, analyzedAt, this.tenantId, convId,
    ).run()
  }
  /** Pendientes de análisis de este cliente (para el botón "Analizar pendientes") */
  pendingAnalysisIds(agentId: string | undefined, limit: number) {
    return this.q(
      `SELECT id FROM conversations WHERE tenant_id = ? AND (? IS NULL OR agent_id = ?) AND (analyzed_at IS NULL OR analyzed_at < last_message_at) AND message_count >= 2
       ORDER BY last_message_at DESC LIMIT ?`,
      this.tenantId, agentId ?? null, agentId ?? null, limit,
    ).all<{ id: string }>().then((r) => r.results.map((x) => x.id))
  }
  async analysisFailed(convId: string) {
    await this.q('UPDATE conversations SET analysis_attempts = analysis_attempts + 1 WHERE tenant_id = ? AND id = ?', this.tenantId, convId).run()
  }
  /** Marca el aviso por correo; devuelve false si ya se había mandado (no se repite) */
  async claimLeadNotice(convId: string): Promise<boolean> {
    const r = await this.q('UPDATE conversations SET lead_notified = 1 WHERE tenant_id = ? AND id = ? AND lead_notified = 0', this.tenantId, convId).run()
    return r.meta.changes > 0
  }
  async updateLead(convId: string, f: Partial<Pick<ConversationRow, 'lead_stage' | 'lead_status' | 'contact_name' | 'contact_email' | 'contact_phone' | 'contact_company'>>) {
    const { sets, vals } = setClause(f, ['lead_stage', 'lead_status', 'contact_name', 'contact_email', 'contact_phone', 'contact_company'])
    if (!sets.length) return
    await this.q(`UPDATE conversations SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, ...vals, this.tenantId, convId).run()
  }
  /** Indicadores de prospectos para la cabecera de Conversaciones */
  async leadStats(f: ConvFilter) {
    const where = ['c.tenant_id = ?']
    const vals: unknown[] = [this.tenantId]
    convWhere({ agentId: f.agentId, from: f.from, to: f.to, channel: f.channel }, where, vals)
    const r = await this.q(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN lead_status IN ('hot','warm','cold') THEN 1 ELSE 0 END) AS prospects,
         SUM(CASE WHEN lead_status = 'hot' THEN 1 ELSE 0 END) AS hot,
         SUM(CASE WHEN lead_status = 'warm' THEN 1 ELSE 0 END) AS warm,
         SUM(CASE WHEN lead_status IN ('hot','warm','cold') AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL) THEN 1 ELSE 0 END) AS with_contact,
         SUM(CASE WHEN lead_status IN ('hot','warm','cold') AND lead_stage = 'new' THEN 1 ELSE 0 END) AS to_contact,
         SUM(CASE WHEN lead_stage = 'won' THEN 1 ELSE 0 END) AS won,
         SUM(CASE WHEN analyzed_at IS NULL OR analyzed_at < last_message_at THEN 1 ELSE 0 END) AS pending
       FROM conversations c WHERE ${where.join(' AND ')}`,
      ...vals,
    ).first<Record<string, number | null>>()
    const n = (k: string) => Number(r?.[k] ?? 0)
    return { total: n('total'), prospects: n('prospects'), hot: n('hot'), warm: n('warm'), with_contact: n('with_contact'), to_contact: n('to_contact'), won: n('won'), pending: n('pending') }
  }
  exportLeads(f: ConvFilter) {
    const where = ['c.tenant_id = ?']
    const vals: unknown[] = [this.tenantId]
    convWhere(f, where, vals)
    return this.q(
      `SELECT c.*, a.name AS agent_name FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id AND a.tenant_id = c.tenant_id
       WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC LIMIT 5000`,
      ...vals,
    ).all<ConversationRow & { agent_name: string | null }>().then((r) => r.results)
  }

  /** Conversaciones por agente desde una fecha (para el inicio del portal) */
  conversationStats(from: number) {
    return this.q(
      'SELECT agent_id, COUNT(*) AS n, MAX(last_message_at) AS last_at FROM conversations WHERE tenant_id = ? AND last_message_at >= ? GROUP BY agent_id',
      this.tenantId, from,
    ).all<{ agent_id: string; n: number; last_at: number }>().then((r) => r.results)
  }
  messages(convId: string, limit = 500) {
    return this.q('SELECT * FROM messages WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at, rowid LIMIT ?', this.tenantId, convId, limit).all<MessageRow>().then((r) => r.results)
  }
  async recentMessages(convId: string, limit: number) {
    const r = await this.q(
      'SELECT role, content FROM messages WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      this.tenantId, convId, limit,
    ).all<{ role: 'user' | 'assistant'; content: string }>()
    return r.results.reverse()
  }
  async insertMessage(m: Omit<MessageRow, 'tenant_id' | 'created_at' | 'feedback'> & { created_at?: number }) {
    const t = m.created_at ?? Date.now()
    const title = m.role === 'user' ? m.content.replace(/\s+/g, ' ').trim().slice(0, 80) : null
    await this.db.batch([
      this.db
        .prepare('INSERT INTO messages (id, tenant_id, conversation_id, role, content, tokens_in, tokens_out, model_id, estimated, sources_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(m.id, this.tenantId, m.conversation_id, m.role, m.content, m.tokens_in, m.tokens_out, m.model_id, m.estimated, m.sources_json, t),
      this.db
        .prepare('UPDATE conversations SET last_message_at = ?, message_count = message_count + 1, title = COALESCE(title, ?) WHERE tenant_id = ? AND id = ?')
        .bind(t, title, this.tenantId, m.conversation_id),
    ])
  }
  /** El visitante finaliza la conversación (solo una vez) */
  async endConversation(convId: string, by: 'visitor' | 'agent'): Promise<boolean> {
    const r = await this.q('UPDATE conversations SET ended_at = ?, ended_by = ? WHERE tenant_id = ? AND id = ? AND ended_at IS NULL', Date.now(), by, this.tenantId, convId).run()
    return r.meta.changes > 0
  }
  async rateConversation(convId: string, rating: number) {
    await this.q('UPDATE conversations SET rating = ? WHERE tenant_id = ? AND id = ? AND ended_at IS NOT NULL', rating, this.tenantId, convId).run()
  }
  async setFeedback(convId: string, messageId: string, value: 1 | -1 | null) {
    const r = await this.q("UPDATE messages SET feedback = ? WHERE tenant_id = ? AND conversation_id = ? AND id = ? AND role = 'assistant'", value, this.tenantId, convId, messageId).run()
    return r.meta.changes > 0
  }
  async deleteConversation(convId: string) {
    await this.db.batch([
      this.db.prepare('DELETE FROM messages WHERE tenant_id = ? AND conversation_id = ?').bind(this.tenantId, convId),
      this.db.prepare('DELETE FROM conversations WHERE tenant_id = ? AND id = ?').bind(this.tenantId, convId),
    ])
  }
  async purgeOlderThan(cutoff: number) {
    await this.db.batch([
      this.db.prepare('DELETE FROM messages WHERE tenant_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE tenant_id = ? AND last_message_at < ?)').bind(this.tenantId, this.tenantId, cutoff),
      this.db.prepare('DELETE FROM conversations WHERE tenant_id = ? AND last_message_at < ?').bind(this.tenantId, cutoff),
    ])
  }
  /** Mensajes del periodo; opcionalmente de un solo agente y canal */
  exportMessages(from: number, to: number, agentId?: string, channel?: 'chat' | 'voice') {
    const extra: string[] = []
    const vals: unknown[] = []
    if (agentId) {
      extra.push('c.agent_id = ?')
      vals.push(agentId)
    }
    if (channel === 'voice') extra.push("c.channel = 'voice'")
    if (channel === 'chat') extra.push("(c.channel IS NULL OR c.channel <> 'voice')")
    return this.q(
      `SELECT c.id AS conversation_id, a.name AS agent, c.origin, m.role, m.content, m.created_at
       FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
       LEFT JOIN agents a ON a.id = c.agent_id AND a.tenant_id = c.tenant_id
       WHERE m.tenant_id = ? AND m.created_at >= ? AND m.created_at < ?${extra.map((x) => ' AND ' + x).join('')} ORDER BY c.id, m.created_at LIMIT 50000`,
      this.tenantId, from, to, ...vals,
    ).all<{ conversation_id: string; agent: string | null; origin: string | null; role: string; content: string; created_at: number }>().then((r) => r.results)
  }
  avgTokensPerConversation(since: number) {
    return this.q(
      `SELECT COUNT(DISTINCT conversation_id) AS convs, COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout
       FROM usage_ledger WHERE tenant_id = ? AND created_at >= ? AND kind = 'chat'`,
      this.tenantId, since,
    ).first<{ convs: number; tin: number; tout: number }>()
  }

  /* ---------- consumo ---------- */
  async insertLedger(l: {
    message_id: string | null
    conversation_id: string | null
    model_id: string
    model_type: string
    kind: string
    tokens_in: number
    tokens_out: number
    cost_micro: number
    price_version: string
    estimated: number
    /** message · minute · token · included */
    billing?: string | null
    /** mensajes: 1 · voz: segundos */
    units?: number | null
    unit_price_micro?: number | null
    /** lo que habría costado por tokens (referencia para el admin) */
    token_cost_micro?: number | null
    /** parte del importe que es excedente de tokens */
    overage_micro?: number | null
  }) {
    await this.q(
      `INSERT INTO usage_ledger (id, tenant_id, message_id, conversation_id, model_id, model_type, kind, tokens_in, tokens_out, cost_micro, price_version, estimated, created_at, billing, units, unit_price_micro, token_cost_micro, overage_micro)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id(), this.tenantId, l.message_id, l.conversation_id, l.model_id, l.model_type, l.kind, l.tokens_in, l.tokens_out, l.cost_micro, l.price_version, l.estimated, Date.now(),
      l.billing ?? null, l.units ?? null, l.unit_price_micro ?? null, l.token_cost_micro ?? null, l.overage_micro ?? null,
    ).run()
  }
  spendBetween(from: number, to: number) {
    return this.q(
      'SELECT COALESCE(SUM(cost_micro),0) AS cost, COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout FROM usage_ledger WHERE tenant_id = ? AND created_at >= ? AND created_at < ?',
      this.tenantId, from, to,
    ).first<{ cost: number; tin: number; tout: number }>()
  }
  dailyUsage(from: number, to: number) {
    return this.q(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(cost_micro) AS cost
       FROM usage_ledger WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY day ORDER BY day`,
      this.tenantId, from, to,
    ).all<{ day: string; tin: number; tout: number; cost: number }>().then((r) => r.results)
  }
  usageByModel(from: number, to: number) {
    return this.q(
      `SELECT model_id, model_type, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(cost_micro) AS cost, COUNT(*) AS n,
         SUM(CASE WHEN kind = 'chat' THEN 1 ELSE 0 END) AS replies,
         SUM(CASE WHEN billing = 'message' THEN COALESCE(units, 1) ELSE 0 END) AS billed_messages,
         COALESCE(SUM(overage_micro), 0) AS overage,
         SUM(CASE WHEN overage_micro > 0 THEN 1 ELSE 0 END) AS overage_messages,
         SUM(CASE WHEN model_type <> 'voice' THEN 0
                  WHEN units IS NOT NULL THEN units
                  WHEN INSTR(price_version, '/min:') > 0 THEN CAST(REPLACE(SUBSTR(price_version, INSTR(price_version, '/min:') + 5), 's', '') AS INTEGER)
                  ELSE 0 END) AS voice_secs
       FROM usage_ledger WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY model_id, model_type`,
      this.tenantId, from, to,
    ).all<{ model_id: string; model_type: string; tin: number; tout: number; cost: number; n: number; replies: number; billed_messages: number; overage: number; overage_messages: number; voice_secs: number }>().then((r) => r.results)
  }
  /** Consumo de un asistente en un periodo, para calcular lo que el cliente cobra en reventa.
   *  ex_in / ex_out = tokens arriba de lo incluido, sumados respuesta por respuesta. */
  agentResaleUsage(agentId: string, from: number, to: number, incIn: number | null, incOut: number | null) {
    return this.q(
      `SELECT
         SUM(CASE WHEN l.kind = 'chat' THEN 1 ELSE 0 END) AS msgs,
         SUM(CASE WHEN l.kind = 'chat' AND ? IS NOT NULL THEN MAX(0, l.tokens_in - ?) ELSE 0 END) AS ex_in,
         SUM(CASE WHEN l.kind = 'chat' AND ? IS NOT NULL THEN MAX(0, l.tokens_out - ?) ELSE 0 END) AS ex_out,
         SUM(CASE WHEN l.model_type <> 'voice' THEN 0
                  WHEN l.units IS NOT NULL THEN l.units
                  WHEN INSTR(l.price_version, '/min:') > 0 THEN CAST(REPLACE(SUBSTR(l.price_version, INSTR(l.price_version, '/min:') + 5), 's', '') AS INTEGER)
                  ELSE 0 END) AS voice_secs,
         SUM(l.tokens_in) AS tokens_in, SUM(l.tokens_out) AS tokens_out,
         SUM(l.cost_micro) AS paid
       FROM usage_ledger l JOIN conversations c ON c.id = l.conversation_id AND c.tenant_id = l.tenant_id
       WHERE l.tenant_id = ? AND c.agent_id = ? AND l.created_at >= ? AND l.created_at < ?`,
      incIn, incIn ?? 0, incOut, incOut ?? 0, this.tenantId, agentId, from, to,
    ).first<{ msgs: number | null; ex_in: number | null; ex_out: number | null; voice_secs: number | null; tokens_in: number | null; tokens_out: number | null; paid: number | null }>()
  }
  /** Tokens promedio por respuesta de este cliente (para elegir sus tokens incluidos) */
  replyTokenStats(since: number) {
    return this.q(
      `SELECT COUNT(*) AS n, ROUND(AVG(tokens_in)) AS avg_in, ROUND(AVG(tokens_out)) AS avg_out, MAX(tokens_in) AS max_in, MAX(tokens_out) AS max_out
       FROM usage_ledger WHERE tenant_id = ? AND kind = 'chat' AND created_at >= ?`,
      this.tenantId, since,
    ).first<{ n: number; avg_in: number | null; avg_out: number | null; max_in: number | null; max_out: number | null }>()
  }
  /** Respuestas del asistente por conversación (para la calculadora del portal) */
  avgRepliesPerConversation(since: number) {
    return this.q(
      `SELECT COUNT(DISTINCT conversation_id) AS convs, COUNT(*) AS replies
       FROM usage_ledger WHERE tenant_id = ? AND created_at >= ? AND kind = 'chat' AND conversation_id IS NOT NULL`,
      this.tenantId, since,
    ).first<{ convs: number; replies: number }>()
  }
  statements() {
    return this.q("SELECT * FROM statements WHERE tenant_id = ? AND status != 'draft' ORDER BY period DESC", this.tenantId).all<StatementRow>().then((r) => r.results)
  }
  statement(period: string) {
    return this.q("SELECT * FROM statements WHERE tenant_id = ? AND period = ? AND status != 'draft'", this.tenantId, period).first<StatementRow>()
  }
  overrideFor(modelId: string, at: number) {
    return this.q('SELECT * FROM tenant_price_overrides WHERE tenant_id = ? AND model_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1', this.tenantId, modelId, at).first<OverrideRow>()
  }

  /* ---------- alertas ---------- */
  async addAlert(kind: string, period: string, message: string): Promise<boolean> {
    const r = await this.q('INSERT OR IGNORE INTO alerts (id, tenant_id, kind, period, message, created_at) VALUES (?, ?, ?, ?, ?, ?)', id(), this.tenantId, kind, period, message, Date.now()).run()
    return r.meta.changes > 0
  }
  alerts(limit = 20) {
    return this.q('SELECT * FROM alerts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', this.tenantId, limit).all<AlertRow>().then((r) => r.results)
  }
  async markAlertsRead() {
    await this.q('UPDATE alerts SET read_at = ? WHERE tenant_id = ? AND read_at IS NULL', Date.now(), this.tenantId).run()
  }

  /* ---------- equipo ---------- */
  users() {
    return this.q('SELECT id, email, name, role, status, totp_enabled, created_at, last_login_at FROM users WHERE tenant_id = ? ORDER BY created_at', this.tenantId)
      .all<Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'status' | 'totp_enabled' | 'created_at' | 'last_login_at'>>()
      .then((r) => r.results)
  }
  user(userId: string) {
    return this.q('SELECT * FROM users WHERE tenant_id = ? AND id = ?', this.tenantId, userId).first<UserRow>()
  }
  userByEmail(email: string) {
    return this.q('SELECT * FROM users WHERE tenant_id = ? AND email = ?', this.tenantId, email).first<UserRow>()
  }
  async createUser(u: { id: string; email: string; name: string | null; role: 'owner' | 'editor' }) {
    await this.q("INSERT INTO users (id, tenant_id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, ?, 'invited', ?)", u.id, this.tenantId, u.email, u.name, u.role, Date.now()).run()
  }
  async setUserRole(userId: string, role: 'owner' | 'editor') {
    await this.q('UPDATE users SET role = ? WHERE tenant_id = ? AND id = ?', role, this.tenantId, userId).run()
  }
  async deleteUser(userId: string) {
    await this.db.batch([
      this.db.prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?').bind(this.tenantId, userId),
      this.db.prepare('DELETE FROM users WHERE tenant_id = ? AND id = ?').bind(this.tenantId, userId),
    ])
  }
  ownerCount() {
    return this.q("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'owner' AND status = 'active'", this.tenantId).first<{ n: number }>().then((r) => r?.n ?? 0)
  }
  ownerEmails() {
    return this.q("SELECT email FROM users WHERE tenant_id = ? AND role = 'owner' AND status = 'active'", this.tenantId).all<{ email: string }>().then((r) => r.results.map((x) => x.email))
  }
}
