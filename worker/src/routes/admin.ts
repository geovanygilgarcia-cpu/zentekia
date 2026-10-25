/*
  API del panel de superadmin (Zentekia). Toda acción que cambia algo queda en auditoría.
*/
import { z } from 'zod'
import type { Env } from '../env'
import { guard, loadSession } from '../auth/session'
import { PlatformRepo } from '../db/platform-repo'
import { TenantRepo } from '../db/tenant-repo'
import { PLANS, RESERVED_SLUGS } from '../db/seed'
import { parseJson, periodOf, periodRange } from '../db/types'
import { effectivePrice } from '../billing/pricing'
import { clientIp, fail, json, randomToken, readJson, sha256Hex } from '../lib/http'
import { portalHostLabel, portalUrl } from '../lib/hosts'
import { createInvite, provisionTenant } from '../lib/provision'
import { match, toCsv } from '../lib/router'

const usd = z.number().min(0).max(1_000_000)
const toMicro = (n: number) => Math.round(n * 1_000_000)
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/, 'de 3 a 32 caracteres: minúsculas, números y guiones; empieza con letra')
  .refine((s) => !RESERVED_SLUGS.has(s), 'ese nombre está reservado')
  .refine((s) => !s.includes('--'), 'sin guiones dobles')

export async function adminRoutes(env: Env, request: Request, url: URL, sub: string): Promise<Response> {
  const ctx = await loadSession(env, request, 'admin', null)
  const c = guard(request, env, ctx, { roles: ['superadmin'] })
  const m = request.method
  const platform = new PlatformRepo(env.DB)
  const ip = clientIp(request)
  const audit = (action: string, tenant_id: string | null, detail?: unknown) => platform.audit({ actor_id: c.user.id, actor_email: c.user.email, tenant_id, action, detail, ip })
  let p: Record<string, string> | null

  if (sub === 'health' && m === 'GET') {
    return json({
      master_key: Boolean(env.MASTER_KEY),
      vectorize: Boolean(env.VECTORIZE),
      r2: Boolean(env.FILES),
      email: Boolean(env.RESEND_API_KEY),
      ai: Boolean(env.AI),
      base_domain: env.BASE_DOMAIN || null,
      totp_required: env.TOTP_OBLIGATORIO !== 'false',
      plans: Object.entries(PLANS).map(([id, v]) => ({ id, ...v })),
    })
  }

  /* ---------- clientes ---------- */
  if (sub === 'tenants' && m === 'GET') {
    const [from, to] = periodRange(periodOf(Date.now()))
    const rows = (await platform.listTenants(from, to)) as Array<Record<string, unknown> & { slug: string }>
    return json({ tenants: rows.map((r) => ({ ...r, portal: portalHostLabel(env, url, r.slug), portal_url: portalUrl(env, url, r.slug) })) })
  }
  if (sub === 'tenants' && m === 'POST') {
    const b = await readJson(
      request,
      z.object({
        name: z.string().trim().min(2).max(100),
        slug: slugSchema,
        owner_email: z.string().trim().toLowerCase().email().max(200),
        plan_id: z.enum(['basico', 'pro', 'enterprise']).default('basico'),
        monthly_limit_usd: usd,
        limit_behavior: z.enum(['block', 'allow']).default('block'),
        enabled_models: z.array(z.string().max(60)).max(30),
        import_prakticall: z.boolean().default(false),
      }),
    )
    if (await platform.tenantBySlug(b.slug)) fail(400, 'slug_taken', 'Ese slug ya está en uso.')
    const { tenant, invite } = await provisionTenant(env, url, {
      name: b.name,
      slug: b.slug,
      ownerEmail: b.owner_email,
      planId: b.plan_id,
      monthlyLimitMicro: toMicro(b.monthly_limit_usd),
      limitBehavior: b.limit_behavior,
      enabledModels: b.enabled_models,
      importPrakticall: b.import_prakticall,
    })
    await audit('tenant.created', tenant.id, { slug: b.slug, plan: b.plan_id, limit_usd: b.monthly_limit_usd, owner: b.owner_email })
    return json({ id: tenant.id, invite_link: invite.link, emailed: invite.emailed, portal_url: portalUrl(env, url, b.slug) })
  }
  if ((p = match('tenants/:id', sub))) {
    const t = await platform.tenantById(p.id!)
    if (!t) fail(404, 'not_found', 'Cliente no encontrado.')
    const tenant = t!
    if (m === 'GET') {
      const repo = new TenantRepo(env.DB, tenant.id)
      const [from, to] = periodRange(periodOf(Date.now()))
      const { data_key_enc: _dk, ...safe } = tenant
      return json({
        tenant: { ...safe, enabled_models: parseJson<string[]>(tenant.enabled_models, []), portal: portalHostLabel(env, url, tenant.slug) },
        users: await repo.users(),
        agents: (await repo.listAgents()).map((a) => ({ id: a.id, name: a.name, model_id: a.model_id })),
        spend: await repo.spendBetween(from, to),
        alerts: await repo.alerts(10),
        audit: await platform.tenantAudit(tenant.id, 30),
      })
    }
    if (m === 'PUT') {
      const b = await readJson(
        request,
        z.object({
          name: z.string().trim().min(2).max(100).optional(),
          plan_id: z.enum(['basico', 'pro', 'enterprise']).optional(),
          monthly_limit_usd: usd.optional(),
          limit_behavior: z.enum(['block', 'allow']).optional(),
          enabled_models: z.array(z.string().max(60)).max(30).optional(),
          suspended_message: z.string().max(300).optional(),
          turnstile: z.boolean().optional(),
        }),
      )
      await platform.updateTenant(tenant.id, {
        name: b.name,
        plan_id: b.plan_id,
        monthly_limit_micro: b.monthly_limit_usd === undefined ? undefined : toMicro(b.monthly_limit_usd),
        limit_behavior: b.limit_behavior,
        enabled_models: b.enabled_models ? JSON.stringify(b.enabled_models) : undefined,
        suspended_message: b.suspended_message,
        turnstile: b.turnstile === undefined ? undefined : b.turnstile ? 1 : 0,
      })
      await audit('tenant.updated', tenant.id, b)
      return json({ ok: true })
    }
  }
  if ((p = match('tenants/:id/:action', sub)) && m === 'POST') {
    const t = await platform.tenantById(p.id!)
    if (!t) fail(404, 'not_found', 'Cliente no encontrado.')
    const tenant = t!
    if (p.action === 'suspend') {
      const b = await readJson(request, z.object({ message: z.string().max(300).optional() }))
      await platform.updateTenant(tenant.id, { status: 'suspended', suspended_message: b.message || tenant.suspended_message || 'El chat no está disponible por el momento.' })
      await audit('tenant.suspended', tenant.id, { message: b.message })
      return json({ ok: true })
    }
    if (p.action === 'reactivate') {
      await platform.updateTenant(tenant.id, { status: 'active' })
      await audit('tenant.reactivated', tenant.id)
      return json({ ok: true })
    }
    if (p.action === 'invite') {
      const repo = new TenantRepo(env.DB, tenant.id)
      const b = await readJson(request, z.object({ email: z.string().trim().toLowerCase().email().max(200).optional() }))
      const users = await repo.users()
      let target = b.email ? users.find((u) => u.email === b.email) : users.find((u) => u.role === 'owner' && u.status !== 'active') || users.find((u) => u.role === 'owner')
      if (!target && b.email) {
        const id = crypto.randomUUID()
        await repo.createUser({ id, email: b.email, name: null, role: 'owner' })
        target = (await repo.users()).find((u) => u.id === id)
      }
      if (!target) fail(400, 'no_owner', 'El cliente no tiene owner. Escribe un correo.')
      const inv = await createInvite(env, url, tenant, target!.id, target!.email)
      await audit('tenant.invite_sent', tenant.id, { email: target!.email })
      return json({ invite_link: inv.link, emailed: inv.emailed })
    }
    if (p.action === 'reset-totp') {
      const b = await readJson(request, z.object({ user_id: z.string().max(64) }))
      const u = await new TenantRepo(env.DB, tenant.id).user(b.user_id)
      if (!u) fail(404, 'not_found', 'Usuario no encontrado.')
      await platform.setTotp(u!.id, null, false)
      await platform.deleteUserSessions(u!.id)
      await audit('tenant.user_totp_reset', tenant.id, { email: u!.email })
      return json({ ok: true })
    }
    if (p.action === 'impersonate') {
      // Token de un solo uso (60 s) que el portal del cliente cambia por una sesión de SOLO LECTURA
      const token = randomToken(32)
      await platform.insertOneTime({ token_hash: await sha256Hex(token), kind: 'impersonate', user_id: c.user.id, tenant_id: tenant.id, data: null, expires_at: Date.now() + 60_000 })
      await audit('tenant.impersonation_started', tenant.id, { read_only: true })
      return json({ url: `${portalUrl(env, url, tenant.slug)}entrar?t=${token}` })
    }
  }

  /* ---------- modelos y tarifas ---------- */
  if (sub === 'models' && m === 'GET') {
    const models = await platform.models(false)
    const out = []
    for (const mo of models) out.push({ ...mo, price: await platform.currentPrice(mo.id), history: await platform.priceHistory(mo.id) })
    return json({ models: out, overrides: await platform.overrides() })
  }
  if ((p = match('models/:id', sub)) && m === 'PUT') {
    const id = z.string().regex(/^[a-z0-9-]{2,40}$/).parse(p.id)
    const b = await readJson(
      request,
      z.object({
        provider: z.enum(['workers-ai', 'anthropic', 'openai', 'openai-compatible']),
        model_name: z.string().trim().max(120),
        display_name: z.string().trim().min(2).max(80),
        type: z.enum(['hosted', 'byok']),
        active: z.boolean(),
        context_window: z.number().int().min(1000).max(2_000_000).default(32000),
      }),
    )
    if (b.type === 'hosted' && b.provider !== 'workers-ai') fail(400, 'type', 'Solo Workers AI puede ser hosted.')
    await platform.upsertModel({ id, ...b, active: b.active ? 1 : 0 })
    if (!(await platform.currentPrice(id))) await platform.addPrice({ model_id: id, input_per_1m_micro: 0, output_per_1m_micro: 0, fee_input_per_1m_micro: 0, fee_output_per_1m_micro: 0, effective_from: Date.now() })
    await audit('model.saved', null, { id, ...b })
    return json({ ok: true })
  }
  if ((p = match('models/:id/price', sub)) && m === 'POST') {
    const mo = await platform.model(p.id!)
    if (!mo) fail(404, 'not_found', 'Modelo no encontrado.')
    const b = await readJson(request, z.object({ input_usd: usd, output_usd: usd, fee_input_usd: usd, fee_output_usd: usd, effective_from: z.number().int().optional() }))
    const eff = b.effective_from && b.effective_from > Date.now() ? b.effective_from : Date.now()
    await platform.addPrice({ model_id: mo!.id, input_per_1m_micro: toMicro(b.input_usd), output_per_1m_micro: toMicro(b.output_usd), fee_input_per_1m_micro: toMicro(b.fee_input_usd), fee_output_per_1m_micro: toMicro(b.fee_output_usd), effective_from: eff })
    await audit('price.added', null, { model_id: mo!.id, ...b, effective_from: eff })
    return json({ ok: true })
  }
  if (sub === 'overrides' && m === 'POST') {
    const b = await readJson(
      request,
      z.object({
        tenant_id: z.string().max(64),
        model_id: z.string().max(60),
        input_usd: usd.nullable().optional(),
        output_usd: usd.nullable().optional(),
        fee_input_usd: usd.nullable().optional(),
        fee_output_usd: usd.nullable().optional(),
        discount_pct: z.number().int().min(0).max(100).nullable().optional(),
      }),
    )
    if (!(await platform.tenantById(b.tenant_id)) || !(await platform.model(b.model_id))) fail(404, 'not_found', 'Cliente o modelo no encontrado.')
    const mm = (v: number | null | undefined) => (v == null ? null : toMicro(v))
    await platform.addOverride({
      tenant_id: b.tenant_id,
      model_id: b.model_id,
      input_per_1m_micro: mm(b.input_usd),
      output_per_1m_micro: mm(b.output_usd),
      fee_input_per_1m_micro: mm(b.fee_input_usd),
      fee_output_per_1m_micro: mm(b.fee_output_usd),
      discount_pct: b.discount_pct ?? null,
      effective_from: Date.now(),
    })
    await audit('price.override_added', b.tenant_id, b)
    return json({ ok: true })
  }

  /* ---------- consumo ---------- */
  if ((sub === 'usage' || sub === 'usage.csv') && m === 'GET') {
    const period = /^\d{4}-\d{2}$/.test(url.searchParams.get('period') || '') ? url.searchParams.get('period')! : periodOf(Date.now())
    const tenantId = url.searchParams.get('tenant') || undefined
    const [from, to] = periodRange(period)
    const rows = await platform.usageReport(from, to, tenantId)
    if (sub === 'usage.csv') {
      await audit('usage.exported', tenantId ?? null, { period })
      const csv = toCsv([
        ['periodo', 'cliente', 'slug', 'modelo', 'tipo', 'mensajes', 'tokens_entrada', 'tokens_salida', 'importe_usd', 'registros_estimados'],
        ...rows.map((r) => [period, r.tenant_name, r.slug, r.model_id, r.model_type, r.messages, r.tokens_in, r.tokens_out, (r.cost_micro / 1e6).toFixed(4), r.estimated]),
      ])
      return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="consumo-${period}.csv"` } })
    }
    return json({ period, rows, daily: await platform.dailyTotals(from, to), statements: await platform.statements(period) })
  }
  if (sub === 'statements/close' && m === 'POST') {
    const b = await readJson(request, z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }))
    const [from, to] = periodRange(b.period)
    const rows = await platform.usageReport(from, to)
    const tenants = [...new Set(rows.map((r) => r.tenant_id))]
    for (const tid of tenants) {
      const repo = new TenantRepo(env.DB, tid)
      const mine = rows.filter((r) => r.tenant_id === tid)
      const lines = []
      for (const r of mine) {
        const mo = await platform.model(r.model_id)
        const pr = mo ? await effectivePrice(platform, repo, mo, to - 1) : { in_per_1m: 0, out_per_1m: 0 }
        lines.push({ model: mo?.display_name ?? r.model_id, type: r.model_type, tokens_in: r.tokens_in, tokens_out: r.tokens_out, in_per_1m_micro: pr.in_per_1m, out_per_1m_micro: pr.out_per_1m, cost_micro: r.cost_micro })
      }
      await platform.upsertStatement({
        tenant_id: tid,
        period: b.period,
        tokens_in: mine.reduce((a, r) => a + r.tokens_in, 0),
        tokens_out: mine.reduce((a, r) => a + r.tokens_out, 0),
        total_micro: mine.reduce((a, r) => a + r.cost_micro, 0),
        lines_json: JSON.stringify(lines),
      })
    }
    await audit('statements.generated', null, { period: b.period, tenants: tenants.length })
    return json({ ok: true, count: tenants.length })
  }
  if ((p = match('statements/:id/:action', sub)) && m === 'POST') {
    const s = await platform.statementById(p.id!)
    if (!s) fail(404, 'not_found', 'Estado de cuenta no encontrado.')
    const action = z.enum(['issue', 'paid']).parse(p.action)
    await platform.setStatementStatus(s!.id, action === 'issue' ? 'issued' : 'paid')
    await audit(action === 'issue' ? 'statement.issued' : 'statement.marked_paid', s!.tenant_id, { period: s!.period, total_micro: s!.total_micro })
    return json({ ok: true })
  }

  /* ---------- auditoría ---------- */
  if (sub === 'audit' && m === 'GET') {
    const before = Number(url.searchParams.get('before') || 0) || undefined
    return json({ items: await platform.auditList({ tenantId: url.searchParams.get('tenant') || undefined, action: url.searchParams.get('action') || undefined, before, limit: 100 }) })
  }

  return fail(404, 'not_found', 'Ruta no encontrada.')
}
