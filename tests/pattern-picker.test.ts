import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { createAnimatedPattern, ANIMATED_PATTERN_PRESETS, getAnimatedPatternSettings, type AnimatedPattern } from '../src/domain/animated-pattern.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import type { SolidClip, SequenceV1 } from '../src/domain/sequence.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { LocalPlayer } from '../src/playback/local-player.js';
import { PatternPicker, type PatternPickerRuntime } from '../src/ui/pattern-picker.js';
import { animatedPatternRenderer } from '../src/rendering/animated-pattern-renderer.js';

class FakeDocument extends EventTarget {
  hidden = false;
  styleReads = 0;
  activeElement: Node | null = null;
  readonly defaultView: { Event: typeof Event; getComputedStyle: (node: Node) => { display: string | undefined; visibility: string | undefined };
    matchMedia?: (query: string) => FakeMediaQueryList } = {
      Event, getComputedStyle: (node: Node) => {
        this.styleReads++; return { display: node.style.display, visibility: node.style.visibility };
      }
    };
  createElement(tag: string) { return new Node(tag, this); }
  createElementNS(_namespace: string, tag: string) { return new Node(tag, this); }
}
class Node extends EventTarget {
  readonly children: Node[] = [];
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = { toggle() {}, add() {}, remove() {} };
  parentElement: Node | null = null;
  hidden = false; inert = false; disabled = false; checked = false; removed = false;
  min = ''; max = ''; step = ''; required = false; readOnly = false;
  readonly captured = new Set<number>();
  textContent = ''; className = ''; id = ''; name = ''; value = ''; type = ''; title = ''; tabIndex = 0;
  attributeWrites = 0;
  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) { super(); }
  get options() { return this.children; }
  get isConnected(): boolean { return !this.removed && (!this.parentElement || this.parentElement.isConnected); }
  append(...children: Node[]) { for (const child of children) { child.remove(); child.removed = false; child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children: Node[]) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; this.removed = true; }
  setAttribute(key: string, value: string) { this.attributeWrites++; this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  removeAttribute(key: string) { this.attrs.delete(key); }
  contains(node: unknown): boolean { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(item => this.matches(item));
    if (selector.includes(' ')) {
      const [ancestor, child] = selector.split(' ');
      return this.matches(child!) && !!this.parentElement?.closest(ancestor!);
    }
    if (selector === ':disabled') return this.disabled || this.parentElement?.tagName === 'fieldset' && this.parentElement.disabled;
    if (selector === '[name]') return !!this.name;
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const match = selector.match(/^(?:(\w+))?\[([^=\]]+)(?:="([^"]+)")?\]$/);
    if (!match) return selector === this.tagName;
    if (match[1] && match[1] !== this.tagName) return false;
    if (match[2] === 'name') return this.name === match[3];
    if (match[2] === 'type') return this.type === match[3];
    if (match[2]!.startsWith('data-')) {
      const key = match[2]!.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return key in this.dataset && (match[3] === undefined || this.dataset[key] === match[3]);
    }
    return this.attrs.has(match[2]!) && (match[3] === undefined || this.attrs.get(match[2]!) === match[3]);
  }
  querySelectorAll<T = Node>(selector: string): T[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child as unknown as T] : []), ...child.querySelectorAll<T>(selector)]);
  }
  querySelector<T = Node>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  closest<T = Node>(selector: string): T | null { return this.matches(selector) ? this as unknown as T : this.parentElement?.closest<T>(selector) ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { this.ownerDocument.activeElement = null; }
  select() {} scrollIntoView() {}
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) { this.captured.delete(id); }
  checkValidity() {
    if (this.disabled) return true;
    if (this.required && !this.value) return false;
    if (this.type !== 'number' || !this.value) return true;
    const value = Number(this.value), minimum = this.min === '' ? -Infinity : Number(this.min);
    if (!Number.isFinite(value) || value < minimum || this.max !== '' && value > Number(this.max)) return false;
    return !this.step || this.step === 'any' || Math.abs((value - (Number.isFinite(minimum) ? minimum : 0)) / Number(this.step)
      - Math.round((value - (Number.isFinite(minimum) ? minimum : 0)) / Number(this.step))) < 1e-8;
  }
  override dispatchEvent(event: Event): boolean {
    if (!Object.hasOwn(event, 'target')) Object.defineProperty(event, 'target', { value: this });
    const accepted = super.dispatchEvent(event);
    if (event.bubbles && !event.cancelBubble) this.parentElement?.dispatchEvent(event);
    return accepted;
  }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const signature = (node: Node): string => JSON.stringify(all(node).map(item => [...item.attrs]));

class FakeMediaQueryList {
  private readonly listeners = new Set<(event: MediaQueryListEvent) => void>();
  constructor(public matches: boolean) {}
  addEventListener(type: string, listener: ((event: MediaQueryListEvent) => void) | null,
    options?: AddEventListenerOptions): void {
    if (type !== 'change' || !listener) return;
    this.listeners.add(listener);
    options?.signal?.addEventListener('abort', () => this.listeners.delete(listener), { once: true });
  }
  setMatches(matches: boolean): void {
    this.matches = matches;
    for (const listener of [...this.listeners]) listener({ matches } as MediaQueryListEvent);
  }
  get listenerCount(): number { return this.listeners.size; }
}

function fixture(t: TestContext, prefersReducedMotion?: boolean) {
  const doc = new FakeDocument();
  const media = prefersReducedMotion === undefined ? undefined : new FakeMediaQueryList(prefersReducedMotion);
  if (media) doc.defaultView.matchMedia = () => media;
  let now = 0, serial = 0;
  const callbacks = new Map<number, (time: number) => void>();
  const runtime: PatternPickerRuntime = { now: () => now,
    requestFrame: callback => { callbacks.set(++serial, callback); return serial; }, cancelFrame: id => { callbacks.delete(id); } };
  class Intersection {
    static instances: Intersection[] = [];
    readonly observed = new Set<Node>();
    constructor(readonly callback: (entries: Array<{ target: Node; isIntersecting: boolean }>) => void) { Intersection.instances.push(this); }
    observe(node: Node) { this.observed.add(node); }
    unobserve(node: Node) { this.observed.delete(node); }
    disconnect() { this.observed.clear(); }
    show(nodes: Node[], visible: boolean) { this.callback(nodes.map(target => ({ target, isIntersecting: visible }))); }
  }
  class Mutation {
    static instances: Mutation[] = [];
    connected = true;
    constructor(readonly callback: (records: Array<{ target: Node }>) => void) { Mutation.instances.push(this); }
    observe() {} disconnect() { this.connected = false; }
  }
  const globals = { document: doc, Element: Node, HTMLElement: Node, HTMLInputElement: Node, HTMLSelectElement: Node,
    HTMLTextAreaElement: Node, IntersectionObserver: Intersection, MutationObserver: Mutation,
    requestAnimationFrame: runtime.requestFrame, cancelAnimationFrame: runtime.cancelFrame };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  setMaxListeners(100);
  t.after(() => { for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
  } });
  const root = doc.createElement('div'), category = doc.createElement('section'), host = doc.createElement('div');
  category.dataset.stagecraftClipSectionPage = 'content'; host.dataset.stagecraftPatternPicker = '';
  const select = doc.createElement('select'); select.name = 'solid-pattern-preset';
  root.append(category); category.append(host); host.append(select);
  function advance(time: number) { now = time; const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(time); }
  function click(node: Node) { node.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
  function key(node: Node, key: string) {
    const event = new Event('keydown', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'key', { value: key }); node.dispatchEvent(event);
  }
  return { doc, root, category, host, select, runtime, callbacks, advance, click, key, media,
    show: (nodes: Node[], visible = true) => Intersection.instances[0]!.show(nodes, visible),
    mutate: (targets = [root]) => Mutation.instances.forEach(observer => { if (observer.connected) observer.callback(targets.map(target => ({ target }))); }),
    observers: Intersection.instances, mutations: Mutation.instances };
}

test('reduced motion keeps useful still frames and does not start a comparison clock', t => {
  const f = fixture(t, true), settings = createAnimatedPattern('radial-burst');
  const picker = new PatternPicker(f.root as unknown as HTMLElement, f.host as unknown as HTMLElement,
    f.select as unknown as HTMLSelectElement, key => key, f.runtime);
  t.after(() => picker.dispose()); f.select.value = settings.preset;
  picker.update(settings, 'clip', false, 900, 300);
  const svg = f.host.querySelector('.stagecraft-pattern-summary-preview')!.querySelector<Node>('svg')!;
  const pattern = svg.children[0]!.children[0]!;
  const reference = animatedPatternRenderer(pattern.getAttribute('id')!, settings, 900, 300);
  reference.draw(1000);
  assert.deepEqual(signature(pattern), signature(reference.node as unknown as Node), 'summary uses a representative still frame');
  reference.draw(0);
  assert.notDeepEqual(signature(pattern), signature(reference.node as unknown as Node), 'still frame shows the pattern beyond its initial pose');
  reference.dispose();
  assert.equal(f.callbacks.size, 0);

  const choices = f.host.querySelectorAll<Node>('[data-stagecraft-pattern-preset]');
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!); f.show([f.host, ...choices]);
  assert.equal(f.callbacks.size, 0, 'opening the gallery does not schedule animation');
  assert.ok(choices.every(choice => all(choice).some(node => node.tagName === 'pattern')));
  let changes = 0; f.select.addEventListener('change', () => { changes++; });
  f.click(choices.find(choice => choice.dataset.stagecraftPatternPreset === 'confetti')!);
  assert.equal(f.select.value, 'confetti', 'reduced motion leaves pattern selection available');
  assert.equal(changes, 1); assert.equal(f.callbacks.size, 0);
});

test('reduced-motion changes stop and resume previews, then detach their listener on disposal', t => {
  const f = fixture(t, false), settings = createAnimatedPattern('radial-burst');
  const picker = new PatternPicker(f.root as unknown as HTMLElement, f.host as unknown as HTMLElement,
    f.select as unknown as HTMLSelectElement, key => key, f.runtime);
  f.select.value = settings.preset; picker.update(settings, 'clip', false, 900, 300);
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!);
  const choices = f.host.querySelectorAll<Node>('[data-stagecraft-pattern-preset]'); f.show([f.host, ...choices]);
  assert.equal(f.callbacks.size, 1, 'no-preference mode keeps the animated comparison');
  f.advance(2000); assert.equal(f.callbacks.size, 1);

  f.media!.setMatches(true);
  assert.equal(f.callbacks.size, 0, 'enabling reduced motion cancels the pending frame');
  const selected = choices.find(choice => choice.dataset.stagecraftPatternPreset === settings.preset)!;
  const pattern = selected.querySelector<Node>('svg')!.children[0]!.children[0]!;
  const reference = animatedPatternRenderer(pattern.getAttribute('id')!, settings, 900, 300);
  reference.draw(1000);
  assert.deepEqual(signature(pattern), signature(reference.node as unknown as Node), 'preference changes paint the stable still frame');
  reference.dispose();

  f.media!.setMatches(false);
  assert.equal(f.callbacks.size, 1, 'turning reduced motion off resumes the comparison clock');
  assert.equal(f.media!.listenerCount, 1);
  picker.dispose();
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.media!.listenerCount, 0, 'dispose aborts the media preference listener');
  f.media!.setMatches(true);
  assert.equal(f.callbacks.size, 0, 'a disposed picker cannot resume from a later preference change');
});

test('picker compares every catalog SVG design using authored palette and settings, with one capped clock', t => {
  const f = fixture(t), settings = { ...createAnimatedPattern(), colors: ['#123456', '#abcdef', '#fedcba'] as const, speed: 1.8, density: 2, scale: 0.7, direction: 42, intensity: 0.8, reverse: true, seed: 49 };
  const picker = new PatternPicker(f.root as unknown as HTMLElement, f.host as unknown as HTMLElement,
    f.select as unknown as HTMLSelectElement, key => key, f.runtime);
  t.after(() => picker.dispose()); f.select.value = settings.preset;
  picker.update(settings, 'clip-a', false, 900, 300);
  const choices = f.host.querySelectorAll<Node>('[data-stagecraft-pattern-preset]');
  assert.equal(choices.length, 22);
  assert.deepEqual(choices.map(choice => choice.dataset.stagecraftPatternPreset), ANIMATED_PATTERN_PRESETS.map(preset => preset.id));
  assert.equal(f.callbacks.size, 0, 'collapsed preview owns no clock');
  for (const choice of choices) {
    const svg = all(f.host).find(node => node.tagName === 'svg' && node.children[0]?.children[0]?.getAttribute('id')?.endsWith(choice.dataset.stagecraftPatternPreset!))!;
    assert.equal(svg.getAttribute('viewBox'), '0 0 900 300');
    const fills = all(svg).flatMap(node => [...node.attrs.values()]);
    for (const color of settings.colors) assert.ok(fills.includes(color), `${choice.dataset.stagecraftPatternPreset} preserves ${color}`);
  }
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!); f.show([f.host, ...choices]);
  assert.equal(f.callbacks.size, 1);
  const before = choices.map(signature); f.advance(1000);
  for (const [index, choice] of choices.entries()) assert.notEqual(signature(choice), before[index], choice.dataset.stagecraftPatternPreset);
  const firstFrame = choices.map(signature); f.advance(1010);
  assert.deepEqual(choices.map(signature), firstFrame, 'frames closer than 1/24 second do not draw');
  f.advance(1050); assert.notDeepEqual(choices.map(signature), firstFrame);
  f.show(choices.slice(0, 15), false); const hidden = choices.slice(0, 15).map(signature); f.advance(1100);
  assert.deepEqual(choices.slice(0, 15).map(signature), hidden, 'offscreen cards stop drawing');
  f.show(choices.slice(15), false); assert.equal(f.callbacks.size, 0, 'no visible cards means no pending RAF');
  f.show([choices[0]!]); assert.equal(f.callbacks.size, 1);
  picker.update({ ...settings, colors: ['#654321', '#aabbcc', '#445566'], speed: 0 }, 'clip-a', false, 900, 300);
  assert.equal(f.callbacks.size, 0, 'speed zero is static');
  assert.ok(all(f.host).some(node => node.getAttribute('fill') === '#654321'));
});

test('collapsed palette edits redraw only the summary and reconcile the retained gallery before opening', t => {
  const f = fixture(t), settings = createAnimatedPattern();
  const picker = new PatternPicker(f.root as unknown as HTMLElement, f.host as unknown as HTMLElement,
    f.select as unknown as HTMLSelectElement, key => key, f.runtime);
  t.after(() => picker.dispose()); picker.update(settings, 'clip', false, 900, 300);
  const choices = f.host.querySelectorAll<Node>('[data-stagecraft-pattern-preset]');
  const summary = f.host.querySelector('.stagecraft-pattern-summary-preview')!;
  const summarySvg = summary.children[0]!;
  const gallerySvgs = choices.flatMap(choice => choice.querySelectorAll<Node>('svg'));
  const retainedNodes = gallerySvgs.flatMap(all);
  const writes = (nodes: Node[]) => nodes.reduce((sum, node) => sum + node.attributeWrites, 0);
  const beforeGallery = writes(retainedNodes), beforeSummary = writes(all(summarySvg));
  let latest = settings;
  for (let index = 1; index <= 20; index++) {
    latest = { ...settings, colors: [`#${index.toString(16).padStart(6, '0')}`, '#aabbcc', '#445566'] };
    picker.update(latest, 'clip', false, 900, 300);
  }
  const galleryWrites = writes(retainedNodes) - beforeGallery;
  const summaryWrites = writes(all(summarySvg)) - beforeSummary;
  t.diagnostic(`20 collapsed palette updates: hidden gallery SVG attribute writes=${galleryWrites}, selected summary=${summaryWrites}`);
  assert.equal(galleryWrites, 0, 'all 21 hidden gallery renderers remain untouched');
  assert.ok(summaryWrites > 0, 'selected summary follows the live palette');
  assert.equal(f.callbacks.size, 0);
  const sameBefore = writes(all(f.host));
  picker.update(latest, 'clip', false, 900, 300); picker.update(latest, 'clip', false, 900, 300);
  assert.equal(writes(all(f.host)), sameBefore, 'duplicate inspector refreshes write no attributes');
  assert.deepEqual(gallerySvgs.flatMap(all), retainedNodes, 'palette edits retain SVG nodes');
  picker.update(latest, 'clip', false, 800, 400);
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!);
  for (const svg of [summarySvg, ...gallerySvgs]) {
    assert.equal(svg.getAttribute('viewBox'), '0 0 800 400');
    assert.ok(all(svg).some(node => [...node.attrs.values()].includes(latest.colors[0])));
  }
  assert.equal(choices[0]!.querySelector('svg'), summarySvg);
  assert.deepEqual(gallerySvgs.flatMap(all), retainedNodes, 'opening reuses the gallery');
});

test('open offscreen and hidden-inspector cards defer updates and catch up when revealed even at speed zero', t => {
  const f = fixture(t), settings = { ...createAnimatedPattern(), speed: 0 };
  const picker = new PatternPicker(f.root as unknown as HTMLElement, f.host as unknown as HTMLElement,
    f.select as unknown as HTMLSelectElement, key => key, f.runtime);
  t.after(() => picker.dispose()); picker.update(settings, 'clip', false);
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!);
  const choices = f.host.querySelectorAll<Node>('[data-stagecraft-pattern-preset]');
  f.show([f.host, choices[0]!]);
  const hiddenSvg = choices[1]!.querySelector<Node>('svg')!;
  const writes = () => all(hiddenSvg).reduce((sum, node) => sum + node.attributeWrites, 0);
  const before = writes();
  const changed = { ...settings, colors: ['#135790', '#246801', '#abcdef'] as const };
  picker.update(changed, 'clip', false);
  assert.equal(writes(), before, 'offscreen card is untouched while open');
  f.show([choices[1]!]);
  assert.ok(writes() > before);
  assert.ok(all(hiddenSvg).some(node => node.getAttribute('fill') === '#135790'));
  f.category.hidden = true; f.mutate([f.category]);
  const beforeHiddenInspector = writes();
  picker.update({ ...changed, colors: ['#987654', '#246801', '#abcdef'] }, 'clip', false);
  assert.equal(writes(), beforeHiddenInspector, 'hidden inspector suppresses gallery work');
  f.category.hidden = false; f.mutate([f.category]);
  assert.ok(writes() > beforeHiddenInspector);
  assert.ok(all(hiddenSvg).some(node => node.getAttribute('fill') === '#987654'));
  assert.equal(f.callbacks.size, 0, 'static previews need no animation frame to catch up');
});

test('renderer mutations do not trigger picker visibility style reads', t => {
  const f = fixture(t), picker = new PatternPicker(f.root as unknown as HTMLElement, f.host as unknown as HTMLElement,
    f.select as unknown as HTMLSelectElement, key => key, f.runtime);
  t.after(() => picker.dispose()); picker.update(createAnimatedPattern(), 'clip', false);
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!);
  f.show([f.host, ...f.host.querySelectorAll<Node>('[data-stagecraft-pattern-preset]')]);
  const before = f.doc.styleReads;
  f.mutate(f.host.querySelectorAll('svg'));
  assert.equal(f.doc.styleReads, before, 'SVG descendant styles cannot change picker eligibility');
  f.select.disabled = true; f.mutate([f.select]);
  assert.equal(f.callbacks.size, 0, 'select disabled mutations remain observed');
  f.select.disabled = false; f.mutate([f.select]);
  f.root.style.display = 'none'; f.mutate([f.root]);
  assert.equal(f.callbacks.size, 0, 'ancestor visibility mutations remain observed');
});

test('hidden category, inspector, browser tab, locks, selection changes and disposal cancel and resume only eligible previews', t => {
  const f = fixture(t), picker = new PatternPicker(f.root as unknown as HTMLElement, f.host as unknown as HTMLElement,
    f.select as unknown as HTMLSelectElement, key => key, f.runtime), settings = createAnimatedPattern();
  picker.update(settings, 'clip-a', false); const choices = f.host.querySelectorAll<Node>('[data-stagecraft-pattern-preset]');
  const toggle = f.host.querySelector('.stagecraft-pattern-toggle')!; f.click(toggle); f.show([f.host, ...choices]);
  for (const hidden of [f.category, f.root]) {
    hidden.hidden = true; f.mutate(); assert.equal(f.callbacks.size, 0);
    hidden.hidden = false; f.mutate(); assert.equal(f.callbacks.size, 1);
  }
  f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(f.callbacks.size, 0);
  f.doc.hidden = false; f.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(f.callbacks.size, 1);
  f.root.style.display = 'none'; f.mutate(); assert.equal(f.callbacks.size, 0);
  f.root.style.display = ''; f.mutate(); assert.equal(f.callbacks.size, 1);
  f.select.disabled = true; f.mutate(); assert.equal(f.callbacks.size, 0);
  f.select.disabled = false; f.mutate(); assert.equal(f.callbacks.size, 1);
  picker.update(settings, 'clip-a', true); assert.equal(f.callbacks.size, 0); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  picker.update(settings, 'clip-a', false); f.click(toggle); assert.equal(f.callbacks.size, 1);
  const stale = choices[5]!; picker.update(settings, 'clip-b', false); assert.equal(f.callbacks.size, 0);
  f.click(toggle); f.show([f.host, ...f.host.querySelectorAll<Node>('[data-stagecraft-pattern-preset]')]);
  f.select.value = settings.preset; f.click(stale); assert.equal(f.select.value, settings.preset, 'detached previous selection cannot change new clip');
  const nodes = all(f.host); picker.dispose(); assert.equal(f.callbacks.size, 0);
  assert.equal(f.observers[0]!.observed.size, 0); assert.equal(f.mutations[0]!.connected, false);
  f.mutate(); f.doc.dispatchEvent(new Event('visibilitychange')); f.advance(5000); assert.equal(f.callbacks.size, 0);
  assert.ok(nodes.filter(node => node.tagName === 'pattern').every(node => !node.isConnected));
});

test('keyboard navigates labeled options without choosing until Enter/Space and Escape collapses', t => {
  const f = fixture(t), settings = createAnimatedPattern(); f.select.value = settings.preset;
  const picker = new PatternPicker(f.root as unknown as HTMLElement, f.host as unknown as HTMLElement,
    f.select as unknown as HTMLSelectElement, key => key, f.runtime); t.after(() => picker.dispose()); picker.update(settings, 'clip', false);
  const toggle = f.host.querySelector('.stagecraft-pattern-toggle')!, choices = f.host.querySelectorAll<Node>('[data-stagecraft-pattern-preset]');
  let changes = 0; f.select.addEventListener('change', () => { changes++; });
  f.key(toggle, 'ArrowDown'); assert.equal(f.doc.activeElement, choices[0]);
  f.key(choices[0]!, 'ArrowDown'); assert.equal(f.doc.activeElement, choices[2]); assert.equal(changes, 0);
  f.key(choices[2]!, 'End'); assert.equal(f.doc.activeElement, choices[21]);
  f.key(choices[18]!, 'Home'); assert.equal(f.doc.activeElement, choices[0]);
  f.key(choices[0]!, 'ArrowRight'); f.key(choices[1]!, 'Enter'); assert.equal(changes, 1); assert.equal(f.select.value, 'speed-lines');
  f.key(choices[1]!, 'End'); assert.equal(f.doc.activeElement, choices[21]);
  f.key(choices[21]!, 'Enter'); assert.equal(changes, 2); assert.equal(f.select.value, 'iridescent-field');
  f.key(choices[21]!, ' '); assert.equal(changes, 2, 'reselecting current option creates no change');
  f.key(choices[21]!, 'Escape'); assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.equal(f.doc.activeElement, toggle);
  assert.equal(choices.every(choice => choice.getAttribute('role') === 'option' && !!choice.querySelector('.stagecraft-pattern-choice-label')?.textContent), true);
});

test('legacy selections compare the new Halftone and Energy recipes without changing their saved settings', t => {
  const f = fixture(t), legacy: AnimatedPattern = { ...createAnimatedPattern(), preset: 'halftone' };
  const before = structuredClone(legacy);
  const picker = new PatternPicker(f.root as unknown as HTMLElement, f.host as unknown as HTMLElement,
    f.select as unknown as HTMLSelectElement, key => key, f.runtime); t.after(() => picker.dispose());
  picker.update(legacy, 'legacy', false, 900, 300);
  for (const preset of ['halftone', 'energy-trails'] as const) {
    const card = f.host.querySelector<Node>(`[data-stagecraft-pattern-preset="${preset}"]`)!;
    const svg = all(card).find(node => node.tagName === 'svg') ?? all(f.host.querySelector('.stagecraft-pattern-summary-preview')!).find(node => node.tagName === 'svg')!;
    const node = svg.children[0]!.children[0]!;
    const reference = animatedPatternRenderer(node.getAttribute('id')!, {
      ...legacy, ...createAnimatedPattern(preset), colors: legacy.colors, intensity: legacy.intensity, seed: legacy.seed,
    }, 900, 300);
    assert.equal(signature(node), signature(reference.node as unknown as Node), `${preset} card shows the new recipe`);
    reference.dispose();
  }
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!);
  assert.deepEqual(legacy, before);
});

test('actual editor picker change preserves authored data, validates the normal form path and creates exactly one Undo', async t => {
  const f = fixture(t); f.category.dataset.stagecraftElementPanel = 'solid';
  let counter = 0; const makeId = () => `picker-${++counter}`;
  const base = createBarsSequence('Compare patterns', makeId);
  const clip: SolidClip = { ...base.clips[0]!, type: 'solid', typeVersion: 2,
    duration: { kind: 'fixed', milliseconds: 5000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { color: '#000000', fit: 'contain', box: { x: 11, y: 22, width: 900, height: 300 },
      crop: { x: 0, y: 0, width: 1, height: 1 }, mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      pattern: { ...createAnimatedPattern('floating-dots'), colors: ['#112233', '#445566', '#778899'], density: 2.2, speed: 1.9, scale: 1.5, direction: 30, reverse: true, seed: 88 },
      outline: { enabled: true, color: '#ffffff', opacity: 1, width: 3 } } };
  const sequence: SequenceV1 = validateSequence({ ...base, clips: [clip], end: { kind: 'fixed', durationMs: 5000 } });
  const field = (name: string, type = 'number', parent = f.root) => {
    const input = f.doc.createElement(type === 'select' ? 'select' : 'input'); input.name = name; input.type = type; parent.append(input); return input;
  };
  const inspector = f.doc.createElement('fieldset'); inspector.dataset.stagecraftInspector = ''; f.root.append(inspector);
  inspector.append(f.category);
  field('ending', 'select'); field('sequence-duration'); field('clip-track', 'select');
  field('solid-start'); field('solid-duration-mode', 'select'); field('solid-duration');
  field('solid-entrance-preset', 'select'); field('solid-exit-preset', 'select');
  for (const suffix of ['speed', 'scale', 'density', 'direction', 'intensity']) field('solid-pattern-' + suffix, 'number', f.category);
  for (const index of [0, 1, 2]) field(`solid-pattern-color-${index}`, 'color', f.category);
  field('solid-pattern-reverse', 'checkbox', f.category); field('solid-pattern-onBreak', 'select', f.category);
  const services: EditorServices = { makeId, repository: { list: async () => [sequence], read: async () => sequence, save: async value => value, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }), localize: key => key,
    confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {}, prepareGroup: async () => {},
    openSession() {}, groupActive: () => false, chooseVideo: async () => null, requestAudioUnlock: async () => {} };
  const view = new EditorView(services); await view.mount(f.root as unknown as HTMLElement); t.after(() => view.detach());
  const before = view.draft.draft!;
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!); assert.deepEqual(view.draft.draft, before); assert.equal(view.draft.canUndo, false);
  const card = f.host.querySelector<Node>('[data-stagecraft-pattern-preset="iridescent-field"]')!; f.click(card);
  const changed = view.draft.draft!; const updated = changed.clips[0] as SolidClip;
  assert.deepEqual(updated, { ...before.clips[0], properties: { ...clip.properties, pattern: { ...clip.properties.pattern!, preset: 'iridescent-field' } } });
  assert.equal(card.getAttribute('aria-selected'), 'true'); assert.equal(view.draft.canUndo, true);
  assert.deepEqual(view.draft.undo(), before); assert.equal(view.draft.canUndo, false);
  assert.deepEqual(view.draft.redo(), changed);
  const locked = { ...changed, tracks: changed.tracks.map(track => ({ ...track, locked: true })) }; view.draft.replace(locked);
  (view as unknown as { paint(): void }).paint();
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!); f.click(f.host.querySelector('[data-stagecraft-pattern-preset="confetti"]')!);
  assert.deepEqual(view.draft.draft, locked);
});

test('editor retains hidden named select and both locale bundles define comparison controls', () => {
  const template = readFileSync('templates/editor.hbs', 'utf8');
  assert.match(template, /data-stagecraft-pattern-picker/); assert.match(template, /<select name="solid-pattern-preset"[^>]*hidden[^>]*>/);
  const packTwoLabels = {
    en: { 'STAGECRAFT.AnimatedSurface.Pattern.Aurora': 'Aurora', 'STAGECRAFT.AnimatedSurface.Pattern.SilkFlow': 'Silk flow', 'STAGECRAFT.AnimatedSurface.Pattern.IridescentField': 'Iridescent fields' },
    de: { 'STAGECRAFT.AnimatedSurface.Pattern.Aurora': 'Aurora', 'STAGECRAFT.AnimatedSurface.Pattern.SilkFlow': 'Seidenfluss', 'STAGECRAFT.AnimatedSurface.Pattern.IridescentField': 'Irisierende Farbfelder' },
  } as const;
  for (const language of ['en', 'de'] as const) {
    const locale = JSON.parse(readFileSync(`lang/${language}.json`, 'utf8')) as Record<string, string>;
    const parameterLabels = (['halftone', 'energy-trails'] as const).flatMap(preset => getAnimatedPatternSettings(createAnimatedPattern(preset)).map(setting => setting.label));
    for (const key of ['STAGECRAFT.Editor.PatternCompare', 'STAGECRAFT.Editor.PatternCollapse', ...ANIMATED_PATTERN_PRESETS.map(preset => preset.label), ...parameterLabels]) assert.ok(locale[key], key);
    assert.deepEqual(Object.fromEntries(Object.keys(packTwoLabels[language]).map(key => [key, locale[key]])), packTwoLabels[language]);
  }
});

async function specificEditor(t: TestContext, pattern: AnimatedPattern) {
  const f = fixture(t); f.category.dataset.stagecraftElementPanel = 'solid';
  let nextId = 0; const makeId = () => `specific-${++nextId}`;
  const base = createBarsSequence('Pattern controls', makeId);
  const solid: SolidClip = { ...base.clips[0]!, type: 'solid', typeVersion: 2,
    duration: { kind: 'fixed', milliseconds: 5000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { color: '#000000', fit: 'contain', box: { x: 0, y: 0, width: 900, height: 300 },
      crop: { x: 0, y: 0, width: 1, height: 1 }, mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], pattern } };
  const sequence = validateSequence({ ...base, clips: [solid], end: { kind: 'fixed', durationMs: 5000 } });
  const field = (name: string, type = 'number', parent = f.root) => {
    const input = f.doc.createElement(type === 'select' ? 'select' : 'input'); input.name = name; input.type = type;
    parent.append(input); return input;
  };
  const inspector = f.doc.createElement('fieldset'); inspector.dataset.stagecraftInspector = ''; f.root.append(inspector);
  inspector.append(f.category);
  field('ending', 'select'); field('sequence-duration'); field('clip-track', 'select');
  field('solid-start'); field('solid-duration-mode', 'select'); field('solid-duration');
  field('solid-entrance-preset', 'select'); field('solid-exit-preset', 'select');
  const group = f.doc.createElement('div'); group.dataset.stagecraftPatternSettings = ''; f.category.append(group);
  for (const suffix of ['speed', 'scale', 'density', 'direction', 'intensity']) {
    const label = f.doc.createElement('label'); group.append(label);
    if (suffix === 'scale' || suffix === 'density') label.dataset.stagecraftPatternLegacy = '';
    const input = field('solid-pattern-' + suffix, 'number', label); input.required = true;
    input.min = suffix === 'scale' ? '0.25' : '0'; input.max = '360'; input.step = 'any';
  }
  for (const index of [0, 1, 2]) field(`solid-pattern-color-${index}`, 'color', group);
  field('solid-pattern-reverse', 'checkbox', group); field('solid-pattern-onBreak', 'select', group);
  const specific = f.doc.createElement('div'); specific.dataset.stagecraftPatternParameters = ''; group.append(specific);
  let saved: SequenceV1 | undefined;
  const services: EditorServices = { makeId,
    repository: { list: async () => [sequence], read: async () => sequence,
      save: async value => { saved = validateSequence(JSON.parse(JSON.stringify(value))); return saved; }, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }), localize: key => key,
    confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {}, prepareGroup: async () => {},
    openSession() {}, groupActive: () => false, chooseVideo: async () => null, requestAudioUnlock: async () => {} };
  const view = new EditorView(services); await view.mount(f.root as unknown as HTMLElement); t.after(() => view.detach());
  const internal = view as unknown as { readForm(editField?: string): boolean; paint(): void; selectClip(id: string): void;
    act(action: string): Promise<void>; busy: boolean; updateButtons(): void };
  const current = () => (view.draft.draft!.clips[0] as SolidClip).properties.pattern!;
  const input = (key: string) => specific.querySelector<Node>(`[name="solid-pattern-parameter-${key}"]`)!;
  const choose = (preset: string) => {
    const toggle = f.host.querySelector('.stagecraft-pattern-toggle')!;
    if (toggle.getAttribute('aria-expanded') !== 'true') f.click(toggle);
    f.click(f.host.querySelector(`[data-stagecraft-pattern-preset="${preset}"]`)!);
  };
  const edit = (key: string, value: string) => { const target = input(key); target.value = value; target.dispatchEvent(new Event('input', { bubbles: true })); };
  return { ...f, view, internal, current, specific, input, choose, edit, saved: () => saved };
}

test('legacy form stays version 1 until deliberate same-preset selection and v2 controls roundtrip through save and Undo', async t => {
  const legacy: AnimatedPattern = { ...createAnimatedPattern(), preset: 'halftone', colors: ['#112233', '#445566', '#778899'] };
  const f = await specificEditor(t, legacy), before = f.view.draft.draft!;
  assert.equal(f.specific.children.length, 0);
  assert.equal(f.internal.readForm(), true); assert.equal(f.current().version, 1); assert.equal(f.view.draft.canUndo, false);
  f.click(f.host.querySelector('.stagecraft-pattern-toggle')!);
  assert.deepEqual(f.view.draft.draft, before, 'opening comparisons never upgrades authored data');
  f.choose('halftone');
  assert.equal(f.current().version, 2); assert.deepEqual(f.current().colors, legacy.colors);
  assert.equal(f.specific.children.length, 6);
  const upgraded = f.view.draft.draft!;
  await f.internal.act('undo'); assert.deepEqual(f.view.draft.draft, before); assert.equal(f.specific.children.length, 0);
  await f.internal.act('redo'); assert.deepEqual(f.view.draft.draft, upgraded); assert.equal(f.specific.children.length, 6);
  const dotSize = f.input('dotSize'); dotSize.focus(); f.edit('dotSize', '77');
  assert.equal(getAnimatedPatternSettings(f.current()).find(setting => setting.key === 'dotSize')?.value, 77);
  assert.equal(f.input('dotSize'), dotSize); assert.equal(f.doc.activeElement, dotSize, 'typing preserves the active control');
  f.internal.updateButtons(); assert.equal(f.input('dotSize'), dotSize);
  for (const label of f.root.querySelectorAll<Node>('[data-stagecraft-pattern-legacy]')) {
    assert.equal(label.hidden, true); const field = label.children[0]!; assert.equal(field.disabled, true);
    field.value = field.name.endsWith('-scale') ? '999' : '';
  }
  assert.equal(f.internal.readForm(), true, 'hidden required generic fields cannot obstruct saving');
  assert.equal(f.current().scale, legacy.scale); assert.equal(f.current().density, legacy.density);
  await f.view.draft.save(); assert.deepEqual((f.saved()!.clips[0] as SolidClip).properties.pattern, f.current());
  f.choose('halftone'); assert.equal(getAnimatedPatternSettings(f.current()).find(setting => setting.key === 'dotSize')?.value, 77);
});

test('specific controls enforce constraints, scrub in one Undo, and refresh when recipes or clips change', async t => {
  const f = await specificEditor(t, createAnimatedPattern('energy-trails'));
  assert.equal(f.specific.children.length, 4);
  const original = f.view.draft.draft!;
  f.edit('strandCount', '3.5'); assert.deepEqual(f.view.draft.draft, original, 'integer constraint blocks fractional strands');
  f.edit('strandCount', '11'); assert.deepEqual(f.view.draft.draft, original, 'range constraint blocks excess strands');
  f.edit('strandCount', '7'); assert.equal(getAnimatedPatternSettings(f.current()).find(setting => setting.key === 'strandCount')?.value, 7);
  const beforeGesture = f.view.draft.draft!, strand = f.input('strandCount');
  const pointer = (type: string, x: number, target: EventTarget) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { target: { value: strand }, button: { value: 0 }, pointerId: { value: 1 },
      clientX: { value: x }, clientY: { value: 0 }, detail: { value: 1 } }); target.dispatchEvent(event);
  };
  pointer('pointerdown', 0, strand); pointer('pointermove', 8, f.doc); pointer('pointerup', 8, f.doc);
  assert.equal(getAnimatedPatternSettings(f.current()).find(setting => setting.key === 'strandCount')?.value, 9);
  await f.internal.act('undo'); assert.deepEqual(f.view.draft.draft, beforeGesture, 'one gesture creates one Undo');
  f.choose('halftone'); assert.equal(f.specific.children.length, 6); assert.equal(f.input('strandCount'), null);
  f.choose('energy-trails'); assert.equal(f.specific.children.length, 4); assert.equal(f.input('dotSize'), null);
  const source = f.view.draft.draft!, first = source.clips[0] as SolidClip;
  const second: SolidClip = { ...first, typeVersion: 2, id: 'other-pattern', startMs: 0, properties: { ...first.properties, pattern: createAnimatedPattern('halftone') } };
  f.view.draft.replace({ ...source, clips: [...source.clips, second] }); f.internal.selectClip(second.id);
  assert.equal(f.input('strandCount'), null); assert.ok(f.input('waveStrength'));
  f.internal.selectClip(first.id); assert.equal(f.input('waveStrength'), null); assert.ok(f.input('strandCount'));
  const locked = { ...f.view.draft.draft!, tracks: source.tracks.map(track => ({ ...track, locked: true })) };
  f.view.draft.replace(locked); f.internal.paint(); assert.equal(f.input('strandCount').disabled, true);
  f.edit('strandCount', '8'); f.choose('halftone'); assert.deepEqual(f.view.draft.draft, locked);
  f.view.draft.replace(source); f.internal.paint(); f.internal.busy = true; f.internal.updateButtons();
  assert.equal(f.input('strandCount').disabled, true); f.edit('strandCount', '8'); assert.deepEqual(f.view.draft.draft, source);
});

test('full editor coalesces native color input bursts into live frames and commits one final Undo edit', async t => {
  const f = await specificEditor(t, createAnimatedPattern('halftone'));
  const before = f.view.draft.draft!, color = f.root.querySelector<Node>('[name="solid-pattern-color-0"]')!;
  const internals = f.view as unknown as { drawStill(sequence?: SequenceV1): void; readForm(field?: string): boolean; paintInspector(): void };
  const originalRead = internals.readForm.bind(f.view), originalInspector = internals.paintInspector.bind(f.view);
  let reads = 0, inspectorPaints = 0;
  const previews: SequenceV1[] = [];
  internals.drawStill = sequence => { if (sequence) previews.push(sequence); };
  internals.readForm = field => { reads++; return originalRead(field); };
  internals.paintInspector = () => { inspectorPaints++; originalInspector(); };
  const edit = (value: string, event = 'input') => { color.value = value; color.dispatchEvent(new Event(event, { bubbles: true })); };
  for (let index = 0; index < 120; index++) edit(`#${index.toString(16).padStart(6, '0')}`);
  assert.equal(f.callbacks.size, 1); assert.equal(reads, 0); assert.equal(inspectorPaints, 0);
  assert.deepEqual(f.view.draft.draft, before, 'live values stay transient until the gesture finishes');
  f.advance(16);
  assert.equal(previews.length, 1);
  assert.equal((previews[0]!.clips[0] as SolidClip).properties.pattern!.colors[0], '#000077');
  edit('#123456'); edit('#234567'); f.advance(32);
  assert.equal(previews.length, 2, 'dragging continues to refresh before change/release');
  edit('#abcdef'); edit('#fedcba', 'change');
  assert.equal(f.callbacks.size, 0); assert.equal(reads, 1, 'only finalization reads the full form');
  assert.equal(f.current().colors[0], '#fedcba', 'change wins even before the scheduled frame');
  assert.equal(f.view.draft.canUndo, true);
  await f.internal.act('undo'); assert.deepEqual(f.view.draft.draft, before); assert.equal(f.view.draft.canUndo, false);
  await f.internal.act('redo'); assert.equal(f.current().colors[0], '#fedcba');
  f.advance(48); assert.equal(f.current().colors[0], '#fedcba', 'cancelled callbacks cannot replay old colors');
});

test('pending native colors finish before Save, clip selection, Undo, mayClose and detach', async t => {
  const f = await specificEditor(t, createAnimatedPattern('halftone'));
  const color = f.root.querySelector<Node>('[name="solid-pattern-color-0"]')!;
  const edit = (value: string) => { color.value = value; color.dispatchEvent(new Event('input', { bubbles: true })); };
  edit('#123456'); await f.internal.act('save');
  assert.equal((f.saved()!.clips[0] as SolidClip).properties.pattern!.colors[0], '#123456');
  assert.equal(f.callbacks.size, 0); assert.equal(f.view.draft.dirty, false);
  const source = f.view.draft.draft!, first = source.clips[0] as SolidClip;
  const track = { ...source.tracks[0]!, id: 'second-color-track', order: source.tracks.length };
  const second: SolidClip = { ...first, id: 'second-color-clip', trackId: track.id };
  f.view.draft.replace({ ...source, tracks: [...source.tracks, track], clips: [...source.clips, second] }); f.internal.paint();
  edit('#234567'); f.internal.selectClip(second.id);
  assert.equal(f.current().colors[0], '#234567', 'selection commits against the original clip');
  assert.equal((f.view.draft.draft!.clips[1] as SolidClip).properties.pattern!.colors[0], '#123456');
  edit('#345678'); await f.internal.act('undo');
  assert.equal((f.view.draft.draft!.clips[1] as SolidClip).properties.pattern!.colors[0], '#123456');
  assert.equal(f.callbacks.size, 0, 'Undo cancels pending color work before reverting');
  edit('#456789'); await f.view.mayClose();
  assert.equal((f.view.draft.draft!.clips[1] as SolidClip).properties.pattern!.colors[0], '#456789');
  edit('#56789a'); f.view.detach();
  assert.equal((f.view.draft.draft!.clips[1] as SolidClip).properties.pattern!.colors[0], '#56789a');
  assert.equal(f.callbacks.size, 0); f.advance(100);
  assert.equal((f.view.draft.draft!.clips[1] as SolidClip).properties.pattern!.colors[0], '#56789a');
});

test('pending native color work cannot overwrite a stale, locked or busy draft', async t => {
  const f = await specificEditor(t, createAnimatedPattern('halftone'));
  const color = f.root.querySelector<Node>('[name="solid-pattern-color-0"]')!;
  const edit = (value: string) => { color.value = value; color.dispatchEvent(new Event('input', { bubbles: true })); };
  const source = f.view.draft.draft!;
  edit('#123456');
  const externallyChanged = { ...source, name: 'Changed elsewhere' }; f.view.draft.replace(externallyChanged);
  f.advance(16); color.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(f.view.draft.draft, externallyChanged);
  edit('#234567');
  const locked = { ...externallyChanged, tracks: source.tracks.map(track => ({ ...track, locked: true })) };
  f.view.draft.replace(locked); f.internal.paint(); await f.view.mayClose();
  assert.deepEqual(f.view.draft.draft, locked); assert.equal(f.callbacks.size, 0);
  f.view.draft.replace(source); f.internal.paint(); edit('#345678');
  f.internal.busy = true; f.internal.updateButtons(); f.view.detach();
  assert.deepEqual(f.view.draft.draft, source); assert.equal(f.callbacks.size, 0);
});

test('switching sequences sees the pending color as unsaved and cannot replay it into the new sequence', async t => {
  const f = await specificEditor(t, createAnimatedPattern('halftone'));
  await f.internal.act('save');
  const color = f.root.querySelector<Node>('[name="solid-pattern-color-0"]')!;
  color.value = '#123456'; color.dispatchEvent(new Event('input', { bubbles: true }));
  let discardedColor: string | undefined;
  const internals = f.view as unknown as { services: EditorServices };
  internals.services.confirmDiscard = async () => {
    discardedColor = f.current().colors[0]; return true;
  };
  await f.internal.act('new');
  assert.equal(discardedColor, '#123456', 'discard confirmation sees the finalized color edit');
  const created = f.view.draft.draft!;
  assert.equal(f.callbacks.size, 0); f.advance(32);
  assert.deepEqual(f.view.draft.draft, created);
});

test('native color normalization preserves untouched authored colors and same-color gestures create no Undo', async t => {
  const f = await specificEditor(t, { ...createAnimatedPattern('halftone'), colors: ['#ABCDEF', '#FEDCBA', '#AABBCC'] });
  const before = f.view.draft.draft!;
  const colors = [0, 1, 2].map(index => f.root.querySelector<Node>(`[name="solid-pattern-color-${index}"]`)!);
  for (const color of colors) color.value = color.value.toLowerCase();
  colors[0]!.dispatchEvent(new Event('input', { bubbles: true }));
  colors[0]!.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(f.view.draft.draft, before); assert.equal(f.view.draft.canUndo, false);
  colors[0]!.value = '#123456'; colors[0]!.dispatchEvent(new Event('input', { bubbles: true }));
  colors[0]!.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(f.current().colors, ['#123456', '#FEDCBA', '#AABBCC']);
  await f.internal.act('undo'); assert.deepEqual(f.view.draft.draft, before);
});
