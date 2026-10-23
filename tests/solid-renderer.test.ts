import test from 'node:test';
import assert from 'node:assert/strict';
import type { SolidClip } from '../src/domain/sequence.js';
import { solidNeedsBackdrop, solidRenderer } from '../src/rendering/solid-renderer.js';
import { CompositionRenderer } from '../src/rendering/composition-renderer.js';
import { VideoBlendBackdrop } from '../src/rendering/video-blend-backdrop.js';
class FakeElement extends EventTarget {
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  className = '';
  alt = '';
  decoding = '';
  draggable = false;
  removed = false;
  tagName: string;
  rect = { left: 0, top: 0, width: 800, height: 600 };
  contentSize = { width: 800, height: 600 };
  private readonly handlers = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(tagName: string) { super(); this.tagName = tagName; }
  get clientWidth(): number { return this.contentSize.width; }
  get clientHeight(): number { return this.contentSize.height; }
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    if (callback) { const set = this.handlers.get(type) ?? new Set(); set.add(callback); this.handlers.set(type, set); }
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    if (callback) this.handlers.get(type)?.delete(callback);
    super.removeEventListener(type, callback, options);
  }
  get listenerCount(): number { return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0); }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  prepend(...nodes: FakeElement[]): void { this.children.unshift(...nodes); }
  remove(): void { this.removed = true; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getBoundingClientRect(): DOMRect { return this.rect as DOMRect; }
}

class FakeImage extends FakeElement {
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  srcAssignments = 0;
  decodeCalls = 0;
  private source = '';
  decodeResult: Promise<void> = Promise.resolve();
  constructor() { super('img'); }
  set src(value: string) { this.source = value; this.srcAssignments += 1; }
  get src(): string { return this.source; }
  override getAttribute(name: string): string | null { return name === 'src' ? this.source || null : super.getAttribute(name); }
  override removeAttribute(name: string): void { if (name === 'src') this.source = ''; else super.removeAttribute(name); }
  decode(): Promise<void> { this.decodeCalls += 1; return this.decodeResult; }
  load(width = 1600, height = 900): void { this.naturalWidth = width; this.naturalHeight = height; this.complete = true; this.dispatchEvent(new Event('load')); }
  fail(): void { this.complete = true; this.dispatchEvent(new Event('error')); }
}

class FakeResizeObserver {
  readonly targets = new Set<Element>();
  disconnected = false;
  private lastTarget: Element | null = null;
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void { this.targets.add(target); this.lastTarget = target; }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.disconnected = true; this.targets.clear(); }
  private entryFor(target: Element): ResizeObserverEntry {
    const element = target as unknown as FakeElement;
    return { target, contentRect: { width: element.contentSize.width, height: element.contentSize.height } } as ResizeObserverEntry;
  }
  deliver(): void {
    const target = [...this.targets][0];
    if (!target) return;
    this.callback([this.entryFor(target)], this as unknown as ResizeObserver);
  }
  deliverLate(): void {
    if (this.lastTarget) this.callback([this.entryFor(this.lastTarget)], this as unknown as ResizeObserver);
  }
}

function installDocument(t: { after(callback: () => void): void }): { images: FakeImage[] } {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const images: FakeImage[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag: string) {
      if (tag === 'img') { const image = new FakeImage(); images.push(image); return image; }
      return new FakeElement(tag);
    },
    createElementNS(_namespace: string, tag: string) { return new FakeElement(tag); }
  } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else Reflect.deleteProperty(globalThis, 'document'); });
  return { images };
}

function installResizeObserver(t: { after(callback: () => void): void }): { observers: FakeResizeObserver[] } {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const observers: FakeResizeObserver[] = [];
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class extends FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) { super(callback); observers.push(this); }
  } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'ResizeObserver', before); else Reflect.deleteProperty(globalThis, 'ResizeObserver'); });
  return { observers };
}

function find(node: FakeElement, tagName: string): FakeElement | undefined {
  if (node.tagName === tagName) return node;
  for (const child of node.children) { const match = find(child, tagName); if (match) return match; }
  return undefined;
}

function allElements(node: FakeElement): FakeElement[] { return [node, ...node.children.flatMap(allElements)]; }

const clip: SolidClip = {
  id: 'solid', trackId: 'visual', type: 'solid', typeVersion: 1, startMs: 0,
  duration: { kind: 'fixed', milliseconds: 1000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
  appearance: { blendMode: 'normal', opacity: 0.4 },
  properties: {
    color: '#aabbcc', fit: 'contain', box: { x: 50, y: 25, width: 200, height: 100 },
    crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
    mask: [{ x: 0, y: 0 }, { x: 1, y: 0.25 }, { x: 0.8, y: 1 }, { x: 0, y: 1 }]
  }
};
const textured: SolidClip = { ...clip, properties: { ...clip.properties, alphaMap: { kind: 'foundry-file', path: 'worlds/test/alpha.png' } } };
const frame = { phase: 'paused' as const, positionMs: 0, opacity: 0.3, items: [] };
const rootFor = () => new FakeElement('root') as unknown as HTMLElement;
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

test('pure solid draws its polygon without creating media and applies opacity/motion once', async t => {
  const { images } = installDocument(t);
  const renderer = solidRenderer(clip, rootFor(), { width: 400, height: 300 }, { signal: new AbortController().signal });
  await renderer.prepare();
  renderer.draw({ clip, opacity: 0.5, localTimeMs: 0, textTransform: { x: 10, y: 20, scale: 2 } }, frame);
  const node = renderer.node as unknown as FakeElement;
  const fill = find(node, 'path')!;
  assert.equal(images.length, 0);
  assert.equal(find(node, 'image'), undefined);
  assert.equal(fill.getAttribute('d'), 'M 0 0 L 200 25 L 160 100 L 0 100 Z');
  assert.equal(fill.getAttribute('fill'), '#aabbcc');
  assert.equal(fill.getAttribute('mask'), null);
  assert.equal(node.style.opacity, '0.2', 'global opacity belongs to CompositionRenderer root');
  assert.equal(node.style.mixBlendMode, 'normal');
  assert.ok(allElements(node).some(element => element.style.transform === 'translate(10px, 20px) scale(2)'));
  renderer.dispose();
});

test('native luminance mask uses sRGB gray and texture alpha, with separate crop/fit aperture', async t => {
  const { images } = installDocument(t);
  const renderer = solidRenderer(textured, rootFor(), { width: 400, height: 300 }, { signal: new AbortController().signal });
  const node = renderer.node as unknown as FakeElement;
  const pending = renderer.prepare();
  const texture = find(node, 'image')!;
  assert.equal(texture.getAttribute('href'), null, 'unprepared textures cannot display');
  renderer.draw({ clip: textured, opacity: 1, localTimeMs: 0 }, frame);
  assert.equal(node.style.opacity, '0');
  images[0]!.load(); await pending;
  const mask = find(node, 'mask')!;
  assert.equal(mask.getAttribute('mask-type'), 'luminance', 'white => 1, black => 0, gray => proportional luminance times source alpha');
  assert.equal(mask.style.maskType, 'luminance');
  assert.equal(mask.getAttribute('color-interpolation'), 'sRGB');
  assert.equal(mask.getAttribute('maskUnits'), 'userSpaceOnUse');
  assert.equal(mask.getAttribute('maskContentUnits'), 'userSpaceOnUse');
  assert.equal(texture.getAttribute('preserveAspectRatio'), 'none', 'computed rectangular fit is independent of polygon points');
  assert.equal(texture.getAttribute('href'), textured.properties.alphaMap!.path);
  assert.ok(Math.abs(Number(texture.getAttribute('x')) - 11.1111111111) < 1e-6);
  assert.ok(Math.abs(Number(texture.getAttribute('width')) - 177.7777777778) < 1e-6);
  const aperture = find(node, 'rect')!;
  assert.ok(Math.abs(Number(aperture.getAttribute('x')) - 55.5555555556) < 1e-6);
  assert.ok(Math.abs(Number(aperture.getAttribute('width')) - 88.8888888889) < 1e-6);
  assert.equal(aperture.getAttribute('height'), '100');
  assert.match(texture.getAttribute('clip-path')!, /^url\(#stagecraft-solid-\d+-crop\)$/);
  const cover: SolidClip = { ...textured, properties: { ...textured.properties, fit: 'cover', color: '#112233' } };
  renderer.updateAppearance?.(cover);
  assert.equal(aperture.getAttribute('x'), '0'); assert.equal(aperture.getAttribute('width'), '200');
  assert.equal(aperture.getAttribute('height'), '100');
  assert.equal(find(node, 'path')!.getAttribute('fill'), '#112233');
  assert.equal(images[0]!.srcAssignments, 1); assert.equal(images[0]!.decodeCalls, 1);
  renderer.dispose(); assert.equal(texture.getAttribute('href'), null);
});

test('simultaneous solids have independent SVG mask, crop and effect IDs', async t => {
  const { images } = installDocument(t); const root = rootFor();
  const first = solidRenderer(textured, root, { width: 400, height: 300 }, { signal: new AbortController().signal });
  const second = solidRenderer(textured, root, { width: 400, height: 300 }, { signal: new AbortController().signal });
  const pending = Promise.all([first.prepare(), second.prepare()]); images.forEach(image => image.load()); await pending;
  const ids = [first, second].flatMap(renderer => allElements(renderer.node as unknown as FakeElement)
    .map(node => node.getAttribute('id')).filter((id): id is string => id !== null));
  assert.equal(ids.length, 6); assert.equal(new Set(ids).size, 6);
  first.dispose(); second.dispose();
});

test('solid shadow/glow use masked SourceAlpha and outline follows the polygon', async t => {
  const { images } = installDocument(t);
  const enhanced: SolidClip = { ...textured, appearance: { blendMode: 'screen', opacity: 0.4 }, properties: { ...textured.properties,
    outline: { enabled: true, color: '#112233', opacity: 0.7, width: 4 },
    shadow: { enabled: true, color: '#223344', opacity: 0.6, offsetX: 3, offsetY: 5, blur: 6 },
    glow: { enabled: true, color: '#445566', opacity: 0.5, radius: 8 }
  } };
  const renderer = solidRenderer(enhanced, rootFor(), { width: 400, height: 300 }, { signal: new AbortController().signal });
  const pending = renderer.prepare(); images[0]!.load(); await pending;
  const node = renderer.node as unknown as FakeElement;
  const filter = find(node, 'filter')!;
  assert.equal(filter.children[0]!.getAttribute('in'), 'SourceAlpha');
  assert.equal(filter.children[4]!.getAttribute('in'), 'SourceAlpha');
  assert.deepEqual(filter.children[7]!.children.map(child => child.getAttribute('in')), ['solidShadow', 'solidGlow', 'SourceGraphic']);
  const outline = allElements(node).filter(child => child.tagName === 'path')[1]!;
  assert.equal(outline.getAttribute('d'), find(node, 'path')!.getAttribute('d'));
  assert.equal(outline.getAttribute('mask'), null);
  assert.equal(outline.getAttribute('stroke-opacity'), '0.7');
  const item = { clip: enhanced, opacity: 0.5, localTimeMs: 0, textTransform: { x: 10, y: 20, scale: 2 } };
  renderer.draw(item, frame);
  assert.equal(node.style.opacity, '0.2'); assert.equal(node.style.mixBlendMode, 'screen');
  assert.equal(solidNeedsBackdrop(item), true); assert.equal(solidNeedsBackdrop({ ...item, opacity: 0 }), false);
  const footprints = renderer.backdropFootprints!(item, { width: 800, height: 600 });
  assert.deepEqual(footprints[0]!.points, [{ x: -80, y: -10 }, { x: 720, y: 90 }, { x: 560, y: 390 }, { x: -80, y: 390 }]);
  assert.ok(Math.abs(footprints[0]!.clip!.x - 142.2222222222) < 1e-6);
  assert.deepEqual(footprints.at(-1)!.points, [{ x: -176, y: -106 }, { x: 816, y: -106 }, { x: 816, y: 486 }, { x: -176, y: 486 }]);
  renderer.dispose();
});

test('solid projects on initial mount and resize; disposal disconnects observer', async t => {
  installDocument(t); const { observers } = installResizeObserver(t);
  const root = new FakeElement('root'); root.contentSize = { width: 0, height: 0 };
  const renderer = solidRenderer(clip, root as unknown as HTMLElement, { width: 400, height: 300 }, { signal: new AbortController().signal });
  await renderer.prepare(); const stage = (renderer.node as unknown as FakeElement).children[0]!;
  assert.equal(stage.style.transform, undefined);
  root.contentSize = { width: 800, height: 600 };
  renderer.draw({ clip, opacity: 1, localTimeMs: 0 }, frame); assert.equal(stage.style.transform, 'scale(2)');
  root.contentSize = { width: 500, height: 600 }; observers[0]!.deliver();
  assert.equal(stage.style.transform, 'scale(1.25)'); assert.equal(stage.style.top, '112.5px');
  renderer.dispose(); assert.equal(observers[0]!.disconnected, true);
  root.contentSize = { width: 100, height: 100 }; observers[0]!.deliverLate();
  assert.equal(stage.style.transform, 'scale(1.25)');
});

test('composition reuses same texture for appearance and scrubbing, replaces it for path/clear', async t => {
  const { images } = installDocument(t);
  const root = rootFor(); const renderer = new CompositionRenderer([textured], root, { width: 400, height: 300 }, { signal: new AbortController().signal, still: true });
  const pending = renderer.prepare(); images[0]!.load(); await pending;
  const changed: SolidClip = { ...textured, properties: { ...textured.properties, color: '#ff0000', box: { ...textured.properties.box, x: 70 } } };
  await renderer.updateStill([changed]); await renderer.updateStill([changed]);
  renderer.draw({ ...frame, items: [{ clip: changed, opacity: 0.5, localTimeMs: 500 }] });
  assert.equal(images.length, 1); assert.equal(images[0]!.srcAssignments, 1); assert.equal(images[0]!.decodeCalls, 1);
  assert.equal(root.style.opacity, '0.3');
  const newPath: SolidClip = { ...changed, properties: { ...changed.properties, alphaMap: { kind: 'foundry-file', path: 'modules/test/another.png' } } };
  const update = renderer.updateStill([newPath]); await flush();
  assert.equal(images[0]!.src, ''); assert.equal(images.length, 2);
  images[1]!.load(); await update;
  await renderer.updateStill([clip]); assert.equal(images[1]!.src, ''); assert.equal(images.length, 2);
  const node = (root as unknown as FakeElement).children.at(-1)!;
  assert.equal(find(node, 'image'), undefined);
  renderer.dispose();
});

test('broken/empty/remote alpha textures fail rather than rendering opaque fill', async t => {
  const { images } = installDocument(t);
  for (const path of ['', 'https://example.com/alpha.png', '//example.com/alpha.png']) {
    assert.throws(() => solidRenderer({ ...textured, properties: { ...textured.properties, alphaMap: { kind: 'foundry-file', path } } }, rootFor(),
      { width: 400, height: 300 }, { signal: new AbortController().signal }), { code: 'MEDIA_INVALID_PATH' });
  }
  for (const outcome of ['load', 'decode'] as const) {
    const renderer = solidRenderer(textured, rootFor(), { width: 400, height: 300 }, { signal: new AbortController().signal });
    const image = images.at(-1)!;
    const pending = renderer.prepare();
    if (outcome === 'load') image.fail();
    else { image.decodeResult = Promise.reject(new Error('decode')); image.load(); }
    await assert.rejects(pending, { code: 'MEDIA_LOAD_FAILED' });
    assert.equal(image.src, ''); assert.equal(image.listenerCount, 0);
    assert.equal((renderer.node as unknown as FakeElement).removed, true);
    assert.equal(find(renderer.node as unknown as FakeElement, 'image')!.getAttribute('href'), null);
  }
});

test('abort/dispose during load or decode removes media/listeners and stale completions stay hidden', async t => {
  const { images } = installDocument(t); const { observers } = installResizeObserver(t);
  for (const phase of ['load', 'decode'] as const) {
    const controller = new AbortController();
    const renderer = solidRenderer(textured, rootFor(), { width: 400, height: 300 }, { signal: controller.signal });
    const image = images.at(-1)!; let finish = () => {};
    if (phase === 'decode') image.decodeResult = new Promise<void>(resolve => { finish = resolve; });
    const pending = renderer.prepare();
    if (phase === 'decode') { image.load(); await flush(); renderer.dispose(); } else controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    image.load(); finish(); await flush();
    const node = renderer.node as unknown as FakeElement;
    assert.equal(node.removed, true); assert.equal(image.src, ''); assert.equal(image.listenerCount, 0);
    assert.equal(find(node, 'image')!.getAttribute('href'), null); assert.equal(node.style.opacity, '0');
    assert.equal(observers.at(-1)!.disconnected, true);
  }
});

test('borrowed board backdrop recognizes a blended pure solid and paints its projected footprint', async t => {
  installDocument(t);
  const canvases: Array<FakeElement & { width: number; height: number; getContext(): unknown }> = [];
  const operations: string[] = [];
  const create = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    if (tag !== 'canvas') return create(tag);
    const node = Object.assign(new FakeElement('canvas'), { width: 0, height: 0, getContext: () => ({
      setTransform() {}, clearRect() {}, save() {}, restore() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
      moveTo(x: number, y: number) { operations.push(`move:${x},${y}`); }, lineTo() {}, closePath() {},
      fill(rule: string) { operations.push(`fill:${rule}`); }, fillRect() {}, drawImage() { operations.push('draw'); }
    }) });
    canvases.push(node); return node as unknown as HTMLCanvasElement;
  }) as typeof document.createElement;
  const enhanced: SolidClip = { ...clip, appearance: { blendMode: 'difference', opacity: 0.4 } };
  const root = rootFor(); const signal = new AbortController().signal;
  let boardRequests = 0;
  const options = { signal, boardBackdrop: () => { boardRequests += 1; return {
    source: canvases[0] as unknown as CanvasImageSource, rect: { left: 0, top: 0, width: 800, height: 600 }
  }; } };
  const composition = new CompositionRenderer([enhanced], root, { width: 400, height: 300 }, options);
  await composition.prepare(); assert.equal(canvases.length, 2, 'solid blend makes CompositionRenderer allocate the shared backdrop');
  assert.equal(boardRequests, 1, 'board subscription begins during composition construction');
  composition.dispose();
  const root2 = rootFor(); const renderer = solidRenderer(enhanced, root2, { width: 400, height: 300 }, { signal });
  await renderer.prepare();
  const backdrop = new VideoBlendBackdrop(root2, options);
  const item = { clip: enhanced, opacity: 0.5, localTimeMs: 0 };
  assert.equal(backdrop.draw(new Map([[enhanced.id, item]]), new Map([[enhanced.id, { renderer }]]), 0.3), 'ready');
  assert.ok(operations.includes('move:100,50')); assert.ok(operations.includes('fill:evenodd'));
  assert.equal(backdrop.node.style.display, '');
  assert.equal(backdrop.draw(new Map([[enhanced.id, { ...item, opacity: 0 }]]), new Map([[enhanced.id, { renderer }]]), 0.3), 'inactive');
  assert.equal(backdrop.node.style.display, 'none'); backdrop.dispose(); renderer.dispose();
});


