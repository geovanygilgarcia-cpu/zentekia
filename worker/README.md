# Worker de agentes Prakticall (Workers AI: Qwen + panel admin)

## Qué incluye
- `POST /chat` → chat del widget (Qwen en streaming). Guarda cada conversación en D1.
  **Pide sesión de admin** (mismo login del panel). Con la variable `CHAT_PUBLICO=true` queda abierto a todos.
- `GET /admin` → panel con login: historial de conversaciones, prompts por agente, probar prompts.
- `GET /health` → estado: `{ ok, model, ai, db }`.

## Agentes que vienen cargados (se editan en /admin)
`prakticall-ventas`, `prakticall-atencion`, `prakticall-cobranza`, `prakticall-reclutamiento`.

## Modelos (todos gratuitos dentro de la cuota diaria de 10,000 neurons)
| Uso | Modelo | Costo aprox. |
|---|---|---|
| Chat | `@cf/qwen/qwen3-30b-a3b-fp8` | ~12 neurons por turno |

## Conexiones que necesita en Cloudflare
| Tipo | Nombre | Para qué |
|---|---|---|
| Workers AI | `AI` | Hablar con Qwen (obligatoria) |
| D1 | `DB` | Historial y prompts del panel |
| Secreto | `ADMIN_PASSWORD` | Contraseña del panel (mínimo 8 caracteres) |
| Variable (opcional) | `ADMIN_USER` | Usuario del panel (por defecto `admin`) |
| Variable (opcional) | `CHAT_PUBLICO` | `true` para que cualquiera use el chat sin login |

Las tablas de D1 se crean solas la primera vez, junto con los 4 prompts de chat de Prakticall.
Si tu base ya tenía los prompts de voz (`…-voz`), siguen ahí pero ya no se usan; puedes ignorarlos.

## Opción A · Desde el panel de Cloudflare
1. **Almacenamiento y bases de datos → D1 → Crear base de datos** → nombre `agente-db`.
2. En el Worker: **Configuración → Vinculaciones → Agregar → D1** → variable `DB`, base `agente-db`.
3. **Configuración → Variables y secretos → Agregar** → tipo **Secreto**, nombre `ADMIN_PASSWORD`, tu contraseña.
4. **Editar código** → pega `worker-un-archivo.js` completo → **Implementar**.
5. Abre `https://agente-zentekia.<tu-subdominio>.workers.dev/admin` y entra con `admin` + tu contraseña.
6. Agrega el dominio donde pongas el widget en la variable `ALLOWED_ORIGINS` (separado por comas).
7. En la página del chat entra con ese mismo `admin` + contraseña.

## Opción B · Con la terminal
```bash
npx wrangler login
npx wrangler d1 create agente-db        # copia el database_id a wrangler.toml
npx wrangler secret put ADMIN_PASSWORD  # escribe tu contraseña
npx wrangler deploy
```

## Cambiar el panel o el Worker
- Panel: edita `admin/` y corre `npm run build:worker` (regenera `worker-un-archivo.js`).
- Probar el panel en tu compu contra el Worker publicado: `npm run dev:admin`
  (`http://localhost:5173` ya está en ALLOWED_ORIGINS).

## Privacidad
Se guardan los mensajes, el agente, el sitio de origen y el país (no la IP).
Menciónalo en el aviso de privacidad del sitio. Para borrar conversaciones usa el panel.
