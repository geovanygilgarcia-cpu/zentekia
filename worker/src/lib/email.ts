/*
  Correo opcional (invitaciones y alertas de consumo) vía Resend.
  Si no hay RESEND_API_KEY, no se manda nada: la liga de invitación se muestra en el panel para copiarla
  y las alertas quedan visibles en el portal y en el admin.
*/
import type { Env } from '../env'

export async function sendEmail(env: Env, to: string[], subject: string, text: string): Promise<boolean> {
  if (!env.RESEND_API_KEY || !to.length) return false
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM || 'Zentekia <no-reply@zentekia.com>', to, subject, text }),
      signal: AbortSignal.timeout(10_000),
    })
    return r.ok
  } catch {
    return false
  }
}
