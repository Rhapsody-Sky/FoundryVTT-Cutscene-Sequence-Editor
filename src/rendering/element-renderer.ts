import type { FrameItem } from '../playback/evaluate.js';
import type { PlayerFrame } from '../playback/local-player.js';
import type { VisualClip } from '../domain/sequence.js';
import type { VideoKeyingFilter } from './video-keying.js';
import type { PlaybackVolume } from '../application/playback-volume.js';
import type { TextMotionLayout } from './text-motion-renderer.js';

export interface BackdropRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A surface-space polygon; an optional rectangle restricts its filled aperture. */
export interface BackdropFootprint {
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** A borrowed, live board image. The renderer never changes its source. */
export interface BoardBackdropFrame {
  readonly source: CanvasImageSource;
  /** Source placement in viewport CSS pixels; previews may project it into their own rect. */
  readonly rect: BackdropRect;
  readonly backgroundColor?: string;
}

export interface RendererOptions {
  readonly signal: AbortSignal;
  readonly still?: boolean;
  /** Personal playback level, separate from authored clip and sequence fades. */
  readonly playbackVolume?: Pick<PlaybackVolume, 'value' | 'subscribe'>;
  readonly onError?: (error: unknown) => void;
  readonly onWarning?: (code: string) => void;
  /** Typed intent only; the playback/session layer owns all resulting state changes. */
  readonly onButtonActivate?: (intent: { readonly clipId: string; readonly breakId?: string }) => Promise<void>;
  /** Button action failures are recoverable and must not tear down the surface. */
  readonly onInteractionError?: (error: unknown) => void;
  /** Prepared visible text units; wrapped line counts are measured once per layout. */
  readonly onTextMotionLayout?: (layout: TextMotionLayout) => void;
  readonly requestAudioUnlock?: (unlock: () => Promise<void>, signal: AbortSignal) => Promise<void>;
  /** Composition-owned streaming context; elements release only their source/gain nodes. */
  readonly createAudioContext?: () => AudioContext;
  readonly boardBackdrop?: (surfaceRect: BackdropRect, signal: AbortSignal) => BoardBackdropFrame | null;
  /** Composition-owned bounded GPU pool; standalone elements may own one. */
  readonly createVideoKeyingFilter?: () => VideoKeyingFilter;
}

/** Elements receive the player's absolute position; they never own a timeline. */
export interface ElementRenderer {
  readonly node: HTMLElement;
  prepare(): Promise<void>;
  draw(item: FrameItem | undefined, frame: PlayerFrame): void;
  /** Updating visual settings never replaces a prepared media decoder. */
  updateAppearance?(clip: VisualClip): void;
  /** Intrinsic dimensions for clipping a borrowed board image to video content. */
  videoSource?(): HTMLVideoElement;
  /** Image pixels/effects that need the borrowed board beneath a non-normal blend. */
  backdropFootprints?(item: FrameItem, surface: Pick<BackdropRect, 'width' | 'height'>): readonly BackdropFootprint[];
  /** Repaint the current decoded image without changing its timeline or playback. */
  refreshVisual?(): void;
  /** Return inactive visual resources before another clip acquires them. */
  deactivateVisual?(): void;
  dispose(): void;
}
