import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { createApi, date, num, perM, usd } from '../shared/api.js'
import { AuthGate } from '../shared/Auth.jsx'
import { stackTablesOnMobile } from '../shared/tableStack.js'
import { Toasts, toast, toastError } from '../shared/toast.jsx'
import UserMenu from '../shared/UserMenu.jsx'
import { ThemeToggle } from '../shared/Theme.jsx'
import Qr from '../shared/Qr.jsx'
import './admin.css'

const root = document.getElementById('root')
const api = createApi(root.dataset.base)
stackTablesOnMobile(root)

function useAction() {
  const [busy, setBusy] = useState(false)
  const run = async (fn, ok) => {
    setBusy(true)
    try {
      const r = await fn()
      if (ok) toast(ok)
      return r
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  return [busy, run]
}
function useLoad(fn, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const reload = () => fn().then((d) => { setData(d); setError(null) }).catch((e) => setError(e.message))
  useEffect(() => { reload() }, deps)
  return { data, error, reload }
}
const Loading = ({ error }) => (error ? <div class="alert alert-danger">{error}</div> : <div class="loading">Cargando…</div>)
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
const STATUS = { active: ['Activo', 'badge-ok'], suspended: ['Suspendido', 'badge-danger'] }

function Health({ h }) {
  if (!h) return null
  const miss = []
  if (!h.master_key) miss.push('MASTER_KEY (cifrado de API keys y tokens del widget)')
  if (!h.vectorize) miss.push('Vectorize (búsqueda semántica; sin él se usa búsqueda por palabras)')
  if (!h.email) miss.push('RESEND_API_KEY (correos; sin él copias las ligas de invitación a mano)')
  if (!miss.length) return null
  return (
    <div class={'alert ' + (h.master_key ? 'alert-warn' : 'alert-danger')} style="margin-bottom:18px">
      <b>Configuración pendiente en el Worker:</b>
      <ul style="margin:6px 0 0;padding-left:18px">{miss.map((m) => <li key={m}>{m}</li>)}</ul>
    </div>
  )
}

function InviteBox({ r }) {
  if (!r) return null
  return (
    <div class="info" style="margin-top:14px">
      {r.emailed ? 'Enviamos la invitación por correo. ' : 'Copia esta liga y mándasela al cliente (vence en 7 días): '}
      <div class="mono" style="word-break:break-all;margin-top:6px;user-select:all">{r.invite_link}</div>
      <button class="link" style="margin-top:6px;color:inherit" onClick={() => navigator.clipboard?.writeText(r.invite_link).then(() => toast('Liga copiada'))}>Copiar liga</button>
    </div>
  )
}

/* ---------------- Tarifas por cliente (cobro por mensaje / minuto) ---------------- */
const shortTokens = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))
// Conversión entre lo que se escribe en los inputs y lo que guarda el backend
const usdToInput = (micro) => (micro == null ? '' : String(micro / 1e6))
const inputToUsd = (v) => (String(v).trim() === '' ? null : Number(v))
const inputToInt = (v) => (String(v ?? '').trim() === '' ? null : Math.max(0, Math.round(Number(v)) || 0))
const intToInput = (n) => (n == null ? '' : String(n))

/** Resumen de la tarifa de un cliente en la tabla de Clientes */
function RateSummary({ t, g }) {
  if (!g) return null
  const msg = t.price_message_micro ?? g.message_micro
  const inc = t.msg_included_in ?? g.included_in
  const out = t.msg_included_out ?? g.included_out
  const special = t.price_message_micro != null || t.price_minute_micro != null || t.msg_included_in != null || t.msg_included_out != null
  return (
    <div class="rate-sum">
      <span>{msg == null ? 'por tokens' : `${usd(msg)}/msj`}</span>
      {msg != null && (inc != null || out != null) && (
        <span class="muted">· {inc != null ? shortTokens(inc) : '∞'}/{out != null ? shortTokens(out) : '∞'} tokens</span>
      )}
      <span class={'rate-tag' + (special ? ' on' : '')}>{special ? 'Especial' : 'General'}</span>
    </div>
  )
}

/** Un concepto de tarifa que puede usar el valor general o uno especial */
function RateField({ label, hint, unit, general, field, set, step = '0.0001', placeholder }) {
  const special = field.mode === 'especial'
  return (
    <div class={'rate-field' + (special ? ' is-special' : '')}>
      <div class="rate-field-head">
        <div class="grow">
          <div class="rate-field-label">{label}</div>
          {hint && <div class="small muted">{hint}</div>}
        </div>
        <div class="seg seg-xs" role="group" aria-label={label}>
          <button type="button" class={'b' + (special ? '' : ' on')} aria-pressed={!special} onClick={() => set({ ...field, mode: 'general' })}>General</button>
          <button type="button" class={'b' + (special ? ' on' : '')} aria-pressed={special} onClick={() => set({ ...field, mode: 'especial' })}>Especial</button>
        </div>
      </div>
      {special ? (
        <div class="rate-input">
          <input class="in" type="number" min="0" step={step} placeholder={placeholder} value={field.value} onInput={(e) => set({ ...field, value: e.target.value })} aria-label={`${label} (especial)`} autoFocus />
          <span class="muted small">{unit}</span>
        </div>
      ) : (
        <div class="rate-general">Usa el general: <b>{general}</b></div>
      )}
    </div>
  )
}

/** Ventana de tarifas y límites de tokens de un cliente */
function RatesModal({ id, name, models, onClose }) {
  const { data, error } = useLoad(() => api.get(`tenants/${id}`), [id])
  const [f, setF] = useState(null)
  const [busy, run] = useAction()
  useEffect(() => {
    if (!data) return
    const t = data.tenant
    const field = (v, fmt) => ({ mode: v == null ? 'general' : 'especial', value: v == null ? '' : fmt(v) })
    setF({
      message: field(t.price_message_micro, (v) => String(v / 1e6)),
      minute: field(t.price_minute_micro, (v) => String(v / 1e6)),
      inc_in: field(t.msg_included_in, String),
      inc_out: field(t.msg_included_out, String),
    })
  }, [data])
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const g = data?.general_rates
  const set = (k) => (v) => setF({ ...f, [k]: v })
  const effective = (field, general, parse) => (field.mode === 'especial' && String(field.value).trim() !== '' ? parse(field.value) : general)
  const save = async (e) => {
    e.preventDefault()
    if (Object.entries(f).find(([, x]) => x.mode === 'especial' && String(x.value).trim() === '')) return toast('Escribe el valor especial o cambia a General.')
    const val = (x, parse) => (x.mode === 'general' ? null : parse(x.value))
    const r = await run(
      () =>
        api.put(`tenants/${id}`, {
          price_message_usd: val(f.message, Number),
          price_minute_usd: val(f.minute, Number),
          msg_included_in: val(f.inc_in, inputToInt),
          msg_included_out: val(f.inc_out, inputToInt),
        }),
      'Tarifas del cliente guardadas',
    )
    if (r) onClose(true)
  }

  // Ejemplo con el uso real: cuánto pagaría una respuesta promedio
  let example = null
  if (data && f && g) {
    const msg = effective(f.message, g.message_micro, (v) => Math.round(Number(v) * 1e6))
    const inc = effective(f.inc_in, g.included_in, (v) => inputToInt(v))
    const out = effective(f.inc_out, g.included_out, (v) => inputToInt(v))
    const rt = data.reply_tokens
    const model = models.find((m) => m.id === data.agents?.[0]?.model_id)
    const p = model?.price || {}
    const [pin, pout] = model?.type === 'byok' ? [p.fee_input_per_1m_micro || 0, p.fee_output_per_1m_micro || 0] : [p.input_per_1m_micro || 0, p.output_per_1m_micro || 0]
    if (msg != null && rt?.n > 0) {
      const exIn = inc == null ? 0 : Math.max(0, rt.avg_in - inc)
      const exOut = out == null ? 0 : Math.max(0, rt.avg_out - out)
      const over = Math.ceil((exIn * pin + exOut * pout) / 1e6)
      example = { msg, over, exIn, exOut, model }
    }
  }

  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose(false)}>
      <div class="modal rate-modal" role="dialog" aria-modal="true" aria-labelledby="rates-title">
        <div class="row" style="align-items:flex-start">
          <div class="grow">
            <h2 id="rates-title">Tarifas y límites</h2>
            <div class="small muted" style="margin-top:2px">{name || data?.tenant.name}</div>
          </div>
          <button type="button" class="b b-ghost b-sm" onClick={() => onClose(false)} aria-label="Cerrar">✕</button>
        </div>
        {!data || !f || !g ? (
          <Loading error={error} />
        ) : (
          <form onSubmit={save}>
            <div class="rate-sec">Precio</div>
            <div class="rate-grid">
              <RateField label="Por mensaje (chat)" hint="Cada respuesta del asistente" unit="USD por mensaje" placeholder="0.02" general={g.message_micro == null ? 'por tokens' : `${usd(g.message_micro)} por mensaje`} field={f.message} set={set('message')} />
              <RateField label="Por minuto (voz)" hint="Proporcional a los segundos" unit="USD por minuto" placeholder="0.15" general={`${usd(g.minute_micro ?? g.fallback_minute_micro)} por minuto`} field={f.minute} set={set('minute')} />
            </div>
            <div class="rate-sec">Tokens incluidos por mensaje</div>
            <div class="rate-grid">
              <RateField label="Entrada" hint="Instrucciones + conocimiento + historial + pregunta" unit="tokens" step="1" placeholder="6000" general={g.included_in == null ? 'sin límite' : `${num(g.included_in)} tokens`} field={f.inc_in} set={set('inc_in')} />
              <RateField label="Salida" hint="La respuesta del asistente" unit="tokens" step="1" placeholder="500" general={g.included_out == null ? 'sin límite' : `${num(g.included_out)} tokens`} field={f.inc_out} set={set('inc_out')} />
            </div>
            <details class="rate-help">
              <summary>¿Cómo funciona el límite de tokens?</summary>
              <ol>
                <li>Cada respuesta del asistente cobra el <b>precio por mensaje</b>.</li>
                <li>Ese precio incluye hasta los tokens de entrada y salida que pongas aquí.</li>
                <li>Si una respuesta se pasa, los tokens de más se cobran aparte a la <b>tarifa por token del modelo</b> (pestaña Tarifas). Eso es el excedente.</li>
                <li><b>General</b>: usa el límite general. Para que este cliente casi nunca pague excedente, elige <b>Especial</b> y pon un número alto (por ejemplo 100000).</li>
              </ol>
              <div class="small muted">Solo aplica si el cliente paga por mensaje. Los cambios cuentan desde ahora; lo ya cobrado no cambia.</div>
            </details>
            <div class="rate-example">
              {data.reply_tokens?.n > 0 ? (
                <>
                  <b>Uso real de este cliente</b> (últimos 30 días, {num(data.reply_tokens.n)} respuestas): promedio {num(data.reply_tokens.avg_in)} de entrada y {num(data.reply_tokens.avg_out)} de salida; máximo {num(data.reply_tokens.max_in)} / {num(data.reply_tokens.max_out)}.
                  {example && (
                    <div style="margin-top:6px">
                      Con esta configuración, una respuesta promedio pagaría <b>{usd(example.msg + example.over, 4)}</b>
                      {example.over > 0 ? (
                        <>
                          {' '}({usd(example.msg, 4)} del mensaje + {usd(example.over, 4)} de excedente por {example.exIn > 0 ? `${num(example.exIn)} de entrada` : ''}
                          {example.exIn > 0 && example.exOut > 0 ? ' y ' : ''}
                          {example.exOut > 0 ? `${num(example.exOut)} de salida` : ''} de más{example.model ? `, tarifa de ${example.model.display_name}` : ''}).
                        </>
                      ) : (
                        <> (sin excedente).</>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>Este cliente todavía no tiene respuestas en los últimos 30 días, así que no hay promedio para comparar.</>
              )}
            </div>
            <div class="row" style="margin-top:18px;justify-content:flex-end">
              <button type="button" class="b b-ghost" onClick={() => onClose(false)}>Cancelar</button>
              <button class="b b-primary" disabled={busy}>Guardar</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

/* ---------------- Clientes ---------------- */
function Clientes({ health }) {
  const tenants = useLoad(() => api.get('tenants'))
  const models = useLoad(() => api.get('models'))
  const [f, setF] = useState({ name: '', slug: '', owner_email: '', monthly_limit_usd: '', plan_id: 'basico', limit_behavior: 'block', enabled: null, import_prakticall: false })
  const [slugTouched, setSlugTouched] = useState(false)
  const [created, setCreated] = useState(null)
  const [detail, setDetail] = useState(null)
  const [rates, setRates] = useState(null)
  const billing = useLoad(() => api.get('billing'))
  const [busy, run] = useAction()
  const activeModels = models.data?.models.filter((m) => m.active) || []
  const enabled = f.enabled ?? activeModels.map((m) => m.id)
  const portalHost = health?.base_domain ? `${f.slug || 'slug'}.${health.base_domain}` : `${location.host}/p/${f.slug || 'slug'}`

  const create = async (e) => {
    e.preventDefault()
    const r = await run(
      () =>
        api.post('tenants', {
          name: f.name,
          slug: f.slug,
          owner_email: f.owner_email,
          monthly_limit_usd: Number(f.monthly_limit_usd || 0),
          plan_id: f.plan_id,
          limit_behavior: f.limit_behavior,
          enabled_models: enabled,
          import_prakticall: f.import_prakticall,
        }),
      'Cliente creado',
    )
    if (r) {
      setCreated(r)
      setF({ ...f, name: '', slug: '', owner_email: '', monthly_limit_usd: '', import_prakticall: false })
      setSlugTouched(false)
      tenants.reload()
    }
  }
  const impersonate = async (t) => {
    const r = await run(() => api.post(`tenants/${t.id}/impersonate`))
    if (r) window.open(r.url, '_blank', 'noopener')
  }
  const toggle = async (t) => {
    if (t.status === 'active') {
      const msg = prompt(`Mensaje que verán los visitantes de ${t.name} mientras está suspendido:`, 'El chat no está disponible por el momento.')
      if (msg === null) return
      await run(() => api.post(`tenants/${t.id}/suspend`, { message: msg }), 'Cliente suspendido')
    } else await run(() => api.post(`tenants/${t.id}/reactivate`), 'Cliente reactivado')
    tenants.reload()
  }

  const list = tenants.data?.tenants || []
  return (
    <>
    <div class="stats">
      <div class="stat"><div class="k">Clientes</div><div class="v">{list.length}</div></div>
      <div class="stat"><div class="k">Activos</div><div class="v">{list.filter((t) => t.status === 'active').length}</div></div>
      <div class="stat"><div class="k">Tokens del mes</div><div class="v">{num(list.reduce((a, t) => a + t.tokens_in + t.tokens_out, 0))}</div></div>
      <div class="stat"><div class="k">Facturado del mes</div><div class="v">{usd(list.reduce((a, t) => a + t.cost_micro, 0), 2)}</div></div>
    </div>
    <div class="cols">
      <form class="card col-form" onSubmit={create}>
        <h2>Nuevo cliente</h2>
        <label class="l">Nombre del cliente<input value={f.name} onInput={(e) => setF({ ...f, name: e.target.value, slug: slugTouched ? f.slug : slugify(e.target.value) })} required /></label>
        <label class="l">Slug<input value={f.slug} onInput={(e) => { setSlugTouched(true); setF({ ...f, slug: e.target.value.toLowerCase() }) }} pattern="[a-z][a-z0-9\-]{1,30}[a-z0-9]" required /></label>
        <div class="small muted" style="margin-top:6px">Portal: {portalHost}</div>
        <label class="l">Correo del owner<input type="email" value={f.owner_email} onInput={(e) => setF({ ...f, owner_email: e.target.value })} placeholder="correo@cliente.com" required /></label>
        <div class="row" style="align-items:flex-start">
          <label class="l grow">Límite mensual (USD)<input type="number" min="0" step="1" value={f.monthly_limit_usd} onInput={(e) => setF({ ...f, monthly_limit_usd: e.target.value })} placeholder="50" required /></label>
          <label class="l grow">Plan
            <select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: e.target.value })}>
              {(health?.plans || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        <div class="l">Modelos habilitados
          <div class="checks">
            {activeModels.map((m) => (
              <label class="check" key={m.id}>
                <input type="checkbox" checked={enabled.includes(m.id)} onChange={(e) => setF({ ...f, enabled: e.target.checked ? [...enabled, m.id] : enabled.filter((x) => x !== m.id) })} />
                {m.display_name}
              </label>
            ))}
          </div>
        </div>
        <label class="l">Al llegar al límite
          <select value={f.limit_behavior} onChange={(e) => setF({ ...f, limit_behavior: e.target.value })}>
            <option value="block">Bloquear respuestas (por defecto)</option>
            <option value="allow">Permitir excedente con aviso</option>
          </select>
        </label>
        <p class="small muted" style="margin-top:14px">La cuenta nace con un solo asistente: la Guía Zentekia, que explica el portal y ayuda al cliente a crear sus demás asistentes.</p>
        <button class="b b-primary b-block" style="margin-top:22px" disabled={busy}>Crear cliente e invitar</button>
        <InviteBox r={created} />
      </form>

      <div class="card col-main">
        <h2>Clientes</h2>
        {!tenants.data ? (
          <Loading error={tenants.error} />
        ) : tenants.data.tenants.length === 0 ? (
          <div class="empty">Aún no hay clientes. Da de alta el primero con el formulario.</div>
        ) : (
          <div class="tbl-wrap">
            <table class="tbl" style="margin-top:6px">
              <thead><tr><th>Cliente</th><th>Portal</th><th>Estado</th><th class="num">Tokens del mes</th><th class="num">Costo del mes</th><th>Tarifa</th><th>Acciones</th></tr></thead>
              <tbody>
                {tenants.data.tenants.map((t) => {
                  const pct = t.monthly_limit_micro > 0 ? (t.cost_micro / t.monthly_limit_micro) * 100 : 0
                  return (
                    <tr key={t.id}>
                      <td>
                        <button class="link" style="color:var(--ink);text-decoration:none;font-weight:600" onClick={() => setDetail(t.id)}>{t.name}</button>
                        {t.open_alerts > 0 && <span class="badge badge-warn" style="margin-left:6px">{t.open_alerts} alerta{t.open_alerts > 1 ? 's' : ''}</span>}
                        {!t.onboarded && <div class="small muted">Sin configurar</div>}
                      </td>
                      <td class="small"><a href={t.portal_url} target="_blank" rel="noopener">{t.portal}</a></td>
                      <td><span class={'badge ' + STATUS[t.status][1]}>{STATUS[t.status][0]}</span></td>
                      <td class="num">{num(t.tokens_in + t.tokens_out)}</td>
                      <td class="num">
                        {usd(t.cost_micro)}
                        {t.monthly_limit_micro > 0 && <div class="small" style={pct >= 80 ? 'color:var(--danger)' : 'color:var(--muted)'}>{Math.round(pct)} % de {usd(t.monthly_limit_micro, 0)}</div>}
                      </td>
                      <td>
                        <RateSummary t={t} g={billing.data} />
                        <button type="button" class="b b-outline b-sm rate-open" onClick={() => setRates({ id: t.id, name: t.name })}>
                          <span class="rate-ic" aria-hidden="true">$</span>Tarifas y límites
                        </button>
                      </td>
                      <td class="nowrap">
                        <button class="link" onClick={() => impersonate(t)}>Ver como cliente</button>
                        <button class={'link' + (t.status === 'active' ? ' link-danger' : '')} style="margin-left:12px" onClick={() => toggle(t)}>{t.status === 'active' ? 'Suspender' : 'Reactivar'}</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {detail && (
        <TenantModal
          id={detail}
          health={health}
          models={activeModels}
          onClose={() => { setDetail(null); tenants.reload() }}
          onRates={() => setRates({ id: detail, name: tenants.data?.tenants.find((t) => t.id === detail)?.name })}
        />
      )}
      {rates && <RatesModal id={rates.id} name={rates.name} models={models.data?.models || []} onClose={(changed) => { setRates(null); if (changed) tenants.reload() }} />}
    </div>
    </>
  )
}

function TenantModal({ id, health, models, onClose, onRates }) {
  const { data, error, reload } = useLoad(() => api.get(`tenants/${id}`), [id])
  const [f, setF] = useState(null)
  const [inv, setInv] = useState(null)
  const [busy, run] = useAction()
  useEffect(() => {
    if (data) setF({ name: data.tenant.name, plan_id: data.tenant.plan_id, monthly_limit_usd: data.tenant.monthly_limit_micro / 1e6, limit_behavior: data.tenant.limit_behavior, enabled_models: data.tenant.enabled_models, turnstile: Boolean(data.tenant.turnstile) })
  }, [data])
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-label="Detalle del cliente" style="width:min(720px,100%)">
        {!data || !f ? <Loading error={error} /> : (
          <>
            <div class="row"><h2 class="grow">{data.tenant.name}</h2><button class="b b-ghost b-sm" onClick={onClose} aria-label="Cerrar">✕</button></div>
            <div class="small muted">{data.tenant.portal} · creado {date(data.tenant.created_at)} · gasto del mes {usd(data.spend?.cost ?? 0)}</div>
            <form onSubmit={async (e) => { e.preventDefault(); await run(() => api.put(`tenants/${id}`, { ...f, monthly_limit_usd: Number(f.monthly_limit_usd) }), 'Cliente actualizado'); reload() }}>
              <div class="row" style="align-items:flex-start">
                <label class="l grow">Nombre<input value={f.name} onInput={(e) => setF({ ...f, name: e.target.value })} /></label>
                <label class="l grow">Plan<select value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: e.target.value })}>{(health?.plans || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              </div>
              <div class="row" style="align-items:flex-start">
                <label class="l grow">Límite mensual (USD)<input type="number" min="0" value={f.monthly_limit_usd} onInput={(e) => setF({ ...f, monthly_limit_usd: e.target.value })} /></label>
                <label class="l grow">Al llegar al límite<select value={f.limit_behavior} onChange={(e) => setF({ ...f, limit_behavior: e.target.value })}><option value="block">Bloquear</option><option value="allow">Permitir con aviso</option></select></label>
              </div>
              <button type="button" class="b b-outline b-sm rate-open" style="margin-top:14px" onClick={() => onRates?.()}>
                <span class="rate-ic" aria-hidden="true">$</span>Tarifas y límites de tokens
              </button>
              <div class="l">Modelos habilitados<div class="checks">
                {models.map((m) => (
                  <label class="check" key={m.id}><input type="checkbox" checked={!f.enabled_models.length || f.enabled_models.includes(m.id)} onChange={(e) => { const cur = f.enabled_models.length ? f.enabled_models : models.map((x) => x.id); setF({ ...f, enabled_models: e.target.checked ? [...cur, m.id] : cur.filter((x) => x !== m.id) }) }} />{m.display_name}</label>
                ))}
              </div></div>
              <label class="check"><input type="checkbox" checked={f.turnstile} onChange={(e) => setF({ ...f, turnstile: e.target.checked })} /> Pedir verificación anti-bots (Turnstile) antes del primer mensaje</label>
              <button class="b b-primary" style="margin-top:16px" disabled={busy}>Guardar</button>
            </form>
            <h3 style="margin-top:24px">Usuarios</h3>
            <table class="tbl"><tbody>
              {data.users.map((u) => (
                <tr key={u.id}><td>{u.email}</td><td>{u.role}</td><td>{u.status === 'active' ? 'Activo' : 'Invitado'}{u.totp_enabled ? ' · 2FA' : ''}</td>
                  <td class="nowrap">{u.totp_enabled ? <button class="link" onClick={() => confirm(`¿Restablecer la verificación en dos pasos de ${u.email}? Tendrá que configurarla de nuevo al entrar.`) && run(() => api.post(`tenants/${id}/reset-totp`, { user_id: u.id }), '2FA restablecido').then(reload)}>Restablecer 2FA</button> : null}</td></tr>
              ))}
            </tbody></table>
            <button class="b b-outline b-sm" style="margin-top:10px" onClick={async () => setInv(await run(() => api.post(`tenants/${id}/invite`, {})))}>Generar nueva invitación al owner</button>
            <InviteBox r={inv} />
            {data.alerts.length > 0 && (<><h3 style="margin-top:24px">Alertas</h3>{data.alerts.map((a) => <div key={a.id} class="small" style="margin-top:6px">{date(a.created_at)} · {a.message}</div>)}</>)}
            <h3 style="margin-top:24px">Auditoría reciente</h3>
            <table class="tbl"><tbody>{data.audit.map((a, i) => <tr key={i}><td class="small nowrap">{date(a.created_at)}</td><td class="small">{a.action}</td><td class="small muted">{a.actor_email}</td></tr>)}</tbody></table>
          </>
        )}
      </div>
    </div>
  )
}

/* ---------------- Cobro general a clientes (por mensaje / minuto) ---------------- */
function Billing() {
  const { data, error, reload } = useLoad(() => api.get('billing'))
  const [f, setF] = useState(null)
  const [busy, run] = useAction()
  useEffect(() => {
    if (data) setF({ message_usd: usdToInput(data.message_micro), minute_usd: usdToInput(data.minute_micro), included_in: intToInput(data.included_in), included_out: intToInput(data.included_out) })
  }, [data])
  if (!data || !f) return <div class="card"><Loading error={error} /></div>
  const save = async (e) => {
    e.preventDefault()
    const r = await run(
      () => api.put('billing', { message_usd: inputToUsd(f.message_usd), minute_usd: inputToUsd(f.minute_usd), included_in: inputToInt(f.included_in), included_out: inputToInt(f.included_out) }),
      'Tarifa general guardada',
    )
    if (r) reload()
  }
  const rt = data.reply_tokens
  return (
    <div class="card">
      <h2>Cobro a clientes</h2>
      <div class="small muted" style="margin-top:4px">
        Lo que paga cada cliente. El chat se cobra por cada respuesta del asistente y la voz por minuto (proporcional a los segundos). Los tokens se siguen midiendo: en Consumo ves cuánto habría costado por tokens para comparar. Un cliente puede tener precio especial (en su ficha). Los cambios aplican desde ahora; lo ya cobrado no cambia.
      </div>
      <form class="row" style="margin-top:12px;align-items:flex-end" onSubmit={save}>
        <label class="l" style="margin-top:0;width:200px">Precio por mensaje (USD)<input type="number" step="0.0001" min="0" placeholder="Por tokens" value={f.message_usd} onInput={(e) => setF({ ...f, message_usd: e.target.value })} /></label>
        <label class="l" style="margin-top:0;width:200px">Precio por minuto de voz (USD)<input type="number" step="0.0001" min="0" placeholder={String(data.fallback_minute_micro / 1e6)} value={f.minute_usd} onInput={(e) => setF({ ...f, minute_usd: e.target.value })} /></label>
        <label class="l" style="margin-top:0;width:200px">Tokens de entrada incluidos<input type="number" step="1" min="0" placeholder="Sin límite" value={f.included_in} onInput={(e) => setF({ ...f, included_in: e.target.value })} /></label>
        <label class="l" style="margin-top:0;width:200px">Tokens de salida incluidos<input type="number" step="1" min="0" placeholder="Sin límite" value={f.included_out} onInput={(e) => setF({ ...f, included_out: e.target.value })} /></label>
        <button class="b b-primary" disabled={busy}>Guardar</button>
      </form>
      <div class="small muted" style="margin-top:8px">
        <b>Tokens incluidos:</b> lo que cubre cada mensaje. Si una respuesta se pasa, el excedente se cobra a la tarifa por token de su modelo (tabla de abajo), además del precio del mensaje. Vacío = sin límite. Cada cliente puede tener su propio límite en su ficha.
        {rt?.n > 0 && (
          <> Últimos 30 días ({num(rt.n)} respuestas): promedio <b>{num(rt.avg_in)}</b> de entrada y <b>{num(rt.avg_out)}</b> de salida; máximo {num(rt.max_in)} / {num(rt.max_out)}. La entrada incluye instrucciones, conocimiento e historial de la plática.</>
        )}
      </div>
      <div class="small muted" style="margin-top:8px">
        {data.message_micro == null ? (
          <>Sin precio por mensaje: el chat se sigue cobrando <b>por tokens</b> con las tarifas de abajo (los tokens incluidos no aplican).</>
        ) : (
          <>
            Chat: <b>{usd(data.message_micro)}</b> por respuesta
            {data.included_in != null || data.included_out != null ? (
              <>, con {data.included_in != null ? `${num(data.included_in)} de entrada` : 'entrada sin límite'} y {data.included_out != null ? `${num(data.included_out)} de salida` : 'salida sin límite'} incluidos</>
            ) : (
              ''
            )}
            . Los resúmenes automáticos de prospectos van incluidos.
          </>
        )}
        {' · '}Voz: <b>{usd(data.minute_micro ?? data.fallback_minute_micro)}</b> por minuto{data.minute_micro == null && ' (valor de respaldo)'}.
      </div>
    </div>
  )
}

/* ---------------- Costo real de proveedores (solo superadmin) ---------------- */
function ProviderCosts() {
  const { data, error, reload } = useLoad(() => api.get('provider-costs'))
  const [f, setF] = useState(null)
  const [busy, run] = useAction()
  useEffect(() => {
    if (!data) return
    const models = {}
    for (const m of data.models) {
      const c = data.costs[m.id]
      models[m.id] = { in_usd: c ? String(c.in_per_1m_micro / 1e6) : '', out_usd: c ? String(c.out_per_1m_micro / 1e6) : '' }
    }
    setF({ models, voice_minute_usd: usdToInput(data.voice_minute_micro) })
  }, [data])
  // La liga #/tarifas/costos (desde Consumo) baja directo a esta tarjeta
  useEffect(() => {
    if (f && /^#\/tarifas\/costos/.test(location.hash)) document.getElementById('costos')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [Boolean(f)])
  if (!data || !f) return <div class="card"><Loading error={error} /></div>

  const ours = data.models.filter((m) => m.type !== 'byok')
  const save = async (e) => {
    e.preventDefault()
    const models = {}
    for (const m of ours) {
      const v = f.models[m.id]
      const empty = String(v.in_usd).trim() === '' && String(v.out_usd).trim() === ''
      models[m.id] = empty ? null : { in_usd: Number(v.in_usd) || 0, out_usd: Number(v.out_usd) || 0 }
    }
    const r = await run(() => api.put('provider-costs', { models, voice_minute_usd: inputToUsd(f.voice_minute_usd) }), 'Costos guardados')
    if (r) reload()
  }
  const setCost = (id, k, v) => setF({ ...f, models: { ...f.models, [id]: { ...f.models[id], [k]: v } } })

  return (
    <div class="card" id="costos">
      <h2>Costo de proveedores</h2>
      <div class="small muted" style="margin-top:4px">
        Lo que te cobran a ti los proveedores. Solo lo ves tú: sirve para calcular tu ganancia en Consumo (cobrado − costo real). Los modelos con la API key del cliente (BYOK) no te cuestan: el proveedor le cobra a él. Se calcula con el costo que tengas capturado al ver el reporte.
      </div>
      <form onSubmit={save}>
        <div class="tbl-wrap">
          <table class="tbl" style="margin-top:10px">
            <thead><tr><th>Modelo</th><th class="num">Entrada (USD / 1M)</th><th class="num">Salida (USD / 1M)</th></tr></thead>
            <tbody>
              {ours.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.name}</b><div class="small muted mono">{m.id}{!m.active && ' · retirado'}</div></td>
                  <td class="num"><input class="in cost-in" type="number" step="0.0001" min="0" placeholder="Sin capturar" value={f.models[m.id]?.in_usd ?? ''} onInput={(e) => setCost(m.id, 'in_usd', e.target.value)} aria-label={`Costo de entrada de ${m.name}`} /></td>
                  <td class="num"><input class="in cost-in" type="number" step="0.0001" min="0" placeholder="Sin capturar" value={f.models[m.id]?.out_usd ?? ''} onInput={(e) => setCost(m.id, 'out_usd', e.target.value)} aria-label={`Costo de salida de ${m.name}`} /></td>
                </tr>
              ))}
              <tr>
                <td><b>Voz (ElevenLabs)</b><div class="small muted">por minuto de llamada</div></td>
                <td class="num" colSpan="2"><input class="in cost-in" type="number" step="0.0001" min="0" placeholder="USD / min" value={f.voice_minute_usd} onInput={(e) => setF({ ...f, voice_minute_usd: e.target.value })} aria-label="Costo de voz por minuto" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <button class="b b-primary" style="margin-top:12px" disabled={busy}>Guardar costos</button>
      </form>
    </div>
  )
}

/* ---------------- Tarifas ---------------- */
function Tarifas() {
  const { data, error, reload } = useLoad(() => api.get('models'))
  const tenants = useLoad(() => api.get('tenants'))
  const [edit, setEdit] = useState(null)
  const [newModel, setNewModel] = useState(null)
  const [ov, setOv] = useState({ tenant_id: '', model_id: '', discount_pct: '', input_usd: '', output_usd: '', fee_input_usd: '', fee_output_usd: '' })
  const [busy, run] = useAction()
  if (!data) return <Loading error={error} />
  const usdIn = (v) => (v === '' ? null : Number(v))
  return (
    <>
      <Billing />
      <ProviderCosts />
      <div class="card">
        <div class="row"><h2 class="grow">Modelos y tarifas</h2><button class="b b-outline b-sm" onClick={() => setNewModel({ id: '', provider: 'anthropic', model_name: '', display_name: '', type: 'byok', active: true, context_window: 200000 })}>+ Agregar modelo</button></div>
        <div class="small muted" style="margin-top:4px">Tarifa por token de cada modelo. Con precio por mensaje, sirve para calcular el costo en tokens y compararlo con lo cobrado; sin precio por mensaje, es lo que se cobra. Precio = modelos hosted; Fee = modelos con la API key del cliente. Cada cambio crea una versión nueva; lo ya cobrado no cambia.</div>
        <div class="tbl-wrap">
          <table class="tbl" style="margin-top:10px">
            <thead><tr><th>Modelo</th><th>Proveedor · nombre</th><th>Tipo</th><th class="num">Entrada / 1M</th><th class="num">Salida / 1M</th><th>Estado</th><th /></tr></thead>
            <tbody>
              {data.models.map((m) => {
                const p = m.price || {}
                const [i, o] = m.type === 'hosted' ? [p.input_per_1m_micro, p.output_per_1m_micro] : [p.fee_input_per_1m_micro, p.fee_output_per_1m_micro]
                return (
                  <tr key={m.id}>
                    <td><b>{m.display_name}</b><div class="small muted mono">{m.id}</div></td>
                    <td class="small">{m.provider}<div class="mono muted">{m.model_name || '(lo define el cliente)'}</div></td>
                    <td>{m.type === 'hosted' ? 'Hosted' : 'BYOK (fee)'}</td>
                    <td class="num">{perM(i)}</td>
                    <td class="num">{perM(o)}</td>
                    <td><span class={'badge ' + (m.active ? 'badge-ok' : '')}>{m.active ? 'Activo' : 'Retirado'}</span></td>
                    <td class="nowrap">
                      <button class="link" onClick={() => setEdit({ m, input_usd: (p.input_per_1m_micro || 0) / 1e6, output_usd: (p.output_per_1m_micro || 0) / 1e6, fee_input_usd: (p.fee_input_per_1m_micro || 0) / 1e6, fee_output_usd: (p.fee_output_per_1m_micro || 0) / 1e6 })}>Cambiar tarifa</button>
                      <button class="link" style="margin-left:10px" onClick={() => setNewModel({ ...m, active: Boolean(m.active), existing: true })}>Editar</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Tarifas especiales por cliente</h2>
        <form class="row" style="margin-top:12px;align-items:flex-end" onSubmit={async (e) => { e.preventDefault(); await run(() => api.post('overrides', { tenant_id: ov.tenant_id, model_id: ov.model_id, discount_pct: ov.discount_pct === '' ? null : Number(ov.discount_pct), input_usd: usdIn(ov.input_usd), output_usd: usdIn(ov.output_usd), fee_input_usd: usdIn(ov.fee_input_usd), fee_output_usd: usdIn(ov.fee_output_usd) }), 'Tarifa especial guardada'); reload() }}>
          <label class="l" style="margin-top:0">Cliente<select value={ov.tenant_id} onChange={(e) => setOv({ ...ov, tenant_id: e.target.value })} required><option value="">Elige…</option>{tenants.data?.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label class="l" style="margin-top:0">Modelo<select value={ov.model_id} onChange={(e) => setOv({ ...ov, model_id: e.target.value })} required><option value="">Elige…</option>{data.models.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></label>
          <label class="l" style="margin-top:0;width:110px">Descuento %<input type="number" min="0" max="100" value={ov.discount_pct} onInput={(e) => setOv({ ...ov, discount_pct: e.target.value })} /></label>
          <span class="small muted" style="padding-bottom:12px">o precio propio (USD / 1M):</span>
          {data.models.find((m) => m.id === ov.model_id)?.type === 'byok' ? (
            <>
              <label class="l" style="margin-top:0;width:110px">Fee entrada<input type="number" step="0.0001" min="0" value={ov.fee_input_usd} onInput={(e) => setOv({ ...ov, fee_input_usd: e.target.value })} /></label>
              <label class="l" style="margin-top:0;width:110px">Fee salida<input type="number" step="0.0001" min="0" value={ov.fee_output_usd} onInput={(e) => setOv({ ...ov, fee_output_usd: e.target.value })} /></label>
            </>
          ) : (
            <>
              <label class="l" style="margin-top:0;width:110px">Entrada<input type="number" step="0.0001" min="0" value={ov.input_usd} onInput={(e) => setOv({ ...ov, input_usd: e.target.value })} /></label>
              <label class="l" style="margin-top:0;width:110px">Salida<input type="number" step="0.0001" min="0" value={ov.output_usd} onInput={(e) => setOv({ ...ov, output_usd: e.target.value })} /></label>
            </>
          )}
          <button class="b b-primary" disabled={busy}>Guardar</button>
        </form>
        {data.overrides.length > 0 && (
          <table class="tbl" style="margin-top:14px">
            <thead><tr><th>Cliente</th><th>Modelo</th><th>Condición</th><th>Desde</th></tr></thead>
            <tbody>{data.overrides.map((o) => (
              <tr key={o.id}><td>{o.tenant_name}</td><td>{data.models.find((m) => m.id === o.model_id)?.display_name || o.model_id}</td>
                <td class="small">{[o.discount_pct != null && `${o.discount_pct} % de descuento`, o.input_per_1m_micro != null && `entrada ${perM(o.input_per_1m_micro)}`, o.output_per_1m_micro != null && `salida ${perM(o.output_per_1m_micro)}`, o.fee_input_per_1m_micro != null && `fee entrada ${perM(o.fee_input_per_1m_micro)}`, o.fee_output_per_1m_micro != null && `fee salida ${perM(o.fee_output_per_1m_micro)}`].filter(Boolean).join(' · ')}</td>
                <td class="small">{date(o.effective_from)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {edit && (
        <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && setEdit(null)}>
          <form class="modal" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post(`models/${edit.m.id}/price`, { input_usd: Number(edit.input_usd), output_usd: Number(edit.output_usd), fee_input_usd: Number(edit.fee_input_usd), fee_output_usd: Number(edit.fee_output_usd) }), 'Nueva tarifa vigente desde ahora'); if (r) { setEdit(null); reload() } }}>
            <h2>Tarifa · {edit.m.display_name}</h2>
            <div class="small muted" style="margin-top:4px">USD por 1 millón de tokens. Aplica a partir de ahora.</div>
            {edit.m.type === 'hosted' ? (
              <div class="row" style="align-items:flex-start">
                <label class="l grow">Precio entrada<input type="number" step="0.0001" min="0" value={edit.input_usd} onInput={(e) => setEdit({ ...edit, input_usd: e.target.value })} /></label>
                <label class="l grow">Precio salida<input type="number" step="0.0001" min="0" value={edit.output_usd} onInput={(e) => setEdit({ ...edit, output_usd: e.target.value })} /></label>
              </div>
            ) : (
              <div class="row" style="align-items:flex-start">
                <label class="l grow">Fee entrada<input type="number" step="0.0001" min="0" value={edit.fee_input_usd} onInput={(e) => setEdit({ ...edit, fee_input_usd: e.target.value })} /></label>
                <label class="l grow">Fee salida<input type="number" step="0.0001" min="0" value={edit.fee_output_usd} onInput={(e) => setEdit({ ...edit, fee_output_usd: e.target.value })} /></label>
              </div>
            )}
            <h3 style="margin-top:18px">Historial</h3>
            <table class="tbl"><tbody>{edit.m.history.map((h) => <tr key={h.id}><td class="small">{date(h.effective_from)}</td><td class="num small">{edit.m.type === 'hosted' ? `${perM(h.input_per_1m_micro)} / ${perM(h.output_per_1m_micro)}` : `${perM(h.fee_input_per_1m_micro)} / ${perM(h.fee_output_per_1m_micro)}`}</td></tr>)}</tbody></table>
            <div class="row" style="margin-top:16px"><button class="b b-primary" disabled={busy}>Guardar tarifa</button><button type="button" class="b b-ghost" onClick={() => setEdit(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
      {newModel && (
        <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && setNewModel(null)}>
          <form class="modal" onSubmit={async (e) => { e.preventDefault(); const { existing, id, price, history, sort, ...b } = newModel; const r = await run(() => api.put(`models/${id}`, { ...b, context_window: Number(b.context_window) }), 'Modelo guardado'); if (r) { setNewModel(null); reload() } }}>
            <h2>{newModel.existing ? 'Editar modelo' : 'Nuevo modelo'}</h2>
            <label class="l">Identificador<input class="mono" value={newModel.id} disabled={newModel.existing} onInput={(e) => setNewModel({ ...newModel, id: e.target.value })} pattern="[a-z0-9\-]{2,40}" placeholder="claude-opus" required /></label>
            <label class="l">Nombre visible<input value={newModel.display_name} onInput={(e) => setNewModel({ ...newModel, display_name: e.target.value })} required /></label>
            <div class="row" style="align-items:flex-start">
              <label class="l grow">Proveedor<select value={newModel.provider} onChange={(e) => setNewModel({ ...newModel, provider: e.target.value, type: e.target.value === 'workers-ai' ? 'hosted' : 'byok' })}><option value="workers-ai">Workers AI (hosted)</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="openai-compatible">Compatible con OpenAI</option></select></label>
              <label class="l grow">Contexto (tokens)<input type="number" value={newModel.context_window} onInput={(e) => setNewModel({ ...newModel, context_window: e.target.value })} /></label>
            </div>
            <label class="l">Nombre del modelo en la API<input class="mono" value={newModel.model_name} onInput={(e) => setNewModel({ ...newModel, model_name: e.target.value })} placeholder={newModel.provider === 'openai-compatible' ? '(vacío: lo escribe el cliente)' : 'claude-sonnet-5-5'} /></label>
            <label class="check"><input type="checkbox" checked={newModel.active} onChange={(e) => setNewModel({ ...newModel, active: e.target.checked })} /> Activo (visible para los clientes)</label>
            <div class="row" style="margin-top:16px"><button class="b b-primary" disabled={busy}>Guardar</button><button type="button" class="b b-ghost" onClick={() => setNewModel(null)}>Cancelar</button></div>
          </form>
        </div>
      )}
    </>
  )
}

/* ---------------- Consumo ---------------- */
function Consumo() {
  const thisMonth = new Date().toISOString().slice(0, 7)
  const [period, setPeriod] = useState(thisMonth)
  const { data, error, reload } = useLoad(() => api.get(`usage?period=${period}`), [period])
  const [busy, run] = useAction()
  if (!data) return <Loading error={error} />
  const total = data.rows.reduce((a, r) => a + r.cost_micro, 0)
  // Ganancia = cobrado − costo real; solo cuentan las filas con costo capturado
  const withCost = data.rows.filter((r) => r.real_cost_micro != null)
  const realTotal = withCost.reduce((a, r) => a + r.real_cost_micro, 0)
  const chargedWithCost = withCost.reduce((a, r) => a + r.cost_micro, 0)
  const missing = data.rows.length - withCost.length
  const profit = (charged, cost) => <span class={charged - cost < 0 ? 'neg' : 'pos'}>{charged - cost >= 0 ? '+' : '−'}{usd(Math.abs(charged - cost))}</span>
  const billedBy = (r) =>
    r.model_type === 'voice' ? (
      `${num(Math.round((r.voice_secs / 60) * 10) / 10)} min`
    ) : r.billed_messages > 0 ? (
      <>
        {num(r.billed_messages)} msj
        {r.overage_micro > 0 && <div class="small muted">{num(r.overage_messages)} con excedente · {usd(r.overage_micro)}</div>}
      </>
    ) : (
      'por tokens'
    )
  return (
    <>
      <div class="card">
        <div class="row">
          <div class="grow">
            <h2>Consumo por cliente y modelo</h2>
            <div class="small muted" style="margin-top:2px">
              Cobrado = lo que paga el cliente. Costo real = lo que te cobran los proveedores. Ganancia = cobrado − costo real.
              {missing > 0 && (
                <> <b>{missing} {missing === 1 ? 'fila no tiene' : 'filas no tienen'} costo capturado</b> y no {missing === 1 ? 'entra' : 'entran'} en la ganancia total.</>
              )}
            </div>
          </div>
          <input type="month" class="in" style="width:auto;margin-top:0" value={period} max={thisMonth} onInput={(e) => e.target.value && setPeriod(e.target.value)} aria-label="Mes" />
          <a class="b b-outline b-sm rate-open" style="margin-top:0" href="#/tarifas/costos"><span class="rate-ic" aria-hidden="true">$</span>Costo de proveedores</a>
          <a class="b b-outline b-sm" href={`${api.base}/usage.csv?period=${period}`}>Exportar CSV</a>
        </div>
        <div class="tbl-wrap">
          <table class="tbl" style="margin-top:10px">
            <thead><tr><th>Cliente</th><th>Modelo</th><th>Tipo</th><th class="num">Cobrado por</th><th class="num">Tokens</th><th class="num">Cobrado</th><th class="num">Costo real</th><th class="num">Ganancia</th></tr></thead>
            <tbody>
              {data.rows.length === 0 && <tr><td colSpan="8"><div class="empty">Sin consumo en {period}.</div></td></tr>}
              {data.rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.tenant_name}</td>
                  <td class="mono small">{r.model_id}</td>
                  <td>{r.model_type === 'hosted' ? 'Hosted' : r.model_type === 'voice' ? 'Voz' : 'Fee BYOK'}</td>
                  <td class="num">{billedBy(r)}</td>
                  <td class="num">{r.model_type === 'voice' ? '—' : <>{num(r.tokens_in + r.tokens_out)}<div class="small muted">{num(r.tokens_in)} / {num(r.tokens_out)}</div></>}</td>
                  <td class="num">{usd(r.cost_micro)}{r.estimated > 0 && <div class="small muted">{r.estimated} estimados</div>}</td>
                  <td class="num">
                    {r.real_cost_micro != null ? (
                      <>{usd(r.real_cost_micro)}{r.model_type === 'byok' && <div class="small muted">lo paga el cliente</div>}</>
                    ) : (
                      <a class="b b-outline b-sm rate-open" style="margin-top:0" href="#/tarifas/costos"><span class="rate-ic" aria-hidden="true">$</span>Capturar costo</a>
                    )}
                  </td>
                  <td class="num">{r.real_cost_micro != null ? profit(r.cost_micro, r.real_cost_micro) : '—'}</td>
                </tr>
              ))}
              {data.rows.length > 0 && (
                <tr>
                  <td colSpan="5"><b>Total</b></td>
                  <td class="num"><b>{usd(total, 2)}</b></td>
                  <td class="num"><b>{usd(realTotal, 2)}</b></td>
                  <td class="num"><b>{profit(chargedWithCost, realTotal)}</b></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="row">
          <h2 class="grow">Estados de cuenta {period}</h2>
          <button class="b b-primary b-sm" disabled={busy} onClick={() => confirm(`¿Generar (o recalcular) los estados de cuenta de ${period}? Los ya emitidos o pagados no cambian.`) && run(() => api.post('statements/close', { period }), 'Estados de cuenta generados').then(reload)}>Cerrar periodo</button>
        </div>
        <div class="small muted" style="margin-top:4px">Fase 1: cobro manual. Genera, emite (el cliente lo ve en su portal) y marca como pagado cuando recibas el pago.</div>
        {data.statements.length === 0 ? <div class="empty">Sin estados de cuenta para este periodo.</div> : (
          <table class="tbl" style="margin-top:10px">
            <thead><tr><th>Cliente</th><th class="num">Tokens</th><th class="num">Total</th><th>Estado</th><th /></tr></thead>
            <tbody>{data.statements.map((s) => (
              <tr key={s.id}><td>{s.tenant_name}</td><td class="num">{num(s.tokens_in + s.tokens_out)}</td><td class="num">{usd(s.total_micro, 2)}</td>
                <td><span class={'badge ' + (s.status === 'paid' ? 'badge-ok' : s.status === 'issued' ? 'badge-warn' : '')}>{{ draft: 'Borrador', issued: 'Emitido', paid: 'Pagado' }[s.status]}</span></td>
                <td class="nowrap">
                  {s.status === 'draft' && <button class="link" onClick={() => run(() => api.post(`statements/${s.id}/issue`), 'Emitido').then(reload)}>Emitir</button>}
                  {s.status !== 'paid' && <button class="link" style="margin-left:10px" onClick={() => confirm(`¿Marcar como pagado ${usd(s.total_micro, 2)} de ${s.tenant_name}?`) && run(() => api.post(`statements/${s.id}/paid`), 'Marcado como pagado').then(reload)}>Marcar pagado</button>}
                  {s.status === 'paid' && <span class="small muted">{date(s.paid_at)}</span>}
                </td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  )
}

/* ---------------- Auditoría ---------------- */
function Auditoria() {
  const [action, setAction] = useState('')
  const [tenant, setTenant] = useState('')
  const tenants = useLoad(() => api.get('tenants'))
  const { data, error } = useLoad(() => api.get(`audit?${new URLSearchParams({ ...(action && { action }), ...(tenant && { tenant }) })}`), [action, tenant])
  return (
    <div class="card">
      <div class="row">
        <h2 class="grow">Auditoría</h2>
        <select class="in" style="width:auto;margin-top:0" value={tenant} onChange={(e) => setTenant(e.target.value)} aria-label="Cliente"><option value="">Todos los clientes</option>{tenants.data?.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select class="in" style="width:auto;margin-top:0" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Acción">
          <option value="">Todas las acciones</option>
          {['auth', 'tenant', 'price', 'model', 'statement', 'provider_key', 'widget', 'agent', 'kb', 'team', 'security', 'conversation'].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div class="small muted" style="margin-top:4px">Registro inmutable: la base de datos rechaza cambios y borrados.</div>
      {!data ? <Loading error={error} /> : (
        <div class="tbl-wrap">
          <table class="tbl" style="margin-top:10px">
            <thead><tr><th>Fecha</th><th>Quién</th><th>Cliente</th><th>Acción</th><th>Detalle</th><th>IP</th></tr></thead>
            <tbody>{data.items.map((a) => (
              <tr key={a.id}><td class="small nowrap">{date(a.created_at)}</td><td class="small">{a.actor_email}</td><td class="small">{a.tenant_name || '—'}</td><td class="mono small">{a.action}</td><td class="mono small" style="max-width:320px;word-break:break-all">{a.detail}</td><td class="small mono">{a.ip}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ---------------- Mi cuenta (superadmin) ---------------- */
function PasswordField({ label, hint, value, onInput, autocomplete }) {
  const [show, setShow] = useState(false)
  return (
    <label class="l">
      {label}
      <div class="row" style="gap:8px;flex-wrap:nowrap">
        <input class="grow" type={show ? 'text' : 'password'} autocomplete={autocomplete} value={value} onInput={(e) => onInput(e.target.value)} required />
        <button type="button" class="b b-ghost b-sm" onClick={() => setShow(!show)} aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{show ? 'Ocultar' : 'Ver'}</button>
      </div>
      {hint && <span class="hint">{hint}</span>}
    </label>
  )
}

function ProfileCard({ me, reload }) {
  const [name, setName] = useState(me.user.name || '')
  const [busy, run] = useAction()
  const changed = name.trim() !== (me.user.name || '')
  const save = async (e) => {
    e.preventDefault()
    if (await run(() => api.put('auth/profile', { name: name.trim() }), 'Nombre actualizado')) reload()
  }
  return (
    <form class="card" onSubmit={save}>
      <h2>Tus datos</h2>
      <div class="small muted" style="margin-top:4px">Así apareces en la auditoría y en los avisos.</div>
      <label class="l">Nombre<input value={name} onInput={(e) => setName(e.target.value)} maxLength={120} autocomplete="name" required /></label>
      <label class="l">Correo<input value={me.user.email} disabled /><span class="hint">Es tu usuario para entrar al panel.</span></label>
      {me.user.last_login_at && <div class="small muted" style="margin-top:12px">Último acceso: {date(me.user.last_login_at)}</div>}
      <button class="b b-primary" style="margin-top:18px" disabled={busy || !changed || !name.trim()}>Guardar nombre</button>
    </form>
  )
}

function PasswordCard() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, run] = useAction()
  const save = async (e) => {
    e.preventDefault()
    if (next !== repeat) return
    if (await run(() => api.post('auth/password', { current, next }), 'Contraseña actualizada. Se cerraron tus otras sesiones.')) {
      setCurrent('')
      setNext('')
      setRepeat('')
    }
  }
  return (
    <form class="card" onSubmit={save}>
      <h2>Contraseña</h2>
      <div class="small muted" style="margin-top:4px">Al cambiarla se cierran tus sesiones en otros equipos.</div>
      <PasswordField label="Contraseña actual" autocomplete="current-password" value={current} onInput={setCurrent} />
      <PasswordField label="Nueva contraseña" hint="Mínimo 10 caracteres, con letras y números." autocomplete="new-password" value={next} onInput={setNext} />
      <PasswordField label="Repite la nueva contraseña" autocomplete="new-password" value={repeat} onInput={setRepeat} />
      {repeat && next !== repeat && <div class="alert alert-warn" style="margin-top:12px">Las dos contraseñas nuevas no coinciden.</div>}
      <button class="b b-primary" style="margin-top:18px" disabled={busy || !current || !next || next !== repeat}>Cambiar contraseña</button>
    </form>
  )
}

function TotpCard({ me, reload }) {
  const on = me.user.totp_enabled
  const [mode, setMode] = useState(null) // 'enable' | 'disable'
  const [setup, setSetup] = useState(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, run] = useAction()
  const start = async () => {
    setMode('enable')
    setCode('')
    const r = await run(() => api.post('auth/totp/setup'))
    if (r) setSetup(r)
    else setMode(null)
  }
  const enable = async (e) => {
    e.preventDefault()
    if (await run(() => api.post('auth/totp/enable', { code }), 'Verificación en dos pasos activada')) {
      setMode(null)
      setSetup(null)
      reload()
    }
  }
  const disable = async (e) => {
    e.preventDefault()
    if (await run(() => api.post('auth/totp/disable', { password }), 'Verificación en dos pasos desactivada')) {
      setMode(null)
      setPassword('')
      reload()
    }
  }
  return (
    <div class="card">
      <div class="row">
        <h2 class="grow">Verificación en dos pasos</h2>
        <span class={'badge ' + (on ? 'badge-ok' : '')}>{on ? 'Activada' : 'Desactivada'}</span>
      </div>
      <div class="small muted" style="margin-top:4px">Además de tu contraseña, te pide un código de 6 dígitos de una app en tu celular.</div>
      {!mode && (
        <div style="margin-top:16px">
          {me.user.totp_required ? (
            <div class="info">En este ambiente es obligatoria para el superadmin (TOTP_OBLIGATORIO = "true" en el Worker).</div>
          ) : on ? (
            <button class="b b-outline" onClick={() => setMode('disable')}>Desactivar</button>
          ) : (
            <button class="b b-primary" onClick={start} disabled={busy}>Activar</button>
          )}
        </div>
      )}
      {mode === 'enable' && (
        <form onSubmit={enable} style="margin-top:12px">
          <ol class="small" style="padding-left:18px;line-height:1.7">
            <li>Abre <b>Google Authenticator</b>, <b>Microsoft Authenticator</b> o 1Password.</li>
            <li>Toca <b>+</b> y escanea este código.</li>
            <li>Escribe el número de 6 dígitos que aparece.</li>
          </ol>
          {setup ? (
            <>
              <Qr text={setup.uri} />
              <div class="small muted" style="text-align:center">
                ¿No puedes escanear? Escribe esta clave:<br />
                <span class="mono" style="user-select:all">{setup.secret}</span>
              </div>
              <label class="l">
                Código de 6 dígitos
                <input class="mono" style="font-size:20px;letter-spacing:6px;text-align:center" inputmode="numeric" autocomplete="one-time-code" maxLength={6} placeholder="000000" value={code} onInput={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
              </label>
            </>
          ) : (
            <div class="loading">Generando código…</div>
          )}
          <div class="row" style="margin-top:16px">
            <button type="button" class="b b-ghost" onClick={() => { setMode(null); setSetup(null) }}>Cancelar</button>
            <button class="b b-primary" disabled={busy || code.length !== 6}>Activar</button>
          </div>
        </form>
      )}
      {mode === 'disable' && (
        <form onSubmit={disable} style="margin-top:12px">
          <div class="alert alert-warn">Sin la verificación, cualquiera con tu contraseña puede entrar al panel de superadmin.</div>
          <PasswordField label="Escribe tu contraseña para confirmar" autocomplete="current-password" value={password} onInput={setPassword} />
          <div class="row" style="margin-top:16px">
            <button type="button" class="b b-ghost" onClick={() => { setMode(null); setPassword('') }}>Cancelar</button>
            <button class="b b-danger" disabled={busy || !password}>Desactivar</button>
          </div>
        </form>
      )}
    </div>
  )
}

function Cuenta({ me, reloadMe }) {
  return (
    <div class="cols cuenta">
      <div class="col-half">
        <ProfileCard me={me} reload={reloadMe} />
        <PasswordCard />
      </div>
      <div class="col-half">
        <TotpCard me={me} reload={reloadMe} />
      </div>
    </div>
  )
}

const HEAD = {
  clientes: ['01 · Clientes', 'Tus clientes,', 'en un solo lugar.'],
  tarifas: ['02 · Tarifas', 'Precio por token,', 'bajo control.'],
  consumo: ['03 · Consumo', 'Lo que se usa,', 'lo que se cobra.'],
  auditoria: ['04 · Auditoría', 'Cada acción,', 'registrada.'],
  cuenta: ['Mi cuenta', 'Tu perfil,', 'tu seguridad.'],
}

const TABS = [['clientes', 'Clientes', Clientes], ['tarifas', 'Tarifas', Tarifas], ['consumo', 'Consumo', Consumo], ['auditoria', 'Auditoría', Auditoria]]
// Páginas que no van en las pestañas (se abren desde el menú de usuario)
const HIDDEN = [['cuenta', 'Mi cuenta', Cuenta]]

function Admin({ me, reload, logout }) {
  const [tab, setTab] = useState((location.hash.match(/^#\/(\w+)/) || [])[1] || 'clientes')
  const health = useLoad(() => api.get('health'))
  useEffect(() => {
    const f = () => setTab((location.hash.match(/^#\/(\w+)/) || [])[1] || 'clientes')
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  const C = ([...TABS, ...HIDDEN].find((t) => t[0] === tab) || TABS[0])[2]
  return (
    <>
      <header class="top">
        <div class="logo">zentekia<b>.</b><small>ADMIN</small></div>
        {TABS.map(([id, label]) => <a key={id} href={`#/${id}`} class={'tab' + (tab === id ? ' on' : '')} aria-current={tab === id ? 'page' : undefined}>{label}</a>)}
        <div class="who">
          <ThemeToggle />
          <UserMenu user={me.user} roleLabel="Superadmin" onLogout={logout} onAccount={() => { location.hash = '#/cuenta' }} />
        </div>
      </header>
      <main class="wrap">
        <div class="page-head">
          <span class="eyebrow">{HEAD[tab]?.[0]}</span>
          <h1>{HEAD[tab]?.[1]} <em>{HEAD[tab]?.[2]}</em></h1>
        </div>
        {tab !== 'cuenta' && <Health h={health.data} />}
        <C health={health.data} me={me} reloadMe={reload} />
      </main>
    </>
  )
}

render(
  <>
    <AuthGate api={api} title="Zentekia Admin" subtitle="Panel de superadmin">
      {({ me, reload, logout }) => <Admin me={me} reload={reload} logout={logout} />}
    </AuthGate>
    <Toasts />
  </>,
  root,
)
