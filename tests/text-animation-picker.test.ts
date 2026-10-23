import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { TEXT_MOTION_PRESETS } from '../src/domain/text-motion.js';
import type { SolidClip, TextClip, Transition } from '../src/domain/sequence.js';
import { createTextAnimationPreview } from '../src/ui/text-animation-preview.js';
import { TextAnimationPicker, type TextAnimationPickerRuntime } from '../src/ui/text-animation-picker.js';
import { AnimationPicker, type AnimationPickerPreview } from '../src/ui/animation-picker.js';
import type { PlayerFrame } from '../src/playback/local-player.js';
import { evaluateTextMotion } from '../src/domain/text-motion.js';

class FakeDocument extends EventTarget {
  hidden = false;
  activeElement: FakeNode | null = null;
  readonly media = new FakeMotionPreference();
  readonly defaultView = {
    Event,
    getComputedStyle: (node: FakeNode) => ({ display: node.style.display, visibility: node.style.visibility }),
    matchMedia: () => this.media as unknown as MediaQueryList
  };
  createElement(tag: string) { return new FakeNode(tag, this); }
}

class FakeMotionPreference {
  matches = false;
  private readonly listeners = new Set<(event: { matches: boolean }) => void>();
  addEventListener(_type: string, listener: (event: { matches: boolean }) => void) { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: (event: { matches: boolean }) => void) { this.listeners.delete(listener); }
  set(matches: boolean) {
    this.matches = matches;
    for (const listener of this.listeners) listener({ matches });
  }
}

class FakeNode extends EventTarget {
  readonly children: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = {
    add: (value: string) => { if (!this.classList.contains(value)) this.className = [...this.className.split(/\s+/u).filter(Boolean), value].join(' '); },
    remove: (value: string) => { this.className = this.className.split(/\s+/u).filter(item => item && item !== value).join(' '); },
    contains: (value: string) => this.className.split(/\s+/u).includes(value)
  };
  parentElement: FakeNode | null = null;
  hidden = false; inert = false; disabled = false; removed = false;
  textContent = ''; className = ''; id = ''; name = ''; value = ''; type = ''; tabIndex = 0;
  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) { super(); }
  get options() { return this.children; }
  get isConnected(): boolean { return !this.removed && (!this.parentElement || this.parentElement.isConnected); }
  append(...children: FakeNode[]) {
    for (const child of children) {
      child.remove(); child.removed = false; child.parentElement = this; this.children.push(child);
    }
  }
  prepend(child: FakeNode) {
    child.remove(); child.removed = false; child.parentElement = this; this.children.unshift(child);
  }
  remove() {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
    }
    this.parentElement = null; this.removed = true;
  }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  removeAttribute(key: string) { this.attrs.delete(key); }
  contains(node: unknown): boolean { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    if (selector === ':disabled') return this.disabled || this.parentElement?.tagName === 'fieldset' && this.parentElement.disabled;
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[data-')) {
      const key = selector.slice(6, -1).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
      return key in this.dataset;
    }
    return selector === this.tagName;
  }
  querySelectorAll<T = FakeNode>(selector: string): T[] {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child as unknown as T] : []), ...child.querySelectorAll<T>(selector)
    ]);
  }
  querySelector<T = FakeNode>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new Event('focusin', { bubbles: true })); }
  scrollIntoView() {}
  override dispatchEvent(event: Event): boolean {
    if (!Object.hasOwn(event, 'target')) Object.defineProperty(event, 'target', { value: this });
    const accepted = super.dispatchEvent(event);
    if (event.bubbles && !event.cancelBubble) this.parentElement?.dispatchEvent(event);
    return accepted;
  }
}

class FakeIntersectionObserver {
  static readonly instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<FakeNode>();
  constructor(readonly callback: (entries: Array<{ target: FakeNode; isIntersecting: boolean }>) => void) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(node: FakeNode) { this.observed.add(node); }
  unobserve(node: FakeNode) { this.observed.delete(node); }
  disconnect() { this.observed.clear(); }
  show(nodes: FakeNode[], isIntersecting: boolean) {
    this.callback(nodes.map(target => ({ target, isIntersecting })));
  }
}

class FakeMutationObserver {
  static readonly instances: FakeMutationObserver[] = [];
  connected = true;
  constructor(readonly callback: (records: Array<{ target: FakeNode }>) => void) { FakeMutationObserver.instances.push(this); }
  observe() {}
  disconnect() { this.connected = false; }
}

interface RendererProbe {
  readonly clip: TextClip;
  readonly frames: PlayerFrame[];
  readonly draws: Array<{ itemId?: string; position: number }>;
  readonly removed: FakeNode;
  disposed: number;
}

const MOTION = 'text-motion:line-reveal';
const VALUES = ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom', ...TEXT_MOTION_PRESETS.map(preset => `text-motion:${preset.id}`)];
const EXIT: Transition = { preset: 'text-motion', version: 1, motion: 'line-reveal', durationMs: 720,
  easing: 'ease-in', amount: 1, stagger: 0.35 };

function fixture(t: TestContext, phase: 'entrance' | 'exit' = 'entrance') {
  const doc = new FakeDocument();
  FakeIntersectionObserver.instances.length = 0; FakeMutationObserver.instances.length = 0;
  let now = 0, serial = 0;
  const callbacks = new Map<number, (time: number) => void>();
  const probes: RendererProbe[] = [];
  const previewCalls: Array<{ value: string; phase: string; source?: Transition; sampleText?: string }> = [];
  const runtime: TextAnimationPickerRuntime = {
    now: () => now,
    requestFrame: callback => { callbacks.set(++serial, callback); return serial; },
    cancelFrame: id => { callbacks.delete(id); },
    createPreview: (value, previewPhase, source, sampleText) => {
      previewCalls.push({ value, phase: previewPhase, ...(source ? { source } : {}), ...(sampleText ? { sampleText } : {}) });
      return createTextAnimationPreview(value, previewPhase, source, sampleText);
    },
    createRenderer: (clip, parent) => {
      const fakeParent = parent as unknown as FakeNode;
      const removed = fakeParent.ownerDocument.createElement('renderer'); fakeParent.append(removed);
      const probe: RendererProbe = { clip, frames: [], draws: [], removed, disposed: 0 };
      probes.push(probe);
      return {
        prepare: async () => {},
        draw: (item, frame) => {
          probe.frames.push(frame);
          probe.draws.push({ ...(item ? { itemId: item.clip.id } : {}), position: frame.positionMs });
        },
        dispose: () => { probe.disposed++; removed.remove(); }
      };
    }
  };
  const globals: Record<string, unknown> = { document: doc, Element: FakeNode, HTMLElement: FakeNode,
    HTMLInputElement: FakeNode, HTMLSelectElement: FakeNode, HTMLTextAreaElement: FakeNode,
    IntersectionObserver: FakeIntersectionObserver, MutationObserver: FakeMutationObserver };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  setMaxListeners(100);
  t.after(() => {
    for (const [key, value] of originals) {
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
  });

  const root = doc.createElement('div'), host = doc.createElement('div'); root.append(host);
  const native = doc.createElement('label'); native.className = 'stagecraft-text-animation-select';
  const select = doc.createElement('select'); native.append(select); host.append(native);
  for (const value of VALUES) {
    const option = doc.createElement('option'); option.value = value; option.textContent = `Localized ${value}`; select.append(option);
  }
  select.value = phase === 'entrance' ? 'fade' : MOTION;
  const localizations: Record<string, string> = {
    'STAGECRAFT.Editor.AnimationIn': 'In', 'STAGECRAFT.Editor.AnimationOut': 'Out',
    'STAGECRAFT.Editor.TextAnimationCompare': 'Compare', 'STAGECRAFT.Editor.TextAnimationCollapse': 'Close comparison',
    'STAGECRAFT.Editor.TextAnimationSample': 'DEINE GESCHICHTE\nBEGINNT HIER'
  };
  const picker = new TextAnimationPicker(root as unknown as HTMLElement, host as unknown as HTMLElement,
    select as unknown as HTMLSelectElement, key => localizations[key] ?? key, phase, runtime);
  function show(nodes: FakeNode[], visible = true) { FakeIntersectionObserver.instances.at(-1)!.show(nodes, visible); }
  function click(node: FakeNode) { node.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
  function key(node: FakeNode, value: string) {
    const event = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value }); node.dispatchEvent(event);
  }
  function advance(time: number) {
    now = time; const pending = [...callbacks.values()]; callbacks.clear();
    for (const callback of pending) callback(time);
  }
  async function settle() { for (let index = 0; index < 4; index++) await Promise.resolve(); }
  return { doc, root, host, select, picker, runtime, callbacks, probes, previewCalls,
    show, click, key, advance, settle, cards: () => host.querySelectorAll<FakeNode>('.stagecraft-text-animation-choice') };
}

test('gallery preserves native option labels and only prepares the selected summary and visible cards', async t => {
  const stylesheet = readFileSync('styles/text-animation-picker.css', 'utf8');
  assert.match(stylesheet, /\.stagecraft-text-animation-miniature\s*\{[^}]*position\s*:\s*relative/s,
    'the renderer layer is contained by each miniature instead of the page');
  const f = fixture(t); f.picker.update({ preset: 'fade', version: 1, durationMs: 700, easing: 'ease-in-out' }, 'clip-a', false);
  const cards = f.cards();
  assert.equal(cards.length, 34);
  assert.deepEqual(cards.map(card => card.dataset.stagecraftTextAnimationValue), VALUES);
  assert.equal(cards[0]!.children[1]!.textContent, 'Localized none');
  assert.equal(f.probes.length, 0, 'a hidden tab does not create a summary renderer');

  f.show([f.host]); await f.settle();
  assert.equal(f.probes.length, 1, 'the selected collapsed thumbnail is the only prepared renderer');
  assert.deepEqual(f.previewCalls.map(call => call.value), ['fade']);
  assert.equal(f.previewCalls[0]!.sampleText, 'DEINE GESCHICHTE\nBEGINNT HIER');
  assert.equal(f.probes[0]!.frames.at(-1)!.items.length, 1);
  assert.equal(f.callbacks.size, 0, 'the summary thumbnail stays static');

  const toggle = f.host.querySelector<FakeNode>('.stagecraft-text-animation-toggle')!;
  f.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(f.probes.length, 1, 'opening does not eagerly build all 34 renderers');
  const visible = [cards[6]!, cards[7]!, cards[8]!]; f.show(visible);
  await f.settle();
  assert.equal(f.probes.length, 4, 'only three intersecting cards join the selected renderer');
  assert.equal(f.callbacks.size, 1, 'all visible cards share one animation clock');
  const before = f.probes.map(probe => probe.draws.length);
  f.advance(500);
  assert.ok(f.probes.some((probe, index) => probe.draws.length > before[index]!));
  const after = f.probes.map(probe => probe.draws.length);
  f.advance(510);
  assert.deepEqual(f.probes.map(probe => probe.draws.length), after, 'the shared clock draws at most 24 frames per second');
  f.advance(550);
  assert.ok(f.probes.some((probe, index) => probe.draws.length > after[index]!));
  const afterFrameLimit = f.probes.map(probe => probe.draws.length);
  f.show(visible, false);
  assert.equal(f.callbacks.size, 0, 'offscreen cards pause the shared clock');
  f.advance(2_000);
  assert.deepEqual(f.probes.map(probe => probe.draws.length), afterFrameLimit);

  f.show([cards[6]!]); f.advance(2_050);
  assert.equal(f.callbacks.size, 1, 'visible cards resume after scrolling back');
  f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.callbacks.size, 0, 'a hidden document cancels the frame');
  f.doc.hidden = false; f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.callbacks.size, 1);
  f.host.hidden = true;
  for (const observer of FakeMutationObserver.instances) if (observer.connected) observer.callback([{ target: f.host }]);
  assert.equal(f.callbacks.size, 0, 'a hidden inspector section pauses its renderer clock');
  f.host.hidden = false;
  for (const observer of FakeMutationObserver.instances) if (observer.connected) observer.callback([{ target: f.host }]);
  assert.equal(f.callbacks.size, 1);
  const priorClipProbes = [...f.probes];
  f.picker.update({ preset: 'fade', version: 1, durationMs: 700, easing: 'ease-in-out' }, 'clip-b', false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'identity changes close the gallery');
  assert.ok(priorClipProbes.every(probe => probe.disposed === 1), 'identity changes dispose the previous clip renderers');
  f.picker.dispose();
  assert.equal(f.callbacks.size, 0); assert.ok(f.probes.every(probe => probe.disposed === 1));
  assert.equal(FakeIntersectionObserver.instances.at(-1)!.observed.size, 0);
  assert.equal(FakeMutationObserver.instances.at(-1)!.connected, false);
});

test('opening and hovering are read-only; choosing dispatches one bubbled change and keyboard controls the listbox', async t => {
  const f = fixture(t); f.picker.update({ preset: 'fade', version: 1, durationMs: 700, easing: 'ease-in-out' }, 'clip', false);
  f.show([f.host]); await f.settle();
  let changes = 0, inputs = 0, bubbled = 0;
  f.select.addEventListener('change', () => changes++);
  f.select.addEventListener('input', () => inputs++);
  f.root.addEventListener('change', () => bubbled++);
  const toggle = f.host.querySelector<FakeNode>('.stagecraft-text-animation-toggle')!;
  f.key(toggle, 'ArrowDown');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(f.doc.activeElement, f.cards()[1], 'ArrowDown opens at the selected native value');
  f.key(f.cards()[1]!, 'Home'); assert.equal(f.doc.activeElement, f.cards()[0]);
  f.key(f.cards()[0]!, 'End'); assert.equal(f.doc.activeElement, f.cards().at(-1));
  f.cards()[10]!.dispatchEvent(new Event('mouseover', { bubbles: true }));
  assert.equal(changes, 0); assert.equal(inputs, 0); assert.equal(bubbled, 0);
  f.key(f.cards()[10]!, 'Enter');
  assert.equal(f.select.value, VALUES[10]);
  assert.equal(changes, 1); assert.equal(bubbled, 1); assert.equal(inputs, 0);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the gallery stays open for comparison');
  f.key(f.cards()[10]!, 'Enter');
  assert.equal(changes, 1, 'reselecting the current option does not create an extra form edit');
  f.key(f.cards()[10]!, 'Escape');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.equal(f.doc.activeElement, toggle);
  assert.equal(changes, 1, 'open and close never dispatch form changes');
  f.picker.update({ preset: 'fade', version: 1, durationMs: 700, easing: 'ease-in-out' }, 'clip', true);
  assert.equal(toggle.disabled, true, 'a locked track disables the custom control');
  f.click(toggle); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(changes, 1, 'a disabled control cannot mutate the native form');
});

test('exit gallery passes the out phase to the production evaluator and avoids the empty half-open endpoint', async t => {
  const f = fixture(t, 'exit'); f.picker.update(EXIT, 'clip-out', false);
  f.show([f.host]); await f.settle();
  assert.equal(f.previewCalls[0]!.value, MOTION);
  assert.equal(f.previewCalls[0]!.phase, 'exit');
  assert.deepEqual(f.previewCalls[0]!.source, EXIT);
  const preview = createTextAnimationPreview(MOTION, 'exit', EXIT, 'OUT TEST');
  const frame = preview.frameAt(0.34);
  assert.equal(frame.items.length, 1);
  assert.equal(frame.items[0]!.textMotion?.exit?.progress, 0.34);
  const exitTransition = frame.items[0]!.textMotion?.exit?.transition;
  assert.equal(exitTransition?.preset, 'text-motion');
  if (exitTransition?.preset !== 'text-motion') throw new Error('Expected text motion in the exit frame');
  assert.equal(exitTransition.motion, 'line-reveal');
  assert.equal(frame.items[0]!.textMotion?.entrance, undefined);
  assert.equal(preview.frameAt(1).items.length, 0, 'production Out reaches its half-open endpoint');
  const reversed = evaluateTextMotion('line-reveal', 0.34, 0, 5, 1, 0.35, 'ease-in', { phase: 'exit' });
  const forward = evaluateTextMotion('line-reveal', 0.34, 0, 5, 1, 0.35, 'ease-in', { phase: 'entrance' });
  assert.notDeepEqual(reversed, forward, 'the exit phase evaluates the authored motion backwards');

  f.click(f.host.querySelector<FakeNode>('.stagecraft-text-animation-toggle')!);
  f.show([f.cards()[6]!]); await f.settle();
  assert.equal(f.callbacks.size, 1, 'the opened out gallery animates its visible card');
  f.doc.media.set(true); await f.settle();
  assert.equal(f.callbacks.size, 0, 'reduced motion keeps a fixed sample frame');
  const drawn = f.probes[0]!.draws.length;
  f.advance(500); assert.equal(f.probes[0]!.draws.length, drawn);
  f.picker.dispose();
});

test('generic gallery accepts a non-text clip factory and forwards the selected transition phase', async t => {
  const f = fixture(t);
  const host = f.doc.createElement('div'); f.root.append(host);
  const select = f.doc.createElement('select'); host.append(select);
  for (const value of ['solid:none', 'solid:fade']) {
    const option = f.doc.createElement('option'); option.value = value; option.textContent = `Localized ${value}`; select.append(option);
  }
  select.value = 'solid:fade';
  const clip: SolidClip = {
    id: 'solid-preview', trackId: 'preview-track', type: 'solid', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 721 },
    entrance: { preset: 'none', version: 1 }, exit: EXIT,
    properties: { fit: 'contain', box: { x: 0, y: 0, width: 640, height: 320 },
      crop: { x: 0, y: 0, width: 1, height: 1 },
      mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], color: '#ff0000' }
  };
  const previewCalls: Array<{ value: string; phase: string; source?: Transition }> = [];
  const rendererClips: Array<SolidClip> = [];
  const drawn: number[] = [];
  const picker = new AnimationPicker<SolidClip, AnimationPickerPreview<SolidClip>>(
    f.root as unknown as HTMLElement, host as unknown as HTMLElement, select as unknown as HTMLSelectElement,
    key => key, 'exit', {
      previewSize: { width: 640, height: 320 },
      scheduler: f.runtime,
      createPreview: (value, phase, source) => {
        previewCalls.push({ value, phase, ...(source ? { source } : {}) });
        return { clip, frameAt: () => ({ positionMs: 0, items: [], opacity: 1, phase: 'playing' }) };
      },
      createRenderer: receivedClip => {
        rendererClips.push(receivedClip);
        return { prepare: async () => {}, draw: (_item, frame) => drawn.push(frame.positionMs), dispose: () => {} };
      }
    });
  picker.update(EXIT, 'solid-clip', false);
  f.show([host]); await f.settle();
  assert.deepEqual(previewCalls, [{ value: 'solid:fade', phase: 'exit', source: EXIT }]);
  assert.deepEqual(rendererClips, [clip]);
  assert.equal(drawn.length, 1, 'the generic preview frame is sent through its injected renderer');
  picker.dispose();
  f.picker.dispose();
});
