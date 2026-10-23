import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEditorTimelineCommand, applyTimelineCommand, enableAutomaticEnd, TimelineCommandError, timelineConflicts } from '../src/application/timeline-commands.js';
import type { SequenceV1, TextClip, VideoClip, VisualClip } from '../src/domain/sequence.js';
import { createBarsSequence, SEQUENCE_LIMITS, validateSequence } from '../src/domain/validation.js';
import { compileSequence } from '../src/playback/evaluate.js';

function ids(prefix = 'edit') { let index = 0; return () => `${prefix}_${++index}`; }
function empty(): SequenceV1 { return { ...createBarsSequence('Automatic', ids('base')), clips: [] }; }
const makeId = ids();
const edit = (sequence: SequenceV1, command: Parameters<typeof applyEditorTimelineCommand>[1]) => applyEditorTimelineCommand(sequence, command, makeId);
const raw = (sequence: SequenceV1, command: Parameters<typeof applyTimelineCommand>[1]) => applyTimelineCommand(sequence, command, makeId);
function duration(sequence: SequenceV1): number { assert.equal(sequence.end.kind, 'fixed'); return sequence.end.kind === 'fixed' ? sequence.end.durationMs : NaN; }
function withText(startMs = 0): SequenceV1 { const base = empty(); return edit(base, { kind: 'add-clip', trackId: base.tracks[0]!.id, type: 'text', startMs }); }
function errorCode(code: string) { return (error: unknown) => error instanceof TimelineCommandError && error.code === code; }

test('automatic length follows growth, moves earlier, shorter trims, removal and an empty timeline', () => {
  let sequence = withText();
  const clip = sequence.clips[0]!;
  assert.deepEqual(sequence.end, { kind: 'fixed', automatic: true, durationMs: 5_000 });
  sequence = edit(sequence, { kind: 'move-clip', clipId: clip.id, trackId: clip.trackId, startMs: 10_000 });
  assert.equal(duration(sequence), 15_000);
  sequence = edit(sequence, { kind: 'move-clip', clipId: clip.id, trackId: clip.trackId, startMs: 2_000 });
  assert.equal(duration(sequence), 7_000);
  sequence = edit(sequence, { kind: 'resize-clip', clipId: clip.id, edge: 'end', timeMs: 3_000 });
  assert.equal(duration(sequence), 3_000);
  sequence = edit(sequence, { kind: 'remove-clip', clipId: clip.id });
  assert.equal(duration(sequence), 1);
  assert.equal(compileSequence(sequence).durationMs, 1);
});

test('all clips define the maximum independently of insertion order and enabled tracks', () => {
  const initial = withText(2_000);
  const tracks = raw(initial, { kind: 'add-track' });
  const sequence = edit(tracks, { kind: 'add-clip', trackId: tracks.tracks[1]!.id, type: 'video', startMs: 0, sourcePath: 'short.webm', sourceDurationMs: 1_000 });
  assert.equal(duration(sequence), 7_000);
  assert.equal(duration(enableAutomaticEnd({ ...sequence, clips: [...sequence.clips].reverse() })), 7_000);
  const disabled = raw(sequence, { kind: 'toggle-track', trackId: sequence.tracks[0]!.id, property: 'enabled' });
  assert.equal(duration(disabled), 7_000);
  const remaining = edit(disabled, { kind: 'remove-clip', clipId: initial.clips[0]!.id });
  assert.equal(duration(remaining), 1_000);
});

test('legacy media converts during a single edit and no longer restricts later videos', () => {
  const base = empty();
  const first = raw(base, { kind: 'add-clip', trackId: base.tracks[0]!.id, type: 'video', startMs: 0, sourcePath: 'first.webm', sourceDurationMs: 3_000 });
  const legacy = raw(first, { kind: 'set-end', end: { kind: 'media', clipId: first.clips[0]!.id } });
  const before = structuredClone(legacy);
  const added = edit(legacy, { kind: 'add-clip', trackId: legacy.tracks[0]!.id, type: 'video', startMs: 10_000, sourcePath: 'second.webm', sourceDurationMs: 2_000 });
  assert.deepEqual(legacy, before);
  assert.equal(duration(added), 12_000);
  assert.equal(compileSequence(added).durationMs, 12_000);
  const trimmed = edit(added, { kind: 'resize-clip', clipId: added.clips[1]!.id, edge: 'end', timeMs: 11_000 });
  assert.equal(duration(trimmed), 11_000);
  assert.deepEqual((trimmed.clips[1] as VideoClip).properties.sourceRange, { inMs: 0, outMs: 1_000 });
});

test('held conversion freezes relative duration and extensions before moving, with isolated source data', () => {
  const initial = createBarsSequence('Held', ids('held'));
  const clip = initial.clips[0]!;
  const source = validateSequence({ ...initial, end: { ...initial.end, future: { keep: true } }, clips: [{ ...clip, startMs: 1_000, duration: { kind: 'sequence-end', future: { keep: true } } }] });
  const before = structuredClone(source);
  const result = edit(source, { kind: 'move-clip', clipId: clip.id, trackId: clip.trackId, startMs: 10_000 });
  assert.deepEqual(result.clips[0]!.duration, { kind: 'fixed', milliseconds: 4_000, future: { keep: true } });
  assert.deepEqual(result.end, { kind: 'fixed', durationMs: 14_000, automatic: true, future: { keep: true } });
  assert.deepEqual(source, before);
  const addedTrack = raw(result, { kind: 'add-track' });
  const addedBars = edit(addedTrack, { kind: 'add-clip', trackId: addedTrack.tracks[1]!.id, type: 'bars', startMs: 20_000 });
  assert.deepEqual(addedBars.clips[1]!.duration, { kind: 'fixed', milliseconds: 5_000 });
  const shrunk = edit(addedBars, { kind: 'remove-clip', clipId: addedBars.clips[1]!.id });
  assert.equal(duration(shrunk), 14_000);
});

test('duplicate grows automatic length and removing its copy shrinks it again', () => {
  const sequence = withText();
  const copy = edit(sequence, { kind: 'duplicate-clip', clipId: sequence.clips[0]!.id });
  assert.equal(duration(copy), 10_000);
  assert.equal(copy.clips[1]!.startMs, 5_000);
  assert.equal(duration(edit(copy, { kind: 'remove-clip', clipId: copy.clips[1]!.id })), 5_000);
});

test('timing replacements update numeric playback length for fixed and trimmed media clips', () => {
  const text = withText();
  const shorter = edit(text, { kind: 'replace-clip', clip: { ...text.clips[0]!, duration: { kind: 'fixed', milliseconds: 2_000 } } as TextClip });
  assert.equal(duration(shorter), 2_000);
  const base = empty();
  const video = edit(base, { kind: 'add-clip', trackId: base.tracks[0]!.id, type: 'video', startMs: 0, sourcePath: 'replace.webm', sourceDurationMs: 8_000 });
  const clip = video.clips[0] as VideoClip;
  const trimmed = edit(video, { kind: 'replace-clip', clip: { ...clip, typeVersion: 2, properties: { ...clip.properties, sourceRange: { inMs: 2_000, outMs: 3_000 } } } });
  assert.equal(duration(trimmed), 1_000);
  assert.equal(compileSequence(trimmed).durationMs, 1_000);
  assert.equal((trimmed.clips[0] as VideoClip).properties.durationMs, 8_000);
});

test('explicit automatic opt-in for manual held clips assigns independent durations sufficient for their fades', () => {
  const source = createBarsSequence('Manual', ids('manual'));
  const clip = source.clips[0]!;
  const manual = validateSequence({ ...source, end: { kind: 'manual' }, clips: [{ ...clip, startMs: 1_000, entrance: { preset: 'fade', version: 1, durationMs: 4_000, easing: 'linear' }, exit: { preset: 'fade', version: 1, durationMs: 4_000, easing: 'linear' } }] });
  const automatic = enableAutomaticEnd(manual);
  assert.deepEqual(automatic.clips[0]!.duration, { kind: 'fixed', milliseconds: 8_000 });
  assert.equal(duration(automatic), 9_000);
  assert.deepEqual(manual.end, { kind: 'manual' });
});

test('style edits and vertical-only gestures preserve legacy policy; timing replacements convert held intervals', () => {
  const source = createBarsSequence('Held', ids('unchanged'));
  const clip = source.clips[0]!;
  const styled = edit(source, { kind: 'replace-clip', clip: { ...clip, properties: { ...clip.properties, color: '#123456' } } as VisualClip });
  assert.deepEqual(styled.end, source.end);
  assert.deepEqual(styled.clips[0]!.duration, clip.duration);
  const tracks = raw(source, { kind: 'add-track' });
  for (const trackId of [clip.trackId, tracks.tracks[1]!.id]) {
    assert.deepEqual(edit(tracks, { kind: 'move-clip', clipId: clip.id, trackId, startMs: clip.startMs }).end, source.end);
  }
  const timing = edit(source, { kind: 'replace-clip', clip: { ...clip, startMs: 2_000 } });
  assert.deepEqual(timing.clips[0]!.duration, { kind: 'fixed', milliseconds: 5_000 });
  assert.equal(duration(timing), 7_000);
});

test('explicit fixed and manual overrides retain their policy and legacy numeric semantics', () => {
  const automatic = withText();
  const clip = automatic.clips[0]!;
  for (const end of [{ kind: 'fixed', durationMs: 8_000, automatic: false }, { kind: 'manual' }] as const) {
    const source = raw(automatic, { kind: 'set-end', end });
    const moved = edit(source, { kind: 'move-clip', clipId: clip.id, trackId: clip.trackId, startMs: 1_000 });
    assert.deepEqual(moved.end, end);
    assert.deepEqual(edit(moved, { kind: 'remove-clip', clipId: clip.id }).end, end);
  }
});

test('held conversion and explicit short trims fit fades proportionally while preserving easing and extensions', () => {
  const base = createBarsSequence('Short', ids('fade'));
  const held = validateSequence({ ...base, end: { kind: 'fixed', durationMs: 1_000 }, clips: [{ ...base.clips[0]!, entrance: { preset: 'fade', version: 1, durationMs: 800, easing: 'linear', future: 'entrance' }, exit: { preset: 'fade', version: 1, durationMs: 800, easing: 'ease-in-out', future: 'exit' } }] });
  const automatic = enableAutomaticEnd(held);
  assert.equal(duration(automatic), 1_000);
  assert.deepEqual(automatic.clips[0]!.entrance, { preset: 'fade', version: 1, durationMs: 500, easing: 'linear', future: 'entrance' });
  const trimmed = edit(automatic, { kind: 'resize-clip', clipId: automatic.clips[0]!.id, edge: 'end', timeMs: 1 });
  assert.deepEqual(trimmed.clips[0]!.entrance, { preset: 'fade', version: 1, durationMs: 1, easing: 'linear', future: 'entrance' });
  assert.deepEqual(trimmed.clips[0]!.exit, { preset: 'none', version: 1, future: 'exit' });
  assert.equal(duration(trimmed), 1);
  const text = withText();
  assert.throws(() => raw(text, { kind: 'replace-clip', clip: { ...text.clips[0]!, duration: { kind: 'fixed', milliseconds: 1 } } as TextClip }), /cannot overlap/);
});

test('automatic moves and trims preserve source bounds, seven day bound, and unknown metadata errors', () => {
  const sequence = withText();
  const clip = sequence.clips[0]!;
  assert.throws(() => edit(sequence, { kind: 'move-clip', clipId: clip.id, trackId: clip.trackId, startMs: SEQUENCE_LIMITS.timelineMs }), /finite number|cannot exceed/);
  const base = empty();
  const video = raw(base, { kind: 'add-clip', trackId: base.tracks[0]!.id, type: 'video', startMs: 0, sourcePath: 'bounds.webm', sourceDurationMs: 3_000 });
  const known = video.clips[0] as VideoClip;
  assert.throws(() => edit(video, { kind: 'resize-clip', clipId: known.id, edge: 'end', timeMs: 3_001 }), errorCode('INVALID_SOURCE_RANGE'));
  const { durationMs: _duration, ...properties } = known.properties;
  const unknown = validateSequence({ ...video, clips: [{ ...known, properties }], end: { kind: 'media', clipId: known.id } });
  assert.throws(() => enableAutomaticEnd(unknown), errorCode('VIDEO_METADATA_REQUIRED'));
  assert.throws(() => edit(unknown, { kind: 'move-clip', clipId: known.id, trackId: known.trackId, startMs: 1_000 }), errorCode('VIDEO_METADATA_REQUIRED'));
});

test('optional automatic flag is validated without migrating legacy numeric snapshots', () => {
  const legacy = empty();
  assert.deepEqual(validateSequence(legacy), legacy);
  for (const automatic of ['true', 1, null]) {
    assert.throws(() => validateSequence({ ...legacy, end: { ...legacy.end, automatic } }), /true or false/);
  }
});

test('colliding timing edits choose deterministic free unlocked tracks without changing siblings', () => {
  const first = withText();
  const second = edit(first, { kind: 'add-clip', trackId: first.tracks[0]!.id, type: 'text', startMs: 5_000 });
  const track = second.tracks[0]!;
  const tracks = validateSequence({ ...second, tracks: [track, { ...track, id: 'locked', order: 1, locked: true }, { ...track, id: 'free', order: 2 }] });
  const before = structuredClone(tracks);
  const result = edit(tracks, { kind: 'move-clip', clipId: tracks.clips[1]!.id, trackId: track.id, startMs: 2_000 });
  assert.equal(result.clips[1]!.trackId, 'free');
  assert.deepEqual(result.clips[0], tracks.clips[0]);
  assert.deepEqual(tracks, before);
  assert.deepEqual(timelineConflicts(result), []);
  assert.throws(() => raw(tracks, { kind: 'move-clip', clipId: tracks.clips[1]!.id, trackId: track.id, startMs: 2_000 }), errorCode('CLIP_OVERLAP'));
});

test('colliding resize and timing replacement add one free track with a single returned result', () => {
  const first = withText();
  const second = edit(first, { kind: 'add-clip', trackId: first.tracks[0]!.id, type: 'text', startMs: 5_000 });
  const clip = second.clips[0]!;
  for (const command of [{ kind: 'resize-clip', clipId: clip.id, edge: 'end', timeMs: 6_000 }, { kind: 'replace-clip', clip: { ...clip, startMs: 1_000 } }] as const) {
    const result = edit(second, command);
    assert.equal(result.tracks.length, 2);
    assert.equal(result.tracks[1]!.name, 'Visual 2');
    assert.equal(result.tracks[1]!.order, 0, 'new collision lane remains at the bottom, matching its preview');
    assert.ok(result.tracks[0]!.order > result.tracks[1]!.order);
    assert.equal(result.clips[0]!.trackId, result.tracks[1]!.id);
    assert.deepEqual(result.clips[1], second.clips[1]);
    assert.deepEqual(timelineConflicts(result), []);
  }
  const full = validateSequence({ ...second, tracks: Array.from({ length: SEQUENCE_LIMITS.tracks }, (_, index) => ({ ...second.tracks[0]!, id: index === 0 ? second.tracks[0]!.id : `locked_${index}`, order: index, locked: index > 0 })) });
  assert.throws(() => edit(full, { kind: 'move-clip', clipId: full.clips[1]!.id, trackId: full.tracks[0]!.id, startMs: 2_000 }), errorCode('TRACK_LIMIT'));
});

test('vertical collision routing preserves legacy endpoint policy and uses free existing tracks before the original', () => {
  const first = createBarsSequence('Vertical', ids('vertical'));
  const track = first.tracks[0]!;
  const clip = first.clips[0]!;
  const source = validateSequence({
    ...first, tracks: [track, { ...track, id: 'occupied', order: 1 }, { ...track, id: 'free', order: 2 }],
    clips: [clip, { ...clip, id: 'sibling', trackId: 'occupied' }]
  });
  const before = structuredClone(source);
  const commands = [
    { kind: 'move-clip', clipId: clip.id, trackId: 'occupied', startMs: clip.startMs },
    { kind: 'replace-clip', clip: { ...clip, trackId: 'occupied' } }
  ] as const;
  for (const command of commands) {
    const result = edit(source, command);
    assert.equal(result.clips[0]!.trackId, 'free');
    assert.deepEqual(result.end, source.end);
    assert.deepEqual(result.clips[0]!.duration, clip.duration);
    assert.deepEqual(result.clips[1], source.clips[1]);
    assert.equal(result.tracks.length, 3);
    assert.deepEqual(source, before);
    assert.throws(() => raw(source, command), errorCode('CLIP_OVERLAP'));
  }
  const two = validateSequence({ ...source, tracks: source.tracks.slice(0, 2) });
  assert.deepEqual(edit(two, commands[0]), two, 'retain the free original track rather than adding an unnecessary track');
});

test('held inspector conversion retains fitted unchanged fades and honors intentional fade edits', () => {
  const base = createBarsSequence('Inspector fade', ids('inspector'));
  const held = validateSequence({ ...base, end: { kind: 'fixed', durationMs: 1_000 }, clips: [{
    ...base.clips[0]!, entrance: { preset: 'fade', version: 1, durationMs: 800, easing: 'linear', future: 'entrance' },
    exit: { preset: 'fade', version: 1, durationMs: 800, easing: 'ease-in-out', future: 'exit' }
  }] });
  const clip = held.clips[0]!;
  const converted = edit(held, { kind: 'replace-clip', clip: { ...clip, startMs: 2_000 } });
  assert.equal(duration(converted), 3_000);
  assert.deepEqual(converted.clips[0]!.duration, { kind: 'fixed', milliseconds: 1_000 });
  assert.deepEqual(converted.clips[0]!.entrance, { ...clip.entrance, durationMs: 500 });
  assert.deepEqual(converted.clips[0]!.exit, { ...clip.exit, durationMs: 500 });
  const edited = edit(held, { kind: 'replace-clip', clip: {
    ...clip, startMs: 2_000,
    entrance: { preset: 'fade', version: 1, durationMs: 300, easing: 'ease-in-out' }
  } });
  assert.equal(edited.clips[0]!.entrance.preset === 'fade' ? edited.clips[0]!.entrance.durationMs : 0, 300);
  assert.equal(edited.clips[0]!.exit.preset === 'fade' ? edited.clips[0]!.exit.durationMs : 0, 500);
  assert.deepEqual(held.clips[0], clip);
});

test('numeric duration reductions match drag trims without normalizing fade-only edits or raw commands', () => {
  const source = withText();
  const clip = source.clips[0] as TextClip;
  const replacement = edit(source, { kind: 'replace-clip', clip: { ...clip, duration: { kind: 'fixed', milliseconds: 1 } } });
  const trimmed = edit(source, { kind: 'resize-clip', clipId: clip.id, edge: 'end', timeMs: 1 });
  assert.deepEqual(replacement, trimmed);
  assert.deepEqual(replacement.clips[0]!.entrance, { preset: 'fade', version: 1, durationMs: 1, easing: 'ease-in-out' });
  assert.deepEqual(replacement.clips[0]!.exit, { preset: 'none', version: 1 });
  assert.throws(() => edit(source, { kind: 'replace-clip', clip: { ...clip, entrance: { preset: 'fade', version: 1, durationMs: 5_000, easing: 'linear' } } }), /cannot overlap/);
  assert.throws(() => raw(source, { kind: 'replace-clip', clip: { ...clip, duration: { kind: 'fixed', milliseconds: 1 } } }), /cannot overlap/);
  assert.deepEqual(source.clips[0], clip);
});

test('probing the unknown legacy media endpoint resolves held clips before automatic conversion', () => {
  const held = createBarsSequence('Unknown media', ids('probe'));
  const bars = held.clips[0]!;
  const track = { ...held.tracks[0]!, id: 'video_track', order: 1 };
  const unknown: VideoClip = {
    id: 'unknown_video', trackId: track.id, type: 'video', typeVersion: 1, startMs: 0,
    duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { source: { kind: 'foundry-file', path: 'unknown.webm' }, fit: 'contain', volume: 1, muted: true }
  };
  const source = validateSequence({ ...held, tracks: [...held.tracks, track], clips: [bars, unknown], end: { kind: 'media', clipId: unknown.id } });
  const before = structuredClone(source);
  const inspected = edit(source, { kind: 'replace-clip', clip: { ...unknown, properties: { ...unknown.properties, durationMs: 8_000 } } });
  assert.deepEqual(inspected.end, { kind: 'fixed', durationMs: 8_000, automatic: true });
  assert.deepEqual(inspected.clips[0]!.duration, { kind: 'fixed', milliseconds: 8_000 });
  assert.equal(compileSequence(inspected).durationMs, 8_000);
  assert.deepEqual(source, before);
  const otherTrack = { ...track, id: 'other_track', order: 2 };
  const otherUnknown = { ...unknown, id: 'other_unknown', trackId: otherTrack.id };
  const multiple = validateSequence({ ...source, tracks: [...source.tracks, otherTrack], clips: [...source.clips, otherUnknown] });
  assert.throws(() => edit(multiple, { kind: 'replace-clip', clip: { ...unknown, properties: { ...unknown.properties, durationMs: 8_000 } } }), errorCode('VIDEO_METADATA_REQUIRED'));
  assert.deepEqual(multiple.clips[2], otherUnknown);
  assert.throws(() => edit(source, { kind: 'replace-clip', clip: { ...unknown, properties: { ...unknown.properties, durationMs: 0 } } }), /finite number/);
});
