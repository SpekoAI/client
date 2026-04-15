# @spekoai/client roadmap

Deferred work beyond the v1 voice-only WebRTC release.

## Transports

- Text-only WebSocket conversation path (like `@elevenlabs/client` `TextConversation`)
- IIFE/CDN bundle for `<script>` tag usage (unpkg/jsdelivr)

## Identifiers / auth flows

- Public `agentId` flow — SDK fetches a short-lived token from Speko backend without requiring the consumer to proxy `/v1/sessions`. Requires public agent catalog on the server.
- `wss://livekit.speko.dev` (prod) cutover — swap the default `livekitUrl` once production LiveKit is stood up. Until then, v1 defaults to staging.

## Audio UX

- `getInputByteFrequencyData()` / `getOutputByteFrequencyData()` visualization helpers
- VAD score streaming via `onVadScore` callback
- Wake-lock acquisition during active calls

## Agent interaction

- Client tools (`clientTools: Record<string, fn>`) with server-driven invocation
- MCP tool call surface (`onMCPToolCall`, `sendMCPToolApprovalResult`)
- Agent tool request/response callbacks
- Guardrail-triggered callback

## Wrappers

- `@spekoai/react` — React hook + provider wrapping `Conversation`
