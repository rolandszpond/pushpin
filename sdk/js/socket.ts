/**
 * Pushpin multiplexed client (vanilla JS/TS, no framework)
 *
 * One WebSocket for the whole app, however many channels it listens to.
 * `client.ts` next door opens a socket per channel; this speaks the server's
 * multiplexed protocol instead (connect without `?channel=`, then subscribe
 * and unsubscribe with frames — see client/src/routes/ws.ts).
 *
 * import { PushpinSocket } from './sdk/js/socket'
 *
 * const pushpin = new PushpinSocket({
 *   serverUrl: 'wss://your-pushpin.do.app',
 *   subscribeKey: 'sk_...',
 *   authorizer: async ({ channel, socketId }) => { ... },
 * })
 *
 * const off = pushpin.subscribe(`private-user.${userId}`, 'notification', (data) => { ... })
 * off() // drops the handler; the channel is left once nothing holds it
 *
 * Subscriptions are reference-counted per channel: any number of callers can
 * hold the same one, and it's only left when the last lets go. The socket
 * itself opens on the first subscription and closes a short while after the
 * last is released, so an app listening to nothing holds no connection.
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

type Authorizer = (params: { channel: string; socketId: string }) => Promise<{ auth: string }>

type SocketOptions = {
    serverUrl: string
    subscribeKey: string
    /** Override WS path. Default: '/app' */
    wsPath?: string
    /**
     * Asks *your own backend* to sign `socketId:channel` for a `private-` or
     * `presence-` channel — the signing secret is the app's publishKey and
     * must never reach a client. Throw an error carrying `status: 403` for a
     * refusal that asking again won't change; anything else is retried.
     */
    authorizer?: Authorizer
    /** How long to wait for the authorizer. Default 10s. */
    authTimeout?: number
    /** Consecutive authorization failures before a channel stops trying. Default 3. */
    maxAuthAttempts?: number
    /**
     * How long the socket stays open once nothing is subscribed. Default 5s,
     * so moving between two screens that hold the same channel doesn't drop
     * and rebuild the connection in between.
     */
    lingerMs?: number
}

/**
 * `pending`   — wanted, not yet confirmed (includes "waiting for the socket").
 * `subscribed`— confirmed by the server; messages are flowing.
 * `refused`   — the authorizer or the server said no. Terminal for this
 *               socket; a reconnect asks again.
 */
type ChannelState = 'pending' | 'subscribed' | 'refused'

type ChannelEntry = {
    handlers: Map<string, Set<EventHandler>>
    refs: number
    state: ChannelState
    authAttempts: number
}

const PRIVATE_PREFIXES = ['private-', 'presence-']
const isPrivateChannel = (name: string) => PRIVATE_PREFIXES.some((p) => name.startsWith(p))

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('authorizer timed out')), ms)
        promise.then(
            (value) => { clearTimeout(timer); resolve(value) },
            (error) => { clearTimeout(timer); reject(error) },
        )
    })
}

// ─── Client ────────────────────────────────────────────────────────────────────

export class PushpinSocket {
    private url: string
    private authorizer?: Authorizer
    private authTimeout: number
    private maxAuthAttempts: number
    private lingerMs: number

    private ws: WebSocket | null = null
    /** Set by `pushpin:ready`; null whenever there's no usable connection. */
    private socketId: string | null = null
    private channels = new Map<string, ChannelEntry>()
    private reconnectAttempts = 0
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private lingerTimer: ReturnType<typeof setTimeout> | null = null
    /** The server sent `error`: it will refuse again, so don't reconnect. */
    private refused = false

    constructor(options: SocketOptions) {
        const base = options.serverUrl.replace(/\/$/, '').replace(/^http/, 'ws')
        this.url = `${base}${options.wsPath ?? '/app'}/${options.subscribeKey}`
        this.authorizer = options.authorizer
        this.authTimeout = options.authTimeout ?? 10_000
        this.maxAuthAttempts = options.maxAuthAttempts ?? 3
        this.lingerMs = options.lingerMs ?? 5_000
    }

    /**
     * Listen for `event` on `channel`. Returns the function that stops
     * listening — call it exactly once.
     */
    subscribe(channel: string, event: string, handler: EventHandler): () => void {
        let entry = this.channels.get(channel)
        const isNew = !entry
        if (!entry) {
            entry = { handlers: new Map(), refs: 0, state: 'pending', authAttempts: 0 }
            this.channels.set(channel, entry)
        }
        if (!entry.handlers.has(event)) entry.handlers.set(event, new Set())
        entry.handlers.get(event)!.add(handler)
        entry.refs++

        this.cancelLinger()
        if (!this.ws) this.open()
        else if (isNew && this.socketId) this.join(channel)

        let released = false
        return () => {
            if (released) return
            released = true
            this.release(channel, event, handler)
        }
    }

    /** Tear everything down now, subscribers included. */
    disconnect() {
        this.channels.clear()
        this.close()
    }

    // ─── Internals ─────────────────────────────────────────────────────────────

    private release(channel: string, event: string, handler: EventHandler) {
        const entry = this.channels.get(channel)
        if (!entry) return
        entry.handlers.get(event)?.delete(handler)
        if (entry.handlers.get(event)?.size === 0) entry.handlers.delete(event)
        if (--entry.refs > 0) return

        this.channels.delete(channel)
        // Harmless if the server never got as far as subscribing it — leaving
        // a channel you aren't on is a no-op there.
        if (entry.state !== 'refused') this.send({ event: 'pushpin:unsubscribe', channel })
        if (this.channels.size === 0) this.scheduleLinger()
    }

    private open() {
        this.clearReconnect()
        this.refused = false
        const ws = new WebSocket(this.url)
        this.ws = ws

        ws.onmessage = (e) => {
            if (this.ws !== ws) return
            let msg: WireMessage
            try { msg = JSON.parse(e.data as string) } catch { return }
            this.onMessage(msg)
        }

        ws.onclose = () => {
            if (this.ws !== ws) return
            this.ws = null
            this.socketId = null
            // Every subscription died with the socket; the next `ready` asks
            // for them all again, refused ones included — a new socketId is a
            // new question.
            for (const entry of this.channels.values()) {
                entry.state = 'pending'
                entry.authAttempts = 0
            }
            if (this.refused || this.channels.size === 0) return
            this.reconnectAttempts++
            const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30_000)
            this.reconnectTimer = setTimeout(() => this.open(), delay)
        }
    }

    private close() {
        this.clearReconnect()
        this.cancelLinger()
        const ws = this.ws
        this.ws = null
        this.socketId = null
        ws?.close()
    }

    private onMessage(msg: WireMessage) {
        if (msg.event === 'pushpin:ready') {
            this.socketId = (msg.data as { socketId?: string } | null)?.socketId ?? null
            this.reconnectAttempts = 0
            for (const channel of this.channels.keys()) this.join(channel)
            return
        }

        if (msg.event === 'pushpin:subscribed') {
            const entry = this.channels.get(msg.channel)
            // Let go of while the subscribe was in flight: the unsubscribe
            // already went out behind it, so there's nothing to do.
            if (!entry) return
            entry.state = 'subscribed'
            entry.authAttempts = 0
            return
        }

        if (msg.event === 'pushpin:subscribe_error') {
            const entry = this.channels.get(msg.channel)
            if (!entry) return
            const code = (msg.data as { code?: string } | null)?.code
            if (code === 'auth_failed') this.authFailed(msg.channel, entry, false)
            else {
                entry.state = 'refused'
                console.warn(`[pushpin] "${msg.channel}" refused: ${code}`)
            }
            return
        }

        if (msg.event === 'error') {
            // Final by contract: the server is about to close and would say
            // the same thing to a reconnect.
            this.refused = true
            console.error('[pushpin] connection refused', msg.data)
            return
        }

        const entry = this.channels.get(msg.channel)
        entry?.handlers.get(msg.event)?.forEach((h) => h(msg.data))
        entry?.handlers.get('*')?.forEach((h) => h({ event: msg.event, data: msg.data }))
    }

    private join(channel: string) {
        const socketId = this.socketId
        if (!socketId) return

        if (!isPrivateChannel(channel)) {
            this.send({ event: 'pushpin:subscribe', channel })
            return
        }

        const entry = this.channels.get(channel)
        if (!entry) return
        if (!this.authorizer) {
            console.error(`[pushpin] "${channel}" is private but no authorizer was configured`)
            entry.state = 'refused'
            return
        }

        // Never cached — the signature names this socketId, which is new on
        // every connection.
        withTimeout(this.authorizer({ channel, socketId }), this.authTimeout)
            .then(({ auth }) => {
                // Stale if the socket was replaced, or the channel let go of,
                // while the authorizer was out.
                if (this.socketId !== socketId || this.channels.get(channel) !== entry) return
                this.send({ event: 'pushpin:subscribe', channel, auth })
            })
            .catch((error: unknown) => {
                if (this.socketId !== socketId || this.channels.get(channel) !== entry) return
                this.authFailed(channel, entry, (error as { status?: number })?.status === 403)
            })
    }

    /**
     * 403 is the backend saying this won't work later either. Anything else
     * gets a few goes — giving up on one flaky request would leave a dead
     * channel until the socket reconnects.
     */
    private authFailed(channel: string, entry: ChannelEntry, fatal: boolean) {
        entry.authAttempts++
        if (fatal || entry.authAttempts >= this.maxAuthAttempts) {
            entry.state = 'refused'
            console.warn(`[pushpin] "${channel}" not authorized`)
            return
        }
        const socketId = this.socketId
        setTimeout(() => {
            if (this.socketId === socketId && this.channels.get(channel) === entry) this.join(channel)
        }, 1000 * entry.authAttempts)
    }

    private send(frame: Record<string, unknown>) {
        if (this.ws?.readyState === WebSocket.OPEN && this.socketId) this.ws.send(JSON.stringify(frame))
    }

    private scheduleLinger() {
        this.cancelLinger()
        this.lingerTimer = setTimeout(() => {
            this.lingerTimer = null
            if (this.channels.size === 0) this.close()
        }, this.lingerMs)
    }

    private cancelLinger() {
        if (this.lingerTimer) clearTimeout(this.lingerTimer)
        this.lingerTimer = null
    }

    private clearReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
    }
}
