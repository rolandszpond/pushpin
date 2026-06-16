import { Database } from 'bun:sqlite'
import { nanoid } from 'nanoid'

const db = new Database('pushpin.db', { create: true })

db.run(`
    CREATE TABLE IF NOT EXISTS apps (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        publishKey   TEXT NOT NULL UNIQUE,
        subscribeKey TEXT NOT NULL UNIQUE,
        webhookUrl   TEXT,
        createdAt    TEXT NOT NULL
    )
`)

export type App = {
    id: string
    name: string
    publishKey: string
    subscribeKey: string
    createdAt: string
    webhookUrl?: string
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const stmt = {
    insert: db.prepare(`
        INSERT INTO apps (id, name, publishKey, subscribeKey, webhookUrl, createdAt)
        VALUES ($id, $name, $publishKey, $subscribeKey, $webhookUrl, $createdAt)
    `),
    byId: db.prepare<App, string>(`SELECT * FROM apps WHERE id = ?`),
    byKey: db.prepare<App, string>(`SELECT * FROM apps WHERE publishKey = ? OR subscribeKey = ?`),
    list: db.prepare<App, []>(`SELECT * FROM apps ORDER BY createdAt ASC`),
    setWebhook: db.prepare(`UPDATE apps SET webhookUrl = $webhookUrl WHERE id = $id`),
    clearWebhook: db.prepare(`UPDATE apps SET webhookUrl = NULL WHERE id = $id`),
    delete: db.prepare(`DELETE FROM apps WHERE id = ?`),
}

export function createApp(name: string): App {
    const app: App = {
        id:           nanoid(16),
        name,
        publishKey:   `pk_${nanoid(32)}`,
        subscribeKey: `sk_${nanoid(32)}`,
        createdAt:    new Date().toISOString(),
    }
    stmt.insert.run({ $id: app.id, $name: app.name, $publishKey: app.publishKey, $subscribeKey: app.subscribeKey, $webhookUrl: app.webhookUrl ?? null, $createdAt: app.createdAt })
    return app
}

export function getAppById(id: string): App | null {
    return stmt.byId.get(id) ?? null
}

export function getAppByKey(apiKey: string): App | null {
    return stmt.byKey.get(apiKey, apiKey) ?? null
}

export function listApps(): App[] {
    return stmt.list.all()
}

export function updateApp(id: string, patch: { webhookUrl?: string | null }): App | null {
    const app = getAppById(id)
    if (!app) return null

    if (patch.webhookUrl === null) {
        stmt.clearWebhook.run({ $id: id })
        delete app.webhookUrl
    } else if (patch.webhookUrl !== undefined) {
        stmt.setWebhook.run({ $webhookUrl: patch.webhookUrl, $id: id })
        app.webhookUrl = patch.webhookUrl
    }

    return app
}

export function deleteApp(id: string): boolean {
    const app = getAppById(id)
    if (!app) return false
    stmt.delete.run(id)
    return true
}
