import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageClip } from '../src/domain/sequence.js';
import { imageContentGeometry, imageMaskCss, imageRenderer, waitForImage } from '../src/rendering/image-renderer.js';

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

const clip: ImageClip = {
  id: 'still-image', trackId: 'visual', type: 'image', typeVersion: 1, startMs: 0,
  duration: { kind: 'fixed', milliseconds: 1000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
  appearance: { blendMode: 'screen', opacity: 0.4 },
  properties: {
    source: { kind: 'foundry-file', path: 'worlds/test/still.png' }, fit: 'contain',
    box: { x: 50, y: 25, width: 200, height: 100 }, crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
    mask: [{ x: 0, y: 0 }, { x: 1, y: 0.25 }, { x: 0.8, y: 1 }, { x: 0, y: 1 }],
    outline: { enabled: true, color: '#112233', opacity: 0.7, width: 4 },
    shadow: { enabled: true, color: '#223344', opacity: 0.6, offsetX: 3, offsetY: 5, blur: 6 },
    glow: { enabled: true, color: '#445566', opacity: 0.5, radius: 8 }
  }
};

const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

test('crop geometry fits the selected source region and keeps a separate contain aperture', () => {
  assert.deepEqual(imageContentGeometry({ x: 0, y: 0, width: 800, height: 600 }, 1920, 1080,
    { x: 0, y: 0, width: 1, height: 1 }, 'contain'), {
    sourceRect: { x: 0, y: 0, width: 1920, height: 1080 },
    aperture: { x: 0, y: 75, width: 800, height: 450 },
    imageRect: { x: 0, y: 75, width: 800, height: 450 }
  });
  const contain = imageContentGeometry(clip.properties.box, 1600, 900, clip.properties.crop, 'contain');
  assert.deepEqual(contain.sourceRect, { x: 400, y: 0, width: 800, height: 900 });
  assert.ok(Math.abs(contain.aperture.x - 105.5555555556) < 0.000001);
  assert.deepEqual({ y: contain.aperture.y, width: contain.aperture.width, height: contain.aperture.height }, { y: 25, width: contain.aperture.width, height: 100 });
  assert.ok(Math.abs(contain.aperture.width - 88.8888888889) < 0.000001);
  assert.ok(Math.abs(contain.imageRect.x - 61.1111111111) < 0.000001);
  assert.deepEqual({ y: contain.imageRect.y, width: contain.imageRect.width, height: contain.imageRect.height }, { y: 25, width: contain.imageRect.width, height: 100 });
  assert.ok(Math.abs(contain.imageRect.width - 177.7777777778) < 0.000001);
  const cover = imageContentGeometry(clip.properties.box, 1600, 900, clip.properties.crop, 'cover');
  assert.deepEqual(cover.aperture, clip.properties.box);
  assert.deepEqual(cover.imageRect, { x: -50, y: -37.5, width: 400, height: 225 });
  assert.throws(() => imageContentGeometry(clip.properties.box, 0, 900, clip.properties.crop, 'contain'), RangeError);
  assert.throws(() => imageContentGeometry(clip.properties.box, 1600, 900, { x: 0.8, y: 0, width: 0.3, height: 1 }, 'cover'), RangeError);
});

test('mask CSS uses evenodd fill for arbitrary crossed or collapsed quads', () => {
  assert.equal(imageMaskCss([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }]),
    'polygon(evenodd, 0% 0%, 100% 100%, 0% 100%, 100% 0%)');
});

test('image readiness cleans listeners on load, decode completion, error, cancel and timeout', async t => {
  const { images } = installDocument(t);
  const controller = new AbortController();
  const readyImage = images[0] ?? new FakeImage();
  readyImage.src = 'worlds/test/ready.png';
  const ready = waitForImage(readyImage as unknown as HTMLImageElement, controller.signal, 1000);
  readyImage.load(20, 10);
  await ready;
  assert.equal(readyImage.listenerCount, 0);

  const failedImage = new FakeImage(); failedImage.src = 'worlds/test/broken.png';
  const failed = waitForImage(failedImage as unknown as HTMLImageElement, controller.signal, 1000);
  failedImage.fail();
  await assert.rejects(failed, { code: 'MEDIA_LOAD_FAILED' });
  assert.equal(failedImage.listenerCount, 0);

  const canceledImage = new FakeImage();
  const cancelController = new AbortController();
  const canceled = waitForImage(canceledImage as unknown as HTMLImageElement, cancelController.signal, 60_000);
  cancelController.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  assert.equal(canceledImage.listenerCount, 0);

  const timeoutImage = new FakeImage();
  await assert.rejects(waitForImage(timeoutImage as unknown as HTMLImageElement, controller.signal, 5), { code: 'MEDIA_TIMEOUT' });
  assert.equal(timeoutImage.listenerCount, 0);
});

test('renderer waits for decode, applies crop, mask, effects and one clip alpha, then reuses the still image', async t => {
  const { images } = installDocument(t);
  const root = new FakeElement('root');
  root.rect = { left: 0, top: 0, width: 800, height: 600 };
  const controller = new AbortController();
  const renderer = imageRenderer(clip, root as unknown as HTMLElement, { width: 400, height: 300 }, { signal: controller.signal });
  const image = images[0]!;
  let finishDecode: () => void = () => {};
  image.decodeResult = new Promise<void>(resolve => { finishDecode = resolve; });
  let ready = false;
  const pending = renderer.prepare().then(() => { ready = true; });
  assert.equal(image.src, clip.properties.source.path);
  image.load();
  await flush();
  assert.equal(ready, false, 'load alone is insufficient while decode is pending');
  assert.equal(image.decodeCalls, 1);
  finishDecode(); await pending;
  assert.equal(ready, true);

  const item = { clip, opacity: 0.5, localTimeMs: 0, textTransform: { x: 10, y: 20, scale: 2 } };
  renderer.draw(item, { phase: 'playing', positionMs: 0, opacity: 0.3, items: [item] });
  assert.equal(renderer.node.style.opacity, '0.2');
  assert.equal(renderer.node.style.mixBlendMode, 'screen');
  const imageNode = find(renderer.node as unknown as FakeElement, 'img')!;
  assert.equal(imageNode.style.width, '177.77777777777777px');
  assert.equal(imageNode.style.height, '100px');
  const allElements = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(allElements)];
  const masked = allElements(renderer.node as unknown as FakeElement).find(node => node.style.clipPath?.startsWith('polygon('));
  assert.equal(masked?.style.clipPath, 'polygon(evenodd, 0% 0%, 100% 25%, 80% 100%, 0% 100%)');
  const outline = find(renderer.node as unknown as FakeElement, 'path')!;
  assert.equal(outline.getAttribute('d'), 'M 0 0 L 200 25 L 160 100 L 0 100 Z');
  assert.equal(outline.getAttribute('stroke-width'), '4');
  const effectsLayer = allElements(renderer.node as unknown as FakeElement).find(node => node.style.filter?.startsWith('url('));
  assert.match(effectsLayer?.style.filter ?? '', /^url\(#stagecraft-image-effects-\d+\)$/);
  assert.equal(effectsLayer?.children.some(node => node.tagName === 'svg'), false, 'the quad outline remains outside the alpha effects group');
  const movedBox = allElements(renderer.node as unknown as FakeElement).find(node => node.style.left === '50px' && node.style.top === '25px');
  assert.equal(movedBox?.style.transform, 'translate(10px, 20px) scale(2)');
  const filter = allElements(renderer.node as unknown as FakeElement).find(node => node.tagName === 'filter')!;
  assert.equal(filter.children[0]?.tagName, 'feGaussianBlur');
  assert.equal(filter.children[0]?.getAttribute('in'), 'SourceAlpha');
  assert.equal(filter.children[1]?.tagName, 'feOffset');
  assert.equal(filter.children[2]?.tagName, 'feFlood');
  assert.equal(filter.children[2]?.getAttribute('flood-opacity'), '0.6');
  assert.equal(filter.children[4]?.tagName, 'feGaussianBlur');
  assert.equal(filter.children[4]?.getAttribute('in'), 'SourceAlpha', 'glow reads the source alpha independently of the shadow');
  assert.equal(filter.children[5]?.tagName, 'feFlood');
  assert.equal(filter.children[5]?.getAttribute('flood-opacity'), '0.5');
  const merge = filter.children[7]!;
  assert.deepEqual(merge.children.map(node => node.getAttribute('in')), ['imageShadow', 'imageGlow', 'SourceGraphic']);
  assert.equal(allElements(renderer.node as unknown as FakeElement).filter(node => node.tagName === 'img').length, 1,
    'outline, shadow and glow reuse the one prepared image source');

  const footprints = renderer.backdropFootprints?.(item, { width: 800, height: 600 });
  assert.deepEqual(footprints?.[0]?.points, [
    { x: -80, y: -10 }, { x: 720, y: 90 }, { x: 560, y: 390 }, { x: -80, y: 390 }
  ], 'nonzero box offsets and slide+zoom are included in the projected mask');
  const aperture = footprints?.[0]?.clip;
  assert.ok(aperture);
  assert.ok(Math.abs(aperture.x - 142.2222222222) < 0.000001);
  assert.deepEqual({ y: aperture.y, width: aperture.width, height: aperture.height }, { y: -10, width: aperture.width, height: 400 });
  assert.ok(Math.abs(aperture.width - 355.5555555556) < 0.000001);
  assert.deepEqual(footprints?.at(-1)?.points, [
    { x: -176, y: -106 }, { x: 816, y: -106 }, { x: 816, y: 486 }, { x: -176, y: 486 }
  ], 'the blend footprint expands for outline, shadow and glow');
  const smallerComposition = imageRenderer(clip, root as unknown as HTMLElement, { width: 200, height: 150 }, { signal: controller.signal });
  const secondImage = images[1]!; secondImage.load(); await smallerComposition.prepare();
  const smallerFootprints = smallerComposition.backdropFootprints?.(item, { width: 800, height: 600 });
  assert.deepEqual(smallerFootprints?.[0]?.points, [
    { x: -160, y: -20 }, { x: 1440, y: 180 }, { x: 1120, y: 780 }, { x: -160, y: 780 }
  ], 'effect coordinates scale from logical composition units into the actual preview surface');
  const smallerAperture = smallerFootprints?.[0]?.clip;
  assert.ok(smallerAperture);
  assert.ok(Math.abs(smallerAperture.x - 284.4444444444) < 0.000001);
  assert.ok(Math.abs(smallerAperture.width - 711.1111111112) < 0.000001);
  assert.deepEqual({ y: smallerAperture.y, height: smallerAperture.height }, { y: -20, height: 800 });
  assert.deepEqual(smallerFootprints?.at(-1)?.points, [
    { x: -352, y: -212 }, { x: 1632, y: -212 }, { x: 1632, y: 972 }, { x: -352, y: 972 }
  ]);
  const smallerStage = allElements(smallerComposition.node as unknown as FakeElement).find(node => node.style.width === '200px' && node.style.height === '150px');
  assert.equal(smallerStage?.style.transform, 'scale(4)');

  const changed: ImageClip = { ...clip, properties: { ...clip.properties, box: { ...clip.properties.box, x: 70 } } };
  renderer.updateAppearance?.(changed);
  renderer.draw({ ...item, clip: changed, localTimeMs: 1000 }, { phase: 'paused', positionMs: 1000, opacity: 1, items: [] });
  renderer.draw({ ...item, clip: changed, localTimeMs: 5000 }, { phase: 'paused', positionMs: 5000, opacity: 1, items: [] });
  assert.equal(image.srcAssignments, 1);
  assert.equal(image.decodeCalls, 1);
  renderer.dispose(); smallerComposition.dispose();
  assert.equal(image.src, ''); assert.equal(image.removed, true);
  assert.equal(image.listenerCount, 0);
  assert.equal(secondImage.src, '');
});

test('image, mask and outline follow surface resizes without a clip update or another draw', async t => {
  const { images } = installDocument(t);
  const { observers } = installResizeObserver(t);
  const root = new FakeElement('root');
  root.rect = { left: 0, top: 0, width: 0, height: 0 };
  root.contentSize = { width: 0, height: 0 };
  const renderer = imageRenderer(clip, root as unknown as HTMLElement, { width: 400, height: 300 },
    { signal: new AbortController().signal });
  const image = images[0]!;
  const pending = renderer.prepare();
  image.load(); await pending;
  const stage = (renderer.node as unknown as FakeElement).children.find(node => node.style.width === '400px')!;
  const observer = observers[0]!;
  assert.ok(observer.targets.has(root as unknown as Element));
  assert.equal(stage.style.transform, undefined, 'detached preparation has no usable surface size');

  // The first mounted frame can arrive before ResizeObserver's first delivery.
  // It must finish the still-dirty initial layout after preparation measured 0×0.
  root.rect = { left: 0, top: 0, width: 1600, height: 1200 };
  root.contentSize = { width: 800, height: 600 };
  const item = { clip, opacity: 1, localTimeMs: 0 };
  renderer.draw(item, { phase: 'playing', positionMs: 0, opacity: 1, items: [item] });
  assert.equal(stage.style.transform, 'scale(2)');

  // Subsequent resizes are handled by the observer alone, including letterboxing.
  root.rect = { left: 0, top: 0, width: 1000, height: 1200 };
  root.contentSize = { width: 500, height: 600 };
  observer.deliver();
  assert.equal(stage.style.left, '0px');
  assert.equal(stage.style.top, '112.5px');
  assert.equal(stage.style.transform, 'scale(1.25)');
  root.rect = { left: 0, top: 0, width: 2000, height: 600 };
  root.contentSize = { width: 1000, height: 300 };
  observer.deliver();
  assert.equal(stage.style.left, '300px');
  assert.equal(stage.style.top, '0px');
  assert.equal(stage.style.transform, 'scale(1)');

  const imageNode = find(renderer.node as unknown as FakeElement, 'img')!;
  const outlinePath = find(renderer.node as unknown as FakeElement, 'path')!;
  const masked = allElements(renderer.node as unknown as FakeElement).find(node => node.style.clipPath?.startsWith('polygon('));
  assert.equal(imageNode.style.width, '177.77777777777777px');
  assert.equal(masked?.style.clipPath, imageMaskCss(clip.properties.mask));
  assert.equal(outlinePath.getAttribute('d'), 'M 0 0 L 200 25 L 160 100 L 0 100 Z');
  assert.equal(image.srcAssignments, 1, 'resize does not reload the still image');
  assert.equal(image.decodeCalls, 1, 'resize does not decode the still image again');

  const finalTransform = stage.style.transform;
  renderer.dispose();
  assert.equal(observer.disconnected, true);
  root.rect = { left: 0, top: 0, width: 600, height: 1800 };
  root.contentSize = { width: 300, height: 900 };
  observer.deliverLate();
  assert.equal(stage.style.transform, finalTransform, 'a queued observer callback cannot relayout a released renderer');
  assert.equal(image.src, '');
});

test('abort during preparation releases the image source and removes pending listeners', async t => {
  const { images } = installDocument(t);
  const root = new FakeElement('root');
  const controller = new AbortController();
  const renderer = imageRenderer(clip, root as unknown as HTMLElement, { width: 400, height: 300 }, { signal: controller.signal });
  const image = images[0]!;
  const pending = renderer.prepare();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(image.src, '');
  assert.equal(image.removed, true);
  assert.equal(image.listenerCount, 0);
});
