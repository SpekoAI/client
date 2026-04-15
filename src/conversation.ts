import { VoiceConversation } from './voice-conversation.js';
import type { ConversationOptions } from './types.js';

export const Conversation = {
  startSession(options: ConversationOptions): Promise<VoiceConversation> {
    return VoiceConversation.create(options);
  },
};
