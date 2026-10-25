/*
  Dos modos de dominio:
  1) Sin BASE_DOMAIN (p. ej. agente-zentekia.<tu-cuenta>.workers.dev): todo por rutas en el mismo host
       /admin/            panel de superadmin
       /p/<slug>/         portal de cada cliente
       /widget.js, /w/... widget y API pública
  2) Con BASE_DOMAIN = "zentekia.com":
       chat.zentekia.com   widget y API pública
       app.zentekia.com    panel de superadmin (admin.zentekia.com también funciona)
       <slug>.zentekia.com portal de cada cliente
*/
import type { Env } from '../env'

export type Area = { kind: 'combined' } | { kind: 'chat' } | { kind: 'admin' } | { kind: 'api' } | { kind: 'portal'; slug: string } | { kind: 'unknown' }

// Subdominios de la plataforma. No se pueden usar como slug de cliente.
const PLATFORM_SUBS: Record<string, 'chat' | 'admin' | 'api'> = {
  chat: 'chat',
  app: 'admin',
  admin: 'admin',
  api: 'api',
}

export function baseDomain(env: Env): string {
  return (env.BASE_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '')
}

export function areaFor(env: Env, url: URL): Area {
  const base = baseDomain(env)
  const host = url.hostname.toLowerCase()
  if (!base || host === base || host === `www.${base}` || !host.endsWith(`.${base}`)) return { kind: 'combined' }
  const sub = host.slice(0, -(base.length + 1))
  if (sub.includes('.')) return { kind: 'unknown' } // comodín de un solo nivel
  const platform = PLATFORM_SUBS[sub]
  if (platform) return { kind: platform }
  return { kind: 'portal', slug: sub }
}

export function chatOrigin(env: Env, url: URL): string {
  const base = baseDomain(env)
  return base ? `https://chat.${base}` : url.origin
}

export function adminUrl(env: Env, url: URL): string {
  const base = baseDomain(env)
  return base ? `https://app.${base}/` : `${url.origin}/admin/`
}

export function portalUrl(env: Env, url: URL, slug: string): string {
  const base = baseDomain(env)
  return base ? `https://${slug}.${base}/` : `${url.origin}/p/${slug}/`
}

export function portalOrigin(env: Env, url: URL, slug: string): string {
  return new URL(portalUrl(env, url, slug)).origin
}

export function portalHostLabel(env: Env, url: URL, slug: string): string {
  const base = baseDomain(env)
  return base ? `${slug}.${base}` : `${url.host}/p/${slug}`
}

/** Normaliza un dominio permitido a origen ("https://tienda.com") */
export function normalizeOrigin(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (!s) return null
  if (!/^https?:\/\//.test(s)) s = 'https://' + s
  try {
    const u = new URL(s)
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null
    return u.origin
  } catch {
    return null
  }
}