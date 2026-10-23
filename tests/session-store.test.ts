import assert from 'node:assert/strict';
import test from 'node:test';
import { createBarsSequence } from '../src/domain/validation.js';
import { withSequenceAudience } from '../src/domain/sequence-audience.js';
import { sessionPlayback } from '../src/playback/session-protocol.js';
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

test('read ignores existing sequence-creation claims and parses the session ledger', async () => {
  const world = new FakeWorld();
  const root = world.entries[0];
  assert.ok(root);
  root.pages.push({
    _id: 'claim-page',
    name: 'Sequence creation claim',
    type: 'text',
    flags: { [MODULE_ID]: { role: 'sequence-creation-claim', schemaVersion: 99 } },
    _stats: { lastModifiedBy: 'gm' },
  });
  addStoredPage(root, { index: 1, actor: 'assistant' });

  const state = await createSessionStore(world.host('player')).read();
  assert.equal(state.rootId, ROOT_ID);
  assert.equal(state.head, 1);
  assert.equal(state.owner?.userId, 'assistant');
  assert.equal(state.owner?.generation, `${ROOT_ID}:1`);
  assert.equal(world.writes, 0);
});

test('the native actor stamp controls authorization even when a stored sender claim names a GM', async () => {
  const world = new FakeWorld();
  const root = world.entries[0];
  assert.ok(root);
  addStoredPage(root, { index: 1, actor: 'player', flags: { senderId: 'gm' } });

  await assert.rejects(createSessionStore(world.host()).read(), errorCode('SESSION_CORRUPT'));
});

test('missing pack and missing root are unavailable and never bootstrap authority storage', async () => {
  const missingPack = new FakeWorld();
  missingPack.packAvailable = false;
  await assert.rejects(createSessionStore(missingPack.host()).read(), errorCode('SESSION_UNAVAILABLE'));
  assert.equal(missingPack.reads, 0);
  assert.equal(missingPack.writes, 0);

  const missingRoot = new FakeWorld(false);
  await assert.rejects(createSessionStore(missingRoot.host()).read(), errorCode('SESSION_UNAVAILABLE'));
  assert.equal(missingRoot.writes, 0);
});

test('duplicate authority roots fail closed without choosing either root', async () => {
  const world = new FakeWorld();
  world.addRoot('second-root');

  await assert.rejects(createSessionStore(world.host()).read(), errorCode('SESSION_CORRUPT'));
  assert.equal(world.writes, 0);
});

test('unknown future session record versions fail closed', async () => {
  const world = new FakeWorld();
  const root = world.entries[0];
  assert.ok(root);
  addStoredPage(root, { index: 1, version: 2 });

  await assert.rejects(createSessionStore(world.host()).read(), errorCode('SESSION_UNSUPPORTED'));
  assert.equal(world.writes, 0);
});

test('players may read but cannot append, and Assistant writes use the native Assistant actor', async () => {
  const world = new FakeWorld();
  const playerStore = createSessionStore(world.host('player'));
  assert.equal((await playerStore.read()).head, 0);
  await assert.rejects(
    playerStore.append({ kind: 'acquire', sessionId: 'player-tab' }, 0),
    errorCode('SESSION_PERMISSION_DENIED')
  );
  assert.equal(world.writes, 0);

  const assistantState = await createSessionStore(world.host('assistant'))
    .append({ kind: 'acquire', sessionId: 'assistant-tab' }, 0);
  assert.equal(assistantState.owner?.userId, 'assistant');
  const root = world.entries[0];
  assert.ok(root);
  assert.equal(root.pages[0]?._stats.lastModifiedBy, 'assistant');
});

test('concurrent appends contend on the unique native slot and preserve the winner', async () => {
  const world = new FakeWorld();
  const storeA = createSessionStore(world.host('gm'));
  const storeB = createSessionStore(world.host('assistant'));
  const results = await Promise.allSettled([
    storeA.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0),
    storeB.append({ kind: 'acquire', sessionId: 'assistant-tab' }, 0),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof SessionStoreError);
  assert.equal(rejected.reason.code, 'SESSION_CONFLICT');
  assert.equal(world.writes, 1);
  const root = world.entries[0];
  assert.ok(root);
  assert.equal(root.pages.length, 1);
  assert.equal(sessionFlags(root.pages[0] as FakePage).index, 1);
});

test('a lost append acknowledgement reconciles by exact requestId without a retry', async () => {
  const world = new FakeWorld();
  world.loseNextAck = true;
  const state = await createSessionStore(world.host()).append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);

  assert.equal(state.head, 1);
  assert.equal(state.owner?.userId, 'gm');
  assert.equal(world.writes, 1);
  const root = world.entries[0];
  assert.ok(root);
  assert.equal(root.pages.length, 1);
});

test('a staged command from before revocation cannot be submitted at an old head', async () => {
  const world = new FakeWorld();
  const store = createSessionStore(world.host());
  const acquired = await store.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const generation = acquired.owner?.generation;
  assert.ok(generation);
  const revoked = await store.append({ kind: 'revoke', generation }, acquired.head);
  assert.equal(revoked.owner, null);
  const writesBeforeStaleIntent = world.writes;

  await assert.rejects(
    store.append({ kind: 'revoke', generation }, acquired.head),
    errorCode('SESSION_CONFLICT')
  );
  assert.equal(world.writes, writesBeforeStaleIntent);
});

test('the native ledger preserves break clocks through player reads and uncertain Continue acknowledgements', async () => {
  const world = new FakeWorld(), store = createSessionStore(world.host());
  let state = await store.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const owned = { sessionId: 'gm-tab', generation: state.owner!.generation, runId: 'run-break' };
  const base = createBarsSequence('Break', () => `sequence-${++world.nextId}`);
  const recipients = [{ userId: 'gm', sessionId: 'gm-tab' }, { userId: 'player', sessionId: 'player-tab' }];
  state = await store.append({ kind: 'prepare', ...owned, recipients,
    snapshot: { ...base, schemaVersion: 2, end: { kind: 'manual', durationMs: 1_000 } } }, state.head);
  state = await store.append({ kind: 'start', ...owned, recipients, atServerMs: 1_000 }, state.head);
  state = await store.append({ kind: 'pause', ...owned, positionMs: 1_000, atServerMs: 2_500,
    holdElapsedMs: 500, pausedFrom: 'holding' }, state.head);
  const playerStore = createSessionStore(world.host('player'));
  assert.deepEqual(sessionPlayback((await playerStore.read()).run!, 8_000),
    { phase: 'paused', positionMs: 1_000, holdElapsedMs: 500, pausedFrom: 'holding' });
  world.loseNextAck = true;
  state = await store.append({ kind: 'continue', ...owned, positionMs: 1_000, atServerMs: 8_000,
    durationMs: 250, holdElapsedMs: 500, exitFrom: 'paused-holding' }, state.head);
  assert.equal(world.writes, 5);
  assert.deepEqual((await playerStore.read()).run, state.run);
  assert.deepEqual(sessionPlayback(state.run!, 8_100),
    { phase: 'exiting', positionMs: 1_000, holdElapsedMs: 500, exitFrom: 'paused-holding' });
  state = await store.append({ kind: 'stop', ...owned }, state.head);
  assert.equal(state.run, null);
  assert.deepEqual((await playerStore.read()).closedRuns, ['run-break']);
});

test('a former audience member becoming a GM or being removed does not corrupt committed history', async () => {
  for (const change of ['promoted', 'removed']) {
    const world = new FakeWorld(), store = createSessionStore(world.host());
    let state = await store.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);
    const owned = { sessionId: 'gm-tab', generation: state.owner!.generation, runId: 'run-audience' };
    const snapshot = withSequenceAudience(createBarsSequence('Target', () => `sequence-${++world.nextId}`),
      { mode: 'selected', userIds: ['player'], includeGM: false });
    const recipients = [{ userId: 'player', sessionId: 'player-tab' }];
    state = await store.append({ kind: 'prepare', ...owned, snapshot, recipients }, state.head);
    state = await store.append({ kind: 'start', ...owned, recipients, atServerMs: 1_000 }, state.head);
    state = await store.append({ kind: 'stop', ...owned }, state.head);
    const storedHistory = structuredClone(world.entries);
    if (change === 'promoted') {
      world.users = world.users.map(user => user.id === 'player' ? { ...user, role: 3 } : user);
      world.packLevels.set('player', 'OWNER');
    }
    else world.users = world.users.filter(user => user.id !== 'player');
    const reloaded = createSessionStore(world.host());
    assert.deepEqual(await reloaded.read(), state);
    assert.deepEqual(world.entries, storedHistory);
    const revoked = await reloaded.append({ kind: 'revoke', generation: state.owner!.generation }, state.head);
    assert.equal(revoked.owner, null); assert.equal(revoked.head, state.head + 1);
    const acquired = await reloaded.append({ kind: 'acquire', sessionId: 'new-gm-tab' }, revoked.head);
    const next = await reloaded.append({ kind: 'prepare', sessionId: 'new-gm-tab', generation: acquired.owner!.generation,
      runId: 'next-audience', snapshot: withSequenceAudience(snapshot, { mode: 'selected', userIds: ['trusted'], includeGM: false }),
      recipients: [{ userId: 'trusted', sessionId: 'trusted-tab' }] }, acquired.head);
    assert.equal(next.run!.runId, 'next-audience');
    assert.deepEqual(next.closedRuns, ['run-audience']);
  }
});

test('current unrelated GM recipients are rejected at new admission before any ledger write', async () => {
  const world = new FakeWorld(), store = createSessionStore(world.host());
  let state = await store.append({ kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const owned = { sessionId: 'gm-tab', generation: state.owner!.generation, runId: 'run-audience' };
  const base = createBarsSequence('Target', () => `sequence-${++world.nextId}`);
  const selected = withSequenceAudience(base, { mode: 'selected', userIds: ['assistant'], includeGM: false });
  const writes = world.writes;
  await assert.rejects(store.append({ kind: 'prepare', ...owned, snapshot: selected,
    recipients: [{ userId: 'assistant', sessionId: 'assistant-tab' }] }, state.head), { code: 'SESSION_PERMISSION_DENIED' });
  assert.equal(world.writes, writes); assert.equal((await store.read()).run, null);
  const valid = withSequenceAudience(base, { mode: 'selected', userIds: ['player'], includeGM: false });
  const recipients = [{ userId: 'player', sessionId: 'player-tab' }];
  state = await store.append({ kind: 'prepare', ...owned, snapshot: valid, recipients }, state.head);
  const beforeStart = world.writes;
  world.users = world.users.map(user => user.id === 'player' ? { ...user, role: 3 } : user);
  await assert.rejects(store.append({ kind: 'start', ...owned, recipients, atServerMs: 1_000 }, state.head), { code: 'SESSION_PERMISSION_DENIED' });
  assert.equal(world.writes, beforeStart); assert.deepEqual(await store.read(), state);
});
