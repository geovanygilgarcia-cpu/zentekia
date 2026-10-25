import { useState } from 'preact/hooks'
import { date } from '../../shared/api.js'
import { toast } from '../../shared/toast.jsx'
import { Field, Loading, PageHead, useAction, useLoad } from './common.jsx'

const ROLE = { owner: 'Owner', editor: 'Editor' }

export default function Equipo({ api, readOnly }) {
  const { data, error, reload } = useLoad(() => api.get('team'))
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('editor')
  const [link, setLink] = useState(null)
  const [busy, run] = useAction()
  if (!data) return <Loading error={error} />
  const invite = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post('team/invite', { email, role }))
    if (r) {
      setLink(r)
      setEmail('')
      reload()
    }
  }
  return (
    <>
      <PageHead title="Equipo" sub="Invita a tu equipo. Los editores configuran el agente, el conocimiento y el widget; no ven API keys ni facturación." />
      <div class="cols">
        <div class="col-main">
          <div class="card">
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr><th>Persona</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th /></tr></thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name || u.email}{u.name && <div class="small muted">{u.email}</div>}</td>
                      <td>
                        {u.id === data.me || readOnly ? ROLE[u.role] : (
                          <select class="in" style="margin-top:0;padding:6px 8px;width:auto" value={u.role} onChange={(e) => run(() => api.put(`team/${u.id}`, { role: e.target.value }), 'Rol actualizado').then(reload)} aria-label={`Rol de ${u.email}`}>
                            <option value="owner">Owner</option>
                            <option value="editor">Editor</option>
                          </select>
                        )}
                      </td>
                      <td><span class={'badge ' + (u.status === 'active' ? 'badge-ok' : 'badge-warn')}>{u.status === 'active' ? 'Activo' : 'Invitado'}</span>{u.totp_enabled ? <span class="badge" style="margin-left:4px">2FA</span> : null}</td>
                      <td class="small">{u.last_login_at ? date(u.last_login_at) : '—'}</td>
                      <td class="nowrap">
                        {u.id !== data.me && !readOnly && (
                          <>
                            {u.status !== 'active' && <button class="link" onClick={() => run(() => api.post('team/invite', { email: u.email, role: u.role })).then((r) => r && setLink(r))}>Reenviar</button>}
                            <button class="link link-danger" style="margin-left:10px" onClick={() => confirm(`¿Quitar el acceso de ${u.email}?`) && run(() => api.del(`team/${u.id}`), 'Acceso quitado').then(reload)}>Quitar</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        {!readOnly && (
          <div class="col-side">
            <form class="card" onSubmit={invite}>
              <div class="card-title">Invitar</div>
              <Field label="Correo"><input type="email" value={email} onInput={(e) => setEmail(e.target.value)} required /></Field>
              <Field label="Rol">
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </select>
              </Field>
              <button class="b b-primary" style="margin-top:16px" disabled={busy}>Crear invitación</button>
              {link && (
                <div class="info" style="margin-top:14px">
                  {link.emailed ? 'Le enviamos un correo. ' : 'Comparte esta liga (vence en 7 días): '}
                  <div class="mono" style="word-break:break-all;margin-top:6px;user-select:all">{link.link}</div>
                  <button type="button" class="link" style="margin-top:6px;color:inherit" onClick={() => navigator.clipboard?.writeText(link.link).then(() => toast('Liga copiada'))}>Copiar liga</button>
                </div>
              )}
            </form>
          </div>
        )}
      </div>
    </>
  )
}
