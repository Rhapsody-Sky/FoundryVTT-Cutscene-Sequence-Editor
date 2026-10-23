/** Playback extension contracts; the implemented session protocol lives in session-protocol.ts. */
export interface PlaybackClock {
  serverNowMs(): number;
  monotonicNowMs(): number;
}

export interface ElementRenderer<TClip> {
  prepare(clip: TClip, signal: AbortSignal): Promise<void>;
  mount(container: HTMLElement): void;
  /** Absolute time evaluation; implementations must not own a second timeline. */
  applyTime(localTimeMs: number): void;
  dispose(): void;
}

