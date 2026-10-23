import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineClipboard } from '../src/application/timeline-clipboard.js';
import { applyEditorTimelineCommand, applyTimelineCommand, timelineConflicts } from '../src/application/timeline-commands.js';
import type { SequenceClip, SequenceV1 } from '../src/domain/sequence.js';
import { createBarsSequence, SEQUENCE_LIMITS, validateSequence } from '../src/domain/validation.js';

function ids(prefix = 'new') {
  let count = 0;
  return () => `${prefix}_${++count}`;
}

function emptySequence(schemaVersion: SequenceV1['schemaVersion'] = 3): SequenceV1 {
  return validateSequence({ ...createBarsSequence('Clipboard', ids('base'), schemaVersion), clips: [],
    end: { kind: 'fixed', durationMs: 10_000, automatic: false } });
}

function fixture(type: SequenceClip['type'] = 'text'): SequenceV1 {
  let sequence = emptySequence();
  if (type === 'audio') sequence = applyTimelineCommand(sequence, { kind: 'add-track', trackKind: 'audio' }, ids('track'));
  const track = sequence.tracks.find(item => item.kind === (type === 'audio' ? 'audio' : 'visual'))!;
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type, trackId: track.id, startMs: 0,
    ...(['video', 'image', 'audio'].includes(type) ? { sourcePath: `worlds/test/media.${type}`, sourceDurationMs: 4_000 } : {}) }, ids('clip'));
  const clip = sequence.clips[0]!;
  const duration = type === 'bars' ? { kind: 'fixed', milliseconds: 2_000, extension: { duration: true } } : { ...clip.duration, extension: { duration: true } };
  const properties = { ...clip.properties, extension: { settings: ['captured'] } };
  if (type === 'video' || type === 'audio') Object.assign(properties, {
    sourceRange: { inMs: 500, outMs: 3_500, extension: { trim: true } },
    loop: true, volume: 0.35, muted: true, onBreak: 'loop',
  });
  if (type === 'image' || type === 'text') Object.assign(properties, {
    shadow: { enabled: true, color: '#000000', opacity: 0.7, offsetX: 4, offsetY: 8, blur: 12, extension: { effect: true } },
  });
  return validateSequence({ ...sequence, clips: [{ ...clip, duration,
    entrance: { ...clip.entrance, extension: { transition: true } }, properties,
    appearance: { blendMode: 'screen', opacity: 0.8, extension: { appearance: true } },
    extension: { payload: ['independent'] },
  }] });
}

function errorCode(expected: string) {
  return (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}

for (const type of ['bars', 'text', 'image', 'video', 'audio'] as const) {
  test(`${type} copies preserve versions, transitions, effects, extensions and inspected media metadata`, () => {
    const source = fixture(type);
    const clipboard = new TimelineClipboard();
    const original = structuredClone(source);
    const clip = source.clips[0]!;
    clipboard.copy(source, { kind: 'clip', id: clip.id });
    assert.equal(clipboard.kind, 'clip');
    assert.equal(clipboard.clipType, type);
    const paste = clipboard.paste(source, { positionMs: 5_000, trackId: clip.trackId }, ids(type));
    assert.deepEqual(paste.selection, { kind: 'clip', id: `${type}_1` });
    const copied = paste.sequence.clips.find(item => item.id === paste.selection.id)!;
    assert.deepEqual(copied, { ...clip, id: `${type}_1`, startMs: 5_000 });
    assert.deepEqual(source, original);
    assert.deepEqual(timelineConflicts(paste.sequence), []);
  });
}

test('copy captures independent payload and composition, and repeat paste does not mutate the clipboard', () => {
  const source = fixture();
  const clipboard = new TimelineClipboard();
  clipboard.copy(source, { kind: 'clip', id: source.clips[0]!.id });
  const before = structuredClone(source);
  Object.assign(source.clips[0]!.properties, { text: 'changed afterwards' });
  Object.assign(source.composition, { width: 1000 });
  const destination = validateSequence({ ...emptySequence(), composition: { width: 960, height: 540 } });
  const makeId = ids('paste');
  const first = clipboard.paste(destination, { positionMs: 0 }, makeId);
  const firstClip = first.sequence.clips[0]!;
  assert.equal(firstClip.type, 'text');
  if (firstClip.type !== 'text') throw new Error('Expected text.');
  assert.equal(firstClip.properties.text, 'Title');
  assert.equal(firstClip.properties.fontSize, 48);
  assert.deepEqual(firstClip.properties.box, { x: 96, y: 189, width: 768, height: 162 });
  assert.equal(firstClip.properties.shadow?.offsetY, 4);
  Object.assign(firstClip.properties, { text: 'mutated pasted clip' });
  const second = clipboard.paste(destination, { positionMs: 0 }, makeId);
  assert.notEqual(second.selection.id, first.selection.id);
  assert.equal((second.sequence.clips[0]!.properties as { text: string }).text, 'Title');
  assert.equal(before.composition.width, 1920);
  assert.equal(destination.clips.length, 0);
  clipboard.clear();
  assert.equal(clipboard.hasContent, false);
  assert.equal(clipboard.kind, null);
  assert.equal(clipboard.clipType, null);
  assert.throws(() => clipboard.paste(destination, { positionMs: 0 }, makeId), errorCode('CLIPBOARD_EMPTY'));
});

test('staged cuts retain previous clipboard on failed removal and commit the captured original after success', () => {
  const clipboard = new TimelineClipboard();
  const previous = fixture('image');
  clipboard.copy(previous, { kind: 'clip', id: previous.clips[0]!.id });
  const text = fixture('text');
  const locked = validateSequence({ ...text, tracks: text.tracks.map(track => ({ ...track, locked: true })) });
  const abandoned = clipboard.stageCopy(locked, { kind: 'clip', id: locked.clips[0]!.id });
  assert.equal(typeof abandoned, 'function');
  assert.throws(() => applyEditorTimelineCommand(locked, { kind: 'remove-clip', clipId: locked.clips[0]!.id }, ids()), errorCode('TRACK_LOCKED'));
  assert.equal(clipboard.clipType, 'image');
  assert.throws(() => clipboard.copy(text, { kind: 'clip', id: 'missing' }), errorCode('CLIP_NOT_FOUND'));
  assert.equal(clipboard.clipType, 'image');
  const commit = clipboard.stageCopy(text, { kind: 'clip', id: text.clips[0]!.id });
  const removed = applyEditorTimelineCommand(text, { kind: 'remove-clip', clipId: text.clips[0]!.id }, ids());
  Object.assign(text.clips[0]!.properties, { text: 'late change' });
  commit();
  assert.equal(clipboard.clipType, 'text');
  assert.equal(removed.clips.length, 0);
  assert.equal((clipboard.paste(removed, { positionMs: 0 }, ids()).sequence.clips[0]!.properties as { text: string }).text, 'Title');
});

test('overlap allocates a new compatible track even when an unlocked spare lane is free', () => {
  const source = fixture();
  const withSpare = applyTimelineCommand(source, { kind: 'add-track' }, ids('spare'));
  const before = structuredClone(withSpare);
  const clipboard = new TimelineClipboard();
  clipboard.copy(source, { kind: 'clip', id: source.clips[0]!.id });
  const pasted = clipboard.paste(withSpare, { positionMs: 500, trackId: source.clips[0]!.trackId }, ids('paste'));
  const inserted = pasted.sequence.clips.find(clip => clip.id === pasted.selection.id)!;
  assert.equal(inserted.startMs, 500);
  assert.equal(pasted.sequence.tracks.length, withSpare.tracks.length + 1);
  assert.equal(withSpare.tracks.some(track => track.id === inserted.trackId), false);
  assert.equal(pasted.sequence.tracks.find(track => track.id === inserted.trackId)!.kind, 'visual');
  assert.deepEqual(withSpare, before);
  assert.deepEqual(timelineConflicts(pasted.sequence), []);
});

test('track selection rejects explicit locked/incompatible/missing targets and creates a lane when none fits', () => {
  const source = fixture('audio');
  const clipboard = new TimelineClipboard();
  clipboard.copy(source, { kind: 'clip', id: source.clips[0]!.id });
  const destination = emptySequence();
  assert.throws(() => clipboard.paste(destination, { positionMs: 0, trackId: destination.tracks[0]!.id }, ids()), errorCode('INCOMPATIBLE_TRACK'));
  assert.throws(() => clipboard.paste(destination, { positionMs: 0, trackId: 'missing' }, ids()), errorCode('TRACK_NOT_FOUND'));
  const locked = validateSequence({ ...source, tracks: source.tracks.map(track => ({ ...track, locked: true })) });
  assert.throws(() => clipboard.paste(locked, { positionMs: 0, trackId: source.clips[0]!.trackId }, ids()), errorCode('TRACK_LOCKED'));
  const result = clipboard.paste(destination, { positionMs: 0 }, ids());
  assert.equal(result.sequence.tracks.length, 2);
  assert.equal(result.sequence.tracks.find(track => track.id === result.sequence.clips[0]!.trackId)!.kind, 'audio');
  assert.equal(destination.tracks.length, 1);
});

test('touching intervals stay on the requested track and non-overlapping paste matches shared editor end policy', () => {
  const source = fixture('bars');
  const clipboard = new TimelineClipboard();
  const clip = source.clips[0]!;
  clipboard.copy(source, { kind: 'clip', id: clip.id });
  for (const end of [{ kind: 'fixed', durationMs: 10_000 }, { kind: 'fixed', durationMs: 10_000, automatic: false },
    { kind: 'fixed', durationMs: 10_000, automatic: true }, { kind: 'manual', durationMs: 10_000 }] as SequenceV1['end'][]) {
    const target = validateSequence({ ...source, end });
    const result = clipboard.paste(target, { positionMs: 2_000, trackId: clip.trackId }, () => 'copy');
    const expected = applyEditorTimelineCommand(target, { kind: 'insert-clip', clip: { ...clip, id: 'copy', startMs: 2_000 } }, ids());
    assert.deepEqual(result.sequence, expected);
    assert.equal(result.sequence.schemaVersion, source.schemaVersion);
    assert.equal(result.sequence.tracks.length, source.tracks.length);
  }
});

test('held visual copies carry their resolved interval when pasted beyond an automatic endpoint', () => {
  const source = validateSequence({ ...createBarsSequence('Held', ids(), 1), end: { kind: 'fixed', durationMs: 5_000 } });
  const before = structuredClone(source);
  const clipboard = new TimelineClipboard();
  clipboard.copy(source, { kind: 'clip', id: source.clips[0]!.id });
  assert.deepEqual(source, before);
  const result = clipboard.paste(source, { positionMs: 8_000 }, ids('paste'));
  assert.deepEqual(result.sequence.end, { kind: 'fixed', durationMs: 13_000, automatic: true });
  assert.deepEqual(result.sequence.clips.find(clip => clip.id === result.selection.id)!.duration, { kind: 'fixed', milliseconds: 5_000 });
  assert.equal(result.sequence.schemaVersion, 1);
});

test('held transitions use shared automatic fitting and legacy manual holds use its finite fallback', () => {
  const clipboard = new TimelineClipboard();
  const sample = createBarsSequence('Held', ids(), 1);
  const source = validateSequence({ ...sample, end: { kind: 'fixed', durationMs: 1_000 }, clips: [{ ...sample.clips[0]!,
    entrance: { preset: 'fade', version: 1, durationMs: 800, easing: 'linear' },
    exit: { preset: 'fade', version: 1, durationMs: 800, easing: 'linear' },
  }] });
  clipboard.copy(source, { kind: 'clip', id: source.clips[0]!.id });
  const paste = clipboard.paste(emptySequence(), { positionMs: 12_000 }, ids());
  assert.deepEqual(paste.sequence.clips[0]!.duration, { kind: 'sequence-end' }, 'intentional fixed end retains the authored hold');
  const automatic = validateSequence({ ...emptySequence(), end: { kind: 'fixed', durationMs: 10_000, automatic: true } });
  const fitted = clipboard.paste(automatic, { positionMs: 12_000 }, ids()).sequence.clips[0]!;
  assert.deepEqual(fitted.duration, { kind: 'fixed', milliseconds: 1_000 });
  assert.equal(fitted.entrance.preset !== 'none' && fitted.entrance.durationMs, 500);
  assert.equal(fitted.exit.preset !== 'none' && fitted.exit.durationMs, 500);
  const manual = validateSequence({ ...sample, end: { kind: 'manual' } });
  clipboard.copy(manual, { kind: 'clip', id: manual.clips[0]!.id });
  const fallback = clipboard.paste(automatic, { positionMs: 12_000 }, ids()).sequence.clips[0]!;
  assert.deepEqual(fallback.duration, { kind: 'fixed', milliseconds: 5_000 });
});

test('break paste adopts legacy target explicitly, retains extensions and does not extend its endpoint', () => {
  const source = validateSequence({ ...emptySequence(), breaks: [{ id: 'source_break', positionMs: 500, extension: { marker: ['preserved'] } }] });
  const clipboard = new TimelineClipboard();
  clipboard.copy(source, { kind: 'break', id: 'source_break' });
  assert.equal(clipboard.clipType, null);
  const target = emptySequence(1);
  const before = structuredClone(target);
  const pasted = clipboard.paste(target, { positionMs: 20_000 }, ids('break'));
  assert.deepEqual(pasted.selection, { kind: 'break', id: 'break_1' });
  assert.deepEqual(pasted.sequence.breaks, [{ id: 'break_1', positionMs: 20_000, extension: { marker: ['preserved'] } }]);
  assert.equal(pasted.sequence.schemaVersion, 3);
  assert.deepEqual(pasted.sequence.end, target.end);
  assert.deepEqual(target, before);
  assert.throws(() => clipboard.paste(pasted.sequence, { positionMs: 20_000 }, ids()), errorCode('BREAK_POSITION_TAKEN'));
  assert.throws(() => clipboard.copy(source, { kind: 'break', id: 'missing' }), errorCode('BREAK_NOT_FOUND'));
  assert.equal(clipboard.kind, 'break');
});

test('repeated break pastes isolate copied extensions and use new identities at exact requested positions', () => {
  const source = validateSequence({ ...emptySequence(), breaks: [{ id: 'marker', positionMs: 100, extension: { text: 'original' } }] });
  const clipboard = new TimelineClipboard();
  clipboard.copy(source, { kind: 'break', id: 'marker' });
  Object.assign(source.breaks![0]!, { extension: { text: 'changed source' } });
  const makeId = ids('marker');
  const first = clipboard.paste(emptySequence(2), { positionMs: 50 }, makeId);
  assert.equal(first.sequence.schemaVersion, 3);
  Object.assign(first.sequence.breaks![0]!, { extension: { text: 'changed paste' } });
  const second = clipboard.paste(first.sequence, { positionMs: 51 }, makeId);
  assert.deepEqual(second.sequence.breaks![1], { id: 'marker_2', positionMs: 51, extension: { text: 'original' } });
  assert.notEqual(first.selection.id, second.selection.id);
});

test('unsupported cross-schema media paste fails without silently upgrading a target or discarding the clipboard', () => {
  const source = fixture('video');
  const clipboard = new TimelineClipboard();
  clipboard.copy(source, { kind: 'clip', id: source.clips[0]!.id });
  const target = emptySequence(1);
  const before = structuredClone(target);
  assert.throws(() => clipboard.paste(target, { positionMs: 0 }, ids()), errorCode('UNSUPPORTED_VERSION'));
  assert.deepEqual(target, before);
  assert.equal(clipboard.clipType, 'video');
  const valid = clipboard.paste(emptySequence(3), { positionMs: 0 }, ids());
  assert.equal(valid.sequence.clips[0]!.typeVersion, source.clips[0]!.typeVersion);
});

test('invalid positions, IDs, maximum tracks, clips and breaks reject without changing either source or clipboard', () => {
  const source = fixture('bars');
  const clipboard = new TimelineClipboard();
  clipboard.copy(source, { kind: 'clip', id: source.clips[0]!.id });
  for (const positionMs of [-1, 0.5, Infinity, SEQUENCE_LIMITS.timelineMs + 1]) {
    assert.throws(() => clipboard.paste(source, { positionMs }, ids()), errorCode('INVALID_TIME'));
  }
  assert.throws(() => clipboard.paste(source, { positionMs: SEQUENCE_LIMITS.timelineMs }, ids()), errorCode('INVALID_TIMING'));
  assert.throws(() => clipboard.paste(source, { positionMs: 2_000 }, () => source.clips[0]!.id), errorCode('DUPLICATE_ID'));
  const fullTracks = validateSequence({ ...source, tracks: Array.from({ length: SEQUENCE_LIMITS.tracks }, (_, order) => ({ ...source.tracks[0]!, id: order === 0 ? source.tracks[0]!.id : `track_${order}`, order })) });
  const before = structuredClone(fullTracks);
  assert.throws(() => clipboard.paste(fullTracks, { positionMs: 0, trackId: fullTracks.tracks[0]!.id }, ids()), errorCode('TRACK_LIMIT'));
  assert.deepEqual(fullTracks, before);
  const fullClips = validateSequence({ ...source, end: { kind: 'fixed', durationMs: 2_000_000, automatic: false },
    clips: Array.from({ length: SEQUENCE_LIMITS.clips }, (_, index) => ({ ...source.clips[0]!, id: `clip_${index}`, startMs: index * 2_000 })) });
  assert.throws(() => clipboard.paste(fullClips, { positionMs: SEQUENCE_LIMITS.clips * 2_000 }, ids()), errorCode('LIMIT_EXCEEDED'));
  const fullBreaks = validateSequence({ ...emptySequence(), breaks: Array.from({ length: SEQUENCE_LIMITS.breaks }, (_, index) => ({ id: `break_${index}`, positionMs: index * 100 })) });
  clipboard.copy(fullBreaks, { kind: 'break', id: 'break_0' });
  assert.throws(() => clipboard.paste(fullBreaks, { positionMs: 30_000 }, ids()), errorCode('BREAK_LIMIT'));
  assert.throws(() => clipboard.paste(fullBreaks, { positionMs: 1.5 }, ids()), errorCode('BREAK_POSITION_INVALID'));
  assert.equal(clipboard.kind, 'break');
});
