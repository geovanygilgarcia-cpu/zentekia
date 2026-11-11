import { useEffect, useRef, useState } from 'preact/hooks'
import { num } from '../../shared/api.js'
import { Field, PageHead, TestWidget, useAction } from './common.jsx'
import { Icon } from './icons.jsx'

const CH = [
  { key: 'chat', label: 'Chat' },
  { key: 'voice', label: 'Voz' },
  { key: 'whatsapp', label: 'WhatsApp' },
]

/** Logo del asistente (el del widget) o su inicial con el color de su marca */
export function AgentAvatar({ agent, size = 44 }) {
  const [broken, setBroken] = useState(false)
  const st = `width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.27)}px`
  if (agent.logo_url && !broken) {
    return (
      <span class="ag-av ag-av-img" style={st}>
        <img src={agent.logo_url} alt="" onError={() => setBroken(true)} />
      </span>
    )
  }
  return (
    <span class="ag-av" style={`${st};font-size:${Math.round(size * 0.42)}px;background:${agent.color || 'var(--accent)'}`} aria-hidden="true">
      {agent.name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

/** Formulario para pedirle a Zentekia un asistente o un canal nuevo */
export function RequestModal({ api, onClose, preset }) {
  const [name, setName] = useState(preset?.name || '')
  // Se puede pedir Chat, Voz o ambos; WhatsApp sigue bloqueado hasta que salga
  const [channels, setChannels] = useState(preset?.channels?.filter((c) => c !== 'whatsapp').length ? preset.channels.filter((c) => c !== 'whatsapp') : ['chat'])
  const toggle = (key) => setChannels((cur) => (cur.includes(key) ? cur.filter((c) => c !== key) : [...cur, key]))
  const [notes, setNotes] = useState(preset?.notes || '')
  const [sent, setSent] = useState(false)
  const [busy, run] = useAction()
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const send = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post('agents/request', { name: name.trim(), channels, notes: notes.trim() || undefined }))
    if (r) setSent(true)
  }
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="req-title">
        {sent ? (
          <div class="req-done">
            <span class="req-ok"><Icon name="check" size={26} /></span>
            <h2 id="req-title">Recibimos tu solicitud</h2>
            <p class="sub" style="margin:8px auto 0;text-align:center">El equipo de Zentekia la revisa y te contacta para darlo de alta. Cuando esté listo, aparecerá aquí.</p>
            <button class="b b-primary" style="margin-top:20px" onClick={onClose}>Entendido</button>
          </div>
        ) : (
          <form onSubmit={send}>
            <div class="row" style="align-items:flex-start">
              <div class="grow">
                <h2 id="req-title">{preset?.title || 'Solicitar un asistente'}</h2>
                <p class="sub" style="margin-top:4px">{preset?.sub || 'Cuéntanos qué necesitas y lo damos de alta por ti.'}</p>
              </div>
              <button type="button" class="icon-x" onClick={onClose} aria-label="Cerrar"><Icon name="x" /></button>
            </div>
            <Field label="Nombre del asistente">
              <input value={name} onInput={(e) => setName(e.target.value)} maxLength={80} required placeholder="Ej.: Ventas, Soporte, Cobranza" />
            </Field>
            <div class="l">Canales</div>
            <div class="req-ch">
              {CH.map((c) => {
                const locked = c.key === 'whatsapp'
                if (locked) {
                  return (
                    <span key={c.key} class="req-chip locked" title="Disponible próximamente">
                      <Icon name={c.key} size={16} />
                      {c.label}
                      <span class="pill-soon">Pronto</span>
                    </span>
                  )
                }
                const on = channels.includes(c.key)
                return (
                  <label key={c.key} class={'req-chip pick' + (on ? ' on' : '')}>
                    <input type="checkbox" checked={on} onChange={() => toggle(c.key)} />
                    <Icon name={c.key === 'voice' ? 'voz' : c.key} size={16} />
                    {c.label}
                    {on && <Icon name="check" size={14} />}
                  </label>
                )
              })}
            </div>
            {!channels.length && <p class="hint" style="margin-top:6px;color:var(--warn, #f5a524)">Elige al menos un canal.</p>}
            <Field label="¿Qué debe hacer?" hint="Opcional. Ej.: atender dudas de pagos y agendar visitas de un asesor.">
              <textarea rows="3" value={notes} onInput={(e) => setNotes(e.target.value)} maxLength={1500} />
            </Field>
            <div class="row" style="margin-top:20px;justify-content:flex-end">
              <button type="button" class="b b-ghost" onClick={onClose}>Cancelar</button>
              <button class="b b-primary" disabled={busy || !name.trim() || !channels.length}>Enviar solicitud</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

/** Tipos de asistente: cada uno nace con instrucciones base (templates del Worker) */
const TYPES = [
  { id: 'ventas', label: 'Ventas', icon: 'target', desc: 'Orienta, cotiza y toma datos de interesados.' },
  { id: 'soporte', label: 'Soporte a clientes', icon: 'chat', desc: 'Resuelve dudas y pasa casos a tu equipo.' },
  { id: 'citas', label: 'Agendar citas', icon: 'calendar', desc: 'Explica servicios y toma datos para la cita.' },
  { id: 'cobranza', label: 'Cobranza', icon: 'bolt', desc: 'Recuerda pagos con amabilidad y da opciones.' },
  { id: 'reclutamiento', label: 'Reclutamiento', icon: 'users', desc: 'Explica vacantes y recibe candidatos.' },
  { id: 'otro', label: 'Otro', icon: 'edit', desc: 'Tú describes qué debe hacer.' },
]

/** El cliente crea su propio asistente eligiendo un tipo */
function CreateModal({ api, onClose, onRequest }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('ventas')
  const [desc, setDesc] = useState('')
  const [busy, run] = useAction()
  const nameRef = useRef(null)
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    nameRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const other = type === 'otro'
  const submit = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post('agents', { name: name.trim(), template: type, description: desc.trim() || undefined }), 'Asistente creado')
    if (r?.id) onClose(r.id)
  }
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="modal" style="width:min(620px,100%)" role="dialog" aria-modal="true" aria-labelledby="new-title" onSubmit={submit}>
        <div class="row" style="align-items:flex-start">
          <div class="grow">
            <h2 id="new-title">Crear asistente</h2>
            <p class="sub" style="margin-top:4px">Elige para qué es y nace con instrucciones base de ese tipo. Después lo ajustas a tu negocio y prendes las herramientas que quieras.</p>
          </div>
          <button type="button" class="icon-x" onClick={() => onClose()} aria-label="Cerrar"><Icon name="x" /></button>
        </div>
        <Field label="Nombre del asistente">
          <input ref={nameRef} value={name} onInput={(e) => setName(e.target.value)} maxLength={80} required placeholder="Ej.: Ventas · Ana, Soporte, Recepción" />
        </Field>
        <div class="l">¿Para qué es?</div>
        <div class="new-types" role="radiogroup" aria-label="Tipo de asistente">
          {TYPES.map((t) => (
            <label key={t.id} class={'new-type' + (type === t.id ? ' on' : '')}>
              <input type="radio" name="type" value={t.id} checked={type === t.id} onChange={() => setType(t.id)} />
              <span class="new-type-ic" aria-hidden="true"><Icon name={t.icon} size={17} /></span>
              <span class="grow">
                <b>{t.label}</b>
                <span class="small muted">{t.desc}</span>
              </span>
            </label>
          ))}
        </div>
        <Field label={other ? '¿Qué debe hacer?' : '¿Qué debe hacer? (opcional)'} hint="En tus palabras. Lo puedes cambiar cuando quieras en la sección Agente.">
          <textarea
            rows="3"
            value={desc}
            maxLength={2000}
            required={other}
            onInput={(e) => setDesc(e.target.value)}
            placeholder={other ? 'Ej.: Responde dudas de mi gimnasio, horarios y precios, y aparta clases de prueba.' : 'Ej.: Somos una clínica dental en Monterrey; atiende de lunes a sábado.'}
          />
        </Field>
        <div class="new-next small muted">
          <b>Después:</b> ajusta sus instrucciones en <b>Agente</b>, sube tus documentos en <b>Conocimiento</b>, prende lo que necesites en <b>Herramientas</b> (todas son opcionales) y copia el código en <b>Instalación</b>.
        </div>
        <div class="row" style="margin-top:18px;gap:8px;justify-content:space-between;flex-wrap:wrap">
          <button type="button" class="link small" onClick={onRequest}>¿Prefieres que lo haga Zentekia?</button>
          <span class="row" style="gap:8px">
            <button type="button" class="b b-ghost" onClick={() => onClose()}>Cancelar</button>
            <button class="b b-primary" disabled={busy || !name.trim() || (other && !desc.trim())}><Icon name="plus" size={15} />Crear asistente</button>
          </span>
        </div>
      </form>
    </div>
  )
}

const chHref = (agent, key) => `#/a/${agent.id}/${key === 'chat' ? 'resumen' : key === 'voice' ? 'voz' : 'whatsapp'}`
const chState = (agent, key) => agent.channels?.[key] || (key === 'chat' ? 'active' : 'soon')
const ago = (t) => {
  if (!t) return 'Sin actividad'
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 60) return m <= 1 ? 'Hace un momento' : `Hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `Hace ${h} h`
  const d = Math.round(h / 24)
  return d === 1 ? 'Ayer' : `Hace ${d} días`
}

function Status({ suspended }) {
  return suspended ? <span class="ag-status off">● Pausado</span> : <span class="ag-status">● En línea</span>
}

function AgentCard({ agent, suspended }) {
  const href = `#/a/${agent.id}`
  return (
    <article class="ag-card">
      <a class="ag-top" href={href}>
        <AgentAvatar agent={agent} size={52} />
        <div class="grow ag-id">
          <div class="ag-name" title={agent.name}>{agent.name}{agent.kind === 'guide' && <span class="ag-guide">Guía</span>}</div>
          <Status suspended={suspended} />
        </div>
        <div class="ag-stat" title="Conversaciones en los últimos 30 días">
          <b>{num(agent.conversations_30d)}</b>
          <span>conv. · 30 d</span>
        </div>
      </a>
      <div class="ag-chs">
        {CH.map((c) => (
          <a key={c.key} class="ag-ch" href={chHref(agent, c.key)}>
            <Icon name={c.key === 'voice' ? 'voz' : c.key} size={16} />
            <span class="grow">{c.label}</span>
            {chState(agent, c.key) === 'active' ? <span class="ag-live">Activo</span> : chState(agent, c.key) === 'available' ? <span class="pill-soon pill-avail">Sin activar</span> : chState(agent, c.key) === 'off' ? <span class="pill-soon">Apagado</span> : <span class="pill-soon">Próximamente</span>}
          </a>
        ))}
      </div>
      <a class="b b-primary b-block" href={href}>Abrir asistente <Icon name="arrow" size={16} /></a>
    </article>
  )
}

function AgentRow({ agent, suspended }) {
  const href = `#/a/${agent.id}`
  return (
    <div class="ag-row" role="row">
      <a class="ag-row-main" href={href} role="cell">
        <AgentAvatar agent={agent} size={40} />
        <span class="ag-id">
          <span class="ag-row-name" title={agent.name}>{agent.name}{agent.kind === 'guide' && <span class="ag-guide">Guía</span>}</span>
          <Status suspended={suspended} />
        </span>
      </a>
      <span class="ag-row-chs" role="cell">
        {CH.map((c) => {
          const st = chState(agent, c.key)
          const on = st === 'active'
          const lbl = on ? 'activo' : st === 'available' ? 'sin activar' : st === 'off' ? 'apagado' : 'próximamente'
          return (
            <a key={c.key} href={chHref(agent, c.key)} class={'ag-dot' + (on ? ' on' : st === 'available' ? ' avail' : '')} title={`${c.label}: ${lbl}`} aria-label={`${c.label}: ${lbl}`}>
              <Icon name={c.key === 'voice' ? 'voz' : c.key} size={15} />
            </a>
          )
        })}
      </span>
      <span class="ag-row-num" role="cell"><b>{num(agent.conversations_30d)}</b><span>conv. · 30 d</span></span>
      <span class="ag-row-when" role="cell">{ago(agent.last_conversation_at)}</span>
      <span role="cell"><a class="b b-outline b-sm" href={href}>Abrir <Icon name="arrow" size={14} /></a></span>
    </div>
  )
}

const VIEW_KEY = 'zc-agents-view-v2'
const SORTS = {
  name: ['Nombre (A-Z)', (a, b) => a.name.localeCompare(b.name, 'es')],
  convs: ['Más conversaciones', (a, b) => b.conversations_30d - a.conversations_30d],
  recent: ['Actividad reciente', (a, b) => (b.last_conversation_at || 0) - (a.last_conversation_at || 0)],
  newest: ['Más nuevos', (a, b) => (b.created_at || 0) - (a.created_at || 0)],
}
const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export default function Asistentes({ ov, me, readOnly, api, reload }) {
  const [asking, setAsking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [talking, setTalking] = useState(false)
  // La Guía Zentekia no se lista con los demás: tiene su propia tarjeta abajo
  const guide = ov.agents.find((a) => a.kind === 'guide')
  const agents = ov.agents.filter((a) => a.kind !== 'guide')
  const [q, setQ] = useState('')
  const [act, setAct] = useState('all')
  const [sort, setSort] = useState('name')
  const [view, setView] = useState(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY)
      if (v === 'grid' || v === 'list') return v
    } catch {}
    return 'list'
  })
  const pickView = (v) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {}
  }
  const canRequest = me.user.role === 'owner' && !readOnly
  const suspended = ov.tenant.status === 'suspended'
  const nq = norm(q.trim())
  const list = agents
    .filter((a) => !nq || norm(a.name).includes(nq))
    .filter((a) => act === 'all' || (act === 'active' ? a.conversations_30d > 0 : !a.conversations_30d))
    .sort(SORTS[sort][1])
  const filtering = nq || act !== 'all'
  const withActivity = agents.filter((a) => a.conversations_30d > 0).length

  return (
    <>
      <PageHead title="Elige un asistente" sub="Entra a un asistente para configurarlo y ver sus canales: chat, voz y WhatsApp.">
        {canRequest && view === 'list' && (
          <button class="b b-primary b-sm" onClick={() => setCreating(true)}><Icon name="plus" size={15} />Crear asistente</button>
        )}
      </PageHead>

      {agents.length > 1 && (
        <div class="ag-tools">
          <label class="ag-search">
            <Icon name="search" size={17} />
            <input type="search" placeholder="Buscar asistente…" value={q} onInput={(e) => setQ(e.target.value)} aria-label="Buscar asistente" />
          </label>
          <div class="ag-chips" role="group" aria-label="Filtrar por actividad">
            {[['all', 'Todos', agents.length], ['active', 'Con actividad', withActivity], ['idle', 'Sin actividad', agents.length - withActivity]].map(([k, l, n]) => (
              <button key={k} type="button" aria-pressed={act === k} onClick={() => setAct(k)} title={k === 'all' ? undefined : `${l} en los últimos 30 días`}>{l}<span class="ag-n">{n}</span></button>
            ))}
          </div>
          <select class="ag-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordenar">
            {Object.entries(SORTS).map(([k, [l]]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </select>
          <div class="ag-view" role="group" aria-label="Vista">
            <button type="button" aria-pressed={view === 'list'} onClick={() => pickView('list')} title="Ver en lista"><Icon name="list" size={17} /><span>Lista</span></button>
            <button type="button" aria-pressed={view === 'grid'} onClick={() => pickView('grid')} title="Ver en tarjetas"><Icon name="grid" size={17} /><span>Tarjetas</span></button>
          </div>
        </div>
      )}

      {filtering && (
        <div class="ag-count small muted">
          {list.length === 1 ? '1 asistente' : `${list.length} asistentes`}
          <button class="link" style="margin-left:10px" onClick={() => { setQ(''); setAct('all') }}>Quitar filtros</button>
        </div>
      )}

      {!agents.length ? null : list.length === 0 && filtering ? (
        <div class="card empty">No hay asistentes que coincidan con «{q || 'el filtro'}».</div>
      ) : view === 'list' ? (
        <div class="ag-list" role="table" aria-label="Asistentes">
          <div class="ag-row ag-row-head" role="row">
            <span role="columnheader">Asistente</span>
            <span role="columnheader">Canales</span>
            <span role="columnheader">Conversaciones</span>
            <span role="columnheader">Última actividad</span>
            <span role="columnheader" />
          </div>
          {list.map((a) => (
            <AgentRow key={a.id} agent={a} suspended={suspended} />
          ))}
        </div>
      ) : (
        <div class="ag-grid">
          {list.map((a) => (
            <AgentCard key={a.id} agent={a} suspended={suspended} />
          ))}
          {canRequest && !filtering && (
            <button type="button" class="ag-new" onClick={() => setCreating(true)}>
              <span class="ag-new-ic"><Icon name="plus" size={22} /></span>
              <b>Crear un asistente</b>
              <span>Elige para qué es y queda listo para configurarlo.</span>
            </button>
          )}
          {!agents.length && !canRequest && <div class="empty">Todavía no hay asistentes en tu cuenta.</div>}
        </div>
      )}
      {guide && !filtering && (
        <div class="card bld-cta">
          <span class="bld-av" aria-hidden="true"><Icon name="compass" size={22} /></span>
          <div class="grow">
            <b>{agents.length ? '¿Dudas con el portal?' : 'Crea tu primer asistente'}</b>
            <p class="small muted" style="margin:3px 0 0">Platica con la Guía Zentekia: te explica qué tiene la plataforma, cómo crear un asistente y cómo dejarlo listo en tu sitio.</p>
          </div>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            {guide.widget_key && (
              <button class="b b-outline" onClick={() => setTalking(true)}><Icon name="chat" size={15} />Hablar con la Guía</button>
            )}
            {canRequest && (
              <button class="b b-primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} />Crear asistente</button>
            )}
          </div>
        </div>
      )}
      {talking && <TestWidget widgetKey={guide.widget_key} title="Guía Zentekia" onClose={() => setTalking(false)} />}
      {creating && (
        <CreateModal
          api={api}
          onRequest={() => {
            setCreating(false)
            setAsking(true)
          }}
          onClose={async (id) => {
            setCreating(false)
            if (id) {
              await reload?.()
              location.hash = `#/a/${id}/agente`
            }
          }}
        />
      )}
      {asking && <RequestModal api={api} onClose={() => setAsking(false)} />}
    </>
  )
}
