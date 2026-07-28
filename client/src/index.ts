import { wsUpgradeRoute, websocketHandlers, type WsData } from './routes/ws'
import { publishRoutes } from './routes/publish'
import { adminRoutes } from './routes/admin'
import { json, cors } from './lib/http'

const PORT = Number(process.env.PORT ?? 3000)

const server = Bun.serve<WsData>({
    port: PORT,

    routes: {
        // Health check
        '/': (req) => json(req, {
            service: 'pushpin',
            version: '0.1.0',
            status: 'ok',
            timestamp: Date.now(),
        }),

        '/app/:subscribeKey': wsUpgradeRoute,

        ...publishRoutes,
        ...adminRoutes,
    },

    websocket: websocketHandlers,

    fetch(req) {
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors(req) })
        }
        return json(req, { ok: false, error: 'Not found' }, 404)
    },
})

console.log(`🚀 Pushpin running on port ${server.port}`)
