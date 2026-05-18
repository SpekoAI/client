# @spekoai/client

Browser SDK for [SpekoAI](https://speko.ai) — real-time voice conversations in the browser over LiveKit WebRTC.

## Install

```bash
npm install @spekoai/client
# or
pnpm add @spekoai/client
```

## Quick start

Create a session from your backend (see [POST /v1/sessions](https://docs.speko.dev)), then start a conversation from the browser:

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
```

### Agent form (no backend required)

If you have a persistent agent (created via `POST /v1/agents`), the SDK can mint
the session for you. Pass an `agentId` and a Speko API key — the SDK calls
`POST /v1/sessions` and connects in one step:

```ts
import { VoiceConversation } from '@spekoai/client';

const conversation = await VoiceConversation.create({
  agentId: 'agent_a1b2c3',
  apiKey: process.env.SPEKO_API_KEY!,
  // optional: apiBaseUrl: 'https://staging.speko.dev',
});
```

Use this form for embedded widgets, prototypes, or server-rendered apps that
already hold a short-lived API key. For production browser apps, prefer the
token form above and mint sessions on a backend you control so your API key
never reaches the client.

### Controlling the session

```ts
await conversation.setMicMuted(true);
conversation.setVolume(0.8);
conversation.sendUserMessage('hello');
conversation.sendContextualUpdate('user switched to the checkout page');

await conversation.endSession();
```

## API

### `VoiceConversation.create(options)`

`options` is one of two shapes — token form or agent form.

**Token form** (your backend mints sessions):

| Option             | Type                     | Description                                                                      |
| ------------------ | ------------------------ | -------------------------------------------------------------------------------- |
| `conversationToken`| `string`                 | LiveKit room token returned by your server.                                      |
| `livekitUrl`       | `string`                 | LiveKit WebSocket URL returned by your server.                                   |

**Agent form** (SDK mints from a Speko API key):

| Option       | Type      | Description                                                              |
| ------------ | --------- | ------------------------------------------------------------------------ |
| `agentId`    | `string`  | Persistent agent id from `POST /v1/agents`.                              |
| `apiKey`     | `string`  | Speko API key. Sent as `Authorization: Bearer ...` to `/v1/sessions`.    |
| `apiBaseUrl` | `string?` | Override the API origin. Defaults to `https://api.speko.dev`.             |

Both forms accept the same shared options:

| Option             | Type                     | Description                                                                      |
| ------------------ | ------------------------ | -------------------------------------------------------------------------------- |
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
