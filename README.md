# Pushpin 📌

Your own self-hosted pub/sub service. Like Pusher, but you own it.

## Architecture

```
Any backend  ──→  POST /publish  ──→  Pushpin Server  ──→  WebSocket clients
                  (publishKey)      (Elysia + Bun + SQLite)  (subscribeKey)
                                           │
                                           └──→  Webhook (optional, per app)
```

Each "app" gets two keys:
- **publishKey** (`pk_...`) — secret, server-side only. Used to send messages.
- **subscribeKey** (`sk_...`) — public, safe in frontend code. Used to receive messages.

Everything is stored in a local SQLite file (`pushpin.db`) via Bun's built-in SQLite — no external database needed.

---

## Setup

### 1. Install
```bash
bun install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in ADMIN_SECRET
```

### 3. Start the server
```bash
bun run dev      # development (watch mode)
bun run start    # production
```

### 4. Create your first app
```bash
curl -X POST http://localhost:3000/admin/apps \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: your-admin-secret" \
  -d '{"name": "My App"}'

# Response:
# {
#   "ok": true,
#   "app": {
#     "id": "abc123",
#     "name": "My App",
#     "publishKey": "pk_...",   ← keep secret, use server-side only
#     "subscribeKey": "sk_..."  ← safe for frontend
#   }
# }
```

---

## Publishing (backends)

```ts
import { PushpinPublisher } from './sdk/js/publisher'

const pushpin = new PushpinPublisher({
  serverUrl: 'https://your-pushpin.do.app',
  publishKey: process.env.PUSHPIN_PUBLISH_KEY!,
})

// Single event
await pushpin.trigger('orders', 'order.created', { id: 123, total: 49.99 })

// Fluent API
await pushpin.channel(`user.${userId}`).trigger('notification', { text: 'Your order shipped!' })

// Batch — multiple events in one request
await pushpin.triggerBatch([
  { channel: 'orders', event: 'order.created', data: { id: 1 } },
  { channel: `user.${userId}`, event: 'notification', data: { text: 'Hi' } },
])
```

---

## Subscribing (Vue frontend)

### Setup — one shared client per app
```ts
// lib/pushpin.ts
import { PushpinClient } from './sdk/vue/client'

export const pushpin = new PushpinClient({
  serverUrl: import.meta.env.VITE_PUSHPIN_URL,
  subscribeKey: import.meta.env.VITE_PUSHPIN_SUBSCRIBE_KEY,
})
```

### Vue composable
```vue
<script setup>
import { pushpin } from '@/lib/pushpin'
import { usePushpinChannel } from '@/sdk/vue/client'

const { on, status, messages } = usePushpinChannel('orders', { client: pushpin })

on('order.created', (data) => {
  console.log('New order:', data)
})

// Wildcard — fires for every event on this channel
on('*', ({ event, data }) => console.log(event, data))
</script>

<template>
  <div>Status: {{ status }}</div>
  <div v-for="msg in messages" :key="msg.timestamp">
    {{ msg.event }}: {{ JSON.stringify(msg.data) }}
  </div>
</template>
```

### Vanilla JS
```ts
import { PushpinClient } from './sdk/vue/client'

const pushpin = new PushpinClient({ serverUrl: '...', subscribeKey: 'sk_...' })

pushpin.channel('orders')
  .on('order.created', (data) => console.log(data))
  .on('order.updated', (data) => console.log(data))
```

---

## Admin API

All admin routes require `x-admin-secret` header.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/apps` | Create a new app |
| GET | `/admin/apps` | List all apps |
| GET | `/admin/apps/:id` | Get app details |
| PATCH | `/admin/apps/:id` | Update app (set/clear webhook URL) |
| DELETE | `/admin/apps/:id` | Delete an app |
| GET | `/admin/stats` | Live connection counts (all apps) |
| GET | `/admin/stats/:appId` | Live connection counts (one app) |
| GET | `/admin/usage` | Monthly usage (all apps) |
| GET | `/admin/usage/:appId` | Monthly usage (one app) |
| GET | `/admin/logs/:appId` | Recent messages — last 7 days |

### Webhooks

Each app can have an optional webhook URL. When set, Pushpin POSTs a JSON payload to that URL after every publish (fire-and-forget, does not block the response).

**Set a webhook:**
```bash
curl -X PATCH http://localhost:3000/admin/apps/<appId> \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: your-admin-secret" \
  -d '{"webhookUrl": "https://your-server.com/pushpin-hook"}'
```

**Clear a webhook:**
```bash
curl -X PATCH http://localhost:3000/admin/apps/<appId> \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: your-admin-secret" \
  -d '{"webhookUrl": null}'
```

**Webhook payload:**
```json
{
  "appId": "abc123",
  "channel": "orders",
  "event": "order.created",
  "data": { "id": 1 },
  "timestamp": 1718000000000,
  "delivered": 3
}
```

### Monthly usage

```bash
curl http://localhost:3000/admin/usage/abc123 \
  -H "x-admin-secret: your-admin-secret"

# Response:
# {
#   "ok": true,
#   "usage": [
#     { "appId": "abc123", "month": "2026-06", "messagesPublished": 1420, "connections": 83 }
#   ]
# }
```

### Message log

Returns all messages published in the last 7 days for an app. The log is pruned automatically every night at midnight.

```bash
curl http://localhost:3000/admin/logs/abc123 \
  -H "x-admin-secret: your-admin-secret"
```

---

## Testing locally

```bash
# Publish a message
curl -X POST http://localhost:3000/publish \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_your_publish_key" \
  -d '{"channel":"orders","event":"order.created","data":{"id":"test-1"}}'

# Connect a client (in browser console or wscat)
# wscat -c "ws://localhost:3000/app/sk_your_subscribe_key?channel=orders"
```

---

## Deploying to Digital Ocean

### App Platform (easiest)
1. Push to GitHub
2. Create a new DO App, point at your repo
3. Set environment variables in the DO dashboard
4. DO handles deploys, SSL, and scaling

### Droplet ($6/mo)
```bash
curl -fsSL https://bun.sh/install | bash
git clone your-repo && cd pushpin
bun install
bun run start
# Use pm2 or systemd to keep it running
```

---

## Scaling beyond one instance

The server uses Bun's in-memory pub/sub, which is perfect for a single instance.
For multiple instances behind a load balancer, a Redis fan-out layer would be needed —
each instance would subscribe to a shared Redis channel and broadcast locally.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `ADMIN_SECRET` | Secret for admin API routes |
