import type { BunRequest, Server, ServerWebSocket } from 'bun'
import { resolveApp } from '../middleware/resolve-app'
import { trackConnect, trackDisconnect, trackPending, trackPendingResolved } from '../lib/registry'
import {
    PUSHPIN_AUTH_REQUIRED,
    PUSHPIN_CONNECTED,
    PUSHPIN_READY,
    PUSHPIN_SUBSCRIBE,
    PUSHPIN_SUBSCRIBED,
    PUSHPIN_SUBSCRIBE_ERROR,
    PUSHPIN_UNSUBSCRIBE,
    type WireMessage,
} from '../types'
import { isPrivateChannel, verify } from '../lib/auth'
import type { App } from '../lib/store'
import { nanoid } from 'nanoid'

export type WsData = {
    subscribeKey: string
    /**
     * Single-channel mode: the one channel named in the connect URL. Absent
     * means the socket is multiplexed and carries `channels` instead — the two
     * modes never mix on one socket.
     */
    channel?: string
    /** Multiplexed mode: every channel this socket is subscribed to. */
    channels?: Set<string>
    /** Multiplexed mode: refused subscribe frames so far. */
    authFailures?: number
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

/**
 * Multiplexed sockets only. A page holds a handful of channels; the cap is
 * there so one socket can't make the server hold an unbounded set for it.
 */
const MAX_CHANNELS_PER_SOCKET = Number(process.env.MAX_CHANNELS_PER_SOCKET ?? 50)

/**
 * Multiplexed sockets only. A refused subscribe doesn't close the socket —
 * one channel being refused mustn't take down the others it carries — so this
 * is what bounds guessing instead. A legitimate client only reaches it through
 * a bug: its backend signs, or refuses to sign, before it ever sends.
 */
const MAX_AUTH_FAILURES = 5

/** Longer than any channel name an app should use; checked before verifying. */
const MAX_CHANNEL_LENGTH = 200

const CLOSE = {
    UNAUTHORIZED: 4001,
    AUTH_TIMEOUT: 4002,
    PROTOCOL: 4003,
} as const

/**
 * WebSocket endpoint
 *
 * Two ways in, decided by whether the URL names a channel:
 *
 *   ws://your-service.com/app/:subscribeKey?channel=my-channel
 *     Single-channel. The original protocol, unchanged: one socket per
 *     channel, a private channel challenged on open. Every existing SDK
 *     speaks this.
 *
 *   ws://your-service.com/app/:subscribeKey
 *     Multiplexed. The socket opens subscribed to nothing, is told its
 *     socketId (`pushpin:ready`), and then adds and removes channels with
 *     `pushpin:subscribe` / `pushpin:unsubscribe` frames — see
 *     `onMultiplexFrame`. One socket for a whole app, instead of one per
 *     channel it listens to.
 *
 * The subscribeKey is public — safe to use in frontend code. It can only
 * receive messages, not publish, and it identifies the app rather than the
 * person holding it. A channel named `private-*` or `presence-*` therefore
 * takes a signature before anything is delivered, on either path: see
 * client/src/lib/auth.ts.
 *
 * The upgrade always succeeds; subscribeKey validation happens in open() so
 * the client gets an `error` message frame instead of a bare connection
 * failure (the SDK relies on that frame to stop reconnecting).
 */
export function wsUpgradeRoute(req: BunRequest<'/app/:subscribeKey'>, server: Server) {
    const { subscribeKey } = req.params
    // An empty `?channel=` is a malformed single-channel request, not a
    // request for multiplexing — only a missing param means that.
    const channel = new URL(req.url).searchParams.get('channel') ?? undefined
    if (channel === '') {
        return Response.json({ ok: false, error: 'Empty channel query param' }, { status: 400 })
    }

    const upgraded = server.upgrade(req, { data: { subscribeKey, channel } satisfies WsData })
    if (!upgraded) {
        return Response.json({ ok: false, error: 'WebSocket upgrade failed' }, { status: 400 })
    }
}

function frame(ws: ServerWebSocket<WsData>, event: string, data: unknown, channel = ws.data.channel ?? ''): string {
    return JSON.stringify({
        event,
        data,
        channel,
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
    ws.subscribe(`${app!.id}:${channel!}`)
    ws.data.subscribed = true
    trackConnect(app!.id, channel!)

    ws.send(frame(ws, PUSHPIN_CONNECTED, { socketId, channel }))
}

/**
 * Parse one client frame, or refuse the socket. Shared by both modes: the
 * bounds are the same whichever frame is expected.
 */
function parseFrame(ws: ServerWebSocket<WsData>, raw: string | Buffer): Record<string, unknown> | null {
    if (typeof raw !== 'string' || raw.length > MAX_AUTH_FRAME) {
        reject(ws, 'protocol_error', 'Unexpected message', CLOSE.PROTOCOL)
        return null
    }
    let msg: unknown
    try {
        msg = JSON.parse(raw)
    } catch {
        reject(ws, 'protocol_error', 'Malformed message', CLOSE.PROTOCOL)
        return null
    }
    if (typeof msg !== 'object' || msg === null) {
        reject(ws, 'protocol_error', 'Unexpected message', CLOSE.PROTOCOL)
        return null
    }
    return msg as Record<string, unknown>
}

/**
 * The single-channel handshake: the one `pushpin:subscribe` frame answering
 * a private channel's challenge.
 */
function onChallengeAnswer(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    // Consumed before the answer is even looked at, so a socket gets one
    // attempt whatever happens to it. Nothing to brute-force.
    ws.data.pendingAuth = false
    clearTimeout(ws.data.authTimer)
    ws.data.authTimer = undefined
    trackPendingResolved(ws.data.app!.id)

    const msg = parseFrame(ws, raw)
    if (!msg) return

    if (msg.event !== PUSHPIN_SUBSCRIBE) {
        return reject(ws, 'protocol_error', 'Unexpected message', CLOSE.PROTOCOL)
    }

    const { app, channel, socketId } = ws.data
    // Never echoes the token back, and says only that it was wrong.
    if (!verify(app!.publishKey, socketId!, channel!, msg.auth)) {
        return reject(ws, 'auth_failed', 'Invalid authorization signature', CLOSE.UNAUTHORIZED)
    }

    subscribeNow(ws)
}

/**
 * The multiplexed protocol:
 *
 *   → { event: 'pushpin:subscribe', channel, auth? }
 *   ← pushpin:subscribed { channel }  or  pushpin:subscribe_error { channel, code }
 *
 *   → { event: 'pushpin:unsubscribe', channel }
 *
 * No challenge round trip: the socketId arrived in `pushpin:ready`, so the
 * client can have a channel signed before it asks, and `auth` rides on the
 * subscribe itself. The signed string is the same `socketId:channel` as the
 * single-channel handshake — one signature scheme, so an app's auth endpoint
 * serves both without knowing which one is asking.
 *
 * A refusal is per channel and leaves the socket open, because the other
 * channels it carries are still good. Anything that isn't one of these two
 * frames is a protocol error and closes it.
 */
function onMultiplexFrame(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    const msg = parseFrame(ws, raw)
    if (!msg) return

    const { app, socketId } = ws.data
    const channels = ws.data.channels!
    const channel = msg.channel

    if (typeof channel !== 'string' || channel.length === 0 || channel.length > MAX_CHANNEL_LENGTH) {
        return reject(ws, 'protocol_error', 'Invalid channel', CLOSE.PROTOCOL)
    }

    if (msg.event === PUSHPIN_UNSUBSCRIBE) {
        // Leaving something you aren't on is a no-op, not an error: the
        // client may be racing its own earlier refusal.
        if (!channels.delete(channel)) return
        ws.unsubscribe(`${app!.id}:${channel}`)
        trackDisconnect(app!.id, channel)
        return
    }

    if (msg.event !== PUSHPIN_SUBSCRIBE) {
        return reject(ws, 'protocol_error', 'Unexpected message', CLOSE.PROTOCOL)
    }

    // Idempotent: a repeat gets the same answer rather than a double-counted
    // subscriber.
    if (channels.has(channel)) {
        ws.send(frame(ws, PUSHPIN_SUBSCRIBED, { channel }, channel))
        return
    }

    if (channels.size >= MAX_CHANNELS_PER_SOCKET) {
        ws.send(frame(ws, PUSHPIN_SUBSCRIBE_ERROR, { channel, code: 'too_many_channels' }, channel))
        return
    }

    if (isPrivateChannel(channel) && !verify(app!.publishKey, socketId!, channel, msg.auth)) {
        ws.data.authFailures = (ws.data.authFailures ?? 0) + 1
        if (ws.data.authFailures >= MAX_AUTH_FAILURES) {
            return reject(ws, 'auth_failed', 'Too many invalid authorization signatures', CLOSE.UNAUTHORIZED)
        }
        // Says only that it was wrong, like the single-channel path.
        ws.send(frame(ws, PUSHPIN_SUBSCRIBE_ERROR, { channel, code: 'auth_failed' }, channel))
        return
    }

    channels.add(channel)
    ws.subscribe(`${app!.id}:${channel}`)
    trackConnect(app!.id, channel)
    ws.send(frame(ws, PUSHPIN_SUBSCRIBED, { channel }, channel))
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

        // Multiplexed: subscribed to nothing, and says so. Everything after
        // this is driven by the client's frames.
        if (channel === undefined) {
            ws.data.channels = new Set()
            ws.send(frame(ws, PUSHPIN_READY, { socketId: ws.data.socketId }))
            return
        }

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
     * A single-channel socket is receive-only, with exactly one exception: the
     * `pushpin:subscribe` frame answering a private channel's challenge. The
     * `pendingAuth` check keeps that true — every such socket outside its
     * handshake window returns before parsing, allocating or replying to
     * anything.
     *
     * A multiplexed socket sends subscribe and unsubscribe frames for as long
     * as it's open; that's what it's for.
     */
    message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
        if (!ws.data.app) return
        if (ws.data.channels) return onMultiplexFrame(ws, raw)
        if (!ws.data.pendingAuth) return
        onChallengeAnswer(ws, raw)
    },

    close(ws: ServerWebSocket<WsData>) {
        const { app, channel, channels } = ws.data

        if (ws.data.authTimer) {
            clearTimeout(ws.data.authTimer)
            ws.data.authTimer = undefined
        }

        if (!app) return

        if (ws.data.pendingAuth) {
            ws.data.pendingAuth = false
            trackPendingResolved(app.id)
        }

        if (channels) {
            for (const name of channels) {
                ws.unsubscribe(`${app.id}:${name}`)
                trackDisconnect(app.id, name)
            }
            channels.clear()
            return
        }

        // Only tear down what was actually set up. `trackDisconnect` decrements
        // a per-(app, channel) counter shared by every listener, so running it
        // for a socket that never subscribed doesn't floor at zero — it
        // discounts real subscribers, and drops the channel's entry entirely
        // once it reaches 0 while people are still connected.
        if (!ws.data.subscribed) return

        ws.unsubscribe(`${app.id}:${channel!}`)
        trackDisconnect(app.id, channel!)
    },
}
