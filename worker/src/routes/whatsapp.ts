/*
  Portal · canal de WhatsApp de un asistente (fase 2 omnicanal)
    GET    whatsapp/:agentId              estado del canal (sin llaves) y proveedores disponibles
    POST   whatsapp/:agentId/numbers      { provider, api_key } → valida la llave y lista los números que puede usar
    POST   whatsapp/:agentId              { provider, api_key, phone } → conecta: registra el webhook y guarda todo cifrado
    POST   whatsapp/:agentId/refresh      vuelve a leer calidad y estado del número
    DELETE whatsapp/:agentId              desconecta (quita el webhook si el BSP lo permite)

  Por ahora el alta es con la API key del BSP (onboarding del propio 360dialog o YCloud, como pide el spec 8.1);
  el Embedded Signup propio queda para cuando el flujo esté estable.
*/
import { z } from 'zod'
import type { Env } from '../env'
import { encryptForTenant } from '../auth/crypto'
import { guard, loadSession } from '../auth/session'
import { ChannelRepo, publicChannel } from '../db/channel-repo'
import { PlatformRepo } from '../db/platform-repo'
import { TenantRepo } from '../db/tenant-repo'
import { parseJson, type AgentConfig, type TenantRow } from '../db/types'
import { chatOrigin } from '../lib/hosts'
import { clientIp, fail, json, randomToken, readJson } from '../lib/http'
import { match } from '../lib/router'
import { channelCreds } from '../channels/outbound'
import { connectorFor, digits, WA_PROVIDERS, WaError, type WaProvider } from '../channels/whatsapp'

const PROVIDERS = [
  { id: '360dialog', name: '360dialog', key_hint: 'API key del número (360dialog Hub → tu número → API key)', signup: 'https://hub.360dialog.com/' },
  { id: 'ycloud', name: 'YCloud', key_hint: 'API key de tu cuenta (YCloud → Developers → API keys)', signup: 'https://www.ycloud.com/' },
]

export async function whatsappRoutes(env: Env, request: Request, url: URL, tenant: TenantRow, sub: string): Promise<Response> {
  const auth = await loadSession(env, request, 'portal', tenant)
  const m = request.method
  const repo = new TenantRepo(env.DB, tenant.id)
  const channels = new ChannelRepo(env.DB, tenant.id)
  const platform = new PlatformRepo(env.DB)
  const audit = (action: string, detail?: unknown) =>
    platform.audit({ actor_id: auth!.user.id, actor_email: auth!.session.impersonator_id ? `soporte:${auth!.user.email}` : auth!.user.email, tenant_id: tenant.id, action, detail, ip: clientIp(request) })
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof WaError) fail(e.status === 400 ? 400 : 502, 'provider', e.message)
      throw e
    }
  }
  const agentOf = async (id: string) => {
    const a = await repo.agent(id)
    if (!a) fail(404, 'not_found', 'Asistente no encontrado.')
    if (parseJson<AgentConfig>(a!.config_json, {}).kind === 'guide') fail(403, 'guide_locked', 'La Guía Zentekia no se puede conectar a WhatsApp.')
    return a!
  }
  const keySchema = z.object({ provider: z.enum(WA_PROVIDERS as [WaProvider, ...WaProvider[]]), api_key: z.string().trim().min(8).max(400) })
  let p: Record<string, string> | null

  if ((p = match(':agentId', sub)) && m === 'GET') {
    guard(request, env, auth, { roles: ['owner', 'editor'] })
    await agentOf(p.agentId!)
    const ch = await channels.forAgent(p.agentId!)
    return json({ channel: ch ? publicChannel(ch) : null, providers: PROVIDERS, inbox_hint: true })
  }

  if ((p = match(':agentId/numbers', sub)) && m === 'POST') {
    guard(request, env, auth, { roles: ['owner'] })
    await agentOf(p.agentId!)
    const b = await readJson(request, keySchema)
    const nums = await wrap(() => connectorFor(b.provider)!.numbers(env, b.api_key))
    if (!nums.length) fail(400, 'no_numbers', 'La llave es válida, pero no tiene números de WhatsApp activos.')
    return json({ numbers: nums.map((n) => ({ phone: n.phone, display: n.display, verified_name: n.verifiedName, quality: n.quality, status: n.status })) })
  }

  if ((p = match(':agentId', sub)) && m === 'POST') {
    guard(request, env, auth, { roles: ['owner'] })
    const agent = await agentOf(p.agentId!)
    if (!tenant.data_key_enc) fail(500, 'no_data_key', 'Falta la llave de cifrado del cliente.')
    const b = await readJson(request, keySchema.extend({ phone: z.string().trim().max(30).optional() }))
    if (await channels.forAgent(agent.id)) fail(400, 'exists', 'Este asistente ya tiene un número conectado. Desconéctalo primero.')
    const conn = connectorFor(b.provider)!
    const nums = await wrap(() => conn.numbers(env, b.api_key))
    const want = digits(b.phone)
    const num = want ? nums.find((n) => n.phone === want) : nums.length === 1 ? nums[0] : null
    if (!num) fail(400, 'phone', want ? 'Ese número no está en la cuenta de esa API key.' : 'Elige cuál de los números de la cuenta quieres conectar.')
    if (await channels.phoneTaken(num!.phone)) fail(400, 'phone_taken', 'Ese número ya está conectado a otro asistente.')

    const id = crypto.randomUUID()
    const hookUrl = `${chatOrigin(env, url)}/v1/wa/${b.provider}/${id}`
    const creds = { apiKey: b.api_key, phone: num!.phone, wabaId: num!.wabaId }
    const hook = await wrap(() => conn.registerWebhook(env, creds, hookUrl, randomToken(32)))
    try {
      await channels.insert({
        id,
        agent_id: agent.id,
        provider: b.provider,
        phone: num!.phone,
        display_phone: num!.display || `+${num!.phone}`,
        external_id: num!.externalId,
        waba_id: num!.wabaId,
        verified_name: num!.verifiedName,
        quality_rating: num!.quality,
        api_key_enc: await encryptForTenant(env, tenant.id, tenant.data_key_enc!, id, b.api_key),
        last4: b.api_key.slice(-4),
        webhook_secret_enc: await encryptForTenant(env, tenant.id, tenant.data_key_enc!, `${id}:webhook`, hook.secret),
        webhook_id: hook.webhookId,
      })
    } catch (e) {
      // No se guardó: se quita el webhook que ya se había creado
      await conn.unregisterWebhook(env, creds, hook.webhookId).catch(() => {})
      if (String(e).includes('UNIQUE')) fail(400, 'phone_taken', 'Ese número ya está conectado a otro asistente.')
      throw e
    }
    await audit('whatsapp.connected', { agent_id: agent.id, provider: b.provider, phone: num!.phone, last4: b.api_key.slice(-4) })
    return json({ channel: publicChannel((await channels.get(id))!) })
  }

  if ((p = match(':agentId/refresh', sub)) && m === 'POST') {
    guard(request, env, auth, { roles: ['owner', 'editor'] })
    await agentOf(p.agentId!)
    const ch = await channels.forAgent(p.agentId!)
    if (!ch) fail(404, 'not_found', 'Este asistente no tiene WhatsApp conectado.')
    const creds = await channelCreds(env, ch!)
    try {
      const n = (await connectorFor(ch!.provider)!.numbers(env, creds.apiKey)).find((x) => x.phone === ch!.phone)
      if (!n) {
        await channels.update(ch!.id, { status: 'error', last_error: 'El número ya no aparece en la cuenta del proveedor.' })
      } else {
        await channels.update(ch!.id, { status: 'connected', last_error: null, quality_rating: n.quality, verified_name: n.verifiedName, display_phone: n.display || ch!.display_phone })
      }
    } catch (e) {
      await channels.update(ch!.id, { status: 'error', last_error: (e instanceof WaError ? e.message : 'No se pudo consultar al proveedor.').slice(0, 300) })
    }
    return json({ channel: publicChannel((await channels.get(ch!.id))!) })
  }

  if ((p = match(':agentId', sub)) && m === 'DELETE') {
    guard(request, env, auth, { roles: ['owner'] })
    await agentOf(p.agentId!)
    const ch = await channels.forAgent(p.agentId!)
    if (!ch) fail(404, 'not_found', 'Este asistente no tiene WhatsApp conectado.')
    await connectorFor(ch!.provider)!.unregisterWebhook(env, await channelCreds(env, ch!), ch!.webhook_id).catch(() => {})
    await channels.remove(ch!.id)
    await audit('whatsapp.disconnected', { agent_id: ch!.agent_id, provider: ch!.provider, phone: ch!.phone })
    return json({ ok: true })
  }

  return fail(404, 'not_found', 'Ruta no encontrada.')
}
