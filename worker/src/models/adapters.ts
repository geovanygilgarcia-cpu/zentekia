import type { Env } from '../env'
import {
  classifyStatus,
  ProviderError,
  sseLines,
  type ChatChunk,
  type ChatRequest,
  type Credentials,
  type ModelProvider,
  type TestResult,
} from './provider'

const TIMEOUT_MS = 30_000

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal | undefined, provider: string): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: sig })
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new ProviderError('timeout', `${provider}: no respondió a tiempo.`, true)
    throw new ProviderError('unavailable', `${provider}: no se pudo conectar.`, true)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const err = classifyStatus(res.status, provider)
    // El detalle del proveedor solo va al log del owner, recortado y sin la key
    ;(err as ProviderError & { detail?: string }).detail = detail.slice(0, 300)
    throw err
  }
  if (!res.body) throw new ProviderError('unavailable', `${provider}: respuesta vacía.`, true)
  return res
}

/* ---------------- Qwen hosted (Workers AI) ---------------- */

/** Quita bloques <think>…</think> aunque lleguen partidos entre trozos */
export function thinkFilter() {
  let inside = false
  let pending = ''
  return {
    push(text: string): string {
      let s = pending + text
      pending = ''
      let out = ''
      while (s) {
        if (inside) {
          const end = s.indexOf('</think>')
          if (end === -1) {
            pending = s.slice(-8)
            return out
          }
          s = s.slice(end + 8)
          inside = false
        } else {
          const start = s.indexOf('<think>')
          if (start === -1) {
            const cut = s.lastIndexOf('<')
            if (cut !== -1 && '<think>'.startsWith(s.slice(cut))) {
              pending = s.slice(cut)
              return out + s.slice(0, cut)
            }
            return out + s
          }
          out += s.slice(0, start)
          s = s.slice(start + 7)
          inside = true
        }
      }
      return out
    },
    flush(): string {
      const p = inside ? '' : pending
      pending = ''
      return p
    },
  }
}

export function workersAi(env: Env): ModelProvider {
  return {
    id: 'workers-ai',
    async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
      if (!env.AI) throw new ProviderError('unavailable', 'Workers AI no está conectado al Worker (binding AI).')
      const messages = [{ role: 'system', content: req.system }, ...req.messages]
      const last = messages[messages.length - 1]!
      // Qwen3 "piensa" antes de responder; /no_think lo desactiva para contestar rápido
      if (req.model.includes('qwen3')) messages[messages.length - 1] = { ...last, content: last.content + ' /no_think' }
      let stream: ReadableStream<Uint8Array>
      try {
        stream = (await env.AI.run(req.model as keyof AiModels, {
          messages,
          stream: true,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
        } as never)) as unknown as ReadableStream<Uint8Array>
      } catch (e) {
        throw new ProviderError('unavailable', 'Qwen hosted no está disponible en este momento.', true)
      }
      const filter = thinkFilter()
      let started = false
      for await (const { data } of sseLines(stream)) {
        if (data === '[DONE]') continue
        let j: { response?: unknown; choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        if (j.usage && (j.usage.prompt_tokens || j.usage.completion_tokens)) {
          yield { type: 'usage', input_tokens: j.usage.prompt_tokens ?? 0, output_tokens: j.usage.completion_tokens ?? 0 }
        }
        let t: unknown = j.response ?? j.choices?.[0]?.delta?.content ?? ''
        if (typeof t === 'number') {
          // Workers AI a veces manda números como número JSON: se toman tal cual del texto original
          const mm = data.match(/"(?:response|content)"\s*:\s*(-?\d[\d.eE+-]*)/)
          t = mm ? mm[1] : String(t)
        }
        if (typeof t !== 'string' || !t) continue
        let out = filter.push(t)
        if (!started) {
          out = out.replace(/^\s+/, '')
          if (out) started = true
        }
        if (out) yield { type: 'delta', text: out }
      }
      const rest = filter.flush()
      if (rest) yield { type: 'delta', text: rest }
    },
    async testConnection(): Promise<TestResult> {
      return env.AI ? { ok: true, message: 'Qwen hosted está disponible.' } : { ok: false, message: 'Falta el binding AI.' }
    },
  }
}

/* ---------------- Anthropic ---------------- */

export function anthropic(): ModelProvider {
  const base = 'https://api.anthropic.com/v1'
  const headers = (key: string) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' })
  return {
    id: 'anthropic',
    async *stream(req, creds, signal) {
      if (!creds.apiKey) throw new ProviderError('auth', 'Anthropic: falta la API key.')
      const res = await post(
        `${base}/messages`,
        headers(creds.apiKey),
        {
          model: req.model,
          system: req.system,
          messages: req.messages.filter((m) => m.role !== 'system'),
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stream: true,
        },
        signal,
        'Anthropic',
      )
      let input = 0
      let output = 0
      for await (const { data } of sseLines(res.body!)) {
        let j: {
          type?: string
          message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
          delta?: { type?: string; text?: string }
          usage?: { output_tokens?: number; input_tokens?: number }
          error?: { message?: string }
        }
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        if (j.type === 'message_start' && j.message?.usage) {
          const u = j.message.usage
          input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
          output = u.output_tokens ?? 0
        } else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta.text) {
          yield { type: 'delta', text: j.delta.text }
        } else if (j.type === 'message_delta' && j.usage) {
          output = j.usage.output_tokens ?? output
          if (j.usage.input_tokens) input = j.usage.input_tokens
        } else if (j.type === 'error') {
          throw new ProviderError('unavailable', 'Anthropic: error durante la respuesta.')
        }
      }
      if (input || output) yield { type: 'usage', input_tokens: input, output_tokens: output }
    },
    async testConnection(creds) {
      return testGet(`${base}/models`, headers(creds.apiKey ?? ''), 'Anthropic')
    },
  }
}

/* ---------------- OpenAI y compatibles ---------------- */

export function openaiLike(kind: 'openai' | 'openai-compatible'): ModelProvider {
  const name = kind === 'openai' ? 'OpenAI' : 'Proveedor compatible'
  const baseOf = (c: Credentials) => (kind === 'openai' ? 'https://api.openai.com/v1' : (c.baseUrl || '').replace(/\/+$/, ''))
  return {
    id: kind,
    async *stream(req, creds, signal) {
      if (!creds.apiKey) throw new ProviderError('auth', `${name}: falta la API key.`)
      const base = baseOf(creds)
      if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(base)) throw new ProviderError('bad_request', `${name}: la URL base debe empezar con https://`)
      const body: Record<string, unknown> = {
        model: req.model,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        stream: true,
        stream_options: { include_usage: true },
        temperature: req.temperature,
      }
      if (kind === 'openai') body.max_completion_tokens = req.maxTokens
      else body.max_tokens = req.maxTokens
      let res: Response
      try {
        res = await post(`${base}/chat/completions`, { Authorization: `Bearer ${creds.apiKey}` }, body, signal, name)
      } catch (e) {
        // Algunos modelos no aceptan temperature: se reintenta una vez sin ella
        if (e instanceof ProviderError && e.kind === 'bad_request' && /temperature/i.test((e as ProviderError & { detail?: string }).detail || '')) {
          delete body.temperature
          res = await post(`${base}/chat/completions`, { Authorization: `Bearer ${creds.apiKey}` }, body, signal, name)
        } else throw e
      }
      let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null
      for await (const { data } of sseLines(res.body!)) {
        if (data === '[DONE]') break
        let j: { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } | null }
        try {
          j = JSON.parse(data)
        } catch {
          continue
        }
        const t = j.choices?.[0]?.delta?.content
        if (t) yield { type: 'delta', text: t }
        if (j.usage) usage = j.usage
      }
      if (usage) yield { type: 'usage', input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 }
    },
    async testConnection(creds) {
      const base = baseOf(creds)
      if (!base) return { ok: false, message: 'Falta la URL base.' }
      return testGet(`${base}/models`, { Authorization: `Bearer ${creds.apiKey ?? ''}` }, name)
    },
  }
}

async function testGet(url: string, headers: Record<string, string>, name: string): Promise<TestResult> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    if (r.ok) return { ok: true, message: `Conexión correcta con ${name}.` }
    const e = classifyStatus(r.status, name)
    return { ok: false, message: e.message }
  } catch {
    return { ok: false, message: `${name}: no se pudo conectar.` }
  }
}

/* ---------------- Simulado (solo pruebas locales con DEV_FAKE_AI=true) ---------------- */

export function fakeProvider(id: string): ModelProvider {
  return {
    id,
    async *stream(req) {
      const q = req.messages[req.messages.length - 1]?.content ?? ''
      const fuentes = [...req.system.matchAll(/<fuente n="\d+" titulo="([^"]*)">/g)].map((m) => m[1])
      const ctx = fuentes.length ? ` (usé la base de conocimiento: ${fuentes.join(', ')})` : ''
      // Con la herramienta de finalizar activa, «adiós» simula que el modelo cierra (marca partida a propósito)
      const close = /adi[oó]s/i.test(q) && req.system.includes('[HERRAMIENTA: FINALIZAR')
      // Con «pasar a una persona» activa, «una persona» simula que el modelo pide ayuda humana
      const human = /una persona/i.test(q) && req.system.includes('[HERRAMIENTA: PASAR A UNA PERSONA]')
      const text = `Respuesta simulada de ${id}${ctx}: recibí «${q.slice(0, 60)}».` + (close ? '\n[FINAL' + 'IZAR]' : '') + (human ? '\n[HUM' + 'ANO]' : '')
      for (const w of close ? [...(text.split('[FINAL')[0]!.match(/\S+\s*/g) || []), '[FINAL', 'IZAR]'] : text.match(/\S+\s*/g) || []) yield { type: 'delta', text: w }
      yield { type: 'usage', input_tokens: Math.ceil((req.system.length + q.length) / 4), output_tokens: Math.ceil(text.length / 4) }
    },
    async testConnection(creds) {
      return creds.apiKey?.includes('bad') ? { ok: false, message: 'La API key no es válida.' } : { ok: true, message: 'Conexión correcta (simulada).' }
    },
  }
}
