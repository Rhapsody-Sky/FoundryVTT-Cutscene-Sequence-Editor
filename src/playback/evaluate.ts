import { getPlaybackSchemaVersion } from '../domain/sequence-audience.js';
import { animatedPatternClock } from './pattern-clock.js';
import type { SequenceClip, VisualClip, SequenceV1, Transition } from '../domain/sequence.js';
import { validateSequence, SequenceValidationError } from '../domain/validation.js';
import { audioDurationMs, audioLoopSettings, clipDurationMs, mediaDurationMs, sequenceDurationMs, videoDurationMs } from '../domain/clip-timing.js';
import { evaluateEasing, transitionChangesBarsReveal, transitionChangesOpacity, transitionChangesTextPosition,
  transitionChangesTextScale, transitionDurationMs } from '../domain/transitions.js';

export interface CompiledSequence {
  /** A validated, deeply frozen copy. Later editor changes cannot affect a run. */
  readonly snapshot: Readonly<SequenceV1>;
  /** Null is the legacy open manual timeline; schema 2 manual sequences have a finite end Break. */
  readonly durationMs: number | null;
  /** Enabled elements, ordered back to front and then by time within each track. */
  readonly clips: readonly SequenceClip[];
  /** Sorted active inner holds, followed by the implicit manual endpoint hold. */
  readonly breaks: readonly CompiledBreak[];
}

export interface CompiledBreak {
  readonly id: string;
  readonly positionMs: number;
  readonly kind: 'inner' | 'terminal';
}

/** A completed hold records only active media-clock time, never ordinary paused time. */
export interface BreakHistoryEntry {
  readonly id: string;
  readonly positionMs: number;
  readonly elapsedMs: number;
}

/** Immutable timeline and media-clock checkpoint; safe to persist in the session ledger. */
export interface PlaybackClockAnchor {
  readonly phase: 'playing' | 'holding' | 'paused' | 'exiting';
  readonly positionMs: number;
  readonly atMs: number;
  readonly exitDurationMs?: number;
  readonly holdElapsedMs?: number;
  readonly pausedFrom?: 'holding';
  readonly exitFrom?: 'holding' | 'paused-holding' | 'paused';
  readonly breakId?: string;
  readonly breakHistory?: readonly BreakHistoryEntry[];
}

/** Validate and copy author-independent clock history before replacing a healthy run. */
export function copyPlaybackAnchor(anchor: PlaybackClockAnchor): PlaybackClockAnchor {
  if (!anchor || typeof anchor !== 'object') throw new TypeError('Playback anchor must be an object.');
  if (!['playing', 'holding', 'paused', 'exiting'].includes(anchor.phase)) throw new TypeError('Invalid playback anchor phase.');
  if (!Number.isFinite(anchor.positionMs) || anchor.positionMs < 0) throw new RangeError('Playback anchor position must be a finite, non-negative number.');
  if (!Number.isFinite(anchor.atMs) || anchor.atMs < 0) throw new RangeError('Playback anchor time must be a finite, non-negative number.');
  if (anchor.exitDurationMs !== undefined && (!Number.isFinite(anchor.exitDurationMs) || anchor.exitDurationMs < 0)) throw new RangeError('Invalid exit duration.');
  if (anchor.holdElapsedMs !== undefined && (!Number.isFinite(anchor.holdElapsedMs) || anchor.holdElapsedMs < 0 || anchor.holdElapsedMs > Number.MAX_SAFE_INTEGER)) throw new RangeError('Holding clock must be finite and non-negative.');
  const holding = anchor.phase === 'holding' || anchor.pausedFrom === 'holding' || anchor.exitFrom === 'holding' || anchor.exitFrom === 'paused-holding';
  if (anchor.pausedFrom !== undefined && (anchor.phase !== 'paused' || anchor.pausedFrom !== 'holding')) throw new TypeError('Invalid paused holding anchor.');
  if (anchor.exitFrom !== undefined && (anchor.phase !== 'exiting' || !['holding', 'paused-holding', 'paused'].includes(anchor.exitFrom))) throw new TypeError('Invalid exit origin.');
  if (anchor.holdElapsedMs !== undefined && !holding) throw new TypeError('Holding clock requires a holding phase.');
  if (anchor.breakId !== undefined && (!holding || typeof anchor.breakId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(anchor.breakId))) throw new TypeError('Invalid current Break ID.');
  let history: readonly BreakHistoryEntry[] | undefined;
  if (anchor.breakHistory !== undefined) {
    if (!Array.isArray(anchor.breakHistory) || anchor.breakHistory.length > 128) throw new TypeError('Invalid Break history.');
    const ids = new Set<string>();
    let previous = -1;
    history = Object.freeze(anchor.breakHistory.map(entry => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id)
        || ids.has(entry.id) || entry.id === anchor.breakId || !Number.isSafeInteger(entry.positionMs)
        || entry.positionMs <= previous || entry.positionMs > anchor.positionMs
        || !Number.isFinite(entry.elapsedMs) || entry.elapsedMs < 0 || entry.elapsedMs > Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid Break history entry.');
      ids.add(entry.id); previous = entry.positionMs;
      return Object.freeze({ id: entry.id, positionMs: entry.positionMs, elapsedMs: entry.elapsedMs });
    }));
  }
  return Object.freeze({ phase: anchor.phase, positionMs: anchor.positionMs, atMs: anchor.atMs,
    ...(anchor.exitDurationMs !== undefined ? { exitDurationMs: anchor.exitDurationMs } : {}),
    ...(anchor.holdElapsedMs !== undefined ? { holdElapsedMs: anchor.holdElapsedMs } : {}),
    ...(anchor.pausedFrom !== undefined ? { pausedFrom: anchor.pausedFrom } : {}),
    ...(anchor.exitFrom !== undefined ? { exitFrom: anchor.exitFrom } : {}),
    ...(anchor.breakId !== undefined ? { breakId: anchor.breakId } : {}),
    ...(history !== undefined ? { breakHistory: history } : {}) });
}

/** Check history against the frozen snapshot, independently of the decoder and client. */
export function validatePlaybackBreakState(plan: CompiledSequence, anchor: PlaybackClockAnchor): void {
  if (getPlaybackSchemaVersion(plan.snapshot) !== 3 && (anchor.breakId !== undefined || anchor.breakHistory !== undefined)) throw new TypeError('Timeline Break clocks require schema version 3.');
  const markers = plan.breaks.filter(marker => marker.kind === 'inner');
  const history = anchor.breakHistory ?? [];
  for (const [index, entry] of history.entries()) {
    const marker = markers[index];
    if (!marker || marker.id !== entry.id || marker.positionMs !== entry.positionMs) throw new TypeError('Break history must be an exact consumed marker prefix.');
  }
  const firstRemaining = markers[history.length];
  if (firstRemaining && anchor.positionMs > firstRemaining.positionMs) throw new TypeError('Playback cannot skip an unconsumed Break.');
  const holding = anchor.phase === 'holding' || anchor.pausedFrom === 'holding' || anchor.exitFrom === 'holding' || anchor.exitFrom === 'paused-holding';
  // Position zero can be ordinarily paused or faded before a scheduled start.
  // Positive due markers and the manual endpoint must retain their held origin.
  const stoppedWithoutHold = !holding && (anchor.phase === 'paused' || anchor.phase === 'exiting');
  if (getPlaybackSchemaVersion(plan.snapshot) === 3 && stoppedWithoutHold
    && ((firstRemaining?.positionMs === anchor.positionMs && anchor.positionMs > 0)
      || (plan.snapshot.end.kind === 'manual' && anchor.positionMs === plan.durationMs))) {
    throw new TypeError('A stopped Break boundary requires its holding origin.');
  }
  if (getPlaybackSchemaVersion(plan.snapshot) === 3 && holding && anchor.breakId === undefined
    && (firstRemaining || plan.snapshot.end.kind !== 'manual' || anchor.positionMs !== plan.durationMs)) throw new TypeError('Terminal holding requires all inner Breaks consumed.');
  if (anchor.breakId !== undefined) {
    const marker = markers[history.length];
    if (!marker || marker.id !== anchor.breakId || marker.positionMs !== anchor.positionMs) throw new TypeError('Current Break must be the first unconsumed marker.');
  }
}

/** Derive the first due hold from the original anchor, even after an arbitrarily late frame. */
export function projectPlaybackAnchor(plan: CompiledSequence, anchor: PlaybackClockAnchor, now: number): PlaybackClockAnchor {
  if (anchor.phase !== 'playing' || now < anchor.atMs) return anchor;
  const reachedPosition = anchor.positionMs + Math.max(0, now - anchor.atMs);
  const history = anchor.breakHistory ?? [];
  const marker = plan.breaks.find(candidate => candidate.kind === 'inner' && !history.some(entry => entry.id === candidate.id));
  if (marker && reachedPosition >= marker.positionMs) {
    return Object.freeze({ phase: 'holding', positionMs: marker.positionMs,
      atMs: anchor.atMs + Math.max(0, marker.positionMs - anchor.positionMs), holdElapsedMs: 0,
      breakId: marker.id, ...(anchor.breakHistory !== undefined ? { breakHistory: anchor.breakHistory } : {}) });
  }
  if (plan.durationMs === null || reachedPosition < plan.durationMs) return anchor;
  const atMs = anchor.atMs + Math.max(0, plan.durationMs - anchor.positionMs);
  const details = anchor.breakHistory !== undefined ? { breakHistory: anchor.breakHistory } : {};
  return getPlaybackSchemaVersion(plan.snapshot) !== 1 && plan.snapshot.end.kind === 'manual'
    ? Object.freeze({ phase: 'holding', positionMs: plan.durationMs, atMs, holdElapsedMs: 0, ...details })
    : Object.freeze({ phase: 'exiting', positionMs: plan.durationMs, atMs,
      exitDurationMs: plan.snapshot.presentation.exitDurationMs, ...details });
}

export function playbackPositionAt(plan: CompiledSequence, anchor: PlaybackClockAnchor, now: number): number {
  const projected = projectPlaybackAnchor(plan, anchor, now);
  const position = projected.positionMs + (projected.phase === 'playing' ? Math.max(0, now - projected.atMs) : 0);
  return plan.durationMs === null ? position : Math.min(position, plan.durationMs);
}

export function playbackHoldElapsedAt(anchor: PlaybackClockAnchor, now: number): number {
  const advancing = anchor.phase === 'holding' || (anchor.phase === 'exiting' && anchor.exitFrom === 'holding');
  return Math.min(Number.MAX_SAFE_INTEGER, (anchor.holdElapsedMs ?? 0) + (advancing ? Math.max(0, now - anchor.atMs) : 0));
}

/** Continue consumes one inner marker; the implicit endpoint continues into the common fade. */
export function continuePlaybackAnchor(plan: CompiledSequence, anchor: PlaybackClockAnchor, now: number): PlaybackClockAnchor {
  const projected = projectPlaybackAnchor(plan, anchor, now);
  if (projected.phase !== 'holding' && !(projected.phase === 'paused' && projected.pausedFrom === 'holding')) return projected;
  const elapsedMs = playbackHoldElapsedAt(projected, now);
  if (projected.breakId !== undefined) {
    const history = Object.freeze([...(projected.breakHistory ?? []), Object.freeze({ id: projected.breakId,
      positionMs: projected.positionMs, elapsedMs })]);
    return Object.freeze({ phase: 'playing', positionMs: projected.positionMs, atMs: now, breakHistory: history });
  }
  return Object.freeze({ phase: 'exiting', positionMs: projected.positionMs, atMs: now,
    exitDurationMs: plan.snapshot.presentation.exitDurationMs,
    exitFrom: projected.phase === 'paused' ? 'paused-holding' : 'holding', holdElapsedMs: elapsedMs,
    ...(projected.breakHistory !== undefined ? { breakHistory: projected.breakHistory } : {}) });
}

export interface FrameItem {
  readonly clip: SequenceClip;
  readonly opacity: number;
  readonly localTimeMs: number;
  /** Deterministic surface clock, including the applicable active Break history. */
  readonly patternTimeMs?: number;
  /** Selected-source-relative position; independent of the frozen timeline and already wrapped. */
  readonly mediaTimeMs?: number;
  readonly mediaPlayback?: 'playing' | 'paused' | 'looping' | 'finishing' | 'finished';
  /** Decoder repetition index, including exact-period clock jumps with equal source positions. */
  readonly mediaCycle?: number;
  /** Terminal video in a manual sequence: source time repeats while local time keeps advancing. */
  readonly videoLoop?: true;
  /** Sound repeats its source interval while its local timeline keeps advancing. */
  readonly audioLoop?: true;
  /** Audio-only fade envelope. Renderer multiplies authored volume and global gain separately. */
  readonly audioGain?: number;
  /** Bars only: 0 places both bars outside the surface; 1 fully reveals them. */
  readonly barsReveal?: number;
  /** Visual motion in logical composition units, relative to its authored box. */
  readonly textTransform?: { readonly x: number; readonly y: number; readonly scale: number };
  /** Raw phase clock; renderer applies segmented easing without independent timers. */
  readonly textMotion?: {
    readonly entrance?: { readonly transition: Transition; readonly progress: number };
    readonly exit?: { readonly transition: Transition; readonly progress: number };
  };
}

export class UnsupportedElementError extends Error {
  readonly code = 'UNSUPPORTED_ELEMENT' as const;

  constructor(elementType: string, elementId: string) {
    super(`Unsupported ${elementType} element "${elementId}".`);
    this.name = 'UnsupportedElementError';
  }
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) freezeDeep(child, seen);
  return Object.freeze(value);
}

export function compileSequence(sequence: SequenceV1): CompiledSequence {
  const validated = validateSequence(sequence);
  const snapshot = freezeDeep(validated);

  const trackOrder = new Map<string, number>();
  for (const track of snapshot.tracks) {
    if (track.enabled) trackOrder.set(track.id, track.order);
  }

  const clips = snapshot.clips
    .filter(clip => trackOrder.has(clip.trackId))
    .slice()
    .sort((left, right) => {
      const orderDifference = trackOrder.get(left.trackId)! - trackOrder.get(right.trackId)!;
      if (orderDifference !== 0) return orderDifference;
      const startDifference = left.startMs - right.startMs;
      if (startDifference !== 0) return startDifference;
      return left.id.localeCompare(right.id);
    });

  const mediaClips=clips.filter(clip=>clip.type==='video' || clip.type==='audio');
  for(const media of mediaClips) {
    if(mediaDurationMs(media)===undefined) throw new SequenceValidationError('MEDIA_METADATA_REQUIRED','MEDIA_METADATA_REQUIRED');
  }
  const durationMs = sequenceDurationMs(snapshot);
  if (durationMs === undefined) throw new SequenceValidationError('MEDIA_METADATA_REQUIRED','MEDIA_METADATA_REQUIRED');
  // A hidden track controls visibility, while its referenced media retains the
  // authored sequence endpoint. sequenceDurationMs resolves the full snapshot.
  if(durationMs!==null) for(const clip of clips) {
    const entrance=transitionDurationMs(clip.entrance);
    const end=clip.duration.kind==='sequence-end' ? clip.startMs+entrance : clip.duration.kind==='fixed' ? clip.startMs+clip.duration.milliseconds
      : clip.type==='video' || clip.type==='audio' ? clip.startMs+mediaDurationMs(clip)! : clip.startMs+entrance;
    if(clip.startMs>=durationMs || end>durationMs) throw new SequenceValidationError('INVALID_TIMING','An element extends beyond the sequence end.');
  }
  return Object.freeze({
    snapshot,
    durationMs,
    clips: Object.freeze(clips),
    breaks: Object.freeze([
      ...(getPlaybackSchemaVersion(snapshot) === 3 ? [...snapshot.breaks ?? []]
        .filter(marker => durationMs === null || marker.positionMs < durationMs)
        .sort((left, right) => left.positionMs - right.positionMs)
        .map(marker => Object.freeze({ ...marker, kind: 'inner' as const })) : []),
      ...(getPlaybackSchemaVersion(snapshot) !== 1 && snapshot.end.kind === 'manual' && durationMs !== null
        ? [Object.freeze({ id: '$end', positionMs: durationMs, kind: 'terminal' as const })] : [])
    ])
  });
}

function entranceProgress(transition: Transition, localTimeMs: number): number {
  if (transition.preset === 'none') return 1;
  const duration = transition.durationMs;
  if (duration <= 0) return 1;
  return evaluateEasing(localTimeMs / duration, transition.easing);
}

function naturalExitProgress(transition: Transition, localTimeMs: number, durationMs: number): number {
  if (transition.preset === 'none') return 1;
  const transitionDuration = transition.durationMs;
  if (transitionDuration <= 0) return 1;
  const transitionStart = durationMs - transitionDuration;
  if (localTimeMs < transitionStart) return 1;
  return 1 - evaluateEasing((localTimeMs - transitionStart) / transitionDuration, transition.easing);
}

function boundedProgress(progress: number): number {
  return Math.max(0, Math.min(1, progress));
}

function entranceOpacity(clip: SequenceClip, localTimeMs: number): number {
  return transitionChangesOpacity(clip.entrance) ? boundedProgress(entranceProgress(clip.entrance, localTimeMs)) : 1;
}

function naturalExitOpacity(clip: SequenceClip, localTimeMs: number, durationMs: number): number {
  return transitionChangesOpacity(clip.exit) ? boundedProgress(naturalExitProgress(clip.exit, localTimeMs, durationMs)) : 1;
}

function barsReveal(clip: VisualClip, localTimeMs: number, manualHold = false): { readonly barsReveal?: number } {
  if (clip.type !== 'bars'
    || (!transitionChangesBarsReveal(clip.entrance) && !transitionChangesBarsReveal(clip.exit))) return {};
  const entrance = transitionChangesBarsReveal(clip.entrance) ? entranceProgress(clip.entrance, localTimeMs) : 1;
  const exit = !manualHold && clip.duration.kind === 'fixed' && transitionChangesBarsReveal(clip.exit)
    ? naturalExitProgress(clip.exit, localTimeMs, clip.duration.milliseconds) : 1;
  return { barsReveal: boundedProgress(Math.min(entrance, exit)) };
}

function textTransform(clip: VisualClip, localTimeMs: number, videoDuration?: number, suppressExit = false): Pick<FrameItem, 'textTransform'> {
  if ((clip.type !== 'text' && clip.type !== 'image' && clip.type !== 'solid' && clip.type !== 'button' && !(clip.type === 'video' && clip.typeVersion === 7)) || ![clip.entrance, clip.exit].some(transition =>
    transitionChangesTextPosition(transition) || transitionChangesTextScale(transition))) return {};
  let x = 0;
  let y = 0;
  let scale = 1;
  const apply = (transition: Transition, progress: number): void => {
    if (transition.preset === 'none') return;
    if (transitionChangesTextPosition(transition)) {
      const offset = (transition.distance ?? 100) * (1 - progress);
      switch (transition.direction ?? 'down') {
        case 'left': x -= offset; break;
        case 'right': x += offset; break;
        case 'up': y -= offset; break;
        case 'down': y += offset; break;
      }
    }
    if (transitionChangesTextScale(transition)) scale += ((transition.scale ?? 0.8) - 1) * (1 - progress);
  };
  apply(clip.entrance, entranceProgress(clip.entrance, localTimeMs));
  const duration = clip.duration.kind === 'fixed' ? clip.duration.milliseconds : videoDuration;
  if (!suppressExit && duration !== undefined) {
    apply(clip.exit, naturalExitProgress(clip.exit, localTimeMs, duration));
  }
  // Back curves may overshoot below the smallest authored scale. Keep the
  // title upright rather than crossing through zero into a mirrored image.
  return { textTransform: Object.freeze({ x, y, scale: Math.max(0.01, scale) }) };
}

function textMotion(clip: VisualClip, localTimeMs: number): Pick<FrameItem, 'textMotion'> {
  if (clip.type !== 'text' || ![clip.entrance, clip.exit].some(value => value.preset === 'text-motion')) return {};
  const entrance = clip.entrance.preset === 'text-motion'
    ? { transition: clip.entrance, progress: boundedProgress(localTimeMs / clip.entrance.durationMs) } : undefined;
  // Like existing title Out controls, sequence-end clips stay readable through
  // holds and use the common sequence fade. Only a fixed clip authors an Out.
  const exit = clip.exit.preset === 'text-motion' && clip.duration.kind === 'fixed'
    ? { transition: clip.exit, progress: boundedProgress((localTimeMs - clip.duration.milliseconds + clip.exit.durationMs) / clip.exit.durationMs) } : undefined;
  return { textMotion: Object.freeze({
    ...(entrance ? { entrance: Object.freeze(entrance) } : {}),
    ...(exit ? { exit: Object.freeze(exit) } : {})
  }) };
}

/**
 * Evaluate every active clip from an absolute sequence position. Fixed
 * clips use [start, end); sequence-end clips remain visible at the fixed
 * sequence boundary so the surface can apply its one global exit fade there.
 * On a manual sequence, terminal bars without Out remain visible and the final video on each track holds its last frame or loops.
 */
export interface EvaluationContext {
  readonly paused?: boolean;
  /** Consumed inner holds, shared by local and network playback. */
  readonly breakHistory?: readonly BreakHistoryEntry[];
  readonly holding?: { readonly elapsedMs: number; readonly paused?: boolean };
  /** Common fade freezes authored envelopes but live sources continue on the exit clock. */
  readonly exiting?: { readonly elapsedMs: number; readonly paused?: boolean };
}

/** Pure media continuation, reusable by future inner Breaks without rewinding finish. */
export function evaluateBreakMedia(clip: Extract<SequenceClip, { type: 'audio' | 'video' }>, heldSourceMs: number,
  elapsedMs: number, paused = false): Pick<FrameItem, 'mediaTimeMs' | 'mediaPlayback' | 'mediaCycle' | 'audioLoop' | 'videoLoop'> {
  const duration = mediaDurationMs(clip)!;
  const behavior = clip.properties.onBreak ?? 'pause';
  const elapsed = Math.max(0, elapsedMs);
  if (behavior === 'pause') return { mediaTimeMs: heldSourceMs, mediaPlayback: 'paused' };
  if (behavior === 'finish') {
    const mediaTimeMs = Math.min(duration, heldSourceMs + elapsed);
    return { mediaTimeMs, mediaPlayback: mediaTimeMs >= duration ? 'finished' : paused ? 'paused' : 'finishing' };
  }
  return { mediaTimeMs: (heldSourceMs + elapsed) % duration, mediaPlayback: paused ? 'paused' : 'looping',
    mediaCycle: Math.floor((heldSourceMs + elapsed) / duration),
    ...(clip.type === 'audio' ? { audioLoop: true as const } : { videoLoop: true as const }) };
}

/** Inner-Break continuation contract: finish keeps its progress; other policies resynchronize. */
export function evaluateMediaAfterBreak(clip: Extract<SequenceClip, { type: 'audio' | 'video' }>, heldSourceMs: number,
  breakElapsedMs: number, resumedElapsedMs: number, paused = false): Pick<FrameItem, 'mediaTimeMs' | 'mediaPlayback' | 'mediaCycle' | 'audioLoop' | 'videoLoop'> {
  if (clip.properties.onBreak === 'finish') return evaluateBreakMedia(clip, heldSourceMs, Math.max(0, breakElapsedMs) + Math.max(0, resumedElapsedMs), paused);
  const duration = mediaDurationMs(clip)!;
  const source = heldSourceMs + Math.max(0, resumedElapsedMs);
  const loop = clip.properties.loop === true;
  return { mediaTimeMs: loop ? source % duration : Math.min(source, duration),
    mediaPlayback: !loop && source >= duration ? 'finished' : paused ? 'paused' : loop ? 'looping' : 'playing',
    ...(loop ? { mediaCycle: Math.floor(source / duration), ...(clip.type === 'audio' ? { audioLoop: true as const } : { videoLoop: true as const }) } : {}) };
}

function evaluateBreakSequence(plan: CompiledSequence, position: number, context: EvaluationContext): readonly FrameItem[] {
  const items: FrameItem[] = [];
  for (const clip of plan.clips) {
    if (position < clip.startMs) continue;
    const localTimeMs = position - clip.startMs;
    const duration = clipDurationMs(plan.snapshot, clip)!;
    const sequenceEnd = clip.duration.kind === 'sequence-end';
    // Only the actual end composition survives its boundary. Earlier ended clips never reappear.
    const atEnd = position === plan.durationMs && clip.startMs + duration === plan.durationMs;
    if (localTimeMs >= duration && !sequenceEnd && !atEnd) continue;
    const opacity = Math.min(entranceOpacity(clip, localTimeMs), sequenceEnd ? 1 : naturalExitOpacity(clip, localTimeMs, duration));
    if (clip.type === 'audio' || clip.type === 'video') {
      const sourceDuration = mediaDurationMs(clip)!;
      const looping = clip.properties.loop === true;
      const heldSourceMs = looping ? localTimeMs % sourceDuration : Math.min(localTimeMs, sourceDuration);
      const mediaElapsedMs = localTimeMs + (context.exiting && !context.exiting.paused ? Math.max(0, context.exiting.elapsedMs) : 0);
      const sourceTimeMs = looping ? mediaElapsedMs % sourceDuration : Math.min(mediaElapsedMs, sourceDuration);
      // A Finish source is committed once at its first active hold. Source progress
      // then follows timeline advancement plus active hold clocks, even after Continue.
      const completed = context.breakHistory ?? [];
      const firstFinish = clip.properties.onBreak === 'finish'
        ? completed.findIndex(entry => entry.positionMs >= clip.startMs && entry.positionMs < clip.startMs + duration) : -1;
      const finishElapsed = firstFinish >= 0
        ? position - completed[firstFinish]!.positionMs
          + completed.slice(firstFinish).reduce((sum, entry) => sum + entry.elapsedMs, 0)
          + (context.holding?.elapsedMs ?? 0)
          + (context.exiting && !context.holding && !context.exiting.paused ? Math.max(0, context.exiting.elapsedMs) : 0) : 0;
      const firstSource = firstFinish >= 0 ? completed[firstFinish]!.positionMs - clip.startMs : 0;
      const committedFinish = firstFinish >= 0 ? evaluateBreakMedia(clip,
        looping ? firstSource % sourceDuration : Math.min(firstSource, sourceDuration), finishElapsed,
        context.paused === true || context.holding?.paused === true || context.exiting?.paused === true) : undefined;
      const media = committedFinish ?? (context.holding ? evaluateBreakMedia(clip, heldSourceMs, context.holding.elapsedMs,
          context.paused === true || context.holding.paused === true || context.exiting?.paused === true)
        : { mediaTimeMs: sourceTimeMs, mediaPlayback: context.paused || context.exiting?.paused ? 'paused' as const : !looping && sourceTimeMs >= sourceDuration ? 'finished' as const : looping ? 'looping' as const : 'playing' as const,
          ...(looping ? { mediaCycle: Math.floor(mediaElapsedMs / sourceDuration), ...(clip.type === 'audio' ? { audioLoop: true as const } : { videoLoop: true as const }) } : {}) });
      items.push(Object.freeze({ clip, localTimeMs, opacity: clip.type === 'audio' ? 1 : opacity, ...media,
        ...(clip.type === 'video' ? textTransform(clip, localTimeMs, duration) : {}),
        ...(clip.type === 'audio' ? { audioGain: media.mediaPlayback === 'finished' ? 0 : opacity } : {}) }));
    } else {
      items.push(Object.freeze({ clip, localTimeMs, opacity, ...barsReveal(clip, localTimeMs), ...textTransform(clip, localTimeMs), ...textMotion(clip, localTimeMs),
        ...animatedPatternClock(clip, position, duration, context) }));
    }
  }
  return Object.freeze(items);
}

export function evaluate(plan: CompiledSequence, positionMs: number, context: EvaluationContext = {}): readonly FrameItem[] {
  if (!Number.isFinite(positionMs)) throw new RangeError('Sequence position must be finite.');
  const position = Math.max(0, plan.durationMs === null ? positionMs : Math.min(positionMs, plan.durationMs));
  if (getPlaybackSchemaVersion(plan.snapshot) !== 1) return evaluateBreakSequence(plan, position, context);
  const items: FrameItem[] = [];
  const finalClipByTrack = new Map<string, SequenceClip>();
  if (plan.durationMs === null) {
    for (const clip of plan.clips) finalClipByTrack.set(clip.trackId, clip);
  }

  for (const clip of plan.clips) {
    if (position < clip.startMs) continue;
    const localTimeMs = position - clip.startMs;
    if (clip.type === 'audio') {
      const durationMs = audioDurationMs(clip)!;
      const settings = audioLoopSettings(clip);
      const indefinite = finalClipByTrack.get(clip.trackId) === clip && settings.loop && settings.loopIndefinitely;
      const audioLoop = clip.typeVersion === 1 ? indefinite : settings.loop;
      if (localTimeMs >= durationMs && !indefinite) continue;
      items.push(Object.freeze({ clip, opacity: 1, localTimeMs,
        ...(audioLoop ? { audioLoop: true as const } : {}),
        audioGain: Math.min(entranceOpacity(clip, localTimeMs), indefinite ? 1 : naturalExitOpacity(clip, localTimeMs, durationMs))
      }));
      continue;
    }
    if (clip.type === 'bars' && clip.duration.kind === 'fixed' && clip.exit.preset === 'none'
      && finalClipByTrack.get(clip.trackId) === clip) {
      items.push(Object.freeze({ clip, opacity: entranceOpacity(clip, localTimeMs), localTimeMs,
        ...barsReveal(clip, localTimeMs, true) }));
      continue;
    }
    if (clip.duration.kind === 'fixed') {
      const clipEndMs = clip.startMs + clip.duration.milliseconds;
      if (position >= clipEndMs) continue;
      const opacity = Math.min(
        entranceOpacity(clip, localTimeMs),
        naturalExitOpacity(clip, localTimeMs, clip.duration.milliseconds)
      );
      items.push(Object.freeze({ clip, opacity, localTimeMs, ...barsReveal(clip, localTimeMs), ...textTransform(clip, localTimeMs), ...textMotion(clip, localTimeMs),
        ...animatedPatternClock(clip, position, clip.duration.milliseconds, context) }));
      continue;
    }

    if (clip.type === 'video') {
      const durationMs = videoDurationMs(clip)!;
      const endMs = clip.startMs + durationMs;
      const manualHold = finalClipByTrack.get(clip.trackId) === clip;
      const videoLoop = manualHold && clip.properties.loop === true;
      // Adjacent clips use half-open intervals. Only the final composition's
      // media remains on its boundary for the common surface fade.
      const finalBoundary = position === plan.durationMs && endMs === plan.durationMs;
      if (position >= endMs && !finalBoundary && !manualHold) continue;
      items.push(Object.freeze({ clip, ...(videoLoop ? { videoLoop: true as const } : {}),
        ...textTransform(clip, localTimeMs, durationMs, manualHold || endMs === plan.durationMs),
        localTimeMs: manualHold && !videoLoop ? Math.min(localTimeMs, durationMs) : localTimeMs, opacity: Math.min(
        entranceOpacity(clip, localTimeMs),
        manualHold || endMs === plan.durationMs ? 1 : naturalExitOpacity(clip, localTimeMs, durationMs)
      ) }));
      continue;
    }

    // A held clip ignores its per-clip exit. The whole composition is faded
    // once when playback enters its global exiting phase.
    items.push(Object.freeze({ clip, opacity: entranceOpacity(clip, localTimeMs), localTimeMs,
      ...barsReveal(clip, localTimeMs), ...textTransform(clip, localTimeMs), ...textMotion(clip, localTimeMs),
      ...animatedPatternClock(clip, position, clipDurationMs(plan.snapshot, clip) ?? Number.MAX_SAFE_INTEGER, context) }));
  }

  return Object.freeze(items);
}
