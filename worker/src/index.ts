/*
  Zentekia · Worker único
  ============================
  Sirve el widget, la API pública de chat, el portal de cada cliente y el panel de superadmin.
  Ver lib/hosts.ts para el modo de dominios (rutas en workers.dev o subdominios con BASE_DOMAIN).
*/
import type { Env } from './env'
import { ensureSchema } from './db/schema'
import { PlatformRepo } from './db/platform-repo'
import { TenantRepo } from './db/tenant-repo'
import { areaFor, chatOrigin } from './lib/hosts'
import { errorResponse, json, SECURITY_HEADERS, sha256Hex } from './lib/http'
import { adminCookieName, createSession, loadSession, portalCookieName, sessionCookieMaxAge, setCookie } from './auth/session'
import { authRoutes } from './routes/auth'
import { adminRoutes } from './routes/admin'
import { portalRoutes } from './routes/portal'
import { widgetRoutes } from './routes/widget'
import { processSource } from './rag/kb'
import { sweepVoiceCalls } from './routes/voice'
import { sweepAnalysis } from './leads/analyze'
import { asset } from './assets'
import { FAVICON_B64 } from './favicon'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    try {
      return await route(request, env, ctx, url)
    } catch (e) {
      return errorResponse(e)
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cron(env))
  },
}

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/{2,}/g, '/')
  if (path === '/health') return json({ ok: true, ai: Boolean(env.AI), db: Boolean(env.DB), vectorize: Boolean(env.VECTORIZE), master_key: Boolean(env.MASTER_KEY) })

  const area = areaFor(env, url)
  if (area.kind === 'unknown' || area.kind === 'api') return json({ error: { code: 'not_found', message: 'No encontrado.' } }, 404)

  if (path.startsWith('/assets/')) return serveAsset(path.slice('/assets/'.length))
  if (path === '/favicon.ico') {
    const bytes = Uint8Array.from(atob(FAVICON_B64), (c) => c.charCodeAt(0))
    return new Response(bytes, { headers: { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400', ...SECURITY_HEADERS } })
  }

  await ensureSchema(env.DB)

  // Widget y API pública
  if (area.kind === 'combined' || area.kind === 'chat') {
    const r = await widgetRoutes(env, request, url, path, ctx)
    if (r) return r
    if (area.kind === 'chat') return json({ error: { code: 'not_found', message: 'No encontrado.' } }, 404)
  }

  // Panel admin
  if (area.kind === 'admin' || (area.kind === 'combined' && (path === '/admin' || path.startsWith('/admin/')))) {
    const rest = area.kind === 'admin' ? path : path.slice('/admin'.length) || '/'
    if (area.kind === 'combined' && path === '/admin') return Response.redirect(`${url.origin}/admin/`, 302)
    if (rest.startsWith('/v1/auth/')) return authRoutes(env, request, 'admin', null, rest.slice('/v1/auth/'.length))
    if (rest.startsWith('/v1/')) return adminRoutes(env, request, url, rest.slice('/v1/'.length))
    if (request.method === 'GET') return spaPage(env, url, 'admin', { base: area.kind === 'admin' ? '/v1' : '/admin/v1' })
  }

  // Portal del cliente
  let slug: string | null = null
  let rest = ''
  if (area.kind === 'portal') {
    slug = area.slug
    rest = path
  } else if (area.kind === 'combined') {
    const mm = path.match(/^\/p\/([a-z0-9-]{3,32})(\/.*)?$/)
    if (mm) {
      slug = mm[1]!
      rest = mm[2] || ''
      if (!rest) return Response.redirect(`${url.origin}/p/${slug}/`, 302)
    }
  }
  if (slug) {
    const tenant = await new PlatformRepo(env.DB).tenantBySlug(slug)
    if (!tenant) return new Response('Portal no encontrado', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    const base = area.kind === 'portal' ? '' : `/p/${slug}`
    if (rest === '/entrar' && request.method === 'GET') return impersonate(env, request, url, tenant.id, slug, base)
    // Cuenta suspendida: el portal deja de abrir (solo soporte de Zentekia, en modo "ver como cliente", puede entrar)
    if (tenant.status === 'suspended') {
      const ctx = await loadSession(env, request, 'portal', tenant)
      if (!ctx?.session.impersonator_id) {
        if (rest.startsWith('/v1/')) return json({ error: { code: 'suspended', message: 'Esta cuenta está suspendida. Contacta a Zentekia.' } }, 403)
        return suspendedPage(tenant.name)
      }
    }
    if (rest.startsWith('/v1/auth/')) return authRoutes(env, request, 'portal', tenant, rest.slice('/v1/auth/'.length))
    if (rest.startsWith('/v1/')) return portalRoutes(env, request, url, tenant, rest.slice('/v1/'.length))
    if (request.method === 'GET') return spaPage(env, url, 'portal', { base: `${base}/v1`, slug, tenant: tenant.name })
  }

  if (area.kind === 'combined' && path === '/') return Response.redirect(`${url.origin}/admin/`, 302)
  return json({ error: { code: 'not_found', message: 'No encontrado.' } }, 404)
}

function serveAsset(name: string): Response {
  const a = asset(name)
  if (!a) return new Response('No encontrado', { status: 404 })
  return new Response(a.body, { headers: { 'Content-Type': a.type, 'Cache-Control': 'public, max-age=300', ...SECURITY_HEADERS } })
}

function spaPage(env: Env, url: URL, app: 'admin' | 'portal', data: Record<string, string>): Response {
  const chat = chatOrigin(env, url)
  const attrs = Object.entries({ ...data, chat })
    .map(([k, v]) => `data-${k}="${v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"`)
    .join(' ')
  const title = app === 'admin' ? 'Zentekia Admin' : `Zentekia · ${data.tenant ?? ''}`
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${title.replace(/[<>&]/g, '')}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@400;500&display=swap">
<script src="/assets/theme.js"></script><link rel="icon" href="/favicon.ico" sizes="any"><link rel="stylesheet" href="/assets/${app}.css"></head><body><div id="root" ${attrs}></div><script src="/assets/${app}.js"></script></body></html>`
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src 'self' data: blob: ${chat}`,
    // Muestras de voz (ElevenLabs)
    'media-src https: blob:',
    "connect-src 'self'",
    `frame-src ${chat}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY', ...SECURITY_HEADERS } })
}

/** Página que ve un cliente suspendido en lugar de su portal */
function suspendedPage(tenantName: string): Response {
  const name = tenantName.replace(/[<>&"]/g, '')
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Cuenta suspendida · Zentekia</title><link rel="icon" href="/favicon.ico" sizes="any">
<style>
:root{color-scheme:dark;--bg:#07090d;--ink:#e8ebf2;--muted:#9aa3b5;--line:rgba(255,255,255,.1);--card:rgba(255,255,255,.04)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f6fb;--ink:#0f172a;--muted:#5b6578;--line:rgba(15,23,42,.1);--card:#fff}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(800px 480px at 80% -10%,rgba(47,107,255,.18),transparent 60%),var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif}
.c{width:min(440px,100%);text-align:center;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:36px 28px;box-shadow:0 30px 70px -40px rgba(47,107,255,.5)}
.logo{font:700 20px system-ui,sans-serif;letter-spacing:-.02em}.logo b{color:#2f6bff}
.ic{width:56px;height:56px;margin:26px auto 16px;border-radius:50%;display:grid;place-items:center;background:rgba(251,191,36,.12);color:#f59e0b;border:1px solid rgba(251,191,36,.3)}
h1{margin:0;font-size:22px;letter-spacing:-.01em}p{margin:10px 0 0;color:var(--muted)}.t{font-weight:600;color:var(--ink)}
</style></head><body><main class="c"><div class="logo">zentekia<b>.</b></div>
<div class="ic" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div>
<h1>Cuenta suspendida</h1><p>El portal de <span class="t">${name}</span> no está disponible por ahora.</p><p>Si crees que es un error, contacta a Zentekia para reactivarla.</p></main></body></html>`
  return new Response(html, { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY', ...SECURITY_HEADERS } })
}

/** "Ver como cliente": cambia un token de 60 s por una sesión de solo lectura en ese portal */
async function impersonate(env: Env, request: Request, url: URL, tenantId: string, slug: string, base: string): Promise<Response> {
  const t = url.searchParams.get('t') || ''
  const platform = new PlatformRepo(env.DB)
  const hash = await sha256Hex(t)
  const tok = await platform.peekOneTime(hash, 'impersonate')
  if (!tok || tok.tenant_id !== tenantId || !(await platform.consumeOneTime(hash))) return new Response('La liga venció. Vuelve a intentarlo desde el panel.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  const admin = await platform.userById(tok.user_id!)
  if (!admin || admin.role !== 'superadmin') return new Response('No autorizado', { status: 403 })
  const { raw } = await createSession(env, request, { user: admin, kind: 'portal', tenantId, mfaOk: true, impersonatorId: admin.id, readOnly: true })
  await platform.audit({ actor_id: admin.id, actor_email: admin.email, tenant_id: tenantId, action: 'tenant.impersonation_session', ip: request.headers.get('CF-Connecting-IP') })
  return new Response(null, { status: 302, headers: { Location: `${base}/`, 'Set-Cookie': setCookie(portalCookieName(slug), raw, Math.min(sessionCookieMaxAge, 3600)), 'Cache-Control': 'no-store' } })
}

async function cron(env: Env) {
  await ensureSchema(env.DB)
  const platform = new PlatformRepo(env.DB)
  const start = Date.now()
  for (const s of await platform.pendingKbSources(10)) {
    if (Date.now() - start > 20_000) break
    await processSource(env, new TenantRepo(env.DB, s.tenant_id), s.id, 8_000)
  }
  // Retención de conversaciones por cliente
  for (const t of await platform.allTenantIds()) {
    await new TenantRepo(env.DB, t.id).purgeOlderThan(Date.now() - t.retention_days * 86_400_000)
  }
  await platform.purgeSessions()
  // Llamadas de voz que el navegador no alcanzó a guardar
  await sweepVoiceCalls(env).catch((e) => console.error('voice_sweep', e))
  // Resumen y prospecto de las conversaciones cerradas o inactivas
  await sweepAnalysis(env).catch((e) => console.error('analysis_sweep', e))
}

export { adminCookieName }
