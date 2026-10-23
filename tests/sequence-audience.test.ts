import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { AudioClip, BreakBehavior, SequenceAudience, SequenceV1, VideoClip } from '../src/domain/sequence.js';
import { BREAKS_PLAYBACK_SCHEMA_VERSION, SEQUENCE_SCHEMA_VERSION } from '../src/domain/sequence.js';
import { getPlaybackSchemaVersion, getSequenceAudience, getSequenceAutomation, withSequenceAudience, withSequenceAutomation } from '../src/domain/sequence-audience.js';
import { SequenceValidationError, SEQUENCE_LIMITS, createBarsSequence, duplicateSequence, validateSequence } from '../src/domain/validation.js';
import { clipDurationMs, effectiveClipFades, isTerminalManualClip, manualEndNeedsDuration, sequenceDurationMs } from '../src/domain/clip-timing.js';
import { upgradeSequenceToBreaks, upgradeSequenceToTimelineBreaks } from '../src/domain/breaks.js';
import { compileSequence, continuePlaybackAnchor, evaluate, projectPlaybackAnchor,
  validatePlaybackBreakState, type PlaybackClockAnchor } from '../src/playback/evaluate.js';
import { applyTimelineCommand } from '../src/application/timeline-commands.js';
import { DraftService } from '../src/application/draft-service.js';
import type { SequenceRepository } from '../src/application/ports.js';
import { applySessionRecord, initialSession, sessionPlayback, SessionProtocolError,
  type Participant, type SessionCommand, type SessionState } from '../src/playback/session-protocol.js';

// Executable historical validator and evaluator, frozen from installed 0.9.4 before schema edits.
const old = await import(pathToFileURL(resolve('tests/fixtures/audience-baseline-validator-0.9.4.mjs')).href);
const none = { preset: 'none', version: 1 } as const;
const fade = { preset: 'fade', version: 1, durationMs: 100, easing: 'linear' } as const;
const selected: SequenceAudience = { mode: 'selected', userIds: ['player-a'], includeGM: false };
function ids(prefix = 'id'): () => string { let n = 0; return () => `${prefix}-${++n}`; }

function fixture(schemaVersion: 1 | 2 | 3, onBreak: BreakBehavior = 'pause'): SequenceV1 {
  const base = createBarsSequence('Timing fixture', ids(), schemaVersion);
  const video: VideoClip = { id: 'video', trackId: 'video-track', type: 'video',
    typeVersion: schemaVersion === 1 ? 3 : 5, startMs: 1_000,
    duration: { kind: 'media' }, entrance: fade, exit: fade,
    properties: { source: { kind: 'foundry-file', path: 'worlds/demo/movie.webm' }, fit: 'contain',
      volume: 0.7, muted: false, durationMs: 4_000, sourceRange: { inMs: 1_000, outMs: 3_000 },
      loop: true, ...(schemaVersion !== 1 ? { onBreak } : {}) } };
  const audio: AudioClip = schemaVersion === 1
    ? { id: 'sound', trackId: 'sound-track', type: 'audio', typeVersion: 1, startMs: 0,
      duration: { kind: 'media' }, entrance: fade, exit: fade,
      properties: { source: { kind: 'foundry-file', path: 'worlds/demo/sound.ogg' }, volume: 0.5,
        muted: false, durationMs: 1_000, loop: true } }
    : { id: 'sound', trackId: 'sound-track', type: 'audio', typeVersion: 3, startMs: 0,
      duration: { kind: 'sequence-end' }, entrance: fade, exit: fade,
      properties: { source: { kind: 'foundry-file', path: 'worlds/demo/sound.ogg' }, volume: 0.5,
        muted: false, durationMs: 1_000, sourceRange: { inMs: 200, outMs: 700 },
        loop: true, loopIndefinitely: true, onBreak } };
  return validateSequence({ ...base, revision: 7, end: { kind: 'manual' },
    tracks: [...base.tracks,
      { id: 'video-track', name: 'Video', kind: 'visual', order: 1, enabled: true, locked: false },
      { id: 'sound-track', name: 'Sound', kind: 'audio', order: 2, enabled: true, locked: false }],
    clips: [{ ...base.clips[0]!, duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: none, exit: none }, video, audio],
    ...(schemaVersion === 3 ? { breaks: [{ id: 'first', positionMs: 500 }, { id: 'second', positionMs: 1_500 },
      { id: 'inactive', positionMs: 5_000 }] } : {}), extension: { preserved: [1, 'future'] } });
}

test('latest envelope is independent from playback3 and historical audiences remain unchanged', () => {
  assert.equal(SEQUENCE_SCHEMA_VERSION, 5);
  assert.equal(BREAKS_PLAYBACK_SCHEMA_VERSION, 3);
  const fresh = createBarsSequence('Current envelope', ids(), SEQUENCE_SCHEMA_VERSION);
  assert.equal(getPlaybackSchemaVersion(fresh), 3);
  assert.deepEqual(getSequenceAudience(fresh), { mode: 'all', userIds: [], includeGM: true });
  for (const version of [1, 2, 3] as const) {
    const source = fixture(version), before = structuredClone(source);
    assert.deepEqual(validateSequence(source), old.validateSequence(source));
    assert.deepEqual(getSequenceAudience(source), { mode: 'all', userIds: [], includeGM: true });
    const wrapped = withSequenceAudience(source, selected);
    assert.equal(wrapped.schemaVersion, 4);
    assert.equal(getPlaybackSchemaVersion(wrapped), version);
    assert.equal(wrapped.revision, 7);
    assert.deepEqual(getSequenceAudience(wrapped), selected);
    assert.deepEqual(source, before);
    assert.throws(() => old.validateSequence(wrapped), (error: unknown) =>
      (error as { code?: string }).code === 'UNSUPPORTED_SCHEMA_VERSION');
  }
});

test('schema4 requires valid launch version, audience, and playback version while legacy schemas reject launch fields', () => {
  const source = fixture(1), wrapped = withSequenceAudience(source, selected);
  const { launch: _launch, ...withoutLaunch } = wrapped;
  const { playbackSchemaVersion: _playback, ...withoutPlayback } = wrapped;
  for (const value of [withoutLaunch, withoutPlayback,
    { ...wrapped, playbackSchemaVersion: 4 }, { ...wrapped, launch: { ...wrapped.launch, version: 2 } },
    { ...wrapped, launch: { version: 1 } },
    { ...wrapped, launch: { version: 1, audience: { ...selected, mode: 'owners' } } },
    { ...wrapped, launch: { version: 1, audience: { ...selected, includeGM: 1 } } },
    { ...wrapped, launch: { version: 1, audience: { ...selected, userIds: null } } },
    { ...wrapped, schemaVersion: 5 }]) assert.throws(() => validateSequence(value), SequenceValidationError);
  for (const schemaVersion of [1, 2, 3]) {
    const base = createBarsSequence('Legacy', ids(), schemaVersion as 1 | 2 | 3);
    assert.throws(() => validateSequence({ ...base, launch: wrapped.launch }), /schema version 4/);
    assert.throws(() => validateSequence({ ...base, playbackSchemaVersion: schemaVersion }), /schema version 4/);
  }
  assert.throws(() => validateSequence({ ...wrapped, breaks: [] }), /schema version 3/);
  assert.throws(() => validateSequence({ ...withSequenceAudience(fixture(2), selected), playbackSchemaVersion: 1 }), /schema version 2/);
});

test('audience IDs are bounded, unique, valid, and allow an explicitly empty selection', () => {
  const source = fixture(1);
  for (const userIds of [['player-a', 'player-a'], [''], [' bad'], ['a/b'], ['a'.repeat(129)],
    Array.from({ length: SEQUENCE_LIMITS.audienceUsers + 1 }, (_, i) => `u-${i}`)]) {
    assert.throws(() => withSequenceAudience(source, { ...selected, userIds }), SequenceValidationError);
  }
  const empty = withSequenceAudience(source, { ...selected, userIds: [] });
  assert.deepEqual(getSequenceAudience(empty), { ...selected, userIds: [] });
  assert.equal(getPlaybackSchemaVersion(empty), 1);
});

test('audience edits, validation and duplication preserve nested future JSON fields without aliasing', () => {
  const wrapped = withSequenceAudience(fixture(3), selected);
  const extended = validateSequence({ ...wrapped,
    launch: { ...wrapped.launch, futureLaunch: { mode: 'later' },
      audience: { ...selected, futureAudience: ['keep'] } },
    breaks: wrapped.breaks!.map(marker => ({ ...marker, futureMarker: 3 })) });
  const changed = withSequenceAudience(extended, { mode: 'all', userIds: [], includeGM: true });
  assert.deepEqual((changed.launch as unknown as Record<string, unknown>).futureLaunch, { mode: 'later' });
  assert.deepEqual((changed.launch!.audience as unknown as Record<string, unknown>).futureAudience, ['keep']);
  const clone = duplicateSequence(changed, 'Clone', ids('copy'));
  assert.equal(clone.schemaVersion, 4);
  assert.equal(clone.revision, 0);
  assert.notEqual(clone.id, changed.id);
  assert.deepEqual(clone.launch, changed.launch);
  assert.deepEqual(clone.playbackSchemaVersion, changed.playbackSchemaVersion);
  assert.notEqual(clone.breaks![0]!.id, changed.breaks![0]!.id);
  assert.deepEqual(clone.clips.map(clip => clip.properties), changed.clips.map(clip => clip.properties));
  const audience = getSequenceAudience(changed);
  (audience.userIds as string[]).push('later-player');
  assert.deepEqual(changed.launch!.audience.userIds, []);
});

for (const version of [1, 2, 3] as const) for (const behavior of ['pause', 'loop', 'finish'] as const) {
  test(`audience wrapping preserves schema${version} ${behavior} audio/video frames, endpoints, fades and clocks`, () => {
    const original = fixture(version, behavior), wrapped = withSequenceAudience(original, selected);
    const before = compileSequence(original), after = compileSequence(wrapped), historical = old.compileSequence(original);
    assert.equal(after.durationMs, before.durationMs);
    assert.equal(after.durationMs, historical.durationMs);
    assert.deepEqual(after.breaks, before.breaks);
    assert.deepEqual(after.breaks, historical.breaks);
    assert.equal(sequenceDurationMs(wrapped), sequenceDurationMs(original));
    assert.equal(manualEndNeedsDuration(wrapped), manualEndNeedsDuration(original));
    for (const clip of original.clips) {
      assert.equal(clipDurationMs(wrapped, clip), clipDurationMs(original, clip));
      assert.deepEqual(effectiveClipFades(wrapped, clip), effectiveClipFades(original, clip));
      assert.equal(isTerminalManualClip(wrapped, clip), isTerminalManualClip(original, clip));
    }
    for (const time of [0, 99, 100, 499, 500, 999, 1000, 1499, 1500, 2000, 2999, 3000, 4900, 5000, 9000]) {
      for (const context of [{}, { paused: true }, { holding: { elapsedMs: 0 } },
        { holding: { elapsedMs: 9000 } }, { holding: { elapsedMs: 500, paused: true } },
        { exiting: { elapsedMs: 500 } }, { exiting: { elapsedMs: 500, paused: true } },
        ...(version === 3 ? [{ breakHistory: [{ id: 'first', positionMs: 500, elapsedMs: 9000 }] }] : [])]) {
        assert.deepEqual(evaluate(after, time, context), evaluate(before, time, context));
        assert.deepEqual(evaluate(after, time, context), old.evaluate(historical, time, context));
      }
    }
    let oldAnchor: PlaybackClockAnchor = { phase: 'playing', positionMs: 0, atMs: 1000,
      ...(version === 3 ? { breakHistory: [] } : {}) };
    let newAnchor = oldAnchor;
    for (const now of [1100, 1900, 9500, 11000, 20000]) {
      const oldProjection = projectPlaybackAnchor(before, oldAnchor, now);
      const newProjection = projectPlaybackAnchor(after, newAnchor, now);
      assert.deepEqual(newProjection, oldProjection);
      assert.deepEqual(newProjection, old.projectPlaybackAnchor(historical, oldAnchor, now));
      validatePlaybackBreakState(after, newProjection);
      if (oldProjection.phase === 'holding') {
        const historicalContinuation = old.continuePlaybackAnchor(historical, oldAnchor, now);
        oldAnchor = continuePlaybackAnchor(before, oldAnchor, now);
        newAnchor = continuePlaybackAnchor(after, newAnchor, now);
        assert.deepEqual(newAnchor, oldAnchor);
        assert.deepEqual(newAnchor, historicalContinuation);
      }
    }
  });
}

test('Break adoption and default clip authoring use playback version and preserve schema4 launch data', () => {
  const original = fixture(1), wrapped = withSequenceAudience(original, selected);
  const added = applyTimelineCommand(wrapped, { kind: 'add-clip', type: 'audio', trackId: 'sound-track',
    startMs: 6000, sourcePath: 'worlds/demo/second.ogg', sourceDurationMs: 1000 }, ids('new'));
  assert.equal(added.clips.at(-1)!.typeVersion, 2, 'a launch edit must not opt new sounds into Break semantics');
  const addedVideo = applyTimelineCommand(wrapped, { kind: 'add-clip', type: 'video', trackId: 'video-track',
    startMs: 6000, sourcePath: 'worlds/demo/second.webm', sourceDurationMs: 1000 }, ids('video'));
  assert.equal(addedVideo.clips.at(-1)!.typeVersion, 1, 'a launch edit must not opt new videos into Break semantics');
  assert.throws(() => applyTimelineCommand(wrapped, { kind: 'add-break', positionMs: 100 }, ids()), /Adopt break/);
  const adopted = upgradeSequenceToBreaks(wrapped);
  assert.equal(adopted.schemaVersion, 4);
  assert.equal(getPlaybackSchemaVersion(adopted), 2);
  assert.deepEqual(adopted.launch, wrapped.launch);
  const marked = applyTimelineCommand(adopted, { kind: 'add-break', positionMs: 100 }, ids('marker'));
  assert.equal(marked.schemaVersion, 4);
  assert.equal(getPlaybackSchemaVersion(marked), 3);
  assert.deepEqual(marked.launch, wrapped.launch);
  assert.deepEqual(upgradeSequenceToTimelineBreaks(adopted).clips, adopted.clips);
});

test('Audience draft history, saved revisions and frozen run snapshots remain independent', async () => {
  let saved = fixture(1);
  const revisions: (number | null)[] = [];
  const repository: SequenceRepository = { list: async () => [], read: async () => structuredClone(saved),
    save: async (sequence, expected) => { revisions.push(expected); saved = validateSequence({ ...sequence, revision: saved.revision + 1 }); return saved; },
    delete: async () => {} };
  const draft = new DraftService(repository, ids());
  await draft.load(saved.id);
  const running = compileSequence(saved);
  draft.replace(withSequenceAudience(draft.draft!, selected));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(draft.expectedRevision, 7);
  assert.equal(draft.undo()!.schemaVersion, 1);
  assert.equal(draft.dirty, false);
  draft.redo();
  await draft.save();
  assert.deepEqual(revisions, [7]);
  assert.equal(saved.revision, 8);
  assert.deepEqual(getSequenceAudience(saved), selected);
  assert.equal(getPlaybackSchemaVersion(saved), 1);
  assert.equal(running.snapshot.schemaVersion, 1);
  assert.equal(running.snapshot.revision, 7);
  assert.equal(draft.undo()!.revision, 8);
  assert.equal(draft.redo()!.schemaVersion, 4);
});

function append(state: SessionState, payload: SessionCommand): SessionState {
  return applySessionRecord(state, { index: state.head + 1, previous: state.head,
    requestId: `request-${state.head + 1}`, actor: 'gm', payload }, id => id === 'gm' || id === 'other-gm');
}
function acquire(): SessionState { return append(initialSession('root'), { kind: 'acquire', sessionId: 'gm-tab' }); }
function prepare(state: SessionState, snapshot: SequenceV1, recipients: readonly Participant[]): SessionState {
  return append(state, { kind: 'prepare', sessionId: state.owner!.sessionId, generation: state.owner!.generation,
    runId: 'run', snapshot, recipients });
}
function owned(state: SessionState) { return { sessionId: state.owner!.sessionId, generation: state.owner!.generation, runId: 'run' }; }
const player = { userId: 'player-a', sessionId: 'player-tab' };
const gm = { userId: 'gm', sessionId: 'gm-tab' };

test('Record1 reducer accepts schema4 snapshots and enforces selected users and the controlling GM browser', () => {
  const acquired = acquire(), snapshot = withSequenceAudience(fixture(3), selected);
  const prepared = prepare(acquired, snapshot, [player]);
  assert.deepEqual(prepared.run!.snapshot, snapshot);
  assert.deepEqual(prepared.run!.breakHistory, []);
  for (const recipient of [gm, { userId: 'player-b', sessionId: 'b-tab' },
    { userId: 'other-gm', sessionId: 'other-tab' }]) {
    assert.throws(() => prepare(acquired, snapshot, [recipient]), SessionProtocolError);
  }
  const include = withSequenceAudience(snapshot, { ...selected, includeGM: true, userIds: ['player-a', 'other-gm'] });
  assert.doesNotThrow(() => prepare(acquired, include, [gm, player]));
  assert.throws(() => prepare(acquired, include, [{ userId: 'gm', sessionId: 'another-gm-tab' }]), SessionProtocolError);
  // The store checks current roles at admission; replay must retain identities after a promotion.
  assert.doesNotThrow(() => prepare(acquired, include, [{ userId: 'other-gm', sessionId: 'other-tab' }]));
  const empty = withSequenceAudience(snapshot, { ...selected, userIds: [] });
  assert.throws(() => prepare(acquired, empty, [player]), SessionProtocolError);
  assert.throws(() => prepare(acquired, empty, []), SessionProtocolError);
  const all = withSequenceAudience(snapshot, { mode: 'all', userIds: [], includeGM: false });
  assert.doesNotThrow(() => prepare(acquired, all, [player]));
  assert.throws(() => prepare(acquired, all, [gm]), SessionProtocolError);
  const started = append(prepared, { kind: 'start', ...owned(prepared), recipients: [player], atServerMs: 1000 });
  assert.equal(sessionPlayback(started.run!, 1500).breakId, 'first');
  assert.throws(() => append(prepared, { kind: 'start', ...owned(prepared), recipients: [gm], atServerMs: 1000 }), SessionProtocolError);
});

for (const version of [1, 2, 3] as const) {
  test(`Record1 schema${version} and wrapped4 projection and pause/fade behavior are equivalent`, () => {
    const snapshot = fixture(version, 'finish');
    const base = acquire();
    let previous = prepare(base, snapshot, [player]);
    let wrapped = prepare(base, withSequenceAudience(snapshot, selected), [player]);
    const start: SessionCommand = { kind: 'start', ...owned(previous), recipients: [player], atServerMs: 1000 };
    previous = append(previous, start); wrapped = append(wrapped, start);
    for (const now of [1000, 1499, 1500, 7000, 10000]) assert.deepEqual(sessionPlayback(wrapped.run!, now), sessionPlayback(previous.run!, now));
    if (version === 3) {
      const playback = sessionPlayback(previous.run!, 1800);
      const command: SessionCommand = { kind: 'continue', ...owned(previous), positionMs: playback.positionMs,
        atServerMs: 1800, durationMs: snapshot.presentation.exitDurationMs, holdElapsedMs: playback.holdElapsedMs!,
        exitFrom: 'holding', breakId: playback.breakId!, expectedBreakHistoryLength: 0 };
      previous = append(previous, command); wrapped = append(wrapped, command);
      assert.deepEqual(sessionPlayback(wrapped.run!, 2000), sessionPlayback(previous.run!, 2000));
      const next = sessionPlayback(previous.run!, 2000);
      const fade: SessionCommand = { kind: 'fade', ...owned(previous), positionMs: next.positionMs,
        atServerMs: 2000, durationMs: 300 };
      previous = append(previous, fade); wrapped = append(wrapped, fade);
      assert.deepEqual(sessionPlayback(wrapped.run!, 2200), sessionPlayback(previous.run!, 2200));
    } else {
      const pause: SessionCommand = { kind: 'pause', ...owned(previous), positionMs: 100 };
      previous = append(previous, pause); wrapped = append(wrapped, pause);
      assert.deepEqual(sessionPlayback(wrapped.run!, 1800), sessionPlayback(previous.run!, 1800));
      const fade: SessionCommand = { kind: 'fade', ...owned(previous), positionMs: 100, atServerMs: 1800,
        durationMs: 300, ...(version === 2 ? { exitFrom: 'paused' as const } : {}) };
      previous = append(previous, fade); wrapped = append(wrapped, fade);
      assert.deepEqual(sessionPlayback(wrapped.run!, 2000), sessionPlayback(previous.run!, 2000));
    }
  });
}

test('launch v2 trigger authoring preserves legacy media, Break and clock semantics', () => {
  for (const version of [1, 2, 3] as const) {
    const source = fixture(version, 'loop');
    const before = compileSequence(source);
    const authored = withSequenceAutomation(source, { version: 1, enabled: true,
      rules: [{ id: `rule-${version}`, enabled: true, event: 'turn-start', actorId: 'actor-1' }] });
    const after = compileSequence(authored);
    assert.equal(authored.playbackSchemaVersion, version);
    assert.equal(getPlaybackSchemaVersion(authored), version);
    assert.equal(after.durationMs, before.durationMs);
    assert.deepEqual(after.breaks, before.breaks);
    assert.deepEqual(after.clips, before.clips);
    assert.deepEqual(getSequenceAutomation(authored).rules, [{ id: `rule-${version}`, enabled: true,
      event: 'turn-start', actorId: 'actor-1' }]);
    assert.deepEqual(source, fixture(version, 'loop'), 'authoring must leave its historical input unchanged');
    for (const time of [0, 99, 500, 999, 1000, 1499, 1500, 2999, 3000, 4900, 5000, 9000]) {
      for (const context of [{}, { paused: true }, { holding: { elapsedMs: 0 } },
        { holding: { elapsedMs: 9000 } }, { exiting: { elapsedMs: 500 } },
        ...(version === 3 ? [{ breakHistory: [{ id: 'first', positionMs: 500, elapsedMs: 9000 }] }] : [])]) {
        assert.deepEqual(evaluate(after, time, context), evaluate(before, time, context));
      }
    }
  }
});
