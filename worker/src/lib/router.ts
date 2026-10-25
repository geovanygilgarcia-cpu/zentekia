/** Router mínimo: patrones tipo "agents/:id/model" */
export type Params = Record<string, string>

export function match(pattern: string, path: string): Params | null {
  const a = pattern.split('/').filter(Boolean)
  const b = path.split('/').filter(Boolean)
  if (a.length !== b.length) return null
  const out: Params = {}
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!
    const v = b[i]!
    if (p.startsWith(':')) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(v)) return null
      out[p.slice(1)] = decodeURIComponent(v)
    } else if (p !== v) return null
  }
  return out
}

export const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  // Evita inyección de fórmulas al abrir el CSV en Excel
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export const toCsv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
