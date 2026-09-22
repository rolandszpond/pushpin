import { timingSafeEqual } from 'node:crypto'

/**
 * Authorizing a subscription.
 *
 * The subscribe key is public by design — it ships in frontend bundles — so it
 * says which *app* a socket belongs to and nothing about who is holding it.
 * That's fine for a channel anyone may read and useless for one that carries
 * somebody's notifications, which is what these prefixes exist for.
 *
 * The model is Pusher's: the app's own backend, which already knows who its
 * caller is, signs a short string naming this exact socket and this exact
 * channel, and we check the signature. The secret is the app's `publishKey`,
 * so the party that can authorize a listener is the same party that can send —
 * a boundary that already exists rather than a new one to keep in sync.
 */

/**
 * Prefixes that require a handshake before subscribing.
 *
 * `presence-` is reserved now even though presence isn't built. If it were
 * added later against channels that had been public all along, the day it
 * shipped would be the day every existing `presence-*` channel silently became
 * a private one that had never been protected.
 *
 * Matched case-sensitively, like Pusher: `Private-foo` is a public channel
 * with an unfortunate name, not a private one.
 */
const PRIVATE_PREFIXES = ['private-', 'presence-'] as const

export function isPrivateChannel(channel: string): boolean {
    return PRIVATE_PREFIXES.some((prefix) => channel.startsWith(prefix))
}

/**
 * The signed string.
 *
 * Unambiguous because `socketId` is our own `nanoid` over `[A-Za-z0-9_-]` and
 * so can never contain the separator. That holds here; it does *not* hold at
 * the signing end, where the socketId arrives from a browser — an app's auth
 * endpoint has to validate the shape before signing, or the two halves of this
 * string stop being separable.
 *
 * No appId: the key is the app's own `publishKey`, so a signature minted for
 * one app already cannot validate under another.
 */
function payload(socketId: string, channel: string): string {
    return `${socketId}:${channel}`
}

/**
 * `v1:` tags the scheme, not the key. Pusher puts the app key here because it
 * has several to choose between; we resolve the app from the socket's URL long
 * before this runs, so the slot is free to carry the thing that actually can't
 * be derived — which digest and which secret produced the hex. Changing either
 * later is then a branch on the prefix rather than a flag day.
 */
const VERSION = 'v1'

/** Longer than any token this mints; a cheap bound before any work is done. */
const MAX_TOKEN_LENGTH = 256

export function sign(secret: string, socketId: string, channel: string): string {
    const digest = new Bun.CryptoHasher('sha256', secret)
        .update(payload(socketId, channel))
        .digest('hex')

    return `${VERSION}:${digest}`
}

/**
 * Constant-time by way of `timingSafeEqual`, which **throws** on a length
 * mismatch rather than returning false — hence the explicit length check
 * first. Both sides are a fixed-length prefix plus 64 hex characters, so that
 * check tells an attacker nothing they couldn't have worked out from this
 * file.
 */
export function verify(
    secret: string,
    socketId: string,
    channel: string,
    auth: unknown,
): boolean {
    if (typeof auth !== 'string' || auth.length > MAX_TOKEN_LENGTH) return false
    if (!auth.startsWith(`${VERSION}:`)) return false

    const given = Buffer.from(auth, 'utf8')
    const expected = Buffer.from(sign(secret, socketId, channel), 'utf8')
    if (given.length !== expected.length) return false

    return timingSafeEqual(given, expected)
}
