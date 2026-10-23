import { getPlaybackSchemaVersion } from './sequence-audience.js';
import type { AudioClip, SequenceV1, VideoClip, SequenceClip } from './sequence.js';
import { transitionChangesTextPosition, transitionChangesTextScale, transitionDurationMs } from './transitions.js';

/** Choose the oldest compatible video version; retain authored geometry/motion capabilities after resets. */
export function videoTypeVersion(properties: Pick<VideoClip['properties'], 'loop' | 'sourceRange' | 'keying' | 'onBreak' | 'box'>, previousVersion?: VideoClip['typeVersion'], transitions?: Partial<Pick<VideoClip, 'entrance' | 'exit'>>): VideoClip['typeVersion'] {
  const motion = [transitions?.entrance, transitions?.exit].some(value => value !== undefined
    && (transitionChangesTextPosition(value) || transitionChangesTextScale(value)));
  return motion || previousVersion === 7 ? 7 : properties.box !== undefined || previousVersion === 6 ? 6 : properties.onBreak !== undefined ? 5 : properties.keying?.enabled === true ? 4 : properties.loop === true ? 3 : properties.sourceRange ? 2 : 1;
}

/** Manual hold is a rendering policy for the last clip on an enabled track. */
export function isTerminalManualClip(sequence: SequenceV1, clip: SequenceClip): boolean {
  return getPlaybackSchemaVersion(sequence) === 1 && sequence.end.kind === 'manual'
    && sequence.tracks.some(track => track.id === clip.trackId && track.enabled)
    && !sequence.clips.some(other => other.trackId === clip.trackId
      && (other.startMs > clip.startMs || (other.startMs === clip.startMs && other.id.localeCompare(clip.id) > 0)));
}

/** Timeline length at the source's normal speed; durationMs remains full metadata. */
export function videoDurationMs(clip: VideoClip): number | undefined {
  return mediaDurationMs(clip);
}

/** Selected source period for decoder playback; independent of authored audio length. */
export function mediaDurationMs(clip: VideoClip | AudioClip): number | undefined {
  if (clip.properties.durationMs === undefined) return undefined;
  const range = clip.properties.sourceRange;
  return range ? range.outMs - range.inMs : clip.properties.durationMs;
}

export function audioDurationMs(clip: AudioClip): number | undefined {
  return clip.duration.kind === 'fixed' ? clip.duration.milliseconds : clip.duration.kind === 'sequence-end' ? undefined : mediaDurationMs(clip);
}

/** Read old manual looping without rewriting its persisted payload. */
export function audioLoopSettings(clip: AudioClip): { readonly loop: boolean; readonly loopIndefinitely: boolean } {
  const loop = clip.properties.loop === true;
  return { loop, loopIndefinitely: clip.typeVersion === 1 ? loop : clip.properties.loopIndefinitely === true };
}

/** Legacy manual ends are null; schema 2 manual ends are calculated. Undefined requires inspected media. */
export function sequenceDurationMs(sequence: SequenceV1): number | null | undefined {
  if (sequence.end.kind === 'manual') {
    if (getPlaybackSchemaVersion(sequence) === 1) return null;
    const ends = durationBearingEnds(sequence);
    return ends.some(end => end === undefined) ? undefined : ends.length ? Math.max(...ends as number[]) : sequence.end.durationMs ?? 5_000;
  }
  if (sequence.end.kind === 'fixed') return sequence.end.durationMs;
  const clipId = sequence.end.clipId;
  const target = sequence.clips.find(clip => clip.id === clipId);
  if (!target || (target.type !== 'video' && target.type !== 'audio')) return undefined;
  const duration = target.type === 'audio' ? audioDurationMs(target) : mediaDurationMs(target);
  return duration === undefined ? undefined : target.startMs + duration;
}

/** A held clip inherits the sequence endpoint, measured relative to its own start. */
export function clipDurationMs(sequence: SequenceV1, clip: SequenceClip): number | null | undefined {
  if (clip.type === 'audio' && clip.duration.kind !== 'sequence-end') return audioDurationMs(clip);
  if (clip.type === 'video') return mediaDurationMs(clip);
  if (clip.duration.kind === 'fixed') return clip.duration.milliseconds;
  const duration = sequenceDurationMs(sequence);
  return duration === null || duration === undefined ? duration : duration - clip.startMs;
}

function durationBearingEnds(sequence: SequenceV1): (number | undefined)[] {
  const enabled = new Set(sequence.tracks.filter(track => track.enabled).map(track => track.id));
  return sequence.clips.filter(clip => enabled.has(clip.trackId) && clip.duration.kind !== 'sequence-end').map(clip => {
    const length = clip.duration.kind === 'fixed' ? clip.duration.milliseconds
      : clip.type === 'video' || clip.type === 'audio' ? mediaDurationMs(clip) : undefined;
    return length === undefined ? undefined : clip.startMs + length;
  });
}

/** Show the manual fallback field only when no enabled clip determines the end. */
export function manualEndNeedsDuration(sequence: SequenceV1): boolean {
  return getPlaybackSchemaVersion(sequence) !== 1 && sequence.end.kind === 'manual' && durationBearingEnds(sequence).length === 0;
}

/** Shared authoring geometry: only fades actually used by the evaluator are shown. */
export function effectiveClipFades(sequence: SequenceV1, clip: SequenceClip): {
  readonly durationMs: number | null | undefined;
  readonly entranceMs: number;
  readonly exitMs: number;
} {
  const durationMs = clipDurationMs(sequence, clip);
  let suppressedExit = clip.duration.kind === 'sequence-end';
  if (getPlaybackSchemaVersion(sequence) === 1) {
    const terminal = isTerminalManualClip(sequence, clip);
    if (clip.type === 'video') suppressedExit ||= terminal || clip.startMs + mediaDurationMs(clip)! === sequenceDurationMs(sequence);
    if (clip.type === 'audio') {
      const settings = audioLoopSettings(clip);
      suppressedExit ||= terminal && settings.loop && settings.loopIndefinitely;
    }
  }
  return Object.freeze({ durationMs, entranceMs: transitionDurationMs(clip.entrance),
    exitMs: suppressedExit ? 0 : transitionDurationMs(clip.exit) });
}
