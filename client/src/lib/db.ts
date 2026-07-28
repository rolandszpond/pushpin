import { Database } from 'bun:sqlite'

export const db = new Database('pushpin.db', { create: true })

db.run(`
    CREATE TABLE IF NOT EXISTS apps (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        publishKey      TEXT NOT NULL UNIQUE,
        subscribeKey    TEXT NOT NULL UNIQUE,
        webhookUrl      TEXT,
        createdAt       TEXT NOT NULL
    )
`)
