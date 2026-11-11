/*
  Reventa: lo que el cliente cobra a SUS clientes por cada asistente.
  - Precio general del cliente (tenants.resale_json) + especial por asistente (config.resale).
  - Cada campo del especial que falte usa el general.
  - No toca lo que el cliente le paga a Zentekia: solo sirve para mostrarle su ganancia.
  Importes en micro-USD.
*/
import type { ResalePrices } from '../db/types'

export const RESALE_FIELDS = ['message_micro', 'minute_micro', 'included_in', 'included_out', 'excess_in_per_1m_micro', 'excess_out_per_1m_micro'] as const
export type ResaleField = (typeof RESALE_FIELDS)[number]

/** Limpia un objeto de precios: solo números ≥ 0 o null */
export function cleanResale(x: unknown): ResalePrices {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
  const out: ResalePrices = {}
  for (const k of RESALE_FIELDS) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.round(v)
  }
  return out
}

/** Precio vigente: el especial del asistente gana; si no, el general */
export function effectiveResale(general: ResalePrices, special: ResalePrices): Required<{ [K in ResaleField]: number | null }> {
  const r = {} as Required<{ [K in ResaleField]: number | null }>
  for (const k of RESALE_FIELDS) r[k] = special[k] ?? general[k] ?? null
  return r
}

export interface ResaleUsage {
  msgs: number
  ex_in: number
  ex_out: number
  voice_secs: number
}

/** Lo que el cliente cobra por ese consumo */
export function resaleCharge(p: ReturnType<typeof effectiveResale>, u: ResaleUsage) {
  const messages = p.message_micro == null ? 0 : u.msgs * p.message_micro
  const excess = Math.ceil(
    ((p.included_in == null || p.excess_in_per_1m_micro == null ? 0 : u.ex_in * p.excess_in_per_1m_micro) +
      (p.included_out == null || p.excess_out_per_1m_micro == null ? 0 : u.ex_out * p.excess_out_per_1m_micro)) /
      1_000_000,
  )
  const voice = p.minute_micro == null ? 0 : Math.ceil((u.voice_secs * p.minute_micro) / 60)
  return { messages, excess, voice, total: messages + excess + voice }
}
