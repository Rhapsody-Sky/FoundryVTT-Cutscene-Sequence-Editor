import { getPlaybackSchemaVersion } from '../domain/sequence-audience.js';
import type {
  AudioClip, BarsClip, BreakBehavior, ButtonAction, ButtonClip, ButtonShape, ButtonTexture, ClipAppearance, ClipBlendMode, ImageClip, SequenceEnd, SequenceV1, TextClip, TextGlow, TextOutline,
  TextShadow, Transition, TransitionEasing, VideoClip, VisualClip, VisualTrack
} from '../domain/sequence.js';
import { audioDurationMs, videoTypeVersion } from '../domain/clip-timing.js';
import { validateSequence } from '../domain/validation.js';
import type { AnimatedPattern } from '../domain/animated-pattern.js';
import type { SolidClip } from '../domain/sequence.js';
import type { TextMotionDirection, TextMotionId, TextMotionOrder } from '../domain/text-motion.js';

export type SimpleElementType = 'video' | 'bars' | 'text';
export type SimpleDurationMode = 'fixed' | 'sequence-end';
export type SimpleBlendMode = ClipBlendMode;
export type SimpleAppearanceValues = ClipAppearance;
export type SimpleOutlineValues = TextOutline;
export type SimpleShadowValues = TextShadow;
export type SimpleGlowValues = TextGlow;

export interface SimpleBarsValues {
  readonly startMs: number;
  readonly entranceMs: number;
  readonly entrancePreset?: Transition['preset'];
  readonly exitPreset?: Transition['preset'];
  readonly exitMs?: number;
  readonly durationMode: SimpleDurationMode;
  readonly durationMs: number;
  readonly heightFraction: number;
  readonly appearance?: SimpleAppearanceValues;
}

export interface SimpleTransitionValues {
  readonly entranceMs: number;
  readonly exitMs?: number;
  readonly entrancePreset?: Transition['preset'];
  readonly exitPreset?: Transition['preset'];
  readonly entranceEasing?: TransitionEasing;
  readonly exitEasing?: TransitionEasing;
  readonly entranceDirection?: 'left' | 'right' | 'up' | 'down';
  readonly exitDirection?: 'left' | 'right' | 'up' | 'down';
  readonly entranceDistance?: number;
  readonly exitDistance?: number;
  readonly entranceScale?: number;
  readonly exitScale?: number;
}

export interface SimpleAnimationValues extends SimpleTransitionValues {
  readonly durationMode: SimpleDurationMode;
  readonly durationMs: number;
  readonly exitMs: number;
}

export interface SimpleTextValues extends SimpleAnimationValues {
  readonly entranceMotion?: TextMotionId;
  readonly entranceAmount?: number;
  readonly entranceStagger?: number;
  readonly entranceMotionDirection?: TextMotionDirection;
  readonly entranceMotionOrder?: TextMotionOrder;
  readonly exitMotion?: TextMotionId;
  readonly exitAmount?: number;
  readonly exitStagger?: number;
  readonly exitMotionDirection?: TextMotionDirection;
  readonly exitMotionOrder?: TextMotionOrder;
  readonly startMs: number;
  readonly text: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly minimumFontSize: number;
  readonly color: string;
  readonly align: 'left' | 'center' | 'right';
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly shrinkToFit: boolean;
  readonly appearance?: SimpleAppearanceValues;
  readonly outline?: SimpleOutlineValues;
  readonly shadow?: SimpleShadowValues;
  readonly glow?: SimpleGlowValues;
}

export interface SimpleImageValues extends SimpleAnimationValues {
  readonly startMs: number;
  readonly sourcePath: string;
  readonly fit: 'contain' | 'cover';
  readonly box: ImageClip['properties']['box'];
  readonly crop: ImageClip['properties']['crop'];
  readonly mask: ImageClip['properties']['mask'];
  readonly appearance?: SimpleAppearanceValues;
  readonly outline?: SimpleOutlineValues;
  readonly shadow?: SimpleShadowValues;
  readonly glow?: SimpleGlowValues;
}

/** Button authoring keeps its visual fields together while leaving option identity to the clip. */
export interface SimpleButtonValues extends SimpleTransitionValues {
  readonly startMs: number;
  readonly durationMode: SimpleDurationMode;
  readonly durationMs: number;
  readonly action: ButtonAction;
  readonly label: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly color: string;
  readonly backgroundColor: string;
  readonly box: ButtonClip['properties']['box'];
  readonly shape: ButtonShape;
  readonly appearance?: SimpleAppearanceValues;
  /** null clears an authored background image; undefined preserves it for partial callers. */
  readonly texture?: ButtonTexture | null;
  readonly outline?: SimpleOutlineValues;
  readonly shadow?: SimpleShadowValues;
  readonly glow?: SimpleGlowValues;
}

/** Color surfaces share image geometry and effects without acquiring an image source. */
export interface SimpleSolidValues extends Omit<SimpleImageValues, 'sourcePath' | 'mask'> {
  readonly mask: SolidClip['properties']['mask'];
  readonly pattern?: AnimatedPattern;
  readonly color: string;
  /** Empty explicitly removes an alpha map; a path retains or creates the optional Foundry file reference. */
  readonly alphaMapPath: string;
}

export interface SimpleVideoValues extends SimpleTransitionValues {
  readonly box?: VideoClip['properties']['box'] | null;
  readonly startMs: number;
  readonly entranceMs: number;
  readonly sourcePath: string;
  readonly durationMs?: number;
  readonly fit: 'contain' | 'cover';
  readonly volume: number;
  readonly muted: boolean;
  readonly loop?: boolean;
  readonly onBreak?: BreakBehavior;
  readonly keying?: SimpleVideoKeying;
  readonly appearance?: SimpleAppearanceValues;
}

/** Values edited by the audio clip inspector; fades control audio gain only. */
export interface SimpleAudioValues {
  readonly startMs: number;
  readonly entranceMs: number;
  readonly exitMs: number;
  readonly sourcePath: string;
  /** Full inspected source duration; retained separately from the authored clip length. */
  readonly durationMs?: number;
  /** Absent for an indefinite clip, whose end is inherited from the sequence. */
  readonly clipDurationMs?: number;
  readonly sourceRange?: { readonly inMs: number; readonly outMs: number };
  readonly volume: number;
  readonly muted: boolean;
  readonly loop: boolean;
  readonly loopIndefinitely: boolean;
  readonly onBreak?: BreakBehavior;
}

/** Normalized chroma-key settings persisted on a video clip. */
export interface SimpleVideoKeying {
  readonly enabled: boolean;
  readonly color: string;
  readonly tolerance: number;
  readonly softness: number;
}

export interface SimpleCompositionEdit {
  readonly name: string;
  readonly presentation: SequenceV1['presentation'];
  readonly end: SequenceEnd;
  readonly bars?: SimpleBarsValues;
  readonly text?: SimpleTextValues;
  readonly video?: SimpleVideoValues;
}

const ORDER: Readonly<Record<SimpleElementType, number>> = { video: 0, bars: 1, text: 2 };
const LABEL: Readonly<Record<SimpleElementType, string>> = { video: 'Video', bars: 'Bars', text: 'Text' };
const DEFAULT_APPEARANCE: SimpleAppearanceValues = { blendMode: 'normal', opacity: 1 };
const DEFAULT_OUTLINE: SimpleOutlineValues = { enabled: false, color: '#ffffff', opacity: 1, width: 2 };
const DEFAULT_SHADOW: SimpleShadowValues = { enabled: false, color: '#000000', opacity: 0.75, offsetX: 0, offsetY: 8, blur: 16 };
const DEFAULT_GLOW: SimpleGlowValues = { enabled: false, color: '#ffffff', opacity: 0.75, radius: 24 };

type AppearanceRecord = SimpleAppearanceValues & Record<string, unknown>;
type EffectRecord<T> = T & Record<string, unknown>;

function extensionsOf(value: object | undefined, knownFields: readonly string[]): Record<string, unknown> {
  if (!value) return {};
  const known = new Set(knownFields);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
}

export function simpleClip(sequence: SequenceV1, type: SimpleElementType): VisualClip | undefined {
  if (!['video', 'bars', 'text'].includes(type)) return undefined;
  return sequence.clips.find((clip): clip is VisualClip => clip.type === type);
}

/** Keep inspected metadata only while the source path it describes stays the same. */
export function videoValuesForPath(values: SimpleVideoValues, sourcePath: string): SimpleVideoValues {
  const { durationMs, ...settings } = values;
  return {
    ...settings,
    sourcePath,
    ...(sourcePath === values.sourcePath && durationMs !== undefined ? { durationMs } : {})
  };
}

/** Keep inspected audio metadata and trim only while they still describe this path. */
export function audioValuesForPath(values: SimpleAudioValues, sourcePath: string): SimpleAudioValues {
  if (sourcePath === values.sourcePath) return { ...values };
  const { durationMs: _durationMs, sourceRange: _sourceRange, ...settings } = values;
  return { ...settings, sourcePath };
}

/** Audio transitions support only a gain fade and preserve extension fields. */
export function audioFade(previous: AudioClip['entrance'] | undefined, durationMs: number): AudioClip['entrance'] {
  const extra = extensionsOf(previous, ['preset', 'version', 'durationMs', 'easing']);
  if (durationMs <= 0) return { ...extra, preset: 'none', version: 1 };
  return {
    ...extra, preset: 'fade', version: 1, durationMs,
    easing: previous?.preset === 'fade' ? previous.easing : 'ease-in-out'
  };
}

/** Bars keep their authored preset and easing when legacy callers edit duration only. */
export function barsTransition(previous: Transition | undefined, durationMs: number, preset?: Transition['preset']): Transition {
  const nextPreset = preset ?? (previous?.preset !== 'none' ? previous?.preset ?? 'fade' : 'fade');
  const extensions = extensionsOf(previous, ['preset', 'version', 'durationMs', 'easing']);
  if (nextPreset === 'none' || durationMs <= 0) return { ...extensions, preset: 'none', version: 1 } as Transition;
  return {
    ...extensions, preset: nextPreset, version: 1, durationMs,
    easing: previous && previous.preset !== 'none' ? previous.easing : 'ease-in-out'
  } as Transition;
}

export function barsExit(previous: Transition | undefined, values: SimpleBarsValues): Transition {
  if (values.durationMode === 'sequence-end' || (values.exitMs === undefined && values.exitPreset === undefined)) {
    return previous ?? { preset: 'none', version: 1 };
  }
  return barsTransition(previous, values.exitMs ?? (previous && previous.preset !== 'none' ? previous.durationMs : 800), values.exitPreset);
}

/** Legacy duration-only edits retain the title's preset, easing and motion fields. */
type PlanarTransitionValues = SimpleTransitionValues & { readonly durationMode?: SimpleDurationMode } & Partial<Pick<SimpleTextValues,
  'entranceMotion' | 'entranceAmount' | 'entranceStagger' | 'entranceMotionDirection' | 'entranceMotionOrder' |
  'exitMotion' | 'exitAmount' | 'exitStagger' | 'exitMotionDirection' | 'exitMotionOrder'>>;

export function planarTransition(
  previous: Transition | undefined,
  values: PlanarTransitionValues,
  phase: 'entrance' | 'exit'
): Transition {
  if (phase === 'exit' && values.durationMode === 'sequence-end') return previous ?? { preset: 'none', version: 1 };
  const durationMs = (phase === 'entrance' ? values.entranceMs : values.exitMs)
    ?? (previous && previous.preset !== 'none' ? previous.durationMs : 0);
  const preset = (phase === 'entrance' ? values.entrancePreset : values.exitPreset)
    ?? (previous && previous.preset !== 'none' ? previous.preset : 'fade');
  const extra = extensionsOf(previous, ['preset', 'version', 'durationMs', 'easing', 'direction', 'distance', 'scale', 'motion', 'amount', 'stagger', 'motionDirection', 'motionOrder']);
  if (preset === 'none' || durationMs <= 0) return { ...extra, preset: 'none', version: 1 } as Transition;
  const old = previous?.preset !== 'none' ? previous : undefined;
  const isTextMotion = preset === 'text-motion';
  const easing = (phase === 'entrance' ? values.entranceEasing : values.exitEasing)
    ?? (isTextMotion
      ? old?.preset === 'text-motion' ? old.easing : phase === 'entrance' ? 'ease-out' : 'ease-in'
      : old?.easing ?? 'ease-in-out');
  const direction = (phase === 'entrance' ? values.entranceDirection : values.exitDirection) ?? old?.direction;
  const distance = (phase === 'entrance' ? values.entranceDistance : values.exitDistance) ?? old?.distance;
  const scale = (phase === 'entrance' ? values.entranceScale : values.exitScale) ?? old?.scale;
  const motionValue = phase === 'entrance' ? values.entranceMotion : values.exitMotion;
  const amountValue = phase === 'entrance' ? values.entranceAmount : values.exitAmount;
  const staggerValue = phase === 'entrance' ? values.entranceStagger : values.exitStagger;
  const motion = motionValue ?? (old?.preset === 'text-motion' ? old.motion : undefined);
  const changedMotion = isTextMotion && (old?.preset !== 'text-motion' || old.motion !== motion);
  const motionDirection = (phase === 'entrance' ? values.entranceMotionDirection : values.exitMotionDirection)
    ?? (changedMotion ? 'default' : old?.preset === 'text-motion' ? old.motionDirection : undefined);
  const motionOrder = (phase === 'entrance' ? values.entranceMotionOrder : values.exitMotionOrder)
    ?? (changedMotion ? 'default' : old?.preset === 'text-motion' ? old.motionOrder : undefined);
  const amount = amountValue ?? (old?.preset === 'text-motion' ? old.amount : undefined) ?? 1;
  const stagger = staggerValue ?? (old?.preset === 'text-motion' ? old.stagger : undefined) ?? 0.35;
  return { ...extra, preset, version: 1, durationMs, easing,
    ...(direction === undefined ? {} : { direction }), ...(distance === undefined ? {} : { distance }),
    ...(scale === undefined ? {} : { scale }),
    ...(isTextMotion ? { ...(motion === undefined ? {} : { motion }), amount, stagger,
      ...(motionDirection === undefined ? {} : { motionDirection }),
      ...(motionOrder === undefined ? {} : { motionOrder }) } : {}) } as Transition;
}

/** Text, image, solid and video surfaces share the same planar transition values. */
export function textTransition(previous: Transition | undefined, values: SimpleTextValues, phase: 'entrance' | 'exit'): Transition {
  return planarTransition(previous, values, phase);
}

/** Image transitions share the title animation fields without entering text helpers. */
export function imageTransition(previous: Transition | undefined, values: SimpleImageValues | SimpleSolidValues, phase: 'entrance' | 'exit'): Transition {
  return planarTransition(previous, values, phase);
}

export function buttonTransition(previous: Transition | undefined, values: SimpleButtonValues, phase: 'entrance' | 'exit'): Transition {
  return planarTransition(previous, values, phase);
}

export function videoTransition(previous: Transition | undefined, values: SimpleVideoValues, phase: 'entrance' | 'exit'): Transition {
  return planarTransition(previous, values, phase);
}

function durationExtensions(duration: BarsClip['duration'] | TextClip['duration'] | undefined): Record<string, unknown> {
  return extensionsOf(duration, ['kind', 'milliseconds']);
}

function appearanceFor(old: { readonly appearance?: ClipAppearance } | undefined, values?: ClipAppearance): AppearanceRecord | undefined {
  const previous = old?.appearance as AppearanceRecord | undefined;
  const next = values ?? previous;
  if (!next || (!previous && next.blendMode === DEFAULT_APPEARANCE.blendMode && next.opacity === DEFAULT_APPEARANCE.opacity)) return undefined;
  return { ...(previous ?? {}), blendMode: next.blendMode, opacity: next.opacity };
}

function effectFor<T extends object>(previous: T | undefined, values: T | undefined, defaults: T): EffectRecord<T> | undefined {
  const previousWithExtensions = previous as (T & Record<string, unknown>) | undefined;
  const next = values ?? previousWithExtensions;
  if (!next) return undefined;
  const isDefault = Object.keys(defaults).every(key => (next as Record<string, unknown>)[key] === (defaults as Record<string, unknown>)[key]);
  if (!previousWithExtensions && isDefault) return undefined;
  return { ...(previousWithExtensions ?? {}), ...next } as EffectRecord<T>;
}

function makeBars(old: BarsClip | undefined, trackId: string, values: SimpleBarsValues, idFactory: () => string): BarsClip {
  const duration = values.durationMode === 'sequence-end'
    ? { ...durationExtensions(old?.duration), kind: 'sequence-end' as const }
    : { ...durationExtensions(old?.duration), kind: 'fixed' as const, milliseconds: values.durationMs };
  const appearance = appearanceFor(old, values.appearance);
  return {
    ...(old ?? {}), id: old?.id ?? idFactory(), trackId, type: 'bars', typeVersion: 1,
    startMs: values.startMs, duration,
    entrance: barsTransition(old?.entrance, values.entranceMs, values.entrancePreset),
    exit: barsExit(old?.exit, values),
    ...(appearance ? { appearance } : {}),
    properties: { ...(old?.properties ?? {}), heightFraction: values.heightFraction, color: old?.properties.color ?? '#000000' }
  } as BarsClip;
}

function makeText(old: TextClip | undefined, trackId: string, values: SimpleTextValues, idFactory: () => string): TextClip {
  const duration = values.durationMode === 'sequence-end'
    ? { ...durationExtensions(old?.duration), kind: 'sequence-end' as const }
    : { ...durationExtensions(old?.duration), kind: 'fixed' as const, milliseconds: values.durationMs };
  const oldProperties = old?.properties;
  const outline = effectFor(oldProperties?.outline, values.outline, DEFAULT_OUTLINE);
  const shadow = effectFor(oldProperties?.shadow, values.shadow, DEFAULT_SHADOW);
  const glow = effectFor(oldProperties?.glow, values.glow, DEFAULT_GLOW);
  const appearance = appearanceFor(old, values.appearance);
  const properties: Record<string, unknown> = {
    ...(old?.properties ?? {}), text: values.text, fontFamily: values.fontFamily,
    fontSize: values.fontSize, minimumFontSize: values.minimumFontSize,
    color: values.color, align: values.align,
    box: { ...(old?.properties.box ?? {}), ...values.box }, shrinkToFit: values.shrinkToFit
  };
  if (outline) properties.outline = outline;
  else delete properties.outline;
  if (shadow) properties.shadow = shadow;
  else delete properties.shadow;
  if (glow) properties.glow = glow;
  else delete properties.glow;
  return {
    ...(old ?? {}), id: old?.id ?? idFactory(), trackId, type: 'text', typeVersion: 1,
    startMs: values.startMs, duration,
    entrance: textTransition(old?.entrance, values, 'entrance'),
    exit: textTransition(old?.exit, values, 'exit'),
    ...(appearance ? { appearance } : {}),
    properties
  } as TextClip;
}

function makeVideo(old: VideoClip | undefined, trackId: string, values: SimpleVideoValues, idFactory: () => string, schemaVersion: 1 | 2 | 3): VideoClip {
  const properties = { ...(old?.properties ?? {}) } as Record<string, unknown>;
  const oldKeying = old?.properties as (VideoClip['properties'] & { readonly keying?: SimpleVideoKeying & Record<string, unknown> }) | undefined;
  const source = { ...(old?.properties.source ?? {}), kind: 'foundry-file' as const, path: values.sourcePath };
  if (values.sourcePath !== old?.properties.source.path) delete properties.sourceRange;
  if (values.durationMs === undefined) delete properties.durationMs;
  else properties.durationMs = values.durationMs;
  if (values.loop === true) properties.loop = true;
  else if (values.loop === false && old?.properties.loop === true) delete properties.loop;
  if (values.onBreak !== undefined) properties.onBreak = values.onBreak;
  else if (schemaVersion >= 2 && old === undefined) properties.onBreak = 'pause';
  if (values.box === null) delete properties.box;
  else if (values.box !== undefined) properties.box = { ...(old?.properties.box ?? {}), ...values.box };
  if (values.keying !== undefined) properties.keying = { ...(oldKeying?.keying ?? {}), ...values.keying };
  const appearance = appearanceFor(old, values.appearance);
  const entrance = videoTransition(old?.entrance, values, 'entrance');
  const exit = videoTransition(old?.exit, values, 'exit');
  return {
    ...(old ?? {}), id: old?.id ?? idFactory(), trackId, type: 'video', typeVersion: videoTypeVersion(
      properties as Pick<VideoClip['properties'], 'loop' | 'sourceRange' | 'keying' | 'onBreak' | 'box'>,
      old?.typeVersion, { entrance, exit }),
    startMs: values.startMs, duration: { ...extensionsOf(old?.duration, ['kind']), kind: 'media' },
    entrance, exit,
    ...(appearance ? { appearance } : {}),
    properties: { ...properties, source, fit: values.fit, volume: values.volume, muted: values.muted } as VideoClip['properties']
  } as VideoClip;
}

function trackIdFor(source: SequenceV1, type: SimpleElementType): string | undefined {
  const clip = source.clips.find(candidate => candidate.type === type);
  return clip?.trackId;
}

/**
 * Rebuilds only the three supported element types. Existing objects are spread
 * before editable fields are changed, retaining IDs and JSON extension fields.
 */
export function buildSimpleSequence(
  source: SequenceV1,
  idFactory: () => string,
  edit: SimpleCompositionEdit
): SequenceV1 {
  if (source.clips.some(clip => clip.type === 'image')) {
    throw new Error('SIMPLE_COMPOSITION_UNSUPPORTED_IMAGE');
  }
  if (source.clips.some(clip => clip.type === 'solid')) {
    throw new Error('SIMPLE_COMPOSITION_UNSUPPORTED_SOLID');
  }
  const values: Partial<Record<SimpleElementType, SimpleBarsValues | SimpleTextValues | SimpleVideoValues>> = {
    ...(edit.video ? { video: edit.video } : {}),
    ...(edit.bars ? { bars: edit.bars } : {}),
    ...(edit.text ? { text: edit.text } : {})
  };
  const present = (['video', 'bars', 'text'] as const).filter(type => values[type] !== undefined);
  const tracksByType = new Map<SimpleElementType, VisualTrack>();
  for (const type of present) {
    const existingTrackId = trackIdFor(source, type);
    const existing = source.tracks.find((track): track is VisualTrack => track.id === existingTrackId && track.kind === 'visual');
    if (existing) tracksByType.set(type, existing);
  }

  // A blank composition must still retain one valid track in the persisted format.
  let emptyTrack: VisualTrack | undefined;
  if (present.length === 0) emptyTrack = source.tracks.find(track => track.kind === 'visual') ?? {
    id: idFactory(), name: 'Visual 1', kind: 'visual', order: 0, enabled: true, locked: false
  };
  else if (tracksByType.size === 0 && source.clips.length === 0) emptyTrack = source.tracks.find(track => track.kind === 'visual');

  const tracks: VisualTrack[] = [];
  const trackIds = new Map<SimpleElementType, string>();
  const onlyExistingSameType = present.length === 1 && source.clips.length === 1 && source.clips[0]?.type === present[0];
  let emptyTrackUsed = false;
  for (const type of present) {
    const oldTrack = tracksByType.get(type) ?? (source.clips.length === 0 && !emptyTrackUsed ? emptyTrack : undefined);
    if (oldTrack === emptyTrack && emptyTrack) emptyTrackUsed = true;
    const trackId = oldTrack?.id ?? idFactory();
    trackIds.set(type, trackId);
    const order = onlyExistingSameType && oldTrack ? oldTrack.order : ORDER[type];
    tracks.push(oldTrack
      ? { ...oldTrack, order }
      : { id: trackId, name: LABEL[type], kind: 'visual', order, enabled: true, locked: false });
  }
  if (present.length === 0 && emptyTrack) tracks.push({ ...emptyTrack });

  const previous = Object.fromEntries(source.clips.map(clip => [clip.type, clip])) as Partial<Record<SimpleElementType, VisualClip>>;
  const clips: VisualClip[] = [];
  if (edit.video) clips.push(makeVideo(previous.video as VideoClip | undefined, trackIds.get('video')!, edit.video, idFactory, getPlaybackSchemaVersion(source)));
  if (edit.bars) clips.push(makeBars(previous.bars as BarsClip | undefined, trackIds.get('bars')!, edit.bars, idFactory));
  if (edit.text) clips.push(makeText(previous.text as TextClip | undefined, trackIds.get('text')!, edit.text, idFactory));

  const video = clips.find((clip): clip is VideoClip => clip.type === 'video');
  const endExtensions = { ...source.end } as Record<string, unknown>;
  delete endExtensions.kind;
  delete endExtensions.clipId;
  delete endExtensions.durationMs;
  const end = video && edit.end.kind !== 'manual'
    ? { ...endExtensions, kind: 'media' as const, clipId: video.id }
    : { ...endExtensions, ...edit.end };
  return validateSequence({ ...source, name: edit.name, presentation: edit.presentation, tracks, clips, end });
}

export interface TimingConflict {
  readonly key: 'MediaMetadataRequired' | 'ElementAfterEnd' | 'ElementStartsAfterEnd' | 'EntranceAfterEnd' | 'TransitionOverlap';
  readonly element: string;
}

/** Finds conflicts in the editor's three-element model before a player starts. */
export function simpleTimingConflicts(sequence: SequenceV1): TimingConflict[] {
  if (sequence.clips.some(clip => clip.type === 'image')) throw new Error('SIMPLE_COMPOSITION_UNSUPPORTED_IMAGE');
  if (sequence.clips.some(clip => clip.type === 'solid')) throw new Error('SIMPLE_COMPOSITION_UNSUPPORTED_SOLID');
  const conflicts: TimingConflict[] = [];
  const video = sequence.clips.find((clip): clip is VideoClip => clip.type === 'video');
  const mediaEndClipId = sequence.end.kind === 'media' ? sequence.end.clipId : undefined;
  const audioEnd = mediaEndClipId === undefined
    ? undefined
    : sequence.clips.find((clip): clip is AudioClip => clip.id === mediaEndClipId && clip.type === 'audio');
  const audioDuration = audioEnd && audioDurationMs(audioEnd);
  if (audioEnd && audioDuration === undefined) {
    conflicts.push({ key: 'MediaMetadataRequired', element: 'audio' });
    return conflicts;
  }
  if (sequence.end.kind === 'media' && (!video || typeof video.properties.durationMs !== 'number')) {
    if (!audioEnd) {
      conflicts.push({ key: 'MediaMetadataRequired', element: 'video' });
      return conflicts;
    }
  }
  const videoDuration = video?.properties.durationMs;
  const endMs = sequence.end.kind === 'fixed'
    ? sequence.end.durationMs
    : sequence.end.kind === 'media' && audioEnd && audioDuration !== undefined
      ? audioEnd.startMs + audioDuration
      : sequence.end.kind === 'media' && video && videoDuration !== undefined
        ? video.startMs + videoDuration
      : null;

  for (const clip of sequence.clips) {
    const label = clip.type;
    const entranceMs = clip.entrance.preset !== 'none' ? clip.entrance.durationMs : 0;
    const exitMs = clip.exit.preset !== 'none' ? clip.exit.durationMs : 0;
    if (clip.duration.kind === 'fixed' && entranceMs + exitMs > clip.duration.milliseconds) {
      conflicts.push({ key: 'TransitionOverlap', element: label });
    }
    if (endMs === null) continue;
    if (clip.duration.kind === 'fixed' && clip.startMs + clip.duration.milliseconds > endMs) {
      conflicts.push({ key: 'ElementAfterEnd', element: label });
    } else if (clip.duration.kind === 'sequence-end' && clip.startMs >= endMs) {
      conflicts.push({ key: 'ElementStartsAfterEnd', element: label });
    }
    if (clip.startMs + entranceMs > endMs) conflicts.push({ key: 'EntranceAfterEnd', element: label });
  }
  return conflicts;
}
