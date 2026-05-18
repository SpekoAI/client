import { requestSession } from './start-session.js';
import type { AgentConversationOptions, ConversationOptions, CreateOptions } from './types.js';
import { WebRTCConnection } from './webrtc-connection.js';

export class VoiceConversation {
  private readonly connection: WebRTCConnection;
  private conversationId = '';

  private constructor(connection: WebRTCConnection) {
    this.connection = connection;
  }

  /**
   * Start a voice conversation. Two forms are supported:
   *
   * 1. **Token form** — `{ conversationToken, livekitUrl, ... }`. Use when
   *    your backend mints sessions via `POST /v1/sessions` and forwards the
   *    response to the browser. This is the primary, lower-level API.
   * 2. **Agent form** — `{ agentId, apiKey, ... }`. Convenience wrapper that
   *    mints a session for a persistent agent from the browser. Requires a
   *    Speko API key in the calling environment, so it's best for
   *    server-rendered apps with short-lived keys, embedded widgets, or
   *    local development.
   *
   * Both forms accept the same set of overrides, callbacks, and audio
   * constraints — only the credential surface differs.
   */
  static async create(options: CreateOptions): Promise<VoiceConversation> {
    if (isAgentOptions(options)) {
      const { conversationToken, livekitUrl } = await requestSession({
        agentId: options.agentId,
        apiKey: options.apiKey,
        ...(options.apiBaseUrl !== undefined && {
          apiBaseUrl: options.apiBaseUrl,
        }),
      });
      const tokenOptions: ConversationOptions = {
        conversationToken,
        livekitUrl,
        ...(options.overrides && { overrides: options.overrides }),
        ...(options.inputDeviceId !== undefined && {
          inputDeviceId: options.inputDeviceId,
        }),
        ...(options.outputDeviceId !== undefined && {
          outputDeviceId: options.outputDeviceId,
        }),
        ...(options.audioConstraints && {
          audioConstraints: options.audioConstraints,
        }),
        ...(options.onConnect && { onConnect: options.onConnect }),
        ...(options.onDisconnect && { onDisconnect: options.onDisconnect }),
        ...(options.onMessage && { onMessage: options.onMessage }),
        ...(options.onStatusChange && { onStatusChange: options.onStatusChange }),
        ...(options.onModeChange && { onModeChange: options.onModeChange }),
        ...(options.onError && { onError: options.onError }),
      };
      return VoiceConversation.create(tokenOptions);
    }

    const connection = new WebRTCConnection({
      conversationToken: options.conversationToken,
      livekitUrl: options.livekitUrl,
      ...(options.overrides && { overrides: options.overrides }),
      ...(options.inputDeviceId !== undefined && {
        inputDeviceId: options.inputDeviceId,
      }),
      ...(options.outputDeviceId !== undefined && {
        outputDeviceId: options.outputDeviceId,
      }),
      ...(options.audioConstraints && {
        audioConstraints: options.audioConstraints,
      }),
      callbacks: {
        ...(options.onConnect && { onConnect: options.onConnect }),
        ...(options.onDisconnect && { onDisconnect: options.onDisconnect }),
        ...(options.onMessage && { onMessage: options.onMessage }),
        ...(options.onStatusChange && { onStatusChange: options.onStatusChange }),
        ...(options.onModeChange && { onModeChange: options.onModeChange }),
        ...(options.onError && { onError: options.onError }),
      },
    });
    const conv = new VoiceConversation(connection);
    conv.conversationId = await connection.connect();
    return conv;
  }

  getId(): string {
    return this.conversationId;
  }

  isOpen(): boolean {
    return this.connection.getStatus() === 'connected';
  }

  async endSession(): Promise<void> {
    await this.connection.disconnect();
  }

  async setMicMuted(muted: boolean): Promise<void> {
    await this.connection.setMicMuted(muted);
  }

  setVolume(volume: number): void {
    this.connection.setVolume(volume);
  }

  sendUserMessage(text: string): void {
    this.connection.publish({ type: 'user_message', text });
  }

  sendContextualUpdate(text: string): void {
    this.connection.publish({ type: 'contextual_update', text });
  }
}

function isAgentOptions(options: CreateOptions): options is AgentConversationOptions {
  return 'agentId' in options;
}
