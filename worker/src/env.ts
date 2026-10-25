export interface Env {
  AI?: Ai
  DB: D1Database
  VECTORIZE?: VectorizeIndex
  FILES?: R2Bucket

  BASE_DOMAIN?: string
  TOTP_OBLIGATORIO?: string
  ADMIN_EMAIL?: string
  ADMIN_USER?: string
  ADMIN_PASSWORD?: string
  MASTER_KEY?: string
  RESEND_API_KEY?: string
  /** Voz: llave de ElevenLabs (secreto) */
  ELEVENLABS_API_KEY?: string
  /** Voz: lo que se le cobra al cliente por minuto en USD (por defecto 0.15) */
  VOICE_PRICE_PER_MIN?: string
  EMAIL_FROM?: string
  ALERT_EMAIL?: string
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET?: string
  /** Solo para pruebas locales: "true" reemplaza los modelos por respuestas simuladas */
  DEV_FAKE_AI?: string
}

export type Role = 'superadmin' | 'owner' | 'editor'
