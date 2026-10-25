import React, { useEffect, useMemo, useRef, useState } from 'react'
import './chat.css'
import Markdown from './markdown.jsx'
import { responder } from './api.js'
import { cargar, guardar, nuevaConversacion, tituloDesde, uid } from './storage.js'

/*
  Widget de chat: un botón flotante que abre el agente virtual.
  Props: config (ver src/config.js), defaultOpen, token (sesión de admin)
  y onSesionExpirada (se llama si el Worker responde 401).
*/
export default function ChatWidget({ config, defaultOpen = false, token, onSesionExpirada }) {
  const [abierto, setAbierto] = useState(defaultOpen)
  const [vista, setVista] = useState('chat') // chat | historial
  const [convs, setConvs] = useState(() => {
    const guardadas = (cargar() || []).filter((c) => !c.call) // las llamadas de voz guardadas ya no aplican
    if (guardadas && guardadas.length) return guardadas
    return [nuevaConversacion(config.greeting, config.agent)]
  })
  const [activaId, setActivaId] = useState(() => convs[0].id)
  const [escribiendo, setEscribiendo] = useState(false)
  const [error, setError] = useState(null)
  const [teaser, setTeaser] = useState(false)
  const [sinLeer, setSinLeer] = useState(0)
  const abortRef = useRef(null)
  const abiertoRef = useRef(abierto)
  abiertoRef.current = abierto

  const activa = convs.find((c) => c.id === activaId) || convs[0]

  // Si cambia el agente (por ejemplo desde la página de demo), se abre una conversación nueva con su saludo
  const agenteAnterior = useRef(config.agent)
  useEffect(() => {
    if (agenteAnterior.current === config.agent) return
    agenteAnterior.current = config.agent
    abortRef.current?.abort()
    const c = nuevaConversacion(config.greeting, config.agent)
    setConvs((cs) => [c, ...cs.filter((x) => x.messages.some((m) => m.role === 'user'))])
    setActivaId(c.id)
    setError(null)
    setVista('chat')
  }, [config.agent, config.greeting])

  useEffect(() => { guardar(convs) }, [convs])

  // Globo de bienvenida junto al botón, una vez por visita
  useEffect(() => {
    if (abierto) return
    const t = setTimeout(() => setTeaser(true), 1400)
    return () => clearTimeout(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (abierto) { setTeaser(false); setSinLeer(0) }
  }, [abierto])

  // Escape cierra el panel
  useEffect(() => {
    if (!abierto) return
    const onKey = (e) => { if (e.key === 'Escape') setAbierto(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [abierto])

  const actualizar = (id, fn) => setConvs((cs) => cs.map((c) => (c.id === id ? fn(c) : c)))

  async function enviar(texto, base) {
    const contenido = texto.trim()
    if (!contenido || escribiendo) return
    setError(null)
    const conv = activa
    const ahora = Date.now()
    const mensajeUsuario = { id: uid(), role: 'user', content: contenido, ts: ahora }
    const respuestaId = uid()
    const previos = base || conv.messages
    const historial = [...previos, mensajeUsuario]

    actualizar(conv.id, (c) => ({
      ...c,
      title: previos.some((m) => m.role === 'user') ? c.title : tituloDesde(contenido),
      updatedAt: ahora,
      messages: [...historial, { id: respuestaId, role: 'assistant', content: '', ts: ahora, pending: true }],
    }))

    const ctrl = new AbortController()
    abortRef.current = ctrl
    setEscribiendo(true)
    let acumulado = ''
    try {
      for await (const trozo of responder({ apiUrl: config.apiUrl, token, messages: historial, signal: ctrl.signal, agent: conv.agent || config.agent, conversationId: conv.id })) {
        acumulado += trozo
        const texto = acumulado
        actualizar(conv.id, (c) => ({
          ...c,
          messages: c.messages.map((m) => (m.id === respuestaId ? { ...m, content: texto } : m)),
        }))
      }
      if (!abiertoRef.current) setSinLeer((n) => n + 1)
    } catch (e) {
      if (e.status === 401) {
        onSesionExpirada?.()
      } else if (e.name !== 'AbortError') {
        setError(
          e instanceof TypeError
            ? 'No pude conectar con el servidor. Revisa tu conexión e intenta de nuevo.'
            : e.message || 'Algo salió mal al responder.'
        )
      }
    } finally {
      actualizar(conv.id, (c) => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages
          .map((m) => (m.id === respuestaId ? { ...m, pending: false, content: acumulado } : m))
          .filter((m) => !(m.id === respuestaId && !acumulado)),
      }))
      setEscribiendo(false)
      abortRef.current = null
    }
  }

  function detener() { abortRef.current?.abort() }

  function reintentar() {
    const msgs = activa.messages
    let i = msgs.length - 1
    while (i >= 0 && msgs[i].role !== 'user') i--
    if (i < 0) return
    enviar(msgs[i].content, msgs.slice(0, i))
  }

  function nueva() {
    if (escribiendo) detener()
    const vacia = convs.find((c) => !c.messages.some((m) => m.role === 'user') && (c.agent || config.agent) === config.agent)
    if (vacia) {
      setActivaId(vacia.id)
    } else {
      const c = nuevaConversacion(config.greeting, config.agent)
      setConvs((cs) => [c, ...cs])
      setActivaId(c.id)
    }
    setError(null)
    setVista('chat')
  }

  function abrirConv(id) {
    if (escribiendo) detener()
    setActivaId(id)
    setError(null)
    setVista('chat')
  }

  function borrar(id) {
    setConvs((cs) => {
      const quedan = cs.filter((c) => c.id !== id)
      const lista = quedan.length ? quedan : [nuevaConversacion(config.greeting, config.agent)]
      if (id === activaId) setActivaId(lista[0].id)
      return lista
    })
  }

  const estilo = { '--zw-accent': config.accent }

  return (
    <div className="zw" style={estilo}>
      {abierto && (
        <section className="zw-panel" role="dialog" aria-label={`Chat con ${config.name}`}>
          <Encabezado
            config={config}
            vista={vista}
            escribiendo={escribiendo}
            onHistorial={() => setVista(vista === 'historial' ? 'chat' : 'historial')}
            onNueva={nueva}
            onCerrar={() => setAbierto(false)}
          />
          {vista === 'historial' ? (
            <Historial convs={convs} activaId={activa.id} onAbrir={abrirConv} onBorrar={borrar} onNueva={nueva} />
          ) : (
            <>
              <Mensajes
                conv={activa}
                config={config}
                escribiendo={escribiendo}
                error={error}
                onReintentar={reintentar}
                onSugerencia={enviar}
              />
              <Composer escribiendo={escribiendo} onEnviar={enviar} onDetener={detener} config={config} />
            </>
          )}
        </section>
      )}

      {!abierto && teaser && (
        <div className="zw-teaser">
          <button className="zw-teaser-body" onClick={() => setAbierto(true)}>
            <span className="zw-teaser-name">{config.name}</span>
            {config.teaser}
          </button>
          <button className="zw-teaser-x" aria-label="Ocultar mensaje" onClick={() => setTeaser(false)}>
            <Icono d="M6 6l12 12M18 6L6 18" />
          </button>
        </div>
      )}

      <button
        className={'zw-launcher' + (abierto ? ' is-open' : '')}
        aria-label={abierto ? 'Cerrar chat' : `Abrir chat con ${config.name}`}
        aria-expanded={abierto}
        onClick={() => setAbierto((a) => !a)}
      >
        <span className="zw-launcher-icon zw-icon-chat" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16.9A2.5 2.5 0 0 1 4 14.5z" /><circle cx="8.5" cy="9.6" r="1.1" className="zw-dot" /><circle cx="12" cy="9.6" r="1.1" className="zw-dot" /><circle cx="15.5" cy="9.6" r="1.1" className="zw-dot" /></svg>
        </span>
        <span className="zw-launcher-icon zw-icon-x" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17" /></svg>
        </span>
        {!abierto && (sinLeer > 0 || teaser) && <span className="zw-badge">{sinLeer || 1}</span>}
      </button>
    </div>
  )
}

/* ---------------- piezas ---------------- */

function Icono({ d }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="zw-ico"><path d={d} /></svg>
  )
}

function Avatar({ config, size = 'md' }) {
  return (
    <span className={`zw-avatar zw-avatar-${size}`} aria-hidden="true">
      {config.name.slice(0, 1)}
    </span>
  )
}

function Encabezado({ config, vista, escribiendo, onHistorial, onNueva, onCerrar }) {
  return (
    <header className="zw-head">
      <button
        className="zw-iconbtn"
        onClick={onHistorial}
        aria-label={vista === 'historial' ? 'Volver al chat' : 'Ver conversaciones'}
        title={vista === 'historial' ? 'Volver al chat' : 'Conversaciones'}
      >
        {vista === 'historial' ? <Icono d="M15 5l-7 7 7 7" /> : <Icono d="M4 7h16M4 12h16M4 17h10" />}
      </button>
      <div className="zw-who">
        <span className="zw-avatar-wrap">
          <Avatar config={config} />
          <span className="zw-online" />
        </span>
        <div className="zw-who-text">
          <strong>{vista === 'historial' ? 'Conversaciones' : config.name}</strong>
          <span>{vista === 'historial' ? config.company : escribiendo ? 'Escribiendo…' : config.subtitle}</span>
        </div>
      </div>
      <button className="zw-iconbtn" onClick={onNueva} aria-label="Nueva conversación" title="Nueva conversación">
        <Icono d="M12 5v14M5 12h14" />
      </button>
      <button className="zw-iconbtn" onClick={onCerrar} aria-label="Cerrar chat" title="Cerrar">
        <Icono d="M6 12h12" />
      </button>
    </header>
  )
}

const hora = (ts) => new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })

function Mensajes({ conv, config, escribiendo, error, onReintentar, onSugerencia }) {
  const finRef = useRef(null)
  const ultimo = conv.messages[conv.messages.length - 1]
  useEffect(() => {
    finRef.current?.scrollIntoView({ block: 'end' })
  }, [conv.id, conv.messages.length, ultimo?.content, error])

  const sinPreguntas = !conv.messages.some((m) => m.role === 'user')

  return (
    <div className="zw-body" aria-live="polite">
      <div className="zw-day">{conv.example ? 'Conversación de ejemplo' : 'Hoy'}</div>
      {conv.messages.map((m, i) => {
        const anterior = conv.messages[i - 1]
        const primeroDelGrupo = !anterior || anterior.role !== m.role
        return (
          <div key={m.id} className={`zw-row zw-${m.role}` + (primeroDelGrupo ? ' is-first' : '')}>
            {m.role === 'assistant' && (primeroDelGrupo ? <Avatar config={config} size="sm" /> : <span className="zw-avatar-gap" />)}
            <div className="zw-bubble">
              {m.pending && !m.content ? (
                <span className="zw-typing" aria-label="Escribiendo"><i /><i /><i /></span>
              ) : (
                <>
                  <Markdown text={m.content} />
                  {m.pending && <span className="zw-caret" aria-hidden="true" />}
                </>
              )}
              {!m.pending && <time className="zw-time">{hora(m.ts)}</time>}
            </div>
          </div>
        )
      })}

      {sinPreguntas && !escribiendo && (
        <div className="zw-chips">
          {config.quickReplies.map((q) => (
            <button key={q} className="zw-chip" onClick={() => onSugerencia(q)}>{q}</button>
          ))}
        </div>
      )}

      {error && (
        <div className="zw-error" role="alert">
          <span>{error}</span>
          <button onClick={onReintentar}>Reintentar</button>
        </div>
      )}
      <div ref={finRef} />
    </div>
  )
}

function Composer({ escribiendo, onEnviar, onDetener, config }) {
  const [texto, setTexto] = useState('')
  const ref = useRef(null)

  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [texto])

  const mandar = () => {
    if (!texto.trim() || escribiendo) return
    onEnviar(texto)
    setTexto('')
  }

  return (
    <div className="zw-foot">
      <form className="zw-composer" onSubmit={(e) => { e.preventDefault(); mandar() }}>
        <label htmlFor="zw-input" className="zw-sr">Escribe tu mensaje</label>
        <textarea
          id="zw-input"
          ref={ref}
          rows={1}
          value={texto}
          placeholder="Escribe tu mensaje…"
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); mandar() }
          }}
        />
        {escribiendo ? (
          <button type="button" className="zw-send is-stop" onClick={onDetener} aria-label="Detener respuesta" title="Detener">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
          </button>
        ) : (
          <button type="submit" className="zw-send" disabled={!texto.trim()} aria-label="Enviar mensaje" title="Enviar">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
          </button>
        )}
      </form>
      <p className="zw-legal">
        {config.apiUrl ? 'Guardamos esta conversación para mejorar la atención' : 'Modo demo · respuestas de ejemplo'}
      </p>
    </div>
  )
}

function Historial({ convs, activaId, onAbrir, onBorrar, onNueva }) {
  const [confirmar, setConfirmar] = useState(null)
  const ordenadas = useMemo(() => [...convs].sort((a, b) => b.updatedAt - a.updatedAt), [convs])
  return (
    <div className="zw-list">
      <button className="zw-new" onClick={onNueva}>
        <Icono d="M12 5v14M5 12h14" /> Nueva conversación
      </button>
      <ul>
        {ordenadas.map((c) => {
          const ultimo = c.messages[c.messages.length - 1]
          return (
            <li key={c.id} className={c.id === activaId ? 'is-active' : undefined}>
              {confirmar === c.id ? (
                <div className="zw-confirm">
                  <span>¿Borrar esta conversación?</span>
                  <button className="zw-confirm-yes" onClick={() => { onBorrar(c.id); setConfirmar(null) }}>Borrar</button>
                  <button onClick={() => setConfirmar(null)}>Cancelar</button>
                </div>
              ) : (
                <>
                  <button className="zw-item" onClick={() => onAbrir(c.id)}>
                    <span className="zw-item-top">
                      <strong>{c.title}</strong>
                      <time>{relativo(c.updatedAt)}</time>
                    </span>
                    <span className="zw-item-prev">
                      {c.example && <em>Ejemplo</em>}
                      {resumen(ultimo?.content)}
                    </span>
                  </button>
                  <button className="zw-iconbtn zw-del" aria-label={`Borrar «${c.title}»`} title="Borrar" onClick={() => setConfirmar(c.id)}>
                    <Icono d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const resumen = (t = '') => t.replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 70)

function relativo(ts) {
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.round(h / 24)
  return d === 1 ? 'ayer' : `hace ${d} días`
}
