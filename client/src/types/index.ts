// ─── Messages ─────────────────────────────────────────────────────────────────

/**
 * Reserved events the server sends about the connection itself, as opposed to
 * anything an app published. All namespaced, so an app's own event names can
 * never collide with them.
 *
 * - `pushpin:connected`     — subscribed, messages will follow.
 * - `pushpin:auth_required` — private channel: sign this socketId and reply
 *                             with `pushpin:subscribe` before anything is
 *                             delivered. See client/src/lib/auth.ts.
 * - `error`                 — refused; the socket is about to close. Not
 *                             namespaced, because the SDKs have always keyed
 *                             on this name to stop reconnecting.
 */
export const PUSHPIN_CONNECTED = 'pushpin:connected'
export const PUSHPIN_AUTH_REQUIRED = 'pushpin:auth_required'
export const PUSHPIN_SUBSCRIBE = 'pushpin:subscribe'

export type WireMessage = {
    event: string
    data: unknown
    channel: string
    appId: string
    timestamp: number
}

/** The one frame a client is ever allowed to send. */
export type SubscribeFrame = {
    event: typeof PUSHPIN_SUBSCRIBE
    auth: string
}
