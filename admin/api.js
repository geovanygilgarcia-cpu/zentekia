// Cliente de la API del panel. En el Worker la URL es la misma (base vacía);
// en desarrollo se puede apuntar a otro lado con window.ADMIN_API_BASE.
const BASE = (typeof window !== 'undefined' && window.ADMIN_API_BASE) || ''
const LLAVE = 'zw-admin-sesion'

export const sesion = {
  get() {
    try { return JSON.parse(sessionStorage.getItem(LLAVE) || 'null') } catch { return null }
  },
  set(v) {
    try { v ? sessionStorage.setItem(LLAVE, JSON.stringify(v)) : sessionStorage.removeItem(LLAVE) } catch { /* sin almacenamiento */ }
  },
}

let alExpirar = () => {}
export const onExpira = (fn) => { alExpirar = fn }

export async function api(ruta, { method = 'GET', body } = {}) {
  const s = sesion.get()
  let res
  try {
    res = await fetch(`${BASE}/admin/api${ruta}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(s?.token ? { Authorization: `Bearer ${s.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error('No pude conectar con el servidor. Revisa tu conexión.')
  }
  const datos = await res.json().catch(() => ({}))
  if (res.status === 401 && ruta !== '/login') {
    sesion.set(null)
    alExpirar()
  }
  if (!res.ok) throw new Error(datos.error || `Error ${res.status}`)
  return datos
}

// Prueba de un prompt: devuelve la respuesta en streaming, trozo por trozo
export async function* probar(prompt, message, signal) {
  const s = sesion.get()
  const res = await fetch(`${BASE}/admin/api/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s?.token || ''}` },
    body: JSON.stringify({ prompt, message }),
    signal,
  })
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || `Error ${res.status}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const linea = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!linea.startsWith('data:')) continue
      const d = linea.slice(5).trim()
      if (d === '[DONE]') return
      try { const t = JSON.parse(d).response; if (t) yield t } catch { /* nada */ }
    }
  }
}
