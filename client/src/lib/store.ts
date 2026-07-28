import { db } from './db'
import { nanoid } from 'nanoid'

export type App = {
    id: string
    name: string
    publishKey: string
    subscribeKey: string
    createdAt: string
    webhookUrl?: string | null
}

// ─── Apps ─────────────────────────────────────────────────────────────────────

const stmt = {
    insert: db.prepare(`
        INSERT INTO apps (id, name, publishKey, subscribeKey, createdAt)
        VALUES ($id, $name, $publishKey, $subscribeKey, $createdAt)
    `),
    byId:         db.prepare<App, string>(`SELECT * FROM apps WHERE id = ?`),
    byKey:        db.prepare<App, [string, string]>(`SELECT * FROM apps WHERE publishKey = ? OR subscribeKey = ?`),
    list:         db.prepare<App, []>(`SELECT * FROM apps ORDER BY createdAt ASC`),
    setWebhook:   db.prepare(`UPDATE apps SET webhookUrl = $webhookUrl WHERE id = $id`),
    clearWebhook: db.prepare(`UPDATE apps SET webhookUrl = NULL WHERE id = $id`),
    delete:       db.prepare(`DELETE FROM apps WHERE id = ?`),
    upsert: db.prepare(`
        INSERT INTO apps (id, name, publishKey, subscribeKey, webhookUrl, createdAt)
        VALUES ($id, $name, $publishKey, $subscribeKey, $webhookUrl, $createdAt)
        ON CONFLICT(id) DO UPDATE SET
            name         = excluded.name,
            publishKey   = excluded.publishKey,
            subscribeKey = excluded.subscribeKey,
            webhookUrl   = excluded.webhookUrl,
            createdAt    = excluded.createdAt
    `),
}

export function createApp(name: string): App {
    const app: App = {
        id:           nanoid(16),
        name,
        publishKey:   `pk_${nanoid(32)}`,
        subscribeKey: `sk_${nanoid(32)}`,
        createdAt:    new Date().toISOString(),
    }
    stmt.insert.run({
        $id:           app.id,
        $name:         app.name,
        $publishKey:   app.publishKey,
        $subscribeKey: app.subscribeKey,
        $createdAt:    app.createdAt,
    })
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
        app.webhookUrl = null
    } else if (patch.webhookUrl !== undefined) {
        stmt.setWebhook.run({ $webhookUrl: patch.webhookUrl, $id: id })
        app.webhookUrl = patch.webhookUrl
    }

    return app
}

export function deleteApp(id: string): App | null {
    const app = getAppById(id)
    if (!app) return null
    stmt.delete.run(id)
    return app
}

// ─── Export / import (for restoring apps after an ephemeral redeploy) ─────────

const importAppsTxn = db.transaction((apps: App[]) => {
    for (const app of apps) {
        stmt.upsert.run({
            $id:           app.id,
            $name:         app.name,
            $publishKey:   app.publishKey,
            $subscribeKey: app.subscribeKey,
            $webhookUrl:   app.webhookUrl ?? null,
            $createdAt:    app.createdAt,
        })
    }
})

/** Upserts by id — never deletes apps that are missing from the given list. */
export function importApps(apps: App[]): number {
    importAppsTxn(apps)
    return apps.length
}
