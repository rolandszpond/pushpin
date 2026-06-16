/**
 * App store — backed entirely by Redis.
 * No Postgres needed.
 *
 * Keys used:
 *   pushpin:apps                  → Redis Set of all app IDs
 *   pushpin:app:id:{id}           → Hash of app fields
 *   pushpin:app:pk:{publishKey}   → app ID (lookup by publish key)
 *   pushpin:app:sk:{subscribeKey} → app ID (lookup by subscribe key)
 */

import { redis } from './redis'
import { nanoid } from 'nanoid'

export type App = {
    id: string
    name: string
    publishKey: string
    subscribeKey: string
    createdAt: string // ISO string
    webhookUrl?: string
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

const key = {
    all:         () => `pushpin:apps`,
    byId:        (id: string) => `pushpin:app:id:${id}`,
    byPublish:   (pk: string) => `pushpin:app:pk:${pk}`,
    bySubscribe: (sk: string) => `pushpin:app:sk:${sk}`,
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createApp(name: string): Promise<App> {
    const app: App = {
        id:           nanoid(16),
        name,
        publishKey:   `pk_${nanoid(32)}`,
        subscribeKey: `sk_${nanoid(32)}`,
        createdAt:    new Date().toISOString(),
    }

    await Promise.all([
        // Store the app fields as a Redis hash
        redis.hset(key.byId(app.id), app),
        // Index by both keys for fast lookup
        redis.set(key.byPublish(app.publishKey), app.id),
        redis.set(key.bySubscribe(app.subscribeKey), app.id),
        // Track all app IDs
        redis.sadd(key.all(), app.id),
    ])

    return app
}

export async function getAppById(id: string): Promise<App | null> {
    const app = await redis.hgetall(key.byId(id))
    if (!app || Object.keys(app).length === 0) return null
    return app as unknown as App
}

export async function getAppByKey(apiKey: string): Promise<App | null> {
    // Try publish key index first, then subscribe key index
    const id =
        (await redis.get<string>(key.byPublish(apiKey))) ??
        (await redis.get<string>(key.bySubscribe(apiKey)))

    if (!id) return null
    return getAppById(id)
}

export async function listApps(): Promise<App[]> {
    const ids = await redis.smembers(key.all())
    if (!ids.length) return []

    const apps = await Promise.all(ids.map(getAppById))
    return (apps.filter(Boolean) as App[]).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
}

export async function updateApp(id: string, patch: { webhookUrl?: string | null }): Promise<App | null> {
    const app = await getAppById(id)
    if (!app) return null

    if (patch.webhookUrl === null) {
        await redis.hdel(key.byId(id), 'webhookUrl')
        delete app.webhookUrl
    } else if (patch.webhookUrl !== undefined) {
        await redis.hset(key.byId(id), { webhookUrl: patch.webhookUrl })
        app.webhookUrl = patch.webhookUrl
    }

    return app
}

export async function deleteApp(id: string): Promise<boolean> {
    const app = await getAppById(id)
    if (!app) return false

    await Promise.all([
        redis.del(key.byId(id)),
        redis.del(key.byPublish(app.publishKey)),
        redis.del(key.bySubscribe(app.subscribeKey)),
        redis.srem(key.all(), id),
    ])

    return true
}
