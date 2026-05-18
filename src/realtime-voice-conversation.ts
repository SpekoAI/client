import type {
  ConversationMessage,
  ConversationMode,
  ConversationStatus,
  RealtimeConversationOptions,
} from './types.js';

type ReadyFrame = { inputSampleRate: 16000 | 24000; outputSampleRate: 16000 | 24000 };

const DEFAULT_SAMPLE_RATE = 24_000;
const READY_TIMEOUT_MS = 10_000;
const CAPTURE_FRAME_MS = 20;
const FALLBACK_BUFFER_SIZE = 1024;
const JITTER_BUFFER_SECONDS = 0.02;

export class RealtimeVoiceConversation {
  private readonly options: RealtimeConversationOptions;
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private outputGain: GainNode | null = null;
  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private captureResampler: Pcm16Resampler | null = null;
  private inputSampleRate: 16000 | 24000;
  private outputSampleRate: 16000 | 24000;
  private status: ConversationStatus = 'disconnected';
  private nextStartAt = 0;
  private mode: ConversationMode = 'listening';
  private micMuted = false;
  private volume = 1;

  private constructor(options: RealtimeConversationOptions) {
    this.options = options;
    this.inputSampleRate = options.inputSampleRate ?? DEFAULT_SAMPLE_RATE;
    this.outputSampleRate = options.outputSampleRate ?? DEFAULT_SAMPLE_RATE;
  }

  static async create(options: RealtimeConversationOptions): Promise<RealtimeVoiceConversation> {
    const conv = new RealtimeVoiceConversation(options);
    await conv.connect();
    return conv;
  }

  getId(): string {
    return this.options.sessionId;
  }

  isOpen(): boolean {
    return this.status === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  async endSession(): Promise<void> {
    this.setStatus('disconnecting');
    this.ws?.close(1000, 'client_stopped');
    this.cleanup();
    this.setStatus('disconnected');
    this.options.onDisconnect?.({ reason: 'user' });
  }

  async setMicMuted(muted: boolean): Promise<void> {
    this.micMuted = muted;
    this.mediaStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.outputGain) this.outputGain.gain.value = this.volume;
  }

  private async connect(): Promise<void> {
    this.setStatus('connecting');
    const ready = new Promise<ReadyFrame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Realtime session did not become ready')),
        READY_TIMEOUT_MS,
      );
      const settle = (frame: ReadyFrame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.openWebSocket(settle, (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const readyFrame = await ready;
    this.inputSampleRate = readyFrame.inputSampleRate;
    this.outputSampleRate = readyFrame.outputSampleRate;
    try {
      await this.setupAudio();
    } catch (err) {
      this.ws?.close(1000, 'audio_setup_failed');
      this.cleanup();
      this.setStatus('disconnected');
      throw err;
    }
    this.setStatus('connected');
    this.options.onConnect?.({ conversationId: this.options.sessionId });
    this.setMode('listening');
  }

  private openWebSocket(
    onReady: (frame: ReadyFrame) => void,
    onReadyError: (err: Error) => void,
  ): void {
    const ws = new WebSocket(this.options.wsUrl, [this.options.wsToken]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let startupError: Error | null = null;

    ws.addEventListener('message', (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        this.playPcm(evt.data);
        return;
      }
      if (typeof evt.data !== 'string') return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (parsed['t'] === 'ready') {
        onReady({
          inputSampleRate: parseSampleRate(parsed['inputSampleRate'], this.inputSampleRate),
          outputSampleRate: parseSampleRate(parsed['outputSampleRate'], this.outputSampleRate),
        });
        return;
      }
      const handledError = this.handleJson(parsed);
      if (this.status === 'connecting' && handledError) {
        startupError = handledError;
      }
    });

    ws.addEventListener('close', (evt) => {
      if (this.status === 'connecting') {
        onReadyError(
          startupError ?? new Error(`WebSocket closed before ready: ${evt.code} ${evt.reason}`),
        );
      }
      this.cleanup();
      this.setStatus('disconnected');
      this.options.onDisconnect?.({
        reason: evt.code === 1000 || evt.code === 1005 ? 'agent' : 'error',
        ...(evt.reason ? { message: evt.reason } : {}),
      });
    });

    ws.addEventListener('error', () => {
      const err = new Error('WebSocket transport error');
      this.options.onError?.(err);
      if (this.status === 'connecting') onReadyError(err);
    });
  }

  private handleJson(parsed: Record<string, unknown>): Error | null {
    const t = parsed['t'];
    if (t === 'transcript') {
      this.options.onMessage?.({
        source: parsed['role'] === 'user' ? 'user' : 'agent',
        text: String(parsed['text'] ?? ''),
        isFinal: Boolean(parsed['final']),
      } satisfies ConversationMessage);
    } else if (t === 'interruption') {
      this.clearPlayback();
      this.setMode('listening');
    } else if (t === 'error') {
      const err = new Error(
        `${String(parsed['code'] ?? 'ERROR')}: ${String(parsed['message'] ?? '')}`,
      );
      this.options.onError?.(err);
      return err;
    }
    return null;
  }

  private async setupAudio(): Promise<void> {
    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) throw new Error('AudioContext is not available in this browser');

    const ctx = new AudioCtor();
    this.ctx = ctx;
    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = this.volume;
    this.outputGain.connect(ctx.destination);
    this.nextStartAt = ctx.currentTime;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: this.inputSampleRate,
        echoCancellation: this.options.audioConstraints?.echoCancellation ?? true,
        noiseSuppression: this.options.audioConstraints?.noiseSuppression ?? true,
        autoGainControl: this.options.audioConstraints?.autoGainControl,
        ...(this.options.inputDeviceId ? { deviceId: { exact: this.options.inputDeviceId } } : {}),
      },
    });
    this.mediaStream = stream;
    if (this.micMuted) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    }
    this.source = ctx.createMediaStreamSource(stream);

    if (await this.trySetupWorklet(ctx)) return;
    this.setupScriptProcessor(ctx);
  }

  private async trySetupWorklet(ctx: AudioContext): Promise<boolean> {
    if (!ctx.audioWorklet) return false;
    const url = URL.createObjectURL(new Blob([workletSource()], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
      const worklet = new AudioWorkletNode(ctx, 'speko-realtime-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          targetSampleRate: this.inputSampleRate,
          frameSize: Math.round((this.inputSampleRate * CAPTURE_FRAME_MS) / 1000),
        },
      });
      worklet.port.onmessage = (evt: MessageEvent<ArrayBuffer>) => {
        if (evt.data instanceof ArrayBuffer) this.sendAudio(new Uint8Array(evt.data));
      };
      const silent = ctx.createGain();
      silent.gain.value = 0;
      this.worklet = worklet;
      this.silentGain = silent;
      this.source?.connect(worklet);
      worklet.connect(silent);
      silent.connect(ctx.destination);
      return true;
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private setupScriptProcessor(ctx: AudioContext): void {
    const processor = ctx.createScriptProcessor(FALLBACK_BUFFER_SIZE, 1, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    this.captureResampler = new Pcm16Resampler(ctx.sampleRate, this.inputSampleRate);
    processor.onaudioprocess = (evt) => {
      const input = evt.inputBuffer.getChannelData(0);
      for (const frame of this.captureResampler?.push(input) ?? []) {
        this.sendAudio(frame);
      }
    };
    this.processor = processor;
    this.silentGain = silent;
    this.source?.connect(processor);
    processor.connect(silent);
    silent.connect(ctx.destination);
  }

  private sendAudio(pcm: Uint8Array): void {
    if (this.micMuted || this.ws?.readyState !== WebSocket.OPEN) return;
    const copy = new Uint8Array(pcm.byteLength);
    copy.set(pcm);
    this.ws.send(copy.buffer);
  }

  private playPcm(pcm: ArrayBuffer): void {
    const ctx = this.ctx;
    const gain = this.outputGain;
    if (!ctx || !gain) return;
    const i16 = new Int16Array(pcm);
    if (i16.length === 0) return;
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = (i16[i] ?? 0) / 32768;
    const buf = ctx.createBuffer(1, f32.length, this.outputSampleRate);
    buf.getChannelData(0).set(f32);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    const startAt = Math.max(this.nextStartAt, ctx.currentTime + JITTER_BUFFER_SECONDS);
    this.nextStartAt = startAt + buf.duration;
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
      if (this.activeSources.size === 0) this.setMode('listening');
    };
    this.setMode('speaking');
    src.start(startAt);
  }

  private clearPlayback(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
    if (this.ctx) this.nextStartAt = this.ctx.currentTime;
  }

  private cleanup(): void {
    this.clearPlayback();
    this.worklet?.disconnect();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.outputGain?.disconnect();
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.ctx?.close().catch(() => undefined);
    this.worklet = null;
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.outputGain = null;
    this.mediaStream = null;
    this.ctx = null;
    this.captureResampler = null;
  }

  private setStatus(status: ConversationStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private setMode(mode: ConversationMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.options.onModeChange?.(mode);
  }
}

class Pcm16Resampler {
  private readonly frameSize: number;
  private readonly pending: number[] = [];

  constructor(
    private readonly sourceRate: number,
    private readonly targetRate: number,
  ) {
    this.frameSize = Math.round((targetRate * CAPTURE_FRAME_MS) / 1000);
  }

  push(input: Float32Array): Uint8Array[] {
    const ratio = this.sourceRate / this.targetRate;
    const outLength = Math.max(1, Math.floor(input.length / ratio));
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, input.length - 1);
      const frac = pos - lo;
      const sample = (input[lo] ?? 0) * (1 - frac) + (input[hi] ?? 0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.pending.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }

    const frames: Uint8Array[] = [];
    while (this.pending.length >= this.frameSize) {
      const pcm = new Int16Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i++) pcm[i] = this.pending.shift() ?? 0;
      frames.push(new Uint8Array(pcm.buffer));
    }
    return frames;
  }
}

function parseSampleRate(value: unknown, fallback: 16000 | 24000): 16000 | 24000 {
  return value === 16000 || value === 24000 ? value : fallback;
}

function workletSource(): string {
  return `
class SpekoRealtimeCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetSampleRate;
    this.frameSize = options.processorOptions.frameSize;
    this.pending = [];
  }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (input) {
      if (output) output.fill(0);
      const ratio = sampleRate / this.targetRate;
      const outLength = Math.max(1, Math.floor(input.length / ratio));
      for (let i = 0; i < outLength; i++) {
        const pos = i * ratio;
        const lo = Math.floor(pos);
        const hi = Math.min(lo + 1, input.length - 1);
        const frac = pos - lo;
        const sample = (input[lo] || 0) * (1 - frac) + (input[hi] || 0) * frac;
        const clamped = Math.max(-1, Math.min(1, sample));
        this.pending.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      }
      while (this.pending.length >= this.frameSize) {
        const pcm = new Int16Array(this.frameSize);
        for (let i = 0; i < this.frameSize; i++) pcm[i] = this.pending.shift() || 0;
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('speko-realtime-capture', SpekoRealtimeCapture);
`;
}
