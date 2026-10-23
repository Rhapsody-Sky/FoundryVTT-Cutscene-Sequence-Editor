import test from 'node:test';
import assert from 'node:assert/strict';
import type { VideoClip } from '../src/domain/sequence.js';
import { assertFoundryMediaPath, bounded, hasStartBuffer, MediaPreparationError, waitForVideo } from '../src/rendering/media-preparation.js';
import { videoRenderer } from '../src/rendering/video-renderer.js';
import { videoSync } from '../src/rendering/video-sync.js';

const clip: VideoClip = {
  id: 'video', trackId: 'visual', type: 'video', typeVersion: 1, startMs: 0,
  duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
  properties: { source: { kind: 'foundry-file', path: 'worlds/test/movie.webm' }, fit: 'contain', volume: 0.7, muted: true, durationMs: 5000 }
};

class FakeVideo extends EventTarget {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  src = '';
  preload = '';
  muted = true;
  volume = 1;
  controls = false;
  playsInline = true;
  disablePictureInPicture = true;
  paused = true;
  seeking = false;
  ended = false;
  duration = 5;
  readyState = 4;
  buffered = { length: 1, start: () => 0, end: () => 5 };
  currentTime = 0;
  playbackRate = 1;
  error: MediaError | null = null;
  plays = 0;
  pauses = 0;
  removed = false;
  listeners = new Set<EventListenerOrEventListenerObject>();
  nextPlay: (() => Promise<void>) | null = null;
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (callback) this.listeners.add(callback);
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (callback) this.listeners.delete(callback);
    super.removeEventListener(type, callback, options);
  }
  play() { this.plays += 1; this.paused = false; return this.nextPlay?.() ?? Promise.resolve(); }
  pause() { this.pauses += 1; this.paused = true; }
  load() {}
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  remove() { this.removed = true; }
}

function installDocument(t: { after(callback: () => void): void }, video: FakeVideo) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => video } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else Reflect.deleteProperty(globalThis, 'document'); });
}
const asVideo = (video: FakeVideo) => video as unknown as HTMLVideoElement;
const parent = { append() {} } as unknown as HTMLElement;
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

test('Foundry paths reject browser schemes, authority escapes and encoded traversal', () => {
  for (const path of ['worlds/a/video.mp4', '/modules/movie/demo.webm', 'worlds/a/my%20video.mp4']) assert.doesNotThrow(() => assertFoundryMediaPath(path));
  for (const path of ['https://example.org/a.mp4', 'javascript:alert(1)', '//example.org/a', ' //example.org/a', 'worlds/%2e%2e/a', 'worlds/../a', 'worlds\\a', 'worlds/a?x=1', '/%2fexample.org/a', 'worlds/%00a']) {
    assert.throws(() => assertFoundryMediaPath(path), (error: unknown) => error instanceof MediaPreparationError && error.code === 'MEDIA_INVALID_PATH');
  }
});

test('start buffer requires first two seconds or the complete short clip, not a later disjoint range', () => {
  const video = new FakeVideo();
  video.buffered.end = () => 1;
  assert.equal(hasStartBuffer(asVideo(video)), false);
  video.duration = 1;
  assert.equal(hasStartBuffer(asVideo(video)), true);
  video.buffered.start = () => 0.5;
  assert.equal(hasStartBuffer(asVideo(video)), false);
  video.readyState = 1;
  assert.equal(hasStartBuffer(asVideo(video)), false);
});

test('media readiness abort, timeout and failure remove pending event listeners', async () => {
  for (const reason of ['abort', 'timeout', 'error']) {
    const video = new FakeVideo();
    video.readyState = 0;
    const controller = new AbortController();
    const ready = waitForVideo(asVideo(video), controller.signal, () => video.readyState >= 2, 5, 'MEDIA_TIMEOUT');
    if (reason === 'abort') controller.abort();
    if (reason === 'error') video.dispatchEvent(new Event('error'));
    await assert.rejects(ready);
    assert.equal(video.listeners.size, 0);
  }
  const controller = new AbortController();
  const pending = bounded(new Promise<void>(() => {}), controller.signal, 60_000, 'MEDIA_TIMEOUT');
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('small drift corrects speed, large timeline jumps seek, and the final frame stays inside decoded duration', () => {
  assert.deepEqual(videoSync(1, 1060, 10, true), { targetSeconds: 1.06, seek: false, rate: 1 });
  assert.equal(videoSync(1, 1250, 10, true).rate, 1.05);
  assert.equal(videoSync(1.25, 1000, 10, true).rate, 0.95);
  assert.equal(videoSync(1, 4000, 10, true).seek, true);
  assert.equal(videoSync(1, 1120, 10, false).seek, true);
  assert.equal(videoSync(4.999, 5000, 5, false).targetSeconds, 4.999);
  assert.equal(videoSync(4.999, 5000, 5, false).seek, false);
});

test('an already-canceled media wait consumes the browser operation rejection', async () => {
  const controller = new AbortController();
  controller.abort();
  const browserOperation = Promise.reject(new DOMException('Playback interrupted', 'AbortError'));
  await assert.rejects(bounded(browserOperation, controller.signal, 8000, 'MEDIA_TIMEOUT'), { name: 'AbortError' });
  // Node's test runner fails this test if the browser rejection remains unhandled.
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('still preparation is silent and final video frame remains visible during global fade', async t => {
  const video = new FakeVideo(); installDocument(t, video);
  const controller = new AbortController();
  const renderer = videoRenderer(clip, parent, { signal: controller.signal, still: true });
  await renderer.prepare();
  assert.equal(video.plays, 0);
  assert.equal(video.muted, true);
  const item = { clip, opacity: 1, localTimeMs: 5000 };
  renderer.draw(item, { phase: 'exiting', positionMs: 5000, opacity: 0.5, items: [item] });
  await flush();
  assert.equal(video.currentTime, 4.999);
  assert.equal(video.style.opacity, '1');
  assert.equal(video.paused, true);
  assert.equal(video.style.backgroundColor, '#000');
  renderer.draw(item, { phase: 'exiting', positionMs: 5000, opacity: 0.2, items: [item] });
  assert.equal(video.currentTime, 4.999);
  renderer.dispose(); renderer.dispose();
  assert.equal(video.removed, true);
  assert.equal(video.src, '');
});

test('intentional pause ignores aborted play promises; actual media errors still fail while paused', async t => {
  const video = new FakeVideo(); installDocument(t, video);
  const controller = new AbortController();
  const errors: unknown[] = [];
  const renderer = videoRenderer(clip, parent, { signal: controller.signal, onError: error => errors.push(error) });
  await renderer.prepare();
  let rejectPlay: (error: unknown) => void = () => {};
  video.nextPlay = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  const item = { clip, opacity: 1, localTimeMs: 0 };
  renderer.draw(item, { phase: 'playing', positionMs: 0, opacity: 1, items: [item] });
  renderer.draw(item, { phase: 'paused', positionMs: 0, opacity: 1, items: [item] });
  rejectPlay(new DOMException('Playback interrupted', 'AbortError'));
  await flush();
  assert.equal(errors.length, 0);
  video.dispatchEvent(new Event('error'));
  assert.equal((errors[0] as MediaPreparationError).code, 'MEDIA_LOAD_FAILED');
  renderer.dispose(); controller.abort();
});

test('audible preflight unlock retries the retained unmuted element behind zero gain', async t => {
  const video = new FakeVideo(); installDocument(t, video);
  const audible: VideoClip = { ...clip, properties: { ...clip.properties, muted: false } };
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  const contextBefore = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let created = 0;
  let resumed = 0;
  let closed = 0;
  class FakeContext {
    state = 'suspended'; destination = {};
    constructor() { created += 1; }
    createGain() { return gain; }
    createMediaElementSource(element: HTMLVideoElement) { assert.equal(element, video); return { connect() {}, disconnect() {} }; }
    async resume() { resumed += 1; this.state = 'running'; }
    async close() { closed += 1; this.state = 'closed'; }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeContext });
  t.after(() => { if (contextBefore) Object.defineProperty(globalThis, 'AudioContext', contextBefore); else Reflect.deleteProperty(globalThis, 'AudioContext'); });
  video.nextPlay = async () => {
    assert.equal(video.muted, false);
    assert.equal(gain.gain.value, 0);
    if (video.plays === 1) throw new DOMException('Gesture needed', 'NotAllowedError');
  };
  const controller = new AbortController();
  let gates = 0;
  const renderer = videoRenderer(audible, parent, { signal: controller.signal,
    requestAudioUnlock: async unlock => { gates += 1; await unlock(); } });
  await renderer.prepare();
  assert.equal(created, 1); assert.equal(resumed, 1); assert.equal(gates, 1); assert.equal(video.plays, 2);
  assert.equal(video.paused, true); assert.equal(gain.gain.value, 0);
  const item = { clip: audible, opacity: 0.8, localTimeMs: 0 };
  video.nextPlay = null;
  renderer.draw(item, { phase: 'playing', positionMs: 0, opacity: 0.5, items: [item] });
  assert.equal(gain.gain.value, 0.4);
  assert.equal(video.volume, 0.7);
  renderer.dispose(); controller.abort(); await flush();
  assert.equal(gain.gain.value, 0); assert.equal(closed, 1);
});

test('short buffering catches up to the latest parent position; eight seconds fails locally', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const video = new FakeVideo(); installDocument(t, video);
  const controller = new AbortController();
  const errors: unknown[] = [];
  const renderer = videoRenderer(clip, parent, { signal: controller.signal, onError: error => errors.push(error) });
  await renderer.prepare();
  video.readyState = 2;
  for (const position of [0, 1000, 2000]) {
    const item = { clip, opacity: 1, localTimeMs: position };
    renderer.draw(item, { phase: 'playing', positionMs: position, opacity: 1, items: [item] });
  }
  assert.equal(video.currentTime, 0, 'buffering does not hard-seek every frame');
  t.mock.timers.tick(3000);
  video.readyState = 4; video.dispatchEvent(new Event('canplay'));
  const recovered = { clip, opacity: 1, localTimeMs: 3000 };
  renderer.draw(recovered, { phase: 'playing', positionMs: 3000, opacity: 1, items: [recovered] });
  await flush();
  assert.equal(video.currentTime, 3);
  assert.equal(errors.length, 0);
  video.readyState = 2; video.dispatchEvent(new Event('waiting'));
  t.mock.timers.tick(7999); assert.equal(errors.length, 0);
  t.mock.timers.tick(1);
  assert.equal((errors[0] as MediaPreparationError).code, 'MEDIA_BUFFER_TIMEOUT');
  renderer.dispose(); controller.abort();
});

test('cancellation during metadata preparation settles and releases the retained video', async t => {
  const video = new FakeVideo(); video.readyState = 0; installDocument(t, video);
  const controller = new AbortController();
  const renderer = videoRenderer(clip, parent, { signal: controller.signal, still: true });
  const pending = renderer.prepare();
  controller.abort(); renderer.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(video.src, ''); assert.equal(video.removed, true); assert.equal(video.paused, true);
});

test('a paused anchor arriving during a seek reconciles without needing another player frame', async t => {
  const video = new FakeVideo(); installDocument(t, video);
  const controller = new AbortController();
  const renderer = videoRenderer(clip, parent, { signal: controller.signal });
  await renderer.prepare();
  let position = 0;
  Object.defineProperty(video, 'currentTime', {
    get: () => position,
    set: (value: number) => { position = value; video.seeking = true; }
  });
  const playing = { clip, opacity: 1, localTimeMs: 4000 };
  renderer.draw(playing, { phase: 'playing', positionMs: 4000, opacity: 1, items: [playing] });
  const paused = { clip, opacity: 1, localTimeMs: 4500 };
  renderer.draw(paused, { phase: 'paused', positionMs: 4500, opacity: 1, items: [paused] });
  assert.equal(position, 4);
  video.seeking = false; video.dispatchEvent(new Event('seeked'));
  await flush();
  assert.equal(position, 4.5);
  video.seeking = false; video.dispatchEvent(new Event('seeked'));
  await flush();
  assert.equal(video.paused, true);
  renderer.dispose(); controller.abort();
});
