/*
  Base de conocimiento (RAG)
  Ingesta: archivo/URL/texto → texto limpio (Workers AI toMarkdown para PDF/DOCX/HTML) → chunks de ~500 tokens
           con 12 % de solape → embeddings (bge-m3) → Vectorize en el namespace del cliente.
  Se procesa por lotes con límite de tiempo: lo que no alcance se continúa en la siguiente consulta del portal
  o en la tarea programada (cada 10 min). Sin Vectorize se usa búsqueda por palabras en D1.
  Recuperación: top-k SOLO en el namespace del cliente y, además, se vuelve a filtrar en D1 por tenant y agente.
*/
import type { Env } from '../env'
import type { TenantRepo } from '../db/tenant-repo'
import { EMBEDDING_MODEL } from '../db/seed'
import { ProviderError } from '../models/provider'

const CHUNK_CHARS = 2000 // ~500 tokens
const OVERLAP_CHARS = 250 // ~12 %
const EMBED_BATCH = 40
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const ALLOWED_EXT = ['pdf', 'docx', 'txt', 'md', 'csv', 'html', 'htm']

export const estimateTokens = (s: string) => Math.ceil(s.length / 4)

export function chunkText(text: string): { title: string | null; text: string }[] {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []
  const paras = clean.split(/\n\n+/)
  const chunks: { title: string | null; text: string }[] = []
  let cur = ''
  let title: string | null = null
  let curTitle: string | null = null
  const push = () => {
    if (cur.trim()) chunks.push({ title: curTitle, text: cur.trim() })
  }
  for (const p of paras) {
    const h = p.match(/^#{1,6}\s+(.+)$/m)
    if (h) title = h[1]!.slice(0, 120)
    // Párrafos gigantes se cortan por oraciones
    const pieces = p.length > CHUNK_CHARS ? p.match(/[^.!?\n]+[.!?\n]*\s*/g) || [p] : [p]
    for (const piece of pieces) {
      if (cur.length + piece.length > CHUNK_CHARS && cur) {
        push()
        cur = cur.slice(-OVERLAP_CHARS) + '\n\n'
      }
      if (!cur.trim()) curTitle = title
      cur += piece + (pieces.length === 1 ? '\n\n' : '')
      while (cur.length > CHUNK_CHARS * 1.5) {
        chunks.push({ title: curTitle, text: cur.slice(0, CHUNK_CHARS).trim() })
        cur = cur.slice(CHUNK_CHARS - OVERLAP_CHARS)
      }
    }
  }
  push()
  return chunks
}

export async function extractFile(env: Env, name: string, bytes: Uint8Array, mime: string): Promise<string> {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['txt', 'md', 'csv'].includes(ext)) return new TextDecoder().decode(bytes)
  if (!env.AI || env.DEV_FAKE_AI === 'true') {
    if (ext === 'html' || ext === 'htm') return htmlToText(new TextDecoder().decode(bytes))
    throw new Error('No hay conversor de documentos disponible (binding AI).')
  }
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' })
  const res = (await env.AI.toMarkdown([{ name, blob }])) as unknown as { format?: string; data?: string; error?: string }[]
  const r = res[0]
  if (!r || r.format === 'error' || !r.data) throw new Error('No pude leer el contenido del archivo. Si es un PDF escaneado, súbelo como texto.')
  return r.data
}

export async function fetchUrlText(env: Env, url: string): Promise<{ title: string; text: string }> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('La URL no es válida.')
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('La URL debe empezar con http:// o https://')
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || u.hostname.endsWith('.internal')) throw new Error('Esa dirección no está permitida.')
  let r: Response
  try {
    r = await fetch(u.toString(), { headers: { 'User-Agent': 'ZentekiaChatBot/1.0 (+https://zentekia.com)' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new Error('No pude abrir la página. Revisa que sea pública.')
  }
  if (!r.ok) throw new Error(`La página respondió con error ${r.status}.`)
  const buf = new Uint8Array(await r.arrayBuffer())
  if (buf.length > 3_000_000) throw new Error('La página es demasiado grande (máx. 3 MB).')
  const ctype = r.headers.get('Content-Type') || ''
  const raw = new TextDecoder().decode(buf)
  const title = (raw.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1] || u.hostname).trim()
  if (ctype.includes('pdf')) return { title, text: await extractFile(env, 'pagina.pdf', buf, 'application/pdf') }
  if (!ctype.includes('html')) return { title, text: raw }
  return { title, text: htmlToText(raw) }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '')}\n\n`)
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** Avanza el procesamiento de una fuente dentro de un presupuesto de tiempo */
export async function processSource(env: Env, repo: TenantRepo, sourceId: string, budgetMs = 20_000): Promise<void> {
  const start = Date.now()
  const src = await repo.source(sourceId)
  if (!src || src.status === 'ready' || src.status === 'error') return
  try {
    if (src.status === 'queued') {
      if (src.type === 'url' && !src.raw_text) {
        const { text } = await fetchUrlText(env, src.url!)
        src.raw_text = text
      }
      const text = src.raw_text || ''
      if (text.trim().length < 20) throw new Error('No encontré texto útil en esta fuente.')
      const chunks = chunkText(text)
      await repo.deleteChunks(sourceId)
      await repo.insertChunks(sourceId, src.agent_id, chunks)
      await repo.updateSource(sourceId, { status: 'processing', raw_text: text, tokens_est: estimateTokens(text), chunk_count: chunks.length, error: null })
    }
    while (Date.now() - start < budgetMs) {
      const pending = await repo.pendingChunks(sourceId, EMBED_BATCH)
      if (!pending.length) break
      if (env.VECTORIZE && env.AI && env.DEV_FAKE_AI !== 'true') {
        const emb = (await env.AI.run(EMBEDDING_MODEL as keyof AiModels, { text: pending.map((c) => (c.title ? `${c.title}\n` : '') + c.text) } as never)) as unknown as { data: number[][] }
        await env.VECTORIZE.upsert(
          pending.map((c, i) => ({
            id: c.id,
            values: emb.data[i]!,
            namespace: repo.tenantId,
            metadata: { tenant_id: repo.tenantId, agent_id: c.agent_id, source_id: c.source_id },
          })),
        )
      }
      await repo.markEmbedded(pending.map((c) => c.id))
    }
    if ((await repo.countPending(sourceId)) === 0) await repo.updateSource(sourceId, { status: 'ready', error: null })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error al procesar.'
    await repo.updateSource(sourceId, { status: 'error', error: msg.slice(0, 300) })
  }
}

export async function deleteVectors(env: Env, ids: string[]) {
  if (!env.VECTORIZE || !ids.length) return
  for (let i = 0; i < ids.length; i += 500) await env.VECTORIZE.deleteByIds(ids.slice(i, i + 500))
}

export interface RetrievedChunk {
  id: string
  text: string
  title: string | null
  source_name: string
  source_url: string | null
}

const STOP = new Set('para como cual cuál cuando cuándo donde dónde desde entre esta este esto estos estas tiene tienen quiero puedo pueden sobre porque hola gracias usted ustedes ellos ellas tengo hacer cómo como qué que cuánto cuanto'.split(' '))

export async function retrieve(env: Env, repo: TenantRepo, agentId: string, question: string, k = 5): Promise<RetrievedChunk[]> {
  if (!(await repo.hasReadyKb(agentId))) return []
  if (env.VECTORIZE && env.AI && env.DEV_FAKE_AI !== 'true') {
    try {
      const emb = (await env.AI.run(EMBEDDING_MODEL as keyof AiModels, { text: [question.slice(0, 2000)] } as never)) as unknown as { data: number[][] }
      const res = await env.VECTORIZE.query(emb.data[0]!, { topK: k * 2, namespace: repo.tenantId, returnMetadata: 'none' })
      const ids = res.matches.filter((m) => m.score > 0.35).map((m) => m.id)
      const rows = await repo.chunksByIds(agentId, ids)
      const byId = new Map(rows.map((r) => [r.id, r]))
      return ids.map((x) => byId.get(x)).filter((x): x is NonNullable<typeof x> => Boolean(x)).slice(0, k)
    } catch (e) {
      if (e instanceof ProviderError) throw e
      console.error(JSON.stringify({ level: 'warn', msg: 'vectorize_query_failed', tenant_id: repo.tenantId }))
    }
  }
  // Respaldo: búsqueda por palabras clave
  const terms = [...new Set(question.toLowerCase().match(/[\p{L}0-9]{4,}/gu) || [])].filter((t) => !STOP.has(t)).slice(0, 8)
  const cands = await repo.keywordCandidates(agentId, terms)
  const scored = cands
    .map((c) => {
      const low = c.text.toLowerCase()
      return { c, s: terms.reduce((acc, t) => acc + (low.split(t).length - 1), 0) }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  return scored.slice(0, k).map((x) => x.c)
}
