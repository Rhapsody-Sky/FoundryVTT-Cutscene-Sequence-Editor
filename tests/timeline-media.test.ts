import test from 'node:test';
import assert from 'node:assert/strict';
import type { SequenceV1, VideoClip } from '../src/domain/sequence.js';
import { clipDurationMs, sequenceDurationMs, videoDurationMs } from '../src/domain/clip-timing.js';
import { validateSequence } from '../src/domain/validation.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';
import { videoRenderer } from '../src/rendering/video-renderer.js';
import { CompositionRenderer } from '../src/rendering/composition-renderer.js';

function video(id = 'first', startMs = 0): VideoClip {
  return { id, trackId: 'visual', type: 'video', typeVersion: 1, startMs,
    duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { source: { kind: 'foundry-file', path: 'worlds/test/movie.webm' }, fit: 'contain', volume: 0.7, muted: true, durationMs: 5000 } };
}
function trimmed(id = 'first', startMs = 0): VideoClip {
  const clip = video(id, startMs);
  return { ...clip, typeVersion: 2, properties: { ...clip.properties, sourceRange: { inMs: 1000, outMs: 3000 } } };
}
function sequence(clips: readonly VideoClip[] = [video()]): SequenceV1 {
  return { schemaVersion: 1, id: 'sequence', revision: 0, name: 'Timeline', composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: true, exitDurationMs: 500 },
    tracks: [{ id: 'visual', name: 'Video', kind: 'visual', order: 0, enabled: true, locked: false }], clips,
    end: { kind: 'media', clipId: clips.at(-1)!.id } };
}

test('v1 videos retain full metadata and endpoint while v2 trim duration preserves full-source metadata', () => {
  const old = validateSequence(sequence());
  assert.equal(old.clips[0]!.typeVersion, 1);
  assert.equal(videoDurationMs(old.clips[0] as VideoClip), 5000);
  assert.equal(sequenceDurationMs(old), 5000);
  assert.equal(evaluate(compileSequence(old), 5000)[0]!.localTimeMs, 5000);
  const clip = trimmed('trim', 2000);
  const value = validateSequence(sequence([clip]));
  assert.equal(clip.properties.durationMs, 5000);
  assert.equal(videoDurationMs(clip), 2000);
  assert.equal(sequenceDurationMs(value), 4000);
  assert.equal(clipDurationMs(value, clip), 2000);
});

test('source ranges require version 2, inspected metadata, integer bounds, and fades that fit the trimmed interval', () => {
  const clip = trimmed();
  assert.throws(() => validateSequence(sequence([{ ...clip, typeVersion: 1 }])), /version 2/);
  assert.throws(() => validateSequence(sequence([{ ...video(), typeVersion: 2 }])), /source range/);
  const { durationMs: _duration, ...properties } = clip.properties;
  assert.throws(() => validateSequence(sequence([{ ...clip, properties }])), /inspected/);
  for (const range of [{ inMs: -1, outMs: 3000 }, { inMs: 1000, outMs: 5001 },
    { inMs: 1000, outMs: 1000 }, { inMs: 3000, outMs: 1000 }, { inMs: 1.5, outMs: 3000 },
    { inMs: 1000, outMs: Number.POSITIVE_INFINITY }]) {
    assert.throws(() => validateSequence(sequence([{ ...clip, properties: { ...clip.properties, sourceRange: range } }])));
  }
  assert.throws(() => validateSequence(sequence([{ ...clip,
    entrance: { preset: 'fade', version: 1, durationMs: 1500, easing: 'linear' },
    exit: { preset: 'fade', version: 1, durationMs: 501, easing: 'linear' } }])), /conflict/);
});

test('multiple media clips switch at their shared boundary and only final media holds during the global fade', () => {
  const first = trimmed();
  const second = trimmed('second', 2000);
  const plan = compileSequence(sequence([first, second]));
  assert.equal(plan.durationMs, 4000);
  assert.deepEqual(evaluate(plan, 1999).map(item => item.clip.id), ['first']);
  assert.deepEqual(evaluate(plan, 2000).map(item => [item.clip.id, item.localTimeMs]), [['second', 0]]);
  assert.deepEqual(evaluate(plan, 4000).map(item => [item.clip.id, item.localTimeMs, item.opacity]), [['second', 2000, 1]]);
  const fixed = compileSequence({ ...sequence([first]), end: { kind: 'fixed', durationMs: 3000 } });
  assert.equal(evaluate(fixed, 2000).length, 0);
  assert.equal(evaluate(fixed, 3000).length, 0);
  assert.throws(() => compileSequence({ ...sequence([first, second]), end: { kind: 'media', clipId: first.id } }), /beyond/);
});

test('earlier video natural fades use trimmed length while the final media shares the global fade', () => {
  const first = { ...trimmed(), exit: { preset: 'fade' as const, version: 1 as const, durationMs: 500, easing: 'linear' as const } };
  const second = { ...first, id: 'second', startMs: 2000 };
  const plan = compileSequence(sequence([first, second]));
  assert.equal(evaluate(plan, 1750)[0]!.opacity, 0.5);
  assert.equal(evaluate(plan, 3750)[0]!.opacity, 1);
  assert.equal(evaluate(plan, 4000)[0]!.opacity, 1);
});

test('hidden ending media keeps the sequence endpoint while rendering only enabled tracks', () => {
  const hidden = trimmed('end', 2000);
  const visible = { ...trimmed('visible'), trackId: 'other' };
  const source = sequence([visible, hidden]);
  const plan = compileSequence({ ...source, tracks: [
    { ...source.tracks[0]!, enabled: false },
    { ...source.tracks[0]!, id: 'other', order: 1 }
  ] });
  assert.equal(plan.durationMs, 4000);
  assert.deepEqual(plan.clips.map(clip => clip.id), ['visible']);
  assert.deepEqual(evaluate(plan, 1000).map(item => item.clip.id), ['visible']);
  assert.equal(evaluate(plan, 4000).length, 0);
});

test('timing helpers distinguish uninspected media and manual held elements', () => {
  const clip = video();
  const { durationMs: _duration, ...properties } = clip.properties;
  const unknown = { ...clip, properties };
  assert.equal(videoDurationMs(unknown), undefined);
  assert.equal(sequenceDurationMs(sequence([unknown])), undefined);
  assert.throws(() => compileSequence(sequence([unknown])), /MEDIA_METADATA_REQUIRED/);
  const held = { id: 'bars', type: 'bars' as const, typeVersion: 1 as const, trackId: 'visual', startMs: 500,
    duration: { kind: 'sequence-end' as const }, entrance: clip.entrance, exit: clip.exit, properties: { color: '#000000', heightFraction: 0.1 } };
  assert.equal(clipDurationMs(sequence(), held), 4500);
  assert.equal(clipDurationMs({ ...sequence(), end: { kind: 'manual' } }, held), null);
});

class FakeNode {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  removed = false;
  append(..._nodes: unknown[]) {}
  remove() { this.removed = true; }
}
class FakeVideo extends FakeNode {
  src = ''; className = ''; playsInline = true; preload = ''; controls = false; disablePictureInPicture = true;
  muted = true; volume = 1; duration = 5; readyState = 4; seeking = false; paused = true; ended = false;
  currentTime = 0; playbackRate = 1; error: MediaError | null = null; plays = 0;
  buffered = { length: 1, start: () => 0, end: () => 5 };
  private readonly events = new EventTarget();
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  get listenerCount() { return [...this.listeners.values()].reduce((count, list) => count + list.size, 0); }
  addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    const [type, callback, options] = args;
    if (callback) {
      const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(callback); this.listeners.set(type, listeners);
      if (typeof options === 'object' && options.signal) {
        options.signal.addEventListener('abort', () => listeners.delete(callback), { once: true });
      }
    }
    this.events.addEventListener(...args);
  }
  removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    const [type, callback] = args;
    if (callback) this.listeners.get(type)?.delete(callback);
    this.events.removeEventListener(...args);
  }
  play() { this.plays += 1; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
function dom(t: { after(callback: () => void): void }) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const videos: FakeVideo[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement() { const node = new FakeVideo(); videos.push(node); return node; }
  } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else Reflect.deleteProperty(globalThis, 'document'); });
  return { videos, root: new FakeNode() as unknown as HTMLElement };
}
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

test('a manual held video plays once and stays paused at its final selected source frame', async t => {
  const { root, videos } = dom(t);
  const clip = trimmed();
  const plan = compileSequence({ ...sequence([clip]), end: { kind: 'manual' } });
  const renderer = videoRenderer(clip, root, { signal: new AbortController().signal });
  await renderer.prepare();
  const preparationPlays = videos[0]!.plays;
  const draw = (positionMs: number) => {
    const items = evaluate(plan, positionMs);
    renderer.draw(items[0], { phase: 'playing', positionMs, opacity: 1, items });
  };
  draw(1_000);
  await flush();
  assert.equal(videos[0]!.plays, preparationPlays + 1);
  assert.equal(videos[0]!.paused, false);
  for (const position of [2_000, 3_000, 60_000]) {
    draw(position);
    await flush();
    assert.equal(videos[0]!.currentTime, 2.999);
    assert.equal(videos[0]!.paused, true);
    assert.equal(videos[0]!.plays, preparationPlays + 1);
    assert.equal(videos[0]!.style.opacity, '1');
  }
  renderer.dispose();
  assert.equal(videos[0]!.src, '');
  assert.equal(videos[0]!.removed, true);
});

test('trimmed renderer seeks in source coordinates, pauses outside clips, and freezes before range end even after native ended', async t => {
  const { root, videos } = dom(t);
  const clip = trimmed();
  const renderer = videoRenderer(clip, root, { signal: new AbortController().signal });
  await renderer.prepare();
  const element = videos[0]!;
  assert.equal(element.currentTime, 1);
  const item = { clip, localTimeMs: 1000, opacity: 1 };
  renderer.draw(item, { phase: 'playing', positionMs: 1000, opacity: 1, items: [item] });
  await flush();
  assert.equal(element.currentTime, 2);
  assert.equal(element.playbackRate, 1);
  assert.equal(element.paused, false);
  renderer.draw(undefined, { phase: 'playing', positionMs: 2000, opacity: 1, items: [] });
  assert.equal(element.paused, true);
  assert.equal(element.style.opacity, '0');
  element.ended = true; element.currentTime = 5;
  const final = { clip, localTimeMs: 2000, opacity: 1 };
  renderer.draw(final, { phase: 'exiting', positionMs: 2000, opacity: 0.5, items: [final] });
  await flush();
  assert.equal(element.currentTime, 2.999);
  assert.equal(element.paused, true);
  assert.equal(element.style.opacity, '1');
  renderer.dispose();
});

test('trimmed preflight checks buffering at the selected source start and verifies full-source metadata', async t => {
  const { root, videos } = dom(t);
  const clip = trimmed();
  const renderer = videoRenderer(clip, root, { signal: new AbortController().signal, still: true });
  videos[0]!.buffered = { length: 1, start: () => 1, end: () => 3 };
  await renderer.prepare();
  assert.equal(videos[0]!.currentTime, 1);
  renderer.dispose();
  const wrong = videoRenderer(clip, root, { signal: new AbortController().signal, still: true });
  videos[1]!.duration = 2;
  await assert.rejects(wrong.prepare(), /MEDIA_DURATION_CHANGED/);
  wrong.dispose();
});

test('tolerated shorter runtime durations clamp trimmed buffering and final seeks without changing stored timing', async t => {
  const { root, videos } = dom(t);
  const base = trimmed();
  const clip = { ...base, properties: { ...base.properties, sourceRange: { inMs: 3000, outMs: 5000 } } };
  const renderer = videoRenderer(clip, root, { signal: new AbortController().signal, still: true });
  const element = videos[0]!;
  element.duration = 4.8;
  element.buffered = { length: 1, start: () => 3, end: () => 4.8 };
  await renderer.prepare();
  assert.equal(element.currentTime, 3);
  const item = { clip, localTimeMs: 2000, opacity: 1 };
  renderer.draw(item, { phase: 'exiting', positionMs: 2000, opacity: 0.5, items: [item] });
  await flush();
  assert.ok(Math.abs(element.currentTime - 4.799) < 1e-9);
  assert.equal(element.paused, true);
  assert.equal(clip.properties.durationMs, 5000);
  assert.equal(videoDurationMs(clip), 2000);
  renderer.dispose();

  const impossible = { ...base, properties: { ...base.properties, sourceRange: { inMs: 4900, outMs: 5000 } } };
  const rejected = videoRenderer(impossible, root, { signal: new AbortController().signal, still: true });
  videos[1]!.duration = 4.8;
  await assert.rejects(rejected.prepare(), /MEDIA_DURATION_CHANGED/);
  assert.equal(videos[1]!.currentTime, 0, 'impossible starts fail before seeking or waiting for buffering');
  rejected.dispose();
});

test('renderer disposal aborts its pending preparation waits while keeping the containing surface signal alive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const { root, videos } = dom(t);
  for (const waiting of ['metadata', 'seek', 'buffer'] as const) {
    const controller = new AbortController();
    const renderer = videoRenderer(trimmed(), root, { signal: controller.signal, still: true });
    const element = videos.at(-1)!;
    if (waiting === 'metadata') element.readyState = 0;
    else if (waiting === 'seek') element.seeking = true;
    else element.buffered = { length: 0, start: () => 0, end: () => 0 };
    const pending = renderer.prepare();
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await flush();
    const priorClears = cleared.mock.callCount();
    assert.ok(element.listenerCount > 0);
    renderer.dispose();
    await rejected;
    assert.equal(element.listenerCount, 0);
    assert.ok(cleared.mock.callCount() > priorClears, `${waiting} timeout was cleared`);
    assert.equal(controller.signal.aborted, false);
    assert.equal(element.src, '');
    assert.equal(element.removed, true);
  }
  t.mock.timers.tick(30_001);
});

test('replacing a still source range cancels old pending draw seeks and releases their listeners and timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const { root, videos } = dom(t);
  const clip = trimmed();
  const errors: unknown[] = [];
  const controller = new AbortController();
  const renderer = new CompositionRenderer([clip], root, { width: 1920, height: 1080 },
    { signal: controller.signal, still: true, onError: error => errors.push(error) });
  await renderer.prepare();
  const old = videos[0]!;
  old.seeking = true;
  const item = { clip, localTimeMs: 1000, opacity: 1 };
  renderer.draw({ phase: 'paused', positionMs: 1000, opacity: 1, items: [item] });
  const priorClears = cleared.mock.callCount();
  const updated = { ...clip, properties: { ...clip.properties, sourceRange: { inMs: 2000, outMs: 4000 } } };
  await renderer.updateStill([updated]);
  await flush();
  assert.equal(old.listenerCount, 0);
  assert.equal(old.removed, true);
  assert.ok(cleared.mock.callCount() > priorClears);
  assert.equal(controller.signal.aborted, false);
  t.mock.timers.tick(8001);
  await flush();
  assert.deepEqual(errors, []);
  renderer.dispose();
});

test('still source-range changes recreate the decoder and show the newly selected source time', async t => {
  const { root, videos } = dom(t);
  const clip = trimmed();
  const renderer = new CompositionRenderer([clip], root, { width: 1920, height: 1080 }, { signal: new AbortController().signal, still: true });
  await renderer.prepare();
  const updated = { ...clip, properties: { ...clip.properties, sourceRange: { inMs: 2000, outMs: 4000 } } };
  await renderer.updateStill([updated]);
  assert.equal(videos.length, 2);
  assert.equal(videos[0]!.removed, true);
  assert.equal(videos[1]!.currentTime, 2);
  const item = { clip: updated, localTimeMs: 1000, opacity: 1 };
  renderer.draw({ phase: 'paused', positionMs: 1000, opacity: 1, items: [item] });
  await flush();
  assert.equal(videos[1]!.currentTime, 3);
  assert.equal(videos[1]!.plays, 0);
  renderer.dispose();
});
