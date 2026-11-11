import type { RemoteAudioTrack } from 'livekit-client';

export interface RemoteAudioPlaybackOptions {
  readonly outputDeviceId?: string;
  /**
   * What happens to a track when `outputDeviceId` is set.
   *
   * `preferred` (default): the track plays at once and moves to the device
   * when the browser has routed it. It stays on the default device if routing
   * fails.
   *
   * `required`: the track makes no sound until the browser has routed it to
   * the device. It stays silent if routing fails.
   */
  readonly outputDeviceRouting?: 'preferred' | 'required';
  /** The browser refused `play()` on an attached element (autoplay policy). */
  readonly onPlaybackRejected: () => void;
  readonly onOutputDeviceError: (error: unknown) => void;
}

type SinkElement = HTMLAudioElement & { setSinkId: (id: string) => Promise<void> };

/**
 * Owns the hidden `<audio>` elements that play a room's remote audio tracks:
 * one element per attached track, all at one volume, all removed together.
 */
export class RemoteAudioPlayback {
  private readonly elements = new Set<HTMLAudioElement>();
  private readonly routing = new Set<RemoteAudioTrack>();
  private volume = 1;

  constructor(private readonly options: RemoteAudioPlaybackOptions) {}

  attach(track: RemoteAudioTrack): void {
    const { outputDeviceId, outputDeviceRouting } = this.options;
    if (outputDeviceId && outputDeviceRouting === 'required') {
      this.attachOnceRouted(track, outputDeviceId);
      return;
    }
    const el = track.attach();
    if (outputDeviceId && canRoute(el)) {
      void el.setSinkId(outputDeviceId).catch(this.options.onOutputDeviceError);
    }
    this.mount(el);
    this.start(el);
  }

  detach(track: RemoteAudioTrack): void {
    this.routing.delete(track);
    for (const el of track.detach()) {
      this.elements.delete(el);
      el.remove();
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    for (const el of this.elements) {
      el.volume = this.volume;
    }
  }

  /** Retry playback on every element. Call from a user-gesture handler. */
  resume(): void {
    for (const el of this.elements) {
      void el.play().catch(() => undefined);
    }
  }

  clear(): void {
    this.routing.clear();
    for (const el of this.elements) el.remove();
    this.elements.clear();
  }

  // `track.attach()` starts playback itself and unmutes the element, so the
  // only way to keep a track silent is to route an empty element first.
  private attachOnceRouted(track: RemoteAudioTrack, outputDeviceId: string): void {
    const el = typeof document === 'undefined' ? undefined : document.createElement('audio');
    if (!el || !canRoute(el)) {
      this.options.onOutputDeviceError(
        new Error('This browser cannot choose an audio output device'),
      );
      return;
    }
    this.routing.add(track);
    el.setSinkId(outputDeviceId).then(
      () => {
        if (!this.routing.delete(track)) return;
        this.mount(el);
        track.attach(el);
        this.start(el);
      },
      (error: unknown) => {
        if (this.routing.delete(track)) this.options.onOutputDeviceError(error);
      },
    );
  }

  private mount(el: HTMLAudioElement): void {
    el.autoplay = true;
    el.volume = this.volume;
    el.style.display = 'none';
    if (typeof document !== 'undefined') {
      document.body.appendChild(el);
    }
    this.elements.add(el);
  }

  private start(el: HTMLAudioElement): void {
    // The `autoplay` attribute alone fails SILENTLY when the browser blocks it
    // (no audio, no error), so play explicitly and report the rejection.
    void el.play().catch(() => this.options.onPlaybackRejected());
  }
}

function canRoute(el: HTMLAudioElement): el is SinkElement {
  return 'setSinkId' in el;
}
