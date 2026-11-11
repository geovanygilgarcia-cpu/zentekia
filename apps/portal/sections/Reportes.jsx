import { useEffect, useState } from 'preact/hooks'
import { num } from '../../shared/api.js'
import { PORTAL_BASE } from '../env.js'
import { PageHead } from './common.jsx'
import { Icon } from './icons.jsx'
import { AgentAvatar } from './Asistentes.jsx'

const KPIS = [
  { stat: 'total', k: 'Conversaciones' },
  { stat: 'prospects', k: 'Prospectos' },
  { stat: 'hot', k: 'Calientes' },
  { stat: 'to_contact', k: 'Por contactar' },
  { stat: 'with_contact', k: 'Con datos de contacto' },
  { stat: 'won', k: 'Ganados' },
]

const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)} %` : '—')

const COMPARE = [
  { id: 'total', label: 'Conversaciones' },
  { id: 'prospects', label: 'Prospectos' },
  { id: 'hot', label: 'Calientes' },
]

/** Barras horizontales para comparar asistentes */
function UsageBars({ rows }) {
  const [stat, setStat] = useState('total')
  const cur = COMPARE.find((c) => c.id === stat)
  const sorted = [...rows].sort((a, b) => b.s[stat] - a.s[stat] || a.agent.name.localeCompare(b.agent.name))
  const total = sorted.reduce((t, r) => t + r.s[stat], 0)
  const max = Math.max(1, ...sorted.map((r) => r.s[stat]))
  return (
    <div class="card" style="margin-top:14px">
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <div class="grow">
          <div class="card-title">Uso por asistente</div>
          <div class="small muted" style="margin-top:2px">{cur.label} de cada asistente en el periodo, de mayor a menor.</div>
        </div>
        <div class="seg seg-sm" role="group" aria-label="Qué comparar">
          {COMPARE.map((c) => (
            <button key={c.id} type="button" class={'b' + (stat === c.id ? ' on' : '')} aria-pressed={stat === c.id} onClick={() => setStat(c.id)}>{c.label}</button>
          ))}
        </div>
      </div>
      {total === 0 ? (
        <div class="empty">Sin {cur.label.toLowerCase()} en este periodo.</div>
      ) : (
        <ul class="rep-bars" aria-label={`${cur.label} por asistente`}>
          {sorted.map(({ agent, s }) => {
            const v = s[stat]
            return (
              <li key={agent.id} class={v === 0 ? 'zero' : ''}>
                <span class="rep-bar-name"><AgentAvatar agent={agent} size={22} /><span>{agent.name}</span></span>
                <span class="rep-bar-track"><span class="rep-bar-fill" style={`width:${v ? Math.max(1.5, (v / max) * 100) : 0}%`} /></span>
                <span class="rep-bar-val"><b>{num(v)}</b><span class="muted">{pct(v, total)}</span></span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default function Reportes({ api, ov, me }) {
  const [period, setPeriod] = useState('30')
  const [channel, setChannel] = useState('')
  const [totals, setTotals] = useState(null)
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [fmt, setFmt] = useState('xlsx')
  const isOwner = me.user.role === 'owner'
  const from = period === 'all' ? 0 : Date.now() - Number(period) * 86400000

  const params = (agent) => {
    const p = new URLSearchParams()
    if (agent) p.set('agent', agent)
    if (from) p.set('from', String(from))
    if (channel) p.set('channel', channel)
    return p
  }

  useEffect(() => {
    setRows(null)
    setError(null)
    Promise.all([
      api.get(`conversations/stats?${params()}`),
      ...ov.agents.map((a) => api.get(`conversations/stats?${params(a.id)}`).then((s) => ({ agent: a, s }))),
    ])
      .then(([all, ...byAgent]) => {
        setTotals(all)
        setRows(byAgent.sort((a, b) => b.s.total - a.s.total || a.agent.name.localeCompare(b.agent.name)))
      })
      .catch((e) => setError(e.message))
  }, [period, channel])

  const leadsUrl = (agent) => `${PORTAL_BASE}/leads/export.${fmt}?${params(agent)}`
  const convsUrl = (agent) => {
    const p = params(agent)
    p.set('from', String(from || 1))
    p.set('to', String(Date.now() + 60_000))
    return `${PORTAL_BASE}/conversations/export.${fmt}?${p}`
  }
  const fileName = (kind, agent) =>
    `${kind}-${
      agent.name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'asistente'
    }.${fmt}`

  return (
    <>
      <PageHead title="Reportes" sub="Cómo le va a cada asistente: conversaciones, prospectos y seguimiento en el periodo que elijas.">
        <div class="row" style="gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <select class="in" style="width:auto;margin-top:0" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Periodo">
            <option value="1">Últimas 24 h</option>
            <option value="7">Últimos 7 días</option>
            <option value="30">Últimos 30 días</option>
            <option value="90">Últimos 90 días</option>
            <option value="all">Todo</option>
          </select>
          <select class="in" style="width:auto;margin-top:0" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Canal">
            <option value="">Chat y llamadas</option>
            <option value="chat">Solo chat</option>
            <option value="voice">Solo llamadas</option>
          </select>
          {isOwner && (
            <div class="seg" role="group" aria-label="Formato de descarga" title="Formato de los archivos que descargas">
              <button type="button" class={'b' + (fmt === 'xlsx' ? ' on' : '')} aria-pressed={fmt === 'xlsx'} onClick={() => setFmt('xlsx')}>Excel</button>
              <button type="button" class={'b' + (fmt === 'csv' ? ' on' : '')} aria-pressed={fmt === 'csv'} onClick={() => setFmt('csv')}>CSV</button>
            </div>
          )}
        </div>
      </PageHead>
      {error ? (
        <div class="alert alert-danger">{error}</div>
      ) : (
        <>
          <div class="kpis">
            {KPIS.map((k) => (
              <div key={k.stat} class="kpi">
                <div class="k">{k.k}</div>
                <div class="v">{totals ? num(totals[k.stat]) : '—'}</div>
                {k.stat === 'prospects' && totals && <div class="s">{pct(totals.prospects, totals.total)} de las conversaciones</div>}
                {k.stat === 'won' && totals && <div class="s">{pct(totals.won, totals.prospects)} de los prospectos</div>}
              </div>
            ))}
          </div>
          {rows && rows.length > 0 && <UsageBars rows={rows} />}
          <div class="card" style="margin-top:14px">
            <div class="row"><div class="card-title grow">Por asistente</div></div>
            {isOwner && (
              <p class="small muted" style="margin:4px 0 0">
                Da clic en un asistente para ver sus conversaciones. En Descargar, <Icon name="chat" size={12} /> baja sus conversaciones y <Icon name="target" size={12} /> sus prospectos, en {fmt === 'xlsx' ? 'Excel' : 'CSV'} y con el periodo y canal elegidos.
              </p>
            )}
            {!rows ? (
              <div class="loading">Cargando…</div>
            ) : rows.length === 0 ? (
              <div class="empty">Todavía no tienes asistentes.</div>
            ) : (
              <div class="tbl-wrap">
                <table class="tbl rep-tbl" style="margin-top:6px">
                  <thead>
                    <tr>
                      <th>Asistente</th>
                      <th class="num">Conversaciones</th>
                      <th class="num">Prospectos</th>
                      <th class="num">Calientes</th>
                      <th class="num">Por contactar</th>
                      <th class="num">Ganados</th>
                      {isOwner && <th>Descargar</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ agent, s }) => (
                      <tr key={agent.id} class={s.total === 0 ? 'muted' : ''}>
                        <td>
                          <a class="rep-agent" href={`#/a/${agent.id}/conversaciones`} title="Ver sus conversaciones">
                            <AgentAvatar agent={agent} size={26} />
                            <b>{agent.name}</b>
                          </a>
                        </td>
                        <td class="num">{num(s.total)}</td>
                        <td class="num">
                          {num(s.prospects)}
                          {s.total > 0 && <div class="small muted">{pct(s.prospects, s.total)}</div>}
                        </td>
                        <td class="num">{num(s.hot)}</td>
                        <td class="num">{num(s.to_contact)}</td>
                        <td class="num">{num(s.won)}</td>
                        {isOwner && (
                          <td class="nowrap">
                            <span class="rep-dl">
                              <a
                                class={'b b-outline b-sm' + (s.total ? '' : ' is-disabled')}
                                href={s.total ? convsUrl(agent.id) : undefined}
                                download={fileName('conversaciones', agent)}
                                aria-disabled={!s.total}
                                aria-label={`Descargar conversaciones de ${agent.name}`}
                                title={s.total ? 'Descargar sus conversaciones' : 'Sin conversaciones en este periodo'}
                              >
                                <Icon name="chat" size={15} />
                              </a>
                              <a
                                class={'b b-outline b-sm' + (s.prospects ? '' : ' is-disabled')}
                                href={s.prospects ? leadsUrl(agent.id) : undefined}
                                download={fileName('prospectos', agent)}
                                aria-disabled={!s.prospects}
                                aria-label={`Descargar prospectos de ${agent.name}`}
                                title={s.prospects ? 'Descargar sus prospectos' : 'Sin prospectos en este periodo'}
                              >
                                <Icon name="target" size={15} />
                              </a>
                            </span>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {isOwner && (
            <div class="card" style="margin-top:14px">
              <div class="card-title">Exportar todo</div>
              <p class="small muted" style="margin:6px 0 12px">
                {fmt === 'xlsx' ? 'Archivo de Excel' : 'CSV'} de todos los asistentes juntos, con el periodo y canal elegidos. Trae una columna con el nombre del asistente. Cambia el formato arriba (Excel o CSV).
              </p>
              <div class="row" style="gap:8px;flex-wrap:wrap">
                <a class="b b-outline b-sm" href={convsUrl()} download={`conversaciones-todas.${fmt}`}><Icon name="chat" size={15} />Todas las conversaciones</a>
                <a class="b b-outline b-sm" href={leadsUrl()} download={`prospectos-todos.${fmt}`}><Icon name="target" size={15} />Todos los prospectos</a>
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
