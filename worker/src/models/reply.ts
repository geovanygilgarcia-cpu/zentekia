/*
  Respuesta completa del agente IA (sin streaming) para canales que no son el widget (WhatsApp).
  Misma lógica que /v1/chat: base de conocimiento, modelo del asistente, respaldo entre modelos hosted
  (o a hosted si falla la API key del cliente y lo permitió), marcas [FINALIZAR] / [HUMANO] y cobro.
*/
import type { Env } from '../env'
import type { TenantRepo } from '../db/tenant-repo'
import { HOSTED_FALLBACKS } from '../db/seed'
import { parseJson, type AgentConfig, type AgentRow, type TenantRow } from '../db/types'
import { recordUsage } from '../billing/meter'
import { retrieve } from '../rag/kb'
import { buildSystem } from './context'
import { estimateTokens, ProviderError, type ChatMessage } from './provider'
import { hostedFallbacksAfter, resolveModel, type Resolved } from './router'
import { EndMarkFilter } from '../routes/widget'

const HISTORY = 16
const MAX_OUTPUT_TOKENS = 700

export interface Reply {
  content: string
  ended: boolean
  handoff: boolean
}

/**
 * Genera la respuesta, la guarda en messages y registra el consumo.
 * El historial ya debe incluir el mensaje del contacto.
 */
export async function generateReply(env: Env, tenant: TenantRow, agent: AgentRow, repo: TenantRepo, convId: string, userText: string, channelHint: string): Promise<Reply & { messageId: string }> {
  const history: ChatMessage[] = (await repo.recentMessages(convId, HISTORY)).map((x) => ({ role: x.role, content: x.content }))
  let kb: Awaited<ReturnType<typeof retrieve>> = []
  try {
    kb = await retrieve(env, repo, agent.id, userText)
  } catch {
    kb = []
  }
  const system = `${buildSystem(tenant, agent, kb)}\n\n${channelHint}`
  const autoEnd = parseJson<AgentConfig>(agent.config_json, {}).auto_end === true

  const st: { full: string; usage: { in: number; out: number } | null; resolved: Resolved | null; ended: boolean; handoff: boolean } = { full: '', usage: null, resolved: null, ended: false, handoff: false }
  const attempt = async (forceHosted: boolean, hostedId?: string) => {
    st.full = ''
    st.usage = null
    const r = await resolveModel(env, repo, tenant, agent, forceHosted, hostedId)
    st.resolved = r
    const filter = new EndMarkFilter()
    for await (const ch of r.provider.stream({ model: r.modelName, system, messages: history, temperature: agent.temperature, maxTokens: MAX_OUTPUT_TOKENS }, r.creds, AbortSignal.timeout(45_000))) {
      if (ch.type === 'delta') {
        if (!filter.ended) st.full += filter.push(ch.text)
      } else st.usage = { in: ch.input_tokens, out: ch.output_tokens }
    }
    st.full += filter.flush()
    st.ended = autoEnd && filter.ended
    st.handoff = filter.handoff
  }
  try {
    await attempt(false)
  } catch (e) {
    // Sin streaming no se mandó nada todavía: se puede reintentar siempre con el respaldo
    const first = st.resolved
    const chain = !first ? [] : first.model.type === 'hosted' ? (e instanceof ProviderError && e.retryable ? hostedFallbacksAfter(first.model.id) : []) : tenant.fallback_to_hosted ? HOSTED_FALLBACKS : []
    if (!chain.length) throw e
    let last: unknown = e
    let ok = false
    for (const id of chain) {
      try {
        await attempt(true, id)
        ok = true
        break
      } catch (e2) {
        last = e2
      }
    }
    if (!ok) throw last
  }
  const r = st.resolved!
  const estimated = !st.usage
  const tin = st.usage ? st.usage.in : estimateTokens(system + history.map((h) => h.content).join(' '))
  const tout = st.usage ? st.usage.out : estimateTokens(st.full)
  const content = st.full.trim() || (st.ended ? 'Gracias por escribirnos. ¡Hasta pronto!' : '…')
  const messageId = crypto.randomUUID()
  await repo.insertMessage({ id: messageId, conversation_id: convId, role: 'assistant', content, tokens_in: tin, tokens_out: tout, model_id: r.model.id, estimated: estimated ? 1 : 0, sources_json: null })
  await recordUsage(env, repo, tenant, { model: r.model, tokensIn: tin, tokensOut: tout, estimated, messageId, conversationId: convId })
  return { content, ended: st.ended, handoff: st.handoff, messageId }
}
