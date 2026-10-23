import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ImagePoint, SequenceV1, SolidClip } from '../src/domain/sequence.js';
import { createBarsSequence } from '../src/domain/validation.js';
import { imageTransition, buildSimpleSequence, type SimpleSolidValues } from '../src/ui/simple-composition.js';
import { patchInspectedClip } from '../src/ui/clip-inspector.js';
import { insertSolidPoint, removeSolidPoint, moveSolidCorner, transformSolidBox, transformVisualBox, VisualHandles, type VisualHandleState } from '../src/ui/image-handles.js';
import { createAnimatedPattern, MAX_POLYGON_POINTS } from '../src/domain/animated-pattern.js';
import { changePatternPreset, resetPatternPalette, changeSolidPolygon } from '../src/ui/animated-surface-inspector.js';
import { validateSequence } from '../src/domain/validation.js';
import { DraftService } from '../src/application/draft-service.js';
import { applyEditorTimelineCommand } from '../src/application/timeline-commands.js';
import { createElementTemplate, instantiateElementTemplate } from '../src/domain/element-template.js';

function ids(prefix = 'solid-editor') { let next = 0; return () => `${prefix}-${++next}`; }

function fixture() {
  const source = createBarsSequence('Solid inspector', ids());
  const track = source.tracks.find(candidate => candidate.kind === 'visual')!;
  const clip: SolidClip = {
    id: 'solid-a', trackId: track.id, type: 'solid', typeVersion: 1,
    startMs: 250, startExtra: 'clip extension',
    duration: { kind: 'fixed', milliseconds: 2000, durationExtra: 'duration extension' },
    entrance: { preset: 'fade', version: 1, durationMs: 300, easing: 'ease-out', transitionExtra: 'entrance extension' },
    exit: { preset: 'fade', version: 1, durationMs: 400, easing: 'ease-in', transitionExtra: 'exit extension' },
    appearance: { blendMode: 'screen', opacity: 0.8, appearanceExtra: 'appearance extension' },
    clipExtra: 'clip extension',
    properties: {
      color: '#223344', fit: 'contain',
      box: { x: 100, y: 50, width: 400, height: 200, boxExtra: 'box extension' },
      crop: { x: 0, y: 0, width: 1, height: 1, cropExtra: 'crop extension' },
      mask: [
        { x: 0.1, y: 0.2, pointExtra: 'mask extension' }, { x: 1, y: 0 },
        { x: 1, y: 1 }, { x: 0, y: 1 }
      ] as unknown as SolidClip['properties']['mask'],
      alphaMap: { kind: 'foundry-file', path: 'alpha/old.png', mapExtra: 'map extension' },
      outline: { enabled: true, color: '#abcdef', opacity: 0.75, width: 3, outlineExtra: 'outline extension' },
      propertiesExtra: 'properties extension'
    }
  } as SolidClip;
  const sequence: SequenceV1 = { ...source, clips: [clip] };
  return { sequence, clip };
}

function solidValues(overrides: Partial<SimpleSolidValues> = {}): SimpleSolidValues {
  return {
    startMs: 500, entranceMs: 700, exitMs: 600, durationMode: 'fixed', durationMs: 3000,
    entrancePreset: 'slide', entranceEasing: 'linear', entranceDirection: 'left', entranceDistance: 42,
    exitPreset: 'fade-zoom', exitEasing: 'back-out', exitScale: 130,
    color: '#aabbcc', alphaMapPath: 'alpha/new.png', fit: 'cover',
    box: { x: 120, y: 70, width: 420, height: 220 },
    crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
    mask: [{ x: 0.2, y: 0.3 }, { x: 0.9, y: 0.1 }, { x: 0.8, y: 0.9 }, { x: 0.1, y: 0.8 }] as unknown as SimpleSolidValues['mask'],
    appearance: { blendMode: 'multiply', opacity: 0.6 },
    outline: { enabled: true, color: '#112233', opacity: 0.5, width: 4 },
    shadow: { enabled: false, color: '#000000', opacity: 0.75, offsetX: 0, offsetY: 8, blur: 16 },
    glow: { enabled: false, color: '#ffffff', opacity: 0.75, radius: 24 },
    ...overrides
  };
}

test('solid inspector patch keeps extensions and alpha-map metadata while editing geometry, effects and transitions', () => {
  const { clip } = fixture();
  const patched = patchInspectedClip(clip, { solid: solidValues() }) as SolidClip;
  assert.equal(patched.id, clip.id);
  assert.equal(patched.trackId, clip.trackId);
  assert.equal((patched as unknown as Record<string, unknown>).clipExtra, 'clip extension');
  assert.equal((patched as unknown as Record<string, unknown>).startExtra, 'clip extension');
  assert.equal((patched.duration as unknown as Record<string, unknown>).durationExtra, 'duration extension');
  assert.equal((patched.properties as unknown as Record<string, unknown>).propertiesExtra, 'properties extension');
  assert.equal(patched.properties.color, '#aabbcc');
  assert.equal(patched.properties.fit, 'cover');
  assert.deepEqual(patched.properties.box, { x: 120, y: 70, width: 420, height: 220, boxExtra: 'box extension' });
  assert.deepEqual(patched.properties.crop, { x: 0.1, y: 0.2, width: 0.7, height: 0.6, cropExtra: 'crop extension' });
  assert.equal((patched.properties.mask[0] as ImagePoint & { pointExtra: string }).pointExtra, 'mask extension');
  assert.deepEqual(patched.properties.alphaMap, { kind: 'foundry-file', path: 'alpha/new.png', mapExtra: 'map extension' });
  assert.equal((patched.properties.outline as unknown as Record<string, unknown>).outlineExtra, 'outline extension');
  assert.deepEqual(patched.entrance, { preset: 'slide', version: 1, durationMs: 700, easing: 'linear', direction: 'left', distance: 42, transitionExtra: 'entrance extension' });
  assert.deepEqual(patched.exit, { preset: 'fade-zoom', version: 1, durationMs: 600, easing: 'back-out', scale: 130, transitionExtra: 'exit extension' });
  assert.deepEqual(patched.appearance, { blendMode: 'multiply', opacity: 0.6, appearanceExtra: 'appearance extension' });
  assert.equal('source' in patched.properties, false, 'solid persistence never creates an image source');
});

test('an explicit empty alpha-map path removes only that optional property and sequence-end drops milliseconds', () => {
  const { clip } = fixture();
  const retained = patchInspectedClip(clip, { solid: solidValues({ alphaMapPath: 'alpha/old.png' }) }) as SolidClip;
  assert.deepEqual(retained.properties.alphaMap, clip.properties.alphaMap);
  const patched = patchInspectedClip(clip, { solid: solidValues({ alphaMapPath: '', durationMode: 'sequence-end' }) }) as SolidClip;
  assert.equal('alphaMap' in patched.properties, false);
  assert.deepEqual(patched.duration, { kind: 'sequence-end', durationExtra: 'duration extension' });
  assert.equal((patched.properties as unknown as Record<string, unknown>).propertiesExtra, 'properties extension');
  assert.equal(patched.properties.color, '#aabbcc');
});

test('shared image transition builder accepts solid values and simple composition remains unsupported', () => {
  const { sequence, clip } = fixture();
  const next = imageTransition(clip.entrance, solidValues(), 'entrance');
  assert.equal(next.preset, 'slide');
  assert.equal(next.durationMs, 700);
  assert.throws(() => buildSimpleSequence(sequence, ids('simple'), {
    name: sequence.name, presentation: sequence.presentation, end: sequence.end
  }), { message: 'SIMPLE_COMPOSITION_UNSUPPORTED_SOLID' });
});

test('solid mask and transform helpers retain type and obey the shared geometry bounds', () => {
  const { clip } = fixture();
  const movedMask = moveSolidCorner(clip, 0, 0.2, 0.1);
  assert.equal(movedMask.type, 'solid');
  assert.equal(movedMask.properties.mask[0].x, 0.3);
  assert.equal((movedMask.properties.mask[0] as ImagePoint & { pointExtra: string }).pointExtra, 'mask extension');
  const transformed = transformSolidBox(movedMask, 0, -40, -20);
  assert.deepEqual(transformed.properties.box, { x: 60, y: 30, width: 440, height: 220, boxExtra: 'box extension' });
  assert.equal(transformVisualBox(clip, 2, -1000, -1000).properties.box.width, 1);
  assert.equal('source' in transformed.properties, false);
});

test('polygon operations preserve v1 for four-point presets, upgrade explicit point edits and enforce bounds', () => {
  const { clip } = fixture();
  assert.equal(changeSolidPolygon(clip, 'diamond').typeVersion, 1);
  assert.equal(changeSolidPolygon(clip, 'missing'), clip);
  const triangle = changeSolidPolygon(clip, 'triangle'); assert.equal(triangle.typeVersion, 2);
  assert.equal(removeSolidPoint(triangle, 0), triangle);
  const inserted = insertSolidPoint(triangle, 2); assert.equal(inserted.properties.mask.length, 4);
  assert.equal(inserted.typeVersion, 2); assert.deepEqual(inserted.properties.mask[3], { x: 0.25, y: 0.5 });
  assert.equal(changeSolidPolygon(inserted, 'rectangle').typeVersion, 2);
  const moved = moveSolidCorner(insertSolidPoint(inserted, 3), 4, 0.013333, -0.012222);
  assert.equal(moved.properties.mask[4]!.x, 0.3883); assert.equal(moved.properties.mask[4]!.y, 0.2378);
  assert.deepEqual(moved.properties.mask.slice(0, 4), inserted.properties.mask);
  assert.equal(moveSolidCorner(moved, 5, 0.1, 0.1), moved);
  assert.equal(insertSolidPoint(moved, -1), moved); assert.equal(removeSolidPoint(moved, 99), moved);
  let bounded = moved;
  while (bounded.properties.mask.length < MAX_POLYGON_POINTS) bounded = insertSolidPoint(bounded, 0);
  assert.equal(insertSolidPoint(bounded, 0), bounded);
  const removed = removeSolidPoint(insertSolidPoint(clip, 0), 1);
  assert.equal(removed.typeVersion, 2); assert.deepEqual(removed.properties.mask, clip.properties.mask);
});

test('pattern preset and palette actions preserve extensions, nested settings and version through inspector patches', () => {
  const { clip } = fixture();
  const pattern = { ...createAnimatedPattern(), colors: ['#112233', '#445566', '#778899'] as const, extra: { keep: true } };
  const changed = changePatternPreset(pattern, 'confetti');
  assert.equal(changed.preset, 'confetti'); assert.deepEqual(changed.colors, pattern.colors);
  assert.equal(changePatternPreset(pattern, 'missing'), pattern);
  assert.notDeepEqual(resetPatternPalette(changed).colors, pattern.colors);
  const upgraded = patchInspectedClip(clip, { solid: solidValues({ pattern }) }) as SolidClip;
  assert.equal(upgraded.typeVersion, 2);
  const repatched = patchInspectedClip(upgraded, { solid: solidValues({ pattern: createAnimatedPattern('starfield') }) }) as SolidClip;
  assert.deepEqual((repatched.properties.pattern as typeof pattern).extra, { keep: true });
  const retained = patchInspectedClip(upgraded, { solid: solidValues() }) as SolidClip;
  assert.equal(retained.typeVersion, 2); assert.deepEqual(retained.properties.pattern, pattern);
});

test('animated polygon element templates copy complete authored settings independently', () => {
  const { clip } = fixture();
  const polygon = changeSolidPolygon(clip, 'star');
  const animated: SolidClip = { ...polygon, typeVersion: 2, properties: { ...polygon.properties, pattern: createAnimatedPattern('spark-trails') } };
  const template = createElementTemplate('pattern-template', 'Sparks', animated, { width: 1920, height: 1080 });
  const instance = instantiateElementTemplate(template, { trackId: clip.trackId, startMs: 500, composition: { width: 1920, height: 1080 } }, () => 'fresh-solid') as SolidClip;
  assert.equal(instance.typeVersion, 2); assert.equal(instance.id, 'fresh-solid');
  assert.deepEqual(instance.properties, animated.properties);
  assert.notEqual(instance.properties, animated.properties); assert.notEqual(instance.properties.mask, animated.properties.mask);
  assert.notEqual(instance.properties.pattern, animated.properties.pattern);
});

class FakeElement extends EventTarget {
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly captured = new Set<number>();
  className = '';
  hidden = false;
  title = '';
  type = '';
  readonly classList = { add: (name: string) => { this.className += ` ${name}`; } };
  constructor(readonly tagName = 'div') { super(); }
  append(...children: FakeElement[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  removeChild(child: FakeElement) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  get clientWidth() { return 960; }
  get clientHeight() { return 540; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540 }; }
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) { this.captured.delete(id); }
  focus() {}
  contains(node: FakeElement): boolean { return node === this || this.children.some(child => child.contains(node)); }
  closest<T extends FakeElement = FakeElement>(selector: string): T | null {
    if (selector.includes(',')) return selector.split(',').map(part => this.closest(part.trim())).find(Boolean) as T | null ?? null;
    const key = /^\[data-([\w-]+)\]$/.exec(selector)?.[1]?.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return key && key in this.dataset ? this as unknown as T : this.parentElement?.closest<T>(selector) ?? null;
  }
  find(key: string, value?: string): FakeElement | undefined {
    if (key in this.dataset && (value === undefined || this.dataset[key] === value)) return this;
    return this.children.map(child => child.find(key, value)).find(Boolean);
  }
}

test('preview handle drag commits solid mask edits and cancels a later transform without changing selection', t => {
  const initial = fixture().sequence;
  let current = initial;
  let previews: SolidClip[] = [];
  let commits = 0, cancels = 0;
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'Element');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const doc = {
    createElement: (tag: string) => new FakeElement(tag), createElementNS: () => new FakeElement('svg'),
    get activeElement() { return null; }
  };
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: undefined });
  t.after(() => {
    for (const [key, descriptor] of [['Element', originalElement], ['document', originalDocument], ['ResizeObserver', originalResizeObserver]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });

  const viewer = new FakeElement();
  const read = (): VisualHandleState<SolidClip> => ({ sequence: structuredClone(current), clip: structuredClone(current.clips[0] as SolidClip), editable: true, positionMs: 1000 });
  const handles = new VisualHandles<SolidClip>(viewer as unknown as HTMLElement, key => key, {
    read, before: () => true, preview: value => previews.push(value), cancel: () => { cancels++; },
    commit: (_sequenceId, _clipId, value) => { commits++; current = { ...current, clips: [value] }; return true; }
  });
  t.after(() => handles.dispose()); handles.update();
  const overlay = viewer.children[0]!;
  const event = (type: string, target: FakeElement, clientX: number, clientY: number) => {
    const value = new Event(type, { cancelable: true });
    Object.defineProperties(value, { target: { value: target }, button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: clientX }, clientY: { value: clientY } });
    overlay.dispatchEvent(value); return value;
  };

  const original = current.clips[0] as SolidClip;
  const corner = overlay.find('imageCorner', '0')!;
  event('pointerdown', corner, 0, 0); event('pointermove', corner, 40, 20); event('pointerup', corner, 40, 20);
  const committed = current.clips[0] as SolidClip;
  assert.equal(commits, 1);
  assert.equal(committed.properties.mask[0].x, 0.3);
  assert.equal(committed.properties.mask[0].y, 0.4);
  assert.equal(original.properties.mask[0].x, 0.1, 'preview does not mutate the selected source clip');
  assert.ok(previews.length > 0);

  const beforeCancel = structuredClone(current);
  const transform = overlay.find('imageMode', 'transform')!;
  event('click', transform, 0, 0);
  const move = overlay.find('imageMove')!;
  event('pointerdown', move, 10, 10); event('pointermove', move, 25, 35);
  assert.ok(previews.at(-1)!.properties.box.x > (beforeCancel.clips[0] as SolidClip).properties.box.x);
  event('pointercancel', move, 25, 35);
  assert.equal(commits, 1);
  assert.equal(cancels, 1);
  assert.deepEqual(current, beforeCancel, 'cancel restores the persisted draft exactly');
});

test('variable polygon handles commit each point gesture or operation once, cancel stale state and honor locks', async t => {
  const source = validateSequence(fixture().sequence);
  const draft = new DraftService({ list: async () => [], read: async () => source, save: async value => value, delete: async () => {} }, ids('polygon-undo'));
  await draft.load(source.id);
  const originalGlobals = new Map(['Element', 'document', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new FakeElement(tag), createElementNS: () => new FakeElement('svg'), activeElement: null } });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: undefined });
  t.after(() => { for (const [key, descriptor] of originalGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  let editable = true, selected = true, positionMs = 1000, commits = 0, previews = 0, cancels = 0;
  const read = (): VisualHandleState<SolidClip> => ({ sequence: draft.draft, clip: selected ? draft.draft!.clips[0] as SolidClip : null, editable, positionMs });
  const viewer = new FakeElement();
  const handles = new VisualHandles<SolidClip>(viewer as unknown as HTMLElement, key => key, {
    read, before: () => editable, preview: () => { previews++; }, cancel: () => { cancels++; },
    commit: (_sequenceId, _clipId, clip) => { commits++; draft.replace(applyEditorTimelineCommand(draft.draft!, { kind: 'replace-clip', clip }, ids('polygon-command'))); return true; }
  });
  t.after(() => handles.dispose()); handles.update();
  const overlay = viewer.children[0]!;
  const event = (type: string, target: FakeElement, x = 0, y = 0) => {
    const value = new Event(type, { cancelable: true });
    Object.defineProperties(value, { target: { value: target }, button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y } });
    overlay.dispatchEvent(value);
  };
  handles.editPoint('add'); assert.equal(commits, 1);
  const added = draft.draft!;
  assert.equal((added.clips[0] as SolidClip).typeVersion, 2);
  assert.ok(overlay.find('imageCorner', '4'));
  const fifth = overlay.find('imageCorner', '4')!;
  event('pointerdown', fifth); event('pointermove', fifth, 20, 20); event('pointermove', fifth, 30, 30); event('pointerup', fifth, 30, 30);
  assert.equal(commits, 2); assert.ok(previews >= 2);
  const moved = draft.draft!;
  assert.notDeepEqual((moved.clips[0] as SolidClip).properties.mask[4], (added.clips[0] as SolidClip).properties.mask[4]);
  assert.deepEqual(draft.undo(), added); assert.deepEqual(draft.undo(), source); draft.redo(); draft.redo(); handles.update();
  handles.editPoint('remove'); assert.equal(commits, 3); assert.equal((draft.draft!.clips[0] as SolidClip).properties.mask.length, 4);
  assert.deepEqual(draft.undo(), moved); handles.update();
  const snapshot = draft.draft!;
  for (const stale of ['locked', 'selection', 'clock'] as const) {
    const corner = overlay.find('imageCorner', '4')!;
    event('pointerdown', corner); event('pointermove', corner, 10, 10);
    if (stale === 'locked') editable = false;
    if (stale === 'selection') selected = false;
    if (stale === 'clock') positionMs++;
    handles.update(); event('pointerup', corner, 20, 20);
    assert.deepEqual(draft.draft, snapshot); assert.equal(commits, 3);
    editable = true; selected = true; handles.update();
  }
  assert.equal(cancels, 3);
  editable = false; handles.editPoint('add'); handles.editPoint('remove'); assert.equal(commits, 3);
  editable = true;
  const triangle = changeSolidPolygon(draft.draft!.clips[0] as SolidClip, 'triangle');
  draft.replace({ ...draft.draft!, clips: [triangle] }); handles.update();
  assert.equal(overlay.find('imageCorner', '3'), undefined);
  event('click', overlay.find('imageMode', 'transform')!); assert.ok(overlay.find('imageCorner', '3')); assert.equal(overlay.find('imageCorner', '4'), undefined);
  event('click', overlay.find('imageMode', 'mask')!); assert.equal(overlay.find('imageCorner', '3'), undefined);
});

test('solid inspector template and both locale bundles expose the alpha and animation contract', () => {
  const template = readFileSync('templates/editor.hbs', 'utf8');
  const solidStart = template.indexOf('data-stagecraft-element-panel="solid"');
  const solidEnd = template.indexOf('data-stagecraft-element-panel="video"', solidStart);
  assert.ok(solidStart >= 0 && solidEnd > solidStart);
  const panel = template.slice(solidStart, solidEnd);
  for (const field of ['solid-color', 'solid-alpha-path', 'solid-fit', 'solid-x', 'solid-crop-width', 'solid-mask-3-y', 'solid-outline-width', 'solid-shadow-blur', 'solid-glow-radius', 'solid-start', 'solid-duration', 'solid-entrance-preset', 'solid-exit-preset']) {
    assert.match(panel, new RegExp(`name="${field}"`));
  }
  for (const section of ['content', 'animation', 'timing']) assert.ok(panel.includes(`data-stagecraft-clip-section-page="${section}"`));
  for (const marker of ['data-stagecraft-solid-alpha-settings', 'data-stagecraft-solid-alpha-dependent', 'data-stagecraft-solid-animations', 'data-stagecraft-solid-animation=', 'data-stagecraft-solid-animation-param=', 'data-stagecraft-solid-end', 'data-stagecraft-solid-out-held']) assert.ok(panel.includes(marker), marker);
  for (const action of ['choose-solid-alpha', 'clear-solid-alpha', 'reset-solid-mask']) assert.ok(panel.includes(`data-stagecraft-action="${action}"`));
  assert.doesNotMatch(panel, /name="image-path"|source:\s*\{/);

  for (const localePath of ['lang/en.json', 'lang/de.json']) {
    const locale = JSON.parse(readFileSync(localePath, 'utf8')) as Record<string, string>;
    for (const key of ['STAGECRAFT.Editor.ColorSurface', 'STAGECRAFT.Editor.AddColorSurface', 'STAGECRAFT.Editor.AlphaMap', 'STAGECRAFT.Editor.ChooseAlphaMap', 'STAGECRAFT.Editor.RemoveAlphaMap', 'STAGECRAFT.Editor.AlphaMapHint', 'STAGECRAFT.Editor.SolidEnd', 'STAGECRAFT.Editor.SolidOutHeldHint']) {
      assert.ok(locale[key], `${localePath} must define ${key}`);
    }
  }
});
