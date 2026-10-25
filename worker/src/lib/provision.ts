/*
  Alta de cliente: crea tenant, llave de cifrado, agente por defecto, widget key e invitación al owner.
*/
import type { Env } from '../env'
import { newWrappedDataKey } from '../auth/crypto'
import { PlatformRepo } from '../db/platform-repo'
import { TenantRepo } from '../db/tenant-repo'
import { HOSTED_DEFAULT_MODEL } from '../db/seed'
import type { TenantRow } from '../db/types'
import { DEFAULT_THEME } from '../widget-theme'
import { PRAKTICALL_AGENTS, PRAKTICALL_WIDGET } from '../templates/prakticall'
import { portalUrl } from './hosts'
import { sha256Hex, randomToken } from './http'
import { sendEmail } from './email'

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export function newWidgetKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return 'pk_live_' + [...b].map((x) => B62[x % 62]).join('')
}

export async function createInvite(env: Env, url: URL, tenant: TenantRow, userId: string, email: string): Promise<{ link: string; emailed: boolean }> {
  const token = randomToken(32)
  await new PlatformRepo(env.DB).insertOneTime({
    token_hash: await sha256Hex(token),
    kind: 'invite',
    user_id: userId,
    tenant_id: tenant.id,
    data: null,
    expires_at: Date.now() + 7 * 86_400_000,
  })
  // El token va en el fragmento (#): no viaja en logs de servidores ni en el Referer
  const link = `${portalUrl(env, url, tenant.slug)}#/invitacion/${token}`
  const emailed = await sendEmail(
    env,
    [email],
    `Tu acceso a Zentekia · ${tenant.name}`,
    `Hola,\n\nZentekia te dio acceso al portal de ${tenant.name} para configurar tu agente de chat.\n\nEntra aquí para crear tu contraseña (la liga vence en 7 días):\n${link}\n\nSi no esperabas este correo, ignóralo.`,
  )
  return { link, emailed }
}

export interface NewTenant {
  name: string
  slug: string
  ownerEmail: string
  planId: string
  monthlyLimitMicro: number
  limitBehavior: 'block' | 'allow'
  enabledModels: string[]
  importPrakticall: boolean
}

export async function provisionTenant(env: Env, url: URL, n: NewTenant) {
  const platform = new PlatformRepo(env.DB)
  const tenantId = crypto.randomUUID()
  await platform.insertTenant({
    id: tenantId,
    slug: n.slug,
    name: n.name,
    plan_id: n.planId,
    monthly_limit_micro: n.monthlyLimitMicro,
    limit_behavior: n.limitBehavior,
    enabled_models: JSON.stringify(n.enabledModels),
    data_key_enc: await newWrappedDataKey(env, tenantId),
    currency: 'USD',
  })
  const tenant = (await platform.tenantById(tenantId))!
  const repo = new TenantRepo(env.DB, tenantId)

  const agents: { name: string; prompt: string; welcome: string; suggested: string[] }[] = []
  if (n.importPrakticall) {
    const legacy = await platform.legacyPrompts()
    for (const p of PRAKTICALL_AGENTS) {
      const w = PRAKTICALL_WIDGET[p.agent]
      agents.push({ name: w?.name ?? p.name, prompt: legacy.get(p.agent) ?? p.content, welcome: w?.welcome ?? '', suggested: w?.suggested ?? [] })
    }
  }
  if (!agents.length) agents.push({ name: `Asistente ${n.name}`, prompt: '', welcome: `Hola, soy el asistente de ${n.name}. ¿En qué te ayudo?`, suggested: [] })

  for (const a of agents) {
    const agentId = await repo.createAgent({
      name: a.name,
      system_prompt: a.prompt,
      welcome_message: a.welcome,
      language: 'es',
      temperature: 0.4,
      model_id: HOSTED_DEFAULT_MODEL,
      provider_key_id: null,
      config_json: JSON.stringify({ suggested_questions: a.suggested, business_name: n.name, tone: 'amable y profesional' }),
    })
    await repo.createWidget(agentId, newWidgetKey(), JSON.stringify({ assistant_name: a.name.split(' · ').pop() || a.name, primary: DEFAULT_THEME.primary }), [])
  }

  const ownerId = crypto.randomUUID()
  await repo.createUser({ id: ownerId, email: n.ownerEmail, name: null, role: 'owner' })
  const invite = await createInvite(env, url, tenant, ownerId, n.ownerEmail)
  return { tenant, invite }
}
