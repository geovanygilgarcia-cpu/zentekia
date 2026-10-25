import { useEffect, useState } from 'preact/hooks'
import { num, perM, usd } from '../../shared/api.js'
import { Field, Loading, PageHead, useAction, useLoad } from './common.jsx'

const PROVIDER = { anthropic: 'Claude', openai: 'OpenAI', 'openai-compatible': 'el proveedor compatible' }
const PREFIX = { anthropic: 'sk-ant-', openai: 'sk-', 'openai-compatible': '' }

export function ModelPicker({ api, agentId, readOnly, onChanged }) {
  const models = useLoad(() => api.get('models'), [])
  const agent = useLoad(() => api.get(`agents/${agentId}`), [agentId])
  const [sel, setSel] = useState(null)
  const [busy, run] = useAction()
  const [keyIn, setKeyIn] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelName, setModelName] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [test, setTest] = useState(null)

  useEffect(() => {
    if (agent.data && !sel) setSel(agent.data.model_id)
  }, [agent.data])
  const d = models.data
  const m = d?.models.find((x) => x.id === sel)
  const key = m && d.keys.find((k) => k.provider === m.provider)
  useEffect(() => {
    setReplacing(false)
    setKeyIn('')
    setTest(null)
    setBaseUrl(key?.base_url || '')
    setModelName(key?.model_name || '')
  }, [sel, d])

  if (!d || !agent.data) return <Loading error={models.error || agent.error} />
  const current = agent.data.model_id

  const saveKey = async (e) => {
    e.preventDefault()
    const r = await run(() => api.put(`keys/${m.provider}`, { api_key: keyIn || undefined, base_url: baseUrl || undefined, model_name: modelName || undefined }), 'Llave guardada y cifrada')
    if (r) {
      setKeyIn('')
      setReplacing(false)
      await models.reload()
      const t = await run(() => api.post(`keys/${r.id}/test`))
      if (t) setTest(t)
      models.reload()
    }
  }
  const testKey = async () => {
    const t = await run(() => api.post(`keys/${key.id}/test`))
    if (t) setTest(t)
    models.reload()
  }
  const apply = async () => {
    const r = await run(() => api.put(`agents/${agentId}/model`, { model_id: sel }), 'Modelo actualizado: se usa desde la siguiente conversación')
    if (r) {
      agent.reload()
      onChanged?.()
    }
  }
  const pct = d.month.limit_micro > 0 ? Math.min(100, (d.month.cost_micro / d.month.limit_micro) * 100) : 0
  const needsKey = m?.type === 'byok' && (!key || replacing)

  return (
    <div class="cols">
      <div class="col-main" style="display:flex;flex-direction:column;gap:10px">
        {d.models.map((x) => (
          <button key={x.id} type="button" class={'opt' + (sel === x.id ? ' on' : '')} onClick={() => setSel(x.id)} aria-pressed={sel === x.id}>
            <div class="row">
              <span class="t grow">{x.name}</span>
              {current === x.id && <span class="badge badge-accent">En uso</span>}
              {x.discounted && <span class="badge badge-ok">Tarifa especial</span>}
            </div>
            <div class="d">
              {x.type === 'hosted'
                ? `Sin API key. Entrada ${perM(x.price_in_per_1m_micro)} · salida ${perM(x.price_out_per_1m_micro)} por 1M tokens`
                : `${x.provider === 'openai-compatible' ? 'URL base y API key' : 'Con tu API key'}. Fee de plataforma: entrada ${perM(x.price_in_per_1m_micro)} · salida ${perM(x.price_out_per_1m_micro)} por 1M tokens`}
            </div>
          </button>
        ))}
        <div class="info" style="margin-top:6px">Con tu propia API key, tu proveedor te cobra aparte por el uso. Zentekia cobra solo el fee de plataforma.</div>
        {!readOnly && sel !== current && (
          <div class="row" style="margin-top:6px">
            <button class="b b-primary" onClick={apply} disabled={busy || (m?.type === 'byok' && !key)}>Usar {m?.name}</button>
            {m?.type === 'byok' && !key && <span class="small muted">Primero guarda tu API key.</span>}
          </div>
        )}
      </div>
      <div class="col-side">
        {m?.type === 'byok' && (
          <div class="card">
            <div class="card-title">Conexión con {PROVIDER[m.provider]}</div>
            <form onSubmit={saveKey}>
              <fieldset disabled={readOnly} style="border:0;padding:0;margin:0">
                {m.provider === 'openai-compatible' && (
                  <>
                    <Field label="URL base" hint="Ej.: https://api.groq.com/openai/v1">
                      <input type="url" value={baseUrl} onInput={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" required={!key} />
                    </Field>
                    <Field label="Nombre del modelo">
                      <input value={modelName} onInput={(e) => setModelName(e.target.value)} placeholder="llama-3.3-70b-versatile" required={!key} />
                    </Field>
                  </>
                )}
                <Field label="API key">
                  {needsKey ? (
                    <input type="password" autocomplete="off" value={keyIn} onInput={(e) => setKeyIn(e.target.value)} placeholder={`${PREFIX[m.provider]}…`} required={!key} />
                  ) : (
                    <input class="mono" value={`${PREFIX[m.provider]}••••••••••••${key.last4}`} readOnly aria-label="API key guardada" />
                  )}
                </Field>
                <div class="row" style="margin-top:16px">
                  {needsKey || (m.provider === 'openai-compatible' && (baseUrl !== (key?.base_url || '') || modelName !== (key?.model_name || ''))) ? (
                    <button class="b b-primary" disabled={busy}>Guardar y probar</button>
                  ) : (
                    <>
                      <button type="button" class="b b-primary" onClick={testKey} disabled={busy}>Probar conexión</button>
                      <button type="button" class="b b-ghost" onClick={() => setReplacing(true)}>Reemplazar</button>
                    </>
                  )}
                  {key && !needsKey && !readOnly && (
                    <button type="button" class="link link-danger right" onClick={() => confirm('¿Borrar la llave? Los agentes que la usan regresarán a Qwen hosted.') && run(() => api.del(`keys/${key.id}`), 'Llave borrada').then(() => { models.reload(); agent.reload() })}>
                      Borrar
                    </button>
                  )}
                </div>
              </fieldset>
            </form>
            {test && <div class={'alert ' + (test.ok ? 'alert-ok' : 'alert-danger')} style="margin-top:12px">{test.message}</div>}
            {key && !test && key.status !== 'untested' && (
              <div class="small" style={`margin-top:10px;color:var(--${key.status === 'ok' ? 'ok' : 'danger'})`}>{key.status === 'ok' ? '✓ Última prueba correcta' : '✗ La última prueba falló'}</div>
            )}
            <div class="small muted" style="margin-top:10px">Tu llave se guarda cifrada y nunca se vuelve a mostrar completa.</div>
          </div>
        )}
        {m?.type === 'hosted' && (
          <div class="card">
            <div class="card-title">{m.name}</div>
            <div class="small muted" style="margin-top:6px">Corre en la infraestructura de Zentekia. No necesitas API key: el precio por token ya incluye todo.</div>
          </div>
        )}
        <div class="card">
          <div class="card-title">Costo del mes</div>
          <div class="small muted" style="margin-top:8px">Tokens consumidos: {num(d.month.tokens)}</div>
          <div class="small muted" style="margin-top:4px">
            Acumulado: {usd(d.month.cost_micro)}
            {d.month.limit_micro > 0 && ` de ${usd(d.month.limit_micro, 2)}`}
          </div>
          {d.month.limit_micro > 0 && (
            <div class={'bar' + (pct >= 100 ? ' over' : '')} style="margin-top:12px" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin="0" aria-valuemax="100">
              <div style={`width:${Math.max(pct, 1)}%`} />
            </div>
          )}
        </div>
        {!readOnly && d.keys.length > 0 && (
          <div class="card">
            <label class="check" style="margin-top:0">
              <input type="checkbox" checked={d.fallback_to_hosted} onChange={(e) => run(() => api.put(`agents/${agentId}/model`, { model_id: current, fallback_to_hosted: e.target.checked }), 'Guardado').then(models.reload)} />
              <span>Si tu proveedor falla, responder con Qwen hosted (se cobra según el modelo realmente usado).</span>
            </label>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Modelo(props) {
  return (
    <>
      <PageHead title="Modelo" sub="Elige qué modelo responde. Los precios se cobran por token consumido." />
      <ModelPicker {...props} />
    </>
  )
}
