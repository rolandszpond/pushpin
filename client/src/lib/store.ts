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

db.run(`
    CREATE TABLE IF NOT EXISTS monthly_usage (
        appId             TEXT NOT NULL,
        month             TEXT NOT NULL,
        messagesPublished INTEGER NOT NULL DEFAULT 0,
        connections       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (appId, month)
    )
`)

db.run(`
    CREATE TABLE IF NOT EXISTS message_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        appId     TEXT NOT NULL,
        channel   TEXT NOT NULL,
        event     TEXT NOT NULL,
        data      TEXT,
        timestamp INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
    )
`)

db.run(`CREATE INDEX IF NOT EXISTS message_log_appId ON message_log (appId, timestamp DESC)`)

export type App = {
    id: string
    name: string
    publishKey: string
    subscribeKey: string
    createdAt: string
    webhookUrl?: string
}

export type MonthlyUsage = {
    appId: string
    month: string
    messagesPublished: number
    connections: number
}

export type MessageLogEntry = {
    id: number
    appId: string
    channel: string
    event: string
    data: string | null
    timestamp: number
    delivered: number
}

// ─── Apps ─────────────────────────────────────────────────────────────────────

const stmt = {
    insert: db.prepare(`
        INSERT INTO apps (id, name, publishKey, subscribeKey, webhookUrl, createdAt)
        VALUES ($id, $name, $publishKey, $subscribeKey, $webhookUrl, $createdAt)
    `),
    byId:        db.prepare<App, string>(`SELECT * FROM apps WHERE id = ?`),
    byKey:       db.prepare<App, string>(`SELECT * FROM apps WHERE publishKey = ? OR subscribeKey = ?`),
    list:        db.prepare<App, []>(`SELECT * FROM apps ORDER BY createdAt ASC`),
    setWebhook:  db.prepare(`UPDATE apps SET webhookUrl = $webhookUrl WHERE id = $id`),
    clearWebhook:db.prepare(`UPDATE apps SET webhookUrl = NULL WHERE id = $id`),
    delete:      db.prepare(`DELETE FROM apps WHERE id = ?`),
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

// ─── Usage tracking ───────────────────────────────────────────────────────────

const usageStmt = {
    incrMessages: db.prepare(`
        INSERT INTO monthly_usage (appId, month, messagesPublished, connections)
        VALUES ($appId, $month, 1, 0)
        ON CONFLICT (appId, month) DO UPDATE SET messagesPublished = messagesPublished + 1
    `),
    incrConnections: db.prepare(`
        INSERT INTO monthly_usage (appId, month, messagesPublished, connections)
        VALUES ($appId, $month, 0, 1)
        ON CONFLICT (appId, month) DO UPDATE SET connections = connections + 1
    `),
    forApp: db.prepare<MonthlyUsage, string>(`
        SELECT * FROM monthly_usage WHERE appId = ? ORDER BY month DESC
    `),
    all: db.prepare<MonthlyUsage, []>(`
        SELECT * FROM monthly_usage ORDER BY appId, month DESC
    `),
}

function currentMonth(): string {
    return new Date().toISOString().slice(0, 7) // YYYY-MM
}

export function trackMonthlyPublish(appId: string) {
    usageStmt.incrMessages.run({ $appId: appId, $month: currentMonth() })
}

export function trackMonthlyConnect(appId: string) {
    usageStmt.incrConnections.run({ $appId: appId, $month: currentMonth() })
}

export function getMonthlyUsage(appId: string): MonthlyUsage[] {
    return usageStmt.forApp.all(appId)
}

export function getAllMonthlyUsage(): MonthlyUsage[] {
    return usageStmt.all.all()
}

// ─── Message log ──────────────────────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

const logStmt = {
    insert: db.prepare(`
        INSERT INTO message_log (appId, channel, event, data, timestamp, delivered)
        VALUES ($appId, $channel, $event, $data, $timestamp, $delivered)
    `),
    prune: db.prepare(`DELETE FROM message_log WHERE timestamp < $cutoff`),
    recent: db.prepare<MessageLogEntry, { $appId: string; $cutoff: number }>(`
        SELECT * FROM message_log WHERE appId = $appId AND timestamp >= $cutoff ORDER BY timestamp DESC
    `),
}

export function logMessage(entry: { appId: string; channel: string; event: string; data: unknown; timestamp: number; delivered: number }) {
    logStmt.insert.run({
        $appId:     entry.appId,
        $channel:   entry.channel,
        $event:     entry.event,
        $data:      entry.data !== null && entry.data !== undefined ? JSON.stringify(entry.data) : null,
        $timestamp: entry.timestamp,
        $delivered: entry.delivered,
    })
}

export function pruneOldLogs() {
    logStmt.prune.run({ $cutoff: Date.now() - SEVEN_DAYS_MS })
}

export function getRecentMessages(appId: string): (Omit<MessageLogEntry, 'data'> & { data: unknown })[] {
    return logStmt.recent.all({ $appId: appId, $cutoff: Date.now() - SEVEN_DAYS_MS }).map((row: MessageLogEntry) => ({
        ...row,
        data: row.data !== null ? JSON.parse(row.data) : null,
    }))
}
