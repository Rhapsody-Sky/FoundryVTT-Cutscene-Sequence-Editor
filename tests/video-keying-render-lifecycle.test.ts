import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import type { VideoClip } from '../src/domain/sequence.js';
import { CompositionRenderer } from '../src/rendering/composition-renderer.js';
import { videoRenderer } from '../src/rendering/video-renderer.js';
import { VideoKeyingFilter, keyingTargetSize } from '../src/rendering/video-keying.js';

const clip: VideoClip = {
  id: 'keyed', trackId: 'video', type: 'video', typeVersion: 4, startMs: 0,
  duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
  properties: { source: { kind: 'foundry-file', path: 'worlds/test/key.webm' }, durationMs: 5000, fit: 'contain', volume: 1, muted: true,
    keying: { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.1 } }
};
class Node extends EventTarget {
  style: Record<string, string> = {}; dataset: Record<string, string> = {}; className = '';
  children: Node[] = []; parent: Node | null = null; width = 0; height = 0;
  frame: { source: string; key: number[] } | undefined;
  bounds = { left: 20, top: 30, width: 800, height: 600 };
  append(node: Node) { node.remove(); node.parent = this; this.children.push(node); }
  prepend(node: Node) { node.remove(); node.parent = this; this.children.unshift(node); }
  insertBefore(node: Node, ref: Node) { node.remove(); node.parent = this; this.children.splice(this.children.indexOf(ref), 0, node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(value => value !== this); this.parent = null; }
  get clientWidth() { return this.bounds.width; }
  get clientHeight() { return this.bounds.height; }
  getBoundingClientRect() { return this.bounds; }
}
class Video extends Node {
  src = ''; muted = true; volume = 1; currentTime = 0; playbackRate = 1; preload = ''; controls = false;
  playsInline = true; disablePictureInPicture = true; paused = true; seeking = false; ended = false;
  duration = 5; readyState = 4; videoWidth = 1920; videoHeight = 1080; error = null; loads = 0; plays = 0;
  buffered = { length: 1, start: () => 0, end: () => 5 };
  pendingPlay: (() => Promise<void>) | null = null;
  play() { this.plays += 1; this.paused = false; return this.pendingPlay?.() ?? Promise.resolve(); }
  pause() { this.paused = true; } load() { this.loads += 1; }
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
function harness(t: TestContext) {
  const calls: string[] = [], videos: Video[] = [], canvases: Node[] = [], attributes: { preserveDrawingBuffer: boolean }[] = [];
  let available = true, contextLost = false, gpuError = 0;
  const gpu = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3, COMPILE_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7,
    TEXTURE0: 8, TEXTURE_2D: 9, TEXTURE_MIN_FILTER: 10, TEXTURE_MAG_FILTER: 11, LINEAR: 12, TEXTURE_WRAP_S: 13,
    TEXTURE_WRAP_T: 14, CLAMP_TO_EDGE: 15, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 16, BLEND: 17, RGBA: 18, UNSIGNED_BYTE: 19,
    TRIANGLE_STRIP: 20, NO_ERROR: 0,
    createProgram: () => ({}), createTexture: () => ({}), createBuffer: () => ({}), createShader: () => ({}),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getShaderParameter: () => true,
    useProgram() {}, bindBuffer() {}, bufferData() {}, getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
    activeTexture() {}, bindTexture() {}, texParameteri() {}, pixelStorei() {}, getUniformLocation: () => ({}), uniform1i() {},
    disable() {}, viewport() {}, uniform3f() {}, uniform1f() {}, texImage2D() {}, drawArrays() {},
    getError: () => { calls.push('error-check'); return gpuError; }, isContextLost: () => contextLost,
    deleteProgram() { calls.push('delete-program'); }, deleteTexture() { calls.push('delete-texture'); },
    deleteBuffer() { calls.push('delete-buffer'); }, deleteShader() { calls.push('delete-shader'); },
    getExtension: () => ({ loseContext() { calls.push('lose-context'); } })
  };
  const frameCallbacks = new Map<number, FrameRequestCallback>(); let id = 0;
  const before = ['document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(tag: string) {
    if (tag === 'video') { const video = new Video(); videos.push(video); return video; }
    const node = new Node();
    if (tag === 'canvas') {
      canvases.push(node);
      // One overflow canvas deliberately has multiple active clip subscribers.
      setMaxListeners(0, node);
      const twoD = { setTransform() {}, clearRect() { calls.push('clear'); }, save() {}, restore() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
        moveTo() {}, lineTo() {}, closePath() {}, fill(rule?: CanvasFillRule) { if (rule === 'evenodd') calls.push('mask-fill-evenodd'); }, fillRect() {},
        drawImage(image: Node) { calls.push(image.frame ? 'copy' : 'board'); if (image.frame) node.frame = structuredClone(image.frame); }, fillStyle: '', globalCompositeOperation: 'source-over' };
      Object.assign(node, { getContext: (type: string, options: { preserveDrawingBuffer: boolean }) => {
        if (type === '2d') return twoD;
        calls.push('context'); attributes.push(options);
        let ownSource = '', ownKey: number[] = [];
        return available ? { ...gpu,
          uniform3f(_location: unknown, ...values: number[]) { ownKey = values; },
          texImage2D(...args: unknown[]) { calls.push('upload'); ownSource = (args.at(-1) as Video).src; },
          drawArrays() { calls.push('key'); node.frame = { source: ownSource, key: [...ownKey] }; }
        } : null;
      } });
    }
    return node;
  } } });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { frameCallbacks.set(++id, callback); return id; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (request: number) => { frameCallbacks.delete(request); } });
  t.after(() => { for (const [name, value] of before) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name); } });
  return { calls, videos, canvases, attributes, root: new Node(), frameCallbacks, unavailable: () => { available = false; },
    lose: () => { contextLost = true; }, allocationError: () => { gpuError = 1285; } };
}
const node = (value: Node) => value as unknown as HTMLElement;
const flush = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };
const item = (video = clip, localTimeMs = 0) => ({ clip: video, opacity: 0.8, localTimeMs });

test('disabled keying allocates no GPU and enabling/disabling reuses the prepared decoder', async t => {
  const h = harness(t), signal = new AbortController().signal;
  const disabled = { ...clip, properties: { ...clip.properties, keying: { ...clip.properties.keying!, enabled: false } } };
  const renderer = videoRenderer(disabled, node(h.root), { signal, still: true }); t.after(() => renderer.dispose());
  await renderer.prepare(); assert.equal(h.canvases.length, 0); assert.equal(h.videos.length, 1);
  renderer.updateAppearance?.(clip);
  renderer.draw(item(), { phase: 'paused', positionMs: 0, opacity: 0.5, items: [item()] });
  assert.equal(h.canvases.length, 1); assert.notEqual(renderer.node, h.videos[0]); assert.equal(h.videos[0]!.style.opacity, '0');
  assert.equal(renderer.node.style.opacity, '0.8'); assert.equal(renderer.node.style.backgroundColor, 'transparent');
  renderer.updateAppearance?.(disabled);
  renderer.draw(item(disabled), { phase: 'paused', positionMs: 0, opacity: 1, items: [item(disabled)] });
  assert.equal(renderer.node, h.videos[0]); assert.equal(h.videos[0]!.loads, 1); assert.equal(h.videos[0]!.plays, 0);
  assert.equal(h.calls.filter(value => value === 'delete-texture').length, 1);
});

test('unavailable requested keying rejects preparation and releases GPU/media without raw fallback', async t => {
  const h = harness(t); h.unavailable();
  const renderer = videoRenderer(clip, node(h.root), { signal: new AbortController().signal, still: true });
  await assert.rejects(renderer.prepare(), { code: 'VIDEO_KEYING_UNAVAILABLE' }); renderer.dispose();
  assert.equal(h.videos[0]!.src, ''); assert.equal(h.root.children.length, 0);
});

test('GPU context loss is terminal and late play cannot revive the retained decoder', async t => {
  const h = harness(t), errors: unknown[] = [];
  const renderer = videoRenderer(clip, node(h.root), { signal: new AbortController().signal, onError: error => errors.push(error) }); t.after(() => renderer.dispose());
  await renderer.prepare(); let resolvePlay!: () => void;
  h.videos[0]!.pendingPlay = () => new Promise<void>(resolve => { resolvePlay = () => { h.videos[0]!.paused = false; resolve(); }; });
  renderer.draw(item(), { phase: 'playing', positionMs: 0, opacity: 1, items: [item()] }); await flush();
  h.lose(); renderer.refreshVisual?.();
  assert.equal((errors[0] as { code: string }).code, 'VIDEO_KEYING_CONTEXT_LOST'); assert.equal(h.videos[0]!.paused, true);
  resolvePlay(); await flush(); assert.equal(h.videos[0]!.paused, true);
  renderer.draw(item(), { phase: 'playing', positionMs: 0, opacity: 1, items: [item()] }); assert.equal(errors.length, 1);
});

test('native context-loss events fail paused normal keying immediately without another draw', async t => {
  const h = harness(t), errors: unknown[] = [];
  const renderer = videoRenderer(clip, node(h.root), { signal: new AbortController().signal, still: true, onError: error => errors.push(error) });
  t.after(() => renderer.dispose()); await renderer.prepare();
  renderer.draw(item(), { phase: 'paused', positionMs: 0, opacity: 1, items: [item()] });
  const event = new Event('webglcontextlost', { cancelable: true });
  h.canvases[0]!.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal((errors[0] as { code: string }).code, 'VIDEO_KEYING_CONTEXT_LOST');
  assert.equal(h.videos[0]!.paused, true); assert.equal(h.frameCallbacks.size, 0);
  renderer.refreshVisual?.(); assert.equal(errors.length, 1);
});

test('key filter disposal is idempotent and releases every GPU resource', t => {
  const h = harness(t), filter = new VideoKeyingFilter(); filter.dispose(); filter.dispose();
  assert.equal(h.calls.filter(value => value === 'delete-shader').length, 2);
  for (const value of ['delete-program', 'delete-texture', 'delete-buffer', 'lose-context']) assert.equal(h.calls.filter(call => call === value).length, 1);
});

test('a keying draw failure keeps audio gain at zero even when the callback retains the renderer', async t => {
  const h = harness(t), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const gain = { gain: { value: 0 }, connect() {}, disconnect() {} };
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
    state = 'running'; destination = {};
    createGain() { return gain; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    async resume() {} async close() {}
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'AudioContext', descriptor); else Reflect.deleteProperty(globalThis, 'AudioContext'); });
  const audible = { ...clip, properties: { ...clip.properties, muted: false } }, errors: unknown[] = [];
  const renderer = videoRenderer(audible, node(h.root), { signal: new AbortController().signal, onError: error => errors.push(error) }); t.after(() => renderer.dispose());
  await renderer.prepare(); const current = item(audible);
  renderer.draw(current, { phase: 'playing', positionMs: 0, opacity: 1, items: [current] }); assert.equal(gain.gain.value, 0.8);
  h.lose(); renderer.draw(current, { phase: 'playing', positionMs: 0, opacity: 1, items: [current] });
  assert.equal(gain.gain.value, 0); assert.equal(h.videos[0]!.paused, true); assert.equal(errors.length, 1);
});

test('twenty sequential keyed videos lease one direct context without copies or preparation uploads', async t => {
  const h = harness(t), clips = Array.from({ length: 20 }, (_, index): VideoClip => ({
    ...clip, id: `key-${index}`, startMs: index * 5000,
    properties: { ...clip.properties, source: { kind: 'foundry-file', path: `worlds/test/key-${index}.webm` } }
  }));
  const renderer = new CompositionRenderer(clips, node(h.root), { width: 1920, height: 1080 }, { signal: new AbortController().signal, still: true });
  t.after(() => renderer.dispose()); await renderer.prepare();
  assert.equal(h.calls.filter(value => value === 'context').length, 1); assert.equal(h.videos.length, 20);
  assert.equal(h.calls.filter(value => value === 'upload').length, 0);
  // Reverse order proves inactive resources are released before any activation.
  for (const selected of [...clips].reverse()) {
    const current = item(selected); renderer.draw({ phase: 'paused', positionMs: selected.startMs, opacity: 1, items: [current] });
    assert.equal(h.calls.filter(value => value === 'context').length, 1);
  }
  assert.equal(h.calls.filter(value => value === 'copy').length, 0);
  assert.equal(h.attributes[0]!.preserveDrawingBuffer, false);
  renderer.dispose(); renderer.dispose();
  assert.equal(h.calls.filter(value => value === 'lose-context').length, 1);
  assert.equal(h.calls.filter(value => value === 'delete-texture').length, 1);
  assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.ok(h.videos.every(video => video.src === '' && video.paused));
});

test('simultaneous keyed videos present independent direct GPU canvases and key uniforms', async t => {
  const h = harness(t), blue: VideoClip = { ...clip, id: 'blue', properties: { ...clip.properties,
    source: { kind: 'foundry-file', path: 'worlds/test/blue.webm' }, keying: { ...clip.properties.keying!, color: '#0000ff' } } };
  const renderer = new CompositionRenderer([clip, blue], node(h.root), { width: 1920, height: 1080 }, { signal: new AbortController().signal, still: true });
  t.after(() => renderer.dispose()); await renderer.prepare();
  const keyed = h.root.children.filter(child => child.className.includes('stagecraft-video-keyed'));
  assert.equal(keyed.length, 2); assert.notEqual(keyed[0], keyed[1]);
  const items = [item(clip), item(blue)]; renderer.draw({ phase: 'paused', positionMs: 0, opacity: 0.5, items });
  assert.deepEqual(keyed[0]!.children[0]!.frame, { source: clip.properties.source.path, key: [0, 1, 0] });
  assert.deepEqual(keyed[1]!.children[0]!.frame, { source: blue.properties.source.path, key: [0, 0, 1] });
  assert.equal(h.calls.filter(value => value === 'context').length, 2);
  assert.equal(h.calls.filter(value => value === 'copy').length, 0);
});

test('twenty overlapping videos bound contexts, retain independent overflow frames and promote when overlap ends', async t => {
  const h = harness(t), clips = Array.from({ length: 20 }, (_, index): VideoClip => ({ ...clip, id: `overlap-${index}`,
    properties: { ...clip.properties, source: { kind: 'foundry-file', path: `worlds/test/overlap-${index}.webm` },
      keying: { ...clip.properties.keying!, color: index % 2 ? '#0000ff' : '#00ff00' } } }));
  const renderer = new CompositionRenderer(clips, node(h.root), { width: 1920, height: 1080 }, { signal: new AbortController().signal, still: true });
  t.after(() => renderer.dispose()); await renderer.prepare();
  const items = clips.map(selected => item(selected)); renderer.draw({ phase: 'paused', positionMs: 0, opacity: 1, items });
  assert.equal(h.calls.filter(value => value === 'context').length, 5);
  assert.deepEqual(h.attributes.map(value => value.preserveDrawingBuffer), [false, false, false, false, true]);
  assert.equal(h.calls.filter(value => value === 'copy').length, 16);
  const layers = h.root.children.filter(child => child.className.includes('stagecraft-video-keyed'));
  for (const [index, layer] of layers.entries()) assert.deepEqual(layer.children[0]!.frame, {
    source: clips[index]!.properties.source.path, key: index % 2 ? [0, 0, 1] : [0, 1, 0]
  });
  // Keep a formerly overflow clip. Its output must become direct and stop copies.
  const selected = items.at(-1)!;
  renderer.draw({ phase: 'paused', positionMs: 0, opacity: 1, items: [selected] });
  assert.equal(h.calls.filter(value => value === 'context').length, 5);
  assert.equal(h.calls.filter(value => value === 'lose-context').length, 3);
  const copies = h.calls.filter(value => value === 'copy').length;
  h.videos.at(-1)!.currentTime = 0.01; renderer.draw({ phase: 'paused', positionMs: 10, opacity: 1, items: [item(clips.at(-1)!, 10)] });
  assert.equal(h.calls.filter(value => value === 'copy').length, copies);
  renderer.draw({ phase: 'paused', positionMs: 10, opacity: 1, items: [] });
  assert.equal(h.calls.filter(value => value === 'lose-context').length, 4);
  renderer.dispose(); assert.equal(h.calls.filter(value => value === 'lose-context').length, 5);
});

test('alternating overflow videos retain their own validated upload signatures across decoded frames', async t => {
  const h = harness(t), clips = Array.from({ length: 6 }, (_, index): VideoClip => ({ ...clip, id: `validation-${index}`,
    properties: { ...clip.properties, source: { kind: 'foundry-file', path: `worlds/test/validation-${index}.webm` } } }));
  const renderer = new CompositionRenderer(clips, node(h.root), { width: 1920, height: 1080 }, { signal: new AbortController().signal, still: true });
  t.after(() => renderer.dispose()); await renderer.prepare();
  const paint = (localTimeMs: number) => {
    for (const video of h.videos) video.currentTime = localTimeMs / 1000;
    renderer.draw({ phase: 'paused', positionMs: localTimeMs, opacity: 1, items: clips.map(selected => item(selected, localTimeMs)) });
  };
  paint(0); assert.equal(h.calls.filter(value => value === 'error-check').length, 6);
  paint(33); paint(66);
  assert.equal(h.calls.filter(value => value === 'key').length, 18);
  assert.equal(h.calls.filter(value => value === 'error-check').length, 6);
  assert.equal(h.calls.filter(value => value === 'context').length, 5);
  const layer = h.root.children.find(child => child.dataset.clipId === clips.at(-1)!.id)!;
  layer.bounds.width = 400; paint(66);
  assert.equal(h.calls.filter(value => value === 'error-check').length, 7);
  // Native dimensions still require validation even at the same output size.
  h.videos.at(-1)!.videoWidth = 960; h.videos.at(-1)!.videoHeight = 540; paint(66);
  assert.equal(h.calls.filter(value => value === 'error-check').length, 8);
  h.videos.at(-1)!.src = 'worlds/test/reloaded-validation.webm'; paint(66);
  assert.equal(h.calls.filter(value => value === 'error-check').length, 9);
});

test('keying output follows fitted physical pixels, source aspect and native resolution', () => {
  const source = { width: 3840, height: 2160 }, surface = { width: 800, height: 600 };
  assert.deepEqual(keyingTargetSize(source, surface, 'contain'), { width: 800, height: 450 });
  assert.deepEqual(keyingTargetSize(source, surface, 'cover'), { width: 1067, height: 600 });
  assert.deepEqual(keyingTargetSize(source, surface, 'contain', 2), { width: 1600, height: 900 });
  assert.deepEqual(keyingTargetSize(source, surface, 'cover', 4), source);
  assert.deepEqual(keyingTargetSize(source, { width: 0, height: 0 }, 'contain'), source);
});

test('direct cached frames repaint on viewport, fit, DPR and seek changes without copying or per-frame error polling', async t => {
  const h = harness(t), renderer = videoRenderer(clip, node(h.root), { signal: new AbortController().signal, still: true });
  t.after(() => renderer.dispose()); await renderer.prepare();
  const current = item(); renderer.draw(current, { phase: 'paused', positionMs: 0, opacity: 1, items: [current] });
  const canvas = h.canvases[0]!;
  assert.deepEqual([canvas.width, canvas.height], [800, 450]);
  const keyed = h.calls.filter(value => value === 'key').length;
  renderer.refreshVisual?.(); assert.equal(h.calls.filter(value => value === 'key').length, keyed);
  (renderer.node as unknown as Node).bounds.width = 400; renderer.refreshVisual?.();
  assert.deepEqual([canvas.width, canvas.height], [400, 225]);
  const covered: VideoClip = { ...clip, properties: { ...clip.properties, fit: 'cover' } };
  renderer.draw(item(covered), { phase: 'paused', positionMs: 0, opacity: 1, items: [item(covered)] });
  assert.equal(canvas.style.objectFit, 'cover'); assert.deepEqual([canvas.width, canvas.height], [1067, 600]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 2 });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'devicePixelRatio', descriptor); else Reflect.deleteProperty(globalThis, 'devicePixelRatio'); });
  renderer.refreshVisual?.(); assert.deepEqual([canvas.width, canvas.height], [1920, 1080]);
  h.videos[0]!.dispatchEvent(new Event('seeked')); renderer.refreshVisual?.();
  assert.equal(h.calls.filter(value => value === 'error-check').length, 4);
  assert.equal(h.calls.filter(value => value === 'copy').length, 0);
  assert.equal(h.videos[0]!.loads, 1); assert.equal(h.videos[0]!.plays, 0);
});

test('changed output allocations validate GPU errors and fail without exposing the raw video', async t => {
  const h = harness(t), errors: unknown[] = [];
  const renderer = videoRenderer(clip, node(h.root), { signal: new AbortController().signal, still: true, onError: error => errors.push(error) });
  t.after(() => renderer.dispose()); await renderer.prepare();
  renderer.draw(item(), { phase: 'paused', positionMs: 0, opacity: 1, items: [item()] });
  h.allocationError(); (renderer.node as unknown as Node).bounds.width = 400;
  renderer.refreshVisual?.();
  assert.equal((errors[0] as { code: string }).code, 'VIDEO_KEYING_UNAVAILABLE');
  assert.equal(h.videos[0]!.style.opacity, '0'); assert.equal(h.videos[0]!.paused, true);
});

test('disabling the last keyed still clip releases its shared context without replacing the decoder', async t => {
  const h = harness(t), disabled: VideoClip = { ...clip, properties: { ...clip.properties, keying: { ...clip.properties.keying!, enabled: false } } };
  const renderer = new CompositionRenderer([clip], node(h.root), { width: 1920, height: 1080 }, { signal: new AbortController().signal, still: true });
  t.after(() => renderer.dispose()); await renderer.prepare(); assert.equal(h.calls.filter(value => value === 'context').length, 1);
  await renderer.updateStill([disabled]); assert.equal(h.calls.filter(value => value === 'lose-context').length, 1);
  assert.equal(h.videos.length, 1); assert.equal(h.videos[0]!.loads, 1);
  await renderer.updateStill([clip]); assert.equal(h.calls.filter(value => value === 'context').length, 2);
  assert.equal(h.videos.length, 1); assert.equal(h.videos[0]!.loads, 1); assert.equal(h.videos[0]!.plays, 0);
  renderer.dispose(); assert.equal(h.calls.filter(value => value === 'lose-context').length, 2);
});

test('paused keyed blend refreshes the board without repeated GPU/filter copies and redraws changed decoder/settings', async t => {
  const h = harness(t); let snapshots = 0;
  const blended: VideoClip = { ...clip, appearance: { blendMode: 'screen', opacity: 1 } };
  const renderer = new CompositionRenderer([blended], node(h.root), { width: 1920, height: 1080 }, {
    signal: new AbortController().signal, still: true,
    boardBackdrop(rect) { snapshots += 1; return { source: {} as CanvasImageSource, rect }; }
  }); t.after(() => renderer.dispose()); await renderer.prepare();
  const current = item(blended); renderer.draw({ phase: 'paused', positionMs: 0, opacity: 1, items: [current] });
  const keyed = h.calls.filter(call => call === 'key').length, copies = h.calls.filter(call => call === 'copy').length;
  const canvasCount = h.canvases.length;
  assert.ok(h.calls.includes('mask-fill-evenodd'), 'the borrowed board is clipped by the reusable polygon mask');
  const pump = () => { const [id, callback] = h.frameCallbacks.entries().next().value!; h.frameCallbacks.delete(id); callback(0); };
  for (let index = 0; index < 6; index += 1) pump();
  assert.ok(snapshots >= 8); assert.equal(h.calls.filter(call => call === 'key').length, keyed); assert.equal(h.calls.filter(call => call === 'copy').length, copies);
  assert.equal(h.canvases.length, canvasCount, 'paused refreshes reuse the board and mask surfaces');
  assert.equal(h.videos[0]!.currentTime, 0); assert.equal(h.videos[0]!.plays, 0);
  // A completed seek may replace pixels without changing the source timestamp.
  h.videos[0]!.dispatchEvent(new Event('seeked'));
  assert.equal(h.calls.filter(call => call === 'key').length, keyed + 1); pump();
  assert.equal(h.calls.filter(call => call === 'key').length, keyed + 1);
  const changed: VideoClip = { ...blended, properties: { ...blended.properties, keying: { ...blended.properties.keying!, color: '#0000ff' } } };
  await renderer.updateStill([changed]); const changedItem = item(changed);
  renderer.draw({ phase: 'paused', positionMs: 0, opacity: 1, items: [changedItem] }); pump();
  assert.equal(h.calls.filter(call => call === 'key').length, keyed + 2);
  // Normal player/backdrop refreshes of one decoder frame share the cached output.
  h.videos[0]!.currentTime = 0.25; renderer.draw({ phase: 'paused', positionMs: 250, opacity: 1, items: [item(changed, 250)] }); await flush(); pump();
  assert.equal(h.calls.filter(call => call === 'key').length, keyed + 3);
  assert.equal(h.videos[0]!.loads, 1); assert.equal(h.videos[0]!.plays, 0);
  renderer.dispose();
});

test('advancing source time refreshes keying despite batched quality counters while unchanged paused time stays cached', async t => {
  const h = harness(t), renderer = videoRenderer(clip, node(h.root), { signal: new AbortController().signal });
  t.after(() => renderer.dispose()); let frames = 1;
  Object.assign(h.videos[0]!, { getVideoPlaybackQuality: () => ({ totalVideoFrames: frames, droppedVideoFrames: 0 }) });
  await renderer.prepare(); const current = item(); renderer.draw(current, { phase: 'playing', positionMs: 0, opacity: 1, items: [current] });
  assert.equal(h.videos[0]!.paused, false);
  const keyed = h.calls.filter(call => call === 'key').length;
  h.videos[0]!.currentTime = 0.01; renderer.refreshVisual?.(); h.videos[0]!.currentTime = 0.02; renderer.refreshVisual?.();
  assert.equal(h.calls.filter(call => call === 'key').length, keyed + 2);
  const paused = item(clip, 20); renderer.draw(paused, { phase: 'paused', positionMs: 20, opacity: 1, items: [paused] });
  assert.equal(h.videos[0]!.paused, true); renderer.refreshVisual?.();
  assert.equal(h.calls.filter(call => call === 'key').length, keyed + 2);
  frames += 1; renderer.refreshVisual?.(); assert.equal(h.calls.filter(call => call === 'key').length, keyed + 2);
  h.videos[0]!.src = 'worlds/test/reloaded.webm'; renderer.refreshVisual?.();
  assert.equal(h.calls.filter(call => call === 'key').length, keyed + 3);
  assert.equal(h.calls.filter(call => call === 'copy').length, 0);
});

test('paused composition refreshes only board pixels and stops visual work when no blended video remains', async t => {
  const h = harness(t), controller = new AbortController(); let supplied = 0;
  const blended: VideoClip = { ...clip, appearance: { blendMode: 'multiply', opacity: 0.5 }, properties: { ...clip.properties, keying: { ...clip.properties.keying!, enabled: false } } };
  const renderer = new CompositionRenderer([blended], node(h.root), { width: 1920, height: 1080 }, {
    signal: controller.signal, still: true, boardBackdrop(rect, signal) { supplied += 1; assert.equal(signal, controller.signal); return { source: {} as CanvasImageSource, rect }; }
  }); t.after(() => renderer.dispose());
  await renderer.prepare(); const current = item(blended, 1250);
  renderer.draw({ phase: 'paused', positionMs: 1250, opacity: 0.3, items: [current] }); await flush();
  const time = h.videos[0]!.currentTime, plays = h.videos[0]!.plays;
  assert.equal(h.root.style.opacity, '0.3'); assert.equal(h.videos[0]!.style.opacity, '0.4');
  for (let index = 0; index < 3; index += 1) {
    const [id, callback] = h.frameCallbacks.entries().next().value!; h.frameCallbacks.delete(id); callback(0);
  }
  assert.ok(supplied >= 5); assert.equal(h.videos[0]!.currentTime, time); assert.equal(h.videos[0]!.plays, plays);
  renderer.draw({ phase: 'paused', positionMs: 1250, opacity: 1, items: [] }); assert.equal(h.frameCallbacks.size, 0);
  assert.equal(h.canvases[0]!.style.display, 'none'); renderer.dispose(); assert.equal(h.root.children.length, 0);
});

test('missing board source waits with a bounded grace then fails and disposes every retained resource', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const h = harness(t), errors: unknown[] = [];
  const blended = { ...clip, appearance: { blendMode: 'screen' as const, opacity: 1 }, properties: { ...clip.properties, keying: { ...clip.properties.keying!, enabled: false } } };
  const renderer = new CompositionRenderer([blended], node(h.root), { width: 1920, height: 1080 }, {
    signal: new AbortController().signal, still: true, boardBackdrop: () => null, onError: error => errors.push(error)
  }); t.after(() => renderer.dispose()); await renderer.prepare();
  const current = item(blended); renderer.draw({ phase: 'paused', positionMs: 0, opacity: 1, items: [current] });
  assert.equal(h.root.style.opacity, '0'); assert.equal(errors.length, 0);
  now = 2100;
  const [id, callback] = h.frameCallbacks.entries().next().value!; h.frameCallbacks.delete(id); callback(0);
  assert.equal((errors[0] as { code: string }).code, 'VIDEO_BACKDROP_UNAVAILABLE');
  assert.equal(h.frameCallbacks.size, 0); assert.equal(h.videos[0]!.src, ''); assert.equal(h.root.children.length, 0);
});


test('boxed keyed video updates one decoder, one keyed canvas and correct contained backdrop footprint', async t => {
  const h = harness(t);
  const renderer = new CompositionRenderer([clip], node(h.root), { width: 1920, height: 1080 }, { signal: new AbortController().signal, still: true });
  t.after(() => renderer.dispose()); await renderer.prepare();
  renderer.draw({ phase: 'paused', positionMs: 0, opacity: 1, items: [item()] });
  const presentation = h.root.children.find(value => value !== h.videos[0])!;
  const canvases = h.canvases.length;
  for (let step = 0; step < 5; step++) {
    const changed: VideoClip = { ...clip, typeVersion: 6, properties: { ...clip.properties, box: { x: 240 + step, y: 120, width: 960, height: 540 } } };
    await renderer.updateStill([changed]); renderer.draw({ phase: 'paused', positionMs: 0, opacity: 1, items: [item(changed)] });
    assert.equal(h.videos.length, 1); assert.equal(h.videos[0]!.loads, 1); assert.equal(h.videos[0]!.plays, 0);
    assert.equal(h.canvases.length, canvases); assert.equal(h.root.children.find(value => value !== h.videos[0]), presentation);
    assert.equal(presentation.style.width, '400px'); assert.equal(presentation.style.height, '225px');
    assert.equal(presentation.style.top, '125px'); assert.equal(h.videos[0]!.style.top, '125px');
  }
  const plain: VideoClip = { ...clip, typeVersion: 6, properties: { ...clip.properties, box: { x: 240, y: 120, width: 960, height: 540 }, keying: { ...clip.properties.keying!, enabled: false } } };
  await renderer.updateStill([plain]); assert.equal(h.videos[0]!.style.left, '100px'); assert.equal(h.videos[0]!.style.width, '400px');
  // The footprint uses physical bounds supplied by the board capture, including app scale.
  const direct = videoRenderer(plain, node(h.root), { signal: new AbortController().signal, still: true }); t.after(() => direct.dispose());
  const footprints = direct.backdropFootprints!(item(plain), { width: 1600, height: 1200 });
  assert.deepEqual(footprints, [{ points: [{ x: 200, y: 250 }, { x: 1000, y: 250 }, { x: 1000, y: 700 }, { x: 200, y: 700 }] }]);
});
