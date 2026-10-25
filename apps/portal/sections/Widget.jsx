import { useEffect, useRef, useState } from 'preact/hooks'
import ChatPanel from '../../shared/ChatPanel.jsx'
import { toastError } from '../../shared/toast.jsx'
import { Field, Loading, PageHead, fileToDataUrl, useAction, useLoad } from './common.jsx'

const SWATCHES = [
  ['#2F6BFF', 'Azul Zentekia'],
  ['#0E7C86', 'Verde azulado'],
  ['#1D4ED8', 'Azul'],
  ['#6D28D9', 'Violeta'],
  ['#C2410C', 'Naranja'],
  ['#334155', 'Grafito'],
]
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

function darken(hex, f = 0.82) {
  const n = parseInt(hex.slice(1), 16)
  const c = (s) => Math.round(((n >> s) & 255) * f).toString(16).padStart(2, '0')
  return `#${c(16)}${c(8)}${c(0)}`.toUpperCase()
}

/** Vista previa con las mismas piezas del widget real */
export function WidgetPreview({ theme, welcome, suggested, logoUrl, host = 'tusitio.com' }) {
  const side = theme.position === 'left' ? 'left' : 'right'
  const size = theme.button_size || 56
  const msgs = [...(welcome ? [{ id: 'w', role: 'assistant', content: welcome }] : []), { id: 'u', role: 'user', content: suggested?.[0] || '¿Cuál es su horario?' }]
  return (
    <div class="browser" aria-label="Vista previa del widget">
      <div class="bar-url">{host}</div>
      <div class="ph">
        <div />
        <div style="width:85%" />
        <div style="width:70%" />
      </div>
      <div class="pv" style={`${side}:20px;bottom:${size + 30}px`}>
        <ChatPanel theme={theme} logoUrl={logoUrl} messages={msgs} suggested={[]} preview onClose={() => {}} onEnd={() => {}} privacy={theme.privacy_notice ? { text: theme.privacy_notice, required: false } : null} />
      </div>
      <div class="bubble" style={`${side}:20px;bottom:18px;width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.32)}px;background:linear-gradient(135deg, ${theme.primary}, ${darken(theme.primary, 0.62)});box-shadow:0 10px 30px -8px ${theme.primary}`} aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z" /></svg>
      </div>
    </div>
  )
}

export function WidgetEditor({ api, agentId, readOnly, compact, onSaved }) {
  const { data, error, reload } = useLoad(() => api.get(`widget?agent=${agentId}`), [agentId])
  const [t, setT] = useState(null)
  const [welcome, setWelcome] = useState('')
  const [busy, run] = useAction()
  const fileRef = useRef(null)
  useEffect(() => {
    if (data) {
      setT({ ...data.theme })
      setWelcome(data.welcome)
    }
  }, [data])
  if (!t) return <Loading error={error} />
  const set = (k, v) => setT((x) => ({ ...x, [k]: v }))
  const inp = (k) => (e) => set(k, e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' || e.target.type === 'range' ? Number(e.target.value) : e.target.value)
  const pickColor = (c) => setT((x) => ({ ...x, primary: c, secondary: darken(c), user_bubble: c }))
  const dirty = JSON.stringify(t) !== JSON.stringify(data.theme) || welcome !== data.welcome

  const save = async (e) => {
    e?.preventDefault()
    const { logo_version, ...theme } = t
    const r = await run(async () => {
      await api.put(`widget/${data.id}`, theme)
      if (welcome !== data.welcome) await api.put(`agents/${agentId}`, { welcome_message: welcome })
      return true
    }, 'Widget guardado: tu sitio lo verá en menos de un minuto')
    if (r) {
      reload()
      onSaved?.()
    }
  }
  const uploadLogo = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > 300_000) return toastError(new Error('El logo pesa más de 300 KB.'))
    try {
      const data_url = await fileToDataUrl(f)
      await run(() => api.post(`widget/${data.id}/logo`, { data_url }), 'Logo actualizado')
      reload()
    } finally {
      e.target.value = ''
    }
  }

  return (
    <div class="cols">
      <form class="col-form" onSubmit={save}>
        <fieldset disabled={readOnly} style="border:0;padding:0;margin:0">
          <div class="l" style="margin-top:0">
            Apariencia
            <div class="seg" style="margin-top:8px;display:flex">
              <button type="button" class={'b' + (t.appearance !== 'claro' ? ' on' : '')} onClick={() => set('appearance', 'oscuro')} aria-pressed={t.appearance !== 'claro'}>Oscuro · Zentekia</button>
              <button type="button" class={'b' + (t.appearance === 'claro' ? ' on' : '')} onClick={() => set('appearance', 'claro')} aria-pressed={t.appearance === 'claro'}>Claro</button>
            </div>
          </div>
          <Field label="Nombre del asistente">
            <input value={t.assistant_name} onInput={inp('assistant_name')} maxLength={60} required />
          </Field>
          <div class="l">
            Color principal
            <div class="swatches">
              {SWATCHES.map(([c, label]) => (
                <button key={c} type="button" class={'sw' + (t.primary.toUpperCase() === c ? ' on' : '')} style={`background:${c}`} aria-label={label} aria-pressed={t.primary.toUpperCase() === c} onClick={() => pickColor(c)} />
              ))}
              <label class={'sw sw-custom' + (SWATCHES.some(([c]) => c === t.primary.toUpperCase()) ? '' : ' on')} title="Otro color" style={SWATCHES.some(([c]) => c === t.primary.toUpperCase()) ? '' : `background:${t.primary}`}>
                <input type="color" value={t.primary} onInput={(e) => pickColor(e.target.value.toUpperCase())} aria-label="Otro color" />
              </label>
            </div>
          </div>
          <div class="l">
            Logo
            <div class="row" style="margin-top:8px">
              <button type="button" class="b b-dashed" onClick={() => fileRef.current?.click()}>{data.has_logo ? 'Cambiar logo' : 'Subir logo'}</button>
              {data.has_logo && !readOnly && (
                <button type="button" class="link link-danger" onClick={() => run(() => api.del(`widget/${data.id}/logo`), 'Logo quitado').then(reload)}>Quitar</button>
              )}
              <span class="small muted" style="font-weight:400">PNG, JPG o SVG, máx. 300 KB</span>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={uploadLogo} />
            </div>
          </div>
          <Field label="Mensaje de bienvenida">
            <textarea rows="3" value={welcome} onInput={(e) => setWelcome(e.target.value)} maxLength={600} />
          </Field>
          <div class="l">
            Posición
            <div class="seg" style="margin-top:8px;display:flex">
              <button type="button" class={'b' + (t.position !== 'left' ? ' on' : '')} onClick={() => set('position', 'right')} aria-pressed={t.position !== 'left'}>Derecha</button>
              <button type="button" class={'b' + (t.position === 'left' ? ' on' : '')} onClick={() => set('position', 'left')} aria-pressed={t.position === 'left'}>Izquierda</button>
            </div>
          </div>

          {!compact && (
            <details class="more">
              <summary>Más opciones</summary>
              <Field label="Subtítulo del encabezado">
                <input value={t.header_subtitle} onInput={inp('header_subtitle')} maxLength={80} />
              </Field>
              <div class="l">
                Colores
                {[
                  ['user_bubble', 'Burbuja del visitante'],
                  ['user_text', 'Texto del visitante'],
                  ...(t.appearance === 'claro'
                    ? [
                        ['background', 'Fondo'],
                        ['text', 'Texto'],
                        ['agent_bubble', 'Burbuja del agente'],
                        ['agent_text', 'Texto del agente'],
                      ]
                    : []),
                ].map(([k, label]) => (
                  <div class="color-row" key={k} style="font-weight:400">
                    <span>{label}</span>
                    <input type="color" value={t[k]} onInput={(e) => set(k, e.target.value.toUpperCase())} aria-label={label} />
                  </div>
                ))}
              </div>
              <Field label="Texto de la caja de mensaje">
                <input value={t.placeholder} onInput={inp('placeholder')} maxLength={80} />
              </Field>
              <Field label="Mensaje si hay un error">
                <input value={t.error_message} onInput={inp('error_message')} maxLength={200} />
              </Field>
              <Field label="Aviso de privacidad" hint="Se muestra en el chat. Puedes incluir un enlace: [Aviso de privacidad](https://…)">
                <textarea rows="3" value={t.privacy_notice} onInput={inp('privacy_notice')} maxLength={1000} />
              </Field>
              <label class="check">
                <input type="checkbox" checked={t.privacy_required} onChange={inp('privacy_required')} /> Pedir que lo acepten antes de chatear
              </label>
              <div class="row" style="align-items:flex-start">
                <div class="grow">
                  <Field label="Margen lateral (px)"><input type="number" min="0" max="120" value={t.margin_x} onInput={inp('margin_x')} /></Field>
                </div>
                <div class="grow">
                  <Field label="Margen inferior (px)"><input type="number" min="0" max="120" value={t.margin_y} onInput={inp('margin_y')} /></Field>
                </div>
              </div>
              <Field label={`Tamaño del botón: ${t.button_size}px`}>
                <input type="range" min="44" max="80" value={t.button_size} onInput={inp('button_size')} style="width:100%;accent-color:var(--accent)" />
              </Field>
              <Field label="Abrir solo después de (segundos)" hint="0 = no se abre solo.">
                <input type="number" min="0" max="120" value={t.auto_open_delay} onInput={inp('auto_open_delay')} />
              </Field>
              <label class="check"><input type="checkbox" checked={t.sound} onChange={inp('sound')} /> Sonido al recibir respuesta con el chat cerrado</label>
              <label class="check">
                <input type="checkbox" checked={t.show_powered_by} disabled={!data.can_hide_powered_by} onChange={inp('show_powered_by')} /> Mostrar «Powered by Zentekia»
                {!data.can_hide_powered_by && <span class="muted"> (tu plan lo incluye siempre)</span>}
              </label>
              <label class="check"><input type="checkbox" checked={t.hours_enabled} onChange={inp('hours_enabled')} /> Horario de atención</label>
              {t.hours_enabled && (
                <div style="padding-left:24px">
                  <div class="row" style="margin-top:8px;gap:4px">
                    {DAYS.map((d, i) => (
                      <button key={d} type="button" class={'b b-sm ' + (t.hours_days.includes(i) ? 'b-dark' : 'b-outline')} aria-pressed={t.hours_days.includes(i)} onClick={() => set('hours_days', t.hours_days.includes(i) ? t.hours_days.filter((x) => x !== i) : [...t.hours_days, i].sort())}>
                        {d}
                      </button>
                    ))}
                  </div>
                  <div class="row" style="align-items:flex-start">
                    <div class="grow"><Field label="Desde"><input type="time" value={t.hours_start} onInput={inp('hours_start')} /></Field></div>
                    <div class="grow"><Field label="Hasta"><input type="time" value={t.hours_end} onInput={inp('hours_end')} /></Field></div>
                  </div>
                  <Field label="Zona horaria">
                    <select value={t.hours_timezone} onChange={inp('hours_timezone')}>
                      {['America/Mexico_City', 'America/Monterrey', 'America/Cancun', 'America/Tijuana', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Guatemala', 'America/Panama', 'America/New_York', 'Europe/Madrid'].map((z) => (
                        <option key={z}>{z}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Mensaje fuera de horario">
                    <input value={t.offline_message} onInput={inp('offline_message')} maxLength={300} />
                  </Field>
                </div>
              )}
            </details>
          )}

          {!readOnly && (
            <div class="row" style="margin-top:28px">
              <button class="b b-primary" disabled={busy || !dirty}>Guardar cambios</button>
              <button type="button" class="b b-ghost" disabled={!dirty} onClick={() => { setT({ ...data.theme }); setWelcome(data.welcome) }}>Descartar</button>
            </div>
          )}
        </fieldset>
      </form>
      <WidgetPreview theme={t} welcome={welcome} suggested={data.suggested} logoUrl={data.logo_url} />
    </div>
  )
}

export default function Widget(props) {
  return (
    <>
      <PageHead title="Widget" sub="Personaliza tu burbuja de chat. Los cambios se ven al instante." />
      <WidgetEditor {...props} />
    </>
  )
}
