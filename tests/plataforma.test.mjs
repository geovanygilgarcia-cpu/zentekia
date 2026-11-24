/*
  Pruebas de punta a punta + aislamiento entre clientes (tenants).
  Requiere el Worker corriendo en local con modelos simulados:
    npx wrangler dev --config tests/wrangler.test.toml --port 8787
  y luego:  BASE=http://127.0.0.1:8787 node --test tests/
*/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const ADMIN = { email: 'erik@zentekia.com', password: 'clave-de-prueba-123' }
const SECRET_KEY = 'sk-test-SUPERSECRETA-123456789-abcd'
const run = Date.now().toString(36)

/* ---------- utilidades ---------- */
function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of s) bits += A.indexOf(c).toString(2).padStart(5, '0')
  const out = []
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(out)
}
function totp(secret, t = Date.now()) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(Math.floor(t / 30000)))
  const h = createHmac('sha1', b32decode(secret)).update(buf).digest()
  const o = h[h.length - 1] & 15
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0')
}

class Browser {
  constructor() {
    this.cookies = {}
    this.csrf = null
  }
  async req(method, path, body, headers = {}) {
    const h = { ...headers }
    const c = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    if (c) h.Cookie = c
    if (this.csrf && method !== 'GET' && !('X-CSRF' in headers)) h['X-CSRF'] = this.csrf
    if (body !== undefined && !(body instanceof FormData)) h['Content-Type'] = 'application/json'
    const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), redirect: 'manual' })
    for (const sc of r.headers.getSetCookie?.() || []) {
      const [kv] = sc.split(';')
      const [k, ...v] = kv.split('=')
      this.cookies[k] = v.join('=')
    }
    const text = await r.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: r.status, json, text, headers: r.headers }
  }
  get(p, h) { return this.req('GET', p, undefined, h) }
  post(p, b = {}, h) { return this.req('POST', p, b, h) }
  put(p, b = {}, h) { return this.req('PUT', p, b, h) }
  del(p, h) { return this.req('DELETE', p, undefined, h) }
}

async function loginWithTotp(br, base, email, password, secretHolder) {
  const r = await br.post(`${base}/v1/auth/login`, { email, password })
  assert.equal(r.status, 200, `login ${email}: ${r.text}`)
  br.csrf = r.json.csrf
  if (r.json.state === 'enroll_totp') {
    const s = await br.post(`${base}/v1/auth/totp/setup`)
    assert.equal(s.status, 200, s.text)
    secretHolder.secret = s.json.secret
    const e = await br.post(`${base}/v1/auth/totp/enable`, { code: totp(s.json.secret) })
    assert.equal(e.status, 200, e.text)
  } else if (r.json.state === 'totp') {
    const v = await br.post(`${base}/v1/auth/totp/verify`, { code: totp(secretHolder.secret) })
    assert.equal(v.status, 200, v.text)
  }
}

async function acceptInvite(br, base, link, password) {
  const token = link.split('#/invitacion/')[1]
  const info = await br.get(`${base}/v1/auth/invite?t=${token}`)
  assert.equal(info.status, 200, info.text)
  const r = await br.post(`${base}/v1/auth/accept`, { token, name: 'Owner', password })
  assert.equal(r.status, 200, r.text)
  br.csrf = r.json.csrf
  if (r.json.state === 'enroll_totp') {
    const s = await br.post(`${base}/v1/auth/totp/setup`)
    const e = await br.post(`${base}/v1/auth/totp/enable`, { code: totp(s.json.secret) })
    assert.equal(e.status, 200, e.text)
  }
  return token
}

async function widgetChat(key, origin, message, conversation_id) {
  const s = await fetch(`${BASE}/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ key, origin }) })
  const sj = await s.json()
  if (!s.ok) return { status: s.status, error: sj }
  const r = await fetch(`${BASE}/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Authorization: `Bearer ${sj.token}` }, body: JSON.stringify({ message, conversation_id }) })
  const text = await r.text()
  const events = text.split('\n\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
  return { status: r.status, token: sj.token, events, text: events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), conv: events.find((e) => e.type === 'meta')?.conversation_id }
}

/* ---------- escenario ---------- */
const admin = new Browser()
const adminTotp = {}
const A = { br: new Browser(), slug: `cliente-a-${run}` }
const B = { br: new Browser(), slug: `cliente-b-${run}` }
const pa = () => `/p/${A.slug}`
const pb = () => `/p/${B.slug}`

test('superadmin: arranque, TOTP obligatorio y alta de dos clientes', async () => {
  await loginWithTotp(admin, '/admin', ADMIN.email, ADMIN.password, adminTotp)
  const me = await admin.get('/admin/v1/auth/me')
  assert.equal(me.json.state, 'ok')
  // sin CSRF no se puede cambiar nada
  const noCsrf = await admin.post('/admin/v1/tenants', {}, { 'X-CSRF': 'x' })
  assert.equal(noCsrf.status, 403)
  // slug reservado
  const bad = await admin.post('/admin/v1/tenants', { name: 'X', slug: 'admin', owner_email: 'x@x.com', monthly_limit_usd: 1, enabled_models: [] })
  assert.equal(bad.status, 400)
  for (const T of [A, B]) {
    const r = await admin.post('/admin/v1/tenants', { name: T.slug, slug: T.slug, owner_email: `owner@${T.slug}.com`, monthly_limit_usd: 50, enabled_models: [], import_prakticall: T === A })
    assert.equal(r.status, 200, r.text)
    T.id = r.json.id
    T.invite = r.json.invite_link
  }
  const dup = await admin.post('/admin/v1/tenants', { name: 'dup', slug: A.slug, owner_email: 'x@x.com', monthly_limit_usd: 1, enabled_models: [] })
  assert.equal(dup.status, 400)
})

test('owners aceptan invitación, configuran TOTP y ven su portal', async () => {
  for (const T of [A, B]) {
    const base = T === A ? pa() : pb()
    const tok = await acceptInvite(T.br, base, T.invite, 'ClaveSegura123')
    // la invitación es de un solo uso
    const again = await new Browser().post(`${base}/v1/auth/accept`, { token: tok, password: 'OtraClave123' })
    assert.equal(again.status, 404)
    const ov = await T.br.get(`${base}/v1/overview`)
    assert.equal(ov.status, 200, ov.text)
    T.agents = ov.json.agents
    T.key = ov.json.agents[0].widget_key
  }
  assert.equal(A.agents.length, 4, 'A importó los 4 agentes de Prakticall')
  assert.equal(B.agents.length, 1)
  for (const T of [A, B]) {
    const r = await T.br.put(`${T === A ? pa() : pb()}/v1/security`, { allowed_origins: [`https://${T.slug}.example`] })
    assert.equal(r.status, 200, r.text)
  }
})

test('widget: solo funciona en los dominios permitidos del cliente', async () => {
  const ok = await widgetChat(A.key, `https://${A.slug}.example`, 'Hola, ¿qué venden?')
  assert.equal(ok.status, 200)
  assert.match(ok.text, /Respuesta simulada/)
  A.conv = ok.conv
  A.token = ok.token
  const wrong = await widgetChat(A.key, `https://${B.slug}.example`, 'hola')
  assert.equal(wrong.status, 403)
  // el iframe declara frame-ancestors con la lista del cliente
  const frame = await fetch(`${BASE}/w/frame?key=${A.key}`)
  assert.match(frame.headers.get('content-security-policy'), new RegExp(`frame-ancestors https://${A.slug}\\.example`))
  assert.doesNotMatch(frame.headers.get('content-security-policy'), new RegExp(B.slug))
  // la API de sesión no acepta llamadas de otros orígenes (solo el iframe propio)
  const cross = await fetch(`${BASE}/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `https://${A.slug}.example` }, body: JSON.stringify({ key: A.key, origin: `https://${A.slug}.example` }) })
  assert.equal(cross.status, 403)
  const b = await widgetChat(B.key, `https://${B.slug}.example`, 'Hola B')
  assert.equal(b.status, 200)
  B.conv = b.conv
  B.token = b.token
})

test('finalizar conversación: se cierra, se califica y la siguiente es nueva', async () => {
  const c = await widgetChat(A.key, `https://${A.slug}.example`, 'quiero terminar')
  const end = await fetch(`${BASE}/v1/end`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Authorization: `Bearer ${c.token}` }, body: JSON.stringify({ conversation_id: c.conv }) })
  assert.equal(end.status, 200)
  const rate = await fetch(`${BASE}/v1/end`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Authorization: `Bearer ${c.token}` }, body: JSON.stringify({ conversation_id: c.conv, rating: 5 }) })
  assert.equal(rate.status, 200)
  const h = await (await fetch(`${BASE}/v1/conversation?id=${c.conv}`, { headers: { Authorization: `Bearer ${c.token}` } })).json()
  assert.equal(h.ended, true)
  assert.equal(h.rating, 5)
  // escribir en una conversación finalizada abre otra
  const r = await fetch(`${BASE}/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Authorization: `Bearer ${c.token}` }, body: JSON.stringify({ message: 'otra cosa', conversation_id: c.conv }) })
  const meta = (await r.text()).split('\n\n').map((l) => l.startsWith('data:') && JSON.parse(l.slice(5))).find((e) => e && e.type === 'meta')
  assert.notEqual(meta.conversation_id, c.conv)
  // el portal la muestra como finalizada y con calificación
  const list = await A.br.get(`${pa()}/v1/conversations?status=ended`)
  const row = list.json.items.find((x) => x.id === c.conv)
  assert.ok(row && row.ended_at && row.rating === 5)
  assert.ok((await A.br.get(`${pa()}/v1/conversations?status=open`)).json.items.every((x) => x.id !== c.conv))
  // B no puede cerrar conversaciones de A
  const other = await fetch(`${BASE}/v1/end`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Authorization: `Bearer ${B.token}` }, body: JSON.stringify({ conversation_id: A.conv }) })
  assert.equal(other.status, 404)
})

test('herramienta finalizar: el agente cierra el chat y la marca no llega al visitante', async () => {
  const agent = A.agents[0].id
  // apagada: aunque el visitante se despida, no se cierra
  let c = await widgetChat(A.key, `https://${A.slug}.example`, 'adiós')
  let h = await (await fetch(`${BASE}/v1/conversation?id=${c.conv}`, { headers: { Authorization: `Bearer ${c.token}` } })).json()
  assert.equal(h.ended, false)
  // encendida
  assert.equal((await A.br.put(`${pa()}/v1/agents/${agent}`, { auto_end: true, end_when: 'cuando tengas nombre y teléfono' })).status, 200)
  const cfg = (await A.br.get(`${pa()}/v1/agents/${agent}`)).json
  assert.equal(cfg.auto_end, true)
  assert.equal(cfg.end_when, 'cuando tengas nombre y teléfono')
  const r = await fetch(`${BASE}/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Authorization: `Bearer ${c.token}` }, body: JSON.stringify({ message: 'gracias, adiós' }) })
  const evs = (await r.text()).split('\n\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
  const conv = evs.find((e) => e.type === 'meta').conversation_id
  const shown = evs.filter((e) => e.type === 'delta').map((e) => e.text).join('')
  assert.ok(!/finaliz|\[/i.test(shown), `se filtró la marca: ${shown}`)
  assert.equal(evs.find((e) => e.type === 'done').ended, true)
  h = await (await fetch(`${BASE}/v1/conversation?id=${conv}`, { headers: { Authorization: `Bearer ${c.token}` } })).json()
  assert.equal(h.ended, true)
  assert.ok(h.messages.every((m) => !m.content.includes('[')))
  const d = await A.br.get(`${pa()}/v1/conversations/${conv}`)
  assert.equal(d.json.conversation.ended_by, 'agent')
  // un mensaje normal no cierra
  c = await widgetChat(A.key, `https://${A.slug}.example`, 'hola')
  h = await (await fetch(`${BASE}/v1/conversation?id=${c.conv}`, { headers: { Authorization: `Bearer ${c.token}` } })).json()
  assert.equal(h.ended, false)
  await A.br.put(`${pa()}/v1/agents/${agent}`, { auto_end: false })
})

test('aislamiento: un cliente no puede ver ni tocar datos de otro', async () => {
  // portal: recursos de B pedidos con la sesión de A
  const bAgent = B.agents[0].id
  assert.equal((await A.br.get(`${pa()}/v1/agents/${bAgent}`)).status, 404)
  assert.equal((await A.br.put(`${pa()}/v1/agents/${bAgent}`, { name: 'hack' })).status, 404)
  assert.equal((await A.br.get(`${pa()}/v1/conversations/${B.conv}`)).status, 404)
  assert.equal((await A.br.del(`${pa()}/v1/conversations/${B.conv}`)).status, 404)
  assert.equal((await A.br.get(`${pa()}/v1/kb?agent=${bAgent}`)).status, 404)
  assert.equal((await A.br.get(`${pa()}/v1/widget?agent=${bAgent}`)).status, 404)
  const bw = await B.br.get(`${pb()}/v1/widget?agent=${bAgent}`)
  assert.equal((await A.br.put(`${pa()}/v1/widget/${bw.json.id}`, { primary: '#000000' })).status, 404)
  // la lista de conversaciones de A no incluye las de B
  const list = await A.br.get(`${pa()}/v1/conversations`)
  assert.ok(list.json.items.every((c) => c.id !== B.conv))
  assert.ok(list.json.items.some((c) => c.id === A.conv))
  // la sesión de A no sirve en el portal de B (ni copiando la cookie con el nombre de B)
  assert.equal((await A.br.get(`${pb()}/v1/overview`)).status, 401)
  const forged = new Browser()
  forged.cookies[`__Host-zt_p_${B.slug}`] = A.br.cookies[`__Host-zt_p_${A.slug}`]
  assert.equal((await forged.get(`${pb()}/v1/overview`)).status, 401)
  // el token del widget de A no lee la conversación de B
  const r = await fetch(`${BASE}/v1/conversation?id=${B.conv}`, { headers: { Authorization: `Bearer ${A.token}` } })
  assert.deepEqual((await r.json()).messages, [])
  // ni puede escribir en ella: el chat abre una conversación nueva de A
  const s = await fetch(`${BASE}/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Authorization: `Bearer ${A.token}` }, body: JSON.stringify({ message: 'intruso', conversation_id: B.conv }) })
  const t = await s.text()
  assert.doesNotMatch(t, new RegExp(B.conv))
  const bMsgs = await B.br.get(`${pb()}/v1/conversations/${B.conv}`)
  assert.ok(bMsgs.json.messages.every((m) => m.content !== 'intruso'))
  // un token alterado no sirve
  const forgedTok = A.token.slice(0, -3) + 'abc'
  const f = await fetch(`${BASE}/v1/conversation?id=${A.conv}`, { headers: { Authorization: `Bearer ${forgedTok}` } })
  assert.equal(f.status, 401)
})

test('base de conocimiento: el RAG de un cliente nunca responde a otro', async () => {
  const aAgent = A.agents.find((a) => a.widget_key === A.key).id
  const add = await A.br.post(`${pa()}/v1/kb/text`, { agent_id: aAgent, name: 'Horarios secretos', text: 'El horario de la sucursal Zafiro es de 9 a 18 horas. Contraseña wifi zafiro-777.' })
  assert.equal(add.status, 200, add.text)
  assert.equal(add.json.source.status, 'ready')
  const a = await widgetChat(A.key, `https://${A.slug}.example`, '¿Cuál es el horario de la sucursal Zafiro?')
  assert.match(a.text, /usé la base de conocimiento: Horarios secretos/)
  const b = await widgetChat(B.key, `https://${B.slug}.example`, '¿Cuál es el horario de la sucursal Zafiro?')
  assert.doesNotMatch(b.text, /usé la base de conocimiento|Horarios secretos/)
  // B no puede borrar la fuente de A
  assert.equal((await B.br.del(`${pb()}/v1/kb/${add.json.id}`)).status, 404)
})

let mock
test('BYOK: la API key se guarda cifrada, nunca se devuelve y se cobra solo el fee', async () => {
  // proveedor compatible con OpenAI simulado
  mock = createServer((req, res) => {
    if (req.url.endsWith('/models')) {
      res.writeHead(req.headers.authorization === `Bearer ${SECRET_KEY}` ? 200 : 401, { 'Content-Type': 'application/json' })
      return res.end('{"data":[]}')
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hola desde el proveedor ' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'compatible.' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise((ok) => mock.listen(9911, '127.0.0.1', ok))
  const save = await B.br.put(`${pb()}/v1/keys/openai-compatible`, { api_key: SECRET_KEY, base_url: 'http://127.0.0.1:9911/v1', model_name: 'llama-prueba' })
  assert.equal(save.status, 200, save.text)
  const t = await B.br.post(`${pb()}/v1/keys/${save.json.id}/test`)
  assert.equal(t.json.ok, true, t.text)
  const models = await B.br.get(`${pb()}/v1/models`)
  assert.ok(!models.text.includes(SECRET_KEY) && !models.text.includes('SUPERSECRETA'), 'la llave nunca aparece en respuestas')
  assert.equal(models.json.keys[0].last4, 'abcd')
  assert.equal((await A.br.post(`${pa()}/v1/keys/${save.json.id}/test`)).status, 404, 'A no puede usar la llave de B')
  const use = await B.br.put(`${pb()}/v1/agents/${B.agents[0].id}/model`, { model_id: 'openai-compatible' })
  assert.equal(use.status, 200, use.text)
  const c = await widgetChat(B.key, `https://${B.slug}.example`, 'hola')
  assert.equal(c.text, 'Hola desde el proveedor compatible.')
  const usage = await B.br.get(`${pb()}/v1/usage`)
  const row = usage.json.by_model.find((x) => x.model_id === 'openai-compatible')
  assert.equal(row.model_type, 'byok')
  assert.equal(row.tin, 1000)
  // fee de ejemplo: $0.20 / $0.40 por 1M → 1000×0.2 + 50×0.4 = 220 micro-USD
  assert.equal(row.cost, 220)
  // una llave mala: el visitante ve un mensaje genérico y el owner recibe alerta
  await B.br.put(`${pb()}/v1/keys/openai-compatible`, { api_key: 'sk-mala-0000000000', base_url: 'http://127.0.0.1:9911/v1', model_name: 'x' })
  const keys = await B.br.get(`${pb()}/v1/models`)
  await B.br.put(`${pb()}/v1/agents/${B.agents[0].id}/model`, { model_id: 'openai-compatible' })
  mock.removeAllListeners('request')
  mock.on('request', (req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end('{"error":{"message":"Incorrect API key provided: sk-mala"}}')
  })
  const bad = await widgetChat(B.key, `https://${B.slug}.example`, 'hola')
  assert.ok(bad.events.some((e) => e.type === 'error'))
  assert.doesNotMatch(JSON.stringify(bad.events), /Incorrect API key|sk-mala/)
  const ov = await B.br.get(`${pb()}/v1/overview`)
  assert.ok(ov.json.alerts.some((a) => a.kind === 'provider_auth'), 'alerta para el owner')
  assert.ok(keys.json.keys.length === 1)
  mock.close()
})

test('roles: un editor no ve API keys, consumo ni equipo', async () => {
  const inv = await A.br.post(`${pa()}/v1/team/invite`, { email: `editor@${A.slug}.com`, role: 'editor' })
  assert.equal(inv.status, 200, inv.text)
  const ed = new Browser()
  await acceptInvite(ed, pa(), inv.json.link, 'ClaveEditor123')
  const me = await ed.get(`${pa()}/v1/auth/me`)
  assert.equal(me.json.state, 'ok', 'el editor no está obligado a TOTP')
  for (const p of ['models', 'usage', 'team', 'security']) assert.equal((await ed.get(`${pa()}/v1/${p}`)).status, 403, p)
  assert.equal((await ed.put(`${pa()}/v1/keys/openai`, { api_key: 'sk-12345678' })).status, 403)
  assert.equal((await ed.get(`${pa()}/v1/kb?agent=${A.agents[0].id}`)).status, 200)
})

test('límite mensual: al 100 % se bloquea y se avisa', async () => {
  await admin.put(`/admin/v1/tenants/${A.id}`, { monthly_limit_usd: 0.000001 })
  await widgetChat(A.key, `https://${A.slug}.example`, 'uno')
  const blocked = await widgetChat(A.key, `https://${A.slug}.example`, 'dos')
  assert.match(blocked.text, /no puedo responder/)
  const ov = await A.br.get(`${pa()}/v1/overview`)
  assert.ok(ov.json.alerts.some((a) => a.kind === 'limit_100'))
  await admin.put(`/admin/v1/tenants/${A.id}`, { monthly_limit_usd: 50 })
})

test('suspensión e impersonación de solo lectura', async () => {
  await admin.post(`/admin/v1/tenants/${B.id}/suspend`, { message: 'Volvemos pronto' })
  const cfg = await (await fetch(`${BASE}/v1/widget/config?key=${B.key}`)).json()
  assert.equal(cfg.suspended, true)
  await admin.post(`/admin/v1/tenants/${B.id}/reactivate`)
  const imp = await admin.post(`/admin/v1/tenants/${A.id}/impersonate`)
  const support = new Browser()
  const go = await support.get(new URL(imp.json.url).pathname + new URL(imp.json.url).search)
  assert.equal(go.status, 302)
  const me = await support.get(`${pa()}/v1/auth/me`)
  assert.equal(me.json.read_only, true)
  support.csrf = me.json.csrf
  assert.equal((await support.get(`${pa()}/v1/usage`)).status, 200)
  assert.equal((await support.put(`${pa()}/v1/agents/${A.agents[0].id}`, { name: 'cambio' })).status, 403)
  // el token de impersonación es de un solo uso
  assert.equal((await new Browser().get(new URL(imp.json.url).pathname + new URL(imp.json.url).search)).status, 403)
  // y no sirve para otro cliente
  const imp2 = await admin.post(`/admin/v1/tenants/${A.id}/impersonate`)
  const u = new URL(imp2.json.url)
  assert.equal((await new Browser().get(`${pb()}/entrar${u.search}`)).status, 403)
})

test('cierre de periodo, estado de cuenta y auditoría', async () => {
  const period = new Date().toISOString().slice(0, 7)
  const close = await admin.post('/admin/v1/statements/close', { period })
  assert.equal(close.status, 200, close.text)
  const rep = await admin.get(`/admin/v1/usage?period=${period}`)
  const stB = rep.json.statements.find((s) => s.tenant_id === B.id)
  assert.ok(stB.total_micro >= 220)
  assert.equal((await B.br.get(`${pb()}/v1/statements/${period}`)).status, 404, 'borrador: el cliente aún no lo ve')
  await admin.post(`/admin/v1/statements/${stB.id}/issue`)
  const st = await B.br.get(`${pb()}/v1/statements/${period}`)
  assert.equal(st.status, 200)
  assert.equal(st.json.statement.total_micro, stB.total_micro)
  assert.equal((await A.br.get(`${pa()}/v1/statements/${period}`)).json?.statement?.tenant_id ?? A.id, A.id)
  await admin.post(`/admin/v1/statements/${stB.id}/paid`)
  const csv = await admin.get(`/admin/v1/usage.csv?period=${period}`)
  assert.match(csv.text, /importe_usd/)
  const audit = await admin.get('/admin/v1/audit?action=statement')
  assert.ok(audit.json.items.some((a) => a.action === 'statement.marked_paid'))
  const all = await admin.get('/admin/v1/audit')
  assert.ok(!all.text.includes(SECRET_KEY), 'la auditoría no guarda llaves')
})

test('prospectos: al cerrar se resume, se detecta el prospecto y sus datos; filtros y seguimiento', async () => {
  const agent = A.agents[0].id
  // reglas por asistente
  assert.equal((await A.br.put(`${pa()}/v1/agents/${agent}`, { lead_criteria: 'Quien pide cotización', lead_fields: ['name', 'phone'], lead_alerts: 'off' })).status, 200)
  const cfg = (await A.br.get(`${pa()}/v1/agents/${agent}`)).json
  assert.deepEqual(cfg.lead_fields, ['name', 'phone'])
  assert.equal(cfg.lead_alerts, 'off')
  // un visitante con interés que deja sus datos
  const c = await widgetChat(A.key, `https://${A.slug}.example`, 'Hola, me llamo Laura Pérez y quiero una cotización para contratar hoy. Mi cel es 55 1234 5678 y mi correo laura@acme.mx')
  const end = await fetch(`${BASE}/v1/end`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Authorization: `Bearer ${c.token}` }, body: JSON.stringify({ conversation_id: c.conv }) })
  assert.equal(end.status, 200)
  let conv
  for (let i = 0; i < 20; i++) {
    conv = (await A.br.get(`${pa()}/v1/conversations/${c.conv}`)).json.conversation
    if (conv.analyzed_at) break
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(conv.analyzed_at, 'se analizó al cerrar')
  assert.ok(conv.summary)
  assert.ok(['hot', 'warm'].includes(conv.lead_status), conv.lead_status)
  assert.equal(conv.contact_phone, '5512345678')
  assert.equal(conv.contact_email, 'laura@acme.mx')
  assert.equal(conv.contact_name, 'Laura Pérez')
  assert.equal(conv.lead_stage, 'new')
  // filtros
  const pros = await A.br.get(`${pa()}/v1/conversations?lead=prospect&contact=phone`)
  assert.ok(pros.json.items.some((x) => x.id === c.conv))
  assert.ok(pros.json.items.every((x) => ['hot', 'warm', 'cold'].includes(x.lead_status) && x.contact_phone))
  assert.ok((await A.br.get(`${pa()}/v1/conversations?q=laura@acme`)).json.items.some((x) => x.id === c.conv))
  const st = (await A.br.get(`${pa()}/v1/conversations/stats`)).json
  assert.ok(st.prospects >= 1 && st.with_contact >= 1 && st.to_contact >= 1)
  // seguimiento y corrección de datos
  const up = await A.br.put(`${pa()}/v1/conversations/${c.conv}/lead`, { lead_stage: 'contacted', contact_company: 'Acme' })
  assert.equal(up.status, 200, up.text)
  assert.equal(up.json.conversation.lead_stage, 'contacted')
  assert.equal(up.json.conversation.contact_company, 'Acme')
  assert.equal((await A.br.put(`${pa()}/v1/conversations/${c.conv}/lead`, { contact_phone: '12' })).status, 400)
  assert.ok((await A.br.get(`${pa()}/v1/conversations?stage=contacted`)).json.items.some((x) => x.id === c.conv))
  assert.ok((await A.br.get(`${pa()}/v1/conversations?stage=new`)).json.items.every((x) => x.id !== c.conv))
  // volver a analizar a mano conserva el seguimiento
  const re = await A.br.post(`${pa()}/v1/conversations/${c.conv}/analyze`)
  assert.equal(re.status, 200, re.text)
  assert.equal(re.json.conversation.lead_stage, 'contacted')
  // CSV de prospectos
  const csv = await A.br.get(`${pa()}/v1/leads/export.csv`)
  assert.equal(csv.status, 200)
  assert.match(csv.text, /laura@acme\.mx/)
  // un saludo sin interés no es prospecto
  const h = await widgetChat(A.key, `https://${A.slug}.example`, 'hola buenas')
  const pend = await A.br.post(`${pa()}/v1/conversations/analyze-pending`)
  assert.equal(pend.status, 200, pend.text)
  const hc = (await A.br.get(`${pa()}/v1/conversations/${h.conv}`)).json.conversation
  assert.equal(hc.lead_status, 'none')
  // aislamiento: B no ve ni toca el prospecto de A
  assert.equal((await B.br.put(`${pb()}/v1/conversations/${c.conv}/lead`, { lead_stage: 'won' })).status, 404)
  assert.equal((await B.br.post(`${pb()}/v1/conversations/${c.conv}/analyze`)).status, 404)
  assert.ok(!(await B.br.get(`${pb()}/v1/leads/export.csv`)).text.includes('laura@acme.mx'))
  // el asistente pide los datos marcados (va en las instrucciones)
  await A.br.put(`${pa()}/v1/agents/${agent}`, { lead_fields: [], lead_alerts: 'hot', lead_criteria: '' })
})

/* ---------- bandeja omnicanal (fase 1): IA ⇄ persona en el web chat ---------- */

// Cada visitante simulado con su propia IP (el widget limita 40 solicitudes por minuto por IP)
let ipN = 0
const vIp = () => `10.77.${Math.floor(++ipN / 250)}.${ipN % 250}`
const ipOf = new Map()

/** Primer mensaje de un visitante nuevo (igual que widgetChat, con IP propia) */
async function visitorChat(key, origin, message) {
  const ip = vIp()
  const s = await fetch(`${BASE}/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, 'CF-Connecting-IP': ip }, body: JSON.stringify({ key, origin }) })
  const sj = await s.json()
  if (!s.ok) return { status: s.status, error: sj, events: [], text: '' }
  ipOf.set(sj.token, ip)
  const r = await chatOn(sj.token, null, message)
  return { ...r, token: sj.token }
}
const history = async (token, conv) => (await fetch(`${BASE}/v1/conversation?id=${conv}`, { headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ipOf.get(token) || vIp() } })).json()

/** Un mensaje más del visitante en la misma conversación (mismo token) */
async function chatOn(token, conversation_id, message) {
  const r = await fetch(`${BASE}/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ipOf.get(token) || vIp() }, body: JSON.stringify({ message, conversation_id }) })
  const events = (await r.text()).split('\n\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
  return { status: r.status, events, text: events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), done: events.find((e) => e.type === 'done'), conv: events.find((e) => e.type === 'meta')?.conversation_id }
}

/** WebSocket del visitante: junta los eventos que llegan */
function visitorSocket(token, conv) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/v1/live?c=${conv}&t=${encodeURIComponent(token)}`, { headers: { Origin: BASE, 'CF-Connecting-IP': vIp() } })
  const events = []
  const opened = new Promise((ok, bad) => {
    ws.onopen = ok
    ws.onerror = bad
  })
  ws.onmessage = (e) => e.data !== 'pong' && events.push(JSON.parse(e.data))
  const waitFor = async (pred, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const hit = events.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }
  return { ws, events, opened, waitFor }
}

const IB = { ag1: new Browser(), ag2: new Browser(), sup: new Browser() }

test('bandeja: escala, la IA deja de responder, una sola persona toma y el visitante recibe en vivo', async () => {
  const agent = A.agents[1]
  const key = agent.widget_key
  // con la bandeja apagada, «hablar con una persona» no cambia nada (comportamiento anterior)
  const before = await visitorChat(key, `https://${A.slug}.example`, 'Hola, ¿me ayudas?')
  const off = await chatOn(before.token, before.conv, 'quiero hablar con una persona')
  assert.match(off.text, /Respuesta simulada/)

  // sin el producto Contact Center no hay bandeja ni agentes humanos
  assert.equal((await A.br.put(`${pa()}/v1/agents/${agent.id}`, { tools: { handoff: { enabled: true, mode: 'inbox' } } })).status, 400)
  assert.equal((await A.br.post(`${pa()}/v1/team/invite`, { email: `x@${A.slug}.com`, role: 'agent' })).json.error.code, 'no_product')
  assert.equal((await A.br.get(`${pa()}/v1/inbox/bootstrap`)).status, 403)
  // Zentekia le activa el Contact Center con 3 licencias (y a B con 1)
  assert.equal((await admin.put(`/admin/v1/tenants/${A.id}`, { products: { va: true, cc: true, cc_seats: 3 } })).status, 200)
  assert.equal((await admin.put(`/admin/v1/tenants/${B.id}`, { products: { va: true, cc: true, cc_seats: 1 } })).status, 200)

  // el owner activa la bandeja en «Pasar a una persona» (sin agentes: se queda en la cola)
  const on = await A.br.put(`${pa()}/v1/agents/${agent.id}`, { tools: { handoff: { enabled: true, mode: 'inbox', no_agents: 'wait', max_wait_min: 0 } } })
  assert.equal(on.status, 200, on.text)
  // una cola que no es del cliente no se acepta
  assert.equal((await A.br.put(`${pa()}/v1/agents/${agent.id}`, { tools: { handoff: { enabled: true, mode: 'inbox', queue_id: 'no-existe' } } })).status, 400)

  // dos agentes y un supervisor (roles nuevos)
  for (const [k, role] of [['ag1', 'agent'], ['ag2', 'agent'], ['sup', 'supervisor']]) {
    const inv = await A.br.post(`${pa()}/v1/team/invite`, { email: `${k}@${A.slug}.com`, role })
    assert.equal(inv.status, 200, inv.text)
    // la invitación de agentes y supervisores abre el Contact Center
    assert.match(inv.json.link, /\/cc\/#\/invitacion\//)
    await acceptInvite(IB[k], pa(), inv.json.link, `Clave${k}12345`)
  }
  // las 3 licencias están ocupadas: no se puede invitar a otro agente ni convertir a alguien en supervisor
  const full = await A.br.post(`${pa()}/v1/team/invite`, { email: `ag4@${A.slug}.com`, role: 'agent' })
  assert.equal(full.status, 400)
  assert.equal(full.json.error.code, 'no_seats')
  const team = await A.br.get(`${pa()}/v1/team`)
  assert.deepEqual(team.json.seats, { enabled: true, total: 3, used: 3 })
  // Zentekia no puede bajar las licencias por debajo de las que ya se usan
  assert.equal((await admin.put(`/admin/v1/tenants/${A.id}`, { products: { va: true, cc: true, cc_seats: 2 } })).status, 400)
  // un agente no entra a la configuración de asistentes ni al equipo
  assert.equal((await IB.ag1.get(`${pa()}/v1/agents/${agent.id}`)).status, 403)
  assert.equal((await IB.ag1.get(`${pa()}/v1/team`)).status, 403)
  assert.equal((await IB.ag1.get(`${pa()}/v1/overview`)).status, 200)
  const boot = await IB.ag1.get(`${pa()}/v1/inbox/bootstrap`)
  assert.equal(boot.status, 200, boot.text)
  assert.equal(boot.json.ready, true)
  assert.equal(boot.json.me.role, 'agent')

  // el visitante pide una persona: escala sin pasar por la IA
  const c = await visitorChat(key, `https://${A.slug}.example`, 'Hola, tengo un problema con mi pedido')
  assert.match(c.text, /Respuesta simulada/, JSON.stringify(c.events))
  const esc = await chatOn(c.token, c.conv, 'Quiero hablar con una persona, por favor')
  assert.equal(esc.text, '', 'la IA no debe responder al escalar')
  assert.equal(esc.done.status, 'waiting_human')
  // mientras espera, la IA no contesta
  const waiting = await chatOn(c.token, c.conv, '¿hay alguien?')
  assert.equal(waiting.text, '')
  assert.equal(waiting.done.handled, true)

  // aparece sin asignar en la bandeja de los agentes
  const un = await IB.ag1.get(`${pa()}/v1/inbox/conversations?view=unassigned`)
  assert.ok(un.json.items.some((x) => x.id === c.conv), un.text)
  assert.ok(un.json.counts.unassigned >= 1)

  // el visitante abre su canal en tiempo real
  const vs = visitorSocket(c.token, c.conv)
  await vs.opened

  // dos agentes toman a la vez: solo uno gana
  const [t1, t2] = await Promise.all([IB.ag1.post(`${pa()}/v1/inbox/conversations/${c.conv}/take`), IB.ag2.post(`${pa()}/v1/inbox/conversations/${c.conv}/take`)])
  assert.deepEqual([t1.status, t2.status].sort(), [200, 409], `${t1.text} ${t2.text}`)
  const [win, lose] = t1.status === 200 ? [IB.ag1, IB.ag2] : [IB.ag2, IB.ag1]
  assert.ok(await vs.waitFor((e) => e.type === 'status' && e.status === 'human_active'), 'el visitante se entera de que lo atiende una persona')

  // solo quien la tiene responde; cualquiera del equipo deja notas internas
  assert.equal((await lose.post(`${pa()}/v1/inbox/conversations/${c.conv}/messages`, { type: 'text', text: 'yo también' })).status, 409)
  const reply = await win.post(`${pa()}/v1/inbox/conversations/${c.conv}/messages`, { type: 'text', text: 'Hola, soy de soporte. ¿Cuál es tu número de pedido?' })
  assert.equal(reply.status, 200, reply.text)
  assert.equal((await lose.post(`${pa()}/v1/inbox/conversations/${c.conv}/messages`, { type: 'note', text: 'NOTA-SECRETA cliente frecuente' })).status, 200)
  const live = await vs.waitFor((e) => e.type === 'message' && e.message.sender === 'human')
  assert.ok(live, `no llegó en vivo: ${JSON.stringify(vs.events)}`)
  assert.match(live.message.content, /soy de soporte/)
  assert.ok(!vs.events.some((e) => JSON.stringify(e).includes('NOTA-SECRETA')), 'una nota interna llegó al visitante')
  vs.ws.close()

  // el visitante escribe: le llega a la persona, la IA sigue callada
  const v2 = await chatOn(c.token, c.conv, 'Es el pedido 12345')
  assert.equal(v2.text, '')
  assert.equal(v2.done.status, 'human_active')

  // historial del visitante: respuesta de la persona y avisos, nunca notas ni eventos internos
  const h = await history(c.token, c.conv)
  assert.equal(h.status, 'human_active')
  assert.ok(h.messages.some((m) => m.sender === 'human' && m.author && /soporte/.test(m.content)))
  assert.ok(h.messages.some((m) => m.role === 'system' && m.kind === 'notice'))
  assert.ok(h.messages.every((m) => !m.content.includes('NOTA-SECRETA') && m.kind !== 'event'))

  // la bandeja guarda tiempos, notas, eventos y el motivo
  const d = await win.get(`${pa()}/v1/inbox/conversations/${c.conv}`)
  assert.equal(d.status, 200, d.text)
  assert.equal(d.json.can_reply, true)
  const cv = d.json.conversation
  assert.equal(cv.escalation_reason, 'keyword')
  assert.ok(cv.escalated_at && cv.assigned_at && cv.first_human_response_at, 'faltan tiempos de escalamiento, asignación o primera respuesta')
  assert.ok(d.json.messages.some((m) => m.kind === 'note' && m.content.includes('NOTA-SECRETA')))
  assert.ok(d.json.messages.some((m) => m.kind === 'event'))
  assert.ok(d.json.messages.some((m) => m.role === 'user' && m.content === 'Es el pedido 12345'))

  // devolver a la IA: vuelve a responder el modelo
  assert.equal((await lose.post(`${pa()}/v1/inbox/conversations/${c.conv}/handback`)).status, 403, 'solo quien atiende (o un supervisor) devuelve')
  assert.equal((await win.post(`${pa()}/v1/inbox/conversations/${c.conv}/handback`)).status, 200)
  const back = await chatOn(c.token, c.conv, 'gracias, ya quedó')
  assert.match(back.text, /Respuesta simulada/)
  // el historial que ve la IA incluye lo que dijo la persona, no las notas
  assert.equal(back.done.status, 'ai_active')

  // herramienta del agente IA ([HUMANO]): con un agente en línea se asigna sola y la marca no llega al visitante
  assert.equal((await IB.ag1.put(`${pa()}/v1/inbox/presence`, { status: 'online' })).status, 200)
  const tool = await chatOn(c.token, c.conv, 'mejor que me atienda una persona')
  assert.ok(!/\[|humano\]/i.test(tool.text), `se filtró la marca: ${tool.text}`)
  assert.equal(tool.done.status, 'human_active')
  const d2 = (await IB.ag1.get(`${pa()}/v1/inbox/conversations/${c.conv}`)).json.conversation
  assert.equal(d2.assignee_user_id, boot.json.me.id)
  assert.equal(d2.escalation_reason, 'ai_tool')

  // el supervisor ve todas y reasigna; luego se cierra y el visitante lo ve cerrado
  const all = await IB.sup.get(`${pa()}/v1/inbox/conversations?view=all`)
  assert.ok(all.json.items.some((x) => x.id === c.conv))
  const ag2id = (await IB.ag2.get(`${pa()}/v1/inbox/bootstrap`)).json.me.id
  assert.equal((await IB.ag1.post(`${pa()}/v1/inbox/conversations/${c.conv}/assign`, { user_id: ag2id })).status, 403, 'un agente no reasigna')
  assert.equal((await IB.sup.post(`${pa()}/v1/inbox/conversations/${c.conv}/assign`, { user_id: ag2id })).status, 200)
  assert.equal((await IB.ag2.post(`${pa()}/v1/inbox/conversations/${c.conv}/close`)).status, 200)
  assert.equal((await history(c.token, c.conv)).ended, true)
  assert.equal((await IB.ag2.post(`${pa()}/v1/inbox/conversations/${c.conv}/close`)).status, 409)
  const m = await IB.sup.get(`${pa()}/v1/inbox/metrics?days=1`)
  assert.equal(m.status, 200, m.text)
  assert.ok(m.json.escalated >= 1 && m.json.avg_first_response_ms != null)
  await IB.ag1.put(`${pa()}/v1/inbox/presence`, { status: 'offline' })
  A.inboxConv = c.conv
})

test('bandeja: aislamiento entre clientes y colas', async () => {
  // B no ve ni toca la bandeja de A
  assert.equal((await B.br.get(`${pb()}/v1/inbox/conversations/${A.inboxConv}`)).status, 404)
  assert.equal((await B.br.post(`${pb()}/v1/inbox/conversations/${A.inboxConv}/take`)).status, 404)
  assert.equal((await B.br.post(`${pb()}/v1/inbox/conversations/${A.inboxConv}/messages`, { type: 'note', text: 'intruso' })).status, 404)
  for (const v of ['mine', 'unassigned', 'waiting', 'ai', 'all', 'closed']) {
    const l = await B.br.get(`${pb()}/v1/inbox/conversations?view=${v}`)
    assert.equal(l.status, 200, l.text)
    assert.ok(l.json.items.every((x) => x.id !== A.inboxConv), `B ve una conversación de A en ${v}`)
  }
  // la sesión de un agente de A no sirve en el portal de B
  assert.equal((await IB.ag1.get(`${pb()}/v1/inbox/bootstrap`)).status, 401)
  // el WebSocket de la bandeja exige el mismo origen y sesión
  const noOrigin = await IB.ag1.get(`${pa()}/v1/inbox/ws`, { Origin: 'https://evil.example' })
  assert.equal(noOrigin.status, 403)
  // el token del widget de B no abre el canal en vivo de una conversación de A
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/v1/live?c=${A.inboxConv}&t=${encodeURIComponent(B.token)}`, { headers: { Origin: BASE, 'CF-Connecting-IP': vIp() } })
  const res = await new Promise((ok) => {
    ws.onopen = () => ok('open')
    ws.onerror = () => ok('error')
  })
  assert.equal(res, 'error')
  // colas: solo administradores las crean; un agente solo ve las de sus colas (y las sin cola)
  assert.equal((await IB.sup.post(`${pa()}/v1/inbox/queues`, { name: 'Ventas' })).status, 403)
  const q = await A.br.post(`${pa()}/v1/inbox/queues`, { name: 'Ventas' })
  assert.equal(q.status, 200, q.text)
  const qs = await B.br.get(`${pb()}/v1/inbox/queues`)
  assert.ok(qs.json.queues.every((x) => x.id !== q.json.id), 'B ve las colas de A')
  assert.equal((await B.br.put(`${pb()}/v1/inbox/queues/${q.json.id}`, { name: 'hack' })).status, 404)
  const agent = A.agents[1]
  assert.equal((await A.br.put(`${pa()}/v1/agents/${agent.id}`, { tools: { handoff: { enabled: true, mode: 'inbox', queue_id: q.json.id } } })).status, 200)
  const c = await visitorChat(agent.widget_key, `https://${A.slug}.example`, 'hola')
  assert.equal((await chatOn(c.token, c.conv, 'quiero hablar con una persona')).done.status, 'waiting_human')
  // ag1 no es de la cola Ventas: no la ve; el supervisor sí
  assert.equal((await IB.ag1.get(`${pa()}/v1/inbox/conversations/${c.conv}`)).status, 404)
  assert.ok((await IB.sup.get(`${pa()}/v1/inbox/conversations?view=waiting`)).json.items.some((x) => x.id === c.conv))
  const ag1id = (await IB.ag1.get(`${pa()}/v1/inbox/bootstrap`)).json.me.id
  assert.equal((await A.br.put(`${pa()}/v1/inbox/queues/${q.json.id}`, { name: 'Ventas', members: [ag1id] })).status, 200)
  assert.equal((await IB.ag1.get(`${pa()}/v1/inbox/conversations/${c.conv}`)).status, 200)
  // respuestas rápidas por cliente
  assert.equal((await IB.sup.post(`${pa()}/v1/inbox/quick-replies`, { shortcut: 'horario', text: 'Lunes a viernes de 9 a 18 h.' })).status, 200)
  assert.ok((await B.br.get(`${pb()}/v1/inbox/quick-replies`)).json.items.every((x) => x.shortcut !== 'horario'))
  await A.br.put(`${pa()}/v1/agents/${agent.id}`, { tools: { handoff: { enabled: false, mode: 'notify', queue_id: null } } })
})

/* ---------- WhatsApp (fase 2): 360dialog y YCloud simulados en el puerto 8799 ---------- */

const BSP = { sent: [], hooks: [], deleted: [] }
const BSP_KEYS = { d360: 'd360_key_ok_123', yc: 'yc_key_ok_123' }
const YC_SECRET = 'whsec_prueba_123'
let bspServer = null
function startBsp() {
  let n = 0
  bspServer = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const send = (status, j) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(j))
      }
      const b = body ? JSON.parse(body) : null
      const u = new URL(req.url, 'http://x')
      if (u.pathname.startsWith('/d360/')) {
        if (req.headers['d360-api-key'] !== BSP_KEYS.d360) return send(401, { error: { message: 'invalid key' } })
        const p = u.pathname.slice(5)
        if (p === '/health_status') return send(200, { health_status: { can_send_message: 'AVAILABLE' }, display_phone_number: '+52 55 1000 0001', quality_rating: 'GREEN', verified_name: 'Muebles A', status: 'CONNECTED' })
        if (p === '/v1/configs/webhook' && req.method === 'POST') {
          BSP.hooks.push({ provider: '360dialog', ...b })
          return send(201, { message: 'ok', ...b })
        }
        if (p === '/messages' && req.method === 'POST') {
          const id = `wamid.D${++n}`
          BSP.sent.push({ provider: '360dialog', id, ...b })
          return send(200, { messaging_product: 'whatsapp', messages: [{ id }] })
        }
        if (p === '/message_templates') return send(200, { data: [] })
      }
      if (u.pathname.startsWith('/yc/')) {
        if (req.headers['x-api-key'] !== BSP_KEYS.yc) return send(401, { error: { message: 'invalid key' } })
        const p = u.pathname.slice(3)
        if (p === '/whatsapp/phoneNumbers')
          return send(200, {
            items: [
              { id: 'pn1', phoneNumber: '+5215520000002', displayPhoneNumber: '+52 1 55 2000 0002', wabaId: 'waba1', verifiedName: 'Muebles A YC', qualityRating: 'GREEN', status: 'CONNECTED' },
              { id: 'pn2', phoneNumber: '+5215520000003', displayPhoneNumber: '+52 1 55 2000 0003', wabaId: 'waba1', verifiedName: 'Muebles A 2', qualityRating: 'YELLOW', status: 'CONNECTED' },
            ],
          })
        if (p === '/webhookEndpoints' && req.method === 'POST') {
          BSP.hooks.push({ provider: 'ycloud', ...b })
          return send(200, { id: 'we1', ...b, status: 'active', secret: YC_SECRET })
        }
        if (p.startsWith('/webhookEndpoints/') && req.method === 'DELETE') {
          BSP.deleted.push(p)
          return send(200, {})
        }
        if (p === '/whatsapp/messages/sendDirectly' && req.method === 'POST') {
          const id = `wamid.Y${++n}`
          BSP.sent.push({ provider: 'ycloud', id, ...b })
          return send(200, { id: `yc_${n}`, wamid: id, status: 'accepted', from: b.from, to: b.to })
        }
        if (p === '/whatsapp/templates')
          return send(200, {
            items: [
              { name: 'seguimiento', language: 'es_MX', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hola {{1}}, ¿seguimos con tu pedido {{2}}?' }] },
              { name: 'promo_img', language: 'es_MX', category: 'MARKETING', status: 'APPROVED', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Promo' }] },
              { name: 'pendiente', language: 'es_MX', category: 'UTILITY', status: 'PENDING', components: [{ type: 'BODY', text: 'x' }] },
            ],
          })
      }
      send(404, { error: { message: 'not found' } })
    })
  })
  return new Promise((ok) => bspServer.listen(8799, '127.0.0.1', ok))
}

/** Espera a que el BSP simulado reciba un envío que cumpla la condición */
async function bspWait(pred, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = BSP.sent.find(pred)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

/** Webhook de YCloud firmado como lo firma YCloud: HMAC-SHA256(secreto, `${t}.${cuerpo}`) */
function ycHook(channelId, payload, secret = YC_SECRET) {
  const raw = JSON.stringify(payload)
  const t = Math.floor(Date.now() / 1000)
  const s = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
  return fetch(`${BASE}/v1/wa/ycloud/${channelId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'YCloud-Signature': `t=${t},s=${s}` }, body: raw })
}
let evtN = 0
const ycInbound = (from, text, sendTime = new Date().toISOString()) => ({
  id: `evt_${++evtN}`,
  type: 'whatsapp.inbound_message.received',
  apiVersion: 'v2',
  createTime: sendTime,
  whatsappInboundMessage: { id: `in_${evtN}`, wamid: `wamid.IN${evtN}.${run}`, wabaId: 'waba1', from: `+${from}`, to: '+5215520000002', sendTime, type: 'text', text: { body: text }, customerProfile: { name: 'Laura WhatsApp' } },
})

const WA = {}

test('whatsapp: el cliente conecta su número de YCloud desde el portal y el asistente contesta', async () => {
  await startBsp()
  const agent = A.agents[2]
  WA.agent = agent
  // llave mala → mensaje claro; llave buena → sus números
  const bad = await A.br.post(`${pa()}/v1/whatsapp/${agent.id}/numbers`, { provider: 'ycloud', api_key: 'yc_key_mala_000' })
  assert.equal(bad.status, 400, bad.text)
  const nums = await A.br.post(`${pa()}/v1/whatsapp/${agent.id}/numbers`, { provider: 'ycloud', api_key: BSP_KEYS.yc })
  assert.equal(nums.status, 200, nums.text)
  assert.equal(nums.json.numbers.length, 2)
  // con dos números hay que elegir uno
  assert.equal((await A.br.post(`${pa()}/v1/whatsapp/${agent.id}`, { provider: 'ycloud', api_key: BSP_KEYS.yc })).status, 400)
  // un editor no conecta números; solo el owner
  const con = await A.br.post(`${pa()}/v1/whatsapp/${agent.id}`, { provider: 'ycloud', api_key: BSP_KEYS.yc, phone: '+52 1 55 2000 0002' })
  assert.equal(con.status, 200, con.text)
  WA.ch = con.json.channel
  assert.equal(WA.ch.phone, '5215520000002')
  assert.equal(WA.ch.quality_rating, 'GREEN')
  // se registró el webhook con nuestra URL y los eventos correctos
  const hook = BSP.hooks.find((h) => h.provider === 'ycloud')
  assert.ok(hook.url.endsWith(`/v1/wa/ycloud/${WA.ch.id}`), hook.url)
  assert.deepEqual(hook.enabledEvents.sort(), ['whatsapp.inbound_message.received', 'whatsapp.message.updated'])
  // la llave nunca regresa al portal
  const g = await A.br.get(`${pa()}/v1/whatsapp/${agent.id}`)
  assert.ok(!g.text.includes(BSP_KEYS.yc) && !g.text.includes(YC_SECRET))
  assert.equal(g.json.channel.last4, BSP_KEYS.yc.slice(-4))
  const ov = await A.br.get(`${pa()}/v1/overview`)
  assert.equal(ov.json.agents.find((a) => a.id === agent.id).channels.whatsapp, 'active')
  // el mismo número no se puede conectar dos veces
  const dup = await A.br.post(`${pa()}/v1/whatsapp/${A.agents[3].id}`, { provider: 'ycloud', api_key: BSP_KEYS.yc, phone: '5215520000002' })
  assert.equal(dup.status, 400, dup.text)

  // firma mala o proveedor equivocado: no entra
  assert.equal((await ycHook(WA.ch.id, ycInbound('5215511112222', 'hola'), 'whsec_otro')).status, 401)
  assert.equal((await fetch(`${BASE}/v1/wa/360dialog/${WA.ch.id}`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 404)

  // mensaje entrante → la IA contesta por WhatsApp al número del cliente
  const ev = ycInbound('5215511112222', 'Hola, ¿tienen sofás?')
  assert.equal((await ycHook(WA.ch.id, ev)).status, 200)
  const out = await bspWait((s) => s.provider === 'ycloud' && s.to === '+5215511112222' && /Respuesta simulada/.test(s.text?.body || ''))
  assert.ok(out, `no se envió la respuesta: ${JSON.stringify(BSP.sent)}`)
  assert.equal(out.from, '+5215520000002')
  WA.aiWamid = out.id

  // el BSP reintenta el mismo evento: no se duplica ni se contesta otra vez
  const before = BSP.sent.length
  assert.equal((await ycHook(WA.ch.id, ev)).status, 200)
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(BSP.sent.length, before, 'el reintento generó otra respuesta')
  const list = await A.br.get(`${pa()}/v1/inbox/conversations?view=ai`)
  const conv = list.json.items.find((x) => x.channel === 'whatsapp' && x.contact_phone === '5215511112222')
  assert.ok(conv, list.text)
  WA.conv = conv.id
  const d = await A.br.get(`${pa()}/v1/inbox/conversations/${conv.id}`)
  assert.equal(d.json.messages.filter((m) => m.role === 'user').length, 1)
  assert.equal(d.json.conversation.contact_name, 'Laura WhatsApp')
  assert.equal(d.json.channel.window_open, true)

  // estados de entrega: entregado → leído (y un «entregado» tardío no lo regresa)
  const st = (status) => ({ id: `evt_${++evtN}`, type: 'whatsapp.message.updated', apiVersion: 'v2', createTime: new Date().toISOString(), whatsappMessage: { id: 'x', wamid: WA.aiWamid, from: '+5215520000002', status } })
  await ycHook(WA.ch.id, st('read'))
  await ycHook(WA.ch.id, st('delivered'))
  await new Promise((r) => setTimeout(r, 500))
  const d2 = await A.br.get(`${pa()}/v1/inbox/conversations/${conv.id}`)
  assert.equal(d2.json.messages.find((m) => m.role === 'assistant').delivery, 'read')

  // B no ve el canal ni la conversación de A
  assert.equal((await B.br.get(`${pb()}/v1/whatsapp/${agent.id}`)).status, 404)
  assert.equal((await B.br.get(`${pb()}/v1/inbox/conversations/${conv.id}`)).status, 404)
})

test('whatsapp: bandeja con traspaso, ventana de 24 h y plantillas', async () => {
  const agent = WA.agent
  assert.equal((await A.br.put(`${pa()}/v1/agents/${agent.id}`, { tools: { handoff: { enabled: true, mode: 'inbox', no_agents: 'wait', max_wait_min: 0 } } })).status, 200)
  // el cliente pide una persona por WhatsApp: la IA no contesta, le llega el aviso de espera
  const sentBefore = BSP.sent.length
  assert.equal((await ycHook(WA.ch.id, ycInbound('5215511112222', 'quiero hablar con una persona'))).status, 200)
  assert.ok(await bspWait((s) => BSP.sent.indexOf(s) >= sentBefore && /comunicando con una persona/.test(s.text?.body || '')), 'no llegó el aviso de espera')
  await new Promise((r) => setTimeout(r, 500))
  assert.ok(!BSP.sent.slice(sentBefore).some((s) => /Respuesta simulada/.test(s.text?.body || '')), 'la IA respondió estando en espera')
  // el owner la toma y contesta: sale por WhatsApp con su texto
  assert.equal((await A.br.post(`${pa()}/v1/inbox/conversations/${WA.conv}/take`)).status, 200)
  const r = await A.br.post(`${pa()}/v1/inbox/conversations/${WA.conv}/messages`, { type: 'text', text: 'Hola Laura, soy del equipo. ¿Qué modelo te interesa?' })
  assert.equal(r.status, 200, r.text)
  assert.ok(await bspWait((s) => s.to === '+5215511112222' && /soy del equipo/.test(s.text?.body || '')))
  // nota interna: nunca sale por WhatsApp
  await A.br.post(`${pa()}/v1/inbox/conversations/${WA.conv}/messages`, { type: 'note', text: 'NOTA-WA-SECRETA' })
  await new Promise((r2) => setTimeout(r2, 300))
  assert.ok(!BSP.sent.some((s) => JSON.stringify(s).includes('NOTA-WA-SECRETA')))
  await A.br.post(`${pa()}/v1/inbox/conversations/${WA.conv}/close`)

  // contacto cuyo último mensaje fue hace 25 h: fuera de la ventana solo plantillas
  const old = new Date(Date.now() - 25 * 3600_000).toISOString()
  await ycHook(WA.ch.id, ycInbound('5215533334444', 'necesito hablar con una persona', old))
  let c2 = null
  for (let i = 0; i < 40 && !c2; i++) {
    await new Promise((r2) => setTimeout(r2, 150))
    c2 = (await A.br.get(`${pa()}/v1/inbox/conversations?view=waiting`)).json.items.find((x) => x.contact_phone === '5215533334444')
  }
  if (!c2) {
    const dbg = {}
    for (const v of ['ai', 'all', 'closed', 'waiting']) dbg[v] = (await A.br.get(`${pa()}/v1/inbox/conversations?view=${v}`)).json.items.filter((x) => x.channel === 'whatsapp').map((x) => [x.contact_phone, x.status, x.last_text])
    assert.fail(`no llegó la conversación vieja: ${JSON.stringify(dbg)}`)
  }
  assert.equal((await A.br.post(`${pa()}/v1/inbox/conversations/${c2.id}/take`)).status, 200)
  const d = await A.br.get(`${pa()}/v1/inbox/conversations/${c2.id}`)
  assert.equal(d.json.channel.window_open, false)
  assert.equal(d.json.can_reply, false)
  assert.equal(d.json.can_template, true)
  const txt = await A.br.post(`${pa()}/v1/inbox/conversations/${c2.id}/messages`, { type: 'text', text: 'hola' })
  assert.equal(txt.status, 409)
  assert.equal(txt.json.error.code, 'window_closed')
  // plantillas aprobadas (la pendiente no aparece; la de imagen no es compatible todavía)
  const tpls = await A.br.get(`${pa()}/v1/inbox/conversations/${c2.id}/templates`)
  assert.equal(tpls.status, 200, tpls.text)
  assert.deepEqual(tpls.json.items.map((t) => t.name).sort(), ['promo_img', 'seguimiento'])
  assert.equal(tpls.json.items.find((t) => t.name === 'promo_img').supported, false)
  assert.equal((await A.br.post(`${pa()}/v1/inbox/conversations/${c2.id}/template`, { name: 'seguimiento', language: 'es_MX', params: ['Laura'] })).status, 400, 'faltan variables')
  const sendT = await A.br.post(`${pa()}/v1/inbox/conversations/${c2.id}/template`, { name: 'seguimiento', language: 'es_MX', params: ['Laura', 'A-77'] })
  assert.equal(sendT.status, 200, sendT.text)
  const tsent = await bspWait((s) => s.type === 'template' && s.to === '+5215533334444')
  assert.equal(tsent.template.name, 'seguimiento')
  assert.deepEqual(tsent.template.components[0].parameters.map((x) => x.text), ['Laura', 'A-77'])
  const d3 = await A.br.get(`${pa()}/v1/inbox/conversations/${c2.id}`)
  assert.ok(d3.json.messages.some((m) => m.content.includes('pedido A-77')))
  await A.br.post(`${pa()}/v1/inbox/conversations/${c2.id}/close`)
  await A.br.put(`${pa()}/v1/agents/${agent.id}`, { tools: { handoff: { enabled: false, mode: 'notify' } } })
})

test('whatsapp: 360dialog con webhook por número y desconexión', async () => {
  const agent = A.agents[3]
  const con = await A.br.post(`${pa()}/v1/whatsapp/${agent.id}`, { provider: '360dialog', api_key: BSP_KEYS.d360 })
  assert.equal(con.status, 200, con.text)
  const ch = con.json.channel
  assert.equal(ch.phone, '525510000001')
  const hook = BSP.hooks.find((h) => h.provider === '360dialog')
  assert.ok(hook.url.endsWith(`/v1/wa/360dialog/${ch.id}`))
  const token = hook.headers['X-Zentekia-Token']
  assert.ok(token && token.length > 20)
  // evento en formato de la Cloud API de Meta
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '525510000001', phone_number_id: 'PNID' }, contacts: [{ profile: { name: 'Pedro' }, wa_id: '5215599998888' }], messages: [{ from: '5215599998888', id: `wamid.D360IN.${run}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: '¿Hacen envíos?' } }] } }] }],
  }
  const noTok = await fetch(`${BASE}/v1/wa/360dialog/${ch.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  assert.equal(noTok.status, 401)
  const ok = await fetch(`${BASE}/v1/wa/360dialog/${ch.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zentekia-Token': token }, body: JSON.stringify(payload) })
  assert.equal(ok.status, 200)
  const out = await bspWait((s) => s.provider === '360dialog' && s.to === '5215599998888')
  assert.ok(out, `no contestó por 360dialog: ${JSON.stringify(BSP.sent.slice(-3))}`)
  assert.equal(out.messaging_product, 'whatsapp')
  assert.match(out.text.body, /Respuesta simulada/)
  // desconectar: el canal desaparece y en YCloud se borra el webhook
  assert.equal((await A.br.del(`${pa()}/v1/whatsapp/${agent.id}`)).status, 200)
  assert.equal((await A.br.get(`${pa()}/v1/whatsapp/${agent.id}`)).json.channel, null)
  assert.equal((await A.br.del(`${pa()}/v1/whatsapp/${WA.agent.id}`)).status, 200)
  assert.ok(BSP.deleted.some((p) => p.endsWith('/we1')))
  // un webhook a un canal desconectado ya no entra
  assert.equal((await ycHook(WA.ch.id, ycInbound('5215511112222', 'hola'))).status, 404)
  bspServer.close()
})

/* ---------- Contact Center como producto aparte (sin agentes virtuales) ---------- */

test('contact center: cliente solo con agentes humanos, canal sin IA, licencias y cobro', async () => {
  const C = { br: new Browser(), slug: `solo-cc-${run}` }
  const pc = `/p/${C.slug}`
  // Zentekia da de alta un cliente solo con Contact Center y 1 licencia a $30
  assert.equal((await admin.post('/admin/v1/tenants', { name: 'Solo CC', slug: C.slug, owner_email: `owner@${C.slug}.com`, monthly_limit_usd: 10, enabled_models: [], products: { va: false, cc: false } })).status, 400, 'sin productos no se crea')
  const t = await admin.post('/admin/v1/tenants', { name: 'Solo CC', slug: C.slug, owner_email: `owner@${C.slug}.com`, monthly_limit_usd: 10, enabled_models: [], products: { va: false, cc: true, cc_seats: 1, cc_seat_price_usd: 30 } })
  assert.equal(t.status, 200, t.text)
  assert.match(t.json.invite_link, /\/cc\/#\/invitacion\//, 'el owner entra directo al Contact Center')
  await acceptInvite(C.br, pc, t.json.invite_link, 'ClaveSoloCC123')
  // el portal de agentes virtuales lleva al Contact Center; el Contact Center abre
  const root = await C.br.get(`${pc}/`)
  assert.equal(root.status, 302)
  assert.match(root.headers.get('location'), /\/cc\/$/)
  const app = await C.br.get(`${pc}/cc/`)
  assert.equal(app.status, 200)
  assert.match(app.text, /assets\/cc\.js/)
  // no puede crear asistentes de IA
  assert.equal((await C.br.post(`${pc}/v1/agents`, { name: 'IA' })).status, 403)
  // nace con un canal de chat web sin IA
  const chs = await C.br.get(`${pc}/v1/cc/channels`)
  assert.equal(chs.status, 200, chs.text)
  assert.equal(chs.json.items.length, 1)
  const ch = chs.json.items[0]
  assert.ok(ch.widget_key)
  const ov = await C.br.get(`${pc}/v1/overview`)
  assert.equal(ov.json.agents.find((a) => a.id === ch.id).mode, 'human')
  assert.deepEqual([ov.json.products.va, ov.json.products.cc], [false, true])
  await C.br.put(`${pc}/v1/security`, { allowed_origins: [`https://${C.slug}.example`] })
  // puede crear más canales
  const nuevo = await C.br.post(`${pc}/v1/cc/channels`, { name: 'Ventas' })
  assert.equal(nuevo.status, 200, nuevo.text)

  // el visitante escribe: la IA nunca contesta, entra directo a la cola
  const v = await visitorChat(ch.widget_key, `https://${C.slug}.example`, 'Hola, ¿tienen envíos?')
  assert.equal(v.text, '', `la IA contestó en un canal sin IA: ${v.text}`)
  assert.equal(v.done.status, 'waiting_human')
  const usage = await admin.get(`/admin/v1/usage`)
  assert.ok(!usage.json.rows.some((r) => r.slug === C.slug), `se cobró IA a un cliente sin agentes virtuales: ${JSON.stringify(usage.json.rows.filter((r) => r.slug === C.slug))}`)

  // 1 licencia: un agente sí, el segundo no
  const ag = new Browser()
  const inv = await C.br.post(`${pc}/v1/team/invite`, { email: `ana@${C.slug}.com`, role: 'agent' })
  assert.equal(inv.status, 200, inv.text)
  assert.equal((await C.br.post(`${pc}/v1/team/invite`, { email: `beto@${C.slug}.com`, role: 'agent' })).json.error.code, 'no_seats')
  await acceptInvite(ag, pc, inv.json.link, 'ClaveAnaCC123')
  // al ponerse en línea se le asigna la conversación que esperaba
  assert.equal((await ag.put(`${pc}/v1/inbox/presence`, { status: 'online' })).status, 200)
  let mine = []
  for (let i = 0; i < 30 && !mine.length; i++) {
    await new Promise((r) => setTimeout(r, 150))
    mine = (await ag.get(`${pc}/v1/inbox/conversations?view=mine`)).json.items
  }
  assert.equal(mine.length, 1, 'no se asignó la conversación al conectarse')
  assert.equal(mine[0].escalation_reason, 'direct')
  assert.equal((await ag.post(`${pc}/v1/inbox/conversations/${v.conv}/messages`, { type: 'text', text: 'Sí, enviamos a todo México.' })).status, 200)
  const h = await history(v.token, v.conv)
  assert.ok(h.messages.some((m) => m.sender === 'human' && /todo México/.test(m.content)))
  // aunque la persona devuelva la conversación, en un canal sin IA nadie automático contesta
  await ag.post(`${pc}/v1/inbox/conversations/${v.conv}/handback`)
  const again = await chatOn(v.token, v.conv, 'gracias')
  assert.equal(again.text, '')
  assert.notEqual(again.done.status, 'ai_active')
  await ag.put(`${pc}/v1/inbox/presence`, { status: 'offline' })

  // un cliente sin Contact Center no tiene bandeja
  assert.equal((await admin.put(`/admin/v1/tenants/${B.id}`, { products: { va: true, cc: false } })).status, 200)
  assert.equal((await B.br.get(`${pb()}/v1/inbox/bootstrap`)).status, 403)
  assert.equal((await B.br.get(`${pb()}/cc/`)).status, 403)

  // el estado de cuenta del mes cobra las licencias: 1 × $30
  const period = new Date().toISOString().slice(0, 7)
  assert.equal((await admin.post('/admin/v1/statements/close', { period })).status, 200)
  const st = (await admin.get(`/admin/v1/usage?period=${period}`)).json.statements.find((s) => s.slug === C.slug)
  assert.ok(st, 'no se generó estado de cuenta para el cliente solo con Contact Center')
  const seats = JSON.parse(st.lines_json).find((l) => l.type === 'seats')
  assert.equal(seats.seats, 1)
  assert.equal(st.total_micro, 30_000_000)
})
