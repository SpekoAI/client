# @spekoai/client — skill sheet

Dense reference for an LLM building a **browser** voice experience with
Speko. For a prose walkthrough, read the README.

## When to use

Pick `@spekoai/client` when you want a user in a browser to have a
real-time voice conversation with a Speko-powered agent. The SDK speaks
to LiveKit over WebRTC; the server picks STT/LLM/TTS providers per
utterance and handles failover. If you're on the server, use
`@spekoai/sdk`. If you're running a LiveKit Agents worker, use
`@spekoai/adapter-livekit`.

## Install

```bash
bun add @spekoai/client
# or: npm install @spekoai/client
```

Requires a modern browser (WebRTC + `AudioContext`). Ships ESM.

## Two-step flow

1. **Backend** mints a conversation token by calling
   `POST /v1/sessions` on the Speko API (direct REST call — `@spekoai/sdk`
   does **not** expose a sessions helper today). Response includes
   `conversationToken` + `livekitUrl`.
2. **Browser** opens `VoiceConversation.create(...)` with those two values.

Do not call `/v1/sessions` from the browser — that would leak your API
key. Token issuance stays server-side; the browser receives a scoped,
short-lived LiveKit token.

### Backend: minting a conversation token

Direct REST call — no SDK method exists for this yet.

```
POST https://api.speko.ai/v1/sessions
Authorization: Bearer $SPEKO_API_KEY
Content-Type: application/json
```

Request body:

```json
{
  "intent": {
    "language": "en-US",
    "optimizeFor": "balanced"
  },
  "constraints": { "allowedProviders": { "tts": ["cartesia"] } },
  "systemPrompt": "You are a concise voice assistant.",
  "voice": "sonic-english",
  "llm":        { "temperature": 0.7, "maxTokens": 400 },
  "ttsOptions": { "sampleRate": 24000, "speed": 1.0 },
  "ttlSeconds": 900,
  "identity":   "user_abc123",
  "metadata":   { "userId": "abc123" }
}
```

- `intent` is **required** and is a nested object. `language` is BCP-47.
  Valid `optimizeFor`: `balanced | accuracy | latency | cost`.
- Everything else is optional. `ttlSeconds` defaults to 900 (max
  86400). `identity` defaults to a random uuid; set it to a
  stable-per-user value if you want LiveKit presence / analytics to
  correlate sessions by end user.
- There is **no `agent` / `agentId` field**. There is no
  `SPEKO_AGENT_ID` env var. Agent behavior is configured via
  `systemPrompt` + `voice` + `llm` at session-creation time.

Response `201`:

```json
{
  "sessionId": "uuid",
  "conversationToken": "jwt-for-livekit",
  "livekitUrl": "wss://...",
  "roomName": "speko_<uuid>",
  "identity": "user_abc123",
  "expiresAt": "2026-04-18T19:00:00Z"
}
```

Return `conversationToken` and `livekitUrl` to the browser — the
browser does not need the other fields.

## Minimal snippet

```ts
import { VoiceConversation } from '@spekoai/client';

// 1) Fetch conversation token + LiveKit URL from your backend.
const res = await fetch('/api/create-session', { method: 'POST' });
const { conversationToken, livekitUrl } = await res.json();

// 2) Open the conversation.
const conversation = await VoiceConversation.create({
  conversationToken,
  livekitUrl,

  onConnect:      ({ conversationId }) => console.log('open', conversationId),
  onDisconnect:   ({ reason }) => console.log('closed:', reason),
  onMessage:      ({ source, text, isFinal }) => console.log(source, text),
  onStatusChange: (status) => console.log('status:', status),
  onModeChange:   (mode)   => console.log('mode:', mode), // listening|speaking
  onError:        (err)    => console.error(err),
});

// Controls
await conversation.setMicMuted(true);
conversation.setVolume(0.8);
conversation.sendUserMessage('hello');            // injects text as a user turn
conversation.sendContextualUpdate('user is on /checkout'); // out-of-band hint
await conversation.endSession();
```

## Public surface

- `VoiceConversation.create(opts) -> Promise<VoiceConversation>`
- Instance methods: `getId()`, `isOpen()`, `setMicMuted(bool)`,
  `setVolume(0-1)`, `sendUserMessage(text)`, `sendContextualUpdate(text)`,
  `endSession()`.
- Also exported (lower-level text path, rarely needed directly): `Conversation`.
- Error: `SpekoClientError` with `SpekoClientErrorCode` enum.
- Types: `ConversationOptions`, `ConversationCallbacks`, `ConversationMode`
  (`listening|speaking`), `ConversationStatus`
  (`connecting|connected|disconnecting|disconnected`),
  `DisconnectionReason` (`user|agent|error|timeout|unknown`),
  `ConversationMessage { source, text, isFinal }`,
  `AgentOverrides { prompt?, firstMessage?, language? }`,
  `TtsOverrides { voiceId?, speed? }`,
  `ConversationOverrides { agent?, tts? }`,
  `AudioConstraints { echoCancellation?, noiseSuppression?, autoGainControl? }`.

## Per-session overrides

Set these on `create({ overrides })` to tweak a single session without
re-deploying an agent definition:

```ts
await VoiceConversation.create({
  conversationToken, livekitUrl,
  overrides: {
    agent: { prompt: 'Be extra concise.', firstMessage: 'Hi!', language: 'en' },
    tts:   { voiceId: 'cartesia-sonic', speed: 1.1 },
  },
  onConnect: (…) => …,
});
```

## Common gotchas

- **`livekitUrl` has no default.** The SDK refuses to guess so you can't
  ship against staging by accident. Always pass the value from your
  session response.
- **Mic permission is required.** Browsers prompt on first `create()`.
  Surface UX for the denial case — the SDK emits `onError`.
- **iOS requires a user gesture** before `AudioContext` can start. Call
  `create()` from a button click, not `useEffect`.
- **`endSession()` must be awaited** or audio tracks linger until GC.
- **`sendUserMessage` vs `sendContextualUpdate`**: the former injects a
  visible user turn; the latter is an invisible hint the agent uses to
  adjust behavior (e.g. page change). Don't confuse them.
- **Status ≠ mode.** `status` is the lifecycle (`connecting` → `connected`
  → `disconnected`); `mode` is whether the agent is currently listening
  or speaking.
- **No tool calls yet.** Client-side tool invocation is not in v1.

## See also

- README: `spekoai://docs/client-readme`
- Server SDK (to mint sessions): `spekoai://docs/sdk-skills`
- Scaffold: prompt `scaffold_project` with `scenario=voice_conversation`.
