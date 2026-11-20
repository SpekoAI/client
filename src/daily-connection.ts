import { type BotOutputData, PipecatClient, type TranscriptData } from '@pipecat-ai/client-js';
import { DailyTransport } from '@pipecat-ai/daily-transport';
import type { ConversationConnection } from './connection.js';
import type { OutboundPacket } from './data-channel.js';
import { SpekoClientError } from './errors.js';
import type { AudioConstraints, ConversationCallbacks, ConversationStatus } from './types.js';

export interface DailyConnectionInit {
  readonly token: string;
  readonly url: string;
  readonly inputDeviceId?: string;
  readonly outputDeviceId?: string;
  readonly audioConstraints?: AudioConstraints;
  readonly micEnabled?: boolean;
  /** Internal override for deterministic tests; production waits 30 seconds. */
  readonly connectTimeoutMs?: number;
  readonly callbacks: ConversationCallbacks;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

class DailyConnectTimeoutError extends Error {}

export class DailyConnection implements ConversationConnection {
  private readonly transport: DailyTransport;
  private readonly client: PipecatClient;
  private readonly audioElements = new Map<string, HTMLAudioElement>();
  private readonly userSegments = new Map<string, { id: string; startedAt?: number }>();
  private nextUserSegment = 0;
  private status: ConversationStatus = 'connecting';
  private disconnected = false;
  private volume = 1;

  constructor(private readonly init: DailyConnectionInit) {
    this.transport = new DailyTransport({
      bufferLocalAudioUntilBotReady: true,
      ...(init.audioConstraints
        ? {
            inputSettings: {
              audio: {
                settings: {
                  echoCancellation: init.audioConstraints.echoCancellation ?? true,
                  noiseSuppression: init.audioConstraints.noiseSuppression ?? true,
                  autoGainControl: init.audioConstraints.autoGainControl ?? true,
                },
              },
            },
          }
        : {}),
    });
    this.client = new PipecatClient({
      transport: this.transport,
      enableCam: false,
      enableMic: init.micEnabled !== false,
      callbacks: {
        onDisconnected: () => this.handleDisconnected('unknown'),
        onBotDisconnected: () => this.handleDisconnected('agent'),
        onBotStartedSpeaking: () => init.callbacks.onModeChange?.('speaking'),
        onBotStoppedSpeaking: () => init.callbacks.onModeChange?.('listening'),
        onUserTranscript: (data) => this.userTranscript(data),
        onBotOutput: (data) => this.botOutput(data),
        onTrackStarted: (track, participant) => {
          if (track.kind === 'audio' && !participant?.local) this.attachAudio(track);
        },
        onTrackStopped: (track) => this.detachAudio(track.id),
        onDeviceError: (error) =>
          init.callbacks.onError?.(
            new SpekoClientError('Microphone device error', 'MICROPHONE_FAILED', error),
          ),
        onError: (message) => {
          const data = message.data as { error?: unknown } | undefined;
          init.callbacks.onError?.(
            new Error(typeof data?.error === 'string' ? data.error : 'Pipecat bot error'),
          );
        },
        onTransportStateChanged: (state) => {
          if (state === 'disconnecting') this.setStatus('disconnecting');
          if (state === 'error') this.setStatus('disconnected');
        },
      },
    });
  }

  async connect(): Promise<string> {
    try {
      await this.client.initDevices();
      if (this.init.inputDeviceId) this.client.updateMic(this.init.inputDeviceId);
      if (this.init.outputDeviceId) this.client.updateSpeaker(this.init.outputDeviceId);
      await this.connectWithTimeout();
    } catch (error) {
      this.setStatus('disconnected');
      if (error instanceof DailyConnectTimeoutError) {
        await this.client.disconnect().catch(() => undefined);
        this.detachAllAudio();
        throw new SpekoClientError(
          'Timed out waiting for the Daily agent to become ready',
          'CONNECTION_TIMEOUT',
          error,
        );
      }
      throw new SpekoClientError(
        'Failed to connect to Daily transport',
        'CONNECTION_FAILED',
        error,
      );
    }
    this.setStatus('connected');
    const conversationId = this.transport.getSessionInfo().id ?? '';
    this.init.callbacks.onConnect?.({ conversationId });
    return conversationId;
  }

  private async connectWithTimeout(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new DailyConnectTimeoutError()),
        this.init.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        this.client.connect({ url: this.init.url, token: this.init.token }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async disconnect(): Promise<void> {
    if (this.status === 'disconnected' || this.status === 'disconnecting') return;
    this.setStatus('disconnecting');
    await this.client.disconnect();
    this.detachAllAudio();
    this.handleDisconnected('user');
  }

  getStatus(): ConversationStatus {
    return this.status;
  }

  async setMicMuted(muted: boolean): Promise<void> {
    this.client.enableMic(!muted);
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    for (const element of this.audioElements.values()) element.volume = this.volume;
  }

  get canPlaybackAudio(): boolean {
    return this.status === 'connected';
  }

  async startAudioPlayback(): Promise<void> {
    for (const element of this.audioElements.values()) {
      await element.play().catch(() => this.init.callbacks.onAudioPlaybackBlocked?.());
    }
  }

  publish(packet: OutboundPacket): void {
    if (this.status !== 'connected') {
      throw new SpekoClientError(
        'Cannot send data before connection is established',
        'NOT_CONNECTED',
      );
    }
    const { type, ...data } = packet;
    this.client.sendClientMessage(type, data);
  }

  async sendChatText(text: string): Promise<void> {
    if (this.status !== 'connected') {
      throw new SpekoClientError(
        'Cannot send text before connection is established',
        'NOT_CONNECTED',
      );
    }
    await this.client.sendText(text);
  }

  private userTranscript(data: TranscriptData): void {
    if (!data.text) {
      if (data.final) this.userSegments.delete(data.user_id);
      return;
    }
    // RTVI timestamps identify individual updates, not STT segments. Keep a
    // stable identity while the recognizer revises one cumulative partial.
    let segment = this.userSegments.get(data.user_id);
    if (!segment) {
      const startedAt = Date.parse(data.timestamp);
      segment = {
        id: `user:${data.user_id}:${this.nextUserSegment++}`,
        ...(Number.isFinite(startedAt) ? { startedAt } : {}),
      };
      this.userSegments.set(data.user_id, segment);
    }
    if (data.final) this.userSegments.delete(data.user_id);
    this.init.callbacks.onMessage?.({
      source: 'user',
      text: data.text,
      isFinal: data.final,
      segmentId: segment.id,
      ...(segment.startedAt !== undefined ? { startedAt: segment.startedAt } : {}),
    });
  }

  private botOutput(data: BotOutputData): void {
    if (!data.text || data.will_be_spoken === false || data.aggregated_by === 'word') return;
    this.init.callbacks.onMessage?.({
      source: 'agent',
      text: data.text,
      isFinal: data.spoken_status === 'completed',
      ...(data.segment_id !== undefined ? { segmentId: `bot:${data.segment_id}` } : {}),
    });
  }

  private handleDisconnected(reason: 'user' | 'agent' | 'unknown'): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.userSegments.clear();
    this.detachAllAudio();
    this.setStatus('disconnected');
    this.init.callbacks.onDisconnect?.({ reason });
  }

  private attachAudio(track: MediaStreamTrack): void {
    this.detachAudio(track.id);
    const element = document.createElement('audio');
    element.autoplay = true;
    element.setAttribute('playsinline', '');
    element.dataset.dailyTrack = track.id;
    element.volume = this.volume;
    element.srcObject = new MediaStream([track]);
    element.hidden = true;
    document.body.append(element);
    this.audioElements.set(track.id, element);
    void element.play().catch(() => this.init.callbacks.onAudioPlaybackBlocked?.());
  }

  private detachAudio(trackId: string): void {
    const element = this.audioElements.get(trackId);
    if (!element) return;
    element.pause();
    element.srcObject = null;
    element.remove();
    this.audioElements.delete(trackId);
  }

  private detachAllAudio(): void {
    for (const trackId of [...this.audioElements.keys()]) this.detachAudio(trackId);
  }

  private setStatus(status: ConversationStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.init.callbacks.onStatusChange?.(status);
  }
}
