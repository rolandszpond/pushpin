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
    if (!channels) return { channels: {}, totalConnections: 0 }

    const result: Record<string, number> = {}
    let total = 0
    for (const [channel, stats] of channels) {
        result[channel] = stats.connections
        total += stats.connections
    }
    return { channels: result, totalConnections: total }
}

export function getAllStats() {
    const result: Record<string, ReturnType<typeof getStats>> = {}
    for (const appId of registry.keys()) {
        result[appId] = getStats(appId)
    }
    return result
}
