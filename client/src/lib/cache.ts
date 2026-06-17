import { sql } from './db'
import type { App } from './store'

// Both publishKey and subscribeKey point to the same App object
const keyMap = new Map<string, App>()

export async function initCache(): Promise<void> {
    const apps = await sql<App[]>`SELECT * FROM apps`
    keyMap.clear()
    for (const app of apps) {
        keyMap.set(app.publishKey, app)
        keyMap.set(app.subscribeKey, app)
    }
    console.log(`[cache] warmed with ${apps.length} apps`)
}

export function getCachedApp(key: string): App | null {
    return keyMap.get(key) ?? null
}

export function addToCache(app: App): void {
    keyMap.set(app.publishKey, app)
    keyMap.set(app.subscribeKey, app)
}

export function updateInCache(app: App): void {
    keyMap.set(app.publishKey, app)
    keyMap.set(app.subscribeKey, app)
}

export function removeFromCache(app: App): void {
    keyMap.delete(app.publishKey)
    keyMap.delete(app.subscribeKey)
}
