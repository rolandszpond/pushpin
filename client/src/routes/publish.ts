import Elysia, { t } from 'elysia'
import { resolveApp } from '../middleware/resolve-app'
import type { WireMessage } from '../types'
import type { App } from '../lib/store'

function fireWebhook(app: App, message: WireMessage, delivered: number) {
    if (!app.webhookUrl) return
    fetch(app.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: message.appId, channel: message.channel, event: message.event, data: message.data, timestamp: message.timestamp, delivered }),
    }).catch(() => {})
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
export const publishRoute = new Elysia()
    .post(
        '/publish',
        async ({ body, headers, set, server }) => {
            // Resolve publish key from Authorization header
            const publishKey = headers['authorization']?.replace('Bearer ', '').trim()
            if (!publishKey) {
                set.status = 401
                return { ok: false, error: 'Missing Authorization header' }
            }

            const app = await resolveApp(publishKey)
            if (!app) {
                set.status = 401
                return { ok: false, error: 'Invalid publish key' }
            }

            // Verify it's actually the publish key, not the subscribe key
            if (app.publishKey !== publishKey) {
                set.status = 403
                return { ok: false, error: 'Subscribe key cannot publish' }
            }

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
            const delivered = server?.publish(topic, JSON.stringify(message)) ?? 0
            fireWebhook(app, message, delivered)

            return { ok: true, delivered }
        },
        {
            body: t.Object({
                channel: t.String(),
                event:   t.String(),
                data:    t.Optional(t.Any()),
            }),
        }
    )

    // Batch publish — send to multiple channels at once
    .post(
        '/publish/batch',
        async ({ body, headers, set, server }) => {
            const publishKey = headers['authorization']?.replace('Bearer ', '').trim()
            if (!publishKey) {
                set.status = 401
                return { ok: false, error: 'Missing Authorization header' }
            }

            const app = await resolveApp(publishKey)
            if (!app || app.publishKey !== publishKey) {
                set.status = 401
                return { ok: false, error: 'Invalid publish key' }
            }

            const results = body.messages.map(({ channel, event, data }) => {
                const message: WireMessage = {
                    event,
                    data: data ?? null,
                    channel,
                    appId: app.id,
                    timestamp: Date.now(),
                }
                const topic = `${app.id}:${channel}`
                const delivered = server?.publish(topic, JSON.stringify(message)) ?? 0
                fireWebhook(app, message, delivered)
                return { channel, event, delivered }
            })

            return { ok: true, results }
        },
        {
            body: t.Object({
                messages: t.Array(t.Object({
                    channel: t.String(),
                    event:   t.String(),
                    data:    t.Optional(t.Any()),
                }))
            })
        }
    )
