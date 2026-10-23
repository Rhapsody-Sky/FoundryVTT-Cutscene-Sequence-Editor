import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { EditorLayout, fitEditorLayout, type EditorLayoutSizes } from '../src/ui/editor-layout.js';

const defaults = (): EditorLayoutSizes => ({ library: 180, inspector: 300, timeline: 250 });

test('layout clamps panes to preserve the viewer, transport and timeline on window resize', () => {
  const requested = { library: 900, inspector: 800, timeline: 700 };
  const fit = fitEditorLayout(requested, { width: 1000, height: 800, chromeHeight: 100 });
  assert.equal(fit.sizes.library + fit.sizes.inspector + 320 + 12, 1000);
  assert.equal(fit.sizes.inspector, 240);
  assert.equal(fit.sizes.timeline, 434);
  assert.deepEqual(requested, { library: 900, inspector: 800, timeline: 700 }, 'viewport constraints do not replace remembered choices');
  const narrow = fitEditorLayout(requested, { width: 600, height: 700, chromeHeight: 100 });
  assert.equal(narrow.stacked, true);
  assert.equal(narrow.sizes.library, 354);
  assert.equal(narrow.sizes.timeline, 264);
  const tiny = fitEditorLayout({ library: -10, inspector: NaN, timeline: Infinity }, { width: 0, height: 0, chromeHeight: 0 });
  assert.deepEqual(tiny.sizes, { library: 140, inspector: 300, timeline: 200 });
});

function fixture(t: TestContext) {
  class Node extends EventTarget {
    parentElement: Node | null = null; children: Node[] = []; dataset: Record<string, string> = {};
    width = 1100; height = 800; clientHeight = 800; tabIndex = 0;
    attrs = new Map<string, string>(); captured = new Set<number>(); classes = new Set<string>();
    values = new Map<string, string>();
    style = { cursor: '', setProperty: (key: string, value: string) => this.values.set(key, value) };
    classList = { add: (key: string) => this.classes.add(key), remove: (key: string) => this.classes.delete(key) };
    ownerDocument = { defaultView: new EventTarget() };
    name = '';
    append(child: Node) { child.parentElement = this; this.children.push(child); }
    contains(node: unknown): boolean { return this === node || this.children.some(child => child.contains(node)); }
    getBoundingClientRect() { return { width: this.width, height: this.height }; }
    querySelectorAll<T>(selector: string): T[] { return this.children.filter(child => selector === '[data-stagecraft-splitter]' ? 'stagecraftSplitter' in child.dataset : '.' + child.name === selector) as T[]; }
    querySelector<T>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
    closest<T>(selector: string): T | null { return selector === '[data-stagecraft-splitter]' && 'stagecraftSplitter' in this.dataset ? this as unknown as T : null; }
    setAttribute(key: string, value: string) { this.attrs.set(key, value); }
    focus() {}
    setPointerCapture(id: number) { this.captured.add(id); }
    hasPointerCapture(id: number) { return this.captured.has(id); }
    releasePointerCapture(id: number) { this.captured.delete(id); }
  }
  let observerCallback: (() => void) | undefined;
  let disconnected = false;
  class Observer {
    constructor(callback: () => void) { observerCallback = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  }
  const saved = new Map(['Element', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'Element', { value: Node, configurable: true });
  Object.defineProperty(globalThis, 'ResizeObserver', { value: Observer, configurable: true });
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const host = new Node(), root = new Node(); host.append(root);
  const toolbar = new Node(), footer = new Node(); toolbar.name = 'stagecraft-editor-toolbar'; toolbar.height = 60; footer.name = 'stagecraft-editor-footer'; footer.height = 30;
  root.append(toolbar); root.append(footer);
  const library = new Node(), inspector = new Node(), timeline = new Node();
  library.dataset.stagecraftSplitter = 'library'; inspector.dataset.stagecraftSplitter = 'inspector'; timeline.dataset.stagecraftSplitter = 'timeline';
  root.append(library); root.append(inspector); root.append(timeline);
  const dispatch = (type: string, target: Node, props: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ target, ...props }).map(([key, value]) => [key, { value }])));
    root.dispatchEvent(event); return event;
  };
  return { root, library, inspector, timeline, dispatch, resize: () => observerCallback?.(), disconnected: () => disconnected };
}

test('panel gestures commit once, retain sizes on remount and release capture on all cancellation paths', t => {
  const f = fixture(t), sizes = defaults();
  let layout = new EditorLayout(f.root as unknown as HTMLElement, sizes);
  const down = (id: number, target = f.library) => f.dispatch('pointerdown', target, { button: 0, pointerId: id, clientX: 180, clientY: 500 });
  const move = (id: number, x: number) => f.dispatch('pointermove', f.root, { pointerId: id, clientX: x, clientY: 500 });
  down(1); move(2, 999); assert.equal(sizes.library, 180, 'other pointers do not resize');
  move(1, 250); assert.equal(sizes.library, 250); assert.equal(f.root.hasPointerCapture(1), true);
  f.dispatch('pointerup', f.root, { pointerId: 1, clientX: 250, clientY: 500 });
  assert.equal(f.root.hasPointerCapture(1), false); assert.equal(f.root.classes.has('stagecraft-layout-dragging'), false);
  layout.dispose(); layout = new EditorLayout(f.root as unknown as HTMLElement, sizes);
  assert.equal(f.root.values.get('--stagecraft-library-width'), '250px');
  for (const cancellation of ['pointercancel', 'lostpointercapture', 'Escape', 'dispose']) {
    down(3); move(3, 300); assert.equal(sizes.library, 370);
    if (cancellation === 'Escape') f.dispatch('keydown', f.library, { key: 'Escape' });
    else if (cancellation === 'dispose') layout.dispose();
    else f.dispatch(cancellation, f.root, { pointerId: 3 });
    assert.equal(sizes.library, 250, cancellation + ' rolls back the unfinished gesture');
    assert.equal(f.root.hasPointerCapture(3), false); assert.equal(f.root.style.cursor, '');
    assert.equal(f.library.classes.has('stagecraft-splitter-active'), false);
  }
  const remembered = { ...sizes };
  down(4); move(4, 350);
  assert.deepEqual(sizes, remembered, 'disposal removes event listeners');
  assert.equal(f.disconnected(), true);
});

test('keyboard resizing reports accessible values and inspector drag cancels when it stacks', t => {
  const f = fixture(t), sizes = defaults(), layout = new EditorLayout(f.root as unknown as HTMLElement, sizes);
  f.dispatch('keydown', f.library, { key: 'ArrowRight' });
  assert.equal(sizes.library, 190); assert.equal(f.library.attrs.get('aria-valuenow'), '190');
  f.dispatch('keydown', f.inspector, { key: 'ArrowLeft', shiftKey: true }); assert.equal(sizes.inspector, 340);
  f.dispatch('keydown', f.timeline, { key: 'ArrowUp' }); assert.equal(sizes.timeline, 260);
  const deletion = f.dispatch('keydown', f.library, { key: 'Delete' }); assert.equal(deletion.defaultPrevented, true);
  f.dispatch('pointerdown', f.inspector, { button: 0, pointerId: 5, clientX: 700, clientY: 0 });
  f.dispatch('pointermove', f.root, { pointerId: 5, clientX: 650, clientY: 0 }); assert.equal(sizes.inspector, 390);
  f.root.width = 600; f.resize();
  assert.equal(sizes.inspector, 340); assert.equal(f.root.hasPointerCapture(5), false);
  assert.equal(f.inspector.tabIndex, -1); assert.equal(f.inspector.attrs.get('aria-disabled'), 'true');
  f.dispatch('keydown', f.inspector, { key: 'ArrowLeft' }); assert.equal(sizes.inspector, 340);
  f.root.width = 1100; f.resize(); assert.equal(f.inspector.tabIndex, 0);
  layout.dispose();
});

test('timeline splitter grows upwards, clamps to transport space and rolls back on pointer cancellation', t => {
  const f = fixture(t), sizes = defaults(), layout = new EditorLayout(f.root as unknown as HTMLElement, sizes);
  f.dispatch('pointerdown', f.timeline, { button: 0, pointerId: 9, clientX: 0, clientY: 500 });
  f.dispatch('pointermove', f.root, { pointerId: 9, clientX: 0, clientY: 450 });
  assert.equal(sizes.timeline, 300);
  f.dispatch('pointermove', f.root, { pointerId: 9, clientX: 0, clientY: 0 });
  assert.equal(sizes.timeline, 444); assert.equal(f.timeline.attrs.get('aria-valuenow'), '444');
  f.dispatch('pointermove', f.root, { pointerId: 9, clientX: 0, clientY: 1000 });
  assert.equal(sizes.timeline, 200);
  f.dispatch('pointercancel', f.root, { pointerId: 9 });
  assert.equal(sizes.timeline, 250); assert.equal(f.root.hasPointerCapture(9), false);
  layout.dispose();
});
