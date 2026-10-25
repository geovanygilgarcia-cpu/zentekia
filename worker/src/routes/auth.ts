/*
  Autenticación compartida por el panel admin y los portales:
    POST  v1/auth/login          { email, password }            → { state: ok | totp | enroll_totp }
    POST  v1/auth/totp/verify    { code }
    POST  v1/auth/totp/setup                                     → { secret, uri }
    POST  v1/auth/totp/enable    { code }
    POST  v1/auth/logout
    GET   v1/auth/me                                             → usuario, estado, csrf
    POST  v1/auth/password       { current, next }
    PUT   v1/auth/profile        { name }
    POST  v1/auth/totp/disable   { password }
    GET   v1/auth/invite?t=                                      → datos de la invitación
    POST  v1/auth/accept         { token, name, password }
*/
import { z } from 'zod'
import type { Env } from '../env'
import { PlatformRepo } from '../db/platform-repo'
import type { TenantRow, UserRow } from '../db/types'
import { decryptPlatform, encryptPlatform, hashPassword, newTotpSecret, passwordPolicy, verifyPassword, verifyTotp } from '../auth/crypto'
import {
  adminCookieName,
  createSession,
  loadSession,
  portalCookieName,
  sessionCookieMaxAge,
  setCookie,
  tooManyAttempts,
  totpNeeded,
  totpRequired,
  type AuthContext,
} from '../auth/session'
import { clientIp, fail, json, readJson, safeEqual, sha256Hex } from '../lib/http'

const emailSchema = z.string().trim().toLowerCase().min(3).max(200)

export async function authRoutes(env: Env, request: Request, kind: 'admin' | 'portal', tenant: TenantRow | null, sub: string): Promise<Response> {
  const repo = new PlatformRepo(env.DB)
  const cookieName = kind === 'admin' ? adminCookieName() : portalCookieName(tenant!.slug)
  const ip = clientIp(request)
  const m = request.method

  if (sub === 'login' && m === 'POST') {
    const body = await readJson(request, z.object({ email: emailSchema, password: z.string().min(1).max(200) }))
    if (tooManyAttempts(`${ip}:${body.email}`) || tooManyAttempts(`ip:${ip}`, 30)) {
      fail(429, 'rate_limited', 'Demasiados intentos. Espera unos minutos.')
    }
    let user: UserRow | null
    if (kind === 'admin') {
      user = await repo.superadminByEmail(body.email)
      if (!user) user = await bootstrapSuperadmin(env, repo, body.email, body.password)
    } else {
      user = await repo.tenantUserByEmail(tenant!.id, body.email)
    }
    const ok = await verifyPassword(body.password, user?.password_hash)
    if (!user || !ok || user.status !== 'active') {
      await repo.audit({ actor_id: user?.id ?? null, actor_email: body.email, tenant_id: tenant?.id ?? null, action: 'auth.login_failed', ip })
      fail(401, 'bad_credentials', 'Correo o contraseña incorrectos.')
    }
    const u = user!
    if (kind === 'portal' && tenant!.status === 'suspended') fail(403, 'suspended', 'Esta cuenta está suspendida. Contacta a Zentekia.')
    const needsTotp = totpNeeded(env, u)
    const { raw, csrf } = await createSession(env, request, { user: u, kind, tenantId: tenant?.id ?? null, mfaOk: !needsTotp })
    await repo.touchLogin(u.id)
    await repo.audit({ actor_id: u.id, actor_email: u.email, tenant_id: tenant?.id ?? null, action: 'auth.login', ip })
    const state = !needsTotp ? 'ok' : u.totp_enabled ? 'totp' : 'enroll_totp'
    return json({ state, csrf }, 200, { 'Set-Cookie': setCookie(cookieName, raw, sessionCookieMaxAge) })
  }

  if (sub === 'invite' && m === 'GET') {
    const t = new URL(request.url).searchParams.get('t') || ''
    const tok = await repo.peekOneTime(await sha256Hex(t), 'invite')
    if (!tok || tok.tenant_id !== (tenant?.id ?? null)) fail(404, 'invalid_invite', 'La invitación no es válida o ya venció. Pide una nueva.')
    const u = await repo.userById(tok!.user_id!)
    return json({ email: u?.email, tenant: tenant?.name ?? 'Zentekia' })
  }

  if (sub === 'accept' && m === 'POST') {
    const body = await readJson(request, z.object({ token: z.string().min(10).max(200), name: z.string().trim().max(120).optional(), password: z.string().max(200) }))
    const pol = passwordPolicy(body.password)
    if (pol) fail(400, 'weak_password', pol)
    const hash = await sha256Hex(body.token)
    const tok = await repo.peekOneTime(hash, 'invite')
    if (!tok || tok.tenant_id !== (tenant?.id ?? null) || !(await repo.consumeOneTime(hash))) {
      fail(404, 'invalid_invite', 'La invitación no es válida o ya venció. Pide una nueva.')
    }
    const u = await repo.userById(tok!.user_id!)
    if (!u) fail(404, 'invalid_invite', 'La invitación no es válida.')
    await repo.setPassword(u!.id, await hashPassword(body.password))
    if (body.name) await repo.setName(u!.id, body.name)
    const fresh = (await repo.userById(u!.id))!
    const needsTotp = totpRequired(env, fresh)
    const { raw, csrf } = await createSession(env, request, { user: fresh, kind, tenantId: tenant?.id ?? null, mfaOk: !needsTotp })
    await repo.audit({ actor_id: fresh.id, actor_email: fresh.email, tenant_id: tenant?.id ?? null, action: 'auth.invite_accepted', ip })
    return json({ state: needsTotp ? 'enroll_totp' : 'ok', csrf }, 200, { 'Set-Cookie': setCookie(cookieName, raw, sessionCookieMaxAge) })
  }

  // A partir de aquí se necesita sesión (aunque falte el segundo paso)
  const ctx = await loadSession(env, request, kind, tenant)
  if (!ctx) fail(401, 'unauthenticated', 'Tu sesión terminó. Vuelve a entrar.')
  const c = ctx!
  if (m !== 'GET' && request.headers.get('X-CSRF') !== c.session.csrf) fail(403, 'csrf', 'Recarga la página e intenta de nuevo.')

  if (sub === 'me' && m === 'GET') return json(meResponse(env, c))

  if (sub === 'logout' && m === 'POST') {
    await repo.deleteSession(c.idHash)
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(cookieName, '', 0) })
  }

  if (sub === 'totp/verify' && m === 'POST') {
    const { code } = await readJson(request, z.object({ code: z.string().max(12) }))
    if (tooManyAttempts(`totp:${c.user.id}`, 8)) fail(429, 'rate_limited', 'Demasiados intentos. Espera unos minutos.')
    if (!c.user.totp_enabled || !c.user.totp_secret_enc) fail(400, 'totp_not_enabled', 'Primero configura tu app de autenticación.')
    const secret = await decryptPlatform(env, `totp:${c.user.id}`, c.user.totp_secret_enc!)
    if (!(await verifyTotp(secret, code))) fail(401, 'bad_code', 'El código no es correcto. Revisa la hora de tu teléfono.')
    await repo.setSessionMfa(c.idHash)
    return json({ state: 'ok' })
  }

  if (sub === 'totp/setup' && m === 'POST') {
    if (c.user.totp_enabled && !c.session.mfa_ok) fail(403, 'mfa_required', 'Primero ingresa tu código actual.')
    const secret = newTotpSecret()
    await repo.setTotp(c.user.id, await encryptPlatform(env, `totp:${c.user.id}`, secret), false)
    const issuer = 'Zentekia'
    const label = encodeURIComponent(`${issuer}:${c.user.email}`)
    return json({ secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30` })
  }

  if (sub === 'totp/enable' && m === 'POST') {
    const { code } = await readJson(request, z.object({ code: z.string().max(12) }))
    if (tooManyAttempts(`totp:${c.user.id}`, 8)) fail(429, 'rate_limited', 'Demasiados intentos. Espera unos minutos.')
    const u = await repo.userById(c.user.id)
    if (!u?.totp_secret_enc) fail(400, 'totp_not_setup', 'Primero genera el código QR.')
    const secret = await decryptPlatform(env, `totp:${u!.id}`, u!.totp_secret_enc!)
    if (!(await verifyTotp(secret, code))) fail(401, 'bad_code', 'El código no es correcto. Revisa la hora de tu teléfono.')
    await repo.setTotp(u!.id, u!.totp_secret_enc, true)
    await repo.setSessionMfa(c.idHash)
    await repo.audit({ actor_id: u!.id, actor_email: u!.email, tenant_id: tenant?.id ?? null, action: 'auth.totp_enabled', ip })
    return json({ state: 'ok' })
  }

  if (sub === 'totp/disable' && m === 'POST') {
    if (c.session.read_only) fail(403, 'read_only', 'Modo solo lectura.')
    if (totpRequired(env, c.user)) fail(400, 'totp_required', 'Para tu tipo de cuenta la verificación en dos pasos es obligatoria.')
    if (c.user.totp_enabled && !c.session.mfa_ok) fail(403, 'mfa_required', 'Primero ingresa tu código actual.')
    const body = await readJson(request, z.object({ password: z.string().max(200) }))
    if (tooManyAttempts(`pw:${c.user.id}`, 8)) fail(429, 'rate_limited', 'Demasiados intentos. Espera unos minutos.')
    if (!(await verifyPassword(body.password, c.user.password_hash))) fail(401, 'bad_credentials', 'La contraseña no es correcta.')
    await repo.setTotp(c.user.id, null, false)
    await repo.audit({ actor_id: c.user.id, actor_email: c.user.email, tenant_id: tenant?.id ?? null, action: 'auth.totp_disabled', ip })
    return json({ ok: true })
  }

  if (sub === 'profile' && m === 'PUT') {
    if (c.session.read_only) fail(403, 'read_only', 'Modo solo lectura.')
    if (totpNeeded(env, c.user) && !c.session.mfa_ok) fail(403, 'mfa_required', 'Completa la verificación en dos pasos.')
    const body = await readJson(request, z.object({ name: z.string().trim().min(1, 'Escribe tu nombre.').max(120) }))
    await repo.setName(c.user.id, body.name)
    await repo.audit({ actor_id: c.user.id, actor_email: c.user.email, tenant_id: tenant?.id ?? null, action: 'auth.profile_updated', ip })
    return json({ ok: true })
  }

  if (sub === 'password' && m === 'POST') {
    if (c.session.read_only) fail(403, 'read_only', 'Modo solo lectura.')
    if (totpNeeded(env, c.user) && !c.session.mfa_ok) fail(403, 'mfa_required', 'Completa la verificación en dos pasos.')
    const body = await readJson(request, z.object({ current: z.string().max(200), next: z.string().max(200) }))
    if (!(await verifyPassword(body.current, c.user.password_hash))) fail(401, 'bad_credentials', 'La contraseña actual no es correcta.')
    const pol = passwordPolicy(body.next)
    if (pol) fail(400, 'weak_password', pol)
    await repo.setPassword(c.user.id, await hashPassword(body.next))
    await repo.deleteUserSessions(c.user.id, c.idHash)
    await repo.audit({ actor_id: c.user.id, actor_email: c.user.email, tenant_id: tenant?.id ?? null, action: 'auth.password_changed', ip })
    return json({ ok: true })
  }

  return fail(404, 'not_found', 'Ruta no encontrada.')
}

export function meResponse(env: Env, c: AuthContext) {
  const mfaPending = totpNeeded(env, c.user) && !c.session.mfa_ok && !c.session.impersonator_id
  return {
    user: { id: c.user.id, email: c.user.email, name: c.user.name, role: c.session.impersonator_id ? 'owner' : c.user.role, totp_enabled: Boolean(c.user.totp_enabled), totp_required: totpRequired(env, c.user), last_login_at: c.user.last_login_at ?? null },
    state: !mfaPending ? 'ok' : c.user.totp_enabled ? 'totp' : 'enroll_totp',
    csrf: c.session.csrf,
    impersonating: Boolean(c.session.impersonator_id),
    read_only: Boolean(c.session.read_only),
    tenant: c.tenant ? { name: c.tenant.name, slug: c.tenant.slug, status: c.tenant.status, onboarded: Boolean(c.tenant.onboarded) } : null,
  }
}

/** Primera vez: si aún no hay superadmin, se crea con ADMIN_EMAIL/ADMIN_USER + ADMIN_PASSWORD (secretos del Worker). */
async function bootstrapSuperadmin(env: Env, repo: PlatformRepo, email: string, password: string): Promise<UserRow | null> {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) return null
  if ((await repo.superadminCount()) > 0) return null
  const expected = (env.ADMIN_EMAIL || env.ADMIN_USER || 'admin').trim().toLowerCase()
  const enc = new TextEncoder()
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(email)))
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(expected)))
  const c = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(password)))
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_PASSWORD)))
  if (!safeEqual(a, b) || !safeEqual(c, d)) return null
  const id = crypto.randomUUID()
  await repo.insertUser({ id, tenant_id: null, email, name: 'Superadmin', role: 'superadmin', password_hash: await hashPassword(password), status: 'active' })
  await repo.audit({ actor_id: id, actor_email: email, tenant_id: null, action: 'auth.superadmin_bootstrap', ip: null })
  return repo.userById(id)
}
