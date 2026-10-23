import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioClip, SequenceV1 } from '../src/domain/sequence.js';
import type { FrameItem } from '../src/playback/evaluate.js';
import { LocalPlayer, type PlayerFrame, type Runtime } from '../src/playback/local-player.js';
import { audioRenderer } from '../src/rendering/audio-renderer.js';
import { CompositionRenderer } from '../src/rendering/composition-renderer.js';
import { MediaPreparationError, probeAudio } from '../src/rendering/media-preparation.js';

const clip: AudioClip = {
  id: 'audio', trackId: 'sound', type: 'audio', typeVersion: 1, startMs: 1000,
  duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
  properties: { source: { kind: 'foundry-file', path: 'worlds/test/sound.ogg' }, durationMs: 5000, volume: 0.8, muted: false }
};
class FakeAudio extends EventTarget {
  readonly style: Record<string, string> = {}; readonly dataset: Record<string, string> = {};
  className = ''; src = ''; preload = ''; controls = false; loop = false;
  muted = false; volume = 1; playbackRate = 1; paused = true; seeking = false;
  ended = false; duration = 5; readyState = 4; error: MediaError | null = null;
  buffered = { length: 1, start: () => 0, end: () => this.duration };
  plays = 0; loads = 0; removed = false; delaySeeks = false;
  readonly seeks: number[] = [];
  nextPlay: (() => Promise<void>) | null = null;
  private time = 0;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  get listenerCount() { return [...this.listeners.values()].reduce((total, list) => total + list.size, 0); }
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    const [type, listener, options] = args;
    if (listener) {
      const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener); this.listeners.set(type, listeners);
      if (typeof options === 'object' && options.signal) options.signal.addEventListener('abort', () => listeners.delete(listener), { once: true });
    }
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    const [type, listener] = args;
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(...args);
  }
  get currentTime() { return this.time; }
  set currentTime(value: number) { this.time = value; this.seeks.push(value); this.ended = false; if (this.delaySeeks) this.seeking = true; }
  advanceTo(value: number) { this.time = value; }
  finishSeek() { this.seeking = false; this.dispatchEvent(new Event('seeked')); }
  play() { this.plays += 1; this.paused = false; return this.nextPlay?.() ?? Promise.resolve(); }
  pause() { this.paused = true; }
  load() { this.loads += 1; }
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  remove() { this.removed = true; }
}
const flush = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
type TestContext = { after(callback: () => void): void };
function setup(t: TestContext, selected = clip, still = false) {
  const audio = new FakeAudio();
  const gain = { gain: { value: 0 }, connect() {}, disconnect() { disconnected += 1; } };
  let contexts = 0, closed = 0, disconnected = 0;
  class FakeContext {
    state: AudioContextState = 'running'; destination = {};
    constructor() { contexts += 1; }
    createGain() { return gain; }
    createMediaElementSource(element: HTMLAudioElement) { assert.equal(element, audio); return { connect() {}, disconnect() { disconnected += 1; } }; }
    async resume() { this.state = 'running'; }
    async close() { closed += 1; this.state = 'closed'; }
  }
  const restore = (key: 'document' | 'AudioContext', value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  };
  restore('document', { createElement: (type: string) => { assert.equal(type, 'audio'); return audio; } });
  restore('AudioContext', FakeContext);
  const controller = new AbortController(), errors: unknown[] = [];
  const parent = { style: {}, append() {}, remove() {} } as unknown as HTMLElement;
  const options = { signal: controller.signal, still, onError: (error: unknown) => errors.push(error) };
  const renderer = audioRenderer(selected, parent, options);
  t.after(() => renderer.dispose());
  const draw = (localTimeMs: number, phase: PlayerFrame['phase'] = 'playing', opacity = 1, looping = false, audioGain = 1) => {
    const item: FrameItem = { clip: selected, localTimeMs, opacity: 1, audioGain, ...(looping ? { audioLoop: true } : {}) };
    renderer.draw(item, { phase, positionMs: selected.startMs + localTimeMs, opacity, items: [item] });
  };
  return { audio, gain, renderer, draw, errors, controller, parent, options, restore,
    graph: () => ({ contexts, closed, disconnected }) };
}

test('audio live numeric trim, gain and envelope edits reuse their prepared decoder and graph', async t => {
  const { audio, gain, renderer, draw, graph, errors } = setup(t);
  await renderer.prepare();
  draw(1000); await flush();
  const edited: AudioClip = { ...clip, properties: { ...clip.properties, volume: .25, sourceRange: { inMs: 2000, outMs: 4500 } } };
  const item: FrameItem = { clip: edited, localTimeMs: 1000, opacity: 1, audioGain: .5 };
  renderer.draw(item, { phase: 'playing', positionMs: 2000, opacity: 1, items: [item] });
  await flush();
  assert.equal(audio.currentTime, 3);
  assert.equal(audio.volume, .25);
  assert.equal(gain.gain.value, .5);
  assert.equal(audio.paused, false);
  assert.equal(audio.loads, 1);
  assert.deepEqual(graph(), { contexts: 1, closed: 0, disconnected: 0 });
  assert.deepEqual(errors, []);
});

test('audio streams through a retained gain graph; delayed clips and preparation stay silent', async t => {
  const { audio, gain, renderer, draw, graph } = setup(t);
  audio.nextPlay = async () => { assert.equal(audio.muted, false); assert.equal(audio.volume, 0.8); assert.equal(gain.gain.value, 0); };
  await renderer.prepare();
  assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  renderer.draw(undefined, { phase: 'playing', positionMs: 0, opacity: 1, items: [] });
  assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  audio.nextPlay = null; draw(0); await flush();
  assert.equal(audio.paused, false); assert.equal(gain.gain.value, 1); assert.equal(audio.volume, 0.8);
  assert.equal(audio.loop, false); assert.equal(audio.loads, 1); assert.equal(graph().contexts, 1);
});

test('trimmed sounds obey parent seeks and pause/resume at the exact source anchor', async t => {
  const ranged: AudioClip = { ...clip, properties: { ...clip.properties, sourceRange: { inMs: 1000, outMs: 3000 } } };
  const { renderer, audio, gain, draw, errors } = setup(t, ranged);
  await renderer.prepare(); assert.equal(audio.currentTime, 1);
  draw(1250); await flush(); assert.equal(audio.currentTime, 2.25); assert.equal(audio.paused, false);
  audio.advanceTo(2.28); draw(1260, 'paused'); await flush();
  assert.equal(audio.currentTime, 2.26); assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  draw(1260); await flush(); assert.equal(audio.paused, false);
  draw(2000); await flush(); assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  draw(0); await flush(); assert.equal(audio.currentTime, 1); assert.equal(audio.paused, false);
  assert.deepEqual(errors, []);
});

test('manual range loops wrap only with audioLoop, retain authored period, and remain silent past nonloop source end', async t => {
  const ranged: AudioClip = { ...clip, properties: { ...clip.properties, loop: true, sourceRange: { inMs: 3000, outMs: 5000 } } };
  const { renderer, audio, draw } = setup(t, ranged); audio.duration = 4.8;
  await renderer.prepare();
  for (const localMs of [0, 1000, 1800, 1999, 2000, 25_000, 500]) {
    draw(localMs, 'playing', 1, true); await flush();
    assert.ok(Math.abs(audio.currentTime - Math.min(3 + localMs % 2000 / 1000, 4.799)) < 1e-9);
    assert.equal(audio.paused, localMs % 2000 >= 1800);
  }
  draw(6000); await flush(); assert.equal(audio.paused, true);
  assert.ok(audio.seeks.every(seconds => seconds >= 3 && seconds < 4.8));
});

test('gain combines authored clip fades and global fade while already-playing sound advances during exit', async t => {
  const { renderer, audio, gain, draw } = setup(t); await renderer.prepare();
  draw(1000, 'playing', 1, false, 0.5); await flush(); assert.equal(gain.gain.value, 0.5);
  audio.advanceTo(1.1); draw(1000, 'exiting', 0.4, false, 0.5); await flush();
  assert.equal(audio.currentTime, 1.1); assert.equal(audio.paused, false); assert.equal(gain.gain.value, 0.2);
  audio.advanceTo(1.2); draw(1000, 'exiting', 0.1, false, 0.5); await flush();
  assert.equal(audio.currentTime, 1.2); assert.equal(gain.gain.value, 0.05);
  draw(1000, 'exiting', 0); assert.equal(gain.gain.value, 0);
  renderer.dispose(); assert.equal(audio.volume, 0);
});

test('exit from pause never starts sound; trim boundaries stop or wrap active exit playback', async t => {
  const ranged: AudioClip = { ...clip, properties: { ...clip.properties, loop: true, sourceRange: { inMs: 1000, outMs: 2000 } } };
  const { renderer, audio, gain, draw } = setup(t, ranged); await renderer.prepare();
  draw(100, 'paused'); await flush(); const plays = audio.plays;
  draw(100, 'exiting', 0.5); await flush(); assert.equal(audio.plays, plays); assert.equal(audio.paused, true);
  draw(100); await flush(); draw(100, 'exiting', 0.5);
  audio.advanceTo(2); audio.dispatchEvent(new Event('timeupdate')); await flush();
  assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  draw(0, 'playing', 1, true); await flush(); draw(0, 'exiting', 0.5, true);
  audio.advanceTo(2); audio.dispatchEvent(new Event('timeupdate')); await flush();
  assert.equal(audio.currentTime, 1); assert.equal(audio.paused, false); assert.equal(gain.gain.value, 0.5);
});

test('still and scrub previews never create a context, unlock audio, or call play', async t => {
  const { renderer, audio, draw, graph } = setup(t, clip, true); await renderer.prepare();
  for (const time of [0, 1200, 9000, 200]) { draw(time); await flush(); }
  assert.equal(audio.plays, 0); assert.equal(audio.muted, true); assert.equal(audio.volume, 0); assert.equal(graph().contexts, 0);
});

test('audible readiness requires unmuted nonzero volume and a running context before declaring preparation ready', async t => {
  const { renderer: unused, audio, gain, options, parent, restore } = setup(t); unused.dispose();
  let resumed = 0, gated = 0, closed = 0;
  class SuspendedContext {
    state = 'suspended'; destination = {};
    createGain() { return gain; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    async resume() { resumed += 1; this.state = 'running'; }
    async close() { closed += 1; }
  }
  restore('AudioContext', SuspendedContext);
  audio.nextPlay = async () => {
    assert.equal(audio.muted, false); assert.equal(audio.volume, 0.8); assert.equal(gain.gain.value, 0);
    if (audio.plays === 1) throw new DOMException('Gesture required', 'NotAllowedError');
  };
  const renderer = audioRenderer(clip, parent, { ...options, requestAudioUnlock: async unlock => { gated += 1; await unlock(); } });
  await renderer.prepare(); assert.equal(gated, 1); assert.equal(resumed, 1); assert.equal(audio.plays, 2);
  assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  renderer.dispose(); await flush(); assert.equal(closed, 1);
});

test('autoplay refusal without a local gate fails silently and releases the streaming graph', async t => {
  const { renderer, audio, graph } = setup(t);
  audio.nextPlay = async () => { throw new DOMException('Gesture required', 'NotAllowedError'); };
  await assert.rejects(renderer.prepare(), /MEDIA_AUTOPLAY/);
  assert.equal(audio.paused, true); assert.equal(audio.volume, 0); assert.equal(graph().closed, 1);
});

test('pending play cannot revive paused, aborted, disposed, or failed sound and no listeners or contexts leak', async t => {
  for (const ending of ['pause', 'abort', 'dispose', 'error'] as const) {
    const { renderer, audio, gain, draw, controller, errors, graph } = setup(t); await renderer.prepare();
    let resolvePlay!: () => void;
    audio.nextPlay = () => new Promise<void>(resolve => { resolvePlay = () => { audio.paused = false; resolve(); }; });
    draw(0); await flush();
    if (ending === 'pause') draw(0, 'paused');
    if (ending === 'abort') controller.abort();
    if (ending === 'dispose') renderer.dispose();
    if (ending === 'error') audio.dispatchEvent(new Event('error'));
    resolvePlay(); await flush(); assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
    assert.equal(errors.length, ending === 'error' ? 1 : 0);
    renderer.dispose(); assert.equal(audio.listenerCount, 0); assert.equal(audio.src, ''); assert.equal(audio.removed, true);
    assert.deepEqual(graph(), { contexts: 1, closed: 1, disconnected: 2 });
  }
});

test('pending seeks reconcile the latest pause and later loop jump before any play', async t => {
  const { renderer, audio, draw, errors } = setup(t); await renderer.prepare();
  audio.delaySeeks = true; draw(4000, 'playing', 1, true); draw(11_250, 'paused', 1, true);
  audio.finishSeek(); await flush(); assert.equal(audio.currentTime, 1.25);
  audio.finishSeek(); await flush(); assert.equal(audio.paused, true); assert.deepEqual(errors, []);
});

test('metadata and start-buffer deadlines fail boundedly and cancellation consumes late preparation plays', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stage of ['metadata', 'buffer']) {
    const { renderer, audio, graph } = setup(t);
    if (stage === 'metadata') audio.readyState = 0;
    else audio.buffered.length = 0;
    const preparation = renderer.prepare(); const rejected = assert.rejects(preparation, /MEDIA_TIMEOUT/);
    await flush(); t.mock.timers.tick(30_001); await rejected;
    renderer.dispose(); assert.equal(audio.listenerCount, 0); assert.equal(graph().contexts, 0);
  }
  const { renderer, audio, controller, graph } = setup(t);
  let resolvePlay!: () => void;
  audio.nextPlay = () => new Promise<void>(resolve => { resolvePlay = () => { audio.paused = false; resolve(); }; });
  const pending = renderer.prepare(), rejected = assert.rejects(pending, { name: 'AbortError' });
  await flush(); controller.abort(); await rejected; resolvePlay(); await flush();
  assert.equal(audio.paused, true); assert.equal(audio.volume, 0); assert.equal(graph().closed, 1);
});

test('runtime stalled sound fails locally after eight seconds and remains terminal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { renderer, audio, draw, errors, gain } = setup(t); await renderer.prepare();
  draw(0); await flush(); audio.readyState = 2; audio.dispatchEvent(new Event('waiting'));
  t.mock.timers.tick(7999); assert.equal(errors.length, 0);
  t.mock.timers.tick(1); assert.equal((errors[0] as MediaPreparationError).code, 'MEDIA_BUFFER_TIMEOUT');
  assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  const plays = audio.plays; draw(0); await flush(); assert.equal(audio.plays, plays);
});

test('probeAudio reads metadata without playing or constructing an audio graph', async t => {
  const { audio, graph } = setup(t);
  assert.deepEqual(await probeAudio(clip.properties.source.path, new AbortController().signal), { durationMs: 5000 });
  assert.equal(audio.preload, 'metadata'); assert.equal(audio.plays, 0); assert.equal(graph().contexts, 0);
  assert.equal(audio.src, ''); assert.equal(audio.removed, true);
});

test('an audio-only composition never acquires board, keying, or canvas visual resources', async t => {
  const { renderer: unused, parent, options, audio } = setup(t, clip, true); unused.dispose();
  const composition = new CompositionRenderer([clip], parent, { width: 100, height: 100 }, {
    ...options, boardBackdrop: () => { assert.fail('Audio requested a visual backdrop'); }
  });
  await composition.prepare();
  const item: FrameItem = { clip, opacity: 1, localTimeMs: 0, audioGain: 1 };
  composition.draw({ phase: 'playing', positionMs: 1000, opacity: 1, items: [item] });
  assert.equal(audio.style.display, 'none'); assert.equal(audio.plays, 0);
  composition.dispose();
});

test('many simultaneous sound clips share one composition-owned context and release every source/gain', async t => {
  const { renderer: unused, options, parent, restore } = setup(t); unused.dispose();
  const nodes: FakeAudio[] = [];
  let appended = 0;
  parent.append = () => { appended += 1; };
  let contexts = 0, closed = 0, disconnected = 0;
  restore('document', { createElement: (type: string) => {
    assert.equal(type, 'audio'); const audio = new FakeAudio(); nodes.push(audio); return audio;
  } });
  class SharedContext {
    state = 'running'; destination = {};
    constructor() { contexts += 1; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() { disconnected += 1; } }; }
    createMediaElementSource() { return { connect() {}, disconnect() { disconnected += 1; } }; }
    async close() { closed += 1; }
  }
  restore('AudioContext', SharedContext);
  const clips = Array.from({ length: 24 }, (_, index) => ({ ...clip, id: `sound-${index}`, trackId: `track-${index}` }));
  const composition = new CompositionRenderer(clips, parent, { width: 100, height: 100 }, options);
  await composition.prepare(); assert.equal(contexts, 1); assert.equal(nodes.length, 24);
  assert.ok(nodes.every(node => node.paused));
  const edited = clips.slice().reverse().map(sound => ({ ...sound, properties: { ...sound.properties, volume: .4 } }));
  composition.updatePreview(edited);
  composition.draw({ phase: 'playing', positionMs: 1000, opacity: 1,
    items: edited.map(sound => ({ clip: sound, localTimeMs: 0, opacity: 1, audioGain: 1 })) });
  await flush();
  assert.equal(appended, 24, 'live replanning never detaches and re-appends prepared media');
  assert.equal(nodes.length, 24);
  assert.equal(contexts, 1);
  assert.equal(closed, 0);
  assert.ok(nodes.every(node => node.loads === 1 && node.volume === .4 && !node.paused));
  assert.equal(nodes[0]?.style.zIndex, '24', 'numeric timing reorder can use paint order without moving decoder nodes');
  composition.dispose(); composition.dispose(); await flush();
  assert.equal(closed, 1); assert.equal(disconnected, 48);
  assert.ok(nodes.every(node => node.removed && node.src === '' && node.volume === 0 && node.listenerCount === 0));
});

test('duration mismatch and media errors reject preparation without starting sound', async t => {
  for (const reason of ['duration', 'error']) {
    const { renderer, audio, graph } = setup(t);
    if (reason === 'duration') audio.duration = 6;
    else audio.error = {} as MediaError;
    await assert.rejects(renderer.prepare(), reason === 'duration' ? /MEDIA_DURATION_CHANGED/ : /MEDIA_LOAD_FAILED/);
    assert.equal(audio.plays, 0); assert.equal(audio.volume, 0); assert.equal(graph().contexts, 0);
    renderer.dispose(); assert.equal(audio.listenerCount, 0);
  }
});

test('Break source anchors keep loops and finish independent of frozen timeline and regular loop', async t => {
  const ranged: AudioClip = { ...clip, properties: { ...clip.properties, loop: true, sourceRange: { inMs: 1000, outMs: 4000 } } };
  const { renderer, audio, gain, errors, graph } = setup(t, ranged); await renderer.prepare();
  const draw = (mediaTimeMs: number, mediaPlayback: NonNullable<FrameItem['mediaPlayback']>,
    phase: PlayerFrame['phase'] = 'holding', opacity = 1) => {
    const item: FrameItem = { clip: ranged, localTimeMs: 9000, mediaTimeMs, mediaPlayback,
      opacity: 1, audioGain: 0.8, ...(mediaPlayback === 'looping' ? { audioLoop: true } : {}) };
    renderer.draw(item, { phase, positionMs: 10_000, opacity, items: [item] });
  };
  draw(2800, 'looping'); await flush(); assert.equal(audio.currentTime, 3.8); assert.equal(audio.paused, false);
  audio.advanceTo(3.98); draw(50, 'looping'); await flush();
  assert.equal(audio.currentTime, 1.05, 'holding wrap starts at selected in-point despite frozen local time');
  assert.equal(gain.gain.value, 0.8);
  audio.advanceTo(1.07); draw(50, 'paused'); await flush();
  assert.equal(audio.currentTime, 1.05); assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  const plays = audio.plays;
  draw(50, 'paused', 'exiting', 0.4); await flush(); assert.equal(audio.plays, plays);
  draw(1000, 'finishing'); await flush(); assert.equal(audio.currentTime, 2); assert.equal(audio.paused, false);
  draw(2000, 'finishing', 'paused'); await flush(); assert.equal(audio.currentTime, 3); assert.equal(gain.gain.value, 0);
  draw(2000, 'finishing'); await flush(); assert.equal(audio.paused, false);
  audio.advanceTo(3.5); draw(2500, 'finishing', 'exiting', 0.25); await flush();
  assert.equal(audio.currentTime, 3.5); assert.equal(audio.paused, false); assert.equal(gain.gain.value, 0.2);
  draw(3000, 'finished'); await flush(); assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  const finishedPlays = audio.plays;
  draw(3000, 'finished', 'exiting', 0.2); await flush(); assert.equal(audio.plays, finishedPlays);
  draw(50, 'looping', 'exiting', 0.5); await flush(); assert.equal(audio.paused, false); assert.equal(gain.gain.value, 0.4);
  renderer.dispose(); await flush();
  assert.deepEqual(errors, []); assert.equal(audio.listenerCount, 0); assert.equal(audio.volume, 0);
  assert.deepEqual(graph(), { contexts: 1, closed: 1, disconnected: 2 });
});

test('Break seeks reconcile the latest frozen source and late play cannot escape normal pause', async t => {
  const { renderer, audio, gain, errors } = setup(t); await renderer.prepare();
  const draw = (mediaTimeMs: number, phase: PlayerFrame['phase']) => {
    const item: FrameItem = { clip, localTimeMs: 8000, mediaTimeMs, mediaPlayback: 'looping', audioLoop: true,
      opacity: 1, audioGain: 1 };
    renderer.draw(item, { phase, positionMs: 9000, opacity: 1, items: [item] });
  };
  audio.delaySeeks = true;
  draw(4000, 'holding'); draw(25, 'paused'); audio.finishSeek(); await flush();
  assert.equal(audio.currentTime, 0.025); audio.finishSeek(); await flush();
  assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  let resolvePlay!: () => void;
  audio.nextPlay = () => new Promise<void>(resolve => { resolvePlay = () => { audio.paused = false; resolve(); }; });
  draw(25, 'holding'); await flush(); draw(25, 'paused'); resolvePlay(); await flush();
  assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0); assert.deepEqual(errors, []);
});

test('a native audio ending recovers when the shared Break clock skips exact full periods', async t => {
  const { renderer, audio, gain, errors } = setup(t); await renderer.prepare();
  const draw = (mediaCycle: number) => {
    const item: FrameItem = { clip, localTimeMs: 8000, mediaTimeMs: 4600, mediaCycle, mediaPlayback: 'looping',
      audioLoop: true, opacity: 1, audioGain: 1 };
    renderer.draw(item, { phase: 'holding', positionMs: 9000, opacity: 1, items: [item] });
  };
  draw(0); await flush(); audio.advanceTo(5); audio.ended = true; audio.paused = true;
  audio.dispatchEvent(new Event('ended')); await flush(); assert.equal(audio.paused, true); assert.equal(gain.gain.value, 0);
  draw(3); await flush(); assert.equal(audio.currentTime, 4.6); assert.equal(audio.paused, false);
  assert.equal(gain.gain.value, 1); assert.deepEqual(errors, []);
});

test('schema 2 ordinary global fade advances active sound without seeking back and preserves ordinary pause', async t => {
  for (const pausedOrigin of [false, true]) {
    const selected: AudioClip = { ...clip, typeVersion: 3, startMs: 0,
      duration: { kind: 'fixed', milliseconds: 5000 }, properties: { ...clip.properties,
        loop: false, loopIndefinitely: false, onBreak: 'pause' } };
    const { renderer, audio, gain, errors } = setup(t, selected);
    let now = 0, callback: (() => void) | null = null;
    const runtime: Runtime = { now: () => now, requestFrame(next) { callback = next; return 1; }, cancelFrame() { callback = null; } };
    const advance = (ms: number) => { now += ms; const next = callback; callback = null; next?.(); };
    const sequence: SequenceV1 = { schemaVersion: 2, id: 'ordinary-fade', revision: 1, name: 'Ordinary fade',
      composition: { width: 1920, height: 1080 }, presentation: { surface: 'window', blockInput: false, exitDurationMs: 2000 },
      tracks: [{ id: 'sound', name: 'Audio', kind: 'audio', order: 0, enabled: true, locked: false }],
      clips: [selected], end: { kind: 'fixed', durationMs: 10_000 } };
    const frames: PlayerFrame[] = [];
    const player = new LocalPlayer(runtime);
    await player.start(sequence, { prepare: () => renderer.prepare(),
      render(frame) { frames.push(frame); renderer.draw(frame.items[0], frame); }, dispose: () => renderer.dispose() });
    await flush(); audio.advanceTo(1); advance(1000); await flush();
    assert.equal(audio.paused, false); assert.equal(gain.gain.value, 1);
    if (pausedOrigin) { player.pause(); await flush(); assert.equal(gain.gain.value, 0); }
    const plays = audio.plays, seeks = audio.seeks.length;
    player.fadeOut(); await flush();
    if (!pausedOrigin) audio.advanceTo(1.5);
    advance(500); await flush();
    assert.equal(frames.at(-1)!.positionMs, 1000, 'composition clock remains at exit origin');
    assert.equal(frames.at(-1)!.holdElapsedMs, undefined, 'ordinary fade has no Break clock');
    assert.equal(frames.at(-1)!.items[0]!.mediaTimeMs, pausedOrigin ? 1000 : 1500);
    assert.equal(audio.currentTime, pausedOrigin ? 1 : 1.5);
    assert.equal(audio.seeks.length, seeks, 'global gain fade never rewinds the live source');
    assert.equal(audio.plays, plays); assert.equal(audio.paused, pausedOrigin);
    assert.equal(gain.gain.value, pausedOrigin ? 0 : 0.75);
    advance(1500); await flush(); assert.equal(player.getState().phase, 'ended'); assert.equal(gain.gain.value, 0);
    assert.deepEqual(errors, []);
  }
});

test('schema 2 natural ordinary exit keeps unfinished audio advancing through its shared fade', async t => {
  const selected: AudioClip = { ...clip, typeVersion: 3, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 1000 }, properties: { ...clip.properties,
      loop: false, loopIndefinitely: false, onBreak: 'pause' } };
  const { renderer, audio, gain, errors } = setup(t, selected);
  let now = 0, callback: (() => void) | null = null;
  const runtime: Runtime = { now: () => now, requestFrame(next) { callback = next; return 1; }, cancelFrame() { callback = null; } };
  const sequence: SequenceV1 = { schemaVersion: 2, id: 'natural-fade', revision: 1, name: 'Natural fade',
    composition: { width: 1920, height: 1080 }, presentation: { surface: 'window', blockInput: false, exitDurationMs: 1000 },
    tracks: [{ id: 'sound', name: 'Audio', kind: 'audio', order: 0, enabled: true, locked: false }],
    clips: [selected], end: { kind: 'fixed', durationMs: 1000 } };
  const frames: PlayerFrame[] = [], player = new LocalPlayer(runtime);
  t.after(() => player.stop());
  await player.start(sequence, { prepare: () => renderer.prepare(),
    render(frame) { frames.push(frame); renderer.draw(frame.items[0], frame); }, dispose: () => renderer.dispose() });
  await flush(); const seeks = audio.seeks.length;
  audio.advanceTo(1.25); now = 1250; const next = callback as (() => void) | null; callback = null; next?.(); await flush();
  assert.equal(frames.at(-1)!.phase, 'exiting'); assert.equal(frames.at(-1)!.positionMs, 1000);
  assert.equal(frames.at(-1)!.items[0]!.mediaTimeMs, 1250); assert.equal(audio.currentTime, 1.25);
  assert.equal(audio.seeks.length, seeks); assert.equal(audio.paused, false); assert.equal(gain.gain.value, 0.75);
  assert.deepEqual(errors, []);
});


test('inner Continue exactly resynchronizes Break-only audio loops in both sub-threshold directions once', async t => {
  for (const [heldMs, elapsedMs] of [[1200, 200], [800, 4800]] as const) {
    const selected: AudioClip = { ...clip, typeVersion: 3, startMs: 0,
      duration: { kind: 'fixed', milliseconds: 5000 }, properties: { ...clip.properties, loop: false, onBreak: 'loop' } };
    const { renderer, audio, gain, errors } = setup(t, selected); await renderer.prepare();
    const held: FrameItem = { clip: selected, localTimeMs: 1000, mediaTimeMs: heldMs,
      mediaPlayback: 'looping', mediaCycle: Math.floor((1000 + elapsedMs) / 5000), audioLoop: true, opacity: 1, audioGain: 1 };
    renderer.draw(held, { phase: 'holding', positionMs: 1000, breakId: 'inner', breakHistory: [], opacity: 1, items: [held] });
    await flush(); assert.equal(audio.currentTime, heldMs / 1000);
    const continued: FrameItem = { clip: selected, localTimeMs: 1000, mediaTimeMs: 1000, mediaPlayback: 'playing', opacity: 1, audioGain: 1 };
    const frame: PlayerFrame = { phase: 'playing', positionMs: 1000, breakHistory: [{ id: 'inner', positionMs: 1000, elapsedMs }], opacity: 1, items: [continued] };
    const seeks = audio.seeks.length;
    renderer.draw(continued, frame); await flush();
    assert.equal(audio.currentTime, 1, 'Continue seeks to timeline source, regardless of the ordinary decoder loop flag');
    assert.equal(audio.playbackRate, 1); assert.equal(audio.paused, false); assert.equal(gain.gain.value, 1);
    assert.equal(audio.seeks.length, seeks + 1);
    renderer.draw(continued, frame); await flush();
    assert.equal(audio.seeks.length, seeks + 1, 'the same consumed marker never repeats the deliberate seek');
    assert.deepEqual(errors, []);
  }
});

test('audio Continue queued during an older seek reconciles the latest target once and stays silent until settled', async t => {
  const selected: AudioClip = { ...clip, typeVersion: 3, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5000 }, properties: { ...clip.properties, loop: false, onBreak: 'loop' } };
  const { renderer, audio, gain, errors } = setup(t, selected); await renderer.prepare();
  audio.delaySeeks = true;
  const draw = (sourceMs: number, phase: PlayerFrame['phase']) => {
    const holding = phase === 'holding';
    const item: FrameItem = { clip: selected, localTimeMs: holding ? 1000 : sourceMs, mediaTimeMs: sourceMs,
      mediaPlayback: holding ? 'looping' : 'playing', opacity: 1, audioGain: 1, ...(holding ? { audioLoop: true } : {}) };
    renderer.draw(item, { phase, positionMs: holding ? 1000 : sourceMs, opacity: 1, items: [item],
      ...(holding ? { breakId: 'inner', breakHistory: [] } : { breakHistory: [{ id: 'inner', positionMs: 1000, elapsedMs: 200 }] }) });
  };
  draw(1200, 'holding'); draw(1000, 'playing'); draw(1020, 'playing');
  assert.deepEqual(audio.seeks, [1.2]); assert.equal(gain.gain.value, 0);
  audio.finishSeek(); await flush();
  assert.deepEqual(audio.seeks, [1.2, 1.02]); assert.equal(audio.seeking, true); assert.equal(audio.paused, true);
  audio.finishSeek(); await flush();
  assert.equal(audio.currentTime, 1.02); assert.equal(audio.paused, false); assert.equal(gain.gain.value, 1);
  draw(1020, 'playing'); await flush(); assert.equal(audio.seeks.length, 2); assert.deepEqual(errors, []);
});

test('audio Finish history advancement preserves source progress and native completed gate without new seeks or play', async t => {
  const selected: AudioClip = { ...clip, typeVersion: 3, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5000 }, properties: { ...clip.properties, loop: false, onBreak: 'finish' } };
  const { renderer, audio, errors } = setup(t, selected); await renderer.prepare();
  const item: FrameItem = { clip: selected, localTimeMs: 1000, mediaTimeMs: 1200, mediaPlayback: 'finishing', opacity: 1, audioGain: 1 };
  renderer.draw(item, { phase: 'holding', positionMs: 1000, breakId: 'inner', breakHistory: [], opacity: 1, items: [item] });
  await flush(); const seeks = audio.seeks.length, plays = audio.plays;
  renderer.draw(item, { phase: 'playing', positionMs: 1000, breakHistory: [{ id: 'inner', positionMs: 1000, elapsedMs: 200 }], opacity: 1, items: [item] });
  await flush(); assert.equal(audio.seeks.length, seeks); assert.equal(audio.plays, plays); assert.equal(audio.currentTime, 1.2);
  audio.advanceTo(5); audio.ended = true; audio.paused = true; audio.dispatchEvent(new Event('ended'));
  await flush(); const afterEndSeeks = audio.seeks.length, afterEndPlays = audio.plays;
  renderer.draw(item, { phase: 'playing', positionMs: 1500,
    breakHistory: [{ id: 'inner', positionMs: 1000, elapsedMs: 200 }, { id: 'later', positionMs: 1500, elapsedMs: 100 }], opacity: 1, items: [item] });
  await flush(); assert.equal(audio.seeks.length, afterEndSeeks); assert.equal(audio.plays, afterEndPlays); assert.equal(audio.paused, true);
  assert.deepEqual(errors, []);
});


test('audio inner Continue clears the native-ended gate before its one deliberate small rewind', async t => {
  const selected: AudioClip = { ...clip, typeVersion: 3, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5000 }, properties: { ...clip.properties, loop: false, onBreak: 'loop' } };
  const { renderer, audio, gain, errors } = setup(t, selected); await renderer.prepare();
  const held: FrameItem = { clip: selected, localTimeMs: 4700, mediaTimeMs: 4900, mediaPlayback: 'looping', mediaCycle: 0, audioLoop: true, opacity: 1 };
  renderer.draw(held, { phase: 'holding', positionMs: 4700, breakId: 'inner', breakHistory: [], opacity: 1, items: [held] });
  await flush(); audio.advanceTo(5); audio.ended = true; audio.paused = true; audio.dispatchEvent(new Event('ended'));
  await flush(); assert.equal(gain.gain.value, 0);
  const item: FrameItem = { clip: selected, localTimeMs: 4700, mediaTimeMs: 4700, mediaPlayback: 'playing', opacity: 1 };
  const frame: PlayerFrame = { phase: 'playing', positionMs: 4700,
    breakHistory: [{ id: 'inner', positionMs: 4700, elapsedMs: 200 }], opacity: 1, items: [item] };
  const seeks = audio.seeks.length;
  renderer.draw(item, frame); await flush(); assert.equal(audio.currentTime, 4.7); assert.equal(audio.paused, false); assert.equal(gain.gain.value, 1);
  assert.equal(audio.seeks.length, seeks + 1); renderer.draw(item, frame); await flush(); assert.equal(audio.seeks.length, seeks + 1);
  assert.deepEqual(errors, []);
});
