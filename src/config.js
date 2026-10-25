/*
  Configuración del agente. Todo lo que cambia de un cliente a otro vive aquí.
  - apiUrl vacío  → modo demo (respuestas de ejemplo, sin servidor)
  - apiUrl con la URL de tu Worker de Cloudflare → respuestas reales del modelo abierto
  - agent: qué prompt usa el Worker en el chat (se administran en el panel /admin)
  - El chat pide entrar con el usuario y contraseña del panel (solo admins por ahora)
*/
const base = {
  accent: '#2f6bff',
  apiUrl: 'https://agente-zentekia.geovany-gil-garcia.workers.dev',
  model: 'Qwen3 30B (código abierto)',
  subtitle: 'En línea · responde al instante',
}

// Agentes disponibles: saludo y sugerencias de cada uno (el prompt vive en el panel)
export const agentes = [
  {
    agent: 'prakticall-ventas',
    etiqueta: 'Ventas',
    name: 'Asesor virtual',
    company: 'Prakticall',
    subtitle: 'Ventas · responde al instante',
    greeting:
      'Hola, soy tu asesor virtual. Estoy aquí para ayudarte a encontrar la mejor opción según lo que estés buscando. ¿Qué producto te interesa hoy?',
    quickReplies: ['Universidad', 'Seguros', 'Internet y telefonía', 'Crédito', 'Automóvil'],
    teaser: '¿Buscas la mejor opción? Te ayudo a elegir.',
  },
  {
    agent: 'prakticall-atencion',
    etiqueta: 'Atención a clientes',
    name: 'Asesor virtual',
    company: 'Prakticall',
    subtitle: 'Atención a clientes · en línea',
    greeting: 'Hola, con gusto te ayudo. ¿Tu consulta es sobre facturación, seguimiento de un caso o algún otro tema?',
    quickReplies: ['Facturación', 'Seguimiento de un caso', 'Otro tema'],
    teaser: '¿Tienes una duda? Con gusto te ayudo.',
  },
  {
    agent: 'prakticall-cobranza',
    etiqueta: 'Cobranza',
    name: 'Sofía',
    company: 'Finmax',
    subtitle: 'Asistente virtual de cobranza',
    greeting: 'Buenas tardes, le saluda Sofía de **Finmax**. Le escribo para platicar sobre su cuenta. ¿Hablo con el titular?',
    quickReplies: ['Sí, soy el titular', 'No soy el titular', 'Ya pagué'],
    teaser: 'Tiene un mensaje de Finmax sobre su cuenta.',
  },
  {
    agent: 'prakticall-reclutamiento',
    etiqueta: 'Reclutamiento',
    name: 'Asesor virtual',
    company: 'Prakticall',
    subtitle: 'Reclutamiento · responde al instante',
    greeting: 'Hola. Gracias por tu interés. Me gustaría ayudarte a encontrar una vacante adecuada. ¿En qué área te gustaría trabajar?',
    quickReplies: ['Ventas', 'Atención a clientes', 'Administración', 'No tengo experiencia'],
    teaser: '¿Buscas trabajo? Te ayudo a encontrar una vacante.',
  },
]

export const configDe = (agent) => ({ ...base, ...(agentes.find((a) => a.agent === agent) || agentes[0]) })
export const defaultConfig = configDe('prakticall-ventas')
