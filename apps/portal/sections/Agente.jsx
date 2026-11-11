import { useEffect, useState } from 'preact/hooks'
import { toast } from '../../shared/toast.jsx'
import { Field, Loading, PageHead, useAction, useLoad } from './common.jsx'

const TONES = ['amable y profesional', 'cercano e informal', 'formal', 'entusiasta', 'directo y breve']

export function AgentForm({ api, agentId, readOnly, compact, onSaved }) {
  const { data, error } = useLoad(() => api.get(`agents/${agentId}`), [agentId])
  const [f, setF] = useState(null)
  const [busy, run] = useAction()
  useEffect(() => {
    if (data) setF({ ...data, suggested_questions: [...(data.suggested_questions || []), '', '', '', ''].slice(0, 4) })
  }, [data])
  if (!f) return <Loading error={error} />
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const save = (e) => {
    e.preventDefault()
    run(
      () =>
        api.put(`agents/${agentId}`, {
          name: f.name,
          welcome_message: f.welcome_message,
          language: f.language,
          system_prompt: f.system_prompt,
          tone: f.tone,
          fallback_response: f.fallback_response || '',
          suggested_questions: f.suggested_questions.map((s) => s.trim()).filter(Boolean),
          business_name: f.business_name || '',
          business_description: f.business_description || '',
          show_sources: Boolean(f.show_sources),
          temperature: Number(f.temperature),
        }),
      'Agente guardado',
    ).then((r) => {
      if (r?.voice_warning) toast(r.voice_warning, true)
      if (r) onSaved?.()
    })
  }
  return (
    <form onSubmit={save}>
      <fieldset disabled={readOnly} style="border:0;padding:0;margin:0">
        <div class={compact ? '' : 'cols'}>
          <div class={compact ? '' : 'col-main'} style={compact ? '' : 'max-width:620px'}>
            <div class="card">
              <Field label="Nombre del agente">
                <input value={f.name} onInput={set('name')} maxLength={80} required />
              </Field>
              <Field label="Mensaje de bienvenida" hint="Es lo primero que ve el visitante al abrir el chat.">
                <textarea rows="2" value={f.welcome_message} onInput={set('welcome_message')} maxLength={600} />
              </Field>
              <div class="row" style="align-items:flex-start">
                <div class="grow">
                  <Field label="Tono">
                    <select value={f.tone || TONES[0]} onChange={set('tone')}>
                      {[...new Set([f.tone || TONES[0], ...TONES])].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div style="width:150px">
                  <Field label="Idioma">
                    <select value={f.language} onChange={set('language')}>
                      <option value="es">Español</option>
                      <option value="en">Inglés</option>
                      <option value="pt">Portugués</option>
                    </select>
                  </Field>
                </div>
              </div>
              <Field label="Instrucciones" hint="Explica en tus palabras qué hace tu negocio, qué debe responder el agente y qué no. Ej.: «Somos una clínica dental en Monterrey. Agenda citas de lunes a sábado…».">
                <textarea rows={compact ? 7 : 12} value={f.system_prompt} onInput={set('system_prompt')} maxLength={20000} />
              </Field>
              <a class="tool-hint" href={`#/a/${agentId}/herramientas`}>
                <span class="endtool-ic" aria-hidden="true">⚙</span>
                <span class="grow small">
                  <b>Herramientas</b>
                  <span class="muted"> · Finalizar conversación, prospectos, pasar a una persona, citas, WhatsApp y webhook se configuran aparte.</span>
                </span>
                <span aria-hidden="true">→</span>
              </a>
              <Field label="Si no sabe la respuesta, dirá…" hint="Respuesta de respaldo cuando la información no está en tus instrucciones ni en tu base de conocimiento.">
                <input value={f.fallback_response || ''} onInput={set('fallback_response')} maxLength={400} placeholder="No tengo esa información. ¿Quieres que te ponga en contacto con una persona del equipo?" />
              </Field>
            </div>
          </div>
          {!compact && (
            <div class="col-side">
              <div class="card">
                <div class="card-title">Preguntas sugeridas</div>
                <div class="small muted" style="margin-top:4px">Botones que aparecen al abrir el chat (máximo 4).</div>
                {f.suggested_questions.map((q, i) => (
                  <input
                    key={i}
                    class="in"
                    style="margin-top:8px"
                    value={q}
                    maxLength={80}
                    placeholder={`Pregunta ${i + 1}`}
                    aria-label={`Pregunta sugerida ${i + 1}`}
                    onInput={(e) => {
                      const a = f.suggested_questions.slice()
                      a[i] = e.target.value
                      setF({ ...f, suggested_questions: a })
                    }}
                  />
                ))}
              </div>
              <div class="card">
                <div class="card-title">Tu negocio</div>
                <Field label="Nombre del negocio">
                  <input value={f.business_name || ''} onInput={set('business_name')} maxLength={120} />
                </Field>
                <Field label="Descripción corta">
                  <textarea rows="3" value={f.business_description || ''} onInput={set('business_description')} maxLength={2000} />
                </Field>
                <Field label={`Creatividad: ${Number(f.temperature) <= 0.3 ? 'precisa' : Number(f.temperature) <= 0.6 ? 'equilibrada' : 'creativa'}`}>
                  <input type="range" min="0" max="1" step="0.1" value={f.temperature} onInput={set('temperature')} style="width:100%;accent-color:var(--accent)" />
                </Field>
                <label class="check">
                  <input type="checkbox" checked={Boolean(f.show_sources)} onChange={set('show_sources')} />
                  Mostrar al visitante las fuentes de la base de conocimiento que usó
                </label>
              </div>
            </div>
          )}
        </div>
        {!readOnly && (
          <div class="row" style="margin-top:20px">
            <button class="b b-primary" disabled={busy}>Guardar cambios</button>
          </div>
        )}
      </fieldset>
    </form>
  )
}

export default function Agente({ api, agentId, readOnly, me, reload }) {
  const [busy, run] = useAction()
  const add = () => {
    const name = prompt('Nombre del nuevo agente')
    if (name?.trim()) run(() => api.post('agents', { name: name.trim() }), 'Agente creado').then((r) => r && reload())
  }
  return (
    <>
      <PageHead title="Agente" sub="Cómo se presenta y qué sabe responder tu asistente.">
        {me.user.role === 'owner' && !readOnly && (
          <button class="b b-outline b-sm" onClick={add} disabled={busy}>+ Otro agente</button>
        )}
      </PageHead>
      <AgentForm api={api} agentId={agentId} readOnly={readOnly} onSaved={reload} />
    </>
  )
}
