/**
 * Pushpin Publisher SDK
 * Use in Firebase Cloud Functions, Node backends, or any server environment.
 *
 * import { PushpinPublisher } from 'pushpin-publisher'
 *
 * const pushpin = new PushpinPublisher({
 *   serverUrl: 'https://your-pushpin.do.app',
 *   publishKey: 'pk_...',
 * })
 *
 * await pushpin.trigger('orders', 'order.created', { id: 123 })
 * await pushpin.channel('orders').trigger('order.created', { id: 123 })
 * await pushpin.triggerBatch([
 *   { channel: 'orders', event: 'order.created', data: { id: 1 } },
 *   { channel: `user.${userId}`, event: 'notification', data: { text: 'Hi' } },
 * ])
 */

import { createHmac } from 'node:crypto'

/**
 * A socketId is minted by the server as a nanoid, so it can only ever be these
 * characters — and crucially it can never contain the ':' that separates it
 * from the channel in the signed string. This is validated because the
 * socketId arrives from a browser: without the check, a caller could submit
 * `"abc:private-other"` and be handed a signature over a string that splits
 * somewhere else entirely.
 */
const SOCKET_ID = /^[A-Za-z0-9_-]{6,64}$/

const PRIVATE_PREFIXES = ['private-', 'presence-']

type PublisherOptions = {
    serverUrl: string
    publishKey: string
    /** Override publish path. Default: '/publish' */
    publishPath?: string
}

type TriggerPayload = {
    channel: string
    event: string
    data?: unknown
}

type TriggerResult = {
    ok: boolean
    delivered: number
}

type BatchResult = {
    ok: boolean
    results: Array<{ channel: string; event: string; delivered: number }>
}

export class PushpinPublisher {
    private baseUrl: string
    private publishKey: string
    private publishPath: string

    constructor({ serverUrl, publishKey, publishPath = '/publish' }: PublisherOptions) {
        this.baseUrl = serverUrl.replace(/\/$/, '')
        this.publishKey = publishKey
        this.publishPath = publishPath
    }

    private get headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.publishKey}`,
        }
    }

    /** Trigger a single event on a channel */
    async trigger(channel: string, event: string, data?: unknown): Promise<TriggerResult> {
        const res = await fetch(`${this.baseUrl}${this.publishPath}`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ channel, event, data }),
        })

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`Pushpin publish failed (${res.status}): ${text}`)
        }

        return res.json() as Promise<TriggerResult>
    }

    /** Trigger multiple events in a single request */
    async triggerBatch(messages: TriggerPayload[]): Promise<BatchResult> {
        const res = await fetch(`${this.baseUrl}${this.publishPath}/batch`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ messages }),
        })

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`Pushpin batch publish failed (${res.status}): ${text}`)
        }

        return res.json() as Promise<BatchResult>
    }

    /**
     * Sign a private-channel subscription for one socket.
     *
     * Server-side only, and the signature is the easy half. The hard half is
     * the line you write *before* calling this: that the caller in front of
     * you is actually entitled to this channel. Signing whatever an
     * authenticated user asks for is the same as having no private channels at
     * all, since anyone signed in could then request somebody else's.
     */
    authorize({ socketId, channel }: { socketId: string; channel: string }): { auth: string } {
        if (!SOCKET_ID.test(socketId)) throw new Error('invalid socketId')
        if (!PRIVATE_PREFIXES.some((prefix) => channel.startsWith(prefix))) {
            throw new Error(`channel "${channel}" is not private`)
        }

        const digest = createHmac('sha256', this.publishKey)
            .update(`${socketId}:${channel}`)
            .digest('hex')

        return { auth: `v1:${digest}` }
    }

    /** Fluent channel handle */
    channel(name: string): ChannelHandle {
        return new ChannelHandle(name, this)
    }
}

export class ChannelHandle {
    constructor(
        private name: string,
        private publisher: PushpinPublisher,
    ) {}

    trigger(event: string, data?: unknown) {
        return this.publisher.trigger(this.name, event, data)
    }
}
