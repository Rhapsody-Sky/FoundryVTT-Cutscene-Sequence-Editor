import test from 'node:test';
import assert from 'node:assert/strict';
import { SAVED_TRIGGER_LIMITS, SavedTriggerLauncher } from '../src/application/saved-trigger-launcher.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import type { TriggerEvent } from '../src/domain/sequence-triggers.js';
import { withSequenceAutomation } from '../src/domain/sequence-audience.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import type { AutomaticAdmissionIntent } from '../src/application/orchestration-coordinator.js';
import { CombatTriggerBinding } from '../src/integrations/foundry/combat-trigger-binding.js';

const event: TriggerEvent = { id: 'combat-step-1', kind: 'turn-start', combatId: 'combat', round: 1,
  turn: 0, combatantId: 'combatant', actorId: 'actor' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function sequence(id: string, enabled = true): SequenceV1 {
  let counter = 0;
  const base = validateSequence({ ...createBarsSequence(id, () => `${id}-${++counter}`, 3), id, revision: 1 });
  return withSequenceAutomation(base, { version: 1, enabled, rules: [
    { id: 'rule-z', enabled: true, event: 'turn-start', actorId: null },
    { id: 'rule-a', enabled: true, event: 'turn-start', actorId: 'actor' }
  ] });
}
function fixture(values = [sequence('sequence-b'), sequence('sequence-a')]) {
  const saved = new Map(values.map(source => [source.id, source]));
  const calls: { sequence: SequenceV1; event: TriggerEvent; ruleId: string; intent?: AutomaticAdmissionIntent }[] = [];
  const errors: Error[] = [];
  let authorized = true;
  const users = [{ id: 'gm', name: 'GM', role: 4, active: true },
    { id: 'player', name: 'Player', role: 1, active: true }];
  const ports = {
    controllerUserId: 'gm', users: () => users,
    repository: {
      async list() { return [...saved.values()].map(source => ({ id: source.id, revision: source.revision, name: source.name })); },
      async read(id: string) { return structuredClone(saved.get(id)); }
    },
    coordinator: {
      get canPrepareAutomatic() { return authorized; },
      captureAutomaticIntent() { return Object.freeze({}) as AutomaticAdmissionIntent; },
      async prepareAutomatic(source: SequenceV1, received: TriggerEvent, ruleId: string, intent: AutomaticAdmissionIntent) {
        calls.push({ sequence: source, event: received, ruleId, intent }); return true;
      }
    },
    report(error: Error) { errors.push(error); }
  };
  return { saved, calls, errors, ports, users, setAuthorized(value: boolean) { authorized = value; } };
}

test('saved launcher ignores uninitialized state and disabled automations; admissions have stable event/sequence/rule order', async () => {
  const setup = fixture([sequence('sequence-b'), sequence('sequence-a'), sequence('disabled', false)]);
  const launcher = new SavedTriggerLauncher(setup.ports);
  assert.equal(await launcher.dispatch([event]), 0);
  await launcher.refresh();
  assert.equal(await launcher.dispatch([event, { ...event, id: 'step-2' }]), 8);
  assert.deepEqual(setup.calls.map(call => [call.event.id, call.sequence.id, call.ruleId]), [
    ['combat-step-1', 'sequence-a', 'rule-a'], ['combat-step-1', 'sequence-a', 'rule-z'],
    ['combat-step-1', 'sequence-b', 'rule-a'], ['combat-step-1', 'sequence-b', 'rule-z'],
    ['step-2', 'sequence-a', 'rule-a'], ['step-2', 'sequence-a', 'rule-z'],
    ['step-2', 'sequence-b', 'rule-a'], ['step-2', 'sequence-b', 'rule-z']
  ]);
});

test('invalidation as the final read completes cannot strand the saved trigger cache disabled', async () => {
  const source = sequence('sequence-a');
  const setup = fixture([source]), entered = deferred<void>(), pending = deferred<SequenceV1>();
  let reads = 0;
  setup.ports.repository.read = () => {
    reads++;
    entered.resolve();
    return pending.promise;
  };
  const launcher = new SavedTriggerLauncher(setup.ports);
  const initial = launcher.refresh();
  await entered.promise;
  let invalidated: Promise<void> | undefined;
  pending.resolve(source);
  // A native library callback can run between the last read and promise cleanup.
  queueMicrotask(() => { invalidated = launcher.refresh(); });
  await initial;
  await invalidated;
  assert.equal(reads, 2, 'The invalidation must complete a fresh read.');
  assert.equal(await launcher.dispatch([event]), 2, 'Saved enabled rules must still launch.');
});

test('a confirmed native combat start during library loading reaches its saved rule exactly once', async () => {
  const source = withSequenceAutomation(sequence('sequence-a'), { version: 1, enabled: true, rules: [
    { id: 'combat-rule', enabled: true, event: 'combat-start', actorId: null }
  ] });
  const setup = fixture([source]), entered = deferred<void>(), waiting = deferred<void>();
  const list = setup.ports.repository.list;
  setup.ports.repository.list = async () => { entered.resolve(); await waiting.promise; return list(); };
  const launcher = new SavedTriggerLauncher(setup.ports);
  const refreshing = launcher.refresh();
  await entered.promise;
  const hooks = new Map<string, (...args: unknown[]) => void>();
  const combat = { id: 'combat', round: 0, turn: null as number | null, _stats: { modifiedTime: 100 } };
  const batches: Promise<number>[] = [];
  const binding = new CombatTriggerBinding({
    hooks: { on: (name, listener) => hooks.set(name, listener), off: name => hooks.delete(name) },
    combats: () => [combat], activeCombatId: () => combat.id,
    events: events => { batches.push(launcher.dispatch(events)); }
  });
  combat.round = 1; combat.turn = 0; combat._stats.modifiedTime = 101;
  hooks.get('updateCombat')!(combat, { round: 1, turn: 0 }, { modifiedTime: 101 }, 'gm');
  assert.equal(setup.calls.length, 0, 'No admission may precede confirmed library loading.');
  waiting.resolve();
  await refreshing;
  assert.deepEqual(await Promise.all(batches), [1]);
  hooks.get('updateCombat')!(combat, { round: 1, turn: 0 }, { modifiedTime: 101 }, 'gm');
  assert.equal(batches.length, 1);
  assert.deepEqual(setup.calls.map(call => [call.ruleId, call.event.kind]), [['combat-rule', 'combat-start']]);
  binding.dispose(); launcher.dispose();
});

test('a confirmed native combat end during library loading freezes the selected audience and dispatches once', async () => {
  const source = withSequenceAutomation(sequence('sequence-a'), { version: 1, enabled: true, rules: [
    { id: 'end-rule', enabled: true, event: 'combat-end', actorId: null }
  ] });
  const setup = fixture([source]), entered = deferred<void>(), waiting = deferred<void>();
  const list = setup.ports.repository.list;
  setup.ports.repository.list = async () => { entered.resolve(); await waiting.promise; return list(); };
  const launcher = new SavedTriggerLauncher(setup.ports), refreshing = launcher.refresh();
  await entered.promise;
  const hooks = new Map<string, (...args: unknown[]) => void>();
  const combat = { id: 'combat', round: 2, turn: 0 as number | null, isActive: true,
    combatant: { id: 'fighter', actorId: 'actor' }, _stats: { modifiedTime: 100 } };
  let current: typeof combat[] = [combat];
  const batches: Promise<number>[] = [];
  const binding = new CombatTriggerBinding({
    hooks: { on: (name, listener) => hooks.set(name, listener), off: name => hooks.delete(name) },
    combats: () => current, activeCombatId: () => current[0]?.id ?? null,
    events: events => { batches.push(launcher.dispatch(events)); }
  });
  current = []; combat.turn = null;
  hooks.get('renderCombatTracker')!();
  hooks.get('deleteCombat')!(combat, { modifiedTime: 101 }, 'gm');
  hooks.get('deleteCombat')!(combat, { modifiedTime: 101 }, 'gm');
  setup.users[1]!.active = false;
  assert.equal(setup.calls.length, 0);
  waiting.resolve(); await refreshing;
  assert.deepEqual(await Promise.all(batches), [1]);
  assert.deepEqual(setup.calls.map(call => [call.ruleId, call.event.kind, call.sequence.launch!.audience.userIds]),
    [['end-rule', 'combat-end', ['player']]]);
  assert.equal(setup.errors.length, 0);
  binding.dispose(); launcher.dispose();
});

test('a loading batch freezes event, connected players and authority before waiting', async () => {
  const setup = fixture([sequence('sequence-a')]), entered = deferred<void>(), waiting = deferred<void>();
  const list = setup.ports.repository.list;
  setup.ports.repository.list = async () => { entered.resolve(); await waiting.promise; return list(); };
  const launcher = new SavedTriggerLauncher(setup.ports);
  const refreshing = launcher.refresh();
  await entered.promise;
  const currentEvent = { ...event };
  const intent = Object.freeze({}) as AutomaticAdmissionIntent;
  setup.ports.coordinator.captureAutomaticIntent = () => intent;
  const pending = launcher.dispatch([currentEvent]);
  currentEvent.actorId = 'different';
  setup.users[1]!.active = false;
  setup.users.push({ id: 'joined-later', name: 'Later', role: 1, active: true });
  waiting.resolve(); await refreshing;
  assert.equal(await pending, 2);
  assert.ok(setup.calls.every(call => call.event.actorId === 'actor' && call.intent === intent));
  assert.deepEqual(setup.calls.map(call => call.sequence.launch!.audience.userIds), [['player'], ['player']]);
});

test('pending library events retain their old authority intent after a controller changes', async () => {
  const setup = fixture([sequence('sequence-a')]), waiting = deferred<void>(), entered = deferred<void>();
  const list = setup.ports.repository.list;
  setup.ports.repository.list = async () => { entered.resolve(); await waiting.promise; return list(); };
  let current = Object.freeze({}) as AutomaticAdmissionIntent;
  const original = current, intents: AutomaticAdmissionIntent[] = [];
  setup.ports.coordinator.captureAutomaticIntent = () => current;
  setup.ports.coordinator.prepareAutomatic = async (_sequence, _event, _rule, intent) => {
    intents.push(intent); return current === intent;
  };
  const launcher = new SavedTriggerLauncher(setup.ports), refreshing = launcher.refresh();
  await entered.promise;
  const pending = launcher.dispatch([event]);
  current = Object.freeze({}) as AutomaticAdmissionIntent;
  waiting.resolve(); await refreshing;
  assert.equal(await pending, 0);
  assert.deepEqual(intents, [original, original]);
  assert.equal(await launcher.dispatch([{ ...event, id: 'new-authority-event' }]), 2);
  assert.ok(intents.slice(2).every(intent => intent === current));
});

test('dispose, authorization loss and read failure cancel pending library events without retry', async () => {
  for (const stopping of ['dispose', 'authority', 'read-error'] as const) {
    const setup = fixture([sequence('sequence-a')]), waiting = deferred<void>(), entered = deferred<void>();
    const list = setup.ports.repository.list;
    setup.ports.repository.list = async () => {
      entered.resolve(); await waiting.promise;
      if (stopping === 'read-error') throw new Error('Library unavailable');
      return list();
    };
    const launcher = new SavedTriggerLauncher(setup.ports), refreshing = launcher.refresh();
    await entered.promise;
    const pending = launcher.dispatch([event]);
    if (stopping === 'dispose') launcher.dispose();
    if (stopping === 'authority') setup.setAuthorized(false);
    waiting.resolve();
    if (stopping === 'read-error') await assert.rejects(refreshing, /Library unavailable/);
    else await refreshing;
    assert.equal(await pending, 0);
    assert.equal(setup.calls.length, 0);
    assert.equal(setup.errors.length, stopping === 'read-error' ? 1 : 0);
  }
});

test('loading event batches are bounded and preserve order when newer events arrive after loading', async () => {
  const setup = fixture([sequence('sequence-a')]), waiting = deferred<void>(), entered = deferred<void>();
  const list = setup.ports.repository.list;
  setup.ports.repository.list = async () => { entered.resolve(); await waiting.promise; return list(); };
  const launcher = new SavedTriggerLauncher(setup.ports), refreshing = launcher.refresh();
  await entered.promise;
  const batches = Array.from({ length: SAVED_TRIGGER_LIMITS.pendingBatches }, (_, index) =>
    launcher.dispatch([{ ...event, id: `waiting-${index}` }]));
  await assert.rejects(launcher.dispatch([{ ...event, id: 'overflow' }]), /Too many automatic combat updates/);
  assert.equal(setup.calls.length, 0);
  waiting.resolve(); await refreshing;
  await batches[0]; // One batch frees its slot; later batches are still queued.
  const latest = launcher.dispatch([{ ...event, id: 'after-loading' }]);
  assert.ok((await Promise.all(batches)).every(accepted => accepted === 2));
  assert.equal(await latest, 2);
  assert.deepEqual(setup.calls.filter((_call, index) => index % 2 === 0).map(call => call.event.id),
    [...batches.map((_batch, index) => `waiting-${index}`), 'after-loading']);
});

test('an oversized batch discovered after library loading admits nothing and reports once', async () => {
  const setup = fixture([sequence('sequence-a')]), waiting = deferred<void>(), entered = deferred<void>();
  const list = setup.ports.repository.list;
  setup.ports.repository.list = async () => { entered.resolve(); await waiting.promise; return list(); };
  const launcher = new SavedTriggerLauncher(setup.ports), refreshing = launcher.refresh();
  await entered.promise;
  const pending = launcher.dispatch(Array.from({ length: SAVED_TRIGGER_LIMITS.matchesPerBatch }, (_, index) =>
    ({ ...event, id: `matching-${index}` })));
  const rejected = assert.rejects(pending, /Too many automatic launches match/);
  waiting.resolve(); await refreshing; await rejected;
  assert.equal(setup.calls.length, 0);
  assert.equal(setup.errors.length, 1);
  assert.equal(await launcher.dispatch([event]), 2);
});

test('each captured batch retains its authority intent across rules and queued dispatch awaits', async () => {
  const setup = fixture([sequence('sequence-a')]), waiting = deferred<void>();
  let current = Object.freeze({}) as AutomaticAdmissionIntent;
  const received: AutomaticAdmissionIntent[] = [];
  setup.ports.coordinator.captureAutomaticIntent = () => current;
  setup.ports.coordinator.prepareAutomatic = async (_source, _event, _rule, intent) => {
    received.push(intent);
    if (received.length === 1) await waiting.promise;
    return intent === current;
  };
  const launcher = new SavedTriggerLauncher(setup.ports);
  await launcher.refresh();
  const oldIntent = current;
  const first = launcher.dispatch([event]), queued = launcher.dispatch([{ ...event, id: 'queued' }]);
  await Promise.resolve();
  current = Object.freeze({}) as AutomaticAdmissionIntent;
  waiting.resolve();
  assert.deepEqual(await Promise.all([first, queued]), [0, 0]);
  assert.equal(received.length, 4);
  assert.ok(received.every(intent => intent === oldIntent));
  assert.equal(await launcher.dispatch([{ ...event, id: 'future' }]), 2);
  assert.ok(received.slice(4).every(intent => intent === current));
});

test('a native batch captures all saved snapshots and events before any asynchronous admission', async () => {
  const setup = fixture([sequence('sequence-a')]), waiting = deferred<void>();
  setup.ports.coordinator.prepareAutomatic = async (source, received, ruleId) => {
    setup.calls.push({ sequence: source, event: received, ruleId });
    if (setup.calls.length === 1) await waiting.promise;
    return true;
  };
  const launcher = new SavedTriggerLauncher(setup.ports);
  await launcher.refresh();
  const mutableEvent = { ...event };
  const dispatching = launcher.dispatch([mutableEvent]);
  await Promise.resolve();
  setup.saved.set('sequence-a', { ...sequence('sequence-a', false), name: 'changed after event', revision: 2 });
  mutableEvent.actorId = 'changed';
  setup.users.push({id:'later-player',name:'Later',role:1,active:true});
  await launcher.refresh();
  waiting.resolve();
  assert.equal(await dispatching, 2);
  assert.deepEqual(setup.calls.map(call => [call.sequence.name, call.sequence.revision, call.event.actorId]),
    [['sequence-a', 1, 'actor'], ['sequence-a', 1, 'actor']]);
  assert.deepEqual(setup.calls.map(call => call.sequence.launch!.audience.userIds), [['player'], ['player']]);
  assert.equal(await launcher.dispatch([event]), 0);
});

test('authorization loss and dispose prevent future admissions without changing accepted ones', async () => {
  for (const stopping of ['authority', 'dispose'] as const) {
    const setup = fixture([sequence('sequence-a')]), waiting = deferred<void>();
    setup.ports.coordinator.prepareAutomatic = async (source, received, ruleId) => {
      setup.calls.push({ sequence: source, event: received, ruleId }); await waiting.promise; return true;
    };
    const launcher = new SavedTriggerLauncher(setup.ports);
    await launcher.refresh();
    const dispatching = launcher.dispatch([event]);
    await Promise.resolve();
    if (stopping === 'authority') setup.setAuthorized(false); else launcher.dispose();
    waiting.resolve();
    assert.equal(await dispatching, 1);
    assert.equal(setup.calls.length, 1);
    assert.equal(await launcher.dispatch([{ ...event, id: 'next' }]), 0);
  }
});

test('duplicate false and failed admissions do not retry and do not block independent matching sequences', async () => {
  const setup = fixture();
  let attempts = 0;
  setup.ports.coordinator.prepareAutomatic = async (source, received, ruleId) => {
    setup.calls.push({ sequence: source, event: received, ruleId });
    attempts++;
    if (attempts === 1) throw new Error('media or queue admission failed');
    return attempts !== 2;
  };
  const launcher = new SavedTriggerLauncher(setup.ports);
  await launcher.refresh();
  assert.equal(await launcher.dispatch([event]), 2);
  assert.equal(setup.calls.length, 4);
  assert.equal(setup.errors.length, 1);
  assert.equal(setup.errors[0]!.message, 'media or queue admission failed');
});

test('refresh invalidates immediately; overlapping refreshes cannot publish stale repository contents', async () => {
  const setup = fixture([sequence('sequence-a')]), waiting = deferred<void>(), enteredRead = deferred<void>();
  const launcher = new SavedTriggerLauncher(setup.ports);
  await launcher.refresh();
  const read = setup.ports.repository.read;
  let reads = 0;
  setup.ports.repository.read = async id => {
    const old = await read(id);
    if (++reads === 1) { enteredRead.resolve(); await waiting.promise; }
    return old;
  };
  const refreshing = launcher.refresh();
  await enteredRead.promise;
  const dispatching = launcher.dispatch([event]);
  assert.equal(setup.calls.length, 0);
  setup.saved.set('sequence-a', { ...sequence('sequence-a', false), revision: 2 });
  const newer = launcher.refresh();
  waiting.resolve();
  await Promise.all([refreshing, newer]);
  assert.equal(await dispatching, 0, 'A newer saved edit cannot capture an earlier pending event.');
  assert.ok(reads >= 2);
  assert.equal(await launcher.dispatch([event]), 0);
});

test('invalid or changed saved data fails closed while repository itself and earlier snapshots remain untouched', async () => {
  const setup = fixture([sequence('sequence-a')]);
  const launcher = new SavedTriggerLauncher(setup.ports);
  await launcher.refresh();
  const original = structuredClone(setup.saved.get('sequence-a'));
  setup.ports.repository.read = async () => ({ ...sequence('different-id'), revision: 1 });
  await assert.rejects(launcher.refresh(), /changed while/);
  assert.equal(await launcher.dispatch([event]), 0);
  assert.deepEqual(setup.saved.get('sequence-a'), original);
  assert.equal(setup.errors.length, 1);
});

test('a deleted sequence rejecting an obsolete read cannot disable the remaining saved trigger rules', async () => {
  const setup = fixture(), waiting = deferred<void>(), enteredRead = deferred<void>();
  const launcher = new SavedTriggerLauncher(setup.ports);
  await launcher.refresh();
  const read = setup.ports.repository.read;
  let firstRead = true;
  setup.ports.repository.read = async id => {
    if (firstRead) {
      firstRead = false;
      assert.equal(id, 'sequence-a');
      enteredRead.resolve();
      await waiting.promise;
      throw new Error('SEQUENCE_NOT_FOUND');
    }
    return read(id);
  };
  const oldRefresh = launcher.refresh();
  await enteredRead.promise;
  setup.saved.delete('sequence-a');
  const newRefresh = launcher.refresh();
  waiting.resolve();
  await Promise.all([oldRefresh, newRefresh]);
  assert.equal(await launcher.dispatch([event]), 2);
  assert.deepEqual(setup.calls.map(call => call.sequence.id), ['sequence-b', 'sequence-b']);
  assert.equal(setup.errors.length, 0);
});

test('batch and repository bounds report an error without partial admissions or deleting saved data', async () => {
  const setup = fixture([sequence('sequence-a')]);
  const launcher = new SavedTriggerLauncher(setup.ports);
  await launcher.refresh();
  await assert.rejects(launcher.dispatch(Array.from({ length: SAVED_TRIGGER_LIMITS.matchesPerBatch }, (_, index) =>
    ({ ...event, id: `event-${index}` }))), /Too many/);
  assert.equal(setup.calls.length, 0);
  const originalList = setup.ports.repository.list;
  setup.ports.repository.list = async () => Array.from({ length: SAVED_TRIGGER_LIMITS.sequences + 1 }, (_, index) =>
    ({ id: `sequence-${index}`, name: 'Sequence', revision: 1 }));
  await assert.rejects(launcher.refresh(), /sequence limit/);
  setup.ports.repository.list = originalList;
  await launcher.refresh();
  assert.equal(await launcher.dispatch([event]), 2);
});

test('queued native event batches retain their order even if the first admission awaits preparation', async () => {
  const setup = fixture([sequence('sequence-a')]), waiting = deferred<void>();
  setup.ports.coordinator.prepareAutomatic = async (source, received, ruleId) => {
    setup.calls.push({ sequence: source, event: received, ruleId });
    if (setup.calls.length === 1) await waiting.promise;
    return true;
  };
  const launcher = new SavedTriggerLauncher(setup.ports);
  await launcher.refresh();
  const first = launcher.dispatch([event]), second = launcher.dispatch([{ ...event, id: 'second' }]);
  await Promise.resolve();
  assert.equal(setup.calls.length, 1);
  waiting.resolve();
  assert.deepEqual(await Promise.all([first, second]), [2, 2]);
  assert.deepEqual(setup.calls.map(call => call.event.id), ['combat-step-1', 'combat-step-1', 'second', 'second']);
});
