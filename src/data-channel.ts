import type {
  ConversationMessage,
  ConversationOverrides,
  MessageSource,
} from './types.js';

export interface OverridesPacket {
  readonly type: 'overrides';
  readonly overrides: ConversationOverrides;
}

export interface UserMessagePacket {
  readonly type: 'user_message';
  readonly text: string;
}

export interface ContextualUpdatePacket {
  readonly type: 'contextual_update';
  readonly text: string;
}

export type OutboundPacket =
  | OverridesPacket
  | UserMessagePacket
  | ContextualUpdatePacket;

export interface TranscriptPacket {
  readonly type: 'transcript';
  readonly source: MessageSource;
  readonly text: string;
  readonly isFinal?: boolean;
}

export interface AgentMessagePacket {
  readonly type: 'agent_message';
  readonly text: string;
  readonly isFinal?: boolean;
}

export interface UserMessageEchoPacket {
  readonly type: 'user_message_echo';
  readonly text: string;
}

export type InboundPacket =
  | TranscriptPacket
  | AgentMessagePacket
  | UserMessageEchoPacket;

export function encodePacket(packet: OutboundPacket): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(packet));
}

export function decodePacket(bytes: Uint8Array): InboundPacket | null {
  let parsed: unknown;
  try {
    const text = new TextDecoder().decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['type'] !== 'string') return null;
  return obj as unknown as InboundPacket;
}

export function packetToMessage(
  packet: InboundPacket,
): ConversationMessage | null {
  if (packet.type === 'transcript') {
    return {
      source: packet.source,
      text: packet.text,
      isFinal: packet.isFinal ?? true,
    };
  }
  if (packet.type === 'agent_message') {
    return {
      source: 'agent',
      text: packet.text,
      isFinal: packet.isFinal ?? true,
    };
  }
  if (packet.type === 'user_message_echo') {
    return { source: 'user', text: packet.text, isFinal: true };
  }
  return null;
}
