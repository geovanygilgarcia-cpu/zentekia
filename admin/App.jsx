import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, probar, sesion, onExpira } from './api.js'
import Markdown from '../src/widget/markdown.jsx'

/*
  Panel administrativo del agente
  - Login (usuario y contraseña configurados en Cloudflare)
  - Conversaciones: historial guardado en D1, búsqueda, filtro por agente, borrar
  - Prompts: crear, editar, activar, borrar y probar en vivo
*/
export default function App() {
  const [usuario, setUsuario] = useState(() => sesion.get()?.usuario || null)
  const [vista, setVista] = useState(() => (location.hash === '#prompts' ? 'prompts' : 'conversaciones'))
  const [aviso, setAviso] = useState(null)

  useEffect(() => onExpira(() => { setUsuario(null); setAviso('Tu sesión expiró. Vuelve a entrar.') }), [])
  useEffect(() => { try { history.replaceState(null, '', '#' + vista) } catch { /* nada */ } }, [vista])

  if (!usuario) {
    return <Login aviso={aviso} onEntrar={(u) => { setAviso(null); setUsuario(u) }} />
  }

  const salir = () => { sesion.set(null); setUsuario(null) }

  return (
    <div className="ad">
      <header className="ad-top">
        <div className="ad-brand">
          <span className="ad-mark" aria-hidden="true">P</span>
          <span><em>Prakticall</em> · panel</span>
        </div>
        <nav className="ad-tabs" aria-label="Secciones">
          <button className={vista === 'conversaciones' ? 'is-on' : ''} onClick={() => setVista('conversaciones')}>Conversaciones</button>
          <button className={vista === 'prompts' ? 'is-on' : ''} onClick={() => setVista('prompts')}>Prompts</button>
        </nav>
        <div className="ad-user">
          <span className="ad-user-name">{usuario}</span>
          <button className="ad-btn ad-btn-quiet" onClick={salir}>Salir</button>
        </div>
      </header>
      <main className="ad-main">
        {vista === 'conversaciones' ? <Conversaciones /> : <Prompts />}
      </main>
    </div>
  )
}

/* ================= login ================= */

function Login({ onEntrar, aviso }) {
  const [u, setU] = useState('admin')
  const [p, setP] = useState('')
  const [error, setError] = useState(aviso)
  const [cargando, setCargando] = useState(false)

  const entrar = async (e) => {
    e.preventDefault()
    setCargando(true)
    setError(null)
    try {
      const r = await api('/login', { method: 'POST', body: { usuario: u, contrasena: p } })
      sesion.set({ token: r.token, usuario: r.usuario })
      onEntrar(r.usuario)
    } catch (err) {
      setError(err.message)
    } finally {
      setCargando(false)
    }
  }

  return (
    <div className="ad-login">
      <form className="ad-login-card" onSubmit={entrar}>
        <span className="ad-mark ad-mark-lg" aria-hidden="true">P</span>
        <h1><em>Prakticall</em> · panel</h1>
        <p className="ad-dim">Historial de conversaciones y prompts del agente virtual.</p>
        <label className="ad-field">
          <span>Usuario</span>
          <input id="ad-user" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} />
        </label>
        <label className="ad-field">
          <span>Contraseña</span>
          <input id="ad-pass" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} autoFocus />
        </label>
        {error && <p className="ad-error" role="alert">{error}</p>}
        <button className="ad-btn ad-btn-primary" disabled={cargando || !p}>{cargando ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  )
}

/* ================= conversaciones ================= */

function Conversaciones() {
  const [stats, setStats] = useState(null)
  const [lista, setLista] = useState([])
  const [hayMas, setHayMas] = useState(false)
  const [pagina, setPagina] = useState(0)
  const [q, setQ] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [agente, setAgente] = useState('')
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [abierta, setAbierta] = useState(null)

  useEffect(() => { api('/stats').then(setStats).catch((e) => setError(e.message)) }, [])

  const cargar = useCallback(async (p) => {
    setCargando(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(p) })
      if (busqueda) params.set('q', busqueda)
      if (agente) params.set('agent', agente)
      const r = await api(`/conversations?${params}`)
      setLista((l) => (p === 0 ? r.conversaciones : [...l, ...r.conversaciones]))
      setHayMas(r.hayMas)
      setPagina(p)
    } catch (e) {
      setError(e.message)
    } finally {
      setCargando(false)
    }
  }, [busqueda, agente])

  useEffect(() => { cargar(0) }, [cargar])

  const borrada = (id) => {
    setLista((l) => l.filter((c) => c.id !== id))
    setAbierta(null)
    setStats((s) => (s ? { ...s, conversaciones: Math.max(0, s.conversaciones - 1) } : s))
  }

  return (
    <div className={'ad-split' + (abierta ? ' has-detail' : '')}>
      <section className="ad-pane ad-list-pane" aria-label="Lista de conversaciones">
        <div className="ad-stats">
          <Stat n={stats?.conversacionesHoy} label="Conversaciones hoy" />
          <Stat n={stats?.preguntasHoy} label="Preguntas hoy" />
          <Stat n={stats?.conversaciones} label="Total guardadas" />
        </div>
        <form className="ad-filters" onSubmit={(e) => { e.preventDefault(); setBusqueda(q.trim()) }}>
          <input id="ad-q" type="search" placeholder="Buscar en los mensajes…" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setBusqueda('') }} />
          <select id="ad-agent" value={agente} onChange={(e) => setAgente(e.target.value)} aria-label="Filtrar por agente">
            <option value="">Todos los agentes</option>
            {(stats?.agentes || []).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </form>
        {error && <p className="ad-error" role="alert">{error}</p>}
        <ul className="ad-convs">
          {lista.map((c) => (
            <li key={c.id}>
              <button className={'ad-conv' + (abierta === c.id ? ' is-on' : '')} onClick={() => setAbierta(c.id)}>
                <span className="ad-conv-top">
                  <strong>{c.title || 'Sin título'}</strong>
                  <time>{fechaCorta(c.updated_at)}</time>
                </span>
                <span className="ad-conv-prev">{(c.last_message || '').replace(/\*\*/g, '').slice(0, 110)}</span>
                <span className="ad-conv-meta">
                  <span className="ad-chip">{c.agent}</span>
                  <span>{c.message_count} mensajes</span>
                  {c.country && <span>{c.country}</span>}
                  {c.origin && <span className="ad-origin">{c.origin.replace(/^https?:\/\//, '')}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {!cargando && !lista.length && !error && (
          <div className="ad-empty">
            <strong>{busqueda || agente ? 'Nada coincide con el filtro.' : 'Todavía no hay conversaciones.'}</strong>
            <span>{busqueda || agente ? 'Prueba con otra palabra o quita el filtro.' : 'Aparecen aquí en cuanto alguien escriba en el chat de tu sitio.'}</span>
          </div>
        )}
        {cargando && <p className="ad-dim ad-pad">Cargando…</p>}
        {hayMas && !cargando && <button className="ad-btn ad-more" onClick={() => cargar(pagina + 1)}>Ver más</button>}
      </section>

      <section className="ad-pane ad-detail-pane" aria-label="Conversación">
        {abierta ? (
          <Detalle id={abierta} onCerrar={() => setAbierta(null)} onBorrada={borrada} />
        ) : (
          <div className="ad-empty ad-empty-center">
            <strong>Elige una conversación</strong>
            <span>Verás todos los mensajes entre el visitante y el agente.</span>
          </div>
        )}
      </section>
    </div>
  )
}

function Stat({ n, label }) {
  return (
    <div className="ad-stat">
      <span className="ad-stat-n">{n ?? '—'}</span>
      <span className="ad-stat-l">{label}</span>
    </div>
  )
}

function Detalle({ id, onCerrar, onBorrada }) {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [confirmar, setConfirmar] = useState(false)

  useEffect(() => {
    setDatos(null)
    setError(null)
    setConfirmar(false)
    api(`/conversations/${id}`).then(setDatos).catch((e) => setError(e.message))
  }, [id])

  const borrar = async () => {
    try {
      await api(`/conversations/${id}`, { method: 'DELETE' })
      onBorrada(id)
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="ad-detail">
      <div className="ad-detail-head">
        <button className="ad-btn ad-btn-quiet ad-back" onClick={onCerrar}>← Lista</button>
        <div className="ad-detail-title">
          <strong>{datos?.conversacion.title || 'Conversación'}</strong>
          {datos && (
            <span className="ad-dim">
              {datos.conversacion.agent} · {fechaLarga(datos.conversacion.started_at)}
              {datos.conversacion.country ? ` · ${datos.conversacion.country}` : ''}
            </span>
          )}
        </div>
        {confirmar ? (
          <span className="ad-confirm">
            ¿Borrar para siempre?
            <button className="ad-btn ad-btn-danger" onClick={borrar}>Borrar</button>
            <button className="ad-btn" onClick={() => setConfirmar(false)}>Cancelar</button>
          </span>
        ) : (
          <button className="ad-btn" onClick={() => setConfirmar(true)}>Borrar</button>
        )}
      </div>
      {error && <p className="ad-error" role="alert">{error}</p>}
      {!datos && !error && <p className="ad-dim ad-pad">Cargando…</p>}
      {datos && (
        <div className="ad-transcript">
          {datos.mensajes.map((m, i) => (
            <div key={i} className={`ad-msg ad-msg-${m.role}`}>
              <span className="ad-msg-who">{m.role === 'user' ? 'Visitante' : 'Agente'} · {hora(m.created_at)}</span>
              <div className="ad-bubble"><Markdown text={m.content} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ================= prompts ================= */

const NUEVO = { id: null, agent: 'prakticall-ventas', name: '', content: '' }

function Prompts() {
  const [lista, setLista] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [sel, setSel] = useState(null) // prompt en edición (copia)
  const [ok, setOk] = useState(null)

  const cargar = useCallback(async (seleccionarId) => {
    setCargando(true)
    try {
      const r = await api('/prompts')
      setLista(r.prompts)
      if (seleccionarId) setSel({ ...r.prompts.find((p) => p.id === seleccionarId) })
      else setSel((s) => s || (r.prompts[0] ? { ...r.prompts[0] } : { ...NUEVO }))
    } catch (e) {
      setError(e.message)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => { cargar() }, [cargar])
  useEffect(() => { if (!ok) return; const t = setTimeout(() => setOk(null), 2500); return () => clearTimeout(t) }, [ok])

  const porAgente = useMemo(() => {
    const g = {}
    for (const p of lista) (g[p.agent] ||= []).push(p)
    return g
  }, [lista])
  const agentes = Object.keys(porAgente)

  return (
    <div className={'ad-split' + (sel ? ' has-detail' : '')}>
      <section className="ad-pane ad-list-pane" aria-label="Lista de prompts">
        <div className="ad-pane-head">
          <h2>Prompts</h2>
          <button className="ad-btn ad-btn-primary" onClick={() => setSel({ ...NUEVO, agent: sel?.agent || 'prakticall-ventas' })}>+ Nuevo</button>
        </div>
        <p className="ad-dim ad-pad-x">Cada agente usa su prompt <b>activo</b>. Los cambios llegan al chat en menos de un minuto.</p>
        {error && <p className="ad-error" role="alert">{error}</p>}
        {cargando && !lista.length && <p className="ad-dim ad-pad">Cargando…</p>}
        {agentes.map((a) => (
          <div key={a} className="ad-group">
            <h3 className="ad-group-h">{a}</h3>
            <ul className="ad-prompts">
              {porAgente[a].map((p) => (
                <li key={p.id}>
                  <button className={'ad-prompt' + (sel?.id === p.id ? ' is-on' : '')} onClick={() => setSel({ ...p })}>
                    <span className="ad-prompt-top">
                      <strong>{p.name}</strong>
                      {p.is_active ? <span className="ad-badge">Activo</span> : null}
                    </span>
                    <span className="ad-dim">Editado {fechaCorta(p.updated_at)} · {p.content.length.toLocaleString('es-MX')} caracteres</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="ad-pane ad-detail-pane" aria-label="Editor de prompt">
        {sel ? (
          <Editor
            key={`${sel.id ?? 'nuevo'}-${sel.updated_at || ''}-${sel.is_active || 0}`}
            prompt={sel}
            agentes={agentes}
            onCerrar={() => setSel(null)}
            onGuardado={(id, msg) => { setOk(msg); cargar(id) }}
            onBorrado={() => { setOk('Prompt borrado'); setSel(null); cargar() }}
          />
        ) : (
          <div className="ad-empty ad-empty-center">
            <strong>Elige un prompt o crea uno nuevo</strong>
            <span>El prompt son las instrucciones que sigue el agente: quién es, qué sabe y cómo responde.</span>
          </div>
        )}
        {ok && <div className="ad-toast" role="status">{ok}</div>}
      </section>
    </div>
  )
}

function Editor({ prompt, agentes, onCerrar, onGuardado, onBorrado }) {
  const [p, setP] = useState(prompt)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [confirmar, setConfirmar] = useState(false)
  const esNuevo = !p.id
  const cambiado = esNuevo || p.name !== prompt.name || p.content !== prompt.content
  const set = (k) => (e) => setP((x) => ({ ...x, [k]: k === 'agent' ? e.target.value.toLowerCase() : e.target.value }))

  const guardar = async (activar = false) => {
    setGuardando(true)
    setError(null)
    try {
      if (esNuevo) {
        const r = await api('/prompts', { method: 'POST', body: { agent: p.agent, name: p.name, content: p.content, activate: activar } })
        onGuardado(r.prompt.id, activar ? 'Prompt creado y activado' : 'Prompt creado')
      } else {
        if (cambiado) await api(`/prompts/${p.id}`, { method: 'PUT', body: { name: p.name, content: p.content } })
        if (activar) await api(`/prompts/${p.id}/activate`, { method: 'POST' })
        onGuardado(p.id, activar ? 'Guardado y activado' : 'Cambios guardados')
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setGuardando(false)
    }
  }

  const borrar = async () => {
    try {
      await api(`/prompts/${p.id}`, { method: 'DELETE' })
      onBorrado()
    } catch (e) {
      setError(e.message)
      setConfirmar(false)
    }
  }

  return (
    <div className="ad-editor">
      <div className="ad-detail-head">
        <button className="ad-btn ad-btn-quiet ad-back" onClick={onCerrar}>← Lista</button>
        <div className="ad-detail-title">
          <strong>{esNuevo ? 'Nuevo prompt' : p.name || 'Sin nombre'}</strong>
          <span className="ad-dim">{p.is_active ? 'Activo: es el que usa el chat ahora' : esNuevo ? 'Aún no se guarda' : 'Inactivo'}</span>
        </div>
      </div>

      <div className="ad-form-row">
        <label className="ad-field">
          <span>Agente</span>
          <input id="ad-p-agent" list="ad-agentes" value={p.agent} onChange={set('agent')} disabled={!esNuevo} spellCheck={false} />
          <datalist id="ad-agentes">{agentes.map((a) => <option key={a} value={a} />)}</datalist>
        </label>
        <label className="ad-field ad-grow">
          <span>Nombre</span>
          <input id="ad-p-name" value={p.name} onChange={set('name')} placeholder="Ej. Ventas · campaña de seguros" maxLength={80} />
        </label>
      </div>

      <label className="ad-field">
        <span>Instrucciones <em className="ad-dim">{p.content.length.toLocaleString('es-MX')} / 12,000</em></span>
        <textarea id="ad-p-content" value={p.content} onChange={set('content')} rows={16} spellCheck={false}
          placeholder={'PERSONALIDAD\nEres el asistente virtual de…\n\nCASO DE USO\n- …\n\nCIERRE\n- …'} />
      </label>

      {error && <p className="ad-error" role="alert">{error}</p>}

      <div className="ad-actions">
        <button className="ad-btn ad-btn-primary" disabled={guardando || !cambiado} onClick={() => guardar(false)}>
          {guardando ? 'Guardando…' : esNuevo ? 'Guardar' : 'Guardar cambios'}
        </button>
        {!p.is_active && (
          <button className="ad-btn" disabled={guardando} onClick={() => guardar(true)}>
            {esNuevo || cambiado ? 'Guardar y activar' : 'Activar'}
          </button>
        )}
        <span className="ad-spacer" />
        {!esNuevo && !p.is_active && (confirmar ? (
          <span className="ad-confirm">
            ¿Borrar este prompt?
            <button className="ad-btn ad-btn-danger" onClick={borrar}>Borrar</button>
            <button className="ad-btn" onClick={() => setConfirmar(false)}>Cancelar</button>
          </span>
        ) : (
          <button className="ad-btn ad-btn-quiet" onClick={() => setConfirmar(true)}>Borrar</button>
        ))}
      </div>

      <Probar prompt={p.content} />
    </div>
  )
}

function Probar({ prompt }) {
  const [msg, setMsg] = useState('¿Qué servicios ofrecen y cuánto cuesta?')
  const [resp, setResp] = useState('')
  const [estado, setEstado] = useState('idle')
  const [error, setError] = useState(null)
  const ctrl = useRef(null)

  const correr = async (e) => {
    e.preventDefault()
    if (estado === 'corriendo') { ctrl.current?.abort(); return }
    setResp('')
    setError(null)
    setEstado('corriendo')
    ctrl.current = new AbortController()
    try {
      for await (const t of probar(prompt, msg, ctrl.current.signal)) setResp((r) => r + t)
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
    } finally {
      setEstado('idle')
    }
  }

  return (
    <form className="ad-test" onSubmit={correr}>
      <div className="ad-test-head">
        <strong>Probar este prompt</strong>
        <span className="ad-dim">Usa el texto del editor, aunque no esté guardado. No se guarda en el historial.</span>
      </div>
      <div className="ad-test-row">
        <input id="ad-test-msg" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Escribe una pregunta de prueba" />
        <button className="ad-btn ad-btn-primary" disabled={!msg.trim() || prompt.trim().length < 20}>
          {estado === 'corriendo' ? 'Detener' : 'Probar'}
        </button>
      </div>
      {error && <p className="ad-error" role="alert">{error}</p>}
      {(resp || estado === 'corriendo') && (
        <div className="ad-bubble ad-test-out" aria-live="polite">
          {resp ? <Markdown text={resp} /> : <span className="ad-dim">Pensando…</span>}
        </div>
      )}
    </form>
  )
}

/* ================= utilidades ================= */

const tz = 'America/Mexico_City'
function fechaCorta(ts) {
  const d = new Date(ts)
  const hoy = new Date()
  const mismoDia = d.toLocaleDateString('es-MX', { timeZone: tz }) === hoy.toLocaleDateString('es-MX', { timeZone: tz })
  return mismoDia
    ? d.toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-MX', { timeZone: tz, day: 'numeric', month: 'short' })
}
const fechaLarga = (ts) =>
  new Date(ts).toLocaleString('es-MX', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
const hora = (ts) => new Date(ts).toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
