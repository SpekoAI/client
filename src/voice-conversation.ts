import type { CreateOptions } from './types.js';
import { WebRTCConnection } from './webrtc-connection.js';

export class VoiceConversation {
  private readonly connection: WebRTCConnection;
  private conversationId = '';

  private constructor(connection: WebRTCConnection) {
    this.connection = connection;
  }

  /**
   * Start a voice conversation from short-lived session credentials minted by
   * your backend via `POST /v1/sessions`.
   */
  static async create(options: CreateOptions): Promise<VoiceConversation> {
    const credentials = options as CreateOptions & {
      readonly conversationToken?: string;
      readonly livekitUrl?: string;
      readonly transportToken?: string;
      readonly transportUrl?: string;
    };
    const conversationToken = credentials.transportToken ?? credentials.conversationToken;
    const livekitUrl = credentials.transportUrl ?? credentials.livekitUrl;
    if (!conversationToken || !livekitUrl) {
      throw new TypeError(
        'VoiceConversation.create requires transportToken + transportUrl, or legacy conversationToken + livekitUrl.',
      );
    }

    const connection = new WebRTCConnection({
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

  /**
   * Send a typed message to the agent over LiveKit's native text channel, so it
   * responds with voice + transcription just like a spoken turn. Preferred over
   * `sendUserMessage` when driving a LiveKit Agents worker.
   */
  async sendChatMessage(text: string): Promise<void> {
    await this.connection.sendChatText(text);
  }

  sendContextualUpdate(text: string): void {
    this.connection.publish({ type: 'contextual_update', text });
  }
}
