import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { cron } from '@elysiajs/cron'
import { wsRoute } from './routes/ws'
import { publishRoute } from './routes/publish'
import { adminRoute } from './routes/admin'
import { pruneOldLogs } from './lib/store'
import { migrate } from './lib/migrate'
import { initCache } from './lib/cache'

const PORT = Number(process.env.PORT ?? 3000)

await migrate()
await initCache()

const app = new Elysia()
    .use(cors({
        origin: true, // restrict to your domains in production
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    }))

    // Health check
    .get('/', () => ({
        service: 'pushpin',
        version: '0.1.0',
        status: 'ok',
        timestamp: Date.now(),
    }))

    .use(cron({
        name: 'prune-message-log',
        pattern: '0 0 * * *', // daily at midnight
        run: pruneOldLogs,
    }))

    // Routes
    .use(wsRoute)
    .use(publishRoute)
    .use(adminRoute)

    .listen(PORT)

console.log(`🚀 Pushpin running on port ${PORT}`)

export type App = typeof app
