/*
  Bandeja (fase 1 omnicanal): las personas del equipo atienden las conversaciones que la IA escala.
  Tiempo real por WebSocket (InboxHubDO). Los eventos solo traen ids: la lista y el chat se vuelven a pedir.
*/
import { Fragment } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import './bandeja.css'
import Markdown from '../../shared/Markdown.jsx'
import { date } from '../../shared/api.js'
import { toast } from '../../shared/toast.jsx'
import { Field, Loading, PageHead, useAction } from './common.jsx'
import { Icon } from './icons.jsx'

const VIEWS = [
  { id: 'mine', label: 'Mías' },
  { id: 'unassigned', label: 'Sin asignar' },
  { id: 'waiting', label: 'En espera' },
  { id: 'ai', label: 'Atiende la IA' },
  { id: 'all', label: 'Todas abiertas', lead: true },
  { id: 'closed', label: 'Cerradas' },
]
const STATUS = {
  ai_active: { label: 'IA', cls: 'st-ai' },
  waiting_human: { label: 'En espera', cls: 'st-wait' },
  human_active: { label: 'Con persona', cls: 'st-human' },
  closed: { label: 'Cerrada', cls: 'st-closed' },
}
const PRESENCE = { online: 'En línea', away: 'Ausente', offline: 'Desconectado' }
const REASON = { ai_tool: 'El asistente pidió a una persona', keyword: 'El visitante pidió una persona', max_turns: 'Máximo de respuestas de la IA', manual: 'Intervención manual' }
const ROLE = { owner: 'Owner', editor: 'Editor', supervisor: 'Supervisor', agent: 'Agente' }
const DELIVERY = { sent: 'Enviado', delivered: 'Entregado', read: 'Leído', failed: 'No se entregó' }
const TICK = { sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠ no enviado' }

const ago = (t) => {
  if (!t) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'ahora'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}
const dur = (ms) => (ms == null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`)
const who = (c) => c.contact_name || c.contact_email || c.contact_phone || c.title || 'Visitante'

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = 740
    g.gain.setValueAtTime(0.06, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.3)
  } catch {}
}

/** WebSocket de la bandeja con reconexión y ping */
function useInboxSocket(api, onEvent, enabled) {
  const cb = useRef(onEvent)
  cb.current = onEvent
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let ws = null
    let stop = false
    let tries = 0
    let ping = null
    let timer = null
    const open = () => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${api.base}/inbox/ws`
      ws = new WebSocket(url)
      ws.onopen = () => {
        tries = 0
        setLive(true)
        cb.current({ type: 'reconnected' })
        ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25_000)
      }
      ws.onmessage = (e) => {
        if (e.data === 'pong') return
        try {
          cb.current(JSON.parse(e.data))
        } catch {}
      }
      ws.onclose = () => {
        setLive(false)
        clearInterval(ping)
        if (!stop) timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** tries++))
      }
    }
    open()
    return () => {
      stop = true
      clearInterval(ping)
      clearTimeout(timer)
      ws?.close()
    }
  }, [enabled])
  return live
}

export default function Bandeja({ api, readOnly }) {
  const [boot, setBoot] = useState(null)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('inbox')
  const loadBoot = () => api.get('inbox/bootstrap').then(setBoot).catch((e) => setError(e.message))
  useEffect(() => {
    loadBoot()
  }, [])
  if (!boot) return <Loading error={error} />
  const lead = boot.me.lead
  return (
    <>
      <PageHead title="Bandeja" sub="Atiende en vivo las conversaciones que el asistente pasa a tu equipo. La IA deja de responder mientras una persona atiende.">
        <Presence api={api} boot={boot} reload={loadBoot} readOnly={readOnly} />
      </PageHead>
      {!boot.ready && <div class="alert alert-warn" style="margin-bottom:16px">La bandeja todavía no está activa en el servidor. Zentekia debe publicar el Worker con los Durable Objects de la bandeja.</div>}
      {lead && (
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'inbox'} class={tab === 'inbox' ? 'on' : ''} onClick={() => setTab('inbox')}>Conversaciones</button>
          <button role="tab" aria-selected={tab === 'config'} class={tab === 'config' ? 'on' : ''} onClick={() => setTab('config')}>Equipo, colas y respuestas</button>
        </div>
      )}
      {tab === 'inbox' ? <Inbox api={api} boot={boot} reloadBoot={loadBoot} readOnly={readOnly} /> : <InboxConfig api={api} boot={boot} reloadBoot={loadBoot} readOnly={readOnly} />}
    </>
  )
}

export function Presence({ api, boot, reload, readOnly }) {
  const [busy, run] = useAction()
  const set = (status) => run(() => api.put('inbox/presence', { status })).then(reload)
  return (
    <div class="ib-presence">
      <span class={'ib-dot ib-' + boot.presence.status} aria-hidden="true" />
      <label class="sr-only" for="ib-presence">Tu estado</label>
      <select id="ib-presence" value={boot.presence.status} disabled={busy || readOnly} onChange={(e) => set(e.target.value)}>
        {Object.entries(PRESENCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </div>
  )
}

export function Inbox({ api, boot, reloadBoot, readOnly }) {
  const lead = boot.me.lead
  const [view, setView] = useState(() => (lead ? 'waiting' : 'mine'))
  const [queue, setQueue] = useState('')
  const [list, setList] = useState(null)
  const [counts, setCounts] = useState(boot.counts)
  const [sel, setSel] = useState(null)
  const [detail, setDetail] = useState(null)
  const [showContact, setShowContact] = useState(false)
  const selRef = useRef(null)
  selRef.current = sel
  const refreshT = useRef(null)

  const loadList = () =>
    api.get(`inbox/conversations?view=${view}${queue ? `&queue=${encodeURIComponent(queue)}` : ''}`).then((r) => {
      setList(r.items)
      setCounts(r.counts)
    }).catch(() => {})
  const loadDetail = (id = selRef.current) => (id ? api.get(`inbox/conversations/${id}`).then((d) => selRef.current === id && setDetail(d)).catch(() => setDetail(null)) : Promise.resolve())

  useEffect(() => {
    setList(null)
    loadList()
  }, [view, queue])
  useEffect(() => {
    setDetail(null)
    loadDetail(sel)
  }, [sel])
  // Las esperas se ven avanzar aunque no llegue ningún evento
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const live = useInboxSocket(
    api,
    (ev) => {
      // Varios eventos seguidos: una sola recarga
      clearTimeout(refreshT.current)
      refreshT.current = setTimeout(loadList, 250)
      if (ev.type === 'reconnected') return loadDetail()
      if (ev.conversation_id && ev.conversation_id === selRef.current) loadDetail()
      if (ev.type === 'presence.changed') reloadBoot()
      if (ev.type === 'conversation.escalated' && boot.presence.status !== 'offline') {
        beep()
        toast('Nueva conversación en espera')
      }
      if (ev.type === 'conversation.assigned' && ev.user_id === boot.me.id && ev.conversation_id !== selRef.current) {
        beep()
        toast('Te asignaron una conversación')
      }
    },
    boot.ready,
  )

  // Contador de conversaciones sin asignar en la pestaña del navegador
  useEffect(() => {
    const n = counts.unassigned
    const base = document.title.replace(/^\(\d+\) /, '')
    document.title = n ? `(${n}) ${base}` : base
    return () => (document.title = document.title.replace(/^\(\d+\) /, ''))
  }, [counts.unassigned])

  const views = VIEWS.filter((v) => !v.lead || lead)
  return (
    <div class={'ib' + (sel ? ' ib-has-sel' : '') + (showContact ? ' ib-contact-open' : '')}>
      <aside class="ib-list card" aria-label="Conversaciones de la bandeja">
        <div class="ib-views" role="tablist">
          {views.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} class={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>
              {v.label}
              {counts[v.id] > 0 && <span class="ib-n">{counts[v.id]}</span>}
            </button>
          ))}
        </div>
        <div class="ib-list-tools">
          {boot.queues.length > 0 && (
            <select value={queue} onChange={(e) => setQueue(e.target.value)} aria-label="Filtrar por cola">
              <option value="">Todas las colas</option>
              {boot.queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          )}
          <span class={'ib-live' + (live ? ' on' : '')} title={live ? 'Conectado en tiempo real' : 'Reconectando…'}>{live ? 'En vivo' : 'Reconectando…'}</span>
        </div>
        {!list ? (
          <div class="loading">Cargando…</div>
        ) : list.length === 0 ? (
          <div class="ib-empty">
            <Icon name="chat" size={22} />
            <p>{view === 'mine' ? 'No tienes conversaciones asignadas.' : view === 'waiting' || view === 'unassigned' ? 'Nadie está esperando. ¡Todo al día!' : 'No hay conversaciones aquí.'}</p>
          </div>
        ) : (
          <div class="conv-list">
            {list.map((c) => (
              <button key={c.id} class={'conv-item ib-item' + (sel === c.id ? ' on' : '')} onClick={() => setSel(c.id)}>
                <div class="ib-item-top">
                  <span class="conv-name">
                    <span class={'ib-ch ' + (c.channel === 'whatsapp' ? 'ib-ch-wa' : 'ib-ch-web')} title={c.channel === 'whatsapp' ? 'WhatsApp' : 'Chat web'} style="margin-right:6px;vertical-align:-4px">
                      <Icon name={c.channel === 'whatsapp' ? 'whatsapp' : 'chat'} size={12} />
                    </span>
                    {who(c)}
                  </span>
                  <span class="small muted">{c.status === 'waiting_human' ? `espera ${ago(c.escalated_at)}` : ago(c.last_message_at)}</span>
                </div>
                {c.last_text && <div class="conv-sum">{c.last_text}</div>}
                <div class="conv-meta">
                  <span class={'ib-st ' + STATUS[c.status].cls}>{STATUS[c.status].label}</span>
                  {c.assignee_name && c.status === 'human_active' && <span class="small muted">· {c.assignee_user_id === boot.me.id ? 'Tú' : c.assignee_name}</span>}
                  {c.queue_name && <span class="stage-tag">{c.queue_name}</span>}
                  {c.agent_name && <span class="small muted">· {c.agent_name}</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>

      <section class="ib-chat card" aria-label="Conversación">
        {!sel ? (
          <div class="ib-empty ib-empty-big">
            <Icon name="hand" size={28} />
            <p>Elige una conversación de la lista.</p>
            <p class="small muted">Las conversaciones nuevas aparecen en «En espera» y se reparten a quien esté en línea.</p>
          </div>
        ) : !detail ? (
          <div class="loading">Cargando…</div>
        ) : (
          <Conversation
            key={sel}
            api={api}
            boot={boot}
            d={detail}
            readOnly={readOnly}
            reload={() => {
              loadDetail()
              loadList()
            }}
            onBack={() => setSel(null)}
            onContact={() => setShowContact((x) => !x)}
          />
        )}
      </section>

      {sel && detail && <ContactPanel d={detail} boot={boot} onClose={() => setShowContact(false)} />}
    </div>
  )
}

function Conversation({ api, boot, d, readOnly, reload, onBack, onContact }) {
  const c = d.conversation
  const me = boot.me
  const mine = c.status === 'human_active' && c.assignee_user_id === me.id
  const [mode, setMode] = useState(d.can_reply ? 'text' : 'note')
  const [text, setText] = useState('')
  const [busy, run] = useAction()
  const [transfer, setTransfer] = useState(false)
  const listRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    // WhatsApp fuera de la ventana de 24 h: solo plantillas
    if (!d.can_reply && mode === 'text') setMode(d.can_template ? 'template' : 'note')
  }, [d.can_reply, d.can_template])
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [d.messages.length])

  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null
  const quick = useMemo(() => (slash == null ? [] : boot.quick_replies.filter((q) => q.shortcut.startsWith(slash)).slice(0, 6)), [slash, boot.quick_replies])

  const act = (path, body, ok) => run(() => api.post(`inbox/conversations/${c.id}/${path}`, body), ok).then((r) => (r ? reload() : null))
  const send = async (e) => {
    e?.preventDefault()
    const v = text.trim()
    if (!v || busy || mode === 'template') return
    const r = await run(() => api.post(`inbox/conversations/${c.id}/messages`, { type: mode, text: v }))
    if (r) {
      setText('')
      reload()
      inputRef.current?.focus()
    }
  }
  const canAct = !readOnly
  const st = STATUS[c.status]

  return (
    <>
      <header class="ib-head">
        <button class="icon-x ib-back" onClick={onBack} aria-label="Volver a la lista"><Icon name="back" size={16} /></button>
        <div class="ib-head-main">
          <div class="ib-head-name">{who(c)}</div>
          <div class="small muted">
            <span class={'ib-st ' + st.cls}>{st.label}</span>
            {c.agent_name && <> · {c.agent_name}</>}
            {c.status === 'human_active' && c.assignee_user_id && <> · {mine ? 'la atiendes tú' : `la atiende ${boot.team.find((u) => u.id === c.assignee_user_id)?.name || 'otra persona'}`}</>}
          </div>
        </div>
        <div class="ib-actions">
          {canAct && c.status === 'waiting_human' && <button class="b b-primary" disabled={busy} onClick={() => act('take', {}, 'Tomaste la conversación')}>Tomar</button>}
          {canAct && c.status === 'ai_active' && !c.ended_at && me.lead && <button class="b" disabled={busy} onClick={() => confirm('La IA dejará de responder y tú atenderás esta conversación. ¿Continuar?') && act('intervene', {}, 'Ahora atiendes tú')}>Intervenir</button>}
          {canAct && (c.status === 'human_active' || c.status === 'waiting_human') && (mine || me.lead) && (
            <>
              <button class="b" disabled={busy} onClick={() => setTransfer(true)}>{me.lead && !mine ? 'Asignar' : 'Transferir'}</button>
              {d.ai_available && <button class="b" disabled={busy} onClick={() => act('handback', {}, 'La IA vuelve a atender')}>Devolver a la IA</button>}
            </>
          )}
          {canAct && (c.status === 'human_active' || c.status === 'waiting_human') && (mine || me.lead || c.status === 'waiting_human') && (
            <button class="b" disabled={busy} onClick={() => confirm('¿Cerrar la conversación? El visitante verá que terminó.') && act('close', {}, 'Conversación cerrada')}>Cerrar</button>
          )}
          <button class="icon-x ib-contact-btn" onClick={onContact} aria-label="Datos del contacto"><Icon name="user" size={16} /></button>
        </div>
      </header>

      {d.channel?.type === 'whatsapp' && (
        <div class={'ib-window' + (d.channel.window_open ? '' : ' closed')}>
          <Icon name="whatsapp" size={14} />
          <span>WhatsApp {d.channel.contact} → {d.channel.phone}</span>
          <span>·</span>
          <span>
            {d.channel.window_open
              ? `Ventana abierta: puedes escribir hasta ${new Date(d.channel.window_expires_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}`
              : 'Ventana de 24 h cerrada: solo se pueden mandar plantillas aprobadas'}
          </span>
        </div>
      )}
      <div class="ib-timeline transcript" ref={listRef} role="log" aria-live="polite">
        {d.messages.map((m) => {
          if (m.kind === 'event') return <div key={m.id} class="ib-event"><span>{m.content}</span><time>{ago(m.created_at)}</time></div>
          if (m.kind === 'notice') return <div key={m.id} class="ib-notice" title="Lo vio el visitante">{m.content}</div>
          if (m.kind === 'note')
            return (
              <div key={m.id} class="tmsg ib-note">
                <div class="ib-note-tag">Nota interna · {m.author_name || 'equipo'}</div>
                <div style="white-space:pre-wrap">{m.content}</div>
                <div class="tmeta">{date(m.created_at)}</div>
              </div>
            )
          const cls = m.role === 'user' ? 'contact' : m.sender === 'human' ? 'human' : 'ai'
          return (
            <div key={m.id} class={'tmsg ib-' + cls}>
              {cls !== 'contact' && <div class="ib-from">{cls === 'human' ? m.author_name || 'Agente' : 'Asistente IA'}</div>}
              {cls === 'ai' ? <Markdown text={m.content} /> : <div style="white-space:pre-wrap">{m.content}</div>}
              {m.media?.stored && (
                <a class="ib-media" href={`${api.base}/inbox/conversations/${c.id}/media/${m.id}`} target="_blank" rel="noopener noreferrer">
                  <Icon name="link" size={13} /> Ver adjunto
                </a>
              )}
              <div class="tmeta">
                {date(m.created_at)}
                {cls !== 'contact' && m.delivery && <span class={'ib-tick ' + m.delivery} title={DELIVERY[m.delivery]}>{TICK[m.delivery]}</span>}
              </div>
            </div>
          )
        })}
      </div>

      {canAct && c.status !== 'closed' && (
        <form class={'ib-composer' + (mode === 'note' ? ' is-note' : '')} onSubmit={send}>
          <div class="ib-modes" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'text'} class={mode === 'text' ? 'on' : ''} disabled={!d.can_reply} onClick={() => setMode('text')}>Responder</button>
            <button type="button" role="tab" aria-selected={mode === 'note'} class={mode === 'note' ? 'on' : ''} onClick={() => setMode('note')}>Nota interna</button>
            {d.can_template && <button type="button" role="tab" aria-selected={mode === 'template'} class={mode === 'template' ? 'on' : ''} onClick={() => setMode('template')}>Plantilla</button>}
            {!d.can_reply && (
              <span class="small muted">
                {d.can_template ? 'Ventana de 24 h cerrada: manda una plantilla.' : c.status === 'waiting_human' ? 'Toma la conversación para responder.' : c.status === 'ai_active' ? 'La atiende la IA.' : 'La atiende otra persona.'}
              </span>
            )}
          </div>
          {mode === 'template' && <TemplatePicker api={api} conv={c} done={reload} />}
          {mode !== 'template' && quick.length > 0 && (
            <ul class="ib-quick" role="listbox" aria-label="Respuestas rápidas">
              {quick.map((q) => (
                <li key={q.id}>
                  <button type="button" onClick={() => { setText(q.text); inputRef.current?.focus() }}>
                    <b>/{q.shortcut}</b> <span>{q.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div class="ib-input" hidden={mode === 'template'}>
            <label class="sr-only" for="ib-text">{mode === 'note' ? 'Nota interna' : 'Respuesta'}</label>
            <textarea
              id="ib-text"
              ref={inputRef}
              rows="2"
              maxLength={4000}
              value={text}
              placeholder={mode === 'note' ? 'Nota para tu equipo (el visitante no la ve)…' : 'Escribe tu respuesta… (usa / para respuestas rápidas)'}
              onInput={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (quick.length === 1 && slash != null) setText(quick[0].text)
                  else send()
                }
              }}
            />
            <button class="b b-primary" disabled={busy || !text.trim()}>{mode === 'note' ? 'Guardar nota' : 'Enviar'}</button>
          </div>
        </form>
      )}
      {transfer && <TransferDialog api={api} boot={boot} c={c} assignOnly={me.lead && !mine} onClose={() => setTransfer(false)} done={() => { setTransfer(false); reload() }} />}
    </>
  )
}

/** WhatsApp: plantillas aprobadas del número, con sus variables (va dentro del formulario del chat: sin <form>) */
function TemplatePicker({ api, conv, done }) {
  const [list, setList] = useState(null)
  const [err, setErr] = useState(null)
  const [sel, setSel] = useState('')
  const [params, setParams] = useState([])
  const [busy, run] = useAction()
  useEffect(() => {
    api.get(`inbox/conversations/${conv.id}/templates`).then((r) => setList(r.items)).catch((e) => setErr(e.message))
  }, [conv.id])
  if (err) return <div class="alert alert-warn">{err}</div>
  if (!list) return <div class="small muted">Cargando plantillas…</div>
  if (!list.length) return <div class="small muted">Este número no tiene plantillas aprobadas. Créalas y apruébalas en tu proveedor de WhatsApp.</div>
  const t = list.find((x) => `${x.name}|${x.language}` === sel)
  const preview = t ? t.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => params[Number(n) - 1] || `{{${n}}}`) : ''
  const send = async () => {
    if (!t) return
    const r = await run(() => api.post(`inbox/conversations/${conv.id}/template`, { name: t.name, language: t.language, params }), 'Plantilla enviada')
    if (r) {
      setSel('')
      setParams([])
      done()
    }
  }
  return (
    <div class="ib-tpl">
      <label class="sr-only" for="ib-tpl-sel">Plantilla</label>
      <select id="ib-tpl-sel" value={sel} onChange={(e) => { setSel(e.target.value); const x = list.find((y) => `${y.name}|${y.language}` === e.target.value); setParams(Array(x?.variables || 0).fill('')) }}>
        <option value="">Elige una plantilla aprobada…</option>
        {list.map((x) => (
          <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`} disabled={!x.supported}>
            {x.name} · {x.language}{x.category ? ` · ${x.category.toLowerCase()}` : ''}{x.supported ? '' : ' (no compatible aún)'}
          </option>
        ))}
      </select>
      {t && (
        <>
          {params.map((v, i) => (
            <input key={i} value={v} maxLength={1000} placeholder={`Dato {{${i + 1}}}`} aria-label={`Dato ${i + 1} de la plantilla`} onInput={(e) => setParams(params.map((p, k) => (k === i ? e.target.value : p)))} />
          ))}
          <div class="ib-tpl-preview">{preview}</div>
          <div style="display:flex;justify-content:flex-end">
            <button type="button" class="b b-primary" disabled={busy || params.some((p) => !p.trim())} onClick={send}>Enviar plantilla</button>
          </div>
        </>
      )}
    </div>
  )
}

function TransferDialog({ api, boot, c, assignOnly, onClose, done }) {
  const [target, setTarget] = useState('')
  const [busy, run] = useAction()
  const go = async (e) => {
    e.preventDefault()
    if (!target) return
    const [kind, id] = target.split(':')
    const body = kind === 'u' ? { user_id: id } : { queue_id: id === 'general' ? null : id }
    const path = kind === 'u' && assignOnly ? 'assign' : 'transfer'
    if (await run(() => api.post(`inbox/conversations/${c.id}/${path}`, body), 'Conversación transferida')) done()
  }
  const people = boot.team.filter((u) => u.id !== c.assignee_user_id)
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="ib-tr-t" onSubmit={go}>
        <h3 id="ib-tr-t">{assignOnly ? 'Asignar conversación' : 'Transferir conversación'}</h3>
        <Field label="¿A quién?">
          <select value={target} onChange={(e) => setTarget(e.target.value)} required autoFocus>
            <option value="">Elige…</option>
            <optgroup label="Personas">
              {people.map((u) => <option key={u.id} value={`u:${u.id}`}>{u.name || u.email} · {PRESENCE[u.status]} · {u.load} activas</option>)}
            </optgroup>
            <optgroup label="Colas (se reparte a quien esté disponible)">
              <option value="q:general">Cola general</option>
              {boot.queues.map((q) => <option key={q.id} value={`q:${q.id}`}>{q.name}</option>)}
            </optgroup>
          </select>
        </Field>
        <div class="row" style="margin-top:18px;justify-content:flex-end;gap:8px;display:flex">
          <button type="button" class="b" onClick={onClose}>Cancelar</button>
          <button class="b b-primary" disabled={busy || !target}>{assignOnly ? 'Asignar' : 'Transferir'}</button>
        </div>
      </form>
    </div>
  )
}

function ContactPanel({ d, boot, onClose }) {
  const c = d.conversation
  const facts = [
    ['Nombre', c.contact_name],
    ['Correo', c.contact_email],
    ['Teléfono', c.contact_phone],
    ['Empresa', c.contact_company],
    ['Le interesa', c.interest],
    ['Sitio', c.origin],
    ['País', c.country],
  ].filter(([, v]) => v)
  return (
    <aside class="ib-contact card" aria-label="Datos del contacto">
      <div class="ib-contact-head">
        <span class="lead-sec-t" style="margin:0">Contacto</span>
        <button class="icon-x ib-contact-close" onClick={onClose} aria-label="Cerrar datos del contacto"><Icon name="x" size={14} /></button>
      </div>
      {c.escalation_reason && (
        <div class="ib-box">
          <span class="lead-sec-t">Motivo del traspaso</span>
          <p>{REASON[c.escalation_reason] || c.escalation_reason}</p>
          {c.escalation_note && <p class="small">{c.escalation_note}</p>}
        </div>
      )}
      <div class="ib-box">
        <span class="lead-sec-t">Resumen de la IA</span>
        <p>{c.summary || <span class="muted">Generando resumen…</span>}</p>
        {c.next_step && <p class="small muted">Siguiente paso sugerido: {c.next_step}</p>}
      </div>
      {facts.length > 0 && (
        <dl class="lead-facts">
          {facts.map(([k, v]) => (
            <Fragment key={k}>
              <dt class="muted">{k}</dt>
              <dd style="margin:0;word-break:break-word">{v}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      <div class="ib-box">
        <span class="lead-sec-t">Tiempos</span>
        <dl class="lead-facts" style="margin-top:0">
          <dt class="muted">Inicio</dt><dd style="margin:0">{date(c.started_at)}</dd>
          {c.escalated_at && <><dt class="muted">Escalada</dt><dd style="margin:0">{date(c.escalated_at)}</dd></>}
          {c.assigned_at && <><dt class="muted">Asignación</dt><dd style="margin:0">{dur(c.assigned_at - c.escalated_at)}</dd></>}
          {c.first_human_response_at && <><dt class="muted">1.ª respuesta</dt><dd style="margin:0">{dur(c.first_human_response_at - c.escalated_at)}</dd></>}
        </dl>
      </div>
      {d.history.length > 0 && (
        <div class="ib-box">
          <span class="lead-sec-t">Conversaciones anteriores</span>
          <ul class="ib-history">
            {d.history.map((h) => (
              <li key={h.id}>
                <span class="small muted">{date(h.last_message_at)} · {STATUS[h.status]?.label}</span>
                <div class="small">{h.summary || h.title || 'Sin resumen'}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}

/* ---------- configuración (supervisores y admins) ---------- */
export function InboxConfig({ api, boot, reloadBoot, readOnly }) {
  const isAdmin = ['owner', 'editor'].includes(boot.me.role)
  const [metrics, setMetrics] = useState(null)
  useEffect(() => {
    api.get('inbox/metrics?days=7').then(setMetrics).catch(() => {})
  }, [])
  return (
    <div class="ib-config">
      <div class="kpis" style="margin-bottom:18px">
        <div class="kpi"><span class="lead-sec-t">Escaladas (7 días)</span><b class="ib-kpi">{metrics ? metrics.escalated : '…'}</b><span class="small muted">{metrics ? `${metrics.ai_only} de ${metrics.conversations} las resolvió solo la IA` : ''}</span></div>
        <div class="kpi"><span class="lead-sec-t">Tiempo hasta asignar</span><b class="ib-kpi">{metrics ? dur(metrics.avg_assign_ms) : '…'}</b><span class="small muted">promedio</span></div>
        <div class="kpi"><span class="lead-sec-t">Primera respuesta</span><b class="ib-kpi">{metrics ? dur(metrics.avg_first_response_ms) : '…'}</b><span class="small muted">desde que escaló</span></div>
        <div class="kpi"><span class="lead-sec-t">Sin atender</span><b class="ib-kpi">{metrics ? metrics.abandoned : '…'}</b><span class="small muted">cerradas antes de asignarse</span></div>
      </div>
      <div class="cols">
        <div class="col-main">
          <TeamStatus boot={boot} />
          <Queues api={api} boot={boot} reloadBoot={reloadBoot} readOnly={readOnly || !isAdmin} />
        </div>
        <div class="col-side">
          <QuickReplies api={api} boot={boot} reloadBoot={reloadBoot} readOnly={readOnly} />
        </div>
      </div>
    </div>
  )
}

function TeamStatus({ boot }) {
  return (
    <div class="card" style="margin-bottom:18px">
      <div class="card-title">Equipo</div>
      <p class="small muted" style="margin-top:0">Para sumar agentes o supervisores, invítalos en <a href="#/equipo">Equipo</a>. Cada quien cambia su estado arriba a la derecha.</p>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Persona</th><th>Rol</th><th>Estado</th><th>Activas</th></tr></thead>
          <tbody>
            {boot.team.map((u) => (
              <tr key={u.id}>
                <td>{u.name || u.email}</td>
                <td class="small">{ROLE[u.role] || u.role}</td>
                <td><span class={'ib-dot ib-' + u.status} aria-hidden="true" /> {PRESENCE[u.status]}</td>
                <td class="small">{u.load} de {u.max_chats}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Queues({ api, boot, reloadBoot, readOnly }) {
  const [edit, setEdit] = useState(null)
  const [busy, run] = useAction()
  const save = async (e) => {
    e.preventDefault()
    const body = { name: edit.name, members: edit.members }
    const r = await run(() => (edit.id ? api.put(`inbox/queues/${edit.id}`, body) : api.post('inbox/queues', body)), 'Cola guardada')
    if (r) {
      setEdit(null)
      reloadBoot()
    }
  }
  return (
    <div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
        Colas
        {!readOnly && <button class="b" onClick={() => setEdit({ name: '', members: [] })}><Icon name="plus" size={14} /> Nueva cola</button>}
      </div>
      <p class="small muted" style="margin-top:0">Sin colas, cualquier persona en línea recibe conversaciones. Con colas (por ejemplo Ventas y Soporte), cada asistente escala a su cola y solo la ven sus integrantes, supervisores y administradores.</p>
      {boot.queues.length === 0 ? (
        <p class="small muted">Todavía no hay colas.</p>
      ) : (
        <ul class="ib-qlist">
          {boot.queues.map((q) => (
            <li key={q.id}>
              <div>
                <b>{q.name}</b>
                <div class="small muted">{q.members.length ? q.members.map((id) => boot.team.find((u) => u.id === id)?.name || boot.team.find((u) => u.id === id)?.email).filter(Boolean).join(', ') : 'Sin integrantes'}</div>
              </div>
              {!readOnly && (
                <div class="nowrap">
                  <button class="link" onClick={() => setEdit({ id: q.id, name: q.name, members: q.members })}>Editar</button>
                  <button class="link link-danger" style="margin-left:10px" onClick={() => confirm(`¿Borrar la cola «${q.name}»? Sus conversaciones pasan a la cola general.`) && run(() => api.del(`inbox/queues/${q.id}`), 'Cola borrada').then(reloadBoot)}>Borrar</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && setEdit(null)}>
          <form class="modal" role="dialog" aria-modal="true" aria-labelledby="ib-q-t" onSubmit={save}>
            <h3 id="ib-q-t">{edit.id ? 'Editar cola' : 'Nueva cola'}</h3>
            <Field label="Nombre"><input value={edit.name} maxLength={60} required autoFocus onInput={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Ej.: Ventas" /></Field>
            <div class="l" style="margin-top:12px">Integrantes</div>
            <div class="ib-members">
              {boot.team.map((u) => (
                <label key={u.id} class="ib-member">
                  <input type="checkbox" checked={edit.members.includes(u.id)} onChange={(e) => setEdit({ ...edit, members: e.target.checked ? [...edit.members, u.id] : edit.members.filter((x) => x !== u.id) })} />
                  {u.name || u.email} <span class="small muted">· {ROLE[u.role] || u.role}</span>
                </label>
              ))}
            </div>
            <div style="margin-top:18px;justify-content:flex-end;gap:8px;display:flex">
              <button type="button" class="b" onClick={() => setEdit(null)}>Cancelar</button>
              <button class="b b-primary" disabled={busy}>Guardar</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

function QuickReplies({ api, boot, reloadBoot, readOnly }) {
  const [f, setF] = useState({ id: null, shortcut: '', text: '' })
  const [busy, run] = useAction()
  const save = async (e) => {
    e.preventDefault()
    const body = { shortcut: f.shortcut.replace(/^\//, ''), text: f.text }
    const r = await run(() => (f.id ? api.put(`inbox/quick-replies/${f.id}`, body) : api.post('inbox/quick-replies', body)), 'Respuesta guardada')
    if (r) {
      setF({ id: null, shortcut: '', text: '' })
      reloadBoot()
    }
  }
  return (
    <div class="card">
      <div class="card-title">Respuestas rápidas</div>
      <p class="small muted" style="margin-top:0">En el chat escribe <b>/</b> y el atajo para insertarla.</p>
      <ul class="ib-qlist">
        {boot.quick_replies.map((q) => (
          <li key={q.id}>
            <div style="min-width:0">
              <b>/{q.shortcut}</b>
              <div class="small muted ib-clip">{q.text}</div>
            </div>
            {!readOnly && (
              <div class="nowrap">
                <button class="link" onClick={() => setF(q)}>Editar</button>
                <button class="link link-danger" style="margin-left:10px" onClick={() => run(() => api.del(`inbox/quick-replies/${q.id}`), 'Respuesta borrada').then(reloadBoot)}>Borrar</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <form onSubmit={save} style="margin-top:12px">
          <Field label="Atajo"><input value={f.shortcut} maxLength={30} required onInput={(e) => setF({ ...f, shortcut: e.target.value })} placeholder="horario" /></Field>
          <Field label="Texto"><textarea rows="3" value={f.text} maxLength={1000} required onInput={(e) => setF({ ...f, text: e.target.value })} placeholder="Nuestro horario es de lunes a viernes de 9 a 18 h." /></Field>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="b b-primary" disabled={busy}>{f.id ? 'Guardar cambios' : 'Agregar'}</button>
            {f.id && <button type="button" class="b" onClick={() => setF({ id: null, shortcut: '', text: '' })}>Cancelar</button>}
          </div>
        </form>
      )}
    </div>
  )
}
