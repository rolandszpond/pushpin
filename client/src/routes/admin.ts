import Elysia, { t } from 'elysia'
import { createApp, listApps, getAppById, updateApp, deleteApp, getMonthlyUsage, getAllMonthlyUsage, getRecentMessages } from '../lib/store'
import { getStats, getAllStats } from '../lib/registry'
import { addToCache, updateInCache, removeFromCache, initCache } from '../lib/cache'

const adminAuth = (headers: Record<string, string | undefined>, set: any) => {
    const secret = headers['x-admin-secret']
    if (secret !== process.env.ADMIN_SECRET) {
        set.status = 401
        return false
    }
    return true
}

export const adminRoute = new Elysia({ prefix: '/admin' })

    // ── Rebuild app cache from DB ────────────────────────────────────────────
    .post('/init', async ({ headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        await initCache()
        return { ok: true }
    })

    // ── Create app ──────────────────────────────────────────────────────────
    .post(
        '/apps',
        async ({ body, headers, set }) => {
            if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
            const app = await createApp(body.name)
            addToCache(app)
            return { ok: true, app }
        },
        {
            body: t.Object({
                name: t.String({ minLength: 1 }),
            }),
        }
    )

    // ── List apps ───────────────────────────────────────────────────────────
    .get('/apps', async ({ headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, apps: await listApps() }
    })

    // ── Get app ─────────────────────────────────────────────────────────────
    .get('/apps/:id', async ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        const app = await getAppById(params.id)
        if (!app) { set.status = 404; return { ok: false, error: 'Not found' } }
        return { ok: true, app }
    })

    // ── Update app (set/clear webhook) ──────────────────────────────────────
    .patch(
        '/apps/:id',
        async ({ params, body, headers, set }) => {
            if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
            const app = await updateApp(params.id, { webhookUrl: body.webhookUrl })
            if (!app) { set.status = 404; return { ok: false, error: 'Not found' } }
            updateInCache(app)
            return { ok: true, app }
        },
        {
            body: t.Object({
                webhookUrl: t.Union([t.String({ format: 'uri' }), t.Null()]),
            }),
        }
    )

    // ── Delete app ──────────────────────────────────────────────────────────
    .delete('/apps/:id', async ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        const app = await deleteApp(params.id)
        if (!app) { set.status = 404; return { ok: false, error: 'Not found' } }
        removeFromCache(app)
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
    .get('/usage', async ({ headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, usage: await getAllMonthlyUsage() }
    })

    .get('/usage/:appId', async ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, usage: await getMonthlyUsage(params.appId) }
    })

    // ── Recent message log ───────────────────────────────────────────────────
    .get('/logs/:appId', async ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, messages: await getRecentMessages(params.appId) }
    })
