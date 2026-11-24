/*
  Productos que Zentekia le activa a cada cliente desde el panel de administración:
    - Agentes virtuales (va): asistentes de IA (portal actual).
    - Contact center (cc): agentes humanos que inician sesión en /cc/ y atienden chat web y WhatsApp.
      Se cobra por licencia de agente humano: cada usuario con rol «agente» o «supervisor» ocupa una.
  Un cliente puede tener uno, otro o los dos.
*/
import type { TenantRow } from '../db/types'

export interface Products {
  va: boolean
  cc: boolean
  /** Licencias de agente humano contratadas */
  cc_seats: number
  /** Precio mensual por licencia (micro-USD); null = el general */
  cc_seat_price_micro: number | null
}

/** Precio general por licencia de agente humano (micro-USD al mes) si el cliente no tiene uno especial */
export const DEFAULT_SEAT_PRICE_MICRO = 25_000_000

/** Clientes anteriores a los productos: solo agentes virtuales */
export function productsOf(t: Pick<TenantRow, 'products_json'>): Products {
  let p: Partial<Products> = {}
  try {
    p = t.products_json ? (JSON.parse(t.products_json) as Partial<Products>) : {}
  } catch {
    p = {}
  }
  return {
    va: p.va !== false,
    cc: p.cc === true,
    cc_seats: Math.max(0, Math.min(10_000, Math.floor(Number(p.cc_seats ?? 0)) || 0)),
    cc_seat_price_micro: p.cc_seat_price_micro == null ? null : Math.max(0, Math.floor(Number(p.cc_seat_price_micro)) || 0),
  }
}

/** Roles que ocupan licencia del contact center */
export const LICENSED_ROLES = ['agent', 'supervisor'] as const
export const isLicensedRole = (r: string) => (LICENSED_ROLES as readonly string[]).includes(r)
