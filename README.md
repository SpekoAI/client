# @spekoai/client

Browser SDK for [SpekoAI](https://speko.ai) — real-time voice conversations in the browser over LiveKit WebRTC.

## Install

```bash
npm install @spekoai/client
# or
bun add @spekoai/client
```

## Quick start

Create a session from your backend (see [POST /v1/sessions](https://docs.speko.ai)), then start a conversation from the browser:

```ts
import { VoiceConversation } from '@spekoai/client';

const conversation = await VoiceConversation.create({
  conversationToken, // from your server's POST /v1/sessions response
  livekitUrl,        // from your server's POST /v1/sessions response

  onConnect: ({ conversationId }) => console.log('connected', conversationId),
  onDisconnect: ({ reason }) => console.log('disconnected', reason),
  onMessage: ({ source, text, isFinal }) => console.log(source, text, isFinal),
  onStatusChange: (status) => console.log('status', status),
  onModeChange: (mode) => console.log('mode', mode), // 'listening' | 'speaking'
  onError: (err) => console.error(err),
});

// control the session
await conversation.setMicMuted(true);
conversation.setVolume(0.8);
conversation.sendUserMessage('hello');
conversation.sendContextualUpdate('user switched to the checkout page');

await conversation.endSession();
```

## API

### `VoiceConversation.create(options)`

| Option             | Type                     | Description                                                                      |
| ------------------ | ------------------------ | -------------------------------------------------------------------------------- |
| `conversationToken`| `string`                 | LiveKit room token returned by your server.                                      |
| `livekitUrl`       | `string`                 | LiveKit WebSocket URL returned by your server.                                   |
| `overrides`        | `ConversationOverrides?` | Per-session agent / TTS overrides (prompt, firstMessage, language, voice, speed).|
| `inputDeviceId`    | `string?`                | Specific microphone deviceId.                                                    |
| `outputDeviceId`   | `string?`                | Specific speaker deviceId.                                                       |
| `audioConstraints` | `AudioConstraints?`      | `echoCancellation`, `noiseSuppression`, `autoGainControl` flags.                 |
| `on*` callbacks    | see types                | `onConnect`, `onDisconnect`, `onMessage`, `onStatusChange`, `onModeChange`, `onError`. |

### Instance methods

- `getId(): string` — conversation id
- `isOpen(): boolean`
- `setMicMuted(muted: boolean): Promise<void>`
- `setVolume(volume: number): void`
- `sendUserMessage(text: string): void`
- `sendContextualUpdate(text: string): void`
- `endSession(): Promise<void>`

## License

MIT
