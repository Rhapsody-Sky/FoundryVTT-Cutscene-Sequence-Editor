import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestrationCoordinator, type OrchestrationCoordinatorHost } from '../src/application/orchestration-coordinator.js';
import { ManualPlaybackLauncher } from '../src/application/manual-playback-launcher.js';
import { withSequenceAudience } from '../src/domain/sequence-audience.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import type { PlaybackAnchor } from '../src/playback/local-player.js';
import { applyOrchestrationRecord, initialOrchestration, type OrchestrationCommand, type OrchestrationState } from '../src/playback/orchestration-protocol.js';
import { SESSION_TIMING } from '../src/playback/session-protocol.js';

function sequence(userIds: string[], durationMs = 1_000): SequenceV1 {
  return withSequenceAudience({ schemaVersion: 3, id: 'sequence', revision: 1, name: 'Sequence', composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: true, exitDurationMs: 250 },
    tracks: [{ id: 'track', name: 'Track', kind: 'visual', order: 0, enabled: true, locked: false }],
    clips: [{ id: 'bars', trackId: 'track', type: 'bars', typeVersion: 1, startMs: 0, duration: { kind: 'sequence-end' },
      entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 }, properties: { heightFraction: 0.1, color: '#000000' } }],
    end: { kind: 'manual', durationMs }, breaks: [{ id: 'hold', positionMs: 500 }] },
  { mode: 'selected', userIds, includeGM: false });
}
async function settle(): Promise<void> { for (let index = 0; index < 150; index++) await Promise.resolve(); }
class Clock {
  time = 0;
  private next = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();
  schedule(callback: () => void, delay: number): number { const id = ++this.next; this.timers.set(id, { due: this.time + delay, callback }); return id; }
  cancel(timer: unknown): void { this.timers.delete(timer as number); }
  async advance(milliseconds: number): Promise<void> {
    const target = this.time + milliseconds;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.due <= target).sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      this.time = next[1].due; this.timers.delete(next[0]); next[1].callback(); await settle();
    }
    this.time = target; await settle();
  }
}
class World {
  readonly clock = new Clock();
  state = initialOrchestration('root');
  readonly commands: OrchestrationCommand[] = [];
  readonly clients = new Map<string, Client>();
  readonly users = [{ id: 'gm', name: 'GM', role: 4, active: true },
    ...['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), role: 1, active: true }))];
  next = 0;
  dropQueries = false;
  create(userId: string, sessionId = `${userId}-tab`): Client { const client = new Client(this, userId, sessionId); this.clients.set(userId, client); return client; }
  id(): string { return `id-${++this.next}`; }
  append(actor: string, payload: OrchestrationCommand, head: number): OrchestrationState {
    this.state = applyOrchestrationRecord(this.state, { index: head + 1, previous: head, requestId: this.id(), actor,
      recordVersion: payload.kind === 'upgrade3' ? 3 : payload.kind === 'upgrade' ? 2 : this.state.version, payload }, id => this.users.some(user => user.id === id && user.role >= 3));
    this.commands.push(payload); return this.state;
  }
  async initialize(): Promise<Client> {
    const gm = this.create('gm'); this.create('a'); this.create('b'); this.create('c');
    for (const client of this.clients.values()) await client.coordinator.initialize(); return gm;
  }
  dispose(): void { for (const client of this.clients.values()) client.coordinator.dispose(); }
}
class Client {
  readonly coordinator: OrchestrationCoordinator;
  readonly starts: { sequence: SequenceV1; anchor: PlaybackAnchor }[] = [];
  readonly prepared: SequenceV1[] = [];
  readonly anchors: PlaybackAnchor[] = [];
  stops = 0;
  reads = 0;
  failReads = false;
  failWrites = false;
  nextRead: Promise<OrchestrationState> | null = null;
  readonly host: OrchestrationCoordinatorHost;
  constructor(world: World, userId: string, sessionId: string) {
    this.host = { userId, sessionId, isGM: userId === 'gm', users: () => world.users,
      store: { read: async () => { this.reads++; if (this.failReads) throw new Error('Ledger offline');
        if (this.nextRead) { const read = this.nextRead; this.nextRead = null; return read; } return world.state; },
      append: async (command, head) => { if (this.failWrites) throw new Error('Unconfirmed write'); return world.append(userId, command, head); } },
      now: () => world.clock.time + 10_000, monotonicNow: () => world.clock.time, makeId: () => world.id(),
      query: async (recipient, data) => { if (world.dropQueries) throw new Error('Query offline');
        const target = world.clients.get(recipient); if (!target) throw new Error('Absent'); return target.coordinator.handleQuery(data, userId); },
      playback: { prepare: async snapshot => { this.prepared.push(snapshot); }, start: async (snapshot, anchor) => { this.starts.push({ sequence: snapshot, anchor }); },
        applyAnchor: anchor => { this.anchors.push(anchor); }, stop: () => { this.stops++; } },
      schedule: (callback, delay) => world.clock.schedule(callback, delay), cancel: timer => world.clock.cancel(timer) };
    this.coordinator = new OrchestrationCoordinator(this.host);
  }
}

test('A can hold while B and C play, and stopping A preserves their surfaces and anchors', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const aRun = world.state.runs[0]!;
  await gm.coordinator.startReady(aRun.runId); await world.clock.advance(SESSION_TIMING.startLeadMs + 600);
  assert.equal(gm.coordinator.runs.find(view => view.run.runId === aRun.runId)!.phase, 'holding');
  await gm.coordinator.prepare(sequence(['b', 'c'])); await settle(); const otherRun = world.state.runs.find(run => run.runId !== aRun.runId)!;
  await gm.coordinator.startReady(otherRun.runId); await world.clock.advance(SESSION_TIMING.startLeadMs);
  assert.equal(world.clients.get('b')!.starts.length, 1); assert.equal(world.clients.get('c')!.starts.length, 1);
  const stops = world.clients.get('b')!.stops; const anchor = world.state.runs.find(run => run.runId === otherRun.runId);
  await gm.coordinator.stopGlobal(aRun.runId); await settle();
  assert.equal(world.state.runs.length, 1); assert.equal(world.state.runs[0], anchor);
  assert.equal(world.clients.get('b')!.stops, stops); assert.equal(gm.starts.length, 0);
  world.dispose();
});

test('overlapping launch waits atomically, C can pass, and B cannot overtake earlier A+B', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const first = world.state.runs[0]!;
  await gm.coordinator.prepare(sequence(['a', 'b'])); await gm.coordinator.prepare(sequence(['b'])); await gm.coordinator.prepare(sequence(['c'])); await settle();
  assert.equal(world.state.runs.length, 2); assert.deepEqual(gm.coordinator.queue.map(launch => launch.userIds), [['a', 'b'], ['b']]);
  await gm.coordinator.stopGlobal(first.runId); await settle();
  assert.equal(world.state.runs.length, 2); assert.deepEqual(gm.coordinator.queue.map(launch => launch.userIds), [['b']]);
  assert.deepEqual(world.state.runs.find(run => run.recipients.some(recipient => recipient.userId === 'a'))!.recipients.map(recipient => recipient.userId), ['a', 'b']);
  world.dispose();
});

test('a slow discovery does not block independent preparation or cancel; its late result cannot recreate a run', async () => {
  const world = new World(); const gm = await world.initialize(); const query = gm.host.query;
  let release!: (value: unknown) => void;
  gm.host.query = async (recipient, data, timeout) => recipient === 'a' && (data as { kind: string }).kind === 'discover'
    ? new Promise(resolve => { release = resolve; }) : query(recipient, data, timeout);
  await gm.coordinator.prepare(sequence(['a'])); await settle();
  await gm.coordinator.prepare(sequence(['b'])); await settle(); assert.equal(world.state.runs.length, 1);
  const launch = gm.coordinator.queue.find(entry => entry.userIds.includes('a'))!;
  await gm.coordinator.cancel(launch.launchId); release({ kind: 'discover', sessionId: 'a-tab', protocolVersion: 6 });
  await settle(); assert.equal(world.state.runs.length, 1); assert.equal(world.state.runs[0]!.recipients[0]!.userId, 'b');
  world.dispose();
});

test('exact transport 6 rejects old, missing, and future discovery before any participant Prepare command', async () => {
  for (const version of [undefined, 4, 5, 7]) {
    const world = new World(); const gm = await world.initialize();
    gm.host.query = async () => ({ kind: 'discover', sessionId: 'a-tab', ...(version === undefined ? {} : { protocolVersion: version }) });
    await gm.coordinator.prepare(sequence(['a'])); await settle();
    assert.equal(world.state.runs.length, 0); assert.equal(gm.coordinator.queue[0]!.status, 'failed');
    assert.equal(world.commands.some(command => command.kind === 'prepare'), false);
    assert.equal(world.clients.get('b')!.prepared.length, 0); world.dispose();
  }
});

test('local Escape retains the run and reservation; stop starts the waiting new run', async () => {
  const world = new World(); const gm = await world.initialize(); const a = world.clients.get('a')!;
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const run = world.state.runs[0]!;
  await gm.coordinator.startReady(run.runId); await world.clock.advance(SESSION_TIMING.startLeadMs);
  a.coordinator.exitLocal(); await gm.coordinator.prepare(sequence(['a'])); await settle();
  assert.equal(a.coordinator.status.phase, 'exited'); assert.equal(world.state.runs.length, 1); assert.equal(gm.coordinator.queue.length, 1);
  await gm.coordinator.stopGlobal(run.runId); await settle();
  assert.notEqual(world.state.runs[0]!.runId, run.runId); assert.equal(a.coordinator.status.phase, 'ready'); world.dispose();
});

test('reload and unauthenticated preparation hints cannot join an existing run', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const run = world.state.runs[0]!, owner = world.state.owner!;
  const old = world.clients.get('a')!; old.coordinator.dispose(); const reloaded = world.create('a', 'a-tab'); await reloaded.coordinator.initialize();
  const hint = { kind: 'prepare', targetSessionId: 'a-tab', ownerSessionId: owner.sessionId, generation: owner.generation,
    runId: run.runId, prepareRevision: run.prepareRevision, protocolVersion: 6 };
  assert.deepEqual(await reloaded.coordinator.handleQuery(hint, 'gm'), { kind: 'stale' });
  assert.deepEqual(await reloaded.coordinator.handleQuery(hint, 'b'), { kind: 'stale' });
  assert.equal(reloaded.prepared.length, 0); assert.equal(reloaded.starts.length, 0);
  await gm.coordinator.startReady(run.runId); await world.clock.advance(SESSION_TIMING.startLeadMs);
  assert.equal(reloaded.starts.length, 0); world.dispose();
});

test('controller loss releases local resources while retaining authoritative runs and queue', async () => {
  const world = new World(); const gm = await world.initialize(); const a = world.clients.get('a')!;
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const run = world.state.runs[0]!;
  await gm.coordinator.startReady(run.runId); await world.clock.advance(SESSION_TIMING.startLeadMs);
  await gm.coordinator.prepare(sequence(['a'])); const state = world.state;
  gm.failReads = true; a.failReads = true; world.dropQueries = true;
  await world.clock.advance(SESSION_TIMING.controllerTimeoutMs + 500);
  assert.equal(a.coordinator.status.canExit, false); assert.ok(a.stops > 0); assert.equal(world.state, state);
  gm.failReads = false; await gm.coordinator.refresh();
  await assert.rejects(gm.coordinator.stopGlobal(run.runId), { code: 'SESSION_CONTROLLER_LOST' });
  await gm.coordinator.revoke(); assert.equal(world.state.runs.length, 0); assert.equal(world.state.owner, null); world.dispose();
});

test('failed launch preserves FIFO while Retry creates a distinct attempt and Cancel releases ordering', async () => {
  const world = new World(); const gm = await world.initialize(); const original = gm.host.query;
  gm.host.query = async () => { throw new Error('Offline'); };
  await gm.coordinator.prepare(sequence(['a'])); await settle();
  const launch = gm.coordinator.queue[0]!; const oldId = world.state.closedRuns[0]!;
  await gm.coordinator.prepare(sequence(['a'])); await settle(); assert.equal(world.state.runs.length, 0);
  gm.host.query = original; await gm.coordinator.retry(launch.launchId); await settle();
  assert.equal(world.state.runs.length, 1); assert.notEqual(world.state.runs[0]!.runId, oldId);
  assert.equal(world.state.launches.find(entry => entry.launchId === launch.launchId)!.order, launch.order);
  await gm.coordinator.stopAll(); assert.equal(world.state.runs.length, 0); assert.equal(world.state.launches.length, 0); world.dispose();
});

test('all snapshots identities at enqueue, preserves timing/extensions, and never adds a later login', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle();
  world.users.find(user => user.id === 'c')!.active = false;
  const all = withSequenceAudience(sequence([]), { mode: 'all', userIds: [], includeGM: false });
  await gm.coordinator.prepare({ ...all, extension: { note: 'preserved' } } as SequenceV1);
  const queued = gm.coordinator.queue[0]!; assert.deepEqual(queued.userIds, ['a', 'b']); assert.equal(queued.snapshot.playbackSchemaVersion, 3);
  assert.deepEqual((queued.snapshot as unknown as { extension: unknown }).extension, { note: 'preserved' });
  world.users.find(user => user.id === 'c')!.active = true;
  await gm.coordinator.stopGlobal(world.state.runs[0]!.runId); await settle();
  assert.deepEqual(world.state.runs[0]!.recipients.map(recipient => recipient.userId), ['a', 'b']); world.dispose();
});

test('role changes reject new preparation/start and injected foreign roots or future states preserve current state', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const run = world.state.runs[0]!;
  world.users.find(user => user.id === 'gm')!.role = 1;
  await assert.rejects(gm.coordinator.startReady(run.runId), { code: 'SESSION_UNAUTHORIZED' });
  await assert.rejects(gm.coordinator.prepare(sequence(['b'])), { code: 'SESSION_UNAUTHORIZED' });
  world.users.find(user => user.id === 'gm')!.role = 4;
  const state = gm.coordinator.state;
  gm.nextRead = Promise.resolve({ ...world.state, rootId: 'foreign', head: world.state.head + 1 });
  await assert.rejects(gm.coordinator.refresh(), { code: 'SESSION_ROOT_CHANGED' }); assert.equal(gm.coordinator.state, state);
  gm.nextRead = Promise.resolve({ ...world.state, version: 5 } as unknown as OrchestrationState);
  await assert.rejects(gm.coordinator.refresh(), { code: 'SESSION_INVALID' }); assert.equal(gm.coordinator.state, state); world.dispose();
});

test('uncertain writes are not replayed and simultaneous hints share one parent read', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const run = world.state.runs[0]!;
  gm.failWrites = true; const writes = world.commands.length;
  await assert.rejects(gm.coordinator.startReady(run.runId), /Unconfirmed/); await settle(); assert.equal(world.commands.length, writes);
  gm.failWrites = false;
  let resolve!: (state: OrchestrationState) => void; gm.nextRead = new Promise(done => { resolve = done; });
  const reads = gm.reads; const first = gm.coordinator.refresh(); const second = gm.coordinator.refresh();
  assert.equal(first, second); assert.equal(gm.reads, reads + 1); resolve(world.state); await first;
  assert.equal(world.state.runs[0]!.phase, 'preparing'); world.dispose();
});

test('legacy active state blocks upgrade until explicit revoke and old commands remain readable', async () => {
  const world = new World();
  world.append('gm', { kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const owner = world.state.owner!;
  world.append('gm', { kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation, runId: 'legacy',
    snapshot: sequence(['a']), recipients: [{ userId: 'a', sessionId: 'a-tab' }] }, world.state.head);
  const gm = await world.initialize();
  await assert.rejects(gm.coordinator.prepare(sequence(['b'])), { code: 'SESSION_ACTIVE' });
  assert.equal(world.state.version, 1); assert.equal(world.state.runs[0]!.runId, 'legacy');
  await gm.coordinator.revoke(); await gm.coordinator.prepare(sequence(['b'])); await settle();
  assert.equal(world.state.version, 3); assert.equal(world.state.runs.length, 1); world.dispose();
});

test('ready manual launches can wait beyond preparation timeouts while an independent group plays', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const waiting = world.state.runs[0]!;
  await gm.coordinator.prepare(sequence(['b'])); await settle(); const playing = world.state.runs.find(run => run.runId !== waiting.runId)!;
  await gm.coordinator.startReady(playing.runId); await world.clock.advance(60_000);
  assert.equal(world.state.runs.length, 2); assert.equal(gm.coordinator.runs.find(view => view.run.runId === waiting.runId)!.phase, 'ready');
  assert.equal(world.state.launches.some(launch => launch.status === 'failed'), false);
  await gm.coordinator.startReady(waiting.runId); assert.equal(world.state.runs.find(run => run.runId === waiting.runId)!.phase, 'playing'); world.dispose();
});

test('a remote run final fade and stop cannot stop the GM surface owned by a different run', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(withSequenceAudience(sequence([]), { mode: 'selected', userIds: [], includeGM: true }));
  await settle(); const local = world.state.runs[0]!; await gm.coordinator.startReady(local.runId);
  await gm.coordinator.prepare(sequence(['b'])); await settle(); const remote = world.state.runs.find(run => run.runId !== local.runId)!;
  await gm.coordinator.startReady(remote.runId); await world.clock.advance(SESSION_TIMING.startLeadMs + 600);
  const stops = gm.stops; await gm.coordinator.fade(remote.runId); await world.clock.advance(250);
  assert.equal(world.state.runs.length, 1); assert.equal(world.state.runs[0]!.runId, local.runId);
  assert.equal(gm.stops, stops); assert.equal(gm.coordinator.status.phase, 'holding'); assert.equal(gm.coordinator.status.runId, local.runId); world.dispose();
});

test('Stop All closes waiting launches without claiming them while reservations are released', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await gm.coordinator.prepare(sequence(['b']));
  await gm.coordinator.prepare(sequence(['a'])); await gm.coordinator.prepare(sequence(['b', 'c'])); await settle();
  const claims = world.commands.filter(command => command.kind === 'claim').length;
  await gm.coordinator.stopAll(); await settle();
  assert.equal(world.state.runs.length, 0); assert.equal(world.state.launches.length, 0);
  assert.equal(world.commands.filter(command => command.kind === 'claim').length, claims); world.dispose();
});

test('Escape during media preparation retains reservation and late readiness cannot remount it', async () => {
  const world = new World(); const gm = await world.initialize(); const a = world.clients.get('a')!;
  let ready!: () => void;
  a.host.playback.prepare = async () => new Promise(resolve => { ready = resolve; });
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const run = world.state.runs[0]!;
  a.coordinator.exitLocal(); ready(); await settle(); await world.clock.advance(SESSION_TIMING.heartbeatMs);
  assert.equal(world.state.runs[0]!.runId, run.runId); assert.equal(world.state.launches[0]!.status, 'preparing');
  await gm.coordinator.prepare(sequence(['a'])); assert.equal(gm.coordinator.queue.length, 1);
  assert.equal(a.coordinator.status.phase, 'exited'); assert.equal(a.starts.length, 0); world.dispose();
});

test('Cancel aborts preparing media and a late Ready answer cannot recreate its run', async () => {
  const world = new World(); const gm = await world.initialize(); const a = world.clients.get('a')!;
  let ready!: () => void; let signal!: AbortSignal;
  a.host.playback.prepare = async (_snapshot, abort) => { signal = abort; return new Promise(resolve => { ready = resolve; }); };
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const run = world.state.runs[0]!; const launch = world.state.launches[0]!;
  await gm.coordinator.cancel(launch.launchId); await a.coordinator.refresh(); await settle();
  assert.equal(signal.aborted, true); ready(); await settle();
  assert.equal(world.state.runs.length, 0); assert.equal(a.starts.length, 0);
  assert.equal(world.state.closedRuns.includes(run.runId), true); world.dispose();
});

test('stale explicit run controls cannot affect a new run after queued commands stop the first', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const first = world.state.runs[0]!;
  await gm.coordinator.prepare(sequence(['a']));
  const stopping = gm.coordinator.stopGlobal(first.runId);
  const stale = gm.coordinator.startReady(first.runId); const rejected = assert.rejects(stale, { code: 'SESSION_CONFLICT' });
  await stopping; await rejected; await settle();
  assert.notEqual(world.state.runs[0]!.runId, first.runId); assert.equal(world.state.runs[0]!.phase, 'preparing'); world.dispose();
});

test('the real manual launcher admits independent B and allows cancellation while A discovery remains pending', async () => {
  const world = new World(); const gm = await world.initialize(); const query = gm.host.query;
  let release!: (value: unknown) => void;
  gm.host.query = async (recipient, data, timeout) => recipient === 'a' && (data as { kind: string }).kind === 'discover'
    ? new Promise(resolve => { release = resolve; }) : query(recipient, data, timeout);
  let dialogs = 0;
  const launcher = new ManualPlaybackLauncher({ chooseAudience: async () => ({ mode: 'selected', userIds: [++dialogs === 1 ? 'a' : 'b'], includeGM: false }),
    prepare: snapshot => gm.coordinator.prepare(snapshot) });
  assert.equal(await launcher.prepare(sequence([])), true);
  assert.equal(await launcher.prepare(sequence([])), true); await settle();
  assert.equal(dialogs, 2); assert.equal(world.state.runs[0]!.recipients[0]!.userId, 'b');
  const pending = gm.coordinator.queue.find(launch => launch.userIds.includes('a'))!;
  await gm.coordinator.cancel(pending.launchId); release({ kind: 'discover', sessionId: 'a-tab', protocolVersion: 6 }); await settle();
  assert.equal(world.state.runs.length, 1); assert.equal(gm.coordinator.queue.length, 0); world.dispose();
});

test('empty and oversized media failure messages create valid failed launches with no reservation', async () => {
  for (const message of ['', 'x'.repeat(5_000)]) {
    const world = new World(); const gm = await world.initialize(); const a = world.clients.get('a')!;
    a.host.playback.prepare = async () => { throw new Error(message); };
    await gm.coordinator.prepare(sequence(['a'])); await settle(); await world.clock.advance(SESSION_TIMING.heartbeatMs);
    assert.equal(world.state.runs.length, 0);
    assert.equal(world.state.launches[0]!.status, 'failed'); assert.ok(world.state.launches[0]!.error!.length > 0);
    assert.ok(world.state.launches[0]!.error!.length <= 2_000); world.dispose();
  }
});

test('injected malformed reservations are rejected before projection and valid injected states are immutable', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle(); const state = gm.coordinator.state!;
  gm.nextRead = Promise.resolve({ ...state, head: state.head + 1, launches: [...state.launches, { ...state.launches[0]!, launchId: 'forged', order: state.head + 1 }] });
  await assert.rejects(gm.coordinator.refresh(), { code: 'SESSION_INVALID' }); assert.equal(gm.coordinator.state, state);
  const copy = JSON.parse(JSON.stringify({ ...world.state, head: world.state.head + 1 })) as OrchestrationState;
  gm.nextRead = Promise.resolve(copy); await gm.coordinator.refresh();
  assert.equal(Object.isFrozen(gm.coordinator.state), true); assert.equal(Object.isFrozen(gm.coordinator.state!.runs[0]!.snapshot), true); world.dispose();
});

test('rejected and ambiguous claims are never autonomously retried by microtasks or polling', async () => {
  for (const committed of [false, true]) {
    const world = new World(); const gm = await world.initialize(); const append = gm.host.store.append;
    let attempts = 0;
    gm.host.store.append = async (command, head) => {
      if (command.kind !== 'claim') return append(command, head);
      attempts++; if (committed) await append(command, head); throw new Error('Claim outcome unconfirmed');
    };
    await assert.rejects(gm.coordinator.prepare(sequence(['a'])), /Claim outcome unconfirmed/);
    await settle(); await gm.coordinator.refresh(); await world.clock.advance(5_000); await settle();
    assert.equal(attempts, 1); assert.equal(world.state.runs.length, 0);
    assert.equal(world.state.launches[0]!.status, committed ? 'preparing' : 'waiting');
    assert.equal(world.clients.get('a')!.prepared.length, 0);
    gm.host.store.append = append; await gm.coordinator.cancel(world.state.launches[0]!.launchId);
    assert.equal(world.state.launches.length, 0); world.dispose();
  }
});

test('restoring even the same GM nonce never mounts or automatically closes past runs', async () => {
  const world = new World(); const original = await world.initialize();
  const fixed = sequence(['a']);
  await original.coordinator.prepare({ ...fixed, breaks: [], end: { kind: 'fixed', durationMs: 1_000 } }); await settle();
  const run = world.state.runs[0]!; await original.coordinator.startReady(run.runId);
  original.coordinator.dispose(); const gm = world.create('gm', 'gm-tab'); await gm.coordinator.initialize();
  const confirmed = world.state;
  await world.clock.advance(SESSION_TIMING.startLeadMs + 500);
  // Explicit Pause creates a control child and arms its inherited end timer. Resume is also explicit.
  await gm.coordinator.pause(run.runId); await gm.coordinator.resume(run.runId);
  const resumed = world.state;
  await world.clock.advance(2_000);
  assert.notEqual(world.state, confirmed); assert.equal(world.state, resumed);
  assert.equal(world.state.runs[0]!.runId, run.runId); assert.equal(gm.starts.length, 0); assert.equal(gm.prepared.length, 0);
  await gm.coordinator.stopGlobal(run.runId); assert.equal(world.state.runs.length, 0); world.dispose();
});

test('a preexisting claimed attempt stays protected when its old Prepare RPC commits after restoration', async () => {
  const world = new World(); const original = await world.initialize(); original.coordinator.dispose();
  world.append('gm', { kind: 'acquire', sessionId: 'gm-tab' }, world.state.head);
  const owner = world.state.owner!;
  const owned = { sessionId: owner.sessionId, generation: owner.generation };
  world.append('gm', { kind: 'upgrade', ...owned }, world.state.head);
  const snapshot = sequence(['a']);
  world.append('gm', { kind: 'enqueue', ...owned, launchId: 'old-launch', snapshot, userIds: ['a'] }, world.state.head);
  world.append('gm', { kind: 'claim', ...owned, launchId: 'old-launch', runId: 'old-attempt' }, world.state.head);
  const restored = world.create('gm', 'gm-tab'); await restored.coordinator.initialize();
  assert.equal(world.state.runs.length, 0);
  // This record represents an old RPC accepted after the replacement's initial read.
  world.append('gm', { kind: 'prepare', ...owned, runId: 'old-attempt', snapshot,
    recipients: [{ userId: 'a', sessionId: 'a-tab' }] }, world.state.head);
  const committed = world.state;
  await restored.coordinator.refresh(); await world.clock.advance(SESSION_TIMING.heartbeatMs * 2);
  assert.equal(world.state, committed); assert.equal(world.state.launches[0]!.status, 'preparing');
  assert.equal(restored.prepared.length, 0); assert.equal(restored.starts.length, 0);
  await restored.coordinator.stopGlobal('old-attempt'); assert.equal(world.state.runs.length, 0);
  world.dispose();
});

const event = { id: 'confirmed-update-1:turn-start', kind: 'turn-start' as const, combatId: 'combat', round: 1, turn: 0, combatantId: 'fighter', actorId: 'actor' };
function automated(userIds: string[]): SequenceV1 {
  const source = sequence(userIds);
  return { ...source, launch: { version: 2, audience: source.launch!.audience,
    automation: { version: 1, enabled: true, rules: [{ id: 'rule', enabled: true, event: 'turn-start', actorId: 'actor' }] } } };
}

test('combat-end waits for overlapping viewers then starts once for its fixed selected audience', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle();
  const existingRun = world.state.runs[0]!.runId;
  const source = automated(['a', 'b']);
  const ending: SequenceV1 = { ...source, launch: { version: 2, audience: source.launch!.audience,
    automation: { version: 1, enabled: true, rules: [{ id: 'end-rule', enabled: true, event: 'combat-end', actorId: null }] } } };
  const ended = { ...event, id: 'v1:combat:101:delete:combat-end', kind: 'combat-end' as const };
  assert.equal(await gm.coordinator.prepareAutomatic(ending, ended, 'end-rule'), true);
  assert.equal(await gm.coordinator.prepareAutomatic(ending, ended, 'end-rule'), false);
  await settle();
  const queued = world.state.launches.find(item => item.mode === 'automatic')!;
  assert.equal(queued.status, 'waiting');
  assert.deepEqual(queued.userIds, ['a', 'b']);
  assert.equal(queued.trigger!.event.kind, 'combat-end');
  assert.equal(world.commands.filter(command => command.kind === 'start').length, 0);
  await gm.coordinator.stopGlobal(existingRun); await settle();
  assert.equal(world.state.runs.length, 1);
  assert.equal(world.state.runs[0]!.phase, 'playing');
  assert.deepEqual(world.state.runs[0]!.recipients.map(item => item.userId), ['a', 'b']);
  await world.clock.advance(SESSION_TIMING.startLeadMs + SESSION_TIMING.heartbeatMs);
  assert.equal(world.clients.get('a')!.starts.length, 1);
  assert.equal(world.clients.get('b')!.starts.length, 1);
  assert.equal(world.clients.get('c')!.starts.length, 0);
  assert.equal(world.commands.filter(command => command.kind === 'start').length, 1);
  assert.equal(world.state.automaticAdmissions.length, 1);
  world.dispose();
});

test('automatic admission starts directly once every fixed viewer is ready, manual admission still waits', async () => {
  const world = new World(); const gm = await world.initialize();
  assert.equal(await gm.coordinator.prepareAutomatic(automated(['a', 'b']), event, 'rule'), true);
  await settle(); assert.equal(world.state.version, 3);
  const auto = world.state.runs[0]!; assert.equal(auto.phase, 'playing');
  assert.deepEqual(auto.recipients.map(item => item.userId), ['a', 'b']);
  assert.equal(world.commands.filter(command => command.kind === 'start').length, 1);
  await gm.coordinator.prepare(sequence(['c'])); await settle();
  assert.equal(world.state.runs.find(item => item.runId !== auto.runId)!.phase, 'preparing');
  await world.clock.advance(SESSION_TIMING.startLeadMs + SESSION_TIMING.heartbeatMs * 3);
  assert.equal(world.commands.filter(command => command.kind === 'start').length, 1);
  assert.equal(world.clients.get('a')!.starts.length, 1); assert.equal(world.clients.get('b')!.starts.length, 1); world.dispose();
});

test('automatic duplicate hooks after terminal completion or cancellation never re-admit, while future events do', async () => {
  const world = new World(); const gm = await world.initialize(); const snapshot = automated(['a']);
  const admitted = await Promise.all([gm.coordinator.prepareAutomatic(snapshot, event, 'rule'), gm.coordinator.prepareAutomatic(snapshot, event, 'rule')]);
  assert.deepEqual(admitted, [true, false]); await settle();
  const run = world.state.runs[0]!; await gm.coordinator.stopGlobal(run.runId);
  assert.equal(await gm.coordinator.prepareAutomatic(snapshot, event, 'rule'), false);
  assert.equal(await gm.coordinator.prepareAutomatic(snapshot, { ...event, id: 'future' }, 'rule'), true); await settle();
  assert.equal(world.state.automaticAdmissions.length, 2);
  await gm.coordinator.stopAll(); assert.equal(await gm.coordinator.prepareAutomatic(snapshot, { ...event, id: 'future' }, 'rule'), false);
  world.dispose();
});

test('automatic all audience and sequence are captured before asynchronous admission and queued unchanged', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle();
  const source = withSequenceAudience(automated([]), { mode: 'all', userIds: [], includeGM: false });
  const admitting = gm.coordinator.prepareAutomatic(source, event, 'rule');
  world.users.find(user => user.id === 'c')!.active = false;
  (source as { name: string }).name = 'edited-after-event';
  await admitting; const launch = world.state.launches.find(item => item.mode === 'automatic')!;
  assert.deepEqual(launch.userIds, ['a', 'b', 'c']); assert.equal(launch.snapshot.name, 'Sequence');
  assert.equal(launch.status, 'waiting');
  world.users.find(user => user.id === 'c')!.active = true;
  await gm.coordinator.stopGlobal(world.state.runs[0]!.runId); await settle();
  assert.deepEqual(world.state.runs[0]!.recipients.map(item => item.userId), ['a', 'b', 'c']);
  assert.equal(world.state.runs[0]!.phase, 'playing'); world.dispose();
});

test('slow automatic group stays preparing while an unrelated automatic group starts, and Retry uses a fresh attempt', async () => {
  const world = new World(); const gm = await world.initialize(); const a = world.clients.get('a')!;
  let ready!: () => void; a.host.playback.prepare = async () => new Promise(resolve => { ready = resolve; });
  await gm.coordinator.prepareAutomatic(automated(['a', 'b']), event, 'rule'); await settle();
  const slow = world.state.runs[0]!; assert.equal(slow.phase, 'preparing');
  await gm.coordinator.prepareAutomatic({ ...automated(['c']), id: 'other' }, event, 'rule'); await settle();
  assert.equal(world.state.runs.find(item => item.runId !== slow.runId)!.phase, 'playing');
  const launch = world.state.launches.find(item => item.runId === slow.runId)!;
  a.coordinator.playbackFailed(new Error('Media failed')); await world.clock.advance(SESSION_TIMING.heartbeatMs);
  assert.equal(world.state.launches.find(item => item.launchId === launch.launchId)!.status, 'failed');
  a.host.playback.prepare = async () => {}; await gm.coordinator.retry(launch.launchId); await settle();
  ready(); await settle();
  const retried = world.state.runs.find(item => item.recipients.some(recipient => recipient.userId === 'a'))!;
  assert.notEqual(retried.runId, slow.runId); assert.equal(retried.phase, 'playing');
  assert.equal(world.state.automaticAdmissions.length, 2); world.dispose();
});

test('automatic ownership never steals another GM tab and disabled rules never acquire a controller', async () => {
  const world = new World(); const gm = await world.initialize();
  assert.equal(await gm.coordinator.prepareAutomatic(sequence(['a']), event, 'rule'), false); assert.equal(world.state.owner, null);
  await gm.coordinator.prepareAutomatic(automated(['a']), event, 'rule'); await settle();
  const second = new Client(world, 'gm', 'other-gm-tab'); await second.coordinator.initialize();
  assert.equal(second.coordinator.canPrepareAutomatic, false);
  assert.equal(await second.coordinator.prepareAutomatic(automated(['b']), { ...event, id: 'second' }, 'rule'), false);
  assert.equal(second.coordinator.lastError, null); assert.equal(world.state.owner!.sessionId, gm.host.sessionId);
  second.coordinator.dispose(); world.dispose();
});

test('reloaded same nonce neither adopts ready automatic runs nor starts old waiting launches when a new event arrives', async () => {
  const world = new World(); const original = await world.initialize();
  const a = world.clients.get('a')!; let ready!: () => void;
  a.host.playback.prepare = async () => new Promise(resolve => { ready = resolve; });
  await original.coordinator.prepareAutomatic(automated(['a']), event, 'rule'); await settle();
  const run = world.state.runs[0]!;
  await original.coordinator.prepareAutomatic(automated(['a']), { ...event, id: 'waiting' }, 'rule');
  const waiting = world.state.launches.find(item => item.status === 'waiting')!;
  original.coordinator.dispose(); const restored = world.create('gm', 'gm-tab'); await restored.coordinator.initialize();
  ready(); await settle(); await world.clock.advance(SESSION_TIMING.heartbeatMs * 2);
  assert.equal(world.state.runs.find(item => item.runId === run.runId)!.phase, 'preparing');
  await restored.coordinator.prepareAutomatic({ ...automated(['b']), id: 'future-sequence' }, { ...event, id: 'future' }, 'rule'); await settle();
  assert.equal(world.state.runs.find(item => item.runId !== run.runId)!.phase, 'playing');
  await restored.coordinator.stopGlobal(run.runId); await settle();
  assert.equal(world.state.launches.find(item => item.launchId === waiting.launchId)!.status, 'waiting');
  assert.equal(restored.prepared.length, 0); world.dispose();
});

test('old participant capability and missing selected viewers fail automatic attempts without partial starts', async () => {
  for (const mode of ['old', 'offline'] as const) {
    const world = new World(); const gm = await world.initialize(); const query = gm.host.query;
    gm.host.query = async (id, data, timeout) => id === 'b' && (data as { kind: string }).kind === 'discover'
      ? mode === 'old' ? { kind: 'discover', sessionId: 'b-tab', protocolVersion: 5 } : Promise.reject(new Error('Offline'))
      : query(id, data, timeout);
    await gm.coordinator.prepareAutomatic(automated(['a', 'b']), event, 'rule'); await settle();
    assert.equal(world.state.runs.length, 0); assert.equal(world.state.launches[0]!.status, 'failed');
    assert.equal(world.commands.filter(command => command.kind === 'start').length, 0);
    assert.equal(world.clients.get('a')!.starts.length, 0); world.dispose();
  }
});

test('simultaneous automatic events from two GM tabs acquire once and the losing tab stays quiet', async () => {
  const world = new World(); const gm = await world.initialize();
  const other = new Client(world, 'gm', 'competing-tab'); await other.coordinator.initialize();
  const results = await Promise.all([
    gm.coordinator.prepareAutomatic(automated(['a']), event, 'rule'), other.coordinator.prepareAutomatic(automated(['a']), event, 'rule')
  ]); await settle();
  assert.deepEqual(results, [true, false]); assert.equal(other.coordinator.lastError, null);
  assert.equal(world.commands.filter(command => command.kind === 'acquire').length, 1);
  assert.equal(world.state.automaticAdmissions.length, 1); assert.equal(world.state.runs[0]!.phase, 'playing');
  other.coordinator.dispose(); world.dispose();
});

test('an unconfirmed automatic Start is never replayed by Ready reports or polling', async () => {
  for (const committed of [false, true]) {
    const world = new World(); const gm = await world.initialize(); const append = gm.host.store.append;
    let attempts = 0;
    gm.host.store.append = async (command, head) => {
      if (command.kind !== 'start') return append(command, head);
      attempts++; if (committed) await append(command, head); throw new Error('Start acknowledgement unconfirmed');
    };
    await gm.coordinator.prepareAutomatic(automated(['a']), event, 'rule'); await settle();
    await gm.coordinator.refresh(); await world.clock.advance(SESSION_TIMING.heartbeatMs * 3);
    assert.equal(attempts, 1); assert.equal(world.state.runs[0]!.phase, committed ? 'playing' : 'preparing');
    assert.equal(world.state.automaticAdmissions.length, 1); world.dispose();
  }
});

test('Cancel or generation revoke during automatic media preflight prevents late Ready from starting', async () => {
  for (const action of ['cancel', 'revoke'] as const) {
    const world = new World(); const gm = await world.initialize(); const a = world.clients.get('a')!;
    let ready!: () => void; a.host.playback.prepare = async () => new Promise(resolve => { ready = resolve; });
    await gm.coordinator.prepareAutomatic(automated(['a']), event, 'rule'); await settle();
    if (action === 'cancel') await gm.coordinator.cancel(world.state.launches[0]!.launchId); else await gm.coordinator.revoke();
    await a.coordinator.refresh(); ready(); await settle(); await world.clock.advance(SESSION_TIMING.heartbeatMs);
    assert.equal(world.state.runs.length, 0); assert.equal(world.commands.filter(command => command.kind === 'start').length, 0);
    assert.equal(world.state.automaticAdmissions.length, 1); assert.equal(a.starts.length, 0); world.dispose();
  }
});

test('idle Record 2 viewers refresh the version boundary before accepting a fresh Transport 6 Prepare', async () => {
  const world = new World();
  world.append('gm', { kind: 'acquire', sessionId: 'gm-tab' }, 0);
  const owner = world.state.owner!; world.append('gm', { kind: 'upgrade', sessionId: owner.sessionId, generation: owner.generation }, world.state.head);
  const history = world.state; const gm = await world.initialize();
  await gm.coordinator.prepareAutomatic(automated(['a']), event, 'rule'); await settle();
  assert.equal(history.version, 2); assert.equal(world.state.version, 3); assert.equal(world.state.runs[0]!.phase, 'playing'); world.dispose();
});

test('one automatic intent binds a free controller once and permits multiple rules and concurrent future events', async () => {
  const world = new World(); const gm = await world.initialize(); const intent = gm.coordinator.captureAutomaticIntent()!;
  assert.equal(gm.coordinator.captureAutomaticIntent(), intent);
  const source = automated(['a']); const launch = source.launch!;
  assert.equal(launch.version, 2); if (launch.version !== 2) throw new Error('Expected automation');
  const rules = { ...source, launch: { ...launch, automation: { ...launch.automation, rules: [...launch.automation.rules,
    { id: 'second', enabled: true, event: 'turn-start' as const, actorId: null }] } } };
  const results = await Promise.all([
    gm.coordinator.prepareAutomatic(rules, event, 'rule', intent),
    gm.coordinator.prepareAutomatic(rules, event, 'second', intent),
    gm.coordinator.prepareAutomatic({ ...automated(['b']), id: 'next-sequence' }, { ...event, id: 'next-event' }, 'rule', gm.coordinator.captureAutomaticIntent()!)
  ]); await settle();
  assert.deepEqual(results, [true, true, true]);
  assert.equal(world.commands.filter(command => command.kind === 'acquire').length, 1);
  assert.equal(world.state.automaticAdmissions.length, 3); assert.equal(world.state.runs.length, 2);
  world.dispose();
});

test('captured event intent cannot reacquire after explicit revoke or same GM reacquisition', async () => {
  for (const reacquire of [false, true]) {
    const world = new World(); const gm = await world.initialize(); const intent = gm.coordinator.captureAutomaticIntent()!;
    await gm.coordinator.prepareAutomatic(automated(['a']), event, 'rule', intent); await settle();
    const epoch = world.state.authorityEpoch; await gm.coordinator.revoke();
    if (reacquire) { await gm.coordinator.prepare(sequence(['b'])); await settle(); }
    const commands = world.commands.length;
    assert.equal(await gm.coordinator.prepareAutomatic(automated(['c']), { ...event, id: 'stale-event' }, 'rule', intent), false);
    assert.equal(world.commands.length, commands); assert.ok(world.state.authorityEpoch > epoch);
    assert.equal(world.state.automaticAdmissions.length, 1);
    assert.equal(await gm.coordinator.prepareAutomatic(automated(['c']), { ...event, id: 'fresh-event' }, 'rule'), true);
    world.dispose();
  }
});

test('an acquire/revoke cycle during pending event refresh invalidates even a controller that is free again', async () => {
  const world = new World(); const gm = await world.initialize(); const intent = gm.coordinator.captureAutomaticIntent()!;
  let resolve!: (state: OrchestrationState) => void;
  gm.nextRead = new Promise(done => { resolve = done; });
  const preparing = gm.coordinator.prepareAutomatic(automated(['a']), event, 'rule', intent); await settle();
  world.append('gm', { kind: 'acquire', sessionId: 'temporary-tab' }, world.state.head);
  world.append('gm', { kind: 'revoke', generation: world.state.owner!.generation }, world.state.head);
  assert.equal(world.state.owner, null); resolve(world.state);
  assert.equal(await preparing, false); assert.equal(world.state.owner, null);
  assert.equal(world.state.automaticAdmissions.length, 0); assert.equal(gm.coordinator.lastError, null); world.dispose();
});

test('authority change before an automatic append confirmation prevents the remainder of the old batch', async () => {
  const world = new World(); const gm = await world.initialize(); const append = gm.host.store.append;
  const intent = gm.coordinator.captureAutomaticIntent()!;
  gm.host.store.append = async (command, head) => {
    const state = await append(command, head);
    if (command.kind === 'upgrade3') {
      world.append('gm', { kind: 'revoke', generation: state.owner!.generation }, world.state.head);
      return world.state;
    }
    return state;
  };
  assert.equal(await gm.coordinator.prepareAutomatic(automated(['a']), event, 'rule', intent), false);
  assert.equal(world.state.owner, null); assert.equal(world.state.automaticAdmissions.length, 0);
  assert.equal(world.commands.some(command => command.kind === 'enqueue'), false); world.dispose();
});

test('unconfirmed claims never replay on new automatic or manual admission, but explicit Retry resolves them', async () => {
  for (const committed of [false, true]) {
    for (const nextMode of ['automatic', 'manual'] as const) {
      const world = new World(); const gm = await world.initialize(); const append = gm.host.store.append;
      let oldLaunch = ''; let claimAttempts = 0;
      gm.host.store.append = async (command, head) => {
        if (command.kind === 'claim' && !oldLaunch) {
          oldLaunch = command.launchId; claimAttempts++;
          if (committed) await append(command, head);
          throw new Error('Unconfirmed reservation');
        }
        if (command.kind === 'claim' && command.launchId === oldLaunch) claimAttempts++;
        return append(command, head);
      };
      await assert.rejects(gm.coordinator.prepareAutomatic(automated(['a']), event, 'rule'), /Unconfirmed/);
      await gm.coordinator.refresh(); await settle();
      const oldAttempt = world.state.launches.find(item => item.launchId === oldLaunch)!.runId;
      assert.equal(gm.coordinator.queue.find(item => item.launchId === oldLaunch)!.status, 'failed');
      if (nextMode === 'manual') await gm.coordinator.prepare(sequence(['b']));
      else await gm.coordinator.prepareAutomatic({ ...automated(['b']), id: 'independent' }, { ...event, id: 'next-event' }, 'rule');
      await settle(); await world.clock.advance(SESSION_TIMING.heartbeatMs);
      assert.equal(claimAttempts, 1); assert.equal(world.state.runs.length, 1);
      await gm.coordinator.prepare(sequence(['a', 'c'])); await settle();
      assert.equal(claimAttempts, 1); assert.equal(world.state.runs.length, 1);
      await gm.coordinator.retry(oldLaunch); await settle();
      assert.equal(claimAttempts, 2); assert.equal(world.state.runs.length, 2);
      const retried = world.state.launches.find(item => item.launchId === oldLaunch)!;
      assert.equal(retried.mode, 'automatic'); assert.notEqual(retried.runId, oldAttempt);
      if (oldAttempt) assert.ok(world.state.closedRuns.includes(oldAttempt));
      world.dispose();
    }
  }
});
