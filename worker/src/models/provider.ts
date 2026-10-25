/*
  Interfaz común de proveedores de modelo.
  Cada adaptador devuelve deltas de texto y, al final, el uso { input_tokens, output_tokens }.
*/
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  system: string
  messages: ChatMessage[] // sin el system
  temperature: number
  maxTokens: number
}

export interface Credentials {
  apiKey?: string
  baseUrl?: string
}

export type ChatChunk = { type: 'delta'; text: string } | { type: 'usage'; input_tokens: number; output_tokens: number }

export interface TestResult {
  ok: boolean
  message: string
}

export interface ModelProvider {
  id: string
  stream(req: ChatRequest, creds: Credentials, signal?: AbortSignal): AsyncIterable<ChatChunk>
  testConnection(creds: Credentials, model?: string): Promise<TestResult>
}

/** Error del proveedor: el detalle se guarda para el owner, nunca se muestra al visitante */
export class ProviderError extends Error {
  constructor(
    public kind: 'auth' | 'quota' | 'unavailable' | 'bad_request' | 'timeout',
    message: string,
    public retryable = false,
  ) {
    super(message)
  }
}

export function classifyStatus(status: number, provider: string): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('auth', `${provider}: la API key no es válida o no tiene permisos.`)
  if (status === 402 || status === 429) return new ProviderError('quota', `${provider}: sin saldo o límite de uso alcanzado.`, status === 429)
  if (status === 400 || status === 404 || status === 422) return new ProviderError('bad_request', `${provider}: el modelo o la solicitud no son válidos (HTTP ${status}).`)
  return new ProviderError('unavailable', `${provider}: servicio no disponible (HTTP ${status}).`, status >= 500)
}

/** Lee un cuerpo SSE y entrega cada "data:" ya separado */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncIterable<{ event: string | null; data: string }> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let event: string | null = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (!line) {
          event = null
          continue
        }
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) yield { event, data: line.slice(5).trim() }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Estimación si el proveedor no reporta uso (~4 caracteres por token en español) */
export const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4))
