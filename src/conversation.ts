import type { CreateOptions } from './types.js';
import { VoiceConversation } from './voice-conversation.js';

export const Conversation = {
  startSession(options: CreateOptions): Promise<VoiceConversation> {
    return VoiceConversation.create(options);
  },
};
