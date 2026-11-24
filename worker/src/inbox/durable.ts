/*
  Durable Objects de la bandeja (fase 1).

  InboxHubDO   · uno por cliente (idFromName(tenant_id))
    - WebSockets de los agentes con la API de hibernación (no cobra mientras nadie habla)
    - difunde eventos de la bandeja (solo ids y estados; cada quien vuelve a pedir lo que puede ver)
    - reparto automático, de uno en uno por cliente (hace también el papel del QueueDO del spec)
    - si un agente se desconecta y no vuelve en GRACE_MS, sus conversaciones regresan a la cola

  ConversationDO · uno por conversación (idFromName(`${tenant_id}:${conversation_id}`))
    - WebSocket del visitante para recibir en vivo los mensajes de la persona que atiende
    - alarma del tiempo máximo en espera (waiting_human)

  Las peticiones internas llegan del propio Worker con el encabezado x-tenant ya validado;
  estos objetos no son accesibles desde internet.
*/
import type { Env } from '../env'
import { onAgentGone, onWaitTimeout, runDispatch } from './core'
import { processInbound } from '../channels/process'
import type { WaInbound } from '../channels/whatsapp'

const GRACE_MS = 60_000

interface AgentAttachment {
  u: string // usuario
  t: string // tenant
}

const jsonRes = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

export class InboxHubDO implements DurableObject {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  /** Ejecuta en orden (una tarea a la vez) aunque haya I/O de por medio */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  private sockets(userId?: string): WebSocket[] {
    return this.state.getWebSockets(userId ? `u:${userId}` : undefined)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const tenantId = request.headers.get('x-tenant') || ''
    if (!tenantId) return jsonRes({ error: 'tenant' }, 400)
    await this.state.storage.put('tenant', tenantId)

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return jsonRes({ error: 'upgrade' }, 426)
      const userId = request.headers.get('x-user') || ''
      if (!userId) return jsonRes({ error: 'user' }, 400)
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]
      this.state.acceptWebSocket(server, [`u:${userId}`])
      server.serializeAttachment({ u: userId, t: tenantId } satisfies AgentAttachment)
      await this.state.storage.delete(`gone:${userId}`)
      server.send(JSON.stringify({ type: 'hello', at: Date.now() }))
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const text = await request.text()
      for (const ws of this.sockets()) {
        try {
          ws.send(text)
        } catch {
          /* socket cerrado */
        }
      }
      return jsonRes({ ok: true })
    }

    if (url.pathname === '/dispatch' && request.method === 'POST') {
      const b = (await request.json().catch(() => ({}))) as { conversation_id?: string | null }
      const r = await this.serial(() => runDispatch(this.env, tenantId, b.conversation_id ?? null))
      return jsonRes(r)
    }

    if (url.pathname === '/connected') {
      const ids = new Set<string>()
      for (const ws of this.sockets()) {
        const a = ws.deserializeAttachment() as AgentAttachment | null
        if (a) ids.add(a.u)
      }
      return jsonRes({ users: [...ids] })
    }

    return jsonRes({ error: 'not_found' }, 404)
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // El navegador manda "ping" cada 25 s para que proxies y redes móviles no corten la conexión
    if (message === 'ping') ws.send('pong')
  }

  async webSocketClose(ws: WebSocket) {
    await this.gone(ws)
  }

  async webSocketError(ws: WebSocket) {
    await this.gone(ws)
  }

  private async gone(ws: WebSocket) {
    const a = ws.deserializeAttachment() as AgentAttachment | null
    if (!a) return
    const others = this.sockets(a.u).filter((s) => s !== ws && s.readyState === WebSocket.OPEN)
    if (others.length) return
    await this.state.storage.put(`gone:${a.u}`, Date.now())
    const cur = await this.state.storage.getAlarm()
    if (!cur) await this.state.storage.setAlarm(Date.now() + GRACE_MS)
  }

  async alarm() {
    const tenantId = (await this.state.storage.get<string>('tenant')) || ''
    if (!tenantId) return
    const gone = await this.state.storage.list<number>({ prefix: 'gone:' })
    let pending = false
    for (const [key, since] of gone) {
      const userId = key.slice('gone:'.length)
      if (this.sockets(userId).some((s) => s.readyState === WebSocket.OPEN)) {
        await this.state.storage.delete(key)
        continue
      }
      if (Date.now() - since < GRACE_MS - 1000) {
        pending = true
        continue
      }
      await this.state.storage.delete(key)
      await this.serial(async () => {
        await onAgentGone(this.env, tenantId, userId)
        await runDispatch(this.env, tenantId, null)
      }).catch((e) => console.error('agent_gone', e))
    }
    if (pending) await this.state.storage.setAlarm(Date.now() + 5_000)
  }
}

interface RoomTimer {
  tenant_id: string
  conversation_id: string
  at: number
}

export class ConversationDO implements DurableObject {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WhatsApp: mensajes de un contacto, uno a la vez y en orden de llegada.
    // Se responde de inmediato; el procesamiento (IA incluida) sigue en este objeto.
    if (url.pathname === '/process' && request.method === 'POST') {
      const b = (await request.json().catch(() => null)) as { kind?: string; tenant_id?: string; channel_id?: string; event?: WaInbound } | null
      if (!b || b.kind !== 'wa_inbound' || !b.tenant_id || !b.channel_id || !b.event) return jsonRes({ error: 'invalid' }, 400)
      const ctx = { waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
      const job = () => processInbound(this.env, ctx, b.tenant_id!, b.channel_id!, b.event!)
      const run = this.chain.then(job, job)
      this.chain = run.catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'wa_inbound', tenant_id: b.tenant_id, error: e instanceof Error ? e.message : String(e) })))
      this.state.waitUntil(this.chain)
      return jsonRes({ ok: true }, 202)
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return jsonRes({ error: 'upgrade' }, 426)
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]
      this.state.acceptWebSocket(server)
      server.send(JSON.stringify({ type: 'hello', at: Date.now() }))
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const text = await request.text()
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(text)
        } catch {
          /* socket cerrado */
        }
      }
      return jsonRes({ ok: true })
    }

    if (url.pathname === '/timeout' && request.method === 'POST') {
      const b = (await request.json().catch(() => ({}))) as Partial<RoomTimer> & { cancel?: boolean }
      if (b.cancel) {
        await this.state.storage.delete('timer')
        await this.state.storage.deleteAlarm()
        return jsonRes({ ok: true })
      }
      if (!b.tenant_id || !b.conversation_id || !b.at) return jsonRes({ error: 'invalid' }, 400)
      await this.state.storage.put('timer', { tenant_id: b.tenant_id, conversation_id: b.conversation_id, at: b.at } satisfies RoomTimer)
      await this.state.storage.setAlarm(b.at)
      return jsonRes({ ok: true })
    }

    return jsonRes({ error: 'not_found' }, 404)
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send('pong')
  }

  async alarm() {
    const t = await this.state.storage.get<RoomTimer>('timer')
    if (!t) return
    await this.state.storage.delete('timer')
    await onWaitTimeout(this.env, t.tenant_id, t.conversation_id).catch((e) => console.error('wait_timeout', e))
  }
}
