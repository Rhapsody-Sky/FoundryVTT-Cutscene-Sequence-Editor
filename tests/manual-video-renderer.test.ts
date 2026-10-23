import test from 'node:test';
import assert from 'node:assert/strict';
import type { VideoClip } from '../src/domain/sequence.js';
import type { FrameItem } from '../src/playback/evaluate.js';
import type { PlayerFrame } from '../src/playback/local-player.js';
import { videoRenderer } from '../src/rendering/video-renderer.js';

const clip: VideoClip = {
  id: 'terminal-video', trackId: 'video-track', type: 'video', typeVersion: 1, startMs: 0,
  duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
  properties: {
    source: { kind: 'foundry-file', path: 'worlds/test/final-scene.webm' },
    fit: 'contain', volume: 0.7, muted: true, durationMs: 5000
  }
};

class FakeVideo extends EventTarget {
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
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
  nextPlay: (() => Promise<void>) | null = null;

  play() { this.plays += 1; this.paused = false; return this.nextPlay?.() ?? Promise.resolve(); }
  pause() { this.pauses += 1; this.paused = true; }
  load() {}
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  remove() { this.removed = true; }
}

function installDom(t: { after(callback: () => void): void }, video: FakeVideo) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => video } });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'document', before);
    else Reflect.deleteProperty(globalThis, 'document');
  });
}

const parent = { append() {} } as unknown as HTMLElement;
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

function item(videoClip: VideoClip, localTimeMs: number, opacity = 1): FrameItem {
  return { clip: videoClip, localTimeMs, opacity };
}

function frame(phase: PlayerFrame['phase'], positionMs: number, opacity: number, current: FrameItem): PlayerFrame {
  return { phase, positionMs, opacity, items: [current] };
}

test('terminal video holds its last frame during a playing anchor, avoids buffer failure, and resumes on a backward seek', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const video = new FakeVideo(); installDom(t, video);
  const controller = new AbortController();
  const errors: unknown[] = [];
  const renderer = videoRenderer(clip, parent, { signal: controller.signal, onError: error => errors.push(error) });
  await renderer.prepare();

  const end = item(clip, 5000);
  renderer.draw(end, frame('playing', 5000, 1, end));
  await flush();
  assert.equal(video.currentTime, 4.999, 'the final decodable frame is retained inside the source duration');
  assert.equal(video.paused, true);
  assert.equal(video.plays, 1, 'the only play call was preparation; the terminal hold does not restart it');

  const later = item(clip, 6200);
  renderer.draw(later, frame('playing', 6200, 1, later));
  await flush();
  assert.equal(video.currentTime, 4.999);
  assert.equal(video.plays, 1, 'further terminal anchors keep the held frame paused');

  video.readyState = 2;
  video.dispatchEvent(new Event('waiting'));
  t.mock.timers.tick(8001);
  assert.equal(errors.length, 0, 'a terminal hold must not start the playback buffer timeout');

  video.readyState = 4;
  const earlier = item(clip, 2500);
  renderer.draw(earlier, frame('playing', 2500, 1, earlier));
  await flush();
  assert.equal(video.currentTime, 2.5, 'a backward seek returns to the requested media position');
  assert.equal(video.paused, false, 'playback resumes after seeking back into the media range');
  assert.equal(video.plays, 2);
  assert.equal(errors.length, 0);

  renderer.dispose(); controller.abort();
});

test('a trimmed source end holds its last frame and the global fade mutes audio through cleanup', async t => {
  const video = new FakeVideo(); installDom(t, video);
  const ranged: VideoClip = {
    ...clip,
    typeVersion: 2,
    properties: { ...clip.properties, muted: false, sourceRange: { inMs: 1000, outMs: 4000 } }
  };
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  const previousAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let closed = 0;
  class FakeAudioContext {
    state = 'running';
    destination = {};
    createGain() { return gain; }
    createMediaElementSource(element: HTMLVideoElement) {
      assert.equal(element, video);
      return { connect() {}, disconnect() {} };
    }
    async resume() { this.state = 'running'; }
    async close() { closed += 1; this.state = 'closed'; }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  t.after(() => {
    if (previousAudioContext) Object.defineProperty(globalThis, 'AudioContext', previousAudioContext);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });

  const controller = new AbortController();
  const errors: unknown[] = [];
  const renderer = videoRenderer(ranged, parent, {
    signal: controller.signal, onError: error => errors.push(error)
  });
  await renderer.prepare();
  assert.equal(video.currentTime, 1, 'preparation starts at the trimmed source in-point');

  const beforeEnd = item(ranged, 2500, 0.8);
  renderer.draw(beforeEnd, frame('playing', 3500, 1, beforeEnd));
  await flush();
  assert.equal(video.currentTime, 3.5);
  assert.equal(video.paused, false);
  assert.equal(gain.gain.value, 0.8);

  const end = item(ranged, 3000);
  renderer.draw(end, frame('playing', 4000, 1, end));
  await flush();
  assert.equal(video.currentTime, 3.999, 'the source-range out-point is clamped to its final decodable frame');
  assert.equal(video.paused, true);
  assert.equal(video.plays, 2, 'the range boundary does not make a third play call');

  renderer.draw(end, frame('exiting', 4000, 0.25, end));
  assert.equal(gain.gain.value, 0.25, 'the global fade scales the retained video audio');
  renderer.draw(end, frame('exiting', 4000, 0, end));
  assert.equal(gain.gain.value, 0, 'the global fade reaches silence while the last image remains held');
  assert.equal(errors.length, 0);

  renderer.dispose(); controller.abort(); await flush();
  assert.equal(gain.gain.value, 0);
  assert.equal(closed, 1, 'disposal closes the audio context after the global fade');
  assert.equal(video.removed, true);
});
