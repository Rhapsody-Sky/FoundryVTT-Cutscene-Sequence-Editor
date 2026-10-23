import { defaultButtonProperties, withButtonProgression } from '../domain/button.js';
import { getPlaybackSchemaVersion } from '../domain/sequence-audience.js';
import type {
  AudioClip, AudioClipV2, AudioClipV3, BarsClip, ButtonClip, ImageClip, SequenceEnd, SequenceV1, SolidClip, TextClip, Transition, VideoClip, SequenceClip, SequenceTrack
} from '../domain/sequence.js';
import { audioDurationMs, clipDurationMs, mediaDurationMs, sequenceDurationMs, videoTypeVersion } from '../domain/clip-timing.js';
import { SequenceValidationError, SEQUENCE_LIMITS, validateSequence } from '../domain/validation.js';
import { transitionDurationMs as transitionDuration } from '../domain/transitions.js';
import { upgradeSequenceToTimelineBreaks } from '../domain/breaks.js';

export type TimelineCommand =
  | { readonly kind: 'add-track'; readonly name?: string; readonly trackKind?: 'visual' | 'audio' }
  | { readonly kind: 'rename-track'; readonly trackId: string; readonly name: string }
  | { readonly kind: 'move-track'; readonly trackId: string; readonly direction: 'up' | 'down' }
  | { readonly kind: 'toggle-track'; readonly trackId: string; readonly property: 'enabled' | 'locked' }
  | { readonly kind: 'remove-track'; readonly trackId: string }
  | {
      readonly kind: 'add-clip'; readonly trackId: string; readonly type: SequenceClip['type'];
      readonly startMs: number; readonly sourcePath?: string; readonly sourceDurationMs?: number;
    }
  | { readonly kind: 'duplicate-clip'; readonly clipId: string }
  | { readonly kind: 'remove-clip'; readonly clipId: string }
  | { readonly kind: 'move-clip'; readonly clipId: string; readonly trackId: string; readonly startMs: number }
  | { readonly kind: 'resize-clip'; readonly clipId: string; readonly edge: 'start' | 'end'; readonly timeMs: number }
  | { readonly kind: 'replace-clip'; readonly clip: SequenceClip }
  | { readonly kind: 'insert-clip'; readonly clip: SequenceClip }
  | { readonly kind: 'add-break'; readonly positionMs: number }
  | { readonly kind: 'move-break'; readonly breakId: string; readonly positionMs: number }
  | { readonly kind: 'remove-break'; readonly breakId: string }
  | { readonly kind: 'set-end'; readonly end: SequenceEnd };

export interface TimelineConflict {
  readonly code: string;
  readonly clipId?: string;
  readonly trackId?: string;
}

export class TimelineCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TimelineCommandError';
    this.code = code;
  }
}

const NO_TRANSITION: Transition = { preset: 'none', version: 1 };
const ENTRANCE: Transition = { preset: 'fade', version: 1, durationMs: 800, easing: 'ease-in-out' };

function commandError(code: string, message: string): never {
  throw new TimelineCommandError(code, message);
}

function findTrack(sequence: SequenceV1, trackId: string): SequenceTrack {
  const track = sequence.tracks.find(candidate => candidate.id === trackId);
  if (!track) return commandError('TRACK_NOT_FOUND', `Track "${trackId}" does not exist.`);
  return track;
}

function findClip(sequence: SequenceV1, clipId: string): SequenceClip {
  const clip = sequence.clips.find(candidate => candidate.id === clipId);
  if (!clip) return commandError('CLIP_NOT_FOUND', `Clip "${clipId}" does not exist.`);
  return clip;
}

function findBreak(sequence: SequenceV1, breakId: string) {
  const marker = sequence.breaks?.find(candidate => candidate.id === breakId);
  if (!marker) return commandError('BREAK_NOT_FOUND', `Break marker "${breakId}" does not exist.`);
  return marker;
}

function requireBreakPosition(positionMs: number): void {
  if (!Number.isInteger(positionMs) || positionMs < 0 || positionMs > SEQUENCE_LIMITS.timelineMs) {
    commandError('BREAK_POSITION_INVALID', `Break marker positions must be integer milliseconds between 0 and ${SEQUENCE_LIMITS.timelineMs}.`);
  }
}

function requireUniqueBreakPosition(sequence: SequenceV1, positionMs: number, exceptId?: string): void {
  if (sequence.breaks?.some(marker => marker.id !== exceptId && marker.positionMs === positionMs)) {
    commandError('BREAK_POSITION_TAKEN', 'A Break marker already exists at this position.');
  }
}

function requireEditableTrack(track: SequenceTrack): void {
  if (track.locked) commandError('TRACK_LOCKED', `Track "${track.id}" is locked.`);
}

function requireCompatibleTrack(track: SequenceTrack, type: SequenceClip['type']): void {
  if (track.kind !== (type === 'audio' ? 'audio' : 'visual')) {
    commandError('INCOMPATIBLE_TRACK', 'This clip type is incompatible with its track kind.');
  }
}

function endForClip(sequence: SequenceV1, clip: SequenceClip): number | null | undefined {
  const duration = clipDurationMs(sequence, clip);
  if (duration === null || duration === undefined) return duration;
  return clip.startMs + duration;
}

function ensureFixedEnd(sequence: SequenceV1, clips: readonly SequenceClip[]): SequenceV1 {
  if (sequence.end.kind !== 'fixed') return sequence;
  if (sequence.end.automatic === true) return recomputeAutomaticEnd(sequence);
  let durationMs = sequence.end.durationMs;
  for (const clip of clips) {
    let requiredEnd: number | null | undefined;
    if ((clip.type !== 'video' && clip.type !== 'audio') && clip.duration.kind === 'sequence-end') {
      // It must start before the end and finish its entrance before the global exit.
      requiredEnd = Math.max(clip.startMs + 1, clip.startMs + transitionDuration(clip.entrance));
    } else {
      requiredEnd = endForClip(sequence, clip);
    }
    if (requiredEnd !== null && requiredEnd !== undefined) durationMs = Math.max(durationMs, requiredEnd);
  }
  if (durationMs === sequence.end.durationMs) return sequence;
  return { ...sequence, end: { ...sequence.end, durationMs } };
}

function fixedEndPreservingExtensions(end: SequenceEnd, durationMs: number): SequenceEnd {
  const known = new Set(['kind', 'durationMs', 'clipId']);
  const extensions = Object.fromEntries(Object.entries(end).filter(([key]) => !known.has(key)));
  return { ...extensions, kind: 'fixed', durationMs } as SequenceEnd;
}

/** Freeze held intervals before calculating the endpoint, avoiding a circular duration. */
function recomputeAutomaticEnd(sequence: SequenceV1): SequenceV1 {
  const oldEnd = sequenceDurationMs(sequence);
  const clips = sequence.clips.map(clip => {
  if ((clip.type === 'video' || clip.type === 'audio') || clip.duration.kind !== 'sequence-end') return clip;
    const milliseconds = typeof oldEnd === 'number'
      ? oldEnd - clip.startMs
      : Math.max(5_000, transitionDuration(clip.entrance) + transitionDuration(clip.exit));
    return fitResizeTransitions({
      ...clip,
      duration: preserveExtensions<SequenceClip['duration']>(
        clip.duration, { kind: 'fixed', milliseconds }, ['kind', 'milliseconds']
      )
    } as SequenceClip, milliseconds);
  });
  let durationMs = 1;
  for (const clip of clips) {
    // Indefinite schema-2 audio inherits the sequence boundary; it does not
    // extend an automatic endpoint by counting itself.
    if (clip.type === 'audio' && clip.duration.kind === 'sequence-end') continue;
    const duration = clip.type === 'audio' ? audioDurationMs(clip) : clip.type === 'video' ? mediaDurationMs(clip) : clip.duration.kind === 'fixed' ? clip.duration.milliseconds : undefined;
    if (duration === undefined) commandError(clip.type === 'audio' ? 'AUDIO_METADATA_REQUIRED' : 'VIDEO_METADATA_REQUIRED', 'Inspect the media duration before editing its timeline.');
    durationMs = Math.max(durationMs, clip.startMs + duration);
  }
  return {
    ...sequence, clips,
    end: { ...fixedEndPreservingExtensions(sequence.end, durationMs), kind: 'fixed', durationMs, automatic: true }
  };
}

/** Explicit, immutable opt-in; loading or validating a legacy sequence never changes its policy. */
export function enableAutomaticEnd(sequence: SequenceV1): SequenceV1 {
  return assertTimelineIsValid(recomputeAutomaticEnd(validateSequence(sequence)));
}

function insertClip(sequence: SequenceV1, clip: SequenceClip): SequenceV1 {
  const withClip = { ...sequence, clips: [...sequence.clips, clip] };
  return ensureFixedEnd(withClip, [clip]);
}

function safeEndAfterRemovingMedia(sequence: SequenceV1, remaining: readonly SequenceClip[]): number {
  let durationMs = 5_000;
  for (const clip of remaining) {
    if ((clip.type !== 'video' && clip.type !== 'audio') && clip.duration.kind === 'sequence-end') {
      durationMs = Math.max(durationMs, clip.startMs + transitionDuration(clip.entrance) + 1);
      continue;
    }
    const end = endForClip(sequence, clip);
    if (end !== null && end !== undefined) durationMs = Math.max(durationMs, end);
  }
  return durationMs;
}

function newDefaultClip(
  type: SequenceClip['type'], trackId: string, startMs: number,
  id: string, sourcePath?: string, sourceDurationMs?: number, schemaVersion: 1 | 2 | 3 = 1,
  composition: SequenceV1['composition'] = { width: 1920, height: 1080 }
): SequenceClip {
  if (type === 'button') return { id, trackId, type, typeVersion: 1, startMs,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: structuredClone(ENTRANCE), exit: structuredClone(ENTRANCE),
    properties: defaultButtonProperties(composition) };
  if (type === 'bars') {
    const clip: BarsClip = {
      id, trackId, type, typeVersion: 1, startMs,
      duration: { kind: 'sequence-end' }, entrance: structuredClone(ENTRANCE), exit: structuredClone(NO_TRANSITION),
      properties: { heightFraction: 0.12, color: '#000000' }
    };
    return clip;
  }
  if (type === 'text') {
    const clip: TextClip = {
      id, trackId, type, typeVersion: 1, startMs,
      duration: { kind: 'fixed', milliseconds: 5_000 },
      entrance: structuredClone(ENTRANCE),
      exit: { preset: 'fade', version: 1, durationMs: 800, easing: 'ease-in-out' },
      properties: {
        text: 'Title', fontFamily: 'Signika', fontSize: 96, minimumFontSize: 36,
        color: '#ffffff', align: 'center', box: { x: 192, y: 378, width: 1536, height: 324 }, shrinkToFit: true
      }
    };
    return clip;
  }
  if (type === 'solid') {
    const clip: SolidClip = {
      id, trackId, type, typeVersion: 1, startMs,
      duration: { kind: 'fixed', milliseconds: 5_000 },
      entrance: structuredClone(ENTRANCE), exit: structuredClone(ENTRANCE),
      properties: {
        color: '#ffffff', fit: 'cover',
        box: { x: 0, y: 0, width: composition.width, height: composition.height },
        crop: { x: 0, y: 0, width: 1, height: 1 },
        mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
      }
    };
    return clip;
  }
  if (sourcePath === undefined || sourcePath.trim().length === 0) {
    return commandError(type === 'image' ? 'IMAGE_SOURCE_REQUIRED' : type === 'audio' ? 'AUDIO_SOURCE_REQUIRED' : 'VIDEO_SOURCE_REQUIRED', 'Choose a media file before adding a clip.');
  }
  if (type === 'image') {
    const clip: ImageClip = {
      id, trackId, type, typeVersion: 1, startMs,
      duration: { kind: 'fixed', milliseconds: 5_000 },
      entrance: structuredClone(ENTRANCE), exit: structuredClone(ENTRANCE),
      properties: {
        source: { kind: 'foundry-file', path: sourcePath }, fit: 'cover',
        box: { x: 0, y: 0, width: composition.width, height: composition.height },
        crop: { x: 0, y: 0, width: 1, height: 1 },
        mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
      }
    };
    return clip;
  }
  if (sourceDurationMs === undefined) {
    return commandError(type === 'audio' ? 'AUDIO_METADATA_REQUIRED' : 'VIDEO_METADATA_REQUIRED', 'Inspect the media duration before adding a clip.');
  }
  if (type === 'audio') {
    const clip: AudioClip = {
      id, trackId, type, typeVersion: schemaVersion >= 2 ? 3 : 2, startMs, duration: { kind: 'fixed', milliseconds: sourceDurationMs },
      entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
      properties: {
        source: { kind: 'foundry-file', path: sourcePath }, volume: 1, muted: false, durationMs: sourceDurationMs,
        ...(schemaVersion >= 2 ? { loop: false, onBreak: 'pause' as const } : {})
      }
    };
    return clip;
  }
  const clip: VideoClip = {
    id, trackId, type, typeVersion: schemaVersion >= 2 ? 5 : 1, startMs,
    duration: { kind: 'media' },
    entrance: structuredClone(NO_TRANSITION), exit: structuredClone(NO_TRANSITION),
    properties: {
      source: { kind: 'foundry-file', path: sourcePath }, fit: 'contain', volume: 1, muted: false,
      durationMs: sourceDurationMs,
      ...(schemaVersion >= 2 ? { onBreak: 'pause' as const } : {})
    }
  };
  return clip;
}

function preserveExtensions<T extends object>(oldValue: T | undefined, newValue: T, knownFields: readonly string[]): T {
  if (!oldValue) return structuredClone(newValue);
  const known = new Set(knownFields);
  const extensions = Object.fromEntries(Object.entries(oldValue).filter(([key]) => !known.has(key)));
  return { ...extensions, ...structuredClone(newValue) } as T;
}

const TRANSITION_FIELDS = ['preset', 'version', 'durationMs', 'easing', 'direction', 'distance', 'scale',
  'motion', 'amount', 'stagger', 'motionDirection', 'motionOrder'] as const;

function mergedReplacement(oldClip: SequenceClip, newClip: SequenceClip): SequenceClip {
  const clipFields = ['id', 'trackId', 'type', 'typeVersion', 'startMs', 'duration', 'entrance', 'exit', 'appearance', 'properties'];
  const merged: Record<string, unknown> = {
    ...preserveExtensions(oldClip, newClip, clipFields),
    entrance: preserveExtensions(oldClip.entrance, newClip.entrance, TRANSITION_FIELDS),
    exit: preserveExtensions(oldClip.exit, newClip.exit, TRANSITION_FIELDS),
    duration: preserveExtensions(oldClip.duration, newClip.duration, ['kind', 'milliseconds']),
    properties: preserveExtensions(oldClip.properties, newClip.properties,
      oldClip.type === 'video'
        ? ['source', 'fit', 'volume', 'muted', 'durationMs', 'sourceRange', 'loop', 'keying', 'onBreak', 'box']
        : oldClip.type === 'audio'
          ? ['source', 'volume', 'muted', 'durationMs', 'sourceRange', 'loop', 'loopIndefinitely', 'onBreak']
        : oldClip.type === 'bars'
          ? ['heightFraction', 'color']
          : oldClip.type === 'button'
            ? ['label', 'fontFamily', 'fontSize', 'color', 'backgroundColor', 'box', 'shape', 'texture', 'action', 'outline', 'shadow', 'glow']
          : oldClip.type === 'solid'
            ? ['color', 'alphaMap', 'fit', 'box', 'crop', 'mask', 'outline', 'shadow', 'glow']
          : oldClip.type === 'image'
            ? ['source', 'fit', 'box', 'crop', 'mask', 'outline', 'shadow', 'glow']
          : ['text', 'fontFamily', 'fontSize', 'minimumFontSize', 'color', 'align', 'box', 'shrinkToFit', 'outline', 'shadow', 'glow'])
  };

  if (oldClip.type === 'video' && newClip.type === 'video') {
    merged.properties = {
      ...(merged.properties as Record<string, unknown>),
      source: preserveExtensions(oldClip.properties.source, newClip.properties.source, ['kind', 'path']),
      ...(newClip.properties.box && oldClip.properties.box
        ? { box: preserveExtensions(oldClip.properties.box, newClip.properties.box, ['x', 'y', 'width', 'height']) }
        : {}),
      ...(newClip.properties.keying && oldClip.properties.keying
        ? { keying: preserveExtensions(oldClip.properties.keying, newClip.properties.keying, ['enabled', 'color', 'tolerance', 'softness']) }
        : {}),
      ...(newClip.properties.sourceRange && oldClip.properties.sourceRange
        ? { sourceRange: preserveExtensions(oldClip.properties.sourceRange, newClip.properties.sourceRange, ['inMs', 'outMs']) }
        : {})
    };
  } else if (oldClip.type === 'audio' && newClip.type === 'audio') {
    merged.properties = {
      ...(merged.properties as Record<string, unknown>),
      source: preserveExtensions(oldClip.properties.source, newClip.properties.source, ['kind', 'path']),
      ...(newClip.properties.sourceRange && oldClip.properties.sourceRange
        ? { sourceRange: preserveExtensions(oldClip.properties.sourceRange, newClip.properties.sourceRange, ['inMs', 'outMs']) }
        : {})
    };
  } else if ((oldClip.type === 'text' && newClip.type === 'text') || (oldClip.type === 'image' && newClip.type === 'image')
    || (oldClip.type === 'solid' && newClip.type === 'solid') || (oldClip.type === 'button' && newClip.type === 'button')) {
    const oldProperties = oldClip.properties as (TextClip | ImageClip | SolidClip | ButtonClip)['properties'] & Record<string, unknown>;
    const nextProperties = newClip.properties as (TextClip | ImageClip | SolidClip | ButtonClip)['properties'] & Record<string, unknown>;
    const properties = merged.properties as Record<string, unknown>;
    merged.properties = {
      ...properties,
      box: preserveExtensions(oldProperties.box, nextProperties.box, ['x', 'y', 'width', 'height']),
      ...(oldProperties.outline && nextProperties.outline
        ? { outline: preserveExtensions(oldProperties.outline, nextProperties.outline, ['enabled', 'color', 'opacity', 'width']) }
        : {}),
      ...(oldProperties.shadow && nextProperties.shadow
        ? { shadow: preserveExtensions(oldProperties.shadow, nextProperties.shadow, ['enabled', 'color', 'opacity', 'offsetX', 'offsetY', 'blur']) }
        : {}),
      ...(oldProperties.glow && nextProperties.glow
        ? { glow: preserveExtensions(oldProperties.glow, nextProperties.glow, ['enabled', 'color', 'opacity', 'radius']) }
        : {})
    };
    if (oldClip.type === 'button' && newClip.type === 'button') {
      merged.properties = { ...(merged.properties as Record<string, unknown>),
        action: preserveExtensions(oldClip.properties.action, newClip.properties.action, ['kind', 'decisionId', 'optionId', 'message', 'visibility']),
        ...(oldClip.properties.texture && newClip.properties.texture ? { texture: preserveExtensions(oldClip.properties.texture, newClip.properties.texture, ['kind', 'id', 'path', 'fit']) } : {}) };
    }
    if (oldClip.type === 'image' && newClip.type === 'image') {
      merged.properties = {
        ...(merged.properties as Record<string, unknown>),
        source: preserveExtensions(oldClip.properties.source, newClip.properties.source, ['kind', 'path']),
        crop: preserveExtensions(oldClip.properties.crop, newClip.properties.crop, ['x', 'y', 'width', 'height']),
        mask: newClip.properties.mask.map((point, index) => preserveExtensions(oldClip.properties.mask[index], point, ['x', 'y']))
      };
    } else if (oldClip.type === 'solid' && newClip.type === 'solid') {
      merged.properties = {
        ...(merged.properties as Record<string, unknown>),
        crop: preserveExtensions(oldClip.properties.crop, newClip.properties.crop, ['x', 'y', 'width', 'height']),
        mask: newClip.properties.mask.map((point, index) => preserveExtensions(oldClip.properties.mask[index], point, ['x', 'y'])),
        ...(newClip.properties.alphaMap && oldClip.properties.alphaMap
          ? { alphaMap: preserveExtensions(oldClip.properties.alphaMap, newClip.properties.alphaMap, ['kind', 'path']) }
          : {})
      };
    }
  }
  if (oldClip.appearance && newClip.appearance) {
    merged.appearance = preserveExtensions(oldClip.appearance, newClip.appearance, ['blendMode', 'opacity']);
  }
  return merged as unknown as SequenceClip;
}

function makeTrackOrderForCopy(tracks: readonly SequenceTrack[], sourceTrack: SequenceTrack, id: string): SequenceTrack[] {
  if (tracks.length >= SEQUENCE_LIMITS.tracks) {
    return commandError('TRACK_LIMIT', `A sequence cannot contain more than ${SEQUENCE_LIMITS.tracks} tracks.`);
  }
  // Orders are visual z-order; insert the copy immediately above the source.
  const ordered = [...tracks].sort((left, right) => left.order - right.order);
  const sourceIndex = ordered.findIndex(track => track.id === sourceTrack.id);
  const insertionIndex = sourceIndex + 1;
  const copyTrack: SequenceTrack = {
    id, name: `${sourceTrack.name} Copy`, kind: sourceTrack.kind, order: 0, enabled: true, locked: false
  };
  const result = ordered.map((track, index) => ({ ...track, order: index < insertionIndex ? index : index + 1 }));
  result.splice(insertionIndex, 0, { ...copyTrack, order: insertionIndex });
  return result;
}

function overlapConflicts(sequence: SequenceV1): TimelineConflict[] {
  const conflicts: TimelineConflict[] = [];
  for (const track of sequence.tracks) {
    const clips = sequence.clips.filter(clip => clip.trackId === track.id).sort((a, b) => a.startMs - b.startMs);
    for (let left = 0; left < clips.length; left += 1) {
      const first = clips[left]!;
      const firstDuration = clipDurationMs(sequence, first);
      const firstEnd = firstDuration === null || firstDuration === undefined ? Number.POSITIVE_INFINITY : first.startMs + firstDuration;
      if (firstDuration === undefined) conflicts.push({ code: 'UNKNOWN_DURATION', clipId: first.id, trackId: track.id });
      if (firstEnd <= first.startMs) conflicts.push({ code: 'INVALID_CLIP_DURATION', clipId: first.id, trackId: track.id });
      for (let right = left + 1; right < clips.length; right += 1) {
        const second = clips[right]!;
        if (second.startMs >= firstEnd) break;
        conflicts.push({ code: 'CLIP_OVERLAP', clipId: second.id, trackId: track.id });
      }
    }
  }
  return conflicts;
}

/** Reports structural timeline problems without invoking the playback compiler. */
export function timelineConflicts(sequence: SequenceV1): readonly TimelineConflict[] {
  let validated: SequenceV1;
  try {
    validated = validateSequence(sequence);
  } catch (error) {
    return [{ code: error instanceof SequenceValidationError ? error.code : 'INVALID_SEQUENCE' }];
  }

  const conflicts = overlapConflicts(validated);
  const duration = sequenceDurationMs(validated);
  if (duration === undefined && validated.end.kind === 'media') {
    conflicts.push({ code: 'UNKNOWN_SEQUENCE_END', clipId: validated.end.clipId });
  } else if (duration !== null && duration !== undefined) {
    for (const clip of validated.clips) {
      const end = endForClip(validated, clip);
      if (end === undefined) {
        conflicts.push({ code: 'UNKNOWN_DURATION', clipId: clip.id, trackId: clip.trackId });
      } else if (end === null || end > duration || clip.startMs >= duration) {
        conflicts.push({ code: 'CLIP_BEYOND_SEQUENCE_END', clipId: clip.id, trackId: clip.trackId });
      }
      if (clip.duration.kind === 'sequence-end'
        && clip.startMs + transitionDuration(clip.entrance) > duration) {
        conflicts.push({ code: 'CLIP_BEYOND_SEQUENCE_END', clipId: clip.id, trackId: clip.trackId });
      }
    }
  }
  const unique: TimelineConflict[] = [];
  const seen = new Set<string>();
  for (const conflict of conflicts) {
    const key = `${conflict.code}\u0000${conflict.clipId ?? ''}\u0000${conflict.trackId ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(conflict);
    }
  }
  return unique;
}

function assertTimelineIsValid(sequence: SequenceV1): SequenceV1 {
  const validated = validateSequence(sequence);
  const conflicts = timelineConflicts(validated);
  if (conflicts.length > 0) {
    const first = conflicts[0]!;
    commandError(first.code, `The edit would create timeline conflict "${first.code}".`);
  }
  return validated;
}

function addAfterEnd(sequence: SequenceV1, candidate: SequenceClip): SequenceV1 {
  const duration = clipDurationMs(sequence, candidate);
  if (duration === null || duration === undefined) return sequence;
  return ensureFixedEnd(sequence, [candidate]);
}

function resizeMedia(clip: VideoClip | AudioClip, edge: 'start' | 'end', timeMs: number): VideoClip | AudioClip {
  const sourceDuration = clip.properties.durationMs;
  if (sourceDuration === undefined) {
    return commandError(clip.type === 'audio' ? 'AUDIO_METADATA_REQUIRED' : 'VIDEO_METADATA_REQUIRED', 'Inspect the media duration before trimming it.');
  }
  const oldRange = clip.properties.sourceRange ?? { inMs: 0, outMs: sourceDuration };
  const nextRange = edge === 'start'
    ? { ...oldRange, inMs: oldRange.inMs + (timeMs - clip.startMs) }
    : { ...oldRange, outMs: oldRange.inMs + (timeMs - clip.startMs) };
  const nextStart = edge === 'start' ? timeMs : clip.startMs;
  if (!Number.isSafeInteger(timeMs) || timeMs < 0 || nextRange.inMs < 0 || nextRange.outMs > sourceDuration || nextRange.inMs >= nextRange.outMs) {
    return commandError('INVALID_SOURCE_RANGE', 'The trim must stay within the inspected media source.');
  }
  const untrimmed = nextRange.inMs === 0 && nextRange.outMs === sourceDuration;
  const { sourceRange: _oldRange, ...properties } = clip.properties;
  const nextProperties = untrimmed ? properties : { ...properties, sourceRange: nextRange };
  if (clip.type === 'audio') {
    return fitResizeTransitions({ ...clip, typeVersion: 1, startMs: nextStart, properties: nextProperties } as AudioClip,
      nextRange.outMs - nextRange.inMs) as AudioClip;
  }
  return {
    ...clip,
    typeVersion: videoTypeVersion(nextProperties, clip.typeVersion),
    startMs: nextStart,
    properties: nextProperties
  } as VideoClip;
}

type ResizableAudioClip = AudioClipV2 | (Omit<AudioClipV3, 'duration'> & { readonly duration: { readonly kind: 'fixed'; readonly milliseconds: number } });

function isResizableAudioClip(clip: AudioClip): clip is ResizableAudioClip {
  return clip.typeVersion === 2 || clip.typeVersion === 3 && clip.duration.kind === 'fixed';
}

function resizeAuthoredAudio(clip: ResizableAudioClip, edge: 'start' | 'end', timeMs: number): AudioClip {
  const oldEnd = clip.startMs + clip.duration.milliseconds;
  const nextStart = edge === 'start' ? timeMs : clip.startMs;
  const nextEnd = edge === 'end' ? timeMs : oldEnd;
  const milliseconds = nextEnd - nextStart;
  if (milliseconds <= 0) return commandError('INVALID_DURATION', 'A clip must end after it starts.');
  let properties = clip.properties;
  if (properties.loop !== true) {
    const sourceDuration = properties.durationMs;
    if (sourceDuration === undefined) return commandError('AUDIO_METADATA_REQUIRED', 'Inspect the media duration before trimming it.');
    const oldRange = properties.sourceRange ?? { inMs: 0, outMs: sourceDuration };
    const nextRange = edge === 'start' ? { ...oldRange, inMs: oldRange.inMs + nextStart - clip.startMs } : oldRange;
    if (nextRange.inMs < 0 || nextRange.inMs >= nextRange.outMs || milliseconds > nextRange.outMs - nextRange.inMs) {
      return commandError('INVALID_SOURCE_RANGE', 'Audio without looping must stay within its selected source interval.');
    }
    if (edge === 'start') properties = { ...properties, sourceRange: nextRange };
  }
  return fitResizeTransitions({
    ...clip, startMs: nextStart, duration: { ...clip.duration, milliseconds }, properties
  }, milliseconds) as AudioClip;
}

function resizeClip(clip: SequenceClip, sequence: SequenceV1, edge: 'start' | 'end', timeMs: number): SequenceClip {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs > SEQUENCE_LIMITS.timelineMs) {
    return commandError('INVALID_TIME', 'Timeline positions must be whole milliseconds within the supported range.');
  }
  if (clip.type === 'audio' && clip.duration.kind === 'sequence-end') {
    return commandError('INDEFINITE_AUDIO_NOT_RESIZABLE', 'Indefinite audio ends with the sequence and cannot be trimmed.');
  }
  if (clip.type === 'audio' && isResizableAudioClip(clip)) {
    return resizeAuthoredAudio(clip, edge, timeMs);
  }
  if ((clip.type === 'video' || clip.type === 'audio')) return resizeMedia(clip, edge, timeMs);

  if (clip.duration.kind === 'sequence-end') {
    if (edge === 'end') {
      if (timeMs <= clip.startMs) return commandError('INVALID_DURATION', 'A clip must end after it starts.');
      return fitResizeTransitions({
        ...clip,
        duration: preserveExtensions<SequenceClip['duration']>(
          clip.duration, { kind: 'fixed', milliseconds: timeMs - clip.startMs }, ['kind', 'milliseconds']
        )
      } as SequenceClip, timeMs - clip.startMs);
    }
    if (sequence.end.kind === 'fixed' && timeMs >= sequence.end.durationMs) {
      return commandError('INVALID_TIME', 'A sequence-end clip must start before the sequence end.');
    }
    return { ...clip, startMs: timeMs };
  }

  const oldEnd = clip.startMs + clip.duration.milliseconds;
  const newStart = edge === 'start' ? timeMs : clip.startMs;
  const newEnd = edge === 'end' ? timeMs : oldEnd;
  if (newEnd <= newStart) return commandError('INVALID_DURATION', 'A clip must end after it starts.');
  return fitResizeTransitions({
    ...clip,
    startMs: newStart,
    duration: { ...clip.duration, milliseconds: newEnd - newStart }
  } as SequenceClip, newEnd - newStart);
}

/** A trim keeps transition proportions while permitting a clip as short as one millisecond. */
function fitResizeTransitions(clip: SequenceClip, durationMs: number): SequenceClip {
  const entranceMs = transitionDuration(clip.entrance);
  const exitMs = transitionDuration(clip.exit);
  const total = entranceMs + exitMs;
  if (total <= durationMs) return clip;
  const fittedEntrance = Math.round(durationMs * entranceMs / total);
  const fit = (transition: Transition, milliseconds: number): Transition => milliseconds === 0
    ? preserveExtensions(transition, NO_TRANSITION, TRANSITION_FIELDS)
    : transition.preset !== 'none' ? { ...transition, durationMs: milliseconds } : transition;
  return { ...clip, entrance: fit(clip.entrance, fittedEntrance), exit: fit(clip.exit, durationMs - fittedEntrance) } as SequenceClip;
}

function sameTrackDuplicate(sequence: SequenceV1, candidate: SequenceClip): SequenceV1 | null {
  const test = ensureFixedEnd({ ...sequence, clips: [...sequence.clips, candidate] }, [candidate]);
  return timelineConflicts(test).length === 0 ? test : null;
}

/** Applies one immutable edit and returns a validated, isolated sequence clone. */
export function applyTimelineCommand(
  sequence: SequenceV1,
  command: TimelineCommand,
  makeId: () => string
): SequenceV1 {
  let source = validateSequence(sequence);
  if ((command.kind === 'add-clip' && command.type === 'button') || (command.kind === 'insert-clip' && command.clip.type === 'button')) source = withButtonProgression(source);
  let next: SequenceV1 = source;

  switch (command.kind) {
    case 'add-track': {
      if (source.tracks.length >= SEQUENCE_LIMITS.tracks) {
        commandError('TRACK_LIMIT', `A sequence cannot contain more than ${SEQUENCE_LIMITS.tracks} tracks.`);
      }
      const highestOrder = Math.max(...source.tracks.map(track => track.order));
      const tracks = highestOrder + 1 >= SEQUENCE_LIMITS.tracks
        ? [...source.tracks]
            .sort((left, right) => left.order - right.order)
            .map((track, order) => ({ ...track, order }))
        : [...source.tracks];
      const order = highestOrder + 1 >= SEQUENCE_LIMITS.tracks ? tracks.length : highestOrder + 1;
      const trackKind = command.trackKind ?? 'visual';
      const name = command.name ?? `${trackKind === 'audio' ? 'Audio' : 'Visual'} ${source.tracks.length + 1}`;
      next = {
        ...source,
        tracks: [...tracks, { id: makeId(), name, kind: trackKind, order, enabled: true, locked: false }]
      };
      break;
    }
    case 'rename-track': {
      const track = findTrack(source, command.trackId);
      requireEditableTrack(track);
      next = { ...source, tracks: source.tracks.map(item => item.id === track.id ? { ...item, name: command.name } : item) };
      break;
    }
    case 'move-track': {
      const track = findTrack(source, command.trackId);
      requireEditableTrack(track);
      const ordered = [...source.tracks].sort((left, right) => left.order - right.order);
      const index = ordered.findIndex(item => item.id === track.id);
      const neighborIndex = index + (command.direction === 'up' ? 1 : -1);
      const neighbor = ordered[neighborIndex];
      if (neighbor && neighbor.locked) requireEditableTrack(neighbor);
      if (neighbor) {
        next = {
          ...source,
          tracks: source.tracks.map(item => item.id === track.id
            ? { ...item, order: neighbor.order }
            : item.id === neighbor.id ? { ...item, order: track.order } : item)
        };
      }
      break;
    }
    case 'toggle-track': {
      const track = findTrack(source, command.trackId);
      if (command.property === 'locked') {
        next = { ...source, tracks: source.tracks.map(item => item.id === track.id ? { ...item, locked: !item.locked } : item) };
      } else {
        requireEditableTrack(track);
        next = { ...source, tracks: source.tracks.map(item => item.id === track.id ? { ...item, enabled: !item.enabled } : item) };
      }
      break;
    }
    case 'remove-track': {
      const track = findTrack(source, command.trackId);
      requireEditableTrack(track);
      if (source.clips.some(clip => clip.trackId === track.id)) {
        commandError('TRACK_NOT_EMPTY', `Track "${track.id}" still contains clips.`);
      }
      if (source.tracks.length === 1) commandError('LAST_TRACK', 'A sequence must retain at least one track.');
      const remaining = source.tracks.filter(item => item.id !== track.id).sort((left, right) => left.order - right.order);
      const orderById = new Map(remaining.map((item, index) => [item.id, index]));
      next = {
        ...source,
        tracks: source.tracks.filter(item => item.id !== track.id).map(item => ({ ...item, order: orderById.get(item.id)! }))
      };
      break;
    }
    case 'add-clip': {
      const track = findTrack(source, command.trackId);
      requireEditableTrack(track);
      requireCompatibleTrack(track, command.type);
      let clip = newDefaultClip(command.type, track.id, command.startMs, makeId(), command.sourcePath, command.sourceDurationMs, getPlaybackSchemaVersion(source), source.composition);
      if (clip.type === 'bars' && source.end.kind === 'fixed' && source.end.automatic === true) {
        clip = { ...clip, duration: { kind: 'fixed', milliseconds: 5_000 } };
      }
      const inserted = insertClip(source, clip);
      next = (clip.type === 'video' || clip.type === 'audio') ? inserted : addAfterEnd(inserted, clip);
      break;
    }
    case 'insert-clip': {
      const clip = structuredClone(command.clip);
      const track = findTrack(source, clip.trackId);
      requireEditableTrack(track);
      requireCompatibleTrack(track, clip.type);
      if (source.clips.some(existing => existing.id === clip.id)) commandError('DUPLICATE_ID', 'An inserted clip must have a new identity.');
      const inserted = insertClip(source, clip);
      next = (clip.type === 'video' || clip.type === 'audio') ? inserted : addAfterEnd(inserted, clip);
      break;
    }
    case 'duplicate-clip': {
      const clip = findClip(source, command.clipId);
      const sourceTrack = findTrack(source, clip.trackId);
      requireEditableTrack(sourceTrack);
      const duration = clipDurationMs(source, clip);
      const copyId = makeId();
      const sameTrackStart = duration === null || duration === undefined ? Number.NaN : clip.startMs + duration;
      const copiedClip = structuredClone(clip);
      if (copiedClip.type === 'button' && copiedClip.properties.action.kind === 'choice') {
        (copiedClip.properties as { action: typeof copiedClip.properties.action }).action = { ...copiedClip.properties.action, optionId: makeId() };
      }
      const sameTrackCopy = { ...copiedClip, id: copyId, startMs: sameTrackStart } as SequenceClip;
      const sameTrackSequence = Number.isSafeInteger(sameTrackStart) && sameTrackStart <= SEQUENCE_LIMITS.timelineMs
        ? sameTrackDuplicate(source, sameTrackCopy)
        : null;
      if (sameTrackSequence) {
        next = sameTrackSequence;
      } else {
        const copyTrackId = makeId();
        const tracks = makeTrackOrderForCopy(source.tracks, sourceTrack, copyTrackId);
        const otherTrackCopy = { ...copiedClip, id: copyId, trackId: copyTrackId, startMs: clip.startMs } as SequenceClip;
        next = ensureFixedEnd({ ...source, tracks, clips: [...source.clips, otherTrackCopy] }, [otherTrackCopy]);
      }
      break;
    }
    case 'remove-clip': {
      const clip = findClip(source, command.clipId);
      requireEditableTrack(findTrack(source, clip.trackId));
      const clips = source.clips.filter(item => item.id !== clip.id);
      let end = source.end;
      if (source.end.kind === 'media' && source.end.clipId === clip.id) {
        end = fixedEndPreservingExtensions(source.end, safeEndAfterRemovingMedia(source, clips));
      }
      next = { ...source, clips, end };
      break;
    }
    case 'move-clip': {
      const clip = findClip(source, command.clipId);
      requireEditableTrack(findTrack(source, clip.trackId));
      const destination = findTrack(source, command.trackId);
      requireEditableTrack(destination);
      requireCompatibleTrack(destination, clip.type);
      let moved = { ...clip, trackId: destination.id, startMs: command.startMs } as SequenceClip;
      if (command.startMs !== clip.startMs && (clip.type !== 'video' && clip.type !== 'audio') && clip.duration.kind === 'sequence-end') {
        const duration = clipDurationMs(source, clip);
        // A body move translates the resolved interval; only a trim changes its length.
        if (typeof duration === 'number' && Number.isFinite(duration)) {
          moved = {
            ...moved,
            duration: preserveExtensions<SequenceClip['duration']>(
              clip.duration, { kind: 'fixed', milliseconds: duration }, ['kind', 'milliseconds']
            )
          } as SequenceClip;
        }
      }
      next = ensureFixedEnd({ ...source, clips: source.clips.map(item => item.id === clip.id ? moved : item) }, [moved]);
      break;
    }
    case 'resize-clip': {
      const clip = findClip(source, command.clipId);
      requireEditableTrack(findTrack(source, clip.trackId));
      const resized = resizeClip(clip, source, command.edge, command.timeMs);
      const changed = source.clips.map(item => item.id === clip.id ? resized : item);
      next = { ...source, clips: changed };
      next = ensureFixedEnd(next, [resized]);
      break;
    }
    case 'replace-clip': {
      const clip = findClip(source, command.clip.id);
      requireEditableTrack(findTrack(source, clip.trackId));
      if (command.clip.id !== clip.id) commandError('CLIP_ID_IMMUTABLE', 'A replacement must keep the existing clip ID.');
      const replacement = mergedReplacement(clip, command.clip);
      requireEditableTrack(findTrack(source, replacement.trackId));
      requireCompatibleTrack(findTrack(source, replacement.trackId), replacement.type);
      next = ensureFixedEnd({ ...source, clips: source.clips.map(item => item.id === clip.id ? replacement : item) }, [replacement]);
      break;
    }
    case 'add-break': {
      requireBreakPosition(command.positionMs);
      if (getPlaybackSchemaVersion(source) === 1) {
        commandError('BREAKS_UPGRADE_REQUIRED', 'Adopt break behavior before adding inner Break markers.');
      }
      let markerSequence = getPlaybackSchemaVersion(source) === 2 ? upgradeSequenceToTimelineBreaks(source) : source;
      const breaks = markerSequence.breaks ?? [];
      if (breaks.length >= SEQUENCE_LIMITS.breaks) commandError('BREAK_LIMIT', `A sequence cannot contain more than ${SEQUENCE_LIMITS.breaks} inner Break markers.`);
      requireUniqueBreakPosition(markerSequence, command.positionMs);
      next = { ...markerSequence, breaks: [...breaks, { id: makeId(), positionMs: command.positionMs }] };
      break;
    }
    case 'move-break': {
      const marker = findBreak(source, command.breakId);
      requireBreakPosition(command.positionMs);
      requireUniqueBreakPosition(source, command.positionMs, marker.id);
      next = { ...source, breaks: source.breaks!.map(item => item.id === marker.id ? { ...item, positionMs: command.positionMs } : item) };
      break;
    }
    case 'remove-break': {
      const marker = findBreak(source, command.breakId);
      next = { ...source, breaks: source.breaks!.filter(item => item.id !== marker.id) };
      break;
    }
    case 'set-end': {
      next = { ...source, end: structuredClone(command.end) };
      break;
    }
  }

  if (next.end.kind === 'fixed' && next.end.automatic === true) next = recomputeAutomaticEnd(next);
  return assertTimelineIsValid(next);
}

function replacementChangesTiming(oldClip: SequenceClip, newClip: SequenceClip): boolean {
  if (oldClip.type !== newClip.type || oldClip.startMs !== newClip.startMs) return true;
  // Audio source settings and representation may change without moving its
  // authored interval. A v1-to-v2 upgrade must not opt the sequence into Auto.
  if (oldClip.type === 'audio' && newClip.type === 'audio') {
    return audioDurationMs(oldClip) !== audioDurationMs(newClip);
  }
  if (oldClip.duration.kind !== newClip.duration.kind) return true;
  if (oldClip.duration.kind === 'fixed' && newClip.duration.kind === 'fixed'
    && oldClip.duration.milliseconds !== newClip.duration.milliseconds) return true;
  if (oldClip.type === 'video' && newClip.type === 'video') {
    return oldClip.properties.durationMs !== newClip.properties.durationMs
      || oldClip.properties.sourceRange?.inMs !== newClip.properties.sourceRange?.inMs
      || oldClip.properties.sourceRange?.outMs !== newClip.properties.sourceRange?.outMs;
  }
  return false;
}

function changesClipTiming(sequence: SequenceV1, command: TimelineCommand): boolean {
  switch (command.kind) {
    case 'add-clip': case 'insert-clip': case 'duplicate-clip': case 'remove-clip': return true;
    case 'move-clip': return findClip(sequence, command.clipId).startMs !== command.startMs;
    case 'resize-clip': {
      const clip = findClip(sequence, command.clipId);
      return (command.edge === 'start' ? clip.startMs : endForClip(sequence, clip)) !== command.timeMs;
    }
    case 'replace-clip': return replacementChangesTiming(findClip(sequence, command.clip.id), command.clip);
    default: return false;
  }
}

/** Keep conversion's fitted transitions when the inspector still contains the old settings. */
function convertedInspectorTransition(original: Transition, requested: Transition, frozen: Transition): Transition {
  const unchanged = original.preset === requested.preset && original.version === requested.version
    && (original.preset === 'none' || (requested.preset !== 'none'
      && original.durationMs === requested.durationMs && original.easing === requested.easing));
  if (!unchanged) return requested;
  const known = new Set<string>(TRANSITION_FIELDS);
  const extensions = Object.fromEntries(Object.entries(requested).filter(([key]) => !known.has(key)));
  if (frozen.preset === 'none' || requested.preset === 'none') return { ...frozen, ...extensions } as Transition;
  // Fitted timing belongs to the conversion, while the current inspector's
  // motion parameters (including removed overrides) belong to this edit.
  return { ...requested, durationMs: frozen.durationMs };
}

/** Editor timing gestures opt legacy timelines in once, as part of the same undoable edit. */
export function applyEditorTimelineCommand(sequence: SequenceV1, command: TimelineCommand, makeId: () => string): SequenceV1 {
  const source = validateSequence(sequence);
  const legacy = source.end.kind === 'media' || (source.end.kind === 'fixed' && source.end.automatic === undefined);
  const timingEdit = changesClipTiming(source, command);
  let conversionSource = source;
  if (legacy && timingEdit && command.kind === 'replace-clip' && (command.clip.type === 'video' || command.clip.type === 'audio')
    && command.clip.properties.durationMs !== undefined) {
    const original = findClip(source, command.clip.id);
    if ((original.type === 'video' || original.type === 'audio') && mediaDurationMs(original) === undefined) {
      requireEditableTrack(findTrack(source, original.trackId));
      requireEditableTrack(findTrack(source, command.clip.trackId));
      // A successful inspection supplies the previously unknown interval. Validate that
      // metadata first, then resolve held clips at the original timeline position.
      const inspected = mergedReplacement(original, command.clip);
      conversionSource = validateSequence({
        ...source,
        clips: source.clips.map(clip => clip.id === original.id
          ? { ...inspected, startMs: original.startMs, trackId: original.trackId }
          : clip)
      });
    }
  }
  const base = legacy && timingEdit ? enableAutomaticEnd(conversionSource) : source;
  if (command.kind === 'insert-clip') {
    const prepared = command.clip;
    // Prepared elements use the same validation/end policy, but can move to a
    // free lane on collision without ever inserting a temporary default clip.
    const insert = (target: SequenceV1, trackId: string) => applyTimelineCommand(target,
      { kind: 'insert-clip', clip: { ...prepared, trackId } }, makeId);
    const candidates = [prepared.trackId, ...[...base.tracks]
      .sort((a, b) => a.order - b.order)
      .filter(track => !track.locked && track.kind === (prepared.type === 'audio' ? 'audio' : 'visual') && track.id !== prepared.trackId)
      .map(track => track.id)];
    for (const trackId of candidates) {
      try { return insert(base, trackId); }
      catch (error) { if (!(error instanceof TimelineCommandError) || error.code !== 'CLIP_OVERLAP') throw error; }
    }
    const expanded = applyTimelineCommand(base, { kind: 'add-track', trackKind: command.clip.type === 'audio' ? 'audio' : 'visual' }, makeId);
    const track = expanded.tracks.find(item => !base.tracks.some(previous => previous.id === item.id))!;
    return insert(expanded, track.id);
  }
  // Inspector timing edits may still carry the held duration from the pre-conversion form.
  if (legacy && timingEdit && command.kind === 'replace-clip' && (command.clip.type !== 'video' && command.clip.type !== 'audio') && command.clip.duration.kind === 'sequence-end') {
    const frozen = findClip(base, command.clip.id);
    if (frozen.type !== 'video' && frozen.duration.kind === 'fixed') {
      const original = findClip(source, command.clip.id);
      command = { ...command, clip: {
        ...command.clip, duration: { ...command.clip.duration, ...frozen.duration },
        entrance: convertedInspectorTransition(original.entrance, command.clip.entrance, frozen.entrance),
        exit: convertedInspectorTransition(original.exit, command.clip.exit, frozen.exit)
      } };
    }
  }
  if (command.kind === 'replace-clip' && (command.clip.type !== 'video' && command.clip.type !== 'audio') && command.clip.duration.kind === 'fixed') {
    const previousDuration = clipDurationMs(source, findClip(source, command.clip.id));
    if (typeof previousDuration === 'number' && command.clip.duration.milliseconds < previousDuration) {
      command = { ...command, clip: fitResizeTransitions(command.clip, command.clip.duration.milliseconds) };
    }
  }
  if (command.kind === 'replace-clip' && command.clip.type === 'audio') {
    const previousDuration = clipDurationMs(source, findClip(source, command.clip.id));
    const duration = audioDurationMs(command.clip);
    if (typeof previousDuration === 'number' && duration !== undefined && duration < previousDuration) {
      command = { ...command, clip: fitResizeTransitions(command.clip, duration) };
    }
  }
  try {
    return applyTimelineCommand(base, command, makeId);
  } catch (error) {
    const placementEdit = command.kind === 'move-clip'
      ? findClip(source, command.clipId).trackId !== command.trackId
      : command.kind === 'replace-clip' && findClip(source, command.clip.id).trackId !== command.clip.trackId;
    if (!(error instanceof TimelineCommandError) || error.code !== 'CLIP_OVERLAP' || (!timingEdit && !placementEdit)
      || (command.kind !== 'move-clip' && command.kind !== 'resize-clip' && command.kind !== 'replace-clip')) throw error;
  }

  const clipId = command.kind === 'replace-clip' ? command.clip.id : command.clipId;
  const original = findClip(base, clipId);
  const requestedTrackId = command.kind === 'move-clip' ? command.trackId
    : command.kind === 'replace-clip' ? command.clip.trackId : original.trackId;
  const onTrack = (target: SequenceV1, trackId: string): SequenceV1 => {
    if (command.kind === 'move-clip') return applyTimelineCommand(target, { ...command, trackId }, makeId);
    if (command.kind === 'replace-clip') {
      return applyTimelineCommand(target, { ...command, clip: { ...command.clip, trackId } }, makeId);
    }
    const relocated = { ...target, clips: target.clips.map(clip => clip.id === clipId ? { ...clip, trackId } : clip) };
    return applyTimelineCommand(relocated, command, makeId);
  };
  const available = [...base.tracks].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const requestedType = command.kind === 'replace-clip' ? command.clip.type : original.type;
  const trackKind = requestedType === 'audio' ? 'audio' : 'visual';
  for (const track of available) {
    if (track.kind !== trackKind || track.locked || track.id === original.trackId || track.id === requestedTrackId) continue;
    try {
      return onTrack(base, track.id);
    } catch (error) {
      if (!(error instanceof TimelineCommandError) || error.code !== 'CLIP_OVERLAP') throw error;
    }
  }
  // If the requested track is occupied, retain the original track before allocating a new one.
  if (original.trackId !== requestedTrackId && findTrack(base, original.trackId).kind === trackKind) {
    try {
      return onTrack(base, original.trackId);
    } catch (error) {
      if (!(error instanceof TimelineCommandError) || error.code !== 'CLIP_OVERLAP') throw error;
    }
  }
  const expanded = applyTimelineCommand(base, { kind: 'add-track', trackKind }, makeId);
  const added = expanded.tracks.find(track => !base.tracks.some(existing => existing.id === track.id))!;
  // Collision lanes appear below the existing rows in both the ghost and committed view.
  // Preserve existing relative stacking while assigning bounded, contiguous orders.
  const existing = [...base.tracks].sort((a, b) => a.order - b.order);
  const orders = new Map(existing.map((track, index) => [track.id, index + 1]));
  const withBottomTrack = {
    ...expanded,
    tracks: expanded.tracks.map(track => ({ ...track, order: track.id === added.id ? 0 : orders.get(track.id)! }))
  };
  return onTrack(withBottomTrack, added.id);
}

