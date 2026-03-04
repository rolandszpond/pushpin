// ─── App (tenant) ────────────────────────────────────────────────────────────

export type App = {
    id: string
    name: string
    publishKey: string   // used by publishers (Firebase, backends)
    subscribeKey: string // used by frontend clients
    createdAt: Date
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export type PublishPayload = {
    channel: string
    event: string
    data?: unknown
}

export type WireMessage = {
    event: string
    data: unknown
    channel: string
    appId: string
    timestamp: number
}

// ─── WebSocket connection metadata ────────────────────────────────────────────

export type ConnectionMeta = {
    appId: string
    channel: string
    socketId: string
}
