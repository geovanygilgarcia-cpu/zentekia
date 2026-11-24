/*
  Canales de WhatsApp (fase 2 omnicanal) de UN cliente.
  Igual que TenantRepo: toda consulta lleva "tenant_id = ?" con el id fijado al construirlo.
  La única consulta sin tenant es channelById (el webhook del BSP llega con el id del canal en la URL,
  como la widget_key del widget); de ahí sale el tenant y todo lo demás se hace con ChannelRepo.
*/
import type { InboxConversation } from './inbox-repo'

export interface ChannelRow {
  id: string
  tenant_id: string
  agent_id: string
  type: 'whatsapp'
  provider: '360dialog' | 'ycloud'
  status: 'connected' | 'error'
  phone: string
  display_phone: string | null
  external_id: string | null
  waba_id: string | null
  verified_name: string | null
  quality_rating: string | null
  api_key_enc: string
  last4: string
  webhook_secret_enc: string | null
  webhook_id: string | null
  last_error: string | null
  last_inbound_at: number | null
  created_at: number
  updated_at: number
}

/** Lo que puede ver el portal (nunca la llave ni el secreto) */
export const publicChannel = (c: ChannelRow) => ({
  id: c.id,
  agent_id: c.agent_id,
  provider: c.provider,
  status: c.status,
  phone: c.phone,
  display_phone: c.display_phone,
  verified_name: c.verified_name,
  quality_rating: c.quality_rating,
  last4: c.last4,
  last_error: c.last_error,
  last_inbound_at: c.last_inbound_at,
  created_at: c.created_at,
})

export const channelById = (db: D1Database, id: string) => db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>()

export type Delivery = 'sent' | 'delivered' | 'read' | 'failed'
const RANK: Record<Delivery, number> = { sent: 1, delivered: 2, read: 3, failed: 0 }

export class ChannelRepo {
  constructor(
    private db: D1Database,
    readonly tenantId: string,
  ) {
    if (!tenantId) throw new Error('ChannelRepo requiere tenantId')
  }

  private q(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).bind(...params)
  }

  list() {
    return this.q('SELECT * FROM channels WHERE tenant_id = ? ORDER BY created_at', this.tenantId).all<ChannelRow>().then((r) => r.results)
  }
  get(id: string) {
    return this.q('SELECT * FROM channels WHERE tenant_id = ? AND id = ?', this.tenantId, id).first<ChannelRow>()
  }
  forAgent(agentId: string) {
    return this.q("SELECT * FROM channels WHERE tenant_id = ? AND agent_id = ? AND type = 'whatsapp'", this.tenantId, agentId).first<ChannelRow>()
  }
  /** ¿El número ya está conectado (en este u otro cliente)? */
  async phoneTaken(phone: string): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 AS x FROM channels WHERE type = 'whatsapp' AND phone = ?").bind(phone).first())
  }
  async insert(c: Omit<ChannelRow, 'tenant_id' | 'created_at' | 'updated_at' | 'last_error' | 'last_inbound_at' | 'status' | 'type'>) {
    const t = Date.now()
    await this.q(
      `INSERT INTO channels (id, tenant_id, agent_id, type, provider, status, phone, display_phone, external_id, waba_id, verified_name, quality_rating, api_key_enc, last4, webhook_secret_enc, webhook_id, created_at, updated_at)
       VALUES (?, ?, ?, 'whatsapp', ?, 'connected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id, this.tenantId, c.agent_id, c.provider, c.phone, c.display_phone, c.external_id, c.waba_id, c.verified_name, c.quality_rating, c.api_key_enc, c.last4, c.webhook_secret_enc, c.webhook_id, t, t,
    ).run()
  }
  async update(id: string, f: Partial<Pick<ChannelRow, 'status' | 'last_error' | 'quality_rating' | 'verified_name' | 'display_phone' | 'last_inbound_at'>>) {
    const keys = (['status', 'last_error', 'quality_rating', 'verified_name', 'display_phone', 'last_inbound_at'] as const).filter((k) => f[k] !== undefined)
    if (!keys.length) return
    await this.q(`UPDATE channels SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE tenant_id = ? AND id = ?`, ...keys.map((k) => f[k]), Date.now(), this.tenantId, id).run()
  }
  async remove(id: string) {
    await this.q('DELETE FROM channels WHERE tenant_id = ? AND id = ?', this.tenantId, id).run()
  }

  /* ---------- conversaciones del canal ---------- */
  /** Conversación abierta de ese contacto en ese número (una por contacto y canal) */
  openConversation(channelId: string, visitorId: string) {
    return this.q(
      'SELECT * FROM conversations WHERE tenant_id = ? AND channel_id = ? AND visitor_id = ? AND ended_at IS NULL ORDER BY last_message_at DESC LIMIT 1',
      this.tenantId, channelId, visitorId,
    ).first<InboxConversation & { channel_id: string | null; wa_window_expires_at: number | null }>()
  }
  async attach(convId: string, channelId: string, contact: { phone: string; name: string | null }) {
    await this.q('UPDATE conversations SET channel_id = ?, contact_phone = COALESCE(contact_phone, ?), contact_name = COALESCE(contact_name, ?) WHERE tenant_id = ? AND id = ?', channelId, contact.phone, contact.name, this.tenantId, convId).run()
  }
  /** Cada mensaje del cliente renueva la ventana de 24 h (nunca la acorta: los eventos pueden llegar desordenados) */
  async renewWindow(convId: string, until: number) {
    await this.q('UPDATE conversations SET wa_window_expires_at = MAX(COALESCE(wa_window_expires_at, 0), ?) WHERE tenant_id = ? AND id = ?', until, this.tenantId, convId).run()
  }

  /* ---------- mensajes ---------- */
  /**
   * Mensaje entrante con deduplicación por id de WhatsApp: si el BSP reintenta, no se inserta otra vez.
   * Devuelve false si ya existía.
   */
  async insertInbound(m: { id: string; conversation_id: string; content: string; channel_message_id: string; created_at: number; media_json: string | null }): Promise<boolean> {
    const r = await this.q(
      "INSERT OR IGNORE INTO messages (id, tenant_id, conversation_id, role, content, tokens_in, tokens_out, model_id, estimated, sources_json, created_at, sender, author_id, kind, channel_message_id, media_json) VALUES (?, ?, ?, 'user', ?, 0, 0, NULL, 0, NULL, ?, NULL, NULL, 'text', ?, ?)",
      m.id, this.tenantId, m.conversation_id, m.content, m.created_at, m.channel_message_id, m.media_json,
    ).run()
    if (r.meta.changes === 0) return false
    const title = m.content.replace(/\s+/g, ' ').trim().slice(0, 80)
    await this.q(
      'UPDATE conversations SET last_message_at = MAX(last_message_at, ?), message_count = message_count + 1, title = COALESCE(title, ?) WHERE tenant_id = ? AND id = ?',
      m.created_at, title, this.tenantId, m.conversation_id,
    ).run()
    return true
  }
  async markSent(messageId: string, channelMessageId: string) {
    await this.q("UPDATE messages SET channel_message_id = ?, delivery_status = 'sent' WHERE tenant_id = ? AND id = ?", channelMessageId, this.tenantId, messageId).run()
  }
  async markFailed(messageId: string) {
    await this.q("UPDATE messages SET delivery_status = 'failed' WHERE tenant_id = ? AND id = ?", this.tenantId, messageId).run()
  }
  /** Estado de entrega: solo avanza (enviado → entregado → leído); «fallido» solo si no se había entregado */
  async updateDelivery(ids: string[], status: Delivery): Promise<{ id: string; conversation_id: string } | null> {
    for (const cid of ids.filter(Boolean)) {
      const m = await this.q('SELECT id, conversation_id, delivery_status FROM messages WHERE tenant_id = ? AND channel_message_id = ?', this.tenantId, cid).first<{ id: string; conversation_id: string; delivery_status: Delivery | null }>()
      if (!m) continue
      const cur = m.delivery_status
      const advance = status === 'failed' ? !cur || cur === 'sent' : !cur || cur === 'failed' || RANK[status] > RANK[cur]
      if (advance) await this.q('UPDATE messages SET delivery_status = ? WHERE tenant_id = ? AND id = ?', status, this.tenantId, m.id).run()
      return { id: m.id, conversation_id: m.conversation_id }
    }
    return null
  }
  async setMedia(messageId: string, media: Record<string, unknown>) {
    await this.q('UPDATE messages SET media_json = ? WHERE tenant_id = ? AND id = ?', JSON.stringify(media), this.tenantId, messageId).run()
  }
  message(convId: string, messageId: string) {
    return this.q('SELECT id, media_json FROM messages WHERE tenant_id = ? AND conversation_id = ? AND id = ?', this.tenantId, convId, messageId).first<{ id: string; media_json: string | null }>()
  }
}
