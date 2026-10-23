import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCoordinator, type CoordinatorHost } from '../src/application/session-coordinator.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import { withSequenceAudience } from '../src/domain/sequence-audience.js';
import type { PlaybackAnchor } from '../src/playback/local-player.js';
import { applySessionRecord, initialSession, sessionPlayback, SESSION_TIMING, type SessionCommand, type SessionState } from '../src/playback/session-protocol.js';

function sequence(durationMs?: number): SequenceV1 {
  return { schemaVersion: 1, id: 'sequence', revision: 1, name: 'Bars', composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: true, exitDurationMs: 250 },
    tracks: [{ id: 'track', name: 'Bars', kind: 'visual', order: 0, enabled: true, locked: false }],
    clips: [{ id: 'bars', trackId: 'track', type: 'bars', typeVersion: 1, startMs: 0,
      duration: { kind: 'sequence-end' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
      properties: { heightFraction: 0.1, color: '#000000' } }],
    end: durationMs === undefined ? { kind: 'manual' } : { kind: 'fixed', durationMs } };
}

function videoSequence(startMs: number, durationMs: number, exitDurationMs = 250): SequenceV1 {
  const base = sequence();
  return {
    ...base,
    name: 'Video',
    presentation: { ...base.presentation, exitDurationMs },
    clips: [...base.clips, {
      id: 'video', trackId: 'track', type: 'video', typeVersion: 1, startMs,
      duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
      properties: { source: { kind: 'foundry-file', path: 'videos/scene.webm' }, fit: 'contain', volume: 1, muted: true, durationMs }
    }],
    end: { kind: 'media', clipId: 'video' }
  };
}

function endBreakSequence(): SequenceV1 {
  return { ...sequence(), schemaVersion: 2, end: { kind: 'manual', durationMs: 1_000 } };
}

function innerBreakSequence(manual = true): SequenceV1 {
  return { ...sequence(3_000), schemaVersion: 3,
    end: manual ? { kind: 'manual', durationMs: 3_000 } : { kind: 'fixed', durationMs: 3_000 },
    breaks: [{ id: 'second', positionMs: 2_000 }, { id: 'first', positionMs: 500 }, { id: 'endpoint', positionMs: 3_000 }] };
}

test('group inner holds share chronological anchors, continue without fade, and stop only after the terminal fade', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(innerBreakSequence()); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_000);
  assert.equal(gm.coordinator.runPhase, 'holding'); assert.equal(player.coordinator.runPhase, 'holding');
  assert.equal(sessionPlayback(world.state.run!, gm.host.now()).breakId, 'first');
  assert.equal(world.commands.some(command => command.kind === 'stop'), false);
  const historyHead = world.state.head;
  const first = gm.coordinator.continueFromBreak();
  const duplicate = gm.coordinator.continueFromBreak();
  const rejected = assert.rejects(duplicate, error => ['SESSION_PHASE', 'SESSION_CONFLICT'].includes((error as { code: string }).code));
  await first; await rejected; await player.coordinator.refresh();
  assert.equal(world.state.head, historyHead + 1);
  assert.equal(world.state.run!.phase, 'playing'); assert.equal(player.anchors.at(-1)!.phase, 'playing');
  assert.deepEqual(player.anchors.at(-1)!.breakHistory, [{ id: 'first', positionMs: 500, elapsedMs: 500 }]);
  await world.clock.advance(2_000);
  assert.equal(sessionPlayback(world.state.run!, gm.host.now()).breakId, 'second');
  await gm.coordinator.continueFromBreak(); await player.coordinator.refresh();
  await world.clock.advance(1_000);
  assert.equal(gm.coordinator.runPhase, 'holding');
  assert.equal(sessionPlayback(world.state.run!, gm.host.now()).breakId, undefined);
  assert.equal(world.state.run!.breakHistory!.length, 2);
  await gm.coordinator.continueFromBreak(); await player.coordinator.refresh();
  assert.equal(player.anchors.at(-1)!.phase, 'exiting');
  await world.clock.advance(250);
  assert.equal(world.state.run, null);
  gm.coordinator.dispose(); player.coordinator.dispose();
});

test('ordinary pause freezes an inner hold, Resume returns to holding, and a local exit leaves GM Continue available', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(innerBreakSequence()); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 800);
  await gm.coordinator.pause(); await player.coordinator.refresh();
  assert.equal(player.anchors.at(-1)!.pausedFrom, 'holding');
  assert.equal(player.anchors.at(-1)!.breakId, 'first');
  await world.clock.advance(3_000);
  assert.equal(sessionPlayback(world.state.run!, gm.host.now()).holdElapsedMs, 300);
  await gm.coordinator.resume(); await player.coordinator.refresh();
  assert.equal(player.anchors.at(-1)!.phase, 'holding');
  await world.clock.advance(200);
  player.coordinator.exitLocal(); gm.coordinator.exitLocal();
  await gm.coordinator.continueFromBreak(); await player.coordinator.refresh();
  assert.equal(world.state.run!.breakHistory![0]!.elapsedMs, 500);
  assert.equal(gm.coordinator.status.phase, 'exited'); assert.equal(player.coordinator.status.phase, 'exited');
  assert.equal(player.starts.length, 1);
  const owner = world.create('other-gm'); await owner.coordinator.initialize();
  await assert.rejects(owner.coordinator.continueFromBreak(), { code: 'SESSION_NOT_OWNER' });
  await world.clock.advance(1_500);
  await gm.coordinator.fade();
  assert.equal(world.state.run!.breakId, 'second');
  assert.equal(world.state.run!.exitFrom, 'holding');
  assert.equal(player.coordinator.status.phase, 'exited');
  gm.coordinator.dispose(); player.coordinator.dispose(); owner.coordinator.dispose();
});

test('a delayed prepared client mounts the first unconsumed Break and reload cannot resurrect exited resources', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(innerBreakSequence(false));
  let release!: (state: SessionState) => void;
  player.nextRead = new Promise<SessionState>(resolve => { release = resolve; });
  const reading = player.coordinator.refresh();
  await gm.coordinator.startReady(); await world.clock.advance(SESSION_TIMING.startLeadMs + 6_000);
  assert.equal(player.starts.length, 0);
  release(world.state); await reading; await settle();
  assert.equal(player.starts[0]!.anchor.atMs, world.state.run!.atServerMs);
  assert.deepEqual(player.starts[0]!.anchor.breakHistory, []);
  assert.equal(player.coordinator.runPhase, 'holding');
  await gm.coordinator.continueFromBreak(); await player.coordinator.refresh();
  assert.equal(player.anchors.at(-1)!.breakHistory![0]!.elapsedMs, 5_500);
  player.coordinator.exitLocal();
  const reloaded = world.create('player', 'player-tab'); await reloaded.coordinator.initialize();
  assert.equal(reloaded.starts.length, 0); assert.equal(reloaded.coordinator.status.phase, 'exited');
  await world.clock.advance(1_500); await gm.coordinator.continueFromBreak();
  await world.clock.advance(1_250);
  assert.equal(world.state.run, null);
  gm.coordinator.dispose(); player.coordinator.dispose(); reloaded.coordinator.dispose();
});

test('schema 3 excludes old client capability responses and rejects unsupported hints without affecting legacy discovery', async () => {
  const { world, gm, player } = await setup();
  const query = gm.host.query;
  gm.host.query = async (recipient, data, timeout) => {
    const response = await query(recipient, data, timeout) as Record<string, unknown>;
    if (response.kind === 'discover') { const { protocolVersion, ...old } = response; return old; }
    return response;
  };
  await gm.coordinator.prepare(innerBreakSequence());
  assert.equal(world.state.run!.recipients.length, 1);
  assert.equal(gm.coordinator.participants.find(entry => entry.userId === 'player')?.status, 'missing');
  await gm.coordinator.stopGlobal();
  gm.host.query = query;
  await gm.coordinator.prepare(innerBreakSequence());
  const run = world.state.run!, owner = world.state.owner!;
  assert.deepEqual(await player.coordinator.handleQuery({ kind: 'heartbeat', ownerSessionId: owner.sessionId,
    generation: owner.generation, runId: run.runId, prepareRevision: run.prepareRevision, targetSessionId: player.sessionId }, 'gm'), { kind: 'unsupported' });
  gm.coordinator.dispose(); player.coordinator.dispose();
});

test('Pause before a scheduled zero Break remains ordinary until Resume immediately reaches the marker', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare({ ...innerBreakSequence(), breaks: [{ id: 'zero', positionMs: 0 }, { id: 'later', positionMs: 500 }] });
  await gm.coordinator.startReady();
  await gm.coordinator.pause(); await player.coordinator.refresh();
  assert.equal(world.state.run!.phase, 'paused');
  assert.equal(world.state.run!.pausedFrom, undefined);
  assert.equal(world.state.run!.positionMs, 0);
  assert.equal(world.state.run!.breakId, undefined);
  const persisted = JSON.parse(JSON.stringify(world.state));
  assert.equal(sessionPlayback(persisted.run, gm.host.now()).phase, 'paused');
  await assert.rejects(gm.coordinator.continueFromBreak(), { code: 'SESSION_PHASE' });
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_000);
  assert.equal(gm.coordinator.runPhase, 'paused');
  await gm.coordinator.resume(); await player.coordinator.refresh();
  assert.equal(gm.coordinator.runPhase, 'holding');
  assert.equal(sessionPlayback(world.state.run!, gm.host.now()).breakId, 'zero');
  assert.equal(sessionPlayback(world.state.run!, gm.host.now()).holdElapsedMs, 0);
  await gm.coordinator.continueFromBreak();
  assert.deepEqual(world.state.run!.breakHistory, [{ id: 'zero', positionMs: 0, elapsedMs: 0 }]);
  await world.clock.advance(500);
  assert.equal(sessionPlayback(world.state.run!, gm.host.now()).breakId, 'later');
  gm.coordinator.dispose(); player.coordinator.dispose();
});

test('global Fade terminates prestart zero and due inner/manual Breaks with the correct media origin', async () => {
  for (const origin of ['scheduled-zero', 'paused-zero', 'inner', 'terminal'] as const) {
    const { world, gm, player } = await setup();
    const breaks = origin === 'inner' ? [{ id: 'inner', positionMs: 500 }]
      : origin === 'terminal' ? [] : [{ id: 'zero', positionMs: 0 }];
    await gm.coordinator.prepare({ ...innerBreakSequence(), breaks }); await gm.coordinator.startReady();
    if (origin === 'paused-zero') await gm.coordinator.pause();
    if (origin === 'inner' || origin === 'terminal') {
      await world.clock.advance(SESSION_TIMING.startLeadMs + (origin === 'inner' ? 600 : 3_100));
    }
    await gm.coordinator.fade(); await player.coordinator.refresh();
    const restored = JSON.parse(JSON.stringify(world.state.run!));
    assert.equal(sessionPlayback(restored, gm.host.now()).phase, 'exiting');
    assert.equal(restored.exitFrom, origin === 'paused-zero' ? 'paused'
      : origin === 'scheduled-zero' ? undefined : 'holding');
    assert.equal(restored.holdElapsedMs, origin === 'inner' || origin === 'terminal' ? 100 : undefined);
    assert.equal(restored.breakId, origin === 'inner' ? 'inner' : undefined);
    await world.clock.advance(250);
    assert.equal(world.state.run, null);
    gm.coordinator.dispose(); player.coordinator.dispose();
  }
});

function deferred(): { readonly promise: Promise<void>; resolve(): void; reject(error: unknown): void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> { for (let index = 0; index < 30; index += 1) await Promise.resolve(); }

class Clock {
  time = 0;
  serverOffset = 10_000;
  private next = 0;
  readonly timers = new Map<number, { due: number; callback: () => void }>();
  schedule(callback: () => void, delay: number): number {
    const id = ++this.next;
    this.timers.set(id, { due: this.time + delay, callback });
    return id;
  }
  cancel(id: unknown): void { this.timers.delete(id as number); }
  async advance(milliseconds: number): Promise<void> {
    const target = this.time + milliseconds;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.time = next[1].due;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.time = target;
    await settle();
  }
}

class World {
  readonly clock = new Clock();
  state = initialSession('root');
  readonly commands: SessionCommand[] = [];
  readonly clients = new Map<string, Client>();
  readonly users = [
    { id: 'gm', name: 'Director', role: 4, active: true },
    { id: 'player', name: 'Player', role: 1, active: true },
    { id: 'other-gm', name: 'Observer', role: 4, active: true }
  ];
  dropQueries = false;
  private nextId = 0;
  create(userId: string, sessionId = `${userId}-tab`): Client {
    const client = new Client(this, userId, sessionId);
    this.clients.set(userId, client);
    return client;
  }
  append(userId: string, payload: SessionCommand, expectedHead: number): SessionState {
    this.state = applySessionRecord(this.state, { index: expectedHead + 1, previous: expectedHead,
      requestId: `request-${++this.nextId}`, actor: userId, payload }, id => this.users.some(user => user.id === id && user.role >= 3));
    this.commands.push(payload);
    return this.state;
  }
  id(): string { return `id-${++this.nextId}`; }
}

class Client {
  readonly coordinator: SessionCoordinator;
  readonly starts: { sequence: SequenceV1; anchor: PlaybackAnchor }[] = [];
  readonly anchors: PlaybackAnchor[] = [];
  stops = 0;
  changes = 0;
  readCount = 0;
  failReads = false;
  failWrites = false;
  nextRead: Promise<SessionState> | null = null;
  onChange: (() => void) | null = null;
  readonly host: CoordinatorHost;
  constructor(readonly world: World, readonly userId: string, readonly sessionId: string) {
    this.host = {
      userId, sessionId, isGM: world.users.some(user => user.id === userId && user.role >= 3),
      users: () => world.users,
      store: {
        read: async () => {
          this.readCount += 1;
          if (this.failReads) throw new Error('Ledger offline');
          if (this.nextRead) { const pending = this.nextRead; this.nextRead = null; return pending; }
          return world.state;
        },
        append: async (command, head) => {
          if (this.failWrites) throw new Error('Write unconfirmed');
          return world.append(userId, command, head);
        }
      },
      now: () => world.clock.time + world.clock.serverOffset,
      monotonicNow: () => world.clock.time,
      makeId: () => world.id(),
      query: async (recipient, data) => {
        if (world.dropQueries) throw new Error('Query offline');
        const target = world.clients.get(recipient);
        if (!target) throw new Error('Absent');
        return target.coordinator.handleQuery(data, userId);
      },
      playback: {
        start: async (snapshot, anchor) => { this.starts.push({ sequence: snapshot, anchor }); },
        applyAnchor: anchor => { this.anchors.push(anchor); },
        stop: () => { this.stops += 1; }
      },
      schedule: (callback, delay) => world.clock.schedule(callback, delay),
      cancel: timer => world.clock.cancel(timer),
      onChange: () => { this.changes += 1; this.onChange?.(); }
    };
    this.coordinator = new SessionCoordinator(this.host);
  }
}

async function setup(): Promise<{ world: World; gm: Client; player: Client }> {
  const world = new World();
  const gm = world.create('gm'); const player = world.create('player');
  await gm.coordinator.initialize(); await player.coordinator.initialize();
  return { world, gm, player };
}

test('selected playback prepares and mounts only the audience while the GM retains all controls', async () => {
  const { world, gm, player } = await setup();
  world.users.push({ id: 'b', name: 'Player B', role: 1, active: true });
  const b = world.create('b'); await b.coordinator.initialize();
  const preparations = { gm: 0, a: 0, b: 0 };
  gm.host.playback.prepare = async () => { preparations.gm++; };
  player.host.playback.prepare = async () => { preparations.a++; };
  b.host.playback.prepare = async () => { preparations.b++; };
  const snapshot = withSequenceAudience(innerBreakSequence(), { mode: 'selected', userIds: ['player'], includeGM: false });
  await gm.coordinator.prepare(snapshot); await settle();
  assert.deepEqual(preparations, { gm: 0, a: 1, b: 0 });
  assert.deepEqual(world.state.run!.recipients, [{ userId: 'player', sessionId: player.sessionId }]);
  assert.equal(gm.coordinator.status.isOwner, true); assert.equal(gm.coordinator.status.canExit, false);
  assert.equal(gm.coordinator.status.phase, 'idle');
  await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_050);
  assert.equal(gm.starts.length, 0); assert.equal(b.starts.length, 0); assert.equal(player.starts.length, 1);
  assert.equal(player.starts[0]!.sequence.presentation.blockInput, true);
  assert.equal(gm.coordinator.runPhase, 'holding');
  await gm.coordinator.pause(); assert.equal(world.state.run!.phase, 'paused');
  await gm.coordinator.resume(); assert.equal(gm.coordinator.runPhase, 'holding');
  await gm.coordinator.continueFromBreak(); assert.equal(gm.coordinator.runPhase, 'playing');
  await gm.coordinator.fade(); await player.coordinator.refresh(); await world.clock.advance(300);
  assert.equal(world.state.run, null); assert.equal(player.coordinator.status.canExit, false);
});

test('all-player audience excludes the GM explicitly and selected audience can include only the GM', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(withSequenceAudience(sequence(), { mode: 'all', userIds: [], includeGM: false }));
  assert.deepEqual(world.state.run!.recipients, [{ userId: 'player', sessionId: player.sessionId }]);
  await gm.coordinator.stopGlobal();
  await gm.coordinator.prepare(withSequenceAudience(sequence(), { mode: 'selected', userIds: [], includeGM: true }));
  assert.deepEqual(world.state.run!.recipients, [{ userId: 'gm', sessionId: gm.sessionId }]);
  await gm.coordinator.startReady(); await world.clock.advance(SESSION_TIMING.startLeadMs);
  assert.equal(gm.starts.length, 1); assert.equal(player.starts.length, 0);
});

test('empty, offline, removed, and promoted selections fail before preparation without fallback', async () => {
  for (const ids of [[], ['gone'], ['offline'], ['other-gm']]) {
    const { world, gm, player } = await setup();
    world.users.push({ id: 'offline', name: 'Disconnected', role: 1, active: false });
    await assert.rejects(gm.coordinator.prepare(withSequenceAudience(sequence(), { mode: 'selected', userIds: ids, includeGM: false })),
      { code: 'SESSION_NO_RECIPIENTS' });
    assert.equal(world.state.run, null); assert.equal(world.state.owner, null);
    assert.equal(world.commands.length, 0); assert.equal(gm.starts.length, 0); assert.equal(player.starts.length, 0);
    if (ids.length) assert.equal(gm.coordinator.participants[0]!.userId, ids[0]);
  }
});

test('available selected peers can start while offline and removed IDs remain visible', async () => {
  const { world, gm } = await setup();
  world.users.push({ id: 'offline', name: 'Disconnected', role: 2, active: false });
  await gm.coordinator.prepare(withSequenceAudience(sequence(), { mode: 'selected', userIds: ['player', 'offline', 'gone'], includeGM: false }));
  assert.deepEqual(world.state.run!.recipients.map(peer => peer.userId), ['player']);
  for (const [userId, error] of [['offline', 'SESSION_RECIPIENT_OFFLINE'], ['gone', 'SESSION_RECIPIENT_REMOVED']]) {
    assert.equal(gm.coordinator.participants.find(peer => peer.userId === userId)?.status, 'missing');
    assert.equal(gm.coordinator.participants.find(peer => peer.userId === userId)?.error, error);
  }
  await gm.coordinator.startReady();
  assert.deepEqual(world.state.run!.recipients.map(peer => peer.userId), ['player']);
});

test('selected old clients cannot be prepared, and protocol 4 is required for audience hints', async () => {
  const { world, gm, player } = await setup();
  const query = gm.host.query;
  gm.host.query = async (userId, data, timeout) => {
    const response = await query(userId, data, timeout) as Record<string, unknown>;
    return response.kind === 'discover' ? { ...response, protocolVersion: 3 } : response;
  };
  await assert.rejects(gm.coordinator.prepare(withSequenceAudience(sequence(), { mode: 'selected', userIds: ['player'], includeGM: false })),
    { code: 'SESSION_NO_RECIPIENTS' });
  assert.equal(world.state.run, null); assert.equal(player.starts.length, 0);
  gm.host.query = query;
  await gm.coordinator.prepare(withSequenceAudience(sequence(), { mode: 'selected', userIds: ['player'], includeGM: false }));
  const run = world.state.run!; const owner = world.state.owner!;
  const hint = { kind: 'prepare', protocolVersion: 3, ownerSessionId: owner.sessionId,
    generation: owner.generation, runId: run.runId, prepareRevision: run.prepareRevision, targetSessionId: player.sessionId };
  assert.deepEqual(await player.coordinator.handleQuery(hint, 'gm'), { kind: 'unsupported' });
  assert.equal((await player.coordinator.handleQuery({ ...hint, protocolVersion: 4 }, 'gm') as { kind: string }).kind, 'status');
});

test('legacy discovery permits absent capabilities but rejects explicitly unknown future versions', async () => {
  for (const version of [undefined, 3, 4, 5, 999]) {
    const { world, gm } = await setup();
    const query = gm.host.query;
    gm.host.query = async (userId, data, timeout) => {
      const response = await query(userId, data, timeout) as Record<string, unknown>;
      if (response.kind !== 'discover') return response;
      const { protocolVersion: _version, ...legacy } = response;
      return version === undefined ? legacy : { ...legacy, protocolVersion: version };
    };
    await gm.coordinator.prepare(sequence());
    assert.equal(world.state.run!.recipients.some(peer => peer.userId === 'player'), version === undefined || version === 3 || version === 4);
    assert.equal(gm.coordinator.participants.find(peer => peer.userId === 'player')!.status, version === 5 || version === 999 ? 'missing' : 'ready');
  }
});

test('targeted local exit leaves the held GM run intact and later reads do not remount it', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(withSequenceAudience(endBreakSequence(), { mode: 'selected', userIds: ['player'], includeGM: false }));
  await gm.coordinator.startReady(); await world.clock.advance(SESSION_TIMING.startLeadMs + 1_100);
  assert.equal(gm.coordinator.runPhase, 'holding');
  player.coordinator.exitLocal();
  assert.equal(player.coordinator.status.canExit, false); assert.equal(gm.coordinator.runPhase, 'holding');
  await assert.rejects(gm.coordinator.prepare(sequence()), { code: 'SESSION_ACTIVE' });
  await world.clock.advance(2_000);
  assert.equal(player.starts.length, 1); assert.equal(gm.coordinator.runPhase, 'holding');
  await gm.coordinator.continueFromBreak(); await world.clock.advance(300);
  assert.equal(world.state.run, null);
});

test('a pure controller still closes fixed endings and target changes cannot rewrite a running snapshot', async () => {
  const { world, gm, player } = await setup();
  const authored = withSequenceAudience(sequence(1_000), { mode: 'selected', userIds: ['player'], includeGM: false });
  await gm.coordinator.prepare(authored);
  const changed = withSequenceAudience(authored, { mode: 'selected', userIds: [], includeGM: true });
  assert.deepEqual(changed.launch!.audience.userIds, []);
  assert.deepEqual(world.state.run!.snapshot.launch!.audience.userIds, ['player']);
  await gm.coordinator.startReady(); await world.clock.advance(SESSION_TIMING.startLeadMs + 1_300);
  assert.equal(world.state.run, null); assert.equal(gm.starts.length, 0); assert.equal(player.starts.length, 1);
});

test('manual video runs stay active for every participant beyond media end until the GM fades', async () => {
  const { world, gm, player } = await setup();
  const source = videoSequence(0, 1_000);
  const held: SequenceV1 = {
    ...source, end: { kind: 'manual' },
    tracks: [...source.tracks, { ...source.tracks[0]!, id: 'video-track', order: 1 }],
    clips: source.clips.map(clip => clip.type === 'video' ? { ...clip, trackId: 'video-track' } : clip)
  };
  await gm.coordinator.prepare(held);
  await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 10_000);
  assert.equal(world.state.run?.phase, 'playing');
  assert.equal(gm.coordinator.status.phase, 'playing');
  assert.equal(player.coordinator.status.phase, 'playing');
  assert.equal(world.commands.some(command => command.kind === 'stop'), false);
  assert.equal(player.starts.length, 1);
  await gm.coordinator.pause(); await player.coordinator.refresh();
  assert.equal(player.coordinator.status.phase, 'paused');
  await gm.coordinator.resume(); await player.coordinator.refresh();
  assert.equal(player.coordinator.status.phase, 'playing');
  await gm.coordinator.fade(); await player.coordinator.refresh();
  assert.equal(world.state.run?.phase, 'exiting');
  await world.clock.advance(1_000);
  assert.equal(world.state.run, null);
  assert.equal(player.coordinator.status.canExit, false);
  assert.equal(world.commands.filter(command => command.kind === 'stop').length, 1);
  gm.coordinator.dispose(); player.coordinator.dispose();
});

test('looped video snapshots reach every participant without per-cycle start or end commands', async () => {
  const { world, gm, player } = await setup();
  const source = videoSequence(0, 8_000);
  const looping: SequenceV1 = {
    ...source, end: { kind: 'manual' },
    tracks: [...source.tracks, { ...source.tracks[0]!, id: 'video-track', order: 1 }],
    clips: source.clips.map(clip => clip.type === 'video' ? {
      ...clip, typeVersion: 3, trackId: 'video-track',
      properties: { ...clip.properties, loop: true, sourceRange: { inMs: 2_000, outMs: 4_000 } }
    } : clip)
  };
  await gm.coordinator.prepare(looping);
  await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 60_000);
  for (const client of [gm, player]) {
    assert.equal(client.coordinator.status.phase, 'playing');
    assert.equal(client.starts.length, 1);
    const video = client.starts[0]!.sequence.clips.find(clip => clip.type === 'video')!;
    assert.equal(video.typeVersion, 3);
    assert.equal(video.properties.loop, true);
    assert.deepEqual(video.properties.sourceRange, { inMs: 2_000, outMs: 4_000 });
    assert.ok(Object.isFrozen(video.properties));
  }
  assert.equal(world.commands.filter(command => command.kind === 'start').length, 1);
  assert.equal(world.commands.filter(command => command.kind === 'stop').length, 0);
  await gm.coordinator.stopGlobal(); await player.coordinator.refresh();
  assert.equal(world.state.run, null);
  assert.equal(player.coordinator.status.canExit, false);
  gm.coordinator.dispose(); player.coordinator.dispose();
});

test('preparation compiles without mounting and captures only discovered player sessions plus director', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence());
  assert.equal(gm.starts.length, 0); assert.equal(player.starts.length, 0);
  assert.equal(gm.coordinator.status.phase, 'ready'); assert.equal(player.coordinator.status.phase, 'ready');
  assert.deepEqual(world.state.run?.recipients, [
    { userId: 'gm', sessionId: 'gm-tab' }, { userId: 'player', sessionId: 'player-tab' }
  ]);
  assert.deepEqual(gm.coordinator.participants.map(item => [item.name, item.status]), [['Director', 'ready'], ['Player', 'ready']]);
  const saved = world.state.run!.snapshot;
  assert.ok(Object.isFrozen(saved));
});

test('slow media preparation stays nonblocking while polling and authenticated heartbeats keep the run alive', async () => {
  const { world, gm, player } = await setup();
  const gmMedia = deferred(); const playerMedia = deferred();
  let gmPrepareCalls = 0; let playerPrepareCalls = 0;
  gm.host.playback.prepare = () => { gmPrepareCalls += 1; return gmMedia.promise; };
  player.host.playback.prepare = () => { playerPrepareCalls += 1; return playerMedia.promise; };

  await gm.coordinator.prepare(sequence());
  assert.equal(gm.coordinator.status.phase, 'preparing');
  assert.equal(player.coordinator.status.phase, 'preparing');
  assert.equal(gm.coordinator.status.canExit, true);
  assert.equal(player.coordinator.status.canExit, true);
  await world.clock.advance(SESSION_TIMING.controllerTimeoutMs * 2);
  assert.equal(gm.coordinator.status.phase, 'preparing');
  assert.equal(player.coordinator.status.phase, 'preparing');
  assert.equal(player.coordinator.lastError, null);
  assert.equal(gmPrepareCalls, 1);
  assert.equal(playerPrepareCalls, 1);
  assert.equal(gm.coordinator.participants.find(peer => peer.userId === 'player')?.status, 'preparing');

  gmMedia.resolve(); playerMedia.resolve(); await settle();
  assert.equal(gm.coordinator.status.phase, 'ready');
  assert.equal(player.coordinator.status.phase, 'ready');
});

test('local exit aborts in-flight media preparation before stopping and ignores its late completion', async () => {
  const { gm, player } = await setup();
  const media = deferred(); const signals: AbortSignal[] = [];
  player.host.playback.prepare = (_snapshot, preparationSignal) => { signals.push(preparationSignal); return media.promise; };
  await gm.coordinator.prepare(sequence());
  assert.equal(player.coordinator.status.phase, 'preparing');
  const stopsBeforeExit = player.stops;
  player.coordinator.exitLocal();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(player.stops, stopsBeforeExit + 1);
  media.resolve(); await settle();
  assert.equal(player.coordinator.status.phase, 'exited');
  assert.equal(player.coordinator.participants.find(peer => peer.userId === 'player')?.status, 'exited');
});

test('global stop and revocation cancel preparations, and an old completion cannot affect a newer run', async () => {
  const { gm, player } = await setup();
  const first = deferred(); const second = deferred();
  const signals: AbortSignal[] = [];
  player.host.playback.prepare = (_snapshot, signal) => {
    signals.push(signal);
    return signals.length === 1 ? first.promise : second.promise;
  };

  await gm.coordinator.prepare(sequence());
  const firstRunId = gm.coordinator.state?.run?.runId;
  assert.equal(player.coordinator.status.phase, 'preparing');
  await gm.coordinator.stopGlobal();
  await player.coordinator.refresh();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(player.coordinator.status.phase, 'exited');

  await gm.coordinator.prepare(sequence(4_000));
  assert.notEqual(gm.coordinator.state?.run?.runId, firstRunId);
  assert.equal(signals.length, 2);
  assert.equal(signals[1]?.aborted, false);
  first.reject(new Error('Late metadata failure from the stopped run')); await settle();
  assert.equal(player.coordinator.status.phase, 'preparing');
  assert.equal(player.coordinator.status.runId, gm.coordinator.state?.run?.runId);
  assert.equal(player.coordinator.lastError, null);

  await gm.coordinator.revoke();
  await player.coordinator.refresh();
  assert.equal(signals[1]?.aborted, true);
  assert.equal(player.coordinator.status.phase, 'exited');
  second.resolve(); await settle();
  assert.equal(player.coordinator.status.phase, 'exited');
});

test('disposing a coordinator aborts pending media preparation and prevents readiness', async () => {
  const { gm, player } = await setup();
  const media = deferred(); const signals: AbortSignal[] = [];
  player.host.playback.prepare = (_snapshot, preparationSignal) => { signals.push(preparationSignal); return media.promise; };
  await gm.coordinator.prepare(sequence());
  const stopsBeforeDispose = player.stops;
  player.coordinator.dispose();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(player.stops, stopsBeforeDispose + 1);
  media.resolve(); await settle();
  assert.equal(player.coordinator.status.phase, 'exited');
});

test('preparation failures are reported and startReady selects only ready participants', async () => {
  const { world, gm, player } = await setup();
  const media = deferred();
  player.host.playback.prepare = () => media.promise;
  await gm.coordinator.prepare(sequence());
  media.reject(new Error('Video metadata could not be loaded')); await settle();
  assert.equal(player.coordinator.status.phase, 'failed');
  await world.clock.advance(SESSION_TIMING.heartbeatMs);
  assert.equal(gm.coordinator.participants.find(peer => peer.userId === 'player')?.status, 'failed');
  assert.match(gm.coordinator.participants.find(peer => peer.userId === 'player')?.error ?? '', /metadata/);

  await gm.coordinator.startReady();
  assert.deepEqual(world.state.run?.recipients, [{ userId: 'gm', sessionId: 'gm-tab' }]);
  assert.equal(player.starts.length, 0);
});

test('a GM that is still preparing can start ready players and its own pending preparation is disposed', async () => {
  const { world, gm, player } = await setup();
  const media = deferred(); const signals: AbortSignal[] = [];
  gm.host.playback.prepare = (_snapshot, preparationSignal) => { signals.push(preparationSignal); return media.promise; };
  await gm.coordinator.prepare(sequence());
  assert.equal(gm.coordinator.status.phase, 'preparing');
  assert.equal(player.coordinator.status.phase, 'ready');

  await gm.coordinator.startReady();
  assert.deepEqual(world.state.run?.recipients, [{ userId: 'player', sessionId: 'player-tab' }]);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(gm.coordinator.status.phase, 'exited');
  await world.clock.advance(SESSION_TIMING.startLeadMs);
  assert.equal(gm.starts.length, 0);
  assert.equal(player.starts.length, 1);
  media.resolve(); await settle();
  assert.equal(gm.coordinator.status.phase, 'exited');
});

test('local exit cancels a scheduled start and remains terminal through late polling and heartbeats', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady(); await player.coordinator.refresh();
  assert.equal(player.coordinator.status.phase, 'scheduled');
  player.coordinator.exitLocal();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 3_000);
  await player.coordinator.refresh();
  assert.equal(player.starts.length, 0); assert.equal(player.coordinator.status.phase, 'exited');
  assert.equal(world.state.run?.phase, 'playing');
});

test('new tabs and same-nonce reconstructed coordinators never join a previously started run', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  player.coordinator.dispose();
  const reload = world.create('player', 'new-tab');
  await reload.coordinator.initialize();
  const sameNonce = new Client(world, 'player', 'player-tab');
  await sameNonce.coordinator.initialize();
  await world.clock.advance(2_000);
  assert.equal(reload.starts.length, 0); assert.equal(sameNonce.starts.length, 0);
  assert.equal(reload.coordinator.status.phase, 'idle'); assert.equal(sameNonce.coordinator.status.phase, 'exited');
  assert.deepEqual(world.state.run?.recipients, [{ userId: 'gm', sessionId: 'gm-tab' }, { userId: 'player', sessionId: 'player-tab' }]);
});

test('read polling cannot substitute for authenticated controller heartbeats', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  world.dropQueries = true;
  await world.clock.advance(SESSION_TIMING.controllerTimeoutMs);
  assert.ok(player.readCount >= 7);
  assert.equal(player.coordinator.status.phase, 'exited');
  assert.equal((player.coordinator.lastError as { code?: string }).code, 'SESSION_CONTROLLER_LOST');
  assert.equal(gm.coordinator.status.phase, 'playing');
  world.dropQueries = false;
  await world.clock.advance(4_000);
  assert.equal(player.starts.length, 1); assert.equal(player.coordinator.status.phase, 'exited');
});

test('GM read failure releases locally at the monotonic deadline even if server wall time jumps', async () => {
  const { world, gm } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  await world.clock.advance(2_000);
  gm.failReads = true;
  world.clock.serverOffset -= 50_000;
  await world.clock.advance(SESSION_TIMING.controllerTimeoutMs);
  assert.equal(gm.coordinator.status.phase, 'exited');
  assert.equal(world.state.run?.phase, 'playing');
  assert.equal(world.commands.filter(command => command.kind === 'revoke').length, 0);
});

test('heartbeats use authenticated sender, owner generation, recipient session and preparation revision', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence());
  const run = world.state.run!; const owner = world.state.owner!;
  const query = { kind: 'heartbeat', runId: run.runId, ownerSessionId: owner.sessionId, generation: owner.generation,
    prepareRevision: run.prepareRevision, targetSessionId: player.sessionId, senderId: 'gm' };
  assert.deepEqual(await player.coordinator.handleQuery(query, 'player'), { kind: 'stale' });
  assert.deepEqual(await player.coordinator.handleQuery({ ...query, generation: 'old-generation' }, 'gm'), { kind: 'stale' });
  assert.deepEqual(await player.coordinator.handleQuery({ ...query, targetSessionId: 'other-tab' }, 'gm'), { kind: 'session-mismatch' });
  const response = await player.coordinator.handleQuery(query, 'gm') as Record<string, unknown>;
  assert.equal(response.status, 'ready'); assert.equal(response.runId, run.runId); assert.equal(response.sessionId, player.sessionId);
});

test('late older reads cannot overwrite a successful stop, and concurrent refreshes share a read', async () => {
  const { world, gm } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  const old = world.state;
  let resolve!: (state: SessionState) => void;
  gm.nextRead = new Promise<SessionState>(done => { resolve = done; });
  const beforeReads = gm.readCount;
  const read = gm.coordinator.refresh(); const sameRead = gm.coordinator.refresh();
  assert.equal(read, sameRead); assert.equal(gm.readCount, beforeReads + 1);
  await gm.coordinator.stopGlobal();
  const head = gm.coordinator.state!.head;
  resolve(old); await read;
  await world.clock.advance(3_000);
  assert.equal(gm.coordinator.state?.head, head); assert.equal(gm.coordinator.state?.run, null);
  assert.equal(gm.starts.length, 0);
});

test('global stop failure preserves confirmed ledger state while local exit remains available', async () => {
  const { world, gm } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady(); await world.clock.advance(2_000);
  const confirmed = gm.coordinator.state;
  gm.failWrites = true;
  await assert.rejects(gm.coordinator.stopGlobal(), /Write unconfirmed/);
  assert.equal(gm.coordinator.state, confirmed); assert.equal(world.state.run?.phase, 'playing');
  assert.equal(gm.coordinator.status.canExit, true);
  gm.coordinator.exitLocal(); assert.equal(gm.coordinator.status.phase, 'exited');
  await world.clock.advance(2_000); assert.equal(gm.starts.length, 1);
});

test('second GM is an observer until explicit revocation and a fresh preparation', async () => {
  const { world, gm } = await setup();
  await gm.coordinator.prepare(sequence());
  const observer = world.create('other-gm'); await observer.coordinator.initialize();
  await assert.rejects(observer.coordinator.prepare(sequence()), { code: 'SESSION_OWNED' });
  await assert.rejects(observer.coordinator.stopGlobal(), { code: 'SESSION_NOT_OWNER' });
  assert.equal(world.state.owner?.userId, 'gm');
  const oldRun = world.state.run!.runId;
  await observer.coordinator.revoke(); await gm.coordinator.refresh();
  assert.equal(gm.coordinator.status.phase, 'exited');
  await observer.coordinator.prepare(sequence());
  assert.equal(world.state.owner?.userId, 'other-gm'); assert.notEqual(world.state.run?.runId, oldRun);
  assert.ok(world.state.closedRuns.includes(oldRun));
});

test('pause, resume and fade apply shared anchors to the same mounted player', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady(); await world.clock.advance(2_000);
  await gm.coordinator.pause(); await player.coordinator.refresh();
  assert.equal(player.anchors.at(-1)?.phase, 'paused'); assert.equal(player.anchors.at(-1)?.positionMs, 500);
  await world.clock.advance(500);
  await gm.coordinator.resume(); await player.coordinator.refresh();
  assert.equal(player.anchors.at(-1)?.phase, 'playing'); assert.equal(player.anchors.at(-1)?.atMs, world.clock.time + world.clock.serverOffset);
  await gm.coordinator.fade(600); await player.coordinator.refresh();
  const anchor = player.anchors.at(-1)!;
  assert.equal(anchor.phase, 'exiting'); assert.equal(anchor.exitDurationMs, 600);
  await gm.coordinator.fade(900); assert.equal(world.state.run?.exitDurationMs, 600);
  assert.equal(player.starts.length, 1);
  await world.clock.advance(600);
  assert.equal(world.state.run, null); assert.equal(world.state.owner?.userId, 'gm');
});

test('natural fixed end appends exactly one global stop and retains ownership', async () => {
  const { world, gm } = await setup();
  await gm.coordinator.prepare(sequence(1_000)); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_250);
  assert.equal(world.state.run, null); assert.equal(world.state.owner?.userId, 'gm');
  await world.clock.advance(10_000);
  assert.equal(world.commands.filter(command => command.kind === 'stop').length, 1);
});

test('video end uses the compiled boundary and preserves the shared final fade without allowing a boundary pause', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(videoSequence(1_000, 3_000, 250));
  await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs);
  assert.equal(player.starts.length, 1);

  // The video starts at 1,000ms and ends at 4,000ms in sequence time.
  await world.clock.advance(4_000);
  assert.equal(world.state.run?.phase, 'playing');
  await assert.rejects(gm.coordinator.pause(), { code: 'SESSION_PHASE' });
  await assert.rejects(gm.coordinator.fade(5_000), { code: 'SESSION_PHASE' });
  assert.equal(world.commands.filter(command => command.kind === 'pause').length, 0);
  assert.equal(world.commands.filter(command => command.kind === 'fade').length, 0);

  await world.clock.advance(249);
  assert.equal(world.state.run?.phase, 'playing');
  await world.clock.advance(1);
  assert.equal(world.state.run, null);
  assert.equal(world.commands.filter(command => command.kind === 'stop').length, 1);
  await world.clock.advance(1_000);
  assert.equal(player.starts.length, 1);
});

test('exit from the preparing notification cannot become ready or mount later', async () => {
  const { world, gm, player } = await setup();
  player.onChange = () => { if (player.coordinator.status.phase === 'preparing') player.coordinator.exitLocal(); };
  await gm.coordinator.prepare(sequence());
  assert.equal(player.coordinator.status.phase, 'exited');
  await gm.coordinator.startReady();
  assert.deepEqual(world.state.run?.recipients, [{ userId: 'gm', sessionId: 'gm-tab' }]);
  await world.clock.advance(2_000); assert.equal(player.starts.length, 0);
});

test('dispose releases every timer idempotently', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady(); await player.coordinator.refresh();
  gm.coordinator.dispose(); player.coordinator.dispose();
  const stops = player.stops;
  player.coordinator.dispose(); assert.equal(player.stops, stops);
  assert.equal(world.clock.timers.size, 0);
  await world.clock.advance(20_000); assert.equal(player.starts.length, 0);
});

test('initial ledger failure still starts polling and a recovered read clears its transient error', async () => {
  const world = new World(); const gm = world.create('gm');
  gm.failReads = true;
  await assert.rejects(gm.coordinator.initialize(), /Ledger offline/);
  gm.failReads = false;
  await world.clock.advance(SESSION_TIMING.pollMs);
  assert.equal(gm.coordinator.state?.rootId, 'root'); assert.equal(gm.coordinator.lastError, null);
});

test('Assistant GM controls are authenticated and undiscovered players remain visibly missing', async () => {
  const world = new World(); world.users[0]!.role = 3;
  const gm = world.create('gm'); const player = world.create('player');
  world.users.push({ id: 'absent-player', name: 'Missing Peer', role: 2, active: true });
  await gm.coordinator.initialize(); await player.coordinator.initialize();
  await gm.coordinator.prepare(sequence());
  assert.equal(player.coordinator.status.phase, 'ready');
  assert.equal(gm.coordinator.participants.find(peer => peer.userId === 'absent-player')?.status, 'missing');
  assert.ok(!world.state.run?.recipients.some(peer => peer.userId === 'absent-player'));
  await gm.coordinator.startReady();
  assert.ok(!world.state.run?.recipients.some(peer => peer.userId === 'absent-player'));
});

test('ready clients may wait longer than the preparation timeout while their controller is alive', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence());
  await world.clock.advance(SESSION_TIMING.prepareTimeoutMs + 2_000);
  assert.equal(player.coordinator.status.phase, 'ready');
  await gm.coordinator.startReady();
  assert.equal(world.state.run?.recipients.length, 2);
});

test('a stalled read cannot overlap another poll or postpone controller release', async () => {
  const { world, gm } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  gm.nextRead = new Promise<SessionState>(() => {});
  const before = gm.readCount;
  await world.clock.advance(SESSION_TIMING.controllerTimeoutMs + 500);
  assert.equal(gm.readCount, before + 1);
  assert.equal(gm.coordinator.status.phase, 'exited');
  assert.equal(world.state.run?.phase, 'playing');
  gm.coordinator.dispose();
});

test('a canceled natural-end callback cannot stop a subsequently paused run even if host cancellation fails', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence(2_000)); await gm.coordinator.startReady();
  await world.clock.advance(2_000);
  gm.host.cancel = () => { throw new Error('Cannot cancel host timer'); };
  await gm.coordinator.pause(); await player.coordinator.refresh();
  await world.clock.advance(3_000);
  assert.equal(world.state.run?.phase, 'paused');
  assert.equal(world.commands.filter(command => command.kind === 'stop').length, 0);
});

test('a fresh run after a long read outage uses the recovered read for its new deadline', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  await world.clock.advance(2_000);
  player.failReads = true;
  await world.clock.advance(SESSION_TIMING.controllerTimeoutMs + 1_000);
  assert.equal(player.coordinator.status.phase, 'exited');
  await gm.coordinator.stopGlobal();
  player.failReads = false;
  await gm.coordinator.prepare(sequence());
  assert.equal(player.coordinator.status.phase, 'ready');
  await gm.coordinator.startReady(); await world.clock.advance(2_000);
  assert.equal(player.coordinator.status.phase, 'playing'); assert.equal(player.starts.length, 2);
});

test('disposal during discovery prevents any later preparation append', async () => {
  const { world, gm } = await setup();
  let resolve!: (value: unknown) => void;
  gm.host.query = () => new Promise<unknown>(done => { resolve = done; });
  const preparing = gm.coordinator.prepare(sequence());
  await settle();
  assert.equal(world.state.owner?.userId, 'gm');
  gm.coordinator.dispose();
  resolve({ kind: 'discover', sessionId: 'player-tab', status: 'idle' });
  await assert.rejects(preparing, { code: 'SESSION_DISPOSED' });
  assert.equal(world.state.run, null);
  assert.equal(world.commands.filter(command => command.kind === 'prepare').length, 0);
});

test('pause and fade cannot resurrect a fixed sequence after its natural final fade began', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence(1_000)); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_100);
  await assert.rejects(gm.coordinator.pause(), { code: 'SESSION_PHASE' });
  await assert.rejects(gm.coordinator.fade(5_000), { code: 'SESSION_PHASE' });
  assert.equal(world.state.run?.phase, 'playing');
  await world.clock.advance(150);
  assert.equal(world.state.run, null); assert.equal(player.starts.length, 1);
});

test('later frame failures are terminal local reports without pretending to stop the group', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady(); await world.clock.advance(2_000);
  player.coordinator.playbackFailed(new Error('Surface failed on frame'));
  assert.equal(player.coordinator.status.phase, 'failed'); assert.equal(player.coordinator.status.canExit, false);
  assert.equal(world.state.run?.phase, 'playing');
  await world.clock.advance(4_000);
  assert.equal(gm.coordinator.participants.find(peer => peer.userId === 'player')?.status, 'failed');
  assert.equal(player.starts.length, 1); assert.equal(player.coordinator.status.phase, 'failed');
  await gm.coordinator.stopGlobal(); await gm.coordinator.prepare(sequence());
  assert.equal(player.coordinator.status.phase, 'ready');
  assert.equal(player.coordinator.lastError, null);
  assert.equal(gm.coordinator.participants.find(peer => peer.userId === 'player')?.error, undefined);
});

test('target preflight failures are reported before readiness without mounting an overlay', async () => {
  const { world, gm, player } = await setup();
  player.host.playback.validateTarget = () => { throw new Error('Canvas unavailable'); };
  await gm.coordinator.prepare(sequence());
  assert.equal(player.coordinator.status.phase, 'failed'); assert.equal(player.starts.length, 0);
  assert.equal(gm.coordinator.participants.find(peer => peer.userId === 'player')?.status, 'failed');
  await gm.coordinator.startReady();
  assert.deepEqual(world.state.run?.recipients, [{ userId: 'gm', sessionId: 'gm-tab' }]);
});

test('synchronous start failures release the client and remain visible as failed to the controller', async () => {
  const { world, gm, player } = await setup();
  player.host.playback.start = () => { throw new Error('Player cannot mount'); };
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs);
  assert.equal(player.coordinator.status.phase, 'failed');
  assert.equal(player.coordinator.status.canExit, false);
  assert.equal(player.stops, 1);
  assert.equal(world.state.run?.phase, 'playing');
  await world.clock.advance(4000);
  assert.equal(gm.coordinator.participants.find(peer => peer.userId === 'player')?.status, 'failed');
  assert.equal(player.starts.length, 0);
});

test('shared-anchor failures report a terminal media failure instead of a voluntary local exit', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs);
  player.host.playback.applyAnchor = () => { throw new Error('Shared anchor failed'); };
  await gm.coordinator.pause(); await player.coordinator.refresh();
  assert.equal(player.coordinator.status.phase, 'failed');
  assert.equal(player.coordinator.status.error, 'Shared anchor failed');
  assert.equal(player.stops, 1);
  assert.equal(world.state.run?.phase, 'paused');
  await world.clock.advance(4000);
  assert.equal(gm.coordinator.participants.find(peer => peer.userId === 'player')?.status, 'failed');
  assert.equal(player.starts.length, 1);
});

test('an automatic stop queued behind explicit stop and preparation cannot close the next run', async () => {
  const { world, gm } = await setup();
  await gm.coordinator.prepare(sequence(1_000)); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_249);
  let commit!: () => void;
  const append = gm.host.store.append;
  let delayed = false;
  gm.host.store.append = async (command, head) => {
    if (command.kind === 'stop' && !delayed) {
      delayed = true;
      return new Promise<SessionState>(resolve => { commit = () => { resolve(world.append('gm', command, head)); }; });
    }
    return append(command, head);
  };
  const stopping = gm.coordinator.stopGlobal();
  const preparing = gm.coordinator.prepare(sequence());
  await settle(); await world.clock.advance(1);
  commit(); await stopping; await preparing; await settle();
  assert.equal(world.state.run?.phase, 'preparing');
  assert.equal(world.commands.filter(command => command.kind === 'stop').length, 1);
});

test('an explicit old-run intent queued before a fresh preparation cannot affect the replacement run', async () => {
  const { world, gm } = await setup();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  const stopping = gm.coordinator.stopGlobal();
  const preparing = gm.coordinator.prepare(sequence());
  const oldStop = gm.coordinator.stopGlobal();
  const rejected = assert.rejects(oldStop, { code: 'SESSION_CONFLICT' });
  await stopping; await preparing; await rejected;
  assert.equal(world.state.run?.phase, 'preparing');
  assert.equal(world.commands.filter(command => command.kind === 'stop').length, 1);
});

test('shared end breaks become holding at the boundary with no endpoint records or automatic stop', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(endBreakSequence()); await gm.coordinator.startReady();
  const head = world.state.head;
  await world.clock.advance(SESSION_TIMING.startLeadMs + 999);
  assert.equal(gm.coordinator.status.phase, 'playing');
  await world.clock.advance(1);
  assert.equal(gm.coordinator.status.phase, 'holding');
  await player.coordinator.refresh();
  assert.equal(player.coordinator.status.phase, 'holding');
  assert.equal(gm.coordinator.runPhase, 'holding');
  for (const client of [gm, player]) {
    assert.equal(client.anchors.at(-1)?.phase, 'holding');
    assert.equal(client.anchors.at(-1)?.positionMs, 1_000);
    assert.equal(client.anchors.at(-1)?.holdElapsedMs, 0);
  }
  await world.clock.advance(20_000);
  assert.equal(world.state.head, head);
  assert.equal(world.state.run!.phase, 'playing');
  assert.equal(gm.coordinator.participants.find(participant => participant.userId === 'player')?.status, 'holding');
  assert.equal(player.coordinator.status.canExit, true);
  assert.equal(player.stops, 0);
  await gm.coordinator.continueFromBreak(); await player.coordinator.refresh();
  assert.equal(world.commands.at(-1)?.kind, 'continue');
  for (const client of [gm, player]) {
    assert.equal(client.anchors.at(-1)?.phase, 'exiting');
    assert.equal(client.anchors.at(-1)?.exitFrom, 'holding');
    assert.equal(client.anchors.at(-1)?.holdElapsedMs, 20_000);
  }
  await world.clock.advance(249);
  assert.equal(world.state.run!.phase, 'exiting');
  await world.clock.advance(1); await player.coordinator.refresh();
  assert.equal(world.state.run, null);
  assert.equal(world.commands.filter(command => command.kind === 'stop').length, 1);
  gm.coordinator.dispose(); player.coordinator.dispose();
});

test('group pause and resume preserve held clocks and Continue from a paused break keeps media frozen', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(endBreakSequence()); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_400);
  await gm.coordinator.pause(); await player.coordinator.refresh();
  assert.equal(world.state.run!.pausedFrom, 'holding');
  assert.equal(world.state.run!.holdElapsedMs, 400);
  for (const client of [gm, player]) {
    assert.equal(client.anchors.at(-1)?.phase, 'paused');
    assert.equal(client.anchors.at(-1)?.pausedFrom, 'holding');
  }
  await world.clock.advance(3_000);
  await gm.coordinator.resume(); await player.coordinator.refresh();
  assert.equal(world.state.run!.phase, 'holding');
  assert.equal(world.state.run!.holdElapsedMs, 400);
  assert.equal(player.anchors.at(-1)?.holdElapsedMs, 400);
  await world.clock.advance(600);
  await gm.coordinator.pause(); await player.coordinator.refresh();
  assert.equal(world.state.run!.holdElapsedMs, 1_000);
  await world.clock.advance(2_000);
  await gm.coordinator.continueFromBreak(); await player.coordinator.refresh();
  assert.equal(world.state.run!.exitFrom, 'paused-holding');
  assert.equal(world.state.run!.pausedFrom, undefined);
  assert.equal(player.anchors.at(-1)?.holdElapsedMs, 1_000);
  assert.equal(player.anchors.at(-1)?.exitFrom, 'paused-holding');
  await world.clock.advance(1_000);
  assert.equal(world.state.run, null);
  gm.coordinator.dispose(); player.coordinator.dispose();
});

test('a prepared participant that receives start after the boundary mounts the shared holding clock', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(endBreakSequence());
  let release!: (state: SessionState) => void;
  player.nextRead = new Promise<SessionState>(resolve => { release = resolve; });
  const reading = player.coordinator.refresh();
  await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_500);
  assert.equal(player.starts.length, 0);
  release(world.state); await reading; await settle();
  assert.equal(player.starts.length, 1);
  assert.deepEqual(player.starts[0]!.anchor, { phase: 'holding', positionMs: 1_000,
    atMs: world.clock.time + world.clock.serverOffset, holdElapsedMs: 500 });
  const reloaded = world.create('player', 'new-player-tab'); await reloaded.coordinator.initialize();
  assert.equal(reloaded.starts.length, 0);
  assert.equal(reloaded.coordinator.runPhase, 'holding');
  player.coordinator.exitLocal();
  await gm.coordinator.pause(); await player.coordinator.refresh();
  await gm.coordinator.resume(); await player.coordinator.refresh();
  assert.equal(player.coordinator.status.phase, 'exited');
  assert.equal(player.starts.length, 1);
  gm.coordinator.dispose(); player.coordinator.dispose(); reloaded.coordinator.dispose();
});

test('Continue is owner controlled and forbidden before an end break while ordinary pause and legacy manual remain unchanged', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(endBreakSequence());
  await assert.rejects(gm.coordinator.continueFromBreak(), { code: 'SESSION_PHASE' });
  await gm.coordinator.startReady();
  await assert.rejects(gm.coordinator.continueFromBreak(), { code: 'SESSION_PHASE' });
  await world.clock.advance(SESSION_TIMING.startLeadMs + 500);
  await gm.coordinator.pause();
  await assert.rejects(gm.coordinator.continueFromBreak(), { code: 'SESSION_PHASE' });
  await gm.coordinator.resume();
  await world.clock.advance(500);
  const other = world.create('other-gm'); await other.coordinator.initialize();
  await assert.rejects(other.coordinator.continueFromBreak(), { code: 'SESSION_NOT_OWNER' });
  await assert.rejects(player.coordinator.continueFromBreak(), { code: 'SESSION_UNAUTHORIZED' });
  const confirmed = world.state;
  gm.failWrites = true;
  await assert.rejects(gm.coordinator.continueFromBreak(), /Write unconfirmed/);
  assert.equal(world.state, confirmed);
  assert.equal(gm.coordinator.status.phase, 'holding');
  gm.failWrites = false;
  await gm.coordinator.stopGlobal();
  await gm.coordinator.prepare(sequence()); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 2_000);
  await assert.rejects(gm.coordinator.continueFromBreak(), { code: 'SESSION_PHASE' });
  assert.equal(world.state.run!.phase, 'playing');
  gm.coordinator.dispose(); player.coordinator.dispose(); other.coordinator.dispose();
});

test('ordinary schema 2 paused fade preserves its shared paused origin', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare({ ...sequence(5_000), schemaVersion: 2 });
  await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 500);
  await gm.coordinator.pause(); await player.coordinator.refresh();
  await gm.coordinator.fade(100); await player.coordinator.refresh();
  assert.equal(player.anchors.at(-1)?.exitFrom, 'paused');
  assert.equal(player.anchors.at(-1)?.holdElapsedMs, undefined);
  assert.equal(player.anchors.at(-1)?.positionMs, 500);
  await world.clock.advance(200);
  assert.equal(world.state.run, null);
  gm.coordinator.dispose(); player.coordinator.dispose();
});

test('an owner outside the ready recipients still observes and continues the global break', async () => {
  const { world, gm, player } = await setup();
  const media = deferred();
  gm.host.playback.prepare = () => media.promise;
  await gm.coordinator.prepare(endBreakSequence()); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_200);
  assert.equal(gm.coordinator.status.phase, 'exited');
  assert.equal(gm.coordinator.runPhase, 'holding');
  assert.equal(player.coordinator.status.phase, 'holding');
  await gm.coordinator.continueFromBreak();
  await world.clock.advance(1_000);
  assert.equal(world.state.run, null);
  gm.coordinator.dispose(); player.coordinator.dispose();
});

test('a held run still releases on controller loss and global fade preserves its advancing held clock', async () => {
  const { world, gm, player } = await setup();
  await gm.coordinator.prepare(endBreakSequence()); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_500);
  await gm.coordinator.fade(100); await player.coordinator.refresh();
  assert.equal(player.anchors.at(-1)?.exitFrom, 'holding');
  assert.equal(player.anchors.at(-1)?.holdElapsedMs, 500);
  await world.clock.advance(1_000);
  await gm.coordinator.prepare(endBreakSequence()); await gm.coordinator.startReady();
  await world.clock.advance(SESSION_TIMING.startLeadMs + 1_500);
  assert.equal(player.coordinator.status.phase, 'holding');
  world.dropQueries = true;
  await world.clock.advance(SESSION_TIMING.controllerTimeoutMs + 1);
  assert.equal(player.coordinator.status.phase, 'exited');
  assert.equal(world.state.run!.phase, 'playing');
  assert.equal(gm.coordinator.runPhase, 'holding');
  gm.coordinator.dispose(); player.coordinator.dispose();
});
