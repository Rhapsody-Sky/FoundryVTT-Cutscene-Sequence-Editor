import assert from 'node:assert/strict';
import test from 'node:test';
import { createBarsSequence } from '../src/domain/validation.js';
import {
  createSessionStore,
  SessionStoreError,
} from '../src/integrations/foundry/session-store.js';
import type {
  RepositoryHost,
  RepositoryPack,
  RepositoryPermissionLevel,
  RepositoryRpcEvent,
  RepositoryUser,
} from '../src/integrations/foundry/sequence-repository.js';

const MODULE_ID = 'stagecraft';
const PACK_COLLECTION = 'world.stagecraft-sequences';
const ROOT_ID = 'authority-root';

interface FakePage {
  _id: string;
  name: string;
  type: 'text';
  flags: Record<string, unknown>;
  _stats: { lastModifiedBy: string };
}

interface FakeEntry {
  _id: string;
  flags: Record<string, unknown>;
  pages: FakePage[];
}

class FakeWorld {
  users: RepositoryUser[] = [
    { id: 'gm', role: 4 },
    { id: 'assistant', role: 3 },
    { id: 'trusted', role: 2 },
    { id: 'player', role: 1 },
  ];
  readonly entries: FakeEntry[] = [];
  readonly settingsEditors = new Set<string>();
  readonly packLevels = new Map<string, RepositoryPermissionLevel>([
    ['gm', 'OWNER'],
    ['assistant', 'OWNER'],
    ['trusted', 'OBSERVER'],
    ['player', 'OBSERVER'],
  ]);
  packAvailable = true;
  packDocumentName = 'JournalEntry';
  writes = 0;
  reads = 0;
  nextId = 0;
  loseNextAck = false;

  constructor(includeRoot = true) {
    if (includeRoot) this.addRoot();
  }

  addRoot(id = ROOT_ID): FakeEntry {
    const entry: FakeEntry = {
      _id: id,
      flags: { [MODULE_ID]: { role: 'authority', schemaVersion: 1 } },
      pages: [],
    };
    this.entries.push(entry);
    return entry;
  }

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
      findPack(collection) {
        if (collection !== PACK_COLLECTION || !world.packAvailable) return undefined;
        return {
          documentName: world.packDocumentName,
          permissionLevel: (id: string) => world.packLevels.get(id),
        } satisfies RepositoryPack;
      },
      canModifySettings: (id) => world.settingsEditors.has(id),
      createPack: async () => { throw new Error('The session store must never create a pack.'); },
      makeId: () => `request-${++world.nextId}`,
      rpc: (event, request) => world.dispatch(event, request, userId),
    };
  }

  private async dispatch(
    event: RepositoryRpcEvent,
    request: Record<string, unknown>,
    userId: string
  ): Promise<unknown> {
    assert.equal(event, 'modifyDocument');
    const operation = request.operation as Record<string, unknown> | undefined;
    assert.equal(operation?.pack, PACK_COLLECTION);

    if (request.action === 'get' && request.type === 'JournalEntry') {
      this.reads += 1;
      const query = operation?.query as Record<string, unknown> | undefined;
      const matches = query?._id === undefined
        ? this.entries
        : this.entries.filter((entry) => entry._id === query._id);
      return { result: structuredClone(matches) };
    }

    if (request.action === 'create' && request.type === 'JournalEntryPage') {
      assert.equal(operation?.keepId, true);
      assert.equal(operation?.render, false);
      const parentUuid = String(operation?.parentUuid);
      assert.equal(parentUuid, `Compendium.${PACK_COLLECTION}.JournalEntry.${ROOT_ID}`);
      const root = this.entries.find((entry) => entry._id === ROOT_ID);
      assert.ok(root);
      const data = operation?.data;
      assert.ok(Array.isArray(data));
      assert.equal(data.length, 1);
      const item = data[0] as Record<string, unknown>;
      assert.equal(typeof item._id, 'string');
      if (root.pages.some((page) => page._id === item._id)) {
        throw new Error('Duplicate embedded page slot');
      }
      const page: FakePage = {
        _id: String(item._id),
        name: String(item.name),
        type: 'text',
        flags: structuredClone(item.flags as Record<string, unknown>),
        _stats: { lastModifiedBy: userId },
      };
      root.pages.push(page);
      this.writes += 1;
      if (this.loseNextAck) {
        this.loseNextAck = false;
        throw new Error('Acknowledgement lost after commit');
      }
      return { result: [{ _id: page._id }] };
    }

    throw new Error(`Unexpected fake operation ${String(request.type)} ${String(request.action)}`);
  }
}

function errorCode(code: SessionStoreError['code']) {
  return (error: unknown): boolean => error instanceof SessionStoreError && error.code === code;
}

function sessionFlags(page: FakePage): Record<string, unknown> {
  return page.flags[MODULE_ID] as Record<string, unknown>;
}

function addStoredPage(
  root: FakeEntry,
  options: { id?: string; index: number; version?: number; actor?: string; flags?: Record<string, unknown> }
): void {
  const { id = `s${options.index.toString(36).padStart(15, '0')}`, index, version = 1, actor = 'gm' } = options;
  root.pages.push({
    _id: id,
    name: `Session ${index}`,
    type: 'text',
    flags: {
      [MODULE_ID]: {
        role: 'session-control',
        recordVersion: version,
        index,
        previous: index - 1,
        requestId: `seed-${index}`,
        payload: { kind: 'acquire', sessionId: `seed-tab-${index}` },
        ...options.flags,
      },
    },
    _stats: { lastModifiedBy: actor },
  });
}


import { createOrchestrationStore } from '../src/integrations/foundry/orchestration-store.js';
test('same-root mixed history upgrades once and makes old clients reject before playback', async () => {
  const world = new FakeWorld();
  const legacy = createSessionStore(world.host());
  const old = await legacy.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const before = structuredClone(world.entries[0]!.pages);
  const store = createOrchestrationStore(world.host());
  const state = await store.append({ kind: 'upgrade', sessionId: 'gm-tab', generation: old.owner!.generation }, old.head);
  assert.equal(state.version, 2);
  assert.equal(state.rootId, ROOT_ID);
  assert.deepEqual(world.entries[0]!.pages.slice(0, before.length), before);
  assert.equal(sessionFlags(world.entries[0]!.pages[0]!).recordVersion, 1);
  assert.equal(sessionFlags(world.entries[0]!.pages[1]!).recordVersion, 2);
  await assert.rejects(() => legacy.read(), errorCode('SESSION_UNSUPPORTED'));
  assert.equal(world.entries.length, 1);
});

test('atomic server append and ambiguous acknowledgements retain one authoritative reservation', async () => {
  const world = new FakeWorld(); const store = createOrchestrationStore(world.host());
  let state = await store.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const owned = { sessionId: state.owner!.sessionId, generation: state.owner!.generation };
  world.loseNextAck = true;
  state = await store.append({ kind: 'upgrade', ...owned }, state.head);
  assert.equal(world.writes, 2);
  const snapshot = createBarsSequence('Queue', (() => { let n = 0; return () => `id-${++n}`; })());
  world.loseNextAck = true;
  state = await store.append({ kind: 'enqueue', ...owned, launchId: 'one', snapshot, userIds: ['player'] }, state.head);
  assert.equal(world.writes, 3);
  const second = createOrchestrationStore(world.host());
  const results = await Promise.allSettled([
    store.append({ kind: 'claim', ...owned, launchId: 'one', runId: 'run-one' }, state.head),
    second.append({ kind: 'claim', ...owned, launchId: 'one', runId: 'run-two' }, state.head)
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const failure = results.find(item => item.status === 'rejected') as PromiseRejectedResult;
  assert.equal((failure.reason as SessionStoreError).code, 'SESSION_CONFLICT');
  const confirmed = await store.read();
  assert.equal(confirmed.launches.length, 1);
  assert.equal(confirmed.launches[0]!.status, 'preparing');
  assert.equal(world.writes, 4);
});

test('current role or missing viewer blocks fresh preparation without corrupting frozen queued identities', async () => {
  const world = new FakeWorld(); const store = createOrchestrationStore(world.host());
  let state = await store.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const owned = { sessionId: state.owner!.sessionId, generation: state.owner!.generation };
  state = await store.append({ kind: 'upgrade', ...owned }, state.head);
  const snapshot = createBarsSequence('Queue', (() => { let n = 0; return () => `id-${++n}`; })());
  await assert.rejects(() => store.append({ kind: 'enqueue', ...owned, launchId: 'bad', snapshot, userIds: ['assistant'] }, state.head), errorCode('SESSION_PERMISSION_DENIED'));
  state = await store.append({ kind: 'enqueue', ...owned, launchId: 'one', snapshot, userIds: ['player', 'trusted'] }, state.head);
  state = await store.append({ kind: 'claim', ...owned, launchId: 'one', runId: 'run-one' }, state.head);
  world.users = world.users.map(user => user.id === 'trusted' ? { ...user, role: 3 } : user);
  world.packLevels.set('trusted', 'OWNER');
  const beforeWrites = world.writes;
  assert.deepEqual((await store.read()).launches[0]!.userIds, ['player', 'trusted']);
  const recipients = [{ userId: 'player', sessionId: 'player-tab' }, { userId: 'trusted', sessionId: 'trusted-tab' }];
  await assert.rejects(() => store.append({ kind: 'prepare', ...owned, runId: 'run-one', snapshot, recipients }, state.head), errorCode('SESSION_PERMISSION_DENIED'));
  assert.equal(world.writes, beforeWrites);
  world.users = world.users.filter(user => user.id !== 'trusted');
  await assert.rejects(() => store.append({ kind: 'prepare', ...owned, runId: 'run-one', snapshot, recipients }, state.head), errorCode('SESSION_INVALID'));
  assert.deepEqual((await store.read()).launches[0]!.userIds, ['player', 'trusted']);
  state = await store.append({ kind: 'fail', ...owned, launchId: 'one', runId: 'run-one', error: 'viewer unavailable' }, state.head);
  assert.equal(state.launches[0]!.status, 'failed');
});

test('replay preserves historical participant roles and returned projections are independent copies', async () => {
  const world = new FakeWorld(); const store = createOrchestrationStore(world.host());
  let state = await store.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const owned = { sessionId: state.owner!.sessionId, generation: state.owner!.generation };
  state = await store.append({ kind: 'upgrade', ...owned }, state.head);
  const snapshot = createBarsSequence('Queue', (() => { let n = 0; return () => `id-${++n}`; })());
  state = await store.append({ kind: 'enqueue', ...owned, launchId: 'one', snapshot, userIds: ['player'] }, state.head);
  state = await store.append({ kind: 'claim', ...owned, launchId: 'one', runId: 'run-one' }, state.head);
  state = await store.append({ kind: 'prepare', ...owned, runId: 'run-one', snapshot, recipients: [{ userId: 'player', sessionId: 'player-tab' }] }, state.head);
  state = await store.append({ kind: 'start', ...owned, runId: 'run-one', recipients: state.runs[0]!.recipients, atServerMs: 1000 }, state.head);
  world.users = world.users.map(user => user.id === 'player' ? { ...user, role: 3 } : user);
  world.packLevels.set('player', 'OWNER');
  const read = await store.read();
  assert.equal(read.runs[0]!.recipients[0]!.userId, 'player');
  (read.launches[0]!.userIds as string[]).push('forged');
  assert.deepEqual((await store.read()).launches[0]!.userIds, ['player']);
  state = await store.append({ kind: 'stop', ...owned, runId: 'run-one' }, state.head);
  assert.deepEqual(state.closedRuns, ['run-one']);
});

test('unsafe effective permissions, forged actor stamps and future records fail without a write', async () => {
  const unsafe = new FakeWorld(); unsafe.settingsEditors.add('player');
  await assert.rejects(() => createOrchestrationStore(unsafe.host()).append({ kind: 'acquire', sessionId: 'gm-tab' }, 0), errorCode('SESSION_PERMISSION_DENIED'));
  assert.equal(unsafe.writes, 0);
  const world = new FakeWorld(); addStoredPage(world.entries[0]!, { index: 1, actor: 'player' });
  await assert.rejects(() => createOrchestrationStore(world.host()).read(), errorCode('SESSION_CORRUPT'));
  const future = new FakeWorld(); addStoredPage(future.entries[0]!, { index: 1, version: 5 });
  await assert.rejects(() => createOrchestrationStore(future.host()).read(), errorCode('SESSION_UNSUPPORTED'));
});

test('unconfirmed writes are never automatically retried and exact request payloads govern reconciliation', async () => {
  const world = new FakeWorld();
  const native = world.host(); let attempted = 0;
  const store = createOrchestrationStore({ ...native, rpc: async (event, request) => {
    if (request.action === 'create') { attempted++; throw new Error('Disconnected before confirmation'); }
    return native.rpc(event, request);
  } });
  await assert.rejects(() => store.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0), errorCode('SESSION_STORAGE_FAILURE'));
  assert.equal(attempted, 1); assert.equal(world.writes, 0); assert.equal((await store.read()).head, 0);

  const changed = new FakeWorld(); const changedNative = changed.host();
  const tampered = createOrchestrationStore({ ...changedNative, rpc: async (event, request) => {
    const result = await changedNative.rpc(event, request);
    if (request.action === 'create') {
      sessionFlags(changed.entries[0]!.pages[0]!).payload = { kind: 'acquire', sessionId: 'other-tab' };
      throw new Error('Acknowledgement lost');
    }
    return result;
  } });
  await assert.rejects(() => tampered.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0), errorCode('SESSION_CONFLICT'));
  assert.equal(changed.writes, 1); assert.equal((await tampered.read()).owner!.sessionId, 'other-tab');
});

test('Record 3 upgrade preserves mixed history and automatic admission lost acknowledgement is reconciled once', async () => {
  const world = new FakeWorld(); const store = createOrchestrationStore(world.host());
  let state = await store.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const owned = { sessionId: state.owner!.sessionId, generation: state.owner!.generation };
  state = await store.append({ kind: 'upgrade', ...owned }, state.head);
  const history = structuredClone(world.entries[0]!.pages);
  world.loseNextAck = true; state = await store.append({ kind: 'upgrade3', ...owned }, state.head);
  assert.equal(state.version, 3); assert.equal(world.writes, 3);
  assert.deepEqual(world.entries[0]!.pages.slice(0, 2), history);
  assert.equal(sessionFlags(world.entries[0]!.pages[2]!).recordVersion, 3);
  const source = createBarsSequence('Automatic', (() => { let n = 0; return () => `id-${++n}`; })());
  const snapshot = { ...source, schemaVersion: 4 as const, playbackSchemaVersion: 1 as const,
    launch: { version: 2 as const, audience: { mode: 'selected' as const, userIds: ['player'], includeGM: false },
      automation: { version: 1 as const, enabled: true, rules: [{ id: 'rule', enabled: true, event: 'combat-start' as const, actorId: null }] } } };
  const event = { id: 'opaque-combat-event', kind: 'combat-start' as const, combatId: 'combat', round: 1, turn: 0, combatantId: null, actorId: null };
  world.loseNextAck = true;
  state = await store.append({ kind: 'enqueue', ...owned, launchId: 'automatic', snapshot, userIds: ['player'], mode: 'automatic', trigger: { event, ruleId: 'rule' } }, state.head);
  assert.equal(world.writes, 4); assert.equal(state.automaticAdmissions.length, 1);
  state = await store.append({ kind: 'cancel', ...owned, launchId: 'automatic' }, state.head);
  await assert.rejects(() => store.append({ kind: 'enqueue', ...owned, launchId: 'duplicate', snapshot, userIds: ['player'], mode: 'automatic', trigger: { event, ruleId: 'rule' } }, state.head), errorCode('SESSION_INVALID'));
  assert.equal(world.writes, 5); assert.equal((await store.read()).automaticAdmissions.length, 1);
  await assert.rejects(() => createSessionStore(world.host()).read(), errorCode('SESSION_UNSUPPORTED'));
});

test('competing browser acquisition commits one authenticated owner at the expected head', async () => {
  const world = new FakeWorld(); const first = createOrchestrationStore(world.host()); const second = createOrchestrationStore(world.host());
  const results = await Promise.allSettled([
    first.append({ kind: 'acquire', sessionId: 'first-tab' }, 0), second.append({ kind: 'acquire', sessionId: 'second-tab' }, 0)
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(world.writes, 1);
  const state = await first.read(); assert.equal(state.owner!.sessionId, 'first-tab');
  await assert.rejects(() => second.append({ kind: 'upgrade', sessionId: 'second-tab', generation: state.owner!.generation }, state.head), errorCode('SESSION_INVALID'));
  assert.equal(world.writes, 1);
});
