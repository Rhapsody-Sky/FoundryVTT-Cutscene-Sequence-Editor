import test from 'node:test';
import assert from 'node:assert/strict';
import { createBarsSequence } from '../src/domain/validation.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import type { SequenceRepository, SequenceSummary } from '../src/application/ports.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { LocalPlayer } from '../src/playback/local-player.js';

function ids() {
  let next = 0;
  return () => `sequence-delete-${++next}`;
}

function savedSequence(name: string, id: string): SequenceV1 {
  return { ...createBarsSequence(name, () => id), revision: 7 };
}

function summary(sequence: SequenceV1): SequenceSummary {
  return { id: sequence.id, revision: sequence.revision, name: sequence.name };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve: (value: T) => resolve(value) };
}

function fixture(initial: readonly SequenceV1[], confirm: (name: string, dirty: boolean) => Promise<boolean> = async () => false) {
  let stored = [...initial];
  const state = {
    confirmations: [] as { name: string; dirty: boolean }[],
    deletes: [] as { id: string; revision: number }[],
    reads: [] as string[],
    shortcutRefreshes: 0,
    liveStops: 0,
    previewStops: 0
  };
  const repository: SequenceRepository = {
    async list() { return stored.map(summary); },
    async read(id) {
      state.reads.push(id);
      const sequence = stored.find(item => item.id === id);
      if (!sequence) throw Object.assign(new Error('Missing sequence.'), { code: 'NOT_FOUND' });
      return sequence;
    },
    async save(sequence) { return sequence; },
    async delete(id, revision) {
      state.deletes.push({ id, revision });
      const sequence = stored.find(item => item.id === id);
      if (!sequence) throw Object.assign(new Error('Missing sequence.'), { code: 'NOT_FOUND' });
      if (sequence.revision !== revision) throw Object.assign(new Error('Stale revision.'), { code: 'CONFLICT' });
      stored = stored.filter(item => item.id !== id);
    }
  };
  const runtime = { now: () => 0, requestFrame: () => 0, cancelFrame: () => {} };
  const localPlayer = new LocalPlayer(runtime);
  localPlayer.stop = () => { state.liveStops++; };
  const services: EditorServices = {
    makeId: ids(), repository, localPlayer,
    localize: key => key === 'STAGECRAFT.Editor.DefaultName' ? 'New sequence' : key === 'STAGECRAFT.Error.CONFLICT' ? 'Localized conflict' : key,
    confirmDiscard: async () => { throw new Error('Deletion must not open the discard dialog.'); },
    async confirmDeleteSequence(name, dirty) {
      state.confirmations.push({ name, dirty });
      return confirm(name, dirty);
    },
    async refreshSequenceShortcuts() { state.shortcutRefreshes++; },
    observeLocal: () => () => {}, prepareGroup: async () => {}, openSession: () => {}, groupActive: () => false,
    chooseVideo: async () => null, requestAudioUnlock: async () => {}
  };
  const message = { textContent: '', classList: { toggle() {} } };
  const deleteButton = { dataset: { stagecraftAction: 'delete-sequence' }, disabled: false, title: '' };
  const inspector = { dataset: {}, disabled: false };
  const root = {
    querySelector(selector: string) {
      if (selector === '[data-stagecraft-message]') return message;
      if (selector === '[data-stagecraft-inspector]') return inspector;
      return null;
    },
    querySelectorAll(selector: string) { return selector === 'button[data-stagecraft-action]' ? [deleteButton] : []; }
  };
  const view = new EditorView(services);
  const internals = view as unknown as {
    mounted: boolean; actionSerial: number; busy: boolean; invalid: boolean;
    items: readonly SequenceSummary[]; root: HTMLElement | null;
    selectedId: string | null; playheadMs: number; activeElement: string;
    lastNonMediaEnd: unknown; fieldHistoryGroup: string | undefined;
    staticVersion: number; staticSourceKey: string | null; staticPrepared: boolean;
    preview: LocalPlayer; updateButtons(): void; act(action: string): Promise<void>;
  };
  internals.mounted = true;
  internals.items = initial.map(summary);
  internals.root = root as unknown as HTMLElement;
  const originalPreviewStop = internals.preview.stop.bind(internals.preview);
  internals.preview.stop = () => { state.previewStops++; originalPreviewStop(); };
  const action = () => internals.act('delete-sequence');
  return { view, internals, services, state, stored: () => stored, root, message, inspector, deleteButton, action };
}

test('canceling deletion preserves a dirty draft and preview without a discard prompt', async t => {
  const saved = savedSequence('Saved title', 'saved-title');
  const gate = deferred<boolean>();
  const f = fixture([saved], () => gate.promise);
  await f.view.draft.load(saved.id);
  f.view.draft.replace({ ...f.view.draft.draft!, name: 'Unsaved title' });
  f.internals.staticVersion = 5;
  f.internals.staticSourceKey = 'still-source';
  f.internals.staticPrepared = true;
  const before = f.view.draft.draft;

  const pending = f.action();
  assert.equal(f.inspector.disabled, true, 'the inspector is disabled while confirmation is pending');
  gate.resolve(false);
  await pending;

  assert.deepEqual(f.state.confirmations, [{ name: 'Saved title', dirty: true }]);
  assert.deepEqual(f.view.draft.draft, before);
  assert.equal(f.view.draft.expectedRevision, saved.revision);
  assert.deepEqual(f.state.deletes, []);
  assert.equal(f.state.previewStops, 0);
  assert.equal(f.internals.staticVersion, 5);
  assert.equal(f.internals.staticSourceKey, 'still-source');
  assert.equal(f.state.liveStops, 0);
  assert.equal(f.inspector.disabled, false, 'canceling re-enables the inspector');
  t.after(() => f.view.detach());
});

test('invalid but otherwise clean saved sequences can be deleted and cancellation keeps invalid state', async t => {
  const saved = savedSequence('Invalid draft', 'invalid-draft');
  const f = fixture([saved]);
  await f.view.draft.load(saved.id);
  f.internals.invalid = true;
  const before = f.view.draft.draft;
  f.internals.updateButtons();

  assert.equal(f.deleteButton.disabled, false, 'invalid clip fields do not disable deleting a saved sequence');
  await f.action();

  assert.deepEqual(f.state.confirmations, [{ name: 'Invalid draft', dirty: true }]);
  assert.deepEqual(f.view.draft.draft, before);
  assert.equal(f.internals.invalid, true);
  assert.deepEqual(f.state.deletes, []);
  t.after(() => f.view.detach());
});

test('delete is disabled for an unsaved draft and whenever the editor is busy', async t => {
  const saved = savedSequence('Saved', 'saved');
  const f = fixture([saved]);
  await f.view.draft.load(saved.id);
  f.internals.updateButtons();
  assert.equal(f.deleteButton.disabled, false);

  f.view.draft.create('Unsaved');
  f.internals.updateButtons();
  assert.equal(f.deleteButton.disabled, true);

  await f.view.draft.load(saved.id);
  f.internals.busy = true;
  f.internals.updateButtons();
  assert.equal(f.deleteButton.disabled, true);
  t.after(() => f.view.detach());
});

test('successful deletion loads the next readable sequence and refreshes scene shortcuts', async t => {
  const removed = savedSequence('A saved title', 'remove-me');
  const next = savedSequence('B saved title', 'next-sequence');
  const f = fixture([removed, next], async () => true);
  await f.view.draft.load(removed.id);
  f.view.draft.replace({ ...f.view.draft.draft!, name: 'Unsaved renamed title' });
  f.internals.selectedId = removed.clips[0]!.id;
  f.internals.playheadMs = 1_250;
  f.internals.invalid = true;
  f.internals.staticVersion = 2;
  f.internals.staticSourceKey = 'old-still';
  f.internals.staticPrepared = true;

  await f.action();

  assert.deepEqual(f.state.confirmations, [{ name: removed.name, dirty: true }]);
  assert.deepEqual(f.state.deletes, [{ id: removed.id, revision: removed.revision }]);
  assert.deepEqual(f.stored().map(item => item.id), [next.id]);
  assert.deepEqual(f.state.reads, [removed.id, next.id]);
  assert.equal(f.view.draft.draft?.id, next.id);
  assert.equal(f.view.draft.expectedRevision, next.revision);
  assert.equal(f.view.draft.dirty, false);
  assert.equal(f.view.draft.canUndo, false);
  assert.equal(f.view.draft.canRedo, false);
  assert.equal(f.internals.selectedId, next.clips[0]!.id, 'the next sequence starts with its default first clip selected');
  assert.equal(f.internals.playheadMs, 0);
  assert.equal(f.internals.invalid, false);
  assert.equal(f.internals.activeElement, 'bars');
  assert.equal(f.internals.staticVersion, 3);
  assert.equal(f.internals.staticSourceKey, null);
  assert.equal(f.internals.staticPrepared, false);
  assert.equal(f.state.previewStops, 1);
  assert.equal(f.state.liveStops, 0, 'deleting never stops local live playback');
  assert.equal(f.state.shortcutRefreshes, 1);
  assert.equal(f.message.textContent, '');
  assert.equal(f.inspector.disabled, false, 'finishing deletion re-enables the inspector');
  t.after(() => f.view.detach());
});

test('deleting the last saved sequence creates a fresh unsaved draft', async t => {
  const only = savedSequence('Only saved title', 'only-sequence');
  const f = fixture([only], async () => true);
  await f.view.draft.load(only.id);

  await f.action();

  assert.deepEqual(f.stored(), []);
  assert.notEqual(f.view.draft.draft?.id, only.id);
  assert.equal(f.view.draft.draft?.name, 'New sequence');
  assert.equal(f.view.draft.expectedRevision, null);
  assert.equal(f.view.draft.dirty, true);
  assert.equal(f.view.draft.canUndo, false);
  assert.equal(f.internals.playheadMs, 0);
  assert.equal(f.state.shortcutRefreshes, 1);
  t.after(() => f.view.detach());
});

test('a revision conflict retains the exact draft, preview, and localized error', async t => {
  const saved = savedSequence('Saved title', 'conflicted');
  const writeGate = deferred<void>();
  const writeStarted = deferred<void>();
  const f = fixture([saved], async () => true);
  await f.view.draft.load(saved.id);
  f.view.draft.replace({ ...f.view.draft.draft!, name: 'Local edits' });
  const before = f.view.draft.draft;
  f.internals.staticVersion = 9;
  f.internals.staticSourceKey = 'still';
  f.services.repository.delete = async () => {
    writeStarted.resolve();
    await writeGate.promise;
    throw Object.assign(new Error('Stale revision.'), { code: 'CONFLICT' });
  };

  const pending = f.action();
  await writeStarted.promise;
  assert.equal(f.inspector.disabled, true, 'the inspector remains disabled while a failed write is still pending');
  writeGate.resolve();
  await pending;

  assert.deepEqual(f.view.draft.draft, before);
  assert.equal(f.view.draft.expectedRevision, saved.revision);
  assert.equal(f.view.draft.dirty, true);
  assert.equal(f.internals.staticVersion, 9);
  assert.equal(f.internals.staticSourceKey, 'still');
  assert.equal(f.state.previewStops, 0);
  assert.equal(f.state.liveStops, 0);
  assert.equal(f.message.textContent, 'Localized conflict');
  assert.equal(f.state.shortcutRefreshes, 0);
  assert.equal(f.inspector.disabled, false, 'a failed deletion re-enables the inspector');
  t.after(() => f.view.detach());
});

test('a pending confirmation blocks duplicate deletes and detach prevents a late confirmation from writing', async () => {
  const saved = savedSequence('Saved title', 'lifecycle');
  const gate = deferred<boolean>();
  const f = fixture([saved], () => gate.promise);
  await f.view.draft.load(saved.id);
  const first = f.action();
  await Promise.resolve();
  await f.action();
  assert.equal(f.state.confirmations.length, 1);
  assert.equal(f.state.deletes.length, 0);

  f.view.detach();
  gate.resolve(true);
  await first;
  assert.equal(f.state.deletes.length, 0, 'a confirmation resolved after detach cannot delete');
  assert.equal(f.state.liveStops, 0);
});

test('detach during the repository write prevents stale post-delete editor cleanup', async () => {
  const saved = savedSequence('Saved title', 'pending-write');
  const writeGate = deferred<void>();
  const writeStarted = deferred<void>();
  const f = fixture([saved], async () => true);
  await f.view.draft.load(saved.id);
  const before = f.view.draft.draft;
  f.services.repository.delete = async (id, revision) => {
    f.state.deletes.push({ id, revision });
    writeStarted.resolve();
    await writeGate.promise;
  };
  const pending = f.action();
  await writeStarted.promise;

  f.view.detach();
  writeGate.resolve();
  await pending;

  assert.deepEqual(f.view.draft.draft, before);
  assert.deepEqual(f.state.deletes, [{ id: saved.id, revision: saved.revision }]);
  assert.equal(f.state.shortcutRefreshes, 0);
  assert.equal(f.state.liveStops, 0);
});

test('detach while loading the next sequence prevents a late read from replacing the new editor draft', async () => {
  const removed = savedSequence('A removed title', 'removed-before-load');
  const next = savedSequence('B next title', 'next-pending-load');
  const readGate = deferred<void>();
  const readStarted = deferred<void>();
  const f = fixture([removed, next], async () => true);
  await f.view.draft.load(removed.id);
  f.services.repository.read = async id => {
    if (id === next.id) {
      readStarted.resolve();
      await readGate.promise;
    }
    return next;
  };
  const pending = f.action();
  await readStarted.promise;

  f.view.detach();
  const freshDraftId = f.view.draft.draft?.id;
  readGate.resolve();
  await pending;

  assert.ok(freshDraftId);
  assert.equal(f.view.draft.draft?.id, freshDraftId);
  assert.equal(f.view.draft.draft?.id === next.id, false);
  assert.equal(f.view.draft.expectedRevision, null);
  assert.equal(f.state.shortcutRefreshes, 0);
});
