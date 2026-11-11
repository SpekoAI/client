# @spekoai/client

Browser SDK for [SpekoAI](https://speko.ai) — real-time voice conversations in the browser.

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
  transportToken, // from your server's POST /v1/sessions response
  transportUrl,   // from your server's POST /v1/sessions response

  onConnect: ({ conversationId }) => console.log('connected', conversationId),
  onDisconnect: ({ reason }) => console.log('disconnected', reason),
  onMessage: ({ source, text, isFinal }) => console.log(source, text, isFinal),
  onStatusChange: (status) => console.log('status', status),
  onModeChange: (mode) => console.log('mode', mode), // 'listening' | 'speaking'
  onError: (err) => console.error(err),
});
```

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

`options` must contain short-lived session credentials minted by your backend.
Do not pass Speko API keys to browser code.

**Session form**:

| Option             | Type                     | Description                                                                      |
| ------------------ | ------------------------ | -------------------------------------------------------------------------------- |
| `transportToken`   | `string`                 | Browser-safe media transport token returned by your server.                      |
| `transportUrl`     | `string`                 | Media transport URL returned by your server.                                     |

`conversationToken` and `livekitUrl` are still accepted as legacy aliases.

Shared options:

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

## Listen to a live call

`CallListener` plays a live call's audio in the browser. It only receives. It
never asks for the microphone and it publishes nothing, so nobody on the call
can hear or see the listener.

Your backend mints the credentials with `speko.calls.listen(callId)` from
`@spekoai/sdk` and returns `url` and `token` to the browser.

```ts
import { CallListener } from '@spekoai/client';

const { url, token } = await fetch(`/api/calls/${callId}/listen`, {
  method: 'POST',
}).then((r) => r.json());

const listener = await CallListener.connect({
  url,
  token,
  onEnded: ({ reason }) => showIdle(reason === 'call_ended' ? 'Call ended' : ''),
  onError: () => showIdle('Connection lost'),
  onSpeakersChange: (speakers) => highlight(speakers), // ['agent'], ['caller'], or both
  onAudioPlaybackBlocked: () => showResumeButton(() => listener.startAudio()),
});

listener.setVolume(0.8);
await listener.disconnect();
```

`listener.status` is `connecting`, `listening`, `ended`, or `failed`. `ended`
and `failed` are final. To listen again, mint a new token and connect a new
listener. `connect()` rejects with `SpekoClientError` code `CONNECTION_FAILED`
when the join fails. A connection lost later calls `onError` with code
`DISCONNECTED`. If the call ends while the join is in progress, `connect()`
resolves to a listener whose status is already `ended`, after `onEnded` fired
with `call_ended`.

`onSpeakersChange` reports roles. On a call between two AI agents, both sides
report `agent`, so the array cannot tell the two agents apart.

With `outputDeviceId`, the call plays on that device only. If the browser
cannot route to the device, the listener stays silent and calls
`onOutputDeviceError(error)` once. The listener does not fall back to the
default device.

The credentials give receive access to everything in the call, which includes
any media published into the call and the messages that your backend sends
into the call. `CallListener` plays audio only. Give the credentials only to
people who are allowed to hear the whole call.

## License

MIT
