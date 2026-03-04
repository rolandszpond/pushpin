import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { wsRoute } from './routes/ws'
import { publishRoute } from './routes/publish'
import { adminRoute } from './routes/admin'

const PORT = Number(process.env.PORT ?? 3000)

const app = new Elysia()
    .use(cors({
        origin: true, // restrict to your domains in production
        methods: ['GET', 'POST', 'DELETE'],
    }))

    // Health check
    .get('/', () => ({
        service: 'pushpin',
        version: '0.1.0',
        status: 'ok',
        timestamp: Date.now(),
    }))

    // Routes
    .use(wsRoute)
    .use(publishRoute)
    .use(adminRoute)

    .listen(PORT)

console.log(`🚀 Pushpin running on port ${PORT}`)

export type App = typeof app
