import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestrationCoordinator, type OrchestrationCoordinatorHost } from '../src/application/orchestration-coordinator.js';
import { SessionCoordinator } from '../src/application/session-coordinator.js';
import { defaultButtonProperties, withButtonProgression } from '../src/domain/button.js';
import { eligibleButton, recipientProgress, recipientRun, type ButtonChoiceCardInput } from '../src/playback/personal-progression.js';
import { applySessionRecord, initialSession, sessionPlayback } from '../src/playback/session-protocol.js';
import { withSequenceAudience } from '../src/domain/sequence-audience.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import type { PlaybackAnchor } from '../src/playback/local-player.js';
import { applyOrchestrationRecord, initialOrchestration, normalizeOrchestrationState, type OrchestrationCommand, type OrchestrationState } from '../src/playback/orchestration-protocol.js';
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
      recordVersion: payload.kind === 'upgrade4' ? 4 : payload.kind === 'upgrade3' ? 3 : payload.kind === 'upgrade' ? 2 : this.state.version, payload }, id => this.users.some(user => user.id === id && user.role >= 3));
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


function personal(choice = false): SequenceV1 {
  const source = withButtonProgression(sequence(['a', 'b']));
  return { ...source, breaks: [{ id: 'hold', positionMs: 500 }, { id: 'hold-two', positionMs: 800 }],
    clips: [...source.clips, ...['continue', ...(choice ? ['left', 'right'] : [])].map((id, index) => ({
      id, trackId: 'track', type: 'button' as const, typeVersion: 1 as const, startMs: 0,
      duration: { kind: 'sequence-end' as const }, entrance: { preset: 'none' as const, version: 1 as const }, exit: { preset: 'none' as const, version: 1 as const },
      properties: { ...defaultButtonProperties(), action: index === 0 ? { kind: 'continue' as const } : {
        kind: 'choice' as const, decisionId: 'direction', optionId: id, message: `I choose ${id}`, visibility: 'gm' as const } }
    }))] };
}
async function sync(world: World): Promise<void> { for (const client of world.clients.values()) await client.coordinator.refresh(); await settle(); }
async function started(choice = false): Promise<{ world: World; gm: Client; a: Client; b: Client; runId: string }> {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(personal(choice)); await settle();
  const runId = world.state.runs[0]!.runId;
  await gm.coordinator.startReady(runId); await world.clock.advance(SESSION_TIMING.startLeadMs + 600); await sync(world);
  return { world, gm, a: world.clients.get('a')!, b: world.clients.get('b')!, runId };
}
function progress(world: World, id: string) { return recipientProgress(world.state.runs[0]!, { userId: id, sessionId: `${id}-tab` })!; }
function phase(world: World, id: string) { return sessionPlayback(recipientRun(world.state.runs[0]!, { userId: id, sessionId: `${id}-tab` }), world.clock.time + 10_000); }

test('personal readers retain independent clocks; simultaneous actions do not conflict on another reader revision', async () => {
  const { world, a, b } = await started();
  assert.equal(world.state.version, 4);
  await Promise.all([a.coordinator.activateButton('continue', 'hold'), b.coordinator.activateButton('continue', 'hold')]);
  assert.equal(progress(world, 'a').anchor.breakHistory!.length, 1); assert.equal(progress(world, 'b').anchor.breakHistory!.length, 1);
  await world.clock.advance(350); await sync(world);
  assert.equal(phase(world, 'a').breakId, 'hold-two');
  const unchanged = progress(world, 'b');
  await a.coordinator.activateButton('continue', 'hold-two');
  assert.equal(progress(world, 'b'), unchanged); assert.equal(phase(world, 'a').phase, 'playing');
  assert.equal(phase(world, 'b').phase, 'holding'); world.dispose();
});

test('authenticated action rejects wrong browser, outsider, stale revision, invisible button and double clicks', async () => {
  const { world, gm, a, runId } = await started(); const run = world.state.runs[0]!;
  const owner = world.state.owner!;
  const base = { kind: 'button-activate', targetSessionId: owner.sessionId, ownerSessionId: owner.sessionId, generation: owner.generation,
    protocolVersion: 7, runId, prepareRevision: run.prepareRevision, participantSessionId: 'a-tab', expectedRevision: progress(world, 'a').revision, clipId: 'continue', breakId: 'hold' };
  assert.equal((await gm.coordinator.handleQuery({ ...base, participantSessionId: 'old-tab' }, 'a') as { kind: string }).kind, 'error');
  assert.equal((await gm.coordinator.handleQuery(base, 'c') as { kind: string }).kind, 'error');
  assert.equal((await gm.coordinator.handleQuery({ ...base, clipId: 'missing' }, 'a') as { kind: string }).kind, 'error');
  const outcomes = await Promise.allSettled([a.coordinator.activateButton('continue', 'hold'), a.coordinator.activateButton('continue', 'hold')]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await gm.coordinator.handleQuery(base, 'a') as { kind: string }).kind, 'error');
  assert.equal(progress(world, 'a').anchor.breakHistory!.length, 1); world.dispose();
});

test('GM mixed-position controls retain each reader position, history and held media clocks', async () => {
  const { world, gm, a, runId } = await started();
  await a.coordinator.activateButton('continue', 'hold'); await world.clock.advance(100); await sync(world);
  await gm.coordinator.pause(runId); await sync(world);
  assert.equal(phase(world, 'a').positionMs, 600); assert.equal(phase(world, 'b').positionMs, 500);
  const held = phase(world, 'b').holdElapsedMs;
  await world.clock.advance(100); await sync(world);
  assert.equal(phase(world, 'b').holdElapsedMs, held);
  await assert.rejects(a.coordinator.activateButton('continue', 'hold'));
  await gm.coordinator.resume(runId); await gm.coordinator.continueFromBreak(runId); await sync(world);
  assert.equal(progress(world, 'a').anchor.breakHistory!.length, 1);
  assert.equal(progress(world, 'b').anchor.breakHistory!.length, 1);
  assert.equal(phase(world, 'a').positionMs, 600); assert.equal(phase(world, 'b').positionMs, 500);
  await gm.coordinator.fade(runId); await sync(world);
  assert.equal(progress(world, 'a').anchor.phase, 'exiting'); assert.equal(progress(world, 'b').anchor.phase, 'exiting');
  await world.clock.advance(250); await sync(world); assert.equal(world.state.runs.length, 0); world.dispose();
});

test('terminal Continue fades only its reader and queue retains audience until every persisted terminal', async () => {
  const { world, gm, a, b, runId } = await started();
  await gm.coordinator.prepare(personal()); await settle(); assert.equal(gm.coordinator.queue.length, 1);
  await a.coordinator.activateButton('continue', 'hold'); await world.clock.advance(350); await sync(world);
  await a.coordinator.activateButton('continue', 'hold-two'); await world.clock.advance(250); await sync(world);
  await a.coordinator.activateButton('continue'); assert.equal(progress(world, 'a').anchor.phase, 'exiting');
  assert.equal(phase(world, 'b').breakId, 'hold');
  await world.clock.advance(250); await sync(world);
  assert.equal(progress(world, 'a').terminal, true); assert.equal(progress(world, 'b').terminal, false);
  assert.equal(world.state.runs[0]!.runId, runId); assert.equal(gm.coordinator.queue.length, 1);
  await b.coordinator.activateButton('continue', 'hold'); await world.clock.advance(350); await sync(world);
  await b.coordinator.activateButton('continue', 'hold-two'); await world.clock.advance(250); await sync(world);
  await b.coordinator.activateButton('continue'); await world.clock.advance(250); await sync(world);
  assert.equal(world.state.closedRuns.includes(runId), true);
  assert.equal(world.state.runs[0]!.phase, 'preparing'); assert.notEqual(world.state.runs[0]!.runId, runId); world.dispose();
});

test('local emergency exit and missing heartbeat retain the reserved audience and cannot be used as completion', async () => {
  const { world, gm, a, runId } = await started();
  a.coordinator.exitLocal(); await gm.coordinator.prepare(personal()); await world.clock.advance(3_000); await sync(world);
  assert.equal(progress(world, 'a').terminal, false); assert.equal(world.state.runs[0]!.runId, runId);
  assert.equal(gm.coordinator.queue.length, 1); await assert.rejects(a.coordinator.activateButton('continue', 'hold')); world.dispose();
});

test('choice failure preserves a durable pending decision; retry uses the same operation, author text and one chat card', async () => {
  const { world, gm, a } = await started(true);
  const calls: ButtonChoiceCardInput[] = []; const cards = new Map<string, string>(); let fail = true;
  gm.host.ensureButtonChoiceCard = async input => { calls.push(input); if (fail) throw new Error('Chat offline');
    const messageId = cards.get(input.operationId) ?? `card-${cards.size}`; cards.set(input.operationId, messageId); return { messageId }; };
  await assert.rejects(a.coordinator.activateButton('left', 'hold'), /Chat offline/); await sync(world);
  assert.equal(progress(world, 'a').choices[0]!.status, 'pending'); assert.equal(phase(world, 'a').breakId, 'hold');
  await assert.rejects(a.coordinator.activateButton('right', 'hold')); await assert.rejects(a.coordinator.activateButton('continue', 'hold'));
  fail = false; await a.coordinator.activateButton('left', 'hold');
  assert.equal(cards.size, 1); assert.equal(calls[0]!.operationId, calls[1]!.operationId);
  assert.equal(calls[1]!.action.message, 'I choose left'); assert.equal(calls[1]!.action.visibility, 'gm');
  assert.equal(calls[1]!.participant.userId, 'a'); assert.equal(progress(world, 'a').choices[0]!.status, 'confirmed');
  assert.equal(progress(world, 'a').anchor.breakHistory!.length, 1); assert.equal(phase(world, 'b').breakId, 'hold'); world.dispose();
});

test('card write followed by ledger failure reconciles the same card without a second option or extra Continue', async () => {
  const { world, gm, a } = await started(true); const cards = new Map<string, string>(); let attempts = 0;
  const append = gm.host.store.append;
  gm.host.store.append = async (command, head) => { if (command.kind === 'choice-confirm' && attempts++ === 0) throw new Error('Ack offline'); return append(command, head); };
  gm.host.ensureButtonChoiceCard = async input => { const messageId = cards.get(input.operationId) ?? `card-${cards.size}`; cards.set(input.operationId, messageId); return { messageId }; };
  await assert.rejects(a.coordinator.activateButton('left', 'hold'), /Ack offline/); await sync(world);
  assert.equal(cards.size, 1); assert.equal(progress(world, 'a').choices[0]!.status, 'pending');
  await assert.rejects(a.coordinator.activateButton('right', 'hold')); await a.coordinator.activateButton('left', 'hold');
  assert.equal(cards.size, 1); assert.equal(progress(world, 'a').choices[0]!.status, 'confirmed');
  assert.equal(progress(world, 'a').anchor.breakHistory!.length, 1); world.dispose();
});

test('terminal acknowledgement retries after a failed ledger write, including an unchanged-head poll', async () => {
  const { world, gm, runId } = await started();
  const append = gm.host.store.append; let attempts = 0;
  gm.host.store.append = async (command, head) => {
    if (command.kind === 'recipient-terminal' && command.participant.userId === 'a' && attempts++ === 0) throw new Error('Terminal write offline');
    return append(command, head);
  };
  await gm.coordinator.fade(runId); await world.clock.advance(250); await sync(world);
  await world.clock.advance(SESSION_TIMING.pollMs); await sync(world);
  assert.equal(world.state.closedRuns.includes(runId), true);
  assert.equal(attempts, 2); world.dispose();
});

test('accepted terminal record with a lost query response reconciles without duplicate ledger writes', async () => {
  const { world, gm, a, runId } = await started(); const query = a.host.query; let lost = false;
  a.host.query = async (userId, data, timeout) => {
    const response = await query(userId, data, timeout);
    if (!lost && (data as { kind: string }).kind === 'recipient-terminal') { lost = true; throw new Error('Response lost'); }
    return response;
  };
  await gm.coordinator.fade(runId); await world.clock.advance(250); await sync(world);
  assert.equal(world.state.closedRuns.includes(runId), true); assert.equal(lost, true);
  assert.equal(world.commands.filter(command => command.kind === 'recipient-terminal' && command.participant.userId === 'a').length, 1); world.dispose();
});

test('external personal state validates every complete clock, fixed browser and durable decision', async () => {
  const { world } = await started(true);
  const mutate = (change: (state: any) => void) => {
    const state = structuredClone(world.state); change(state); assert.throws(() => normalizeOrchestrationState(state));
  };
  mutate(state => { state.runs[0].recipientStates[0].anchor.positionMs = 999; });
  mutate(state => { state.runs[0].recipientStates[0].anchor.atMs = -1; });
  mutate(state => { state.runs[0].recipientStates[0].anchor.extra = true; });
  mutate(state => { state.runs[0].recipientStates[0].sessionId = 'other-tab'; });
  mutate(state => { state.runs[0].recipientStates.pop(); });
  mutate(state => { delete state.runs[0].recipientStates; });
  mutate(state => { state.version = 3; });
  world.dispose();
});

test('a confirmed decision cannot be chosen again at a later Break in the same run', async () => {
  const { world, gm, a } = await started(true); let cards = 0;
  gm.host.ensureButtonChoiceCard = async () => ({ messageId: `card-${++cards}` });
  await a.coordinator.activateButton('left', 'hold'); await world.clock.advance(350); await sync(world);
  await assert.rejects(a.coordinator.activateButton('right', 'hold-two'));
  await assert.rejects(a.coordinator.activateButton('left', 'hold-two'));
  assert.equal(cards, 1); assert.equal(phase(world, 'a').breakId, 'hold-two'); world.dispose();
});

test('personal adoption upgrades only an idle ledger and requires exact Transport 7 discovery', async () => {
  const world = new World(); const gm = await world.initialize();
  await gm.coordinator.prepare(sequence(['a'])); await settle();
  await assert.rejects(gm.coordinator.prepare(personal()), { code: 'SESSION_ACTIVE' });
  assert.equal(world.state.version, 3); await gm.coordinator.stopAll();
  const query = gm.host.query;
  gm.host.query = async (userId, data, timeout) => (data as { kind: string }).kind === 'discover'
    ? { kind: 'discover', sessionId: `${userId}-tab`, protocolVersion: 6 } : query(userId, data, timeout);
  await gm.coordinator.prepare(personal()); await settle();
  assert.equal(world.state.version, 4); assert.equal(world.state.runs.length, 0);
  assert.equal(gm.coordinator.queue[0]!.status, 'failed'); world.dispose();
});

test('buttons with zero authored appearance opacity are ineligible on the authority', async () => {
  const { world } = await started(); const run = world.state.runs[0]!;
  const hidden = { ...run, snapshot: { ...run.snapshot, clips: run.snapshot.clips.map(clip => clip.id === 'continue'
    ? { ...clip, appearance: { blendMode: 'normal' as const, opacity: 0 } } : clip) } };
  assert.throws(() => eligibleButton(hidden, progress(world, 'a'), 'continue', 'hold', world.clock.time + 10_000));
  world.dispose();
});

test('legacy single-session reducer cannot silently adopt personal sequence semantics', () => {
  const state = applySessionRecord(initialSession('legacy'), { index: 1, previous: 0, requestId: 'acquire', actor: 'gm', payload: { kind: 'acquire', sessionId: 'gm-tab' } }, () => true);
  assert.throws(() => applySessionRecord(state, { index: 2, previous: 1, requestId: 'prepare', actor: 'gm', payload: {
    kind: 'prepare', sessionId: 'gm-tab', generation: state.owner!.generation, runId: 'personal', snapshot: personal(), recipients: [{ userId: 'a', sessionId: 'a-tab' }, { userId: 'b', sessionId: 'b-tab' }]
  } }, () => true));
});

test('standalone personal preparation rejects before any authority acquisition or store write', async () => {
  let writes = 0;
  const coordinator = new SessionCoordinator({ userId: 'gm', sessionId: 'gm-tab', isGM: true,
    users: () => [{ id: 'gm', name: 'GM', role: 4, active: true }],
    store: { read: async () => initialSession('standalone'), append: async () => { writes++; throw new Error('Must not write'); } },
    now: () => 0, monotonicNow: () => 0, makeId: () => 'unused', query: async () => null,
    playback: { start: async () => {}, applyAnchor: () => {}, stop: () => {} }, schedule: () => null, cancel: () => {} });
  await assert.rejects(coordinator.prepare(personal()), { code: 'SESSION_UNSUPPORTED' });
  assert.equal(writes, 0); assert.equal(coordinator.state, null); coordinator.dispose();
});
