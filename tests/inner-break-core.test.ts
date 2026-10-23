import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioClipV3, SequenceV1, VideoClip } from '../src/domain/sequence.js';
import { sequenceDurationMs } from '../src/domain/clip-timing.js';
import { upgradeSequenceToBreaks, upgradeSequenceToTimelineBreaks } from '../src/domain/breaks.js';
import { createBarsSequence, duplicateSequence, validateSequence } from '../src/domain/validation.js';
import { compileSequence, continuePlaybackAnchor, copyPlaybackAnchor, evaluate, playbackHoldElapsedAt,
  playbackPositionAt, projectPlaybackAnchor, validatePlaybackBreakState, type PlaybackClockAnchor } from '../src/playback/evaluate.js';
import { LocalPlayer, type PlayerFrame, type Runtime, type Surface } from '../src/playback/local-player.js';

const none = { preset: 'none', version: 1 } as const;
function sequence(onBreak: 'pause' | 'loop' | 'finish' = 'pause', markers = [500, 1500]): SequenceV1 {
  const sound: AudioClipV3 = { id: 'sound', trackId: 'audio', type: 'audio', typeVersion: 3, startMs: 0,
    entrance: none, exit: none, duration: { kind: 'sequence-end' }, properties: {
      source: { kind: 'foundry-file', path: 'sound.ogg' }, volume: 1, muted: false, durationMs: 2000,
      loop: true, loopIndefinitely: true, onBreak } };
  return { ...createBarsSequence('Inner holds', (() => { let n = 0; return () => `id${++n}`; })(), 3),
    breaks: markers.map(positionMs => ({ id: `break${positionMs}`, positionMs })),
    tracks: [{ id: 'visual', name: 'Visual', kind: 'visual', enabled: true, locked: false, order: 0 },
      { id: 'audio', name: 'Audio', kind: 'audio', enabled: true, locked: false, order: 1 }],
    clips: [{ id: 'bars', trackId: 'visual', type: 'bars', typeVersion: 1, startMs: 0,
      entrance: none, exit: none, duration: { kind: 'fixed', milliseconds: 3000 },
      properties: { heightFraction: 0.1, color: '#000000' } }, sound],
    end: { kind: 'manual' }, presentation: { surface: 'window', blockInput: false, exitDurationMs: 200 } };
}
class Clock implements Runtime {
  time = 0; next = 0; frames = new Map<number, () => void>();
  now(): number { return this.time; }
  requestFrame(callback: () => void): number { const id = ++this.next; this.frames.set(id, callback); return id; }
  cancelFrame(id: number): void { this.frames.delete(id); }
  advance(ms: number): void { this.time += ms; const frames = [...this.frames.values()]; this.frames.clear(); frames.forEach(callback => callback()); }
}
class RecordingSurface implements Surface {
  frames: PlayerFrame[] = []; disposed = 0;
  async prepare(): Promise<void> {}
  render(frame: PlayerFrame): void { this.frames.push(frame); }
  dispose(): void { this.disposed++; }
}
const soundState = (player: LocalPlayer) => player.getState().items!.find(item => item.clip.id === 'sound')!;

test('restored stopped anchors require a held origin at positive inner and manual endpoint boundaries', () => {
  const plan = compileSequence(sequence());
  for (const phase of ['paused', 'exiting'] as const) {
    assert.throws(() => validatePlaybackBreakState(plan, { phase, positionMs: 500, atMs: 1000 }), /holding origin/);
    assert.throws(() => validatePlaybackBreakState(plan, { phase, positionMs: 3000, atMs: 1000,
      breakHistory: [{ id: 'break500', positionMs: 500, elapsedMs: 200 }, { id: 'break1500', positionMs: 1500, elapsedMs: 100 }] }), /holding origin/);
    const zero = compileSequence(sequence('pause', [0]));
    assert.doesNotThrow(() => validatePlaybackBreakState(zero, { phase, positionMs: 0, atMs: 1000 }));
  }
  assert.doesNotThrow(() => validatePlaybackBreakState(plan, { phase: 'paused', pausedFrom: 'holding',
    breakId: 'break500', positionMs: 500, atMs: 1000, holdElapsedMs: 200 }));
});

test('schema3 validates markers, preserves input/extensions and rejects unsupported legacy marker fields', () => {
  const draft = { ...sequence(), extension: { preserve: true } };
  assert.deepEqual(validateSequence(draft), draft);
  for (const breaks of [[{ id: 'a', positionMs: -1 }], [{ id: 'a', positionMs: 0.5 }],
    [{ id: 'a', positionMs: 0 }, { id: 'a', positionMs: 1 }], [{ id: 'a', positionMs: 1 }, { id: 'b', positionMs: 1 }],
    Array.from({ length: 129 }, (_, index) => ({ id: `b${index}`, positionMs: index }))]) assert.throws(() => validateSequence({ ...draft, breaks }));
  assert.throws(() => validateSequence({ ...draft, breaks: [{ id: 'a', positionMs: 604800001 }] }));
  for (const schemaVersion of [1, 2]) assert.throws(() => validateSequence({ ...createBarsSequence('old', () => 'id'), schemaVersion, breaks: [] }), /schema version 3/);
});

test('schema2 adoption preserves every persisted field and schema1 requires explicit semantics adoption first', () => {
  const { breaks: _markers, ...source } = sequence();
  const old = { ...source, schemaVersion: 2 as const, extension: { version: 'original' } };
  const before = structuredClone(old);
  assert.deepEqual(upgradeSequenceToTimelineBreaks(old), { ...old, schemaVersion: 3 });
  assert.deepEqual(old, before);
  const legacy = createBarsSequence('legacy', (() => { let n = 0; return () => `l${++n}`; })());
  assert.throws(() => upgradeSequenceToTimelineBreaks(legacy), /EXPLICIT_BREAK_ADOPTION_REQUIRED/);
  assert.equal(upgradeSequenceToTimelineBreaks(upgradeSequenceToBreaks(legacy)).schemaVersion, 3);
  assert.deepEqual(upgradeSequenceToBreaks({ ...old, schemaVersion: 3 }), { ...old, schemaVersion: 3 });
});

test('markers sort independently of author order, never extend end, and stay inactive at or beyond endpoint', () => {
  const draft = sequence('pause', [4000, 1500, 3000, 500]); const before = structuredClone(draft);
  const plan = compileSequence(draft);
  assert.equal(sequenceDurationMs(draft), 3000);
  assert.deepEqual(plan.breaks.map(marker => [marker.kind, marker.positionMs]), [['inner', 500], ['inner', 1500], ['terminal', 3000]]);
  assert.deepEqual(draft, before);
  const expanded = compileSequence({ ...draft, end: { kind: 'fixed', durationMs: 5000 } });
  assert.deepEqual(expanded.breaks.map(marker => marker.positionMs), [500, 1500, 3000, 4000]);
  let id = 0; const duplicate = duplicateSequence(draft, 'Copy', () => `copy${++id}`);
  assert.deepEqual(duplicate.breaks!.map(marker => marker.positionMs), draft.breaks!.map(marker => marker.positionMs));
  assert.ok(duplicate.breaks!.every(marker => !draft.breaks!.some(original => original.id === marker.id)));
});

test('pure shared projection stops skipped frames and late arrivals at the first unconsumed marker', () => {
  const plan = compileSequence(sequence());
  const initial: PlaybackClockAnchor = { phase: 'playing', positionMs: 0, atMs: 1000, breakHistory: [] };
  assert.equal(projectPlaybackAnchor(plan, initial, 1200), initial);
  const held = projectPlaybackAnchor(plan, initial, 10000);
  assert.deepEqual(held, { phase: 'holding', positionMs: 500, atMs: 1500, holdElapsedMs: 0, breakId: 'break500', breakHistory: [] });
  assert.equal(playbackPositionAt(plan, initial, 10000), 500);
  assert.equal(playbackHoldElapsedAt(held, 10000), 8500);
  const continued = continuePlaybackAnchor(plan, held, 10000);
  assert.equal(continued.phase, 'playing');
  assert.deepEqual(continued.breakHistory, [{ id: 'break500', positionMs: 500, elapsedMs: 8500 }]);
  const second = projectPlaybackAnchor(plan, continued, 90000);
  assert.equal(second.breakId, 'break1500'); assert.equal(second.atMs, 11000);
  validatePlaybackBreakState(plan, copyPlaybackAnchor(second));
});

test('boundary zero holds immediately, future start lead stays detached, and Continue consumes zero once', async () => {
  const clock = new Clock(); const player = new LocalPlayer(clock); const surface = new RecordingSurface();
  await player.start(sequence('loop', [0, 500]), surface, { phase: 'playing', positionMs: 0, atMs: 1000 });
  assert.equal(surface.frames.length, 0);
  clock.advance(1000);
  assert.equal(player.getState().breakId, 'break0'); assert.equal(player.getState().positionMs, 0);
  clock.advance(200); assert.equal(soundState(player).mediaTimeMs, 200);
  player.continueFromBreak(); assert.equal(player.getState().phase, 'playing');
  assert.equal(soundState(player).mediaTimeMs, 0);
  clock.advance(500); assert.equal(player.getState().breakId, 'break500');
  player.stop();
});

test('normal Pause freezes both clocks and Resume returns to holding at the exact original media progress', async () => {
  const clock = new Clock(); const player = new LocalPlayer(clock); const surface = new RecordingSurface();
  await player.start(sequence('loop'), surface); clock.advance(800);
  assert.equal(player.getState().positionMs, 500); assert.equal(soundState(player).mediaTimeMs, 800);
  player.pause(); clock.advance(5000);
  assert.equal(player.getState().phase, 'paused'); assert.equal(player.getState().breakId, 'break500');
  assert.equal(player.getState().holdElapsedMs, 300); assert.equal(soundState(player).mediaTimeMs, 800);
  player.resume(); clock.advance(200);
  assert.equal(player.getState().phase, 'holding'); assert.equal(player.getState().holdElapsedMs, 500);
  player.continueFromBreak(); assert.equal(soundState(player).mediaTimeMs, 500);
  assert.equal(player.getState().breakHistory![0]!.elapsedMs, 500);
  player.stop();
});

test('Finish preserves incomplete source progress after Continue and remains finished at later holds and terminal', async () => {
  const clock = new Clock(); const player = new LocalPlayer(clock); const surface = new RecordingSurface();
  await player.start(sequence('finish'), surface); clock.advance(500); clock.advance(300);
  assert.equal(soundState(player).mediaTimeMs, 800);
  player.continueFromBreak(); assert.equal(soundState(player).mediaTimeMs, 800);
  assert.equal(soundState(player).mediaPlayback, 'finishing');
  clock.advance(200); assert.equal(soundState(player).mediaTimeMs, 1000);
  player.pause(); clock.advance(3000); assert.equal(soundState(player).mediaTimeMs, 1000);
  player.resume(); clock.advance(800);
  assert.equal(player.getState().breakId, 'break1500'); assert.equal(soundState(player).mediaTimeMs, 1800);
  clock.advance(400); assert.equal(soundState(player).mediaPlayback, 'finished');
  player.continueFromBreak(); assert.equal(soundState(player).mediaPlayback, 'finished');
  clock.advance(1500); assert.equal(player.getState().phase, 'holding'); assert.equal(player.getState().breakId, undefined);
  assert.equal(soundState(player).mediaPlayback, 'finished');
  player.continueFromBreak(); clock.advance(100); assert.equal(soundState(player).mediaPlayback, 'finished');
  clock.advance(100); assert.equal(player.getState().phase, 'ended'); assert.equal(surface.disposed, 1);
});

test('Loop wraps during a hold and resynchronizes at each Continue; Pause media never advances in hold', async () => {
  for (const behavior of ['loop', 'pause'] as const) {
    const clock = new Clock(); const player = new LocalPlayer(clock); const surface = new RecordingSurface();
    await player.start(sequence(behavior), surface); clock.advance(4500);
    assert.equal(player.getState().breakId, 'break500'); assert.equal(player.getState().positionMs, 500);
    assert.equal(soundState(player).mediaTimeMs, 500);
    assert.equal(soundState(player).mediaPlayback, behavior === 'loop' ? 'looping' : 'paused');
    player.continueFromBreak(); clock.advance(1000); assert.equal(player.getState().breakId, 'break1500');
    clock.advance(700); assert.equal(soundState(player).mediaTimeMs, behavior === 'loop' ? 200 : 1500);
    player.continueFromBreak(); assert.equal(soundState(player).mediaTimeMs, 1500);
    player.stop();
  }
});

test('clips ended at or before an inner marker remain absent through hold, Continue and later holds', async () => {
  const draft = sequence('finish'); const audio = draft.clips[1] as AudioClipV3;
  const early = { ...audio, duration: { kind: 'fixed', milliseconds: 500 } as const,
    properties: { ...audio.properties, loopIndefinitely: false } };
  const clock = new Clock(); const player = new LocalPlayer(clock); const surface = new RecordingSurface();
  await player.start({ ...draft, clips: [draft.clips[0]!, early] }, surface); clock.advance(500);
  assert.equal(player.getState().items!.some(item => item.clip.id === 'sound'), false);
  clock.advance(4000); player.continueFromBreak(); clock.advance(1000);
  assert.equal(player.getState().items!.some(item => item.clip.id === 'sound'), false);
  player.stop();
});

test('persisted history and paused current hold reconstruct exact Finish source after reconnect', async () => {
  const draft = sequence('finish'); const clock = new Clock(); clock.time = 20000;
  const anchor: PlaybackClockAnchor = { phase: 'paused', pausedFrom: 'holding', breakId: 'break1500', positionMs: 1500,
    atMs: 9000, holdElapsedMs: 100, breakHistory: [{ id: 'break500', positionMs: 500, elapsedMs: 200 }] };
  const player = new LocalPlayer(clock); const surface = new RecordingSurface();
  await player.start(draft, surface, anchor);
  assert.equal(soundState(player).mediaTimeMs, 1800); assert.equal(soundState(player).mediaPlayback, 'paused');
  player.resume(); clock.advance(100); assert.equal(soundState(player).mediaTimeMs, 1900);
  player.continueFromBreak(); clock.advance(100); assert.equal(soundState(player).mediaPlayback, 'finished');
  const restored = evaluate(compileSequence(draft), 1600, { breakHistory: player.getState().breakHistory! });
  assert.equal(restored.find(item => item.clip.id === 'sound')!.mediaPlayback, 'finished');
  player.stop();
});

test('fixed/media endings still fade after consumed markers and stale/invalid histories cannot replace a run', async () => {
  const draft = { ...sequence('pause', [500]), end: { kind: 'fixed', durationMs: 3000 } as const };
  const clock = new Clock(); const player = new LocalPlayer(clock); const surface = new RecordingSurface();
  await player.start(draft, surface); clock.advance(500);
  assert.throws(() => player.applyAnchor({ phase: 'playing', positionMs: 1500, atMs: 500, breakHistory: [] }), /skip/);
  assert.throws(() => player.applyAnchor({ phase: 'playing', positionMs: 500, atMs: 500,
    breakHistory: [{ id: 'wrong', positionMs: 500, elapsedMs: 1 }] }), /prefix/);
  assert.equal(player.getState().breakId, 'break500');
  player.continueFromBreak(); clock.advance(2500); assert.equal(player.getState().phase, 'exiting');
  clock.advance(200); assert.equal(player.getState().phase, 'ended'); assert.equal(surface.disposed, 1);
});


test('trimmed video uses the same three inner policies and Finish never restarts after a later Continue', async () => {
  for (const behavior of ['pause', 'loop', 'finish'] as const) {
    const clock = new Clock(); const player = new LocalPlayer(clock); const surface = new RecordingSurface();
    const draft = sequence(behavior);
    const video: VideoClip = { id: 'video', trackId: 'visual', type: 'video', typeVersion: 5, startMs: 0,
      duration: { kind: 'media' }, entrance: none, exit: none, properties: {
        source: { kind: 'foundry-file', path: 'movie.webm' }, fit: 'contain', volume: 1, muted: true,
        durationMs: 4000, sourceRange: { inMs: 1000, outMs: 4000 }, onBreak: behavior } };
    await player.start({ ...draft, clips: [video], end: { kind: 'media', clipId: 'video' } }, surface);
    const media = () => player.getState().items![0]!;
    clock.advance(1500); assert.equal(player.getState().positionMs, 500);
    assert.equal(media().mediaTimeMs, behavior === 'pause' ? 500 : 1500);
    player.continueFromBreak(); assert.equal(media().mediaTimeMs, behavior === 'finish' ? 1500 : 500);
    clock.advance(1000); assert.equal(player.getState().breakId, 'break1500');
    clock.advance(600);
    assert.equal(media().mediaPlayback, behavior === 'finish' ? 'finished' : behavior === 'pause' ? 'paused' : 'looping');
    player.continueFromBreak(); assert.equal(media().mediaTimeMs, behavior === 'finish' ? 3000 : 1500);
    clock.advance(200); assert.equal(media().mediaTimeMs, behavior === 'finish' ? 3000 : 1700);
    player.stop(); assert.equal(surface.disposed, 1);
  }
});

test('Finish begins on the first marker where its clip is active and ignores earlier unrelated holds', async () => {
  const draft = sequence('finish'); const audio = draft.clips[1] as AudioClipV3;
  const clock = new Clock(); const player = new LocalPlayer(clock); const surface = new RecordingSurface();
  await player.start({ ...draft, clips: [draft.clips[0]!, { ...audio, startMs: 1000 }] }, surface);
  clock.advance(1500); assert.equal(player.getState().positionMs, 500);
  assert.equal(player.getState().items!.some(item => item.clip.id === 'sound'), false);
  player.continueFromBreak(); clock.advance(1000); assert.equal(soundState(player).mediaTimeMs, 500);
  clock.advance(100); player.continueFromBreak(); clock.advance(100);
  assert.equal(soundState(player).mediaTimeMs, 700); assert.equal(soundState(player).mediaPlayback, 'finishing');
  player.stop();
});
