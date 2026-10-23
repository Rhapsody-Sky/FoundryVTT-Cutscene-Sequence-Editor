import test from 'node:test';
import assert from 'node:assert/strict';
import { createBarsSequence } from '../src/domain/validation.js';
import { applyOrchestrationRecord, initialOrchestration, eligibleLaunches, reduceOrchestration, scopedSession, normalizeOrchestrationState, ORCHESTRATION_LIMITS, type OrchestrationState, type OrchestrationCommand, type OrchestrationRecord } from '../src/playback/orchestration-protocol.js';
import { reduceSession, SessionProtocolError, sessionPosition, sessionPlayback, type SessionRecord } from '../src/playback/session-protocol.js';
const snapshot = createBarsSequence('Parallel', (() => { let n = 0; return () => `id-${++n}`; })());
function append(state: OrchestrationState, command: OrchestrationCommand, version: 1 | 2 | 3 | 4 = state.version, actor = 'gm'): OrchestrationState {
  return applyOrchestrationRecord(state, { index: state.head + 1, previous: state.head, requestId: `request-${state.head + 1}`, actor, payload: command, recordVersion: version }, id => id === 'gm' || id === 'assistant');
}
function owner(state: OrchestrationState) { return { sessionId: state.owner!.sessionId, generation: state.owner!.generation }; }
function acquired() { return append(initialOrchestration('root'), { kind: 'acquire', sessionId: 'gm-tab' }); }
function upgraded() { const state = acquired(); return append(state, { kind: 'upgrade', ...owner(state) }, 2); }
function enqueue(state: OrchestrationState, launchId: string, userIds: readonly string[]) { return append(state, { kind: 'enqueue', ...owner(state), launchId, snapshot, userIds }); }
function claim(state: OrchestrationState, launchId: string, runId = `${launchId}-run`) { return append(state, { kind: 'claim', ...owner(state), launchId, runId }); }
function prepare(state: OrchestrationState, launchId: string, recipients?: readonly { userId: string; sessionId: string }[]) {
  const launch = state.launches.find(item => item.launchId === launchId)!;
  return append(state, { kind: 'prepare', ...owner(state), runId: launch.runId!, snapshot: launch.snapshot,
    recipients: recipients ?? launch.userIds.map(userId => ({ userId, sessionId: `${userId}-tab` })) });
}
function start(state: OrchestrationState, runId: string, atServerMs = 1000) {
  return append(state, { kind: 'start', ...owner(state), runId, recipients: scopedSession(state, runId).run!.recipients, atServerMs });
}
function rejects(fn: () => unknown, code = 'SESSION_CONFLICT') { assert.throws(fn, error => error instanceof SessionProtocolError && error.code === code); }

test('upgrade is explicit, shares the old log and cannot change an active historical run', () => {
  const old = acquired();
  rejects(() => enqueue(old, 'new', ['a']), 'SESSION_INVALID');
  rejects(() => append(old, { kind: 'acquire', sessionId: 'other' }, 2));
  const preparing = append(old, { kind: 'prepare', ...owner(old), runId: 'old-run', snapshot, recipients: [{ userId: 'a', sessionId: 'a-tab' }] });
  rejects(() => append(preparing, { kind: 'upgrade', ...owner(preparing) }, 2));
  const stopped = append(preparing, { kind: 'stop', ...owner(preparing), runId: 'old-run' });
  const result = append(stopped, { kind: 'upgrade', ...owner(stopped) }, 2);
  assert.equal(result.version, 2);
  assert.deepEqual(result.closedRuns, ['old-run']);
  const records: OrchestrationRecord[] = [
    { index: 1, previous: 0, requestId: 'one', actor: 'gm', recordVersion: 1, payload: { kind: 'acquire', sessionId: 'gm-tab' } },
    { index: 2, previous: 1, requestId: 'two', actor: 'gm', recordVersion: 2, payload: { kind: 'upgrade', sessionId: 'gm-tab', generation: 'root:1' } }
  ];
  assert.equal(reduceOrchestration('root', records, () => true).head, 2);
  const legacyRecords = records.map(({ recordVersion: _version, ...record }) => record) as SessionRecord[];
  rejects(() => reduceSession('root', legacyRecords, () => true), 'SESSION_INVALID');
  rejects(() => append(result, { kind: 'revoke', generation: result.owner!.generation }, 1));
});

test('reservation is atomic per user across tabs; fairness allows independent groups', () => {
  let state = enqueue(upgraded(), 'a', ['a']);
  state = prepare(claim(state, 'a'), 'a', [{ userId: 'a', sessionId: 'tab-one' }]);
  state = enqueue(state, 'ab', ['a', 'b']);
  state = enqueue(state, 'b', ['b']);
  state = enqueue(state, 'c', ['c']);
  assert.deepEqual(eligibleLaunches(state).map(item => item.launchId), ['c']);
  rejects(() => claim(state, 'ab'));
  rejects(() => claim(state, 'b'));
  state = claim(state, 'c');
  assert.equal(state.launches.find(item => item.launchId === 'c')!.status, 'preparing');
  state = append(state, { kind: 'stop', ...owner(state), runId: 'a-run' });
  assert.deepEqual(eligibleLaunches(state).map(item => item.launchId), ['ab']);
  assert.deepEqual(state.closedLaunches, ['a']);
});

test('independent run clocks and stopping one preserve the other; revoke closes queue and attempts', () => {
  let state = enqueue(upgraded(), 'a', ['a']);
  state = start(prepare(claim(state, 'a'), 'a'), 'a-run', 1000);
  state = enqueue(state, 'b', ['b']);
  state = start(prepare(claim(state, 'b'), 'b'), 'b-run', 3000);
  assert.equal(sessionPosition(scopedSession(state, 'a-run').run!, 3500), 2500);
  assert.equal(sessionPosition(scopedSession(state, 'b-run').run!, 3500), 500);
  state = append(state, { kind: 'pause', ...owner(state), runId: 'a-run', positionMs: 400 });
  assert.equal(scopedSession(state, 'b-run').run!.atServerMs, 3000);
  state = append(state, { kind: 'stop', ...owner(state), runId: 'a-run' });
  assert.equal(state.runs.length, 1);
  state = enqueue(state, 'later', ['b']);
  state = enqueue(state, 'claimed', ['c']); state = claim(state, 'claimed');
  state = append(state, { kind: 'revoke', generation: state.owner!.generation }, 2, 'assistant');
  assert.equal(state.owner, null);
  assert.deepEqual(state.runs, []); assert.deepEqual(state.launches, []);
  assert.deepEqual(new Set(state.closedRuns), new Set(['a-run', 'b-run', 'claimed-run']));
  assert.deepEqual(new Set(state.closedLaunches), new Set(['a', 'b', 'later', 'claimed']));
});

test('failure releases reservation but blocks ordering; retry preserves position and rejects stale attempt replies', () => {
  let state = prepare(claim(enqueue(upgraded(), 'a', ['a']), 'a'), 'a');
  state = enqueue(state, 'same', ['a']); state = enqueue(state, 'other', ['b']);
  const order = state.launches[0]!.order;
  state = append(state, { kind: 'fail', ...owner(state), launchId: 'a', runId: 'a-run', error: 'media unavailable' });
  assert.deepEqual(eligibleLaunches(state).map(item => item.launchId), ['other']);
  state = append(state, { kind: 'retry', ...owner(state), launchId: 'a' });
  assert.equal(state.launches[0]!.order, order);
  rejects(() => claim(state, 'a', 'a-run'));
  state = prepare(claim(state, 'a', 'a-run-2'), 'a');
  rejects(() => append(state, { kind: 'start', ...owner(state), runId: 'a-run', recipients: [{ userId: 'a', sessionId: 'a-tab' }], atServerMs: 1000 }));
  rejects(() => append(state, { kind: 'fail', ...owner(state), launchId: 'a', runId: 'a-run', error: 'late' }));
  state = append(state, { kind: 'cancel', ...owner(state), launchId: 'a' });
  assert.deepEqual(eligibleLaunches(state).map(item => item.launchId), ['same', 'other']);
});

test('Record 2 preparation and start retain the full frozen audience and fixed browser identities', () => {
  let state = claim(enqueue(upgraded(), 'ab', ['a', 'b']), 'ab');
  rejects(() => append(state, { kind: 'prepare', ...owner(state), runId: 'ab-run', snapshot: { ...snapshot, name: 'changed' }, recipients: [{ userId: 'a', sessionId: 'a' }] }));
  rejects(() => prepare(state, 'ab', [{ userId: 'c', sessionId: 'c' }]));
  rejects(() => prepare(state, 'ab', [{ userId: 'b', sessionId: 'b-tab' }]));
  rejects(() => prepare(state, 'ab', [{ userId: 'a', sessionId: 'a-tab' }, { userId: 'a', sessionId: 'a-other-tab' }]));
  rejects(() => prepare(state, 'ab', [{ userId: 'a', sessionId: 'a-tab' }, { userId: 'a', sessionId: 'a-other-tab' }, { userId: 'b', sessionId: 'b-tab' }]));
  state = prepare(state, 'ab');
  rejects(() => append(state, { kind: 'start', ...owner(state), runId: 'ab-run', recipients: [state.runs[0]!.recipients[0]!], atServerMs: 1000 }));
  rejects(() => append(state, { kind: 'start', ...owner(state), runId: 'ab-run', recipients: [{ userId: 'a', sessionId: 'a-new-tab' }, { userId: 'b', sessionId: 'b-tab' }], atServerMs: 1000 }));
  rejects(() => append(state, { kind: 'start', ...owner(state), runId: 'ab-run', recipients: [state.runs[0]!.recipients[0]!, state.runs[0]!.recipients[0]!], atServerMs: 1000 }));
  const malformed = structuredClone(state);
  rejects(() => normalizeOrchestrationState({ ...malformed, runs: [{ ...malformed.runs[0]!, recipients: [malformed.runs[0]!.recipients[0]!] }] }), 'SESSION_INVALID');
  assert.ok(Object.isFrozen(normalizeOrchestrationState(malformed)));
  state = append(state, { kind: 'start', ...owner(state), runId: 'ab-run', recipients: [...state.runs[0]!.recipients].reverse(), atServerMs: 1000 });
  state = enqueue(state, 'b', ['b']);
  assert.deepEqual(eligibleLaunches(state), []);
  assert.equal(state.launches[0]!.userIds.length, 2);
  rejects(() => append(state, { kind: 'cancel', ...owner(state), launchId: 'ab' }));
});

test('Record 1 still accepts multiple browser tabs and a ready participant subset', () => {
  let state = acquired();
  const prepared = [{ userId: 'a', sessionId: 'a-first-tab' }, { userId: 'a', sessionId: 'a-second-tab' }, { userId: 'b', sessionId: 'b-tab' }];
  state = append(state, { kind: 'prepare', ...owner(state), runId: 'legacy', snapshot, recipients: prepared });
  state = append(state, { kind: 'start', ...owner(state), runId: 'legacy', recipients: [prepared[1]!], atServerMs: 1000 });
  assert.equal(state.version, 1);
  assert.deepEqual(state.runs[0]!.recipients, [prepared[1]!]);
  assert.deepEqual(normalizeOrchestrationState(structuredClone(state)).runs[0]!.recipients, [prepared[1]!]);
});

test('validation enforces lease, head, identity uniqueness, limits and frozen snapshots', () => {
  let state = upgraded();
  rejects(() => append(state, { kind: 'enqueue', ...owner(state), sessionId: 'other-tab', launchId: 'a', snapshot, userIds: ['a'] }), 'SESSION_UNAUTHORIZED');
  rejects(() => enqueue(state, 'empty', []), 'SESSION_INVALID');
  rejects(() => enqueue(state, 'duplicate', ['a', 'a']), 'SESSION_INVALID');
  rejects(() => enqueue(state, 'too-many', Array.from({ length: 101 }, (_, i) => `user-${i}`)), 'SESSION_INVALID');
  rejects(() => applyOrchestrationRecord(state, { index: 99, previous: 98, requestId: 'stale', actor: 'gm', payload: { kind: 'revoke', generation: state.owner!.generation }, recordVersion: 2 }, () => true));
  state = enqueue(state, 'frozen', ['a']);
  assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.launches[0]!.snapshot)); assert.ok(Object.isFrozen(state.launches[0]!.userIds));
  const cloned = structuredClone(state);
  rejects(() => applyOrchestrationRecord({ ...cloned, launches: [cloned.launches[0]!, cloned.launches[0]!] }, { index: cloned.head + 1, previous: cloned.head, requestId: 'x', actor: 'gm', recordVersion: 2, payload: { kind: 'revoke', generation: cloned.owner!.generation } }, () => true), 'SESSION_INVALID');
  for (let i = 1; i < ORCHESTRATION_LIMITS.launches; i++) state = enqueue(state, `launch-${i}`, [`user-${i}`]);
  rejects(() => enqueue(state, 'overflow', ['z']), 'SESSION_INVALID');
});

test('run limit includes claimed attempts, not merely prepared players', () => {
  let state = upgraded();
  for (let i = 0; i < ORCHESTRATION_LIMITS.activeRuns; i++) state = claim(enqueue(state, `launch-${i}`, [`user-${i}`]), `launch-${i}`);
  state = enqueue(state, 'overflow', ['independent']);
  assert.deepEqual(eligibleLaunches(state), []);
  rejects(() => claim(state, 'overflow'));
});

test('inner Break histories remain isolated per run and survive a cloned projection', () => {
  const inner = { ...snapshot, schemaVersion: 3 as const, end: { kind: 'manual' as const, durationMs: 3000 }, breaks: [{ id: 'first', positionMs: 500 }] };
  let state = upgraded();
  for (const id of ['a', 'b']) {
    state = append(state, { kind: 'enqueue', ...owner(state), launchId: id, snapshot: inner, userIds: [id] });
    state = start(prepare(claim(state, id), id), `${id}-run`, id === 'a' ? 1000 : 2000);
  }
  const continued = { kind: 'continue' as const, ...owner(state), runId: 'a-run', positionMs: 500, atServerMs: 3000,
    durationMs: inner.presentation.exitDurationMs, holdElapsedMs: 1500, exitFrom: 'holding' as const, breakId: 'first', expectedBreakHistoryLength: 0 };
  state = append(structuredClone(state), continued);
  assert.deepEqual(scopedSession(state, 'a-run').run!.breakHistory, [{ id: 'first', positionMs: 500, elapsedMs: 1500 }]);
  assert.deepEqual(scopedSession(state, 'b-run').run!.breakHistory, []);
  assert.equal(sessionPlayback(scopedSession(state, 'b-run').run!, 3000).phase, 'holding');
  rejects(() => append(state, continued));
  rejects(() => append({ ...structuredClone(state), runs: state.runs.map(run => run.runId === 'a-run' ? { ...run, breakHistory: [{ id: 'invented', positionMs: 500, elapsedMs: 1500 }] } : run) }, { kind: 'stop', ...owner(state), runId: 'a-run' }), 'SESSION_INVALID');
});

test('untrusted accessors, duplicate requests and reservation corruption fail closed', () => {
  const state = upgraded();
  let touched = false;
  const record = { index: state.head + 1, previous: state.head, actor: 'gm', recordVersion: 2 as const,
    get requestId() { touched = true; return 'evil'; }, payload: { kind: 'revoke' as const, generation: state.owner!.generation } };
  rejects(() => reduceOrchestration('root', [record], () => true), 'SESSION_INVALID');
  assert.equal(touched, false);
  const duplicate: OrchestrationRecord[] = [
    { index: 1, previous: 0, actor: 'gm', requestId: 'duplicate', recordVersion: 1, payload: { kind: 'acquire', sessionId: 'gm-tab' } },
    { index: 2, previous: 1, actor: 'gm', requestId: 'duplicate', recordVersion: 2, payload: { kind: 'upgrade', sessionId: 'gm-tab', generation: 'root:1' } }
  ];
  rejects(() => reduceOrchestration('root', duplicate, () => true));
  const hostileOwner = { ...state.owner, get generation() { touched = true; return state.owner!.generation; } };
  rejects(() => append({ ...structuredClone(state), owner: hostileOwner as typeof state.owner }, { kind: 'revoke', generation: state.owner!.generation }), 'SESSION_INVALID');
  assert.equal(touched, false);
});

const triggerEvent = { id: 'combat-change-1:turn-start', kind: 'turn-start' as const, combatId: 'combat', round: 1, turn: 0, combatantId: 'fighter', actorId: 'actor' };
const automaticSnapshot: typeof snapshot = { ...snapshot, schemaVersion: 4, playbackSchemaVersion: 1,
  launch: { version: 2, audience: { mode: 'selected', userIds: ['a'], includeGM: false },
    automation: { version: 1, enabled: true, rules: [{ id: 'rule', enabled: true, event: 'turn-start', actorId: 'actor' }] } } };
function automatic(state: OrchestrationState, launchId: string, eventId = triggerEvent.id, ruleId = 'rule') {
  return append(state, { kind: 'enqueue', ...owner(state), launchId, snapshot: automaticSnapshot, userIds: ['a'], mode: 'automatic',
    trigger: { event: { ...triggerEvent, id: eventId }, ruleId } });
}
function upgraded3() { const state = upgraded(); return append(state, { kind: 'upgrade3', ...owner(state) }, 3); }

test('combat-end context survives record validation while unsupported event kinds still fail', () => {
  const state = upgraded3();
  const ending: typeof snapshot = { ...automaticSnapshot, launch: { version: 2, audience: automaticSnapshot.launch!.audience,
    automation: { version: 1, enabled: true, rules: [{ id: 'end-rule', enabled: true, event: 'combat-end', actorId: null }] } } };
  const ended = { ...triggerEvent, id: 'v1:combat:101:delete:combat-end', kind: 'combat-end' as const };
  const command: OrchestrationCommand = { kind: 'enqueue', ...owner(state), launchId: 'end', snapshot: ending,
    userIds: ['a'], mode: 'automatic', trigger: { event: ended, ruleId: 'end-rule' } };
  const result = append(state, command);
  assert.deepEqual(normalizeOrchestrationState(structuredClone(result)).launches[0]!.trigger!.event, ended);
  const unknown = { ...command, trigger: { event: { ...ended, kind: 'round-end' }, ruleId: 'end-rule' } };
  rejects(() => append(state, unknown as OrchestrationCommand), 'SESSION_INVALID');
});

test('Record 3 explicitly upgrades only idle Record 2 and keeps all historical identities', () => {
  let state = enqueue(upgraded(), 'old', ['a']);
  rejects(() => append(state, { kind: 'upgrade3', ...owner(state) }, 3));
  state = prepare(claim(state, 'old'), 'old');
  rejects(() => append(state, { kind: 'upgrade3', ...owner(state) }, 3));
  state = append(state, { kind: 'cancel', ...owner(state), launchId: 'old' });
  const before = state;
  state = append(state, { kind: 'upgrade3', ...owner(state) }, 3);
  assert.equal(state.version, 3);
  assert.deepEqual(state.closedRuns, before.closedRuns); assert.deepEqual(state.closedLaunches, ['old']);
  rejects(() => append(state, { kind: 'revoke', generation: state.owner!.generation }, 2));
  rejects(() => automatic(upgraded(), 'too-old'), 'SESSION_INVALID');
  rejects(() => append(acquired(), { kind: 'upgrade3', ...owner(acquired()) }, 3));
});

test('automatic admission dedupe survives Retry, Cancel, Stop and Revoke and keeps the exact event context', () => {
  let state = automatic(upgraded3(), 'one');
  const trigger = structuredClone(state.launches[0]!.trigger);
  rejects(() => automatic(state, 'duplicate'));
  state = claim(state, 'one');
  state = append(state, { kind: 'fail', ...owner(state), launchId: 'one', runId: 'one-run', error: 'media' });
  state = append(state, { kind: 'retry', ...owner(state), launchId: 'one' });
  assert.deepEqual(state.launches[0]!.trigger, trigger);
  state = start(prepare(claim(state, 'one', 'retry-run'), 'one'), 'retry-run');
  state = append(state, { kind: 'stop', ...owner(state), runId: 'retry-run' });
  rejects(() => automatic(state, 'after-stop'));
  state = automatic(state, 'two', 'event-2');
  state = append(state, { kind: 'cancel', ...owner(state), launchId: 'two' });
  rejects(() => automatic(state, 'after-cancel', 'event-2'));
  state = automatic(state, 'three', 'event-3');
  state = append(state, { kind: 'revoke', generation: state.owner!.generation });
  assert.equal(state.automaticAdmissions.length, 3);
  state = append(state, { kind: 'acquire', sessionId: 'gm-tab' });
  rejects(() => automatic(state, 'after-revoke', 'event-3'));
  assert.ok(Object.isFrozen(state.automaticAdmissions));
});

test('automatic admission keys distinguish event, sequence and rule while overlap order remains atomic', () => {
  const twoRules = { ...automaticSnapshot, launch: { ...automaticSnapshot.launch!, version: 2 as const,
    automation: { version: 1 as const, enabled: true, rules: [
      { id: 'rule', enabled: true, event: 'turn-start' as const, actorId: 'actor' },
      { id: 'second', enabled: true, event: 'turn-start' as const, actorId: null }
    ] } } };
  let state = automatic(upgraded3(), 'first'); state = claim(state, 'first');
  state = append(state, { kind: 'enqueue', ...owner(state), launchId: 'second', snapshot: twoRules, userIds: ['a', 'b'], mode: 'automatic', trigger: { event: triggerEvent, ruleId: 'second' } });
  state = append(state, { kind: 'enqueue', ...owner(state), launchId: 'other-sequence', snapshot: { ...automaticSnapshot, id: 'different' }, userIds: ['c'], mode: 'automatic', trigger: { event: triggerEvent, ruleId: 'rule' } });
  state = enqueue(state, 'later-b', ['b']);
  assert.deepEqual(eligibleLaunches(state).map(item => item.launchId), ['other-sequence']);
  assert.equal(state.automaticAdmissions.length, 3);
  assert.deepEqual(normalizeOrchestrationState(structuredClone(state)).automaticAdmissions, state.automaticAdmissions);
});

test('automatic registry limits reject new events without pruning and reject forged rule/context projections', () => {
  const full = normalizeOrchestrationState({ ...structuredClone(upgraded3()), automaticAdmissions: Array.from({ length: ORCHESTRATION_LIMITS.automaticAdmissions }, (_, index) => ({ eventId: `event-${index}`, sequenceId: 'sequence', ruleId: 'rule' })) });
  rejects(() => automatic(full, 'overflow'), 'SESSION_INVALID'); assert.equal(full.automaticAdmissions.length, ORCHESTRATION_LIMITS.automaticAdmissions);
  const state = upgraded3();
  rejects(() => automatic(state, 'unknown-rule', triggerEvent.id, 'absent'), 'SESSION_INVALID');
  rejects(() => automatic(state, 'oversized-event', 'x'.repeat(257)), 'SESSION_INVALID');
  const launched = automatic(state, 'one');
  rejects(() => normalizeOrchestrationState({ ...structuredClone(launched), automaticAdmissions: [] }), 'SESSION_INVALID');
  rejects(() => normalizeOrchestrationState({ ...structuredClone(launched), automaticAdmissions: [launched.automaticAdmissions[0]!, launched.automaticAdmissions[0]!] }), 'SESSION_INVALID');
});

test('authority epoch records every acquisition/revocation and remains stable across upgrades and normal queue writes', () => {
  let state = acquired(); assert.equal(state.authorityEpoch, state.head);
  const acquisition = state.authorityEpoch;
  state = append(state, { kind: 'upgrade', ...owner(state) }, 2);
  state = append(state, { kind: 'upgrade3', ...owner(state) }, 3);
  state = automatic(state, 'launch'); state = claim(state, 'launch');
  assert.equal(state.authorityEpoch, acquisition);
  state = append(state, { kind: 'revoke', generation: state.owner!.generation });
  assert.equal(state.authorityEpoch, state.head); const revocation = state.authorityEpoch;
  state = append(state, { kind: 'acquire', sessionId: 'gm-tab' });
  assert.equal(state.authorityEpoch, revocation + 1);
  assert.equal(normalizeOrchestrationState(structuredClone(state)).authorityEpoch, state.authorityEpoch);
});
