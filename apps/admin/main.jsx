import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { createApi, date, num, perM, usd } from '../shared/api.js'
import { AuthGate } from '../shared/Auth.jsx'
import { stackTablesOnMobile } from '../shared/tableStack.js'
import { Toasts, toast, toastError } from '../shared/toast.jsx'
import UserMenu from '../shared/UserMenu.jsx'
import { ThemeToggle } from '../shared/Theme.jsx'
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

/* ---------------- Clientes ---------------- */
function Clientes({ health }) {
  const tenants = useLoad(() => api.get('tenants'))
  const models = useLoad(() => api.get('models'))
  const [f, setF] = useState({ name: '', slug: '', owner_email: '', monthly_limit_usd: '', plan_id: 'basico', limit_behavior: 'block', enabled: null, import_prakticall: false })
  const [slugTouched, setSlugTouched] = useState(false)
  const [created, setCreated] = useState(null)
  const [detail, setDetail] = useState(null)
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
        <label class="check" style="margin-top:14px">
          <input type="checkbox" checked={f.import_prakticall} onChange={(e) => setF({ ...f, import_prakticall: e.target.checked })} />
          Importar los 4 agentes de chat de Prakticall (versión anterior)
        </label>
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
              <thead><tr><th>Cliente</th><th>Portal</th><th>Estado</th><th class="num">Tokens del mes</th><th class="num">Costo del mes</th><th>Acciones</th></tr></thead>
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
      {detail && <TenantModal id={detail} health={health} models={activeModels} onClose={() => { setDetail(null); tenants.reload() }} />}
    </div>
    </>
  )
}

function TenantModal({ id, health, models, onClose }) {
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
      <div class="card">
        <div class="row"><h2 class="grow">Modelos y tarifas</h2><button class="b b-outline b-sm" onClick={() => setNewModel({ id: '', provider: 'anthropic', model_name: '', display_name: '', type: 'byok', active: true, context_window: 200000 })}>+ Agregar modelo</button></div>
        <div class="small muted" style="margin-top:4px">Precio = lo que paga el cliente por modelos hosted. Fee = lo que cobra Zentekia por token en modelos con la API key del cliente. Cada cambio crea una versión nueva; lo ya cobrado no cambia.</div>
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
  return (
    <>
      <div class="card">
        <div class="row">
          <h2 class="grow">Consumo por cliente y modelo</h2>
          <input type="month" class="in" style="width:auto;margin-top:0" value={period} max={thisMonth} onInput={(e) => e.target.value && setPeriod(e.target.value)} aria-label="Mes" />
          <a class="b b-outline b-sm" href={`${api.base}/usage.csv?period=${period}`}>Exportar CSV</a>
        </div>
        <div class="tbl-wrap">
          <table class="tbl" style="margin-top:10px">
            <thead><tr><th>Cliente</th><th>Modelo</th><th>Tipo</th><th class="num">Mensajes</th><th class="num">Entrada</th><th class="num">Salida</th><th class="num">Importe</th></tr></thead>
            <tbody>
              {data.rows.length === 0 && <tr><td colSpan="7"><div class="empty">Sin consumo en {period}.</div></td></tr>}
              {data.rows.map((r, i) => (
                <tr key={i}><td>{r.tenant_name}</td><td class="mono small">{r.model_id}</td><td>{r.model_type === 'hosted' ? 'Hosted' : r.model_type === 'voice' ? 'Voz (por minuto)' : 'Fee BYOK'}</td><td class="num">{num(r.messages)}</td><td class="num">{num(r.tokens_in)}</td><td class="num">{num(r.tokens_out)}</td><td class="num">{usd(r.cost_micro)}{r.estimated > 0 && <div class="small muted">{r.estimated} estimados</div>}</td></tr>
              ))}
              {data.rows.length > 0 && <tr><td colSpan="6"><b>Total</b></td><td class="num"><b>{usd(total, 2)}</b></td></tr>}
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

const HEAD = {
  clientes: ['01 · Clientes', 'Tus clientes,', 'en un solo lugar.'],
  tarifas: ['02 · Tarifas', 'Precio por token,', 'bajo control.'],
  consumo: ['03 · Consumo', 'Lo que se usa,', 'lo que se cobra.'],
  auditoria: ['04 · Auditoría', 'Cada acción,', 'registrada.'],
}

const TABS = [['clientes', 'Clientes', Clientes], ['tarifas', 'Tarifas', Tarifas], ['consumo', 'Consumo', Consumo], ['auditoria', 'Auditoría', Auditoria]]

function Admin({ me, logout }) {
  const [tab, setTab] = useState((location.hash.match(/^#\/(\w+)/) || [])[1] || 'clientes')
  const health = useLoad(() => api.get('health'))
  useEffect(() => {
    const f = () => setTab((location.hash.match(/^#\/(\w+)/) || [])[1] || 'clientes')
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  const C = (TABS.find((t) => t[0] === tab) || TABS[0])[2]
  return (
    <>
      <header class="top">
        <div class="logo">zentekia<b>.</b><small>ADMIN</small></div>
        {TABS.map(([id, label]) => <a key={id} href={`#/${id}`} class={'tab' + (tab === id ? ' on' : '')} aria-current={tab === id ? 'page' : undefined}>{label}</a>)}
        <div class="who"><ThemeToggle /><UserMenu user={me.user} roleLabel="Superadmin" onLogout={logout} /></div>
      </header>
      <main class="wrap">
        <div class="page-head">
          <span class="eyebrow">{HEAD[tab]?.[0]}</span>
          <h1>{HEAD[tab]?.[1]} <em>{HEAD[tab]?.[2]}</em></h1>
        </div>
        <Health h={health.data} />
        <C health={health.data} />
      </main>
    </>
  )
}

render(
  <>
    <AuthGate api={api} title="Zentekia Admin" subtitle="Panel de superadmin">
      {({ me, logout }) => <Admin me={me} logout={logout} />}
    </AuthGate>
    <Toasts />
  </>,
  root,
)
