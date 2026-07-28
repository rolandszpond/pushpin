<?php

declare(strict_types=1);

namespace Pushpin;

/**
 * Pushpin Publisher SDK
 * Use in Laravel, WordPress, or any PHP backend.
 *
 * $pushpin = new PushpinPublisher('https://your-pushpin.do.app', 'pk_...');
 *
 * $pushpin->trigger('orders', 'order.created', ['id' => 123, 'total' => 49.99]);
 * $pushpin->channel('orders')->trigger('order.created', ['id' => 123]);
 * $pushpin->triggerBatch([
 *     ['channel' => 'orders', 'event' => 'order.created', 'data' => ['id' => 1]],
 *     ['channel' => "user.$userId", 'event' => 'notification', 'data' => ['text' => 'Hi']],
 * ]);
 */
final class PushpinPublisher
{
    private string $baseUrl;

    public function __construct(
        string $serverUrl,
        private readonly string $publishKey,
        private readonly string $publishPath = '/publish',
    ) {
        $this->baseUrl = rtrim($serverUrl, '/');
    }

    /** Trigger a single event on a channel */
    public function trigger(string $channel, string $event, mixed $data = null): array
    {
        return $this->post($this->publishPath, [
            'channel' => $channel,
            'event'   => $event,
            'data'    => $data,
        ]);
    }

    /** Trigger multiple events in a single request */
    public function triggerBatch(array $messages): array
    {
        return $this->post("{$this->publishPath}/batch", ['messages' => $messages]);
    }

    /** Fluent channel handle */
    public function channel(string $name): PushpinChannelHandle
    {
        return new PushpinChannelHandle($name, $this);
    }

    private function post(string $path, array $body): array
    {
        $ch = curl_init($this->baseUrl . $path);

        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($body, JSON_THROW_ON_ERROR),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                "Authorization: Bearer {$this->publishKey}",
            ],
        ]);

        $response = curl_exec($ch);
        if ($response === false) {
            $error = curl_error($ch);
            curl_close($ch);
            throw new \RuntimeException("Pushpin publish failed: {$error}");
        }

        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($status >= 400) {
            throw new \RuntimeException("Pushpin publish failed ({$status}): {$response}");
        }

        return json_decode($response, true, flags: JSON_THROW_ON_ERROR);
    }
}

final class PushpinChannelHandle
{
    public function __construct(
        private readonly string $name,
        private readonly PushpinPublisher $publisher,
    ) {}

    public function trigger(string $event, mixed $data = null): array
    {
        return $this->publisher->trigger($this->name, $event, $data);
    }
}
