import { useEffect, useState } from 'preact/hooks'
import { date, num } from '../../shared/api.js'
import { toast } from '../../shared/toast.jsx'
import { CHAT_ORIGIN } from '../env.js'
import { snippetFor } from './Instalacion.jsx'
import { PageHead, TestWidget } from './common.jsx'
import { Icon } from './icons.jsx'

const DAY = 86_400_000

/** Pantalla de entrada de un asistente: cómo va, qué falta y accesos rápidos */
/** Qué canales tiene prendidos este asistente (un solo código en el sitio sirve para todo) */
function Canales({ api, agent, ov, me, readOnly, reload }) {
  const [busy, setBusy] = useState(false)
  const owner = me.user.role === 'owner' && !readOnly
  const chat = agent.channels?.chat !== 'off'
  const voice = agent.channels?.voice === 'active'
  const toggleChat = async () => {
    if (chat && !voice && !confirm('Si apagas el chat y la voz no está activa, el widget desaparece de tu sitio. ¿Continuar?')) return
    setBusy(true)
    try {
      await api.put(`agents/${agent.id}/channels`, { chat: !chat })
      toast(chat ? 'Chat apagado' : 'Chat activado')
      await reload()
    } catch (e) {
      toast(e.message, true)
    } finally {
      setBusy(false)
    }
  }
  const result = chat && voice ? 'chat y botón «Llamar»' : chat ? 'solo chat' : voice ? 'solo voz (burbuja de teléfono)' : 'nada: el widget está oculto'
  return (
    <div class="card rs-chans">
      <div class="rs-chans-head">
        <div>
          <div class="card-title">Canales en tu sitio</div>
          <div class="small muted" style="margin-top:2px">El mismo código de instalación sirve para todo. Tu widget muestra: <b class={chat || voice ? '' : 'rs-warn'}>{result}</b>.</div>
        </div>
      </div>
      <div class="rs-chans-row">
        <label class={'rs-ch' + (chat ? ' on' : '')}>
          <span class="rs-ch-ic"><Icon name="chat" /></span>
          <span class="grow"><b>Chat</b><span>Conversación por texto</span></span>
          <span class="switch">
            <input type="checkbox" role="switch" checked={chat} disabled={!owner || busy} onChange={toggleChat} aria-label="Chat activo" />
            <i aria-hidden="true" />
          </span>
        </label>
        <a class={'rs-ch' + (voice ? ' on' : '')} href={`#/a/${agent.id}/voz`}>
          <span class="rs-ch-ic"><Icon name="voz" /></span>
          <span class="grow"><b>Voz</b><span>{voice ? 'Activa · configurar' : ov.voice_available ? 'Apagada · activar' : 'Próximamente'}</span></span>
          {voice ? <span class="ag-live">Activo</span> : <Icon name="arrow" size={16} />}
        </a>
      </div>
    </div>
  )
}

export default function Resumen({ api, agent, agentId, ov, me, readOnly, reload }) {
  const [d, setD] = useState(null)
  const [testing, setTesting] = useState(false)
  const owner = me.user.role === 'owner'

  useEffect(() => {
    const from = String(Date.now() - 30 * DAY)
    const q = (extra) => api.get(`conversations?${new URLSearchParams({ agent: agentId, from, ...extra })}`).catch(() => ({ items: [], total: 0 }))
    Promise.all([
      q({}),
      q({ status: 'ended' }),
      api.get(`agents/${agentId}`).catch(() => ({})),
      api.get(`kb?agent=${agentId}`).catch(() => ({ sources: [] })),
    ]).then(([all, ended, cfg, kb]) => setD({ all, ended, cfg, kb }))
  }, [agentId])

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippetFor(agent.widget_key))
      toast('Código copiado: pégalo antes de </body>')
    } catch {
      location.hash = `#/a/${agentId}/instalacion`
    }
  }

  const steps = d && [
    { ok: Boolean(d.cfg.system_prompt?.trim()), t: 'Personalidad e instrucciones', s: 'Qué hace tu negocio y cómo debe responder.', to: 'agente' },
    { ok: (d.kb.sources || []).length > 0, t: 'Base de conocimiento', s: 'Preguntas frecuentes, catálogo o políticas.', to: 'conocimiento' },
    { ok: Boolean(agent.logo_url), t: 'Tu marca en el widget', s: 'Logo, colores y mensaje de bienvenida.', to: 'widget' },
    { ok: d.all.total > 0, t: 'Recibiendo conversaciones', s: 'Instálalo en tu sitio con una línea de código.', to: 'instalacion' },
  ]
  const done = steps ? steps.filter((s) => s.ok).length : 0
  const showSetup = steps && done < steps.length && !readOnly

  return (
    <>
      <PageHead title="Resumen" sub={`Cómo va «${agent.name}» en los últimos 30 días y qué puedes hacer desde aquí.`}>
        <button class="b b-outline b-sm" onClick={() => setTesting(true)}><Icon name="play" size={14} />Probar el chat</button>
      </PageHead>

      {!d ? (
        <div class="loading">Cargando…</div>
      ) : (
        <>
          <Canales api={api} agent={agent} ov={ov} me={me} readOnly={readOnly} reload={reload} />
          <div class="kpis">
            <div class="kpi"><div class="k">Conversaciones</div><div class="v">{num(d.all.total)}</div><div class="s">últimos 30 días</div></div>
            <div class="kpi"><div class="k">Finalizadas</div><div class="v">{num(d.ended.total)}</div><div class="s">{d.all.total ? `${Math.round((d.ended.total / d.all.total) * 100)} % del total` : 'sin datos aún'}</div></div>
            <div class="kpi"><div class="k">Abiertas</div><div class="v">{num(Math.max(0, d.all.total - d.ended.total))}</div><div class="s">en curso o sin cerrar</div></div>
            <div class="kpi"><div class="k">Conocimiento</div><div class="v">{num((d.kb.sources || []).length)}</div><div class="s">fuentes cargadas</div></div>
          </div>

          <div class="rs-grid">
            <div class="rs-col">
              {showSetup && (
                <div class="card rs-setup">
                  <div class="row">
                    <div class="grow">
                      <div class="card-title">Deja listo tu chat</div>
                      <div class="small muted" style="margin-top:2px">{done} de {steps.length} pasos completos</div>
                    </div>
                    {owner && <a class="b b-primary b-sm" href={`#/a/${agentId}/bienvenida`}>Configuración guiada</a>}
                  </div>
                  <div class="bar" style="margin:14px 0 6px"><div style={`width:${(done / steps.length) * 100}%`} /></div>
                  <div class="rs-steps">
                    {steps.map((s) => (
                      <a key={s.to} class={'rs-step' + (s.ok ? ' ok' : '')} href={`#/a/${agentId}/${s.to}`}>
                        <span class="rs-dot">{s.ok ? <Icon name="check" size={14} /> : null}</span>
                        <span class="grow"><b>{s.t}</b><span>{s.s}</span></span>
                        <Icon name="arrow" size={15} />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div class="card">
                <div class="row">
                  <div class="card-title grow">Conversaciones recientes</div>
                  <a class="small" href={`#/a/${agentId}/conversaciones`}>Ver todas</a>
                </div>
                {d.all.items.length === 0 ? (
                  <div class="empty">Aún no hay conversaciones. Prueba tu chat o instálalo en tu sitio.</div>
                ) : (
                  <div class="rs-convs">
                    {d.all.items.slice(0, 5).map((c) => (
                      <a key={c.id} class="rs-conv" href={`#/a/${agentId}/conversaciones`}>
                        <span class="grow">
                          <b>{c.title || 'Sin mensajes'}</b>
                          <span>{date(c.last_message_at)} · {c.message_count} mensajes</span>
                        </span>
                        {c.ended_at ? <span class="badge badge-ok">Finalizada{c.rating ? ` · ${c.rating}★` : ''}</span> : <span class="badge">Abierta</span>}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div class="rs-col">
              <div class="card">
                <div class="card-title">Accesos rápidos</div>
                <div class="rs-actions">
                  <a href={`#/a/${agentId}/agente`}><Icon name="spark" /><b>Personalidad</b><span>Instrucciones y tono</span></a>
                  <a href={`#/a/${agentId}/conocimiento`}><Icon name="book" /><b>Conocimiento</b><span>Sube documentos</span></a>
                  <a href={`#/a/${agentId}/widget`}><Icon name="brush" /><b>Apariencia</b><span>Colores y logo</span></a>
                  <button type="button" onClick={copySnippet}><Icon name="copy" /><b>Copiar código</b><span>Para tu sitio web</span></button>
                </div>
              </div>
              <div class="card rs-next">
                <div class="card-title">Más canales</div>
                <div class="small muted" style="margin-top:2px">El mismo asistente, con lo que ya sabe, atendiendo en más lugares.</div>
                <a class="rs-chan" href={`#/a/${agentId}/voz`}><Icon name="voz" /><span class="grow"><b>Voz</b><span>Tus visitantes hablan con el asistente desde el widget</span></span>{agent.channels?.voice === 'active' ? <span class="ag-live">Activo</span> : agent.channels?.voice === 'available' ? <span class="pill-soon pill-avail">Activar</span> : <span class="pill-soon">Próximamente</span>}</a>
                <a class="rs-chan" href={`#/a/${agentId}/whatsapp`}><Icon name="whatsapp" /><span class="grow"><b>WhatsApp</b><span>Atiende en tu número de negocio</span></span><span class="pill-soon">Próximamente</span></a>
              </div>
            </div>
          </div>
        </>
      )}

      {testing && <TestWidget widgetKey={agent.widget_key} title="Prueba del chat" onClose={() => setTesting(false)} />}
    </>
  )
}
