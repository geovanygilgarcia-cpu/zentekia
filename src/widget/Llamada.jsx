import React, { useEffect, useRef, useState } from 'react'
import { turnoDeVoz, decirTexto } from './api.js'

/*
  Modo llamada (manos libres)
  - El agente saluda en voz alta.
  - El micrófono detecta solo cuándo empiezas y terminas de hablar (no hay que apretar nada).
  - Cada turno: tu audio → Worker (Whisper → Qwen → MeloTTS) → la respuesta se reproduce.
  - Si el agente decide colgar o transferir, la llamada termina sola.
*/

const ESTADOS = {
  conectando: 'Conectando…',
  hablando: 'Hablando',
  escuchando: 'Te escucho',
  grabando: 'Te escucho',
  pensando: 'Pensando…',
  terminada: 'Llamada terminada',
}

// "Buenos días" según la hora del visitante
function segunHora(t) {
  const h = new Date().getHours()
  const saludo = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'
  return t.replace(/^Buen(os d[ií]as|as tardes|as noches)/, saludo)
}

const SILENCIO_FIN_MS = 900 // silencio después de hablar para cerrar tu turno
const SIN_VOZ_MS = 8000 // si no dices nada en este tiempo, cuenta como silencio
const MAX_TURNO_MS = 20000
const MAX_LLAMADA_MS = 5 * 60 * 1000

export default function Llamada({ config, conversationId, historialInicial, onMensaje, onSalir }) {
  const [estado, setEstado] = useState('conectando')
  const [segundos, setSegundos] = useState(0)
  const [nivel, setNivel] = useState(0)
  const [silenciado, setSilenciado] = useState(false)
  const [lineas, setLineas] = useState([])
  const [error, setError] = useState(null)
  const [fin, setFin] = useState(null) // { motivo: 'hangup' | 'transfer' | 'usuario' | 'error' }

  const vivo = useRef(true)
  const r = useRef({}) // recursos: stream, ctx, analyser, recorder, audio, abort, historial, timers
  const silenciadoRef = useRef(false)
  silenciadoRef.current = silenciado

  const decir = (role, content) => {
    setLineas((l) => [...l.slice(-5), { role, content }])
    r.current.historial.push({ role, content })
    onMensaje(role, content)
  }

  /* ---------- arranque y limpieza ---------- */
  useEffect(() => {
    vivo.current = true
    r.current.historial = [...historialInicial]
    const inicio = Date.now()
    const reloj = setInterval(() => {
      const s = Math.floor((Date.now() - inicio) / 1000)
      setSegundos(s)
      if (s * 1000 > MAX_LLAMADA_MS) terminar('usuario')
    }, 500)
    iniciar()
    return () => {
      vivo.current = false
      clearInterval(reloj)
      liberar()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function iniciar() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (!vivo.current) return stream.getTracks().forEach((t) => t.stop())
      const AC = window.AudioContext || window.webkitAudioContext
      const ctx = new AC()
      const fuente = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      fuente.connect(analyser)
      Object.assign(r.current, { stream, ctx, analyser, audio: new Audio() })

      // Saludo del agente
      const saludo = segunHora(config.voiceGreeting || config.greeting.replace(/\*\*/g, ''))
      decir('assistant', saludo)
      let audio = null
      try {
        audio = (await decirTexto({ apiUrl: config.apiUrl, text: saludo })).audio
      } catch (e) {
        console.warn('Saludo sin voz:', e.message)
      }
      if (!vivo.current) return
      await reproducir(audio, saludo)
      escuchar()
    } catch (e) {
      console.error(e)
      setError(
        e.name === 'NotAllowedError' || e.name === 'SecurityError'
          ? 'Necesito permiso para usar el micrófono. Actívalo en la barra de direcciones y vuelve a llamar.'
          : e.name === 'NotFoundError'
          ? 'No encontré un micrófono en este dispositivo.'
          : 'No pude iniciar la llamada. Intenta de nuevo.'
      )
      terminar('error')
    }
  }

  function liberar() {
    const x = r.current
    x.abort?.abort()
    clearTimeout(x.timerTurno)
    cancelAnimationFrame(x.raf)
    try { x.recorder?.state === 'recording' && x.recorder.stop() } catch { /* nada */ }
    x.stream?.getTracks().forEach((t) => t.stop())
    x.ctx?.close?.().catch(() => {})
    if (x.audio) { x.audio.pause(); x.audio.src = '' }
    window.speechSynthesis?.cancel?.()
  }

  function terminar(motivo) {
    if (!vivo.current) return
    vivo.current = false // detiene escucha, envíos y reproducción pendientes
    setFin({ motivo })
    setEstado('terminada')
    setNivel(0)
    liberar()
  }

  /* ---------- reproducir la voz del agente ---------- */
  function reproducir(base64, texto) {
    return new Promise((listo) => {
      if (!vivo.current) return listo()
      setEstado('hablando')
      const x = r.current
      if (base64) {
        let hecho = false
        const fin = () => { if (!hecho) { hecho = true; clearTimeout(x.timerAudio); listo() } }
        x.audio.src = 'data:audio/mpeg;base64,' + base64
        x.audio.onended = fin
        x.audio.onerror = fin
        x.timerAudio = setTimeout(fin, 45000)
        x.audio.play().catch(() => { if (!hecho) { hecho = true; clearTimeout(x.timerAudio); vozDelNavegador(texto, listo) } })
      } else {
        vozDelNavegador(texto, listo)
      }
    })
  }

  // Respaldo si el servidor no mandó audio: voz del propio navegador
  function vozDelNavegador(texto, listo) {
    const ss = window.speechSynthesis
    if (!ss || !texto) return listo()
    let hecho = false
    const fin = () => { if (!hecho) { hecho = true; listo() } }
    const u = new SpeechSynthesisUtterance(texto)
    u.lang = 'es-MX'
    u.onend = fin
    u.onerror = fin
    ss.speak(u)
    // Algunos navegadores nunca avisan que terminaron: se continúa después de un tiempo razonable
    setTimeout(fin, Math.max(2500, texto.length * 75))
  }

  /* ---------- escuchar un turno con detección de voz ---------- */
  function escuchar() {
    if (!vivo.current) return
    const x = r.current
    setEstado('escuchando')
    const tipo = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || ''
    const recorder = new MediaRecorder(x.stream, tipo ? { mimeType: tipo } : undefined)
    const partes = []
    recorder.ondataavailable = (e) => e.data.size && partes.push(e.data)
    x.recorder = recorder

    const datos = new Float32Array(x.analyser.fftSize)
    const inicio = performance.now()
    let piso = 0.01
    let calibrando = true
    let hablo = false
    let ultimoSonido = 0
    let primerSonido = 0

    recorder.onstop = () => {
      cancelAnimationFrame(x.raf)
      setNivel(0)
      if (!vivo.current) return
      const blob = hablo ? new Blob(partes, { type: recorder.mimeType || tipo || 'audio/webm' }) : null
      enviar(blob)
    }
    recorder.start(250)

    const medir = () => {
      if (!vivo.current || recorder.state !== 'recording') return
      x.analyser.getFloatTimeDomainData(datos)
      let suma = 0
      for (let i = 0; i < datos.length; i++) suma += datos[i] * datos[i]
      const rms = Math.sqrt(suma / datos.length)
      const ahora = performance.now()
      const t = ahora - inicio

      if (calibrando) {
        piso = piso * 0.8 + rms * 0.2
        if (t > 300) calibrando = false
      }
      const umbral = Math.max(0.018, piso * 3)
      const fuerte = !silenciadoRef.current && rms > umbral
      setNivel(silenciadoRef.current ? 0 : Math.min(1, rms / (umbral * 3)))

      if (fuerte) {
        if (!primerSonido) primerSonido = ahora
        if (!hablo && ahora - primerSonido > 150) {
          hablo = true
          setEstado('grabando')
        }
        ultimoSonido = ahora
      } else if (!hablo) {
        primerSonido = 0
      }

      const terminoDeHablar = hablo && ahora - ultimoSonido > SILENCIO_FIN_MS
      const nadaQueDecir = !hablo && t > SIN_VOZ_MS
      const muyLargo = t > MAX_TURNO_MS
      if (terminoDeHablar || nadaQueDecir || muyLargo) {
        recorder.stop()
        return
      }
      x.raf = requestAnimationFrame(medir)
    }
    x.raf = requestAnimationFrame(medir)
  }

  async function enviar(blob) {
    if (!vivo.current) return
    setEstado('pensando')
    const x = r.current
    x.abort = new AbortController()
    try {
      const res = await turnoDeVoz({
        apiUrl: config.apiUrl,
        agent: config.voiceAgent,
        conversationId,
        messages: x.historial,
        audio: blob,
        signal: x.abort.signal,
      })
      if (!vivo.current) return
      decir('user', res.transcript || '[silencio]')
      if (res.reply) decir('assistant', res.reply)
      await reproducir(res.audio, res.reply)
      if (!vivo.current) return
      if (res.action) terminar(res.action)
      else escuchar()
    } catch (e) {
      if (e.name === 'AbortError' || !vivo.current) return
      setError(e.message)
      // Un error de red no corta la llamada: se vuelve a escuchar
      setTimeout(() => { if (vivo.current) { setError(null); escuchar() } }, 2500)
    }
  }

  /* ---------- interfaz ---------- */
  const mmss = `${String(Math.floor(segundos / 60)).padStart(2, '0')}:${String(segundos % 60).padStart(2, '0')}`
  const terminada = estado === 'terminada'
  const textoFin = {
    transfer: 'Te transfirió con un asesor. En la versión real aquí entra una persona de tu equipo.',
    hangup: 'El agente terminó la llamada.',
    usuario: 'Colgaste la llamada.',
    error: 'La llamada no pudo continuar.',
  }

  return (
    <div className={`zw-call is-${estado}`} style={{ '--zw-level': nivel }}>
      <div className="zw-call-stage">
        <div className="zw-call-orb" aria-hidden="true">
          <span className="zw-call-ring" />
          <span className="zw-call-ring zw-call-ring-2" />
          <span className="zw-call-avatar">{config.name.slice(0, 1)}</span>
        </div>
        <strong className="zw-call-name">{config.name}</strong>
        <span className="zw-call-company">{config.company}</span>
        <span className="zw-call-status" aria-live="polite">
          {terminada ? textoFin[fin?.motivo] || ESTADOS.terminada : silenciado && estado.startsWith('escuch') ? 'Micrófono silenciado' : ESTADOS[estado]}
        </span>
        <span className="zw-call-time">{mmss}</span>
      </div>

      <div className="zw-call-lines" aria-label="Transcripción">
        {lineas.map((l, i) => (
          <p key={i} className={`zw-call-line zw-call-${l.role}`}>
            <b>{l.role === 'user' ? 'Tú' : config.name}</b> {l.content === '[silencio]' ? <em>(sin respuesta)</em> : l.content}
          </p>
        ))}
      </div>

      {error && <p className="zw-call-error" role="alert">{error}</p>}

      <div className="zw-call-actions">
        {terminada ? (
          <>
            <button className="zw-call-btn" onClick={onSalir}>Volver al chat</button>
          </>
        ) : (
          <>
            <button
              className={'zw-call-btn zw-call-mute' + (silenciado ? ' is-on' : '')}
              onClick={() => setSilenciado((s) => !s)}
              aria-pressed={silenciado}
            >
              {silenciado ? 'Activar micrófono' : 'Silenciar'}
            </button>
            <button className="zw-call-btn zw-call-hang" onClick={() => terminar('usuario')} aria-label="Colgar">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.6 14.2c4.8-4.3 12-4.3 16.8 0 .5.5.6 1.3.1 1.8l-1.6 1.7c-.4.4-1.1.5-1.6.2l-2.2-1.3c-.4-.3-.6-.8-.5-1.3l.3-1.4a11 11 0 0 0-5.8 0l.3 1.4c.1.5-.1 1-.5 1.3l-2.2 1.3c-.5.3-1.2.2-1.6-.2L3.5 16c-.5-.5-.4-1.3.1-1.8z" /></svg>
              Colgar
            </button>
          </>
        )}
      </div>
    </div>
  )
}
