/*
  App del iframe del widget (chat.<dominio>/w/frame?key=…).
  Aislada del sitio del cliente: el sitio solo ve la burbuja; el chat vive aquí.
*/
import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import ChatPanel from '../shared/ChatPanel.jsx'
import VoiceCall from '../shared/VoiceCall.jsx'
import './frame.css'

const root = document.getElementById('root')
const KEY = root.dataset.key
const TURNSTILE = root.dataset.turnstile
// El loader manda ?chat=false / ?voice=false cuando el sitio apagó un canal con data-chat / data-voice
const QS = new URLSearchParams(location.search)
const CHAT_OFF = QS.get('chat') === 'false'
const VOICE_OFF = QS.get('voice') === 'false'

const store = {
  get(k) {
    try {
      return localStorage.getItem(`zt:${KEY}:${k}`)
    } catch {
      return mem[k] ?? null
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(`zt:${KEY}:${k}`)
      else localStorage.setItem(`zt:${KEY}:${k}`, v)
    } catch {
      mem[k] = v
    }
  },
}
const mem = {}

function parentOrigin() {
  try {
    if (location.ancestorOrigins && location.ancestorOrigins.length) return location.ancestorOrigins[0]
  } catch {}
  try {
    if (document.referrer) return new URL(document.referrer).origin
  } catch {}
  return ''
}
const PARENT = parentOrigin()
const post = (msg) => {
  if (window.parent !== window && PARENT) window.parent.postMessage({ source: 'zentekia-chat', ...msg }, PARENT)
}

let token = null
let turnstileToken = null

async function session(force) {
  if (token && !force) return token
  const r = await fetch('/v1/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, origin: PARENT, visitor_id: store.get('visitor') || undefined, turnstile: turnstileToken || undefined }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'No se pudo iniciar el chat.'), { code: j.error?.code })
  token = j.token
  store.set('visitor', j.visitor_id)
  return token
}

async function authed(path, init = {}, retry = true) {
  const t = await session()
  const r = await fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } })
  if (r.status === 401 && retry) {
    token = null
    return authed(path, init, false)
  }
  return r
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = 880
    g.gain.setValueAtTime(0.05, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.25)
  } catch {}
}

const uid = () => Math.random().toString(36).slice(2)

/** Nombre de la última persona del equipo que escribió (para el encabezado) */
const lastAuthor = (msgs) => [...msgs].reverse().find((m) => m.sender === 'human')?.author || null

const HANDLER = {
  es: { waiting: 'Esperando a una persona…', human: (n) => (n ? `Te atiende ${n}` : 'Te atiende una persona') },
  en: { waiting: 'Waiting for a person…', human: (n) => (n ? `${n} is helping you` : 'A person is helping you') },
  pt: { waiting: 'Aguardando uma pessoa…', human: (n) => (n ? `${n} está te atendendo` : 'Uma pessoa está te atendendo') },
}

function App() {
  const [cfg, setCfg] = useState(null)
  const [fatal, setFatal] = useState(null)
  const [messages, setMessages] = useState([])
  const [typing, setTyping] = useState(false)
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(store.get('privacy') === '1')
  const [needCaptcha, setNeedCaptcha] = useState(false)
  const [ended, setEnded] = useState(false)
  const [rating, setRating] = useState(null)
  const [calling, setCalling] = useState(false)
  // Bandeja: ai_active · waiting_human · human_active (con una persona la IA no responde)
  const [status, setStatus] = useState('ai_active')
  const [agentName, setAgentName] = useState(null)
  const [live, setLive] = useState(true)
  const convRef = useRef(store.get('conv'))
  const visibleRef = useRef(true)
  const capRef = useRef(null)

  const welcome = (c) => (c.welcome ? [{ id: 'welcome', role: 'assistant', content: c.welcome }] : [])

  useEffect(() => {
    ;(async () => {
      try {
        const r = await fetch(`/v1/widget/config?key=${encodeURIComponent(KEY)}`)
        const c = await r.json()
        if (!r.ok) throw new Error(c.error?.message || 'Widget no disponible')
        setCfg(c)
        document.documentElement.lang = c.language || 'es'
        let restored = []
        if (convRef.current && !c.suspended) {
          try {
            const h = await authed(`/v1/conversation?id=${encodeURIComponent(convRef.current)}`)
            const j = await h.json()
            restored = (j.messages || []).map((m) => ({ ...m, final: true }))
            if (j.ended) {
              setEnded(true)
              setRating(j.rating || null)
            } else if (j.status) setStatus(j.status)
            setLive(j.live !== false)
            setAgentName(lastAuthor(restored))
          } catch {}
        }
        setMessages([...welcome(c), ...restored])
        if (c.turnstile && TURNSTILE) setNeedCaptcha(true)
        post({ type: 'zt:ready' })
      } catch (e) {
        setFatal(e.message)
      }
    })()
    const onMsg = (e) => {
      if (e.origin !== PARENT || e.data?.source !== 'zentekia-host') return
      if (e.data.type === 'zt:visibility') visibleRef.current = Boolean(e.data.visible)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Turnstile (opcional, si el cliente lo activó)
  useEffect(() => {
    if (!needCaptcha || !capRef.current) return
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = () =>
      window.turnstile?.render(capRef.current, {
        sitekey: TURNSTILE,
        callback: (t) => {
          turnstileToken = t
          setNeedCaptcha(false)
        },
      })
    document.head.appendChild(s)
  }, [needCaptcha])

  async function send(text) {
    if (busy) return
    const userMsg = { id: uid(), role: 'user', content: text }
    const botId = uid()
    setMessages((m) => [...m.filter((x) => !x.error), userMsg])
    setBusy(true)
    setTyping(true)
    let content = ''
    let realId = botId
    try {
      const r = await authed('/v1/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: convRef.current, message: text }) })
      if (!r.ok || !r.body) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error?.message || cfg.theme.error_message)
      }
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let started = false
      const upsert = (patch) =>
        setMessages((m) => {
          const i = m.findIndex((x) => x.id === botId || x.id === realId)
          if (i === -1) return [...m, { id: realId, role: 'assistant', content: '', ...patch }]
          const n = m.slice()
          n[i] = { ...n[i], ...patch }
          return n
        })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 2)
          if (!line.startsWith('data:')) continue
          let ev
          try {
            ev = JSON.parse(line.slice(5))
          } catch {
            continue
          }
          if (ev.type === 'meta') {
            if (ev.conversation_id) {
              convRef.current = ev.conversation_id
              store.set('conv', ev.conversation_id)
            }
            if (ev.message_id) realId = ev.message_id
          } else if (ev.type === 'delta') {
            content += ev.text
            if (!started) {
              started = true
              setTyping(false)
            }
            upsert({ id: realId, content })
          } else if (ev.type === 'done') {
            // La IA no respondió porque atiende (o se espera a) una persona: solo cambia el estado
            if (!ev.handled || content) upsert({ id: realId, content, final: !ev.notice, sources: ev.sources || [] })
            if (ev.status) setStatus(ev.status)
            // El agente usó la herramienta de finalizar: se cierra el chat y se pide calificación
            if (ev.ended) {
              setEnded(true)
              post({ type: 'zt:ended' })
            }
          } else if (ev.type === 'error') {
            setTyping(false)
            upsert({ id: realId, content: content ? content : ev.message, error: !content })
          }
        }
      }
      if (cfg.theme.sound && !visibleRef.current) beep()
      post({ type: 'zt:message' })
    } catch (e) {
      setMessages((m) => [...m, { id: uid(), role: 'assistant', content: e.message || cfg.theme.error_message, error: true }])
    } finally {
      setTyping(false)
      setBusy(false)
    }
  }

  async function feedback(id, value) {
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, feedback: value } : x)))
    try {
      await authed('/v1/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: convRef.current, message_id: id, value }) })
    } catch {}
  }

  function newConversation() {
    convRef.current = null
    store.set('conv', null)
    setEnded(false)
    setRating(null)
    setStatus('ai_active')
    setAgentName(null)
    setMessages(welcome(cfg))
  }

  /* ---------- bandeja: respuestas de una persona en tiempo real ---------- */
  // Vuelve a pedir el historial (al conectar o reconectar no se pierde nada)
  async function syncHistory() {
    if (!convRef.current) return
    try {
      const h = await authed(`/v1/conversation?id=${encodeURIComponent(convRef.current)}`)
      const j = await h.json()
      const restored = (j.messages || []).map((m) => ({ ...m, final: true }))
      setMessages([...welcome(cfg), ...restored])
      setAgentName(lastAuthor(restored))
      if (j.ended) {
        setEnded(true)
        setRating(j.rating || null)
      } else if (j.status) setStatus(j.status)
    } catch {}
  }
  const withHuman = status === 'waiting_human' || status === 'human_active'
  useEffect(() => {
    if (!cfg || !withHuman || ended || !live || !convRef.current) return
    let ws = null
    let stop = false
    let tries = 0
    let ping = null
    let timer = null
    const open = async () => {
      let t
      try {
        if (tries > 0) token = null // el token pudo vencer
        t = await session()
      } catch {
        if (!stop) timer = setTimeout(open, Math.min(30_000, 2000 * 2 ** tries++))
        return
      }
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/live?c=${encodeURIComponent(convRef.current)}&t=${encodeURIComponent(t)}`
      ws = new WebSocket(url)
      ws.onopen = () => {
        tries = 0
        syncHistory()
        ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25_000)
      }
      ws.onmessage = (e) => {
        if (e.data === 'pong') return
        let ev
        try {
          ev = JSON.parse(e.data)
        } catch {
          return
        }
        if (ev.type === 'message' && ev.message) {
          setMessages((m) => (m.some((x) => x.id === ev.message.id) ? m : [...m, { ...ev.message, final: true }]))
          if (ev.message.sender === 'human') {
            setAgentName(ev.message.author)
            if (cfg.theme.sound && !visibleRef.current) beep()
            post({ type: 'zt:message' })
          }
        } else if (ev.type === 'status') {
          setStatus(ev.status)
          if (ev.agent_name) setAgentName(ev.agent_name)
        } else if (ev.type === 'ended') {
          setEnded(true)
          post({ type: 'zt:ended' })
        }
      }
      ws.onclose = () => {
        clearInterval(ping)
        if (!stop) timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** tries++))
      }
    }
    open()
    return () => {
      stop = true
      clearInterval(ping)
      clearTimeout(timer)
      ws?.close()
    }
  }, [cfg, withHuman, ended, live])

  async function endConversation() {
    setEnded(true)
    post({ type: 'zt:ended' })
    if (!convRef.current) return
    try {
      await authed('/v1/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: convRef.current }) })
    } catch {}
  }

  async function rate(n) {
    setRating(n)
    if (!convRef.current) return
    try {
      await authed('/v1/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: convRef.current, rating: n }) })
    } catch {}
  }

  /* ---------- voz ---------- */
  async function voiceToken() {
    const r = await authed('/v1/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw Object.assign(new Error(j.error?.message || 'No se pudo iniciar la llamada.'), { code: j.error?.code || 'error' })
    return j.token
  }
  const voicePost = (path, callId) =>
    authed(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ call_id: callId }) }).catch(() => {})

  if (fatal) return <div class="zt-fatal">{fatal}</div>
  if (!cfg) return <div class="zt-loading" aria-busy="true" />
  const t = cfg.theme
  const closeFrame = window.parent !== window ? () => post({ type: 'zt:close' }) : null
  // Asistente solo de voz: el widget es directamente la pantalla de llamada
  if (cfg.chat === false || CHAT_OFF) {
    if (!cfg.voice || VOICE_OFF || cfg.suspended) return <div class="zt-fatal">{cfg.suspended ? cfg.suspended_message : 'Este asistente no está disponible por ahora.'}</div>
    return (
      <VoiceCall
        standalone
        theme={t}
        language={cfg.language}
        logoUrl={cfg.logo_url}
        getToken={voiceToken}
        onStarted={(id) => voicePost('/v1/voice/start', id)}
        onEnded={(id) => voicePost('/v1/voice/end', id)}
        onClose={closeFrame}
      />
    )
  }
  return (
    <>
      <ChatPanel
        theme={t}
        language={cfg.language}
        logoUrl={cfg.logo_url}
        messages={cfg.suspended ? [{ id: 's', role: 'assistant', content: cfg.suspended_message }] : messages}
        typing={typing}
        suggested={cfg.suspended ? [] : cfg.suggested}
        onSend={send}
        onClose={window.parent !== window ? () => post({ type: 'zt:close' }) : null}
        onEnd={cfg.suspended ? null : endConversation}
        onNew={newConversation}
        onRate={rate}
        ended={ended}
        rating={rating}
        onFeedback={feedback}
        disabled={busy || cfg.suspended || needCaptcha}
        offline={!cfg.online}
        notice={!cfg.online ? t.offline_message : null}
        privacy={t.privacy_notice ? { text: t.privacy_notice, required: t.privacy_required, accepted, onAccept: () => { store.set('privacy', '1'); setAccepted(true) } } : null}
        onCall={cfg.voice && !VOICE_OFF && !cfg.suspended && cfg.online && !withHuman && !(t.privacy_required && t.privacy_notice && !accepted) ? () => setCalling(true) : null}
        handler={ended || cfg.suspended ? null : status === 'waiting_human' ? (HANDLER[cfg.language] || HANDLER.es).waiting : status === 'human_active' ? (HANDLER[cfg.language] || HANDLER.es).human(agentName) : null}
      />
      {calling && (
        <VoiceCall
          theme={t}
          language={cfg.language}
          logoUrl={cfg.logo_url}
          getToken={voiceToken}
          onStarted={(id) => voicePost('/v1/voice/start', id)}
          onEnded={(id) => voicePost('/v1/voice/end', id)}
          onClose={() => setCalling(false)}
        />
      )}
      {needCaptcha && <div class="zt-captcha" ref={capRef} />}
    </>
  )
}

render(<App />, root)
