import test from 'node:test';
import assert from 'node:assert/strict';
import type { BarsClip, SequenceV1, VideoClip, VisualTrack } from '../src/domain/sequence.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';
import { LocalPlayer, type PlayerFrame, type Runtime, type Surface } from '../src/playback/local-player.js';

function barsClip(options: {
  id: string;
  trackId?: string;
  startMs?: number;
  duration?: BarsClip['duration'];
  entrance?: BarsClip['entrance'];
  exit?: BarsClip['exit'];
  color?: string;
}): BarsClip {
  return {
    id: options.id,
    trackId: options.trackId ?? 'track-main',
    type: 'bars',
    typeVersion: 1,
    startMs: options.startMs ?? 0,
    duration: options.duration ?? { kind: 'sequence-end' },
    entrance: options.entrance ?? { preset: 'none', version: 1 },
    exit: options.exit ?? { preset: 'none', version: 1 },
    properties: { heightFraction: 0.12, color: options.color ?? '#000000' }
  };
}

function makeSequence(options: {
  end?: SequenceV1['end'];
  clips?: readonly SequenceV1['clips'][number][];
  tracks?: readonly VisualTrack[];
  exitDurationMs?: number;
} = {}): SequenceV1 {
  return {
    schemaVersion: 1,
    id: 'sequence-main',
    revision: 0,
    name: 'Test sequence',
    composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: options.exitDurationMs ?? 100 },
    tracks: options.tracks ?? [{ id: 'track-main', name: 'Main', kind: 'visual', order: 0, enabled: true, locked: false }],
    clips: options.clips ?? [barsClip({ id: 'clip-main' })],
    end: options.end ?? { kind: 'manual' }
  };
}

class FakeRuntime implements Runtime {
  private nextId = 0;
  private callbacks = new Map<number, () => void>();
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
  prepareCount = 0;
  disposeCount = 0;
  preparedPlan: ReturnType<typeof compileSequence> | null = null;

  async prepare(plan: ReturnType<typeof compileSequence>, _signal: AbortSignal): Promise<void> {
    this.prepareCount += 1;
    this.preparedPlan = plan;
  }

  render(frame: PlayerFrame): void { this.frames.push(frame); }

  dispose(): void { this.disposeCount += 1; }
}

test('observers receive the advancing clock and pause keeps that position stable', async () => {
  const runtime = new FakeRuntime();
  const positions: number[] = [];
  const player = new LocalPlayer(runtime, state => positions.push(state.positionMs));
  await player.start(makeSequence(), new FakeSurface());
  runtime.advance(250);
  assert.equal(positions.at(-1), 250);
  player.pause();
  runtime.advance(500);
  assert.equal(positions.at(-1), 250);
  player.resume();
  runtime.advance(100);
  assert.equal(positions.at(-1), 350);
  player.stop();
});

test('evaluation respects clip starts, half-open fixed ends, transition easing, and held sequence ends', () => {
  const fixed = barsClip({
    id: 'clip-fixed',
    startMs: 100,
    duration: { kind: 'fixed', milliseconds: 200 },
    entrance: { preset: 'fade', version: 1, durationMs: 100, easing: 'linear' },
    exit: { preset: 'fade', version: 1, durationMs: 100, easing: 'linear' }
  });
  const held = barsClip({ id: 'clip-held', color: '#123456', exit: { preset: 'fade', version: 1, durationMs: 200, easing: 'linear' } });
  const plan = compileSequence(makeSequence({
    end: { kind: 'fixed', durationMs: 300 },
    clips: [fixed, held]
  }));

  assert.equal(evaluate(plan, 99).some(item => item.clip.id === 'clip-fixed'), false);
  assert.equal(evaluate(plan, 100).find(item => item.clip.id === 'clip-fixed')?.opacity, 0);
  assert.equal(evaluate(plan, 150).find(item => item.clip.id === 'clip-fixed')?.opacity, 0.5);
  assert.equal(evaluate(plan, 250).find(item => item.clip.id === 'clip-fixed')?.opacity, 0.5);
  assert.deepEqual(evaluate(plan, 300).map(item => item.clip.id), ['clip-held']);
  assert.equal(evaluate(plan, 300)[0]?.opacity, 1, 'sequence-end clips use the global exit, not their natural clip exit');
  assert.deepEqual(evaluate(plan, 301).map(item => item.clip.id), ['clip-held'], 'the fixed endpoint is the frozen exit position');
});

test('compiler keeps the snapshot immutable and emits only enabled tracks in back-to-front order', () => {
  const tracks: readonly VisualTrack[] = [
    { id: 'track-front', name: 'Front', kind: 'visual', order: 1, enabled: true, locked: false },
    { id: 'track-hidden', name: 'Hidden', kind: 'visual', order: 2, enabled: false, locked: false },
    { id: 'track-back', name: 'Back', kind: 'visual', order: 0, enabled: true, locked: false }
  ];
  const source = makeSequence({
    tracks,
    clips: [
      barsClip({ id: 'front-clip', trackId: 'track-front' }),
      barsClip({ id: 'hidden-clip', trackId: 'track-hidden' }),
      barsClip({ id: 'back-clip', trackId: 'track-back' })
    ]
  });
  const plan = compileSequence(source);

  assert.deepEqual(plan.clips.map(clip => clip.id), ['back-clip', 'front-clip']);
  (source as { name: string }).name = 'Edited draft';
  ((source.clips[0] as BarsClip).properties as { color: string }).color = '#ffffff';
  assert.equal(plan.snapshot.name, 'Test sequence');
  assert.equal((plan.clips[0] as BarsClip).properties.color, '#000000');
  assert.ok(Object.isFrozen(plan.snapshot));
  assert.ok(Object.isFrozen(plan.clips[0]?.properties));
});

test('an active run renders from its compiled snapshot after the draft changes', async () => {
  const runtime = new FakeRuntime();
  const surface = new FakeSurface();
  const player = new LocalPlayer(runtime);
  const draft = makeSequence();
  await player.start(draft, surface);

  ((draft.clips[0] as BarsClip).properties as { color: string }).color = '#ffffff';
  runtime.advance(1);

  assert.equal((surface.frames.at(-1)?.items[0]?.clip as BarsClip).properties.color, '#000000');
  assert.equal(surface.preparedPlan?.snapshot.clips[0]?.type, 'bars');
  player.stop();
});

test('text uses the same immutable compiled timeline as bars', () => {
  const clip = {
    id: 'title-clip', trackId: 'track-main', type: 'text', typeVersion: 1, startMs: 0,
    duration: { kind: 'sequence-end' },
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { text: 'Title', fontFamily: 'serif', fontSize: 48, minimumFontSize: 24, color: '#ffffff', align: 'center', box: { x: 0, y: 0, width: 100, height: 100 }, shrinkToFit: true }
  } as const;
  const plan=compileSequence(makeSequence({ clips: [clip] }));
  const frame=evaluate(plan,250);
  assert.equal(frame[0]?.clip.type,'text');
  assert.equal(frame[0]?.localTimeMs,250);
  assert.equal(frame[0]?.opacity,1);
});

test('stopping during preparation aborts the run and prevents a late surface attachment', async () => {
  const runtime = new FakeRuntime();
  const player = new LocalPlayer(runtime);
  let resolvePreparation!: () => void;
  let attached = false;
  let observedSignal: AbortSignal | undefined;
  const lateSurface: Surface = {
    prepare: (_plan, signal) => {
      observedSignal = signal;
      return new Promise<void>(resolve => { resolvePreparation = resolve; }).then(() => {
        if (!signal.aborted) attached = true;
      });
    },
    render: () => assert.fail('a stopped run must never render'),
    dispose: () => undefined
  };

  const pendingStart = player.start(makeSequence(), lateSurface);
  assert.equal(player.getState().phase, 'preparing');
  player.stop();
  assert.equal(observedSignal?.aborted, true);
  resolvePreparation();
  await pendingStart;

  assert.equal(attached, false);
  assert.equal(player.getState().phase, 'ended');
  assert.equal(runtime.pendingFrames, 0);
});

test('fade out freezes a paused position, repeated fades do not extend it, and stop is idempotent', async () => {
  const runtime = new FakeRuntime();
  const surface = new FakeSurface();
  const player = new LocalPlayer(runtime);
  await player.start(makeSequence(), surface);
  runtime.advance(500);
  player.pause();
  assert.equal(player.getState().phase, 'paused');
  assert.equal(player.getState().positionMs, 500);

  runtime.advance(300);
  player.fadeOut(100);
  assert.equal(player.getState().phase, 'exiting');
  assert.equal(player.getState().positionMs, 500);
  runtime.advance(50);
  assert.equal(surface.frames.at(-1)?.opacity, 0.5);
  player.fadeOut(1_000);
  runtime.advance(50);

  assert.equal(player.getState().phase, 'ended');
  assert.equal(surface.disposeCount, 1);
  player.stop();
  player.stop();
  player.fadeOut();
  assert.equal(surface.disposeCount, 1);
});

test('twenty fixed-duration starts keep held bars visible at the global endpoint and release every surface', async () => {
  const runtime = new FakeRuntime();
  const player = new LocalPlayer(runtime);
  const sequence = makeSequence({
    end: { kind: 'fixed', durationMs: 10 },
    exitDurationMs: 5,
    clips: [
      barsClip({ id: 'held', duration: { kind: 'sequence-end' } }),
      barsClip({ id: 'natural', duration: { kind: 'fixed', milliseconds: 10 } })
    ]
  });
  const surfaces: FakeSurface[] = [];

  for (let index = 0; index < 20; index += 1) {
    const surface = new FakeSurface();
    surfaces.push(surface);
    await player.start(sequence, surface);
    runtime.advance(10);
    assert.equal(player.getState().phase, 'exiting');
    assert.deepEqual(surface.frames.at(-1)?.items.map(item => item.clip.id), ['held']);
    runtime.advance(5);
    assert.equal(player.getState().phase, 'ended');
  }

  assert.equal(surfaces.every(surface => surface.disposeCount === 1), true);
  assert.equal(runtime.pendingFrames, 0);
});

test('a render error ends the player, disposes the surface, and exposes the error in state', async () => {
  const runtime = new FakeRuntime();
  const player = new LocalPlayer(runtime);
  const surface = new FakeSurface();
  surface.render = () => { throw new Error('renderer failed'); };

  await assert.rejects(player.start(makeSequence(), surface), /renderer failed/);
  assert.deepEqual(player.getState(), { phase: 'ended', positionMs: 0, durationMs: null, error: 'renderer failed' });
  assert.equal(surface.disposeCount, 1);
  assert.equal(runtime.pendingFrames, 0);
});

test('a late shared start renders from its anchor time and clamps future anchors until their time arrives', async () => {
  const runtime = new FakeRuntime();
  runtime.time = 1_250;
  const surface = new FakeSurface();
  const player = new LocalPlayer(runtime);

  await player.start(makeSequence(), surface, { phase: 'playing', positionMs: 200, atMs: 700 });
  assert.equal(surface.frames[0]?.positionMs, 750);
  assert.equal(player.getState().positionMs, 750);

  player.applyAnchor({ phase: 'playing', positionMs: 40, atMs: 1_400 });
  assert.equal(player.getState().positionMs, 40);
  runtime.advance(100);
  assert.equal(player.getState().positionMs, 40);
  runtime.advance(60);
  assert.equal(player.getState().positionMs, 50);
  player.stop();
});

test('shared pause anchors hold position and a later playing anchor resumes from its timestamp', async () => {
  const runtime = new FakeRuntime();
  const surface = new FakeSurface();
  const player = new LocalPlayer(runtime);

  await player.start(makeSequence(), surface, { phase: 'paused', positionMs: 300, atMs: 0 });
  runtime.advance(500);
  assert.equal(player.getState().phase, 'paused');
  assert.equal(player.getState().positionMs, 300);

  player.applyAnchor({ phase: 'playing', positionMs: 300, atMs: 400 });
  assert.equal(player.getState().phase, 'playing');
  assert.equal(player.getState().positionMs, 400);
  runtime.advance(25);
  assert.equal(player.getState().positionMs, 425);

  player.applyAnchor({ phase: 'paused', positionMs: 125, atMs: runtime.now() });
  runtime.advance(250);
  assert.equal(player.getState().phase, 'paused');
  assert.equal(player.getState().positionMs, 125);
  player.stop();
});

test('a late exiting anchor finishes without mounting an already-ended surface', async () => {
  const runtime = new FakeRuntime();
  runtime.time = 500;
  const player = new LocalPlayer(runtime);
  const surface = new FakeSurface();

  await player.start(makeSequence(), surface, { phase: 'exiting', positionMs: 321, atMs: 100, exitDurationMs: 200 });

  assert.equal(player.getState().phase, 'ended');
  assert.equal(player.getState().positionMs, 321);
  assert.equal(surface.prepareCount, 0);
  assert.equal(surface.frames.length, 0);
  assert.equal(surface.disposeCount, 1);
  assert.equal(runtime.pendingFrames, 0);
});

test('identical exit anchors do not restart a fade and a hidden clock jump finishes from the fixed deadline', async () => {
  const runtime = new FakeRuntime();
  runtime.time = 1_050;
  const surface = new FakeSurface();
  const player = new LocalPlayer(runtime);

  await player.start(makeSequence(), surface, { phase: 'exiting', positionMs: 321, atMs: 1_000, exitDurationMs: 100 });
  assert.equal(player.getState().phase, 'exiting');
  assert.equal(surface.frames.at(-1)?.opacity, 0.5);

  player.applyAnchor({ phase: 'exiting', positionMs: 321, atMs: 1_000, exitDurationMs: 100 });
  runtime.advance(50);
  assert.equal(player.getState().phase, 'ended');
  assert.equal(surface.disposeCount, 1);
  assert.equal(runtime.pendingFrames, 0);

  const jumpRuntime = new FakeRuntime();
  jumpRuntime.time = 1_000;
  const jumpSurface = new FakeSurface();
  const jumpPlayer = new LocalPlayer(jumpRuntime);
  await jumpPlayer.start(makeSequence({ end: { kind: 'fixed', durationMs: 50 }, exitDurationMs: 100 }), jumpSurface, {
    phase: 'playing', positionMs: 30, atMs: 900
  });
  assert.equal(jumpPlayer.getState().phase, 'exiting');
  assert.ok(Math.abs((jumpSurface.frames.at(-1)?.opacity ?? 0) - 0.2) < 0.000001);
  jumpRuntime.advance(500);
  assert.equal(jumpPlayer.getState().phase, 'ended');
  assert.equal(jumpSurface.disposeCount, 1);
  assert.equal(jumpRuntime.pendingFrames, 0);
});

test('invalid shared anchors are rejected before they can disturb the current run', async () => {
  const runtime = new FakeRuntime();
  const player = new LocalPlayer(runtime);
  const currentSurface = new FakeSurface();
  const rejectedSurface = new FakeSurface();
  await player.start(makeSequence(), currentSurface);
  runtime.advance(25);

  await assert.rejects(
    player.start(makeSequence(), rejectedSurface, { phase: 'playing', positionMs: -1, atMs: 0 }),
    /position must be a finite, non-negative number/
  );
  assert.throws(
    () => player.applyAnchor({ phase: 'playing', positionMs: 10, atMs: Number.NaN }),
    /time must be a finite, non-negative number/
  );
  assert.equal(player.getState().phase, 'playing');
  assert.equal(player.getState().positionMs, 25);
  assert.equal(currentSurface.disposeCount, 0);
  assert.equal(rejectedSurface.prepareCount, 0);
  player.stop();
});

test('replacing a run while preparation is pending cannot apply its late shared anchor', async () => {
  const runtime = new FakeRuntime();
  const player = new LocalPlayer(runtime);
  let finishPreparation!: () => void;
  const staleFrames: PlayerFrame[] = [];
  const staleSurface: Surface = {
    prepare: () => new Promise<void>(resolve => { finishPreparation = resolve; }),
    render: frame => staleFrames.push(frame),
    dispose: () => undefined
  };
  const pendingStart = player.start(makeSequence(), staleSurface, { phase: 'playing', positionMs: 500, atMs: 0 });
  const currentSurface = new FakeSurface();
  await player.start(makeSequence(), currentSurface, { phase: 'paused', positionMs: 75, atMs: 0 });

  finishPreparation();
  await pendingStart;

  assert.equal(player.getState().phase, 'paused');
  assert.equal(player.getState().positionMs, 75);
  assert.equal(staleFrames.length, 0);
});

function mediaSequence(durationMs = 8000): SequenceV1 {
  const video:VideoClip={...barsClip({id:'movie',trackId:'video-track'}),type:'video',duration:{kind:'media'},properties:{source:{kind:'foundry-file',path:'worlds/test/movie.mp4'},fit:'contain',volume:.5,muted:false,durationMs}};
  return makeSequence({clips:[video,barsClip({id:'bars'})],tracks:[{id:'video-track',name:'Video',kind:'visual',order:0,enabled:true,locked:false},{id:'track-main',name:'Bars',kind:'visual',order:1,enabled:true,locked:false}],end:{kind:'media',clipId:'movie'}});
}

test('video duration drives the common endpoint, retains its last frame and fades every layer together', async()=>{
  const source=mediaSequence();const plan=compileSequence(source);
  assert.equal(plan.durationMs,8000);
  assert.deepEqual(evaluate(plan,8000).map(item=>[item.clip.type,item.localTimeMs]),[['video',8000],['bars',8000]]);
  const runtime=new FakeRuntime();const surface=new FakeSurface();const player=new LocalPlayer(runtime);
  await player.start(source,surface);runtime.advance(8050);
  assert.equal(player.getState().phase,'exiting');
  assert.equal(surface.frames.at(-1)?.opacity,.5);
  assert.equal(surface.frames.at(-1)?.items.length,2);
  runtime.advance(50);assert.equal(surface.disposeCount,1);assert.equal(player.getState().phase,'ended');
});

test('unconfirmed video metadata and timing beyond its confirmed end are rejected before playback',()=>{
  const source=mediaSequence();const clip=source.clips[0] as VideoClip;
  const {durationMs:_duration,...properties}=clip.properties;
  assert.throws(()=>compileSequence({...source,clips:[{...clip,properties},source.clips[1]!]}),/MEDIA_METADATA_REQUIRED/);
  assert.throws(()=>compileSequence({...source,clips:[clip,{...source.clips[1]!,startMs:8000}]}),/extends beyond/);
});

test('separate preparation retains resources without drawing until the shared start time',async()=>{
  const runtime=new FakeRuntime();const surface=new FakeSurface();const player=new LocalPlayer(runtime);
  await player.prepare(mediaSequence(),surface);
  assert.equal(player.getState().phase,'preparing');assert.equal(surface.frames.length,0);
  runtime.advance(30000);assert.equal(surface.frames.length,0);
  player.play({phase:'playing',positionMs:0,atMs:31500});
  runtime.advance(1499);assert.equal(surface.frames.length,0);
  runtime.advance(1);assert.equal(surface.frames[0]?.positionMs,0);
  assert.equal(surface.prepareCount,1);player.stop();assert.equal(surface.disposeCount,1);
});

test('exiting an already-prepared surface cannot later play it; asynchronous failure releases it once',async()=>{
  const runtime=new FakeRuntime();const player=new LocalPlayer(runtime);const surface=new FakeSurface();
  await player.prepare(mediaSequence(),surface);player.stop();
  assert.throws(()=>player.play(),/MEDIA_NOT_PREPARED/);assert.equal(surface.frames.length,0);
  const second=new FakeSurface();await player.start(mediaSequence(),second);
  player.fail(new Error('MEDIA_BUFFER_TIMEOUT'));player.fail(new Error('late'));player.stop();
  assert.equal(second.disposeCount,1);assert.equal(player.getState().error,'MEDIA_BUFFER_TIMEOUT');assert.equal(runtime.pendingFrames,0);
});

test('private preview replans immutable frames immediately while its clock and resources continue', async () => {
  const runtime = new FakeRuntime(), surface = new FakeSurface(), player = new LocalPlayer(runtime);
  const original = makeSequence();
  await player.startPreview(original, surface);
  runtime.advance(250);
  const previousFrame = surface.frames.at(-1)!;
  const changed = { ...original, clips: [barsClip({ id: 'clip-main', startMs: 50, entrance: { preset: 'fade', version: 1, durationMs: 400, easing: 'linear' } })] };
  assert.equal(player.updatePreview(changed), true);
  const latest = surface.frames.at(-1)!;
  assert.equal(latest.positionMs, 250);
  assert.equal(latest.items[0]?.localTimeMs, 200);
  assert.equal(latest.items[0]?.opacity, .5);
  assert.notEqual(latest.items[0]?.clip, previousFrame.items[0]?.clip);
  assert.equal(previousFrame.items[0]?.clip.startMs, 0);
  assert.equal(surface.preparedPlan?.clips[0]?.startMs, 0);
  assert.equal(Object.isFrozen(latest.items[0]?.clip), true);
  runtime.advance(100);
  assert.equal(player.getState().positionMs, 350);
  assert.equal(surface.prepareCount, 1);
  assert.equal(surface.disposeCount, 0);
  assert.equal(runtime.pendingFrames, 1);
  player.stop();
});

test('ordinary immutable starts and incompatible or invalid preview updates leave playback untouched', async () => {
  const runtime = new FakeRuntime(), surface = new FakeSurface(), player = new LocalPlayer(runtime);
  const original = mediaSequence();
  await player.start(original, surface);
  assert.equal(player.updatePreview(original), false);
  assert.equal(surface.prepareCount, 1);
  player.stop();
  const preview = new FakeSurface();
  await player.startPreview(original, preview);
  runtime.advance(75);
  const frame = preview.frames.at(-1), count = preview.frames.length;
  const movie = original.clips[0] as VideoClip;
  assert.equal(player.updatePreview({ ...original, composition: { width: 1280, height: 720 } }), false);
  assert.equal(player.updatePreview({ ...original, clips: [{ ...movie, properties: { ...movie.properties, source: { kind: 'foundry-file', path: 'worlds/test/other.mp4' } } }, original.clips[1]!] }), false);
  assert.equal(player.updatePreview({ ...original, clips: [{ ...movie, startMs: -1 }, original.clips[1]!] }), false);
  assert.equal(preview.frames.length, count);
  assert.equal(preview.frames.at(-1), frame);
  assert.equal(preview.disposeCount, 0);
  runtime.advance(25);
  assert.equal(player.getState().positionMs, 100);
  player.stop();
});

test('private preview media trim and volume edits replace frame metadata without preparing again', async () => {
  const runtime = new FakeRuntime(), surface = new FakeSurface(), player = new LocalPlayer(runtime);
  const original = mediaSequence();
  await player.startPreview(original, surface);
  runtime.advance(500);
  const movie = original.clips[0] as VideoClip;
  const edited: VideoClip = { ...movie, typeVersion: 2, properties: { ...movie.properties, volume: .25, sourceRange: { inMs: 1000, outMs: 6000 } } };
  assert.equal(player.updatePreview({ ...original, clips: [edited, original.clips[1]!] }), true);
  assert.equal(player.getState().durationMs, 5000);
  assert.deepEqual(surface.frames.at(-1)?.items[0]?.clip, edited);
  assert.equal(surface.prepareCount, 1);
  assert.equal(surface.disposeCount, 0);
  runtime.advance(100);
  assert.equal(player.getState().positionMs, 600);
  player.stop();
});

function previewBreaks(): SequenceV1 {
  return { ...makeSequence({ end: { kind: 'manual', durationMs: 3000 } }), schemaVersion: 3,
    breaks: [{ id: 'first', positionMs: 1000 }, { id: 'second', positionMs: 2000 }] };
}

test('preview keeps paused and held transport, following edited Break and endpoint positions', async () => {
  const runtime = new FakeRuntime(), surface = new FakeSurface(), player = new LocalPlayer(runtime);
  const original = previewBreaks();
  await player.startPreview(original, surface);
  runtime.advance(1000); runtime.advance(125); player.continueFromBreak();
  runtime.advance(1000); runtime.advance(250); player.pause();
  assert.equal(player.getState().breakId, 'second');
  const moved = { ...original, breaks: [{ id: 'first', positionMs: 2500 }, { id: 'second', positionMs: 500 }] };
  assert.equal(player.updatePreview(moved), true);
  assert.equal(player.getState().phase, 'paused');
  assert.equal(player.getState().positionMs, 500);
  assert.equal(player.getState().holdElapsedMs, 250);
  runtime.advance(500);
  assert.equal(player.getState().holdElapsedMs, 250);
  player.resume(); runtime.advance(50);
  assert.equal(player.getState().holdElapsedMs, 300);
  player.continueFromBreak(); runtime.advance(2000);
  assert.equal(player.getState().phase, 'playing');
  assert.equal(player.getState().positionMs, 2500);
  assert.deepEqual(player.getState().breakHistory?.map(entry => entry.id), ['first', 'second']);
  runtime.advance(500);
  assert.equal(player.getState().phase, 'holding');
  assert.equal(player.updatePreview({ ...moved, end: { kind: 'manual', durationMs: 4000 } }), true);
  assert.equal(player.getState().positionMs, 4000);
  assert.equal(player.getState().phase, 'holding');
  assert.equal(surface.prepareCount, 1);
  assert.equal(surface.disposeCount, 0);
  player.stop();
});

test('unconsumed preview Break moved behind the playhead does not rewind or later fire', async () => {
  const runtime = new FakeRuntime(), surface = new FakeSurface(), player = new LocalPlayer(runtime);
  const original = previewBreaks();
  await player.startPreview(original, surface);
  runtime.advance(500);
  assert.equal(player.updatePreview({ ...original, breaks: [{ id: 'first', positionMs: 100 }, { id: 'second', positionMs: 2000 }] }), true);
  assert.equal(player.getState().phase, 'playing');
  assert.equal(player.getState().positionMs, 500);
  assert.equal(player.getState().breakHistory?.[0]?.elapsedMs, 0);
  assert.equal(player.updatePreview(original), true);
  runtime.advance(500);
  assert.equal(player.getState().phase, 'playing');
  runtime.advance(1000);
  assert.equal(player.getState().phase, 'holding');
  assert.equal(player.getState().breakId, 'second');
  player.stop();
});

test('preview pause remains frozen and end shortening starts a natural exit without restarting it on edits', async () => {
  const runtime = new FakeRuntime(), surface = new FakeSurface(), player = new LocalPlayer(runtime);
  const original = makeSequence({ end: { kind: 'fixed', durationMs: 3000 }, exitDurationMs: 1000 });
  await player.startPreview(original, surface);
  runtime.advance(500); player.pause();
  assert.equal(player.updatePreview({ ...original, clips: [barsClip({ id: 'clip-main', startMs: 100 })] }), true);
  runtime.advance(500);
  assert.equal(player.getState().phase, 'paused');
  assert.equal(player.getState().positionMs, 500);
  player.resume(); runtime.advance(500);
  const shorter = { ...original, end: { kind: 'fixed' as const, durationMs: 750 } };
  assert.equal(player.updatePreview(shorter), true);
  assert.equal(player.getState().phase, 'exiting');
  runtime.advance(200);
  assert.equal(surface.frames.at(-1)?.opacity, .8);
  assert.equal(player.updatePreview({ ...shorter, clips: [barsClip({ id: 'clip-main', color: '#ffffff' })] }), true);
  assert.equal(surface.frames.at(-1)?.opacity, .8);
  assert.equal(player.updatePreview({ ...shorter, presentation: { ...shorter.presentation, exitDurationMs: 2000 } }), true);
  assert.equal(surface.frames.at(-1)?.opacity, .9);
  assert.equal(surface.prepareCount, 1);
  assert.equal(surface.disposeCount, 0);
  player.stop();
});
