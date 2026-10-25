/* Cliente HTTP del panel y del portal: cookie de sesión + encabezado X-CSRF en cambios */
export function createApi(base) {
  let csrf = null
  let onUnauth = null
  async function req(method, path, body) {
    const headers = {}
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json'
    if (method !== 'GET' && csrf) headers['X-CSRF'] = csrf
    let r
    try {
      r = await fetch(`${base}/${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) })
    } catch {
      throw Object.assign(new Error('No hay conexión con el servidor.'), { code: 'network' })
    }
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const e = Object.assign(new Error(j.error?.message || `Error ${r.status}`), { code: j.error?.code, status: r.status })
      if (r.status === 401 && !path.startsWith('auth/') && onUnauth) onUnauth()
      throw e
    }
    return j
  }
  return {
    base,
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b ?? {}),
    put: (p, b) => req('PUT', p, b ?? {}),
    del: (p) => req('DELETE', p),
    setCsrf: (c) => (csrf = c),
    onUnauthorized: (fn) => (onUnauth = fn),
  }
}

export const usd = (micro, digits) => {
  const v = (micro || 0) / 1e6
  const d = digits ?? (v !== 0 && Math.abs(v) < 0.01 ? 4 : 2)
  return '$' + v.toLocaleString('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d })
}
export const perM = (micro) => '$' + ((micro || 0) / 1e6).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
export const num = (n) => (n || 0).toLocaleString('es-MX')
export const date = (t) => new Date(t).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })
export const day = (t) => new Date(t).toLocaleDateString('es-MX', { dateStyle: 'medium' })
