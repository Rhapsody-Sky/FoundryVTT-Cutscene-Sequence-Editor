import test from 'node:test';
import assert from 'node:assert/strict';
import type { SequenceV1, TextClip, VideoClip, VisualClip } from '../src/domain/sequence.js';
import { videoDurationMs, videoTypeVersion } from '../src/domain/clip-timing.js';
import { duplicateSequence, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { applyTimelineCommand } from '../src/application/timeline-commands.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';

function video(loop = true, id = 'movie', trackId = 'main', startMs = 1_000): VideoClip {
  return {
    id, trackId, startMs, type: 'video', typeVersion: loop ? 3 : 1, duration: { kind: 'media' },
    entrance: { preset: 'fade', version: 1, durationMs: 250, easing: 'linear' },
    exit: { preset: 'fade', version: 1, durationMs: 500, easing: 'linear' },
    properties: {
      source: { kind: 'foundry-file', path: 'worlds/test/movie.webm' },
      fit: 'contain', volume: 0.7, muted: false, durationMs: 5_000,
      ...(loop ? { loop: true } : {})
    }
  };
}

function sequence(clips: readonly VisualClip[] = [video()]): SequenceV1 {
  return {
    schemaVersion: 1, id: 'loop-sequence', revision: 7, name: 'Video loop',
    composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 500 },
    tracks: [...new Set(clips.map(clip => clip.trackId))].map((id, order) => ({
      id, order, name: id, kind: 'visual', enabled: true, locked: false
    })),
    clips, end: { kind: 'manual' }
  };
}

function trimmed(loop = true): VideoClip {
  const base = video(loop);
  const properties = { ...base.properties, sourceRange: { inMs: 1_000, outMs: 3_000 } };
  return { ...base, properties, typeVersion: videoTypeVersion(properties) };
}

function ids(): () => string {
  let next = 0;
  return () => `copy_${++next}`;
}

test('video versions distinguish full source, trimming, and explicit looping without adding defaults', () => {
  assert.equal(videoTypeVersion({}), 1);
  assert.equal(videoTypeVersion({ loop: false }), 1);
  assert.equal(videoTypeVersion({ sourceRange: { inMs: 1, outMs: 2 } }), 2);
  assert.equal(videoTypeVersion({ loop: false, sourceRange: { inMs: 1, outMs: 2 } }), 2);
  assert.equal(videoTypeVersion({ loop: true }), 3);
  assert.equal(videoTypeVersion({ loop: true, sourceRange: { inMs: 1, outMs: 2 } }), 3);
  for (const clip of [video(false), trimmed(false), video(), trimmed()]) {
    const loaded = validateSequence(sequence([clip])).clips[0] as VideoClip;
    assert.deepEqual(loaded, clip);
    assert.equal(Object.hasOwn(loaded.properties, 'loop'), Object.hasOwn(clip.properties, 'loop'));
    const explicitFalse = { ...clip, typeVersion: clip.properties.sourceRange ? 2 as const : 1 as const,
      properties: { ...clip.properties, loop: false } };
    assert.deepEqual(validateSequence(sequence([explicitFalse])).clips[0], explicitFalse);
  }
});

test('validation rejects incompatible loop versions and nonboolean loop values', () => {
  const clip = video();
  const check = (candidate: unknown, code: string, path: string) => assert.throws(
    () => validateSequence({ ...sequence(), clips: [candidate] }),
    error => error instanceof SequenceValidationError && error.code === code && error.path === path
  );
  for (const typeVersion of [1, 2]) {
    check({ ...trimmed(), typeVersion }, 'UNSUPPORTED_VERSION', 'sequence.clips[0].typeVersion');
  }
  check({ ...clip, typeVersion: 4 }, 'INVALID_VALUE', 'sequence.clips[0].properties.keying.enabled');
  const { loop: _loop, ...properties } = clip.properties;
  for (const next of [properties, { ...properties, loop: false }]) {
    check({ ...clip, properties: next }, 'INVALID_VALUE', 'sequence.clips[0].properties.loop');
  }
  for (const loop of [null, 0, 1, 'true', [], {}]) {
    check({ ...clip, properties: { ...properties, loop } }, 'INVALID_VALUE', 'sequence.clips[0].properties.loop');
  }
  check({ ...video(false), typeVersion: 2 }, 'INVALID_VALUE', 'sequence.clips[0].properties.sourceRange');
  check({ ...trimmed(false), typeVersion: 1 }, 'UNSUPPORTED_VERSION', 'sequence.clips[0].typeVersion');
});

test('looping source ranges require inspected metadata and valid whole-millisecond bounds', () => {
  const clip = trimmed();
  const { durationMs: _duration, ...properties } = clip.properties;
  assert.throws(() => validateSequence(sequence([{ ...clip, properties }])), /inspected/);
  for (const sourceRange of [
    { inMs: -1, outMs: 3_000 }, { inMs: 1_000, outMs: 5_001 },
    { inMs: 1_000, outMs: 1_000 }, { inMs: 3_000, outMs: 1_000 },
    { inMs: 1.5, outMs: 3_000 }, { inMs: 1_000, outMs: Number.POSITIVE_INFINITY }
  ]) {
    assert.throws(() => validateSequence(sequence([{ ...clip, properties: { ...clip.properties, sourceRange } }])));
  }
  const { durationMs: _unknown, ...uninspected } = video().properties;
  assert.throws(() => compileSequence(sequence([{ ...video(), properties: uninspected }])), /MEDIA_METADATA_REQUIRED/);
  assert.equal(videoDurationMs(clip), 2_000);
  assert.equal(clip.properties.durationMs, 5_000);
});

test('trimming and restoring full source retain looping and choose compatible legacy versions', () => {
  for (const loop of [true, false]) {
    const original = sequence([video(loop)]);
    const trimmedSequence = applyTimelineCommand(original,
      { kind: 'resize-clip', clipId: 'movie', edge: 'end', timeMs: 4_000 }, ids());
    const short = trimmedSequence.clips[0] as VideoClip;
    assert.equal(short.typeVersion, loop ? 3 : 2);
    assert.deepEqual(short.properties.sourceRange, { inMs: 0, outMs: 3_000 });
    const movedStart = applyTimelineCommand(trimmedSequence,
      { kind: 'resize-clip', clipId: 'movie', edge: 'start', timeMs: 2_000 }, ids());
    assert.deepEqual((movedStart.clips[0] as VideoClip).properties.sourceRange, { inMs: 1_000, outMs: 3_000 });
    assert.equal(movedStart.clips[0]!.typeVersion, loop ? 3 : 2);
    const restoredStart = applyTimelineCommand(movedStart,
      { kind: 'resize-clip', clipId: 'movie', edge: 'start', timeMs: 1_000 }, ids());
    const restored = applyTimelineCommand(restoredStart,
      { kind: 'resize-clip', clipId: 'movie', edge: 'end', timeMs: 6_000 }, ids());
    assert.deepEqual(restored, original);
  }
});

test('validation round trips and duplication preserve loop, metadata, and JSON extensions', () => {
  const source = sequence([{ ...trimmed(), extension: { marker: 'clip' },
    properties: { ...trimmed().properties, extension: { flags: ['keep'] },
      source: { ...trimmed().properties.source, extension: 'source' },
      sourceRange: { inMs: 1_000, outMs: 3_000, extension: 'range' } }
  } as VideoClip]);
  const roundTrip = validateSequence(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(roundTrip, source);
  const copy = duplicateSequence(roundTrip, 'Copy', ids());
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.clips[0]!.id, source.clips[0]!.id);
  assert.equal(copy.clips[0]!.trackId, copy.tracks[0]!.id);
  assert.deepEqual(copy.clips[0]!.properties, source.clips[0]!.properties);
  assert.equal(copy.clips[0]!.typeVersion, 3);
  const clipCopy = applyTimelineCommand(source, { kind: 'duplicate-clip', clipId: 'movie' }, ids());
  assert.deepEqual(clipCopy.clips[1]!.properties, source.clips[0]!.properties);
  assert.equal(clipCopy.clips[1]!.typeVersion, 3);
  assert.deepEqual(source, roundTrip);
});

test('explicit loop removal stays removed during replacement while unknown extensions survive', () => {
  const sourceClip = { ...trimmed(), extension: 'clip',
    properties: { ...trimmed().properties, extension: { keep: true } } };
  const { loop: _loop, ...properties } = trimmed().properties;
  const replacement: VideoClip = { ...trimmed(), typeVersion: videoTypeVersion(properties), properties };
  const changed = applyTimelineCommand(sequence([sourceClip]), { kind: 'replace-clip', clip: replacement }, ids());
  const saved = changed.clips[0] as VideoClip & { extension: string };
  assert.equal(saved.typeVersion, 2);
  assert.equal(Object.hasOwn(saved.properties, 'loop'), false);
  assert.deepEqual(saved.properties, { ...properties, extension: { keep: true } });
  assert.equal(saved.extension, 'clip');
});

test('terminal manual videos keep absolute local time across cycles and rewinds with a single entrance', () => {
  for (const clip of [video(), trimmed()]) {
    const plan = compileSequence(sequence([clip]));
    const duration = videoDurationMs(clip)!;
    assert.deepEqual(evaluate(plan, 999), []);
    for (const localTimeMs of [0, 125, duration - 1, duration, duration + 125, duration * 3 + 300, 60_000, 125]) {
      const item = evaluate(plan, clip.startMs + localTimeMs)[0]!;
      assert.equal(item.videoLoop, true);
      assert.equal(item.localTimeMs, localTimeMs);
      assert.equal(item.opacity, Math.min(1, localTimeMs / 250));
    }
  }
  const nonloop = compileSequence(sequence([trimmed(false)]));
  const held = evaluate(nonloop, 60_000)[0]!;
  assert.equal(held.localTimeMs, 2_000);
  assert.equal(Object.hasOwn(held, 'videoLoop'), false);
  assert.equal(held.opacity, 1);
});

test('loop opt-in does not change finite sequences, earlier clips, or hidden tracks', () => {
  const first = trimmed();
  const later: TextClip = {
    id: 'title', trackId: 'main', startMs: 4_000, type: 'text', typeVersion: 1,
    duration: { kind: 'fixed', milliseconds: 1_000 },
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { text: 'Title', fontFamily: 'serif', fontSize: 48, minimumFontSize: 24, color: '#ffffff',
      align: 'center', box: { x: 0, y: 0, width: 100, height: 100 }, shrinkToFit: true }
  };
  const withLater = compileSequence(sequence([later, first]));
  assert.equal(evaluate(withLater, 2_750)[0]!.opacity, 0.5);
  assert.equal(Object.hasOwn(evaluate(withLater, 2_750)[0]!, 'videoLoop'), false);
  for (const position of [3_000, 3_999, 5_000, 60_000]) assert.deepEqual(evaluate(withLater, position), []);
  assert.deepEqual(evaluate(withLater, 4_000).map(item => item.clip.id), ['title']);
  for (const end of [{ kind: 'fixed' as const, durationMs: 4_000 }, { kind: 'media' as const, clipId: first.id }]) {
    const looping = compileSequence({ ...sequence([first]), end });
    const ordinary = compileSequence({ ...sequence([trimmed(false)]), end });
    for (const position of [999, 1_125, 2_750, 3_000, 3_001, 60_000]) {
      assert.deepEqual(evaluate(looping, position).map(item => [item.localTimeMs, item.opacity, Object.hasOwn(item, 'videoLoop')]),
        evaluate(ordinary, position).map(item => [item.localTimeMs, item.opacity, false]));
    }
  }
  const hidden = video(true, 'hidden', 'hidden', 10_000);
  const visible = sequence([first, hidden]);
  const plan = compileSequence({ ...visible,
    tracks: visible.tracks.map(track => track.id === 'hidden' ? { ...track, enabled: false } : track) });
  assert.deepEqual(evaluate(plan, 60_000).map(item => [item.clip.id, item.localTimeMs, item.videoLoop]), [['movie', 59_000, true]]);
});
