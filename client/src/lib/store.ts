import { sql } from './db'
import { nanoid } from 'nanoid'

export type App = {
    id: string
    name: string
    publishKey: string
    subscribeKey: string
    createdAt: string
    webhookUrl?: string | null
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

export async function createApp(name: string): Promise<App> {
    const app: App = {
        id:           nanoid(16),
        name,
        publishKey:   `pk_${nanoid(32)}`,
        subscribeKey: `sk_${nanoid(32)}`,
        createdAt:    new Date().toISOString(),
    }
    await sql`
        INSERT INTO apps (id, name, publish_key, subscribe_key, created_at)
        VALUES (${app.id}, ${app.name}, ${app.publishKey}, ${app.subscribeKey}, ${app.createdAt})
    `
    return app
}

export async function getAppById(id: string): Promise<App | null> {
    const [app] = await sql<App[]>`SELECT * FROM apps WHERE id = ${id}`
    return app ?? null
}

export async function getAppByKey(key: string): Promise<App | null> {
    const [app] = await sql<App[]>`SELECT * FROM apps WHERE publish_key = ${key} OR subscribe_key = ${key}`
    return app ?? null
}

export async function listApps(): Promise<App[]> {
    return sql<App[]>`SELECT * FROM apps ORDER BY created_at ASC`
}

export async function updateApp(id: string, patch: { webhookUrl?: string | null }): Promise<App | null> {
    const app = await getAppById(id)
    if (!app) return null

    if (patch.webhookUrl === null) {
        await sql`UPDATE apps SET webhook_url = NULL WHERE id = ${id}`
        app.webhookUrl = null
    } else if (patch.webhookUrl !== undefined) {
        await sql`UPDATE apps SET webhook_url = ${patch.webhookUrl} WHERE id = ${id}`
        app.webhookUrl = patch.webhookUrl
    }

    return app
}

export async function deleteApp(id: string): Promise<App | null> {
    const app = await getAppById(id)
    if (!app) return null
    await sql`DELETE FROM apps WHERE id = ${id}`
    return app
}

// ─── Usage tracking ───────────────────────────────────────────────────────────

function currentMonth(): string {
    return new Date().toISOString().slice(0, 7)
}

export async function trackMonthlyPublish(appId: string): Promise<void> {
    await sql`
        INSERT INTO monthly_usage (app_id, month, messages_published, connections)
        VALUES (${appId}, ${currentMonth()}, 1, 0)
        ON CONFLICT (app_id, month) DO UPDATE SET messages_published = monthly_usage.messages_published + 1
    `
}

export async function trackMonthlyConnect(appId: string): Promise<void> {
    await sql`
        INSERT INTO monthly_usage (app_id, month, messages_published, connections)
        VALUES (${appId}, ${currentMonth()}, 0, 1)
        ON CONFLICT (app_id, month) DO UPDATE SET connections = monthly_usage.connections + 1
    `
}

export async function getMonthlyUsage(appId: string): Promise<MonthlyUsage[]> {
    return sql<MonthlyUsage[]>`
        SELECT * FROM monthly_usage WHERE app_id = ${appId} ORDER BY month DESC
    `
}

export async function getAllMonthlyUsage(): Promise<MonthlyUsage[]> {
    return sql<MonthlyUsage[]>`SELECT * FROM monthly_usage ORDER BY app_id, month DESC`
}

// ─── Message log ──────────────────────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function logMessage(entry: {
    appId: string
    channel: string
    event: string
    data: unknown
    timestamp: number
    delivered: number
}): Promise<void> {
    const data = entry.data !== null && entry.data !== undefined ? JSON.stringify(entry.data) : null
    await sql`
        INSERT INTO message_log (app_id, channel, event, data, timestamp, delivered)
        VALUES (${entry.appId}, ${entry.channel}, ${entry.event}, ${data}, ${entry.timestamp}, ${entry.delivered})
    `
}

export async function pruneOldLogs(): Promise<void> {
    await sql`DELETE FROM message_log WHERE timestamp < ${Date.now() - SEVEN_DAYS_MS}`
}

export async function getRecentMessages(appId: string): Promise<(Omit<MessageLogEntry, 'data'> & { data: unknown })[]> {
    const cutoff = Date.now() - SEVEN_DAYS_MS
    const rows = await sql<MessageLogEntry[]>`
        SELECT * FROM message_log WHERE app_id = ${appId} AND timestamp >= ${cutoff} ORDER BY timestamp DESC
    `
    return rows.map(row => ({
        ...row,
        data: row.data !== null ? JSON.parse(row.data) : null,
    }))
}
