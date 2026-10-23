import assert from 'node:assert/strict';
import test from 'node:test';
import { createBarsSequence } from '../src/domain/validation.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import {
  createFoundryRepository,
  RepositoryError,
  type RepositoryHost,
  type RepositoryPack,
  type RepositoryPermissionLevel,
  type RepositoryRpcEvent,
  type RepositoryUser,
} from '../src/integrations/foundry/sequence-repository.js';

const MODULE_ID = 'stagecraft';
const PACK_COLLECTION = 'world.stagecraft-sequences';

interface FakeEntry {
  _id: string;
  name: string;
  flags?: Record<string, unknown>;
  pages?: FakePage[];
}

interface FakePage {
  _id: string;
  name: string;
  type: 'text';
  flags: Record<string, unknown>;
  _stats: { lastModifiedBy: string };
}

class FakeWorld {
  users: RepositoryUser[] = [
    { id: 'gm', role: 4 },
    { id: 'assistant', role: 3 },
    { id: 'trusted', role: 2 },
    { id: 'player', role: 1 },
  ];
  entries: FakeEntry[] = [];
  writeCount = 0;
  packCreateCount = 0;
  nextEntryId = 0;
  nextHostId = 0;
  loseNextPageAck = false;
  loseNextClaimAck = false;
  failNextSequenceParentCreate = false;
  failNextPageCreate = false;
  dropNextPageCreate = false;
  private claimGate: { readonly signalEntered: () => void; readonly wait: Promise<void> } | undefined;
  settingsEditors = new Set<string>();
  packLevels = new Map<string, RepositoryPermissionLevel>();
  packDocumentName = 'JournalEntry';

  pack(): RepositoryPack | undefined {
    if (this.packLevels.size === 0 && this.packCreateCount === 0) return undefined;
    return {
      documentName: this.packDocumentName,
      permissionLevel: (userId) => this.packLevels.get(userId),
    };
  }

  createPack = async (): Promise<void> => {
    if (this.packCreateCount > 0) throw new Error('Compendium already exists');
    this.packCreateCount += 1;
    this.packLevels.set('gm', 'OWNER');
    this.packLevels.set('assistant', 'OWNER');
    this.packLevels.set('trusted', 'OBSERVER');
    this.packLevels.set('player', 'OBSERVER');
  };

  host(userId = 'gm'): RepositoryHost {
    const world = this;
    return {
      worldId: 'test-world',
      get currentUser() {
        const user = world.users.find((candidate) => candidate.id === userId);
        if (!user) throw new Error(`Unknown fake user ${userId}`);
        return user;
      },
      get users() { return world.users; },
      findPack: () => world.pack(),
      canModifySettings: (id) => world.settingsEditors.has(id),
      createPack: async () => world.createPack(),
      makeId: () => `id-${++world.nextHostId}`,
      rpc: async (event, request) => world.dispatch(event, request, userId),
    };
  }

  private async dispatch(
    event: RepositoryRpcEvent,
    request: Record<string, unknown>,
    userId: string
  ): Promise<unknown> {
    assert.equal(event, 'modifyDocument');
    const type = request.type;
    const action = request.action;
    const operation = request.operation as Record<string, unknown> | undefined;
    assert.equal(operation?.pack, PACK_COLLECTION);

    if (action === 'get' && type === 'JournalEntry') {
      const query = operation?.query as Record<string, unknown> | undefined;
      const matches = query?._id === undefined
        ? this.entries
        : this.entries.filter((entry) => entry._id === query._id);
      return { result: structuredClone(matches) };
    }

    if (action === 'create' && type === 'JournalEntry') {
      const flags = (dataFlags(operation) ?? {})[MODULE_ID] as Record<string, unknown> | undefined;
      if (flags?.role === 'sequence' && this.failNextSequenceParentCreate) {
        this.failNextSequenceParentCreate = false;
        throw new Error('Sequence parent creation failed before commit');
      }
      this.writeCount += 1;
      const data = operation?.data;
      assert.ok(Array.isArray(data));
      const created = (data as Record<string, unknown>[]).map((item) => {
        const entry: FakeEntry = {
          _id: `entry-${++this.nextEntryId}`,
          name: String(item.name),
          flags: structuredClone(item.flags as Record<string, unknown>),
          pages: [],
        };
        this.entries.push(entry);
        return { _id: entry._id };
      });
      return { result: created };
    }

    if (action === 'create' && type === 'JournalEntryPage') {
      if (this.failNextPageCreate) {
        this.failNextPageCreate = false;
        throw new Error('Page creation failed before commit');
      }
      if (this.dropNextPageCreate) {
        this.dropNextPageCreate = false;
        return { result: [] };
      }
      this.writeCount += 1;
      const parentId = String(operation?.parentUuid).split('.').at(-1);
      const parent = this.entries.find((entry) => entry._id === parentId);
      assert.ok(parent, `Missing parent ${parentId}`);
      const data = operation?.data;
      assert.ok(Array.isArray(data));
      const item = (data as Record<string, unknown>[])[0];
      assert.ok(item);
      if (parent.pages?.some((page) => page._id === item._id)) throw new Error('Duplicate page slot');
      const page: FakePage = {
        _id: String(item._id),
        name: String(item.name),
        type: 'text',
        flags: structuredClone(item.flags as Record<string, unknown>),
        _stats: { lastModifiedBy: userId },
      };
      parent.pages ??= [];
      parent.pages.push(page);
      if (flagsOfFake(page.flags)?.role === 'sequence-creation-claim' && this.claimGate) {
        const gate = this.claimGate;
        this.claimGate = undefined;
        gate.signalEntered();
        await gate.wait;
      }
      if (flagsOfFake(page.flags)?.role === 'sequence-creation-claim' && this.loseNextClaimAck) {
        this.loseNextClaimAck = false;
        throw new Error('Creation reservation acknowledgement lost after commit');
      }
      if (this.loseNextPageAck) {
        this.loseNextPageAck = false;
        throw new Error('Acknowledgement lost after commit');
      }
      return { result: [{ _id: page._id }] };
    }

    throw new Error(`Unexpected fake operation ${String(type)} ${String(action)}`);
  }

  addAuthorityRoot(name = 'Stagecraft Sequence Authority'): FakeEntry {
    const root: FakeEntry = {
      _id: `entry-${++this.nextEntryId}`,
      name,
      flags: { [MODULE_ID]: { role: 'authority', schemaVersion: 1 } },
      pages: [],
    };
    this.entries.push(root);
    return root;
  }

  addFutureSequence(sequenceId: string): FakeEntry {
    const entry: FakeEntry = {
      _id: `entry-${++this.nextEntryId}`,
      name: 'Future sequence',
      flags: { [MODULE_ID]: { role: 'sequence', schemaVersion: 2, sequenceId } },
      pages: [],
    };
    this.entries.push(entry);
    return entry;
  }

  addFutureAuthorityPage(): void {
    const root = this.entries.find((entry) => flagsOfFake(entry.flags)?.role === 'authority');
    assert.ok(root);
    root.pages?.push({
      _id: 'future-session',
      name: 'Future session record',
      type: 'text',
      flags: { [MODULE_ID]: { role: 'session', recordVersion: 99, sequenceId: 'future-session-sequence' } },
      _stats: { lastModifiedBy: 'gm' },
    });
  }

  pauseNextClaimAfterCommit(): { readonly entered: Promise<void>; readonly release: () => void } {
    let signalEntered = (): void => {};
    let release = (): void => {};
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.claimGate = { signalEntered, wait };
    return { entered, release };
  }
}

function dataFlags(operation: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const data = operation?.data;
  const first = Array.isArray(data) ? data[0] : undefined;
  return first && typeof first === 'object' ? (first as Record<string, unknown>).flags as Record<string, unknown> | undefined : undefined;
}

function flagsOfFake(flags: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const moduleFlags = flags?.[MODULE_ID];
  return moduleFlags && typeof moduleFlags === 'object' ? moduleFlags as Record<string, unknown> : undefined;
}

function seedExistingPack(world: FakeWorld): void {
  world.packCreateCount = 1;
  world.packLevels.set('gm', 'OWNER');
  world.packLevels.set('assistant', 'OWNER');
  world.packLevels.set('trusted', 'OBSERVER');
  world.packLevels.set('player', 'OBSERVER');
}

function sequence(id: string, name = `Sequence ${id}`): SequenceV1 {
  let number = 0;
  return createBarsSequence(name, () => `${id}-${++number}`) as SequenceV1;
}

function assertRepositoryCode(code: RepositoryError['code']) {
  return (error: unknown): boolean => error instanceof RepositoryError && error.code === code;
}

test('missing library lists empty without initialization; first save creates the pack, marked root, and revision 1', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());

  assert.deepEqual(await repository.list(), []);
  assert.equal(world.packCreateCount, 0);
  assert.equal(world.writeCount, 0);

  const saved = await repository.save(sequence('opening'), null);
  assert.equal(saved.revision, 1);
  assert.equal(world.packCreateCount, 1);
  assert.equal(world.entries.length, 2);
  const rootFlags = world.entries[0]?.flags?.[MODULE_ID] as Record<string, unknown>;
  assert.equal(rootFlags.role, 'authority');
  assert.equal(rootFlags.schemaVersion, 1);
  assert.deepEqual(await repository.list(), [{ id: saved.id, revision: 1, name: saved.name }]);
  assert.deepEqual(await repository.read(saved.id), saved);
});

test('concurrent creates for one sequence contend on one authority-root reservation', async () => {
  const world = new FakeWorld();
  seedExistingPack(world);
  world.addAuthorityRoot();
  const repositoryA = createFoundryRepository(world.host());
  const repositoryB = createFoundryRepository(world.host());
  const sameSequence = sequence('create-race');

  const raced = await Promise.allSettled([
    repositoryA.save(sameSequence, null),
    repositoryB.save(sameSequence, null),
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = raced.find((result) => result.status === 'rejected');
  assert.ok(rejection && rejection.status === 'rejected');
  assert.ok(rejection.reason instanceof RepositoryError);
  assert.equal(rejection.reason.code, 'CONFLICT');

  const roots = world.entries.filter((entry) => flagsOfFake(entry.flags)?.role === 'authority');
  const sequenceParents = world.entries.filter((entry) => {
    const flags = flagsOfFake(entry.flags);
    return flags?.role === 'sequence' && flags.sequenceId === sameSequence.id;
  });
  assert.equal(sequenceParents.length, 1);
  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.pages?.length, 1);
  assert.match(roots[0]?.pages?.[0]?._id ?? '', /^c[0-9a-f]{15}$/);
  assert.equal(roots[0]?.pages?.[0]?._id, 'c42b70e9d1450d5b');
  assert.equal((await repositoryA.read(sameSequence.id) as SequenceV1).revision, 1);

  const separate = await repositoryB.save(sequence('create-race-other'), null);
  assert.equal(separate.revision, 1);
  assert.equal((await repositoryA.list()).length, 2);
});

test('a different create request conflicts while a valid reservation is awaiting its parent', async () => {
  const world = new FakeWorld();
  seedExistingPack(world);
  world.addAuthorityRoot();
  const repositoryA = createFoundryRepository(world.host());
  const repositoryB = createFoundryRepository(world.host());
  const input = sequence('pending-create');
  const gate = world.pauseNextClaimAfterCommit();

  const winnerPromise = repositoryA.save(input, null);
  await gate.entered;
  await assert.rejects(repositoryB.save(input, null), assertRepositoryCode('CONFLICT'));
  gate.release();
  assert.equal((await winnerPromise).revision, 1);
  assert.equal(world.entries.filter((entry) => {
    const flags = flagsOfFake(entry.flags);
    return flags?.role === 'sequence' && flags.sequenceId === input.id;
  }).length, 1);
});

test('lost creation-reservation acknowledgement is recovered by its exact request ID', async () => {
  const world = new FakeWorld();
  seedExistingPack(world);
  const root = world.addAuthorityRoot();
  const repository = createFoundryRepository(world.host());
  world.loseNextClaimAck = true;

  const saved = await repository.save(sequence('claim-lost-ack'), null);
  assert.equal(saved.revision, 1);
  assert.equal(root.pages?.length, 1);
  const claim = root.pages?.[0];
  assert.equal(flagsOfFake(claim?.flags)?.sequenceId, saved.id);
  const parent = world.entries.find((entry) => {
    const flags = flagsOfFake(entry.flags);
    return flags?.role === 'sequence' && flags.sequenceId === saved.id;
  });
  assert.ok(parent);
  const parentFlags = parent.flags?.[MODULE_ID] as Record<string, unknown>;
  assert.equal(flagsOfFake(claim?.flags)?.createRequestId, parentFlags.createRequestId);
  assert.equal(parentFlags.reservationId, claim?._id);
  assert.equal(claim?._stats.lastModifiedBy, 'gm');
});

test('an incomplete creation reservation is an issue only for its sequence and is preserved', async () => {
  const world = new FakeWorld();
  seedExistingPack(world);
  world.addAuthorityRoot();
  const repository = createFoundryRepository(world.host());
  world.failNextSequenceParentCreate = true;
  const incomplete = sequence('incomplete-create');

  await assert.rejects(
    repository.save(incomplete, null),
    assertRepositoryCode('STORAGE_FAILURE')
  );
  const reservationWriteCount = world.writeCount;
  const summaries = await repository.list();
  assert.deepEqual(summaries, [{
    id: incomplete.id,
    revision: 0,
    name: 'Unavailable sequence',
    issue: 'CORRUPT_STORAGE',
  }]);
  await assert.rejects(repository.read(incomplete.id), assertRepositoryCode('CORRUPT_STORAGE'));
  await assert.rejects(repository.save(incomplete, null), assertRepositoryCode('CONFLICT'));
  assert.equal(world.writeCount, reservationWriteCount);

  const other = await repository.save(sequence('incomplete-other'), null);
  assert.equal(other.revision, 1);
  const stillIssue = (await repository.list()).find((item) => item.id === incomplete.id);
  assert.equal(stillIssue?.issue, 'CORRUPT_STORAGE');
  assert.equal(world.entries.filter((entry) => flagsOfFake(entry.flags)?.role === 'sequence' && flagsOfFake(entry.flags)?.sequenceId === incomplete.id).length, 0);
});

test('a creation reservation without a server actor stamp affects only its own sequence', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const saved = await repository.save(sequence('claim-actor'), null);
  const root = world.entries.find((entry) => flagsOfFake(entry.flags)?.role === 'authority');
  assert.ok(root?.pages?.[0]);
  root.pages[0]._stats.lastModifiedBy = '';

  assert.deepEqual((await repository.list()).find((item) => item.id === saved.id), {
    id: saved.id,
    revision: 0,
    name: saved.name,
    issue: 'CORRUPT_STORAGE',
  });
  const other = await repository.save(sequence('claim-actor-other'), null);
  assert.equal(other.revision, 1);
  assert.equal((await repository.list()).find((item) => item.id === other.id)?.revision, 1);
});

test('unreserved v1 sequence parents remain readable and future authority pages are ignored', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const saved = await repository.save(sequence('legacy-unreserved'), null);
  const root = world.entries.find((entry) => flagsOfFake(entry.flags)?.role === 'authority');
  const parent = world.entries.find((entry) => flagsOfFake(entry.flags)?.sequenceId === saved.id);
  assert.ok(root && parent);
  root.pages = [];
  const parentFlags = parent.flags?.[MODULE_ID] as Record<string, unknown>;
  delete parentFlags.reservationId;
  assert.equal(typeof parentFlags.createRequestId, 'string');
  world.addFutureAuthorityPage();

  assert.deepEqual(await repository.list(), [{ id: saved.id, revision: 1, name: saved.name }]);
  assert.deepEqual(await repository.read(saved.id), saved);
});

test('stale revisions conflict before writing and concurrent saves contend for one immutable slot', async () => {
  const world = new FakeWorld();
  const repositoryA = createFoundryRepository(world.host());
  const repositoryB = createFoundryRepository(world.host());
  const initial = await repositoryA.save(sequence('race'), null);

  const writesBeforeStaleSave = world.writeCount;
  await assert.rejects(
    repositoryA.save({ ...initial, name: 'Stale overwrite' }, 0),
    assertRepositoryCode('CONFLICT')
  );
  assert.equal(world.writeCount, writesBeforeStaleSave);

  const raced = await Promise.allSettled([
    repositoryA.save({ ...initial, name: 'Winner A' }, 1),
    repositoryB.save({ ...initial, name: 'Winner B' }, 1),
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = raced.find((result) => result.status === 'rejected');
  assert.ok(rejection && rejection.status === 'rejected');
  assert.ok(rejection.reason instanceof RepositoryError);
  assert.equal(rejection.reason.code, 'CONFLICT');
  const history = world.entries.find((entry) => (entry.flags?.[MODULE_ID] as Record<string, unknown> | undefined)?.sequenceId === initial.id)?.pages;
  assert.equal(history?.length, 2);
  assert.equal((await repositoryA.read(initial.id) as SequenceV1).revision, 2);
});

test('lost append acknowledgement is recovered by reading the exact request ID', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const initial = await repository.save(sequence('lost-ack'), null);
  world.loseNextPageAck = true;

  const saved = await repository.save({ ...initial, name: 'Confirmed after readback' }, 1);
  assert.equal(saved.revision, 2);
  assert.equal(saved.name, 'Confirmed after readback');
  assert.equal((await repository.read(initial.id) as SequenceV1).revision, 2);
  assert.equal(world.entries.find((entry) => (entry.flags?.[MODULE_ID] as Record<string, unknown> | undefined)?.sequenceId === initial.id)?.pages?.length, 2);
});

test('an identifiable unsupported sequence appears as an issue row while other sequences remain usable', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const current = await repository.save(sequence('current'), null);
  world.addFutureSequence('future');

  const summaries = await repository.list();
  assert.deepEqual(summaries.find((item) => item.id === 'future'), {
    id: 'future',
    revision: 0,
    name: 'Future sequence',
    issue: 'UNSUPPORTED_DATA',
  });
  await assert.rejects(repository.read('future'), assertRepositoryCode('UNSUPPORTED_DATA'));

  const created = await repository.save(sequence('separate'), null);
  assert.equal(created.revision, 1);
  assert.equal((await repository.read(current.id) as SequenceV1).revision, 1);
  assert.equal(world.entries.filter((entry) => (entry.flags?.[MODULE_ID] as Record<string, unknown> | undefined)?.sequenceId === 'future').length, 1);
});

test('missing or duplicate roots fail closed without repairing or replacing existing data', async () => {
  const missing = new FakeWorld();
  seedExistingPack(missing);
  const incompleteEntry: FakeEntry = {
    _id: 'legacy-entry',
    name: 'Unrelated preserved data',
    flags: { other: { retained: true } },
    pages: [],
  };
  missing.entries.push(incompleteEntry);
  const missingRepository = createFoundryRepository(missing.host());
  const missingBefore = structuredClone(missing.entries);
  const missingWrites = missing.writeCount;
  await assert.rejects(missingRepository.list(), assertRepositoryCode('CORRUPT_STORAGE'));
  await assert.rejects(missingRepository.save(sequence('blocked'), null), assertRepositoryCode('CORRUPT_STORAGE'));
  assert.deepEqual(missing.entries, missingBefore);
  assert.equal(missing.writeCount, missingWrites);

  const duplicate = new FakeWorld();
  seedExistingPack(duplicate);
  duplicate.addAuthorityRoot('Root A');
  duplicate.addAuthorityRoot('Root B');
  const duplicateRepository = createFoundryRepository(duplicate.host());
  const duplicateBefore = structuredClone(duplicate.entries);
  await assert.rejects(duplicateRepository.list(), assertRepositoryCode('CORRUPT_STORAGE'));
  await assert.rejects(duplicateRepository.save(sequence('blocked'), null), assertRepositoryCode('CORRUPT_STORAGE'));
  assert.deepEqual(duplicate.entries, duplicateBefore);
});

test('unsafe player permissions block pack creation and existing-pack writes before mutation', async () => {
  const missingPack = new FakeWorld();
  missingPack.settingsEditors.add('player');
  const missingRepository = createFoundryRepository(missingPack.host());
  await assert.rejects(missingRepository.save(sequence('unsafe'), null), assertRepositoryCode('UNSAFE_PERMISSIONS'));
  assert.equal(missingPack.packCreateCount, 0);
  assert.equal(missingPack.writeCount, 0);

  const ownedByPlayer = new FakeWorld();
  seedExistingPack(ownedByPlayer);
  ownedByPlayer.addAuthorityRoot();
  ownedByPlayer.packLevels.set('player', 'OWNER');
  const repository = createFoundryRepository(ownedByPlayer.host());
  const before = structuredClone(ownedByPlayer.entries);
  const writes = ownedByPlayer.writeCount;
  await assert.rejects(repository.save(sequence('unsafe-existing'), null), assertRepositoryCode('UNSAFE_PERMISSIONS'));
  assert.deepEqual(ownedByPlayer.entries, before);
  assert.equal(ownedByPlayer.writeCount, writes);
});

test('duplicate sequence IDs and corrupt revision chains block the affected library state', async () => {
  const world = new FakeWorld();
  seedExistingPack(world);
  world.addAuthorityRoot();
  world.addFutureSequence('same-id');
  world.addFutureSequence('same-id');
  const repository = createFoundryRepository(world.host());
  await assert.rejects(repository.list(), assertRepositoryCode('CORRUPT_STORAGE'));

  const broken = new FakeWorld();
  seedExistingPack(broken);
  broken.addAuthorityRoot();
  broken.entries.push({
    _id: 'bad-sequence',
    name: 'Broken history',
    flags: { [MODULE_ID]: { role: 'sequence', schemaVersion: 1, sequenceId: 'broken' } },
    pages: [{
      _id: 'wrong-slot',
      name: 'Revision 1',
      type: 'text',
      flags: { [MODULE_ID]: { role: 'revision', recordVersion: 1, index: 1, previous: 0, requestId: 'request', payload: sequence('broken') } },
      _stats: { lastModifiedBy: 'gm' },
    }],
  });
  const brokenRepository = createFoundryRepository(broken.host());
  assert.deepEqual((await brokenRepository.list()).find((item) => item.id === 'broken'), {
    id: 'broken', revision: 0, name: 'Broken history', issue: 'CORRUPT_STORAGE',
  });
  await assert.rejects(brokenRepository.read('broken'), assertRepositoryCode('CORRUPT_STORAGE'));
});

function parentOf(world: FakeWorld, id: string): FakeEntry {
  const parent = world.entries.find((entry) => flagsOfFake(entry.flags)?.role === 'sequence'
    && flagsOfFake(entry.flags)?.sequenceId === id);
  assert.ok(parent);
  return parent;
}

test('deletion appends a terminal revision while preserving historical data, root and other sequences', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const first = await repository.save(sequence('delete-preserved'), null);
  const snapshot = structuredClone(first);
  const saved = await repository.save({ ...first, name: 'Latest before deletion' }, 1);
  const other = await repository.save(sequence('delete-other'), null);
  world.addFutureAuthorityPage();
  const rootBefore = structuredClone(world.entries.find((entry) => flagsOfFake(entry.flags)?.role === 'authority'));
  const otherBefore = structuredClone(parentOf(world, other.id));
  const parent = parentOf(world, saved.id);
  const historyBefore = structuredClone(parent.pages);
  const flagsBefore = structuredClone(parent.flags);

  await repository.delete(saved.id, 2);

  assert.deepEqual(parent.pages?.slice(0, 2), historyBefore);
  assert.deepEqual(parent.flags, flagsBefore);
  assert.deepEqual(world.entries.find((entry) => flagsOfFake(entry.flags)?.role === 'authority'), rootBefore);
  assert.deepEqual(parentOf(world, other.id), otherBefore);
  assert.deepEqual(await repository.list(), [{ id: other.id, name: other.name, revision: 1 }]);
  assert.deepEqual(await repository.read(other.id), other);
  assert.deepEqual(first, snapshot, 'an already loaded playback snapshot stays unchanged');
  const deletion = parent.pages?.at(-1);
  assert.equal(deletion?._id, 'r000000000000003');
  assert.equal(flagsOfFake(deletion?.flags)?.recordVersion, 2, 'v1 readers reject before inspecting payload');
  assert.equal(flagsOfFake(deletion?.flags)?.operation, 'delete');
  assert.equal(flagsOfFake(deletion?.flags)?.sequenceId, saved.id);
  assert.equal(flagsOfFake(deletion?.flags)?.payload, undefined);
  assert.equal(deletion?._stats.lastModifiedBy, 'gm');
  const writes = world.writeCount;
  await assert.rejects(repository.read(saved.id), assertRepositoryCode('NOT_FOUND'));
  await assert.rejects(repository.save(saved, 2), assertRepositoryCode('NOT_FOUND'));
  await assert.rejects(repository.save(saved, null), assertRepositoryCode('NOT_FOUND'));
  await assert.rejects(repository.delete(saved.id, 2), assertRepositoryCode('NOT_FOUND'));
  assert.equal(world.writeCount, writes);
});

test('deletion rejects stale, missing and invalid inputs without initializing or writing', async () => {
  const empty = new FakeWorld();
  const emptyRepository = createFoundryRepository(empty.host());
  await assert.rejects(emptyRepository.delete('missing', 1), assertRepositoryCode('NOT_FOUND'));
  assert.equal(empty.packCreateCount, 0);
  assert.equal(empty.writeCount, 0);
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const saved = await repository.save(sequence('delete-stale'), null);
  const before = structuredClone(world.entries);
  const writes = world.writeCount;
  await assert.rejects(repository.delete('missing', 1), assertRepositoryCode('NOT_FOUND'));
  await assert.rejects(repository.delete(saved.id, 2), assertRepositoryCode('CONFLICT'));
  for (const revision of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(repository.delete(saved.id, revision), assertRepositoryCode('INVALID_SEQUENCE'));
  }
  await assert.rejects(repository.delete('../foreign', 1), assertRepositoryCode('INVALID_SEQUENCE'));
  assert.deepEqual(world.entries, before);
  assert.equal(world.writeCount, writes);
});

test('two writers racing save against delete occupy exactly one immutable revision slot', async () => {
  for (const deleteFirst of [true, false]) {
    const world = new FakeWorld();
    const repositoryA = createFoundryRepository(world.host());
    const repositoryB = createFoundryRepository(world.host('assistant'));
    const saved = await repositoryA.save(sequence(`save-delete-${deleteFirst}`), null);
    const deleteOperation = (): Promise<void> => repositoryA.delete(saved.id, 1);
    const saveOperation = (): Promise<SequenceV1> => repositoryB.save({ ...saved, name: 'Racing save' }, 1);
    const raced = await Promise.allSettled(deleteFirst
      ? [deleteOperation(), saveOperation()]
      : [saveOperation(), deleteOperation()]);
    assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = raced.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(assertRepositoryCode('CONFLICT')(rejected.reason));
    const pages = parentOf(world, saved.id).pages;
    assert.equal(pages?.length, 2);
    if (flagsOfFake(pages?.[1]?.flags)?.operation === 'delete') {
      assert.deepEqual(await repositoryA.list(), []);
      await assert.rejects(repositoryA.read(saved.id), assertRepositoryCode('NOT_FOUND'));
    } else {
      assert.equal((await repositoryA.read(saved.id) as SequenceV1).revision, 2);
    }
  }
});

test('concurrent deletion requests have one winner and deletion shares local serialization with save', async () => {
  const world = new FakeWorld();
  const repositoryA = createFoundryRepository(world.host());
  const repositoryB = createFoundryRepository(world.host());
  const saved = await repositoryA.save(sequence('delete-race'), null);
  const raced = await Promise.allSettled([repositoryA.delete(saved.id, 1), repositoryB.delete(saved.id, 1)]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(parentOf(world, saved.id).pages?.length, 2);
  const rejected = raced.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(assertRepositoryCode('CONFLICT')(rejected.reason));

  const local = await repositoryA.save(sequence('delete-local-lock'), null);
  const writes = world.writeCount;
  const serial = await Promise.allSettled([
    repositoryA.save({ ...local, name: 'Serialized save' }, 1),
    repositoryA.delete(local.id, 1),
  ]);
  assert.equal(serial[0]?.status, 'fulfilled');
  assert.equal(serial[1]?.status, 'rejected');
  assert.equal(world.writeCount, writes + 1, 'stale queued deletion never reaches the server');
  assert.equal((await repositoryA.read(local.id) as SequenceV1).revision, 2);
});

test('lost deletion acknowledgement is recovered by exact request readback; unconfirmed writes do not succeed', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const saved = await repository.save(sequence('delete-lost-ack'), null);
  world.loseNextPageAck = true;
  await repository.delete(saved.id, 1);
  assert.equal(parentOf(world, saved.id).pages?.length, 2);
  assert.deepEqual(await repository.list(), []);

  for (const failure of ['failNextPageCreate', 'dropNextPageCreate'] as const) {
    const retained = await repository.save(sequence(`delete-${failure}`), null);
    world[failure] = true;
    await assert.rejects(repository.delete(retained.id, 1), assertRepositoryCode('STORAGE_FAILURE'));
    assert.deepEqual(await repository.read(retained.id), retained);
    assert.equal(parentOf(world, retained.id).pages?.length, 1);
  }
});

test('unsafe permissions and a role change during deletion preparation block the append', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const saved = await repository.save(sequence('delete-permissions'), null);
  const before = structuredClone(world.entries);
  const writes = world.writeCount;
  world.packLevels.set('trusted', 'OWNER');
  await assert.rejects(repository.delete(saved.id, 1), assertRepositoryCode('UNSAFE_PERMISSIONS'));
  world.packLevels.set('trusted', 'OBSERVER');
  world.settingsEditors.add('player');
  await assert.rejects(repository.delete(saved.id, 1), assertRepositoryCode('UNSAFE_PERMISSIONS'));
  world.settingsEditors.clear();
  const host = world.host();
  const roleChangingHost: RepositoryHost = {
    ...host,
    get currentUser() { return world.users.find((user) => user.id === 'gm')!; },
    get users() { return world.users; },
    rpc: async (event, request) => {
      const response = await host.rpc(event, request);
      if (request.action === 'get') world.users = world.users.map((user) => user.id === 'gm' ? { ...user, role: 2 } : user);
      return response;
    },
  };
  await assert.rejects(createFoundryRepository(roleChangingHost).delete(saved.id, 1), assertRepositoryCode('UNSAFE_PERMISSIONS'));
  assert.equal(world.writeCount, writes);
  assert.deepEqual(world.entries, before);
});

test('malformed, foreign and future deletion records stay preserved as issue rows and cannot resurrect', async () => {
  const cases: readonly [string, RepositoryError['code'], (record: Record<string, unknown>, page: FakePage, parent: FakeEntry) => void][] = [
    ['foreign-id', 'CORRUPT_STORAGE', (record) => { record.sequenceId = 'foreign-sequence'; }],
    ['payload', 'CORRUPT_STORAGE', (record) => { record.payload = {}; }],
    ['missing-operation', 'UNSUPPORTED_DATA', (record) => { delete record.operation; }],
    ['foreign-role', 'CORRUPT_STORAGE', (record) => { record.role = 'foreign-delete'; }],
    ['future-version', 'UNSUPPORTED_DATA', (record) => { record.recordVersion = 3; }],
    ['future-operation', 'UNSUPPORTED_DATA', (record) => { record.operation = 'restore'; }],
    ['missing-request', 'CORRUPT_STORAGE', (record) => { delete record.requestId; }],
    ['duplicate-request', 'CORRUPT_STORAGE', (record, _page, parent) => { record.requestId = flagsOfFake(parent.pages![0]!.flags)!.requestId; }],
    ['wrong-slot', 'CORRUPT_STORAGE', (_record, page) => { page._id = 'foreign-slot'; }],
    ['first-revision', 'CORRUPT_STORAGE', (record, page, parent) => {
      record.index = 1;
      record.previous = 0;
      page._id = 'r000000000000001';
      parent.pages = [page];
    }],
    ['player-actor', 'UNSAFE_PERMISSIONS', (_record, page) => { page._stats.lastModifiedBy = 'player'; }],
    ['missing-actor', 'CORRUPT_STORAGE', (_record, page) => { page._stats.lastModifiedBy = ''; }],
    ['after-terminal', 'CORRUPT_STORAGE', (_record, _page, parent) => {
      const prior = structuredClone(parent.pages![0]!);
      prior._id = 'r000000000000003';
      const flags = flagsOfFake(prior.flags)!;
      flags.index = 3;
      flags.previous = 2;
      flags.requestId = 'after-deletion';
      flags.payload = { ...(flags.payload as SequenceV1), revision: 3 };
      parent.pages!.push(prior);
    }],
  ];
  for (const [name, code, mutate] of cases) {
    const world = new FakeWorld();
    const repository = createFoundryRepository(world.host());
    const saved = await repository.save(sequence(`delete-invalid-${name}`), null);
    const other = await repository.save(sequence(`untouched-${name}`), null);
    await repository.delete(saved.id, 1);
    const parent = parentOf(world, saved.id);
    const deletion = parent.pages!.at(-1)!;
    mutate(flagsOfFake(deletion.flags)!, deletion, parent);
    const before = structuredClone(world.entries);
    const writes = world.writeCount;
    assert.equal((await repository.list()).find((item) => item.id === saved.id)?.issue, code, name);
    await assert.rejects(repository.read(saved.id), assertRepositoryCode(code), name);
    await assert.rejects(repository.save(saved, null), assertRepositoryCode(code), name);
    await assert.rejects(repository.delete(saved.id, 1), assertRepositoryCode(code), name);
    assert.deepEqual(await repository.read(other.id), other, name);
    assert.deepEqual(world.entries, before, name);
    assert.equal(world.writeCount, writes, name);
  }
});

test('a persisted deletion whose actor loses authority becomes an issue and remains blocked', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const saved = await repository.save(sequence('delete-demoted-actor'), null);
  await repository.delete(saved.id, 1);
  const before = structuredClone(world.entries);
  world.users = world.users.map((user) => user.id === 'gm' ? { ...user, role: 2 } : user);
  world.packLevels.set('gm', 'OBSERVER');
  const assistantRepository = createFoundryRepository(world.host('assistant'));
  assert.equal((await assistantRepository.list())[0]?.issue, 'UNSAFE_PERMISSIONS');
  await assert.rejects(assistantRepository.read(saved.id), assertRepositoryCode('UNSAFE_PERMISSIONS'));
  await assert.rejects(assistantRepository.save(saved, null), assertRepositoryCode('UNSAFE_PERMISSIONS'));
  assert.deepEqual(world.entries, before);
});

function fillSavedHistory(parent: FakeEntry, saved: SequenceV1, count: number): void {
  parent.pages = Array.from({ length: count }, (_, offset): FakePage => {
    const index = offset + 1;
    return {
      _id: `r${index.toString(36).padStart(15, '0')}`,
      name: `Revision ${index}`,
      type: 'text',
      flags: {
        [MODULE_ID]: {
          role: 'revision', recordVersion: 1, index, previous: index - 1,
          requestId: `boundary-request-${index}`, payload: { ...saved, revision: index },
        },
      },
      _stats: { lastModifiedBy: 'gm' },
    };
  });
}

function boundaryDeletion(id: string, index: number): FakePage {
  return {
    _id: `r${index.toString(36).padStart(15, '0')}`,
    name: `Revision ${index}`,
    type: 'text',
    flags: {
      [MODULE_ID]: {
        role: 'revision', recordVersion: 2, operation: 'delete', sequenceId: id,
        index, previous: index - 1, requestId: `boundary-deletion-${index}`,
      },
    },
    _stats: { lastModifiedBy: 'gm' },
  };
}

test('5000 saved revisions retain their save cap and permit one extra terminal deletion with lost acknowledgement', async () => {
  const world = new FakeWorld();
  const repository = createFoundryRepository(world.host());
  const saved = await repository.save(sequence('delete-save-limit'), null);
  const parent = parentOf(world, saved.id);
  fillSavedHistory(parent, saved, 5000);
  const latest = { ...saved, revision: 5000 };
  assert.deepEqual(await repository.read(saved.id), latest);
  const historyBefore = structuredClone(parent.pages);
  const rootBefore = structuredClone(world.entries.find((entry) => flagsOfFake(entry.flags)?.role === 'authority'));
  const writes = world.writeCount;
  await assert.rejects(repository.save(latest, 5000), assertRepositoryCode('UNSUPPORTED_DATA'));
  assert.equal(world.writeCount, writes);
  world.loseNextPageAck = true;
  await repository.delete(saved.id, 5000);
  assert.equal(world.writeCount, writes + 1);
  assert.equal(parent.pages?.length, 5001);
  assert.deepEqual(parent.pages?.slice(0, 5000), historyBefore);
  assert.deepEqual(world.entries.find((entry) => flagsOfFake(entry.flags)?.role === 'authority'), rootBefore);
  const terminal = parent.pages?.at(-1);
  assert.equal(terminal?._id, `r${(5001).toString(36).padStart(15, '0')}`);
  assert.equal(flagsOfFake(terminal?.flags)?.recordVersion, 2);
  assert.equal(flagsOfFake(terminal?.flags)?.operation, 'delete');
  assert.deepEqual(await repository.list(), []);
  await assert.rejects(repository.read(saved.id), assertRepositoryCode('NOT_FOUND'));
  await assert.rejects(repository.save(latest, null), assertRepositoryCode('NOT_FOUND'));
  await assert.rejects(repository.delete(saved.id, 5000), assertRepositoryCode('NOT_FOUND'));
  assert.equal(world.writeCount, writes + 1);
});

test('the reserved 5001st slot rejects saves, nonterminal deletions and oversized histories without writes', async () => {
  const cases: readonly [string, RepositoryError['code'], (parent: FakeEntry, saved: SequenceV1) => void][] = [
    ['save-in-deletion-slot', 'UNSUPPORTED_DATA', (parent, saved) => { fillSavedHistory(parent, saved, 5001); }],
    ['nonterminal-delete', 'CORRUPT_STORAGE', (parent, saved) => {
      fillSavedHistory(parent, saved, 5001);
      parent.pages![4999] = boundaryDeletion(saved.id, 5000);
    }],
    ['after-reserved-delete', 'UNSUPPORTED_DATA', (parent, saved) => {
      fillSavedHistory(parent, saved, 5002);
      parent.pages![5000] = boundaryDeletion(saved.id, 5001);
    }],
    ['deletion-beyond-reserved-slot', 'UNSUPPORTED_DATA', (parent, saved) => {
      fillSavedHistory(parent, saved, 5001);
      parent.pages!.push(boundaryDeletion(saved.id, 5002));
    }],
  ];
  for (const [name, code, arrange] of cases) {
    const world = new FakeWorld();
    const repository = createFoundryRepository(world.host());
    const saved = await repository.save(sequence(`delete-boundary-${name}`), null);
    arrange(parentOf(world, saved.id), saved);
    const before = structuredClone(world.entries);
    const writes = world.writeCount;
    assert.equal((await repository.list())[0]?.issue, code, name);
    await assert.rejects(repository.read(saved.id), assertRepositoryCode(code), name);
    await assert.rejects(repository.delete(saved.id, 5000), assertRepositoryCode(code), name);
    await assert.rejects(repository.save({ ...saved, revision: 5000 }, 5000), assertRepositoryCode(code), name);
    assert.deepEqual(world.entries, before, name);
    assert.equal(world.writeCount, writes, name);
  }
});
