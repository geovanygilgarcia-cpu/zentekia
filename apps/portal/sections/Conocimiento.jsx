import { useEffect, useRef, useState } from 'preact/hooks'
import { num, date } from '../../shared/api.js'
import { Field, Loading, PageHead, useAction, useLoad } from './common.jsx'

const STATUS = {
  queued: ['En cola', 'badge'],
  processing: ['Procesando', 'badge badge-warn'],
  ready: ['Listo', 'badge badge-ok'],
  error: ['Error', 'badge badge-danger'],
}
const TYPE = { pdf: 'PDF', docx: 'Word', file: 'Archivo', url: 'Página web', text: 'Texto' }

export function KnowledgeBase({ api, agentId, readOnly }) {
  const { data, error, reload } = useLoad(() => api.get(`kb?agent=${agentId}`), [agentId])
  const [tab, setTab] = useState('file')
  const [busy, run] = useAction()
  const [url, setUrl] = useState('')
  const [tName, setTName] = useState('')
  const [tText, setTText] = useState('')
  const fileRef = useRef(null)

  const pending = data?.sources.some((s) => s.status === 'queued' || s.status === 'processing')
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(reload, 3000)
    return () => clearTimeout(t)
  }, [data])

  if (!data) return <Loading error={error} />

  const upload = async (e) => {
    e.preventDefault()
    const f = fileRef.current?.files?.[0]
    if (!f) return
    const fd = new FormData()
    fd.append('agent_id', agentId)
    fd.append('file', f)
    const r = await run(() => api.post('kb/file', fd), 'Archivo agregado')
    if (r) {
      fileRef.current.value = ''
      reload()
    }
  }
  const addUrl = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post('kb/url', { agent_id: agentId, url }), 'Página agregada')
    if (r) {
      setUrl('')
      reload()
    }
  }
  const addText = async (e) => {
    e.preventDefault()
    const r = await run(() => api.post('kb/text', { agent_id: agentId, name: tName, text: tText }), 'Texto agregado')
    if (r) {
      setTName('')
      setTText('')
      reload()
    }
  }
  const L = data.limits
  return (
    <>
      {!readOnly && (
        <div class="card">
          <div class="tabs" role="tablist">
            {[
              ['file', 'Subir archivo'],
              ['url', 'Página web'],
              ['text', 'Texto libre'],
            ].map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} class={tab === id ? 'on' : ''} onClick={() => setTab(id)} type="button">{label}</button>
            ))}
          </div>
          {tab === 'file' && (
            <form onSubmit={upload}>
              <Field label="Archivo" hint="PDF, Word (DOCX), TXT, CSV o HTML. Máximo 10 MB.">
                <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,.csv,.html,.htm" class="in" required />
              </Field>
              <button class="b b-primary" style="margin-top:14px" disabled={busy}>{busy ? 'Leyendo archivo…' : 'Agregar archivo'}</button>
            </form>
          )}
          {tab === 'url' && (
            <form onSubmit={addUrl}>
              <Field label="Dirección de la página" hint="Debe ser pública. Puedes volver a leerla después si cambia (re-rastreo).">
                <input type="url" value={url} onInput={(e) => setUrl(e.target.value)} placeholder="https://misitio.com/preguntas-frecuentes" required />
              </Field>
              <button class="b b-primary" style="margin-top:14px" disabled={busy}>Agregar página</button>
            </form>
          )}
          {tab === 'text' && (
            <form onSubmit={addText}>
              <Field label="Título">
                <input value={tName} onInput={(e) => setTName(e.target.value)} maxLength={120} placeholder="Horarios y sucursales" required />
              </Field>
              <Field label="Contenido">
                <textarea rows="7" value={tText} onInput={(e) => setTText(e.target.value)} placeholder="Pega aquí preguntas frecuentes, políticas, precios…" required />
              </Field>
              <button class="b b-primary" style="margin-top:14px" disabled={busy}>Agregar texto</button>
            </form>
          )}
        </div>
      )}
      <div class="card">
        <div class="row">
          <div class="card-title grow">Fuentes</div>
          <span class="small muted">
            {L.used_sources} de {L.max_sources} fuentes · {num(Math.round(L.used_chars / 4))} de {num(Math.round(L.max_chars / 4))} tokens
          </span>
        </div>
        {!data.vector_search && <div class="small muted" style="margin-top:6px">Búsqueda por palabras clave (la búsqueda semántica se activa cuando Zentekia conecta Vectorize).</div>}
        {data.sources.length === 0 ? (
          <div class="empty">Todavía no hay fuentes. Agrega un PDF, una página o texto para que tu agente responda con tu información.</div>
        ) : (
          <div class="tbl-wrap" style="margin-top:8px">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Fuente</th>
                  <th>Tipo</th>
                  <th>Estado</th>
                  <th class="num">Tokens</th>
                  <th class="num">Fragmentos</th>
                  <th>Actualizada</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={s.id}>
                    <td style="max-width:280px;word-break:break-word">
                      {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a> : s.name}
                      {s.error && <div class="small" style="color:var(--danger);margin-top:2px">{s.error}</div>}
                    </td>
                    <td>{TYPE[s.type] || s.type}</td>
                    <td><span class={STATUS[s.status]?.[1]}>{STATUS[s.status]?.[0]}</span></td>
                    <td class="num">{num(s.tokens_est)}</td>
                    <td class="num">{num(s.chunk_count)}</td>
                    <td class="nowrap small">{date(s.updated_at)}</td>
                    <td class="nowrap">
                      {!readOnly && (
                        <>
                          <button class="link" onClick={() => run(() => api.post(`kb/${s.id}/reprocess`), s.type === 'url' ? 'Página leída de nuevo' : 'Fuente reprocesada').then(reload)}>
                            {s.type === 'url' ? 'Re-rastrear' : 'Reprocesar'}
                          </button>
                          {'  '}
                          <button class="link link-danger" style="margin-left:10px" onClick={() => confirm(`¿Borrar «${s.name}»?`) && run(() => api.del(`kb/${s.id}`), 'Fuente borrada').then(reload)}>
                            Borrar
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

export default function Conocimiento(props) {
  return (
    <>
      <PageHead title="Conocimiento" sub="Documentos y páginas que tu agente consulta para responder. Solo los usa tu agente." />
      <KnowledgeBase {...props} />
    </>
  )
}
