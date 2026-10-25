export interface TenantRow {
  id: string
  slug: string
  name: string
  status: 'active' | 'suspended'
  plan_id: string
  monthly_limit_micro: number
  currency: string
  limit_behavior: 'block' | 'allow'
  enabled_models: string
  retention_days: number
  suspended_message: string | null
  fallback_to_hosted: number
  turnstile: number
  data_key_enc: string | null
  onboarded: number
  created_at: number
}

export interface UserRow {
  id: string
  tenant_id: string | null
  email: string
  name: string | null
  role: 'superadmin' | 'owner' | 'editor'
  password_hash: string | null
  totp_secret_enc: string | null
  totp_enabled: number
  status: 'active' | 'invited' | 'disabled'
  created_at: number
  last_login_at: number | null
}

export interface SessionRow {
  id_hash: string
  user_id: string
  tenant_id: string | null
  kind: 'admin' | 'portal'
  csrf: string
  mfa_ok: number
  impersonator_id: string | null
  read_only: number
  expires_at: number
  created_at: number
  ip: string | null
}

export interface AgentConfig {
  tone?: string
  fallback_response?: string
  suggested_questions?: string[]
  template?: string
  business_name?: string
  business_description?: string
  show_sources?: boolean
  /** El agente puede cerrar la conversación por su cuenta con la herramienta finalizar */
  auto_end?: boolean
  /** Cuándo debe usarla (lo escribe el cliente) */
  end_when?: string
  /** Qué cuenta como prospecto para este negocio (lo escribe el cliente; guía al análisis) */
  lead_criteria?: string
  /** Datos que el agente debe intentar pedir (nombre, teléfono, correo…) */
  lead_fields?: Array<'name' | 'phone' | 'email' | 'company'>
  /** Aviso por correo a los owners: 'hot' = solo calientes, 'warm' = calientes y tibios, 'off' = nunca */
  lead_alerts?: 'off' | 'hot' | 'warm'
  /** Canal de chat (texto). Por defecto activo; se puede apagar para un asistente solo de voz. */
  chat_enabled?: boolean
  /** Canal de voz (ElevenLabs Agents) */
  voice?: VoiceConfig
}

/** ¿El asistente atiende por chat (texto)? */
export const chatEnabled = (agent: Pick<AgentRow, 'config_json'>) => parseJson<AgentConfig>(agent.config_json, {}).chat_enabled !== false

export interface VoiceConfig {
  enabled?: boolean
  voice_id?: string
  voice_name?: string
  /** eleven_flash_v2_5 (más rápida) | eleven_v4_turbo (más expresiva) */
  model?: string
  /** 0.7 a 1.2 */
  speed?: number
  /** patient | normal | eager */
  eagerness?: string
  /** Saludo al contestar (si no, el mensaje de bienvenida del chat) */
  first_message?: string
  el_agent_id?: string
  el_tool_id?: string
  synced_at?: number
  sync_error?: string | null
}

export interface AgentRow {
  id: string
  tenant_id: string
  name: string
  system_prompt: string
  welcome_message: string
  language: string
  temperature: number
  model_id: string
  provider_key_id: string | null
  config_json: string
  created_at: number
  updated_at: number
}

export interface WidgetTheme {
  appearance?: 'oscuro' | 'claro'
  assistant_name?: string
  header_title?: string
  header_subtitle?: string
  primary?: string
  secondary?: string
  background?: string
  text?: string
  user_bubble?: string
  user_text?: string
  agent_bubble?: string
  agent_text?: string
  position?: 'right' | 'left'
  margin_x?: number
  margin_y?: number
  button_size?: number
  placeholder?: string
  error_message?: string
  privacy_notice?: string
  privacy_required?: boolean
  auto_open_delay?: number
  sound?: boolean
  show_powered_by?: boolean
  hours_enabled?: boolean
  hours_timezone?: string
  hours_days?: number[]
  hours_start?: string
  hours_end?: string
  offline_message?: string
  logo_version?: number
}

export interface WidgetRow {
  id: string
  tenant_id: string
  agent_id: string
  widget_key: string
  allowed_origins: string
  theme_json: string
  logo_data: string | null
  version: number
  updated_at: number
}

export interface ProviderKeyRow {
  id: string
  tenant_id: string
  provider: string
  secret_enc: string
  last4: string
  base_url: string | null
  model_name: string | null
  status: string
  tested_at: number | null
  created_at: number
}

export interface KbSourceRow {
  id: string
  tenant_id: string
  agent_id: string
  type: 'pdf' | 'docx' | 'txt' | 'url' | 'text' | 'file'
  name: string
  url: string | null
  status: 'queued' | 'processing' | 'ready' | 'error'
  error: string | null
  r2_key: string | null
  raw_text: string | null
  tokens_est: number
  chunk_count: number
  recrawl_count: number
  recrawl_period: string | null
  created_at: number
  updated_at: number
}

export interface KbChunkRow {
  id: string
  tenant_id: string
  source_id: string
  agent_id: string
  seq: number
  title: string | null
  text: string
  vector_id: string | null
  embedded: number
}

export interface ConversationRow {
  id: string
  tenant_id: string
  agent_id: string
  visitor_id: string
  origin: string | null
  country: string | null
  title: string | null
  started_at: number
  last_message_at: number
  message_count: number
  ended_at: number | null
  ended_by: string | null
  rating: number | null
  channel?: string | null
  summary?: string | null
  lead_status?: LeadStatus | null
  lead_score?: number | null
  lead_stage?: LeadStage
  contact_name?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  contact_company?: string | null
  interest?: string | null
  next_step?: string | null
  analyzed_at?: number | null
  analysis_attempts?: number
  lead_notified?: number
}

export type LeadStatus = 'hot' | 'warm' | 'cold' | 'none'
export type LeadStage = 'new' | 'contacted' | 'won' | 'lost'

export interface MessageRow {
  id: string
  tenant_id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  tokens_in: number
  tokens_out: number
  model_id: string | null
  estimated: number
  feedback: number | null
  sources_json: string | null
  created_at: number
}

export interface ModelRow {
  id: string
  provider: 'workers-ai' | 'anthropic' | 'openai' | 'openai-compatible'
  model_name: string
  display_name: string
  type: 'hosted' | 'byok'
  active: number
  context_window: number
  sort: number
}

export interface PriceRow {
  id: string
  model_id: string
  input_per_1m_micro: number
  output_per_1m_micro: number
  fee_input_per_1m_micro: number
  fee_output_per_1m_micro: number
  effective_from: number
}

export interface OverrideRow {
  id: string
  tenant_id: string
  model_id: string
  input_per_1m_micro: number | null
  output_per_1m_micro: number | null
  fee_input_per_1m_micro: number | null
  fee_output_per_1m_micro: number | null
  discount_pct: number | null
  effective_from: number
}

export interface StatementRow {
  id: string
  tenant_id: string
  period: string
  tokens_in: number
  tokens_out: number
  total_micro: number
  status: 'draft' | 'issued' | 'paid'
  lines_json: string
  generated_at: number
  paid_at: number | null
}

export interface AlertRow {
  id: string
  tenant_id: string
  kind: string
  period: string
  message: string
  created_at: number
  read_at: number | null
}

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

export const periodOf = (t: number) => new Date(t).toISOString().slice(0, 7)
export const periodRange = (period: string): [number, number] => {
  const [y, m] = period.split('-').map(Number) as [number, number]
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)]
}

export interface VoiceCallRow {
  id: string
  tenant_id: string
  agent_id: string
  visitor_id: string
  origin: string | null
  conversation_id: string | null
  status: 'pending' | 'saving' | 'saved' | 'failed'
  attempts: number
  created_at: number
}
