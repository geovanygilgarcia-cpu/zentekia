import { useState } from 'preact/hooks'
import { date } from '../../shared/api.js'
import Qr from '../../shared/Qr.jsx'
import { SIZES, useTextSize, useTheme } from '../../shared/Theme.jsx'
import { Field, PageHead, useAction } from './common.jsx'
import { Icon } from './icons.jsx'

const ROLE = { owner: 'Propietario', editor: 'Editor' }

/** Campo de contraseña con botón para ver lo que se escribe */
function Password({ value, onInput, autocomplete, label, hint }) {
  const [show, setShow] = useState(false)
  return (
    <Field label={label} hint={hint}>
      <span class="pw">
        <input type={show ? 'text' : 'password'} autocomplete={autocomplete} value={value} onInput={(e) => onInput(e.target.value)} required />
        <button type="button" class="pw-eye" onClick={() => setShow(!show)} aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}>{show ? 'Ocultar' : 'Ver'}</button>
      </span>
    </Field>
  )
}

function Datos({ api, me, reload, readOnly }) {
  const [name, setName] = useState(me.user.name || '')
  const [busy, run] = useAction()
  const changed = name.trim() !== (me.user.name || '')
  const save = async (e) => {
    e.preventDefault()
    const r = await run(() => api.put('auth/profile', { name: name.trim() }), 'Nombre actualizado')
    if (r) reload()
  }
  return (
    <form class="card acc-card" onSubmit={save}>
      <div class="acc-head"><span class="acc-ic"><Icon name="users" /></span><div><div class="card-title">Tus datos</div><div class="small muted">Así te ve tu equipo en el portal.</div></div></div>
      <Field label="Nombre">
        <input value={name} onInput={(e) => setName(e.target.value)} maxLength={120} required disabled={readOnly} autocomplete="name" />
      </Field>
      <Field label="Correo" hint="Es tu usuario para entrar. Si necesitas cambiarlo, pídeselo a Zentekia.">
        <input value={me.user.email} disabled />
      </Field>
      <div class="acc-meta">
        <span>Rol: <b>{ROLE[me.user.role] || me.user.role}</b></span>
        {me.user.last_login_at && <span>Último acceso: <b>{date(me.user.last_login_at)}</b></span>}
      </div>
      {!readOnly && <button class="b b-primary" style="margin-top:18px" disabled={busy || !changed || !name.trim()}>Guardar nombre</button>}
    </form>
  )
}

function Contrasena({ api }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, run] = useAction()
  const mismatch = again && next !== again
  const save = async (e) => {
    e.preventDefault()
    if (next !== again) return
    const r = await run(() => api.post('auth/password', { current: cur, next }), 'Contraseña actualizada. Se cerraron tus otras sesiones.')
    if (r) {
      setCur('')
      setNext('')
      setAgain('')
    }
  }
  return (
    <form class="card acc-card" onSubmit={save}>
      <div class="acc-head"><span class="acc-ic"><Icon name="shield" /></span><div><div class="card-title">Contraseña</div><div class="small muted">Al cambiarla se cierran tus sesiones en otros equipos.</div></div></div>
      <Password label="Contraseña actual" autocomplete="current-password" value={cur} onInput={setCur} />
      <Password label="Nueva contraseña" hint="Mínimo 10 caracteres, con letras y números." autocomplete="new-password" value={next} onInput={setNext} />
      <Password label="Repite la nueva contraseña" autocomplete="new-password" value={again} onInput={setAgain} />
      {mismatch && <div class="alert alert-warn" style="margin-top:12px">Las dos contraseñas nuevas no coinciden.</div>}
      <button class="b b-primary" style="margin-top:18px" disabled={busy || !cur || !next || next !== again}>Cambiar contraseña</button>
    </form>
  )
}

function DosPasos({ api, me, reload }) {
  const on = me.user.totp_enabled
  const [mode, setMode] = useState(null) // 'enable' | 'disable'
  const [setup, setSetup] = useState(null)
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [busy, run] = useAction()
  const startEnable = async () => {
    setMode('enable')
    setCode('')
    const s = await run(() => api.post('auth/totp/setup'))
    if (s) setSetup(s)
    else setMode(null)
  }
  const confirmEnable = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post('auth/totp/enable', { code }), 'Verificación en dos pasos activada')
    if (r) {
      setMode(null)
      setSetup(null)
      reload()
    }
  }
  const confirmDisable = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post('auth/totp/disable', { password: pw }), 'Verificación en dos pasos desactivada')
    if (r) {
      setMode(null)
      setPw('')
      reload()
    }
  }
  return (
    <div class={'card acc-card acc-2fa' + (on ? ' on' : '')}>
      <div class="acc-head">
        <span class="acc-ic"><Icon name="check" /></span>
        <div class="grow">
          <div class="card-title">Verificación en dos pasos</div>
          <div class="small muted">Además de tu contraseña, te pide un código de 6 dígitos de una app en tu celular.</div>
        </div>
        <span class={'badge ' + (on ? 'badge-ok' : '')}>{on ? 'Activada' : 'Desactivada'}</span>
      </div>

      {!mode && (
        <>
          <p class="acc-text">
            {on
              ? 'Tu cuenta está más protegida: aunque alguien sepa tu contraseña, no puede entrar sin tu celular.'
              : 'Es opcional. Te recomendamos activarla si manejas información sensible; si te resulta complicada, puedes dejarla apagada.'}
          </p>
          {me.user.totp_required ? (
            <div class="info">Para tu tipo de cuenta es obligatoria.</div>
          ) : on ? (
            <button class="b b-outline" onClick={() => setMode('disable')}>Desactivar</button>
          ) : (
            <button class="b b-primary" onClick={startEnable} disabled={busy}>Activar</button>
          )}
        </>
      )}

      {mode === 'enable' && (
        <form onSubmit={confirmEnable}>
          <ol class="acc-steps">
            <li>Instala <b>Google Authenticator</b> o <b>Microsoft Authenticator</b> en tu celular.</li>
            <li>En la app toca <b>+</b> y escanea este código.</li>
            <li>Escribe el número de 6 dígitos que aparece.</li>
          </ol>
          {setup ? (
            <>
              <Qr text={setup.uri} />
              <div class="small muted" style="text-align:center">¿No puedes escanear? Escribe esta clave en la app:<br /><span class="mono" style="user-select:all">{setup.secret}</span></div>
              <Field label="Código de 6 dígitos">
                <input class="acc-code mono" inputmode="numeric" autocomplete="one-time-code" maxLength={6} placeholder="000000" value={code} onInput={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
              </Field>
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
        <form onSubmit={confirmDisable}>
          <p class="acc-text">Para confirmar que eres tú, escribe tu contraseña. Desde tu siguiente acceso solo te pediremos correo y contraseña.</p>
          <Password label="Tu contraseña" autocomplete="current-password" value={pw} onInput={setPw} />
          <div class="row" style="margin-top:16px">
            <button type="button" class="b b-ghost" onClick={() => { setMode(null); setPw('') }}>Cancelar</button>
            <button class="b b-danger" disabled={busy || !pw}>Desactivar</button>
          </div>
        </form>
      )}
    </div>
  )
}

function Preferencias() {
  const [t, setT] = useTheme()
  const [s, setS] = useTextSize()
  return (
    <div class="card acc-card">
      <div class="acc-head"><span class="acc-ic"><Icon name="brush" /></span><div><div class="card-title">Cómo se ve</div><div class="small muted">Se guarda en este navegador.</div></div></div>
      <div class="l">Tamaño de letra</div>
      <div class="acc-seg" role="group" aria-label="Tamaño de letra">
        {SIZES.map((x, i) => (
          <button key={x.id} type="button" aria-pressed={s === x.id} onClick={() => setS(x.id)}>
            <span style={`font-size:${13 + i * 3}px;font-weight:700`}>Aa</span>
            {x.label}
          </button>
        ))}
      </div>
      <div class="l">Tema</div>
      <div class="acc-seg" role="group" aria-label="Tema">
        <button type="button" aria-pressed={t === 'light'} onClick={() => setT('light')}>Claro</button>
        <button type="button" aria-pressed={t === 'dark'} onClick={() => setT('dark')}>Oscuro</button>
      </div>
    </div>
  )
}

export default function MiCuenta({ api, me, reloadMe, readOnly }) {
  return (
    <>
      <PageHead title="Mi cuenta" sub="Tu nombre, tu contraseña, la verificación en dos pasos y el tamaño de letra." />
      <div class="acc-grid">
        <div class="acc-col">
          <Datos api={api} me={me} reload={reloadMe} readOnly={readOnly} />
          <Preferencias />
        </div>
        <div class="acc-col">
          {readOnly ? (
            <div class="card"><div class="small muted">Estás en modo soporte (solo lectura): la contraseña y la verificación en dos pasos solo las cambia la persona dueña de la cuenta.</div></div>
          ) : (
            <>
              <DosPasos api={api} me={me} reload={reloadMe} />
              <Contrasena api={api} />
            </>
          )}
        </div>
      </div>
    </>
  )
}
