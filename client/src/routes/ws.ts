import type { BunRequest, Server, ServerWebSocket } from 'bun'
import { resolveApp } from '../middleware/resolve-app'
import { trackConnect, trackDisconnect, trackPending, trackPendingResolved } from '../lib/registry'
import {
    PUSHPIN_AUTH_REQUIRED,
    PUSHPIN_CONNECTED,
    PUSHPIN_SUBSCRIBE,
    type WireMessage,
} from '../types'
import { isPrivateChannel, verify } from '../lib/auth'
import type { App } from '../lib/store'
import { nanoid } from 'nanoid'

export type WsData = {
    subscribeKey: string
    channel: string
    app?: App
    socketId?: string
    /** Challenged, not yet answered. Exactly one answer is ever processed. */
    pendingAuth?: boolean
    /** `ws.subscribe()` and `trackConnect()` have run. Drives cleanup in close(). */
    subscribed?: boolean
    authTimer?: ReturnType<typeof setTimeout>
}

/**
 * How long a challenged socket may sit unanswered.
 *
 * There has to be an explicit timer: Bun's `idleTimeout` won't reap these,
 * because `sendPings` is on by default and the browser's WebSocket stack
 * answers those pongs by itself, resetting the idle clock forever.
 *
 * Deliberately longer than the SDK's own authorizer timeout, so the normal
 * case is the client giving up and deciding for itself whether to retry,
 * rather than the server closing the socket out from under a request that was
 * about to succeed.
 */
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS ?? 15_000)

/** Nothing legitimate approaches this; a bound before any parsing happens. */
const MAX_AUTH_FRAME = 2048

const CLOSE = {
    UNAUTHORIZED: 4001,
    AUTH_TIMEOUT: 4002,
    PROTOCOL: 4003,
} as const

/**
 * WebSocket endpoint
 *
 * Clients connect with:
 *   ws://your-service.com/app/:subscribeKey?channel=my-channel
 *
 * The subscribeKey is public — safe to use in frontend code. It can only
 * receive messages, not publish, and it identifies the app rather than the
 * person holding it. A channel named `private-*` or `presence-*` therefore
 * takes a second step before anything is delivered: see `open`/`message`
 * below and client/src/lib/auth.ts.
 *
 * The upgrade always succeeds if a channel is present; subscribeKey validation
 * happens in open() so the client gets an `error` message frame instead of a
 * bare connection failure (the SDK relies on that frame to stop reconnecting).
 */
export function wsUpgradeRoute(req: BunRequest<'/app/:subscribeKey'>, server: Server) {
    const { subscribeKey } = req.params
    const channel = new URL(req.url).searchParams.get('channel')
    if (!channel) {
        return Response.json({ ok: false, error: 'Missing channel query param' }, { status: 400 })
    }

    const upgraded = server.upgrade(req, { data: { subscribeKey, channel } satisfies WsData })
    if (!upgraded) {
        return Response.json({ ok: false, error: 'WebSocket upgrade failed' }, { status: 400 })
    }
}

function frame(ws: ServerWebSocket<WsData>, event: string, data: unknown): string {
    return JSON.stringify({
        event,
        data,
        channel: ws.data.channel,
        appId: ws.data.app?.id ?? '',
        timestamp: Date.now(),
    } satisfies WireMessage)
}

/**
 * Refuse, and say so before hanging up.
 *
 * The frame has to go first: every SDK treats an `error` event as final and
 * stops reconnecting on it, so a bare close would instead be read as a dropped
 * connection and retried on a backoff forever.
 */
function reject(ws: ServerWebSocket<WsData>, code: string, message: string, closeCode: number) {
    ws.send(frame(ws, 'error', { message, code }))
    ws.close(closeCode, code)
}

function subscribeNow(ws: ServerWebSocket<WsData>) {
    const { app, channel, socketId } = ws.data

    // Bun's built-in pub/sub — subscribe to namespaced channel
    ws.subscribe(`${app!.id}:${channel}`)
    ws.data.subscribed = true
    trackConnect(app!.id, channel)

    ws.send(frame(ws, PUSHPIN_CONNECTED, { socketId, channel }))
}

export const websocketHandlers = {
    open(ws: ServerWebSocket<WsData>) {
        const { subscribeKey, channel } = ws.data

        const app = resolveApp(subscribeKey)
        if (!app) {
            ws.send(JSON.stringify({ event: 'error', data: { message: 'Invalid subscribe key' } }))
            ws.close()
            return
        }

        ws.data.app = app
        ws.data.socketId = nanoid(12)

        // Public channels: unchanged, and deliberately so — this is the path
        // every existing consumer of this server is on.
        if (!isPrivateChannel(channel)) {
            subscribeNow(ws)
            return
        }

        // Private: challenge, and subscribe to nothing until it is answered.
        ws.data.pendingAuth = true
        trackPending(app.id)

        ws.data.authTimer = setTimeout(() => {
            if (!ws.data.pendingAuth) return
            ws.data.pendingAuth = false
            trackPendingResolved(app.id)
            reject(ws, 'auth_timeout', 'Authorization timed out', CLOSE.AUTH_TIMEOUT)
        }, AUTH_TIMEOUT_MS)

        ws.send(frame(ws, PUSHPIN_AUTH_REQUIRED, { socketId: ws.data.socketId, channel }))
    },

    /**
     * Clients are receive-only, with exactly one exception: the single
     * `pushpin:subscribe` frame answering a private channel's challenge.
     *
     * The first line is what keeps that true. Every socket outside its
     * handshake window — which is every socket on a public channel, and every
     * private one the moment it subscribes — returns here before parsing,
     * allocating or replying to anything.
     */
    message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        if (!ws.data.pendingAuth) return

        // Consumed before the answer is even looked at, so a socket gets one
        // attempt whatever happens to it. Nothing to brute-force.
        ws.data.pendingAuth = false
        clearTimeout(ws.data.authTimer)
        ws.data.authTimer = undefined
        trackPendingResolved(ws.data.app!.id)

        if (typeof raw !== 'string' || raw.length > MAX_AUTH_FRAME) {
            return reject(ws, 'protocol_error', 'Unexpected message', CLOSE.PROTOCOL)
        }

        let msg: unknown
        try {
            msg = JSON.parse(raw)
        } catch {
            return reject(ws, 'protocol_error', 'Malformed message', CLOSE.PROTOCOL)
        }

        if ((msg as { event?: unknown })?.event !== PUSHPIN_SUBSCRIBE) {
            return reject(ws, 'protocol_error', 'Unexpected message', CLOSE.PROTOCOL)
        }

        const { app, channel, socketId } = ws.data
        // Never echoes the token back, and says only that it was wrong.
        if (!verify(app!.publishKey, socketId!, channel, (msg as { auth?: unknown }).auth)) {
            return reject(ws, 'auth_failed', 'Invalid authorization signature', CLOSE.UNAUTHORIZED)
        }

        subscribeNow(ws)
    },

    close(ws: ServerWebSocket<WsData>) {
        const { app, channel } = ws.data

        if (ws.data.authTimer) {
            clearTimeout(ws.data.authTimer)
            ws.data.authTimer = undefined
        }

        if (!app) return

        if (ws.data.pendingAuth) {
            ws.data.pendingAuth = false
            trackPendingResolved(app.id)
        }

        // Only tear down what was actually set up. `trackDisconnect` decrements
        // a per-(app, channel) counter shared by every listener, so running it
        // for a socket that never subscribed doesn't floor at zero — it
        // discounts real subscribers, and drops the channel's entry entirely
        // once it reaches 0 while people are still connected.
        if (!ws.data.subscribed) return

        ws.unsubscribe(`${app.id}:${channel}`)
        trackDisconnect(app.id, channel)
    },
}
