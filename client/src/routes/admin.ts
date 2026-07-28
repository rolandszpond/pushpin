import type { BunRequest } from 'bun'
import { createApp, listApps, getAppById, updateApp, deleteApp, importApps, type App } from '../lib/store'
import { getStats, getAllStats } from '../lib/registry'
import { json, isAuthorized } from '../lib/http'

function isValidWebhookUrl(url: unknown): url is string {
    if (typeof url !== 'string') return false
    try { new URL(url); return true } catch { return false }
}

function isExportedApp(a: any): a is App {
    return typeof a?.id === 'string'
        && typeof a?.name === 'string'
        && typeof a?.publishKey === 'string'
        && typeof a?.subscribeKey === 'string'
        && typeof a?.createdAt === 'string'
        && (a.webhookUrl === undefined || a.webhookUrl === null || typeof a.webhookUrl === 'string')
}

export const adminRoutes = {
    // ── Create / list apps ──────────────────────────────────────────────────
    '/admin/apps': {
        POST: async (req: Request) => {
            if (!isAuthorized(req)) return json(req, { ok: false, error: 'Unauthorized' }, 401)

            let body: unknown
            try { body = await req.json() } catch { return json(req, { ok: false, error: 'Invalid JSON body' }, 400) }
            const name = (body as any)?.name
            if (typeof name !== 'string' || name.length < 1) {
                return json(req, { ok: false, error: 'name is required' }, 422)
            }

            const app = createApp(name)
            return json(req, { ok: true, app })
        },

        GET: (req: Request) => {
            if (!isAuthorized(req)) return json(req, { ok: false, error: 'Unauthorized' }, 401)
            return json(req, { ok: true, apps: listApps() })
        },
    },

    // ── Get / update (webhook) / delete a single app ────────────────────────
    '/admin/apps/:id': {
        GET: (req: BunRequest<'/admin/apps/:id'>) => {
            if (!isAuthorized(req)) return json(req, { ok: false, error: 'Unauthorized' }, 401)
            const app = getAppById(req.params.id)
            if (!app) return json(req, { ok: false, error: 'Not found' }, 404)
            return json(req, { ok: true, app })
        },

        PATCH: async (req: BunRequest<'/admin/apps/:id'>) => {
            if (!isAuthorized(req)) return json(req, { ok: false, error: 'Unauthorized' }, 401)

            let body: unknown
            try { body = await req.json() } catch { return json(req, { ok: false, error: 'Invalid JSON body' }, 400) }
            const webhookUrl = (body as any)?.webhookUrl
            if (webhookUrl !== undefined && webhookUrl !== null && !isValidWebhookUrl(webhookUrl)) {
                return json(req, { ok: false, error: 'webhookUrl must be a valid URL or null' }, 422)
            }

            const app = updateApp(req.params.id, { webhookUrl })
            if (!app) return json(req, { ok: false, error: 'Not found' }, 404)
            return json(req, { ok: true, app })
        },

        DELETE: (req: BunRequest<'/admin/apps/:id'>) => {
            if (!isAuthorized(req)) return json(req, { ok: false, error: 'Unauthorized' }, 401)
            const app = deleteApp(req.params.id)
            if (!app) return json(req, { ok: false, error: 'Not found' }, 404)
            return json(req, { ok: true })
        },
    },

    // ── Live connection stats ────────────────────────────────────────────────
    '/admin/stats': {
        GET: (req: Request) => {
            if (!isAuthorized(req)) return json(req, { ok: false, error: 'Unauthorized' }, 401)
            return json(req, { ok: true, stats: getAllStats() })
        },
    },

    '/admin/stats/:appId': {
        GET: (req: BunRequest<'/admin/stats/:appId'>) => {
            if (!isAuthorized(req)) return json(req, { ok: false, error: 'Unauthorized' }, 401)
            return json(req, { ok: true, stats: getStats(req.params.appId) })
        },
    },

    // ── Export / import apps (restore after an ephemeral redeploy) ──────────
    '/admin/export': {
        GET: (req: Request) => {
            if (!isAuthorized(req)) return json(req, { ok: false, error: 'Unauthorized' }, 401)
            return json(req, { ok: true, exportedAt: new Date().toISOString(), apps: listApps() })
        },
    },

    '/admin/import': {
        POST: async (req: Request) => {
            if (!isAuthorized(req)) return json(req, { ok: false, error: 'Unauthorized' }, 401)

            let body: unknown
            try { body = await req.json() } catch { return json(req, { ok: false, error: 'Invalid JSON body' }, 400) }
            const apps = (body as any)?.apps
            if (!Array.isArray(apps) || !apps.every(isExportedApp)) {
                return json(req, { ok: false, error: 'apps must be an array of previously-exported app objects' }, 422)
            }

            const imported = importApps(apps)
            return json(req, { ok: true, imported })
        },
    },
}
