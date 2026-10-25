/*
  Modelos y tarifas con los que arranca la plataforma.
  Las TARIFAS SON DE EJEMPLO: Erik las define en Admin → Tarifas (cada cambio crea una versión nueva
  y el histórico no se altera). Los modelos también se activan, retiran o agregan desde ahí.
  price = precio por 1M tokens (entrada, salida) en micro-USD para modelos hosted.
  fee   = fee de plataforma por 1M tokens (entrada, salida) en micro-USD para modelos BYOK.
*/
export interface SeedModel {
  id: string
  provider: 'workers-ai' | 'anthropic' | 'openai' | 'openai-compatible'
  model_name: string
  display_name: string
  type: 'hosted' | 'byok'
  context_window: number
  price: [number, number]
  fee: [number, number]
}

export const SEED_MODELS: SeedModel[] = [
  {
    id: 'qwen-hosted',
    provider: 'workers-ai',
    model_name: '@cf/qwen/qwen3-30b-a3b-fp8',
    display_name: 'Qwen hosted by Zentekia',
    type: 'hosted',
    context_window: 32000,
    price: [300_000, 1_200_000],
    fee: [0, 0],
  },
  {
    id: 'claude-sonnet',
    provider: 'anthropic',
    model_name: 'claude-sonnet-5-5',
    display_name: 'Claude Sonnet (Anthropic)',
    type: 'byok',
    context_window: 200000,
    price: [0, 0],
    fee: [200_000, 400_000],
  },
  {
    id: 'claude-haiku',
    provider: 'anthropic',
    model_name: 'claude-haiku-5-5',
    display_name: 'Claude Haiku (Anthropic)',
    type: 'byok',
    context_window: 200000,
    price: [0, 0],
    fee: [200_000, 400_000],
  },
  {
    id: 'openai-default',
    provider: 'openai',
    model_name: 'gpt-6-luna',
    display_name: 'OpenAI',
    type: 'byok',
    context_window: 128000,
    price: [0, 0],
    fee: [200_000, 400_000],
  },
  {
    id: 'openai-compatible',
    provider: 'openai-compatible',
    model_name: '',
    display_name: 'Compatible con OpenAI',
    type: 'byok',
    context_window: 32000,
    price: [0, 0],
    fee: [200_000, 400_000],
  },
]

export const HOSTED_DEFAULT_MODEL = 'qwen-hosted'
export const EMBEDDING_MODEL = '@cf/baai/bge-m3'

/** Límites por plan (los elige Erik al dar de alta al cliente) */
export const PLANS: Record<string, { name: string; maxSources: number; maxKbChars: number; recrawlsPerMonth: number; canHidePoweredBy: boolean; maxMessagesPerConversation: number; tenantPerMinute: number }> = {
  basico: { name: 'Básico', maxSources: 10, maxKbChars: 1_000_000, recrawlsPerMonth: 10, canHidePoweredBy: false, maxMessagesPerConversation: 40, tenantPerMinute: 120 },
  pro: { name: 'Pro', maxSources: 50, maxKbChars: 5_000_000, recrawlsPerMonth: 60, canHidePoweredBy: true, maxMessagesPerConversation: 80, tenantPerMinute: 400 },
  enterprise: { name: 'Enterprise', maxSources: 300, maxKbChars: 30_000_000, recrawlsPerMonth: 500, canHidePoweredBy: true, maxMessagesPerConversation: 150, tenantPerMinute: 1500 },
}

export const RESERVED_SLUGS = new Set(['chat', 'admin', 'api', 'app', 'www', 'mail', 'status', 'docs', 'cdn', 'assets', 'billing', 'support'])
