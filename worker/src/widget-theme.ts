import { PLANS } from './db/seed'
import { parseJson, type AgentConfig, type AgentRow, type TenantRow, type WidgetRow, type WidgetTheme } from './db/types'

export const DEFAULT_THEME: Required<Omit<WidgetTheme, 'logo_version'>> = {
  appearance: 'oscuro',
  assistant_name: 'Asistente',
  header_title: '',
  header_subtitle: 'En línea',
  primary: '#2F6BFF',
  secondary: '#1C3D8F',
  background: '#FFFFFF',
  text: '#1F2937',
  user_bubble: '#2F6BFF',
  user_text: '#FFFFFF',
  agent_bubble: '#F1F5F9',
  agent_text: '#1F2937',
  position: 'right',
  margin_x: 20,
  margin_y: 20,
  button_size: 56,
  placeholder: 'Escribe tu mensaje',
  error_message: 'Tuvimos un problema para responder. Intenta de nuevo en un momento.',
  privacy_notice: '',
  privacy_required: false,
  auto_open_delay: 0,
  sound: false,
  show_powered_by: true,
  hours_enabled: false,
  hours_timezone: 'America/Mexico_City',
  hours_days: [1, 2, 3, 4, 5],
  hours_start: '09:00',
  hours_end: '18:00',
  offline_message: 'Estamos fuera de horario. Déjanos tu mensaje y te respondemos al volver.',
}

export function mergedTheme(w: WidgetRow) {
  return { ...DEFAULT_THEME, ...parseJson<WidgetTheme>(w.theme_json, {}) }
}

/** Configuración pública del widget (lo que puede ver cualquier visitante) */
export function publicConfig(tenant: TenantRow, w: WidgetRow, agent: AgentRow, logoUrl: string | null) {
  const t = mergedTheme(w)
  const cfg = parseJson<AgentConfig>(agent.config_json, {})
  const plan = PLANS[tenant.plan_id] ?? PLANS.basico!
  return {
    version: w.version,
    suspended: tenant.status === 'suspended',
    suspended_message: tenant.status === 'suspended' ? tenant.suspended_message || 'El chat no está disponible por el momento.' : null,
    language: agent.language,
    welcome: agent.welcome_message,
    suggested: (cfg.suggested_questions || []).filter(Boolean).slice(0, 4),
    logo_url: logoUrl,
    theme: { ...t, show_powered_by: plan.canHidePoweredBy ? t.show_powered_by : true, header_title: t.header_title || t.assistant_name },
    turnstile: false,
  }
}

/** ¿Está dentro del horario de atención? */
export function withinHours(t: ReturnType<typeof mergedTheme>, at = new Date()): boolean {
  if (!t.hours_enabled) return true
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: t.hours_timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at)
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value || '')
    const hh = parts.find((p) => p.type === 'hour')?.value || '00'
    const mm = parts.find((p) => p.type === 'minute')?.value || '00'
    const cur = `${hh === '24' ? '00' : hh}:${mm}`
    return t.hours_days.includes(wd) && cur >= t.hours_start && cur < t.hours_end
  } catch {
    return true
  }
}

/* ---------- contraste WCAG ---------- */
function lum(hex: string): number {
  const m = hex.replace('#', '')
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  const rgb = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}
export function contrastProblems(t: ReturnType<typeof mergedTheme>): string[] {
  // En apariencia oscura el fondo, el texto y la burbuja del agente los pone el diseño (ya cumplen contraste)
  const pairs: Array<[string, string, string]> = [
    [t.user_text, t.user_bubble, 'texto sobre burbuja del usuario'],
    ['#FFFFFF', t.primary, 'texto blanco sobre color principal'],
    ...(t.appearance === 'claro'
      ? ([
          [t.agent_text, t.agent_bubble, 'texto sobre burbuja del agente'],
          [t.text, t.background, 'texto sobre fondo'],
        ] as Array<[string, string, string]>)
      : []),
  ]
  return pairs.filter(([a, b]) => contrast(a, b) < 4.5).map(([a, b, label]) => `${label} (${contrast(a, b).toFixed(1)}:1, mínimo 4.5:1)`)
}
