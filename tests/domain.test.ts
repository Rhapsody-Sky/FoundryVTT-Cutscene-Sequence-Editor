import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftService } from '../src/application/draft-service.js';
import type { SequenceRepository } from '../src/application/ports.js';
import { createBarsSequence, duplicateSequence, isSimpleBarsSequence, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import type { SequenceV1, VideoClip } from '../src/domain/sequence.js';

function ids(prefix = 'id') {
  let index = 0;
  return () => `${prefix}_${++index}`;
}

function bars(name = 'Scene'): SequenceV1 {
  return createBarsSequence(name, ids());
}

function videoSequence(): SequenceV1 {
  const base = bars('Video');
  const sourceClip = base.clips[0]!;
  const clip: VideoClip = {
    ...sourceClip,
    id: 'video_1',
    type: 'video',
    duration: { kind: 'media' },
    entrance: { preset: 'fade', version: 1, durationMs: 500, easing: 'linear' },
    exit: { preset: 'none', version: 1 },
    properties: {
      source: { kind: 'foundry-file', path: 'worlds/demo/cutscene.webm' },
      fit: 'contain', volume: 0.7, muted: false
    }
  };
  return validateSequence({ ...base, clips: [clip], end: { kind: 'media', clipId: clip.id } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

test('validator rejects unsupported schema, broken references, and unsafe timing', () => {
  const base = bars();
  assert.throws(() => validateSequence({ ...base, schemaVersion: 6 }), error => errorCode(error) === 'UNSUPPORTED_SCHEMA_VERSION');
  assert.throws(() => validateSequence({ ...base, end: {kind:'fixed', durationMs:400} }), error => errorCode(error) === 'INVALID_TIMING');
  assert.throws(() => validateSequence({
    ...base,
    clips: [{ ...base.clips[0]!, trackId: 'missing_track' }]
  }), error => errorCode(error) === 'INVALID_REFERENCE');
  assert.throws(() => validateSequence({
    ...base,
    clips: [{ ...base.clips[0]!, startMs: Number.NaN }]
  }), error => errorCode(error) === 'INVALID_JSON_VALUE');
  assert.throws(() => validateSequence({
    ...base,
    clips: [{ ...base.clips[0]!, type: 'animated-sprite' }]
  }), error => errorCode(error) === 'UNSUPPORTED_TYPE');
});

test('bars allow exactly half the surface height per bar and reject anything greater', () => {
  const base = bars();
  const clip = base.clips[0]!;
  const atLimit = validateSequence({ ...base, clips: [{ ...clip, properties: { ...clip.properties, heightFraction: 0.5 } }] });
  assert.equal((atLimit.clips[0] as { properties: { heightFraction: number } }).properties.heightFraction, 0.5);
  assert.throws(() => validateSequence({
    ...base, clips: [{ ...clip, properties: { ...clip.properties, heightFraction: 0.500001 } }]
  }), error => errorCode(error) === 'INVALID_VALUE');
});

test('validator preserves JSON extension fields and returns an isolated clone', () => {
  const source = {
    ...bars(),
    extension: { owner: 'editor', future: { flags: ['keep-me'] } }
  };
  const result = validateSequence(source) as SequenceV1 & { extension: { future: { flags: string[] } } };
  assert.deepEqual(result.extension, source.extension);
  assert.notEqual(result, source);
  result.extension.future.flags.push('local-copy');
  assert.deepEqual(source.extension.future.flags, ['keep-me']);
});

test('duplicate remaps sequence, track, clip, and media-end IDs while retaining media paths', () => {
  const source = videoSequence() as SequenceV1 & { extension: { marker: string } };
  const extended = { ...source, revision: 8, extension: { marker: 'preserved' } };
  const original = structuredClone(extended);
  const copy = duplicateSequence(extended, 'Copy', ids('copy')) as SequenceV1 & { extension: { marker: string } };
  assert.equal(copy.id, 'copy_1');
  assert.equal(copy.revision, 0);
  assert.equal(copy.name, 'Copy');
  assert.notEqual(copy.tracks[0]!.id, source.tracks[0]!.id);
  assert.notEqual(copy.clips[0]!.id, source.clips[0]!.id);
  assert.equal(copy.clips[0]!.trackId, copy.tracks[0]!.id);
  assert.equal(copy.end.kind, 'media');
  if (copy.end.kind === 'media') assert.equal(copy.end.clipId, copy.clips[0]!.id);
  assert.equal((copy.clips[0] as VideoClip).properties.source.path, 'worlds/demo/cutscene.webm');
  assert.deepEqual(copy.extension, { marker: 'preserved' });
  assert.deepEqual(extended, original);
});

test('simple bars classification refuses locked tracks and complex sequences', () => {
  const base = bars();
  assert.equal(isSimpleBarsSequence(base), true);
  assert.equal(isSimpleBarsSequence({ ...base, tracks: [{ ...base.tracks[0]!, locked: true }] }), false);
  assert.equal(isSimpleBarsSequence({ ...base, clips: [...base.clips, { ...base.clips[0]!, id: 'second_clip' }] }), false);
  assert.equal(isSimpleBarsSequence({ ...base, end: { kind: 'manual' } }), true);
});

test('draft creation is local and save conflicts preserve the exact dirty draft', async () => {
  const stored = { ...bars('Loaded'), revision: 4 };
  let saves = 0;
  const repository: SequenceRepository = {
    async list() { return []; },
    async read() { return stored; },
    async delete() {},
    async save() {
      saves += 1;
      throw Object.assign(new Error('Revision conflict.'), { code: 'CONFLICT' });
    }
  };
  const service = new DraftService(repository, ids('new'));
  const created = service.create('Unsaved');
  assert.equal(created.revision, 0);
  assert.equal(service.dirty, true);
  assert.equal(saves, 0);

  await service.load(stored.id);
  const edited = { ...service.draft!, name: 'Edited locally' };
  service.replace(edited);
  const beforeSave = service.draft;
  await assert.rejects(service.save(), error => errorCode(error) === 'CONFLICT');
  assert.deepEqual(service.draft, beforeSave);
  assert.equal(service.expectedRevision, 4);
  assert.equal(service.dirty, true);
  assert.equal(service.conflict, true);
  assert.equal(saves, 1);
});

test('draft edits made during an awaited save stay dirty and use the returned revision as their base', async () => {
  const original = bars('Before');
  const gate = deferred<SequenceV1>();
  let saveInput: SequenceV1 | undefined;
  let saveExpected: number | null | undefined;
  const repository: SequenceRepository = {
    async list() { return []; },
    async read() { return original; },
    async delete() {},
    save(sequence, expectedRevision) {
      saveInput = structuredClone(sequence);
      saveExpected = expectedRevision;
      return gate.promise;
    }
  };
  const service = new DraftService(repository, ids());
  await service.load(original.id);
  service.replace({ ...service.draft!, name: 'Saved snapshot' });
  const pendingSave = service.save();
  await Promise.resolve();
  assert.equal(saveInput?.name, 'Saved snapshot');
  assert.equal(saveExpected, original.revision);

  service.replace({ ...service.draft!, name: 'Newer edit' });
  gate.resolve({ ...saveInput!, revision: original.revision + 1 });
  const saved = await pendingSave;
  assert.equal(saved.name, 'Saved snapshot');
  assert.equal(service.draft?.name, 'Newer edit');
  assert.equal(service.draft?.revision, original.revision + 1);
  assert.equal(service.expectedRevision, original.revision + 1);
  assert.equal(service.dirty, true);
  assert.equal(service.conflict, false);
});

test('failed loads leave the current draft and its revision untouched', async () => {
  const original = bars('Current');
  const repository: SequenceRepository = {
    async list() { return []; },
    async read(id) {
      if (id !== original.id) throw new Error('Not found');
      return original;
    },
    async delete() {},
    async save(sequence) { return sequence; }
  };
  const service = new DraftService(repository, ids());
  await service.load(original.id);
  const before = service.draft;
  await assert.rejects(service.load('missing'));
  assert.deepEqual(service.draft, before);
  assert.equal(service.expectedRevision, original.revision);
  assert.equal(service.dirty, false);
});

test('validation failures expose a useful error type and path', () => {
  const base = bars();
  assert.throws(() => validateSequence({ ...base, composition: { ...base.composition, width: Infinity } }), error => {
    assert.ok(error instanceof SequenceValidationError);
    assert.equal(error.code, 'INVALID_JSON_VALUE');
    assert.equal(error.path, 'sequence.composition.width');
    return true;
  });
});
