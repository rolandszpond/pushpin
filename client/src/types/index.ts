// ─── Messages ─────────────────────────────────────────────────────────────────

export type WireMessage = {
    event: string
    data: unknown
    channel: string
    appId: string
    timestamp: number
}
