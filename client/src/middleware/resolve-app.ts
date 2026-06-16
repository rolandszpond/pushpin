import { getAppByKey } from '../lib/store'

export async function resolveApp(apiKey: string) {
    return getAppByKey(apiKey)
}
