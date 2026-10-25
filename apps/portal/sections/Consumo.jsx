import { useState } from 'preact/hooks'
import { num, perM, usd } from '../../shared/api.js'
import { PORTAL_BASE } from '../env.js'
import { Loading, PageHead, useLoad } from './common.jsx'

/** Barras de tokens por día (una serie, color principal, tooltip por barra) */
function DailyChart({ daily, period }) {
  const [hover, setHover] = useState(null)
  const [y, mo] = period.split('-').map(Number)
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  const byDay = Object.fromEntries(daily.map((d) => [Number(d.day.slice(8, 10)), d]))
  const vals = Array.from({ length: days }, (_, i) => byDay[i + 1] || { day: `${period}-${String(i + 1).padStart(2, '0')}`, tin: 0, tout: 0, cost: 0 })
  const max = Math.max(1, ...vals.map((v) => v.tin + v.tout))
  const W = 720
  const H = 180
  const padL = 44
  const padB = 22
  const bw = (W - padL) / days
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f))
  const h = hover != null ? vals[hover] : null
  return (
    <div style="position:relative">
      <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Tokens por día en ${period}`} preserveAspectRatio="none">
        {ticks.map((tk) => {
          const yy = H - padB - (tk / max) * (H - padB - 10)
          return (
            <g key={tk}>
              <line class="gl" x1={padL} x2={W} y1={yy} y2={yy} />
              <text x={padL - 6} y={yy + 3} text-anchor="end">{tk >= 1000 ? `${Math.round(tk / 1000)}k` : tk}</text>
            </g>
          )
        })}
        {vals.map((v, i) => {
          const tot = v.tin + v.tout
          const bh = (tot / max) * (H - padB - 10)
          const x = padL + i * bw + 1
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + i * bw} y={0} width={bw} height={H - padB} fill="transparent" />
              {tot > 0 && <path class="bx" d={roundTop(x, H - padB - bh, Math.max(1, bw - 2), bh, Math.min(4, (bw - 2) / 2))} opacity={hover == null || hover === i ? 1 : 0.55} />}
              {(i === 0 || (i + 1) % 5 === 0) && <text x={x + (bw - 2) / 2} y={H - 6} text-anchor="middle">{i + 1}</text>}
            </g>
          )
        })}
      </svg>
      {h && (
        <div class="tooltip">
          <b>{h.day}</b>
          <div>{num(h.tin + h.tout)} tokens</div>
          <div class="muted">{usd(h.cost)}</div>
        </div>
      )}
    </div>
  )
}
function roundTop(x, y, w, h, r) {
  if (h <= r) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

function Calculator({ prices, avg, current }) {
  const [convs, setConvs] = useState(1000)
  const [model, setModel] = useState(current || prices[0]?.id)
  const p = prices.find((x) => x.id === model) || prices[0]
  if (!p) return null
  const cost = Math.ceil((convs * (avg.tokens_in * p.in_per_1m_micro + avg.tokens_out * p.out_per_1m_micro)) / 1e6)
  return (
    <div class="card">
      <div class="card-title">Calculadora</div>
      <div class="row" style="margin-top:12px;font-size:14px">
        Con
        <input class="in" type="number" min="0" step="100" value={convs} onInput={(e) => setConvs(Number(e.target.value) || 0)} style="width:110px;margin-top:0" aria-label="Conversaciones al mes" />
        conversaciones al mes usando
        <select class="in" style="width:auto;margin-top:0" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Modelo">
          {prices.map((x) => (
            <option key={x.id} value={x.id}>{x.name}</option>
          ))}
        </select>
        pagarías aproximadamente <b style="font-size:18px">{usd(cost, 2)}</b> al mes.
      </div>
      <div class="small muted" style="margin-top:8px">
        Calculado con {num(avg.tokens_in)} tokens de entrada y {num(avg.tokens_out)} de salida por conversación
        {avg.sample ? ` (promedio de tus últimas ${num(avg.sample)} conversaciones)` : ' (valor típico; se ajusta con tu uso real)'}.
        {p.type === 'byok' && ' Es solo el fee de plataforma: tu proveedor te cobra aparte.'}
      </div>
    </div>
  )
}

export default function Consumo({ api }) {
  const thisMonth = new Date().toISOString().slice(0, 7)
  const [period, setPeriod] = useState(thisMonth)
  const { data, error } = useLoad(() => api.get(`usage?period=${period}`), [period])
  const [stmt, setStmt] = useState(null)
  if (!data) return <Loading error={error} />
  const pct = data.limit_micro > 0 ? (data.totals.cost_micro / data.limit_micro) * 100 : 0
  const openStmt = async (p) => setStmt(await api.get(`statements/${p}`))
  return (
    <>
      <PageHead title="Consumo y costos" sub="Todo se mide en tokens. Aquí ves cuánto llevas, cuánto vas a pagar y a qué tarifa.">
        <input type="month" class="in" style="width:auto;margin-top:0" value={period} max={thisMonth} onInput={(e) => e.target.value && setPeriod(e.target.value)} aria-label="Mes" />
      </PageHead>
      <div class="kpis">
        <div class="kpi">
          <div class="k">Costo {period === thisMonth ? 'del mes en curso' : 'del mes'}</div>
          <div class="v">{usd(data.totals.cost_micro)}</div>
          <div class="s">USD</div>
        </div>
        {period === thisMonth && (
          <div class="kpi">
            <div class="k">Estimado al cierre</div>
            <div class="v">{usd(data.projection_micro, 2)}</div>
            <div class="s">si sigues al mismo ritmo</div>
          </div>
        )}
        <div class="kpi">
          <div class="k">Tokens</div>
          <div class="v">{num(data.totals.tokens_in + data.totals.tokens_out)}</div>
          <div class="s">{num(data.totals.tokens_in)} entrada · {num(data.totals.tokens_out)} salida</div>
        </div>
        {data.limit_micro > 0 && (
          <div class="kpi">
            <div class="k">Límite mensual</div>
            <div class="v">{usd(data.limit_micro, 2)}</div>
            <div class={'bar' + (pct >= 100 ? ' over' : '')} style="margin-top:8px" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin="0" aria-valuemax="100" aria-label="Uso del límite">
              <div style={`width:${Math.min(100, Math.max(pct, 1))}%`} />
            </div>
            <div class="s">{Math.round(pct)} % usado · al llegar al 100 % {data.limit_behavior === 'block' ? 'el agente deja de responder' : 'sigue respondiendo con aviso'}</div>
          </div>
        )}
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-title">Tokens por día</div>
        <DailyChart daily={data.daily} period={period} />
        <details style="margin-top:6px">
          <summary class="small muted" style="cursor:pointer">Ver como tabla</summary>
          <table class="tbl" style="margin-top:6px">
            <thead><tr><th>Día</th><th class="num">Entrada</th><th class="num">Salida</th><th class="num">Costo</th></tr></thead>
            <tbody>
              {data.daily.map((d) => (
                <tr key={d.day}><td>{d.day}</td><td class="num">{num(d.tin)}</td><td class="num">{num(d.tout)}</td><td class="num">{usd(d.cost)}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>

      <div class="cols" style="margin-top:14px">
        <div class="col-main">
          <div class="card">
            <div class="card-title">Desglose por modelo</div>
            {data.by_model.length === 0 ? (
              <div class="empty">Sin consumo en este periodo.</div>
            ) : (
              <div class="tbl-wrap">
                <table class="tbl">
                  <thead><tr><th>Modelo</th><th class="num">Mensajes</th><th class="num">Entrada</th><th class="num">Salida</th><th class="num">Importe</th></tr></thead>
                  <tbody>
                    {data.by_model.map((b) => (
                      <tr key={b.model_id}>
                        <td>{b.name}{b.model_type === 'byok' && <div class="small muted">fee de plataforma</div>}{b.model_type === 'voice' && <div class="small muted">cobro por minuto · Mensajes = llamadas</div>}</td>
                        <td class="num">{num(b.n)}</td>
                        <td class="num">{num(b.tin)}</td>
                        <td class="num">{num(b.tout)}</td>
                        <td class="num">{usd(b.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <Calculator prices={data.prices} avg={data.avg_per_conversation} current={data.current_model} />
        </div>
        <div class="col-side">
          <div class="card">
            <div class="card-title">Tarifas por 1M tokens</div>
            <table class="tbl" style="margin-top:6px">
              <thead><tr><th>Modelo</th><th class="num">Entrada</th><th class="num">Salida</th></tr></thead>
              <tbody>
                {data.prices.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}{p.type === 'byok' && <div class="small muted">fee de plataforma</div>}</td>
                    <td class="num">{perM(p.in_per_1m_micro)}</td>
                    <td class="num">{perM(p.out_per_1m_micro)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class="small muted" style="margin-top:8px">Precios en USD. Con tu propia API key tu proveedor te cobra aparte.</div>
          </div>
          <div class="card">
            <div class="card-title">Estados de cuenta</div>
            {data.statements.length === 0 ? (
              <div class="small muted" style="margin-top:8px">Aún no hay estados de cuenta emitidos.</div>
            ) : (
              <table class="tbl" style="margin-top:6px">
                <tbody>
                  {data.statements.map((s) => (
                    <tr key={s.period}>
                      <td>{s.period}</td>
                      <td class="num">{usd(s.total_micro, 2)}</td>
                      <td><span class={'badge ' + (s.status === 'paid' ? 'badge-ok' : 'badge-warn')}>{s.status === 'paid' ? 'Pagado' : 'Por pagar'}</span></td>
                      <td class="nowrap">
                        <button class="link" onClick={() => openStmt(s.period)}>Ver</button>{' '}
                        <a href={`${PORTAL_BASE}/statements/${s.period}?format=csv`} style="margin-left:8px">CSV</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
      {stmt && <StatementModal s={stmt} onClose={() => setStmt(null)} />}
    </>
  )
}

function StatementModal({ s, onClose }) {
  const st = s.statement
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-label={`Estado de cuenta ${st.period}`}>
        <div class="row">
          <h2 class="grow">Estado de cuenta {st.period}</h2>
          <button class="b b-ghost b-sm" onClick={() => window.print()}>Imprimir / PDF</button>
          <button class="b b-ghost b-sm" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        <div class="small muted" style="margin-top:4px">{s.tenant.name} · Zentekia</div>
        <table class="tbl" style="margin-top:14px">
          <thead><tr><th>Modelo</th><th class="num">Entrada</th><th class="num">Salida</th><th class="num">Tarifa (1M)</th><th class="num">Importe</th></tr></thead>
          <tbody>
            {st.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.model}{l.type === 'byok' && <div class="small muted">fee de plataforma</div>}</td>
                <td class="num">{num(l.tokens_in)}</td>
                <td class="num">{num(l.tokens_out)}</td>
                <td class="num small">{perM(l.in_per_1m_micro)} / {perM(l.out_per_1m_micro)}</td>
                <td class="num">{usd(l.cost_micro)}</td>
              </tr>
            ))}
            <tr><td><b>Total</b></td><td class="num">{num(st.tokens_in)}</td><td class="num">{num(st.tokens_out)}</td><td /><td class="num"><b>{usd(st.total_micro, 2)} USD</b></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
