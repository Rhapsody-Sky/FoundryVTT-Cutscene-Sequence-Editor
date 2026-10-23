import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { VideoClip } from '../src/domain/sequence.js';
import type { FrameItem } from '../src/playback/evaluate.js';
import { videoRenderer } from '../src/rendering/video-renderer.js';
import { videoBoxRect } from '../src/rendering/video-geometry.js';
import { videoContentRect } from '../src/rendering/video-blend-backdrop.js';

const composition = { width: 1920, height: 1080 };
const clip: VideoClip = { id: 'movie', trackId: 'track', type: 'video', typeVersion: 7, startMs: 0,
  duration: { kind: 'media' }, entrance: { preset: 'zoom', version: 1, easing: 'linear', durationMs: 1000, scale: 0.4 },
  exit: { preset: 'none', version: 1 }, properties: { source: { kind: 'foundry-file', path: 'movie.webm' },
    durationMs: 5000, fit: 'contain', volume: 1, muted: true, box: { x: 100, y: 200, width: 1000, height: 400 } } };
class Node extends EventTarget {
  style: Record<string, string> = {}; dataset: Record<string, string> = {}; className = '';
  children: Node[] = []; parent: Node | null = null;
  bounds = { left: 20, top: 30, width: 960, height: 800 };
  private outputWidth = 0; private outputHeight = 0; allocations = 0;
  get width() { return this.outputWidth; } set width(value: number) { this.outputWidth = value; this.allocations += 1; }
  get height() { return this.outputHeight; } set height(value: number) { this.outputHeight = value; this.allocations += 1; }
  get clientWidth() { return this.bounds.width; } get clientHeight() { return this.bounds.height; }
  getBoundingClientRect() { return this.bounds; }
  append(node: Node) { node.remove(); node.parent = this; this.children.push(node); }
  insertBefore(node: Node, ref: Node) { node.remove(); node.parent = this; this.children.splice(this.children.indexOf(ref), 0, node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(other => other !== this); this.parent = null; }
}
class Video extends Node {
  src = ''; muted = true; volume = 1; currentTime = 0; playbackRate = 1; preload = ''; controls = false;
  playsInline = true; disablePictureInPicture = true; paused = true; seeking = false; ended = false;
  duration = 5; readyState = 4; videoWidth = 1920; videoHeight = 1080; error = null; loads = 0;
  buffered = { length: 1, start: () => 0, end: () => 5 };
  async play() { this.paused = false; } pause() { this.paused = true; } load() { this.loads += 1; }
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
function harness(t: TestContext) {
  let uploads = 0, copies = 0;
  const videos: Video[] = [], canvases: Node[] = [];
  const gpu = { VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3, COMPILE_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7,
    TEXTURE0: 8, TEXTURE_2D: 9, TEXTURE_MIN_FILTER: 10, TEXTURE_MAG_FILTER: 11, LINEAR: 12, TEXTURE_WRAP_S: 13,
    TEXTURE_WRAP_T: 14, CLAMP_TO_EDGE: 15, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 16, BLEND: 17, RGBA: 18, UNSIGNED_BYTE: 19, TRIANGLE_STRIP: 20, NO_ERROR: 0,
    createProgram: () => ({}), createTexture: () => ({}), createBuffer: () => ({}), createShader: () => ({}),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {}, getProgramParameter: () => true, getShaderParameter: () => true,
    useProgram() {}, bindBuffer() {}, bufferData() {}, getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
    activeTexture() {}, bindTexture() {}, texParameteri() {}, pixelStorei() {}, getUniformLocation: () => ({}), uniform1i() {},
    disable() {}, viewport() {}, uniform3f() {}, uniform1f() {}, texImage2D() { uploads += 1; }, drawArrays() {},
    getError: () => 0, isContextLost: () => false, deleteProgram() {}, deleteTexture() {}, deleteBuffer() {}, deleteShader() {},
    getExtension: () => ({ loseContext() {} }) };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(tag: string) {
    if (tag === 'video') { const video = new Video(); videos.push(video); return video; }
    const node = new Node();
    if (tag === 'canvas') { canvases.push(node); Object.assign(node, { getContext(type: string) { return type === 'webgl' ? gpu : { drawImage() { copies += 1; } }; } }); }
    return node;
  } } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else Reflect.deleteProperty(globalThis, 'document'); });
  return { root: new Node(), videos, canvases, uploads: () => uploads, copies: () => copies };
}
function draw(renderer: ReturnType<typeof videoRenderer>, item: FrameItem) {
  renderer.draw(item, { phase: 'paused', positionMs: item.localTimeMs, opacity: 1, items: [item] });
}

test('raw video CSS motion and blend footprint project the same centered box at every viewport', async t => {
  const h = harness(t), renderer = videoRenderer(clip, h.root as unknown as HTMLElement, { signal: new AbortController().signal, still: true }, composition);
  t.after(() => renderer.dispose()); await renderer.prepare();
  for (const viewport of [{ width: 960, height: 800 }, { width: 540, height: 960 }, { width: 1920, height: 1080 }]) {
    Object.assign(h.root.bounds, viewport);
    for (const fit of ['contain', 'cover'] as const) for (const scale of [0.4, 1, 1.2]) {
      const current = { ...clip, properties: { ...clip.properties, fit } }, motion = { x: -200, y: 100, scale };
      const item = { clip: current, localTimeMs: 0, opacity: 0.5, textTransform: motion };
      draw(renderer, item);
      const base = videoBoxRect(current, viewport, composition), projected = videoBoxRect(current, viewport, composition, motion);
      const factor = Math.min(viewport.width / composition.width, viewport.height / composition.height);
      assert.equal(renderer.node.style.left, `${base.x}px`); assert.equal(renderer.node.style.width, `${base.width}px`);
      assert.equal(renderer.node.style.transform, `translate(${-200 * factor}px, ${100 * factor}px) scale(${scale})`);
      const content = videoContentRect(projected.width, projected.height, 1920, 1080, fit);
      const x = projected.x + content.x, y = projected.y + content.y;
      assert.deepEqual(renderer.backdropFootprints!(item, viewport)[0]!.points,
        [{ x, y }, { x: x + content.width, y }, { x: x + content.width, y: y + content.height }, { x, y: y + content.height }]);
    }
  }
  assert.equal(h.videos.length, 1); assert.equal(h.canvases.length, 0); assert.equal(h.videos[0]!.loads, 1);
});

test('keyed zoom reuses the GPU output and paused frame without copies or size churn', async t => {
  const h = harness(t), keyed: VideoClip = { ...clip, properties: { ...clip.properties, keying: { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.1 } } };
  const renderer = videoRenderer(keyed, h.root as unknown as HTMLElement, { signal: new AbortController().signal, still: true }, composition);
  t.after(() => renderer.dispose()); await renderer.prepare();
  const sizes: number[] = [];
  for (const scale of [0.4, 0.5, 0.8, 1, 1.1, 1.2]) {
    const current = { clip: keyed, localTimeMs: 0, opacity: 1, textTransform: { x: 100, y: 50, scale } };
    draw(renderer, current);
    assert.equal(renderer.node.style.transform, h.videos[0]!.style.transform);
    assert.equal(renderer.node.style.left, h.videos[0]!.style.left);
    const rect = videoBoxRect(keyed, h.root.bounds, composition, current.textTransform);
    const content = videoContentRect(rect.width, rect.height, 1920, 1080, 'contain');
    const footprint = renderer.backdropFootprints!(current, h.root.bounds)[0]!.points;
    assert.equal(footprint[0]!.x, rect.x + content.x); assert.equal(footprint[0]!.y, rect.y + content.y);
    sizes.push(h.canvases[0]!.allocations);
  }
  assert.equal(h.videos.length, 1); assert.equal(h.canvases.length, 1); assert.equal(h.uploads(), 1); assert.equal(h.copies(), 0);
  assert.ok(sizes.every(value => value === sizes[0]));
  h.videos[0]!.currentTime = 0.01;
  draw(renderer, { clip: keyed, localTimeMs: 10, opacity: 1, textTransform: { x: 100, y: 50, scale: 0.6 } });
  assert.equal(h.uploads(), 2); assert.equal(h.canvases[0]!.allocations, sizes[0]);
});

test('keying target retains ancestor CSS scale and changes only on surface resize', async t => {
  const h = harness(t), keyed: VideoClip = { ...clip, properties: { ...clip.properties, keying: { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.1 } } };
  Object.defineProperty(h.root, 'clientWidth', { value: 1920 }); Object.defineProperty(h.root, 'clientHeight', { value: 1600 });
  const renderer = videoRenderer(keyed, h.root as unknown as HTMLElement, { signal: new AbortController().signal, still: true }, composition);
  t.after(() => renderer.dispose()); await renderer.prepare();
  draw(renderer, { clip: keyed, localTimeMs: 0, opacity: 1, textTransform: { x: 0, y: 0, scale: 0.4 } });
  assert.equal(h.canvases[0]!.width, 356); assert.equal(h.canvases[0]!.height, 200);
  h.root.bounds.width = 1920; h.root.bounds.height = 1600;
  draw(renderer, { clip: keyed, localTimeMs: 0, opacity: 1, textTransform: { x: 0, y: 0, scale: 0.5 } });
  assert.equal(h.canvases[0]!.width, 712); assert.equal(h.canvases[0]!.height, 400);
  assert.equal(h.uploads(), 2);
});

test('unboxed legacy and identity video keep actual-surface fit styles', async t => {
  const h = harness(t);
  const { box: _box, ...properties } = clip.properties;
  for (const typeVersion of [1, 6, 7] as const) {
    const current: VideoClip = { ...clip, typeVersion, entrance: { preset: 'none', version: 1 }, properties };
    const renderer = videoRenderer(current, h.root as unknown as HTMLElement, { signal: new AbortController().signal, still: true }, composition);
    await renderer.prepare(); draw(renderer, { clip: current, localTimeMs: 0, opacity: 1 });
    assert.equal(renderer.node.style.width, '100%'); assert.equal(renderer.node.style.height, '100%');
    assert.equal(renderer.node.style.left, '0'); assert.equal(renderer.node.style.top, '0'); assert.equal(renderer.node.style.transform, '');
    renderer.dispose();
  }
  assert.equal(h.canvases.length, 0);
});
