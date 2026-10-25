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
