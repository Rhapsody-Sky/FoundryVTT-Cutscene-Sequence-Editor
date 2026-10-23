import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { applyTimelineCommand } from '../src/application/timeline-commands.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import type { BarsClip, SequenceV1, Transition } from '../src/domain/sequence.js';
import { buildSimpleSequence, simpleTimingConflicts, type SimpleBarsValues } from '../src/ui/simple-composition.js';
import { patchInspectedClip } from '../src/ui/clip-inspector.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { LocalPlayer } from '../src/playback/local-player.js';

function ids() { let next = 0; return () => `bars-editor-${++next}`; }
function fixtureSequence(): SequenceV1 {
  const base = createBarsSequence('Animated bars', ids());
  return validateSequence({ ...base, end: { kind: 'fixed', durationMs: 5000, automatic: true }, clips: [{
    ...base.clips[0]!, duration: { kind: 'fixed', milliseconds: 5000 },
    entrance: { preset: 'slide', version: 1, durationMs: 800, easing: 'linear', futureEntrance: 'keep' },
    exit: { preset: 'fade-slide', version: 1, durationMs: 600, easing: 'linear', futureExit: 'keep' },
    futureClip: 'keep'
  }] });
}
function values(clip: BarsClip): SimpleBarsValues {
  return { startMs: clip.startMs, durationMode: clip.duration.kind, durationMs: clip.duration.kind === 'fixed' ? clip.duration.milliseconds : 5000,
    entranceMs: clip.entrance.preset === 'none' ? 0 : clip.entrance.durationMs, heightFraction: clip.properties.heightFraction };
}

test('legacy composition and inspector callers retain bars presets, exit, easing, IDs and extensions', () => {
  const source = fixtureSequence(), clip = source.clips[0]! as BarsClip;
  const edit = { ...values(clip), heightFraction: 0.2 };
  const rebuilt = buildSimpleSequence(source, ids(), { name: source.name, end: source.end, presentation: source.presentation, bars: edit }).clips[0]!;
  for (const result of [rebuilt, patchInspectedClip(clip, { bars: edit })]) {
    assert.equal(result.id, clip.id);
    assert.deepEqual(result.entrance, clip.entrance);
    assert.deepEqual(result.exit, clip.exit);
    assert.equal((result as unknown as { futureClip: string }).futureClip, 'keep');
  }
});

test('bars adapters author all four presets independently and held clips preserve their authored exit', () => {
  const source = fixtureSequence(), clip = source.clips[0]! as BarsClip;
  for (const preset of ['none', 'fade', 'slide', 'fade-slide'] as const) {
    const edit = { ...values(clip), entrancePreset: preset, exitPreset: preset, entranceMs: 400, exitMs: 300 };
    const result = patchInspectedClip(clip, { bars: edit });
    assert.equal(result.entrance.preset, preset); assert.equal(result.exit.preset, preset);
    if (result.entrance.preset !== 'none') assert.equal(result.entrance.easing, 'linear');
    if (result.exit.preset !== 'none') assert.equal(result.exit.durationMs, 300);
    assert.equal((result.exit as unknown as { futureExit: string }).futureExit, 'keep');
    const rebuilt = buildSimpleSequence(source, ids(), { name: source.name, end: source.end, presentation: source.presentation, bars: edit });
    assert.deepEqual(rebuilt.clips[0]!.entrance, result.entrance); assert.deepEqual(rebuilt.clips[0]!.exit, result.exit);
  }
  const held = patchInspectedClip(clip, { bars: { ...values(clip), durationMode: 'sequence-end', exitPreset: 'none', exitMs: 0 } });
  assert.deepEqual(held.exit, clip.exit);
});

test('simple timing validation includes slide durations', () => {
  const source = fixtureSequence();
  const conflicting = { ...source, clips: [{ ...source.clips[0]! as BarsClip, duration: { kind: 'fixed' as const, milliseconds: 1000 } }] };
  assert.deepEqual(simpleTimingConflicts(conflicting), [{ key: 'TransitionOverlap', element: 'bars' }]);
});

// Minimal DOM for exercising EditorView's event/read/paint path, with numeric validity.
async function editorFixture(t: TestContext, sequence = fixtureSequence()) {
  class Field extends EventTarget {
    children: Field[] = []; dataset: Record<string, string> = {}; name = ''; value = ''; checked = false;
    hidden = false; disabled = false; readOnly = false; type = ''; textContent = ''; title = ''; parent: Field | null = null;
    min = '0'; max = ''; step = '1'; attributes: Record<string, string> = {}; captures = new Set<number>();
    get parentElement() { return this.parent; }
    get ownerDocument() { return document; }
    classList = { toggle() {}, add() {}, remove() {} };
    constructor(readonly tag = 'div') { super(); }
    get options() { return this.children; }
    append(...children: Field[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    after(node: Field) { if (!this.parent) return; const siblings = this.parent.children, index = siblings.indexOf(this); node.parent = this.parent; siblings.splice(index + 1, 0, node); }
    remove() { if (!this.parent) return; this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    replaceChildren() { this.children = []; }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector: string): boolean {
      if (selector === '[data-stagecraft-inspector] input[type="number"]') return this.tag === 'input' && this.type === 'number' && !!this.closest('[data-stagecraft-inspector]');
      if (selector === ':disabled') { for (let node: Field | null = this; node; node = node.parent) if (node.disabled) return true; return false; }
      if (selector === '[name]') return !!this.name;
      const name = selector.match(/^\[name="([^"]+)"\]$/); if (name) return this.name === name[1];
      const data = selector.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/); if (!data) return false;
      const key = data[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return key in this.dataset && (data[2] === undefined || this.dataset[key] === data[2]);
    }
    querySelectorAll<T>(selector: string): T[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child as unknown as T] : []), ...child.querySelectorAll<T>(selector)]); }
    querySelector<T>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
    closest<T>(selector: string): T | null { return this.matches(selector) ? this as unknown as T : this.parent?.closest<T>(selector) ?? null; }
    focus() {} select() {}
    setPointerCapture(id: number) { this.captures.add(id); }
    hasPointerCapture(id: number) { return this.captures.has(id); }
    releasePointerCapture(id: number) { this.captures.delete(id); }
    checkValidity() {
      if (this.type !== 'number') return true;
      const value = Number(this.value), min = this.min.trim() === '' ? Number.NEGATIVE_INFINITY : Number(this.min), max = this.max.trim() === '' ? Number.POSITIVE_INFINITY : Number(this.max);
      if (this.value.trim() === '' || !Number.isFinite(value) || value < min || value > max) return false;
      if (this.step === 'any') return true;
      const step = Number(this.step), base = Number.isFinite(min) ? min : 0;
      return Math.abs((value - base) / step - Math.round((value - base) / step)) < 1e-7;
    }
  }
  const globals = { Element: Field, HTMLElement: Field, HTMLInputElement: Field, HTMLSelectElement: Field, HTMLTextAreaElement: Field, document: Object.assign(new EventTarget(), { createElement: (tag: string) => new Field(tag) }) };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  const root = new Field(), inspector = new Field(); inspector.dataset.stagecraftInspector = ''; root.append(inspector);
  const panel = new Field(); panel.dataset.stagecraftElementPanel = 'bars'; inspector.append(panel);
  const textPanel = new Field(); textPanel.dataset.stagecraftElementPanel = 'text'; inspector.append(textPanel);
  const fields = new Map<string, Field>();
  function field(name: string, parent = root, options?: string[], min = 0) {
    const input = new Field(options ? 'select' : 'input'); input.name = name;
    if (!options) { input.type = 'number'; input.min = String(min); input.step = 'any'; }
    for (const value of options ?? []) { const option = new Field('option'); option.value = value; input.append(option); }
    parent.append(input); fields.set(name, input); return input;
  }
  field('ending', inspector, ['automatic', 'fixed', 'manual', 'media']); field('sequence-duration', inspector); field('clip-track', inspector, []);
  field('bars-start', panel); field('bars-duration-mode', panel, ['fixed', 'sequence-end']); field('bars-duration', panel, undefined, 0.001); field('bars-height', panel);
  const rows = new Map<string, Field>();
  for (const direction of ['entrance', 'exit']) {
    const row = new Field(); row.dataset.stagecraftBarsAnimation = direction; panel.append(row); rows.set(direction, row);
    field('bars-' + direction + '-preset', row, ['none', 'fade', 'slide', 'fade-slide']);
    const duration = new Field(); duration.dataset.stagecraftBarsAnimationDuration = direction; row.append(duration); rows.set(direction + '-duration', duration);
    field('bars-' + direction, duration, undefined, 0.001);
  }
  field('text-exit-preset', textPanel, ['none', 'fade', 'slide', 'fade-slide']);
  field('text-exit', textPanel, undefined, 0.001);
  fields.get('bars-duration')!.step = 'any';
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
  function dispatch(type: string, target: unknown, properties: Record<string, unknown> = {}) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ target, button: 0, pointerId: 1, clientX: 0, clientY: 0,
      shiftKey: false, altKey: false, key: '', ctrlKey: false, metaKey: false, ...properties })
      .map(([key, value]) => [key, { value }])));
    if (type.startsWith('pointer')) document.dispatchEvent(event);
    root.dispatchEvent(event);
    return event;
  }
  return { root, view, fields, rows, edit, dispatch, selectClip: (id: string) => (view as unknown as { selectClip(id: string): void }).selectClip(id), clip: (id = sequence.clips[0]!.id) => view.draft.draft!.clips.find(clip => clip.id === id)! as BarsClip };
}

test('bars inspector loads presets and preserves them on style edits, then fits and synchronizes shortened clips', async t => {
  const f = await editorFixture(t);
  assert.equal(f.fields.get('bars-entrance-preset')!.value, 'slide'); assert.equal(f.fields.get('bars-exit-preset')!.value, 'fade-slide');
  f.edit('bars-height', '15'); assert.equal(f.clip().entrance.preset, 'slide'); assert.equal(f.clip().exit.preset, 'fade-slide');
  f.edit('bars-duration', '0.001');
  assert.deepEqual(f.clip().duration, { kind: 'fixed', milliseconds: 1 });
  assert.equal(f.clip().exit.preset, 'none'); assert.equal(f.fields.get('bars-exit-preset')!.value, 'none');
  assert.equal(f.rows.get('exit-duration')!.hidden, true); assert.equal(f.fields.get('bars-exit')!.disabled, true);
  f.edit('bars-height', '16'); assert.equal(f.clip().exit.preset, 'none');
  f.edit('bars-exit-preset', 'fade-slide');
  assert.equal(f.clip().exit.preset, 'fade-slide'); assert.equal(f.clip().entrance.preset, 'none');
  assert.equal(f.fields.get('bars-entrance-preset')!.value, 'none'); assert.equal(f.fields.get('bars-exit')!.value, '0.001');
});

test('canceling a transient duration scrub restores all inspector fields and keeps history clean', async t => {
  const f = await editorFixture(t);
  const duration = f.fields.get('bars-duration')!;
  const handle = duration;
  const readForm = (f.view as unknown as { readForm(): boolean }).readForm.bind(f.view);
  assert.equal(f.view.draft.canUndo, false);
  f.dispatch('pointerdown', handle, { clientX: 0 });
  f.dispatch('pointermove', handle, { clientX: -200 });
  assert.equal(duration.value, '0.001');
  const previewedDuration = f.clip().duration;
  assert.equal(previewedDuration.kind, 'fixed');
  if (previewedDuration.kind === 'fixed') assert.equal(previewedDuration.milliseconds, 5000);
  assert.equal(f.fields.get('bars-entrance')!.value, '0.001');
  assert.equal(f.fields.get('bars-exit-preset')!.value, 'none');

  f.dispatch('keydown', handle, { key: 'Escape' });
  assert.equal(duration.value, '5');
  assert.equal(f.fields.get('bars-entrance-preset')!.value, 'slide');
  assert.equal(f.fields.get('bars-entrance')!.value, '0.8');
  assert.equal(f.fields.get('bars-exit-preset')!.value, 'fade-slide');
  assert.equal(f.fields.get('bars-exit')!.value, '0.6');
  assert.equal(readForm(), true);
  assert.equal(f.view.draft.dirty, false);
  assert.equal(f.view.draft.canUndo, false);
});

test('bars inspector accepts 50 percent per bar and rejects greater heights', async t => {
  const f = await editorFixture(t);
  f.edit('bars-height', '50');
  assert.equal(f.clip().properties.heightFraction, 0.5);
  f.edit('bars-height', '50.1');
  assert.equal(f.clip().properties.heightFraction, 0.5);
});

test('selecting an animation from None supplies a duration bounded by clip length and the opposite animation', async t => {
  const source = fixtureSequence();
  const clip = { ...source.clips[0]!, duration: { kind: 'fixed' as const, milliseconds: 500 }, entrance: { preset: 'none', version: 1 } as Transition,
    exit: { preset: 'fade-slide', version: 1, durationMs: 500, easing: 'linear' } as Transition };
  const f = await editorFixture(t, validateSequence({ ...source, clips: [clip], end: { kind: 'fixed', durationMs: 500, automatic: true } }));
  assert.equal(f.fields.get('bars-entrance')!.disabled, true);
  f.edit('bars-entrance-preset', 'slide');
  assert.equal(f.clip().entrance.preset, 'slide'); assert.equal(f.clip().exit.preset, 'fade-slide');
  assert.equal(f.fields.get('bars-entrance')!.value, '0.25'); assert.equal(f.fields.get('bars-exit')!.value, '0.25');
  f.edit('bars-entrance-preset', 'none'); assert.equal(f.clip().entrance.preset, 'none');
  assert.equal(f.rows.get('entrance-duration')!.hidden, true); assert.equal(f.fields.get('bars-entrance')!.disabled, true);
  f.edit('bars-entrance-preset', 'fade'); assert.equal(f.clip().entrance.preset, 'fade');
});

test('Out selection from None defaults to 800 ms and overlapping slide durations keep the last valid draft', async t => {
  const source = fixtureSequence(), clip = source.clips[0]! as BarsClip;
  const f = await editorFixture(t, validateSequence({ ...source, clips: [{ ...clip, exit: { preset: 'none', version: 1 } }] }));
  f.edit('bars-exit-preset', 'slide');
  assert.equal(f.clip().exit.preset, 'slide'); assert.equal(f.fields.get('bars-exit')!.value, '0.8');
  const valid = structuredClone(f.clip());
  f.edit('bars-exit', '4.5'); assert.deepEqual(f.clip(), valid);
  f.edit('bars-exit', '1.5');
  const exit = f.clip().exit;
  assert.equal(exit.preset !== 'none' && exit.durationMs, 1500);
});

test('held bars disable Out with the sequence-fade explanation and keep authored settings across mode changes', async t => {
  const source = fixtureSequence(), clip = source.clips[0]!;
  const held = validateSequence({ ...source, end: { kind: 'manual' }, clips: [{ ...clip, duration: { kind: 'sequence-end' } }] });
  const f = await editorFixture(t, held);
  assert.equal(f.fields.get('bars-exit-preset')!.disabled, true); assert.equal(f.fields.get('bars-exit')!.disabled, true);
  assert.equal(f.rows.get('exit')!.title, 'STAGECRAFT.Editor.BarsOutHeldHint');
  f.edit('bars-height', '20'); assert.deepEqual(f.clip().exit, clip.exit);
  f.edit('bars-duration-mode', 'fixed'); assert.deepEqual(f.clip().exit, clip.exit); assert.equal(f.fields.get('bars-exit-preset')!.disabled, false);
  assert.equal(f.rows.get('exit')!.title, '');
  f.edit('bars-duration-mode', 'sequence-end'); assert.deepEqual(f.clip().exit, clip.exit);
});

test('manual terminal fixed bars can choose an Out animation while earlier bars stay editable', async t => {
  const source = fixtureSequence(), bars = source.clips[0]! as BarsClip;
  const earlier: BarsClip = { ...bars, id: 'bars-editor-earlier', startMs: 0, duration: { kind: 'fixed', milliseconds: 5000 }, exit: { preset: 'none', version: 1 } };
  const terminal: BarsClip = { ...bars, id: 'bars-editor-terminal', startMs: 10000, duration: { kind: 'fixed', milliseconds: 5000 }, exit: { preset: 'none', version: 1 } };
  const manual = validateSequence({ ...source, end: { kind: 'manual' }, clips: [earlier, terminal] });
  const f = await editorFixture(t, manual);
  assert.equal(f.fields.get('bars-exit-preset')!.disabled, false);
  f.selectClip(terminal.id);
  assert.equal(f.fields.get('bars-exit-preset')!.disabled, false);
  assert.equal(f.fields.get('bars-exit')!.disabled, true);
  assert.deepEqual(f.clip(terminal.id).exit, terminal.exit);
  f.edit('bars-exit-preset', 'fade');
  assert.equal(f.fields.get('bars-exit')!.disabled, false);
  const exit = f.clip(terminal.id).exit;
  assert.equal(exit.preset === 'none' ? 0 : exit.durationMs, 800);
  assert.equal(exit.preset, 'fade');
  assert.deepEqual(f.clip(terminal.id).duration, terminal.duration);
  await (f.view as unknown as { act(kind: string): Promise<void> }).act('undo');
  assert.deepEqual(f.clip(terminal.id).exit, terminal.exit);
  assert.equal(f.fields.get('bars-exit-preset')!.value, 'none');
});

test('fixed-duration manual terminal titles can still seed an Out animation', async t => {
  const makeId = ids(); let source = fixtureSequence();
  source = applyTimelineCommand(source, { kind: 'add-track' }, makeId);
  const track = source.tracks.find(candidate => candidate.id !== source.tracks[0]!.id)!;
  source = applyTimelineCommand(source, { kind: 'add-clip', type: 'text', trackId: track.id, startMs: 0 }, makeId);
  const title = source.clips.find(clip => clip.type === 'text')!;
  const manual = validateSequence({ ...source, end: { kind: 'manual' }, clips: source.clips.map(clip => clip.id === title.id
    ? { ...clip, duration: { kind: 'fixed', milliseconds: 5000 }, exit: { preset: 'none', version: 1 } } : clip) });
  const f = await editorFixture(t, manual);
  f.selectClip(title.id);
  assert.equal(f.fields.get('text-exit-preset')!.value, 'none');
  f.edit('text-exit-preset', 'fade');
  const result = f.view.draft.draft!.clips.find(clip => clip.id === title.id)!;
  assert.equal(result.type, 'text');
  if (result.type === 'text') { assert.equal(result.exit.preset, 'fade'); assert.equal(result.exit.durationMs, 800); }
});
