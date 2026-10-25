import { useState } from 'preact/hooks'
import { PageHead, useAction } from './common.jsx'
import { Icon } from './icons.jsx'

const INFO = {
  voz: {
    title: 'Canal de Voz',
    key: 'voice',
    sub: 'Tu asistente contesta y hace llamadas con voz natural, usando las mismas instrucciones y conocimiento que tu chat.',
    feats: [
      ['Contesta llamadas 24/7', 'Atiende tu línea sin tiempos de espera y transfiere a una persona cuando hace falta.'],
      ['Llamadas salientes', 'Confirma citas, da seguimiento a cotizaciones o recuerda pagos.'],
      ['Grabación y transcripción', 'Cada llamada queda en Conversaciones junto con las del chat.'],
    ],
  },
  whatsapp: {
    title: 'Canal de WhatsApp',
    key: 'whatsapp',
    sub: 'Tu asistente atiende en tu número de WhatsApp Business, con el mismo conocimiento y tono que tu chat.',
    feats: [
      ['Tu número de negocio', 'Conectado a la API oficial de WhatsApp Business.'],
      ['Plantillas y campañas', 'Mensajes aprobados para avisos, recordatorios y seguimiento.'],
      ['Pase a una persona', 'Tu equipo toma la conversación cuando el caso lo pide.'],
    ],
  },
}

const SS = (agentId, ch) => `zc-interest-${agentId}-${ch}`

/** Página de un canal que todavía no está disponible: solo informa y permite pedir aviso */
export default function Proximamente({ api, channel, agent, me, readOnly }) {
  const i = INFO[channel]
  const [busy, run] = useAction()
  const [asked, setAsked] = useState(() => {
    try {
      return localStorage.getItem(SS(agent.id, channel)) === '1'
    } catch {
      return false
    }
  })
  const canAsk = me.user.role === 'owner' && !readOnly
  const notify = async () => {
    const r = await run(
      () => api.post('agents/request', { name: agent.name, channels: [i.key], notes: `Quiere que le avisen cuando ${i.title.replace('Canal de ', '')} esté disponible para este asistente.` }),
      'Listo: te avisamos cuando esté disponible',
    )
    if (r) {
      setAsked(true)
      try {
        localStorage.setItem(SS(agent.id, channel), '1')
      } catch {}
    }
  }
  return (
    <>
      <PageHead title={i.title} sub={i.sub} />
      <div class="soon-hero card">
        <span class="soon-ic"><Icon name={channel} size={28} /></span>
        <div class="grow">
          <span class="pill-soon">Próximamente</span>
          <h2 style="margin-top:10px">Muy pronto en «{agent.name}»</h2>
          <p class="sub">Estamos preparando este canal. Por ahora está bloqueado; cuando salga, se activa aquí mismo.</p>
        </div>
        {canAsk && (asked ? (
          <span class="b b-outline soon-asked"><Icon name="check" size={16} />Te avisaremos</span>
        ) : (
          <button class="b b-primary" onClick={notify} disabled={busy}>Avísame cuando esté listo</button>
        ))}
      </div>
      <div class="soon-feats">
        {i.feats.map(([t, s]) => (
          <div key={t} class="card">
            <div class="card-title">{t}</div>
            <div class="small muted" style="margin-top:6px">{s}</div>
          </div>
        ))}
      </div>
    </>
  )
}
