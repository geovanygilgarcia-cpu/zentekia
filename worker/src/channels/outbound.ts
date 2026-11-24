/*
  Envío al contacto por su canal (WhatsApp). Lo usan la IA (channels/process.ts) y la bandeja (inbox/core.ts).
  La llave del BSP se descifra solo aquí y solo para la llamada.
*/
import type { Env } from '../env'
import { decryptForTenant } from '../auth/crypto'
import { ChannelRepo, type ChannelRow } from '../db/channel-repo'
import { PlatformRepo } from '../db/platform-repo'
import { connectorFor, WaError, type WaCreds } from './whatsapp'

export async function channelCreds(env: Env, ch: ChannelRow): Promise<WaCreds> {
  const tenant = await new PlatformRepo(env.DB).tenantById(ch.tenant_id)
  if (!tenant?.data_key_enc) throw new WaError('Falta la llave de cifrado del cliente.', 500)
  const apiKey = await decryptForTenant(env, ch.tenant_id, tenant.data_key_enc, ch.id, ch.api_key_enc)
  return { apiKey, phone: ch.phone, wabaId: ch.waba_id }
}

export async function webhookSecret(env: Env, ch: ChannelRow): Promise<string | null> {
  if (!ch.webhook_secret_enc) return null
  const tenant = await new PlatformRepo(env.DB).tenantById(ch.tenant_id)
  if (!tenant?.data_key_enc) return null
  return decryptForTenant(env, ch.tenant_id, tenant.data_key_enc, `${ch.id}:webhook`, ch.webhook_secret_enc)
}

/** Markdown del modelo → formato de WhatsApp (*negritas*, _cursivas_, ligas en texto) */
export function toWhatsAppText(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => (t.trim() === u.trim() ? u : `${t}: ${u}`))
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .trim()
}

export const windowOpen = (conv: { wa_window_expires_at?: number | null }) => Boolean(conv.wa_window_expires_at && conv.wa_window_expires_at > Date.now())

export interface WaConvRef {
  id: string
  channel?: string | null
  channel_id?: string | null
  visitor_id: string
  contact_phone?: string | null
  wa_window_expires_at?: number | null
}

export const isWhatsApp = (c: { channel?: string | null; channel_id?: string | null }) => c.channel === 'whatsapp' && Boolean(c.channel_id)

/** Número del contacto: visitor_id = "wa:<dígitos>" */
export const contactNumber = (c: WaConvRef) => (c.visitor_id.startsWith('wa:') ? c.visitor_id.slice(3) : c.contact_phone || '')

/**
 * Manda un texto al contacto y marca el mensaje como enviado (o fallido).
 * Lanza WaError si el BSP lo rechaza; el mensaje queda guardado como «fallido».
 */
export async function sendTextToContact(env: Env, tenantId: string, conv: WaConvRef, messageId: string, text: string): Promise<string> {
  const repo = new ChannelRepo(env.DB, tenantId)
  const ch = conv.channel_id ? await repo.get(conv.channel_id) : null
  if (!ch) {
    await repo.markFailed(messageId)
    throw new WaError('El número de WhatsApp de esta conversación ya no está conectado.', 409)
  }
  const conn = connectorFor(ch.provider)!
  try {
    const id = await conn.sendText(env, await channelCreds(env, ch), contactNumber(conv), toWhatsAppText(text))
    await repo.markSent(messageId, id)
    if (ch.status !== 'connected' || ch.last_error) await repo.update(ch.id, { status: 'connected', last_error: null })
    return id
  } catch (e) {
    await repo.markFailed(messageId)
    const msg = e instanceof WaError ? e.message : 'No se pudo enviar por WhatsApp.'
    await repo.update(ch.id, { last_error: msg.slice(0, 300) })
    throw e instanceof WaError ? e : new WaError(msg)
  }
}

export async function sendTemplateToContact(env: Env, tenantId: string, conv: WaConvRef, messageId: string, t: { name: string; language: string; params: string[] }): Promise<string> {
  const repo = new ChannelRepo(env.DB, tenantId)
  const ch = conv.channel_id ? await repo.get(conv.channel_id) : null
  if (!ch) throw new WaError('El número de WhatsApp de esta conversación ya no está conectado.', 409)
  const conn = connectorFor(ch.provider)!
  try {
    const id = await conn.sendTemplate(env, await channelCreds(env, ch), contactNumber(conv), t)
    await repo.markSent(messageId, id)
    return id
  } catch (e) {
    await repo.markFailed(messageId)
    throw e instanceof WaError ? e : new WaError('No se pudo enviar la plantilla.')
  }
}
