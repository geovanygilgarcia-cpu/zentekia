# Zentekia Chat · plataforma multicliente (fase 1)

Un solo Worker de Cloudflare con cuatro partes:

| Parte | Dónde vive (workers.dev) | Dónde vive (con tu dominio) |
|---|---|---|
| Panel de superadmin (Clientes, Tarifas, Consumo, Auditoría) | `/admin/` | `admin.zentekia.com` |
| Portal de cada cliente | `/p/<slug>/` | `<slug>.zentekia.com` |
| Widget que se pega en el sitio del cliente | `/widget.js` | `chat.zentekia.com/widget.js` |
| API pública del chat | `/v1/...` | `chat.zentekia.com/v1/...` |

Instalación en el sitio del cliente (una línea):

```html
<script src="https://chat.zentekia.com/widget.js" data-key="pk_live_xxxxx" async></script>
```

## Qué incluye

- **Clientes (tenants) aislados**: el `tenant_id` siempre sale del servidor (llave del widget validada o sesión del portal).
  Todas las consultas pasan por `worker/src/db/tenant-repo.ts`, que agrega `tenant_id` a cada una.
  Vectores en un namespace por cliente y un segundo filtro en D1. Pruebas automáticas de aislamiento en `tests/`.
- **Acceso**: correo + contraseña (PBKDF2-SHA256, 100 000 iteraciones), TOTP obligatorio para superadmin y owners,
  cookies `__Host-` HttpOnly/Secure/SameSite=Lax, CSRF en cada cambio, roles owner/editor,
  e impersonación de soporte en solo lectura y con auditoría.
- **Widget**: iframe aislado con `frame-ancestors` igual a los dominios permitidos de cada cliente,
  token de conversación firmado de 30 min, streaming (SSE), Markdown seguro sin HTML del modelo,
  historial por visitante, pulgar arriba/abajo, horario de atención, aviso de privacidad y Turnstile opcional.
- **Modelos**: Qwen hosted (Workers AI), Claude, OpenAI y compatibles con OpenAI usando la API key del cliente.
  La key se cifra con AES-256-GCM en sobre (MASTER_KEY → data key por cliente → key).
  Solo se ven los últimos 4 caracteres y hay un botón «Probar conexión».
  Si el cliente lo activa, cuando su proveedor falla responde Qwen hosted.
- **Base de conocimiento**: PDF/DOCX/TXT/CSV/HTML, URL con re-rastreo y texto libre.
  Se parte en fragmentos de ~500 tokens con 12 % de solape, se convierte en vectores con bge-m3 y se guarda en Vectorize.
  Sin Vectorize usa búsqueda por palabras.
- **Cobro por token**: registro de consumo con la versión de tarifa usada, fee de plataforma en BYOK,
  precios especiales por cliente, límite mensual con alertas al 80 % y al 100 %, bloqueo amable,
  estados de cuenta mensuales (borrador → emitido → pagado) y CSV.
- **Auditoría inmutable**: los triggers de D1 rechazan UPDATE y DELETE.
- **Prakticall**: al dar de alta el cliente `prakticall` puedes importar sus 4 agentes de chat.
  Si la base todavía tiene los prompts que editaste en la versión anterior (`legacy_prompts`), se usan esos.

## Bandeja omnicanal · fase 1 (web chat con personas)

Implementa la fase 1 de la *Especificación técnica: plataforma omnicanal Zentekia*: personas del equipo
atienden en vivo las conversaciones que la IA escala, con traspaso en los dos sentidos.

- **Estados** (`conversations.status`): `ai_active` → `waiting_human` → `human_active` → `closed`, y de regreso a `ai_active`.
  La regla de que la IA no responde con una persona vive en el servidor (`routes/widget.ts`), no en el prompt.
- **Disparadores** (Herramientas → Pasar a una persona → «Pasar a la Bandeja»): la marca `[HUMANO]` del agente IA,
  frases del visitante («hablar con una persona»…) y máximo de respuestas de la IA. Cola, mensajes, espera máxima
  y qué hacer sin nadie disponible (sigue la IA o se queda en la cola) se configuran por asistente.
- **Reparto**: agente en línea, con capacidad libre y de la cola; gana el de menos carga y, si empatan, el que lleva
  más tiempo sin recibir una. Dos agentes nunca toman la misma (UPDATE condicional en D1). Si un agente se
  desconecta más de 60 s, sus conversaciones vuelven a la cola.
- **Tiempo real**: `InboxHubDO` (uno por cliente: WebSockets de la bandeja, presencia y reparto; también hace el papel
  del QueueDO del spec) y `ConversationDO` (uno por conversación: WebSocket del visitante y alarma de espera).
  Los eventos de la bandeja solo llevan ids; cada agente vuelve a pedir lo que su rol le deja ver.
- **Timeline**: `messages.kind` = `text` · `notice` (aviso que ve el visitante) · `note` (nota interna) · `event` (evento interno).
  Notas y eventos nunca llegan al widget ni al modelo.
- **Roles nuevos**: `supervisor` (ve todo, reasigna, interviene conversaciones de la IA) y `agent` (sus conversaciones,
  las de sus colas y las sin cola). Ambos solo entran a la Bandeja y a Mi cuenta.
- **Portal**: sección Bandeja (lista con filtros, chat con notas y respuestas rápidas con `/`, panel del contacto con el
  resumen de la IA, tomar, transferir, devolver a la IA, cerrar) y pestaña de equipo, colas, respuestas rápidas y métricas
  (tiempo hasta asignar, primera respuesta, resueltas solo por la IA).
- **API**: `worker/src/routes/inbox.ts`. Núcleo: `worker/src/inbox/core.ts`. Datos: `worker/src/db/inbox-repo.ts` (migración v9).

## Productos: Agentes virtuales y Contact Center

Zentekia vende dos productos y en el panel de administración (Clientes → nuevo o detalle) se le activan a cada cliente
uno, otro o los dos (`tenants.products_json`, migración v11):

- **Agentes virtuales**: el portal de siempre (asistentes de IA, cobro por uso).
- **Contact Center**: aplicación aparte en `/cc/` del portal del cliente (`cliente.zentekia.com/cc/`), con el mismo
  inicio de sesión. Ahí entran los agentes humanos: se ponen en línea, reciben chats de la web y de WhatsApp, los atienden,
  transfieren y cierran. Secciones: Bandeja (pantalla completa), Supervisión (equipo en línea, colas, respuestas rápidas,
  métricas), Canales, Equipo y licencias, Seguridad y Mi cuenta.
  - **Se cobra por licencia de agente humano**: cada usuario con rol «agente» o «supervisor» ocupa una. No se puede invitar
    a más de las contratadas. El cierre de periodo agrega la línea «Licencias de Contact Center» (licencias × precio; precio
    especial por cliente o el general de `DEFAULT_SEAT_PRICE_MICRO`, hoy 25 USD).
  - **Canales sin IA**: chat web y WhatsApp que entran directo a la cola (por dentro son asistentes con `mode: 'human'`, así
    reutilizan widget, instalación, WhatsApp y bandeja). Un cliente solo con Contact Center nace con el canal «Chat web».
  - Sin agentes virtuales la IA nunca contesta ni se cobra (tampoco el resumen automático: se usa el análisis básico).
- La bandeja y el traspaso IA → persona requieren el Contact Center. Los clientes existentes quedan solo con Agentes
  virtuales hasta que se les active.

## WhatsApp · fase 2 (360dialog y YCloud)

Cada asistente puede tener un número de WhatsApp Business conectado con **360dialog** o **YCloud** (el cliente elige).

- **Alta desde el portal** (asistente → pestaña WhatsApp, solo owner): el cliente pega la API key de su BSP,
  elige el número y Zentekia registra el webhook solo. La llave y el secreto del webhook se guardan cifrados por cliente;
  el portal solo ve los últimos 4 caracteres. Un número solo puede estar conectado una vez en toda la plataforma.
- **Webhook** `POST /v1/wa/<360dialog|ycloud>/<canal>`: se valida la firma (YCloud: `YCloud-Signature`, HMAC con
  tolerancia de 5 min; 360dialog: token propio en `X-Zentekia-Token` y, si se define `D360_PLATFORM_SECRET`,
  también `x-360dialog-signature`) y se responde 200 de inmediato.
- **Procesamiento**: cada contacto se procesa en orden en su propio `ConversationDO` (en lugar de Cloudflare Queues,
  que requiere plan de pago). Deduplicación por id de WhatsApp: los reintentos del BSP no duplican mensajes ni respuestas.
- **Mismo agente IA y misma bandeja**: el asistente contesta con su conocimiento y herramientas; el traspaso a personas,
  colas, notas y reportes funcionan igual que en el chat web.
- **Ventana de 24 h** (`conversations.wa_window_expires_at`): cada mensaje del cliente la renueva. Fuera de ella la bandeja
  bloquea el texto libre y ofrece las **plantillas aprobadas** del número, con sus variables.
- **Estados de entrega** (enviado, entregado, leído, fallido) en cada mensaje; solo avanzan.
- **Adjuntos**: se guardan en R2 si el Worker tiene el binding `FILES` (hoy está comentado en `wrangler.toml`); sin R2 se
  muestra el tipo y el texto del adjunto.
- Código: `worker/src/channels/` (conectores, envío y procesamiento), `worker/src/routes/whatsapp.ts`, migración v10.

Pendiente: Embedded Signup propio / Integrated Onboarding de 360dialog (spec 8.1), plantillas con imagen o botones
con variables, gestor de plantillas y flujos (fase 3), voz (fase 4), horarios por cola y «agendar devolución de llamada».

> **Publicar la bandeja requiere `npm run deploy`** (Opción A): crea los Durable Objects con su migración.
> Si publicas pegando el archivo único (Opción B), todo lo anterior sigue funcionando, pero la Bandeja queda
> desactivada hasta que agregues los Durable Objects `INBOX_HUB` y `CONVERSATION_DO`.

## Publicar

### Opción A · terminal (recomendada)

```bash
npm install
npx wrangler login
# 1) Base de conocimiento (una sola vez)
npx wrangler vectorize create zentekia-kb --dimensions=1024 --metric=cosine
# 2) Secretos
npx wrangler secret put MASTER_KEY --config worker/wrangler.toml        # pega el resultado de: openssl rand -base64 32
npx wrangler secret put ADMIN_PASSWORD --config worker/wrangler.toml    # contraseña inicial del superadmin
npx wrangler secret put ADMIN_EMAIL --config worker/wrangler.toml       # tu correo de superadmin
# opcional: correos de invitación y alertas
npx wrangler secret put RESEND_API_KEY --config worker/wrangler.toml
# 3) Publicar
npm run deploy
```

> **Guarda la MASTER_KEY en un lugar seguro.** Si la pierdes o la cambias, las API keys guardadas de los clientes
> ya no se pueden descifrar y hay que volver a capturarlas.

### Opción B · panel de Cloudflare (pegar un archivo)

1. En el Worker `agente-zentekia`: **Editar código**, pega `worker/worker-un-archivo.js` completo e **Implementa**.
2. **Configuración → Vinculaciones**: deben estar `AI` (Workers AI) y `DB` (D1 `agente-db`).
   Agrega `VECTORIZE` (Vectorize `zentekia-kb`); el índice se crea en *Almacenamiento → Vectorize* con 1024 dimensiones y métrica cosine.
3. **Configuración → Variables y secretos**: secretos `MASTER_KEY` y `ADMIN_EMAIL`. `ADMIN_PASSWORD` ya existe.
4. **Configuración → Desencadenadores → Cron**: `*/10 * * * *`. Procesa documentos pendientes y borra conversaciones vencidas.

### Primera entrada

Abre `https://agente-zentekia.<tu-cuenta>.workers.dev/admin/` y entra con `ADMIN_EMAIL` + `ADMIN_PASSWORD`.
Si no definiste `ADMIN_EMAIL`, el usuario es `admin`. Te pedirá configurar la verificación en dos pasos.

La primera vez, la base renombra las tablas de la versión anterior a `legacy_conversations`, `legacy_messages`
y `legacy_prompts`. No se borra nada.

### Con tu dominio (zentekia.com)

1. DNS: registro comodín `*` (proxy naranja) hacia el Worker y rutas `*.zentekia.com/*`.
   Agrega también `chat`, `admin` y `api` como rutas o Custom Domains.
2. En `worker/wrangler.toml` cambia `BASE_DOMAIN = "zentekia.com"` y vuelve a publicar.
3. Recomendado: proteger `admin.zentekia.com` con Cloudflare Access.

## Desarrollo y pruebas

```bash
npm install
npm run build          # compila admin, portal, widget y loader, y genera worker/worker-un-archivo.js
npm run typecheck      # TypeScript estricto del Worker
tests/correr.sh        # 10 pruebas de punta a punta y de aislamiento (Worker local con modelos simulados)
```

```
worker/src/
  index.ts            rutas por host o ruta, páginas del panel y portal, cron
  db/                 esquema D1, repositorio por cliente (tenant-repo) y de plataforma
  auth/               contraseñas, TOTP, cifrado, sesiones
  routes/             auth, admin, portal, widget (API pública)
  models/             adaptadores (Workers AI, Anthropic, OpenAI y compatibles), router y armado del contexto
  billing/            tarifas y medición
  rag/                ingesta y recuperación
apps/
  admin/  portal/     paneles (Preact)
  frame/              chat dentro del iframe
  loader/             widget.js (burbuja, ~2 KB gzip)
  shared/             ChatPanel: la misma pieza en el widget real y en la vista previa del portal
```

## Pendientes y decisiones abiertas

- **Tarifas de ejemplo**: Qwen a $0.30/$1.20 y fee BYOK a $0.20/$0.40 por 1M tokens. Cámbialas en Admin → Tarifas.
- **Modelos**: verifica en Tarifas los nombres exactos de la API (`claude-sonnet-5-5`, `claude-haiku-5-5`, `gpt-6-luna`).
  Se editan sin volver a publicar.
- **Límite de frecuencia**: hoy está en memoria en cada servidor. Los topes de gasto y de mensajes sí son globales.
  Para un límite global estricto falta moverlo a un Durable Object (fase 2).
- **Ingesta**: los lotes corren con un límite de tiempo, y la tarea programada continúa lo pendiente.
  Cloudflare Queues requiere el plan de pago.
- **Embeddings**: hoy no se cobran.
- **Pagos**: el cobro es manual (fase 1). Los estados de cuenta y el registro de consumo ya están listos para conectar Stripe o Mercado Pago.
- **Voz**: queda fuera de esta fase, como dice el spec.
