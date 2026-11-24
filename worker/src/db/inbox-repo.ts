/*
  Acceso a datos de la bandeja (fase 1 omnicanal) de UN cliente.
  Igual que TenantRepo: toda consulta lleva "tenant_id = ?" con el id fijado al construirlo,
  y ese id sale de la sesión o del token del widget, nunca del cliente.

  Las transiciones de estado son UPDATE condicionales (WHERE status = …): si dos agentes
  intentan tomar la misma conversación, solo a uno le cambia una fila.
*/
import type { ConversationRow, MessageRow } from './types'

export type ConvStatus = 'ai_active' | 'waiting_human' | 'human_active' | 'closed'
export type PresenceStatus = 'online' | 'away' | 'offline'
export type InboxView = 'mine' | 'unassigned' | 'waiting' | 'ai' | 'all' | 'closed'

export interface InboxConversation extends ConversationRow {
  status: ConvStatus
  assignee_user_id: string | null
  queue_id: string | null
  escalation_reason: string | null
  escalation_note: string | null
  escalated_at: number | null
  assigned_at: number | null
  first_human_response_at: number | null
  handled_by_human: number
}

export interface InboxMessage extends Omit<MessageRow, 'role' | 'sender' | 'author_id' | 'kind'> {
  role: 'user' | 'assistant' | 'system'
  sender: 'human' | 'system' | null
  author_id: string | null
  kind: 'text' | 'notice' | 'note' | 'event'
}

export interface QueueRow {
  id: string
  tenant_id: string
  name: string
  created_at: number
}

export interface PresenceRow {
  user_id: string
  status: PresenceStatus
  max_chats: number
  last_assigned_at: number | null
  updated_at: number
}

export interface QuickReplyRow {
  id: string
  shortcut: string
  text: string
  created_at: number
}

const OPEN = "status IN ('waiting_human','human_active')"

export class InboxRepo {
  constructor(
    private db: D1Database,
    readonly tenantId: string,
  ) {
    if (!tenantId) throw new Error('InboxRepo requiere tenantId')
  }

  private q(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).bind(...params)
  }

  /* ---------- conversaciones ---------- */
  conversation(convId: string) {
    return this.q('SELECT * FROM conversations WHERE tenant_id = ? AND id = ?', this.tenantId, convId).first<InboxConversation>()
  }

  /**
   * Lista de la bandeja. `queues` limita a las colas del agente (null = sin cola, visible para todos).
   * Un agente ve: las suyas + las sin asignar de sus colas. Supervisores y admins ven todo.
   */
  async list(o: { view: InboxView; userId: string; queues: string[] | null; queueId?: string; agentId?: string; limit: number }) {
    const where = ['c.tenant_id = ?', "(c.channel IS NULL OR c.channel <> 'voice')"]
    const vals: unknown[] = [this.tenantId]
    switch (o.view) {
      case 'mine':
        where.push("c.status = 'human_active' AND c.assignee_user_id = ?")
        vals.push(o.userId)
        break
      case 'unassigned':
        where.push("c.status = 'waiting_human' AND c.assignee_user_id IS NULL")
        break
      case 'waiting':
        where.push("c.status = 'waiting_human'")
        break
      case 'ai':
        where.push("c.status = 'ai_active' AND c.ended_at IS NULL")
        break
      case 'closed':
        where.push("c.status = 'closed' AND c.handled_by_human = 1")
        break
      case 'all':
        where.push(`c.${OPEN}`)
        break
    }
    if (o.queues) {
      // Agente: solo sus conversaciones o las de sus colas (o sin cola)
      const qs = o.queues.length ? `c.queue_id IN (${o.queues.map(() => '?').join(',')})` : '0'
      where.push(`(c.assignee_user_id = ? OR c.queue_id IS NULL OR ${qs})`)
      vals.push(o.userId, ...o.queues)
    }
    if (o.queueId) {
      where.push('c.queue_id = ?')
      vals.push(o.queueId)
    }
    if (o.agentId) {
      where.push('c.agent_id = ?')
      vals.push(o.agentId)
    }
    const order = o.view === 'waiting' || o.view === 'unassigned' ? 'COALESCE(c.escalated_at, c.last_message_at) ASC' : 'c.last_message_at DESC'
    const r = await this.q(
      `SELECT c.*, a.name AS agent_name, u.name AS assignee_name, u.email AS assignee_email, qq.name AS queue_name,
         (SELECT m.content FROM messages m WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.kind = 'text' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_text
       FROM conversations c
       LEFT JOIN agents a ON a.id = c.agent_id AND a.tenant_id = c.tenant_id
       LEFT JOIN users u ON u.id = c.assignee_user_id AND u.tenant_id = c.tenant_id
       LEFT JOIN queues qq ON qq.id = c.queue_id AND qq.tenant_id = c.tenant_id
       WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
      ...vals,
      o.limit,
    ).all<InboxConversation & { agent_name: string | null; assignee_name: string | null; assignee_email: string | null; queue_name: string | null; last_text: string | null }>()
    return r.results
  }

  /** Contadores para las pestañas */
  async counts(userId: string, queues: string[] | null) {
    const where = ['tenant_id = ?']
    const vals: unknown[] = [this.tenantId]
    if (queues) {
      const qs = queues.length ? `queue_id IN (${queues.map(() => '?').join(',')})` : '0'
      where.push(`(assignee_user_id = ? OR queue_id IS NULL OR ${qs})`)
      vals.push(userId, ...queues)
    }
    const r = await this.q(
      `SELECT
         SUM(CASE WHEN status = 'human_active' AND assignee_user_id = ? THEN 1 ELSE 0 END) AS mine,
         SUM(CASE WHEN status = 'waiting_human' AND assignee_user_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
         SUM(CASE WHEN status = 'waiting_human' THEN 1 ELSE 0 END) AS waiting,
         SUM(CASE WHEN status = 'ai_active' AND ended_at IS NULL AND last_message_at > ? THEN 1 ELSE 0 END) AS ai,
         SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END) AS all_open
       FROM conversations WHERE ${where.join(' AND ')}`,
      userId,
      Date.now() - 86_400_000,
      ...vals,
    ).first<Record<string, number | null>>()
    const n = (k: string) => Number(r?.[k] ?? 0)
    return { mine: n('mine'), unassigned: n('unassigned'), waiting: n('waiting'), ai: n('ai'), all: n('all_open') }
  }

  /** IA → espera de humano (solo si la atendía la IA y no está cerrada) */
  async escalate(convId: string, f: { reason: string; note: string | null; queueId: string | null }): Promise<boolean> {
    const r = await this.q(
      `UPDATE conversations SET status = 'waiting_human', escalation_reason = ?, escalation_note = ?, queue_id = COALESCE(?, queue_id),
         escalated_at = ?, assignee_user_id = NULL
       WHERE tenant_id = ? AND id = ? AND status = 'ai_active' AND ended_at IS NULL`,
      f.reason, f.note, f.queueId, Date.now(), this.tenantId, convId,
    ).run()
    return r.meta.changes > 0
  }

  /**
   * Asigna a un agente. `from` son los estados desde los que se permite:
   *  - tomar o autoasignar: solo desde waiting_human sin asignar (dos agentes nunca ganan los dos)
   *  - reasignar (supervisor): también desde human_active
   */
  async assign(convId: string, userId: string, from: 'waiting' | 'any'): Promise<boolean> {
    const cond = from === 'waiting' ? "status = 'waiting_human' AND assignee_user_id IS NULL" : OPEN
    const t = Date.now()
    const r = await this.q(
      `UPDATE conversations SET status = 'human_active', assignee_user_id = ?, assigned_at = COALESCE(assigned_at, ?), handled_by_human = 1
       WHERE tenant_id = ? AND id = ? AND ${cond} AND ended_at IS NULL`,
      userId, t, this.tenantId, convId,
    ).run()
    if (r.meta.changes > 0) {
      await this.q(
        `INSERT INTO agent_presence (tenant_id, user_id, status, last_assigned_at, updated_at) VALUES (?, ?, 'offline', ?, ?)
         ON CONFLICT(tenant_id, user_id) DO UPDATE SET last_assigned_at = excluded.last_assigned_at`,
        this.tenantId, userId, t, t,
      ).run()
    }
    return r.meta.changes > 0
  }

  /** Vuelve a la cola (transferencia a cola o agente desconectado) */
  async requeue(convId: string, queueId: string | null | undefined, expectAssignee?: string): Promise<boolean> {
    const extra = expectAssignee ? ' AND assignee_user_id = ?' : ''
    const params: unknown[] = [this.tenantId, convId]
    if (expectAssignee) params.push(expectAssignee)
    const setQueue = queueId === undefined ? '' : ', queue_id = ?'
    const r = await this.q(
      `UPDATE conversations SET status = 'waiting_human', assignee_user_id = NULL${setQueue}
       WHERE tenant_id = ? AND id = ? AND ${OPEN} AND ended_at IS NULL${extra}`,
      ...(queueId === undefined ? [] : [queueId]),
      ...params,
    ).run()
    return r.meta.changes > 0
  }

  /** Humano o cola → IA */
  async handback(convId: string): Promise<boolean> {
    const r = await this.q(
      `UPDATE conversations SET status = 'ai_active', assignee_user_id = NULL
       WHERE tenant_id = ? AND id = ? AND ${OPEN} AND ended_at IS NULL`,
      this.tenantId, convId,
    ).run()
    return r.meta.changes > 0
  }

  /** Cierre desde la bandeja (cualquier estado abierto) */
  async close(convId: string, by: 'human' | 'visitor' | 'agent'): Promise<boolean> {
    const r = await this.q(
      `UPDATE conversations SET status = 'closed', ended_at = ?, ended_by = ? WHERE tenant_id = ? AND id = ? AND ended_at IS NULL`,
      Date.now(), by, this.tenantId, convId,
    ).run()
    return r.meta.changes > 0
  }

  /** Sincroniza el estado cuando la conversación se cerró por la ruta vieja (visitante o herramienta finalizar) */
  async markClosed(convId: string) {
    await this.q("UPDATE conversations SET status = 'closed' WHERE tenant_id = ? AND id = ? AND ended_at IS NOT NULL", this.tenantId, convId).run()
  }

  async markFirstHumanResponse(convId: string) {
    await this.q('UPDATE conversations SET first_human_response_at = COALESCE(first_human_response_at, ?) WHERE tenant_id = ? AND id = ?', Date.now(), this.tenantId, convId).run()
  }

  /** Conversaciones activas de un agente (capacidad y reencolar al desconectarse) */
  activeOf(userId: string) {
    return this.q("SELECT id FROM conversations WHERE tenant_id = ? AND assignee_user_id = ? AND status = 'human_active'", this.tenantId, userId)
      .all<{ id: string }>()
      .then((r) => r.results.map((x) => x.id))
  }

  /** Carga de cada agente (conversaciones human_active asignadas) */
  loads() {
    return this.q("SELECT assignee_user_id AS user_id, COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND status = 'human_active' AND assignee_user_id IS NOT NULL GROUP BY assignee_user_id", this.tenantId)
      .all<{ user_id: string; n: number }>()
      .then((r) => r.results)
  }

  /** En espera y sin asignar, la más antigua primero (para repartir cuando alguien se conecta) */
  waiting(limit: number) {
    return this.q(
      "SELECT id, queue_id FROM conversations WHERE tenant_id = ? AND status = 'waiting_human' AND assignee_user_id IS NULL AND ended_at IS NULL ORDER BY COALESCE(escalated_at, last_message_at) LIMIT ?",
      this.tenantId, limit,
    )
      .all<{ id: string; queue_id: string | null }>()
      .then((r) => r.results)
  }

  /** Otras conversaciones del mismo visitante (historial en el panel del contacto) */
  visitorHistory(visitorId: string, exceptId: string) {
    return this.q(
      'SELECT id, agent_id, status, started_at, last_message_at, summary, title FROM conversations WHERE tenant_id = ? AND visitor_id = ? AND id <> ? ORDER BY last_message_at DESC LIMIT 10',
      this.tenantId, visitorId, exceptId,
    )
      .all<Pick<InboxConversation, 'id' | 'agent_id' | 'status' | 'started_at' | 'last_message_at' | 'summary' | 'title'>>()
      .then((r) => r.results)
  }

  /* ---------- mensajes ---------- */
  /** Timeline completo (incluye notas internas y eventos): solo para la bandeja */
  timeline(convId: string, limit = 500) {
    return this.q(
      `SELECT m.*, u.name AS author_name, u.email AS author_email FROM messages m LEFT JOIN users u ON u.id = m.author_id AND u.tenant_id = m.tenant_id
       WHERE m.tenant_id = ? AND m.conversation_id = ? ORDER BY m.created_at, m.rowid LIMIT ?`,
      this.tenantId, convId, limit,
    )
      .all<InboxMessage & { author_name: string | null; author_email: string | null }>()
      .then((r) => r.results)
  }

  /**
   * Inserta un mensaje de humano, nota o evento del sistema.
   * Notas y eventos no cuentan para el límite de mensajes ni cambian el título.
   */
  async insert(m: { id?: string; conversation_id: string; role: InboxMessage['role']; sender: InboxMessage['sender']; author_id: string | null; kind: InboxMessage['kind']; content: string }) {
    const id = m.id ?? crypto.randomUUID()
    const t = Date.now()
    const counts = m.kind === 'text' ? 1 : 0
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO messages (id, tenant_id, conversation_id, role, content, tokens_in, tokens_out, model_id, estimated, sources_json, created_at, sender, author_id, kind) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, 0, NULL, ?, ?, ?, ?)",
        )
        .bind(id, this.tenantId, m.conversation_id, m.role, m.content, t, m.sender, m.author_id, m.kind),
      this.db
        .prepare(`UPDATE conversations SET last_message_at = CASE WHEN ? = 1 THEN ? ELSE last_message_at END, message_count = message_count + ? WHERE tenant_id = ? AND id = ?`)
        .bind(counts, t, counts, this.tenantId, m.conversation_id),
    ])
    return { id, created_at: t }
  }

  /* ---------- colas ---------- */
  queues() {
    return this.q('SELECT * FROM queues WHERE tenant_id = ? ORDER BY name', this.tenantId).all<QueueRow>().then((r) => r.results)
  }
  queue(queueId: string) {
    return this.q('SELECT * FROM queues WHERE tenant_id = ? AND id = ?', this.tenantId, queueId).first<QueueRow>()
  }
  async createQueue(name: string): Promise<string> {
    const id = crypto.randomUUID()
    await this.q('INSERT INTO queues (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)', id, this.tenantId, name, Date.now()).run()
    return id
  }
  async renameQueue(queueId: string, name: string) {
    await this.q('UPDATE queues SET name = ? WHERE tenant_id = ? AND id = ?', name, this.tenantId, queueId).run()
  }
  async deleteQueue(queueId: string) {
    await this.db.batch([
      this.db.prepare('DELETE FROM queue_members WHERE tenant_id = ? AND queue_id = ?').bind(this.tenantId, queueId),
      this.db.prepare('UPDATE conversations SET queue_id = NULL WHERE tenant_id = ? AND queue_id = ?').bind(this.tenantId, queueId),
      this.db.prepare('DELETE FROM queues WHERE tenant_id = ? AND id = ?').bind(this.tenantId, queueId),
    ])
  }
  /** Reemplaza los integrantes de una cola (solo usuarios de este cliente) */
  async setMembers(queueId: string, userIds: string[]) {
    const stmts = [this.db.prepare('DELETE FROM queue_members WHERE tenant_id = ? AND queue_id = ?').bind(this.tenantId, queueId)]
    for (const u of userIds) {
      stmts.push(
        this.db
          .prepare('INSERT OR IGNORE INTO queue_members (tenant_id, queue_id, user_id) SELECT ?, ?, id FROM users WHERE tenant_id = ? AND id = ?')
          .bind(this.tenantId, queueId, this.tenantId, u),
      )
    }
    await this.db.batch(stmts)
  }
  members() {
    return this.q('SELECT queue_id, user_id FROM queue_members WHERE tenant_id = ?', this.tenantId)
      .all<{ queue_id: string; user_id: string }>()
      .then((r) => r.results)
  }
  queuesOf(userId: string) {
    return this.q('SELECT queue_id FROM queue_members WHERE tenant_id = ? AND user_id = ?', this.tenantId, userId)
      .all<{ queue_id: string }>()
      .then((r) => r.results.map((x) => x.queue_id))
  }
  async removeUser(userId: string) {
    await this.db.batch([
      this.db.prepare('DELETE FROM queue_members WHERE tenant_id = ? AND user_id = ?').bind(this.tenantId, userId),
      this.db.prepare('DELETE FROM agent_presence WHERE tenant_id = ? AND user_id = ?').bind(this.tenantId, userId),
    ])
  }

  /* ---------- presencia (instantánea; el estado en vivo está en el InboxHub) ---------- */
  presence() {
    return this.q('SELECT user_id, status, max_chats, last_assigned_at, updated_at FROM agent_presence WHERE tenant_id = ?', this.tenantId)
      .all<PresenceRow>()
      .then((r) => r.results)
  }
  presenceOf(userId: string) {
    return this.q('SELECT user_id, status, max_chats, last_assigned_at, updated_at FROM agent_presence WHERE tenant_id = ? AND user_id = ?', this.tenantId, userId).first<PresenceRow>()
  }
  async setPresence(userId: string, f: { status?: PresenceStatus; max_chats?: number }) {
    const t = Date.now()
    await this.q(
      `INSERT INTO agent_presence (tenant_id, user_id, status, max_chats, updated_at)
       SELECT ?, id, COALESCE(?, 'offline'), COALESCE(?, 4), ? FROM users WHERE tenant_id = ? AND id = ?
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET status = COALESCE(?, status), max_chats = COALESCE(?, max_chats), updated_at = ?`,
      this.tenantId, f.status ?? null, f.max_chats ?? null, t, this.tenantId, userId, f.status ?? null, f.max_chats ?? null, t,
    ).run()
  }

  /** Personas que pueden atender la bandeja (todos los roles del cliente) */
  team() {
    return this.q("SELECT id, email, name, role FROM users WHERE tenant_id = ? AND status = 'active' ORDER BY COALESCE(name, email)", this.tenantId)
      .all<{ id: string; email: string; name: string | null; role: string }>()
      .then((r) => r.results)
  }

  /* ---------- respuestas rápidas ---------- */
  quickReplies() {
    return this.q('SELECT id, shortcut, text, created_at FROM quick_replies WHERE tenant_id = ? ORDER BY shortcut', this.tenantId).all<QuickReplyRow>().then((r) => r.results)
  }
  async createQuickReply(shortcut: string, text: string): Promise<string> {
    const id = crypto.randomUUID()
    await this.q('INSERT INTO quick_replies (id, tenant_id, shortcut, text, created_at) VALUES (?, ?, ?, ?, ?)', id, this.tenantId, shortcut, text, Date.now()).run()
    return id
  }
  async updateQuickReply(qrId: string, shortcut: string, text: string): Promise<boolean> {
    const r = await this.q('UPDATE quick_replies SET shortcut = ?, text = ? WHERE tenant_id = ? AND id = ?', shortcut, text, this.tenantId, qrId).run()
    return r.meta.changes > 0
  }
  async deleteQuickReply(qrId: string): Promise<boolean> {
    const r = await this.q('DELETE FROM quick_replies WHERE tenant_id = ? AND id = ?', this.tenantId, qrId).run()
    return r.meta.changes > 0
  }

  /* ---------- métricas (de los tiempos precalculados en conversations) ---------- */
  async metrics(from: number) {
    const r = await this.q(
      `SELECT
         COUNT(*) AS escalated,
         SUM(CASE WHEN assigned_at IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
         AVG(CASE WHEN assigned_at IS NOT NULL THEN assigned_at - escalated_at END) AS avg_assign_ms,
         AVG(CASE WHEN first_human_response_at IS NOT NULL THEN first_human_response_at - escalated_at END) AS avg_first_response_ms,
         SUM(CASE WHEN status = 'closed' AND assigned_at IS NULL THEN 1 ELSE 0 END) AS abandoned
       FROM conversations WHERE tenant_id = ? AND escalated_at >= ?`,
      this.tenantId, from,
    ).first<Record<string, number | null>>()
    const total = await this.q("SELECT COUNT(*) AS n, SUM(CASE WHEN escalated_at IS NULL THEN 1 ELSE 0 END) AS ai_only FROM conversations WHERE tenant_id = ? AND started_at >= ? AND (channel IS NULL OR channel <> 'voice')", this.tenantId, from).first<{ n: number; ai_only: number | null }>()
    return {
      conversations: total?.n ?? 0,
      ai_only: Number(total?.ai_only ?? 0),
      escalated: Number(r?.escalated ?? 0),
      assigned: Number(r?.assigned ?? 0),
      abandoned: Number(r?.abandoned ?? 0),
      avg_assign_ms: r?.avg_assign_ms == null ? null : Math.round(r.avg_assign_ms),
      avg_first_response_ms: r?.avg_first_response_ms == null ? null : Math.round(r.avg_first_response_ms),
    }
  }
}
