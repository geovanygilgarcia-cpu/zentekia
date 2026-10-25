import React, { useState } from 'react'
import './demo.css'
import ChatWidget from '../widget/ChatWidget.jsx'
import { defaultConfig, agentes, configDe } from '../config.js'
import { iniciarSesion } from '../widget/api.js'

// Sesión de admin guardada solo en esta pestaña (se borra al cerrarla)
const LLAVE = 'prakticall-chat-sesion'
const sesion = {
  get() {
    try { return JSON.parse(sessionStorage.getItem(LLAVE) || 'null') } catch { return null }
  },
  set(v) {
    try { v ? sessionStorage.setItem(LLAVE, JSON.stringify(v)) : sessionStorage.removeItem(LLAVE) } catch { /* sin almacenamiento */ }
  },
}

const COLORES = [
  { nombre: 'Azul', valor: '#2f6bff' },
  { nombre: 'Verde', valor: '#0c7a45' },
  { nombre: 'Grafito', valor: '#2b3140' },
  { nombre: 'Terracota', valor: '#c2410c' },
  { nombre: 'Violeta', valor: '#6d4aff' },
]

const ETAPAS = [
  { k: 'Sitio web', d: 'La página de Prakticall o la de cualquier cliente.' },
  { k: 'Widget', d: 'Este botón flotante, hecho en React. Guarda las conversaciones en el navegador.' },
  { k: 'Cloudflare Worker', d: 'Recibe los mensajes, agrega las instrucciones del negocio y limita abusos.' },
  { k: 'Workers AI', d: 'Qwen3 30B responde el chat. Modelo abierto y gratuito.' },
]

export default function DemoPage() {
  const [usuario, setUsuario] = useState(() => sesion.get())
  const [aviso, setAviso] = useState(null)

  if (!usuario) {
    return (
      <Login
        aviso={aviso}
        onEntrar={(s) => { sesion.set(s); setAviso(null); setUsuario(s) }}
      />
    )
  }

  const salir = (msg = null) => { sesion.set(null); setAviso(msg); setUsuario(null) }
  return <Pagina sesionActual={usuario} onSalir={salir} />
}

function Login({ onEntrar, aviso }) {
  const [u, setU] = useState('admin')
  const [p, setP] = useState('')
  const [error, setError] = useState(aviso)
  const [cargando, setCargando] = useState(false)

  const entrar = async (e) => {
    e.preventDefault()
    setCargando(true)
    setError(null)
    try {
      const r = await iniciarSesion({ apiUrl: defaultConfig.apiUrl, usuario: u, contrasena: p })
      onEntrar({ token: r.token, usuario: r.usuario })
    } catch (err) {
      setError(err.message)
    } finally {
      setCargando(false)
    }
  }

  return (
    <div className="dm dm-login">
      <form className="dm-card dm-login-card" onSubmit={entrar}>
        <div>
          <p className="dm-eyebrow">Prakticall · agentes virtuales</p>
          <h1 className="dm-login-title">Solo <em>administradores</em></h1>
          <p className="dm-hint">Entra con el mismo usuario y contraseña del panel <code>/admin</code>.</p>
        </div>
        <div className="dm-field">
          <label htmlFor="dm-user">Usuario</label>
          <input id="dm-user" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} />
        </div>
        <div className="dm-field">
          <label htmlFor="dm-pass">Contraseña</label>
          <input id="dm-pass" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} autoFocus />
        </div>
        {error && <p className="dm-error" role="alert">{error}</p>}
        <button className="dm-btn" disabled={cargando || !p}>{cargando ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  )
}

function Pagina({ sesionActual, onSalir }) {
  const [config, setConfig] = useState(defaultConfig)
  const set = (k) => (v) => setConfig((c) => ({ ...c, [k]: v }))
  const abrirAlInicio = typeof window !== 'undefined' && window.innerWidth > 900

  return (
    <div className="dm">
      <main className="dm-wrap">
        <header className="dm-head">
          <div className="dm-topbar">
            <p className="dm-eyebrow">Prakticall · agentes virtuales</p>
            <span className="dm-user">
              {sesionActual.usuario}
              <button className="dm-link" onClick={() => onSalir()}>Salir</button>
            </span>
          </div>
          <h1>
            Chat <em>con IA abierta</em>
          </h1>
          <p className="dm-lede">
            Elige un caso y abre el widget de la esquina para conversar con el agente.
            Todo corre con modelos abiertos y gratuitos de Cloudflare Workers AI.
          </p>
        </header>

        <section className="dm-card" aria-labelledby="dm-ajustes">
          <h2 id="dm-ajustes">Ajustes del agente</h2>

          <div className="dm-field">
            <span className="dm-label" id="dm-agente-label">Agente</span>
            <div className="dm-agents" role="radiogroup" aria-labelledby="dm-agente-label">
              {agentes.map((a) => (
                <button
                  key={a.agent}
                  role="radio"
                  aria-checked={config.agent === a.agent}
                  className="dm-agent"
                  onClick={() => setConfig((c) => ({ ...configDe(a.agent), accent: c.accent, apiUrl: c.apiUrl }))}
                >
                  {a.etiqueta}
                </button>
              ))}
            </div>
            <p className="dm-hint">Cada agente usa su propio prompt, que editas en el panel <code>/admin</code>.</p>
          </div>

          <div className="dm-field">
            <label htmlFor="dm-nombre">Nombre del agente</label>
            <input id="dm-nombre" value={config.name} maxLength={18} onChange={(e) => set('name')(e.target.value || 'Agente')} />
          </div>

          <div className="dm-field">
            <span className="dm-label" id="dm-color-label">Color de la marca</span>
            <div className="dm-swatches" role="radiogroup" aria-labelledby="dm-color-label">
              {COLORES.map((c) => (
                <button
                  key={c.valor}
                  role="radio"
                  aria-checked={config.accent === c.valor}
                  title={c.nombre}
                  aria-label={c.nombre}
                  className="dm-swatch"
                  style={{ '--sw': c.valor }}
                  onClick={() => set('accent')(c.valor)}
                />
              ))}
            </div>
          </div>

          <div className="dm-field">
            <label htmlFor="dm-api">URL del Worker</label>
            <input
              id="dm-api"
              placeholder="https://agente.tu-cuenta.workers.dev"
              value={config.apiUrl}
              onChange={(e) => set('apiUrl')(e.target.value.trim())}
              spellCheck={false}
            />
            <p className="dm-hint">
              <span className={'dm-pill' + (config.apiUrl ? ' is-live' : '')}>{config.apiUrl ? 'Conectado al modelo' : 'Modo demo'}</span>
              Déjalo vacío para usar las respuestas de ejemplo.
            </p>
          </div>
        </section>

        <section className="dm-flow" aria-labelledby="dm-como">
          <h2 id="dm-como">Cómo va a funcionar</h2>
          <ol>
            {ETAPAS.map((e) => (
              <li key={e.k} className="is-done">
                <strong>{e.k}</strong>
                <span>{e.d}</span>
                <small>Funcionando</small>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <ChatWidget
        config={config}
        defaultOpen={abrirAlInicio}
        token={sesionActual.token}
        onSesionExpirada={() => onSalir('Tu sesión expiró. Vuelve a entrar.')}
      />
    </div>
  )
}
