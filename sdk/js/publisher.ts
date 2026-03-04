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
