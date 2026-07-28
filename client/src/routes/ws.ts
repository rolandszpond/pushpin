import type { BunRequest, Server, ServerWebSocket } from 'bun'
import { resolveApp } from '../middleware/resolve-app'
import { trackConnect, trackDisconnect } from '../lib/registry'
import type { WireMessage } from '../types'
import type { App } from '../lib/store'
import { nanoid } from 'nanoid'

export type WsData = {
    subscribeKey: string
    channel: string
    app?: App
    socketId?: string
}

/**
 * WebSocket endpoint
 *
 * Clients connect with:
 *   ws://your-service.com/app/:subscribeKey?channel=my-channel
 *
 * The subscribeKey is public — safe to use in frontend code.
 * It can only receive messages, not publish.
 *
 * The upgrade always succeeds if a channel is present; subscribeKey validation
 * happens in open() so the client gets an `error` message frame instead of a
 * bare connection failure (the SDK relies on that frame to stop reconnecting).
 */
export function wsUpgradeRoute(req: BunRequest<'/app/:subscribeKey'>, server: Server) {
    const { subscribeKey } = req.params
    const channel = new URL(req.url).searchParams.get('channel')
    if (!channel) {
        return Response.json({ ok: false, error: 'Missing channel query param' }, { status: 400 })
    }

    const upgraded = server.upgrade(req, { data: { subscribeKey, channel } satisfies WsData })
    if (!upgraded) {
        return Response.json({ ok: false, error: 'WebSocket upgrade failed' }, { status: 400 })
    }
}

export const websocketHandlers = {
    open(ws: ServerWebSocket<WsData>) {
        const { subscribeKey, channel } = ws.data

        const app = resolveApp(subscribeKey)
        if (!app) {
            ws.send(JSON.stringify({ event: 'error', data: { message: 'Invalid subscribe key' } }))
            ws.close()
            return
        }

        const socketId = nanoid(12)
        ws.data.app = app
        ws.data.socketId = socketId

        // Bun's built-in pub/sub — subscribe to namespaced channel
        const topic = `${app.id}:${channel}`
        ws.subscribe(topic)

        trackConnect(app.id, channel)

        ws.send(JSON.stringify({
            event: 'pushpin:connected',
            data: {
                socketId,
                channel,
            },
            channel,
            appId: app.id,
            timestamp: Date.now(),
        } satisfies WireMessage))
    },

    close(ws: ServerWebSocket<WsData>) {
        const { app, channel } = ws.data
        if (!app) return

        const topic = `${app.id}:${channel}`
        ws.unsubscribe(topic)
        trackDisconnect(app.id, channel)
    },

    message() {
        // Clients are receive-only — ignore inbound messages
    },
}
