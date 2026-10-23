import type { SequenceV1 } from './sequence.js';
import { audioDurationMs, audioLoopSettings, isTerminalManualClip, videoTypeVersion } from './clip-timing.js';
import { validateSequence } from './validation.js';
import { getPlaybackSchemaVersion } from './sequence-audience.js';

/** Explicit adoption of new semantics. Reading and ordinary edits never call this. */
export function upgradeSequenceToBreaks(sequence: SequenceV1): SequenceV1 {
  const source = validateSequence(sequence);
  if (getPlaybackSchemaVersion(source) !== 1) return source;
  const clips = source.clips.map(clip => {
    if (clip.type === 'video') {
      const wasLooping = isTerminalManualClip(source, clip) && clip.properties.loop === true;
      const properties = { ...clip.properties, onBreak: wasLooping ? 'loop' as const : 'pause' as const };
      return { ...clip, typeVersion: videoTypeVersion(properties, clip.typeVersion, clip), properties };
    }
    if (clip.type === 'audio') {
      const settings = audioLoopSettings(clip);
      const wasIndefinite = isTerminalManualClip(source, clip) && settings.loop && settings.loopIndefinitely;
      const length = audioDurationMs(clip);
      if (!wasIndefinite && length === undefined) throw new Error('MEDIA_METADATA_REQUIRED');
      return { ...clip, typeVersion: 3 as const,
        duration: wasIndefinite ? { ...clip.duration, kind: 'sequence-end' as const } : { ...clip.duration, kind: 'fixed' as const, milliseconds: length! },
        properties: { ...clip.properties, loop: clip.typeVersion === 1 ? wasIndefinite : settings.loop,
          loopIndefinitely: wasIndefinite, onBreak: wasIndefinite ? 'loop' as const : 'pause' as const } };
    }
    return clip;
  });
  // A previous numeric duration is intentionally removed only for adopted indefinite clips.
  for (const clip of clips) if (clip.type === 'audio' && clip.duration.kind === 'sequence-end') {
    delete (clip.duration as { milliseconds?: number }).milliseconds;
  }
  return validateSequence({ ...source,
    ...((source.schemaVersion === 4 || source.schemaVersion === 5) ? { playbackSchemaVersion: 2 } : { schemaVersion: 2 }), clips });
}

/** Adopt editable holds without changing existing media, endpoint, or rendering semantics. */
export function upgradeSequenceToTimelineBreaks(sequence: SequenceV1): SequenceV1 {
  const source = validateSequence(sequence);
  if (getPlaybackSchemaVersion(source) === 1) throw new Error('EXPLICIT_BREAK_ADOPTION_REQUIRED');
  return validateSequence({ ...source,
    ...((source.schemaVersion === 4 || source.schemaVersion === 5) ? { playbackSchemaVersion: 3 } : { schemaVersion: 3 }) });
}
