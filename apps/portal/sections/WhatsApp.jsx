/*
  Canal de WhatsApp de un asistente (fase 2 omnicanal): conectar el número con la API key del BSP
  (360dialog o YCloud), ver su estado y calidad, y desconectarlo.
*/
import { useState } from 'preact/hooks'
import { date } from '../../shared/api.js'
import { Field, Loading, PageHead, useAction, useLoad } from './common.jsx'
import { Icon } from './icons.jsx'
import './whatsapp.css'

const QUALITY = {
  GREEN: { label: 'Alta', cls: 'badge-ok' },
  YELLOW: { label: 'Media', cls: 'badge-warn' },
  RED: { label: 'Baja', cls: 'badge-danger' },
}

export default function WhatsApp({ api, agent, me, readOnly, reload }) {
  const { data, error, reload: reloadCh, setData } = useLoad(() => api.get(`whatsapp/${agent.id}`), [agent.id])
  const [busy, run] = useAction()
  if (!data) return <Loading error={error} />
  const owner = me.user.role === 'owner' && !readOnly
  const ch = data.channel
  const after = (r) => {
    if (r) {
      setData({ ...data, channel: r.channel ?? null })
      reload?.()
    }
  }
  return (
    <>
      <PageHead title="Canal de WhatsApp" sub="Tu asistente atiende en tu número de WhatsApp Business con el mismo conocimiento y tono que tu chat. Las conversaciones llegan a Conversaciones y a la Bandeja." />
      <div class="cols">
        <div class="col-main">
          {ch ? (
            <div class="card">
              <div class="wa-head">
                <span class="wa-ic" aria-hidden="true"><Icon name="whatsapp" size={22} /></span>
                <div style="flex:1;min-width:0">
                  <div class="wa-phone">{ch.display_phone || `+${ch.phone}`}</div>
                  <div class="small muted">{ch.verified_name || 'Sin nombre verificado'} · {data.providers.find((p) => p.id === ch.provider)?.name || ch.provider} · llave ••••{ch.last4}</div>
                </div>
                <span class={'badge ' + (ch.status === 'connected' ? 'badge-ok' : 'badge-danger')}>{ch.status === 'connected' ? 'Conectado' : 'Con error'}</span>
              </div>
              <dl class="lead-facts" style="margin-top:16px">
                <dt class="muted">Calidad del número</dt>
                <dd style="margin:0">{ch.quality_rating ? <span class={'badge ' + (QUALITY[ch.quality_rating]?.cls || '')}>{QUALITY[ch.quality_rating]?.label || ch.quality_rating}</span> : '—'}</dd>
                <dt class="muted">Último mensaje recibido</dt>
                <dd style="margin:0">{ch.last_inbound_at ? date(ch.last_inbound_at) : 'Todavía ninguno'}</dd>
                <dt class="muted">Conectado desde</dt>
                <dd style="margin:0">{date(ch.created_at)}</dd>
              </dl>
              {ch.last_error && <div class="alert alert-warn" style="margin-top:14px">{ch.last_error}</div>}
              {!readOnly && (
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px">
                  <button class="b" disabled={busy} onClick={() => run(() => api.post(`whatsapp/${agent.id}/refresh`), 'Estado actualizado').then(after)}><Icon name="refresh" size={14} /> Actualizar estado</button>
                  {owner && (
                    <button class="b b-danger" disabled={busy} onClick={() => confirm(`¿Desconectar ${ch.display_phone || ch.phone}? El asistente deja de contestar por WhatsApp. Las conversaciones anteriores se conservan.`) && run(() => api.del(`whatsapp/${agent.id}`), 'WhatsApp desconectado').then((r) => r && (setData({ ...data, channel: null }), reload?.()))}>Desconectar</button>
                  )}
                </div>
              )}
            </div>
          ) : owner ? (
            <Connect api={api} agent={agent} providers={data.providers} done={after} />
          ) : (
            <div class="card">
              <p style="margin:0">Este asistente todavía no tiene un número de WhatsApp. {readOnly ? '' : 'Pide al propietario de la cuenta que lo conecte.'}</p>
            </div>
          )}
        </div>
        <div class="col-side">
          <div class="card">
            <div class="card-title">Cómo funciona</div>
            <ul class="wa-list">
              <li>El asistente contesta los mensajes que llegan a tu número, con sus instrucciones, conocimiento y herramientas.</li>
              <li>Si activas <b>Pasar a la Bandeja</b> en <a href={`#/a/${agent.id}/herramientas`}>Herramientas</a>, tu equipo atiende en vivo desde la <a href="#/bandeja">Bandeja</a>, junto con el chat web.</li>
              <li>WhatsApp permite escribir libremente hasta 24 horas después del último mensaje del cliente. Después solo se pueden mandar <b>plantillas aprobadas</b> por Meta.</li>
              <li>Tu cuenta de WhatsApp sigue siendo tuya: la llave se guarda cifrada y puedes desconectarla cuando quieras.</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  )
}

function Connect({ api, agent, providers, done }) {
  const [provider, setProvider] = useState(providers[0]?.id || '360dialog')
  const [key, setKey] = useState('')
  const [numbers, setNumbers] = useState(null)
  const [phone, setPhone] = useState('')
  const [busy, run] = useAction()
  const prov = providers.find((p) => p.id === provider)
  const check = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post(`whatsapp/${agent.id}/numbers`, { provider, api_key: key }))
    if (r) {
      setNumbers(r.numbers)
      setPhone(r.numbers.length === 1 ? r.numbers[0].phone : '')
    }
  }
  const connect = async () => {
    const r = await run(() => api.post(`whatsapp/${agent.id}`, { provider, api_key: key, phone }), 'WhatsApp conectado')
    if (r) done(r)
  }
  return (
    <form class="card" onSubmit={check}>
      <div class="card-title">Conectar un número</div>
      <p class="small muted" style="margin-top:0">Necesitas una cuenta con el proveedor oficial (BSP) y tu número ya dado de alta ahí. Pega la API key y elige el número.</p>
      <div class="wa-prov" role="radiogroup" aria-label="Proveedor">
        {providers.map((p) => (
          <label key={p.id} class={'wa-prov-opt' + (provider === p.id ? ' on' : '')}>
            <input type="radio" name="wa-prov" value={p.id} checked={provider === p.id} onChange={() => { setProvider(p.id); setNumbers(null); setPhone('') }} />
            <b>{p.name}</b>
            <span class="small muted">{p.key_hint}</span>
          </label>
        ))}
      </div>
      <Field label={`API key de ${prov?.name || 'tu proveedor'}`} hint={<>¿Aún no tienes cuenta? <a href={prov?.signup} target="_blank" rel="noopener noreferrer">Crear cuenta en {prov?.name}</a></>}>
        <input type="password" autoComplete="off" value={key} maxLength={400} required onInput={(e) => { setKey(e.target.value); setNumbers(null) }} />
      </Field>
      {!numbers ? (
        <button class="b b-primary" style="margin-top:16px" disabled={busy || key.trim().length < 8}>Verificar llave</button>
      ) : (
        <>
          <div class="l" style="margin-top:16px">Número</div>
          <div class="wa-nums">
            {numbers.map((n) => (
              <label key={n.phone} class={'wa-num' + (phone === n.phone ? ' on' : '')}>
                <input type="radio" name="wa-num" value={n.phone} checked={phone === n.phone} onChange={() => setPhone(n.phone)} />
                <span><b>{n.display || `+${n.phone}`}</b> <span class="small muted">{[n.verified_name, n.status, n.quality && `calidad ${n.quality}`].filter(Boolean).join(' · ')}</span></span>
              </label>
            ))}
          </div>
          <button type="button" class="b b-primary" style="margin-top:16px" disabled={busy || !phone} onClick={connect}>Conectar {phone ? `+${phone}` : ''}</button>
        </>
      )}
    </form>
  )
}
