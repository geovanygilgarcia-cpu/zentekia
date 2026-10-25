import { useState } from 'preact/hooks'
import { CHAT_ORIGIN } from '../env.js'
import { AgentForm } from './Agente.jsx'
import { KnowledgeBase } from './Conocimiento.jsx'
import { ModelPicker } from './Modelo.jsx'
import { WidgetEditor } from './Widget.jsx'
import { Snippet } from './Instalacion.jsx'
import { DomainsEditor } from './Seguridad.jsx'
import { Loading, PageHead, useAction, useLoad } from './common.jsx'

const STEPS = ['Tu marca', 'Personalidad', 'Conocimiento', 'Modelo', 'Prueba', 'Instalación']

function Personality({ api, agentId, next }) {
  const tpl = useLoad(() => api.get('templates'))
  const [picked, setPicked] = useState(null)
  const [busy, run] = useAction()
  const [k, setK] = useState(0)
  if (!tpl.data) return <Loading error={tpl.error} />
  const apply = async (t) => {
    const cur = await api.get(`agents/${agentId}`)
    if (cur.system_prompt?.trim() && !confirm(`La plantilla «${t.name}» reemplaza las instrucciones, el saludo y las preguntas sugeridas actuales. ¿Continuar?`)) return
    setPicked(t.id)
    await run(() => api.put(`agents/${agentId}`, { template: t.id, tone: t.tone, welcome_message: t.welcome, suggested_questions: t.suggested, system_prompt: t.prompt }), `Plantilla «${t.name}» aplicada: ajústala abajo`)
    setK(k + 1)
  }
  return (
    <>
      <div class="tpl-grid">
        {tpl.data.templates.map((t) => (
          <button key={t.id} type="button" class={'opt' + (picked === t.id ? ' on' : '')} onClick={() => apply(t)} disabled={busy}>
            <div class="t">{t.name}</div>
            <div class="d">{t.description}</div>
          </button>
        ))}
      </div>
      <div style="margin-top:18px">
        <AgentForm key={k} api={api} agentId={agentId} compact onSaved={next} />
      </div>
    </>
  )
}

export default function Wizard({ api, agentId, agent, done, reload }) {
  const [step, setStep] = useState(0)
  const [busy, run] = useAction()
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1))
  const finish = async () => {
    const r = await run(() => api.post('onboarding/complete'), '¡Listo! Tu chat está configurado')
    if (r) done()
  }
  return (
    <>
      <PageHead title="Configura tu chat" sub="Seis pasos y tu agente queda en tu sitio. Puedes volver a cualquier paso después." />
      <div class="wiz-steps" role="list">
        {STEPS.map((s, i) => (
          <span key={s} role="listitem" class={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
            {i + 1}. {s}
          </span>
        ))}
      </div>

      {step === 0 && (
        <>
          <p class="sub" style="margin:-8px 0 16px">Nombre de tu asistente, color de tu marca y logo.</p>
          <WidgetEditor api={api} agentId={agentId} compact onSaved={reload} />
        </>
      )}
      {step === 1 && (
        <>
          <p class="sub" style="margin:-8px 0 16px">Elige una plantilla según tu tipo de negocio y ajústala con tus palabras.</p>
          <Personality api={api} agentId={agentId} next={next} />
        </>
      )}
      {step === 2 && (
        <>
          <p class="sub" style="margin:-8px 0 16px">Sube lo que tu agente debe saber: preguntas frecuentes, catálogo, políticas. Puedes saltarte este paso.</p>
          <KnowledgeBase api={api} agentId={agentId} />
        </>
      )}
      {step === 3 && (
        <>
          <p class="sub" style="margin:-8px 0 16px">Si no sabes cuál elegir, deja Qwen hosted by Zentekia: no necesitas API key.</p>
          <ModelPicker api={api} agentId={agentId} />
        </>
      )}
      {step === 4 && (
        <>
          <p class="sub" style="margin:-8px 0 16px">Platica con tu agente como lo haría un visitante. Si algo no te gusta, regresa al paso 2.</p>
          <iframe title="Prueba del chat" allow="microphone; autoplay" src={`${CHAT_ORIGIN}/w/frame?key=${agent?.widget_key}`} class="wiz-test" />
        </>
      )}
      {step === 5 && (
        <div class="cols">
          <div class="col-main">
            <div class="card">
              <div class="card-title">1. Autoriza tu sitio</div>
              <div style="margin-top:10px"><DomainsEditor api={api} /></div>
            </div>
            <div class="card">
              <div class="card-title">2. Pega este código antes de &lt;/body&gt;</div>
              <div style="margin-top:10px"><Snippet widgetKey={agent?.widget_key} /></div>
              <div class="small muted" style="margin-top:10px">Instrucciones para WordPress, Shopify y Wix en la sección Instalación.</div>
            </div>
          </div>
        </div>
      )}

      <div class="row" style="margin-top:24px">
        {step === 0 && <a class="b b-ghost" href={`#/a/${agentId}/resumen`}>Ahora no</a>}
        {step > 0 && <button class="b b-ghost" onClick={() => setStep(step - 1)}>← Atrás</button>}
        {step < STEPS.length - 1 ? (
          <button class="b b-primary" onClick={next}>Siguiente →</button>
        ) : (
          <button class="b b-primary" onClick={finish} disabled={busy}>Terminar</button>
        )}
      </div>
    </>
  )
}
