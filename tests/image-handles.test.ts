import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ImageClip, SequenceV1, TextClip, VideoClip } from '../src/domain/sequence.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import { applyEditorTimelineCommand } from '../src/application/timeline-commands.js';
import { moveImageCorner, transformImageBox, type VisualHandleState, type EditableVisualClip, VisualHandles, transformTextBox, transformTextBoxEdge, transformVisualBox } from '../src/ui/image-handles.js';

function sequence(): SequenceV1 {
  let id = 0; const makeId = () => 'image-handle-' + ++id;
  const seed = createBarsSequence('Image handles', makeId);
  const source: SequenceV1 = { ...seed, schemaVersion: 2, clips: [], end: { kind: 'fixed', durationMs: 5000, automatic: true } };
  const next = applyEditorTimelineCommand(source, { kind: 'add-clip', type: 'image', trackId: seed.tracks[0]!.id, sourcePath: 'images/test.png', startMs: 0 }, makeId);
  const clip = next.clips[0] as ImageClip;
  return validateSequence({ ...next, clips: [{ ...clip, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { ...clip.properties, box: { x: 100, y: 50, width: 400, height: 200 },
      mask: [{ x: 0.2, y: 0.2, custom: 'keep' }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } } ] });
}

const editorTemplate = readFileSync('templates/editor.hbs', 'utf8');

function numericInput(name: string): Record<string, string> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = editorTemplate.match(new RegExp(`<input\\b[^>]*\\bname="${escaped}"[^>]*>`))?.[0];
  assert.ok(tag, `The real editor template must contain numeric input ${name}.`);
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1]!, match[2]!]));
}

function browserAcceptsNumber(attributes: Record<string, string>, value: number): boolean {
  const minimum = attributes.min === undefined ? Number.NEGATIVE_INFINITY : Number(attributes.min);
  const maximum = attributes.max === undefined ? Number.POSITIVE_INFINITY : Number(attributes.max);
  if (!Number.isFinite(value) || value < minimum || value > maximum) return false;
  if (attributes.step === 'any') return true;
  const step = Number(attributes.step ?? 1), base = Number.isFinite(minimum) ? minimum : 0;
  return step > 0 && Math.abs((value - base) / step - Math.round((value - base) / step)) < 1e-7;
}

function fixture(t: TestContext, width = 960, height = 540, observeResize = false, hostScale = 1, initial = sequence()) {
  let resizeCallback: () => void = () => {};
  let observed: unknown;
  let observerDisconnected = false;
  class Observer {
    constructor(callback: () => void) { resizeCallback = callback; }
    observe(node: unknown) { observed = node; }
    disconnect() { observerDisconnected = true; }
  }
  let active: Node | null = null;
  class Node extends EventTarget {
    children: Node[] = []; parentElement: Node | null = null; dataset: Record<string, string> = {}; style: Record<string, string> = {};
    attributes: Record<string, string> = {}; className = ''; hidden = false; type = ''; title = ''; captured = new Set<number>();
    classList = { add: (name: string) => { this.className += ' ' + name; } };
    append(...children: Node[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    removeChild(child: Node) { this.children = this.children.filter(item => item !== child); child.parentElement = null; }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    getAttribute(key: string) { return this.attributes[key] ?? null; }
    get clientWidth() { return width; }
    get clientHeight() { return height; }
    getBoundingClientRect() { return { left: 0, top: 0, width: width * hostScale, height: height * hostScale, right: width * hostScale, bottom: height * hostScale }; }
    setPointerCapture(id: number) { this.captured.add(id); }
    hasPointerCapture(id: number) { return this.captured.has(id); }
    releasePointerCapture(id: number) { this.captured.delete(id); }
    focus() { active = this; }
    contains(node: Node): boolean { return node === this || this.children.some(child => child.contains(node)); }
    closest(selector: string): Node | null {
      if (selector.includes(',')) return selector.split(',').map(part => this.closest(part.trim())).find(Boolean) ?? null;
      const key = /^\[data-([\w-]+)\]$/.exec(selector)?.[1]?.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return key && key in this.dataset ? this : this.parentElement?.closest(selector) ?? null;
    }
    find(key: string, value?: string): Node | undefined {
      if (key in this.dataset && (value === undefined || this.dataset[key] === value)) return this;
      return this.children.map(child => child.find(key, value)).find(Boolean);
    }
  }
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = { Element: Node, HTMLElement: Node, ResizeObserver: observeResize ? Observer : undefined,
    document: { createElement: () => new Node(), createElementNS: () => new Node(), get activeElement() { return active; } } };
  for (const [key, value] of Object.entries(globals)) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value }); }
  t.after(() => { for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  let source = initial; let editable = true; let positionMs = 1000;
  const viewer = new Node(); const previews: EditableVisualClip[] = [], commits: EditableVisualClip[] = []; let cancellations = 0;
  const read = (): VisualHandleState => ({ sequence: structuredClone(source), clip: structuredClone(source.clips[0]) as EditableVisualClip, editable, positionMs });
  const handles = new VisualHandles(viewer as unknown as HTMLElement, key => key, { read, before: () => editable,
    preview: clip => previews.push(clip), cancel: () => { cancellations++; },
    commit: (sequenceId, clipId, clip) => { assert.equal(sequenceId, source.id); assert.equal(clipId, source.clips[0]!.id); commits.push(clip); source = { ...source, clips: [clip] }; return true; } });
  t.after(() => handles.dispose()); handles.update();
  const root = viewer.children[0]!;
  const dispatch = (type: string, target: Node, properties: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ target, button: 0, pointerId: 1, clientX: 0, clientY: 0, ...properties }).map(([key, value]) => [key, { value }])));
    root.dispatchEvent(event); return event;
  };
  const corner = (index: number) => root.find('imageCorner', String(index))!;
  const edge = (side: 'top' | 'right' | 'bottom' | 'left') => root.find('imageEdge', side)!;
  const outside = new Node(); outside.focus();
  const keyAtFocus = (key: string) => { if (active && root.contains(active)) dispatch('keydown', active, { key }); };
  return { handles, viewer, root, corner, edge, dispatch, previews, commits, read, outside, keyAtFocus,
    get source() { return source; }, get cancellations() { return cancellations; },
    setSource(value: SequenceV1) { source = value; }, disable() { editable = false; }, seek(value: number) { positionMs = value; },
    resizeViewer(nextWidth: number, nextHeight: number) { width = nextWidth; height = nextHeight; resizeCallback(); },
    get observed() { return observed; }, get observerDisconnected() { return observerDisconnected; } };
}

test('mask and box edits keep source, crop, timing and nested extensions, including crossed points', () => {
  const original = sequence().clips[0] as ImageClip;
  const moved = moveImageCorner(original, 0, 0.8, 0.8);
  assert.equal(moved.properties.mask[0].x, 1); assert.equal(moved.properties.mask[0].y, 1);
  assert.equal((moved.properties.mask[0] as unknown as { custom: string }).custom, 'keep');
  assert.equal(original.properties.mask[0].x, 0.2);
  assert.deepEqual(moved.properties.source, original.properties.source); assert.deepEqual(moved.properties.crop, original.properties.crop);
  const resized = transformImageBox(moved, 0, -40, -20);
  assert.deepEqual(resized.properties.box, { x: 60, y: 30, width: 440, height: 220 });
  assert.deepEqual(resized.properties.mask, moved.properties.mask); assert.deepEqual(resized.duration, moved.duration);
  assert.equal(transformImageBox(moved, 2, -1000, -1000).properties.box.width, 1);
  assert.equal(moveImageCorner(original, 7, 1, 1), original); assert.equal(transformImageBox(original, null, NaN, 0), original);
});

test('zero-delta gestures preserve fractional legacy geometry and do not preview or commit', t => {
  const initial = sequence(), source = initial.clips[0] as ImageClip;
  const legacy = validateSequence({ ...initial, clips: [{ ...source, properties: {
    ...source.properties,
    box: { ...source.properties.box, x: 100.123456789, y: 50.987654321 },
    mask: [{ ...source.properties.mask[0]!, x: 0.12345678901234566 }, ...source.properties.mask.slice(1)]
  } }] });
  const f = fixture(t, 960, 540, false, 1, legacy);
  f.dispatch('pointerdown', f.corner(0)); f.dispatch('pointerup', f.corner(0));
  assert.deepEqual(f.source, legacy);
  assert.equal(f.previews.length, 0); assert.equal(f.commits.length, 0);
  const image = legacy.clips[0] as ImageClip;
  assert.equal(transformImageBox(image, null, 1, 0).properties.box.y, image.properties.box.y);
  assert.equal(moveImageCorner(image, 0, 0, 0.1).properties.mask[0].x, image.properties.mask[0].x);
  const narrow = { ...image, properties: { ...image.properties,
    box: { x: 100.123456789, y: 50.987654321, width: 1, height: 200 } } };
  const constrained = transformImageBox(narrow, 0, 10, 20);
  assert.equal(constrained.properties.box.x, narrow.properties.box.x, 'a clamped horizontal axis must stay untouched');
  assert.equal(constrained.properties.box.width, narrow.properties.box.width, 'its anchored dimension must stay untouched too');
  assert.notEqual(constrained.properties.box.y, narrow.properties.box.y, 'the independent vertical axis can still move');
});

test('title resize rounds gesture-derived spatial values and keeps them valid in the real inspector', () => {
  const seed = visualSequence('text'), original = seed.clips[0] as TextClip;
  const clip: TextClip = { ...original, properties: {
    ...original.properties,
    fontSize: 80.123456789, minimumFontSize: 20.222222222,
    box: { x: 100.123456789, y: 50.987654321, width: 400.123456789, height: 200.123456789 },
    outline: { ...original.properties.outline!, width: 3.333333333 },
    shadow: { ...original.properties.shadow!, offsetX: -4.123456789, offsetY: 8.345678912, blur: 16.987654321 },
    glow: { ...original.properties.glow!, radius: 24.7654321 }
  } };
  const resized = transformTextBox(clip, 2, 30, 63.45);
  assert.equal(resized.properties.box.width, 449.51);
  assert.equal(resized.properties.box.height, 224.82);
  assert.equal(resized.properties.fontSize, 90.01);
  assert.equal(resized.properties.minimumFontSize, 22.72);
  assert.equal(resized.properties.outline!.width, 3.74);
  assert.equal(resized.properties.shadow!.offsetX, -4.63);
  assert.equal(resized.properties.shadow!.offsetY, 9.38);
  assert.equal(resized.properties.shadow!.blur, 19.08);
  assert.equal(resized.properties.glow!.radius, 27.82);

  for (const [name, value] of [
    ['title-x', resized.properties.box.x], ['title-y', resized.properties.box.y],
    ['title-width', resized.properties.box.width], ['title-height', resized.properties.box.height],
    ['title-size', resized.properties.fontSize], ['title-minimum-size', resized.properties.minimumFontSize],
    ['outline-width', resized.properties.outline!.width], ['shadow-offset-x', resized.properties.shadow!.offsetX],
    ['shadow-offset-y', resized.properties.shadow!.offsetY], ['shadow-blur', resized.properties.shadow!.blur],
    ['glow-radius', resized.properties.glow!.radius]
  ] as const) {
    const attributes = numericInput(name);
    assert.equal(attributes.step, 'any', `${name} must accept stored fractions without rounding on load`);
    assert.ok(browserAcceptsNumber(attributes, value), `${name} rejects gesture result ${value} with its real min/max/step`);
  }
  assert.equal(numericInput('title-x').min, '-32768');
  assert.equal(numericInput('title-y').min, '-32768');
  assert.equal(numericInput('title-width').max, '32768');
  const anchored = transformTextBox(clip, 0, -30, -63.45);
  assert.ok(Math.abs((anchored.properties.box.x + anchored.properties.box.width) - (clip.properties.box.x + clip.properties.box.width)) < 0.01);
  assert.ok(Math.abs((anchored.properties.box.y + anchored.properties.box.height) - (clip.properties.box.y + clip.properties.box.height)) < 0.01);
  assert.ok(Math.abs(anchored.properties.fontSize / clip.properties.fontSize - anchored.properties.box.width / clip.properties.box.width) < 0.001);

  const bounded = transformTextBox(original, 2, -1e9, -1e9);
  assert.equal(bounded.properties.box.width, 20);
  assert.equal(bounded.properties.box.height, 10);
  assert.equal(bounded.properties.minimumFontSize, 1);
  assert.ok(bounded.properties.minimumFontSize <= bounded.properties.fontSize);
  for (const [name, value] of [
    ['title-width', bounded.properties.box.width], ['title-height', bounded.properties.box.height],
    ['title-size', bounded.properties.fontSize], ['title-minimum-size', bounded.properties.minimumFontSize],
    ['outline-width', bounded.properties.outline!.width], ['shadow-blur', bounded.properties.shadow!.blur],
    ['glow-radius', bounded.properties.glow!.radius]
  ] as const) assert.ok(browserAcceptsNumber(numericInput(name), value), `${name} rejects the minimum-bound result ${value}`);
  assert.doesNotThrow(() => validateSequence({ ...seed, clips: [resized] }));
});

test('a resize constrained to its original size does not quantize legacy title values', () => {
  const seed = visualSequence('text'), original = seed.clips[0] as TextClip;
  const clip: TextClip = { ...original, properties: {
    ...original.properties, fontSize: 512, minimumFontSize: 36.123456789,
    box: { x: 100.123456789, y: 50.987654321, width: 400.123456789, height: 200.123456789 }
  } };
  assert.equal(transformTextBox(clip, 2, 100, 100), clip);
  assert.doesNotThrow(() => validateSequence({ ...seed, clips: [clip] }));
});

test('mask pointer gestures preview live at different viewport sizes and commit only once', t => {
  const f = fixture(t, 960, 540); const original = f.source; const corner = f.corner(0);
  f.dispatch('pointerdown', corner);
  for (let x = 10; x <= 50; x += 10) f.dispatch('pointermove', corner, { clientX: x, clientY: 20 });
  assert.equal(f.previews.length, 5); assert.deepEqual(f.source, original); assert.equal(f.commits.length, 0);
  f.dispatch('pointerup', corner, { clientX: 50, clientY: 20 });
  assert.equal(f.commits.length, 1); assert.equal(f.source.clips[0]!.type, 'image');
  const next = f.source.clips[0] as ImageClip;
  assert.equal(next.properties.mask[0].x, 0.45); assert.equal(next.properties.mask[0].y, 0.4);
  assert.equal(f.root.hasPointerCapture(1), false);
});

test('projection uses composition letterboxing and follows slide/zoom before mask dragging', t => {
  const f = fixture(t, 960, 960); const original = f.source.clips[0] as ImageClip;
  const animated: ImageClip = { ...original, entrance: { preset: 'fade-zoom', version: 1, durationMs: 2000, easing: 'linear', scale: 0.5 } };
  f.setSource({ ...f.source, clips: [animated] }); f.handles.update();
  assert.equal(f.corner(0).style.left, '105px'); assert.equal(f.corner(0).style.top, '262.5px');
  f.dispatch('pointerdown', f.corner(0)); f.dispatch('pointerup', f.corner(0), { clientX: 15 });
  assert.ok(Math.abs((f.source.clips[0] as ImageClip).properties.mask[0].x - 0.3) < 1e-9);
});

test('Escape, capture loss, changed draft, playhead and disabled editing cancel without draft mutation', t => {
  const f = fixture(t); const original = f.source;
  const start = () => { f.dispatch('pointerdown', f.corner(0)); f.dispatch('pointermove', f.corner(0), { clientX: 20 }); };
  start(); f.dispatch('keydown', f.corner(0), { key: 'Escape' });
  start(); f.dispatch('lostpointercapture', f.corner(0));
  start(); f.setSource({ ...f.source, name: 'Another edit' }); f.handles.update();
  start(); f.seek(1200); f.handles.update();
  start(); f.disable(); f.handles.update();
  assert.equal(f.cancellations, 5); assert.equal(f.commits.length, 0);
  assert.deepEqual(f.source.clips, original.clips); assert.equal(f.root.hidden, true);
  f.dispatch('pointerdown', f.corner(0)); f.dispatch('pointerup', f.corner(0), { clientX: 50 }); assert.equal(f.commits.length, 0);
});

test('drag explicitly takes focus from an inspector field so Escape cancels at the actual keyboard target', t => {
  const f = fixture(t); assert.equal(document.activeElement, f.outside);
  f.dispatch('pointerdown', f.corner(0)); assert.equal(document.activeElement, f.corner(0));
  f.dispatch('pointermove', f.corner(0), { clientX: 20 });
  f.keyAtFocus('Escape'); assert.equal(f.cancellations, 1);
  f.dispatch('pointerup', f.corner(0), { clientX: 20 }); assert.equal(f.commits.length, 0);
});

test('transform tools resize or move the image box while preserving mask and crop; arrows edit one logical unit', t => {
  const f = fixture(t);
  f.dispatch('click', f.root.find('imageMode', 'transform')!);
  f.dispatch('pointerdown', f.corner(2)); f.dispatch('pointerup', f.corner(2), { clientX: 20, clientY: 10 });
  let image = f.source.clips[0] as ImageClip;
  assert.deepEqual(image.properties.box, { x: 100, y: 50, width: 440, height: 220 });
  const move = f.root.find('imageMove')!;
  f.dispatch('keydown', move, { key: 'ArrowRight', shiftKey: true });
  image = f.source.clips[0] as ImageClip; assert.equal(image.properties.box.x, 110);
  assert.deepEqual(image.properties.mask, (sequence().clips[0] as ImageClip).properties.mask);
  f.dispatch('click', f.root.find('imageMode', 'mask')!);
  f.dispatch('keydown', f.corner(0), { key: 'ArrowDown' });
  assert.equal((f.source.clips[0] as ImageClip).properties.mask[0].y, 0.2045);
});

test('disposing during a gesture releases capture and listeners and never commits the transient edit', t => {
  const f = fixture(t);
  f.dispatch('pointerdown', f.corner(0)); f.dispatch('pointermove', f.corner(0), { clientX: 30 });
  f.handles.dispose(); assert.equal(f.root.hasPointerCapture(1), false); assert.equal(f.viewer.children.length, 0);
  f.dispatch('pointerup', f.corner(0), { clientX: 30 }); assert.equal(f.commits.length, 0);
});

test('viewer resize reprojects handles without editing and cancels a drag before its coordinates become stale', t => {
  const f = fixture(t, 960, 540, true), original = f.source;
  assert.equal(f.observed, f.viewer);
  assert.equal(f.corner(0).style.left, '90px'); assert.equal(f.corner(0).style.top, '45px');
  f.resizeViewer(800, 800);
  assert.equal(f.corner(0).style.left, '75px'); assert.equal(f.corner(0).style.top, '212.5px');
  assert.deepEqual(f.source, original); assert.equal(f.previews.length, 0); assert.equal(f.commits.length, 0);
  f.dispatch('pointerdown', f.corner(0)); f.dispatch('pointermove', f.corner(0), { clientX: 20 });
  assert.equal(f.root.hasPointerCapture(1), true);
  f.resizeViewer(1920, 1080);
  assert.equal(f.cancellations, 1); assert.equal(f.root.hasPointerCapture(1), false);
  assert.equal(f.corner(0).style.left, '180px'); assert.equal(f.corner(0).style.top, '90px');
  f.dispatch('pointerup', f.corner(0), { clientX: 20 }); assert.equal(f.commits.length, 0);
  assert.deepEqual(f.source, original);
  f.handles.dispose(); assert.equal(f.observerDisconnected, true);
  f.resizeViewer(640, 360); assert.equal(f.viewer.children.length, 0);
});

test('scaled application paints handles in local pixels but translates pointer movement from visual pixels', t => {
  const f = fixture(t, 960, 540, true, 2);
  assert.equal(f.corner(0).style.left, '90px'); assert.equal(f.corner(0).style.top, '45px');
  f.dispatch('pointerdown', f.corner(0), { clientX: 180, clientY: 90 });
  f.dispatch('pointerup', f.corner(0), { clientX: 220, clientY: 90 });
  const image = f.source.clips[0] as ImageClip;
  assert.ok(Math.abs(image.properties.mask[0].x - 0.3) < 1e-9);
  assert.equal(f.corner(0).style.left, '110px'); assert.equal(f.corner(0).style.top, '45px');
  f.resizeViewer(800, 800);
  assert.ok(Math.abs(parseFloat(f.corner(0).style.left!) - 110 * 800 / 960) < 1e-9);
  assert.equal(f.corner(0).style.top, '212.5px');
  f.dispatch('click', f.root.find('imageMode', 'transform')!);
  const move = f.root.find('imageMove')!;
  assert.ok(Math.abs(parseFloat(move.style.width!) - 400 * 800 / 1920) < 1e-9);
  assert.ok(Math.abs(parseFloat(move.style.top!) - (175 + 50 * 800 / 1920)) < 1e-9);
});

function visualSequence(type: 'text' | 'video'): SequenceV1 {
  const seed = sequence(), old = seed.clips[0] as ImageClip;
  const common = { id: old.id, trackId: old.trackId, startMs: 0, entrance: old.entrance, exit: old.exit };
  const clip: TextClip | VideoClip = type === 'text' ? {
    ...common, type: 'text', typeVersion: 1, duration: { kind: 'fixed', milliseconds: 5000 },
    properties: { text: 'Title', fontFamily: 'serif', fontSize: 80, minimumFontSize: 20,
      color: '#ffffff', align: 'left', box: old.properties.box, shrinkToFit: true,
      outline: { enabled: true, width: 4, opacity: 1, color: '#ffffff' },
      shadow: { enabled: true, offsetX: -4, offsetY: 8, blur: 16, color: '#000000', opacity: 1 },
      glow: { enabled: true, radius: 24, color: '#ffffff', opacity: 1 } }
  } : { ...common, type: 'video', typeVersion: 1, duration: { kind: 'media' },
    properties: { source: { kind: 'foundry-file', path: 'movie.webm' }, durationMs: 5000, fit: 'contain', volume: 1, muted: true } };
  return validateSequence({ ...seed, clips: [clip] });
}

test('title corners scale font, minimum font, effects and box proportionally at the fixed opposite corner', () => {
  const seed = visualSequence('text'), clip = seed.clips[0] as TextClip;
  const next = transformTextBox(clip, 0, -200, -100);
  assert.deepEqual(next.properties.box, { x: -100, y: -50, width: 600, height: 300 });
  assert.equal(next.properties.fontSize, 120); assert.equal(next.properties.minimumFontSize, 30);
  assert.equal(next.properties.outline!.width, 6); assert.equal(next.properties.shadow!.offsetX, -6);
  assert.equal(next.properties.shadow!.blur, 24); assert.equal(next.properties.glow!.radius, 36);
  assert.deepEqual(clip.properties.box, { x: 100, y: 50, width: 400, height: 200 });
  for (const corner of [0, 1, 2, 3]) for (const delta of [-1e10, 1e10, -Number.MAX_VALUE, Number.MAX_VALUE]) {
    const resized = transformTextBox(clip, corner, delta, delta);
    assert.doesNotThrow(() => validateSequence({ ...seed, clips: [resized] }));
  }
  const moved = transformTextBox(clip, null, 50, 25);
  assert.equal(moved.properties.fontSize, 80); assert.equal(moved.properties.box.x, 150);
});

test('text edge resizing changes only its axis, preserves the opposite edge and retains title extensions', () => {
  const seed = visualSequence('text'), base = seed.clips[0] as TextClip;
  type ExtendedText = TextClip & { readonly clipExtension: { readonly keep: true };
    readonly properties: TextClip['properties'] & { readonly propertyExtension: { readonly keep: true };
      readonly box: TextClip['properties']['box'] & { readonly boxExtension: 'keep' } } };
  const original = { ...base, clipExtension: { keep: true as const }, properties: {
    ...base.properties, propertyExtension: { keep: true as const }, box: { ...base.properties.box, boxExtension: 'keep' as const }
  } } as ExtendedText;
  const cases = [
    ['top', 0, 20, { x: 100, y: 70, width: 400, height: 180 }],
    ['right', 20, 0, { x: 100, y: 50, width: 420, height: 200 }],
    ['bottom', 0, 20, { x: 100, y: 50, width: 400, height: 220 }],
    ['left', 20, 0, { x: 120, y: 50, width: 380, height: 200 }]
  ] as const;
  for (const [edge, dx, dy, expected] of cases) {
    const next = transformTextBoxEdge(original, edge, dx, dy) as ExtendedText;
    assert.deepEqual(next.properties.box, { ...original.properties.box, ...expected, boxExtension: 'keep' });
    if (edge === 'top') assert.equal(next.properties.box.y + next.properties.box.height, original.properties.box.y + original.properties.box.height);
    if (edge === 'left') assert.equal(next.properties.box.x + next.properties.box.width, original.properties.box.x + original.properties.box.width);
    if (edge === 'bottom') assert.equal(next.properties.box.y, original.properties.box.y);
    if (edge === 'right') assert.equal(next.properties.box.x, original.properties.box.x);
    assert.deepEqual(next.properties.text, original.properties.text);
    assert.equal(next.properties.fontSize, original.properties.fontSize);
    assert.equal(next.properties.minimumFontSize, original.properties.minimumFontSize);
    assert.deepEqual(next.properties.outline, original.properties.outline);
    assert.deepEqual(next.properties.shadow, original.properties.shadow);
    assert.deepEqual(next.properties.glow, original.properties.glow);
    assert.deepEqual(next.clipExtension, original.clipExtension);
    assert.deepEqual(next.properties.propertyExtension, original.properties.propertyExtension);
    assert.equal(next.entrance, original.entrance); assert.equal(next.exit, original.exit);
  }
  assert.equal(transformTextBoxEdge(original, 'top', 10, 0), original, 'horizontal motion must not resize a vertical edge');
  assert.equal(transformTextBoxEdge(original, 'right', 0, 10), original, 'vertical motion must not resize a horizontal edge');
  assert.equal(transformTextBoxEdge(original, 'top', 0, 0), original, 'a click must preserve legacy precision');
});

test('text edge geometry clamps to valid ranges and rounds only values it derives', () => {
  const seed = visualSequence('text'), base = seed.clips[0] as TextClip;
  const legacy = { ...base, properties: { ...base.properties, box: {
    x: 100.123456789, y: 50.987654321, width: 400.123456789, height: 200.123456789
  } } } as TextClip;
  const right = transformTextBoxEdge(legacy, 'right', 0.123, Number.MAX_VALUE);
  assert.equal(right.properties.box.x, legacy.properties.box.x);
  assert.equal(right.properties.box.y, legacy.properties.box.y);
  assert.equal(right.properties.box.width, 400.25);
  assert.equal(right.properties.box.height, legacy.properties.box.height);
  const left = transformTextBoxEdge(legacy, 'left', 0.126, 0);
  assert.equal(left.properties.box.x, 100.25);
  assert.equal(left.properties.box.width, 400);
  assert.ok(Math.abs(left.properties.box.x + left.properties.box.width
    - (legacy.properties.box.x + legacy.properties.box.width)) < 0.01);
  assert.equal(transformTextBoxEdge(base, 'right', Number.MAX_VALUE, 0).properties.box.width, 32768);
  assert.equal(transformTextBoxEdge(base, 'right', -Number.MAX_VALUE, 0).properties.box.width, 1);
  assert.equal(transformTextBoxEdge(base, 'left', Number.MAX_VALUE, 0).properties.box.width, 1);
  const farLeft = transformTextBoxEdge(base, 'left', -Number.MAX_VALUE, 0);
  assert.equal(farLeft.properties.box.x, -32268); assert.equal(farLeft.properties.box.width, 32768);
  assert.equal(transformTextBoxEdge(base, 'bottom', Number.MAX_VALUE, Number.MAX_VALUE).properties.box.height, 32768);
  assert.equal(transformTextBoxEdge(base, 'bottom', 0, -Number.MAX_VALUE).properties.box.height, 1);
  const farTop = transformTextBoxEdge(base, 'top', 0, -Number.MAX_VALUE);
  assert.equal(farTop.properties.box.y, -32518); assert.equal(farTop.properties.box.height, 32768);
  assert.doesNotThrow(() => validateSequence({ ...seed, clips: [farLeft] }));
  assert.doesNotThrow(() => validateSequence({ ...seed, clips: [farTop] }));
});

test('text edge controls project to transformed box midpoints, resize in a scaled host, and commit once', t => {
  const seed = visualSequence('text'), original = seed.clips[0] as TextClip;
  const animated = { ...original,
    entrance: { preset: 'fade-zoom', version: 1, durationMs: 2000, easing: 'linear', scale: 0.6 },
    exit: { preset: 'fade-slide', version: 1, durationMs: 3000, easing: 'linear', direction: 'right', distance: 120 }
  } as TextClip;
  const animatedSequence = validateSequence({ ...seed, clips: [animated] });
  const f = fixture(t, 960, 540, true, 2, animatedSequence);
  const top = f.edge('top'), right = f.edge('right'), bottom = f.edge('bottom'), left = f.edge('left');
  assert.equal(top.hidden, false); assert.equal(right.hidden, false); assert.equal(bottom.hidden, false); assert.equal(left.hidden, false);
  assert.deepEqual([top.style.left, top.style.top], ['150px', '35px']);
  assert.deepEqual([right.style.left, right.style.top], ['230px', '75px']);
  assert.deepEqual([bottom.style.left, bottom.style.top], ['150px', '115px']);
  assert.deepEqual([left.style.left, left.style.top], ['70px', '75px']);
  assert.equal(top.title, 'ElementResize: TextEdgeTop'); assert.equal(top.getAttribute('aria-label'), top.title);
  const sourceBefore = f.source;
  f.dispatch('pointerdown', top, { clientX: 300, clientY: 70 });
  assert.equal(f.root.hasPointerCapture(1), true);
  f.dispatch('pointermove', top, { clientX: 300, clientY: 90 });
  assert.deepEqual(f.source, sourceBefore); assert.equal(f.commits.length, 0); assert.equal(f.previews.length, 1);
  const candidate = f.previews[0] as TextClip;
  assert.deepEqual(candidate.properties.box, { x: 100, y: 72.22, width: 400, height: 177.78 });
  assert.equal(candidate.properties.fontSize, original.properties.fontSize);
  assert.equal(candidate.properties.minimumFontSize, original.properties.minimumFontSize);
  assert.deepEqual(candidate.properties.outline, original.properties.outline);
  assert.deepEqual(candidate.properties.shadow, original.properties.shadow);
  assert.deepEqual(candidate.properties.glow, original.properties.glow);
  assert.equal(top.style.left, '150px');
  assert.ok(Math.abs(parseFloat(top.style.top!) - 45) < 0.01, 'preview follows the zoomed top edge');
  f.dispatch('pointerup', top, { clientX: 300, clientY: 90 });
  assert.equal(f.commits.length, 1); assert.deepEqual(f.commits[0], candidate);
  assert.equal(f.root.hasPointerCapture(1), false);
  f.seek(3500); f.handles.update();
  assert.equal(top.style.left, '180px');
  assert.ok(Math.abs(parseFloat(top.style.top!) - 36.11) < 0.01, 'slide motion reprojects the resized box');
});

test('edge keyboard operations use arrows and Shift while perpendicular arrows are no-ops', t => {
  const f = fixture(t, 960, 540, false, 1, visualSequence('text'));
  const right = f.edge('right');
  f.dispatch('keydown', right, { key: 'ArrowUp' });
  assert.equal(f.commits.length, 0);
  f.dispatch('keydown', right, { key: 'ArrowRight', shiftKey: true });
  assert.equal((f.source.clips[0] as TextClip).properties.box.width, 410);
  assert.equal(f.commits.length, 1);
  f.dispatch('keydown', f.edge('top'), { key: 'ArrowLeft' });
  assert.equal(f.commits.length, 1);
  f.dispatch('keydown', f.edge('top'), { key: 'ArrowDown' });
  assert.equal((f.source.clips[0] as TextClip).properties.box.height, 199);
  assert.equal(f.commits.length, 2);
});

test('text edge gestures cancel on Escape, pointer capture loss and stale editor state', t => {
  const f = fixture(t, 960, 540, false, 1, visualSequence('text'));
  const top = f.edge('top');
  f.dispatch('pointerdown', top); f.dispatch('pointermove', top, { clientY: 15 });
  f.dispatch('keydown', top, { key: 'Escape' });
  f.dispatch('pointerdown', top); f.dispatch('pointermove', top, { clientY: 15 });
  f.dispatch('lostpointercapture', top);
  f.dispatch('pointerdown', top); f.dispatch('pointermove', top, { clientY: 15 });
  f.setSource({ ...f.source, name: 'Changed while resizing' }); f.handles.update();
  assert.equal(f.cancellations, 3); assert.equal(f.commits.length, 0);
});

test('text edge gestures cancel when seeking, resizing the viewer, editing is disabled or handles are disposed', t => {
  const f = fixture(t, 960, 540, true, 1, visualSequence('text'));
  const top = f.edge('top');
  const start = () => { f.dispatch('pointerdown', top); f.dispatch('pointermove', top, { clientY: 15 }); };
  const original = f.source;
  start(); f.seek(1200); f.handles.update();
  start(); f.resizeViewer(800, 450);
  start(); f.disable(); f.handles.update();
  const disposed = fixture(t, 960, 540, false, 1, visualSequence('text'));
  disposed.dispatch('pointerdown', disposed.edge('top'));
  disposed.dispatch('pointermove', disposed.edge('top'), { clientY: 15 });
  disposed.handles.dispose();
  assert.equal(f.cancellations, 3); assert.equal(disposed.cancellations, 1);
  assert.equal(f.commits.length, 0); assert.equal(disposed.commits.length, 0);
  assert.deepEqual(f.source, original); assert.equal(f.root.hasPointerCapture(1), false);
  assert.equal(disposed.root.hasPointerCapture(1), false);
});

test('edge handles are hidden and ignore pointer and keyboard input for image and video clips', t => {
  for (const type of ['image', 'video'] as const) {
    const f = fixture(t, 960, 540, false, 1, type === 'image' ? sequence() : visualSequence('video'));
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const handle = f.edge(side); assert.equal(handle.hidden, true);
      f.dispatch('pointerdown', handle); f.dispatch('pointerup', handle, { clientY: 20 });
      f.dispatch('keydown', handle, { key: 'ArrowDown' });
    }
    assert.equal(f.previews.length, 0); assert.equal(f.commits.length, 0);
    f.handles.dispose();
  }
});

test('shared title handles preview a scaled candidate and commit one command in a scaled Foundry host', t => {
  const f = fixture(t, 960, 540, true, 2, visualSequence('text'));
  assert.equal(f.root.dataset.imageEditMode, 'transform');
  const original = f.source;
  f.dispatch('pointerdown', f.corner(2));
  f.dispatch('pointermove', f.corner(2), { clientX: 200, clientY: 100 });
  assert.deepEqual(f.source, original); assert.equal(f.commits.length, 0);
  const next = f.previews[0] as TextClip;
  assert.equal(next.properties.box.width, 600); assert.equal(next.properties.fontSize, 120);
  assert.equal(f.corner(2).style.left, '350px'); assert.equal(f.corner(2).style.top, '175px');
  f.dispatch('pointerup', f.corner(2), { clientX: 200, clientY: 100 });
  assert.equal(f.commits.length, 1);
});

test('unboxed video handles represent the actual portrait surface then opt into logical geometry', t => {
  const f = fixture(t, 540, 960, false, 1, visualSequence('video'));
  assert.equal(f.corner(0).style.left, '0px'); assert.equal(f.corner(0).style.top, '0px');
  assert.equal(f.corner(2).style.left, '540px'); assert.ok(Math.abs(parseFloat(f.corner(2).style.top!) - 960) < 1e-9);
  f.dispatch('pointerdown', f.corner(2)); f.dispatch('pointermove', f.corner(2), { clientX: -27, clientY: -27 });
  assert.equal((f.previews[0] as VideoClip).typeVersion, 6);
  assert.equal((f.source.clips[0] as VideoClip).properties.box, undefined);
  f.dispatch('keydown', f.corner(2), { key: 'Escape' }); assert.equal(f.cancellations, 1); assert.equal(f.commits.length, 0);
  f.dispatch('pointerdown', f.corner(2)); f.dispatch('pointerup', f.corner(2), { clientX: -27, clientY: -27 });
  assert.equal(f.commits.length, 1); assert.doesNotThrow(() => validateSequence(f.source));
  const next = f.source.clips[0] as VideoClip;
  assert.equal(next.properties.box!.width, 1824); assert.equal(next.properties.box!.height, 3317.33);
  assert.deepEqual(next.properties.source, (visualSequence('video').clips[0] as VideoClip).properties.source);
});

test('video move/resize keeps independently authored geometry and rejects nonfinite deltas', () => {
  const clip = visualSequence('video').clips[0] as VideoClip;
  for (const corner of [null, 0, 1, 2, 3]) assert.equal(transformVisualBox(clip, corner, 0, 0,
    { x: -100, y: 0, width: 2120, height: 1080 }), clip, 'A click without movement must not opt legacy video into a box.');
  const next = transformVisualBox(clip, null, 50, 20, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(next.properties.box, { x: 50, y: 20, width: 1920, height: 1080 });
  assert.equal(transformVisualBox(clip, null, NaN, 1), clip);
  const extreme = transformVisualBox(clip, null, Number.MAX_VALUE, -Number.MAX_VALUE, { x: 0, y: 0, width: 1920, height: 1e10 });
  assert.doesNotThrow(() => validateSequence({ ...visualSequence('video'), clips: [extreme] }));
});
