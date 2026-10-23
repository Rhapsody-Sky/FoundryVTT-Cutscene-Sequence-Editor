import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import type { TextClip, SequenceV1, TransitionEasing } from '../src/domain/sequence.js';
import type { TimelineCommand } from '../src/application/timeline-commands.js';
import { buildSimpleSequence, type SimpleTextValues } from '../src/ui/simple-composition.js';
import { patchInspectedClip } from '../src/ui/clip-inspector.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { LocalPlayer } from '../src/playback/local-player.js';

function ids() { let next = 0; return () => `title-editor-${++next}`; }
function fixtureSequence(): SequenceV1 {
  const base = createBarsSequence('Animated title', ids());
  return validateSequence({ ...base, end: { kind: 'fixed', durationMs: 5000, automatic: true }, clips: [{
    ...base.clips[0]!, type: 'text', duration: { kind: 'fixed', milliseconds: 5000 },
    entrance: { preset: 'fade-slide', version: 1, durationMs: 800, easing: 'back-out', direction: 'left', distance: 170, futureEntrance: 'keep' },
    exit: { preset: 'fade-zoom', version: 1, durationMs: 600, easing: 'ease-in', scale: 1.3, futureExit: 'keep' },
    properties: { text: 'The title', fontFamily: 'Custom Serif', fontSize: 72, minimumFontSize: 24, color: '#ffffff', align: 'center',
      box: { x: 0, y: 100, width: 1920, height: 800, futureBox: 'keep' }, shrinkToFit: true,
      glow: { enabled: true, color: '#aabbcc', opacity: 0.6, radius: 18, futureGlow: 'keep' }, futureProperties: 'keep' }, futureClip: 'keep'
  }] });
}
function values(clip: TextClip): SimpleTextValues {
  return { startMs: clip.startMs, durationMode: clip.duration.kind, durationMs: clip.duration.kind === 'fixed' ? clip.duration.milliseconds : 5000,
    entranceMs: clip.entrance.preset === 'none' ? 0 : clip.entrance.durationMs,
    exitMs: clip.exit.preset === 'none' ? 0 : clip.exit.durationMs, ...clip.properties };
}

test('legacy title adapters preserve authored animation, custom fonts, effects, IDs and extension data', () => {
  const source = fixtureSequence(), clip = source.clips[0]! as TextClip;
  const edit = { ...values(clip), fontSize: 80 };
  const rebuilt = buildSimpleSequence(source, ids(), { name: source.name, end: source.end, presentation: source.presentation, text: edit }).clips[0]! as TextClip;
  for (const result of [rebuilt, patchInspectedClip(clip, { text: edit }) as TextClip]) {
    assert.equal(result.id, clip.id); assert.deepEqual(result.entrance, clip.entrance); assert.deepEqual(result.exit, clip.exit);
    assert.deepEqual(result.properties.glow, clip.properties.glow); assert.deepEqual(result.properties.box, clip.properties.box);
    assert.equal(result.properties.fontFamily, 'Custom Serif'); assert.equal((result as unknown as { futureClip: string }).futureClip, 'keep');
  }
});

test('title adapters independently author six presets, easing, direction, distance and percent-converted scale', () => {
  const source = fixtureSequence(), clip = source.clips[0]! as TextClip;
  for (const preset of ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'] as const) {
    const edit: SimpleTextValues = { ...values(clip), entrancePreset: preset, exitPreset: preset, entranceMs: 400, exitMs: 300,
      entranceEasing: 'back-in-out', exitEasing: 'ease-out', entranceDirection: 'up', exitDirection: 'right', entranceDistance: 0, exitDistance: 250, entranceScale: 0.05, exitScale: 4 };
    const result = patchInspectedClip(clip, { text: edit });
    assert.equal(result.entrance.preset, preset); assert.equal(result.exit.preset, preset);
    if (result.entrance.preset !== 'none') { assert.equal(result.entrance.easing, 'back-in-out'); assert.equal(result.entrance.distance, 0); assert.equal(result.entrance.scale, 0.05); }
    const rebuilt = buildSimpleSequence(source, ids(), { name: source.name, end: source.end, presentation: source.presentation, text: edit }).clips[0]!;
    assert.deepEqual(rebuilt.entrance, result.entrance); assert.deepEqual(rebuilt.exit, result.exit);
  }
  const held = patchInspectedClip(clip, { text: { ...values(clip), durationMode: 'sequence-end', exitPreset: 'none', exitMs: 0 } });
  assert.deepEqual(held.exit, clip.exit);
});

// Minimal DOM for exercising EditorView's event/read/paint path, with numeric validity.
async function editorFixture(t: TestContext, sequence = fixtureSequence()) {
  class Field extends EventTarget {
    children: Field[] = []; dataset: Record<string, string> = {}; name = ''; value = ''; checked = false;
    hidden = false; disabled = false; type = ''; textContent = ''; title = ''; parent: Field | null = null; min = 0; max = Infinity;
    classList = { toggle() {}, add() {}, remove() {} };
    constructor(readonly tag = 'div') { super(); }
    get options() { return this.children; }
    append(...children: Field[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren() { this.children = []; }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector: string): boolean {
      if (selector === '[name]') return !!this.name;
      const name = selector.match(/^\[name="([^"]+)"\]$/); if (name) return this.name === name[1];
      const data = selector.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/); if (!data) return false;
      const key = data[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return key in this.dataset && (data[2] === undefined || this.dataset[key] === data[2]);
    }
    querySelectorAll<T>(selector: string): T[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child as unknown as T] : []), ...child.querySelectorAll<T>(selector)]); }
    querySelector<T>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
    closest<T>(selector: string): T | null { return this.matches(selector) ? this as unknown as T : this.parent?.closest<T>(selector) ?? null; }
    focus() {} select() {} checkValidity() { return this.type !== 'number' || Number.isFinite(Number(this.value)) && Number(this.value) >= this.min && Number(this.value) <= this.max; }
  }
  const globals = { Element: Field, HTMLElement: Field, HTMLInputElement: Field, HTMLSelectElement: Field, HTMLTextAreaElement: Field, document: { createElement: (tag: string) => new Field(tag) } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  const root = new Field(), panel = new Field(); panel.dataset.stagecraftElementPanel = 'text'; root.append(panel);
  const inspector = new Field(); inspector.dataset.stagecraftInspector = ''; root.append(inspector);
  const fields = new Map<string, Field>();
  function field(name: string, parent = root, options?: string[], min = 0) {
    const input = new Field(options ? 'select' : 'input'); input.name = name;
    if (!options) { input.type = 'number'; input.min = min; input.max = name.endsWith('-scale') ? 400 : name.endsWith('-distance') ? 32768 : Infinity; }
    for (const value of options ?? []) { const option = new Field('option'); option.value = value; input.append(option); }
    parent.append(input); fields.set(name, input); return input;
  }
  field('ending', root, ['automatic', 'fixed', 'manual', 'media']); field('sequence-duration'); field('clip-track', root, []);
  field('text-start', panel); field('text-duration-mode', panel, ['fixed', 'sequence-end']); field('text-duration', panel, undefined, 0.001); field('title-size', panel, undefined, 1);
  const rows = new Map<string, Field>();
  for (const direction of ['entrance', 'exit']) {
    const row = new Field(); row.dataset.stagecraftTextAnimation = direction; panel.append(row); rows.set(direction, row);
    field('text-' + direction + '-preset', row, ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom']);
    const duration = new Field(); duration.dataset.stagecraftTextAnimationParam = direction; row.append(duration); rows.set(direction + '-duration', duration);
    field('text-' + direction, duration, undefined, 0.001);
    const easing = new Field(); easing.dataset.stagecraftTextAnimationParam = direction; row.append(easing); rows.set(direction + '-easing', easing);
    field('text-' + direction + '-easing', easing, ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-in', 'back-out', 'back-in-out']);
    for (const suffix of ['direction', 'distance', 'scale']) {
      const parameter = new Field(); parameter.dataset.stagecraftTextAnimationParam = direction;
      parameter.dataset.stagecraftAnimationKind = suffix === 'scale' ? 'zoom' : 'slide'; row.append(parameter); rows.set(direction + '-' + suffix, parameter);
      field('text-' + direction + '-' + suffix, parameter, suffix === 'direction' ? ['left', 'right', 'up', 'down'] : undefined, suffix === 'scale' ? 5 : 0);
    }
  }
  const services: EditorServices = {
    makeId: ids(), repository: { list: async () => [sequence], read: async () => sequence, save: async value => value, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }), localize: key => key,
    confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {}, prepareGroup: async () => {}, openSession() {},
    groupActive: () => false, chooseVideo: async () => null, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services); await view.mount(root as unknown as HTMLElement); t.after(() => view.detach());
  function edit(name: string, value: string) {
    const input = fields.get(name)!; input.value = value;
    const event = new Event('input'); Object.defineProperty(event, 'target', { value: input }); root.dispatchEvent(event);
  }
  const undo = new Field('button'); undo.dataset.stagecraftAction = 'undo'; root.append(undo);
  const redo = new Field('button'); redo.dataset.stagecraftAction = 'redo'; root.append(redo);
  async function action(name: 'undo' | 'redo') {
    const event = new Event('click'); Object.defineProperty(event, 'target', { value: name === 'undo' ? undo : redo }); root.dispatchEvent(event);
    await Promise.resolve();
  }
  return { view, fields, rows, edit, action, clip: () => view.draft.draft!.clips[0]! as TextClip };
}


test('title inspector paints every timed preset and shows only its parameters while style edits preserve authored data and siblings', async t => {
  const source = fixtureSequence();
  const sibling = { ...source.clips[0]!, id: 'sibling', trackId: 'sibling-track', entrance: { preset: 'none' as const, version: 1 as const }, exit: { preset: 'none' as const, version: 1 as const } };
  const withSibling = validateSequence({ ...source, tracks: [...source.tracks, { ...source.tracks[0]!, id: 'sibling-track', order: 1 }], clips: [...source.clips, sibling] });
  const f = await editorFixture(t, withSibling);
  assert.equal(f.fields.get('text-entrance-preset')!.value, 'fade-slide'); assert.equal(f.fields.get('text-exit-preset')!.value, 'fade-zoom');
  assert.equal(f.fields.get('text-entrance')!.value, '0.8'); assert.equal(f.fields.get('text-exit')!.value, '0.6');
  assert.equal(f.fields.get('text-exit-scale')!.value, '130');
  assert.equal(f.rows.get('entrance-direction')!.hidden, false); assert.equal(f.rows.get('entrance-scale')!.hidden, true);
  assert.equal(f.rows.get('exit-distance')!.hidden, true); assert.equal(f.rows.get('exit-scale')!.hidden, false);
  f.edit('title-size', '80');
  assert.deepEqual(f.clip().entrance, source.clips[0]!.entrance); assert.deepEqual(f.clip().exit, source.clips[0]!.exit);
  assert.deepEqual(f.view.draft.draft!.clips[1], sibling);
  f.edit('text-entrance-direction', 'down'); f.edit('text-entrance-distance', '32768');
  const entrance = f.clip().entrance;
  assert.ok(entrance.preset !== 'none'); assert.equal(entrance.direction, 'down'); assert.equal(entrance.distance, 32768);
  f.edit('text-exit-scale', '5'); const smallExit = f.clip().exit; assert.ok(smallExit.preset !== 'none'); assert.equal(smallExit.scale, 0.05);
  f.edit('text-exit-scale', '400'); const largeExit = f.clip().exit; assert.ok(largeExit.preset !== 'none'); assert.equal(largeExit.scale, 4);
  const valid = structuredClone(f.clip()); f.edit('text-exit-scale', '401'); assert.deepEqual(f.clip(), valid);
  f.edit('text-exit-scale', '80'); f.edit('text-entrance-preset', 'none');
  for (const suffix of ['duration', 'easing', 'direction', 'distance', 'scale']) assert.equal(f.rows.get('entrance-' + suffix)!.hidden, true);
  for (const suffix of ['', '-easing', '-direction', '-distance', '-scale']) assert.equal(f.fields.get('text-entrance' + suffix)!.disabled, true);
  f.edit('text-entrance-preset', 'fade'); assert.equal(f.rows.get('entrance-easing')!.hidden, false); assert.equal(f.rows.get('entrance-direction')!.hidden, true);
  f.edit('text-entrance-preset', 'zoom'); assert.equal(f.rows.get('entrance-scale')!.hidden, false); assert.equal(f.rows.get('entrance-direction')!.hidden, true);
});

test('title preset from None seeds 800 ms, bounds against the opposite animation, and keeps valid state for duration conflicts', async t => {
  const source = fixtureSequence(), clip = source.clips[0]!;
  const f = await editorFixture(t, validateSequence({ ...source, clips: [{ ...clip, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 } }] }));
  f.edit('text-entrance-preset', 'zoom'); assert.equal(f.fields.get('text-entrance')!.value, '0.8');
  f.edit('text-exit-preset', 'slide'); assert.equal(f.fields.get('text-exit')!.value, '0.8');
  const valid = structuredClone(f.clip()); f.edit('text-exit', '4.5'); assert.deepEqual(f.clip(), valid);
  f.edit('text-exit', '0.8'); f.edit('text-duration', '0.5');
  assert.equal(f.fields.get('text-entrance')!.value, '0.25'); assert.equal(f.fields.get('text-exit')!.value, '0.25');
  f.edit('text-entrance-preset', 'none'); f.edit('text-exit', '0.5'); f.edit('text-entrance-preset', 'fade-zoom');
  assert.equal(f.fields.get('text-entrance')!.value, '0.25'); assert.equal(f.fields.get('text-exit')!.value, '0.25');
});

test('title shortening proportionally fits zoom and slide, synchronizes presets, and undo restores the animation controls', async t => {
  const f = await editorFixture(t);
  f.edit('text-duration', '0.7');
  assert.equal(f.fields.get('text-entrance')!.value, '0.4'); assert.equal(f.fields.get('text-exit')!.value, '0.3');
  assert.equal(f.clip().entrance.preset, 'fade-slide'); assert.equal(f.clip().exit.preset, 'fade-zoom');
  await f.action('undo'); assert.deepEqual(f.clip(), fixtureSequence().clips[0]);
  assert.equal(f.fields.get('text-entrance')!.value, '0.8'); assert.equal(f.fields.get('text-exit')!.value, '0.6');
  await f.action('redo'); assert.equal(f.fields.get('text-exit')!.value, '0.3');
  f.edit('text-duration', '0.001'); assert.equal(f.clip().exit.preset, 'none');
  assert.equal(f.fields.get('text-exit-preset')!.value, 'none'); assert.equal(f.rows.get('exit-scale')!.hidden, true);
  f.edit('text-exit-preset', 'zoom'); assert.equal(f.clip().entrance.preset, 'none');
  assert.equal(f.fields.get('text-entrance-preset')!.value, 'none'); assert.equal(f.fields.get('text-exit')!.value, '0.001');
});

test('timeline trim repaints title durations and preserves motion endpoints through undo', async t => {
  const f = await editorFixture(t);
  const commands = f.view as unknown as { timelineCommand(command: TimelineCommand): void };
  commands.timelineCommand({ kind: 'resize-clip', clipId: f.clip().id, edge: 'end', timeMs: 700 });
  assert.equal(f.fields.get('text-entrance')!.value, '0.4'); assert.equal(f.fields.get('text-exit')!.value, '0.3');
  assert.equal(f.fields.get('text-entrance-direction')!.value, 'left'); assert.equal(f.fields.get('text-exit-scale')!.value, '130');
  await f.action('undo'); assert.deepEqual(f.clip(), fixtureSequence().clips[0]);
  assert.equal(f.fields.get('text-entrance')!.value, '0.8'); assert.equal(f.fields.get('text-exit')!.value, '0.6');
});

test('legacy title None and Fade remain identical on style edits and all easing options work through the event path', async t => {
  const source = fixtureSequence();
  const sequence = validateSequence({ ...source, clips: [{ ...source.clips[0]!,
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'fade', version: 1, durationMs: 600, easing: 'ease-in-out' } }] });
  const f = await editorFixture(t, sequence);
  f.edit('title-size', '80'); assert.deepEqual(f.clip().entrance, sequence.clips[0]!.entrance); assert.deepEqual(f.clip().exit, sequence.clips[0]!.exit);
  f.edit('text-entrance-preset', 'slide');
  for (const easing of ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-in', 'back-out', 'back-in-out'] satisfies TransitionEasing[]) {
    f.edit('text-entrance-easing', easing); const entrance = f.clip().entrance;
    assert.ok(entrance.preset !== 'none'); assert.equal(entrance.easing, easing);
  }
  for (const direction of ['left', 'right', 'up', 'down']) {
    f.edit('text-entrance-direction', direction); const entrance = f.clip().entrance;
    assert.ok(entrance.preset !== 'none'); assert.equal(entrance.direction ?? 'down', direction);
  }
});

test('held title Out keeps all authored settings and the sequence-fade tooltip through mode and style edits', async t => {
  const source = fixtureSequence(), clip = source.clips[0]!;
  const held = validateSequence({ ...source, end: { kind: 'manual' }, clips: [{ ...clip, duration: { kind: 'sequence-end' } }] });
  const f = await editorFixture(t, held);
  assert.equal(f.fields.get('text-exit-preset')!.disabled, true); assert.equal(f.fields.get('text-exit-scale')!.disabled, true);
  assert.equal(f.rows.get('exit')!.title, 'STAGECRAFT.Editor.TitleOutHeldHint');
  f.edit('title-size', '80'); assert.deepEqual(f.clip().exit, clip.exit);
  f.edit('text-duration-mode', 'fixed'); assert.deepEqual(f.clip().exit, clip.exit); assert.equal(f.fields.get('text-exit-preset')!.disabled, false);
  f.edit('text-duration-mode', 'sequence-end'); assert.deepEqual(f.clip().exit, clip.exit); assert.equal(f.fields.get('text-exit-easing')!.disabled, true);
});

test('title animation template provides independent animation controls outside Timing, with complete flat localization', async () => {
  const template = await readFile('templates/editor.hbs', 'utf8');
  const title = template.slice(template.indexOf('data-stagecraft-element-panel="text"'), template.indexOf('data-stagecraft-element-panel="video"'));
  const timing = title.slice(title.indexOf('id="stagecraft-clip-text-timing"'), title.indexOf('</section>', title.indexOf('id="stagecraft-clip-text-timing"')));
  assert.doesNotMatch(timing, /name="text-(entrance|exit)"/);
  assert.match(timing, /name="text-start"/);
  const animation = title.slice(title.indexOf('id="stagecraft-clip-text-animation"'), title.indexOf('id="stagecraft-clip-text-timing"'));
  assert.match(animation, /data-stagecraft-text-animation="entrance"/);
  assert.match(animation, /data-stagecraft-text-animation="exit"/);
  for (const phase of ['entrance', 'exit']) for (const suffix of ['', '-preset', '-easing', '-direction', '-distance', '-scale']) assert.ok(title.includes('name="text-' + phase + suffix + '"'));
  for (const lang of ['en', 'de']) {
    const labels = JSON.parse(await readFile('lang/' + lang + '.json', 'utf8')) as Record<string, string>;
    for (const match of title.matchAll(/localize "([^"]+)"/g)) assert.ok(labels[match[1]!], lang + ' ' + match[1]);
    assert.equal(Object.keys(labels).some(key => Object.keys(labels).some(other => other.startsWith(key + '.'))), false);
  }
});
