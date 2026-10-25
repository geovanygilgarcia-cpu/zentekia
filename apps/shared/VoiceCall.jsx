import { useEffect, useRef, useState } from 'preact/hooks'
import { themeVars } from './ChatPanel.jsx'

const T = {
  es: {
    connecting: 'Conectando…', listening: 'Te escucho…', speaking: 'Hablando…', muted: 'Micrófono silenciado',
    mute: 'Silenciar', unmute: 'Activar micrófono', hang: 'Colgar', ended: 'Llamada terminada', back: 'Volver al chat', again: 'Llamar otra vez',
    micDenied: 'Necesitamos permiso para usar tu micrófono. Actívalo en tu navegador e intenta de nuevo.',
    failed: 'No se pudo conectar la llamada. Intenta de nuevo o escríbenos por chat.', tip: 'Habla con naturalidad; puedes interrumpir cuando quieras.',
    you: 'Tú', call: 'Llamar', idle: 'Habla con nosotros por voz desde aquí, sin marcar a ningún teléfono.', close: 'Cerrar',
  },
  en: {
    connecting: 'Connecting…', listening: 'Listening…', speaking: 'Speaking…', muted: 'Microphone muted',
    mute: 'Mute', unmute: 'Unmute', hang: 'Hang up', ended: 'Call ended', back: 'Back to chat', again: 'Call again',
    micDenied: 'We need permission to use your microphone. Allow it in your browser and try again.',
    failed: "We couldn't connect the call. Try again or message us.", tip: 'Speak naturally; you can interrupt anytime.',
    you: 'You', call: 'Call', idle: 'Talk to us by voice right here, no phone call needed.', close: 'Close',
  },
  pt: {
    connecting: 'Conectando…', listening: 'Ouvindo…', speaking: 'Falando…', muted: 'Microfone silenciado',
    mute: 'Silenciar', unmute: 'Ativar microfone', hang: 'Desligar', ended: 'Chamada encerrada', back: 'Voltar ao chat', again: 'Ligar de novo',
    micDenied: 'Precisamos de permissão para usar seu microfone. Ative no navegador e tente de novo.',
    failed: 'Não foi possível conectar a chamada. Tente de novo ou escreva no chat.', tip: 'Fale naturalmente; você pode interromper quando quiser.',
    you: 'Você', call: 'Ligar', idle: 'Fale com a gente por voz daqui mesmo, sem ligar para nenhum telefone.', close: 'Fechar',
  },
}

let loader = null
/** Carga el cliente de voz solo cuando hace falta */
function loadVoice() {
  if (window.ZentekiaVoice) return Promise.resolve(window.ZentekiaVoice)
  if (!loader) {
    loader = new Promise((ok, bad) => {
      const s = document.createElement('script')
      s.src = '/assets/voice.js'
      s.async = true
      s.onload = () => (window.ZentekiaVoice ? ok(window.ZentekiaVoice) : bad(new Error('voice')))
      s.onerror = () => {
        loader = null
        bad(new Error('voice'))
      }
      document.head.appendChild(s)
    })
  }
  return loader
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

const I = {
  mic: <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />,
  micOff: <path d="M4 4l16 16M9 9v3a3 3 0 0 0 5.1 2.1M15 9.4V6a3 3 0 0 0-5.7-1.3M5.5 11a6.5 6.5 0 0 0 10.6 5.1M18.5 11c0 .9-.2 1.8-.5 2.6M12 17.5V21" />,
  hang: <path d="M3.5 14.5c4.8-4.6 12.2-4.6 17 0l-2 2.6-3.4-1.4v-2.4c-2-.7-4.2-.7-6.2 0v2.4L5.5 17.1z" />,
  phone: <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />,
}
const Ico = ({ d, size = 24 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{d}</svg>
)

/**
 * Pantalla de llamada dentro del widget.
 * getToken(): Promise<string> · onStarted(callId) · onEnded(callId) · onClose()
 */
export default function VoiceCall({ theme, language = 'es', logoUrl, getToken, onStarted, onEnded, onClose, standalone = false }) {
  const t = T[language] || T.es
  // standalone (widget solo de voz): empieza en 'idle' y la llamada inicia al tocar «Llamar»
  const [state, setState] = useState(standalone ? 'idle' : 'connecting') // idle | connecting | live | ended | error
  const [mode, setMode] = useState('listening')
  const [muted, setMuted] = useState(false)
  const [lines, setLines] = useState([])
  const [secs, setSecs] = useState(0)
  const [err, setErr] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const callRef = useRef(null)
  const orbRef = useRef(null)
  const ringRef = useRef(null)
  const endedRef = useRef(false)
  const finishRef = useRef(null)
  const initial = (theme.assistant_name || '?').trim().charAt(0).toUpperCase()

  useEffect(() => {
    let alive = true
    let raf = 0
    let timer = 0
    if (standalone && attempt === 0) return
    endedRef.current = false
    callRef.current = null
    setState('connecting')
    setLines([])
    setSecs(0)
    setErr(null)
    setMuted(false)

    const finish = () => {
      if (endedRef.current) return
      endedRef.current = true
      cancelAnimationFrame(raf)
      clearInterval(timer)
      if (alive) setState((s) => (s === 'error' ? s : 'ended'))
      if (callRef.current?.id) onEnded?.(callRef.current.id)
    }
    finishRef.current = finish

    ;(async () => {
      try {
        // Primero el permiso del micrófono (así el error es claro si lo niegan)
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((x) => x.stop())
        const [Voice, token] = await Promise.all([loadVoice(), getToken()])
        if (!alive) return
        const call = await Voice.start({
          token,
          onMode: (m) => alive && setMode(m),
          onMessage: (m) => {
            if (!alive || !m.text) return
            setLines((ls) => [...ls.slice(-5), { role: m.role, text: m.text, k: Math.random() }])
          },
          onEnd: () => finish(),
          onError: (e) => console.warn('voice', e),
        })
        if (!alive) {
          call.end()
          return
        }
        callRef.current = call
        setState('live')
        onStarted?.(call.id)
        const t0 = Date.now()
        timer = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000)
        // Animación del orbe con el volumen (sin re-render)
        const loop = () => {
          const lv = call.levels()
          const out = Math.min(1, lv.output * 1.6)
          const inp = Math.min(1, lv.input * 1.6)
          if (orbRef.current) orbRef.current.style.transform = `scale(${1 + out * 0.22})`
          if (ringRef.current) ringRef.current.style.transform = `scale(${1 + Math.max(out, inp) * 0.55})`
          raf = requestAnimationFrame(loop)
        }
        raf = requestAnimationFrame(loop)
      } catch (e) {
        if (!alive) return
        const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'NotFoundError')
        setErr(denied ? t.micDenied : e?.message && e.code ? e.message : t.failed)
        setState('error')
      }
    })()

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      clearInterval(timer)
      if (callRef.current && !endedRef.current) {
        callRef.current.end().catch(() => {})
        finish()
      }
    }
  }, [attempt])

  const hang = async () => {
    try {
      await callRef.current?.end()
    } catch {}
    finishRef.current?.()
  }
  const toggleMute = () => {
    const m = !muted
    callRef.current?.mute(m)
    setMuted(m)
  }

  const last = lines[lines.length - 1]
  const status = state === 'connecting' ? t.connecting : muted ? t.muted : mode === 'speaking' ? t.speaking : t.listening

  return (
    <section class={'zw zv' + (theme.appearance === 'claro' ? ' zw-light' : '')} style={themeVars(theme)} aria-label={theme.assistant_name} role="dialog" aria-modal="true">
      <div class="zv-top zw-mono">
        <span class={'zv-live' + (state === 'live' ? ' on' : '')} />
        {state === 'live' ? mmss(secs) : state === 'ended' ? t.ended : state === 'error' || state === 'idle' ? '' : t.connecting}
      </div>

      {standalone && onClose && state !== 'live' && state !== 'connecting' && (
        <button type="button" class="zw-icon zv-x" onClick={onClose} aria-label={t.close} title={t.close}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3 12 10.6l5.3-5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4l5.3-5.3-5.3-5.3a1 1 0 0 1 1.4-1.4z" /></svg>
        </button>
      )}
      <div class={'zv-stage ' + (state === 'live' ? mode : state)}>
        <div class="zv-ring" ref={ringRef} />
        <div class="zv-ring zv-ring-2" />
        <div class="zv-orb" ref={orbRef}>
          {logoUrl ? <img src={logoUrl} alt="" /> : <span>{initial}</span>}
        </div>
      </div>

      <div class="zv-name">{theme.assistant_name}</div>
      <div class="zv-status" role="status" aria-live="polite">{state === 'ended' ? `${t.ended} · ${mmss(secs)}` : state === 'error' ? '' : state === 'idle' ? t.idle : status}</div>

      {state === 'error' && <div class="zv-err">{err}</div>}

      {state === 'live' && (
        <div class="zv-caption" aria-live="polite">
          {last ? (
            <p key={last.k} class={last.role === 'user' ? 'u' : 'a'}>
              {last.role === 'user' && <b>{t.you}: </b>}
              {last.text}
            </p>
          ) : (
            <p class="tip">{t.tip}</p>
          )}
        </div>
      )}

      <div class="zv-actions">
        {state === 'idle' ? (
          <button type="button" class="zv-btn zv-start" onClick={() => setAttempt(attempt + 1)} aria-label={t.call}>
            <Ico d={I.phone} size={28} />
            <span>{t.call}</span>
          </button>
        ) : state === 'live' || state === 'connecting' ? (
          <>
            <button type="button" class={'zv-btn' + (muted ? ' on' : '')} onClick={toggleMute} disabled={state !== 'live'} aria-pressed={muted} aria-label={muted ? t.unmute : t.mute}>
              <Ico d={muted ? I.micOff : I.mic} />
              <span>{muted ? t.unmute : t.mute}</span>
            </button>
            <button type="button" class="zv-btn zv-hang" onClick={state === 'live' ? hang : standalone ? () => { setAttempt(0); setState('idle') } : onClose} aria-label={t.hang}>
              <Ico d={I.hang} size={28} />
              <span>{t.hang}</span>
            </button>
          </>
        ) : (
          <>
            {onClose && <button type="button" class="zw-btn zw-btn-ghost" onClick={onClose}>{standalone ? t.close : t.back}</button>}
            <button type="button" class="zw-btn zw-btn-primary" onClick={() => setAttempt(attempt + 1)}>{t.again}</button>
          </>
        )}
      </div>
    </section>
  )
}
