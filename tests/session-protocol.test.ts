import test from 'node:test';
import assert from 'node:assert/strict';
import { createBarsSequence } from '../src/domain/validation.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';
import {
  applySessionRecord,
  initialSession,
  reduceSession,
  sessionPosition,
  sessionPlayback,
  SESSION_LIMITS,
  SessionProtocolError,
  type Participant,
  type SessionCommand,
  type SessionRecord,
  type SessionState
} from '../src/playback/session-protocol.js';

function ids(prefix = 'id') {
  let index = 0;
  return () => `${prefix}_${++index}`;
}

function sequence(): SequenceV1 {
  return createBarsSequence('Protocol test', ids('sequence'));
}

function record(index: number, previous: number, actor: string, payload: SessionCommand, requestId = `request_${index}`): SessionRecord {
  return { index, previous, actor, requestId, payload };
}

function code(error: unknown): unknown {
  return error instanceof SessionProtocolError ? error.code : undefined;
}

function rejectsCode(operation: () => unknown, expected: string): void {
  assert.throws(operation, error => {
    assert.equal(code(error), expected);
    return true;
  });
}

function append(state: SessionState, payload: SessionCommand, actor = 'gm-a', requestId?: string): SessionState {
  const index = state.head + 1;
  const next = record(index, state.head, actor, payload, requestId ?? `request_${index}`);
  return applySessionRecord(state, next, id => id === 'gm-a' || id === 'gm-b');
}

function acquire(state = initialSession('root-main'), actor = 'gm-a', sessionId = 'tab-a'): SessionState {
  return applySessionRecord(
    state,
    record(state.head + 1, state.head, actor, { kind: 'acquire', sessionId }),
    id => id === 'gm-a' || id === 'gm-b'
  );
}

const recipients: readonly Participant[] = [
  { userId: 'user-c', sessionId: 'browser-c' },
  { userId: 'user-a', sessionId: 'browser-a' },
  { userId: 'user-b', sessionId: 'browser-b' }
];

test('ordinary schema 2 paused fades retain silence without a Break clock', () => {
  const acquired = acquire(); const owner = acquired.owner!;
  const owned = { sessionId: owner.sessionId, generation: owner.generation, runId: 'paused-exit' };
  const prepared = append(acquired, { kind: 'prepare', ...owned,
    snapshot: { ...sequence(), schemaVersion: 2 }, recipients });
  const started = append(prepared, { kind: 'start', ...owned, recipients, atServerMs: 1_000 });
  const paused = append(started, { kind: 'pause', ...owned, positionMs: 500 });
  const fade = { kind: 'fade' as const, ...owned, positionMs: 500, atServerMs: 2_000, durationMs: 400, exitFrom: 'paused' as const };
  const exiting = append(paused, fade);
  assert.equal(exiting.run!.exitFrom, 'paused');
  assert.equal(exiting.run!.holdElapsedMs, undefined);
  assert.deepEqual(sessionPlayback(JSON.parse(JSON.stringify(exiting.run)), 2_200), { phase: 'exiting', positionMs: 500, exitFrom: 'paused' });
  rejectsCode(() => append(paused, { ...fade, holdElapsedMs: 0 }), 'SESSION_INVALID');
  rejectsCode(() => append(started, fade), 'SESSION_INVALID');
  rejectsCode(() => append(paused, { ...fade, kind: 'continue' }), 'SESSION_CONFLICT');
});

test('ledger slots are contiguous and duplicate or stale entries conflict', () => {
  const initial = initialSession('root-main');
  const first = record(1, 0, 'gm-a', { kind: 'acquire', sessionId: 'tab-a' }, 'same-request');
  const state = applySessionRecord(initial, first, id => id === 'gm-a');

  assert.equal(state.head, 1);
  assert.deepEqual(state.owner, { userId: 'gm-a', sessionId: 'tab-a', generation: 'root-main:1' });
  rejectsCode(() => applySessionRecord(state, first, id => id === 'gm-a'), 'SESSION_CONFLICT');
  rejectsCode(() => applySessionRecord(state, record(3, 1, 'gm-a', { kind: 'revoke', generation: state.owner!.generation }), id => id === 'gm-a'), 'SESSION_CONFLICT');

  rejectsCode(() => reduceSession('root-main', [
    first,
    record(2, 1, 'gm-a', { kind: 'revoke', generation: state.owner!.generation }, 'same-request')
  ], id => id === 'gm-a'), 'SESSION_CONFLICT');
});

function breakStarted(): SessionState {
  const acquired = acquire(), owner = acquired.owner!;
  const snapshot: SequenceV1 = { ...sequence(), schemaVersion: 2, end: { kind: 'manual', durationMs: 1_000 } };
  const prepared = append(acquired, { kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-break', snapshot, recipients });
  return append(prepared, { kind: 'start', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-break', recipients, atServerMs: 1_000 });
}

function breakOwned(state: SessionState) {
  return { sessionId: state.owner!.sessionId, generation: state.owner!.generation, runId: state.run!.runId };
}

function innerStarted(manual = true): SessionState {
  const acquired = acquire(), owned = { sessionId: acquired.owner!.sessionId, generation: acquired.owner!.generation, runId: 'inner-run' };
  const snapshot: SequenceV1 = { ...sequence(), schemaVersion: 3,
    end: manual ? { kind: 'manual', durationMs: 3_000 } : { kind: 'fixed', durationMs: 3_000 },
    breaks: [{ id: 'second', positionMs: 2_000 }, { id: 'first', positionMs: 500 },
      { id: 'endpoint', positionMs: 3_000 }, { id: 'outside', positionMs: 4_000 }] };
  const prepared = append(acquired, { kind: 'prepare', ...owned, snapshot, recipients });
  return append(prepared, { kind: 'start', ...owned, recipients, atServerMs: 1_000 });
}

function innerContinue(state: SessionState, now: number): Extract<SessionCommand, { kind: 'fade' | 'continue' }> {
  const playback = sessionPlayback(state.run!, now);
  return { kind: 'continue', ...breakOwned(state), positionMs: playback.positionMs, atServerMs: now,
    durationMs: state.run!.snapshot.presentation.exitDurationMs, holdElapsedMs: playback.holdElapsedMs!,
    exitFrom: playback.phase === 'paused' ? 'paused-holding' : 'holding', expectedBreakHistoryLength: state.run!.breakHistory!.length,
    ...(playback.breakId !== undefined ? { breakId: playback.breakId } : {}) };
}

test('inner Break projection catches the first skipped marker and Continue consumes chronological history without a fade', () => {
  let state = innerStarted();
  assert.deepEqual(sessionPlayback(state.run!, 1_499), { phase: 'playing', positionMs: 499, breakHistory: [] });
  assert.deepEqual(sessionPlayback(state.run!, 9_000), { phase: 'holding', positionMs: 500, holdElapsedMs: 7_500, breakId: 'first', breakHistory: [] });
  state = append(state, innerContinue(state, 9_000));
  assert.equal(state.run!.phase, 'playing');
  assert.deepEqual(state.run!.breakHistory, [{ id: 'first', positionMs: 500, elapsedMs: 7_500 }]);
  assert.equal(Object.hasOwn(state.run!, 'holdElapsedMs'), false);
  assert.equal(Object.hasOwn(state.run!, 'breakId'), false);
  assert.equal(sessionPlayback(state.run!, 10_499).positionMs, 1_999);
  assert.equal(sessionPlayback(state.run!, 10_500).breakId, 'second');
  state = append(state, innerContinue(state, 11_000));
  assert.equal(sessionPlayback(state.run!, 12_000).breakId, undefined);
  assert.equal(sessionPlayback(state.run!, 12_000).phase, 'holding');
  assert.equal(sessionPlayback(state.run!, 12_000).positionMs, 3_000);
  const exiting = append(state, innerContinue(state, 12_100));
  assert.equal(exiting.run!.phase, 'exiting');
  assert.equal(exiting.run!.breakHistory!.length, 2);
  assert.ok(Object.isFrozen(exiting.run!.breakHistory));
  assert.ok(Object.isFrozen(exiting.run!.breakHistory![0]));
});

test('inner hold pause/resume excludes ordinary pause time and rebuild retains all clocks', () => {
  const started = innerStarted(), owned = breakOwned(started);
  const paused = append(started, { kind: 'pause', ...owned, positionMs: 500, atServerMs: 1_800,
    pausedFrom: 'holding', holdElapsedMs: 300, breakId: 'first' });
  assert.equal(sessionPlayback(paused.run!, 9_000).holdElapsedMs, 300);
  const resumed = append(JSON.parse(JSON.stringify(paused)) as SessionState,
    { kind: 'resume', ...owned, positionMs: 500, atServerMs: 9_000 });
  assert.equal(sessionPlayback(resumed.run!, 9_200).holdElapsedMs, 500);
  const continued = append(resumed, innerContinue(resumed, 9_200));
  assert.equal(continued.run!.breakHistory![0]!.elapsedMs, 500);
  assert.deepEqual(sessionPlayback(JSON.parse(JSON.stringify(continued.run)), 10_800), sessionPlayback(continued.run!, 10_800));
  const faded = append(paused, { kind: 'fade', ...owned, positionMs: 500, atServerMs: 9_000,
    durationMs: 250, holdElapsedMs: 300, breakId: 'first', exitFrom: 'paused-holding' });
  assert.equal(sessionPlayback(faded.run!, 9_100).holdElapsedMs, 300);
});

test('schema 3 rejects unsupported, duplicate, stale, and invented Continue/clock/history shapes', () => {
  const started = innerStarted(), first = innerContinue(started, 2_000);
  const { expectedBreakHistoryLength, ...unsupported } = first;
  const { breakId, ...untargeted } = first;
  rejectsCode(() => append(started, unsupported), 'SESSION_CONFLICT');
  rejectsCode(() => append(started, untargeted), 'SESSION_CONFLICT');
  rejectsCode(() => append(started, { ...first, holdElapsedMs: 0 }), 'SESSION_INVALID');
  rejectsCode(() => append(started, { ...first, positionMs: 2_000 }), 'SESSION_INVALID');
  rejectsCode(() => append(started, { kind: 'pause', ...breakOwned(started), positionMs: 2_000 }), 'SESSION_INVALID');
  const continued = append(started, first);
  rejectsCode(() => append(continued, first), 'SESSION_CONFLICT');
  rejectsCode(() => append(continued, { ...first, atServerMs: 4_000, positionMs: 2_000, holdElapsedMs: 500, breakId: 'second' }), 'SESSION_CONFLICT');
  rejectsCode(() => append(started, first, 'gm-b'), 'SESSION_UNAUTHORIZED');
  const invalid = { ...continued, run: { ...continued.run!, breakHistory: [{ id: 'second', positionMs: 500, elapsedMs: 500 }] } };
  rejectsCode(() => append(invalid, { kind: 'stop', ...breakOwned(started) }), 'SESSION_INVALID');
  const legacy = breakStarted();
  rejectsCode(() => append(legacy, { ...innerContinue(started, 2_000), ...breakOwned(legacy) }), 'SESSION_INVALID');
});

test('restored paused/exiting positive and manual terminal Breaks require their holding origin', () => {
  const first = innerStarted();
  let terminal = append(first, innerContinue(first, 2_000));
  terminal = append(terminal, innerContinue(terminal, 4_000));
  for (const state of [first, terminal]) {
    const positionMs = state === first ? 500 : 3_000;
    for (const fields of [{ phase: 'paused' as const }, { phase: 'exiting' as const },
      { phase: 'exiting' as const, exitFrom: 'paused' as const }]) {
      const restored = JSON.parse(JSON.stringify({ ...state, run: { ...state.run!, ...fields, positionMs, atServerMs: 5_000 } }));
      rejectsCode(() => sessionPlayback(restored.run, 5_100), 'SESSION_INVALID');
      rejectsCode(() => append(restored, { kind: 'stop', ...breakOwned(state) }), 'SESSION_INVALID');
    }
  }
  const firstExit = append(first, { kind: 'fade', ...breakOwned(first), positionMs: 500, atServerMs: 2_000,
    durationMs: 250, exitFrom: 'holding', breakId: 'first', holdElapsedMs: 500 });
  assert.equal(sessionPlayback(JSON.parse(JSON.stringify(firstExit.run)), 2_100).holdElapsedMs, 600);
  const terminalExit = append(terminal, { kind: 'fade', ...breakOwned(terminal), positionMs: 3_000, atServerMs: 5_100,
    durationMs: 250, exitFrom: 'holding', holdElapsedMs: 100 });
  assert.equal(sessionPlayback(JSON.parse(JSON.stringify(terminalExit.run)), 5_200).holdElapsedMs, 200);
});

test('fixed sequence end ignores endpoint/outside markers after inner Breaks and preserves historical replay', () => {
  const records: SessionRecord[] = [];
  let state = initialSession('root-main');
  const source = innerStarted(false);
  const owned = { sessionId: 'tab-a', generation: 'root-main:1', runId: 'inner-run' };
  const commands: SessionCommand[] = [{ kind: 'acquire', sessionId: 'tab-a' },
    { kind: 'prepare', ...owned, snapshot: source.run!.snapshot, recipients },
    { kind: 'start', ...owned, recipients, atServerMs: 1_000 }];
  for (const command of commands) {
    const entry = record(state.head + 1, state.head, 'gm-a', command); records.push(entry);
    state = applySessionRecord(state, entry, () => true);
  }
  for (const now of [2_000, 4_000]) {
    const entry = record(state.head + 1, state.head, 'gm-a', innerContinue(state, now)); records.push(entry);
    state = applySessionRecord(state, entry, () => true);
  }
  assert.equal(sessionPlayback(state.run!, 5_000).phase, 'exiting');
  assert.equal(sessionPlayback(state.run!, 5_000).positionMs, 3_000);
  assert.deepEqual(reduceSession('root-main', records, () => true), state);
  const revoked = append(state, { kind: 'revoke', generation: state.owner!.generation }, 'gm-b');
  const reacquired = acquire(revoked, 'gm-b', 'tab-b');
  rejectsCode(() => append(reacquired, innerContinue(state, 4_500)), 'SESSION_UNAUTHORIZED');
});

test('serialized group Break history preserves Finish source progress and each Continue resynchronizes Loop', () => {
  const acquired = acquire(), owned = { sessionId: acquired.owner!.sessionId, generation: acquired.owner!.generation, runId: 'media-history' };
  const base = innerStarted().run!.snapshot;
  const none = { preset: 'none', version: 1 } as const;
  const snapshot: SequenceV1 = { ...base,
    tracks: [...base.tracks, ...['finish', 'loop'].map((id, index) => ({ id, name: id, kind: 'audio' as const, enabled: true, locked: false, order: index + 1 }))],
    clips: [...base.clips, ...(['finish', 'loop'] as const).map(id => ({ id, trackId: id, type: 'audio' as const, typeVersion: 3 as const,
      startMs: 0, duration: { kind: 'sequence-end' as const }, entrance: none, exit: none,
      properties: { source: { kind: 'foundry-file' as const, path: `${id}.ogg` }, volume: 1, muted: false,
        durationMs: 2_500, loop: true, loopIndefinitely: true, onBreak: id } }))] };
  let state = append(acquired, { kind: 'prepare', ...owned, snapshot, recipients });
  state = append(state, { kind: 'start', ...owned, recipients, atServerMs: 1_000 });
  function media(at: number, run = state.run!) {
    const playback = sessionPlayback(run, at);
    return evaluate(compileSequence(run.snapshot), playback.positionMs, {
      breakHistory: playback.breakHistory!,
      ...(playback.holdElapsedMs !== undefined ? { holding: { elapsedMs: playback.holdElapsedMs, paused: playback.phase === 'paused' } } : {})
    });
  }
  assert.equal(media(2_000).find(item => item.clip.id === 'finish')!.mediaTimeMs, 1_000);
  state = append(state, innerContinue(state, 2_000));
  assert.equal(media(2_000).find(item => item.clip.id === 'finish')!.mediaTimeMs, 1_000);
  assert.equal(media(2_000).find(item => item.clip.id === 'loop')!.mediaTimeMs, 500);
  assert.equal(media(3_500).find(item => item.clip.id === 'finish')!.mediaPlayback, 'finished');
  assert.equal(media(4_500).find(item => item.clip.id === 'loop')!.mediaTimeMs, 500);
  state = append(state, innerContinue(state, 4_500));
  const restored = JSON.parse(JSON.stringify(state.run!));
  assert.equal(media(4_500, restored).find(item => item.clip.id === 'finish')!.mediaPlayback, 'finished');
  assert.equal(media(4_500, restored).find(item => item.clip.id === 'loop')!.mediaTimeMs, 2_000);
  assert.equal(media(5_500, restored).find(item => item.clip.id === 'finish')!.mediaTimeMs, 2_500);
});

test('schema 2 manual endpoints derive holding without changing the ledger or legacy manual clocks', () => {
  const state = breakStarted(), run = state.run!;
  assert.deepEqual(sessionPlayback(run, 1_999), { phase: 'playing', positionMs: 999 });
  assert.deepEqual(sessionPlayback(run, 2_000), { phase: 'holding', positionMs: 1_000, holdElapsedMs: 0 });
  assert.deepEqual(sessionPlayback(run, 12_345), { phase: 'holding', positionMs: 1_000, holdElapsedMs: 10_345 });
  assert.equal(state.head, 3);
  assert.equal(run.phase, 'playing');
  assert.equal(sessionPlayback(run, Number.MAX_SAFE_INTEGER).holdElapsedMs, SESSION_LIMITS.positionMs);
  const old = { ...run, snapshot: { ...run.snapshot, schemaVersion: 1 as const, end: { kind: 'manual' as const } } };
  assert.deepEqual(sessionPlayback(old, 12_345), { phase: 'playing', positionMs: 11_345 });
  assert.equal(Object.hasOwn(run, 'holdElapsedMs'), false);
});

test('held pause freezes the media clock, resume advances it, and Continue preserves it under the common exit', () => {
  const started = breakStarted(), owned = breakOwned(started);
  const paused = append(started, { kind: 'pause', ...owned, positionMs: 1_000, atServerMs: 2_400,
    holdElapsedMs: 400, pausedFrom: 'holding' });
  assert.deepEqual(sessionPlayback(paused.run!, 8_000), { phase: 'paused', positionMs: 1_000, holdElapsedMs: 400, pausedFrom: 'holding' });
  const resumed = append(JSON.parse(JSON.stringify(paused)) as SessionState,
    { kind: 'resume', ...owned, positionMs: 1_000, atServerMs: 9_000 });
  assert.deepEqual(sessionPlayback(resumed.run!, 9_250), { phase: 'holding', positionMs: 1_000, holdElapsedMs: 650 });
  const exiting = append(resumed, { kind: 'continue', ...owned, positionMs: 1_000, atServerMs: 9_250,
    durationMs: 250, holdElapsedMs: 650, exitFrom: 'holding' });
  assert.deepEqual(sessionPlayback(exiting.run!, 9_350), { phase: 'exiting', positionMs: 1_000, holdElapsedMs: 750, exitFrom: 'holding' });
  assert.equal(exiting.run!.pausedFrom, undefined);
  const frozenExit = append(paused, { kind: 'continue', ...owned, positionMs: 1_000, atServerMs: 9_000,
    durationMs: 250, holdElapsedMs: 400, exitFrom: 'paused-holding' });
  assert.deepEqual(sessionPlayback(frozenExit.run!, 9_100), { phase: 'exiting', positionMs: 1_000, holdElapsedMs: 400, exitFrom: 'paused-holding' });
  const faded = append(started, { kind: 'fade', ...owned, positionMs: 1_000, atServerMs: 2_400,
    durationMs: 100, holdElapsedMs: 400, exitFrom: 'holding' });
  assert.equal(sessionPlayback(faded.run!, 2_450).holdElapsedMs, 450);
});

test('Continue cannot target preparation, ordinary pauses, an early endpoint, another actor, or a stale chain', () => {
  const started = breakStarted(), owned = breakOwned(started);
  const valid: SessionCommand = { kind: 'continue', ...owned, positionMs: 1_000, atServerMs: 2_000,
    durationMs: 250, holdElapsedMs: 0, exitFrom: 'holding' };
  rejectsCode(() => append(started, { ...valid, atServerMs: 1_999 }), 'SESSION_CONFLICT');
  rejectsCode(() => append(started, valid, 'gm-b'), 'SESSION_UNAUTHORIZED');
  rejectsCode(() => append(started, { ...valid, sessionId: 'other-tab' }), 'SESSION_UNAUTHORIZED');
  rejectsCode(() => append(started, { ...valid, generation: 'root-main:99' }), 'SESSION_CONFLICT');
  rejectsCode(() => append(started, { ...valid, runId: 'other-run' }), 'SESSION_CONFLICT');
  rejectsCode(() => applySessionRecord(started, record(4, 2, 'gm-a', valid), () => true), 'SESSION_CONFLICT');
  const ordinaryPause = append(started, { kind: 'pause', ...owned, positionMs: 500 });
  rejectsCode(() => append(ordinaryPause, valid), 'SESSION_CONFLICT');
  const preparing = { ...started, run: { ...started.run!, phase: 'preparing' as const, positionMs: 0, atServerMs: 0 } };
  rejectsCode(() => append(preparing, valid), 'SESSION_CONFLICT');
});

test('untrusted held payloads and states reject invented positions, elapsed clocks, origins, and legacy extensions', () => {
  const started = breakStarted(), owned = breakOwned(started);
  const pause: SessionCommand = { kind: 'pause', ...owned, positionMs: 1_000, atServerMs: 2_100, holdElapsedMs: 100, pausedFrom: 'holding' };
  for (const invalid of [
    { ...pause, positionMs: 999 }, { ...pause, holdElapsedMs: 101 }, { ...pause, holdElapsedMs: NaN },
    { ...pause, holdElapsedMs: SESSION_LIMITS.positionMs + 1 }, { ...pause, pausedFrom: 'playing' },
    { ...pause, atServerMs: undefined }, { ...pause, holdElapsedMs: undefined }
  ]) rejectsCode(() => append(started, invalid as SessionCommand), 'SESSION_INVALID');
  rejectsCode(() => append(started, { kind: 'pause', ...owned, positionMs: 1_000 }), 'SESSION_INVALID');
  const validExit: SessionCommand = { kind: 'continue', ...owned, positionMs: 1_000, atServerMs: 2_100,
    durationMs: 250, holdElapsedMs: 100, exitFrom: 'holding' };
  for (const invalid of [ { ...validExit, positionMs: 999 }, { ...validExit, exitFrom: 'paused-holding' },
    { ...validExit, holdElapsedMs: 0 }, { ...validExit, exitFrom: undefined }, { ...validExit, durationMs: -1 } ]) {
    rejectsCode(() => append(started, invalid as SessionCommand), 'SESSION_INVALID');
  }
  const paused = append(started, pause);
  const stop: SessionCommand = { kind: 'stop', ...owned };
  for (const run of [
    { ...paused.run!, positionMs: 999 }, { ...paused.run!, holdElapsedMs: Infinity },
    { ...paused.run!, pausedFrom: undefined }, { ...paused.run!, phase: 'playing' },
    { ...paused.run!, exitFrom: 'holding' },
    { ...paused.run!, snapshot: { ...paused.run!.snapshot, schemaVersion: 1 } }
  ]) rejectsCode(() => append({ ...paused, run } as SessionState, stop), 'SESSION_INVALID');
  rejectsCode(() => append(paused, { kind: 'resume', ...owned, positionMs: 1_000, atServerMs: 2_099 }), 'SESSION_INVALID');
});

test('one GM lease excludes another GM and a second tab of the same GM', () => {
  const state = acquire();
  const secondTab = record(2, 1, 'gm-a', { kind: 'acquire', sessionId: 'tab-b' });
  const secondGm = record(2, 1, 'gm-b', { kind: 'acquire', sessionId: 'tab-c' });
  rejectsCode(() => applySessionRecord(state, secondTab, id => id === 'gm-a' || id === 'gm-b'), 'SESSION_CONFLICT');
  rejectsCode(() => applySessionRecord(state, secondGm, id => id === 'gm-a' || id === 'gm-b'), 'SESSION_CONFLICT');

  const wrongTabPrepare = record(2, 1, 'gm-a', {
    kind: 'prepare', sessionId: 'tab-b', generation: state.owner!.generation,
    runId: 'run-tab', snapshot: sequence(), recipients
  });
  rejectsCode(() => applySessionRecord(state, wrongTabPrepare, id => id === 'gm-a' || id === 'gm-b'), 'SESSION_UNAUTHORIZED');

  const otherGmPrepare = record(2, 1, 'gm-b', {
    kind: 'prepare', sessionId: state.owner!.sessionId, generation: state.owner!.generation,
    runId: 'run-gm', snapshot: sequence(), recipients
  });
  rejectsCode(() => applySessionRecord(state, otherGmPrepare, id => id === 'gm-a' || id === 'gm-b'), 'SESSION_UNAUTHORIZED');
});

test('a GM can revoke the matching generation; stale former-owner intent cannot follow reacquisition', () => {
  const acquired = acquire();
  const oldOwner = acquired.owner!;
  const prepared = append(acquired, {
    kind: 'prepare', sessionId: oldOwner.sessionId, generation: oldOwner.generation,
    runId: 'run-old', snapshot: sequence(), recipients
  });

  const revoked = append(prepared, { kind: 'revoke', generation: oldOwner.generation }, 'gm-b');
  assert.equal(revoked.owner, null);
  assert.equal(revoked.run, null);
  assert.deepEqual(revoked.closedRuns, ['run-old']);

  const reacquired = acquire(revoked, 'gm-b', 'tab-b');
  assert.equal(reacquired.owner?.generation, 'root-main:4');
  rejectsCode(() => applySessionRecord(reacquired, record(5, 4, 'gm-a', {
    kind: 'start', sessionId: oldOwner.sessionId, generation: oldOwner.generation,
    runId: 'run-old', recipients: [recipients[0]!], atServerMs: 5_000
  }), id => id === 'gm-a' || id === 'gm-b'), 'SESSION_UNAUTHORIZED');
});

test('stop and revoke close run IDs permanently', () => {
  const acquired = acquire();
  const owner = acquired.owner!;
  const prepared = append(acquired, {
    kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-terminal', snapshot: sequence(), recipients
  });
  const playing = append(prepared, {
    kind: 'start', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-terminal', recipients: [recipients[0]!], atServerMs: 1_000
  });
  const stopped = append(playing, {
    kind: 'stop', sessionId: owner.sessionId, generation: owner.generation, runId: 'run-terminal'
  });

  assert.equal(stopped.run, null);
  assert.deepEqual(stopped.closedRuns, ['run-terminal']);
  rejectsCode(() => append(stopped, {
    kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-terminal', snapshot: sequence(), recipients
  }), 'SESSION_CONFLICT');
  rejectsCode(() => append(stopped, {
    kind: 'stop', sessionId: owner.sessionId, generation: owner.generation, runId: 'run-terminal'
  }), 'SESSION_CONFLICT');
});

test('prepare stores an isolated, deeply frozen playable snapshot', () => {
  const draft = sequence();
  const acquired = acquire();
  const owner = acquired.owner!;
  const prepared = append(acquired, {
    kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-snapshot', snapshot: draft, recipients
  });

  (draft as { name: string }).name = 'Edited after prepare';
  assert.equal(prepared.run?.snapshot.name, 'Protocol test');
  assert.notEqual(prepared.run?.snapshot, draft);
  assert.ok(Object.isFrozen(prepared.run?.snapshot));
  assert.ok(Object.isFrozen(prepared.run?.snapshot.tracks));
  assert.ok(Object.isFrozen(prepared.run?.snapshot.tracks[0]));
  assert.throws(() => {
    (prepared.run!.snapshot.presentation as { exitDurationMs: number }).exitDurationMs = 5;
  }, TypeError);
});

test('animated titles survive shared snapshot serialization and keep motion frozen during pause and global fade', () => {
  const base = sequence();
  const draft: SequenceV1 = { ...base, end: { kind: 'fixed', durationMs: 4000, automatic: true }, clips: [{
    id: 'animated-title', trackId: base.tracks[0]!.id, type: 'text', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 4000 },
    entrance: { preset: 'fade-slide', version: 1, durationMs: 1000, easing: 'ease-out', direction: 'left', distance: 200 },
    exit: { preset: 'fade-zoom', version: 1, durationMs: 1000, easing: 'back-out', scale: 0.6 },
    properties: { text: 'Chapter II', fontFamily: 'Arial', fontSize: 64, minimumFontSize: 20, color: '#ffffff',
      align: 'center', box: { x: 400, y: 400, width: 1120, height: 160 }, shrinkToFit: true }
  }] };
  const acquired = acquire(), owner = acquired.owner!;
  const payload: SessionCommand = { kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-title-motion', snapshot: draft, recipients };
  const prepared = append(acquired, JSON.parse(JSON.stringify(payload)) as SessionCommand);
  assert.deepEqual(prepared.run!.snapshot.clips, draft.clips);
  assert.ok(Object.isFrozen(prepared.run!.snapshot.clips[0]!.entrance));
  const started = append(prepared, { kind: 'start', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-title-motion', recipients, atServerMs: 1000 });
  const firstClient = compileSequence(started.run!.snapshot);
  const secondClient = compileSequence(JSON.parse(JSON.stringify(started.run!.snapshot)) as SequenceV1);
  const position = sessionPosition(started.run!, 1250);
  const firstFrame = evaluate(firstClient, position);
  assert.deepEqual(evaluate(secondClient, position), firstFrame);
  assert.equal(firstFrame[0]!.opacity, 0.4375);
  assert.deepEqual(firstFrame[0]!.textTransform, { x: -112.5, y: 0, scale: 1 });
  const paused = append(started, { kind: 'pause', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-title-motion', positionMs: 3250 });
  assert.deepEqual(evaluate(secondClient, sessionPosition(paused.run!, 9000)), evaluate(firstClient, 3250));
  const exiting = append(paused, { kind: 'fade', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-title-motion', positionMs: 3250, atServerMs: 9000, durationMs: 250 });
  assert.deepEqual(evaluate(secondClient, sessionPosition(exiting.run!, 10000)), evaluate(firstClient, 3250));
});

test('start accepts only prepared recipients and positions follow server anchors through pause and fade', () => {
  const acquired = acquire();
  const owner = acquired.owner!;
  const prepared = append(acquired, {
    kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-clock', snapshot: sequence(), recipients
  });

  rejectsCode(() => append(prepared, {
    kind: 'start', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-clock', recipients: [{ userId: 'outsider', sessionId: 'browser-x' }], atServerMs: 1_000
  }), 'SESSION_CONFLICT');

  const started = append(prepared, {
    kind: 'start', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-clock', recipients: [recipients[0]!, recipients[1]!], atServerMs: 1_000
  });
  assert.equal(started.run?.phase, 'playing');
  assert.deepEqual(started.run?.recipients.map(item => item.userId), ['user-a', 'user-c']);
  assert.equal(sessionPosition(started.run!, 2_500), 1_500);
  assert.equal(sessionPosition(started.run!, 20_000), 5_000, 'fixed sequence time clamps at its endpoint');

  const paused = append(started, {
    kind: 'pause', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-clock', positionMs: 1_500
  });
  assert.equal(sessionPosition(paused.run!, 9_000), 1_500);

  const resumed = append(paused, {
    kind: 'resume', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-clock', positionMs: 1_500, atServerMs: 5_000
  });
  assert.equal(sessionPosition(resumed.run!, 5_500), 2_000);

  const exiting = append(resumed, {
    kind: 'fade', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-clock', positionMs: 2_200, atServerMs: 6_000, durationMs: 300
  });
  assert.equal(exiting.run?.phase, 'exiting');
  assert.equal(exiting.run?.exitDurationMs, 300);
  assert.equal(sessionPosition(exiting.run!, 30_000), 2_200, 'exit time does not advance sequence time');
  rejectsCode(() => append(exiting, {
    kind: 'fade', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-clock', positionMs: 2_200, atServerMs: 7_000, durationMs: 900
  }), 'SESSION_CONFLICT');
});

test('runtime validation rejects non-GM actors and malformed or unsupported payload data', () => {
  const initial = initialSession('root-main');
  rejectsCode(() => applySessionRecord(
    initial,
    record(1, 0, 'player', { kind: 'acquire', sessionId: 'tab-player' }),
    id => id === 'gm-a'
  ), 'SESSION_UNAUTHORIZED');

  rejectsCode(() => applySessionRecord(initial, {
    index: 1, previous: 0, actor: 'gm-a', requestId: 'bad',
    payload: { kind: 'acquire', sessionId: 'tab-a', unexpected: true }
  }, id => id === 'gm-a'), 'SESSION_INVALID');

  const acquired = acquire();
  const owner = acquired.owner!;
  const invalidPrepare = record(2, 1, 'gm-a', {
    kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-invalid', snapshot: { schemaVersion: 1 } as SequenceV1, recipients
  });
  rejectsCode(() => applySessionRecord(acquired, invalidPrepare, id => id === 'gm-a'), 'SESSION_INVALID');

  rejectsCode(() => applySessionRecord(acquired, record(2, 1, 'gm-a', {
    kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation,
    runId: 'run-duplicate-recipients', snapshot: sequence(),
    recipients: [{ userId: 'user-a', sessionId: 'same-tab' }, { userId: 'user-b', sessionId: 'same-tab' }]
  }), id => id === 'gm-a'), 'SESSION_INVALID');
});
