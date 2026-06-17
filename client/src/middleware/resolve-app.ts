import { getCachedApp } from '../lib/cache'

export function resolveApp(apiKey: string) {
    return getCachedApp(apiKey)
}
