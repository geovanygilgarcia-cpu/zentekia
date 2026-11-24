/*
  Zentekia Contact Center (/cc/ del portal de cada cliente).
  Producto aparte de los agentes virtuales: aquí entran los agentes humanos, se ponen en línea y atienden
  chat web y WhatsApp. Mismo inicio de sesión y misma API que el portal (cookie del cliente + /v1).
    #/                     bandeja (todas las personas)
    #/supervision          equipo en línea, colas, respuestas rápidas y métricas (supervisor y admins)
    #/canales[/<id>/<tab>] canales sin IA: chat web (widget e instalación) y WhatsApp (admins)
    #/seguridad · #/equipo  dominios autorizados y personas con licencias (owner)
    #/cuenta               mi cuenta
*/
import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { createApi } from '../shared/api.js'
import { AuthGate } from '../shared/Auth.jsx'
import { Toasts } from '../shared/toast.jsx'
import UserMenu from '../shared/UserMenu.jsx'
import { ThemeSwitch, ThemeToggle } from '../shared/Theme.jsx'
import { stackTablesOnMobile } from '../shared/tableStack.js'
import { Inbox, InboxConfig, Presence } from '../portal/sections/Bandeja.jsx'
import Equipo from '../portal/sections/Equipo.jsx'
import Seguridad from '../portal/sections/Seguridad.jsx'
import MiCuenta from '../portal/sections/MiCuenta.jsx'
import { PageHead } from '../portal/sections/common.jsx'
import { Icon } from '../portal/sections/icons.jsx'
import Canales from './Canales.jsx'
import '../portal/portal.css'
import './cc.css'

const root = document.getElementById('root')
const api = createApi(root.dataset.base)
const PORTAL = root.dataset.portal
const HAS_VA = root.dataset.va === '1'

const ROLE_LABEL = { owner: 'Propietario', editor: 'Administrador', supervisor: 'Supervisor', agent: 'Agente' }
const LEAD = ['owner', 'editor', 'supervisor']
const ADMIN = ['owner', 'editor']

const SECTIONS = [
  { id: 'bandeja', label: 'Bandeja', icon: 'inbox', roles: ['owner', 'editor', 'supervisor', 'agent'] },
  { id: 'supervision', label: 'Supervisión', icon: 'users', roles: LEAD },
  { id: 'canales', label: 'Canales', icon: 'chat', roles: ADMIN },
  { id: 'equipo', label: 'Equipo y licencias', icon: 'user', roles: ['owner'] },
  { id: 'seguridad', label: 'Seguridad', icon: 'shield', roles: ['owner'] },
  { id: 'cuenta', label: 'Mi cuenta', icon: 'user', roles: ['owner', 'editor', 'supervisor', 'agent'] },
]

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  return { section: parts[0] || 'bandeja', a: parts[1] || null, b: parts[2] || null }
}

function ContactCenter({ me, logout, reloadMe }) {
  const [r, setR] = useState(parseHash())
  const [boot, setBoot] = useState(null)
  const [error, setError] = useState(null)
  const role = me.impersonating ? 'owner' : me.user.role
  const readOnly = Boolean(me.read_only)
  const loadBoot = () => api.get('inbox/bootstrap').then(setBoot).catch((e) => setError(e.message))
  useEffect(() => {
    loadBoot()
    const onHash = () => setR(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (!boot) return <div class="loading" style="padding:40px">{error || 'Cargando el Contact Center…'}</div>

  const sections = SECTIONS.filter((s) => s.roles.includes(role))
  const s = sections.find((x) => x.id === r.section) || sections[0]
  const roleLabel = me.impersonating ? 'Soporte · solo lectura' : ROLE_LABEL[role] || role
  const go = (id) => (location.hash = `#/${id}`)
  const props = { api, me, readOnly, reloadMe, go }

  let view
  if (s.id === 'bandeja') view = <Inbox api={api} boot={boot} reloadBoot={loadBoot} readOnly={readOnly} />
  else if (s.id === 'supervision')
    view = (
      <>
        <PageHead title="Supervisión" sub="Quién está en línea, cuánta carga tiene cada persona, colas, respuestas rápidas y tiempos de atención." />
        <InboxConfig api={api} boot={boot} reloadBoot={loadBoot} readOnly={readOnly} />
      </>
    )
  else if (s.id === 'canales') view = <Canales {...props} channelId={r.a} tab={r.b} />
  else if (s.id === 'equipo') view = <Equipo {...props} />
  else if (s.id === 'seguridad') view = <Seguridad {...props} />
  else view = <MiCuenta {...props} />

  return (
    <>
      {me.impersonating && <div class="banner">Estás viendo el Contact Center como soporte de Zentekia, en modo solo lectura.</div>}
      <div class={'app cc-app' + (s.id === 'bandeja' ? ' cc-full' : '')}>
        <aside class="side">
          <div class="brand">zentekia<b>.</b><small>CONTACT CENTER</small></div>
          <div class="host">{root.dataset.tenant}</div>
          <div class="side-acct">
            <ThemeToggle />
            <UserMenu variant="icon" user={me.user} roleLabel={roleLabel} onLogout={logout} onAccount={() => go('cuenta')} />
          </div>
          <div class="cc-presence"><Presence api={api} boot={boot} reload={loadBoot} readOnly={readOnly} /></div>
          <nav aria-label="Secciones">
            {sections.map((x) => (
              <a key={x.id} class={'nv' + (s.id === x.id ? ' on' : '')} href={`#/${x.id}`} aria-current={s.id === x.id ? 'page' : undefined}>
                <span class="nv-ic" aria-hidden="true"><Icon name={x.icon} /></span>
                {x.label}
                {x.id === 'bandeja' && boot.counts.unassigned > 0 && <span class="ib-n" style="margin-left:auto">{boot.counts.unassigned}</span>}
              </a>
            ))}
            {HAS_VA && ADMIN.includes(role) && (
              <>
                <div class="nv-group">Otros productos</div>
                <a class="nv" href={PORTAL}>
                  <span class="nv-ic" aria-hidden="true"><Icon name="spark" /></span>
                  Agentes virtuales
                </a>
              </>
            )}
          </nav>
          <div class="foot">
            <ThemeSwitch />
            <UserMenu variant="card" user={me.user} roleLabel={roleLabel} onLogout={logout} onAccount={() => go('cuenta')} />
          </div>
        </aside>
        <main class="main" id="main">
          {s.id === 'bandeja' && (
            <div class="cc-top">
              <h1 class="cc-title">Bandeja</h1>
              <span class="small muted">{boot.me.name || boot.me.email} · {roleLabel}</span>
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
      <AuthGate api={api} title="Contact Center" subtitle={root.dataset.tenant}>
        {({ me, logout, reload }) => <ContactCenter me={me} logout={logout} reloadMe={reload} />}
      </AuthGate>
      <Toasts />
    </>
  )
}

render(<App />, root)
