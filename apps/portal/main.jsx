import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { createApi } from '../shared/api.js'
import { AuthGate } from '../shared/Auth.jsx'
import { Toasts } from '../shared/toast.jsx'
import UserMenu from '../shared/UserMenu.jsx'
import { ThemeSwitch, ThemeToggle } from '../shared/Theme.jsx'
import { stackTablesOnMobile } from '../shared/tableStack.js'
import Agente from './sections/Agente.jsx'
import Conocimiento from './sections/Conocimiento.jsx'
import Modelo from './sections/Modelo.jsx'
import Widget from './sections/Widget.jsx'
import Instalacion from './sections/Instalacion.jsx'
import Conversaciones from './sections/Conversaciones.jsx'
import Consumo from './sections/Consumo.jsx'
import Equipo from './sections/Equipo.jsx'
import Seguridad from './sections/Seguridad.jsx'
import Wizard from './sections/Wizard.jsx'
import Asistentes, { AgentAvatar } from './sections/Asistentes.jsx'
import Resumen from './sections/Resumen.jsx'
import Proximamente from './sections/Proximamente.jsx'
import Voz from './sections/Voz.jsx'
import MiCuenta from './sections/MiCuenta.jsx'
import { Icon } from './sections/icons.jsx'
import './portal.css'

const root = document.getElementById('root')
const api = createApi(root.dataset.base)

/* Secciones del canal Chat (dentro de un asistente) */
const CHAT_SECTIONS = [
  { id: 'resumen', label: 'Resumen', icon: 'home', C: Resumen, roles: ['owner', 'editor'] },
  { id: 'agente', label: 'Agente', icon: 'spark', C: Agente, roles: ['owner', 'editor'] },
  { id: 'conocimiento', label: 'Conocimiento', icon: 'book', C: Conocimiento, roles: ['owner', 'editor'] },
  { id: 'modelo', label: 'Modelo', icon: 'cpu', C: Modelo, roles: ['owner'] },
  { id: 'widget', label: 'Widget', icon: 'brush', C: Widget, roles: ['owner', 'editor'] },
  { id: 'instalacion', label: 'Instalación', icon: 'code', C: Instalacion, roles: ['owner', 'editor'] },
  { id: 'conversaciones', label: 'Conversaciones', icon: 'chat', C: Conversaciones, roles: ['owner', 'editor'] },
]
/* Secciones de la cuenta (no dependen del asistente) */
const ACCOUNT_SECTIONS = [
  { id: 'consumo', label: 'Consumo y costos', icon: 'chart', C: Consumo, roles: ['owner'] },
  { id: 'equipo', label: 'Equipo', icon: 'users', C: Equipo, roles: ['owner'] },
  { id: 'seguridad', label: 'Seguridad', icon: 'shield', C: Seguridad, roles: ['owner'] },
  { id: 'cuenta', label: 'Mi cuenta', icon: 'user', C: MiCuenta, roles: ['owner', 'editor'] },
]
/* Canales del asistente. Para activar uno nuevo: cambia su estado en el backend (overview → channels) y agrega sus secciones. */
export const CHANNELS = [
  { id: 'chat', label: 'Chat', home: 'resumen' },
  { id: 'voz', key: 'voice', label: 'Voz', home: 'voz' },
  { id: 'whatsapp', key: 'whatsapp', label: 'WhatsApp', home: 'whatsapp' },
]

/**
 * Rutas:
 *   #/                       → mis asistentes
 *   #/consumo · #/equipo …   → secciones de la cuenta
 *   #/a/<id>                 → resumen del asistente (canal Chat)
 *   #/a/<id>/<sección>       → sección del asistente (agente, widget, voz, whatsapp, bienvenida…)
 *   #/a/<id>/conversaciones/<conv> → abre esa conversación (liga del aviso de prospecto)
 */
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'a' && parts[1]) return { agentId: decodeURIComponent(parts[1]), section: parts[2] || 'resumen', param: parts[3] ? decodeURIComponent(parts[3]) : null }
  return { agentId: null, section: parts[0] || 'asistentes' }
}

const SS_KEY = 'zc-agent'
const lastAgent = () => {
  try {
    return sessionStorage.getItem(SS_KEY)
  } catch {
    return null
  }
}

function Portal({ me, logout, reloadMe }) {
  const [ov, setOv] = useState(null)
  const [r, setR] = useState(parseHash())
  const role = me.user.role
  const roleLabel = me.impersonating ? 'Soporte · solo lectura' : { owner: 'Propietario', editor: 'Editor' }[role] || role

  const loadOverview = () => api.get('overview').then(setOv)
  useEffect(() => {
    loadOverview()
    const onHash = () => {
      setR(parseHash())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!ov) return <div class="loading">Cargando tu portal…</div>

  const chatSections = CHAT_SECTIONS.filter((s) => s.roles.includes(role))
  const accountSections = ACCOUNT_SECTIONS.filter((s) => s.roles.includes(role))
  const agent = r.agentId ? ov.agents.find((a) => a.id === r.agentId) : null

  // Ligas viejas (#/agente, #/widget…): llevan al último asistente abierto
  if (!r.agentId && (chatSections.some((s) => s.id === r.section) || r.section === 'bienvenida')) {
    const id = (ov.agents.find((a) => a.id === lastAgent()) || ov.agents[0])?.id
    if (id) {
      location.replace(`#/a/${id}/${r.section}`)
      return null
    }
  }
  if (r.agentId && !agent) {
    location.replace('#/')
    return null
  }
  if (agent) {
    try {
      sessionStorage.setItem(SS_KEY, agent.id)
    } catch {}
  }

  const base = agent ? `#/a/${agent.id}` : '#'
  const go = (id) => {
    if (agent) location.hash = `${base}/${id}`
    else if (accountSections.some((s) => s.id === id) || id === 'asistentes') location.hash = `#/${id}`
    else if (ov.agents[0]) location.hash = `#/a/${(ov.agents.find((a) => a.id === lastAgent()) || ov.agents[0]).id}/${id}`
  }
  const props = { api, me, ov, agentId: agent?.id, agent, reload: loadOverview, reloadMe, go, readOnly: me.read_only, param: r.param }

  // ¿Qué se muestra en el área principal?
  let view
  let channel = 'chat'
  let activeNav = r.section
  if (!agent) {
    const acc = accountSections.find((s) => s.id === r.section)
    view = acc ? <acc.C key={acc.id} {...props} /> : <Asistentes {...props} />
    if (!acc) activeNav = 'asistentes'
  } else if (r.section === 'voz' || r.section === 'whatsapp') {
    channel = r.section
    view = r.section === 'voz' && ov.voice_available ? <Voz key={'voz' + agent.id} {...props} /> : <Proximamente key={r.section} channel={r.section} {...props} />
  } else if (r.section === 'bienvenida') {
    view = <Wizard {...props} done={() => { loadOverview(); go('resumen') }} />
  } else {
    const s = [...chatSections, ...accountSections].find((x) => x.id === r.section) || chatSections[0]
    activeNav = s.id
    view = <s.C key={s.id + agent.id} {...props} />
  }

  const NavLink = ({ s, href }) => (
    <a class={'nv' + (activeNav === s.id ? ' on' : '')} href={href} aria-current={activeNav === s.id ? 'page' : undefined}>
      <span class="nv-ic" aria-hidden="true"><Icon name={s.icon} /></span>
      {s.label}
    </a>
  )
  const unread = ov.alerts?.filter((a) => !a.read_at) || []

  return (
    <>
      {me.impersonating && <div class="banner">Estás viendo el portal de <b>{ov.tenant.name}</b> como soporte de Zentekia, en modo solo lectura.</div>}
      {ov.tenant.status === 'suspended' && <div class="banner">Esta cuenta está suspendida: el cliente no puede entrar y sus asistentes no responden.</div>}
      <div class={'app' + (agent ? ' in-agent' : '')}>
        <aside class="side">
          {agent ? (
            <>
              <a class="side-back" href="#/"><Icon name="back" size={15} />Todos los asistentes</a>
              <div class="side-agent">
                <AgentAvatar agent={agent} size={34} />
                <span class="side-agent-name">{agent.name}</span>
              </div>
            </>
          ) : (
            <>
              <div class="brand">zentekia<b>.</b><small>AGENTES IA</small></div>
              <div class="host">{ov.tenant.portal}</div>
            </>
          )}
          <div class="side-acct">
            <ThemeToggle />
            <UserMenu variant="icon" user={me.user} roleLabel={roleLabel} onLogout={logout} onAccount={() => go('cuenta')} />
          </div>
          <nav aria-label="Secciones">
            {agent ? (
              <>
                <div class="nv-group">Canal · {CHANNELS.find((c) => c.id === channel).label}</div>
                {channel === 'chat' ? (
                  chatSections.map((s) => <NavLink key={s.id} s={s} href={`${base}/${s.id}`} />)
                ) : (
                  <a class="nv on" href={`${base}/${channel}`} aria-current="page"><span class="nv-ic" aria-hidden="true"><Icon name={channel === 'voz' && ov.voice_available ? 'voz' : 'clock'} /></span>{channel === 'voz' && ov.voice_available ? 'Configuración' : 'Próximamente'}</a>
                )}
                {accountSections.length > 0 && <div class="nv-group">Cuenta</div>}
                {accountSections.map((s) => <NavLink key={s.id} s={s} href={`${base}/${s.id}`} />)}
              </>
            ) : (
              <>
                <NavLink s={{ id: 'asistentes', label: 'Asistentes', icon: 'grid' }} href="#/" />
                {accountSections.map((s) => <NavLink key={s.id} s={s} href={`#/${s.id}`} />)}
              </>
            )}
          </nav>
          <div class="foot">
            <ThemeSwitch />
            <UserMenu variant="card" user={me.user} roleLabel={roleLabel} onLogout={logout} onAccount={() => go('cuenta')} />
          </div>
        </aside>
        <main class="main" id="main">
          {agent && (
            <div class="ch-head">
              <div class="crumbs"><a href="#/">Asistentes</a> / <span>{agent.name}</span></div>
              <div class="ch-tabs" role="tablist" aria-label="Canales">
                {CHANNELS.map((c) => {
                  const state = c.key ? agent.channels?.[c.key] || 'soon' : agent.channels?.chat || 'active'
                  const on = channel === c.id
                  return (
                    <a key={c.id} role="tab" aria-selected={on} class={'ch-tab' + (on ? ' on' : '')} href={`${base}/${c.home}`}>
                      <Icon name={c.id} size={16} />
                      {c.label}
                      {state === 'active' ? <span class="ch-live">Activo</span> : state === 'available' ? <span class="ch-soon ch-avail">Sin activar</span> : state === 'off' ? <span class="ch-soon ch-off">Apagado</span> : <span class="ch-soon">Próximamente</span>}
                    </a>
                  )
                })}
              </div>
            </div>
          )}
          {unread.length > 0 && r.section !== 'bienvenida' && (
            <div class="alert alert-warn" style="margin-bottom:18px">
              {unread.slice(0, 3).map((a) => (
                <div key={a.id}>{a.message}</div>
              ))}
              {!me.read_only && (
                <button class="link" style="margin-top:6px;color:inherit" onClick={() => api.post('alerts/read').then(loadOverview)}>Marcar como leídas</button>
              )}
            </div>
          )}
          {view}
        </main>
      </div>
    </>
  )
}

stackTablesOnMobile(root)

function App() {
  return (
    <>
      <AuthGate api={api} title="Zentekia" subtitle={root.dataset.tenant}>
        {({ me, logout, reload }) => <Portal me={me} logout={logout} reloadMe={reload} />}
      </AuthGate>
      <Toasts />
    </>
  )
}

render(<App />, root)
