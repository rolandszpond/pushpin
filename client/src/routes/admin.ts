import Elysia, { t } from 'elysia'
import { createApp, listApps, getAppById, deleteApp } from '../lib/store'
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
        async ({ body, headers, set }) => {
            if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }

            const app = await createApp(body.name)
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

        const apps = await listApps()
        return { ok: true, apps }
    })

    // ── Get app ─────────────────────────────────────────────────────────────
    .get('/apps/:id', async ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }

        const app = await getAppById(params.id)
        if (!app) { set.status = 404; return { ok: false, error: 'Not found' } }
        return { ok: true, app }
    })

    // ── Delete app ──────────────────────────────────────────────────────────
    .delete('/apps/:id', async ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }

        const deleted = await deleteApp(params.id)
        if (!deleted) { set.status = 404; return { ok: false, error: 'Not found' } }
        return { ok: true }
    })

    // ── Stats: all apps ─────────────────────────────────────────────────────
    .get('/stats', ({ headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, stats: getAllStats() }
    })

    // ── Stats: single app ───────────────────────────────────────────────────
    .get('/stats/:appId', ({ params, headers, set }) => {
        if (!adminAuth(headers as any, set)) return { ok: false, error: 'Unauthorized' }
        return { ok: true, stats: getStats(params.appId) }
    })
