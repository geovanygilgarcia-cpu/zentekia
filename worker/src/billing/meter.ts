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
  const cost = costMicro(u.tokensIn, u.tokensOut, price)
  await repo.insertLedger({
    message_id: u.messageId,
    conversation_id: u.conversationId,
    model_id: u.model.id,
    model_type: u.model.type,
    kind: u.kind ?? 'chat',
    tokens_in: u.tokensIn,
    tokens_out: u.tokensOut,
    cost_micro: cost,
    price_version: price.version,
    estimated: u.estimated ? 1 : 0,
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
