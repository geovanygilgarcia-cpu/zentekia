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
