import test from 'node:test';
import assert from 'node:assert/strict';
import type { SequenceV1, VideoClip, VideoKeying } from '../src/domain/sequence.js';
import { videoDurationMs, videoTypeVersion } from '../src/domain/clip-timing.js';
import { duplicateSequence, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { applyTimelineCommand } from '../src/application/timeline-commands.js';
import { compileSequence } from '../src/playback/evaluate.js';

const keying: VideoKeying = { enabled: true, color: '#00FF00', tolerance: 0.2, softness: 0.1 };

function video(properties: Partial<VideoClip['properties']> = {}): VideoClip {
  const next = {
    source: { kind: 'foundry-file' as const, path: 'worlds/test/movie.webm' },
    fit: 'contain' as const, muted: true, volume: 0.7, durationMs: 5_000, ...properties
  };
  return {
    id: 'movie', trackId: 'visual', type: 'video', typeVersion: videoTypeVersion(next), startMs: 1_000,
    duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: next
  };
}

function sequence(clip: VideoClip = video({ keying })): SequenceV1 {
  return {
    schemaVersion: 1, id: 'keying-sequence', revision: 9, name: 'Keyed video',
    composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 500 },
    tracks: [{ id: 'visual', name: 'Video', kind: 'visual', order: 0, enabled: true, locked: false }],
    clips: [clip], end: { kind: 'manual' }
  };
}

function ids(): () => string {
  let next = 0;
  return () => `copy_${++next}`;
}

function rejects(clip: unknown, path: string, code = 'INVALID_VALUE'): void {
  assert.throws(() => validateSequence({ ...sequence(), clips: [clip] }),
    error => error instanceof SequenceValidationError && error.path === `sequence.clips[0].${path}` && error.code === code);
}

test('active keying takes version precedence over loop and trimming; disabled settings retain legacy versions', () => {
  for (const enabled of [true, false]) {
    for (const loop of [true, false]) {
      for (const trimmed of [true, false]) {
        const clip = video({ keying: { ...keying, enabled }, loop,
          ...(trimmed ? { sourceRange: { inMs: 1_000, outMs: 3_000 } } : {}) });
        assert.equal(clip.typeVersion, enabled ? 4 : loop ? 3 : trimmed ? 2 : 1);
        assert.deepEqual(validateSequence(sequence(clip)).clips[0], clip);
        assert.equal(videoDurationMs(clip), trimmed ? 2_000 : 5_000);
        assert.equal(clip.properties.durationMs, 5_000);
      }
    }
  }
  for (const clip of [video(), video({ sourceRange: { inMs: 1_000, outMs: 3_000 } }), video({ loop: true })]) {
    const loaded = validateSequence(sequence(clip)).clips[0] as VideoClip;
    assert.equal(Object.hasOwn(loaded.properties, 'keying'), false);
    assert.deepEqual(loaded, clip);
  }
});

test('keying validates exact object and field paths even when disabled', () => {
  for (const invalid of [null, [], 'green', false]) {
    rejects({ ...video(), properties: { ...video().properties, keying: invalid } }, 'properties.keying', 'INVALID_SHAPE');
  }
  for (const enabled of [true, false]) {
    for (const [field, values] of [
      ['enabled', [undefined, null, 1, 'true']],
      ['color', [undefined, null, '#0f0', '#00ff00ff', '00ff00', '#gg0000', '#00ff00 ']],
      ['tolerance', [undefined, null, '0.1', -0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]],
      ['softness', [undefined, null, '0.1', -0.01, 1.01, Number.NaN, Number.NEGATIVE_INFINITY]]
    ] as const) {
      for (const value of values) {
        const candidate: Record<string, unknown> = { ...keying, enabled };
        if (value === undefined) delete candidate[field];
        else candidate[field] = value;
        rejects({ ...video({ keying: { ...keying, enabled } }),
          properties: { ...video().properties, keying: candidate } }, `properties.keying.${field}`,
        typeof value === 'number' && !Number.isFinite(value) ? 'INVALID_JSON_VALUE' : 'INVALID_VALUE');
      }
    }
  }
  for (const tolerance of [0, 1]) {
    for (const softness of [0, 1]) {
      assert.doesNotThrow(() => validateSequence(sequence(video({ keying: { ...keying, tolerance, softness } }))));
    }
  }
});

test('version 4 requires enabled keying and legacy versions reject active keying', () => {
  for (const typeVersion of [1, 2, 3]) {
    rejects({ ...video({ keying, loop: typeVersion === 3, sourceRange: { inMs: 1_000, outMs: 3_000 } }), typeVersion },
      'typeVersion', 'UNSUPPORTED_VERSION');
  }
  rejects({ ...video(), typeVersion: 4 }, 'properties.keying.enabled');
  rejects({ ...video({ keying: { ...keying, enabled: false } }), typeVersion: 4 }, 'properties.keying.enabled');
  rejects({ ...video({ keying }), typeVersion: 5 }, 'typeVersion', 'UNSUPPORTED_VERSION');
  rejects({ ...video({ keying: { ...keying, enabled: false } }), typeVersion: 3 }, 'properties.loop');
  const { durationMs: _duration, ...properties } = video({ keying, sourceRange: { inMs: 1_000, outMs: 3_000 } }).properties;
  rejects({ ...video({ keying }), properties }, 'properties.durationMs', 'MEDIA_METADATA_REQUIRED');
});

test('keyed playback snapshots isolate data and preserve extension fields through serialization and copies', () => {
  const clip = { ...video({ keying, loop: true, sourceRange: { inMs: 1_000, outMs: 3_000 } }), extension: 'clip' };
  const extended = { ...clip, properties: { ...clip.properties, extension: ['keep'],
    keying: { ...keying, extension: { authored: true } } } };
  const source = sequence(extended);
  const loaded = validateSequence(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(loaded, source);
  assert.equal(loaded.id, source.id);
  assert.equal(loaded.revision, 9);
  assert.notEqual(loaded.clips[0]!.properties, source.clips[0]!.properties);
  const snapshot = compileSequence(loaded).snapshot;
  assert.deepEqual(snapshot, loaded);
  assert.ok(Object.isFrozen((snapshot.clips[0] as VideoClip).properties.keying));
  assert.deepEqual(compileSequence(JSON.parse(JSON.stringify(snapshot))).snapshot, snapshot);
  for (const copied of [duplicateSequence(loaded, 'Copy', ids()),
    applyTimelineCommand(loaded, { kind: 'duplicate-clip', clipId: 'movie' }, ids())]) {
    const copy = copied.clips.at(-1)! as VideoClip;
    assert.equal(copy.typeVersion, 4);
    assert.deepEqual(copy.properties, clipWithExtensions(loaded).properties);
    assert.notEqual(copy.id, 'movie');
  }
  assert.deepEqual(source, loaded);
});

function clipWithExtensions(source: SequenceV1): VideoClip {
  return source.clips[0] as VideoClip;
}

test('trim, restore and move retain keying configuration, metadata and compatible versions', () => {
  for (const enabled of [true, false]) {
    for (const loop of [true, false]) {
      const original = sequence(video({ keying: { ...keying, enabled }, loop }));
      const short = applyTimelineCommand(original, { kind: 'resize-clip', clipId: 'movie', edge: 'end', timeMs: 4_000 }, ids());
      const shortClip = short.clips[0] as VideoClip;
      assert.equal(shortClip.typeVersion, enabled ? 4 : loop ? 3 : 2);
      assert.deepEqual(shortClip.properties.sourceRange, { inMs: 0, outMs: 3_000 });
      assert.deepEqual(shortClip.properties.keying, { ...keying, enabled });
      const restored = applyTimelineCommand(short, { kind: 'resize-clip', clipId: 'movie', edge: 'end', timeMs: 6_000 }, ids());
      assert.deepEqual(restored, original);
      const moved = applyTimelineCommand(short, { kind: 'move-clip', clipId: 'movie', trackId: 'visual', startMs: 2_000 }, ids());
      assert.deepEqual(moved.clips[0], { ...shortClip, startMs: 2_000 });
    }
  }
});

test('metadata replacement retains keying extensions while explicit removal remains removed', () => {
  const source = sequence(video({ keying: { ...keying, extension: 'key' } as VideoKeying }));
  const replacement = video({ keying, durationMs: 6_000 });
  const inspected = applyTimelineCommand(source, { kind: 'replace-clip', clip: replacement }, ids());
  assert.deepEqual((inspected.clips[0] as VideoClip).properties.keying, { ...keying, extension: 'key' });
  assert.equal(inspected.clips[0]!.typeVersion, 4);
  assert.equal((inspected.clips[0] as VideoClip).properties.durationMs, 6_000);
  const disabled = video({ keying: { ...keying, enabled: false }, durationMs: 6_000 });
  const switchedOff = applyTimelineCommand(inspected, { kind: 'replace-clip', clip: disabled }, ids());
  assert.equal(switchedOff.clips[0]!.typeVersion, 1);
  assert.deepEqual((switchedOff.clips[0] as VideoClip).properties.keying, { ...keying, enabled: false, extension: 'key' });
  const removed = applyTimelineCommand(switchedOff, { kind: 'replace-clip', clip: video({ durationMs: 6_000 }) }, ids());
  assert.equal(Object.hasOwn((removed.clips[0] as VideoClip).properties, 'keying'), false);
});
