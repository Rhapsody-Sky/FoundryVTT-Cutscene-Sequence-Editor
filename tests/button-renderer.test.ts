import test from 'node:test';
import assert from 'node:assert/strict';
import type { ButtonClip } from '../src/domain/sequence.js';
import { BUTTON_TEXTURES } from '../src/domain/button.js';
import type { PlayerFrame } from '../src/playback/local-player.js';
import { buttonRenderer } from '../src/rendering/button-renderer.js';
import { CompositionRenderer } from '../src/rendering/composition-renderer.js';
import type { RendererOptions } from '../src/rendering/element-renderer.js';

class FakeClassList {
  constructor(private readonly element: FakeElement) {}
  add(...tokens: string[]): void {
    const names = new Set((this.element.className || '').split(/\s+/).filter(Boolean));
    tokens.forEach(token => names.add(token)); this.element.className = [...names].join(' ');
  }
  contains(token: string): boolean { return this.element.className.split(/\s+/).includes(token); }
}

class FakeElement extends EventTarget {
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList(this);
  className = '';
  tagName: string;
  textContent = '';
  type = '';
  alt = '';
  draggable = false;
  disabled = false;
  tabIndex = 0;
  removed = false;
  rect = { left: 0, top: 0, width: 800, height: 600 };
  contentSize = { width: 800, height: 600 };
  constructor(tagName: string) { super(); this.tagName = tagName.toUpperCase(); }
  get clientWidth(): number { return this.contentSize.width; }
  get clientHeight(): number { return this.contentSize.height; }
  getContext(_kind: string): null { return null; }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
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
  decodeCalls = 0;
  srcAssignments = 0;
  private source = '';
  constructor() { super('img'); }
  set src(value: string) { this.source = value; this.srcAssignments += 1; this.complete = true; this.naturalWidth = 160; this.naturalHeight = 120; }
  get src(): string { return this.source; }
  override getAttribute(name: string): string | null { return name === 'src' ? this.source || null : super.getAttribute(name); }
  override removeAttribute(name: string): void { if (name === 'src') this.source = ''; else super.removeAttribute(name); }
  decode(): Promise<void> { this.decodeCalls += 1; return Promise.resolve(); }
}

class FakeResizeObserver {
  target: FakeElement | null = null;
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void { this.target = target as unknown as FakeElement; }
  disconnect(): void { this.disconnected = true; this.target = null; }
  deliver(): void {
    if (!this.target) return;
    const target = this.target as unknown as Element;
    const entry = { target, contentRect: { width: this.target.contentSize.width, height: this.target.contentSize.height } } as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

function installDocument(t: { after(callback: () => void): void }, fonts?: Pick<FontFaceSet, 'load' | 'check'>): { images: FakeImage[] } {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const images: FakeImage[] = [];
  const fakeDocument: { createElement(tag: string): FakeElement; createElementNS(_namespace: string, tag: string): FakeElement; fonts?: Pick<FontFaceSet, 'load' | 'check'> } = {
    createElement(tag: string) {
      if (tag === 'img') { const image = new FakeImage(); images.push(image); return image; }
      return new FakeElement(tag);
    },
    createElementNS(_namespace: string, tag: string) { return new FakeElement(tag); }
  };
  if (fonts) fakeDocument.fonts = fonts;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
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
  if (node.tagName === tagName.toUpperCase()) return node;
  for (const child of node.children) { const match = find(child, tagName); if (match) return match; }
  return undefined;
}

const base: ButtonClip = {
  id: 'button-one', trackId: 'visual', type: 'button', typeVersion: 1, startMs: 0,
  duration: { kind: 'fixed', milliseconds: 5000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
  properties: {
    action: { kind: 'continue' }, label: 'Continue', fontFamily: 'sans-serif', fontSize: 30,
    color: '#ffffff', backgroundColor: '#26334d', shape: 'hexagon',
    box: { x: 40, y: 70, width: 220, height: 64 },
    outline: { enabled: true, color: '#aabbcc', opacity: 0.8, width: 3 },
    shadow: { enabled: true, color: '#000000', opacity: 0.5, offsetX: 2, offsetY: 3, blur: 5 },
    glow: { enabled: true, color: '#557799', opacity: 0.25, radius: 8 }
  }
};

function rootFor(): FakeElement { return new FakeElement('root'); }
function item(clip: ButtonClip, opacity = 1, textTransform?: { x: number; y: number; scale: number }) {
  return { clip, opacity, localTimeMs: 100, ...(textTransform ? { textTransform } : {}) };
}
function frame(phase: PlayerFrame['phase'], breakId: string | undefined, opacity = 1): PlayerFrame {
  return { phase, ...(breakId !== undefined ? { breakId } : {}), positionMs: 100, opacity, items: [] };
}
function activate(button: FakeElement): void {
  if (!button.disabled) button.dispatchEvent(new Event('click', { cancelable: true }));
}
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

test('button renderer uses a native accessible button, exact authored shape, effects, and frame motion', async t => {
  installDocument(t);
  const calls: { clipId: string; breakId?: string }[] = [];
  const options: RendererOptions = { signal: new AbortController().signal, onButtonActivate: async intent => { calls.push(intent); } };
  const renderer = buttonRenderer(base, rootFor() as unknown as HTMLElement, { width: 800, height: 600 }, options);
  await renderer.prepare();
  renderer.draw(item(base, 0.75, { x: 12, y: -4, scale: 1.2 }), frame('holding', 'break-a'));
  const node = renderer.node as unknown as FakeElement;
  const button = find(node, 'button')!;
  const label = find(button, 'span')!;
  const motion = node.children[0]!.children[0]!;
  const outline = find(node, 'svg')!.children[0]!;
  assert.equal(button.tagName, 'BUTTON'); assert.equal(button.type, 'button');
  assert.equal(button.getAttribute('aria-label'), 'Continue');
  assert.equal(button.dataset.stagecraftInteractive, '');
  assert.equal(button.disabled, false); assert.equal(button.tabIndex, 0);
  assert.equal(motion.style.left, '40px'); assert.equal(motion.style.top, '70px');
  assert.equal(motion.style.width, '220px'); assert.equal(motion.style.height, '64px');
  assert.equal(motion.style.transformOrigin, 'center center', 'the animated box scales around its own center');
  assert.equal(button.style.left, '0'); assert.equal(button.style.top, '0', 'the native hit target matches the local box geometry');
  assert.match(button.style.clipPath!, /^polygon\(12% 0%, 88% 0%, 100% 50%, 88% 100%, 12% 100%, 0% 50%\)$/);
  assert.equal(label.textContent, 'Continue');
  assert.equal(outline.getAttribute('stroke'), '#aabbcc');
  assert.equal(outline.getAttribute('stroke-width'), '3');
  assert.match(motion.style.transform!, /translate\(12px, -4px\) scale\(1.2\)/);
  assert.match(motion.style.filter!, /drop-shadow\(2px 3px 5px/);
  activate(button);
  await flush();
  assert.deepEqual(calls, [{ clipId: 'button-one', breakId: 'break-a' }]);
  assert.equal(button.disabled, true, 'a successful action stays locked for this break');
  button.dispatchEvent(new Event('click', { cancelable: true })); await flush();
  assert.equal(calls.length, 1, 'even a synthetic click cannot re-enter a completed hold');
  renderer.draw(item(base), frame('holding', 'break-b'));
  assert.equal(button.disabled, false, 'a different break re-enables the control');
  renderer.draw(item(base), frame('holding', undefined));
  assert.equal(button.disabled, false, 'the terminal manual hold is actionable without a Break ID');
  activate(button); await flush();
  assert.deepEqual(calls, [{ clipId: 'button-one', breakId: 'break-a' }, { clipId: 'button-one' }]);
  assert.equal(button.disabled, true, 'terminal hold action is latched to prevent duplicate activation');
  button.dispatchEvent(new Event('click', { cancelable: true })); await flush();
  assert.equal(calls.length, 2, 'terminal hold remains latched through the active fade');
  renderer.dispose();
});

test('only visible live buttons at a matching held break are focusable and actionable', async t => {
  installDocument(t);
  let activations = 0;
  const options: RendererOptions = { signal: new AbortController().signal, onButtonActivate: async () => { activations += 1; } };
  const renderer = buttonRenderer(base, rootFor() as unknown as HTMLElement, { width: 800, height: 600 }, options);
  await renderer.prepare();
  const button = find(renderer.node as unknown as FakeElement, 'button')!;
  const cases: { frame: PlayerFrame; opacity: number; clip: ButtonClip }[] = [
    { frame: frame('playing', 'break-a'), opacity: 1, clip: base },
    { frame: frame('paused', 'break-a'), opacity: 1, clip: base },
    { frame: frame('exiting', 'break-a'), opacity: 1, clip: base },
    { frame: frame('holding', 'break-a', 0), opacity: 1, clip: base },
    { frame: frame('holding', 'break-a'), opacity: 0, clip: base },
    { frame: frame('holding', 'break-a'), opacity: 1, clip: { ...base, appearance: { blendMode: 'normal', opacity: 0 } } }
  ];
  for (const sample of cases) {
    renderer.draw(item(sample.clip, sample.opacity), sample.frame);
    assert.equal(button.disabled, true); assert.equal(button.tabIndex, -1); assert.equal(button.style.pointerEvents, 'none');
    activate(button);
  }
  renderer.draw(item(base), frame('holding', 'break-a'));
  assert.equal(button.disabled, false);
  activate(button); await flush(); assert.equal(activations, 1);
  renderer.dispose();

  const stillOptions: RendererOptions = { signal: new AbortController().signal, still: true, onButtonActivate: async () => { activations += 1; } };
  const still = buttonRenderer(base, rootFor() as unknown as HTMLElement, { width: 800, height: 600 }, stillOptions);
  await still.prepare(); still.draw(item(base), frame('holding', 'break-a'));
  const stillButton = find(still.node as unknown as FakeElement, 'button')!;
  assert.equal(stillButton.dataset.stagecraftInteractive, undefined);
  assert.equal(stillButton.disabled, true); assert.equal(stillButton.tabIndex, -1);
  still.dispose();
});

test('composition shares a pending choice gate and reports failures without locking retries', async t => {
  installDocument(t);
  const first = base;
  const second: ButtonClip = { ...base, id: 'button-two', properties: { ...base.properties, label: 'Option B', action: {
    kind: 'choice', decisionId: 'decision', optionId: 'b', message: 'B', visibility: 'public'
  } } };
  const pending: { intent: { clipId: string; breakId?: string }; resolve(): void; reject(error: unknown): void }[] = [];
  const failures: unknown[] = [];
  const root = rootFor();
  const composition = new CompositionRenderer([first, second], root as unknown as HTMLElement, { width: 800, height: 600 }, {
    signal: new AbortController().signal,
    onButtonActivate: intent => new Promise<void>((resolve, reject) => pending.push({ intent, resolve, reject })),
    onInteractionError: error => failures.push(error)
  });
  await composition.prepare();
  composition.draw({ ...frame('holding', 'break-choice'), items: [item(first), item(second)] });
  const buttons = root.children.flatMap(child => child.children[0]?.children ?? []).map(child => child.children[0]!).filter(child => child.tagName === 'BUTTON');
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every(button => button.disabled === false));
  activate(buttons[0]!); await flush();
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0]!.intent, { clipId: first.id, breakId: 'break-choice' });
  assert.ok(buttons.every(button => button.disabled && button.tabIndex === -1 && button.getAttribute('aria-busy') === 'true'));
  activate(buttons[1]!); await flush(); assert.equal(pending.length, 1);
  pending[0]!.reject(new Error('host rejected action')); await flush();
  assert.equal(failures.length, 1);
  assert.ok(buttons.every(button => !button.disabled && button.getAttribute('aria-busy') === null));
  activate(buttons[1]!); await flush();
  assert.equal(pending.length, 2);
  pending[1]!.resolve(); await flush();
  assert.ok(buttons.every(button => button.disabled && button.getAttribute('aria-busy') === null), 'confirmed choice remains locked for its break');
  composition.draw({ ...frame('holding', 'break-next'), items: [item(first), item(second)] });
  assert.ok(buttons.every(button => !button.disabled), 'a later break becomes actionable');
  composition.dispose();
});

test('built-in and Foundry textures use static assets and one bounded image preparation', async t => {
  const { images } = installDocument(t);
  assert.deepEqual(BUTTON_TEXTURES.map(texture => texture.id), ['grain', 'diagonal', 'honeycomb', 'facets']);
  assert.ok(BUTTON_TEXTURES.every(texture => texture.path.startsWith('modules/stagecraft/assets/button-textures/')));
  const textured: ButtonClip = { ...base, properties: { ...base.properties, texture: { kind: 'builtin', id: 'grain' } } };
  const builtin = buttonRenderer(textured,
    rootFor() as unknown as HTMLElement, { width: 800, height: 600 }, { signal: new AbortController().signal });
  await builtin.prepare();
  assert.equal(images.length, 1); assert.equal(images[0]!.src, BUTTON_TEXTURES[0]!.path); assert.equal(images[0]!.decodeCalls, 1); assert.equal(images[0]!.srcAssignments, 1);
  assert.equal(images[0]!.style.visibility, 'visible');
  builtin.draw(item(textured), frame('holding', 'break-a'));
  builtin.dispose(); assert.equal(images[0]!.getAttribute('src'), null);

  assert.throws(() => buttonRenderer({ ...base, properties: { ...base.properties, texture: { kind: 'foundry-file', path: 'https://example.test/a.png', fit: 'cover' } } },
    rootFor() as unknown as HTMLElement, { width: 800, height: 600 }, { signal: new AbortController().signal }), /MEDIA_INVALID_PATH/);
});

test('font preparation falls back safely when a requested family is unavailable', async t => {
  const { images } = installDocument(t, { load: async () => [], check: () => false });
  const warnings: string[] = [];
  const clip: ButtonClip = { ...base, properties: { ...base.properties, fontFamily: 'Unavailable Display Face' } };
  const renderer = buttonRenderer(clip, rootFor() as unknown as HTMLElement, { width: 800, height: 600 }, {
    signal: new AbortController().signal, onWarning: code => warnings.push(code)
  });
  await renderer.prepare();
  const label = find(find(renderer.node as unknown as FakeElement, 'button')!, 'span')!;
  assert.equal(images.length, 0);
  assert.equal(label.style.fontFamily, 'sans-serif');
  assert.deepEqual(warnings, ['FONT_FALLBACK']);
  renderer.dispose();
});

test('resize projection recenters logical button geometry and disconnects on dispose', async t => {
  installDocument(t);
  const { observers } = installResizeObserver(t);
  const root = rootFor();
  const renderer = buttonRenderer(base, root as unknown as HTMLElement, { width: 800, height: 600 }, { signal: new AbortController().signal });
  await renderer.prepare();
  const stage = (renderer.node as unknown as FakeElement).children[0]!;
  assert.equal(stage.style.transform, 'scale(1)');
  root.contentSize = { width: 600, height: 400 };
  observers[0]!.deliver();
  assert.ok(Math.abs(Number.parseFloat(stage.style.left!) - 33.3333333333) < 1e-6);
  assert.equal(stage.style.top, '0px');
  assert.ok(Math.abs(Number.parseFloat(stage.style.transform!.slice('scale('.length)) - 2 / 3) < 1e-6);
  renderer.dispose();
  assert.equal(observers[0]!.disconnected, true);
});
