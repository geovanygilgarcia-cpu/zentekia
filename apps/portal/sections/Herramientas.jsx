import { useEffect, useState } from 'preact/hooks'
import { toast } from '../../shared/toast.jsx'
import { Field, Loading, PageHead, useAction, useLoad } from './common.jsx'
import { Icon } from './icons.jsx'

const LEAD_FIELDS = [
  { id: 'name', label: 'Nombre' },
  { id: 'phone', label: 'Teléfono / WhatsApp' },
  { id: 'email', label: 'Correo' },
  { id: 'company', label: 'Empresa' },
]

const WEBHOOK_EVENTS = [
  { id: 'conversation.analyzed', label: 'Conversación terminada', hint: 'con resumen y datos de contacto' },
  { id: 'lead.detected', label: 'Prospecto detectado', hint: 'caliente o tibio' },
  { id: 'handoff.requested', label: 'Pidió a una persona', hint: 'al momento' },
]

/** Estado editable de cada herramienta a partir del agente que manda el backend */
function fromAgent(a) {
  const t = a.tools || {}
  return {
    leads: {
      enabled: t.leads?.enabled !== false,
      lead_fields: a.lead_fields || [],
      lead_custom: a.lead_custom || [],
      lead_criteria: a.lead_criteria || '',
      lead_alerts: a.lead_alerts || 'hot',
    },
    end_chat: { enabled: Boolean(a.auto_end), end_when: a.end_when || '' },
    handoff: {
      enabled: Boolean(t.handoff?.enabled),
      when: t.handoff?.when || '',
      message: t.handoff?.message || '',
      email: t.handoff?.email !== false,
      // Bandeja en vivo
      mode: t.handoff?.mode === 'inbox' ? 'inbox' : 'notify',
      keywords: (t.handoff?.keywords || []).join(', '),
      max_ai_turns: t.handoff?.max_ai_turns ?? 0,
      queue_id: t.handoff?.queue_id || '',
      waiting_message: t.handoff?.waiting_message || '',
      assigned_message: t.handoff?.assigned_message || '',
      handback_message: t.handoff?.handback_message || '',
      no_agents: t.handoff?.no_agents === 'ai' ? 'ai' : 'wait',
      no_agents_message: t.handoff?.no_agents_message || '',
      max_wait_min: t.handoff?.max_wait_min ?? 5,
    },
    booking: { enabled: Boolean(t.booking?.enabled), url: t.booking?.url || '', when: t.booking?.when || '' },
    whatsapp: { enabled: Boolean(t.whatsapp?.enabled), number: t.whatsapp?.number || '', message: t.whatsapp?.message || '' },
    links: { enabled: Boolean(t.links?.enabled), items: t.links?.items?.length ? t.links.items : [{ label: '', url: '' }] },
    webhook: {
      enabled: Boolean(t.webhook?.enabled),
      url: t.webhook?.url || '',
      events: t.webhook?.events?.length ? t.webhook.events : WEBHOOK_EVENTS.map((e) => e.id),
      secret: t.webhook?.secret || '',
      last_status: t.webhook?.last_status ?? null,
      last_at: t.webhook?.last_at ?? null,
      last_error: t.webhook?.last_error ?? null,
    },
  }
}

/** Lo que se manda al backend al guardar una herramienta */
function toPayload(id, v) {
  switch (id) {
    case 'leads':
      return { tools: { leads: { enabled: v.enabled } }, lead_fields: v.lead_fields, lead_custom: v.lead_custom, lead_criteria: v.lead_criteria, lead_alerts: v.lead_alerts }
    case 'end_chat':
      return { auto_end: v.enabled, end_when: v.end_when }
    case 'handoff':
      return {
        tools: {
          handoff: {
            enabled: v.enabled,
            when: v.when,
            message: v.message,
            email: v.email,
            mode: v.mode,
            keywords: v.keywords.split(',').map((x) => x.trim()).filter((x) => x.length >= 3).slice(0, 20),
            max_ai_turns: Math.max(0, Math.min(50, Number(v.max_ai_turns) || 0)),
            queue_id: v.queue_id || null,
            waiting_message: v.waiting_message,
            assigned_message: v.assigned_message,
            handback_message: v.handback_message,
            no_agents: v.no_agents,
            no_agents_message: v.no_agents_message,
            max_wait_min: Math.max(0, Math.min(240, Number(v.max_wait_min) || 0)),
          },
        },
      }
    case 'booking':
      return { tools: { booking: { enabled: v.enabled, url: v.url.trim(), when: v.when } } }
    case 'whatsapp':
      return { tools: { whatsapp: { enabled: v.enabled, number: v.number, message: v.message } } }
    case 'links':
      return {
        tools: {
          links: {
            enabled: v.enabled,
            items: v.items.map((x) => ({ label: x.label.trim(), url: x.url.trim() })).filter((x) => x.label && x.url),
          },
        },
      }
    case 'webhook':
      return { tools: { webhook: { enabled: v.enabled, url: v.url.trim(), events: v.events } } }
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Tarjeta de una herramienta: encabezado con interruptor, cuerpo y barra de guardar */
function ToolCard({ icon, title, desc, tag, value, saved, onChange, onSave, busy, readOnly, children, footer }) {
  const dirty = !same(value, saved)
  return (
    <section class={'card tool' + (value.enabled ? ' on' : '')}>
      <label class="tool-head">
        <span class="tool-ic" aria-hidden="true"><Icon name={icon} size={19} /></span>
        <span class="grow">
          <b>{title}{tag && <span class="tool-tag">{tag}</span>}</b>
          <span class="small muted">{desc}</span>
        </span>
        <span class="switch">
          <input type="checkbox" role="switch" checked={value.enabled} disabled={readOnly} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} aria-label={title} />
          <i aria-hidden="true" />
        </span>
      </label>
      {value.enabled && children && <div class="tool-body">{children}</div>}
      {(dirty || footer) && (
        <div class="tool-foot">
          {footer}
          <span class="grow" />
          {dirty && !readOnly && (
            <>
              <span class="small muted">Sin guardar</span>
              <button type="button" class="b b-ghost b-sm" onClick={() => onChange(saved)}>Descartar</button>
              <button type="button" class="b b-primary b-sm" disabled={busy} onClick={onSave}>Guardar</button>
            </>
          )}
        </div>
      )}
    </section>
  )
}

export default function Herramientas({ api, agentId, readOnly, ov }) {
  const { data, error, setData } = useLoad(() => api.get(`agents/${agentId}`), [agentId])
  // Colas de la bandeja (para elegir a cuál escala este asistente)
  const [inbox, setInbox] = useState({ ready: Boolean(ov?.inbox_ready), queues: [] })
  useEffect(() => {
    if (ov?.inbox_ready) api.get('inbox/queues').then((r) => setInbox({ ready: true, queues: r.queues })).catch(() => {})
  }, [ov?.inbox_ready])
  const [saved, setSaved] = useState(null)
  const [f, setF] = useState(null)
  const [busy, run] = useAction()
  const [testing, setTesting] = useState(false)
  const [extra, setExtra] = useState('')

  useEffect(() => {
    if (data) {
      const s = fromAgent(data)
      setSaved(s)
      setF(s)
    }
  }, [data])
  if (!f) return <Loading error={error} />

  const setTool = (id) => (v) => setF({ ...f, [id]: v })
  const setField = (id, k) => (e) => setF({ ...f, [id]: { ...f[id], [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value } })
  const save = (id) => async () => {
    const r = await run(() => api.put(`agents/${agentId}`, toPayload(id, f[id])), f[id].enabled ? 'Herramienta guardada' : 'Herramienta apagada')
    if (r) {
      if (r.voice_warning) toast(r.voice_warning, true)
      setData(await api.get(`agents/${agentId}`))
    }
  }
  const card = (id) => ({ value: f[id], saved: saved[id], onChange: setTool(id), onSave: save(id), busy, readOnly })

  const testWebhook = async () => {
    setTesting(true)
    try {
      const r = await api.post(`agents/${agentId}/webhook/test`)
      if (r.ok) toast(`Webhook respondió ${r.status}: todo bien`)
      else toast(r.error || 'El webhook no respondió bien', true)
      setData(await api.get(`agents/${agentId}`))
    } catch (e) {
      toast(e.message, true)
    } finally {
      setTesting(false)
    }
  }
  const rotateSecret = () =>
    confirm('¿Generar un secreto nuevo? El sistema que recibe el webhook tendrá que usar el nuevo para verificar la firma.') &&
    run(() => api.put(`agents/${agentId}`, { tools: { webhook: { rotate_secret: true } } }), 'Secreto nuevo generado').then(async (r) => r && setData(await api.get(`agents/${agentId}`)))

  const active = Object.values(saved).filter((t) => t.enabled).length
  const fields = f.leads.lead_fields
  const custom = f.leads.lead_custom
  const addExtra = () => {
    const v = extra.trim()
    if (!v || custom.length >= 6 || custom.some((c) => c.toLowerCase() === v.toLowerCase())) return
    setF({ ...f, leads: { ...f.leads, lead_custom: [...custom, v] } })
    setExtra('')
  }
  const toggleField = (id) => setF({ ...f, leads: { ...f.leads, lead_fields: fields.includes(id) ? fields.filter((x) => x !== id) : [...fields, id] } })
  const waNumber = f.whatsapp.number.replace(/\D/g, '')
  const hookOk = saved.webhook.last_at && saved.webhook.last_status >= 200 && saved.webhook.last_status < 300
  const setLink = (i, k) => (e) => {
    const items = f.links.items.slice()
    items[i] = { ...items[i], [k]: e.target.value }
    setF({ ...f, links: { ...f.links, items } })
  }

  return (
    <>
      <PageHead title="Herramientas" sub="Acciones opcionales que tu asistente puede hacer en el chat. Prende solo las que necesitas: cada una se configura aparte." />
      <div class="tool-sum small muted">
        {active === 1 ? '1 herramienta activa' : `${active} herramientas activas`} en «{data.name}»
      </div>
      <div class="tool-grid">
        <ToolCard {...card('leads')} icon="target" title="Prospectos" desc="Pide datos de contacto cuando hay interés, califica cada conversación (caliente, tibio, frío) y te avisa por correo.">
          <div class="l" style="margin-top:0">Datos que debe pedir</div>
          <div class="req-ch">
            {LEAD_FIELDS.map((x) => {
              const on = fields.includes(x.id)
              return (
                <label key={x.id} class={'req-chip pick' + (on ? ' on' : '')}>
                  <input type="checkbox" checked={on} onChange={() => toggleField(x.id)} disabled={readOnly} />
                  {x.label}
                  {on && <Icon name="check" size={14} />}
                </label>
              )
            })}
            {custom.map((c) => (
              <span key={c} class="req-chip on tool-custom">
                {c}
                {!readOnly && (
                  <button type="button" aria-label={`Quitar ${c}`} onClick={() => setF({ ...f, leads: { ...f.leads, lead_custom: custom.filter((x) => x !== c) } })}>
                    <Icon name="x" size={13} />
                  </button>
                )}
              </span>
            ))}
          </div>
          {!readOnly && custom.length < 6 && (
            <div class="tool-add">
              <input
                class="in"
                value={extra}
                maxLength={40}
                placeholder="Otro dato: colonia, presupuesto, fecha de la cita…"
                aria-label="Agregar otro dato"
                onInput={(e) => setExtra(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addExtra()
                  }
                }}
              />
              <button type="button" class="b b-outline b-sm" disabled={!extra.trim()} onClick={addExtra}>
                <Icon name="plus" size={14} />Agregar
              </button>
            </div>
          )}
          <p class="hint" style="margin-top:6px">Los datos extra se piden igual que los demás y quedan anotados en el resumen de cada conversación (máximo 6).</p>
          <Field label="¿Qué es un prospecto para tu negocio?" hint="Opcional. Ej.: «Quien pide cotización de 10 piezas o más». Quien pide soporte no es prospecto.">
            <textarea rows="2" value={f.leads.lead_criteria} maxLength={1500} onInput={setField('leads', 'lead_criteria')} />
          </Field>
          <Field label="Avisarme por correo">
            <select class="in" value={f.leads.lead_alerts} onChange={setField('leads', 'lead_alerts')}>
              <option value="hot">Solo prospectos calientes</option>
              <option value="warm">Calientes y tibios</option>
              <option value="off">No avisar</option>
            </select>
          </Field>
        </ToolCard>

        <ToolCard {...card('end_chat')} icon="door" title="Finalizar conversación" desc="Cuando ya terminó, el asistente se despide, cierra el chat y le pide al visitante calificar la atención.">
          <Field label="¿Cuándo debe finalizar?" hint="Si lo dejas vacío, cierra cuando tenga lo que necesita o el visitante se despida.">
            <textarea rows="2" value={f.end_chat.end_when} maxLength={1000} onInput={setField('end_chat', 'end_when')} placeholder="Ej.: Cuando ya tengas nombre, teléfono y el servicio que le interesa." />
          </Field>
        </ToolCard>

        <ToolCard {...card('handoff')} icon="hand" title="Pasar a una persona" desc="Si el visitante pide hablar con alguien o el caso lo rebasa, el asistente toma sus datos y avisa a tu equipo con la liga de la conversación.">
          <Field label="¿Cuándo debe pasar el caso?" hint="Opcional. Por defecto: cuando lo pidan, estén molestos o sea algo que no puede resolver.">
            <textarea rows="2" value={f.handoff.when} maxLength={800} onInput={setField('handoff', 'when')} placeholder="Ej.: Quejas, devoluciones o pedidos de más de $20,000." />
          </Field>
          <Field label="Qué le dice al visitante">
            <input value={f.handoff.message} maxLength={300} onInput={setField('handoff', 'message')} placeholder="Le paso tu caso a una persona del equipo para que te dé seguimiento." />
          </Field>
          <label class="check">
            <input type="checkbox" checked={f.handoff.email} onChange={setField('handoff', 'email')} disabled={readOnly} />
            Avisar por correo a los propietarios (además del aviso en el portal)
          </label>
          <Field label="¿Qué pasa al pasar a una persona?">
            <select value={f.handoff.mode} onChange={setField('handoff', 'mode')} disabled={readOnly}>
              <option value="notify">Solo avisar a mi equipo (te contactan después)</option>
              <option value="inbox" disabled={!inbox.ready && f.handoff.mode !== 'inbox'}>Pasar a la Bandeja: una persona responde en vivo en el mismo chat</option>
            </select>
          </Field>
          {!inbox.ready && <p class="small muted" style="margin:6px 0 0">La Bandeja en vivo todavía no está activa en tu cuenta.</p>}
          {f.handoff.mode === 'inbox' && (
            <div class="ib-tool">
              <p class="small muted" style="margin:0 0 4px">Mientras una persona atiende, el asistente deja de responder. Tu equipo contesta desde <a href="#/bandeja">Bandeja</a>.</p>
              <Field label="Frases con las que el visitante pide a una persona" hint="Separadas por coma. Escala de inmediato, sin pasar por la IA. Vacío = frases comunes («hablar con una persona», «agente humano»…).">
                <input value={f.handoff.keywords} maxLength={1200} onInput={setField('handoff', 'keywords')} placeholder="hablar con una persona, quiero un asesor" />
              </Field>
              <div class="ib-tool-row">
                <Field label="Escalar tras N respuestas de la IA" hint="0 = apagado">
                  <input type="number" min="0" max="50" value={f.handoff.max_ai_turns} onInput={setField('handoff', 'max_ai_turns')} />
                </Field>
                <Field label="Cola">
                  <select value={f.handoff.queue_id} onChange={setField('handoff', 'queue_id')} disabled={readOnly}>
                    <option value="">Cola general</option>
                    {inbox.queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                  </select>
                </Field>
              </div>
              <div class="ib-tool-row">
                <Field label="Si no hay nadie disponible">
                  <select value={f.handoff.no_agents} onChange={setField('handoff', 'no_agents')} disabled={readOnly}>
                    <option value="wait">Se queda en la cola (deja su mensaje)</option>
                    <option value="ai">Sigue atendiendo la IA</option>
                  </select>
                </Field>
                <Field label="Espera máxima (min)" hint="Después aplica lo de la izquierda. 0 = sin límite">
                  <input type="number" min="0" max="240" value={f.handoff.max_wait_min} onInput={setField('handoff', 'max_wait_min')} />
                </Field>
              </div>
              <Field label="Mensaje mientras espera">
                <input value={f.handoff.waiting_message} maxLength={300} onInput={setField('handoff', 'waiting_message')} placeholder="Te estoy comunicando con una persona del equipo. En un momento te atienden." />
              </Field>
              <Field label="Cuando alguien toma la conversación" hint="{agente} se cambia por el nombre de pila de quien atiende.">
                <input value={f.handoff.assigned_message} maxLength={300} onInput={setField('handoff', 'assigned_message')} placeholder="{agente} se unió a la conversación." />
              </Field>
              <Field label="Si no hay nadie disponible, se le dice">
                <input value={f.handoff.no_agents_message} maxLength={300} onInput={setField('handoff', 'no_agents_message')} placeholder={f.handoff.no_agents === 'ai' ? 'En este momento no hay personas disponibles, pero sigo aquí para ayudarte.' : 'En este momento no hay personas disponibles. Déjanos tu mensaje y te responderemos en cuanto sea posible.'} />
              </Field>
              <Field label="Cuando la conversación vuelve al asistente">
                <input value={f.handoff.handback_message} maxLength={300} onInput={setField('handoff', 'handback_message')} placeholder="Te atiende de nuevo el asistente virtual." />
              </Field>
            </div>
          )}
        </ToolCard>

        <ToolCard {...card('booking')} icon="calendar" title="Agendar citas" desc="Comparte la liga de tu calendario para que el visitante elija día y hora. Funciona con Calendly, Cal.com, Google Calendar o cualquier página de reservas.">
          <Field label="Liga de tu calendario">
            <input type="url" value={f.booking.url} maxLength={500} onInput={setField('booking', 'url')} placeholder="https://calendly.com/tu-negocio/30min" />
          </Field>
          <Field label="¿Cuándo debe compartirla?" hint="Opcional.">
            <input value={f.booking.when} maxLength={500} onInput={setField('booking', 'when')} placeholder="Cuando quiera una cita, una visita o una demo." />
          </Field>
        </ToolCard>

        <ToolCard {...card('whatsapp')} icon="whatsapp" title="Continuar por WhatsApp" desc="Si el visitante prefiere WhatsApp, el asistente le da una liga que abre el chat con tu número y un mensaje ya escrito.">
          <Field label="Número de WhatsApp" hint="Con lada del país, sin el +. Ej.: 52 55 1234 5678.">
            <input inputMode="tel" value={f.whatsapp.number} maxLength={25} onInput={setField('whatsapp', 'number')} placeholder="52 55 1234 5678" />
          </Field>
          <Field label="Mensaje prellenado" hint="Opcional.">
            <input value={f.whatsapp.message} maxLength={300} onInput={setField('whatsapp', 'message')} placeholder="Hola, vengo del chat de su sitio web." />
          </Field>
          {waNumber.length >= 10 && (
            <a
              class="link small"
              href={`https://wa.me/${waNumber}${f.whatsapp.message.trim() ? `?text=${encodeURIComponent(f.whatsapp.message.trim())}` : ''}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Probar la liga →
            </a>
          )}
        </ToolCard>

        <ToolCard {...card('links')} icon="link" title="Enlaces útiles" desc="Ligas que el asistente comparte cuando vienen al caso: catálogo, lista de precios, ubicación, formulario de registro…">
          {f.links.items.map((x, i) => (
            <div key={i} class="tool-link">
              <input class="in" value={x.label} maxLength={60} placeholder="Nombre (ej.: Catálogo 2026)" aria-label={`Nombre del enlace ${i + 1}`} onInput={setLink(i, 'label')} />
              <input class="in" type="url" value={x.url} maxLength={500} placeholder="https://…" aria-label={`Liga del enlace ${i + 1}`} onInput={setLink(i, 'url')} />
              <button
                type="button"
                class="icon-x"
                aria-label="Quitar enlace"
                disabled={readOnly}
                onClick={() => {
                  const items = f.links.items.filter((_, j) => j !== i)
                  setF({ ...f, links: { ...f.links, items: items.length ? items : [{ label: '', url: '' }] } })
                }}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
          {f.links.items.length < 8 && !readOnly && (
            <button type="button" class="b b-ghost b-sm" style="margin-top:8px" onClick={() => setF({ ...f, links: { ...f.links, items: [...f.links.items, { label: '', url: '' }] } })}>
              <Icon name="plus" size={14} />Agregar enlace
            </button>
          )}
        </ToolCard>

        <ToolCard
          {...card('webhook')}
          icon="hook"
          title="Webhook"
          tag="Avanzado"
          desc="Manda las conversaciones, prospectos y solicitudes de persona a tu CRM o a Zapier, Make o n8n, en JSON y firmados."
          footer={
            saved.webhook.enabled && saved.webhook.url ? (
              <>
                <button type="button" class="b b-outline b-sm" disabled={testing || readOnly} onClick={testWebhook}>
                  <Icon name="bolt" size={14} />
                  {testing ? 'Enviando…' : 'Enviar prueba'}
                </button>
                {saved.webhook.last_at && (
                  <span class={'small ' + (hookOk ? 'tool-ok' : 'tool-bad')}>
                    {hookOk ? `✓ Último envío: HTTP ${saved.webhook.last_status}` : `✕ ${saved.webhook.last_error || 'Falló el último envío'}`}
                  </span>
                )}
              </>
            ) : null
          }
        >
          <Field label="URL que recibe los eventos" hint="Solo https://. Recibe un POST con JSON.">
            <input type="url" value={f.webhook.url} maxLength={500} onInput={setField('webhook', 'url')} placeholder="https://hooks.zapier.com/hooks/catch/…" />
          </Field>
          <div class="l">Eventos</div>
          <div class="tool-events">
            {WEBHOOK_EVENTS.map((ev) => {
              const on = f.webhook.events.includes(ev.id)
              return (
                <label key={ev.id} class="check">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={readOnly}
                    onChange={() => setF({ ...f, webhook: { ...f.webhook, events: on ? f.webhook.events.filter((x) => x !== ev.id) : [...f.webhook.events, ev.id] } })}
                  />
                  <span>
                    <b>{ev.label}</b> <span class="muted">· {ev.hint}</span> <code class="tool-code">{ev.id}</code>
                  </span>
                </label>
              )
            })}
          </div>
          {saved.webhook.secret && (
            <div class="tool-secret">
              <div class="l" style="margin:0">Secreto para verificar la firma</div>
              <div class="row" style="gap:8px;margin-top:6px">
                <code class="tool-code grow">{saved.webhook.secret}</code>
                <button type="button" class="b b-ghost b-sm" onClick={() => navigator.clipboard?.writeText(saved.webhook.secret).then(() => toast('Secreto copiado'))}>
                  <Icon name="copy" size={14} />Copiar
                </button>
                {!readOnly && <button type="button" class="b b-ghost b-sm" onClick={rotateSecret}>Generar otro</button>}
              </div>
              <p class="hint" style="margin-top:6px">
                Cada envío trae <code>X-Zentekia-Signature: sha256=…</code>, que es el HMAC-SHA256 de <code>{'"<X-Zentekia-Timestamp>.<cuerpo>"'}</code> con este secreto.
              </p>
            </div>
          )}
        </ToolCard>
      </div>
    </>
  )
}
