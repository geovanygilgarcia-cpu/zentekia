/*
  Herramientas opcionales del asistente (portal → Herramientas).
  Los modelos que usamos no tienen "function calling" en común, así que cada herramienta es:
    - una sección en el prompt que le dice al agente cuándo y cómo usarla, y
    - si hace falta una acción del servidor, una marca que el agente escribe al final ([HUMANO])
      y que el Worker quita antes de mostrarle el mensaje al visitante.
*/
import type { Env } from '../env'
import type { TenantRepo } from '../db/tenant-repo'
import { leadsEnabled, parseJson, type AgentConfig, type AgentRow, type ConversationRow, type TenantRow, type ToolsConfig, type WebhookEvent } from '../db/types'
import { sendEmail } from '../lib/email'
import { sendWebhook } from './webhook'

export const HANDOFF_MARK = '[HUMANO]'

export interface ToolInfo {
  id: keyof ToolsConfig | 'end_chat'
  name: string
  description: string
}

/** Catálogo (lo usa el Guía para recomendar herramientas al crear un asistente) */
export const TOOL_CATALOG: ToolInfo[] = [
  { id: 'leads', name: 'Prospectos', description: 'Pide nombre, teléfono o correo cuando hay interés, califica la conversación (caliente, tibio, frío) y avisa por correo.' },
  { id: 'end_chat', name: 'Finalizar conversación', description: 'El asistente cierra el chat cuando ya terminó y le pide al visitante calificar la atención.' },
  { id: 'handoff', name: 'Pasar a una persona', description: 'Cuando el visitante pide hablar con alguien o el caso lo rebasa, avisa al equipo con la liga de la conversación.' },
  { id: 'booking', name: 'Agendar citas', description: 'Comparte la liga de tu calendario (Calendly, Cal.com, Google Calendar) para que el visitante elija horario.' },
  { id: 'whatsapp', name: 'Continuar por WhatsApp', description: 'Ofrece seguir la plática por WhatsApp con una liga que abre el chat con tu número.' },
  { id: 'links', name: 'Enlaces útiles', description: 'Catálogo, lista de precios, ubicación en mapas, formulario… el asistente los comparte cuando vienen al caso.' },
  { id: 'webhook', name: 'Webhook', description: 'Manda cada conversación analizada, prospecto o solicitud de persona a tu CRM, Zapier, Make o n8n.' },
]

export function toolsOf(agent: Pick<AgentRow, 'config_json'>): ToolsConfig {
  return parseJson<AgentConfig>(agent.config_json, {}).tools ?? {}
}

export const waLink = (number: string, message?: string) =>
  `https://wa.me/${number.replace(/\D/g, '')}${message?.trim() ? `?text=${encodeURIComponent(message.trim())}` : ''}`

/** Secciones de prompt de las herramientas activas (chat de texto) */
export function toolPrompts(cfg: AgentConfig): string[] {
  const t = cfg.tools ?? {}
  const out: string[] = []
  if (t.handoff?.enabled) {
    const cuando = t.handoff.when?.trim() || 'cuando el visitante pida hablar con una persona, esté molesto, o su caso necesite a alguien del equipo (quejas, casos especiales, algo que no puedes resolver).'
    const msg = t.handoff.message?.trim() || 'Le paso tu caso a una persona del equipo para que te dé seguimiento.'
    out.push(`[HERRAMIENTA: PASAR A UNA PERSONA]
Puedes avisar al equipo para que una persona tome la conversación. Úsala ${cuando}
- Antes, pide un nombre y un medio de contacto (teléfono o correo) si todavía no los tienes, para que puedan buscarlo.
- Dile algo como: "${msg.replace(/"/g, "'")}"
- Para usarla, termina tu mensaje exactamente con ${HANDOFF_MARK} (en una línea aparte). El visitante no verá esa marca.
- Úsala una sola vez por conversación, no prometas tiempos de respuesta que no conoces y nunca menciones la marca.`)
  }
  if (t.booking?.enabled && t.booking.url) {
    out.push(`[HERRAMIENTA: AGENDAR CITAS]
El visitante puede elegir día y hora en esta liga: ${t.booking.url}
Compártela ${t.booking.when?.trim() || 'cuando quiera agendar una cita, una visita, una llamada o una demo.'}
- Escríbela completa tal cual. No confirmes horarios tú: la cita queda agendada cuando el visitante la reserva en la liga.`)
  }
  if (t.whatsapp?.enabled && t.whatsapp.number) {
    out.push(`[HERRAMIENTA: CONTINUAR POR WHATSAPP]
Si el visitante prefiere WhatsApp o quiere seguir la plática por ahí, comparte esta liga completa: ${waLink(t.whatsapp.number, t.whatsapp.message)}`)
  }
  const links = (t.links?.enabled ? t.links.items ?? [] : []).filter((l) => l.label && l.url)
  if (links.length) {
    out.push(`[ENLACES ÚTILES]
Puedes compartir estas ligas cuando vengan al caso (escríbelas completas, sin inventar otras):
${links.map((l) => `- ${l.label}: ${l.url}`).join('\n')}`)
  }
  return out
}

/** Las mismas herramientas, para la llamada de voz (sin ligas largas ni marcas) */
export function voiceToolPrompts(cfg: AgentConfig): string[] {
  const t = cfg.tools ?? {}
  const out: string[] = []
  if (t.booking?.enabled && t.booking.url) out.push('Si quieren agendar una cita, diles que les puedes mandar la liga del calendario por chat o WhatsApp; no confirmes horarios por teléfono.')
  if (t.whatsapp?.enabled && t.whatsapp.number) out.push(`Si prefieren WhatsApp, el número es ${t.whatsapp.number.replace(/\D/g, '')}.`)
  if (t.handoff?.enabled) out.push('Si piden hablar con una persona, toma su nombre y teléfono y diles que alguien del equipo los contactará.')
  return out
}

/** El agente pidió pasar la conversación a una persona: alerta en el portal, correo y webhook */
export async function onHandoff(env: Env, tenant: TenantRow, repo: TenantRepo, agent: AgentRow, convId: string, portalBase: string) {
  const t = toolsOf(agent).handoff
  if (!t?.enabled) return
  const link = `${portalBase}#/a/${agent.id}/conversaciones/${convId}`
  const isNew = await repo.addAlert('handoff', convId, `«${agent.name}» pidió que una persona atienda una conversación. Ábrela en Conversaciones.`)
  if (!isNew) return // una sola vez por conversación
  const msgs = await repo.messages(convId, 40)
  const last = msgs.filter((m) => m.role === 'user').slice(-3).map((m) => `  «${m.content.replace(/\s+/g, ' ').slice(0, 200)}»`)
  if (t.email !== false) {
    const owners = await repo.ownerEmails()
    if (owners.length)
      await sendEmail(env, owners, `Un visitante necesita a una persona · ${agent.name}`, [`El asistente «${agent.name}» pasó una conversación a tu equipo.`, '', 'Lo último que escribió el visitante:', ...last, '', `Ver la conversación: ${link}`].join('\n'))
  }
  await fireEvent(env, tenant, repo, agent, 'handoff.requested', { conversation_id: convId, portal_url: link, last_messages: msgs.slice(-6).map((m) => ({ role: m.role, content: m.content })) })
}

/** Manda un evento al webhook del asistente si está activo y suscrito; guarda el último resultado */
export async function fireEvent(env: Env, tenant: TenantRow, repo: TenantRepo, agent: AgentRow, event: WebhookEvent, data: Record<string, unknown>) {
  const cfg = parseJson<AgentConfig>(agent.config_json, {})
  const wh = cfg.tools?.webhook
  if (!wh?.enabled || !wh.url || !wh.secret) return
  if (wh.events?.length && !wh.events.includes(event)) return
  if (event === 'lead.detected' && !leadsEnabled(cfg)) return
  const r = await sendWebhook(wh.url, wh.secret, { event, tenant: tenant.slug, agent: { id: agent.id, name: agent.name }, data })
  // Se vuelve a leer para no pisar cambios hechos mientras tanto
  const fresh = await repo.agent(agent.id)
  if (!fresh) return
  const c2 = parseJson<AgentConfig>(fresh.config_json, {})
  if (c2.tools?.webhook) {
    c2.tools.webhook = { ...c2.tools.webhook, last_status: r.status, last_at: Date.now(), last_error: r.error }
    await repo.updateAgent(agent.id, { config_json: JSON.stringify(c2) })
  }
}

/** Datos de la conversación que van en los eventos */
export function conversationPayload(conv: ConversationRow, a: { summary: string | null; lead_status: string; lead_score: number; interest: string | null; next_step: string | null; contact_name: string | null; contact_email: string | null; contact_phone: string | null; contact_company: string | null }, link: string) {
  return {
    conversation_id: conv.id,
    channel: conv.channel ?? 'chat',
    started_at: conv.started_at,
    last_message_at: conv.last_message_at,
    ended_at: conv.ended_at,
    origin: conv.origin,
    country: conv.country,
    summary: a.summary,
    lead: { status: a.lead_status, score: a.lead_score, interest: a.interest, next_step: a.next_step },
    contact: { name: a.contact_name, email: a.contact_email, phone: a.contact_phone, company: a.contact_company },
    portal_url: link,
  }
}
