import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEditorTimelineCommand, applyTimelineCommand, TimelineCommandError, timelineConflicts, type TimelineCommand } from '../src/application/timeline-commands.js';
import type { BarsClip, SequenceV1, TextClip, VideoClip } from '../src/domain/sequence.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import { upgradeSequenceToBreaks } from '../src/domain/breaks.js';

function ids(prefix = 'id') {
  let index = 0;
  return () => `${prefix}_${++index}`;
}

function emptySequence(end: SequenceV1['end'] = { kind: 'fixed', durationMs: 5_000 }): SequenceV1 {
  const base = createBarsSequence('Timeline', ids('base'));
  return validateSequence({ ...base, clips: [], end });
}

const defaultMakeId = ids('edit');

test('inserting a prepared element preserves its settings and moves overlaps to a free lane', () => {
  const source = createBarsSequence('Prepared elements', ids('prepared'));
  const original = structuredClone(source);
  const prepared = { ...source.clips[0]! as BarsClip, id: 'new-prepared-clip', duration: { kind: 'fixed' as const, milliseconds: 5000 },
    properties: { heightFraction: 0.5, color: '#ff0000' } };
  const result = applyEditorTimelineCommand(source, { kind: 'insert-clip', clip: prepared }, ids('insert'));
  const inserted = result.clips.find(clip => clip.id === prepared.id)!;
  assert.notEqual(inserted.trackId, prepared.trackId);
  assert.deepEqual(inserted.properties, prepared.properties);
  assert.equal(result.clips.length, source.clips.length + 1);
  assert.deepEqual(source, original);
  assert.deepEqual(timelineConflicts(result), []);
  assert.throws(() => applyEditorTimelineCommand(result, { kind: 'insert-clip', clip: inserted }, ids('again')), code('DUPLICATE_ID'));
});

test('prepared insertion rejects a locked destination and extends automatic timing', () => {
  const source = emptySequence({ kind: 'fixed', durationMs: 5000, automatic: true });
  const sample = createBarsSequence('Sample', ids('sample')).clips[0]! as BarsClip;
  const clip = { ...sample, id: 'inserted', trackId: source.tracks[0]!.id, startMs: 8000,
    duration: { kind: 'fixed' as const, milliseconds: 3000 } };
  const result = applyEditorTimelineCommand(source, { kind: 'insert-clip', clip }, ids('placement'));
  assert.deepEqual(result.end, { kind: 'fixed', durationMs: 11000, automatic: true });
  const locked = { ...source, tracks: source.tracks.map(track => ({ ...track, locked: true })) };
  assert.throws(() => applyEditorTimelineCommand(locked, { kind: 'insert-clip', clip }, ids('locked')), code('TRACK_LOCKED'));
});

function apply(sequence: SequenceV1, command: Parameters<typeof applyTimelineCommand>[1], makeId = defaultMakeId): SequenceV1 {
  return applyTimelineCommand(sequence, command, makeId);
}

function code(codeName: string) {
  return (error: unknown): boolean => error instanceof TimelineCommandError && error.code === codeName;
}

test('inner Break commands explicitly require legacy adoption, upgrade schema 2 once and never extend the endpoint', () => {
  const legacy = createBarsSequence('Legacy', ids('legacy'));
  assert.throws(() => apply(legacy, { kind: 'add-break', positionMs: 0 }), code('BREAKS_UPGRADE_REQUIRED'));
  const adopted = upgradeSequenceToBreaks(legacy);
  const before = structuredClone(adopted);
  const added = apply(adopted, { kind: 'add-break', positionMs: 7_000 }, ids('marker'));
  assert.equal(added.schemaVersion, 3);
  assert.deepEqual(adopted, before, 'adding a marker leaves the schema-2 source untouched');
  assert.deepEqual(added.end, adopted.end, 'a marker beyond the endpoint does not extend the sequence');
  assert.deepEqual(added.breaks, [{ id: 'marker_1', positionMs: 7_000 }]);
  assert.throws(() => apply(added, { kind: 'add-break', positionMs: 7_000 }), code('BREAK_POSITION_TAKEN'));
  assert.throws(() => apply(added, { kind: 'move-break', breakId: 'marker_1', positionMs: 7_000.5 }), code('BREAK_POSITION_INVALID'));
  const moved = apply(added, { kind: 'move-break', breakId: 'marker_1', positionMs: 9_000 });
  assert.deepEqual(moved.breaks, [{ id: 'marker_1', positionMs: 9_000 }], 'moving a marker keeps its stable ID');
  assert.deepEqual(moved.end, adopted.end);
  const removed = apply(moved, { kind: 'remove-break', breakId: 'marker_1' });
  assert.deepEqual(removed.breaks, []);
  assert.deepEqual(removed.end, adopted.end);
});

test('timeline commands return isolated validated clones and leave siblings and extensions intact', () => {
  const first = createBarsSequence('Source', ids('source'));
  const secondTrack = { ...first.tracks[0]!, id: 'second_track', name: 'Second', order: 1 };
  const firstClip = { ...first.clips[0]!, properties: { ...first.clips[0]!.properties, extension: { marker: 'stay' } } };
  const sibling = {
    ...first.clips[0]!, id: 'sibling', trackId: 'second_track', startMs: 1_000,
    duration: { kind: 'fixed' as const, milliseconds: 1_000 }
  };
  const source = validateSequence({
    ...first, tracks: [first.tracks[0]!, secondTrack], clips: [firstClip, sibling],
    extension: { future: ['preserve'] }
  });
  const before = structuredClone(source);
  const result = apply(source, { kind: 'rename-track', trackId: first.tracks[0]!.id, name: 'Renamed' });

  assert.notEqual(result, source);
  assert.deepEqual(source, before);
  assert.equal(result.tracks[0]!.name, 'Renamed');
  assert.deepEqual((result.clips[0]!.properties as Record<string, unknown>).extension, { marker: 'stay' });
  assert.deepEqual(result.clips[1], source.clips[1]);
  assert.deepEqual((result as SequenceV1 & { extension: unknown }).extension, { future: ['preserve'] });
});

test('text clips may touch but cannot overlap on one track', () => {
  const source = emptySequence();
  const one = apply(source, { kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'text', startMs: 0 });
  const two = apply(one, { kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'text', startMs: 5_000 });
  assert.equal(two.clips.length, 2);
  assert.deepEqual(timelineConflicts(two), []);
  assert.throws(
    () => apply(two, { kind: 'move-clip', clipId: two.clips[1]!.id, trackId: two.tracks[0]!.id, startMs: 4_999 }),
    code('CLIP_OVERLAP')
  );
});

test('manual sequence-end clips block later same-track clips until the end is fixed', () => {
  const source = emptySequence({ kind: 'manual' });
  const bars = apply(source, { kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'bars', startMs: 0 });
  assert.throws(
    () => apply(bars, { kind: 'add-clip', trackId: bars.tracks[0]!.id, type: 'text', startMs: 1_000 }),
    code('CLIP_OVERLAP')
  );
  const fixed = apply(bars, { kind: 'resize-clip', clipId: bars.clips[0]!.id, edge: 'end', timeMs: 5_000 });
  const text = apply(fixed, { kind: 'add-clip', trackId: fixed.tracks[0]!.id, type: 'text', startMs: 5_000 });
  assert.equal(text.clips.length, 2);
});

test('adding and trimming a video preserves manual completion and extensions', () => {
  const source = emptySequence({
    kind: 'manual', clipId: 'obsolete-target', durationMs: 123, futureEndField: { retained: true }
  } as SequenceV1['end']);
  const added = apply(source, {
    kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'video', startMs: 1_000,
    sourcePath: 'worlds/demo/clip.webm', sourceDurationMs: 5_000
  });
  assert.deepEqual(added.end, source.end);
  const video = added.clips[0] as VideoClip;
  const extended = apply(added, {
    kind: 'replace-clip',
    clip: {
      ...video, typeVersion: 2,
      properties: { ...video.properties, sourceRange: { inMs: 0, outMs: 5_000, marker: 'keep' } as VideoClip['properties']['sourceRange'] & { marker: string } }
    }
  });
  const trimmed = apply(extended, { kind: 'resize-clip', clipId: video.id, edge: 'start', timeMs: 1_500 });
  const result = trimmed.clips[0] as VideoClip;
  assert.equal(result.startMs, 1_500);
  assert.equal(result.typeVersion, 2);
  assert.deepEqual(result.properties.sourceRange, { inMs: 500, outMs: 5_000, marker: 'keep' });
  assert.deepEqual(extended.end, source.end);
  assert.deepEqual(trimmed.end, source.end);
});

test('resizing the end of a sequence-end clip makes only that clip fixed', () => {
  const source = emptySequence({ kind: 'manual' });
  const addedBars = apply(source, { kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'bars', startMs: 0 });
  const barsClip = addedBars.clips[0]!;
  const bars = validateSequence({
    ...addedBars,
    clips: [{ ...barsClip, duration: { ...barsClip.duration, customDuration: { retained: true } } }]
  });
  const resized = apply(bars, { kind: 'resize-clip', clipId: bars.clips[0]!.id, edge: 'end', timeMs: 2_500 });
  assert.deepEqual(resized.end, { kind: 'manual' });
  assert.deepEqual(resized.clips[0]!.duration, { kind: 'fixed', milliseconds: 2_500, customDuration: { retained: true } });
});

test('manual video timing and editor gestures preserve the authored end policy and its extensions', () => {
  const empty = emptySequence({ kind: 'manual', futureEndField: { retained: true } } as SequenceV1['end']);
  const source = apply(empty, {
    kind: 'add-clip', trackId: empty.tracks[0]!.id, type: 'video', startMs: 1_000,
    sourcePath: 'worlds/demo/clip.webm', sourceDurationMs: 5_000
  });
  const clip = source.clips[0] as VideoClip;
  const commands: readonly TimelineCommand[] = [
    { kind: 'move-clip', clipId: clip.id, trackId: clip.trackId, startMs: 2_000 },
    { kind: 'resize-clip', clipId: clip.id, edge: 'end', timeMs: 4_000 },
    { kind: 'replace-clip', clip: { ...clip, properties: { ...clip.properties, durationMs: 4_000 } } },
    { kind: 'duplicate-clip', clipId: clip.id },
    { kind: 'remove-clip', clipId: clip.id },
    { kind: 'add-clip', trackId: clip.trackId, type: 'text', startMs: 6_000 }
  ];
  for (const edit of [applyTimelineCommand, applyEditorTimelineCommand]) {
    for (const command of commands) {
      const result = edit(source, command, ids('manual'));
      assert.deepEqual(result.end, empty.end, command.kind);
      assert.deepEqual(timelineConflicts(result), [], command.kind);
    }
  }
});

for (const type of ['bars', 'text'] as const) {
  test(`moving finite held ${type} translates its duration and preserves siblings and extensions`, () => {
    const empty = emptySequence();
    const added = apply(empty, { kind: 'add-clip', trackId: empty.tracks[0]!.id, type, startMs: 1_000 });
    const clip = added.clips[0]!;
    const source = validateSequence({
      ...added, extension: { keep: ['sequence'] },
      end: { kind: 'fixed', durationMs: 5_000, extension: { keep: 'end' } },
      tracks: [...added.tracks, { ...added.tracks[0]!, id: 'destination', order: 1 }, { ...added.tracks[0]!, id: 'sibling-track', order: 2 }],
      clips: [
        { ...clip, duration: { kind: 'sequence-end', extension: { keep: ['duration'] } }, extension: { keep: 'clip' },
          entrance: { ...clip.entrance, extension: { keep: 'entrance' } }, properties: { ...clip.properties, extension: { keep: 'properties' } } },
        { ...clip, id: 'sibling', trackId: 'sibling-track', startMs: 0, duration: { kind: 'fixed', milliseconds: 2_000 } }
      ]
    });
    const before = structuredClone(source);
    for (const [startMs, trackId] of [[2_000, clip.trackId], [0, clip.trackId], [2_000, 'destination']] as const) {
      const moved = apply(source, { kind: 'move-clip', clipId: clip.id, startMs, trackId });
      assert.deepEqual(moved.clips[0], {
        ...source.clips[0], startMs, trackId,
        duration: { kind: 'fixed', milliseconds: 4_000, extension: { keep: ['duration'] } }
      });
      assert.deepEqual(moved.clips[1], source.clips[1]);
      assert.deepEqual(moved.end, { ...source.end, durationMs: Math.max(5_000, startMs + 4_000) });
      assert.deepEqual((moved as SequenceV1 & { extension: unknown }).extension, { keep: ['sequence'] });
      assert.deepEqual(source, before);
    }
    // Track-only moves and clicks preserve the user's held-duration choice.
    for (const trackId of [clip.trackId, 'destination']) {
      const moved = apply(source, { kind: 'move-clip', clipId: clip.id, startMs: clip.startMs, trackId });
      assert.deepEqual(moved.clips[0]!.duration, source.clips[0]!.duration);
      assert.deepEqual(moved.end, source.end);
    }
    const manual = validateSequence({ ...source, end: { kind: 'manual' } });
    const moved = apply(manual, { kind: 'move-clip', clipId: clip.id, startMs: 2_000, trackId: 'destination' });
    assert.deepEqual(moved.clips[0]!.duration, manual.clips[0]!.duration);
    assert.deepEqual(moved.end, { kind: 'manual' });
  });
}

test('moving finite held clips preserves the media endpoint and rejects overflow', () => {
  const empty = emptySequence();
  const video = apply(empty, { kind: 'add-clip', trackId: empty.tracks[0]!.id, type: 'video', startMs: 0,
    sourcePath: 'scene.webm', sourceDurationMs: 5_000 });
  const tracks = apply(video, { kind: 'add-track' });
  const bars = apply(tracks, { kind: 'add-clip', trackId: tracks.tracks[1]!.id, type: 'bars', startMs: 1_000 });
  const source = apply(bars, { kind: 'set-end', end: { kind: 'media', clipId: video.clips[0]!.id } });
  const clip = source.clips[1]!;
  const before = structuredClone(source);
  const left = apply(source, { kind: 'move-clip', clipId: clip.id, startMs: 0, trackId: clip.trackId });
  assert.deepEqual(left.clips[1]!.duration, { kind: 'fixed', milliseconds: 4_000 });
  assert.deepEqual(left.end, source.end);
  assert.deepEqual(left.clips[0], source.clips[0]);
  assert.throws(() => apply(source, { kind: 'move-clip', clipId: clip.id, startMs: 2_000, trackId: clip.trackId }),
    code('CLIP_BEYOND_SEQUENCE_END'));
  assert.deepEqual(source, before);
});

test('duplicate prefers a valid same-track insertion and falls back to a named new track when blocked', () => {
  const source = emptySequence();
  const first = apply(source, { kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'text', startMs: 0 });
  const second = apply(first, { kind: 'add-clip', trackId: first.tracks[0]!.id, type: 'text', startMs: 5_000 });
  const duplicated = apply(second, { kind: 'duplicate-clip', clipId: second.clips[0]!.id }, ids('copy'));
  assert.equal(duplicated.tracks.length, 2);
  const copy = duplicated.clips.find(clip => clip.id !== second.clips[0]!.id && clip.id !== second.clips[1]!.id)!;
  assert.equal(copy.startMs, 0);
  assert.notEqual(copy.trackId, second.clips[0]!.trackId);
  assert.equal(duplicated.tracks.find(track => track.id === copy.trackId)?.name, 'Visual 1 Copy');
  assert.deepEqual(timelineConflicts(duplicated), []);
});

test('locked tracks permit unlocking but block clip and track edits while locked', () => {
  const source = emptySequence();
  const locked = validateSequence({ ...source, tracks: [{ ...source.tracks[0]!, locked: true }] });
  assert.throws(() => apply(locked, { kind: 'add-clip', trackId: locked.tracks[0]!.id, type: 'text', startMs: 0 }), code('TRACK_LOCKED'));
  assert.throws(() => apply(locked, { kind: 'rename-track', trackId: locked.tracks[0]!.id, name: 'x' }), code('TRACK_LOCKED'));
  const unlocked = apply(locked, { kind: 'toggle-track', trackId: locked.tracks[0]!.id, property: 'locked' });
  assert.equal(unlocked.tracks[0]!.locked, false);
  assert.equal((unlocked.clips[0] as TextClip | undefined), undefined);
});

test('track commands use front as greater order and compact ranks after removal', () => {
  const source = emptySequence();
  const second = { ...source.tracks[0]!, id: 'second-track', name: 'Second', order: 1 };
  const third = { ...source.tracks[0]!, id: 'third-track', name: 'Third', order: 2 };
  const three = validateSequence({ ...source, tracks: [source.tracks[0]!, second, third] });
  const moved = apply(three, { kind: 'move-track', trackId: three.tracks[0]!.id, direction: 'up' });
  assert.ok(moved.tracks.find(track => track.id === three.tracks[0]!.id)!.order > moved.tracks.find(track => track.id === 'second-track')!.order);
  const removed = apply(moved, { kind: 'remove-track', trackId: 'third-track' });
  assert.deepEqual([...removed.tracks].map(track => track.order).sort(), [0, 1]);
});

test('adding a track compacts a sparse rank at the supported order ceiling', () => {
  const source = emptySequence();
  const sparseTrack = {
    ...source.tracks[0]!, order: 63, futureTrackField: { retained: true }
  };
  const sparse = validateSequence({ ...source, tracks: [sparseTrack] });

  const added = apply(sparse, { kind: 'add-track', name: 'New layer' }, ids('sparse'));
  const original = added.tracks.find(track => track.id === sparseTrack.id)!;
  const appended = added.tracks.find(track => track.id !== sparseTrack.id)!;
  assert.equal(original.order, 0);
  assert.deepEqual((original as typeof sparseTrack).futureTrackField, { retained: true });
  assert.equal(appended.order, 1);
  assert.equal(original.id, sparseTrack.id);
});

test('media sequence end keeps its target and rejects clips beyond its inspected endpoint', () => {
  const source = emptySequence();
  const firstVideo = apply(source, {
    kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'video', startMs: 0,
    sourcePath: 'worlds/demo/first.webm', sourceDurationMs: 3_000
  });
  const secondTrack = apply(firstVideo, { kind: 'add-track', name: 'Second video' });
  const secondVideo = apply(secondTrack, {
    kind: 'add-clip', trackId: secondTrack.tracks[1]!.id, type: 'video', startMs: 3_000,
    sourcePath: 'worlds/demo/second.webm', sourceDurationMs: 3_000
  });
  assert.throws(
    () => apply(secondVideo, { kind: 'set-end', end: { kind: 'media', clipId: firstVideo.clips[0]!.id } }),
    code('CLIP_BEYOND_SEQUENCE_END')
  );
  assert.equal(secondVideo.end.kind, 'fixed');
});

test('manual end permits video regardless of track visibility', () => {
  const source = emptySequence();
  const videoSequence = apply(source, {
    kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'video', startMs: 0,
    sourcePath: 'worlds/demo/disabled.webm', sourceDurationMs: 3_000
  });
  const trackId = videoSequence.clips[0]!.trackId;
  const disabled = apply(videoSequence, { kind: 'toggle-track', trackId, property: 'enabled' });
  const manual = apply(disabled, { kind: 'set-end', end: { kind: 'manual' } });
  assert.equal(manual.end.kind, 'manual');
  assert.deepEqual(timelineConflicts(manual), []);
  const enabled = apply(manual, { kind: 'toggle-track', trackId, property: 'enabled' });
  assert.deepEqual(enabled.end, { kind: 'manual' });
  assert.deepEqual(timelineConflicts(enabled), []);
});

test('media sequence end rejects an entrance that cannot finish before the endpoint', () => {
  const source = emptySequence();
  const withVideo = apply(source, {
    kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'video', startMs: 0,
    sourcePath: 'worlds/demo/target.webm', sourceDurationMs: 3_000
  });
  const withTrack = apply(withVideo, { kind: 'add-track', name: 'Bars' });
  const withBars = apply(withTrack, { kind: 'add-clip', trackId: withTrack.tracks[1]!.id, type: 'bars', startMs: 0 });
  const bars = withBars.clips.find(clip => clip.type === 'bars')!;
  const longEntrance = apply(withBars, {
    kind: 'replace-clip', clip: { ...bars, entrance: { preset: 'fade', version: 1, durationMs: 4_000, easing: 'linear' } }
  });
  assert.throws(
    () => apply(longEntrance, { kind: 'set-end', end: { kind: 'media', clipId: withVideo.clips[0]!.id } }),
    code('CLIP_BEYOND_SEQUENCE_END')
  );
});

test('removing a referenced video replaces the media end with a valid fixed duration', () => {
  const source = emptySequence();
  const videoSequence = apply(source, {
    kind: 'add-clip', trackId: source.tracks[0]!.id, type: 'video', startMs: 0,
    sourcePath: 'worlds/demo/clip.webm', sourceDurationMs: 3_000
  });
  const video = videoSequence.clips[0]!;
  const mediaEnd = apply(videoSequence, {
    kind: 'set-end', end: {
      kind: 'media', clipId: video.id, durationMs: 3_000, futureEndField: { retained: true }
    } as SequenceV1['end']
  });
  const removed = apply(mediaEnd, { kind: 'remove-clip', clipId: video.id });
  assert.deepEqual(removed.end, { kind: 'fixed', durationMs: 5_000, futureEndField: { retained: true } });
  assert.equal('clipId' in removed.end, false);
  assert.deepEqual(removed.clips, []);
});

