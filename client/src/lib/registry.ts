/**
 * Subscriber registry
 *
 * Bun's WebSocket server has built-in pub/sub via ws.subscribe() / server.publish().
 * This registry tracks per-app connection counts for the stats endpoint.
 *
 * For multi-instance deployments, we use Redis to fan out publishes across
 * all instances — each instance subscribes to its app channels via a polling
 * mechanism (Upstash doesn't support persistent connections, so we use a
 * lightweight approach: publish writes to Redis, and instances poll or
 * receive via the HTTP publish endpoint which fans out locally).
 *
 * In practice: for a single-instance deploy (most cases), Bun's built-in
 * pub/sub is all you need. The Redis layer adds resilience and multi-instance support.
 */

type ChannelStats = {
    connections: number
}

// appId → channel → stats
const registry = new Map<string, Map<string, ChannelStats>>()

// appId → sockets that have been challenged for a private channel and have not
// answered yet. Counted apart from `registry` because they are not subscribed
// to anything: they receive nothing, and a channel's connection count must not
// include them. Worth surfacing anyway — "stuck authorizing" is the failure
// mode this whole handshake introduces, and it is otherwise invisible.
const pending = new Map<string, number>()

export function trackPending(appId: string) {
    pending.set(appId, (pending.get(appId) ?? 0) + 1)
}

/** Answered, timed out, or gone. Called exactly once per `trackPending`. */
export function trackPendingResolved(appId: string) {
    const next = (pending.get(appId) ?? 0) - 1
    if (next <= 0) pending.delete(appId)
    else pending.set(appId, next)
}

export function trackConnect(appId: string, channel: string) {
    if (!registry.has(appId)) registry.set(appId, new Map())
    const channels = registry.get(appId)!
    if (!channels.has(channel)) channels.set(channel, { connections: 0 })
    channels.get(channel)!.connections++
}

export function trackDisconnect(appId: string, channel: string) {
    const channels = registry.get(appId)
    if (!channels) return
    const stats = channels.get(channel)
    if (!stats) return
    stats.connections = Math.max(0, stats.connections - 1)
    if (stats.connections === 0) channels.delete(channel)
    if (channels.size === 0) registry.delete(appId)
}

export function getStats(appId: string) {
    const channels = registry.get(appId)
    if (!channels) return { channels: {}, totalConnections: 0, pendingConnections: pending.get(appId) ?? 0 }

    const result: Record<string, number> = {}
    let total = 0
    for (const [channel, stats] of channels) {
        result[channel] = stats.connections
        total += stats.connections
    }
    return { channels: result, totalConnections: total, pendingConnections: pending.get(appId) ?? 0 }
}

export function getAllStats() {
    const result: Record<string, ReturnType<typeof getStats>> = {}
    // Union of both maps: an app whose only sockets are stuck authorizing has
    // no entry in `registry` at all, and that is exactly when you want to see
    // it here.
    for (const appId of new Set([...registry.keys(), ...pending.keys()])) {
        result[appId] = getStats(appId)
    }
    return result
}
