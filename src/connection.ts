import type { OutboundPacket } from './data-channel.js';
import type { ConversationStatus } from './types.js';

export interface ConversationConnection {
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  getStatus(): ConversationStatus;
  setMicMuted(muted: boolean): Promise<void>;
  setVolume(volume: number): void;
  readonly canPlaybackAudio: boolean;
  startAudioPlayback(): Promise<void>;
  publish(packet: OutboundPacket): void;
  sendChatText(text: string): Promise<void>;
}
