/**
 * Pushpin Client SDK (vanilla JS/TS, no framework)
 *
 * import { PushpinClient } from './sdk/js/client'
 *
 * const pushpin = new PushpinClient({
 *   serverUrl: 'wss://your-pushpin.do.app',
 *   subscribeKey: 'sk_...',
 * })
 *
 * pushpin.channel('orders')
 *   .on('order.created', (data) => console.log('New order:', data))
 *   .on('*', ({ event, data }) => console.log(event, data))
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

type WireMessage = {
    event: string
    data: unknown
    channel: string
    appId: string
    timestamp: number
}

type EventHandler = (data: unknown) => void
type StatusType = 'disconnected' | 'connecting' | 'connected' | 'error'

type ClientOptions = {
    serverUrl: string
    subscribeKey: string
    /** Override WS path. Default: '/app' */
    wsPath?: string
    reconnectDelay?: number
    maxReconnectAttempts?: number
}

// ─── Channel ───────────────────────────────────────────────────────────────────

export class PushpinChannel {
    private handlers = new Map<string, Set<EventHandler>>()

    constructor(public readonly name: string) {}

    on(event: string, handler: EventHandler): this {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set())
        this.handlers.get(event)!.add(handler)
        return this
    }

    off(event: string, handler?: EventHandler): this {
        if (!handler) this.handlers.delete(event)
        else this.handlers.get(event)?.delete(handler)
        return this
    }

    /** @internal */
    _dispatch(event: string, data: unknown) {
        this.handlers.get(event)?.forEach((h) => h(data))
        // Wildcard fires for every event
        this.handlers.get('*')?.forEach((h) => h({ event, data }))
    }
}

// ─── Client ────────────────────────────────────────────────────────────────────

type ChannelEntry = {
    channel: PushpinChannel
    ws: WebSocket | null
    status: StatusType
    attempts: number
    intentionalClose: boolean
}

export class PushpinClient {
    private baseUrl: string
    private subscribeKey: string
    private wsPath: string
    private reconnectDelay: number
    private maxReconnectAttempts: number

    private channels = new Map<string, ChannelEntry>()

    constructor({
        serverUrl,
        subscribeKey,
        wsPath = '/app',
        reconnectDelay = 3000,
        maxReconnectAttempts = 10,
    }: ClientOptions) {
        this.baseUrl = serverUrl.replace(/\/$/, '').replace(/^http/, 'ws')
        this.subscribeKey = subscribeKey
        this.wsPath = wsPath
        this.reconnectDelay = reconnectDelay
        this.maxReconnectAttempts = maxReconnectAttempts
    }

    /** Subscribe to a channel */
    channel(name: string): PushpinChannel {
        if (this.channels.has(name)) {
            return this.channels.get(name)!.channel
        }

        const channel = new PushpinChannel(name)
        const entry: ChannelEntry = {
            channel,
            ws: null,
            status: 'disconnected',
            attempts: 0,
            intentionalClose: false,
        }
        this.channels.set(name, entry)
        this._connect(name)
        return channel
    }

    /** Get the current connection status for a channel */
    getStatus(name: string): StatusType {
        return this.channels.get(name)?.status ?? 'disconnected'
    }

    /** Disconnect from a specific channel */
    leave(name: string) {
        const entry = this.channels.get(name)
        if (!entry) return
        entry.intentionalClose = true
        entry.ws?.close()
        this.channels.delete(name)
    }

    /** Disconnect all channels */
    disconnect() {
        for (const name of [...this.channels.keys()]) this.leave(name)
    }

    private _connect(name: string) {
        const entry = this.channels.get(name)
        if (!entry) return

        const url = `${this.baseUrl}${this.wsPath}/${this.subscribeKey}?channel=${encodeURIComponent(name)}`
        const ws = new WebSocket(url)
        entry.ws = ws
        entry.status = 'connecting'

        ws.onopen = () => {
            // TCP connected — wait for pushpin:connected before marking as ready
        }

        ws.onmessage = (e) => {
            try {
                const msg: WireMessage = JSON.parse(e.data)
                if (msg.event === 'pushpin:connected') {
                    entry.status = 'connected'
                    entry.attempts = 0
                    return
                }
                if (msg.event === 'error') {
                    // Server explicitly rejected (bad key, limit reached, etc.) — don't retry
                    entry.intentionalClose = true
                }
                entry.channel._dispatch(msg.event, msg.data)
            } catch {
                // ignore malformed messages
            }
        }

        ws.onerror = () => {
            entry.status = 'error'
        }

        ws.onclose = () => {
            entry.status = 'disconnected'
            if (entry.intentionalClose || !this.channels.has(name)) return

            const max = this.maxReconnectAttempts
            if (max > 0 && entry.attempts >= max) {
                console.warn(`[pushpin] channel "${name}" max reconnect attempts reached`)
                return
            }

            entry.attempts++
            const delay = Math.min(this.reconnectDelay * entry.attempts, 30_000)
            setTimeout(() => this._connect(name), delay)
        }
    }
}
