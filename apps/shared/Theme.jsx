import { useEffect, useState } from 'preact/hooks'

const KEY = 'zt-theme'
const saved = () => {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : null
  } catch {
    return null
  }
}
const system = () => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
export const currentTheme = () => document.documentElement.getAttribute('data-theme') || saved() || system()

const listeners = new Set()
export function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t)
  try {
    localStorage.setItem(KEY, t)
  } catch {}
  listeners.forEach((fn) => fn(t))
}
// Si la persona nunca eligió, sigue al sistema (por ejemplo, el celular cambia a oscuro de noche)
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if (!saved()) {
    const t = system()
    document.documentElement.setAttribute('data-theme', t)
    listeners.forEach((fn) => fn(t))
  }
})

export function useTheme() {
  const [t, setT] = useState(currentTheme)
  useEffect(() => {
    listeners.add(setT)
    return () => listeners.delete(setT)
  }, [])
  return [t, setTheme]
}

export const Sun = ({ size = 18 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
  </svg>
)
export const Moon = ({ size = 18 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
    <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" />
  </svg>
)

/** Botón redondo: muestra el sol en oscuro (para pasar a claro) y la luna en claro */
export function ThemeToggle({ className = '' }) {
  const [t, set] = useTheme()
  const next = t === 'dark' ? 'light' : 'dark'
  const label = next === 'light' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'
  return (
    <button type="button" class={`theme-btn ${className}`} onClick={() => set(next)} title={label} aria-label={label}>
      {t === 'dark' ? <Sun /> : <Moon />}
    </button>
  )
}

/** Selector Claro / Oscuro (pie del menú lateral) */
export function ThemeSwitch({ className = '' }) {
  const [t, set] = useTheme()
  return (
    <div class={`theme-seg ${className}`} role="group" aria-label="Tema">
      <button type="button" aria-pressed={t === 'light'} onClick={() => set('light')}><Sun size={15} />Claro</button>
      <button type="button" aria-pressed={t === 'dark'} onClick={() => set('dark')}><Moon size={15} />Oscuro</button>
    </div>
  )
}

/* Tamaño de letra (para leer más cómodo). Se guarda por navegador. */
const SIZE_KEY = 'zt-size'
export const SIZES = [
  { id: 'md', label: 'Normal', zoom: 1 },
  { id: 'lg', label: 'Grande', zoom: 1.12 },
  { id: 'xl', label: 'Muy grande', zoom: 1.25 },
]
const curSize = () => document.documentElement.getAttribute('data-size') || 'md'
/** Factor de zoom actual (lo usan los menús que se posicionan con coordenadas) */
export const uiZoom = () => SIZES.find((s) => s.id === curSize())?.zoom || 1
export function useTextSize() {
  const [s, setS] = useState(curSize)
  const set = (v) => {
    if (v === 'md') document.documentElement.removeAttribute('data-size')
    else document.documentElement.setAttribute('data-size', v)
    try {
      localStorage.setItem(SIZE_KEY, v)
    } catch {}
    setS(v)
  }
  return [s, set]
}
