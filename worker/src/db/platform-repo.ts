/*
  Accesos de plataforma (superadmin, login y búsquedas públicas por widget_key).
  Son las únicas consultas que cruzan clientes, y solo se usan desde el panel admin,
  el login o para resolver el tenant a partir de una llave validada.
*/
import type { ModelRow, OverrideRow, PriceRow, SessionRow, StatementRow, TenantRow, UserRow, VoiceCallRow, WidgetRow } from './types'

const id = () => crypto.randomUUID()

export class PlatformRepo {
  constructor(private db: D1Database) {}

  private q(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).bind(...params)
  }

  /* ---------- tenants ---------- */
  tenantById(tid: string) {
    return this.q('SELECT * FROM tenants WHERE id = ?', tid).first<TenantRow>()
  }
  tenantBySlug(slug: string) {
    return this.q('SELECT * FROM tenants WHERE slug = ?', slug).first<TenantRow>()
  }
  async listTenants(from: number, to: number) {
    const r = await this.q(
      `SELECT t.id, t.slug, t.name, t.status, t.plan_id, t.monthly_limit_micro, t.limit_behavior, t.enabled_models, t.created_at, t.onboarded,
         COALESCE(u.tin, 0) AS tokens_in, COALESCE(u.tout, 0) AS tokens_out, COALESCE(u.cost, 0) AS cost_micro,
         (SELECT COUNT(*) FROM alerts a WHERE a.tenant_id = t.id AND a.read_at IS NULL) AS open_alerts,
         (SELECT email FROM users x WHERE x.tenant_id = t.id AND x.role = 'owner' ORDER BY x.created_at LIMIT 1) AS owner_email
       FROM tenants t LEFT JOIN (
         SELECT tenant_id, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(cost_micro) AS cost
         FROM usage_ledger WHERE created_at >= ? AND created_at < ? GROUP BY tenant_id
       ) u ON u.tenant_id = t.id ORDER BY t.created_at DESC`,
      from, to,
    ).all()
    return r.results
  }
  async insertTenant(t: Pick<TenantRow, 'id' | 'slug' | 'name' | 'plan_id' | 'monthly_limit_micro' | 'limit_behavior' | 'enabled_models' | 'data_key_enc' | 'currency'>) {
    await this.q(
      `INSERT INTO tenants (id, slug, name, status, plan_id, monthly_limit_micro, currency, limit_behavior, enabled_models, data_key_enc, created_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      t.id, t.slug, t.name, t.plan_id, t.monthly_limit_micro, t.currency, t.limit_behavior, t.enabled_models, t.data_key_enc, Date.now(),
    ).run()
  }
  async updateTenant(tid: string, f: Partial<Pick<TenantRow, 'name' | 'status' | 'plan_id' | 'monthly_limit_micro' | 'limit_behavior' | 'enabled_models' | 'suspended_message' | 'turnstile' | 'currency'>>) {
    const allowed = ['name', 'status', 'plan_id', 'monthly_limit_micro', 'limit_behavior', 'enabled_models', 'suspended_message', 'turnstile', 'currency'] as const
    const sets: string[] = []
    const vals: unknown[] = []
    for (const k of allowed) {
      if (f[k] === undefined) continue
      sets.push(`${k} = ?`)
      vals.push(f[k])
    }
    if (!sets.length) return
    await this.q(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, ...vals, tid).run()
  }
  allTenantIds() {
    return this.q('SELECT id, retention_days FROM tenants').all<{ id: string; retention_days: number }>().then((r) => r.results)
  }

  /** Resuelve el tenant a partir de la llave pública del widget (no secreta) */
  widgetByKey(key: string) {
    return this.q('SELECT * FROM widget_configs WHERE widget_key = ?', key).first<WidgetRow>()
  }

  /* ---------- usuarios y sesiones ---------- */
  userById(uid: string) {
    return this.q('SELECT * FROM users WHERE id = ?', uid).first<UserRow>()
  }
  superadminByEmail(email: string) {
    return this.q("SELECT * FROM users WHERE tenant_id IS NULL AND role = 'superadmin' AND email = ?", email).first<UserRow>()
  }
  /** Llamadas de voz que el navegador no alcanzó a cerrar (las guarda el cron) */
  pendingVoiceCalls(olderThan: number, limit = 10) {
    return this.q("SELECT * FROM voice_calls WHERE status = 'pending' AND attempts < 6 AND created_at < ? ORDER BY created_at LIMIT ?", olderThan, limit).all<VoiceCallRow>().then((r) => r.results)
  }
  /** Conversaciones por analizar: cerradas, o sin mensajes nuevos desde hace un rato; con al menos un mensaje del visitante */
  pendingAnalysis(idleBefore: number, limit = 20) {
    return this.q(
      `SELECT c.id, c.tenant_id FROM conversations c JOIN tenants t ON t.id = c.tenant_id AND t.status = 'active'
       WHERE (c.analyzed_at IS NULL OR c.analyzed_at < c.last_message_at) AND c.analysis_attempts < 3 AND c.message_count >= 2
         AND (c.ended_at IS NOT NULL OR c.last_message_at < ?) AND c.last_message_at > ?
       ORDER BY c.last_message_at DESC LIMIT ?`,
      idleBefore, Date.now() - 14 * 86_400_000, limit,
    ).all<{ id: string; tenant_id: string }>().then((r) => r.results)
  }
  /** Correos del equipo Zentekia (para avisos como solicitudes de asistentes nuevos) */
  superadminEmails() {
    return this.q("SELECT email FROM users WHERE tenant_id IS NULL AND role = 'superadmin' AND status = 'active'").all<{ email: string }>().then((r) => r.results.map((x) => x.email))
  }
  superadminCount() {
    return this.q("SELECT COUNT(*) AS n FROM users WHERE tenant_id IS NULL AND role = 'superadmin'").first<{ n: number }>().then((r) => r?.n ?? 0)
  }
  tenantUserByEmail(tenantId: string, email: string) {
    return this.q('SELECT * FROM users WHERE tenant_id = ? AND email = ?', tenantId, email).first<UserRow>()
  }
  async insertUser(u: Pick<UserRow, 'id' | 'tenant_id' | 'email' | 'name' | 'role' | 'password_hash' | 'status'>) {
    await this.q(
      'INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      u.id, u.tenant_id, u.email, u.name, u.role, u.password_hash, u.status, Date.now(),
    ).run()
  }
  async setPassword(uid: string, hash: string) {
    await this.q("UPDATE users SET password_hash = ?, status = 'active' WHERE id = ?", hash, uid).run()
  }
  async setTotp(uid: string, secretEnc: string | null, enabled: boolean) {
    await this.q('UPDATE users SET totp_secret_enc = ?, totp_enabled = ? WHERE id = ?', secretEnc, enabled ? 1 : 0, uid).run()
  }
  async setName(uid: string, name: string) {
    await this.q('UPDATE users SET name = ? WHERE id = ?', name, uid).run()
  }
  async touchLogin(uid: string) {
    await this.q('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), uid).run()
  }

  async insertSession(s: SessionRow) {
    await this.q(
      'INSERT INTO sessions (id_hash, user_id, tenant_id, kind, csrf, mfa_ok, impersonator_id, read_only, expires_at, created_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      s.id_hash, s.user_id, s.tenant_id, s.kind, s.csrf, s.mfa_ok, s.impersonator_id, s.read_only, s.expires_at, s.created_at, s.ip,
    ).run()
  }
  session(idHash: string) {
    return this.q('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?', idHash, Date.now()).first<SessionRow>()
  }
  async setSessionMfa(idHash: string) {
    await this.q('UPDATE sessions SET mfa_ok = 1 WHERE id_hash = ?', idHash).run()
  }
  async deleteSession(idHash: string) {
    await this.q('DELETE FROM sessions WHERE id_hash = ?', idHash).run()
  }
  async deleteUserSessions(uid: string, exceptHash?: string) {
    await this.q('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?', uid, exceptHash ?? '').run()
  }
  async purgeSessions() {
    await this.q('DELETE FROM sessions WHERE expires_at < ?', Date.now()).run()
    await this.q('DELETE FROM one_time_tokens WHERE expires_at < ?', Date.now() - 86_400_000).run()
  }

  async insertOneTime(t: { token_hash: string; kind: string; user_id: string | null; tenant_id: string | null; data: string | null; expires_at: number }) {
    await this.q('INSERT INTO one_time_tokens (token_hash, kind, user_id, tenant_id, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)', t.token_hash, t.kind, t.user_id, t.tenant_id, t.data, t.expires_at).run()
  }
  peekOneTime(hash: string, kind: string) {
    return this.q('SELECT * FROM one_time_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?', hash, kind, Date.now()).first<{
      token_hash: string; kind: string; user_id: string | null; tenant_id: string | null; data: string | null; expires_at: number
    }>()
  }
  /** Marca el token como usado de forma atómica (solo gana una petición) */
  async consumeOneTime(hash: string): Promise<boolean> {
    const r = await this.q('UPDATE one_time_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', Date.now(), hash, Date.now()).run()
    return r.meta.changes === 1
  }

  /* ---------- modelos y tarifas ---------- */
  models(onlyActive = false) {
    return this.q(`SELECT * FROM models ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY sort, display_name`).all<ModelRow>().then((r) => r.results)
  }
  model(mid: string) {
    return this.q('SELECT * FROM models WHERE id = ?', mid).first<ModelRow>()
  }
  async upsertModel(m: Omit<ModelRow, 'sort'>) {
    await this.q(
      `INSERT INTO models (id, provider, model_name, display_name, type, active, context_window, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM models))
       ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model_name = excluded.model_name, display_name = excluded.display_name,
         type = excluded.type, active = excluded.active, context_window = excluded.context_window`,
      m.id, m.provider, m.model_name, m.display_name, m.type, m.active, m.context_window,
    ).run()
  }
  currentPrice(mid: string, at = Date.now()) {
    return this.q('SELECT * FROM price_list WHERE model_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1', mid, at).first<PriceRow>()
  }
  priceHistory(mid: string) {
    return this.q('SELECT * FROM price_list WHERE model_id = ? ORDER BY effective_from DESC LIMIT 20', mid).all<PriceRow>().then((r) => r.results)
  }
  async addPrice(p: Omit<PriceRow, 'id'>) {
    await this.q(
      'INSERT INTO price_list (id, model_id, input_per_1m_micro, output_per_1m_micro, fee_input_per_1m_micro, fee_output_per_1m_micro, effective_from) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id(), p.model_id, p.input_per_1m_micro, p.output_per_1m_micro, p.fee_input_per_1m_micro, p.fee_output_per_1m_micro, p.effective_from,
    ).run()
  }
  overrides() {
    return this.q(
      `SELECT o.*, t.name AS tenant_name, t.slug FROM tenant_price_overrides o JOIN tenants t ON t.id = o.tenant_id
       WHERE o.effective_from = (SELECT MAX(effective_from) FROM tenant_price_overrides x WHERE x.tenant_id = o.tenant_id AND x.model_id = o.model_id)
       ORDER BY t.name`,
    ).all<OverrideRow & { tenant_name: string; slug: string }>().then((r) => r.results)
  }
  async addOverride(o: Omit<OverrideRow, 'id'>) {
    await this.q(
      `INSERT INTO tenant_price_overrides (id, tenant_id, model_id, input_per_1m_micro, output_per_1m_micro, fee_input_per_1m_micro, fee_output_per_1m_micro, discount_pct, effective_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id(), o.tenant_id, o.model_id, o.input_per_1m_micro, o.output_per_1m_micro, o.fee_input_per_1m_micro, o.fee_output_per_1m_micro, o.discount_pct, o.effective_from,
    ).run()
  }

  /* ---------- reportes y estados de cuenta ---------- */
  usageReport(from: number, to: number, tenantId?: string) {
    return this.q(
      `SELECT l.tenant_id, t.name AS tenant_name, t.slug, l.model_id, l.model_type,
         SUM(l.tokens_in) AS tokens_in, SUM(l.tokens_out) AS tokens_out, SUM(l.cost_micro) AS cost_micro, COUNT(*) AS messages,
         SUM(l.estimated) AS estimated
       FROM usage_ledger l JOIN tenants t ON t.id = l.tenant_id
       WHERE l.created_at >= ? AND l.created_at < ? ${tenantId ? 'AND l.tenant_id = ?' : ''}
       GROUP BY l.tenant_id, l.model_id, l.model_type ORDER BY t.name, l.model_id`,
      ...(tenantId ? [from, to, tenantId] : [from, to]),
    ).all<{ tenant_id: string; tenant_name: string; slug: string; model_id: string; model_type: string; tokens_in: number; tokens_out: number; cost_micro: number; messages: number; estimated: number }>().then((r) => r.results)
  }
  dailyTotals(from: number, to: number) {
    return this.q(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(cost_micro) AS cost
       FROM usage_ledger WHERE created_at >= ? AND created_at < ? GROUP BY day ORDER BY day`,
      from, to,
    ).all<{ day: string; tin: number; tout: number; cost: number }>().then((r) => r.results)
  }
  statements(period?: string) {
    return this.q(
      `SELECT s.*, t.name AS tenant_name, t.slug FROM statements s JOIN tenants t ON t.id = s.tenant_id ${period ? 'WHERE s.period = ?' : ''} ORDER BY s.period DESC, t.name`,
      ...(period ? [period] : []),
    ).all<StatementRow & { tenant_name: string; slug: string }>().then((r) => r.results)
  }
  statementById(sid: string) {
    return this.q('SELECT * FROM statements WHERE id = ?', sid).first<StatementRow>()
  }
  async upsertStatement(s: Omit<StatementRow, 'id' | 'paid_at' | 'status' | 'generated_at'>) {
    // Un estado ya pagado no se recalcula
    await this.q(
      `INSERT INTO statements (id, tenant_id, period, tokens_in, tokens_out, total_micro, status, lines_json, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
       ON CONFLICT(tenant_id, period) DO UPDATE SET tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
         total_micro = excluded.total_micro, lines_json = excluded.lines_json, generated_at = excluded.generated_at
       WHERE statements.status = 'draft'`,
      id(), s.tenant_id, s.period, s.tokens_in, s.tokens_out, s.total_micro, s.lines_json, Date.now(),
    ).run()
  }
  async setStatementStatus(sid: string, status: 'issued' | 'paid') {
    await this.q('UPDATE statements SET status = ?, paid_at = CASE WHEN ? = \'paid\' THEN ? ELSE paid_at END WHERE id = ?', status, status, Date.now(), sid).run()
  }

  /* ---------- auditoría (solo inserción) ---------- */
  async audit(a: { actor_id: string | null; actor_email: string | null; tenant_id: string | null; action: string; detail?: unknown; ip: string | null }) {
    await this.q(
      'INSERT INTO audit_log (id, actor_id, actor_email, tenant_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id(), a.actor_id, a.actor_email, a.tenant_id, a.action, a.detail === undefined ? null : JSON.stringify(a.detail), a.ip, Date.now(),
    ).run()
  }
  auditList(f: { tenantId?: string; action?: string; limit: number; before?: number }) {
    const where: string[] = []
    const vals: unknown[] = []
    if (f.tenantId) {
      where.push('a.tenant_id = ?')
      vals.push(f.tenantId)
    }
    if (f.action) {
      where.push('a.action LIKE ?')
      vals.push(`${f.action}%`)
    }
    if (f.before) {
      where.push('a.created_at < ?')
      vals.push(f.before)
    }
    return this.q(
      `SELECT a.*, t.name AS tenant_name FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC LIMIT ?`,
      ...vals, f.limit,
    ).all().then((r) => r.results)
  }
  tenantAudit(tenantId: string, limit: number) {
    return this.q('SELECT action, actor_email, detail, ip, created_at FROM audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', tenantId, limit).all().then((r) => r.results)
  }

  /** Prompts activos de la versión anterior (tabla legacy_prompts), si existe */
  async legacyPrompts(): Promise<Map<string, string>> {
    try {
      const r = await this.q('SELECT agent, content FROM legacy_prompts WHERE is_active = 1 ORDER BY updated_at').all<{ agent: string; content: string }>()
      return new Map(r.results.map((x) => [x.agent, x.content]))
    } catch {
      return new Map()
    }
  }

  /* ---------- tareas programadas ---------- */
  pendingKbSources(limit: number) {
    return this.q("SELECT tenant_id, id FROM kb_sources WHERE status IN ('queued', 'processing') ORDER BY updated_at LIMIT ?", limit).all<{ tenant_id: string; id: string }>().then((r) => r.results)
  }
}
