import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { DraftService } from '../src/application/draft-service.js';
import type { SequenceRepository } from '../src/application/ports.js';
import { CLIP_BLEND_MODES, type SequenceV1, type TextClip, type VideoClip } from '../src/domain/sequence.js';
import { createBarsSequence, duplicateSequence, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { CompositionRenderer } from '../src/rendering/composition-renderer.js';
import { textRenderer } from '../src/rendering/text-renderer.js';

function ids() { let next = 0; return () => `style_${++next}`; }
function sequence(): SequenceV1 {
  const base = createBarsSequence('Style', ids());
  const title: TextClip = {
    ...base.clips[0]!, type: 'text', typeVersion: 1, duration: { kind: 'sequence-end' },
    appearance: { blendMode: 'screen', opacity: 0.6 },
    properties: {
      text: 'A title', fontFamily: 'serif', fontSize: 96, minimumFontSize: 24, color: '#ffffff', align: 'center',
      box: { x: 100, y: 200, width: 1400, height: 400 }, shrinkToFit: false,
      outline: { enabled: true, color: '#ff8800', opacity: 0.4, width: 8 },
      shadow: { enabled: true, color: '#123456', opacity: 0.3, offsetX: -12, offsetY: 15, blur: 24 },
      glow: { enabled: true, color: '#abcdef', opacity: 0.2, radius: 36 }
    }
  };
  return { ...base, clips: [title] };
}

test('legacy sequences retain absent styles; every agreed blend mode validates without normalizing stored data', () => {
  const legacy = createBarsSequence('Legacy', ids());
  assert.deepEqual(validateSequence(legacy), legacy);
  assert.equal(Object.hasOwn(validateSequence(legacy).clips[0]!, 'appearance'), false);
  for (const blendMode of CLIP_BLEND_MODES) {
    const base = sequence();
    const value = { ...base, clips: [{ ...base.clips[0]!, appearance: { blendMode, opacity: 0 } }] };
    assert.deepEqual(validateSequence(value), value);
  }
});

test('invalid and future blend modes fail at their exact compatibility path and leave input intact', () => {
  for (const appearance of [null, {}, { blendMode: 'normal' }, { opacity: 1 },
    { blendMode: 'subtract', opacity: 1 }, { blendMode: 'NORMAL', opacity: 1 },
    { blendMode: 'normal', opacity: -0.1 }, { blendMode: 'normal', opacity: 1.1 },
    { blendMode: 'normal', opacity: '0.5' }]) {
    const base = sequence();
    const value = { ...base, clips: [{ ...base.clips[0]!, appearance }] };
    const before = structuredClone(value);
    assert.throws(() => validateSequence(value), (error: unknown) => {
      assert.ok(error instanceof SequenceValidationError);
      assert.match(error.path!, /^sequence\.clips\[0\]\.appearance/);
      return true;
    });
    assert.deepEqual(value, before);
  }
});

test('effect validation requires complete typed objects, strict colors, and bounded logical units even when disabled', () => {
  const base = sequence();
  const title = base.clips[0] as TextClip;
  for (const kind of ['outline', 'shadow', 'glow'] as const) {
    for (const bad of [null, {}, { ...title.properties[kind], enabled: 'true' },
      { ...title.properties[kind], color: 'red' }, { ...title.properties[kind], color: '#fff' },
      { ...title.properties[kind], opacity: -0.1 }, { ...title.properties[kind], opacity: 1.1 },
      { ...title.properties[kind], enabled: false, color: '#ffffff;display:none' }]) {
      assert.throws(() => validateSequence({ ...base, clips: [{ ...title, properties: { ...title.properties, [kind]: bad } }] }));
    }
  }
  for (const [kind, field, bad] of [
    ['outline', 'width', -1], ['outline', 'width', 32.1],
    ['shadow', 'offsetX', -256.1], ['shadow', 'offsetY', 256.1],
    ['shadow', 'blur', -1], ['shadow', 'blur', 128.1],
    ['glow', 'radius', -1], ['glow', 'radius', 128.1]
  ] as const) {
    assert.throws(() => validateSequence({ ...base, clips: [{ ...title, properties: { ...title.properties,
      [kind]: { ...title.properties[kind], [field]: bad } } }] }), (error: unknown) => {
      assert.ok(error instanceof SequenceValidationError);
      assert.equal(error.path, `sequence.clips[0].properties.${kind}.${field}`);
      return true;
    });
  }
  const boundaries = { ...title, properties: { ...title.properties,
    outline: { enabled: false, color: '#AaBbCc', opacity: 0, width: 32 },
    shadow: { enabled: false, color: '#000000', opacity: 1, offsetX: -256, offsetY: 256, blur: 128 },
    glow: { enabled: true, color: '#ffffff', opacity: 0, radius: 128 }
  } };
  assert.doesNotThrow(() => validateSequence({ ...base, clips: [boundaries] }));
});

test('draft save/load and duplication preserve all styles, independent alpha, and extension fields without mutating the source', async () => {
  let stored = validateSequence(sequence());
  const repo: SequenceRepository = {
    async list() { return []; }, async read() { return stored; },
    async delete() {},
    async save(value) { stored = validateSequence({ ...value, revision: value.revision + 1 }); return stored; }
  };
  const draft = new DraftService(repo, ids());
  await draft.load(stored.id);
  const title = stored.clips[0] as TextClip;
  const changed = { ...stored, clips: [{ ...title, appearance: { ...title.appearance!, opacity: 0.45 },
    properties: { ...title.properties, extension: { author: 'keep' } } }] };
  draft.replace(changed);
  const saved = await draft.save();
  await draft.load(saved.id);
  assert.deepEqual(draft.draft, saved);
  const before = structuredClone(saved);
  const copy = duplicateSequence(saved, 'Copy', ids());
  assert.deepEqual(copy.clips[0]!.appearance, saved.clips[0]!.appearance);
  assert.deepEqual(copy.clips[0]!.properties, saved.clips[0]!.properties);
  assert.notEqual(copy.clips[0]!.properties, saved.clips[0]!.properties);
  assert.deepEqual(saved, before);
});

class FakeNode extends EventTarget {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = ''; textContent = ''; children: FakeNode[] = []; parent: FakeNode | null = null;
  isConnected = true; clientWidth = 1400; clientHeight = 400; scrollWidth = 1400; scrollHeight = 400;
  append(node: FakeNode) { node.remove(); this.children.push(node); node.parent = this; }
  prepend(node: FakeNode) { node.remove(); this.children.unshift(node); node.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 540 }; }
}
class FakeCanvas extends FakeNode {
  width = 960; height = 540;
  getContext() { return { setTransform() {}, clearRect() {}, save() {}, restore() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
    moveTo() {}, lineTo() {}, closePath() {}, fill(_rule?: CanvasFillRule) {}, drawImage() {} }; }
}
class FakeVideo extends FakeNode {
  videoWidth = 960; videoHeight = 540;
  src = ''; muted = true; volume = 1; currentTime = 0; playbackRate = 1; preload = '';
  controls = false; playsInline = true; disablePictureInPicture = true;
  paused = true; seeking = false; ended = false; duration = 5; readyState = 4; error = null;
  loads = 0; plays = 0; buffered = { length: 1, start: () => 0, end: () => 5 };
  load() { this.loads += 1; } pause() { this.paused = true; }
  play() { this.plays += 1; this.paused = false; return Promise.resolve(); }
  getAttribute(name: string) { return name === 'src' ? this.src : null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
function dom(t: TestContext) {
  const videos: FakeVideo[] = []; let fontLoads = 0;
  const doc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const observer = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const raf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const cancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag: string) { if (tag === 'video') { const video = new FakeVideo(); videos.push(video); return video; } return tag === 'canvas' ? new FakeCanvas() : new FakeNode(); },
    fonts: { async load() { fontLoads++; }, check: () => true }
  } });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  t.after(() => {
    if (doc) Object.defineProperty(globalThis, 'document', doc); else Reflect.deleteProperty(globalThis, 'document');
    if (observer) Object.defineProperty(globalThis, 'ResizeObserver', observer); else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    if (raf) Object.defineProperty(globalThis, 'requestAnimationFrame', raf); else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (cancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', cancel); else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  const root = new FakeNode(); root.clientWidth = 960; root.clientHeight = 540;
  return { root, videos, get fontLoads() { return fontLoads; } };
}
const node = (value: FakeNode) => value as unknown as HTMLElement;

test('combined text effects keep independent alpha, preserve fill, scale together, and composite opacity exactly once', async t => {
  const { root } = dom(t);
  const title = sequence().clips[0] as TextClip;
  const renderer = new CompositionRenderer([title], node(root), { width: 1920, height: 1080 }, { signal: new AbortController().signal });
  await renderer.prepare();
  const item = { clip: title, opacity: 0.5, localTimeMs: 400 };
  renderer.draw({ phase: 'exiting', positionMs: 400, opacity: 0.25, items: [item] });
  const layer = root.children[0]!; const stage = layer.children[0]!; const text = stage.children[0]!;
  assert.equal(root.style.isolation, 'isolate');
  assert.equal(root.style.opacity, '0.25');
  assert.equal(layer.style.opacity, '0.3');
  assert.equal(layer.style.mixBlendMode, 'screen');
  assert.equal(stage.style.opacity, undefined); assert.equal(text.style.opacity, undefined);
  assert.equal(text.style.color, '#ffffff'); assert.equal(text.style.paintOrder, 'stroke fill');
  assert.equal(text.style.webkitTextStroke, '8px rgba(255, 136, 0, 0.4)');
  assert.equal(text.style.textShadow, '-12px 15px 24px rgba(18, 52, 86, 0.3), 0px 0px 36px rgba(171, 205, 239, 0.2)');
  assert.equal(stage.style.transform, 'scale(0.5)');
  for (const part of [layer, stage, text]) assert.equal(part.style.overflow, 'visible');
  renderer.draw({ phase: 'paused', positionMs: 0, opacity: 1, items: [] });
  assert.equal(layer.style.opacity, '0');
  renderer.dispose();
});

test('disabled or absent title effects emit no visible effect; default clip appearance stays normal/full', t => {
  const { root } = dom(t);
  const title = sequence().clips[0] as TextClip;
  for (const properties of [
    { ...title.properties, outline: { ...title.properties.outline!, enabled: false }, shadow: { ...title.properties.shadow!, enabled: false }, glow: { ...title.properties.glow!, enabled: false } },
    { text: title.properties.text, fontFamily: 'serif', fontSize: 96, minimumFontSize: 24, color: '#ffffff', align: 'center' as const, box: title.properties.box, shrinkToFit: false }
  ]) {
    const { appearance: _appearance, ...base } = title;
    const legacy = { ...base, properties };
    const renderer = textRenderer(legacy, node(root), { width: 1920, height: 1080 }, { signal: new AbortController().signal });
    const item = { clip: legacy, opacity: 0.75, localTimeMs: 500 };
    renderer.draw(item, { phase: 'paused', positionMs: 500, opacity: 1, items: [item] });
    const layer = root.children[0]!; const text = layer.children[0]!.children[0]!;
    assert.equal(layer.style.opacity, '0.75'); assert.equal(layer.style.mixBlendMode, 'normal');
    assert.equal(text.style.webkitTextStroke, undefined); assert.equal(text.style.textShadow, undefined);
    assert.equal(text.style.paintOrder, undefined); renderer.dispose();
  }
});

test('unchanged still titles and bars retain prepared nodes across repeated scrubs', async t => {
  const { root } = dom(t);
  const title = sequence().clips[0] as TextClip;
  const bars = { ...createBarsSequence('Bars', ids()).clips[0]!, id: 'retained-bars' };
  const renderer = new CompositionRenderer([title, bars], node(root), { width: 1920, height: 1080 },
    { signal: new AbortController().signal, still: true });
  await renderer.prepare();
  const nodes = [...root.children];
  for (let index = 0; index < 20; index++) {
    await renderer.updateStill(structuredClone([title, bars]));
    assert.equal(root.children[0], nodes[0]); assert.equal(root.children[1], nodes[1]);
  }
  await renderer.updateStill([{ ...title, properties: { ...title.properties, text: 'Changed' } }, bars]);
  assert.notEqual(root.children[0], nodes[0]); assert.equal(root.children[1], nodes[1]);
  renderer.dispose();
});

test('bars and reused still video apply updated blend and static opacity without rebuilding or starting media', async t => {
  const { root, videos } = dom(t);
  const bars = createBarsSequence('Bars', ids()).clips[0]!;
  const video: VideoClip = {
    ...bars, id: 'video', type: 'video', duration: { kind: 'media' },
    appearance: { blendMode: 'multiply', opacity: 0.8 },
    properties: { source: { kind: 'foundry-file', path: 'worlds/test/movie.webm' }, fit: 'contain', volume: 1, muted: false, durationMs: 5000 }
  };
  const styledBars = { ...bars, appearance: { blendMode: 'difference' as const, opacity: 0.5 } };
  const renderer = new CompositionRenderer([video, styledBars], node(root), { width: 1920, height: 1080 },
    { signal: new AbortController().signal, still: true,
      boardBackdrop: rect => ({ source: new FakeCanvas() as unknown as HTMLCanvasElement, rect }) });
  await renderer.prepare();
  const updated = { ...video, appearance: { blendMode: 'plus-lighter' as const, opacity: 0.2 }, properties: { ...video.properties, fit: 'cover' as const } };
  await renderer.updateStill([updated, styledBars]);
  assert.equal(videos.length, 1); assert.equal(videos[0]!.loads, 1); assert.equal(videos[0]!.plays, 0);
  assert.equal(videos[0]!.style.mixBlendMode, 'plus-lighter'); assert.equal(videos[0]!.style.objectFit, 'cover');
  const items = [{ clip: updated, opacity: 0.5, localTimeMs: 0 }, { clip: styledBars, opacity: 0.5, localTimeMs: 0 }];
  renderer.draw({ phase: 'paused', positionMs: 0, opacity: 0.4, items });
  assert.equal(videos[0]!.style.opacity, '0.1');
  const barLayer = root.children.find(child => child.style.mixBlendMode === 'difference')!;
  assert.equal(barLayer.style.opacity, '0.25'); assert.equal(barLayer.style.mixBlendMode, 'difference');
  assert.equal(root.style.opacity, '0.4');
  assert.deepEqual(barLayer.children.map(bar => bar.style.opacity), [undefined, undefined]);
  renderer.dispose();
});


test('still title geometry retains one node and prepared font while whole visual resizes in local CSS pixels', async t => {
  const h = dom(t), original = sequence().clips[0] as TextClip;
  const renderer = new CompositionRenderer([original], node(h.root), { width: 1920, height: 1080 }, { signal: new AbortController().signal, still: true });
  t.after(() => renderer.dispose()); await renderer.prepare();
  const layer = h.root.children[0]!, stage = layer.children[0]!, text = stage.children[0]!;
  // Foundry physically doubles the app; CSS layout stays at 960 by 540.
  h.root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1920, height: 1080 });
  for (let step = 1; step <= 5; step++) {
    const changed = { ...original, properties: { ...original.properties, fontSize: 96 + step,
      minimumFontSize: 24 + step, box: { ...original.properties.box, x: 100 + step, width: 1400 + step } } };
    await renderer.updateStill([changed]);
    renderer.draw({ phase: 'paused', positionMs: 500, opacity: 1, items: [{ clip: changed, opacity: 1, localTimeMs: 500 }] });
    assert.equal(h.root.children[0], layer); assert.equal(stage.style.transform, 'scale(0.5)');
    assert.equal(text.style.left, `${100 + step}px`); assert.equal(text.style.fontSize, `${96 + step}px`);
  }
  assert.equal(h.fontLoads, 1);
  const disabled = { ...original, properties: { ...original.properties,
    outline: { ...original.properties.outline!, enabled: false }, shadow: { ...original.properties.shadow!, enabled: false }, glow: { ...original.properties.glow!, enabled: false } } };
  await renderer.updateStill([disabled]); assert.equal(text.style.webkitTextStroke, ''); assert.equal(text.style.textShadow, '');
});
