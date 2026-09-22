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

/**
 * `authorizing` sits between `connecting` and `connected` for private
 * channels. `unauthorized` is terminal — it means the channel was refused
 * rather than dropped, and reconnecting would only ask the same question again.
 */
type StatusType = 'disconnected' | 'connecting' | 'authorizing' | 'connected' | 'unauthorized' | 'error'

type AuthorizerParams = { channel: string; socketId: string }
type AuthorizerResult = { auth: string } | string
type Authorizer = (params: AuthorizerParams) => Promise<AuthorizerResult> | AuthorizerResult

type ClientOptions = {
    serverUrl: string
    subscribeKey: string
    /** Override WS path. Default: '/app' */
    wsPath?: string
    reconnectDelay?: number
    maxReconnectAttempts?: number
    /**
     * Called when the server challenges a `private-`/`presence-` channel. It
     * must ask *your own backend* to sign the socketId — the signing secret is
     * the app's publishKey and must never reach a browser.
     */
    authorizer?: Authorizer
    /**
     * How long to wait for the authorizer. Default 10s, deliberately under the
     * server's own 15s window so the client is normally the one that gives up
     * and keeps control of whether to retry.
     */
    authTimeout?: number
    /** Consecutive authorizer failures before a channel stops trying. Default 3. */
    maxAuthAttempts?: number
}

const PRIVATE_PREFIXES = ['private-', 'presence-']

function isPrivateChannel(name: string): boolean {
    return PRIVATE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('authorizer timed out')), ms)
        promise.then(
            (value) => { clearTimeout(timer); resolve(value) },
            (error) => { clearTimeout(timer); reject(error) },
        )
    })
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
    /** Per-channel override of the client-wide authorizer. */
    authorizer?: Authorizer
    /** Consecutive authorizer failures; reset once a subscribe succeeds. */
    authAttempts: number
    /**
     * Whether *this* connection was challenged. Reset on every connect, and
     * checked before accepting a subscription on a private channel — see the
     * fail-closed guard in `_connect`.
     */
    sawAuthRequired: boolean
}

export class PushpinClient {
    private baseUrl: string
    private subscribeKey: string
    private wsPath: string
    private reconnectDelay: number
    private maxReconnectAttempts: number
    private authorizer?: Authorizer
    private authTimeout: number
    private maxAuthAttempts: number

    private channels = new Map<string, ChannelEntry>()

    constructor({
        serverUrl,
        subscribeKey,
        wsPath = '/app',
        reconnectDelay = 3000,
        maxReconnectAttempts = 10,
        authorizer,
        authTimeout = 10_000,
        maxAuthAttempts = 3,
    }: ClientOptions) {
        this.baseUrl = serverUrl.replace(/\/$/, '').replace(/^http/, 'ws')
        this.subscribeKey = subscribeKey
        this.wsPath = wsPath
        this.reconnectDelay = reconnectDelay
        this.maxReconnectAttempts = maxReconnectAttempts
        this.authorizer = authorizer
        this.authTimeout = authTimeout
        this.maxAuthAttempts = maxAuthAttempts
    }

    /** Subscribe to a channel */
    channel(name: string, options?: { authorizer?: Authorizer }): PushpinChannel {
        const existing = this.channels.get(name)
        if (existing) {
            // Re-assigned even for an existing entry: callers routinely pass an
            // inline closure that is a new function every render, and silently
            // keeping the first one makes a later authorizer look wired up when
            // it isn't.
            if (options?.authorizer) existing.authorizer = options.authorizer
            return existing.channel
        }

        const channel = new PushpinChannel(name)
        const entry: ChannelEntry = {
            channel,
            ws: null,
            status: 'disconnected',
            attempts: 0,
            intentionalClose: false,
            authorizer: options?.authorizer,
            authAttempts: 0,
            sawAuthRequired: false,
        }
        this.channels.set(name, entry)
        this._connect(name)
        return channel
    }

    /** Get the current connection status for a channel */
    getStatus(name: string): StatusType {
        return this.channels.get(name)?.status ?? 'disconnected'
    }

    /**
     * Try a refused channel again — after a sign-in, say, when the answer the
     * backend would give has actually changed. Clears the terminal state a
     * refusal leaves behind; without it the only way back is `leave` + `channel`.
     */
    reauthorize(name: string) {
        const entry = this.channels.get(name)
        if (!entry) return
        entry.authAttempts = 0
        entry.attempts = 0
        entry.intentionalClose = false
        if (entry.ws && entry.ws.readyState <= WebSocket.OPEN) return
        this._connect(name)
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

        const isPrivate = isPrivateChannel(name)
        const authorizer = entry.authorizer ?? this.authorizer

        // Fail before opening a socket that could only ever be closed again.
        if (isPrivate && !authorizer) {
            console.error(`[pushpin] channel "${name}" is private but no authorizer was configured`)
            entry.intentionalClose = true
            entry.status = 'unauthorized'
            return
        }

        const url = `${this.baseUrl}${this.wsPath}/${this.subscribeKey}?channel=${encodeURIComponent(name)}`
        const ws = new WebSocket(url)
        entry.ws = ws
        entry.status = 'connecting'
        // Per connection, not per channel: the challenge is reissued with a new
        // socketId every time we reconnect.
        entry.sawAuthRequired = false

        ws.onopen = () => {
            // TCP connected — wait for pushpin:connected before marking as ready
        }

        ws.onmessage = (e) => {
            let msg: WireMessage
            try {
                msg = JSON.parse(e.data)
            } catch {
                return // ignore malformed messages
            }

            if (msg.event === 'pushpin:auth_required') {
                entry.sawAuthRequired = true
                entry.status = 'authorizing'

                const { socketId } = (msg.data ?? {}) as { socketId?: string }
                if (!socketId) return

                // Never stored on the entry. The socketId is new on every
                // connection, so a cached token would be wrong on the next one
                // — re-fetching is what makes reconnection re-authorize for free.
                withTimeout(Promise.resolve(authorizer!({ channel: name, socketId })), this.authTimeout)
                    .then((result) => {
                        const auth = typeof result === 'string' ? result : result?.auth
                        if (!auth) throw new Error('authorizer returned no auth token')
                        // It may have closed, or been replaced, while we waited.
                        if (entry.ws !== ws || ws.readyState !== WebSocket.OPEN) return
                        ws.send(JSON.stringify({ event: 'pushpin:subscribe', auth }))
                    })
                    .catch((error: unknown) => {
                        entry.authAttempts++
                        // A 403 is the backend saying this won't work later
                        // either. Anything else — a dropped request, a cold
                        // start — is worth a few goes before giving up, since
                        // stopping on the first one leaves a dead channel with
                        // no way back until the page is reloaded.
                        const forbidden = (error as { status?: number })?.status === 403
                        const fatal = forbidden || entry.authAttempts >= this.maxAuthAttempts
                        if (fatal) {
                            entry.intentionalClose = true
                            entry.status = 'unauthorized'
                        }
                        entry.channel._dispatch('pushpin:auth_failed', {
                            channel: name,
                            error: (error as Error)?.message ?? String(error),
                            fatal,
                        })
                        if (entry.ws === ws) ws.close()
                    })
                return
            }

            if (msg.event === 'pushpin:connected') {
                // Fail closed. A private channel that reaches "subscribed"
                // without having been challenged means the server didn't ask —
                // an old build, or a rolled-back deploy — and accepting it
                // would be subscribing to a private channel with no
                // authorization at all, silently.
                if (isPrivate && !entry.sawAuthRequired) {
                    console.error(`[pushpin] server subscribed "${name}" without an auth challenge — refusing`)
                    entry.intentionalClose = true
                    entry.status = 'error'
                    ws.close()
                    return
                }
                entry.status = 'connected'
                entry.attempts = 0
                entry.authAttempts = 0
                return
            }

            if (msg.event === 'error') {
                const code = (msg.data as { code?: string } | null)?.code
                // A timeout means the authorizer was slow, which the next
                // attempt may well survive. Every other refusal is final —
                // asking again with the same inputs gets the same answer.
                if (code !== 'auth_timeout') entry.intentionalClose = true
                if (code === 'auth_failed') entry.status = 'unauthorized'
            }

            entry.channel._dispatch(msg.event, msg.data)
        }

        ws.onerror = () => {
            entry.status = 'error'
        }

        ws.onclose = () => {
            if (entry.status !== 'unauthorized') entry.status = 'disconnected'
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
