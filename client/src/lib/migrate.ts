import { sql } from './db'

export async function migrate() {
    await sql`
        CREATE TABLE IF NOT EXISTS apps (
            id               TEXT PRIMARY KEY,
            name             TEXT NOT NULL,
            publish_key      TEXT NOT NULL UNIQUE,
            subscribe_key    TEXT NOT NULL UNIQUE,
            webhook_url      TEXT,
            connection_limit INTEGER,
            created_at       TEXT NOT NULL
        )
    `
    await sql`ALTER TABLE apps ADD COLUMN IF NOT EXISTS connection_limit INTEGER`
    await sql`
        CREATE TABLE IF NOT EXISTS monthly_usage (
            app_id              TEXT NOT NULL,
            month               TEXT NOT NULL,
            messages_published  INTEGER NOT NULL DEFAULT 0,
            connections         INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (app_id, month)
        )
    `
    await sql`
        CREATE TABLE IF NOT EXISTS message_log (
            id        SERIAL PRIMARY KEY,
            app_id    TEXT NOT NULL,
            channel   TEXT NOT NULL,
            event     TEXT NOT NULL,
            data      TEXT,
            timestamp BIGINT NOT NULL,
            delivered INTEGER NOT NULL DEFAULT 0
        )
    `
    await sql`
        CREATE INDEX IF NOT EXISTS idx_message_log_app_id ON message_log (app_id, timestamp DESC)
    `
}
