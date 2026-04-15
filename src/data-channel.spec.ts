import { describe, expect, it } from 'vitest';
import {
  decodePacket,
  encodePacket,
  packetToMessage,
} from './data-channel.js';

describe('data-channel', () => {
  it('round-trips an outbound user message', () => {
    const bytes = encodePacket({ type: 'user_message', text: 'hello' });
    const decoded = decodePacket(bytes);
    expect(decoded).toEqual({ type: 'user_message', text: 'hello' });
  });

  it('returns null for malformed JSON', () => {
    const bytes = new Uint8Array([0x7b, 0x7b, 0x7b]); // {{{
    expect(decodePacket(bytes)).toBeNull();
  });

  it('returns null for packets without a type field', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ foo: 'bar' }));
    expect(decodePacket(bytes)).toBeNull();
  });

  it('converts agent_message to ConversationMessage', () => {
    const msg = packetToMessage({
      type: 'agent_message',
      text: 'hi there',
    });
    expect(msg).toEqual({ source: 'agent', text: 'hi there', isFinal: true });
  });

  it('converts transcript packets and preserves isFinal=false', () => {
    const msg = packetToMessage({
      type: 'transcript',
      source: 'user',
      text: 'partial',
      isFinal: false,
    });
    expect(msg).toEqual({ source: 'user', text: 'partial', isFinal: false });
  });
});
