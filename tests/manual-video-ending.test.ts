import test from 'node:test';
import assert from 'node:assert/strict';
import type { SequenceV1, TextClip, VideoClip, VisualClip } from '../src/domain/sequence.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';
import { LocalPlayer, type PlayerFrame, type Runtime, type Surface } from '../src/playback/local-player.js';

function video(id = 'movie', trackId = 'main', startMs = 0): VideoClip {
  return {
    id, trackId, startMs, type: 'video', typeVersion: 1, duration: { kind: 'media' },
    entrance: { preset: 'none', version: 1 },
    exit: { preset: 'fade', version: 1, durationMs: 500, easing: 'linear' },
    properties: {
      source: { kind: 'foundry-file', path: 'worlds/test/movie.webm' },
      fit: 'contain', volume: 1, muted: false, durationMs: 2_000
    }
  };
}

function sequence(clips: readonly VisualClip[] = [video()]): SequenceV1 {
  return {
    schemaVersion: 1, id: 'manual-video', revision: 0, name: 'Manual video',
    composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 100 },
    tracks: [...new Set(clips.map(clip => clip.trackId))].map((id, order) => ({
      id, order, name: id, kind: 'visual', enabled: true, locked: false
    })),
    clips, end: { kind: 'manual' }
  };
}

test('the final video on each manual track holds with clamped source time and no natural exit fade', () => {
  const first = video('first');
  const final = video('final', 'main', 3_000);
  const other = video('other', 'overlay', 500);
  // Authored array order does not determine the final clip on a track.
  const plan = compileSequence(sequence([final, other, first]));
  assert.equal(plan.durationMs, null);
  assert.equal(evaluate(plan, 1_750).find(item => item.clip.id === 'first')?.opacity, 0.5);
  assert.deepEqual(evaluate(plan, 2_000).map(item => item.clip.id), ['other']);
  assert.deepEqual(evaluate(plan, 4_750).map(item => [item.clip.id, item.localTimeMs, item.opacity]), [
    ['final', 1_750, 1], ['other', 2_000, 1]
  ]);
  for (const position of [5_000, 5_001, 60_000]) {
    assert.deepEqual(evaluate(plan, position).map(item => [item.clip.id, item.localTimeMs, item.opacity]), [
      ['final', 2_000, 1], ['other', 2_000, 1]
    ]);
  }
});

test('a later title makes the earlier manual video finite even through the gap and after the title ends', () => {
  const title: TextClip = {
    id: 'title', trackId: 'main', startMs: 3_000, type: 'text', typeVersion: 1,
    duration: { kind: 'fixed', milliseconds: 1_000 },
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: {
      text: 'Title', fontFamily: 'serif', fontSize: 48, minimumFontSize: 24,
      color: '#ffffff', align: 'center', box: { x: 0, y: 0, width: 100, height: 100 }, shrinkToFit: true
    }
  };
  const plan = compileSequence(sequence([video(), title]));
  assert.equal(evaluate(plan, 1_750)[0]?.opacity, 0.5);
  for (const position of [2_000, 2_999, 4_000, 60_000]) assert.deepEqual(evaluate(plan, position), []);
  assert.deepEqual(evaluate(plan, 3_000).map(item => item.clip.id), ['title']);
});

test('manual trimmed video holds at the selected range duration while retaining full-source metadata', () => {
  const base = video('trimmed', 'main', 1_000);
  const clip: VideoClip = {
    ...base, typeVersion: 2,
    entrance: { preset: 'fade', version: 1, durationMs: 250, easing: 'linear' },
    properties: { ...base.properties, durationMs: 5_000, sourceRange: { inMs: 1_000, outMs: 3_000 } }
  };
  const plan = compileSequence(sequence([clip]));
  assert.deepEqual(evaluate(plan, 999), []);
  assert.equal(evaluate(plan, 1_125)[0]?.opacity, 0.5);
  assert.equal(evaluate(plan, 2_750)[0]?.opacity, 1);
  assert.deepEqual(evaluate(plan, 60_000).map(item => [item.localTimeMs, item.opacity]), [[2_000, 1]]);
  assert.equal((plan.clips[0] as VideoClip).properties.durationMs, 5_000);
  const { durationMs: _duration, ...properties } = base.properties;
  assert.throws(() => compileSequence(sequence([{ ...base, properties }])), /MEDIA_METADATA_REQUIRED/);
});

test('hidden tracks do not change which visible manual videos hold', () => {
  const visible = video('visible');
  const hidden = video('hidden', 'hidden', 10_000);
  const source = sequence([visible, hidden]);
  const plan = compileSequence({
    ...source, tracks: source.tracks.map(track => track.id === 'hidden' ? { ...track, enabled: false } : track)
  });
  assert.equal(plan.durationMs, null);
  assert.deepEqual(evaluate(plan, 60_000).map(item => [item.clip.id, item.localTimeMs, item.opacity]), [
    ['visible', 2_000, 1]
  ]);
});

class FakeRuntime implements Runtime {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();
  time = 0;
  now(): number { return this.time; }
  requestFrame(callback: () => void): number {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id;
  }
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
  readonly frames: PlayerFrame[] = [];
  disposeCount = 0;
  signal?: AbortSignal;
  async prepare(_plan: ReturnType<typeof compileSequence>, signal: AbortSignal): Promise<void> { this.signal = signal; }
  render(frame: PlayerFrame): void { this.frames.push(frame); }
  dispose(): void { this.disposeCount += 1; }
}

test('manual player stays playing past video end, fades the held frame globally, and releases the run', async () => {
  const runtime = new FakeRuntime();
  const surface = new FakeSurface();
  const player = new LocalPlayer(runtime);
  await player.start(sequence(), surface);
  runtime.advance(60_000);
  assert.equal(player.getState().phase, 'playing');
  assert.equal(player.getState().durationMs, null);
  assert.equal(surface.disposeCount, 0);
  assert.equal(surface.frames.at(-1)?.positionMs, 60_000);
  assert.deepEqual(surface.frames.at(-1)?.items.map(item => [item.localTimeMs, item.opacity]), [[2_000, 1]]);
  player.fadeOut();
  runtime.advance(50);
  assert.equal(player.getState().phase, 'exiting');
  assert.equal(surface.frames.at(-1)?.opacity, 0.5);
  assert.deepEqual(surface.frames.at(-1)?.items.map(item => [item.localTimeMs, item.opacity]), [[2_000, 1]]);
  runtime.advance(50);
  assert.equal(player.getState().phase, 'ended');
  assert.equal(surface.disposeCount, 1);
  assert.equal(surface.signal?.aborted, true);
  assert.equal(runtime.pendingFrames, 0);
  player.stop();
  assert.equal(surface.disposeCount, 1);

  const stoppedSurface = new FakeSurface();
  await player.start(sequence(), stoppedSurface);
  runtime.advance(3_000);
  player.stop();
  assert.equal(player.getState().phase, 'ended');
  assert.equal(stoppedSurface.disposeCount, 1);
  assert.equal(stoppedSurface.signal?.aborted, true);
  assert.equal(runtime.pendingFrames, 0);
});
