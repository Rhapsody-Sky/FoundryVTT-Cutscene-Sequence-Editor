import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSequenceAudience } from '../src/application/audience-resolver.js';
import { withSequenceAudience } from '../src/domain/sequence-audience.js';
import { createBarsSequence } from '../src/domain/validation.js';

const users = [
  { id: 'gm', name: 'GM', role: 4, active: true },
  { id: 'a', name: 'A', role: 1, active: true },
  { id: 'b', name: 'B', role: 2, active: true },
  { id: 'offline', name: 'Offline', role: 1, active: false },
  { id: 'assistant', name: 'Assistant', role: 3, active: true }
];
function sequence() { let next = 0; return createBarsSequence('Audience', () => `id-${++next}`); }

test('legacy audience retains active players plus the directing GM', () => {
  const result = resolveSequenceAudience(sequence(), users, 'gm');
  assert.equal(result.includeGM, true);
  assert.deepEqual(result.players.map(user => user.id), ['a', 'b']);
  assert.deepEqual(result.unavailable, []);
});

test('selected identities are independent of names, ordering, and role upgrades', () => {
  const authored = withSequenceAudience(sequence(), { mode: 'selected', userIds: ['b', 'offline', 'removed', 'assistant', 'gm'], includeGM: false });
  const result = resolveSequenceAudience(authored, [...users].reverse(), 'gm');
  assert.equal(result.includeGM, false);
  assert.deepEqual(result.players.map(user => user.id), ['b']);
  assert.deepEqual(result.unavailable, [
    { userId: 'offline', reason: 'offline' }, { userId: 'removed', reason: 'removed' },
    { userId: 'assistant', reason: 'not-player' }, { userId: 'gm', reason: 'not-player' }
  ]);
});

test('empty and missing selections never fall back to all players or the GM', () => {
  for (const ids of [[], ['removed']]) {
    const authored = withSequenceAudience(sequence(), { mode: 'selected', userIds: ids, includeGM: false });
    const result = resolveSequenceAudience(authored, users, 'gm');
    assert.equal(result.includeGM, false);
    assert.deepEqual(result.players, []);
  }
});

test('all players can exclude the GM, and selected mode can explicitly include only the GM', () => {
  const all = resolveSequenceAudience(withSequenceAudience(sequence(), { mode: 'all', userIds: [], includeGM: false }), users, 'gm');
  assert.equal(all.includeGM, false); assert.deepEqual(all.players.map(user => user.id), ['a', 'b']);
  const gmOnly = resolveSequenceAudience(withSequenceAudience(sequence(), { mode: 'selected', userIds: [], includeGM: true }), users, 'gm');
  assert.equal(gmOnly.includeGM, true); assert.deepEqual(gmOnly.players, []);
});
