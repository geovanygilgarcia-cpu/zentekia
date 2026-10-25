/*
  Sesiones del panel admin y de los portales.
  - Cookie HttpOnly; Secure; SameSite=Lax; Path=/ con prefijo __Host- (sin Domain → solo ese host).
      admin:  __Host-zt_a          portal: __Host-zt_p_<slug>
    Con un nombre por portal, un portal nunca lee la cookie de otro aunque compartan host (*.workers.dev).
  - En la base solo se guarda el SHA-256 del id de sesión.
  - CSRF: toda operación que cambia datos exige el encabezado X-CSRF con el token de la sesión.
  - TOTP obligatorio para superadmin y owners (TOTP_OBLIGATORIO="true").
*/
import type { Env } from '../env'
import { PlatformRepo } from '../db/platform-repo'
import type { SessionRow, TenantRow, UserRow } from '../db/types'
import { fail, randomToken, sha256Hex, clientIp } from '../lib/http'

const TTL_MS = 12 * 60 * 60 * 1000

export interface AuthContext {
  session: SessionRow
  user: UserRow
  tenant: TenantRow | null
  idHash: string
}

export const adminCookieName = () => '__Host-zt_a'
export const portalCookieName = (slug: string) => `__Host-zt_p_${slug}`

export function readCookie(request: Request, name: string): string | null {
  const h = request.headers.get('Cookie') || ''
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=') || null
  }
  return null
}

export function setCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`
}

/** 2FA obligatoria: solo superadmin (salvo TOTP_OBLIGATORIO = "false"). Los usuarios de clientes la activan si quieren. */
export function totpRequired(env: Env, user: Pick<UserRow, 'role'>): boolean {
  if (env.TOTP_OBLIGATORIO === 'false') return false
  return user.role === 'superadmin'
}

/** ¿Esta sesión debe pasar por el código de 6 dígitos? (obligatoria o porque la persona la activó) */
export function totpNeeded(env: Env, user: Pick<UserRow, 'role' | 'totp_enabled'>): boolean {
  return totpRequired(env, user) || user.totp_enabled === 1
}

export async function createSession(
  env: Env,
  request: Request,
  o: { user: UserRow; kind: 'admin' | 'portal'; tenantId: string | null; mfaOk: boolean; impersonatorId?: string | null; readOnly?: boolean },
): Promise<{ raw: string; csrf: string }> {
  const raw = randomToken(32)
  const csrf = randomToken(18)
  const repo = new PlatformRepo(env.DB)
  await repo.insertSession({
    id_hash: await sha256Hex(raw),
    user_id: o.user.id,
    tenant_id: o.tenantId,
    kind: o.kind,
    csrf,
    mfa_ok: o.mfaOk ? 1 : 0,
    impersonator_id: o.impersonatorId ?? null,
    read_only: o.readOnly ? 1 : 0,
    expires_at: Date.now() + TTL_MS,
    created_at: Date.now(),
    ip: clientIp(request),
  })
  return { raw, csrf }
}

export const sessionCookieMaxAge = Math.floor(TTL_MS / 1000)

/** Lee la sesión de la cookie. Valida tipo y, para portal, que el usuario pertenezca a ese tenant. */
export async function loadSession(env: Env, request: Request, kind: 'admin' | 'portal', tenant: TenantRow | null): Promise<AuthContext | null> {
  const name = kind === 'admin' ? adminCookieName() : portalCookieName(tenant!.slug)
  const raw = readCookie(request, name)
  if (!raw || raw.length > 100) return null
  const repo = new PlatformRepo(env.DB)
  const idHash = await sha256Hex(raw)
  const session = await repo.session(idHash)
  if (!session || session.kind !== kind) return null
  const user = await repo.userById(session.user_id)
  if (!user || user.status === 'disabled') return null
  if (kind === 'admin') {
    if (user.role !== 'superadmin' || user.tenant_id !== null) return null
    return { session, user, tenant: null, idHash }
  }
  // Portal: la sesión, el usuario y el host/slug deben apuntar al mismo tenant
  if (!tenant || session.tenant_id !== tenant.id) return null
  if (!session.impersonator_id && user.tenant_id !== tenant.id) return null
  if (session.impersonator_id && user.role !== 'superadmin') return null
  return { session, user, tenant, idHash }
}

export interface Guard {
  roles?: Array<'owner' | 'editor' | 'superadmin'>
  write?: boolean
}

/** Verificación de cada endpoint protegido (RBAC + MFA + CSRF + solo lectura en impersonación) */
export function guard(request: Request, env: Env, ctx: AuthContext | null, g: Guard = {}): AuthContext {
  if (!ctx) return fail(401, 'unauthenticated', 'Tu sesión terminó. Vuelve a entrar.')
  if (totpNeeded(env, ctx.user) && !ctx.session.mfa_ok && !ctx.session.impersonator_id) {
    fail(403, 'mfa_required', 'Completa la verificación en dos pasos.')
  }
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  if (mutating) {
    const h = request.headers.get('X-CSRF')
    if (!h || h !== ctx.session.csrf) fail(403, 'csrf', 'La sesión no es válida para esta acción. Recarga la página.')
  }
  if ((g.write || mutating) && ctx.session.read_only) fail(403, 'read_only', 'Estás viendo este portal en modo solo lectura (soporte).')
  if (g.roles) {
    // En impersonación el superadmin actúa con permisos de owner pero en solo lectura
    const role = ctx.session.impersonator_id ? 'owner' : ctx.user.role
    if (!g.roles.includes(role as 'owner')) fail(403, 'forbidden', 'Tu rol no tiene permiso para esto.')
  }
  return ctx
}

/* ---------- límite de intentos de login (por IP + correo) ---------- */
const attempts = new Map<string, number[]>()
export function tooManyAttempts(key: string, max = 6, windowMs = 10 * 60_000): boolean {
  const t = Date.now()
  const list = (attempts.get(key) || []).filter((x) => t - x < windowMs)
  list.push(t)
  attempts.set(key, list)
  if (attempts.size > 5000) attempts.clear()
  return list.length > max
}
