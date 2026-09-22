// ─── Messages ─────────────────────────────────────────────────────────────────

/**
 * Reserved events the server sends about the connection itself, as opposed to
 * anything an app published. All namespaced, so an app's own event names can
 * never collide with them.
 *
 * Single-channel sockets (`?channel=` on the URL):
 *
 * - `pushpin:connected`     — subscribed, messages will follow.
 * - `pushpin:auth_required` — private channel: sign this socketId and reply
 *                             with `pushpin:subscribe` before anything is
 *                             delivered. See client/src/lib/auth.ts.
 *
 * Multiplexed sockets (no `?channel=`):
 *
 * - `pushpin:ready`           — open, subscribed to nothing, carrying the
 *                               socketId to have channels signed against.
 * - `pushpin:subscribed`      — one channel added; its messages will follow.
 * - `pushpin:subscribe_error` — one channel refused (`auth_failed`,
 *                               `too_many_channels`). The socket stays open.
 *
 * Either:
 *
 * - `error` — refused; the socket is about to close. Not namespaced, because
 *             the SDKs have always keyed on this name to stop reconnecting.
 */
export const PUSHPIN_CONNECTED = 'pushpin:connected'
export const PUSHPIN_AUTH_REQUIRED = 'pushpin:auth_required'
export const PUSHPIN_READY = 'pushpin:ready'
export const PUSHPIN_SUBSCRIBED = 'pushpin:subscribed'
export const PUSHPIN_SUBSCRIBE_ERROR = 'pushpin:subscribe_error'

/** Client → server. */
export const PUSHPIN_SUBSCRIBE = 'pushpin:subscribe'
export const PUSHPIN_UNSUBSCRIBE = 'pushpin:unsubscribe'

export type WireMessage = {
    event: string
    data: unknown
    channel: string
    appId: string
    timestamp: number
}

/**
 * What a client may send. Single-channel: exactly one `subscribe`, carrying
 * `auth` and no `channel`, answering the challenge. Multiplexed: any number of
 * both, each naming its `channel`, `auth` required on a private one.
 */
export type SubscribeFrame = {
    event: typeof PUSHPIN_SUBSCRIBE
    channel?: string
    auth?: string
}

export type UnsubscribeFrame = {
    event: typeof PUSHPIN_UNSUBSCRIBE
    channel: string
}
