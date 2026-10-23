import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioClipV3, BarsClip, SequenceV1, VideoClip } from '../src/domain/sequence.js';
import { effectiveClipFades, manualEndNeedsDuration, sequenceDurationMs } from '../src/domain/clip-timing.js';
import { upgradeSequenceToBreaks } from '../src/domain/breaks.js';
import { createBarsSequence, createBreaksSequence, validateSequence } from '../src/domain/validation.js';
import { compileSequence, evaluate, evaluateBreakMedia, evaluateMediaAfterBreak } from '../src/playback/evaluate.js';
import { LocalPlayer, type PlayerFrame, type Runtime, type Surface } from '../src/playback/local-player.js';

const none = { preset: 'none', version: 1 } as const;
function bars(id = 'bars', length = 1_000): BarsClip {
  return { id, trackId: 'visual', type: 'bars', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: length }, entrance: none, exit: none,
    properties: { heightFraction: 0.12, color: '#000000' } };
}
function audio(onBreak: 'pause' | 'loop' | 'finish' = 'pause', indefinite = false): AudioClipV3 {
  return { id: 'audio', trackId: 'audio', type: 'audio', typeVersion: 3, startMs: 0,
    duration: indefinite ? { kind: 'sequence-end' } : { kind: 'fixed', milliseconds: 1_000 }, entrance: none, exit: none,
    properties: { source: { kind: 'foundry-file', path: 'sound.ogg' }, durationMs: 5_000,
      sourceRange: { inMs: 1_000, outMs: 3_000 }, volume: 1, muted: false,
      loop: indefinite, loopIndefinitely: indefinite, onBreak } };
}
function sequence(clips: SequenceV1['clips'] = [bars(), audio()]): SequenceV1 {
  return { schemaVersion: 2, id: 'break-test', revision: 4, name: 'Break test',
    composition: { width: 1920, height: 1080 }, presentation: { surface: 'window', blockInput: false, exitDurationMs: 200 },
    tracks: [{ id: 'visual', name: 'Visual', kind: 'visual', order: 0, enabled: true, locked: false },
      { id: 'audio', name: 'Audio', kind: 'audio', order: 1, enabled: true, locked: false }], clips, end: { kind: 'manual' } };
}
class Clock implements Runtime {
  time = 0;
  next = 0;
  callbacks = new Map<number, () => void>();
  now(): number { return this.time; }
  requestFrame(callback: () => void): number { const id = ++this.next; this.callbacks.set(id, callback); return id; }
  cancelFrame(id: number): void { this.callbacks.delete(id); }
  advance(ms: number): void { this.time += ms; const callbacks = [...this.callbacks.values()]; this.callbacks.clear(); for (const callback of callbacks) callback(); }
}
class RecordingSurface implements Surface {
  frames: PlayerFrame[] = [];
  disposed = 0;
  async prepare(): Promise<void> {}
  render(frame: PlayerFrame): void { this.frames.push(frame); }
  dispose(): void { this.disposed++; }
}

test('schema 2 finite endpoint excludes indefinite/held clips and exposes fallback only without duration-bearing clips', () => {
  const indefinite = { ...audio('pause', true), startMs: 100 };
  const held = { ...bars('held'), duration: { kind: 'sequence-end' as const } };
  const draft = sequence([bars(), indefinite, held]);
  assert.equal(sequenceDurationMs(draft), 1_000);
  assert.equal(manualEndNeedsDuration(draft), false);
  assert.equal(sequenceDurationMs(sequence([held, indefinite])), 5_000);
  assert.equal(manualEndNeedsDuration(sequence([held, indefinite])), true);
  assert.equal(sequenceDurationMs({ ...sequence([held]), end: { kind: 'manual', durationMs: 3_000 } }), 3_000);
  assert.equal(compileSequence(sequence([bars(), { ...audio('pause', true), properties: { ...indefinite.properties, durationMs: 60_000 } }])).durationMs, 1_000);
  const hidden = { ...draft, tracks: draft.tracks.map(track => track.id === 'visual' ? { ...track, enabled: false } : track) };
  assert.equal(manualEndNeedsDuration(hidden), true);
});

test('new draft factory opts into schema 2 while legacy factory and validation preserve baseline payloads', () => {
  let index = 0;
  assert.equal(createBarsSequence('Legacy', () => `old-${++index}`).schemaVersion, 1);
  assert.equal(createBreaksSequence('New', () => `new-${++index}`).schemaVersion, 2);
  const old = { ...sequence([bars()]), schemaVersion: 1 as const };
  assert.deepEqual(validateSequence(old), old);
  assert.equal(sequenceDurationMs(old), null);
  assert.throws(() => validateSequence({ ...sequence(), schemaVersion: 1 }), /schema version 2/);
  assert.throws(() => validateSequence({ ...sequence(), schemaVersion: 6 }), /not supported/);
  assert.throws(() => validateSequence(sequence([{ ...audio('pause', true), duration: { kind: 'fixed', milliseconds: 100 } }])), /sequence-end duration/);
});

test('explicit migration preserves IDs, revisions, source ranges and extensions and converts only effective old indefinite audio', () => {
  const oldAudio = { ...audio('pause'), typeVersion: 2 as const, duration: { kind: 'fixed' as const, milliseconds: 1_000 }, properties: { ...audio().properties, loop: true, loopIndefinitely: true } };
  const { onBreak: _unused, ...oldProperties } = oldAudio.properties;
  const legacy = { ...sequence([bars(), { ...oldAudio, properties: oldProperties }]), schemaVersion: 1 as const,
    extension: { preserve: ['yes'] } };
  const original = structuredClone(legacy);
  const migrated = upgradeSequenceToBreaks(legacy);
  assert.deepEqual(legacy, original);
  assert.equal(migrated.id, legacy.id);
  assert.equal(migrated.revision, legacy.revision);
  assert.deepEqual((migrated as unknown as { extension: unknown }).extension, legacy.extension);
  const sound = migrated.clips[1] as AudioClipV3;
  assert.equal(sound.typeVersion, 3);
  assert.deepEqual(sound.duration, { kind: 'sequence-end' });
  assert.equal(sound.properties.onBreak, 'loop');
  assert.deepEqual(sound.properties.sourceRange, oldProperties.sourceRange);
  const later = { ...oldAudio, id: 'later', startMs: 2_000, properties: { ...oldProperties, loop: false, loopIndefinitely: false } };
  const finiteMigration = upgradeSequenceToBreaks({ ...legacy, clips: [...legacy.clips, later] });
  assert.deepEqual(finiteMigration.clips[1]!.duration, { kind: 'fixed', milliseconds: 1_000 });
  assert.equal((finiteMigration.clips[1] as AudioClipV3).properties.loopIndefinitely, false);
});

test('end composition retains only exact endpoint clips and authored fades remain effective', () => {
  const fading = { ...bars('fading'), exit: { preset: 'fade', version: 1, durationMs: 200, easing: 'linear' } as const };
  const plan = compileSequence(sequence([bars('early', 400), fading, audio('finish')]));
  assert.equal(evaluate(plan, 900).find(item => item.clip.id === 'fading')!.opacity, 0.5);
  const boundary = evaluate(plan, 1_000, { holding: { elapsedMs: 100 } });
  assert.deepEqual(boundary.map(item => item.clip.id), ['fading', 'audio']);
  assert.equal(boundary[0]!.opacity, 0);
  assert.equal(boundary[1]!.mediaTimeMs, 1_100);
  assert.equal(boundary[1]!.localTimeMs, 1_000);
  assert.equal(boundary[1]!.mediaPlayback, 'finishing');
  assert.equal(evaluate(plan, 30_000, { holding: { elapsedMs: 29_000 } }).some(item => item.clip.id === 'early'), false);
});

test('shared fade geometry preserves authored fixed fades and suppresses only effective held exits', () => {
  const fade = { preset: 'fade', version: 1, durationMs: 100, easing: 'linear' } as const;
  const finite = { ...audio(), entrance: fade, exit: fade };
  assert.deepEqual(effectiveClipFades(sequence([finite]), finite), { durationMs: 1_000, entranceMs: 100, exitMs: 100 });
  const indefinite = { ...audio('pause', true), entrance: fade, exit: fade };
  assert.deepEqual(effectiveClipFades(sequence([bars(), indefinite]), indefinite), { durationMs: 1_000, entranceMs: 100, exitMs: 0 });
});

test('Break media policies are independent of ordinary loops and finish continuation never rewinds', () => {
  const sound = audio('finish', true);
  const finished = evaluateBreakMedia(sound, 1_500, 600);
  assert.deepEqual(finished, { mediaTimeMs: 2_000, mediaPlayback: 'finished' });
  assert.equal(evaluateMediaAfterBreak(sound, 1_500, 600, 100).mediaPlayback, 'finished');
  assert.equal(evaluateMediaAfterBreak(sound, 500, 300, 200).mediaTimeMs, 1_000);
  const looping = { ...sound, properties: { ...sound.properties, onBreak: 'loop' as const } };
  assert.equal(evaluateBreakMedia(looping, 500, 4_000).mediaCycle, 2);
  assert.equal(evaluateBreakMedia(looping, 500, 4_000).mediaTimeMs, 500);
  assert.equal(evaluateMediaAfterBreak(looping, 500, 4_000, 100).mediaTimeMs, 600);
  const paused = { ...sound, properties: { ...sound.properties, onBreak: 'pause' as const } };
  assert.equal(evaluateBreakMedia(paused, 750, 99_000).mediaTimeMs, 750);
  assert.equal(evaluateBreakMedia(paused, 750, 99_000).audioLoop, undefined);
});

test('video v5 source/keying validation and pause at selected source end remain independent of looping', () => {
  const video: VideoClip = { id: 'video', trackId: 'visual', type: 'video', typeVersion: 5, startMs: 0,
    duration: { kind: 'media' }, entrance: none, exit: none,
    properties: { source: { kind: 'foundry-file', path: 'movie.webm' }, fit: 'contain', volume: 1, muted: true,
      durationMs: 4_000, sourceRange: { inMs: 1_000, outMs: 2_000 }, onBreak: 'pause',
      keying: { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.05 } } };
  const held = evaluate(compileSequence(sequence([video])), 1_000, { holding: { elapsedMs: 200 } })[0]!;
  assert.equal(held.mediaTimeMs, 1_000);
  assert.equal(held.mediaPlayback, 'paused');
});

test('holding advances only media clock; ordinary pause freezes both and resume carries exact source progress', async () => {
  const runtime = new Clock(); const surface = new RecordingSurface(); const player = new LocalPlayer(runtime);
  await player.start(sequence([bars(), audio('loop', true)]), surface);
  runtime.advance(1_250);
  assert.equal(player.getState().phase, 'holding');
  assert.equal(player.getState().positionMs, 1_000);
  assert.equal(player.getState().holdElapsedMs, 250);
  assert.equal(player.getState().items!.find(item => item.clip.id === 'audio')!.mediaTimeMs, 1_250);
  player.pause(); runtime.advance(2_000);
  assert.equal(player.getState().phase, 'paused');
  assert.equal(player.getState().holdElapsedMs, 250);
  player.resume(); runtime.advance(250);
  assert.equal(player.getState().phase, 'holding');
  assert.equal(player.getState().holdElapsedMs, 500);
  assert.equal(player.getState().items!.find(item => item.clip.id === 'audio')!.mediaTimeMs, 1_500);
  player.continueFromBreak(); runtime.advance(100);
  assert.equal(surface.frames.at(-1)!.phase, 'exiting');
  assert.equal(surface.frames.at(-1)!.opacity, 0.5);
  assert.equal(surface.frames.at(-1)!.holdElapsedMs, 600);
  runtime.advance(100);
  assert.equal(player.getState().phase, 'ended');
  assert.equal(surface.disposed, 1);
  player.stop(); player.applyAnchor({ phase: 'holding', positionMs: 1_000, atMs: runtime.time });
  assert.equal(surface.disposed, 1);
});

test('late shared starts enter holding with the original endpoint time and future leads stay detached', async () => {
  const runtime = new Clock(); runtime.time = 5_000;
  const surface = new RecordingSurface(); const player = new LocalPlayer(runtime);
  await player.start(sequence([bars(), audio('loop', true)]), surface, { phase: 'playing', positionMs: 0, atMs: 1_000 });
  assert.equal(player.getState().phase, 'holding');
  assert.equal(player.getState().holdElapsedMs, 3_000);
  assert.equal(surface.disposed, 0);
  player.stop();
  const future = new RecordingSurface();
  await player.start(sequence(), future, { phase: 'playing', positionMs: 0, atMs: 6_000 });
  assert.equal(future.frames.length, 0);
  runtime.advance(500); assert.equal(future.frames.length, 0);
  runtime.advance(500); assert.equal(future.frames.at(-1)!.positionMs, 0);
  player.stop();
});

test('shared paused holding and exit anchors preserve clocks and idempotent fixed deadlines', async () => {
  const runtime = new Clock(); runtime.time = 8_000; const surface = new RecordingSurface(); const player = new LocalPlayer(runtime);
  await player.start(sequence([bars(), audio('loop', true)]), surface, { phase: 'paused', pausedFrom: 'holding', positionMs: 1_000, holdElapsedMs: 700, atMs: 5_000 });
  assert.equal(player.getState().holdElapsedMs, 700);
  player.continueFromBreak(); runtime.advance(100);
  assert.equal(surface.frames.at(-1)!.holdElapsedMs, 700);
  assert.equal(surface.frames.at(-1)!.items[1]!.mediaPlayback, 'paused');
  player.fadeOut(5_000); runtime.advance(100);
  assert.equal(player.getState().phase, 'ended'); assert.equal(surface.disposed, 1);
  const late = new RecordingSurface();
  await player.start(sequence(), late, { phase: 'exiting', positionMs: 1_000, atMs: 0, exitFrom: 'holding', holdElapsedMs: 100, exitDurationMs: 200 });
  assert.equal(late.frames.length, 0); assert.equal(late.disposed, 1);
});

test('holding failures release the surface once and invalid holding clocks cannot replace a healthy anchor', async () => {
  const runtime = new Clock(); const surface = new RecordingSurface(); const player = new LocalPlayer(runtime);
  await player.start(sequence(), surface); runtime.advance(1_000);
  assert.throws(() => player.applyAnchor({ phase: 'holding', positionMs: 1_000, atMs: 0, holdElapsedMs: -1 }), /Holding clock/);
  assert.equal(player.getState().phase, 'holding');
  player.fail(new Error('decoder failed')); player.fail(new Error('late failure'));
  assert.equal(player.getState().error, 'decoder failed'); assert.equal(surface.disposed, 1);
});

test('schema 2 exit freezes normal media while its global fade clock advances from ordinary pause', async () => {
  const runtime = new Clock(); const surface = new RecordingSurface(); const player = new LocalPlayer(runtime);
  await player.start(sequence(), surface); runtime.advance(400); player.pause(); player.fadeOut(); runtime.advance(100);
  assert.equal(surface.frames.at(-1)!.positionMs, 400);
  assert.equal(surface.frames.at(-1)!.opacity, 0.5);
  assert.equal(surface.frames.at(-1)!.items[1]!.mediaPlayback, 'paused');
  assert.equal(surface.frames.at(-1)!.items[1]!.mediaTimeMs, 400);
  player.stop();
});

test('schema 2 live fade advances source clock under frozen clip envelope and late anchors match', async () => {
  const runtime = new Clock(); const surface = new RecordingSurface(); const player = new LocalPlayer(runtime);
  await player.start(sequence(), surface); runtime.advance(400); player.fadeOut(); runtime.advance(100);
  const frame = surface.frames.at(-1)!;
  assert.equal(frame.positionMs, 400);
  assert.equal(frame.items[1]!.localTimeMs, 400);
  assert.equal(frame.items[1]!.mediaTimeMs, 500);
  assert.equal(frame.items[1]!.mediaPlayback, 'playing');
  assert.equal(frame.opacity, 0.5);
  assert.equal(frame.holdElapsedMs, undefined);
  const peer = new LocalPlayer(runtime); const peerSurface = new RecordingSurface();
  await peer.start(sequence(), peerSurface, { phase: 'exiting', positionMs: 400, atMs: 400, exitDurationMs: 200 });
  assert.deepEqual(peerSurface.frames.at(-1), frame);
  player.stop(); peer.stop();
});
