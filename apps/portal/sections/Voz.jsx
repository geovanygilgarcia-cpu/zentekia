import { useEffect, useRef, useState } from 'preact/hooks'
import { toast } from '../../shared/toast.jsx'
import { CHAT_ORIGIN } from '../env.js'
import { Field, Loading, PageHead, useAction, useLoad, TestWidget } from './common.jsx'
import { Icon } from './icons.jsx'

const MODELS = [
  ['eleven_flash_v2_5', 'Más rápida', 'Contesta casi al instante. Recomendada para atención.'],
  ['eleven_v4_turbo', 'Más expresiva', 'Entonación más humana; tarda un poco más.'],
]
const EAGER = [
  ['patient', 'Paciente', 'Espera más a que termines de hablar'],
  ['normal', 'Normal', 'Equilibrado'],
  ['eager', 'Rápida', 'Contesta en cuanto haces una pausa'],
]
const GENDER = { female: 'Mujer', male: 'Hombre', neutral: 'Neutral' }

/** Botón para escuchar la muestra de una voz (solo suena una a la vez) */
let playing = null
function Play({ url, label }) {
  const [on, setOn] = useState(false)
  const ref = useRef(null)
  useEffect(() => () => ref.current?.pause(), [])
  if (!url) return null
  const toggle = (e) => {
    e.stopPropagation()
    if (on) {
      ref.current?.pause()
      setOn(false)
      return
    }
    playing?.()
    const a = ref.current || (ref.current = new Audio(url))
    a.currentTime = 0
    a.onended = () => setOn(false)
    a.play().then(() => setOn(true)).catch(() => toast('No se pudo reproducir la muestra'))
    playing = () => {
      a.pause()
      setOn(false)
    }
  }
  return (
    <button type="button" class={'vz-play' + (on ? ' on' : '')} onClick={toggle} aria-label={on ? `Detener ${label}` : `Escuchar ${label}`} title={on ? 'Detener' : 'Escuchar'}>
      {on ? <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg> : <Icon name="play" size={14} />}
    </button>
  )
}

function VoicePicker({ api, value, onPick, disabled }) {
  const [q, setQ] = useState('')
  const [gender, setGender] = useState('')
  const { data, error } = useLoad(() => api.get('voice/voices'), [])
  if (!data) return <Loading error={error} />
  const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const count = (g) => data.voices.filter((v) => v.gender === g).length
  const list = data.voices
    .filter((v) => !gender || v.gender === gender)
    .filter((v) => !q || norm(`${v.name} ${v.description}`).includes(norm(q)))
  const d = data.diag
  return (
    <div>
      <div class="vz-tools">
        <label class="ag-search vz-search">
          <Icon name="search" size={16} />
          <input type="search" placeholder="Buscar voz (nombre o estilo)…" value={q} onInput={(e) => setQ(e.target.value)} aria-label="Buscar voz" />
        </label>
        <div class="ag-chips" role="group" aria-label="Filtrar por género">
          <button type="button" aria-pressed={!gender} onClick={() => setGender('')}>Todas<span class="ag-n">{data.voices.length}</span></button>
          <button type="button" aria-pressed={gender === 'female'} onClick={() => setGender(gender === 'female' ? '' : 'female')}>Mujer<span class="ag-n">{count('female')}</span></button>
          <button type="button" aria-pressed={gender === 'male'} onClick={() => setGender(gender === 'male' ? '' : 'male')}>Hombre<span class="ag-n">{count('male')}</span></button>
        </div>
      </div>
      {data.voices.length === 0 ? (
        <div class="alert alert-warn">
          No encontramos voces mexicanas en la biblioteca de ElevenLabs.
          {d && (
            <div class="small" style="margin-top:6px">
              {d.failed > 0 ? `Fallaron ${d.failed} de ${d.queries} búsquedas: ${d.errors[0]}` : `Se revisaron ${d.raw} voces; ${d.mexican} con acento mexicano${d.paid_skipped ? ` (${d.paid_skipped} con cobro extra se ocultaron)` : ''}.`}
            </div>
          )}
        </div>
      ) : list.length === 0 ? (
        <div class="empty">No hay voces con esos filtros.</div>
      ) : (
        <div class="vz-scroll">
        <div class="vz-grid" role="radiogroup" aria-label="Voces">
          {list.map((v) => (
            <div
              key={v.voice_id}
              role="radio"
              tabIndex={disabled ? -1 : 0}
              aria-checked={value === v.voice_id}
              class={'vz-voice' + (value === v.voice_id ? ' on' : '') + (disabled ? ' dis' : '')}
              onClick={() => !disabled && onPick(v)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !disabled && (e.preventDefault(), onPick(v))}
            >
              <span class="vz-av" aria-hidden="true">{v.name.charAt(0)}</span>
              <span class="vz-info">
                <b>{v.name}</b>
                <span>{[GENDER[v.gender] || null, v.description].filter(Boolean).join(' · ') || 'Mexicana'}</span>
              </span>
              <Play url={v.preview_url} label={v.name} />
              {value === v.voice_id && <span class="vz-check"><Icon name="check" size={14} /></span>}
            </div>
          ))}
        </div>
        </div>
      )}
    </div>
  )
}

export default function Voz({ api, agent, agentId, me, readOnly, reload }) {
  const chatOn = agent.channels?.chat !== 'off'
  const { data, error, reload: reloadVoice } = useLoad(() => api.get(`voice?agent=${agentId}`), [agentId])
  const [f, setF] = useState(null)
  const [testing, setTesting] = useState(false)
  const [busy, run] = useAction()
  const owner = me.user.role === 'owner' && !readOnly
  useEffect(() => {
    if (data) setF({ ...data.config })
  }, [data])
  if (!data || !f) return <Loading error={error} />
  const c = data.config
  const set = (k, v) => setF({ ...f, [k]: v })
  const dirty = JSON.stringify({ ...f, library_owner_id: undefined }) !== JSON.stringify({ ...c })

  const save = async (enabled) => {
    const body = { enabled, voice_id: f.voice_id || undefined, voice_name: f.voice_name || undefined, model: f.model, speed: Number(f.speed), eagerness: f.eagerness, first_message: f.first_message, library_owner_id: f.library_owner_id || undefined }
    const r = await run(() => api.put(`voice/${agentId}`, body), enabled ? (c.ready ? 'Voz actualizada' : '¡Voz activada! Tu widget ya muestra el botón Llamar') : 'Voz desactivada')
    if (r) {
      reloadVoice()
      reload()
    }
  }

  return (
    <>
      <PageHead title="Canal de Voz" sub={`Tus visitantes hablan con «${agent.name}» desde el widget, con voz natural y respuestas al instante.`}>
        {c.ready && (
          <button class="b b-outline b-sm" onClick={() => setTesting(true)}><Icon name="voz" size={15} />Probar llamada</button>
        )}
      </PageHead>

      <div class={'card vz-status' + (c.ready ? ' on' : '')}>
        <span class="vz-status-ic"><Icon name="voz" size={24} /></span>
        <div class="grow">
          <div class="card-title">{c.ready ? 'La voz está activa' : 'La voz está apagada'}</div>
          <div class="small muted" style="margin-top:3px">
            {c.ready
              ? chatOn
                ? `Tu widget muestra el chat con el botón «Llamar». Voz: ${c.voice_name || 'elegida'}.`
                : `Tu widget es solo de voz: una burbuja de teléfono que abre la llamada. Voz: ${c.voice_name || 'elegida'}.`
              : chatOn
                ? 'Elige una voz abajo y actívala. El botón «Llamar» aparece en tu widget al momento, sin reinstalar nada.'
                : 'El chat de este asistente está apagado: si activas la voz, tu widget será solo de voz.'}
          </div>
          {c.sync_error && <div class="alert alert-warn" style="margin-top:10px">{c.sync_error}</div>}
        </div>
        {owner && (c.ready ? (
          <button class="b b-outline" onClick={() => confirm('¿Apagar la voz? El botón «Llamar» desaparece del widget.') && save(false)} disabled={busy}>Apagar</button>
        ) : (
          <button class="b b-primary" onClick={() => save(true)} disabled={busy || !f.voice_id}>{busy ? 'Activando…' : 'Activar voz'}</button>
        ))}
      </div>

      <div class="vz-cols">
        <div class="card vz-voices">
          <div class="card-title">1. Elige la voz 🇲🇽</div>
          <div class="small muted" style="margin:3px 0 14px">Voces con acento mexicano. Toca ▶ para escucharla; al activarla se agrega sola a tu cuenta de ElevenLabs.</div>
          <VoicePicker api={api} value={f.voice_id} disabled={!owner} onPick={(v) => setF({ ...f, voice_id: v.voice_id, voice_name: v.name, library_owner_id: v.owner_id && !v.in_account ? v.owner_id : undefined })} />
        </div>

        <div class="vz-side">
          <div class="card">
            <div class="card-title">2. Cómo habla</div>
            <div class="l">Calidad de la voz</div>
            <div class="vz-opts">
              {MODELS.map(([id, t, d]) => (
                <button key={id} type="button" class={'opt' + (f.model === id ? ' on' : '')} onClick={() => owner && set('model', id)} disabled={!owner}>
                  <div class="t">{t}</div>
                  <div class="d">{d}</div>
                </button>
              ))}
            </div>
            <Field label={`Velocidad al hablar: ${Number(f.speed).toFixed(2)}×`} hint="1.00 es normal. Más bajo para gente mayor; más alto para ir al grano.">
              <input type="range" min="0.7" max="1.2" step="0.05" value={f.speed} onInput={(e) => set('speed', Number(e.target.value))} disabled={!owner} style="width:100%" />
            </Field>
            <div class="l">Rapidez para contestar</div>
            <div class="acc-seg" role="group" aria-label="Rapidez para contestar">
              {EAGER.map(([id, t, d]) => (
                <button key={id} type="button" aria-pressed={f.eagerness === id} onClick={() => owner && set('eagerness', id)} title={d} disabled={!owner}>{t}</button>
              ))}
            </div>
            <Field label="Saludo al contestar" hint="Lo primero que dice. Si lo dejas vacío usa el mensaje de bienvenida del chat.">
              <textarea rows="2" maxLength={400} value={f.first_message} placeholder={data.welcome} onInput={(e) => set('first_message', e.target.value)} disabled={!owner} />
            </Field>
            {owner && c.ready && (
              <button class="b b-primary" style="margin-top:16px" onClick={() => save(true)} disabled={busy || !dirty}>Guardar cambios</button>
            )}
          </div>
          <div class="card vz-info-card">
            <div class="card-title">Bueno saber</div>
            <ul>
              <li>Usa las mismas <b>instrucciones</b> y la misma <b>base de conocimiento</b> que tu chat. Si las cambias, la voz se actualiza sola.</li>
              <li>Cada llamada queda en <b>Conversaciones</b> con su transcripción.</li>
              <li>Se cobra por minuto: <b>${data.price_per_min.toFixed(2)} USD</b>, visible en Consumo y costos.</li>
              <li>El visitante necesita dar permiso de micrófono en su navegador.</li>
              <li>¿Solo voz, sin chat? Apaga el chat en <a href={`#/a/${agentId}/resumen`}>Resumen → Canales en tu sitio</a>. Es el mismo código de instalación.</li>
            </ul>
          </div>
        </div>
      </div>

      {testing && <TestWidget widgetKey={agent.widget_key} title="Probar llamada" onClose={() => setTesting(false)} />}
    </>
  )
}
