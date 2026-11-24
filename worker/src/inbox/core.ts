/*
  Núcleo de la bandeja omnicanal (fase 1: web chat).

  Estados de una conversación:
    ai_active      la atiende el agente IA
    waiting_human  escalada, en cola esperando a una persona
    human_active   la atiende una persona; la IA NO responde (se decide aquí, no en el prompt)
    closed         cerrada

  Toda transición es un UPDATE condicional en D1 (InboxRepo) y después se avisa:
    - a la bandeja del cliente por el InboxHubDO (WebSocket de los agentes; solo ids, sin contenido)
    - al visitante por el ConversationDO (WebSocket del widget)
  La asignación automática corre dentro del InboxHubDO, de una en una por cliente.
*/
import type { Env } from '../env'
import { InboxRepo, type ConvStatus, type InboxConversation } from '../db/inbox-repo'
import { TenantRepo } from '../db/tenant-repo'
import { parseJson, type AgentConfig, type AgentRow, type HandoffConfig, type TenantRow } from '../db/types'
import { analyzeConversation } from '../leads/analyze'

export type EscalationReason = 'ai_tool' | 'keyword' | 'max_turns' | 'manual'

const REASON_LABEL: Record<EscalationReason, string> = {
  ai_tool: 'el asistente pidió a una persona',
  keyword: 'el visitante pidió hablar con una persona',
  max_turns: 'se alcanzó el máximo de respuestas de la IA sin resolver',
  manual: 'escalada a mano',
}

export const DEFAULT_KEYWORDS = ['hablar con una persona', 'hablar con un humano', 'hablar con alguien', 'agente humano', 'persona real', 'con un asesor', 'con un ejecutivo']

export const DEFAULT_TEXTS = {
  waiting: 'Te estoy comunicando con una persona del equipo. En un momento te atienden.',
  assigned: '{agente} se unió a la conversación.',
  handback: 'Te atiende de nuevo el asistente virtual.',
  no_agents_wait: 'En este momento no hay personas disponibles. Déjanos tu mensaje y te responderemos en cuanto sea posible.',
  no_agents_ai: 'En este momento no hay personas disponibles, pero sigo aquí para ayudarte.',
  closed: 'La conversación se cerró. ¡Gracias por escribirnos!',
}

/** Configuración de la bandeja del asistente (vive en Herramientas → Pasar a una persona) */
export interface InboxSettings {
  enabled: boolean
  keywords: string[]
  max_ai_turns: number
  queue_id: string | null
  waiting_message: string
  assigned_message: string
  handback_message: string
  no_agents: 'ai' | 'wait'
  no_agents_message: string
  max_wait_min: number
  email: boolean
}

export function inboxSettings(agent: Pick<AgentRow, 'config_json'>): InboxSettings {
  const h: HandoffConfig = parseJson<AgentConfig>(agent.config_json, {}).tools?.handoff ?? {}
  const policy = h.no_agents === 'ai' ? 'ai' : 'wait'
  return {
    enabled: Boolean(h.enabled) && h.mode === 'inbox',
    keywords: (h.keywords?.length ? h.keywords : DEFAULT_KEYWORDS).map(norm).filter(Boolean),
    max_ai_turns: Math.max(0, Math.min(50, h.max_ai_turns ?? 0)),
    queue_id: h.queue_id || null,
    waiting_message: h.waiting_message?.trim() || DEFAULT_TEXTS.waiting,
    assigned_message: h.assigned_message?.trim() || DEFAULT_TEXTS.assigned,
    handback_message: h.handback_message?.trim() || DEFAULT_TEXTS.handback,
    no_agents: policy,
    no_agents_message: h.no_agents_message?.trim() || (policy === 'ai' ? DEFAULT_TEXTS.no_agents_ai : DEFAULT_TEXTS.no_agents_wait),
    max_wait_min: Math.max(0, Math.min(240, h.max_wait_min ?? 5)),
    email: h.email !== false,
  }
}

/** ¿El Worker tiene los Durable Objects de la bandeja? (sin ellos la bandeja no se puede activar) */
export const inboxReady = (env: Env) => Boolean(env.INBOX_HUB && env.CONVERSATION_DO)

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** ¿El visitante pidió explícitamente a una persona? */
export function asksForHuman(text: string, s: InboxSettings): boolean {
  const t = norm(text)
  return s.keywords.some((k) => k.length >= 3 && t.includes(k))
}

/* ---------- avisos en tiempo real ---------- */

const hubStub = (env: Env, tenantId: string) => (env.INBOX_HUB ? env.INBOX_HUB.get(env.INBOX_HUB.idFromName(tenantId)) : null)
const roomStub = (env: Env, tenantId: string, convId: string) => (env.CONVERSATION_DO ? env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(`${tenantId}:${convId}`)) : null)

async function call(stub: DurableObjectStub | null, path: string, tenantId: string, body: unknown): Promise<Response | null> {
  if (!stub) return null
  try {
    return await stub.fetch(`https://do${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tenant': tenantId }, body: JSON.stringify(body) })
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', msg: 'do_call_failed', path, tenant_id: tenantId, error: e instanceof Error ? e.message : String(e) }))
    return null
  }
}

/** Evento para la bandeja: solo ids y estado; cada agente vuelve a pedir lo que puede ver */
export async function inboxEvent(env: Env, tenantId: string, type: string, data: Record<string, unknown>) {
  await call(hubStub(env, tenantId), '/broadcast', tenantId, { type, ...data, at: Date.now() })
}

/** Evento para el widget del visitante de esa conversación */
export async function visitorEvent(env: Env, tenantId: string, convId: string, data: Record<string, unknown>) {
  await call(roomStub(env, tenantId, convId), '/broadcast', tenantId, data)
}

export interface VisitorMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  sender: 'human' | 'system' | null
  author: string | null
  kind: 'text' | 'notice'
  created_at: number
}

/** Mensaje de sistema que ve el visitante (y la bandeja) */
async function notice(env: Env, inbox: InboxRepo, convId: string, content: string) {
  const m = await inbox.insert({ conversation_id: convId, role: 'system', sender: 'system', author_id: null, kind: 'notice', content })
  const msg: VisitorMessage = { id: m.id, role: 'system', content, sender: 'system', author: null, kind: 'notice', created_at: m.created_at }
  await visitorEvent(env, inbox.tenantId, convId, { type: 'message', message: msg })
}

/** Evento interno del timeline (solo lo ven los agentes) */
async function event(inbox: InboxRepo, convId: string, content: string, authorId: string | null = null) {
  await inbox.insert({ conversation_id: convId, role: 'system', sender: 'system', author_id: authorId, kind: 'event', content })
}

async function statusChanged(env: Env, inbox: InboxRepo, convId: string, status: ConvStatus, extra: Record<string, unknown> = {}) {
  await visitorEvent(env, inbox.tenantId, convId, { type: 'status', status, ...extra })
}

/** Nombre que ve el visitante: solo el nombre de pila (nunca el correo) */
export const publicName = (u: { name: string | null } | null | undefined) => (u?.name?.trim().split(/\s+/)[0] || 'Un agente').slice(0, 40)

async function userLabel(inbox: InboxRepo, userId: string) {
  const u = (await inbox.team()).find((x) => x.id === userId)
  return { u, label: u ? u.name || u.email : 'alguien' }
}

/* ---------- transiciones ---------- */

export interface EscalateResult {
  escalated: boolean
  status: ConvStatus
}

/**
 * IA → humano. Pasa a waiting_human, avisa al visitante y a la bandeja, intenta asignar
 * y aplica la política cuando no hay nadie disponible.
 */
export async function escalate(env: Env, ctx: ExecutionContext, tenant: TenantRow, agent: AgentRow, convId: string, reason: EscalationReason, opts: { portalBase?: string; note?: string } = {}): Promise<EscalateResult> {
  const s = inboxSettings(agent)
  const inbox = new InboxRepo(env.DB, tenant.id)
  if (!s.enabled || !inboxReady(env)) return { escalated: false, status: ((await inbox.conversation(convId))?.status ?? 'ai_active') as ConvStatus }
  if (!(await inbox.escalate(convId, { reason, note: opts.note ?? null, queueId: s.queue_id }))) {
    return { escalated: false, status: ((await inbox.conversation(convId))?.status ?? 'ai_active') as ConvStatus }
  }
  await event(inbox, convId, `Escalada a la bandeja: ${REASON_LABEL[reason]}.`)
  await notice(env, inbox, convId, s.waiting_message)
  await statusChanged(env, inbox, convId, 'waiting_human')
  await inboxEvent(env, tenant.id, 'conversation.escalated', { conversation_id: convId, reason })
  // Resumen y datos capturados para el agente (el análisis existente con IA)
  ctx.waitUntil(analyzeConversation(env, tenant, new TenantRepo(env.DB, tenant.id), convId, { portalBase: opts.portalBase }).then(() => inboxEvent(env, tenant.id, 'conversation.updated', { conversation_id: convId })).catch((e) => console.error('analysis', e)))

  const d = await dispatchVia(env, tenant.id, convId)
  if (d?.assigned) return { escalated: true, status: 'human_active' }
  if (!d?.online && s.no_agents === 'ai') {
    // Nadie conectado y la política dice que siga la IA
    await handbackToAi(env, tenant.id, convId, s.no_agents_message, 'Nadie disponible en la bandeja: la IA continúa.')
    return { escalated: true, status: 'ai_active' }
  }
  if (!d?.online) await notice(env, inbox, convId, s.no_agents_message)
  // Tiempo máximo de espera (alarma del ConversationDO)
  if (s.max_wait_min > 0) await call(roomStub(env, tenant.id, convId), '/timeout', tenant.id, { tenant_id: tenant.id, conversation_id: convId, at: Date.now() + s.max_wait_min * 60_000 })
  return { escalated: true, status: 'waiting_human' }
}

/** Pide al InboxHubDO que reparta (serializado por cliente) */
async function dispatchVia(env: Env, tenantId: string, convId?: string): Promise<{ assigned: string | null; online: number } | null> {
  const r = await call(hubStub(env, tenantId), '/dispatch', tenantId, { conversation_id: convId ?? null })
  if (!r || !r.ok) return null
  return (await r.json()) as { assigned: string | null; online: number }
}
export const requestDispatch = (env: Env, tenantId: string) => dispatchVia(env, tenantId)

/**
 * Reparto automático. SOLO lo llama el InboxHubDO (una ejecución a la vez por cliente).
 * Regla: agente en línea, con capacidad libre y de la cola de la conversación (sin cola = cualquiera);
 * gana el de menos carga y, si empatan, el que lleva más tiempo sin recibir una.
 */
export async function runDispatch(env: Env, tenantId: string, onlyConv: string | null): Promise<{ assigned: string | null; online: number }> {
  const inbox = new InboxRepo(env.DB, tenantId)
  const team = new Set((await inbox.team()).map((u) => u.id))
  const online = (await inbox.presence()).filter((p) => p.status === 'online' && team.has(p.user_id))
  if (!online.length) return { assigned: null, online: 0 }
  const load = new Map((await inbox.loads()).map((l) => [l.user_id, l.n]))
  const members = await inbox.members()
  let list: Array<{ id: string; queue_id: string | null }>
  if (onlyConv) {
    const c = await inbox.conversation(onlyConv)
    list = c && c.status === 'waiting_human' && !c.assignee_user_id ? [{ id: c.id, queue_id: c.queue_id }] : []
  } else list = await inbox.waiting(50)
  let assigned: string | null = null
  for (const conv of list) {
    const cands = online
      .filter((p) => (load.get(p.user_id) ?? 0) < p.max_chats)
      .filter((p) => !conv.queue_id || members.some((m) => m.queue_id === conv.queue_id && m.user_id === p.user_id))
      .sort((a, b) => (load.get(a.user_id) ?? 0) - (load.get(b.user_id) ?? 0) || (a.last_assigned_at ?? 0) - (b.last_assigned_at ?? 0))
    const pick = cands[0]
    if (!pick) continue
    if (await inbox.assign(conv.id, pick.user_id, 'waiting')) {
      load.set(pick.user_id, (load.get(pick.user_id) ?? 0) + 1)
      pick.last_assigned_at = Date.now()
      await afterAssign(env, inbox, conv.id, pick.user_id, null)
      if (conv.id === onlyConv) assigned = pick.user_id
    }
  }
  return { assigned, online: online.length }
}

/** Avisos después de asignar (tomar, autoasignar, reasignar) */
async function afterAssign(env: Env, inbox: InboxRepo, convId: string, userId: string, byUserId: string | null) {
  const { u, label } = await userLabel(inbox, userId)
  const conv = await inbox.conversation(convId)
  const by = byUserId && byUserId !== userId ? (await userLabel(inbox, byUserId)).label : null
  await event(inbox, convId, by ? `${by} asignó la conversación a ${label}.` : byUserId ? `${label} tomó la conversación.` : `Asignada automáticamente a ${label}.`, byUserId)
  const agent = conv ? await new TenantRepo(env.DB, inbox.tenantId).agent(conv.agent_id) : null
  const s = agent ? inboxSettings(agent) : null
  await notice(env, inbox, convId, (s?.assigned_message ?? DEFAULT_TEXTS.assigned).replace(/\{agente\}/g, publicName(u)))
  await statusChanged(env, inbox, convId, 'human_active', { agent_name: publicName(u) })
  await inboxEvent(env, inbox.tenantId, 'conversation.assigned', { conversation_id: convId, user_id: userId })
}

export class InboxError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Un agente toma una conversación en espera. Dos agentes a la vez: solo uno gana. */
export async function take(env: Env, tenantId: string, convId: string, userId: string) {
  const inbox = new InboxRepo(env.DB, tenantId)
  if (!(await inbox.assign(convId, userId, 'waiting'))) throw new InboxError(409, 'taken', 'Otra persona ya tomó esta conversación o ya no está en espera.')
  await afterAssign(env, inbox, convId, userId, userId)
}

/** Supervisor o admin asigna (o reasigna) a una persona concreta */
export async function assignTo(env: Env, tenantId: string, convId: string, userId: string, byUserId: string) {
  const inbox = new InboxRepo(env.DB, tenantId)
  if (!(await inbox.team()).some((u) => u.id === userId)) throw new InboxError(400, 'user', 'Esa persona no pertenece a tu equipo.')
  const before = await inbox.conversation(convId)
  if (before?.status === 'human_active' && before.assignee_user_id === userId) return
  if (!(await inbox.assign(convId, userId, 'any'))) throw new InboxError(409, 'state', 'La conversación ya no está abierta.')
  await afterAssign(env, inbox, convId, userId, byUserId)
}

/** Transferir a otra cola (vuelve a espera y se reparte) */
export async function transferToQueue(env: Env, tenantId: string, convId: string, queueId: string | null, byUserId: string) {
  const inbox = new InboxRepo(env.DB, tenantId)
  const q = queueId ? await inbox.queue(queueId) : null
  if (queueId && !q) throw new InboxError(404, 'not_found', 'Cola no encontrada.')
  if (!(await inbox.requeue(convId, queueId))) throw new InboxError(409, 'state', 'La conversación ya no está abierta.')
  const { label } = await userLabel(inbox, byUserId)
  await event(inbox, convId, `${label} la transfirió a ${q ? `la cola «${q.name}»` : 'la cola general'}.`, byUserId)
  await statusChanged(env, inbox, convId, 'waiting_human')
  await inboxEvent(env, tenantId, 'conversation.transferred', { conversation_id: convId, queue_id: queueId })
  await dispatchVia(env, tenantId, convId)
}

/** Devolver al agente IA */
export async function handbackToAi(env: Env, tenantId: string, convId: string, visitorText: string | null, eventText: string, byUserId: string | null = null) {
  const inbox = new InboxRepo(env.DB, tenantId)
  if (!(await inbox.handback(convId))) throw new InboxError(409, 'state', 'La conversación ya no está con una persona ni en espera.')
  await event(inbox, convId, eventText, byUserId)
  if (visitorText) await notice(env, inbox, convId, visitorText)
  await statusChanged(env, inbox, convId, 'ai_active')
  await call(roomStub(env, tenantId, convId), '/timeout', tenantId, { cancel: true })
  await inboxEvent(env, tenantId, 'conversation.handback', { conversation_id: convId })
}

export async function handbackByUser(env: Env, tenantId: string, conv: InboxConversation, byUserId: string) {
  const agent = await new TenantRepo(env.DB, tenantId).agent(conv.agent_id)
  const s = agent ? inboxSettings(agent) : null
  const { label } = await userLabel(new InboxRepo(env.DB, tenantId), byUserId)
  await handbackToAi(env, tenantId, conv.id, s?.handback_message ?? DEFAULT_TEXTS.handback, `${label} devolvió la conversación al asistente IA.`, byUserId)
}

/** Cerrar desde la bandeja */
export async function closeByUser(env: Env, ctx: ExecutionContext, tenant: TenantRow, convId: string, byUserId: string, portalBase?: string) {
  const inbox = new InboxRepo(env.DB, tenant.id)
  if (!(await inbox.close(convId, 'human'))) throw new InboxError(409, 'state', 'La conversación ya estaba cerrada.')
  const { label } = await userLabel(inbox, byUserId)
  await event(inbox, convId, `${label} cerró la conversación.`, byUserId)
  await visitorEvent(env, tenant.id, convId, { type: 'ended' })
  await call(roomStub(env, tenant.id, convId), '/timeout', tenant.id, { cancel: true })
  await inboxEvent(env, tenant.id, 'conversation.closed', { conversation_id: convId })
  ctx.waitUntil(analyzeConversation(env, tenant, new TenantRepo(env.DB, tenant.id), convId, { portalBase }).catch((e) => console.error('analysis', e)))
}

/** La conversación se cerró por la ruta del widget (visitante o herramienta finalizar) */
export async function closedElsewhere(env: Env, tenantId: string, convId: string) {
  const inbox = new InboxRepo(env.DB, tenantId)
  const before = await inbox.conversation(convId)
  await inbox.markClosed(convId)
  if (before && (before.status === 'waiting_human' || before.status === 'human_active')) {
    await event(inbox, convId, before.ended_by === 'visitor' || !before.ended_by ? 'El visitante cerró la conversación.' : 'La conversación se cerró.')
    await call(roomStub(env, tenantId, convId), '/timeout', tenantId, { cancel: true })
    await inboxEvent(env, tenantId, 'conversation.closed', { conversation_id: convId })
  }
}

/** Respuesta de una persona: solo quien la tiene asignada */
export async function humanReply(env: Env, tenantId: string, convId: string, user: { id: string; name: string | null }, text: string) {
  const inbox = new InboxRepo(env.DB, tenantId)
  const conv = await inbox.conversation(convId)
  if (!conv || conv.status !== 'human_active' || conv.assignee_user_id !== user.id) throw new InboxError(409, 'not_yours', 'Toma la conversación antes de responder.')
  const m = await inbox.insert({ conversation_id: convId, role: 'assistant', sender: 'human', author_id: user.id, kind: 'text', content: text })
  await inbox.markFirstHumanResponse(convId)
  const msg: VisitorMessage = { id: m.id, role: 'assistant', content: text, sender: 'human', author: publicName(user), kind: 'text', created_at: m.created_at }
  await visitorEvent(env, tenantId, convId, { type: 'message', message: msg })
  await inboxEvent(env, tenantId, 'message.created', { conversation_id: convId, message_id: m.id })
  return m
}

/** Nota interna: nunca llega al visitante */
export async function addNote(env: Env, tenantId: string, convId: string, userId: string, text: string) {
  const inbox = new InboxRepo(env.DB, tenantId)
  const m = await inbox.insert({ conversation_id: convId, role: 'system', sender: 'human', author_id: userId, kind: 'note', content: text })
  await inboxEvent(env, tenantId, 'message.created', { conversation_id: convId, message_id: m.id })
  return m
}

/** Se cumplió el tiempo máximo en espera (alarma del ConversationDO) */
export async function onWaitTimeout(env: Env, tenantId: string, convId: string) {
  const inbox = new InboxRepo(env.DB, tenantId)
  const conv = await inbox.conversation(convId)
  if (!conv || conv.status !== 'waiting_human') return
  const agent = await new TenantRepo(env.DB, tenantId).agent(conv.agent_id)
  const s = agent ? inboxSettings(agent) : null
  if (s?.no_agents === 'ai') {
    await handbackToAi(env, tenantId, convId, s.no_agents_message, 'Se agotó el tiempo de espera: la IA continúa.').catch(() => {})
  } else {
    await event(inbox, convId, 'Se agotó el tiempo máximo de espera; el visitante sigue en la cola.')
    await notice(env, inbox, convId, s?.no_agents_message ?? DEFAULT_TEXTS.no_agents_wait)
    await inboxEvent(env, tenantId, 'conversation.updated', { conversation_id: convId })
  }
}

/** Un agente se desconectó (sin volver en el tiempo de gracia): sus conversaciones vuelven a la cola */
export async function onAgentGone(env: Env, tenantId: string, userId: string) {
  const inbox = new InboxRepo(env.DB, tenantId)
  await inbox.setPresence(userId, { status: 'offline' })
  const { label } = await userLabel(inbox, userId)
  for (const id of await inbox.activeOf(userId)) {
    if (await inbox.requeue(id, undefined, userId)) {
      await event(inbox, id, `${label} se desconectó: la conversación volvió a la cola.`)
      await statusChanged(env, inbox, id, 'waiting_human')
    }
  }
  await inboxEvent(env, tenantId, 'presence.changed', { user_id: userId, status: 'offline' })
}

/** Cuántas respuestas dio la IA desde el último escalamiento (disparador de máximo de turnos) */
export async function aiTurnsSinceEscalation(db: D1Database, tenantId: string, conv: { id: string; escalated_at?: number | null }) {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND conversation_id = ? AND role = 'assistant' AND sender IS NULL AND created_at > ?")
    .bind(tenantId, conv.id, conv.escalated_at ?? 0)
    .first<{ n: number }>()
  return r?.n ?? 0
}
