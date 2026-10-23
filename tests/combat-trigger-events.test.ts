import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatTriggerEventAdapter, type CombatTriggerSnapshot } from '../src/integrations/foundry/combat-trigger-events.js';

function combat(
  round: number,
  turn: number | null,
  combatantId: string | null,
  actorId: string | null,
  modifiedTime = 1,
  combatId = 'combat-1',
): CombatTriggerSnapshot {
  return { combatId, round, turn, combatantId, actorId, modifiedTime };
}

function confirmed(modifiedTime: number, positionFieldsChanged = true, turnEventsEnabled = true) {
  return { modifiedTime, positionFieldsChanged, turnEventsEnabled } as const;
}

function started(adapter = new CombatTriggerEventAdapter()): CombatTriggerEventAdapter {
  adapter.initialize([combat(0, null, null, null)], 'combat-1');
  return adapter;
}

test('confirmed 0-to-started update emits combat-start before the first turn-start', () => {
  const adapter = started();
  const events = adapter.processUpdate(combat(1, 0, 'combatant-a', 'actor-a', 2), confirmed(2));

  assert.deepEqual(events.map(event => event.kind), ['combat-start', 'turn-start']);
  assert.deepEqual(events.map(event => [event.round, event.turn, event.combatantId, event.actorId]), [
    [1, 0, 'combatant-a', 'actor-a'],
    [1, 0, 'combatant-a', 'actor-a'],
  ]);
  assert.notEqual(events[0]!.id, events[1]!.id);
  assert.ok(events.every(event => event.id.length <= 256));
});

test('normal forward turns end the old actor turn before starting the new actor turn', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(2, 0, 'combatant-a', 'actor-a')], 'combat-1');

  const events = adapter.processUpdate(combat(2, 1, 'combatant-b', 'actor-b', 3), confirmed(3));

  assert.deepEqual(events.map(event => event.kind), ['turn-end', 'turn-start']);
  assert.deepEqual(events.map(event => [event.round, event.turn, event.combatantId, event.actorId]), [
    [2, 0, 'combatant-a', 'actor-a'],
    [2, 1, 'combatant-b', 'actor-b'],
  ]);
});

test('round advancement is forward and preserves old-turn actor context', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(4, 2, 'combatant-c', 'actor-c')], 'combat-1');

  const events = adapter.processUpdate(combat(5, 0, 'combatant-a', 'actor-a', 8), confirmed(8));

  assert.deepEqual(events.map(event => event.kind), ['turn-end', 'turn-start']);
  assert.deepEqual(events.map(event => [event.round, event.turn, event.actorId]), [[4, 2, 'actor-c'], [5, 0, 'actor-a']]);
});

test('rewinds are silent but identical same-millisecond forward transitions get distinct IDs', () => {
  const left = new CombatTriggerEventAdapter();
  const right = new CombatTriggerEventAdapter();
  const baseline = [combat(1, 0, 'combatant-a', 'actor-a', 10)];
  left.initialize(baseline, 'combat-1');
  right.initialize(baseline, 'combat-1');

  const first = left.processUpdate(combat(1, 1, 'combatant-b', 'actor-b', 20), confirmed(20));
  const firstOnPeer = right.processUpdate(combat(1, 1, 'combatant-b', 'actor-b', 20), confirmed(20));
  assert.deepEqual(first.map(event => event.id), firstOnPeer.map(event => event.id));
  assert.deepEqual(left.processUpdate(combat(1, 0, 'combatant-a', 'actor-a', 20), confirmed(20)), []);
  assert.deepEqual(right.processUpdate(combat(1, 0, 'combatant-a', 'actor-a', 20), confirmed(20)), []);

  const second = left.processUpdate(combat(1, 1, 'combatant-b', 'actor-b', 20), confirmed(20));
  const secondOnPeer = right.processUpdate(combat(1, 1, 'combatant-b', 'actor-b', 20), confirmed(20));
  assert.deepEqual(second.map(event => event.id), secondOnPeer.map(event => event.id));
  assert.deepEqual(second.map(event => event.kind), ['turn-end', 'turn-start']);
  assert.ok(first.every(event => second.every(next => next.id !== event.id)));
});

test('a duplicate post-update callback is a no-op and does not consume an occurrence', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(1, 0, 'combatant-a', 'actor-a')], 'combat-1');
  const next = combat(1, 1, 'combatant-b', 'actor-b', 2);

  const first = adapter.processUpdate(next, confirmed(2));
  assert.deepEqual(adapter.processUpdate(next, confirmed(2)), []);
  adapter.processUpdate(combat(1, 0, 'combatant-a', 'actor-a', 2), confirmed(2));
  const second = adapter.processUpdate(next, confirmed(2));

  assert.equal(new Set([...first, ...second].map(event => event.id)).size, 4);
});

test('ready/reload initialization seeds an already active fight without replaying it', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(7, 1, 'combatant-b', 'actor-b', 30)], 'combat-1');

  assert.deepEqual(adapter.processUpdate(combat(7, 1, 'combatant-b', 'actor-b', 30), confirmed(30)), []);
  assert.deepEqual(adapter.processUpdate(combat(7, 2, 'combatant-c', 'actor-c', 31), confirmed(31)).map(event => event.kind), ['turn-end', 'turn-start']);
});

test('initiative and roster-only changes do not create turns, including a shifted actor at the same coordinates', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(3, 1, 'combatant-a', 'actor-a')], 'combat-1');

  assert.deepEqual(adapter.processUpdate(combat(3, 1, 'combatant-b', 'actor-b', 2), confirmed(2, false)), []);
  assert.deepEqual(adapter.processUpdate(combat(3, 1, 'combatant-c', 'actor-c', 3), confirmed(3)), []);
});

test('active combat switching is silent and updates to another combat only refresh its baseline', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([
    combat(1, 0, 'combatant-a', 'actor-a', 1, 'combat-1'),
    combat(1, 0, 'combatant-x', 'actor-x', 1, 'combat-2'),
  ], 'combat-1');

  adapter.setActiveCombat('combat-2');
  assert.deepEqual(adapter.processUpdate(combat(1, 1, 'combatant-y', 'actor-y', 2, 'combat-1'), confirmed(2)).map(event => event.kind), []);
  adapter.setActiveCombat('combat-1');
  assert.deepEqual(adapter.processUpdate(combat(1, 1, 'combatant-y', 'actor-y', 2, 'combat-1'), confirmed(2)), []);
  assert.deepEqual(adapter.processUpdate(combat(1, 2, 'combatant-z', 'actor-z', 3, 'combat-2'), confirmed(3)).map(event => event.kind), []);
});

test('quiet cleanup and round reset never emit; a later real restart starts a new combat lifecycle', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(2, 1, 'combatant-b', 'actor-b', 4)], 'combat-1');

  assert.deepEqual(adapter.processUpdate(combat(0, null, null, null, 5), confirmed(5)), []);
  assert.deepEqual(adapter.processUpdate(combat(1, 0, 'combatant-a', 'actor-a', 6), confirmed(6)).map(event => event.kind), ['combat-start', 'turn-start']);
  adapter.remove('combat-1');
  assert.deepEqual(adapter.processUpdate(combat(1, 1, 'combatant-b', 'actor-b', 7), confirmed(7)), []);
});

test('confirmed deletion ends a started active fight once using the last confirmed turn', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(3, 2, 'combatant-b', 'actor-b', 10)], 'combat-1');
  // Foundry may render/select the next tracker before deleteCombat arrives.
  adapter.setActiveCombat(null);
  const events = adapter.processDeletion('combat-1', { modifiedTime: 11, wasActive: true });
  assert.deepEqual(events, [{ id: 'v1:combat-1:11:delete:combat-end', kind: 'combat-end',
    combatId: 'combat-1', round: 3, turn: 2, combatantId: 'combatant-b', actorId: 'actor-b' }]);
  assert.deepEqual(adapter.processDeletion('combat-1', { modifiedTime: 11, wasActive: true }), []);
});

test('unstarted, inactive, unknown and unconfirmed deletions remain silent and remove their baselines', () => {
  for (const [round, wasActive, modifiedTime] of [[0, true, 11], [3, false, 11], [3, true, null]] as const) {
    const adapter = new CombatTriggerEventAdapter();
    adapter.initialize([combat(round, 0, 'combatant-a', 'actor-a', 10)], 'combat-1');
    assert.deepEqual(adapter.processDeletion('combat-1', { modifiedTime, wasActive }), []);
    assert.deepEqual(adapter.processDeletion('combat-1', { modifiedTime: 12, wasActive: true }), []);
    assert.deepEqual(adapter.processDeletion('missing', { modifiedTime: 12, wasActive: true }), []);
  }
});

test('stale or malformed deletion cannot discard a newer baseline', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(3, 2, 'combatant-b', 'actor-b', 10)], 'combat-1');
  assert.deepEqual(adapter.processDeletion('combat-1', { modifiedTime: 9, wasActive: true }), []);
  assert.throws(() => adapter.processDeletion('combat-1', { modifiedTime: NaN, wasActive: true }), TypeError);
  assert.throws(() => adapter.processDeletion('combat-1', { modifiedTime: 11, wasActive: undefined as unknown as boolean }), TypeError);
  assert.equal(adapter.processDeletion('combat-1', { modifiedTime: 11, wasActive: true }).length, 1);
});

test('peers identify the same confirmed end and a recreated fight has a new end identity', () => {
  const adapters = [new CombatTriggerEventAdapter(), new CombatTriggerEventAdapter()];
  const ends = adapters.map(adapter => {
    adapter.initialize([combat(2, null, null, null, 10)], 'combat-1');
    return adapter.processDeletion('combat-1', { modifiedTime: 11, wasActive: true });
  });
  assert.deepEqual(ends[0], ends[1]);
  const adapter = adapters[0]!;
  adapter.seed(combat(1, 0, 'combatant-a', 'actor-a', 12));
  const next = adapter.processDeletion('combat-1', { modifiedTime: 13, wasActive: true });
  assert.equal(next.length, 1);
  assert.notEqual(next[0]!.id, ends[0]![0]!.id);
});

test('stale callbacks are ignored without replacing the latest turn baseline', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(1, 0, 'combatant-a', 'actor-a', 10)], 'combat-1');

  assert.deepEqual(adapter.processUpdate(combat(1, 1, 'combatant-b', 'actor-b', 20), confirmed(20)).map(event => event.kind), ['turn-end', 'turn-start']);
  assert.deepEqual(adapter.processUpdate(combat(1, 0, 'combatant-a', 'actor-a', 19), confirmed(19)), []);
  assert.deepEqual(adapter.processUpdate(combat(1, 2, 'combatant-c', 'actor-c', 21), confirmed(21)).map(event => event.kind), ['turn-end', 'turn-start']);
});

test('turnEvents false suppresses output while recording the confirmed position transition', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(1, 0, 'combatant-a', 'actor-a')], 'combat-1');

  assert.deepEqual(adapter.processUpdate(combat(1, 1, 'combatant-b', 'actor-b', 2), confirmed(2, true, false)), []);
  const repeated = adapter.processUpdate(combat(1, 1, 'combatant-b', 'actor-b', 2), confirmed(2));
  assert.deepEqual(repeated, []);
  const back = adapter.processUpdate(combat(1, 0, 'combatant-a', 'actor-a', 2), confirmed(2));
  assert.deepEqual(back, []);
  const forward = adapter.processUpdate(combat(1, 1, 'combatant-b', 'actor-b', 2), confirmed(2));
  assert.equal(forward[0]?.id.includes(':1:turn-end') || forward[0]?.id.includes(':1:turn-start'), true);
});

test('switching viewed combat is a selector update, not a native combat event', () => {
  const adapter = new CombatTriggerEventAdapter();
  adapter.initialize([combat(6, 1, 'combatant-a', 'actor-a')], 'combat-1');
  adapter.setActiveCombat('combat-1');
  assert.deepEqual(adapter.processUpdate(combat(6, 1, 'combatant-a', 'actor-a', 2), {
    ...confirmed(2),
    positionFieldsChanged: false,
  }), []);
});
