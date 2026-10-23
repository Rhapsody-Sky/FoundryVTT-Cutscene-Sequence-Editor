import test from 'node:test';
import assert from 'node:assert/strict';
import type { SequenceV1, VideoClip } from '../src/domain/sequence.js';
import type { FrameItem } from '../src/playback/evaluate.js';
import { LocalPlayer, type PlayerFrame, type Runtime } from '../src/playback/local-player.js';
import { videoRenderer } from '../src/rendering/video-renderer.js';

const clip: VideoClip = {
  id: 'loop-video', trackId: 'video', type: 'video', typeVersion: 3, startMs: 10_000,
  duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
  properties: { source: { kind: 'foundry-file', path: 'worlds/test/loop.webm' },
    durationMs: 5000, loop: true, fit: 'contain', volume: 0.7, muted: true }
};

class FakeVideo extends EventTarget {
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  className = ''; src = ''; preload = ''; controls = false; playsInline = true;
  disablePictureInPicture = true; muted = true; volume = 1; playbackRate = 1;
  paused = true; seeking = false; ended = false; duration = 5; readyState = 4;
  buffered = { length: 1, start: () => 0, end: () => this.duration };
  error: MediaError | null = null;
  plays = 0; pauses = 0; loads = 0; removed = false; delaySeeks = false;
  readonly seeks: number[] = [];
  nextPlay: (() => Promise<void>) | null = null;
  private time = 0;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  get currentTime() { return this.time; }
  set currentTime(value: number) {
    this.time = value; this.seeks.push(value); this.ended = false;
    if (this.delaySeeks) this.seeking = true;
  }
  advanceTo(seconds: number) { this.time = seconds; }
  finishSeek() { this.seeking = false; this.dispatchEvent(new Event('seeked')); }
  get listenerCount() { return [...this.listeners.values()].reduce((total, list) => total + list.size, 0); }
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    const [type, listener, options] = args;
    if (listener) {
      const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener); this.listeners.set(type, listeners);
      if (typeof options === 'object' && options.signal) {
        options.signal.addEventListener('abort', () => listeners.delete(listener), { once: true });
      }
    }
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    const [type, listener] = args;
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(...args);
  }
  play() { this.plays += 1; this.paused = false; return this.nextPlay?.() ?? Promise.resolve(); }
  pause() { this.pauses += 1; this.paused = true; }
  load() { this.loads += 1; }
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  remove() { this.removed = true; }
}

const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

async function setup(t: { after(callback: () => void): void }, selected = clip, duration = 5) {
  const video = new FakeVideo(); video.duration = duration;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => video } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const controller = new AbortController();
  const errors: unknown[] = [];
  const renderer = videoRenderer(selected, { append() {} } as unknown as HTMLElement,
    { signal: controller.signal, onError: error => errors.push(error) });
  t.after(() => renderer.dispose());
  await renderer.prepare();
  const draw = (localTimeMs: number, phase: PlayerFrame['phase'] = 'playing', opacity = 1, looping = true) => {
    const item: FrameItem = { clip: selected, localTimeMs, opacity: 0.8, ...(looping ? { videoLoop: true } : {}) };
    renderer.draw(item, { items: [item], positionMs: selected.startMs + localTimeMs, phase, opacity });
  };
  return { renderer, video, errors, controller, draw };
}

test('video live numeric trim, volume and box edits reuse the prepared decoder', async t => {
  const { renderer, video, draw, errors } = await setup(t);
  draw(1000); await flush();
  const edited: VideoClip = { ...clip, typeVersion: 6, properties: { ...clip.properties, volume: .25,
    box: { x: 0, y: 0, width: 960, height: 540 }, sourceRange: { inMs: 2000, outMs: 4500 } } };
  const item: FrameItem = { clip: edited, localTimeMs: 1000, opacity: 1, videoLoop: true };
  renderer.draw(item, { phase: 'playing', positionMs: 11000, opacity: 1, items: [item] });
  await flush();
  assert.equal(video.currentTime, 3);
  assert.equal(video.volume, .25);
  assert.equal(video.paused, false);
  assert.equal(video.loads, 1);
  assert.equal(renderer.node, video);
  assert.deepEqual(errors, []);
});

test('full-source loops follow the parent position through repeated cycles and large or backward anchors', async t => {
  const { video, draw, errors } = await setup(t);
  for (const localTimeMs of [1250, 5000, 11_250, 1_000_000_250, 23_250, 250]) {
    draw(localTimeMs); await flush();
    assert.equal(video.currentTime, (localTimeMs % 5000) / 1000);
    assert.equal(video.paused, false);
    assert.equal(video.playbackRate, 1);
  }
  assert.equal(video.loads, 1, 'all wraps reuse the prepared source');
  assert.equal(video.src, clip.properties.source.path);
  assert.deepEqual(errors, []);
});

test('trimmed loops clamp runtime source bounds while retaining the authored shared period', async t => {
  const ranged: VideoClip = { ...clip, properties: { ...clip.properties, sourceRange: { inMs: 3000, outMs: 5000 } } };
  const { video, draw, errors } = await setup(t, ranged, 4.8);
  assert.equal(video.currentTime, 3);
  for (const localTimeMs of [1750, 1800, 1999, 2000, 3650, 3800, 9000, 600]) {
    draw(localTimeMs); await flush();
    const expected = Math.min(3 + (localTimeMs % 2000) / 1000, 4.799);
    assert.ok(Math.abs(video.currentTime - expected) < 1e-9);
    assert.equal(video.paused, localTimeMs % 2000 >= 1800);
  }
  assert.ok(video.seeks.every(seconds => seconds >= 3 && seconds < 4.8));
  assert.equal(ranged.properties.durationMs, 5000, 'runtime tolerance does not change authored media metadata');
  assert.deepEqual(errors, []);
});

test('shorter full-source decoders hold the final frame until the shared stored cycle boundary', async t => {
  const { video, draw, errors } = await setup(t, clip, 4.8);
  for (const localTimeMs of [4800, 4999, 5000, 9800, 10_000, 20_050]) {
    draw(localTimeMs); await flush();
    assert.ok(Math.abs(video.currentTime - Math.min((localTimeMs % 5000) / 1000, 4.799)) < 1e-9);
    assert.equal(video.paused, localTimeMs % 5000 >= 4800);
  }
  assert.deepEqual(errors, []);
});

test('tolerated longer decoders still wrap at the authored boundary', async t => {
  const { video, draw, errors } = await setup(t, clip, 5.2);
  for (const localTimeMs of [4900, 5000, 10_000, 20_100]) {
    draw(localTimeMs); await flush();
    assert.equal(video.currentTime, (localTimeMs % 5000) / 1000);
    assert.equal(video.paused, false);
  }
  assert.ok(video.seeks.every(seconds => seconds < 5));
  assert.deepEqual(errors, []);
});

test('short loop boundaries force seeks even when source drift is below the normal threshold', async t => {
  const short: VideoClip = { ...clip, properties: { ...clip.properties, sourceRange: { inMs: 1000, outMs: 1200 } } };
  const { video, draw } = await setup(t, short);
  draw(180); await flush();
  assert.equal(video.currentTime, 1.18);
  const before = video.seeks.length;
  for (const localTimeMs of [200, 400, 600, 1_000_000_000]) {
    video.advanceTo(1.199);
    draw(localTimeMs); await flush();
    assert.equal(video.currentTime, 1);
    assert.equal(video.paused, false);
  }
  assert.equal(video.seeks.length, before + 4);
});

test('pause and exit freeze the exact wrapped source position, and resume uses the same absolute anchor', async t => {
  const { video, draw, errors } = await setup(t);
  draw(6150); await flush();
  video.advanceTo(1.18);
  draw(6160, 'paused'); await flush();
  assert.equal(video.currentTime, 1.16, 'even a small correction is aligned when the parent stops scheduling frames');
  assert.equal(video.paused, true);
  const plays = video.plays;
  draw(6160, 'paused'); await flush();
  assert.equal(video.plays, plays);
  draw(6160); await flush();
  assert.equal(video.paused, false);
  draw(6250, 'exiting', 0.5); await flush();
  assert.equal(video.currentTime, 1.25);
  assert.equal(video.paused, true);
  draw(6250, 'exiting', 0); await flush();
  assert.equal(video.currentTime, 1.25);
  assert.deepEqual(errors, []);
});

test('pending wrap seeks reconcile the latest paused frame without another animation frame', async t => {
  const { video, draw, errors } = await setup(t);
  draw(4900); await flush();
  video.delaySeeks = true;
  draw(5000);
  assert.equal(video.currentTime, 0);
  draw(5020, 'paused');
  video.finishSeek(); await flush();
  assert.equal(video.currentTime, 0.02, 'seek completion re-evaluates the latest paused anchor');
  assert.equal(video.seeking, true);
  video.finishSeek(); await flush();
  assert.equal(video.paused, true);
  assert.deepEqual(errors, []);
});

test('pending wrap seeks reconcile a jump across multiple cycles before resuming', async t => {
  const { video, draw, errors } = await setup(t);
  draw(4900); await flush();
  video.delaySeeks = true;
  draw(5000);
  draw(20_050);
  video.finishSeek(); await flush();
  assert.equal(video.currentTime, 0.05, 'cycle identity belongs to the decoder request rather than the pending frame');
  video.finishSeek(); await flush();
  assert.equal(video.paused, false);
  assert.deepEqual(errors, []);
});

test('native ended and stalled events recover loops while actual missing media still times out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { video, draw, errors } = await setup(t);
  draw(4900); await flush();
  video.advanceTo(5); video.ended = true; video.paused = true;
  video.dispatchEvent(new Event('ended')); await flush();
  assert.equal(video.currentTime, 4.9);
  assert.equal(video.paused, false);
  video.readyState = 2;
  video.dispatchEvent(new Event('stalled'));
  draw(5000); await flush();
  video.readyState = 4; video.dispatchEvent(new Event('canplay'));
  t.mock.timers.tick(8001); await flush();
  assert.deepEqual(errors, [], 'a recovered wrap clears the prior cycle buffering timeout');
  video.readyState = 2;
  video.dispatchEvent(new Event('waiting'));
  t.mock.timers.tick(8001); await flush();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /MEDIA_BUFFER_TIMEOUT/);
});

test('disposing during a wrap aborts seek listeners and timers without surfacing errors or aborting the surface', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { renderer, video, draw, errors, controller } = await setup(t);
  draw(4900); await flush();
  video.delaySeeks = true;
  draw(5000);
  assert.equal(video.seeking, true);
  renderer.dispose(); await flush();
  assert.equal(video.listenerCount, 0);
  assert.equal(video.src, '');
  assert.equal(video.removed, true);
  assert.equal(video.paused, true);
  assert.equal(controller.signal.aborted, false);
  t.mock.timers.tick(8001); await flush();
  assert.deepEqual(errors, []);
});

test('a delayed play completing during a wrapped pause cannot resume the decoder', async t => {
  const { video, draw, errors } = await setup(t);
  let resolvePlay!: () => void;
  video.nextPlay = () => new Promise<void>(resolve => { resolvePlay = () => { video.paused = false; resolve(); }; });
  draw(5000); await flush();
  draw(5020, 'paused'); await flush();
  resolvePlay(); await flush();
  assert.equal(video.currentTime, 0.02);
  assert.equal(video.paused, true);
  assert.deepEqual(errors, []);
});

test('loop audio follows the composition fade and disconnects completely on disposal', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let closed = 0; let disconnected = 0;
  const gain = { gain: { value: 0 }, connect() {}, disconnect() { disconnected += 1; } };
  class FakeAudioContext {
    state = 'running'; destination = {};
    createGain() { return gain; }
    createMediaElementSource() { return { connect() {}, disconnect() { disconnected += 1; } }; }
    async resume() { this.state = 'running'; }
    async close() { closed += 1; this.state = 'closed'; }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });
  const audible: VideoClip = { ...clip, properties: { ...clip.properties, muted: false } };
  const { renderer, video, draw, errors } = await setup(t, audible);
  draw(10_000); await flush();
  assert.equal(video.paused, false);
  assert.equal(video.volume, 0.7);
  assert.equal(gain.gain.value, 0.8);
  draw(10_050, 'exiting', 0.25); await flush();
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 0.05);
  assert.equal(gain.gain.value, 0.2);
  draw(10_050, 'exiting', 0); await flush();
  assert.equal(gain.gain.value, 0);
  renderer.dispose(); await flush();
  assert.equal(disconnected, 2);
  assert.equal(closed, 1);
  assert.deepEqual(errors, []);
});

test('disposing during a pending play keeps the decoder paused when the browser resolves later', async t => {
  const { renderer, video, draw, errors } = await setup(t);
  let resolvePlay!: () => void;
  video.nextPlay = () => new Promise<void>(resolve => { resolvePlay = () => { video.paused = false; resolve(); }; });
  draw(5000); await flush();
  renderer.dispose();
  resolvePlay(); await flush();
  assert.equal(video.paused, true);
  assert.equal(video.src, '');
  assert.deepEqual(errors, []);
});

test('a reported media failure stays terminal when pending native playback resolves without disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let created = 0; let resumed = 0;
  const gain = { gain: { value: 0 }, connect() {}, disconnect() {} };
  class FakeAudioContext {
    state = 'running'; destination = {};
    constructor() { created += 1; }
    createGain() { return gain; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    async resume() { resumed += 1; this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });
  const audible: VideoClip = { ...clip, properties: { ...clip.properties, muted: false } };
  const { renderer, video, draw, errors } = await setup(t, audible);
  let resolvePlay!: () => void;
  video.nextPlay = () => new Promise<void>(resolve => { resolvePlay = () => { video.paused = false; resolve(); }; });
  draw(5000); await flush();
  assert.equal(gain.gain.value, 0.8);
  video.dispatchEvent(new Event('error'));
  assert.equal(errors.length, 1, 'the callback records the error without disposing the renderer');
  assert.match(String(errors[0]), /MEDIA_LOAD_FAILED/);
  assert.equal(video.paused, true);
  assert.equal(gain.gain.value, 0);
  const plays = video.plays;
  resolvePlay(); await flush();
  assert.equal(video.paused, true, 'late native fulfillment cannot revive failed playback');
  draw(6000); await flush();
  video.dispatchEvent(new Event('ended'));
  video.readyState = 2; video.dispatchEvent(new Event('stalled'));
  t.mock.timers.tick(8001); await flush();
  assert.equal(video.plays, plays);
  assert.equal(gain.gain.value, 0);
  assert.equal(created, 1);
  assert.equal(resumed, 0);
  assert.equal(errors.length, 1);
  await assert.rejects(renderer.prepare(), /MEDIA_LOAD_FAILED/);
  assert.equal(created, 1, 'failed renderers cannot recreate media audio resources');
});

test('cancelled preparation also guards native playback that resolves after its bounded wait', async t => {
  const video = new FakeVideo();
  let resolvePlay!: () => void;
  video.nextPlay = () => new Promise<void>(resolve => { resolvePlay = () => { video.paused = false; resolve(); }; });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => video } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const controller = new AbortController();
  const renderer = videoRenderer(clip, { append() {} } as unknown as HTMLElement, { signal: controller.signal });
  t.after(() => renderer.dispose());
  const preparation = renderer.prepare();
  const rejected = assert.rejects(preparation, { name: 'AbortError' });
  await flush();
  controller.abort(); await rejected;
  assert.equal(video.paused, true);
  resolvePlay(); await flush();
  assert.equal(video.paused, true, 'late preflight fulfillment preserves cancellation even before disposal');
});

test('a loop property alone does not alter finite playback or the manual last-frame hold', async t => {
  const { video, draw } = await setup(t);
  draw(5000, 'playing', 1, false); await flush();
  assert.equal(video.currentTime, 4.999);
  assert.equal(video.paused, true);
  assert.equal(video.plays, 1);
});

test('Break loops advance their source anchor through frozen envelopes and live global exit', async t => {
  const ranged: VideoClip = { ...clip, properties: { ...clip.properties, sourceRange: { inMs: 1000, outMs: 4000 } } };
  const { renderer, video, errors } = await setup(t, ranged);
  const draw = (mediaTimeMs: number, mediaPlayback: NonNullable<FrameItem['mediaPlayback']>,
    phase: PlayerFrame['phase'] = 'holding', opacity = 1) => {
    const item: FrameItem = { clip: ranged, localTimeMs: 9000, mediaTimeMs, mediaPlayback, opacity: 0.8,
      ...(mediaPlayback === 'looping' ? { videoLoop: true } : {}) };
    renderer.draw(item, { phase, positionMs: 19_000, opacity, items: [item] });
  };
  draw(2800, 'looping'); await flush(); assert.equal(video.currentTime, 3.8); assert.equal(video.paused, false);
  video.advanceTo(3.98); draw(50, 'looping'); await flush();
  assert.equal(video.currentTime, 1.05); assert.equal(video.paused, false); assert.equal(video.style.opacity, '0.8');
  video.advanceTo(1.075); draw(50, 'paused'); await flush();
  assert.equal(video.currentTime, 1.05, 'pause freezes the exact shared source anchor'); assert.equal(video.paused, true);
  const plays = video.plays;
  draw(50, 'paused', 'exiting', 0.5); await flush(); assert.equal(video.plays, plays);
  draw(650, 'looping', 'exiting', 0.5); await flush();
  assert.equal(video.currentTime, 1.65); assert.equal(video.paused, false);
  draw(1500, 'finishing'); await flush(); assert.equal(video.currentTime, 2.5); assert.equal(video.paused, false);
  draw(2800, 'finishing', 'exiting', 0.2); await flush();
  assert.equal(video.currentTime, 3.8); assert.equal(video.paused, false);
  draw(3000, 'finished'); await flush(); assert.equal(video.currentTime, 3.999); assert.equal(video.paused, true);
  const completedPlays = video.plays;
  draw(3000, 'finished', 'exiting', 0.1); await flush();
  assert.equal(video.currentTime, 3.999); assert.equal(video.plays, completedPlays);
  renderer.dispose(); assert.equal(video.src, ''); assert.equal(video.listenerCount, 0); assert.deepEqual(errors, []);
});

test('Break pause reconciles pending seeks and pending native play without reviving the decoder', async t => {
  const { renderer, video, errors } = await setup(t);
  const draw = (mediaTimeMs: number, phase: PlayerFrame['phase']) => {
    const item: FrameItem = { clip, localTimeMs: 10_000, mediaTimeMs, mediaPlayback: 'looping', videoLoop: true, opacity: 1 };
    renderer.draw(item, { phase, positionMs: 20_000, opacity: 1, items: [item] });
  };
  video.delaySeeks = true; draw(4000, 'holding'); draw(25, 'paused');
  video.finishSeek(); await flush(); assert.equal(video.currentTime, 0.025);
  video.finishSeek(); await flush(); assert.equal(video.paused, true);
  let resolvePlay!: () => void;
  video.nextPlay = () => new Promise<void>(resolve => { resolvePlay = () => { video.paused = false; resolve(); }; });
  draw(25, 'holding'); await flush(); draw(25, 'paused'); resolvePlay(); await flush();
  assert.equal(video.paused, true); assert.deepEqual(errors, []);
});

test('Break video sound follows global gain while running and is silent at paused or finished source', async t => {
  const gain = { gain: { value: 0 }, connect() {}, disconnect() {} };
  let closed = 0, disconnected = 0;
  class FakeAudioContext {
    state = 'running'; destination = {};
    createGain() { return { ...gain, disconnect() { disconnected += 1; } }; }
    createMediaElementSource() { return { connect() {}, disconnect() { disconnected += 1; } }; }
    async close() { closed += 1; this.state = 'closed'; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });
  const audible: VideoClip = { ...clip, properties: { ...clip.properties, muted: false } };
  const { renderer, video, errors } = await setup(t, audible);
  const draw = (mediaTimeMs: number, mediaPlayback: NonNullable<FrameItem['mediaPlayback']>,
    phase: PlayerFrame['phase'], opacity: number) => {
    const item: FrameItem = { clip: audible, localTimeMs: 10_000, mediaTimeMs, mediaPlayback, opacity: 0.8,
      ...(mediaPlayback === 'looping' ? { videoLoop: true } : {}) };
    renderer.draw(item, { phase, positionMs: 20_000, opacity, items: [item] });
  };
  draw(1000, 'looping', 'holding', 1); await flush(); assert.equal(gain.gain.value, 0.8);
  video.advanceTo(1.5); draw(1500, 'looping', 'exiting', 0.25); await flush();
  assert.equal(video.paused, false); assert.equal(gain.gain.value, 0.2);
  draw(1500, 'looping', 'paused', 1); await flush(); assert.equal(gain.gain.value, 0); assert.equal(video.paused, true);
  draw(4000, 'finishing', 'holding', 1); await flush(); assert.equal(gain.gain.value, 0.8);
  draw(5000, 'finished', 'holding', 1); await flush(); assert.equal(gain.gain.value, 0); assert.equal(video.currentTime, 4.999);
  draw(5000, 'finished', 'exiting', 0.5); await flush(); assert.equal(gain.gain.value, 0);
  renderer.dispose(); await flush(); assert.equal(closed, 1); assert.equal(disconnected, 2); assert.deepEqual(errors, []);
});

test('native end cannot replay Break finish and trimmed loop waits for the shared clock wrap', async t => {
  const { renderer, video, errors } = await setup(t);
  const draw = (mediaTimeMs: number, mediaPlayback: NonNullable<FrameItem['mediaPlayback']>) => {
    const item: FrameItem = { clip, localTimeMs: 10_000, mediaTimeMs, mediaPlayback, opacity: 1,
      ...(mediaPlayback === 'looping' ? { videoLoop: true } : {}) };
    renderer.draw(item, { phase: 'holding', positionMs: 20_000, opacity: 1, items: [item] });
  };
  draw(4600, 'finishing'); await flush();
  video.advanceTo(5); video.ended = true; video.paused = true; video.dispatchEvent(new Event('ended')); await flush();
  assert.equal(video.currentTime, 4.999); const plays = video.plays;
  draw(4700, 'finishing'); await flush(); assert.equal(video.paused, true); assert.equal(video.plays, plays);
  draw(5000, 'finished'); await flush(); assert.equal(video.plays, plays);
  draw(25, 'looping'); await flush(); assert.equal(video.currentTime, 0.025); assert.equal(video.paused, false);
  assert.deepEqual(errors, []);
  const ranged: VideoClip = { ...clip, properties: { ...clip.properties, sourceRange: { inMs: 1000, outMs: 4000 } } };
  const second = await setup(t, ranged);
  const drawRanged = (mediaTimeMs: number) => {
    const item: FrameItem = { clip: ranged, localTimeMs: 9000, mediaTimeMs, mediaPlayback: 'looping', videoLoop: true, opacity: 1 };
    second.renderer.draw(item, { phase: 'holding', positionMs: 19_000, opacity: 1, items: [item] });
  };
  drawRanged(2800); await flush(); second.video.advanceTo(4.01); second.video.dispatchEvent(new Event('timeupdate')); await flush();
  assert.equal(second.video.currentTime, 3.999); assert.equal(second.video.paused, true); const trimPlays = second.video.plays;
  drawRanged(2900); await flush(); assert.equal(second.video.plays, trimPlays);
  drawRanged(50); await flush(); assert.equal(second.video.currentTime, 1.05); assert.equal(second.video.paused, false);
  assert.deepEqual(second.errors, []);
});

test('native video endings recover on exact full-period jumps in the absolute Break cycle', async t => {
  const { renderer, video, errors } = await setup(t);
  const draw = (mediaCycle: number) => {
    const item: FrameItem = { clip, localTimeMs: 10_000, mediaTimeMs: 4600, mediaCycle, mediaPlayback: 'looping', videoLoop: true, opacity: 1 };
    renderer.draw(item, { phase: 'holding', positionMs: 20_000, opacity: 1, items: [item] });
  };
  draw(0); await flush(); video.advanceTo(5); video.ended = true; video.paused = true;
  video.dispatchEvent(new Event('ended')); await flush(); assert.equal(video.currentTime, 4.999); assert.equal(video.paused, true);
  draw(3); await flush(); assert.equal(video.currentTime, 4.6); assert.equal(video.paused, false); assert.deepEqual(errors, []);
});

test('schema 2 ordinary video fade advances live source without rewinds and keeps paused source silent', async t => {
  const gain = { gain: { value: 0 }, connect() {}, disconnect() {} };
  class FakeAudioContext {
    state = 'running'; destination = {};
    createGain() { return gain; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });
  for (const pausedOrigin of [false, true]) {
    const selected: VideoClip = { ...clip, typeVersion: 5, startMs: 0,
      properties: { ...clip.properties, loop: false, muted: false, onBreak: 'pause' } };
    const { renderer, video, errors } = await setup(t, selected);
    let now = 0, callback: (() => void) | null = null;
    const runtime: Runtime = { now: () => now, requestFrame(next) { callback = next; return 1; }, cancelFrame() { callback = null; } };
    const advance = (ms: number) => { now += ms; const next = callback; callback = null; next?.(); };
    const sequence: SequenceV1 = { schemaVersion: 2, id: 'video-fade', revision: 1, name: 'Video fade',
      composition: { width: 1920, height: 1080 }, presentation: { surface: 'window', blockInput: false, exitDurationMs: 2000 },
      tracks: [{ id: 'video', name: 'Video', kind: 'visual', order: 0, enabled: true, locked: false }],
      clips: [selected], end: { kind: 'fixed', durationMs: 10_000 } };
    const frames: PlayerFrame[] = [], player = new LocalPlayer(runtime);
    await player.start(sequence, { async prepare() {},
      render(frame) { frames.push(frame); renderer.draw(frame.items[0], frame); }, dispose: () => renderer.dispose() });
    await flush(); video.advanceTo(1); advance(1000); await flush();
    assert.equal(video.paused, false); assert.equal(gain.gain.value, 1);
    if (pausedOrigin) { player.pause(); await flush(); assert.equal(gain.gain.value, 0); }
    const seeks = video.seeks.length, plays = video.plays;
    player.fadeOut(); await flush();
    if (!pausedOrigin) video.advanceTo(1.5);
    advance(500); await flush();
    assert.equal(frames.at(-1)!.positionMs, 1000); assert.equal(frames.at(-1)!.holdElapsedMs, undefined);
    assert.equal(frames.at(-1)!.items[0]!.mediaTimeMs, pausedOrigin ? 1000 : 1500);
    assert.equal(video.currentTime, pausedOrigin ? 1 : 1.5); assert.equal(video.paused, pausedOrigin);
    assert.equal(video.seeks.length, seeks, 'frozen composition fades must not rewind the live source');
    assert.equal(video.plays, plays); assert.equal(gain.gain.value, pausedOrigin ? 0 : 0.75);
    advance(1500); await flush(); assert.equal(player.getState().phase, 'ended'); assert.equal(gain.gain.value, 0);
    assert.deepEqual(errors, []);
  }
});


test('inner Continue exactly resynchronizes Break-only video loops in both sub-threshold directions once', async t => {
  for (const [heldMs, elapsedMs] of [[1200, 200], [800, 4800]] as const) {
    const selected: VideoClip = { ...clip, typeVersion: 5, startMs: 0,
      properties: { ...clip.properties, loop: false, onBreak: 'loop' } };
    const { renderer, video, errors } = await setup(t, selected);
    const held: FrameItem = { clip: selected, localTimeMs: 1000, mediaTimeMs: heldMs,
      mediaPlayback: 'looping', mediaCycle: Math.floor((1000 + elapsedMs) / 5000), videoLoop: true, opacity: 1 };
    renderer.draw(held, { phase: 'holding', positionMs: 1000, breakId: 'inner', breakHistory: [], opacity: 1, items: [held] });
    await flush(); assert.equal(video.currentTime, heldMs / 1000);
    const continued: FrameItem = { clip: selected, localTimeMs: 1000, mediaTimeMs: 1000, mediaPlayback: 'playing', opacity: 1 };
    const frame: PlayerFrame = { phase: 'playing', positionMs: 1000, breakHistory: [{ id: 'inner', positionMs: 1000, elapsedMs }], opacity: 1, items: [continued] };
    const seeks = video.seeks.length;
    renderer.draw(continued, frame); await flush();
    assert.equal(video.currentTime, 1, 'Continue seeks to timeline source, regardless of the ordinary decoder loop flag');
    assert.equal(video.playbackRate, 1); assert.equal(video.paused, false); assert.equal(video.seeks.length, seeks + 1);
    renderer.draw(continued, frame); await flush();
    assert.equal(video.seeks.length, seeks + 1, 'the same consumed marker never repeats the deliberate seek');
    assert.deepEqual(errors, []);
  }
});

test('video Continue queued during an older seek reconciles the latest target once', async t => {
  const selected: VideoClip = { ...clip, typeVersion: 5, startMs: 0,
    properties: { ...clip.properties, loop: false, onBreak: 'loop' } };
  const { renderer, video, errors } = await setup(t, selected);
  video.delaySeeks = true;
  const draw = (sourceMs: number, phase: PlayerFrame['phase']) => {
    const holding = phase === 'holding';
    const item: FrameItem = { clip: selected, localTimeMs: holding ? 1000 : sourceMs, mediaTimeMs: sourceMs,
      mediaPlayback: holding ? 'looping' : 'playing', opacity: 1, ...(holding ? { videoLoop: true } : {}) };
    renderer.draw(item, { phase, positionMs: holding ? 1000 : sourceMs, opacity: 1, items: [item],
      ...(holding ? { breakId: 'inner', breakHistory: [] } : { breakHistory: [{ id: 'inner', positionMs: 1000, elapsedMs: 200 }] }) });
  };
  draw(1200, 'holding'); draw(1000, 'playing'); draw(1020, 'playing');
  assert.deepEqual(video.seeks, [1.2]);
  video.finishSeek(); await flush();
  assert.deepEqual(video.seeks, [1.2, 1.02]); assert.equal(video.seeking, true); assert.equal(video.paused, true);
  video.finishSeek(); await flush();
  assert.equal(video.currentTime, 1.02); assert.equal(video.paused, false);
  draw(1020, 'playing'); await flush(); assert.equal(video.seeks.length, 2); assert.deepEqual(errors, []);
});

test('video Finish history advancement preserves source progress and native completed gate without new seeks or play', async t => {
  const selected: VideoClip = { ...clip, typeVersion: 5, startMs: 0,
    properties: { ...clip.properties, loop: false, onBreak: 'finish' } };
  const { renderer, video, errors } = await setup(t, selected);
  const item: FrameItem = { clip: selected, localTimeMs: 1000, mediaTimeMs: 1200, mediaPlayback: 'finishing', opacity: 1 };
  renderer.draw(item, { phase: 'holding', positionMs: 1000, breakId: 'inner', breakHistory: [], opacity: 1, items: [item] });
  await flush(); const seeks = video.seeks.length, plays = video.plays;
  renderer.draw(item, { phase: 'playing', positionMs: 1000, breakHistory: [{ id: 'inner', positionMs: 1000, elapsedMs: 200 }], opacity: 1, items: [item] });
  await flush(); assert.equal(video.seeks.length, seeks); assert.equal(video.plays, plays); assert.equal(video.currentTime, 1.2);
  video.advanceTo(5); video.ended = true; video.paused = true; video.dispatchEvent(new Event('ended'));
  await flush(); const afterEndSeeks = video.seeks.length, afterEndPlays = video.plays;
  renderer.draw(item, { phase: 'playing', positionMs: 1500,
    breakHistory: [{ id: 'inner', positionMs: 1000, elapsedMs: 200 }, { id: 'later', positionMs: 1500, elapsedMs: 100 }], opacity: 1, items: [item] });
  await flush(); assert.equal(video.seeks.length, afterEndSeeks); assert.equal(video.plays, afterEndPlays); assert.equal(video.paused, true);
  assert.deepEqual(errors, []);
});


test('video inner Continue clears the native-ended gate before its one deliberate small rewind', async t => {
  const selected: VideoClip = { ...clip, typeVersion: 5, startMs: 0,
    properties: { ...clip.properties, loop: false, onBreak: 'loop' } };
  const { renderer, video, errors } = await setup(t, selected);
  const held: FrameItem = { clip: selected, localTimeMs: 4700, mediaTimeMs: 4900, mediaPlayback: 'looping', mediaCycle: 0, videoLoop: true, opacity: 1 };
  renderer.draw(held, { phase: 'holding', positionMs: 4700, breakId: 'inner', breakHistory: [], opacity: 1, items: [held] });
  await flush(); video.advanceTo(5); video.ended = true; video.paused = true; video.dispatchEvent(new Event('ended'));
  await flush(); assert.equal(video.paused, true);
  const item: FrameItem = { clip: selected, localTimeMs: 4700, mediaTimeMs: 4700, mediaPlayback: 'playing', opacity: 1 };
  const frame: PlayerFrame = { phase: 'playing', positionMs: 4700,
    breakHistory: [{ id: 'inner', positionMs: 4700, elapsedMs: 200 }], opacity: 1, items: [item] };
  const seeks = video.seeks.length;
  renderer.draw(item, frame); await flush(); assert.equal(video.currentTime, 4.7); assert.equal(video.paused, false);
  assert.equal(video.seeks.length, seeks + 1); renderer.draw(item, frame); await flush(); assert.equal(video.seeks.length, seeks + 1);
  assert.deepEqual(errors, []);
});
