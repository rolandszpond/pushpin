# Pushpin 📌

Your own self-hosted pub/sub service. Like Pusher, but you own it.

## Architecture

```
Any backend  ──→  POST /publish  ──→  Pushpin Server  ──→  WebSocket clients
                  (publishKey)         (Bun + SQLite)         (subscribeKey)
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

### PHP
```php
require 'sdk/php/PushpinPublisher.php';

use Pushpin\PushpinPublisher;

$pushpin = new PushpinPublisher('https://your-pushpin.do.app', getenv('PUSHPIN_PUBLISH_KEY'));

$pushpin->trigger('orders', 'order.created', ['id' => 123, 'total' => 49.99]);

$pushpin->channel("user.$userId")->trigger('notification', ['text' => 'Your order shipped!']);

$pushpin->triggerBatch([
  ['channel' => 'orders', 'event' => 'order.created', 'data' => ['id' => 1]],
  ['channel' => "user.$userId", 'event' => 'notification', 'data' => ['text' => 'Hi']],
]);
```

---

## Subscribing (vanilla JS/TS)

No framework dependency — works in any browser context (plain script, bundler, or a `<script type="module">` tag).

```ts
import { PushpinClient } from './sdk/js/client'

const pushpin = new PushpinClient({ serverUrl: 'wss://your-pushpin.do.app', subscribeKey: 'sk_...' })

pushpin.channel('orders')
  .on('order.created', (data) => console.log(data))
  .on('order.updated', (data) => console.log(data))
  .on('*', ({ event, data }) => console.log(event, data))
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

---

## Subscribing (React / React Native)

`sdk/react/client.ts` works unmodified in both — it only relies on the standard `WebSocket` global, which React Native provides too.

### Setup — one shared client per app
```ts
// lib/pushpin.ts
import { PushpinClient } from './sdk/react/client'

export const pushpin = new PushpinClient({
  serverUrl: process.env.NEXT_PUBLIC_PUSHPIN_URL!, // or EXPO_PUBLIC_PUSHPIN_URL, etc.
  subscribeKey: process.env.NEXT_PUBLIC_PUSHPIN_SUBSCRIBE_KEY!,
})
```

### React hook
```tsx
import { useEffect } from 'react'
import { pushpin } from '@/lib/pushpin'
import { usePushpinChannel } from '@/sdk/react/client'

function Orders() {
  const { on, status, messages } = usePushpinChannel('orders', { client: pushpin })

  useEffect(() => {
    on('order.created', (data) => console.log('New order:', data))
  }, [on])

  return (
    <div>
      <div>Status: {status}</div>
      {messages.map((msg) => (
        <div key={msg.timestamp}>{msg.event}: {JSON.stringify(msg.data)}</div>
      ))}
    </div>
  )
}
```

---

## Private channels

A channel whose name starts with **`private-`** or **`presence-`** is not
delivered to a socket until that socket proves it is allowed to listen.

Everything else is unchanged. The subscribeKey is public by design — it ships
in your frontend bundle — so it identifies the *app*, not the person holding
it. For a channel anyone may read that is exactly right, and for one carrying
somebody's notifications it is worth nothing, which is what these prefixes fix.

(`presence-` is reserved now even though presence isn't built yet. Adding it
later against names that had always been public would silently downgrade every
existing `presence-*` channel on the day it shipped.)

### The handshake

```
client                          pushpin                         your backend
  │  connect ?channel=private-x   │                                  │
  ├──────────────────────────────►│                                  │
  │  pushpin:auth_required        │                                  │
  │  { socketId }                 │                                  │
  │◄──────────────────────────────┤                                  │
  │                                                                  │
  │  POST /pushpin/auth { socketId, channel }                        │
  ├─────────────────────────────────────────────────────────────────►│
  │                                              ▲ is THIS caller allowed
  │  { auth: "v1:<hmac>" }                       │ on THIS channel?
  │◄─────────────────────────────────────────────────────────────────┤
  │  pushpin:subscribe { auth }   │                                  │
  ├──────────────────────────────►│                                  │
  │  pushpin:connected            │  ✓ verified                      │
  │◄──────────────────────────────┤                                  │
```

The signature is over `"<socketId>:<channel>"`, keyed with the app's
**publishKey**, hex, prefixed `v1:`:

```
auth = "v1:" + HMAC_SHA256(publishKey, socketId + ":" + channel)
```

Because `socketId` is minted fresh for every connection, a signature is good
for exactly one socket and needs no expiry — and a reconnect is re-authorized
automatically, because the server challenges again with a new socketId.

An unanswered challenge is closed after 15s (`AUTH_TIMEOUT_MS`). A socket gets
exactly one attempt; there is nothing to brute-force.

### Authorizing (your backend)

The publisher SDK signs for you:

```ts
import { PushpinPublisher } from './sdk/js/publisher'

const pushpin = new PushpinPublisher({
  serverUrl: process.env.PUSHPIN_SERVER_URL!,
  publishKey: process.env.PUSHPIN_PUBLISH_KEY!,
})

app.post('/pushpin/auth', async (req, res) => {
  const user = await requireUser(req)          // however you authenticate
  const { socketId, channel } = req.body

  // ⚠️ THE LINE THAT MATTERS. See the warning below.
  if (!userMayListenTo(user, channel)) return res.status(403).json({ error: 'Forbidden' })

  res.json(pushpin.authorize({ socketId, channel }))
})
```

> **Signing any channel for any signed-in user is the same as having no private
> channels at all.** "Is there a session" is authentication; this endpoint needs
> *authorization* — an affirmative check that this specific caller belongs on
> this specific channel (`private-user.${user.id}` matched exactly, a membership
> lookup for a shared room), defaulting to deny. Without it, anyone who can log
> in can request a signature for somebody else's channel.

`authorize()` refuses a non-private channel and validates the socketId against
`/^[A-Za-z0-9_-]{6,64}$/` — the separator in the signed string is only
unambiguous while a socketId cannot contain `:`, and that value arrives from a
browser.

### Subscribing (frontend)

Give the client an `authorizer`; it is called on every connection, with the
socketId the server just issued.

```ts
const pushpin = new PushpinClient({
  serverUrl: import.meta.env.VITE_PUSHPIN_URL,
  subscribeKey: import.meta.env.VITE_PUSHPIN_SUBSCRIBE_KEY,
  authorizer: async ({ channel, socketId }) => {
    const res = await fetch('/pushpin/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ socketId, channel }),
    })
    if (!res.ok) throw Object.assign(new Error('forbidden'), { status: res.status })
    return res.json()            // { auth: "v1:..." }
  },
})

pushpin.channel(`private-user.${userId}`).on('notification', (data) => { /* … */ })
```

Never cache the token — the socketId changes on every connection, and
re-fetching is what makes reconnection re-authorize for free.

Behaviour worth knowing:

- A `private-` channel with no authorizer never opens a socket; it logs and
  goes straight to `unauthorized`.
- A **403 is terminal.** Any other authorizer failure (a dropped request, a
  cold start) is retried up to `maxAuthAttempts` (default 3) on the normal
  backoff, because giving up on one flaky fetch leaves a dead channel with no
  way back. `client.reauthorize(name)` clears a terminal refusal after a
  sign-in.
- A refused channel emits `pushpin:auth_failed` with `{ channel, error, fatal }`.
- If the server ever subscribes a private channel *without* challenging it —
  an old build, a rolled-back deploy — the client **refuses the subscription**
  and logs. It fails closed rather than listening unprotected.

### Close codes

| Code | Meaning |
|------|---------|
| 4001 | Invalid or missing authorization signature |
| 4002 | Authorization timed out |
| 4003 | Protocol error (unexpected or malformed frame) |

### Rolling this out

The server is backwards compatible: nothing existing uses these prefixes, and
an old SDK pointed at a private channel gets the `error` frame it already knows
to stop on. **Deploy the server before any client starts using private
channels** — a new client against an old server is the one unsafe combination,
and it is exactly what the fail-closed guard above exists to catch.

## One socket, many channels (multiplexed)

Every section above opens **one WebSocket per channel**. An app that listens to
a user's feed plus whatever the current screen shows ends up holding several.
Connect *without* `?channel=` instead and the socket carries as many channels
as you add to it:

```ts
import { PushpinSocket } from './sdk/js/socket'

const pushpin = new PushpinSocket({ serverUrl, subscribeKey, authorizer })

const off = pushpin.subscribe(`private-user.${userId}`, 'notification', (data) => { /* … */ })
off() // the channel is left once nothing else holds it
```

Subscriptions are reference-counted per channel, so two parts of a UI holding
the same channel share one subscription and releasing one doesn't cut off the
other. The socket opens on the first `subscribe` and closes shortly after the
last release (`lingerMs`, default 5s).

The wire protocol, for anyone writing another client:

```
connect  /app/:subscribeKey                 (no ?channel=)
←  pushpin:ready        { socketId }
→  { event: 'pushpin:subscribe',   channel, auth? }
←  pushpin:subscribed      { channel }                 — or —
←  pushpin:subscribe_error { channel, code }           auth_failed | too_many_channels
→  { event: 'pushpin:unsubscribe', channel }
```

- **No challenge round trip.** The socketId arrives in `ready`, so the client
  has the channel signed first and sends `auth` with the subscribe. The signed
  string is the same `"<socketId>:<channel>"`, so one auth endpoint serves both
  modes.
- **A refusal is per channel and the socket stays open**, since the other
  channels on it are still good. Five refused signatures on one socket close
  it with 4001, which is what bounds guessing now that one refusal doesn't.
- Messages carry their `channel`, which is how the client routes them.
- At most `MAX_CHANNELS_PER_SOCKET` channels per socket (default 50).

`?channel=` sockets are unchanged. The two modes don't mix on one socket.

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
| GET | `/admin/export` | Export all apps as JSON (for backup / restoring after an ephemeral redeploy) |
| POST | `/admin/import` | Restore apps from a previous export |

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

### Export / Import (persisting apps on App Platform)

Apps live in a local SQLite file (`pushpin.db`). On a Droplet that file survives every deploy for free. On DigitalOcean App Platform (or any host that rebuilds the container from scratch on each deploy), it does **not** — the DB resets to empty. Use export/import to carry your apps across:

```bash
# Before pushing a new deploy — save the current apps somewhere safe
curl http://localhost:3000/admin/export -H "x-admin-secret: your-admin-secret" > apps-backup.json

# After the new deploy is live — restore them
curl -X POST http://localhost:3000/admin/import \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: your-admin-secret" \
  -d "{\"apps\": $(jq .apps apps-backup.json)}"
```

Import **upserts by `id`** — publish/subscribe keys are preserved exactly (existing client configs keep working) and it never deletes an app just because it's missing from the payload. Re-running the same import is always safe.

This is a manual step you're responsible for triggering around each deploy — nothing runs it automatically. If you'd rather not remember to do this, a Droplet needs no such workaround.

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
5. **Important:** App Platform rebuilds the container from scratch on every deploy, wiping the local SQLite file. Export your apps before pushing and import them back after — see [Export / Import](#export--import-persisting-apps-on-app-platform) above.

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
| `AUTH_TIMEOUT_MS` | How long a private-channel socket may sit unanswered (default: 15000) |
| `MAX_CHANNELS_PER_SOCKET` | Channels one multiplexed socket may hold (default: 50) |
