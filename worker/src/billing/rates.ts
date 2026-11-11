/*
  Tarifas de cobro al cliente.
  - Chat: precio por mensaje (cada respuesta del asistente).
  - Voz: precio por minuto (se cobra proporcional a los segundos).
  Orden de prioridad: precio especial del cliente → precio general (panel admin) → respaldo.
  Si no hay precio por mensaje en ningún lado, el chat se sigue cobrando por tokens (como antes).
  Los tokens se siguen midiendo siempre, para comparar en el admin.
  Importes en micro-USD.
*/
import type { Env } from '../env'
import type { TenantRow } from '../db/types'

const KEY_MESSAGE = 'price_message_micro'
const KEY_MINUTE = 'price_minute_micro'
const KEY_INC_IN = 'msg_included_in'
const KEY_INC_OUT = 'msg_included_out'

/** Precio de voz si nadie ha capturado uno (variable VOICE_PRICE_PER_MIN o 0.15 USD) */
export function fallbackMinuteMicro(env: Env): number {
  const perMin = Number(env.VOICE_PRICE_PER_MIN || '0.15')
  return Math.round((Number.isFinite(perMin) && perMin >= 0 ? perMin : 0.15) * 1e6)
}

const toMicro = (v: string | null | undefined) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

export interface GlobalRates {
  message_micro: number | null
  minute_micro: number | null
  /** Tokens incluidos en cada mensaje; lo que pase se cobra a la tarifa por token del modelo. null = sin límite */
  included_in: number | null
  included_out: number | null
}

export async function globalRates(db: D1Database): Promise<GlobalRates> {
  const r = await db.prepare('SELECT k, v FROM meta WHERE k IN (?, ?, ?, ?)').bind(KEY_MESSAGE, KEY_MINUTE, KEY_INC_IN, KEY_INC_OUT).all<{ k: string; v: string }>()
  const get = (k: string) => toMicro(r.results.find((x) => x.k === k)?.v)
  return { message_micro: get(KEY_MESSAGE), minute_micro: get(KEY_MINUTE), included_in: get(KEY_INC_IN), included_out: get(KEY_INC_OUT) }
}

export async function setGlobalRates(db: D1Database, r: Partial<GlobalRates>) {
  const stmts: D1PreparedStatement[] = []
  for (const [k, v] of [[KEY_MESSAGE, r.message_micro], [KEY_MINUTE, r.minute_micro], [KEY_INC_IN, r.included_in], [KEY_INC_OUT, r.included_out]] as const) {
    if (v === undefined) continue
    stmts.push(v === null ? db.prepare('DELETE FROM meta WHERE k = ?').bind(k) : db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(k, String(Math.round(v))))
  }
  if (stmts.length) await db.batch(stmts)
}

export interface TenantRates {
  /** null = el chat se cobra por tokens */
  message_micro: number | null
  minute_micro: number
  message_source: 'cliente' | 'general' | 'tokens'
  minute_source: 'cliente' | 'general' | 'respaldo'
  /** Tokens incluidos por mensaje (null = sin límite) */
  included_in: number | null
  included_out: number | null
}

export async function tenantRates(env: Env, tenant: TenantRow): Promise<TenantRates> {
  const g = await globalRates(env.DB)
  const tm = tenant.price_message_micro ?? null
  const tn = tenant.price_minute_micro ?? null
  return {
    message_micro: tm ?? g.message_micro,
    message_source: tm != null ? 'cliente' : g.message_micro != null ? 'general' : 'tokens',
    minute_micro: tn ?? g.minute_micro ?? fallbackMinuteMicro(env),
    minute_source: tn != null ? 'cliente' : g.minute_micro != null ? 'general' : 'respaldo',
    included_in: tenant.msg_included_in ?? g.included_in,
    included_out: tenant.msg_included_out ?? g.included_out,
  }
}

/** Excedente de un mensaje: tokens arriba de lo incluido × tarifa por token del modelo */
export function overageMicro(r: Pick<TenantRates, 'included_in' | 'included_out'>, tin: number, tout: number, price: { in_per_1m: number; out_per_1m: number }): number {
  const exIn = r.included_in == null ? 0 : Math.max(0, tin - r.included_in)
  const exOut = r.included_out == null ? 0 : Math.max(0, tout - r.included_out)
  if (!exIn && !exOut) return 0
  return Math.ceil((exIn * price.in_per_1m + exOut * price.out_per_1m) / 1_000_000)
}

/** Cobro de una llamada: proporcional a los segundos, redondeado hacia arriba */
export const voiceCost = (secs: number, minuteMicro: number) => Math.ceil((secs * minuteMicro) / 60)

/* ---------- costo real de proveedores (lo que le cuesta a Zentekia) ----------
   Solo para el panel admin: compara lo cobrado contra lo que pagas tú.
   - Modelos: precio del proveedor por 1M tokens (entrada/salida).
   - Voz: lo que ElevenLabs te cobra por minuto.
   - Modelos BYOK: el proveedor le cobra directo al cliente, así que tu costo es 0. */
const KEY_COSTS = 'provider_costs'

export interface ProviderCosts {
  models: Record<string, { in_per_1m_micro: number; out_per_1m_micro: number }>
  voice_minute_micro: number | null
}

export async function providerCosts(db: D1Database): Promise<ProviderCosts> {
  const r = await db.prepare('SELECT v FROM meta WHERE k = ?').bind(KEY_COSTS).first<{ v: string }>()
  try {
    const j = r?.v ? (JSON.parse(r.v) as Partial<ProviderCosts>) : {}
    return { models: j.models && typeof j.models === 'object' ? j.models : {}, voice_minute_micro: typeof j.voice_minute_micro === 'number' ? j.voice_minute_micro : null }
  } catch {
    return { models: {}, voice_minute_micro: null }
  }
}

export async function setProviderCosts(db: D1Database, c: ProviderCosts) {
  await db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(KEY_COSTS, JSON.stringify(c)).run()
}

/** Costo real de una fila de consumo; null = no está configurado */
export function realCost(c: ProviderCosts, row: { model_id: string; model_type: string; tokens_in: number; tokens_out: number; voice_secs: number }): number | null {
  if (row.model_type === 'voice') return c.voice_minute_micro == null ? null : Math.ceil((row.voice_secs * c.voice_minute_micro) / 60)
  if (row.model_type === 'byok') return 0
  const m = c.models[row.model_id]
  if (!m) return null
  return Math.ceil((row.tokens_in * m.in_per_1m_micro + row.tokens_out * m.out_per_1m_micro) / 1_000_000)
}
