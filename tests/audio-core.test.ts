import assert from 'node:assert/strict';
import test from 'node:test';
import type { AudioClip, SequenceV1 } from '../src/domain/sequence.js';
import { clipDurationMs, isTerminalManualClip, mediaDurationMs, sequenceDurationMs } from '../src/domain/clip-timing.js';
import { createBarsSequence, duplicateSequence, isSimpleSequence, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';

const sound: AudioClip = {
  id: 'sound', trackId: 'sound_track', type: 'audio', typeVersion: 1, startMs: 100,
  duration: { kind: 'media' }, entrance: { preset: 'fade', version: 1, durationMs: 200, easing: 'linear' },
  exit: { preset: 'fade', version: 1, durationMs: 200, easing: 'linear' },
  properties: { source: { kind: 'foundry-file', path: 'worlds/demo/music.ogg' }, volume: 0.6, muted: false,
    durationMs: 2_000, sourceRange: { inMs: 500, outMs: 1_500 } }
};

function sequence(clip: AudioClip = sound, end: SequenceV1['end'] = { kind: 'manual' }): SequenceV1 {
  return validateSequence({
    schemaVersion: 1, id: 'sequence', revision: 0, name: 'Sound', composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 800 }, end,
    tracks: [{ id: 'sound_track', name: 'Audio', kind: 'audio', order: 0, enabled: true, locked: false }], clips: [clip]
  });
}

function invalidCode(code: string) {
  return (error: unknown) => error instanceof SequenceValidationError && error.code === code;
}

test('audio trimming resolves source metadata, timeline duration and referenced media endpoint', () => {
  const source = sequence(sound, { kind: 'media', clipId: sound.id });
  assert.equal(mediaDurationMs(sound), 1_000);
  assert.equal(clipDurationMs(source, sound), 1_000);
  assert.equal(sequenceDurationMs(source), 1_100);
  assert.equal(isSimpleSequence(source), false);
  assert.equal(sequenceDurationMs(sequence()), null);
});

test('audio validation rejects incompatible tracks, invalid trim, versions and non-fade transitions', () => {
  const source = sequence();
  assert.throws(() => validateSequence({ ...source, tracks: [{ ...source.tracks[0]!, kind: 'visual' }] }), invalidCode('INCOMPATIBLE_TRACK'));
  assert.throws(() => validateSequence({ ...source, tracks: [{ ...source.tracks[0]!, kind: 'unknown' }] }), invalidCode('UNSUPPORTED_TYPE'));
  for (const changed of [
    { ...sound, typeVersion: 2 },
    { ...sound, type: 'unknown' },
    { ...sound, entrance: { preset: 'slide', version: 1, durationMs: 200, easing: 'linear' } },
    { ...sound, properties: { ...sound.properties, volume: 1.1 } },
    { ...sound, properties: { ...sound.properties, muted: 'false' } },
    { ...sound, properties: { ...sound.properties, loop: 1 } },
    { ...sound, properties: { ...sound.properties, sourceRange: { inMs: 1_500, outMs: 1_500 } } },
    { ...sound, properties: { ...sound.properties, source: { kind: 'playlist', path: 'music' } } },
    { ...sound, properties: { ...sound.properties, sourceRange: { inMs: 0, outMs: 100 } } }
  ]) assert.throws(() => validateSequence({ ...source, clips: [changed] }), SequenceValidationError);
  const { durationMs: _duration, ...withoutMetadata } = sound.properties;
  assert.throws(() => validateSequence({ ...source, clips: [{ ...sound, properties: withoutMetadata }] }), invalidCode('MEDIA_METADATA_REQUIRED'));
});

test('audio fade envelope is separate from visual opacity and stops exactly at the source boundary', () => {
  const plan = compileSequence(sequence());
  assert.equal(evaluate(plan, 99).length, 0);
  const entrance = evaluate(plan, 200)[0]!;
  assert.equal(entrance.audioGain, 0.5);
  assert.equal(entrance.opacity, 1);
  assert.equal(entrance.localTimeMs, 100);
  assert.equal(evaluate(plan, 600)[0]!.audioGain, 1);
  assert.equal(evaluate(plan, 1_000)[0]!.audioGain, 0.5);
  assert.deepEqual(evaluate(plan, 1_100), []);
  assert.deepEqual(evaluate(plan, 20_000), []);
  assert.deepEqual(evaluate(compileSequence(sequence(sound, { kind: 'media', clipId: sound.id })), 1_100), []);
});

test('only terminal manual opted audio loops, ignoring natural fadeout and retaining its entrance', () => {
  const looped = { ...sound, properties: { ...sound.properties, loop: true } };
  const source = sequence(looped);
  assert.equal(isTerminalManualClip(source, looped), true);
  const plan = compileSequence(source);
  assert.equal(evaluate(plan, 200)[0]!.audioGain, 0.5);
  assert.equal(evaluate(plan, 1_000)[0]!.audioGain, 1);
  const held = evaluate(plan, 9_999)[0]!;
  assert.equal(held.audioLoop, true);
  assert.equal(held.localTimeMs, 9_899);
  assert.equal(held.audioGain, 1);
  const finite = compileSequence(sequence(looped, { kind: 'fixed', durationMs: 2_000 }));
  assert.equal(evaluate(finite, 1_000)[0]!.audioLoop, undefined);
  assert.deepEqual(evaluate(finite, 1_100), []);
  const later = { ...sound, id: 'later', startMs: 1_100 };
  const multiple = compileSequence(validateSequence({ ...source, clips: [looped, later] }));
  assert.equal(evaluate(multiple, 1_000)[0]!.audioLoop, undefined);
  assert.equal(evaluate(multiple, 1_100).length, 1);
  assert.equal(evaluate(multiple, 1_100)[0]!.clip.id, 'later');
});

test('hidden audio metadata can define end, while enabled unknown source metadata blocks compilation', () => {
  const source = sequence(sound, { kind: 'media', clipId: sound.id });
  const hidden = validateSequence({ ...source, tracks: [{ ...source.tracks[0]!, enabled: false }] });
  assert.equal(compileSequence(hidden).durationMs, 1_100);
  assert.deepEqual(evaluate(compileSequence(hidden), 500), []);
  const { durationMs: _duration, sourceRange: _range, ...properties } = sound.properties;
  const unknown = sequence({ ...sound, properties });
  assert.equal(mediaDurationMs(unknown.clips[0] as AudioClip), undefined);
  assert.throws(() => compileSequence(unknown), invalidCode('MEDIA_METADATA_REQUIRED'));
});

test('audio snapshots clone, freeze and duplicate extension JSON; legacy visual data stays unchanged', () => {
  const source = validateSequence({ ...sequence(), future: { keep: [1, 2] }, clips: [{ ...sound, properties: { ...sound.properties, extension: { keep: true } } }] });
  const plan = compileSequence(source);
  assert.notEqual(plan.snapshot, source);
  assert.deepEqual(plan.snapshot, source);
  assert.equal(Object.isFrozen(plan.snapshot.clips[0]!.properties), true);
  let id = 0;
  const copy = duplicateSequence(source, 'Copy', () => `copy_${++id}`);
  assert.deepEqual((copy.clips[0]!.properties as Record<string, unknown>).extension, { keep: true });
  assert.equal(copy.tracks[0]!.kind, 'audio');
  const referenced = duplicateSequence(sequence(sound, { kind: 'media', clipId: sound.id }), 'Copy', () => `copy_${++id}`);
  assert.deepEqual(referenced.end, { kind: 'media', clipId: referenced.clips[0]!.id });
  const legacy = createBarsSequence('Legacy', () => `legacy_${++id}`);
  assert.deepEqual(validateSequence(legacy), legacy);
  assert.deepEqual(compileSequence(legacy).snapshot, legacy);
});
