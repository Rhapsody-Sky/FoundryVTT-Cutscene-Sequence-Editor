import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioClip, VideoClip } from '../src/domain/sequence.js';
import type { FrameItem } from '../src/playback/evaluate.js';
import type { PlayerFrame } from '../src/playback/local-player.js';
import { audioRenderer } from '../src/rendering/audio-renderer.js';
import { videoRenderer } from '../src/rendering/video-renderer.js';

class PersonalVolume {
  readonly listeners = new Set<(value: number) => void>();
  constructor(public value = 0.5) {}
  subscribe(listener: (value: number) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  set(value: number) { this.value = value; for (const listener of this.listeners) listener(value); }
}

class Media extends EventTarget {
  readonly style: Record<string, string> = {}; readonly dataset: Record<string, string> = {};
  src = ''; muted = false; volume = 1; playbackRate = 1; paused = true; seeking = false; ended = false;
  duration = 5; readyState = 4; error = null; plays = 0; pauses = 0; delaySeeks = false;
  buffered = { length: 1, start: () => 0, end: () => 5 };
  readonly seeks: number[] = [];
  nextPlay: (() => Promise<void>) | undefined;
  private time = 0;
  get currentTime() { return this.time; }
  set currentTime(value: number) { this.time = value; this.seeks.push(value); this.ended = false; this.seeking = this.delaySeeks; }
  finishSeek() { this.seeking = false; this.dispatchEvent(new Event('seeked')); }
  play() { this.plays += 1; this.paused = false; return this.nextPlay?.() ?? Promise.resolve(); }
  pause() { this.pauses += 1; this.paused = true; }
  load() {}
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  remove() {}
}

const flush = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
function setup(t: { after(callback: () => void): void }, type: 'audio' | 'video', muted = false, still = false, initialVolume = 0.5) {
  const media = new Media(), level = new PersonalVolume(initialVolume), controller = new AbortController(), errors: unknown[] = [];
  let contexts = 0;
  const gain = { gain: { value: 0 }, connect() {}, disconnect() {} };
  class Context {
    state = 'running'; destination = {};
    constructor() { contexts += 1; }
    createGain() { return gain; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  for (const [name, value] of [['document', { createElement: () => media }], ['AudioContext', Context]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  const common = {
    id: type, trackId: type, startMs: 0, duration: { kind: 'media' } as const,
    entrance: { preset: 'none', version: 1 } as const, exit: { preset: 'none', version: 1 } as const,
    properties: { source: { kind: 'foundry-file', path: `worlds/test/${type}.webm` } as const, durationMs: 5000, volume: 0.8, muted }
  };
  const clip: AudioClip | VideoClip = type === 'audio' ? { ...common, type, typeVersion: 1 }
    : { ...common, type, typeVersion: 3, properties: { ...common.properties, fit: 'contain' } };
  const before = JSON.stringify(clip);
  const parent = { append() {} } as unknown as HTMLElement;
  const options = { signal: controller.signal, playbackVolume: level, still, onError: (error: unknown) => errors.push(error) };
  const renderer = clip.type === 'audio' ? audioRenderer(clip, parent, options) : videoRenderer(clip, parent, options);
  t.after(() => renderer.dispose());
  const draw = (phase: PlayerFrame['phase'] = 'holding', time = 0, playback: FrameItem['mediaPlayback'] = 'looping') => {
    const item: FrameItem = { clip, localTimeMs: 0, mediaTimeMs: time, mediaPlayback: playback, opacity: 0.5, audioGain: 0.5,
      ...(type === 'audio' ? { audioLoop: true } : { videoLoop: true }) };
    renderer.draw(item, { phase, positionMs: 0, opacity: 0.5, items: [item] });
  };
  const output = () => media.muted || media.paused ? 0 : media.volume * (contexts ? gain.gain.value : 1);
  return { renderer, media, level, gain, controller, errors, draw, output, contexts: () => contexts,
    unchanged: () => assert.equal(JSON.stringify(clip), before) };
}

for (const type of ['audio', 'video'] as const) {
  test(`${type}: personal volume combines once with authored and sequence fades, and changes immediately during a hold`, async t => {
    const { renderer, media, level, draw, output, unchanged } = setup(t, type);
    await renderer.prepare(); draw(); await flush();
    assert.equal(output(), 0.1, '0.8 authored × 0.5 personal × 0.5 clip envelope × 0.5 sequence fade');
    const before = { time: media.currentTime, seeks: media.seeks.length, plays: media.plays, pauses: media.pauses };
    level.set(0); assert.equal(output(), 0);
    level.set(1); assert.equal(output(), 0.2);
    assert.deepEqual({ time: media.currentTime, seeks: media.seeks.length, plays: media.plays, pauses: media.pauses }, before);
    unchanged();
  });

  test(`${type}: personal mute still preflights audible permission behind a silent graph`, async t => {
    const { renderer, media, gain, level, contexts, draw, output } = setup(t, type, false, false, 0);
    assert.equal(media.volume, 0, 'hidden renderer starts silent');
    media.nextPlay = async () => { assert.equal(media.muted, false); assert.equal(media.volume, 0.8); assert.equal(gain.gain.value, 0); };
    await renderer.prepare(); assert.equal(contexts(), 1); assert.equal(media.paused, true);
    media.nextPlay = undefined; draw(); await flush(); assert.equal(output(), 0);
    level.set(1); assert.equal(output(), 0.2);
  });

  test(`${type}: personal updates preserve silence while paused, seeking, or after terminal teardown`, async t => {
    const { renderer, media, level, draw, output, controller } = setup(t, type);
    await renderer.prepare(); draw(); await flush();
    draw('paused'); await flush(); level.set(1); assert.equal(output(), 0);
    media.delaySeeks = true; draw('holding', 1000); level.set(0); level.set(1); assert.equal(output(), 0);
    media.finishSeek(); await flush(); assert.equal(output(), 0.2);
    controller.abort(); assert.equal(level.listeners.size, 0); assert.equal(output(), 0);
    level.set(0); level.set(1); assert.equal(output(), 0);
    renderer.dispose(); assert.equal(media.volume, 0); assert.equal(level.listeners.size, 0);
  });

  test(`${type}: late native play completion and personal updates cannot resurrect failed media`, async t => {
    const { renderer, media, level, draw, output, errors } = setup(t, type);
    await renderer.prepare();
    let complete!: () => void;
    media.nextPlay = () => new Promise<void>(resolve => { complete = () => { media.paused = false; resolve(); }; });
    draw(); await flush();
    media.dispatchEvent(new Event('error'));
    assert.equal(errors.length, 1); assert.equal(level.listeners.size, 0);
    level.set(1); complete(); await flush(); assert.equal(output(), 0); assert.equal(media.paused, true);
  });

  test(`${type}: native play completion uses the latest personal level and stays silent after disposal`, async t => {
    const { renderer, media, level, draw, output } = setup(t, type);
    await renderer.prepare();
    let complete!: () => void;
    media.nextPlay = () => new Promise<void>(resolve => { complete = () => { media.paused = false; resolve(); }; });
    draw(); await flush(); level.set(0); complete(); await flush();
    assert.equal(media.paused, false); assert.equal(output(), 0);
    level.set(1); assert.equal(output(), 0.2);
    draw('paused'); await flush(); draw(); await flush();
    renderer.dispose(); assert.equal(level.listeners.size, 0);
    complete(); await flush(); level.set(1);
    assert.equal(output(), 0); assert.equal(media.paused, true); assert.equal(media.volume, 0);
  });

  test(`${type}: preparation failure releases its personal-volume observer`, async t => {
    const { renderer, media, level } = setup(t, type);
    media.duration = 0;
    await assert.rejects(renderer.prepare(), /MEDIA_LOAD_FAILED/);
    assert.equal(level.listeners.size, 0); level.set(1); assert.equal(media.volume, 0);
  });

  for (const mode of ['muted', 'still'] as const) {
    test(`${type}: ${mode} playback remains silent when personal volume rises`, async t => {
      const { renderer, level, contexts, draw, output } = setup(t, type, mode === 'muted', mode === 'still', 0);
      await renderer.prepare(); draw(); await flush(); level.set(1);
      assert.equal(output(), 0); assert.equal(contexts(), 0);
      renderer.dispose(); assert.equal(level.listeners.size, 0);
    });
  }
}
