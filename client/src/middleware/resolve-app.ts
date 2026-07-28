import { getAppByKey } from '../lib/store'

export function resolveApp(apiKey: string) {
    return getAppByKey(apiKey)
}
