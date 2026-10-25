import { useEffect, useState } from 'preact/hooks'
import { date } from '../../shared/api.js'
import { Field, Loading, PageHead, useAction, useLoad } from './common.jsx'

export function DomainsEditor({ api, readOnly, onSaved }) {
  const { data, error, reload } = useLoad(() => api.get('security'))
  const [text, setText] = useState('')
  const [busy, run] = useAction()
  useEffect(() => {
    if (data) setText(data.allowed_origins.join('\n'))
  }, [data])
  if (!data) return <Loading error={error} />
  const save = async (e) => {
    e.preventDefault()
    const list = text.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean)
    const r = await run(() => api.put('security', { allowed_origins: list }), 'Dominios guardados')
    if (r) {
      reload()
      onSaved?.()
    }
  }
  return (
    <form onSubmit={save}>
      <Field label="Dominios donde funciona tu widget" hint="Uno por línea, por ejemplo https://misitio.com y https://www.misitio.com. En otros sitios el chat no carga.">
        <textarea rows="4" value={text} onInput={(e) => setText(e.target.value)} disabled={readOnly} placeholder="https://misitio.com" />
      </Field>
      {!readOnly && <button class="b b-primary" style="margin-top:14px" disabled={busy}>Guardar dominios</button>}
    </form>
  )
}

const ACTIONS = {
  'auth.login': 'Inicio de sesión',
  'auth.login_failed': 'Intento de acceso fallido',
  'auth.password_changed': 'Cambio de contraseña',
  'auth.totp_enabled': 'Verificación en dos pasos activada',
  'auth.totp_disabled': 'Verificación en dos pasos desactivada',
  'auth.profile_updated': 'Nombre actualizado',
  'agent.requested': 'Solicitud de asistente o canal',
  'provider_key.saved': 'API key guardada',
  'provider_key.deleted': 'API key borrada',
  'widget.updated': 'Widget actualizado',
  'agent.updated': 'Agente actualizado',
  'security.updated': 'Seguridad actualizada',
  'team.invited': 'Invitación enviada',
  'conversations.exported': 'Conversaciones exportadas',
  'tenant.impersonation_session': 'Acceso de soporte Zentekia (solo lectura)',
}

export default function Seguridad({ api, readOnly }) {
  const { data, reload } = useLoad(() => api.get('security'))
  const [days, setDays] = useState(90)
  const [busy, run] = useAction()
  useEffect(() => {
    if (data) setDays(data.retention_days)
  }, [data])
  return (
    <>
      <PageHead title="Seguridad" sub="Dónde funciona tu widget, cuánto tiempo guardamos las conversaciones y la actividad de la cuenta." />
      <div class="cols">
        <div class="col-main">
          <div class="card"><DomainsEditor api={api} readOnly={readOnly} /></div>
          <div class="card">
            <Field label="Guardar conversaciones durante (días)" hint="Después se borran de forma definitiva. Por defecto 90 días.">
              <input type="number" min="7" max="3650" value={days} onInput={(e) => setDays(Number(e.target.value))} disabled={readOnly} style="max-width:160px" />
            </Field>
            {!readOnly && <button class="b b-primary" style="margin-top:14px" disabled={busy} onClick={() => run(() => api.put('security', { retention_days: days }), 'Retención guardada').then(reload)}>Guardar</button>}
          </div>
          {data && (
            <div class="card">
              <div class="card-title">Actividad reciente</div>
              <table class="tbl" style="margin-top:6px">
                <thead><tr><th>Fecha</th><th>Acción</th><th>Quién</th></tr></thead>
                <tbody>
                  {data.audit.map((a, i) => (
                    <tr key={i}>
                      <td class="small nowrap">{date(a.created_at)}</td>
                      <td>{ACTIONS[a.action] || a.action}</td>
                      <td class="small muted">{a.actor_email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div class="col-side">
          <div class="card">
            <div class="card-title">Tu contraseña y verificación en dos pasos</div>
            <div class="small muted" style="margin-top:6px">Ahora están en <b>Mi cuenta</b>, junto con tu nombre y el tamaño de letra. Cada persona del equipo administra los suyos.</div>
            <a class="b b-outline b-sm" style="margin-top:14px" href="#/cuenta">Ir a Mi cuenta</a>
          </div>
        </div>
      </div>
    </>
  )
}
