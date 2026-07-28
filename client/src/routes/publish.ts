import type { Server } from 'bun'
import { resolveApp } from '../middleware/resolve-app'
import type { WireMessage } from '../types'
import type { App } from '../lib/store'
import { json } from '../lib/http'

function fireWebhook(app: App, message: WireMessage, delivered: number) {
    if (!app.webhookUrl) return
    fetch(app.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: message.appId, channel: message.channel, event: message.event, data: message.data, timestamp: message.timestamp, delivered }),
    }).catch(() => {})
}

type PublishBody = { channel: string; event: string; data?: unknown }

function isPublishBody(body: any): body is PublishBody {
    return typeof body?.channel === 'string' && typeof body?.event === 'string'
}

/**
 * Publish endpoint
 *
 * POST /publish
 * Authorization: Bearer <publishKey>
 *
 * Body: { channel, event, data? }
 *
 * The publishKey is secret — only use it server-side (Cloud Functions, backends).
 */
export const publishRoutes = {
    '/publish': {
        POST: async (req: Request, server: Server) => {
            // Resolve publish key from Authorization header
            const publishKey = req.headers.get('authorization')?.replace('Bearer ', '').trim()
            if (!publishKey) return json(req, { ok: false, error: 'Missing Authorization header' }, 401)

            const app = resolveApp(publishKey)
            if (!app) return json(req, { ok: false, error: 'Invalid publish key' }, 401)

            // Verify it's actually the publish key, not the subscribe key
            if (app.publishKey !== publishKey) return json(req, { ok: false, error: 'Subscribe key cannot publish' }, 403)

            let body: unknown
            try { body = await req.json() } catch { return json(req, { ok: false, error: 'Invalid JSON body' }, 400) }
            if (!isPublishBody(body)) return json(req, { ok: false, error: 'channel and event are required strings' }, 422)

            const { channel, event, data } = body

            const message: WireMessage = {
                event,
                data: data ?? null,
                channel,
                appId: app.id,
                timestamp: Date.now(),
            }

            // Broadcast via Bun's built-in pub/sub
            const topic = `${app.id}:${channel}`
            const delivered = server.publish(topic, JSON.stringify(message))
            fireWebhook(app, message, delivered)

            return json(req, { ok: true, delivered })
        },
    },

    // Batch publish — send to multiple channels at once
    '/publish/batch': {
        POST: async (req: Request, server: Server) => {
            const publishKey = req.headers.get('authorization')?.replace('Bearer ', '').trim()
            if (!publishKey) return json(req, { ok: false, error: 'Missing Authorization header' }, 401)

            const app = resolveApp(publishKey)
            if (!app || app.publishKey !== publishKey) return json(req, { ok: false, error: 'Invalid publish key' }, 401)

            let body: unknown
            try { body = await req.json() } catch { return json(req, { ok: false, error: 'Invalid JSON body' }, 400) }
            const messages = (body as any)?.messages
            if (!Array.isArray(messages) || !messages.every(isPublishBody)) {
                return json(req, { ok: false, error: 'messages must be an array of { channel, event, data? }' }, 422)
            }

            const results = (messages as PublishBody[]).map(({ channel, event, data }) => {
                const message: WireMessage = {
                    event,
                    data: data ?? null,
                    channel,
                    appId: app.id,
                    timestamp: Date.now(),
                }
                const topic = `${app.id}:${channel}`
                const delivered = server.publish(topic, JSON.stringify(message))
                fireWebhook(app, message, delivered)
                return { channel, event, delivered }
            })

            return json(req, { ok: true, results })
        },
    },
}
