import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import { TEXT_MOTION_PRESETS, textMotionControls } from '../src/domain/text-motion.js';
import { textMotionSegmentCount, type TextMotionLayout } from '../src/rendering/text-motion-renderer.js';
import type { SequenceV1, TextClip, Transition } from '../src/domain/sequence.js';
import { patchInspectedClip } from '../src/ui/clip-inspector.js';
import { buildSimpleSequence, type SimpleTextValues } from '../src/ui/simple-composition.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { LocalPlayer } from '../src/playback/local-player.js';
import type { PlayerFrame, Surface } from '../src/playback/local-player.js';

function ids() { let next = 0; return () => `text-motion-editor-${++next}`; }

function motionSequence(): SequenceV1 {
  const base = createBarsSequence('Text motion', ids());
  const title = {
    ...base.clips[0]!, type: 'text', typeVersion: 1,
    duration: { kind: 'fixed', milliseconds: 5_000 },
    entrance: {
      preset: 'text-motion', version: 1, durationMs: 900, easing: 'ease-out',
      motion: 'line-reveal', amount: 2.25, stagger: 0.6, futureEntrance: 'keep'
    },
    exit: {
      preset: 'text-motion', version: 1, durationMs: 720, easing: 'ease-in',
      motion: 'noise-dissolve', amount: 0.8, stagger: 0.2, futureExit: 'keep'
    },
    properties: {
      text: 'Segmented title', fontFamily: 'Arial', fontSize: 72, minimumFontSize: 24,
      color: '#ffffff', align: 'center', box: { x: 0, y: 100, width: 1920, height: 800 }, shrinkToFit: true
    }
  } as unknown as TextClip;
  return validateSequence({ ...base, end: { kind: 'fixed', durationMs: 5_000 }, clips: [title] });
}

function values(clip: TextClip): SimpleTextValues {
  const durationMs = clip.duration.kind === 'fixed' ? clip.duration.milliseconds : 5_000;
  return {
    startMs: clip.startMs, durationMode: clip.duration.kind, durationMs,
    entranceMs: clip.entrance.preset === 'none' ? 0 : clip.entrance.durationMs,
    exitMs: clip.exit.preset === 'none' ? 0 : clip.exit.durationMs,
    entrancePreset: clip.entrance.preset, exitPreset: clip.exit.preset,
    entranceEasing: clip.entrance.preset === 'none' ? 'ease-in-out' : clip.entrance.easing,
    exitEasing: clip.exit.preset === 'none' ? 'ease-in-out' : clip.exit.easing,
    ...(clip.entrance.preset === 'text-motion' ? {
      entranceMotion: clip.entrance.motion, entranceAmount: clip.entrance.amount ?? 1, entranceStagger: clip.entrance.stagger ?? 0.35,
      ...(clip.entrance.motionDirection === undefined ? {} : { entranceMotionDirection: clip.entrance.motionDirection }),
      ...(clip.entrance.motionOrder === undefined ? {} : { entranceMotionOrder: clip.entrance.motionOrder })
    } : {}),
    ...(clip.exit.preset === 'text-motion' ? {
      exitMotion: clip.exit.motion, exitAmount: clip.exit.amount ?? 1, exitStagger: clip.exit.stagger ?? 0.35,
      ...(clip.exit.motionDirection === undefined ? {} : { exitMotionDirection: clip.exit.motionDirection }),
      ...(clip.exit.motionOrder === undefined ? {} : { exitMotionOrder: clip.exit.motionOrder })
    } : {}),
    ...clip.properties
  };
}

test('direct numeric entry updates the running editor preview without restarting its clock', async t => {
  const f = await editorFixture(t);
  await f.startPreview();
  f.advance(400);
  f.edit('title-size', '96');
  assert.equal(f.preview.getState().phase, 'playing');
  assert.equal(f.preview.getState().positionMs, 400);
  assert.equal((f.rendered.at(-1)!.items[0]!.clip as TextClip).properties.fontSize, 96);
  assert.equal(f.clip().properties.fontSize, 96);
  f.advance(300);
  assert.equal(f.preview.getState().positionMs, 700);
  assert.equal((f.rendered.at(-1)!.items[0]!.clip as TextClip).properties.fontSize, 96);
  f.edit('title-size', '-1');
  assert.equal(f.clip().properties.fontSize, 96, 'invalid input does not corrupt the draft');
  f.advance(100);
  assert.equal(f.preview.getState().positionMs, 800, 'invalid input does not stop playback');
});

test('text preset choices have separate Undo steps after a focused numeric edit', async t => {
  const f = await editorFixture(t);
  f.focus('title-size');
  f.edit('title-size', '84');
  f.edit('text-entrance-preset', 'fade');
  f.edit('text-entrance-preset', 'text-motion:gravity-out');
  assert.equal(f.clip().entrance.preset, 'text-motion');
  f.draft.undo();
  assert.equal(f.clip().entrance.preset, 'fade');
  assert.equal(f.clip().properties.fontSize, 84);
  f.draft.undo();
  const restored = f.clip().entrance;
  assert.equal(restored.preset, 'text-motion');
  assert.equal(restored.motion, 'line-reveal');
  assert.equal(f.clip().properties.fontSize, 84);
  f.draft.undo();
  assert.equal(f.clip().properties.fontSize, 72);
  assert.equal(f.draft.canUndo, false);
});

test('text In and Out have separate preview hosts and retain the native preset fallback', async () => {
  const template = await readFile('templates/editor.hbs', 'utf8');
  assert.equal([...template.matchAll(/data-stagecraft-text-animation-picker=/g)].length, 2);
  for (const phase of ['entrance', 'exit']) {
    assert.match(template, new RegExp(`data-stagecraft-text-animation-picker="${phase}"><label class="stagecraft-text-animation-select">`));
    assert.match(template, new RegExp(`<select name="text-${phase}-preset">`));
  }
  for (const language of ['en', 'de']) {
    const labels = JSON.parse(await readFile(`lang/${language}.json`, 'utf8')) as Record<string, string>;
    for (const suffix of ['Compare', 'Collapse', 'Sample']) assert.ok(labels['STAGECRAFT.Editor.TextAnimation' + suffix]);
    assert.match(labels['STAGECRAFT.Editor.TextAnimationSample']!, /\n/);
  }
});

test('advancing preview frames do not rescan every numeric field or serialize the draft', async t => {
  const f = await editorFixture(t);
  await f.startPreview();
  const reads = f.contextReads();
  f.advance(100); f.advance(100); f.advance(100);
  assert.equal(f.preview.getState().positionMs, 300);
  assert.equal(f.contextReads(), reads);
});

test('numeric dragging survives preview frames, updates immediately and commits exactly one Undo', async t => {
  const f = await editorFixture(t);
  await f.startPreview();
  f.advance(200);
  f.pointer('pointerdown', 'title-size', 100);
  f.pointer('pointermove', 'title-size', 140);
  assert.equal((f.rendered.at(-1)!.items[0]!.clip as TextClip).properties.fontSize, 82);
  assert.equal(f.clip().properties.fontSize, 72, 'drag previews are transient');
  assert.equal(f.draft.canUndo, false);
  f.advance(100);
  f.pointer('pointermove', 'title-size', 180);
  assert.equal((f.rendered.at(-1)!.items[0]!.clip as TextClip).properties.fontSize, 92);
  f.advance(100);
  f.pointer('pointerup', 'title-size', 180);
  assert.equal(f.clip().properties.fontSize, 92);
  assert.equal(f.preview.getState().phase, 'playing');
  assert.equal(f.preview.getState().positionMs, 400);
  f.advance(100);
  assert.equal(f.preview.getState().positionMs, 500);
  f.draft.undo();
  assert.equal(f.clip().properties.fontSize, 72);
  assert.equal(f.draft.canUndo, false, 'all pointer movements make one history entry');
});

test('Escape rolls a live numeric drag back without stopping the preview or adding Undo', async t => {
  const f = await editorFixture(t);
  await f.startPreview();
  f.advance(200);
  f.pointer('pointerdown', 'title-size', 100);
  f.pointer('pointermove', 'title-size', 160);
  assert.equal((f.rendered.at(-1)!.items[0]!.clip as TextClip).properties.fontSize, 87);
  f.advance(100);
  f.escape();
  assert.equal((f.rendered.at(-1)!.items[0]!.clip as TextClip).properties.fontSize, 72);
  assert.equal(f.fields.get('title-size')!.value, '72');
  assert.equal(f.draft.canUndo, false);
  assert.equal(f.preview.getState().phase, 'playing');
  f.advance(100);
  assert.equal(f.preview.getState().positionMs, 400);
});

async function editorFixture(t: TestContext, source = motionSequence()) {
  class Field extends EventTarget {
    children: Field[] = []; dataset: Record<string, string> = {}; name = ''; private currentValue = ''; checked = false;
    hidden = false; disabled = false; type = ''; textContent = ''; title = ''; parent: Field | null = null; min = ''; max = ''; step = 'any';
    private capture: number | null = null;
    classList = { toggle() {}, add() {}, remove() {} };
    constructor(readonly tag = 'div') { super(); }
    get value() { return this.currentValue; }
    set value(value: string) { this.currentValue = this.tag !== 'select' || this.children.some(option => option.value === value) ? value : ''; }
    get options() { return this.children; }
    append(...children: Field[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren() { this.children = []; }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector: string): boolean {
      if (selector === 'input[type="number"]') return this.tag === 'input' && this.type === 'number';
      if (selector === '[name]') return !!this.name;
      const name = selector.match(/^\[name="([^"]+)"\]$/); if (name) return this.name === name[1];
      const data = selector.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/); if (!data) return false;
      const key = data[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return key in this.dataset && (data[2] === undefined || this.dataset[key] === data[2]);
    }
    querySelectorAll<T>(selector: string): T[] {
      if (selector === '[data-stagecraft-inspector] input[type="number"]') return this.querySelectorAll<Field>('[data-stagecraft-inspector]')
        .flatMap(inspector => inspector.querySelectorAll<T>('input[type="number"]'));
      return this.children.flatMap(child => [...(child.matches(selector) ? [child as unknown as T] : []), ...child.querySelectorAll<T>(selector)]);
    }
    querySelector<T>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
    closest<T>(selector: string): T | null { return this.matches(selector) ? this as unknown as T : this.parent?.closest<T>(selector) ?? null; }
    focus() {} select() {}
    setPointerCapture(id: number) { this.capture = id; }
    hasPointerCapture(id: number) { return this.capture === id; }
    releasePointerCapture(id: number) { if (this.capture === id) this.capture = null; }
    checkValidity() { return this.type !== 'number' || this.value.trim() !== '' && Number.isFinite(Number(this.value))
      && (this.min === '' || Number(this.value) >= Number(this.min)) && (this.max === '' || Number(this.value) <= Number(this.max)); }
  }
  let now = 0, frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const globals = {
    Element: Field, HTMLElement: Field, HTMLInputElement: Field, HTMLSelectElement: Field, HTMLTextAreaElement: Field,
    document: { createElement: (tag: string) => new Field(tag) },
    performance: { now: () => now },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); }
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });

  const root = new Field(), panel = new Field(); panel.dataset.stagecraftElementPanel = 'text';
  const inspector = new Field(); inspector.dataset.stagecraftInspector = ''; root.append(inspector);
  inspector.append(panel);
  const fields = new Map<string, Field>();
  function field(name: string, parent = root, options?: string[], minimum = 0, maximum = Infinity) {
    const input = new Field(options ? 'select' : 'input'); input.name = name;
    if (!options) { input.type = 'number'; input.min = String(minimum); input.max = Number.isFinite(maximum) ? String(maximum) : ''; }
    for (const value of options ?? []) { const option = new Field('option'); option.value = value; input.append(option); }
    parent.append(input); fields.set(name, input); return input;
  }
  field('ending', root, ['automatic', 'fixed', 'manual', 'media']); field('sequence-duration'); field('clip-track', root, []);
  field('text-start', panel); field('text-duration-mode', panel, ['fixed', 'sequence-end']); field('text-duration', panel, undefined, 0.001);
  field('title-size', panel, undefined, 1, 999);
  field('title-text', panel).type = 'text';
  const rows = new Map<string, Field>();
  for (const phase of ['entrance', 'exit'] as const) {
    const row = new Field(); row.dataset.stagecraftTextAnimation = phase; panel.append(row); rows.set(phase, row);
    const motionIds = TEXT_MOTION_PRESETS.map(preset => 'text-motion:' + preset.id);
    field('text-' + phase + '-preset', row, ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom', ...motionIds]);
    const duration = new Field(); duration.dataset.stagecraftTextAnimationParam = phase; row.append(duration); rows.set(phase + '-duration', duration);
    field('text-' + phase, duration, undefined, 0.001, 600);
    const easing = new Field(); easing.dataset.stagecraftTextAnimationParam = phase; row.append(easing); rows.set(phase + '-easing', easing);
    field('text-' + phase + '-easing', easing, ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-in', 'back-out', 'back-in-out']);
    for (const [suffix, minimum, maximum] of [['amount', 0, 4], ['stagger', 0, 90]] as const) {
      const parameter = new Field(); parameter.dataset.stagecraftTextAnimationParam = phase; parameter.dataset.stagecraftAnimationKind = 'motion';
      row.append(parameter); rows.set(phase + '-' + suffix, parameter);
      field('text-' + phase + '-' + suffix, parameter, undefined, minimum, maximum);
    }
    for (const [suffix, options] of [
      ['motion-direction', ['default', 'up', 'down', 'left', 'right']],
      ['motion-order', ['default', 'forward', 'reverse', 'center-out', 'edges-in', 'random']]
    ] as const) {
      const parameter = new Field(); parameter.dataset.stagecraftTextAnimationParam = phase; parameter.dataset.stagecraftAnimationKind = suffix;
      row.append(parameter); rows.set(phase + '-' + suffix, parameter);
      field('text-' + phase + '-' + suffix, parameter, [...options]);
    }
    for (const suffix of ['direction', 'distance', 'scale']) {
      const parameter = new Field(); parameter.dataset.stagecraftTextAnimationParam = phase;
      parameter.dataset.stagecraftAnimationKind = suffix === 'scale' ? 'zoom' : 'slide'; row.append(parameter); rows.set(phase + '-' + suffix, parameter);
      field('text-' + phase + '-' + suffix, parameter, suffix === 'direction' ? ['left', 'right', 'up', 'down'] : undefined,
        suffix === 'scale' ? 5 : 0, suffix === 'scale' ? 400 : suffix === 'distance' ? 32768 : Infinity);
    }
  }
  const services: EditorServices = {
    makeId: ids(), repository: { list: async () => [source], read: async () => source, save: async value => value, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }), localize: key => key,
    confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {},
    prepareGroup: async () => {}, openSession() {}, groupActive: () => false, chooseVideo: async () => null, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services); await view.mount(root as unknown as HTMLElement); t.after(() => view.detach());
  const driver = view as unknown as { numericScrubberContext(input: HTMLInputElement): unknown };
  const readContext = driver.numericScrubberContext.bind(driver);
  let contextReads = 0;
  driver.numericScrubberContext = input => { contextReads++; return readContext(input); };
  function edit(name: string, value: string) {
    const input = fields.get(name)!; input.value = value;
    const event = new Event('input'); Object.defineProperty(event, 'target', { value: input }); root.dispatchEvent(event);
  }
  function focus(name: string) {
    const event = new Event('focusin'); Object.defineProperty(event, 'target', { value: fields.get(name) }); root.dispatchEvent(event);
  }
  const preview = (view as unknown as { preview: LocalPlayer }).preview;
  const rendered: PlayerFrame[] = [];
  const surface: Surface = { prepare: async () => {}, render: frame => rendered.push(frame), dispose() {} };
  function pointer(type: string, name: string, x: number) {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries({ target: fields.get(name), pointerId: 1, button: 0, clientX: x, clientY: 0, detail: 1 })) {
      Object.defineProperty(event, key, { value });
    }
    root.dispatchEvent(event);
  }
  return { fields, rows, edit, focus, preview, rendered, draft: view.draft, pointer, contextReads: () => contextReads,
    startPreview: () => preview.startPreview(view.draft.draft!, surface),
    advance: (elapsed: number) => { now += elapsed; const queued = [...frames.values()]; frames.clear(); for (const callback of queued) callback(now); },
    escape: () => { const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value: 'Escape' }); root.dispatchEvent(event); },
    clip: () => view.draft.draft!.clips[0]! as TextClip,
    reportLayout: (layout: TextMotionLayout) => (view as unknown as { receiveTextMotionLayout(layout: TextMotionLayout): void }).receiveTextMotionLayout(layout)
  };
}

test('text motion survives title content edits and simple-sequence round trips', () => {
  const source = motionSequence();
  const title = source.clips[0]! as TextClip;
  const edit = { ...values(title), text: 'Edited title', fontSize: 84 };

  const inspected = patchInspectedClip(title, { text: edit }) as TextClip;
  assert.deepEqual(inspected.entrance, title.entrance);
  assert.deepEqual(inspected.exit, title.exit);
  assert.equal(inspected.properties.text, 'Edited title');

  const rebuilt = buildSimpleSequence(source, ids(), {
    name: source.name, end: source.end, presentation: source.presentation, text: edit
  }).clips[0]! as TextClip;
  assert.deepEqual(rebuilt.entrance, title.entrance);
  assert.deepEqual(rebuilt.exit, title.exit);
  assert.equal(rebuilt.properties.text, 'Edited title');
});

test('switching a title motion to a legacy preset clears only known motion fields', () => {
  const title = motionSequence().clips[0]! as TextClip;
  const legacyEdit: SimpleTextValues = {
    ...values(title), entrancePreset: 'fade', entranceMs: 500, entranceEasing: 'ease-in-out',
    text: title.properties.text
  };
  const changed = patchInspectedClip(title, { text: legacyEdit }) as TextClip;

  assert.equal(changed.entrance.preset, 'fade');
  assert.equal('motion' in changed.entrance, false);
  assert.equal('amount' in changed.entrance, false);
  assert.equal('stagger' in changed.entrance, false);
  assert.equal('motionDirection' in changed.entrance, false);
  assert.equal('motionOrder' in changed.entrance, false);
  assert.equal((changed.entrance as Transition & { futureEntrance?: string }).futureEntrance, 'keep');
  assert.deepEqual(changed.exit, title.exit);
});

test('choosing motions seeds their duration, easing and segmented controls through the editor', async t => {
  const original = motionSequence();
  const title = { ...original.clips[0]!,
    entrance: { preset: 'none' as const, version: 1 as const }, exit: { preset: 'none' as const, version: 1 as const }
  } as TextClip;
  const f = await editorFixture(t, validateSequence({ ...original, clips: [title] }));

  f.edit('text-entrance-preset', 'text-motion:line-reveal');
  assert.equal(f.fields.get('text-entrance-preset')!.value, 'text-motion:line-reveal');
  assert.equal(f.fields.get('text-entrance-preset')!.disabled, false);
  assert.deepEqual([...f.fields].filter(([, field]) => !field.disabled && !field.checkValidity()).map(([name]) => name), []);
  assert.deepEqual(f.clip().entrance, {
    preset: 'text-motion', version: 1, durationMs: 720, easing: 'ease-out',
    motion: 'line-reveal', amount: 1, stagger: 0.35, motionDirection: 'default', motionOrder: 'default'
  });
  assert.equal(f.fields.get('text-entrance')!.value, '0.72');
  assert.equal(f.rows.get('entrance-amount')!.hidden, false);
  assert.equal(f.rows.get('entrance-stagger')!.hidden, false);
  assert.equal(f.fields.get('text-entrance-direction')!.disabled, true);

  f.edit('text-exit-preset', 'text-motion:noise-dissolve');
  assert.deepEqual(f.clip().exit, {
    preset: 'text-motion', version: 1, durationMs: 720, easing: 'ease-in',
    motion: 'noise-dissolve', amount: 1, stagger: 0.35, motionDirection: 'default', motionOrder: 'default'
  });
  assert.equal(f.fields.get('text-exit')!.value, '0.72');
});

test('all 28 presets appear in one localized text motion group in each title phase only', async () => {
  const template = await readFile('templates/editor.hbs', 'utf8');
  const title = template.slice(template.indexOf('data-stagecraft-element-panel="text"'), template.indexOf('data-stagecraft-element-panel="video"'));
  const options = [...title.matchAll(/<option value="text-motion:([^"]+)">/g)].map(match => match[1]);
  assert.deepEqual(options, [...TEXT_MOTION_PRESETS, ...TEXT_MOTION_PRESETS].map(preset => preset.id));
  const groups = [...title.matchAll(/<optgroup label="\{\{localize 'STAGECRAFT\.Editor\.TextMotionGroup'\}\}">([\s\S]*?)<\/optgroup>/g)];
  assert.equal(groups.length, 2);
  for (const group of groups) assert.deepEqual([...group[1]!.matchAll(/value="text-motion:([^"]+)"/g)].map(match => match[1]), TEXT_MOTION_PRESETS.map(preset => preset.id));
  assert.doesNotMatch(title, /\(reverse\)|type="checkbox"[^>]*motion-reverse|TextMotionReverse/);
  assert.match(title, /name="text-entrance-amount" min="0" max="4"/);
  assert.match(title, /name="text-exit-amount" min="0" max="4"/);
  assert.match(title, /name="text-entrance-stagger" min="0" max="90"/);
  assert.match(title, /name="text-exit-stagger" min="0" max="90"/);
  assert.doesNotMatch(template.slice(template.indexOf('data-stagecraft-element-panel="image"')), /text-motion:/);
  assert.doesNotMatch(template.slice(template.indexOf('data-stagecraft-element-panel="solid"')), /text-motion:/);

  for (const language of ['en', 'de']) {
    const labels = JSON.parse(await readFile(`lang/${language}.json`, 'utf8')) as Record<string, string>;
    for (const match of title.matchAll(/localize "([^"]+)"/g)) assert.ok(labels[match[1]!], `${language}: ${match[1]}`);
    for (const preset of TEXT_MOTION_PRESETS) assert.ok(labels[`STAGECRAFT.Editor.TextMotion.${preset.id}`], `${language}: ${preset.id}`);
    assert.ok(labels['STAGECRAFT.Editor.TextMotionAmount']);
    assert.ok(labels['STAGECRAFT.Editor.TextMotionStagger']);
    assert.ok(labels['STAGECRAFT.Editor.TextMotionGroup']);
  }
});

test('every catalog motion works in both phases with metadata-driven controls and valid dropdown values', async t => {
  const f = await editorFixture(t);
  for (const phase of ['entrance', 'exit'] as const) {
    for (const preset of TEXT_MOTION_PRESETS) {
      f.edit('text-' + phase + '-preset', 'none');
      f.edit('text-' + phase + '-preset', 'text-motion:' + preset.id);
      const transition = f.clip()[phase];
      assert.equal(transition.preset, 'text-motion', phase + ': ' + preset.id);
      assert.equal(transition.motion, preset.id);
      assert.equal(f.fields.get('text-' + phase + '-preset')!.value, 'text-motion:' + preset.id);
      assert.equal(f.fields.get('text-' + phase)!.value, String(preset.durationMs / 1000));
      const controls = textMotionControls(preset.id, {
        segmentCount: textMotionSegmentCount(f.clip().properties.text, preset.unit), amount: 1, stagger: 0.35
      });
      assert.equal(f.rows.get(phase + '-motion-direction')!.hidden, !controls.directions);
      assert.equal(f.fields.get('text-' + phase + '-motion-direction')!.disabled, !controls.directions);
      assert.equal(f.rows.get(phase + '-motion-order')!.hidden, !controls.order);
      assert.equal(f.fields.get('text-' + phase + '-motion-order')!.disabled, !controls.order);
      assert.equal(f.fields.get('text-' + phase + '-direction')!.disabled, true);
      assert.equal(f.fields.get('text-' + phase + '-motion-direction')!.value, 'default');
      assert.equal(f.fields.get('text-' + phase + '-motion-order')!.value, 'default');
      for (const field of f.fields.values()) if (field.tag === 'select') assert.ok(field.options.some(option => option.value === field.value), field.name);
    }
  }
});

test('title controls follow actual segment availability and retain hidden direction and order values', async t => {
  const f = await editorFixture(t);
  for (const phase of ['entrance', 'exit'] as const) {
    const prefix = 'text-' + phase;
    f.edit(prefix + '-preset', 'text-motion:word-ghost');
    f.edit(prefix + '-motion-direction', 'right');
    f.edit(prefix + '-motion-order', 'reverse');
    f.edit('title-text', 'Ghost');
    assert.equal(f.rows.get(phase + '-motion-order')!.hidden, true, 'one word has no order');
    assert.equal(f.fields.get(prefix + '-motion-order')!.disabled, true);
    assert.equal(f.rows.get(phase + '-motion-direction')!.hidden, false, 'one word still moves');
    f.edit('title-text', 'Ghost words');
    assert.equal(f.rows.get(phase + '-motion-order')!.hidden, false);
    assert.equal(f.fields.get(prefix + '-motion-order')!.value, 'reverse');
    f.edit(prefix + '-stagger', '0');
    assert.equal(f.rows.get(phase + '-motion-order')!.hidden, true, 'no stagger means simultaneous words');
    f.edit(prefix + '-amount', '0');
    assert.equal(f.rows.get(phase + '-motion-direction')!.hidden, true, 'no displacement or deformation');
    f.edit(prefix + '-stagger', '50');
    assert.equal(f.rows.get(phase + '-motion-order')!.hidden, false, 'opacity still staggers at amount zero');
    f.edit(prefix + '-amount', '1');
    assert.equal(f.rows.get(phase + '-motion-direction')!.hidden, false);
    assert.equal(f.fields.get(prefix + '-motion-direction')!.value, 'right');
    const retained = f.clip()[phase];
    assert.equal(retained.preset, 'text-motion');
    if (retained.preset !== 'text-motion') throw new Error('Motion lost');
    assert.equal(retained.motionOrder, 'reverse');
    assert.equal(retained.motionDirection, 'right');
  }
});

test('line, character and long-title fallback controls do not expose ineffective ordering', async t => {
  const f = await editorFixture(t);
  f.edit('text-entrance-preset', 'text-motion:line-reveal');
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, true);
  f.edit('title-text', 'One\nTwo');
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, false);
  f.edit('title-text', 'One\n\n');
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, false, 'blank lines retain stagger slots and affect visible timing');
  f.edit('text-entrance-preset', 'text-motion:character-fade-up');
  f.edit('title-text', '👩🏽‍🚀');
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, true, 'one grapheme');
  f.edit('title-text', '👩🏽‍🚀A');
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, false);
  f.edit('title-text', 'A'.repeat(257));
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, true, 'long unbroken title falls back to one unit');
});

test('measured wrapping updates line order, while stale layouts cannot override edited typography', async t => {
  const f = await editorFixture(t);
  const clip = f.clip();
  const report: TextMotionLayout = { clip, clipId: clip.id, text: clip.properties.text,
    counts: { character: 14, word: 2, line: 2 } };
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, true, 'one explicit line before measurement');
  f.reportLayout(report);
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, false, 'two rendered lines');
  f.edit('title-size', '84');
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, true, 'old layout no longer describes the title');
  f.reportLayout(report);
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, true, 'stale async report is ignored');
  f.reportLayout({ ...report, clip: f.clip() });
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, false, 'fresh report is accepted');
});

test('authored motion direction and order survive content and timing edits, while a preset change resets them', async t => {
  const source = motionSequence();
  const title = source.clips[0]! as TextClip;
  const configured = { ...title,
    entrance: { ...title.entrance, motionDirection: 'left', motionOrder: 'edges-in' },
    exit: { ...title.exit, motion: 'character-exit-up', motionDirection: 'right', motionOrder: 'random' }
  } as TextClip;
  const edit = { ...values(configured), text: 'Content edit' };
  const patched = patchInspectedClip(configured, { text: edit }) as TextClip;
  assert.deepEqual(patched.entrance, configured.entrance);
  assert.deepEqual(patched.exit, configured.exit);
  const rebuilt = buildSimpleSequence({ ...source, clips: [configured] }, ids(), {
    name: source.name, end: source.end, presentation: source.presentation, text: edit
  }).clips[0]! as TextClip;
  assert.deepEqual(rebuilt.entrance, configured.entrance);
  assert.deepEqual(rebuilt.exit, configured.exit);

  const f = await editorFixture(t, validateSequence({ ...source, clips: [configured] }));
  assert.equal(f.fields.get('text-entrance-motion-direction')!.value, 'left');
  assert.equal(f.fields.get('text-entrance-motion-order')!.value, 'edges-in');
  f.edit('title-size', '84');
  assert.deepEqual(f.clip().entrance, configured.entrance);
  assert.deepEqual(f.clip().exit, configured.exit);
  f.edit('text-entrance', '0.81');
  assert.deepEqual(f.clip().entrance, { ...configured.entrance, durationMs: 810 });
  f.edit('text-entrance-preset', 'text-motion:random-fade');
  const reset = f.clip().entrance;
  assert.equal(reset.preset, 'text-motion');
  assert.equal(reset.motionDirection, 'default');
  assert.equal(reset.motionOrder, 'default');
  assert.equal(f.rows.get('entrance-motion-direction')!.hidden, true);
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, false);
  assert.deepEqual(f.clip().exit, configured.exit);
  f.edit('text-entrance-preset', 'fade');
  assert.equal('motionDirection' in f.clip().entrance, false);
  assert.equal('motionOrder' in f.clip().entrance, false);
  assert.equal((f.clip().entrance as Transition & { futureEntrance?: string }).futureEntrance, 'keep');
  assert.equal(f.rows.get('entrance-motion-direction')!.hidden, true);
  assert.equal(f.rows.get('entrance-motion-order')!.hidden, true);
});

test('direction and order settings serialize for motions applied opposite their native phase', async t => {
  const f = await editorFixture(t);
  f.edit('title-text', 'Segmented\ntitle');
  for (const [phase, motion] of [['entrance', 'character-exit-up'], ['exit', 'line-reveal']] as const) {
    f.edit('text-' + phase + '-preset', 'text-motion:' + motion);
    f.edit('text-' + phase + '-motion-direction', 'left');
    f.edit('text-' + phase + '-motion-order', 'center-out');
    const transition = f.clip()[phase];
    assert.equal(transition.preset, 'text-motion');
    assert.equal(transition.motion, motion);
    assert.equal(transition.motionDirection, 'left');
    assert.equal(transition.motionOrder, 'center-out');
    assert.equal(f.fields.get('text-' + phase + '-motion-direction')!.value, 'left');
    assert.equal(f.fields.get('text-' + phase + '-motion-order')!.value, 'center-out');
  }
});

test('motion control templates expose only supported values with localized From and Towards labels', async () => {
  const template = await readFile('templates/editor.hbs', 'utf8');
  for (const phase of ['entrance', 'exit']) {
    for (const [suffix, expected] of [
      ['direction', ['default', 'up', 'down', 'left', 'right']],
      ['order', ['default', 'forward', 'reverse', 'center-out', 'edges-in', 'random']]
    ] as const) {
      const select = template.match(new RegExp(`<select name="text-${phase}-motion-${suffix}">([\\s\\S]*?)</select>`));
      assert.ok(select);
      assert.deepEqual([...select[1]!.matchAll(/<option value="([^"]+)">/g)].map(match => match[1]), expected);
    }
  }
  const en = JSON.parse(await readFile('lang/en.json', 'utf8')) as Record<string, string>;
  const de = JSON.parse(await readFile('lang/de.json', 'utf8')) as Record<string, string>;
  assert.equal(en['STAGECRAFT.Editor.TextMotionFrom'], 'From');
  assert.equal(en['STAGECRAFT.Editor.TextMotionTowards'], 'Towards');
  assert.equal(de['STAGECRAFT.Editor.TextMotionFrom'], 'Von');
  assert.equal(de['STAGECRAFT.Editor.TextMotionTowards'], 'Nach');
});
