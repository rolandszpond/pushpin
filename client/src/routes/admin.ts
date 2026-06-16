import Elysia, { t } from 'elysia'
import { createApp, listApps, getAppById, updateApp, deleteApp, getMonthlyUsage, getAllMonthlyUsage, getRecentMessages } from '../lib/store'
import { getStats, getAllStats } from '../lib/registry'

const adminAuth = (headers: Record<string, string | undefined>, set: any) => {
    const secret = headers['x-admin-secret']
    if (secret !== process.env.ADMIN_SECRET) {
        set.status = 401
        return false
    }
    return true
}

export const adminRoute = new Elysia({ prefix: '/admin' })

    // ── Create app ──────────────────────────────────────────────────────────
    .post(
        '/apps',
        ({ body, headers, set }) => {
            if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
            const app = createApp(body.name)
            return { ok: true, app }
        },
        {
            body: t.Object({
                name: t.String({ minLength: 1 }),
            }),
        }
    )

    // ── List apps ───────────────────────────────────────────────────────────
    .get('/apps', ({ headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, apps: listApps() }
    })

    // ── Get app ─────────────────────────────────────────────────────────────
    .get('/apps/:id', ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        const app = getAppById(params.id)
        if (!app) { set.status = 404; return { ok: false, error: 'Not found' } }
        return { ok: true, app }
    })

    // ── Update app (set/clear webhook) ──────────────────────────────────────
    .patch(
        '/apps/:id',
        ({ params, body, headers, set }) => {
            if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
            const app = updateApp(params.id, { webhookUrl: body.webhookUrl })
            if (!app) { set.status = 404; return { ok: false, error: 'Not found' } }
            return { ok: true, app }
        },
        {
            body: t.Object({
                webhookUrl: t.Union([t.String({ format: 'uri' }), t.Null()]),
            }),
        }
    )

    // ── Delete app ──────────────────────────────────────────────────────────
    .delete('/apps/:id', ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        const deleted = deleteApp(params.id)
        if (!deleted) { set.status = 404; return { ok: false, error: 'Not found' } }
        return { ok: true }
    })

    // ── Live connection stats ────────────────────────────────────────────────
    .get('/stats', ({ headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, stats: getAllStats() }
    })

    .get('/stats/:appId', ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, stats: getStats(params.appId) }
    })

    // ── Monthly usage ────────────────────────────────────────────────────────
    .get('/usage', ({ headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, usage: getAllMonthlyUsage() }
    })

    .get('/usage/:appId', ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, usage: getMonthlyUsage(params.appId) }
    })

    // ── Recent message log ───────────────────────────────────────────────────
    .get('/logs/:appId', ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, messages: getRecentMessages(params.appId) }
    })
