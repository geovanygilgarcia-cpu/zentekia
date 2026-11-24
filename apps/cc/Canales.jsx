/*
  Canales del Contact Center: chat web y WhatsApp que entran directo a la cola de personas (sin IA).
  Cada canal reutiliza el editor del widget, la instalación y la conexión de WhatsApp del portal.
*/
import { useState } from 'preact/hooks'
import { date } from '../shared/api.js'
import { Field, Loading, PageHead, useAction, useLoad } from '../portal/sections/common.jsx'
import { Icon } from '../portal/sections/icons.jsx'
import { WidgetEditor } from '../portal/sections/Widget.jsx'
import Instalacion from '../portal/sections/Instalacion.jsx'
import WhatsApp from '../portal/sections/WhatsApp.jsx'

const TABS = [
  { id: 'widget', label: 'Chat web' },
  { id: 'instalacion', label: 'Instalación' },
  { id: 'whatsapp', label: 'WhatsApp' },
]

export default function Canales({ api, me, readOnly, go, channelId, tab }) {
  const { data, error, reload } = useLoad(() => api.get('cc/channels'))
  const [name, setName] = useState('')
  const [busy, run] = useAction()
  if (!data) return <Loading error={error} />
  const ch = channelId ? data.items.find((x) => x.id === channelId) : null

  if (ch) {
    const t = TABS.find((x) => x.id === tab) || TABS[0]
    const agent = { id: ch.id, name: ch.name, widget_key: ch.widget_key }
    return (
      <>
        <div class="crumbs" style="margin-bottom:10px"><a href="#/canales">Canales</a> / <span>{ch.name}</span></div>
        <div class="tabs" role="tablist">
          {TABS.map((x) => (
            <button key={x.id} role="tab" aria-selected={t.id === x.id} class={t.id === x.id ? 'on' : ''} onClick={() => (location.hash = `#/canales/${ch.id}/${x.id}`)}>
              {x.label}
              {x.id === 'whatsapp' && ch.whatsapp && <span class="ch-live" style="margin-left:6px">Activo</span>}
            </button>
          ))}
        </div>
        {t.id === 'widget' && (
          <>
            <PageHead title="Chat web" sub="Así se ve la burbuja de chat de este canal. Lo que escriben tus visitantes llega directo a la Bandeja: sin IA." />
            <WidgetEditor api={api} agentId={ch.id} readOnly={readOnly} />
          </>
        )}
        {t.id === 'instalacion' && <Instalacion api={api} agent={agent} agentId={ch.id} me={me} go={(id) => go(id === 'seguridad' ? 'seguridad' : id)} />}
        {t.id === 'whatsapp' && <WhatsApp api={api} agent={agent} me={me} readOnly={readOnly} reload={reload} />}
      </>
    )
  }

  const create = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post('cc/channels', { name }), 'Canal creado')
    if (r) {
      setName('')
      reload()
      location.hash = `#/canales/${r.id}/widget`
    }
  }
  const admin = ['owner', 'editor'].includes(me.user.role) && !readOnly
  return (
    <>
      <PageHead title="Canales" sub="Por dónde te escriben tus clientes. Cada canal tiene su chat web y puede tener un número de WhatsApp; todo llega a la Bandeja y lo atienden personas." />
      <div class="cols">
        <div class="col-main">
          {data.items.length === 0 ? (
            <div class="card"><p style="margin:0">Todavía no hay canales. Crea el primero.</p></div>
          ) : (
            <div class="cc-channels">
              {data.items.map((c) => (
                <a key={c.id} class="card cc-channel" href={`#/canales/${c.id}/widget`}>
                  <div class="cc-channel-top">
                    <b>{c.name}</b>
                    <span class="small muted">desde {date(c.created_at)}</span>
                  </div>
                  <div class="cc-channel-chs">
                    <span class="cc-pill on"><Icon name="chat" size={14} /> Chat web</span>
                    <span class={'cc-pill' + (c.whatsapp ? ' on' : '')}><Icon name="whatsapp" size={14} /> {c.whatsapp ? c.whatsapp.display_phone || `+${c.whatsapp.phone}` : 'WhatsApp sin conectar'}</span>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
        {admin && (
          <div class="col-side">
            <form class="card" onSubmit={create}>
              <div class="card-title">Nuevo canal</div>
              <p class="small muted" style="margin-top:0">Por ejemplo uno por marca, sucursal o área (Ventas, Soporte).</p>
              <Field label="Nombre"><input value={name} maxLength={80} required onInput={(e) => setName(e.target.value)} placeholder="Soporte" /></Field>
              <button class="b b-primary" style="margin-top:14px" disabled={busy || !name.trim()}><Icon name="plus" size={14} /> Crear canal</button>
            </form>
          </div>
        )}
      </div>
    </>
  )
}
