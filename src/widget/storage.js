// Conversaciones guardadas en el navegador del visitante (si el navegador lo permite).
const KEY = 'prakticall-conversaciones-v1'

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

export function cargar() {
  try {
    const raw = localStorage.getItem(KEY)
    const lista = raw ? JSON.parse(raw) : null
    return Array.isArray(lista) ? lista : null
  } catch {
    return null
  }
}

export function guardar(lista) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lista.slice(0, 30)))
  } catch {
    /* sin almacenamiento: la conversación vive solo en memoria */
  }
}

export function nuevaConversacion(greeting, agent) {
  const ahora = Date.now()
  return {
    id: uid(),
    agent,
    title: 'Nueva conversación',
    createdAt: ahora,
    updatedAt: ahora,
    messages: [{ id: uid(), role: 'assistant', content: greeting, ts: ahora }],
  }
}

export function tituloDesde(texto) {
  const t = texto.replace(/\s+/g, ' ').trim()
  return t.length > 42 ? t.slice(0, 40).trimEnd() + '…' : t
}
