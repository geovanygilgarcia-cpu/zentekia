/*
  Límite de frecuencia en capas (por IP, por sesión de chat y por cliente).
  Ventana deslizante en memoria de cada servidor de Cloudflare: es una primera barrera barata.
  Para un límite global estricto se puede mover a un Durable Object sin cambiar las llamadas (fase 2).
  El tope duro de gasto y de mensajes por conversación sí es global (sale de D1).
*/
const buckets = new Map<string, number[]>()

export function hit(key: string, max: number, windowMs = 60_000): boolean {
  const t = Date.now()
  const list = (buckets.get(key) || []).filter((x) => t - x < windowMs)
  if (list.length >= max) {
    buckets.set(key, list)
    return false
  }
  list.push(t)
  buckets.set(key, list)
  if (buckets.size > 20_000) buckets.clear()
  return true
}
