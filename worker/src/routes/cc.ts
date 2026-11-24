/*
  Contact Center · canales de entrada (chat web y WhatsApp que van directo a la cola de personas, sin IA)
    GET  cc/channels          canales «solo personas» con su widget y su WhatsApp
    POST cc/channels          { name, welcome_message? } → crea un chat web nuevo
    PUT  cc/channels/:id      { name?, welcome_message? }
  Por dentro cada canal es un «asistente» con config.mode = 'human': así reutiliza el widget, la instalación,
  la conexión de WhatsApp, los webhooks y la bandeja sin código aparte. La IA nunca contesta en ellos.
*/
import { z } from 'zod'
import type { Env } from '../env'
import { guard, loadSession } from '../auth/session'
import { ChannelRepo, publicChannel } from '../db/channel-repo'
import { PlatformRepo } from '../db/platform-repo'
import { TenantRepo } from '../db/tenant-repo'
import { HOSTED_DEFAULT_MODEL } from '../db/seed'
import { parseJson, type AgentConfig, type TenantRow } from '../db/types'
import { chatOrigin } from '../lib/hosts'
import { clientIp, fail, json, readJson } from '../lib/http'
import { newWidgetKey } from '../lib/provision'
import { productsOf } from '../lib/products'
import { match } from '../lib/router'
import { DEFAULT_THEME } from '../widget-theme'

const MAX_CHANNELS = 20

export async function ccRoutes(env: Env, request: Request, url: URL, tenant: TenantRow, sub: string): Promise<Response> {
  const auth = await loadSession(env, request, 'portal', tenant)
  const m = request.method
  if (!auth) fail(401, 'unauthenticated', 'Tu sesión terminó. Vuelve a entrar.')
  if (!productsOf(tenant).cc) fail(403, 'no_product', 'Tu cuenta no tiene el Contact Center. Pídelo a Zentekia.')
  const repo = new TenantRepo(env.DB, tenant.id)
  const platform = new PlatformRepo(env.DB)
  const audit = (action: string, detail?: unknown) =>
    platform.audit({ actor_id: auth!.user.id, actor_email: auth!.session.impersonator_id ? `soporte:${auth!.user.email}` : auth!.user.email, tenant_id: tenant.id, action, detail, ip: clientIp(request) })
  const humanAgents = async () => (await repo.listAgents()).filter((a) => parseJson<AgentConfig>(a.config_json, {}).mode === 'human')
  let p: Record<string, string> | null

  if (sub === 'channels' && m === 'GET') {
    guard(request, env, auth, { roles: ['owner', 'editor', 'supervisor'] })
    const [agents, widgets, wa] = await Promise.all([humanAgents(), repo.widgets(), new ChannelRepo(env.DB, tenant.id).list()])
    return json({
      chat_origin: chatOrigin(env, url),
      items: agents.map((a) => {
        const w = widgets.find((x) => x.agent_id === a.id)
        const c = wa.find((x) => x.agent_id === a.id)
        return { id: a.id, name: a.name, welcome_message: a.welcome_message, widget_key: w?.widget_key ?? null, whatsapp: c ? publicChannel(c) : null, created_at: a.created_at }
      }),
    })
  }

  if (sub === 'channels' && m === 'POST') {
    guard(request, env, auth, { roles: ['owner', 'editor'] })
    const b = await readJson(request, z.object({ name: z.string().trim().min(1).max(80), welcome_message: z.string().trim().max(600).optional() }))
    if ((await humanAgents()).length >= MAX_CHANNELS) fail(400, 'limit', `Máximo ${MAX_CHANNELS} canales.`)
    const id = await repo.createAgent({
      name: b.name,
      system_prompt: '',
      welcome_message: b.welcome_message || `Hola, gracias por escribir a ${tenant.name}. ¿En qué te podemos ayudar?`,
      language: 'es',
      temperature: 0.4,
      model_id: HOSTED_DEFAULT_MODEL,
      provider_key_id: null,
      config_json: JSON.stringify({ mode: 'human', business_name: tenant.name, tools: { leads: { enabled: false } } } satisfies AgentConfig),
    })
    const origins = parseJson<string[]>((await repo.widgets())[0]?.allowed_origins, [])
    await repo.createWidget(id, newWidgetKey(), JSON.stringify({ assistant_name: tenant.name, header_title: tenant.name, primary: DEFAULT_THEME.primary }), origins)
    await audit('cc.channel_created', { agent_id: id, name: b.name })
    return json({ id })
  }

  if ((p = match('channels/:id', sub)) && m === 'PUT') {
    guard(request, env, auth, { roles: ['owner', 'editor'] })
    const a = (await humanAgents()).find((x) => x.id === p!.id)
    if (!a) fail(404, 'not_found', 'Canal no encontrado.')
    const b = await readJson(request, z.object({ name: z.string().trim().min(1).max(80).optional(), welcome_message: z.string().trim().max(600).optional() }))
    await repo.updateAgent(a!.id, { name: b.name, welcome_message: b.welcome_message })
    await audit('cc.channel_updated', { agent_id: a!.id })
    return json({ ok: true })
  }

  return fail(404, 'not_found', 'Ruta no encontrada.')
}
