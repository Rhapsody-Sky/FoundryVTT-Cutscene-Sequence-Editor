import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEditorTimelineCommand, applyTimelineCommand, TimelineCommandError, timelineConflicts, type TimelineCommand } from '../src/application/timeline-commands.js';
import type { AudioClip, SequenceV1 } from '../src/domain/sequence.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';

function ids(prefix = 'edit') { let next = 0; return () => `${prefix}_${++next}`; }

function empty(end: SequenceV1['end'] = { kind: 'fixed', durationMs: 5_000, automatic: true }): SequenceV1 {
  const base = createBarsSequence('Audio timeline', ids('base'));
  return validateSequence({ ...base, clips: [], end, tracks: [base.tracks[0]!,
    { id: 'audio_track', name: 'Audio', kind: 'audio', order: 1, enabled: true, locked: false }] });
}

function add(source: SequenceV1, startMs = 0, makeId = ids('sound')): SequenceV1 {
  return applyTimelineCommand(source, { kind: 'add-clip', type: 'audio', trackId: 'audio_track', startMs,
    sourcePath: 'worlds/demo/music.ogg', sourceDurationMs: 2_000 }, makeId);
}

function addLegacy(source: SequenceV1, startMs = 0): SequenceV1 {
  const result = add(source, startMs);
  return validateSequence({ ...result, clips: result.clips.map(clip => clip.type === 'audio'
    ? { ...clip, typeVersion: 1, duration: { kind: 'media' } } : clip) });
}

function code(expected: string) { return (error: unknown) => error instanceof TimelineCommandError && error.code === expected; }

test('audio command defaults use inspected source metadata and distinct audio tracks', () => {
  const source = empty();
  const tracks = applyTimelineCommand(source, { kind: 'add-track', trackKind: 'audio' }, ids('track'));
  assert.equal(tracks.tracks.at(-1)!.kind, 'audio');
  const visual = applyTimelineCommand(source, { kind: 'add-track' }, ids('track'));
  assert.equal(visual.tracks.at(-1)!.kind, 'visual');
  const result = add(source);
  const clip = result.clips[0] as AudioClip;
  assert.equal(clip.type, 'audio');
  assert.equal(clip.typeVersion, 2);
  assert.deepEqual(clip.duration, { kind: 'fixed', milliseconds: 2_000 });
  assert.deepEqual(clip.entrance, { preset: 'none', version: 1 });
  assert.deepEqual(clip.exit, { preset: 'none', version: 1 });
  assert.deepEqual(clip.properties, { source: { kind: 'foundry-file', path: 'worlds/demo/music.ogg' }, volume: 1, muted: false, durationMs: 2_000 });
  assert.deepEqual(result.end, { kind: 'fixed', durationMs: 2_000, automatic: true });
  for (const command of [
    { kind: 'add-clip', type: 'audio', trackId: 'audio_track', startMs: 0 },
    { kind: 'add-clip', type: 'audio', trackId: 'audio_track', startMs: 0, sourcePath: 'music.ogg' }
  ] as const) assert.throws(() => applyTimelineCommand(source, command, ids()), TimelineCommandError);
  assert.throws(() => applyTimelineCommand(source, { kind: 'add-clip', type: 'audio', trackId: source.tracks[0]!.id,
    startMs: 0, sourcePath: 'music.ogg', sourceDurationMs: 2_000 }, ids()), code('INCOMPATIBLE_TRACK'));
  assert.throws(() => applyTimelineCommand(source, { kind: 'add-clip', type: 'text', trackId: 'audio_track', startMs: 0 }, ids()), code('INCOMPATIBLE_TRACK'));
});

test('legacy audio source trimming updates automatic end, keeps source duration and fits audio fades', () => {
  const source = addLegacy(empty(), 1_000);
  const clip = source.clips[0] as AudioClip;
  const faded = applyTimelineCommand(source, { kind: 'replace-clip', clip: { ...clip,
    entrance: { preset: 'fade', version: 1, durationMs: 500, easing: 'linear' },
    exit: { preset: 'fade', version: 1, durationMs: 500, easing: 'linear' } } }, ids());
  const trimmed = applyEditorTimelineCommand(faded, { kind: 'resize-clip', clipId: clip.id, edge: 'end', timeMs: 1_200 }, ids());
  const audio = trimmed.clips[0] as AudioClip;
  assert.equal(audio.typeVersion, 1);
  assert.deepEqual(audio.properties.sourceRange, { inMs: 0, outMs: 200 });
  assert.equal(audio.properties.durationMs, 2_000);
  assert.deepEqual(audio.entrance, { preset: 'fade', version: 1, durationMs: 100, easing: 'linear' });
  assert.deepEqual(audio.exit, { preset: 'fade', version: 1, durationMs: 100, easing: 'linear' });
  assert.deepEqual(trimmed.end, { kind: 'fixed', durationMs: 1_200, automatic: true });
  const sourceTrim = applyEditorTimelineCommand(faded, { kind: 'replace-clip', clip: {
    ...faded.clips[0] as AudioClip, properties: { ...clip.properties, sourceRange: { inMs: 100, outMs: 300 } }
  } }, ids());
  assert.deepEqual(sourceTrim.clips[0]!.entrance, { preset: 'fade', version: 1, durationMs: 100, easing: 'linear' });
  assert.deepEqual(sourceTrim.clips[0]!.exit, { preset: 'fade', version: 1, durationMs: 100, easing: 'linear' });
  const startTrim = applyTimelineCommand(source, { kind: 'resize-clip', clipId: clip.id, edge: 'start', timeMs: 1_500 }, ids());
  assert.deepEqual((startTrim.clips[0] as AudioClip).properties.sourceRange, { inMs: 500, outMs: 2_000 });
  assert.throws(() => applyTimelineCommand(source, { kind: 'resize-clip', clipId: clip.id, edge: 'end', timeMs: 3_001 }, ids()), code('INVALID_SOURCE_RANGE'));
});

test('audio moves reject visual destinations and collision allocation uses same-kind unlocked lanes', () => {
  const base = add(empty({ kind: 'manual' }));
  const source = add(base, 2_000, ids('later'));
  const clip = source.clips[1]!;
  assert.throws(() => applyEditorTimelineCommand(source, { kind: 'move-clip', clipId: clip.id, trackId: source.tracks[0]!.id, startMs: 0 }, ids()), code('INCOMPATIBLE_TRACK'));
  const available = applyTimelineCommand(source, { kind: 'add-track', trackKind: 'audio' }, ids('available'));
  const allocated = applyEditorTimelineCommand(available, { kind: 'move-clip', clipId: clip.id, trackId: 'audio_track', startMs: 500 }, ids('collision'));
  assert.equal(allocated.clips.find(item => item.id === clip.id)!.trackId, available.tracks.at(-1)!.id);
  assert.equal(allocated.tracks.length, available.tracks.length);
  const added = applyEditorTimelineCommand(source, { kind: 'move-clip', clipId: clip.id, trackId: 'audio_track', startMs: 500 }, ids('collision'));
  const newTrack = added.tracks.find(track => !source.tracks.some(old => old.id === track.id))!;
  assert.equal(newTrack.kind, 'audio');
  assert.equal(added.clips.find(item => item.id === clip.id)!.trackId, newTrack.id);
  assert.deepEqual(timelineConflicts(added), []);
  assert.deepEqual(source.clips.map(item => item.startMs), [0, 2_000]);
});

test('duplicate audio prefers adjacent interval and occupied copies allocate an audio track', () => {
  const first = add(empty({ kind: 'manual' }));
  const adjacent = applyTimelineCommand(first, { kind: 'duplicate-clip', clipId: first.clips[0]!.id }, ids('copy'));
  assert.equal(adjacent.clips[1]!.startMs, 2_000);
  assert.equal(adjacent.clips[1]!.trackId, 'audio_track');
  const copy = applyTimelineCommand(adjacent, { kind: 'duplicate-clip', clipId: adjacent.clips[0]!.id }, ids('copy_again'));
  const copied = copy.clips.at(-1)!;
  assert.equal(copy.tracks.find(track => track.id === copied.trackId)!.kind, 'audio');
  assert.equal(copied.startMs, 0);
  assert.deepEqual(timelineConflicts(copy), []);
});

test('manual audio timing, replace and source extensions remain immutable and undo-compatible', () => {
  const base = add(empty({ kind: 'manual', extension: { held: true } } as SequenceV1['end']));
  const clip = base.clips[0] as AudioClip;
  const extended = validateSequence({ ...base, extension: { keep: true }, clips: [{ ...clip, marker: 1,
    properties: { ...clip.properties, extension: { keep: true }, source: { ...clip.properties.source, future: 9 },
      sourceRange: { inMs: 0, outMs: 2_000, rangeExtension: 3 } } }] });
  const before = structuredClone(extended);
  const edits: readonly TimelineCommand[] = [
    { kind: 'move-clip', clipId: clip.id, trackId: clip.trackId, startMs: 500 },
    { kind: 'resize-clip', clipId: clip.id, edge: 'start', timeMs: 500 },
    { kind: 'replace-clip', clip: { ...clip, properties: { ...clip.properties, volume: 0.4, loop: true, sourceRange: { inMs: 100, outMs: 1_000 } } } }
  ];
  for (const command of edits) {
    const result = applyEditorTimelineCommand(extended, command, ids());
    assert.deepEqual(extended, before);
    assert.deepEqual(result.end, before.end);
    assert.deepEqual((result as SequenceV1 & { extension: unknown }).extension, { keep: true });
    assert.deepEqual((result.clips[0]!.properties as Record<string, unknown>).extension, { keep: true });
    assert.equal(((result.clips[0] as AudioClip).properties.source as Record<string, unknown>).future, 9);
    assert.equal(((result.clips[0] as AudioClip).properties.sourceRange as Record<string, unknown>).rangeExtension, 3);
  }
});

test('legacy referenced audio converts metadata and intervals before an editor timing edit', () => {
  const source = addLegacy(empty({ kind: 'manual' }));
  const clip = source.clips[0] as AudioClip;
  const referenced = validateSequence({ ...source, end: { kind: 'media', clipId: clip.id } });
  const result = applyEditorTimelineCommand(referenced, { kind: 'replace-clip', clip: { ...clip, properties: { ...clip.properties, sourceRange: { inMs: 100, outMs: 1_500 } } } }, ids());
  assert.deepEqual(result.end, { kind: 'fixed', durationMs: 1_400, automatic: true });
  const removed = applyTimelineCommand(referenced, { kind: 'remove-clip', clipId: clip.id }, ids());
  assert.deepEqual(removed.end, { kind: 'fixed', durationMs: 5_000 });
});
