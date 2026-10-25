import { useState } from 'preact/hooks'
import { toast } from '../../shared/toast.jsx'
import { CHAT_ORIGIN } from '../env.js'
import { Field, PageHead, TestWidget, useAction } from './common.jsx'

export const snippetFor = (key) => `<script src="${CHAT_ORIGIN}/widget.js" data-key="${key}" async></script>`

const GUIDES = {
  html: ['HTML', ['Abre el archivo de tu página (o la plantilla que se repite en todas).', 'Pega el código justo antes de la etiqueta </body>.', 'Guarda y publica. La burbuja aparece en la esquina.']],
  wordpress: ['WordPress', ['Instala el plugin gratuito «WPCode» (Insert Headers and Footers).', 'Ve a Code Snippets → Header & Footer.', 'Pega el código en «Footer» y guarda.']],
  shopify: ['Shopify', ['En tu panel: Tienda online → Temas → ⋯ → Editar código.', 'Abre layout/theme.liquid.', 'Pega el código justo antes de </body> y guarda.']],
  wix: ['Wix', ['Ve a Configuración → Código personalizado (requiere plan Premium).', 'Agrega código, pégalo y elige «Todas las páginas» y «Body - end».', 'Aplica y publica tu sitio.']],
}

export function Snippet({ widgetKey }) {
  const code = snippetFor(widgetKey)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      toast('Código copiado')
    } catch {
      toast('Selecciona el código y cópialo con Ctrl+C')
    }
  }
  return (
    <div>
      <code class="snip" style="user-select:all">{code}</code>
      <button class="b b-primary" style="margin-top:12px" onClick={copy} type="button">Copiar código</button>
    </div>
  )
}

export default function Instalacion({ api, agent, agentId, go, me }) {
  const [g, setG] = useState('html')
  const [url, setUrl] = useState('')
  const [res, setRes] = useState(null)
  const [busy, run] = useAction()
  const [testing, setTesting] = useState(false)
  const verify = async (e) => {
    e.preventDefault()
    setRes(null)
    const r = await run(() => api.post('install/verify', { url, agent_id: agentId }))
    if (r) setRes(r)
  }
  return (
    <>
      <PageHead title="Instalación" sub="Copia una línea, pégala en tu sitio y listo. Los cambios del portal se aplican solos, sin reinstalar." />
      <div class="cols">
        <div class="col-main">
          <div class="card">
            <div class="card-title">Tu código</div>
            <div class="small muted" style="margin:4px 0 12px">Para el agente «{agent?.name}».</div>
            <Snippet widgetKey={agent?.widget_key} />
            {me.user.role === 'owner' && (
              <div class="info" style="margin-top:14px">
                El widget solo funciona en los dominios que autorices en <button class="link" style="color:inherit" onClick={() => go('seguridad')}>Seguridad</button>.
              </div>
            )}
          </div>
          <div class="card">
            <div class="tabs" role="tablist">
              {Object.entries(GUIDES).map(([id, [label]]) => (
                <button key={id} role="tab" aria-selected={g === id} class={g === id ? 'on' : ''} onClick={() => setG(id)} type="button">{label}</button>
              ))}
            </div>
            <ol style="margin:0;padding-left:20px;line-height:1.9">
              {GUIDES[g][1].map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        </div>
        <div class="col-side">
          <div class="card">
            <div class="card-title">Verificar instalación</div>
            <form onSubmit={verify}>
              <Field label="Dirección de tu sitio">
                <input value={url} onInput={(e) => setUrl(e.target.value)} placeholder="https://misitio.com" required />
              </Field>
              <button class="b b-primary" style="margin-top:14px" disabled={busy}>{busy ? 'Revisando…' : 'Verificar'}</button>
            </form>
            {res && <div class={'alert ' + (res.found && res.domain_allowed ? 'alert-ok' : 'alert-warn')} style="margin-top:12px">{res.message}</div>}
          </div>
          <div class="card">
            <div class="card-title">Probar el chat real</div>
            <div class="small muted" style="margin:4px 0 12px">Habla con tu agente tal como lo verán tus visitantes (consume tokens).</div>
            <button class="b b-outline" onClick={() => setTesting(true)}>Abrir chat de prueba</button>
            {testing && <TestWidget widgetKey={agent?.widget_key} title="Prueba del chat" onClose={() => setTesting(false)} />}
          </div>
        </div>
      </div>
    </>
  )
}
