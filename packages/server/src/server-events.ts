/**
 * The backoffice's live-update channel: `/umbraco/serverEventHub`, which the
 * client opens with `@microsoft/signalr` over a plain WebSocket (we report
 * `signalR.skipNegotiation`). This speaks just enough of SignalR's JSON hub
 * protocol to hold the connection: the handshake, keep-alive pings, and close.
 * Events are sent through `broadcast` once server-side changes publish them.
 *
 * Protocol: every message is JSON followed by the record separator U+001E.
 * The client opens with `{"protocol":"json","version":1}`; the server answers
 * `{}`. Pings are `{"type":6}`, invocations `{"type":1,...}`, close `{"type":7}`.
 */
import type { Server, ServerWebSocket } from 'bun'

const RS = '\u001e'

export interface HubSocketData {
  userKey: string
  handshaken: boolean
  /** Which hub the socket belongs to, when several share one server. */
  hub: string
}

export interface ServerEventHubOptions {
  /** How often to ping every socket; SignalR clients time out after 30 s of silence. */
  pingMs?: number
  /** Tags this hub's sockets, so `combineHubs` can route them. */
  name?: string
}

export interface ServerEventHub {
  readonly name: string
  /** Upgrades a signed-in request; answers 401 otherwise. `undefined` means upgraded. */
  upgrade(
    request: Request,
    server: Server<HubSocketData>,
    userKey: string | undefined,
  ): Response | undefined
  websocket: {
    open(ws: ServerWebSocket<HubSocketData>): void
    message(ws: ServerWebSocket<HubSocketData>, message: string | Buffer): void
    close(ws: ServerWebSocket<HubSocketData>): void
  }
  /** Sends a hub invocation to every connected client. */
  broadcast(target: string, args: unknown[]): number
  connections(): number
  stop(): void
}

export function createServerEventHub(options: ServerEventHubOptions = {}): ServerEventHub {
  const sockets = new Set<ServerWebSocket<HubSocketData>>()
  const send = (ws: ServerWebSocket<HubSocketData>, message: unknown) =>
    ws.send(`${JSON.stringify(message)}${RS}`)

  const timer = setInterval(() => {
    for (const ws of sockets) if (ws.data.handshaken) send(ws, { type: 6 })
  }, options.pingMs ?? 15_000)
  timer.unref()

  const name = options.name ?? 'serverEventHub'
  return {
    name,
    upgrade(request, server, userKey) {
      if (!userKey) return new Response('Unauthorized', { status: 401 })
      const upgraded = server.upgrade(request, { data: { userKey, handshaken: false, hub: name } })
      return upgraded ? undefined : new Response('Expected a WebSocket upgrade', { status: 400 })
    },

    websocket: {
      open(ws) {
        sockets.add(ws)
      },
      message(ws, message) {
        const text = typeof message === 'string' ? message : message.toString('utf8')
        for (const record of text.split(RS)) {
          if (!record) continue
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(record) as Record<string, unknown>
          } catch {
            ws.close(1003, 'Invalid message')
            return
          }
          if (!ws.data.handshaken) {
            if (parsed.protocol !== 'json') {
              send(ws, { error: `The protocol '${String(parsed.protocol)}' is not supported.` })
              ws.close()
              return
            }
            ws.data.handshaken = true
            send(ws, {})
            continue
          }
          if (parsed.type === 7) ws.close()
          // Pings (6) and anything else the client sends need no answer.
        }
      },
      close(ws) {
        sockets.delete(ws)
      },
    },

    broadcast(target, args) {
      let sent = 0
      for (const ws of sockets) {
        if (!ws.data.handshaken) continue
        send(ws, { type: 1, target, arguments: args })
        sent += 1
      }
      return sent
    },

    connections: () => sockets.size,

    stop() {
      clearInterval(timer)
      for (const ws of sockets) ws.close(1001, 'Server shutting down')
      sockets.clear()
    },
  }
}

/** One Bun websocket handler for several hubs, routed by the hub each socket joined. */
export function combineHubs(hubs: readonly ServerEventHub[]): ServerEventHub['websocket'] {
  const of = (ws: ServerWebSocket<HubSocketData>) =>
    (hubs.find((hub) => hub.name === ws.data.hub) ?? hubs[0]) as ServerEventHub
  return {
    open: (ws) => of(ws).websocket.open(ws),
    message: (ws, message) => of(ws).websocket.message(ws, message),
    close: (ws) => of(ws).websocket.close(ws),
  }
}
