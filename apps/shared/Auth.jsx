import { useEffect, useState } from 'preact/hooks'
import Qr from './Qr.jsx'
import { ThemeToggle } from './Theme.jsx'

/*
  Puerta de acceso compartida (admin y portal):
  login → (TOTP obligatorio: configurar o verificar) → app.
  También atiende las invitaciones: #/invitacion/<token>
*/
export function AuthGate({ api, title, subtitle, children }) {
  const [me, setMe] = useState(undefined)
  const inviteToken = (location.hash.match(/^#\/invitacion\/([A-Za-z0-9_-]{20,})/) || [])[1]

  const load = async () => {
    try {
      const m = await api.get('auth/me')
      api.setCsrf(m.csrf)
      setMe(m)
    } catch {
      setMe(null)
    }
  }
  useEffect(() => {
    api.onUnauthorized(() => setMe(null))
    if (!inviteToken) load()
    else setMe(null)
  }, [])

  if (me === undefined) return <div class="loading">Cargando…</div>
  if (inviteToken && !me) return <Shell title={title} subtitle={subtitle}><Invite api={api} token={inviteToken} onDone={() => { history.replaceState(null, '', location.pathname); load() }} /></Shell>
  if (!me) return <Shell title={title} subtitle={subtitle}><Login api={api} onDone={load} /></Shell>
  if (me.state === 'enroll_totp') return <Shell title={title} subtitle={subtitle}><Enroll api={api} onDone={load} /></Shell>
  if (me.state === 'totp') return <Shell title={title} subtitle={subtitle}><Verify api={api} onDone={load} /></Shell>
  return children({ me, reload: load, logout: async () => { await api.post('auth/logout').catch(() => {}); setMe(null) } })
}

function Shell({ title, subtitle, children }) {
  const admin = /admin/i.test(title)
  return (
    <div class="auth">
      <ThemeToggle className="theme-float" />
      <aside class="auth-hero">
        <div class="logo">zentekia<b>.</b> <span class="muted" style="font-weight:500">agentes IA</span></div>
        <div>
          <span class="eyebrow">{admin ? 'Panel de superadmin' : subtitle || 'Portal del cliente'}</span>
          <h1>{admin ? <>Opera tu plataforma de <em>agentes inteligentes.</em></> : <>Tus asistentes de IA, <em>en todos tus canales.</em></>}</h1>
          <p>{admin ? 'Da de alta clientes, ajusta tarifas por token y sigue el consumo de toda la plataforma desde un solo lugar.' : 'Configura tus asistentes, súbeles conocimiento y mide cada conversación en chat, voz y WhatsApp.'}</p>
          <div class="feats">
            <div><span>01 · Aislado</span>Datos por cliente</div>
            <div><span>02 · Seguro</span>2FA y cifrado</div>
            <div><span>03 · Medible</span>Costo por token</div>
          </div>
        </div>
        <div class="foot">ZENTEKIA · OPERACIONES INTELIGENTES</div>
        <div class="orb" aria-hidden="true" />
      </aside>
      <main class="auth-side">
        <div class="card">
          <div class="brand">{title}</div>
          {subtitle && <div class="muted small" style="margin-top:2px">{subtitle}</div>}
          <div style="margin-top:22px">{children}</div>
        </div>
      </main>
    </div>
  )
}

function useSubmit(fn) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const run = async (e) => {
    e?.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (x) {
      setErr(x.message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, err, run }
}

function Login({ api, onDone }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const s = useSubmit(async () => {
    const r = await api.post('auth/login', { email, password })
    api.setCsrf(r.csrf)
    onDone()
  })
  return (
    <form onSubmit={s.run}>
      <h2>Entrar</h2>
      <label class="l">Correo<input type="text" autocomplete="username" value={email} onInput={(e) => setEmail(e.target.value)} required /></label>
      <label class="l">Contraseña<input type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword(e.target.value)} required /></label>
      {s.err && <div class="alert alert-danger" style="margin-top:14px">{s.err}</div>}
      <button class="b b-primary b-block" style="margin-top:20px" disabled={s.busy}>{s.busy ? <span class="spinner" /> : 'Entrar'}</button>
    </form>
  )
}

function CodeInput({ value, onInput }) {
  return <input class="in mono" style="font-size:22px;letter-spacing:6px;text-align:center" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" value={value} onInput={(e) => onInput(e.target.value.replace(/\D/g, ''))} required />
}

function Verify({ api, onDone }) {
  const [code, setCode] = useState('')
  const s = useSubmit(async () => {
    await api.post('auth/totp/verify', { code })
    onDone()
  })
  return (
    <form onSubmit={s.run}>
      <h2>Verificación en dos pasos</h2>
      <p class="sub">Escribe el código de 6 dígitos de tu app de autenticación.</p>
      <div style="margin-top:16px"><CodeInput value={code} onInput={setCode} /></div>
      {s.err && <div class="alert alert-danger" style="margin-top:14px">{s.err}</div>}
      <button class="b b-primary b-block" style="margin-top:20px" disabled={s.busy || code.length !== 6}>Continuar</button>
    </form>
  )
}

function Enroll({ api, onDone }) {
  const [setup, setSetup] = useState(null)
  const [code, setCode] = useState('')
  const [err0, setErr0] = useState(null)
  useEffect(() => {
    api.post('auth/totp/setup').then(setSetup).catch((e) => setErr0(e.message))
  }, [])
  const s = useSubmit(async () => {
    await api.post('auth/totp/enable', { code })
    onDone()
  })
  return (
    <form onSubmit={s.run}>
      <h2>Protege tu cuenta</h2>
      <p class="sub">Tu rol requiere verificación en dos pasos. Escanea el código con Google Authenticator, Microsoft Authenticator o 1Password.</p>
      {err0 && <div class="alert alert-danger" style="margin-top:14px">{err0}</div>}
      {setup && (
        <>
          <Qr text={setup.uri} />
          <div class="small muted" style="text-align:center">¿No puedes escanear? Escribe esta clave:<br /><span class="mono" style="user-select:all">{setup.secret}</span></div>
          <label class="l" style="margin-top:18px">Código de 6 dígitos<CodeInput value={code} onInput={setCode} /></label>
        </>
      )}
      {s.err && <div class="alert alert-danger" style="margin-top:14px">{s.err}</div>}
      <button class="b b-primary b-block" style="margin-top:20px" disabled={!setup || s.busy || code.length !== 6}>Activar y entrar</button>
    </form>
  )
}

function Invite({ api, token, onDone }) {
  const [info, setInfo] = useState(null)
  const [err0, setErr0] = useState(null)
  const [name, setName] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  useEffect(() => {
    api.get(`auth/invite?t=${encodeURIComponent(token)}`).then(setInfo).catch((e) => setErr0(e.message))
  }, [])
  const s = useSubmit(async () => {
    if (pw !== pw2) throw new Error('Las contraseñas no coinciden.')
    const r = await api.post('auth/accept', { token, name: name || undefined, password: pw })
    api.setCsrf(r.csrf)
    onDone()
  })
  if (err0) return <div class="alert alert-danger">{err0}</div>
  if (!info) return <div class="muted">Cargando invitación…</div>
  return (
    <form onSubmit={s.run}>
      <h2>Crea tu contraseña</h2>
      <p class="sub">Acceso para <b>{info.email}</b> en {info.tenant}.</p>
      <label class="l">Tu nombre<input value={name} onInput={(e) => setName(e.target.value)} autocomplete="name" /></label>
      <label class="l">Contraseña<input type="password" autocomplete="new-password" value={pw} onInput={(e) => setPw(e.target.value)} required /><span class="hint">Mínimo 10 caracteres, con letras y números.</span></label>
      <label class="l">Repite la contraseña<input type="password" autocomplete="new-password" value={pw2} onInput={(e) => setPw2(e.target.value)} required /></label>
      {s.err && <div class="alert alert-danger" style="margin-top:14px">{s.err}</div>}
      <button class="b b-primary b-block" style="margin-top:20px" disabled={s.busy}>Crear cuenta</button>
    </form>
  )
}
