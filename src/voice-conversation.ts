import { reconcileTranscript } from './transcript.js';
import type { ConversationMessage, CreateOptions } from './types.js';
import { WebRTCConnection } from './webrtc-connection.js';

// Shared mutable cell — the onMessage closure and the `transcript` getter
// both reference the same object so the getter always sees the latest list.
interface TranscriptCell {
  list: ConversationMessage[];
}

export class VoiceConversation {
  private readonly connection: WebRTCConnection;
  private conversationId = '';
  private readonly _cell: TranscriptCell;

  private constructor(connection: WebRTCConnection, cell: TranscriptCell) {
    this.connection = connection;
    this._cell = cell;
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

    const cell: TranscriptCell = { list: [] };
    const consumerOnMessage = options.onMessage;
    const consumerOnTranscript = options.onTranscript;

    const wrappedOnMessage = (msg: ConversationMessage): void => {
      // (a) Back-compat: forward to the consumer's onMessage unchanged.
      consumerOnMessage?.(msg);
      // (b) Reconcile into the canonical list.
      cell.list = reconcileTranscript(cell.list, msg);
      // (c) Fire onTranscript with the full reconciled list.
      consumerOnTranscript?.(cell.list);
    };

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
      ...(options.micEnabled !== undefined && { micEnabled: options.micEnabled }),
      callbacks: {
        ...(options.onConnect && { onConnect: options.onConnect }),
        ...(options.onDisconnect && { onDisconnect: options.onDisconnect }),
        // Always register our wrapped handler; it calls through to the consumer's onMessage.
        onMessage: wrappedOnMessage,
        ...(options.onStatusChange && { onStatusChange: options.onStatusChange }),
        ...(options.onModeChange && { onModeChange: options.onModeChange }),
        ...(options.onError && { onError: options.onError }),
        ...(options.onAudioPlaybackBlocked && {
          onAudioPlaybackBlocked: options.onAudioPlaybackBlocked,
        }),
      },
    });

    const conv = new VoiceConversation(connection, cell);
    conv.conversationId = await connection.connect();
    return conv;
  }

  /** The current reconciled transcript (deduped, ordered by startedAt). */
  get transcript(): readonly ConversationMessage[] {
    return this._cell.list;
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

  /** True when the browser is currently allowing the agent's audio to play. */
  get canPlaybackAudio(): boolean {
    return this.connection.canPlaybackAudio;
  }

  /**
   * Resume agent audio after an autoplay block. Call from a user-gesture handler
   * (e.g. a "tap to unmute" button shown when `onAudioPlaybackBlocked` fires).
   */
  async startAudioPlayback(): Promise<void> {
    await this.connection.startAudioPlayback();
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
