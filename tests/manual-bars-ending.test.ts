import test from 'node:test';
import assert from 'node:assert/strict';
import type { BarsClip, SequenceV1, TextClip, VisualClip } from '../src/domain/sequence.js';
import { clipDurationMs, isTerminalManualClip } from '../src/domain/clip-timing.js';
import { createBarsSequence } from '../src/domain/validation.js';
import { applyTimelineCommand, timelineConflicts } from '../src/application/timeline-commands.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';
import { LocalPlayer, type PlayerFrame, type Runtime, type Surface } from '../src/playback/local-player.js';

function bars(id = 'bars', trackId = 'main', startMs = 0): BarsClip {
  return {
    id, trackId, startMs, type: 'bars', typeVersion: 1,
    duration: { kind: 'fixed', milliseconds: 5_000 },
    entrance: { preset: 'fade-slide', version: 1, durationMs: 500, easing: 'linear' },
    exit: { preset: 'none', version: 1 },
    properties: { heightFraction: 0.12, color: '#000000' }
  };
}

function sequence(clips: readonly VisualClip[] = [bars()]): SequenceV1 {
  return {
    schemaVersion: 1, id: 'manual-bars', revision: 0, name: 'Manual bars',
    composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 100 },
    tracks: [...new Set(clips.map(clip => clip.trackId))].map((id, order) => ({
      id, order, name: id, kind: 'visual', enabled: true, locked: false
    })),
    clips, end: { kind: 'manual' }
  };
}

test('automatic five-second bars switched to manual retain their authored interval and hold indefinitely', () => {
  let nextId = 0;
  const ids = () => `default_${++nextId}`;
  const initial = { ...createBarsSequence('Automatic bars', ids), schemaVersion: 1 as const, clips: [],
    end: { kind: 'fixed' as const, automatic: true, durationMs: 1 } };
  const automatic = applyTimelineCommand(initial, {
    kind: 'add-clip', trackId: initial.tracks[0]!.id, type: 'bars', startMs: 0
  }, ids);
  assert.deepEqual(automatic.clips[0]!.duration, { kind: 'fixed', milliseconds: 5_000 });
  const manual = applyTimelineCommand(automatic, { kind: 'set-end', end: { kind: 'manual' } }, ids);
  const plan = compileSequence(manual);
  for (const position of [5_000, 5_001, 60_000]) {
    assert.equal(evaluate(plan, position)[0]!.opacity, 1);
    assert.equal(evaluate(plan, position)[0]!.localTimeMs, position);
  }
  assert.deepEqual(manual.clips, automatic.clips);
  assert.equal(clipDurationMs(manual, manual.clips[0]!), 5_000);
  const restored = applyTimelineCommand(manual, { kind: 'set-end', end: automatic.end }, ids);
  assert.deepEqual(restored, automatic);
  assert.deepEqual(evaluate(compileSequence(restored), 5_000), []);
});

test('terminal manual fixed bars without Out hold and only play entrance once', () => {
  const source = sequence([bars('bars', 'main', 1_000)]);
  const original = structuredClone(source);
  const plan = compileSequence(source);
  assert.deepEqual(evaluate(plan, 999), []);
  for (const position of [1_250, 5_500, 6_000, 60_000, 1_250]) {
    const item = evaluate(plan, position)[0]!;
    const progress = position === 1_250 ? 0.5 : 1;
    assert.equal(item.opacity, progress);
    assert.equal(item.barsReveal, progress);
    assert.equal(item.localTimeMs, position - 1_000);
  }
  assert.deepEqual(source, original);
  assert.deepEqual(plan.snapshot.clips[0]!.exit, original.clips[0]!.exit);
  assert.deepEqual(plan.snapshot.clips[0]!.duration, original.clips[0]!.duration);
});

test('terminal manual fixed bars with an explicit Out keep their finite duration and exit channels', () => {
  for (const preset of ['fade', 'slide', 'fade-slide'] as const) {
    const sourceClip: BarsClip = { ...bars(),
      exit: { preset, version: 1, durationMs: 1_000, easing: 'linear' } };
    const source = sequence([sourceClip]);
    const original = structuredClone(source);
    const plan = compileSequence(source);
    const exiting = evaluate(plan, 4_500)[0]!;
    assert.equal(exiting.opacity, preset === 'slide' ? 1 : 0.5);
    assert.equal(exiting.barsReveal, preset === 'fade' ? 1 : 0.5);
    for (const position of [5_000, 5_001, 60_000]) assert.deepEqual(evaluate(plan, position), []);
    assert.deepEqual(source, original);
    assert.deepEqual(plan.snapshot.clips[0], original.clips[0]);
  }
});

test('sequence-end bars retain their existing hold behavior even with an authored Out', () => {
  const sourceClip: BarsClip = { ...bars(), duration: { kind: 'sequence-end' },
    exit: { preset: 'fade-slide', version: 1, durationMs: 1_000, easing: 'linear' } };
  const source = sequence([sourceClip]);
  const original = structuredClone(source);
  const plan = compileSequence(source);
  assert.equal(evaluate(plan, 250)[0]!.opacity, 0.5);
  assert.equal(evaluate(plan, 250)[0]!.barsReveal, 0.5);
  for (const position of [4_500, 5_000, 60_000]) {
    const item = evaluate(plan, position)[0]!;
    assert.equal(item.opacity, 1);
    assert.equal(item.barsReveal, 1);
  }
  assert.deepEqual(source, original);
  assert.deepEqual(plan.snapshot.clips[0], original.clips[0]);
});

test('terminal helper follows enabled tracks and compiler time/id ordering independently of array order', () => {
  const first = bars('first');
  const final = bars('final', 'main', 6_000);
  const hidden = bars('hidden', 'hidden', 10_000);
  const source = sequence([final, hidden, first]);
  const manual = { ...source,
    tracks: source.tracks.map(track => track.id === 'hidden' ? { ...track, enabled: false } : track) };
  assert.equal(isTerminalManualClip(manual, first), false);
  assert.equal(isTerminalManualClip(manual, final), true);
  assert.equal(isTerminalManualClip(manual, hidden), false);
  const tied = bars('zzz', 'main', 6_000);
  assert.equal(isTerminalManualClip({ ...manual, clips: [tied, ...manual.clips] }, final), false);
  assert.equal(isTerminalManualClip({ ...manual, clips: [tied, ...manual.clips] }, tied), true);
  assert.equal(isTerminalManualClip({ ...manual, end: { kind: 'fixed', durationMs: 20_000 } }, final), false);
  assert.deepEqual(evaluate(compileSequence(manual), 60_000).map(item => [item.clip.id, item.opacity, item.barsReveal]), [['final', 1, 1]]);
});

test('later bars or titles keep earlier bars finite and adding them uses authored duration', () => {
  const first: BarsClip = { ...bars(),
    exit: { preset: 'fade-slide', version: 1, durationMs: 1_000, easing: 'linear' } };
  const title: TextClip = {
    id: 'title', trackId: 'main', startMs: 6_000, type: 'text', typeVersion: 1,
    duration: { kind: 'fixed', milliseconds: 1_000 },
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { text: 'Title', fontFamily: 'serif', fontSize: 48, minimumFontSize: 24, color: '#ffffff',
      align: 'center', box: { x: 0, y: 0, width: 100, height: 100 }, shrinkToFit: true }
  };
  for (const later of [title, bars('later', 'main', 6_000)]) {
    const source = sequence([later, first]);
    assert.deepEqual(timelineConflicts(source), []);
    const plan = compileSequence(source);
    assert.equal(evaluate(plan, 4_500)[0]!.opacity, 0.5);
    assert.equal(evaluate(plan, 4_500)[0]!.barsReveal, 0.5);
    assert.deepEqual(evaluate(plan, 5_000), []);
    assert.deepEqual(evaluate(plan, 5_999), []);
    assert.deepEqual(evaluate(plan, 6_000).map(item => item.clip.id), [later.id]);
    if (later.type === 'text') assert.deepEqual(evaluate(plan, 60_000), []);
  }
  const added = applyTimelineCommand(sequence(), {
    kind: 'add-clip', type: 'text', trackId: 'main', startMs: 5_000
  }, () => 'added-title');
  assert.deepEqual(timelineConflicts(added), []);
  assert.equal(added.clips[1]!.startMs, 5_000);
  const addedPlan = compileSequence(added);
  assert.deepEqual(evaluate(addedPlan, 5_000).map(item => item.clip.id), ['added-title']);
  assert.deepEqual(evaluate(addedPlan, 60_000), []);
});

test('finite fixed bars preserve their natural exit and endpoint', () => {
  const clip: BarsClip = { ...bars(),
    exit: { preset: 'fade-slide', version: 1, durationMs: 1_000, easing: 'linear' } };
  const plan = compileSequence({ ...sequence([clip]), end: { kind: 'fixed', durationMs: 6_000 } });
  assert.equal(evaluate(plan, 4_500)[0]!.opacity, 0.5);
  assert.equal(evaluate(plan, 4_500)[0]!.barsReveal, 0.5);
  assert.deepEqual(evaluate(plan, 5_000), []);
  assert.deepEqual(evaluate(plan, 60_000), []);
});

class FakeRuntime implements Runtime {
  time = 0;
  private nextId = 0;
  private callbacks = new Map<number, () => void>();
  now(): number { return this.time; }
  requestFrame(callback: () => void): number { const id = ++this.nextId; this.callbacks.set(id, callback); return id; }
  cancelFrame(id: number): void { this.callbacks.delete(id); }
  advance(milliseconds: number): void {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
  get pendingFrames(): number { return this.callbacks.size; }
}

class FakeSurface implements Surface {
  frames: PlayerFrame[] = [];
  disposed = 0;
  signal?: AbortSignal;
  async prepare(_plan: ReturnType<typeof compileSequence>, signal: AbortSignal): Promise<void> { this.signal = signal; }
  render(frame: PlayerFrame): void { this.frames.push(frame); }
  dispose(): void { this.disposed += 1; }
}

test('manual held bars share one global fade and release the surface once', async () => {
  const runtime = new FakeRuntime();
  const surface = new FakeSurface();
  const player = new LocalPlayer(runtime);
  await player.start(sequence(), surface);
  runtime.advance(60_000);
  assert.equal(player.getState().phase, 'playing');
  assert.deepEqual(surface.frames.at(-1)!.items.map(item => [item.opacity, item.barsReveal]), [[1, 1]]);
  player.fadeOut();
  runtime.advance(50);
  assert.equal(player.getState().phase, 'exiting');
  assert.equal(surface.frames.at(-1)!.opacity, 0.5);
  assert.deepEqual(surface.frames.at(-1)!.items.map(item => [item.opacity, item.barsReveal]), [[1, 1]]);
  runtime.advance(50);
  assert.equal(player.getState().phase, 'ended');
  assert.equal(surface.disposed, 1);
  assert.equal(surface.signal?.aborted, true);
  assert.equal(runtime.pendingFrames, 0);
  player.stop();
  assert.equal(surface.disposed, 1);
});
