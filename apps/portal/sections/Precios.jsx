import { useEffect, useState } from 'preact/hooks'
import { num, usd } from '../../shared/api.js'
import { toast } from '../../shared/toast.jsx'
import { Loading, PageHead, useAction, useLoad } from './common.jsx'
import { Icon } from './icons.jsx'
import { AgentAvatar } from './Asistentes.jsx'

/** Conceptos que el cliente puede cobrar (lo mismo que maneja billing/resale.ts en el Worker) */
const FIELDS = [
  { id: 'message_usd', key: 'message_micro', label: 'Por mensaje (chat)', hint: 'Cada respuesta del asistente', unit: 'USD por mensaje', money: true, ph: '0.05', sec: 'Precio' },
  { id: 'minute_usd', key: 'minute_micro', label: 'Por minuto (voz)', hint: 'Proporcional a los segundos', unit: 'USD por minuto', money: true, ph: '0.30', sec: 'Precio' },
  { id: 'included_in', key: 'included_in', label: 'Tokens de entrada incluidos', hint: 'Por mensaje. Lo que pase es excedente', unit: 'tokens', ph: '6000', sec: 'Tokens incluidos por mensaje' },
  { id: 'included_out', key: 'included_out', label: 'Tokens de salida incluidos', hint: 'Por mensaje. Lo que pase es excedente', unit: 'tokens', ph: '500', sec: 'Tokens incluidos por mensaje' },
  { id: 'excess_in_usd_1m', key: 'excess_in_per_1m_micro', label: 'Excedente de entrada', hint: 'Precio de los tokens de más', unit: 'USD por 1M tokens', money: true, ph: '1.00', sec: 'Precio del excedente' },
  { id: 'excess_out_usd_1m', key: 'excess_out_per_1m_micro', label: 'Excedente de salida', hint: 'Precio de los tokens de más', unit: 'USD por 1M tokens', money: true, ph: '4.00', sec: 'Precio del excedente' },
]
const SECTIONS = [...new Set(FIELDS.map((f) => f.sec))]

/** Valor guardado (micros o tokens) → texto del input */
const toInput = (f, v) => (v == null ? null : f.money ? String(v / 1e6) : String(v))

/** Cómo se muestra un valor guardado */
const show = (f, v) =>
  v == null
    ? f.key.startsWith('included')
      ? 'sin límite'
      : 'no cobras'
    : f.money
      ? `${usd(v)}${f.key === 'message_micro' ? ' / msj' : f.key === 'minute_micro' ? ' / min' : ' / 1M'}`
      : `${num(v)} tokens`

/** Inputs del formulario → lo que espera el backend (vacío = null) */
const toPayload = (vals) => {
  const out = {}
  for (const f of FIELDS) {
    const v = vals[f.id]
    out[f.id] = v == null || String(v).trim() === '' ? null : f.money ? Number(v) : Math.max(0, Math.round(Number(v)) || 0)
  }
  return out
}

/** Resumen corto del precio que aplica a un asistente */
function PriceSummary({ p }) {
  const parts = []
  if (p.message_micro != null) parts.push(`${usd(p.message_micro)}/msj`)
  if (p.minute_micro != null) parts.push(`${usd(p.minute_micro)}/min`)
  if (p.included_in != null || p.included_out != null) parts.push(`${p.included_in != null ? num(p.included_in) : '∞'} / ${p.included_out != null ? num(p.included_out) : '∞'} tokens`)
  return <span class="small">{parts.length ? parts.join(' · ') : <span class="muted">Sin precio</span>}</span>
}

export default function Precios({ api, ov }) {
  const thisMonth = new Date().toISOString().slice(0, 7)
  const [period, setPeriod] = useState(thisMonth)
  const { data, error, reload } = useLoad(() => api.get(`resale?period=${period}`), [period])
  const [editing, setEditing] = useState(null)
  if (!data) return <Loading error={error} />

  const t = data.totals
  const margin = t.charged_micro > 0 ? Math.round((t.profit_micro / t.charged_micro) * 100) : null
  const hasGeneral = Object.keys(data.general).length > 0
  const agentFor = (id, name) => ov.agents.find((a) => a.id === id) || { name }

  return (
    <>
      <PageHead title="Tus precios" sub="Lo que cobras a tus clientes por cada asistente. No cambia lo que le pagas a Zentekia: sirve para ver cuánto ganas.">
        <input type="month" class="in" style="width:auto;margin-top:0" value={period} max={thisMonth} onInput={(e) => e.target.value && setPeriod(e.target.value)} aria-label="Mes" />
      </PageHead>
      <div class="kpis">
        <div class="kpi">
          <div class="k">Cobras a tus clientes</div>
          <div class="v">{usd(t.charged_micro, 2)}</div>
          <div class="s">con tus precios</div>
        </div>
        <div class="kpi">
          <div class="k">Pagas a Zentekia</div>
          <div class="v">{usd(t.paid_micro, 2)}</div>
          <div class="s">tu consumo del mes</div>
        </div>
        <div class="kpi">
          <div class="k">Tu ganancia</div>
          <div class={'v ' + (t.profit_micro < 0 ? 'neg' : 'pos')}>
            {t.profit_micro < 0 ? '−' : ''}
            {usd(Math.abs(t.profit_micro), 2)}
          </div>
          <div class="s">{margin == null ? 'sin cobros todavía' : `${margin} % de margen`}</div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <div class="grow">
            <div class="card-title">Precio general</div>
            <div class="small muted" style="margin-top:2px">Aplica a todos tus asistentes, salvo los que tengan precio especial.</div>
          </div>
          <button type="button" class="b b-outline b-sm price-open" onClick={() => setEditing({ kind: 'general' })}>
            <span class="price-ic" aria-hidden="true">$</span>
            {hasGeneral ? 'Editar precio general' : 'Poner precio general'}
          </button>
        </div>
        <div class="price-general">
          {FIELDS.map((f) => (
            <div key={f.id} class="price-cell">
              <div class="k">{f.label}</div>
              <div class="v">{show(f, data.general[f.key])}</div>
            </div>
          ))}
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-title">Por asistente</div>
        <div class="small muted" style="margin-top:2px">Lo que cobras y lo que te queda en {period}. Da clic en Precios para ponerle a un asistente un precio distinto al general.</div>
        {data.agents.length === 0 ? (
          <div class="empty">Todavía no tienes asistentes.</div>
        ) : (
          <div class="tbl-wrap">
            <table class="tbl price-tbl" style="margin-top:8px">
              <thead>
                <tr>
                  <th>Asistente</th>
                  <th>Precio</th>
                  <th class="num">Mensajes</th>
                  <th class="num">Minutos</th>
                  <th class="num">Cobras</th>
                  <th class="num">Pagas</th>
                  <th class="num">Ganancia</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.agents.map((a) => {
                  const special = Object.keys(a.special).length > 0
                  return (
                    <tr key={a.id}>
                      <td>
                        <span class="row" style="gap:10px;flex-wrap:nowrap">
                          <AgentAvatar agent={agentFor(a.id, a.name)} size={26} />
                          <b>{a.name}</b>
                        </span>
                      </td>
                      <td>
                        <PriceSummary p={a.effective} />
                        <div><span class={'price-tag' + (special ? ' on' : '')}>{special ? 'Especial' : 'General'}</span></div>
                      </td>
                      <td class="num">{num(a.usage.msgs)}</td>
                      <td class="num">{num(Math.round((a.usage.voice_secs / 60) * 10) / 10)}</td>
                      <td class="num">
                        {usd(a.charge.total)}
                        {a.charge.excess > 0 && <div class="small muted">{usd(a.charge.excess)} excedente</div>}
                      </td>
                      <td class="num">{usd(a.paid_micro)}</td>
                      <td class={'num ' + (a.profit_micro < 0 ? 'neg' : 'pos')}>
                        {a.profit_micro < 0 ? '−' : '+'}
                        {usd(Math.abs(a.profit_micro))}
                      </td>
                      <td class="nowrap">
                        <button type="button" class="b b-outline b-sm price-open" onClick={() => setEditing({ kind: 'agent', agent: a })}>
                          <span class="price-ic" aria-hidden="true">$</span>Precios
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <PriceModal
          api={api}
          title={editing.kind === 'general' ? 'Precio general' : `Precios · ${editing.agent.name}`}
          general={editing.kind === 'general' ? null : data.general}
          current={editing.kind === 'general' ? data.general : editing.agent.special}
          usage={editing.kind === 'agent' ? editing.agent.usage : null}
          path={editing.kind === 'general' ? 'resale' : `agents/${editing.agent.id}/resale`}
          onClose={(changed) => {
            setEditing(null)
            if (changed) reload()
          }}
        />
      )}
    </>
  )
}

/**
 * Ventana para editar precios.
 * Sin `general` edita el precio general; con `general` edita el de un asistente,
 * donde cada concepto puede usar el general o uno especial.
 */
function PriceModal({ api, title, general, current, usage, path, onClose }) {
  const perAgent = general != null
  const [vals, setVals] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.id, toInput(f, current[f.key]) ?? ''])))
  const [mode, setMode] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.id, current[f.key] != null ? 'especial' : 'general'])))
  const [busy, run] = useAction()

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    const v = { ...vals }
    if (perAgent) {
      const missing = FIELDS.find((f) => mode[f.id] === 'especial' && String(v[f.id]).trim() === '')
      if (missing) return toast(`Escribe el valor de "${missing.label}" o cámbialo a General.`)
      for (const f of FIELDS) if (mode[f.id] === 'general') v[f.id] = ''
    }
    if (await run(() => api.put(path, toPayload(v)), perAgent ? 'Precios del asistente guardados' : 'Precio general guardado')) onClose(true)
  }

  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose(false)}>
      <div class="modal price-modal" role="dialog" aria-modal="true" aria-labelledby="price-title">
        <div class="row" style="align-items:flex-start">
          <div class="grow">
            <h2 id="price-title">{title}</h2>
            <p class="sub" style="margin-top:4px">
              Lo que tú cobras a tus clientes.{' '}
              {perAgent ? 'Elige General para usar tu precio general o Especial para uno distinto en este asistente.' : 'Vacío = no cobras ese concepto (o sin límite, en los tokens incluidos).'}
            </p>
          </div>
          <button type="button" class="icon-x" onClick={() => onClose(false)} aria-label="Cerrar"><Icon name="x" /></button>
        </div>
        <form onSubmit={submit}>
          {SECTIONS.map((sec) => (
            <div key={sec}>
              <div class="price-sec">{sec}</div>
              <div class="price-grid">
                {FIELDS.filter((f) => f.sec === sec).map((f) => {
                  const special = !perAgent || mode[f.id] === 'especial'
                  return (
                    <div key={f.id} class={'price-field' + (perAgent && special ? ' is-special' : '')}>
                      <div class="price-field-head">
                        <div class="grow">
                          <div class="price-field-label">{f.label}</div>
                          <div class="small muted">{f.hint}</div>
                        </div>
                        {perAgent && (
                          <div class="seg seg-xs" role="group" aria-label={f.label}>
                            <button type="button" class={'b' + (special ? '' : ' on')} aria-pressed={!special} onClick={() => setMode({ ...mode, [f.id]: 'general' })}>General</button>
                            <button type="button" class={'b' + (special ? ' on' : '')} aria-pressed={special} onClick={() => setMode({ ...mode, [f.id]: 'especial' })}>Especial</button>
                          </div>
                        )}
                      </div>
                      {special ? (
                        <div class="price-input">
                          <input
                            class="in"
                            type="number"
                            min="0"
                            step={f.money ? '0.0001' : '1'}
                            placeholder={perAgent ? f.ph : `${f.ph} (vacío = ${f.key.startsWith('included') ? 'sin límite' : 'no cobras'})`}
                            value={vals[f.id]}
                            onInput={(e) => setVals({ ...vals, [f.id]: e.target.value })}
                            aria-label={f.label}
                          />
                          <span class="small muted">{f.unit}</span>
                        </div>
                      ) : (
                        <div class="price-gen">Usa el general: <b>{show(f, general[f.key])}</b></div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          <details class="price-help">
            <summary>¿Cómo se calcula lo que cobras?</summary>
            <ol>
              <li>Cada respuesta del asistente cobra el <b>precio por mensaje</b>.</li>
              <li>Si una respuesta usa más tokens de los incluidos, los tokens de más se cobran al <b>precio del excedente</b> (por millón de tokens).</li>
              <li>Las llamadas se cobran por <b>minuto</b>, proporcional a los segundos.</li>
              <li>Los resúmenes automáticos de prospectos no cuentan como mensaje.</li>
            </ol>
            {usage && (
              <div class="small muted">
                Este mes este asistente lleva {num(usage.msgs)} mensajes, {num(Math.round((usage.voice_secs / 60) * 10) / 10)} min de llamada y {num(usage.tokens_in + usage.tokens_out)} tokens.
              </div>
            )}
          </details>
          <div class="row" style="margin-top:18px;justify-content:flex-end">
            <button type="button" class="b b-ghost" onClick={() => onClose(false)}>Cancelar</button>
            <button class="b b-primary" disabled={busy}>Guardar</button>
          </div>
        </form>
      </div>
    </div>
  )
}
