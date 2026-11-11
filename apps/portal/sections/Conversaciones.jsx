import { useEffect, useState } from 'preact/hooks'
import Markdown from '../../shared/Markdown.jsx'
import { date, num } from '../../shared/api.js'
import { toast } from '../../shared/toast.jsx'
import { Field, PageHead, useAction } from './common.jsx'
import { Icon } from './icons.jsx'

/* Temperatura del prospecto (la pone el análisis con IA; el equipo la puede corregir) */
export const LEAD = {
  hot: { label: 'Caliente', cls: 'lead-hot' },
  warm: { label: 'Tibio', cls: 'lead-warm' },
  cold: { label: 'Frío', cls: 'lead-cold' },
  none: { label: 'No prospecto', cls: 'lead-none' },
}
/* Seguimiento: lo mueve el equipo */
const STAGES = [
  { id: 'new', label: 'Por contactar' },
  { id: 'contacted', label: 'Contactado' },
  { id: 'won', label: 'Ganado' },
  { id: 'lost', label: 'Perdido' },
]
const isProspect = (c) => c.lead_status === 'hot' || c.lead_status === 'warm' || c.lead_status === 'cold'
const pendingOf = (c) => !c.analyzed_at || c.analyzed_at < c.last_message_at

const EMPTY = { lead: '', contact: '', stage: '', channel: '', status: '', rating: '' }

export function LeadPill({ status, score }) {
  if (!status) return <span class="lead-pill lead-pending">Sin analizar</span>
  const l = LEAD[status] || LEAD.none
  return (
    <span class={'lead-pill ' + l.cls}>
      {status === 'hot' && <Icon name="flame" size={12} />}
      {l.label}
      {status !== 'none' && score != null && <b>{score}</b>}
    </span>
  )
}

const waLink = (phone) => {
  let d = phone.replace(/\D/g, '')
  if (d.length === 10) d = '52' + d // número de México sin lada de país
  return `https://wa.me/${d}`
}

export default function Conversaciones({ api, ov, me, readOnly, agentId, param }) {
  const [q, setQ] = useState('')
  const [agent, setAgent] = useState(agentId || '')
  const [range, setRange] = useState('30')
  const [f, setF] = useState(EMPTY)
  const [more, setMore] = useState(false)
  const [page, setPage] = useState(0)
  const [list, setList] = useState(null)
  const [stats, setStats] = useState(null)
  const [sel, setSel] = useState(param || null)
  const [detail, setDetail] = useState(null)
  const [rules, setRules] = useState(false)
  const [busy, run] = useAction()
  const [sweeping, setSweeping] = useState(false)
  const owner = me.user.role === 'owner'
  const canEdit = !readOnly

  const from = range === 'all' ? 0 : Date.now() - Number(range) * 86_400_000
  const params = (extra = {}) => {
    const p = new URLSearchParams(extra)
    if (q) p.set('q', q)
    if (agent) p.set('agent', agent)
    if (from) p.set('from', String(from))
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v)
    return p
  }
  const statsParams = () => {
    const p = new URLSearchParams()
    if (agent) p.set('agent', agent)
    if (from) p.set('from', String(from))
    if (f.channel) p.set('channel', f.channel)
    return p
  }
  const load = () => {
    api.get(`conversations?${params({ page: String(page) })}`).then(setList).catch(() => setList({ items: [], total: 0 }))
    api.get(`conversations/stats?${statsParams()}`).then(setStats).catch(() => setStats(null))
  }
  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0)
    return () => clearTimeout(t)
  }, [q, agent, range, f, page])
  useEffect(() => {
    if (param) setSel(param)
  }, [param])
  useEffect(() => {
    setDetail(null)
    if (sel) api.get(`conversations/${sel}`).then(setDetail).catch(() => setSel(null))
  }, [sel])

  const setFilter = (patch) => {
    setF({ ...f, ...patch })
    setPage(0)
  }
  const extraCount = ['contact', 'stage', 'channel', 'status', 'rating'].filter((k) => f[k]).length

  // Cambios en la conversación abierta se reflejan en la lista sin recargar todo
  const patchConv = (c) => {
    setDetail((d) => (d ? { ...d, conversation: c } : d))
    setList((l) => (l ? { ...l, items: l.items.map((x) => (x.id === c.id ? { ...x, ...c } : x)) } : l))
    api.get(`conversations/stats?${statsParams()}`).then(setStats).catch(() => {})
  }

  const del = async () => {
    if (!confirm('¿Borrar esta conversación? No se puede deshacer.')) return
    const r = await run(() => api.del(`conversations/${sel}`), 'Conversación borrada')
    if (r) {
      setSel(null)
      load()
    }
  }
  const reanalyze = async () => {
    const r = await run(() => api.post(`conversations/${sel}/analyze`))
    if (r) {
      patchConv(r.conversation)
      toast(r.warning || 'Listo, la conversación se volvió a analizar')
    }
  }
  const sweep = async () => {
    setSweeping(true)
    const r = await run(() => api.post(`conversations/analyze-pending${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`))
    setSweeping(false)
    if (r) {
      toast(r.pending ? `Analicé ${r.analyzed}. Faltan ${r.pending}: vuelve a darle clic para seguir.` : `Listo: analicé ${r.analyzed} conversaciones`)
      load()
    }
  }

  return (
    <>
      <PageHead title="Conversaciones" sub="Lo que platicaron con tu agente, con un resumen de cada una y los prospectos que dejó.">
        <div class="row" style="gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="b b-outline b-sm" onClick={() => setRules(true)}><Icon name="target" size={15} />Reglas de prospectos</button>
          {/* Los totales y las descargas (Excel / CSV) viven en Reportes */}
          <a class="b b-ghost b-sm" href={`#/a/${agentId}/reportes`}><Icon name="report" size={15} />Ver reportes</a>
        </div>
      </PageHead>

      {stats?.pending > 0 && canEdit && (
        <div class={'lead-top' + (sel ? ' conv-open' : '')}>
          <div class="lead-pending-bar">
            <span><b>{num(stats.pending)}</b> {stats.pending === 1 ? 'conversación sigue' : 'conversaciones siguen'} sin resumen. Se analizan solas cuando terminan o tras {30} min sin mensajes.</span>
            <button class="b b-outline b-sm" onClick={sweep} disabled={sweeping}><Icon name="refresh" size={14} />{sweeping ? 'Analizando…' : 'Analizar ahora'}</button>
          </div>
        </div>
      )}

      <div class={'cols conv-cols' + (sel ? ' conv-open' : '')}>
        <div class="col-form">
          <div class="card" style="padding:14px">
            <input class="in" style="margin-top:0" placeholder="Buscar en mensajes, nombres, correos…" value={q} onInput={(e) => { setQ(e.target.value); setPage(0) }} aria-label="Buscar" />
            <div class="conv-filters">
              <select class="in" value={f.lead} onChange={(e) => setFilter({ lead: e.target.value })} aria-label="Tipo">
                <option value="">Todas</option>
                <option value="prospect">Solo prospectos</option>
                <option value="hot">Calientes</option>
                <option value="warm">Tibios</option>
                <option value="cold">Fríos</option>
                <option value="none">No prospectos</option>
                <option value="pending">Sin analizar</option>
              </select>
              <select class="in" value={range} onChange={(e) => { setRange(e.target.value); setPage(0) }} aria-label="Periodo">
                <option value="1">Últimas 24 h</option>
                <option value="7">Últimos 7 días</option>
                <option value="30">Últimos 30 días</option>
                <option value="90">Últimos 90 días</option>
                <option value="all">Todo</option>
              </select>
              {more && (
                <>
                  <select class="in" value={f.contact} onChange={(e) => setFilter({ contact: e.target.value })} aria-label="Datos de contacto">
                    <option value="">Con o sin datos</option>
                    <option value="any">Dejó teléfono o correo</option>
                    <option value="phone">Dejó teléfono</option>
                    <option value="email">Dejó correo</option>
                    <option value="missing">Prospecto sin datos</option>
                  </select>
                  <select class="in" value={f.stage} onChange={(e) => setFilter({ stage: e.target.value })} aria-label="Seguimiento">
                    <option value="">Cualquier seguimiento</option>
                    {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                  <select class="in" value={f.channel} onChange={(e) => setFilter({ channel: e.target.value })} aria-label="Canal">
                    <option value="">Chat y llamadas</option>
                    <option value="chat">Solo chat</option>
                    <option value="voice">Solo llamadas</option>
                  </select>
                  <select class="in" value={f.status} onChange={(e) => setFilter({ status: e.target.value })} aria-label="Estado">
                    <option value="">Abiertas y finalizadas</option>
                    <option value="open">Abiertas</option>
                    <option value="ended">Finalizadas</option>
                  </select>
                  <select class="in" value={f.rating} onChange={(e) => setFilter({ rating: e.target.value })} aria-label="Calificación">
                    <option value="">Cualquier calificación</option>
                    <option value="4">4★ o más</option>
                    <option value="5">5★</option>
                  </select>
                  {ov.agents.length > 1 && (
                    <select class="in" value={agent} onChange={(e) => { setAgent(e.target.value); setPage(0) }} aria-label="Agente">
                      <option value="">Todos los agentes</option>
                      {ov.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  )}
                </>
              )}
            </div>
            <div class="row" style="margin-top:8px;gap:6px">
              <button type="button" class="conv-more" onClick={() => setMore(!more)} aria-expanded={more}>
                <Icon name="filter" size={13} />{more ? 'Menos filtros' : 'Más filtros'}{!more && extraCount > 0 && <span class="conv-more-n">{extraCount}</span>}
              </button>
              <span class="grow" />
              {(Object.values(f).some(Boolean) || q) && (
                <button type="button" class="conv-more" onClick={() => { setF(EMPTY); setQ(''); setPage(0) }}>Limpiar</button>
              )}
            </div>
            <div class="conv-list" style="margin-top:6px">
              {!list ? (
                <div class="loading">Cargando…</div>
              ) : list.items.length === 0 ? (
                <div class="empty">{Object.values(f).some(Boolean) || q ? 'Nada coincide con estos filtros.' : 'Sin conversaciones en este periodo.'}</div>
              ) : (
                list.items.map((c) => (
                  <button key={c.id} class={'conv-item' + (sel === c.id ? ' on' : '')} onClick={() => setSel(c.id)}>
                    <div class="row" style="gap:6px;flex-wrap:nowrap">
                      <span class="grow conv-name">
                        {c.channel === 'voice' && <span class="conv-ch" title="Llamada"><Icon name="phone" size={12} /></span>}
                        {c.contact_name || c.title || 'Sin mensajes'}
                      </span>
                      {pendingOf(c) && !c.lead_status ? <span class="lead-pill lead-pending">{c.ended_at ? 'Analizando' : 'Abierta'}</span> : <LeadPill status={c.lead_status} score={c.lead_score} />}
                    </div>
                    {c.summary && <div class="conv-sum">{c.summary}</div>}
                    <div class="small muted conv-meta">
                      <span>{date(c.last_message_at)}</span>
                      <span>· {c.message_count} msj</span>
                      {(c.contact_phone || c.contact_email) && <span class="conv-has" title="Dejó datos de contacto"><Icon name={c.contact_phone ? 'phone' : 'mail'} size={11} /></span>}
                      {isProspect(c) && c.lead_stage && c.lead_stage !== 'new' && <span class={'stage-tag stage-' + c.lead_stage}>{STAGES.find((s) => s.id === c.lead_stage)?.label}</span>}
                      {ov.agents.length > 1 && c.agent_name && <span>· {c.agent_name}</span>}
                    </div>
                  </button>
                ))
              )}
            </div>
            {list && list.total > 30 && (
              <div class="row" style="margin-top:10px">
                <button class="b b-ghost b-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>← Anteriores</button>
                <span class="small muted grow nowrap" style="text-align:center">{page * 30 + 1}–{Math.min(list.total, (page + 1) * 30)} de {list.total}</span>
                <button class="b b-ghost b-sm" disabled={(page + 1) * 30 >= list.total} onClick={() => setPage(page + 1)}>Siguientes →</button>
              </div>
            )}
          </div>
        </div>
        <div class="col-main">
          <div class="card conv-detail" style="min-height:420px">
            {sel && <button type="button" class="b b-ghost b-sm conv-back" onClick={() => setSel(null)}>← Volver a la lista</button>}
            {!sel ? (
              <div class="empty">Elige una conversación para ver su resumen, los datos del prospecto y la transcripción.</div>
            ) : !detail ? (
              <div class="loading">Cargando…</div>
            ) : (
              <>
                <div class="row conv-head">
                  <div class="grow small muted conv-head-meta">
                    {detail.conversation.channel === 'voice' ? 'Llamada' : 'Chat'} · iniciada {date(detail.conversation.started_at)}
                    {detail.conversation.origin && ` · ${detail.conversation.origin}`}
                    {detail.conversation.country && ` · ${detail.conversation.country}`}
                  </div>
                  {canEdit && <button class="b b-ghost b-sm" onClick={reanalyze} disabled={busy} title="Vuelve a generar el resumen y los datos del prospecto"><Icon name="refresh" size={14} />{detail.conversation.analyzed_at ? 'Volver a analizar' : 'Analizar'}</button>}
                  {owner && canEdit && <button class="b b-danger b-sm" onClick={del} disabled={busy}>Borrar</button>}
                </div>

                <LeadPanel api={api} c={detail.conversation} canEdit={canEdit} onChange={patchConv} onAnalyze={reanalyze} busy={busy} />

                {detail.conversation.ended_at && (
                  <div class="alert alert-ok" style="margin:14px 0">
                    Finalizada por {detail.conversation.ended_by === 'agent' ? 'el agente' : 'el visitante'} el {date(detail.conversation.ended_at)}
                    {detail.conversation.rating ? ` · calificación ${'★'.repeat(detail.conversation.rating)}${'☆'.repeat(5 - detail.conversation.rating)}` : ' · sin calificación'}
                  </div>
                )}
                <div class="lead-sec-t" style="margin-top:18px">Transcripción</div>
                <div class="transcript">
                  {detail.messages.map((m) => (
                    <div key={m.id} style={`display:flex;flex-direction:column;align-items:${m.role === 'user' ? 'flex-end' : 'flex-start'}`}>
                      <div class={'tmsg ' + m.role}>{m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}</div>
                      <div class="tmeta">
                        {date(m.created_at)}
                        {m.role === 'assistant' && m.tokens_in + m.tokens_out > 0 && ` · ${m.tokens_in + m.tokens_out} tokens`}
                        {m.feedback === 1 && ' · 👍'}
                        {m.feedback === -1 && ' · 👎'}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {rules && <RulesModal api={api} agentId={agentId || ov.agents[0]?.id} canEdit={canEdit} onClose={() => setRules(false)} />}
    </>
  )
}

/** Resumen + prospecto + contacto de la conversación abierta */
function LeadPanel({ api, c, canEdit, onChange, onAnalyze, busy }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [saving, run] = useAction()
  useEffect(() => setEditing(false), [c.id])

  if (!c.analyzed_at) {
    return (
      <div class="lead-panel lead-empty">
        <Icon name="spark" size={18} />
        <div class="grow">
          <b>Todavía sin resumen</b>
          <div class="small muted">{c.ended_at ? 'Se está analizando; tarda unos segundos.' : 'Se analiza sola cuando la conversación termina o tras 30 minutos sin mensajes.'}</div>
        </div>
        {canEdit && <button class="b b-primary b-sm" onClick={onAnalyze} disabled={busy}>Analizar ahora</button>}
      </div>
    )
  }

  const save = async (patch, msg) => {
    const r = await run(() => api.put(`conversations/${c.id}/lead`, patch), msg)
    if (r) onChange(r.conversation)
    return r
  }
  const startEdit = () => {
    setForm({ contact_name: c.contact_name || '', contact_phone: c.contact_phone || '', contact_email: c.contact_email || '', contact_company: c.contact_company || '' })
    setEditing(true)
  }
  const saveEdit = async (e) => {
    e.preventDefault()
    if (await save(form, 'Datos guardados')) setEditing(false)
  }
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Copiado'))
  const stale = c.analyzed_at < c.last_message_at
  const hasContact = c.contact_name || c.contact_phone || c.contact_email || c.contact_company

  return (
    <div class="lead-panel">
      <div class="lead-main">
        <div class="row" style="gap:8px;margin-bottom:8px">
          <span class="lead-sec-t" style="margin:0">Resumen</span>
          <LeadPill status={c.lead_status} score={c.lead_score} />
          {stale && <span class="small muted">· hubo mensajes después del análisis</span>}
        </div>
        <p class="lead-summary">{c.summary}</p>
        {(c.interest || c.next_step) && (
          <dl class="lead-facts">
            {c.interest && (<><dt>Le interesa</dt><dd>{c.interest}</dd></>)}
            {c.next_step && (<><dt>Siguiente paso</dt><dd>{c.next_step}</dd></>)}
          </dl>
        )}
        {canEdit && c.lead_status !== 'none' && (
          <div class="lead-stage">
            <span class="lead-sec-t" style="margin:0 0 6px">Seguimiento</span>
            <div class="seg seg-sm" role="group" aria-label="Seguimiento">
              {STAGES.map((s) => (
                <button key={s.id} type="button" class={'b' + ((c.lead_stage || 'new') === s.id ? ' on' : '')} disabled={saving} onClick={() => (c.lead_stage || 'new') !== s.id && save({ lead_stage: s.id })}>{s.label}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div class="lead-contact">
        <div class="row" style="margin-bottom:8px">
          <span class="lead-sec-t grow" style="margin:0">Contacto</span>
          {canEdit && !editing && <button type="button" class="conv-more" onClick={startEdit}><Icon name="edit" size={13} />{hasContact ? 'Editar' : 'Agregar'}</button>}
        </div>
        {editing ? (
          <form onSubmit={saveEdit} class="lead-form">
            <input class="in" placeholder="Nombre" value={form.contact_name} maxLength={80} onInput={(e) => setForm({ ...form, contact_name: e.target.value })} aria-label="Nombre" />
            <input class="in" placeholder="Teléfono" inputMode="tel" value={form.contact_phone} maxLength={40} onInput={(e) => setForm({ ...form, contact_phone: e.target.value })} aria-label="Teléfono" />
            <input class="in" placeholder="Correo" type="email" value={form.contact_email} maxLength={120} onInput={(e) => setForm({ ...form, contact_email: e.target.value })} aria-label="Correo" />
            <input class="in" placeholder="Empresa" value={form.contact_company} maxLength={100} onInput={(e) => setForm({ ...form, contact_company: e.target.value })} aria-label="Empresa" />
            <div class="row" style="gap:6px;margin-top:4px">
              <button class="b b-primary b-sm" disabled={saving}>Guardar</button>
              <button type="button" class="b b-ghost b-sm" onClick={() => setEditing(false)}>Cancelar</button>
            </div>
          </form>
        ) : !hasContact ? (
          <p class="small muted" style="margin:0">El visitante no dejó datos de contacto.</p>
        ) : (
          <ul class="lead-cards">
            {c.contact_name && <li><Icon name="user" size={15} /><span class="grow">{c.contact_name}</span></li>}
            {c.contact_phone && (
              <li>
                <Icon name="phone" size={15} />
                <a class="grow" href={`tel:${c.contact_phone}`}>{c.contact_phone}</a>
                <a class="lead-act" href={waLink(c.contact_phone)} target="_blank" rel="noopener" title="Abrir en WhatsApp"><Icon name="whatsapp" size={15} /></a>
                <button type="button" class="lead-act" onClick={() => copy(c.contact_phone)} title="Copiar"><Icon name="copy" size={14} /></button>
              </li>
            )}
            {c.contact_email && (
              <li>
                <Icon name="mail" size={15} />
                <a class="grow" href={`mailto:${c.contact_email}`}>{c.contact_email}</a>
                <button type="button" class="lead-act" onClick={() => copy(c.contact_email)} title="Copiar"><Icon name="copy" size={14} /></button>
              </li>
            )}
            {c.contact_company && <li><Icon name="building" size={15} /><span class="grow">{c.contact_company}</span></li>}
          </ul>
        )}
        {canEdit && (
          <label class="l" style="margin-top:12px">
            Temperatura
            <select class="in" value={c.lead_status || 'none'} disabled={saving} onChange={(e) => save({ lead_status: e.target.value }, 'Temperatura actualizada')}>
              {Object.entries(LEAD).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
        )}
      </div>
    </div>
  )
}

const FIELDS = [
  { id: 'name', label: 'Nombre' },
  { id: 'phone', label: 'Teléfono / WhatsApp' },
  { id: 'email', label: 'Correo' },
  { id: 'company', label: 'Empresa' },
]

/** Qué cuenta como prospecto, qué datos pide el asistente y cuándo avisar por correo (por asistente) */
function RulesModal({ api, agentId, canEdit, onClose }) {
  const [cfg, setCfg] = useState(null)
  const [busy, run] = useAction()
  useEffect(() => {
    api.get(`agents/${agentId}`).then((a) => setCfg({ lead_criteria: a.lead_criteria || '', lead_fields: a.lead_fields || [], lead_alerts: a.lead_alerts || 'hot' }))
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const toggle = (id) => setCfg({ ...cfg, lead_fields: cfg.lead_fields.includes(id) ? cfg.lead_fields.filter((x) => x !== id) : [...cfg.lead_fields, id] })
  const save = async (e) => {
    e.preventDefault()
    const r = await run(() => api.put(`agents/${agentId}`, cfg), 'Reglas guardadas')
    if (r) onClose()
  }
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="rules-title" style="width:min(600px,100%)">
        <div class="row" style="align-items:flex-start">
          <div class="grow">
            <h2 id="rules-title">Reglas de prospectos</h2>
            <p class="sub" style="margin-top:4px">Al terminar cada conversación, Zentekia escribe un resumen, decide si es un posible cliente y guarda los datos de contacto que dejó. Puedes apagar los prospectos de un asistente en Herramientas.</p>
          </div>
          <button type="button" class="icon-x" onClick={onClose} aria-label="Cerrar"><Icon name="x" /></button>
        </div>
        {!cfg ? (
          <div class="loading">Cargando…</div>
        ) : (
          <form onSubmit={save}>
            <fieldset disabled={!canEdit} style="border:0;padding:0;margin:0">
              <Field label="¿Qué es un prospecto para tu negocio?" hint="Opcional. Ej.: «Empresas que preguntan por planes de 10 usuarios o más, o personas que quieren agendar una demo. Quien pide soporte de su cuenta NO es prospecto».">
                <textarea rows="3" value={cfg.lead_criteria} maxLength={1500} onInput={(e) => setCfg({ ...cfg, lead_criteria: e.target.value })} />
              </Field>
              <div class="l">Datos que el asistente debe pedir</div>
              <p class="small muted" style="margin:2px 0 0">Cuando el visitante muestre interés real, el asistente se los pedirá de forma natural. Sin marcar ninguno, no los pide.</p>
              <div class="req-ch">
                {FIELDS.map((x) => {
                  const on = cfg.lead_fields.includes(x.id)
                  return (
                    <label key={x.id} class={'req-chip pick' + (on ? ' on' : '')}>
                      <input type="checkbox" checked={on} onChange={() => toggle(x.id)} />
                      {x.label}
                      {on && <Icon name="check" size={14} />}
                    </label>
                  )
                })}
              </div>
              <Field label="Avisarme por correo cuando llegue un prospecto">
                <select class="in" value={cfg.lead_alerts} onChange={(e) => setCfg({ ...cfg, lead_alerts: e.target.value })}>
                  <option value="hot">Solo calientes</option>
                  <option value="warm">Calientes y tibios</option>
                  <option value="off">No avisar</option>
                </select>
              </Field>
              <p class="small muted" style="margin-top:14px">Los avisos llegan a los propietarios de la cuenta. El análisis usa el modelo de Zentekia y se suma a tu consumo (normalmente una fracción de centavo por conversación).</p>
            </fieldset>
            <div class="row" style="margin-top:20px;justify-content:flex-end">
              <button type="button" class="b b-ghost" onClick={onClose}>Cancelar</button>
              {canEdit && <button class="b b-primary" disabled={busy}>Guardar reglas</button>}
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
