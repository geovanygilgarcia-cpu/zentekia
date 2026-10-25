import { useEffect, useState } from 'preact/hooks'
import { toast, toastError } from '../../shared/toast.jsx'
import { CHAT_ORIGIN } from '../env.js'

const EYEBROW = {
  'Elige un asistente': 'Mis asistentes',
  Resumen: 'Canal · Chat',
  Agente: 'Chat · Personalidad',
  Conocimiento: 'Chat · Base de conocimiento',
  Modelo: 'Chat · Inteligencia',
  Widget: 'Chat · Marca',
  Instalación: 'Chat · Integración',
  Conversaciones: 'Chat · Historial',
  'Consumo y costos': 'Cuenta · Facturación',
  Equipo: 'Cuenta · Accesos',
  Seguridad: 'Cuenta · Protección',
  'Mi cuenta': 'Cuenta · Tu acceso',
  'Configura tu chat': 'Bienvenida',
  'Canal de Voz': 'Canal · Voz',
  'Canal de WhatsApp': 'Canal · WhatsApp',
}

/** Título con la última palabra en degradado (como en zentekia.com) */
function Title({ text }) {
  const i = text.lastIndexOf(' ')
  return i < 0 ? <em>{text}</em> : <>{text.slice(0, i + 1)}<em>{text.slice(i + 1)}</em></>
}

export function PageHead({ title, sub, children }) {
  return (
    <div class="page-head">
      <div>
        <span class="eyebrow">{EYEBROW[title] || 'Zentekia'}</span>
        <h1><Title text={title} /></h1>
        {sub && <p class="sub">{sub}</p>}
      </div>
      {children}
    </div>
  )
}

/** Carga datos con estado de carga/error y función para recargar */
export function useLoad(fn, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const load = () =>
    fn()
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => setError(e.message))
  useEffect(() => {
    load()
  }, deps)
  return { data, error, reload: load, setData }
}

/** Ejecuta una acción con estado "ocupado" y avisos */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const run = async (fn, okMsg) => {
    setBusy(true)
    try {
      const r = await fn()
      if (okMsg) toast(okMsg)
      return r
    } catch (e) {
      toastError(e)
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return [busy, run]
}

export const Loading = ({ error }) => (error ? <div class="alert alert-danger">{error}</div> : <div class="loading">Cargando…</div>)

export function Field({ label, hint, children }) {
  return (
    <label class="l">
      {label}
      {children}
      {hint && <span class="hint">{hint}</span>}
    </label>
  )
}

export const fileToDataUrl = (file) =>
  new Promise((ok, bad) => {
    const r = new FileReader()
    r.onload = () => ok(r.result)
    r.onerror = () => bad(new Error('No pude leer el archivo.'))
    r.readAsDataURL(file)
  })

/**
 * Ventana para probar el widget real (chat y voz).
 * En computadora es una ventana grande; en celular ocupa toda la pantalla con una barra para cerrar.
 */
export function TestWidget({ widgetKey, title = 'Prueba del chat', onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    // La X del propio widget también cierra la prueba
    const onMsg = (e) => e.origin === CHAT_ORIGIN && e.data?.source === 'zentekia-chat' && e.data.type === 'zt:close' && onClose()
    document.addEventListener('keydown', onKey)
    window.addEventListener('message', onMsg)
    document.documentElement.classList.add('no-scroll')
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('message', onMsg)
      document.documentElement.classList.remove('no-scroll')
    }
  }, [])
  return (
    <div class="modal-bg test-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="test-win" role="dialog" aria-modal="true" aria-label={title}>
        <div class="test-bar">
          <span class="test-dot" aria-hidden="true" />
          <b>{title}</b>
          <span class="small muted test-note">Así lo ven tus visitantes</span>
          <button type="button" class="test-close" onClick={onClose}>Cerrar</button>
        </div>
        <iframe title={title} allow="microphone; autoplay; clipboard-write" src={`${CHAT_ORIGIN}/w/frame?key=${widgetKey}`} />
      </div>
    </div>
  )
}
