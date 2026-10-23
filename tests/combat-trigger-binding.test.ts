import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatTriggerBinding, combatTriggerSnapshot, type NativeTriggerCombat } from '../src/integrations/foundry/combat-trigger-binding.js';
import type { TriggerEvent } from '../src/domain/sequence-triggers.js';

type Listener = (...args: unknown[]) => void;
function combat(round = 0, turn: number | null = 0, actorId = 'actor-a', id = 'combat'): NativeTriggerCombat {
  return { id, round, turn, combatant: { id: `combatant-${actorId}`, actorId, actor: { id: actorId } }, _stats: { modifiedTime: 100 } };
}
function setup(initial = [combat()]) {
  const callbacks = new Map<string, Set<Listener>>();
  let activeId: string | null = initial[0]?.id ?? null;
  const events: TriggerEvent[] = [];
  const binding = new CombatTriggerBinding({
    hooks: {
      on(type, listener) { if (!callbacks.has(type)) callbacks.set(type, new Set()); callbacks.get(type)!.add(listener); },
      off(type, listener) { callbacks.get(type)?.delete(listener); }
    },
    combats: () => initial,
    activeCombatId: () => activeId,
    events: received => { events.push(...received); }
  });
  return { binding, callbacks, events, combats: initial, setActive(id: string | null) { activeId = id; },
    emit(type: string, ...args: unknown[]) { for (const listener of callbacks.get(type) ?? []) listener(...args); } };
}

test('native binding uses only confirmed updates and maps start and old/new actors', () => {
  const state = setup();
  assert.equal(state.callbacks.has('combatStart'), false);
  assert.equal(state.callbacks.has('combatTurn'), false);
  assert.equal(state.callbacks.has('combatTurnChange'), false);
  state.emit('updateCombat', combat(1), { round: 1 }, { modifiedTime: 101 }, 'gm');
  assert.deepEqual(state.events.map(event => [event.kind, event.actorId]),
    [['combat-start', 'actor-a'], ['turn-start', 'actor-a']]);
  state.emit('updateCombat', combat(1, 1, 'actor-b'), { turn: 1 }, { modifiedTime: 102 }, 'gm');
  assert.deepEqual(state.events.slice(2).map(event => [event.kind, event.actorId, event.turn]),
    [['turn-end', 'actor-a', 0], ['turn-start', 'actor-b', 1]]);
});

test('reload baseline, tracker render, initiatives and missing confirmation metadata never emit', () => {
  const state = setup([combat(1, 1)]);
  state.emit('renderCombatTracker');
  state.emit('canvasReady');
  state.emit('updateCombat', combat(1, 1), { turn: 1 }, { modifiedTime: 101 });
  state.emit('updateCombat', combat(1, 1), { combatants: [] }, { modifiedTime: 102 });
  state.emit('updateCombat', combat(1, 2), { turn: 2 }, {});
  state.emit('updateCombat', null, { turn: 2 }, { modifiedTime: 103 });
  assert.deepEqual(state.events, []);
});

test('scene-active fight is independent from tracker view; inactive changes are quietly observed', () => {
  const state = setup([combat(), combat(0, 0, 'actor-b', 'other')]);
  state.emit('updateCombat', combat(1, 0, 'actor-b', 'other'), { round: 1 }, { modifiedTime: 101 });
  assert.equal(state.events.length, 0);
  state.setActive('other'); state.emit('canvasReady');
  state.emit('updateCombat', combat(1, 0, 'actor-b', 'other'), { active: true }, { modifiedTime: 102 });
  assert.equal(state.events.length, 0);
  state.emit('updateCombat', combat(1, 1, 'actor-c', 'other'), { turn: 1 }, { modifiedTime: 103 });
  assert.deepEqual(state.events.map(event => [event.kind, event.actorId]), [['turn-end', 'actor-b'], ['turn-start', 'actor-c']]);
});

test('creation and deletion only seed/remove; a recreated started combat does not replay an old trigger', () => {
  const state = setup([]);
  state.setActive('combat');
  state.emit('createCombat', combat(2, 0));
  state.emit('updateCombat', combat(2, 0), { active: true }, { modifiedTime: 101 });
  assert.equal(state.events.length, 0);
  state.emit('deleteCombat', combat(2, 0));
  state.emit('updateCombat', combat(2, 1), { turn: 1 }, { modifiedTime: 102 });
  assert.equal(state.events.length, 0);
});

test('suppressed turn workflow and stale updates do not cause trigger callbacks; next true forward change does', () => {
  const state = setup([combat(1, 0)]);
  state.emit('updateCombat', combat(1, 1), { turn: 1 }, { modifiedTime: 101, turnEvents: false });
  state.emit('updateCombat', combat(1, 2), { turn: 2 }, { modifiedTime: 99 });
  assert.equal(state.events.length, 0);
  state.emit('updateCombat', combat(1, 2), { turn: 2 }, { modifiedTime: 102 });
  assert.deepEqual(state.events.map(event => event.kind), ['turn-end', 'turn-start']);
  assert.equal(state.events[0]!.turn, 1);
});

test('binding maps missing combatant safely and releases all native hooks on dispose', () => {
  assert.deepEqual(combatTriggerSnapshot({ id: 'combat', round: 0, turn: null }), {
    combatId: 'combat', round: 0, turn: null, combatantId: null, actorId: null
  });
  const state = setup(), stale = [...state.callbacks.get('updateCombat')!][0]!;
  state.binding.dispose(); state.binding.dispose();
  assert.ok([...state.callbacks.values()].every(listeners => listeners.size === 0));
  stale(combat(1), { round: 1 }, { modifiedTime: 101 });
  assert.deepEqual(state.events, []);
});

test('confirmed native end survives collection removal, tracker rendering and cleared current turn', () => {
  const state = setup([combat(3, 2, 'actor-b')]);
  const deleted = { ...state.combats[0]!, turn: null, combatant: null, isActive: true };
  state.combats.splice(0);
  state.setActive(null);
  state.emit('renderCombatTracker');
  state.emit('deleteCombat', deleted, { modifiedTime: 101 }, 'gm');
  state.emit('deleteCombat', deleted, { modifiedTime: 101 }, 'gm');
  assert.deepEqual(state.events.map(event => [event.kind, event.round, event.turn, event.actorId]),
    [['combat-end', 3, 2, 'actor-b']]);
});

test('cancelled/pre-delete, unstarted, inactive and missing-metadata deletion do not trigger an end', () => {
  for (const [round, isActive, options] of [[0, true, { modifiedTime: 101 }],
    [2, false, { modifiedTime: 101 }], [2, true, {}], [2, undefined, { modifiedTime: 101 }]] as const) {
    const state = setup([combat(round)]);
    const deleted = { ...state.combats[0]!, ...(isActive === undefined ? {} : { isActive }) };
    state.emit('preDeleteCombat', deleted, { modifiedTime: 101 }, 'gm');
    state.emit('combatEnd', deleted);
    assert.equal(state.events.length, 0);
    state.emit('deleteCombat', deleted, options, 'gm');
    assert.equal(state.events.length, 0);
    state.binding.dispose();
  }
});

test('a native end is independent of another selected fight and respects hook disposal', () => {
  const state = setup([combat(2), combat(1, 0, 'actor-b', 'other')]);
  const deleted = { ...state.combats[0]!, turn: null, combatant: null, isActive: true };
  state.setActive('other');
  state.emit('renderCombatTracker');
  const stale = [...state.callbacks.get('deleteCombat')!][0]!;
  state.emit('deleteCombat', deleted, { modifiedTime: 101 }, 'gm');
  state.binding.dispose();
  stale({ ...combat(1, 0, 'actor-b', 'other'), isActive: true }, { modifiedTime: 102 });
  assert.deepEqual(state.events.map(event => [event.kind, event.combatId]), [['combat-end', 'combat']]);
});

test('confirmed embedded roster changes refresh the old actor after parent setupTurns without emitting events', async () => {
  for (const hook of ['createCombatant', 'updateCombatant', 'deleteCombatant']) {
    const state = setup([combat(1, 0)]);
    // Foundry emits the child hook before the parent's synchronous setupTurns.
    state.emit(hook, { parent: state.combats[0] });
    state.combats[0] = combat(1, 2, 'actor-b');
    await Promise.resolve();
    assert.equal(state.events.length, 0);
    state.emit('updateCombat', combat(1, 3, 'actor-c'), { turn: 3 }, { modifiedTime: 101 });
    assert.deepEqual(state.events.map(event => [event.kind, event.actorId, event.turn]),
      [['turn-end', 'actor-b', 2], ['turn-start', 'actor-c', 3]]);
  }
});

test('a queued roster baseline cannot suppress a real confirmed update or survive disposal', async () => {
  const state = setup([combat(1, 0)]);
  state.emit('updateCombatant', { parent: state.combats[0] });
  state.combats[0] = { ...combat(1, 1, 'actor-b'), _stats: { modifiedTime: 101 } };
  state.emit('updateCombat', state.combats[0], { turn: 1 }, { modifiedTime: 101 });
  await Promise.resolve();
  assert.deepEqual(state.events.map(event => event.kind), ['turn-end', 'turn-start']);
  state.emit('deleteCombatant', { parent: state.combats[0] });
  state.binding.dispose();
  await Promise.resolve();
  assert.equal(state.events.length, 2);
});
