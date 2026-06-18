import Elysia, { t } from 'elysia'
import { resolveApp } from '../middleware/resolve-app'
import { trackConnect, trackDisconnect, getStats } from '../lib/registry'
import { trackMonthlyConnect } from '../lib/store'
import type { WireMessage } from '../types'
import { nanoid } from 'nanoid'

/**
 * WebSocket endpoint
 *
 * Clients connect with:
 *   ws://your-service.com/app/:subscribeKey?channel=my-channel
 *
 * The subscribeKey is public — safe to use in frontend code.
 * It can only receive messages, not publish.
 */
export const wsRoute = new Elysia()
    .ws('/app/:subscribeKey', {
        query: t.Object({
            channel: t.String(),
        }),
        params: t.Object({
            subscribeKey: t.String(),
        }),

        async open(ws) {
            const { subscribeKey } = ws.data.params
            const { channel } = ws.data.query

            // Validate subscribe key
            const app = await resolveApp(subscribeKey)
            if (!app) {
                ws.send(JSON.stringify({ event: 'error', data: { message: 'Invalid subscribe key' } }))
                ws.close()
                return
            }

            // Attach app context to the ws for use in close()
            ;(ws as any)._app = app
            ;(ws as any)._channel = channel
            ;(ws as any)._socketId = nanoid(12)

            // Bun's built-in pub/sub — subscribe to namespaced channel
            const topic = `${app.id}:${channel}`
            ws.subscribe(topic)

            if (app.connectionLimit !== null && getStats(app.id).totalConnections >= app.connectionLimit) {
                ws.send(JSON.stringify({ event: 'error', data: { message: 'Connection limit reached' } }))
                ws.close()
                return
            }

            trackConnect(app.id, channel)
            trackMonthlyConnect(app.id, getStats(app.id).totalConnections)

            ws.send(JSON.stringify({
                event: 'pushpin:connected',
                data: {
                    socketId: (ws as any)._socketId,
                    channel,
                },
                channel,
                appId: app.id,
                timestamp: Date.now(),
            } satisfies WireMessage))
        },

        close(ws) {
            const app = (ws as any)._app
            const channel = (ws as any)._channel
            if (!app || !channel) return

            const topic = `${app.id}:${channel}`
            ws.unsubscribe(topic)
            trackDisconnect(app.id, channel)
        },

        message() {
            // Clients are receive-only — ignore inbound messages
        },
    })
