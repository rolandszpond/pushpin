import { getAppByKey } from '../lib/store'

/**
 * Resolve an API key (publish or subscribe) to an app record.
 * Entirely Redis-backed — no Postgres needed.
 */
export async function resolveApp(apiKey: string) {
    return getAppByKey(apiKey)
}
