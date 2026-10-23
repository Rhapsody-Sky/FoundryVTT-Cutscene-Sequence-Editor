/** Persisted data only. Runtime validation and migrations follow in package 1. */
import type { AnimatedPattern } from './animated-pattern.js';
import type { TextMotionDirection, TextMotionId, TextMotionOrder } from './text-motion.js';

export const SEQUENCE_SCHEMA_VERSION = 5 as const;
/** Playback semantics are versioned independently from launch authoring. */
export const BREAKS_PLAYBACK_SCHEMA_VERSION = 3 as const;
export type PlaybackSchemaVersion = 1 | 2 | 3;

export interface SequenceAudience {
  readonly mode: 'all' | 'selected';
  readonly userIds: readonly string[];
  readonly includeGM: boolean;
}

export type SequenceTriggerKind = 'combat-start' | 'combat-end' | 'turn-start' | 'turn-end';

export interface SequenceAutomationRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly event: SequenceTriggerKind;
  /** Combat lifecycle rules are global and therefore always store null. */
  readonly actorId: string | null;
}

export interface SequenceAutomation {
  readonly version: 1;
  readonly enabled: boolean;
  readonly rules: readonly SequenceAutomationRule[];
}

export interface SequenceLaunchSettingsV1 {
  readonly version: 1;
  readonly audience: SequenceAudience;
}

export interface SequenceLaunchSettingsV2 {
  readonly version: 2;
  readonly audience: SequenceAudience;
  readonly automation: SequenceAutomation;
}

export type SequenceLaunchSettings = SequenceLaunchSettingsV1 | SequenceLaunchSettingsV2;

/** Foundry-independent, confirmed combat/turn transition passed to rule matching. */
export interface TriggerEvent {
  readonly id: string;
  readonly kind: SequenceTriggerKind;
  readonly combatId: string;
  readonly round: number;
  readonly turn: number | null;
  readonly combatantId: string | null;
  readonly actorId: string | null;
}
export type BreakBehavior = 'pause' | 'loop' | 'finish';

export interface VisualTrack {
  readonly id: string;
  readonly name: string;
  readonly kind: 'visual';
  /** Back to front. Array order is not a substitute for this value. */
  readonly order: number;
  readonly enabled: boolean;
  readonly locked: boolean;
}

export interface AudioTrack extends Omit<VisualTrack, 'kind'> {
  readonly kind: 'audio';
}

export type SequenceTrack = VisualTrack | AudioTrack;

export type ClipDuration =
  | { readonly kind: 'fixed'; readonly milliseconds: number }
  | { readonly kind: 'sequence-end' }
  | { readonly kind: 'media' };

export const TRANSITION_EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-in', 'back-out', 'back-in-out'] as const;
export type TransitionEasing = typeof TRANSITION_EASINGS[number];
export type SlideDirection = 'left' | 'right' | 'up' | 'down';

export type Transition =
  | { readonly preset: 'none'; readonly version: 1 }
  | {
      readonly preset: 'fade' | 'slide' | 'fade-slide' | 'zoom' | 'fade-zoom' | 'text-motion';
      readonly version: 1;
      readonly durationMs: number;
      readonly easing: TransitionEasing;
      readonly direction?: SlideDirection;
      /** Logical composition units. Slide defaults to 100 when absent. */
      readonly distance?: number;
      /** Zoom endpoint scale; defaults to 0.8 when absent. */
      readonly scale?: number;
      /** Text-only segmented motion; the opposite edge plays its entire motion backwards. */
      readonly motion?: TextMotionId;
      /** Hidden endpoint edge; preset geometry is retained when absent/default. */
      readonly motionDirection?: TextMotionDirection;
      /** Temporal segment ordering, independent of each segment's geometry. */
      readonly motionOrder?: TextMotionOrder;
      /** Relative to the title's font size, independent from viewport resolution. */
      readonly amount?: number;
      /** Fraction of the total transition interval reserved for staggering. */
      readonly stagger?: number;
    };

export const CLIP_BLEND_MODES = ['normal', 'multiply', 'screen', 'plus-lighter', 'overlay', 'difference'] as const;
export type ClipBlendMode = typeof CLIP_BLEND_MODES[number];
export interface ClipAppearance {
  readonly blendMode: ClipBlendMode;
  readonly opacity: number;
}

export interface TextOutline {
  readonly enabled: boolean;
  readonly color: string;
  readonly opacity: number;
  /** Logical composition units. */
  readonly width: number;
}
export interface TextShadow {
  readonly enabled: boolean;
  readonly color: string;
  readonly opacity: number;
  /** Logical composition units. */
  readonly offsetX: number;
  readonly offsetY: number;
  readonly blur: number;
}
export interface TextGlow {
  readonly enabled: boolean;
  readonly color: string;
  readonly opacity: number;
  /** Logical composition units. */
  readonly radius: number;
}

interface ClipBase {
  readonly id: string;
  readonly trackId: string;
  readonly typeVersion: 1;
  readonly startMs: number;
  readonly entrance: Transition;
  /** Natural clip end only. Global exit freezes composition time and fades the whole surface. */
  readonly exit: Transition;
  /** Absent appearance renders as normal blending and full opacity. */
  readonly appearance?: ClipAppearance;
}

export interface BarsClip extends ClipBase {
  readonly type: 'bars';
  readonly duration: Exclude<ClipDuration, { readonly kind: 'media' }>;
  readonly properties: {
    /** Fraction of the actual surface height for EACH bar; must be in [0, 0.5]. */
    readonly heightFraction: number;
    readonly color: string;
  };
}

export interface VideoKeying {
  readonly enabled: boolean;
  /** Key color as exactly six hexadecimal digits following #. */
  readonly color: string;
  readonly tolerance: number;
  readonly softness: number;
}

export interface VideoClip extends Omit<ClipBase, 'typeVersion'> {
  readonly type: 'video';
  /** Versions 2–4 add trim, looping and keying; 5 adds Break behavior; 6 adds a logical box; 7 adds slide/zoom transitions. */
  readonly typeVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly duration: { readonly kind: 'media' };
  readonly properties: {
    readonly source: { readonly kind: 'foundry-file'; readonly path: string };
    readonly fit: 'contain' | 'cover';
    /** Absent retains the historical full actual surface; present requires version 6 or later. */
    readonly box?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly volume: number;
    readonly muted: boolean;
    /** Legacy terminal hold loop; schema 2 normal decoder loop. Break looping uses onBreak separately. */
    readonly loop?: boolean;
    readonly onBreak?: BreakBehavior;
    /** Active keying requires version 4 or later; disabled settings may remain on legacy clips. */
    readonly keying?: VideoKeying;
    /** FULL source duration inspected by the GM; participants verify it before readiness. */
    readonly durationMs?: number;
    /** Source interval in milliseconds. Requires typeVersion 2 or later and inspected durationMs. */
    readonly sourceRange?: { readonly inMs: number; readonly outMs: number };
  };
}

/** Standalone sound; its fades affect gain independently of visual opacity. */
interface AudioClipBase extends Omit<ClipBase, 'typeVersion'> {
  readonly type: 'audio';
  readonly properties: {
    readonly source: { readonly kind: 'foundry-file'; readonly path: string };
    readonly volume: number;
    readonly muted: boolean;
    readonly durationMs?: number;
    readonly sourceRange?: { readonly inMs: number; readonly outMs: number };
    /** Version 1: terminal manual hold. Versions 2/3: repeat within the clip interval. */
    readonly loop?: boolean;
    /** Version 2: terminal manual extension. Version 3: duration must be sequence-end, independently of onBreak. */
    readonly loopIndefinitely?: boolean;
    readonly onBreak?: BreakBehavior;
  };
}

/** Legacy source-duration timing and manual-loop behavior remain unchanged. */
export interface AudioClipV1 extends AudioClipBase {
  readonly typeVersion: 1;
  readonly duration: { readonly kind: 'media' };
}

/** Authored duration is independent from the selected source interval. */
export interface AudioClipV2 extends AudioClipBase {
  readonly typeVersion: 2;
  readonly duration: { readonly kind: 'fixed'; readonly milliseconds: number };
}

/** Schema 2: indefinite sounds inherit the sequence endpoint and author no duration. */
export interface AudioClipV3 extends AudioClipBase {
  readonly typeVersion: 3;
  readonly duration: { readonly kind: 'fixed'; readonly milliseconds: number } | { readonly kind: 'sequence-end' };
}

export type AudioClip = AudioClipV1 | AudioClipV2 | AudioClipV3;

export interface TextClip extends ClipBase {
  readonly type: 'text';
  readonly duration: Exclude<ClipDuration, { readonly kind: 'media' }>;
  readonly properties: {
    readonly text: string;
    readonly fontFamily: string;
    /** Logical composition units, like box; scaled to the client viewport at render time. */
    readonly fontSize: number;
    readonly color: string;
    readonly align: 'left' | 'center' | 'right';
    /** Rectangle in logical composition units, independent of client pixels. */
    readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly shrinkToFit: boolean;
    /** Logical composition units. */
    readonly minimumFontSize: number;
    readonly outline?: TextOutline;
    readonly shadow?: TextShadow;
    readonly glow?: TextGlow;
  };
}

export interface ImagePoint {
  readonly x: number;
  readonly y: number;
}

export interface ImageSurfaceGeometry {
  readonly fit: 'contain' | 'cover';
  /** Rectangle in logical composition units, independent of client pixels. */
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Source fractions: crop before fitting the selected region into the box. */
  readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Local normalized box coordinates, initially TL, TR, BR, BL; arbitrary quadrilaterals are allowed. */
  readonly mask: readonly [ImagePoint, ImagePoint, ImagePoint, ImagePoint];
}

export interface SurfaceEffects {
  readonly outline?: TextOutline;
  readonly shadow?: TextShadow;
  readonly glow?: TextGlow;
}

/** Static image geometry: mask points clip the fitted image without deforming it. */
export interface ImageClip extends ClipBase {
  readonly type: 'image';
  readonly duration: Exclude<ClipDuration, { readonly kind: 'media' }>;
  readonly properties: ImageSurfaceGeometry & SurfaceEffects & {
    readonly source: { readonly kind: 'foundry-file'; readonly path: string };
  };
}

/** Static color surface. Its four-point mask and optional alpha map retain the original payload shape. */
export interface SolidClipV1 extends Omit<ClipBase, 'typeVersion'> {
  readonly type: 'solid';
  readonly typeVersion: 1;
  readonly duration: Exclude<ClipDuration, { readonly kind: 'media' }>;
  readonly properties: Omit<ImageSurfaceGeometry, 'mask'> & SurfaceEffects & {
    readonly mask: readonly [ImagePoint, ImagePoint, ImagePoint, ImagePoint];
    readonly color: string;
    readonly alphaMap?: { readonly kind: 'foundry-file'; readonly path: string };
    readonly pattern?: never;
  };
}

/** Polygon color surface. Pattern is optional so type version 2 also supports a static fill. */
export interface SolidClipV2 extends Omit<ClipBase, 'typeVersion'> {
  readonly type: 'solid';
  readonly typeVersion: 2;
  readonly duration: Exclude<ClipDuration, { readonly kind: 'media' }>;
  readonly properties: Omit<ImageSurfaceGeometry, 'mask'> & SurfaceEffects & {
    readonly mask: readonly ImagePoint[];
    readonly color: string;
    readonly alphaMap?: { readonly kind: 'foundry-file'; readonly path: string };
    readonly pattern?: AnimatedPattern;
  };
}

export type SolidClip = SolidClipV1 | SolidClipV2;

export type ButtonShape = 'rectangle' | 'rounded' | 'pill' | 'bevel' | 'hexagon';
export type ButtonTexture = { readonly kind: 'builtin'; readonly id: 'grain' | 'diagonal' | 'honeycomb' | 'facets' }
  | { readonly kind: 'foundry-file'; readonly path: string; readonly fit: 'contain' | 'cover' };
export type ButtonAction = { readonly kind: 'continue' }
  | { readonly kind: 'choice'; readonly decisionId: string; readonly optionId: string; readonly message: string; readonly visibility: 'public' | 'gm' };
export interface ButtonClip extends ClipBase {
  readonly type: 'button';
  readonly duration: Exclude<ClipDuration, { readonly kind: 'media' }>;
  readonly properties: SurfaceEffects & {
    readonly action: ButtonAction;
    readonly label: string;
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly color: string;
    readonly backgroundColor: string;
    readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly shape: ButtonShape;
    readonly texture?: ButtonTexture;
  };
}

export type VisualClip = BarsClip | VideoClip | TextClip | ImageClip | SolidClip | ButtonClip;
export type SequenceClip = VisualClip | AudioClip;
export type SequenceEnd =
  | { readonly kind: 'manual'; readonly durationMs?: number }
  | {
      readonly kind: 'fixed'; readonly durationMs: number;
      /** Editor policy only: durationMs stays the authoritative playback endpoint. */
      readonly automatic?: boolean;
    }
  | { readonly kind: 'media'; readonly clipId: string };

/** Authored inner hold; positions beyond the current endpoint remain stored and inactive. */
export interface TimelineBreak {
  readonly id: string;
  readonly positionMs: number;
}

export interface SequenceV1 {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5;
  /** Required in schemas 4/5, absent in historical schemas. Validated at persistence boundaries. */
  readonly playbackSchemaVersion?: PlaybackSchemaVersion;
  /** Explicit capability; historical sequences always use shared progression. */
  readonly progression?: { readonly version: 1; readonly mode: 'per-recipient' };
  readonly launch?: SequenceLaunchSettings;
  /** Playback schema 3 only; author order does not control playback order. */
  readonly breaks?: readonly TimelineBreak[];
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly composition: { readonly width: number; readonly height: number };
  readonly presentation: {
    readonly surface: 'window' | 'canvas';
    readonly blockInput: boolean;
    /** Global run fade; sequence-end clips use this instead of their individual exit. */
    readonly exitDurationMs: number;
  };
  readonly tracks: readonly SequenceTrack[];
  readonly clips: readonly SequenceClip[];
  readonly end: SequenceEnd;
}
