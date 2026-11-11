/*
  Precios por token.
    costo_mensaje = tokens_in × precio_in + tokens_out × precio_out
  - Modelo hosted (Workers AI de Zentekia): precio = tarifa del modelo (incluye inferencia + margen).
  - Modelo BYOK: precio = fee de plataforma (el proveedor le cobra aparte al cliente).
  - Si el cliente tiene override vigente, se usa (precios propios o % de descuento).
  - Cada registro guarda la versión de tarifa usada, así un cambio de precio no altera el histórico.
  Importes en micro-USD.
*/
import { PlatformRepo } from '../db/platform-repo'
import type { TenantRepo } from '../db/tenant-repo'
import type { ModelRow } from '../db/types'

export interface EffectivePrice {
  in_per_1m: number
  out_per_1m: number
  version: string
  source: 'list' | 'override'
}

export async function effectivePrice(platform: PlatformRepo, repo: TenantRepo, model: ModelRow, at = Date.now()): Promise<EffectivePrice> {
  const p = await platform.currentPrice(model.id, at)
  const hosted = model.type === 'hosted'
  let inP = p ? (hosted ? p.input_per_1m_micro : p.fee_input_per_1m_micro) : 0
  let outP = p ? (hosted ? p.output_per_1m_micro : p.fee_output_per_1m_micro) : 0
  let version = p ? `list:${p.id}` : 'list:none'
  let source: EffectivePrice['source'] = 'list'
  const o = await repo.overrideFor(model.id, at)
  if (o) {
    const oi = hosted ? o.input_per_1m_micro : o.fee_input_per_1m_micro
    const oo = hosted ? o.output_per_1m_micro : o.fee_output_per_1m_micro
    if (oi != null) inP = oi
    if (oo != null) outP = oo
    if (o.discount_pct != null) {
      inP = Math.round((inP * (100 - o.discount_pct)) / 100)
      outP = Math.round((outP * (100 - o.discount_pct)) / 100)
    }
    version += `+override:${o.id}`
    source = 'override'
  }
  return { in_per_1m: inP, out_per_1m: outP, version, source }
}

/** Costo en micro-USD (redondeo hacia arriba por mensaje para no perder fracciones) */
export function costMicro(tokensIn: number, tokensOut: number, price: Pick<EffectivePrice, 'in_per_1m' | 'out_per_1m'>): number {
  return Math.ceil((tokensIn * price.in_per_1m + tokensOut * price.out_per_1m) / 1_000_000)
}

export const fmtUsd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro !== 0 && Math.abs(micro) < 10_000 ? 4 : 2)} USD`
