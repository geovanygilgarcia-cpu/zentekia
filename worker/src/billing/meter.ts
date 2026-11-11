/*
  Medición y control de gasto.
  - Cada respuesta del modelo deja una fila en usage_ledger con tokens, costo y versión de tarifa.
  - Límite mensual por cliente: alertas al 80 % y al 100 % (portal + admin + correo si hay Resend).
  - Al 100 %: "block" (por defecto) deja de responder con un mensaje amable; "allow" sigue con aviso.
*/
import type { Env } from '../env'
import { PlatformRepo } from '../db/platform-repo'
import type { TenantRepo } from '../db/tenant-repo'
import type { ModelRow, TenantRow } from '../db/types'
import { periodOf, periodRange } from '../db/types'
import { sendEmail } from '../lib/email'
import { costMicro, effectivePrice, fmtUsd } from './pricing'
import { overageMicro, tenantRates } from './rates'

export async function monthSpend(repo: TenantRepo, at = Date.now()) {
  const [from, to] = periodRange(periodOf(at))
  const r = await repo.spendBetween(from, to)
  return r?.cost ?? 0
}

export async function budgetAllows(repo: TenantRepo, tenant: TenantRow): Promise<boolean> {
  if (tenant.monthly_limit_micro <= 0 || tenant.limit_behavior === 'allow') return true
  return (await monthSpend(repo)) < tenant.monthly_limit_micro
}

export async function recordUsage(
  env: Env,
  repo: TenantRepo,
  tenant: TenantRow,
  u: { model: ModelRow; tokensIn: number; tokensOut: number; estimated: boolean; messageId: string | null; conversationId: string | null; kind?: string },
): Promise<number> {
  const platform = new PlatformRepo(env.DB)
  const price = await effectivePrice(platform, repo, u.model)
  // Lo que costaría por tokens: se guarda siempre para comparar en el admin
  const tokenCost = costMicro(u.tokensIn, u.tokensOut, price)
  const kind = u.kind ?? 'chat'
  // Con precio por mensaje: cada respuesta del asistente cuesta lo mismo y los
  // resúmenes automáticos (análisis) van incluidos. Sin precio: se cobra por tokens como antes.
  const rates = await tenantRates(env, tenant)
  let cost = tokenCost
  let billing: 'message' | 'included' | 'token' = 'token'
  let version = price.version
  let overage = 0
  if (rates.message_micro != null) {
    if (kind === 'chat') {
      // Precio del mensaje + excedente si pasó los tokens incluidos
      overage = overageMicro(rates, u.tokensIn, u.tokensOut, price)
      cost = rates.message_micro + overage
      billing = 'message'
      version = `msg:${rates.message_micro}:${rates.message_source}${overage ? `+exc:${rates.included_in ?? '-'}/${rates.included_out ?? '-'}:${price.version}` : ''}`
    } else {
      cost = 0
      billing = 'included'
      version = `included:${kind}`
    }
  }
  await repo.insertLedger({
    message_id: u.messageId,
    conversation_id: u.conversationId,
    model_id: u.model.id,
    model_type: u.model.type,
    kind,
    tokens_in: u.tokensIn,
    tokens_out: u.tokensOut,
    cost_micro: cost,
    price_version: version,
    estimated: u.estimated ? 1 : 0,
    billing,
    units: billing === 'message' ? 1 : null,
    unit_price_micro: billing === 'message' ? rates.message_micro : null,
    token_cost_micro: tokenCost,
    overage_micro: overage || null,
  })
  await checkThresholds(env, repo, tenant)
  return cost
}

export async function checkThresholds(env: Env, repo: TenantRepo, tenant: TenantRow) {
  if (tenant.monthly_limit_micro <= 0) return
  const period = periodOf(Date.now())
  const spent = await monthSpend(repo)
  const pct = (spent / tenant.monthly_limit_micro) * 100
  const steps: Array<[number, string, string]> = [
    [80, 'limit_80', `Llevas el 80 % de tu límite mensual (${fmtUsd(spent)} de ${fmtUsd(tenant.monthly_limit_micro)}).`],
    [
      100,
      'limit_100',
      tenant.limit_behavior === 'block'
        ? `Llegaste al 100 % de tu límite mensual (${fmtUsd(tenant.monthly_limit_micro)}). Tu agente dejó de responder hasta el próximo mes o hasta que Zentekia amplíe el límite.`
        : `Llegaste al 100 % de tu límite mensual (${fmtUsd(tenant.monthly_limit_micro)}). Tu agente sigue respondiendo; el excedente se cobrará.`,
    ],
  ]
  for (const [threshold, kind, message] of steps) {
    if (pct < threshold) continue
    const isNew = await repo.addAlert(kind, period, message)
    if (isNew) {
      const owners = await repo.ownerEmails()
      const zentekia = env.ALERT_EMAIL ? [env.ALERT_EMAIL] : []
      await sendEmail(env, [...owners, ...zentekia], `Zentekia · ${tenant.name}: ${threshold} % del límite mensual`, message)
    }
  }
}
