import assert from 'node:assert/strict';
import test from 'node:test';
import { DraftService } from '../src/application/draft-service.js';
import type { SequenceRepository } from '../src/application/ports.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import { createBarsSequence } from '../src/domain/validation.js';

function ids(prefix = 'id') {
  let index = 0;
  return () => `${prefix}_${++index}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function repositoryFor(initial: SequenceV1, save: SequenceRepository['save'] = async sequence => ({ ...sequence, revision: sequence.revision + 1 })) {
  const repository: SequenceRepository = {
    async list() { return []; },
    async delete() {},
    async read(id) {
      if (id !== initial.id) throw new Error('Not found.');
      return initial;
    },
    save
  };
  return repository;
}

test('undo and redo restore isolated snapshots and return to the clean loaded baseline', async () => {
  const original = createBarsSequence('Original', ids('source'));
  const service = new DraftService(repositoryFor(original), ids('new'));
  await service.load(original.id);

  service.replace({ ...service.draft!, name: 'First edit' });
  service.replace({ ...service.draft!, name: 'Second edit' });
  assert.equal(service.canUndo, true);
  assert.equal(service.canRedo, false);
  assert.equal(service.undo()?.name, 'First edit');
  assert.equal(service.dirty, true);
  assert.equal(service.redo()?.name, 'Second edit');
  assert.equal(service.undo()?.name, 'First edit');
  assert.equal(service.undo()?.name, 'Original');
  assert.equal(service.dirty, false);
  assert.equal(service.canUndo, false);
});

test('grouped replacements create one undo step and a new edit clears redo', async () => {
  const original = createBarsSequence('Original', ids('source'));
  const service = new DraftService(repositoryFor(original), ids('new'));
  await service.load(original.id);

  service.replace({ ...service.draft!, name: 'Drag 1' }, { historyGroup: 'drag' });
  service.replace({ ...service.draft!, name: 'Drag 2' }, { historyGroup: 'drag' });
  assert.equal(service.undo()?.name, 'Original');
  assert.equal(service.canRedo, true);
  service.replace({ ...service.draft!, name: 'New branch' });
  assert.equal(service.canRedo, false);
  assert.equal(service.redo(), null);
});

test('a grouped no-op does not swallow the next real change and save ends the group', async () => {
  const original = createBarsSequence('Original', ids('source'));
  const service = new DraftService(repositoryFor(original), ids('new'));
  await service.load(original.id);
  service.replace(service.draft!, { historyGroup: 'focus' });
  service.replace({ ...service.draft!, name: 'First value' }, { historyGroup: 'focus' });
  assert.equal(service.undo()?.name, 'Original');
  service.redo();
  await service.save();
  service.replace({ ...service.draft!, name: 'After save' }, { historyGroup: 'focus' });
  assert.equal(service.undo()?.name, 'First value');
  assert.equal(service.draft?.revision, 1);
});

test('history is bounded to the most recent one hundred undo snapshots', async () => {
  const original = createBarsSequence('Original', ids('source'));
  const service = new DraftService(repositoryFor(original), ids('new'));
  await service.load(original.id);
  for (let index = 1; index <= 105; index += 1) {
    service.replace({ ...service.draft!, name: `Edit ${index}` });
  }

  for (let index = 0; index < 100; index += 1) assert.ok(service.undo());
  assert.equal(service.draft?.name, 'Edit 5');
  assert.equal(service.undo(), null);
});

test('load, create, and duplicate reset both history stacks', async () => {
  const original = createBarsSequence('Original', ids('source'));
  const service = new DraftService(repositoryFor(original), ids('new'));
  await service.load(original.id);
  service.replace({ ...service.draft!, name: 'Changed' });
  assert.equal(service.canUndo, true);

  await service.load(original.id);
  assert.equal(service.canUndo, false);
  assert.equal(service.canRedo, false);
  service.replace({ ...service.draft!, name: 'Changed again' });
  service.duplicate('Copy');
  assert.equal(service.canUndo, false);
  service.replace({ ...service.draft!, name: 'Copy edit' });
  assert.equal(service.canUndo, true);
  service.create('Fresh');
  assert.equal(service.canUndo, false);
  assert.equal(service.canRedo, false);
});

test('save conflicts preserve undo and redo history with the dirty draft', async () => {
  const original = createBarsSequence('Original', ids('source'));
  const repository = repositoryFor(original, async () => { throw Object.assign(new Error('Conflict.'), { code: 'CONFLICT' }); });
  const service = new DraftService(repository, ids('new'));
  await service.load(original.id);
  service.replace({ ...service.draft!, name: 'Changed' });
  service.undo();
  service.redo();
  await assert.rejects(service.save());

  assert.equal(service.draft?.name, 'Changed');
  assert.equal(service.conflict, true);
  assert.equal(service.canUndo, true);
  assert.equal(service.canRedo, false);
  assert.equal(service.undo()?.name, 'Original');
  assert.equal(service.redo()?.name, 'Changed');
});

test('edits during an in-flight save keep revision metadata aligned through undo', async () => {
  const original = { ...createBarsSequence('Original', ids('source')), revision: 2 };
  const gate = deferred<SequenceV1>();
  let snapshot: SequenceV1 | undefined;
  const service = new DraftService(repositoryFor(original, sequence => {
    snapshot = structuredClone(sequence);
    return gate.promise;
  }), ids('new'));
  await service.load(original.id);
  service.replace({ ...service.draft!, name: 'Saved edit' });
  const saving = service.save();
  await Promise.resolve();
  service.replace({ ...service.draft!, name: 'Later edit' });
  service.undo();
  assert.equal(service.draft?.name, 'Saved edit');
  gate.resolve({ ...snapshot!, revision: 3 });
  await saving;

  assert.equal(service.draft?.revision, 3);
  assert.equal(service.dirty, false);
  assert.equal(service.undo()?.name, 'Original');
  assert.equal(service.draft?.revision, 3);
  assert.equal(service.dirty, true);
  assert.equal(service.redo()?.name, 'Saved edit');
  assert.equal(service.draft?.revision, 3);
});

test('a save finishing after a new document is created cannot replace its draft or history', async () => {
  const original = createBarsSequence('Original', ids('source'));
  const gate = deferred<SequenceV1>();
  let snapshot: SequenceV1 | undefined;
  const service = new DraftService(repositoryFor(original, sequence => {
    snapshot = structuredClone(sequence);
    return gate.promise;
  }), ids('new'));
  await service.load(original.id);
  service.replace({ ...service.draft!, name: 'Old edit' });
  const saving = service.save();
  await Promise.resolve();
  service.create('New document');
  service.replace({ ...service.draft!, name: 'New document edit' });
  assert.equal(service.canUndo, true);
  gate.resolve({ ...snapshot!, revision: 1 });
  await saving;

  assert.equal(service.draft?.name, 'New document edit');
  assert.equal(service.draft?.revision, 0);
  assert.equal(service.expectedRevision, null);
  assert.equal(service.dirty, true);
  assert.equal(service.undo()?.name, 'New document');
});

test('a save for a new document queues behind the old save and persists with its own revision and history', async () => {
  const original = createBarsSequence('Original', ids('source'));
  const gate = deferred<SequenceV1>();
  const calls: { id: string; expectedRevision: number | null }[] = [];
  let oldSnapshot: SequenceV1 | undefined;
  const service = new DraftService(repositoryFor(original, (sequence, expectedRevision) => {
    calls.push({ id: sequence.id, expectedRevision });
    if (sequence.id === original.id) {
      oldSnapshot = structuredClone(sequence);
      return gate.promise;
    }
    return Promise.resolve({ ...sequence, revision: (expectedRevision ?? 0) + 1 });
  }), ids('new'));

  await service.load(original.id);
  service.replace({ ...service.draft!, name: 'Old edit' });
  const oldSave = service.save();
  await Promise.resolve();
  assert.equal(calls.length, 1);

  service.create('New document');
  service.replace({ ...service.draft!, name: 'New document edit' });
  const newId = service.draft!.id;
  const newSave = service.save();
  assert.notEqual(newSave, oldSave);
  assert.equal(calls.length, 1, 'the second repository save waits for the first');

  gate.resolve({ ...oldSnapshot!, revision: 1 });
  const [oldResult, newResult] = await Promise.all([oldSave, newSave]);
  assert.equal(oldResult.id, original.id);
  assert.equal(newResult.id, newId);
  assert.deepEqual(calls, [
    { id: original.id, expectedRevision: original.revision },
    { id: newId, expectedRevision: null }
  ]);
  assert.equal(service.draft?.id, newId);
  assert.equal(service.draft?.revision, 1);
  assert.equal(service.dirty, false);
  assert.equal(service.undo()?.name, 'New document');
  assert.equal(service.draft?.revision, 1);
});

