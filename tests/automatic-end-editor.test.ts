import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { DraftService } from '../src/application/draft-service.js';
import { applyTimelineCommand, enableAutomaticEnd } from '../src/application/timeline-commands.js';
import { createBarsSequence } from '../src/domain/validation.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import { getSequenceAudience, withSequenceAudience } from '../src/domain/sequence-audience.js';
import { LocalPlayer } from '../src/playback/local-player.js';

function ids() { let id = 0; return () => `automatic-editor-${++id}`; }

function dom(t: TestContext) {
  let active: Field | null = null;
  class Field extends EventTarget {
    children: Field[] = []; dataset: Record<string, string> = {}; name = ''; value = ''; checked = false;
    hidden = false; disabled = false; className = ''; type = ''; textContent = ''; title = ''; parent: Field | null = null;
    classList = { toggle() {}, add() {}, remove() {} };
    constructor(readonly tag = 'div') { super(); }
    get options() { return this.children; }
    append(...children: Field[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren() { this.children = []; }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector: string): boolean {
      if (selector === '[name]') return !!this.name;
      const name = selector.match(/^\[name="([^"]+)"\]$/); if (name) return this.name === name[1];
      const data = selector.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/);
      if (!data) return false;
      const key = data[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return key in this.dataset && (data[2] === undefined || this.dataset[key] === data[2]);
    }
    querySelectorAll<T>(selector: string): T[] {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child as unknown as T] : []), ...child.querySelectorAll<T>(selector)]);
    }
    querySelector<T>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
    closest<T>(selector: string): T | null { return this.matches(selector) ? this as unknown as T : this.parent?.closest<T>(selector) ?? null; }
    focus() { active = this; } select() {} checkValidity() { return true; }
  }
  const globals: Record<string, unknown> = {
    Element: Field, HTMLElement: Field, HTMLInputElement: Field, HTMLSelectElement: Field, HTMLTextAreaElement: Field,
    document: { createElement: (tag: string) => new Field(tag), get activeElement() { return active; } }
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  function dispatch(root: Field, type: string, target: Field) {
    const event = new Event(type); Object.defineProperty(event, 'target', { value: target }); root.dispatchEvent(event);
  }
  return { Field, dispatch };
}

async function fixture(t: TestContext, sequence?: SequenceV1) {
  const ui = dom(t), root = new ui.Field(), makeId = ids();
  const inspector = new ui.Field(); inspector.dataset.stagecraftInspector = ''; root.append(inspector);
  const fields = new Map<string, InstanceType<typeof ui.Field>>();
  const field = (name: string, parent = root, options?: string[]) => {
    const node = new ui.Field(options ? 'select' : 'input'); node.name = name;
    for (const value of options ?? []) { const option = new ui.Field('option'); option.value = value; node.append(option); }
    parent.append(node); fields.set(name, node); return node;
  };
  field('ending', root, ['automatic', 'fixed', 'manual', 'media']); field('sequence-duration'); field('end-media'); field('clip-track');
  for (const type of ['bars', 'text', 'video']) {
    const panel = new ui.Field(); panel.dataset.stagecraftElementPanel = type; root.append(panel);
    field(type + '-start', panel);
    field(type + '-entrance', panel);
    if (type !== 'video') { field(type + '-duration-mode', panel, ['fixed', 'sequence-end']); field(type + '-duration', panel); }
    if (type === 'bars') field('bars-height', panel);
    if (type === 'text') { field('title-text', panel); field('text-exit', panel); }
    if (type === 'video') { field('video-in', panel); field('video-out', panel); }
  }
  let stored = sequence ? structuredClone(sequence) : null;
  const services: EditorServices = {
    makeId, repository: {
      list: async () => stored ? [stored] : [],
      read: async id => stored?.id === id ? structuredClone(stored) : null,
      save: async (value, expectedRevision) => {
        stored = structuredClone({ ...value, revision: expectedRevision === null ? 0 : (expectedRevision ?? 0) + 1 });
        return structuredClone(stored);
      },
      delete: async () => {}
    },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }),
    localize: key => key, confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {}, prepareGroup: async () => {},
    openSession() {}, groupActive: () => false, chooseVideo: async () => null, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services); await view.mount(root as unknown as HTMLElement); t.after(() => view.detach());
  const edit = (name: string, value: string) => {
    const input = fields.get(name)!; input.focus(); ui.dispatch(root, 'focusin', input); input.value = value; ui.dispatch(root, 'input', input);
  };
  const driver = view as unknown as { selectClip(id: string): void; inspectCurrentVideo(): Promise<void>; ensureMediaMetadata(): Promise<void> };
  const clickAction = async (name: string) => {
    const button = new ui.Field('button'); button.dataset.stagecraftAction = name; root.append(button); ui.dispatch(root, 'click', button);
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { ...ui, root, fields, services, view, edit, driver, clickAction };
}

function legacyMedia() {
  const makeId = ids(); let sequence = createBarsSequence('Legacy media', makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track' }, makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'video', trackId: sequence.tracks[1]!.id, startMs: 0, sourcePath: 'clip.webm', sourceDurationMs: 8000 }, makeId);
  return applyTimelineCommand(sequence, { kind: 'set-end', end: { kind: 'media', clipId: sequence.clips[1]!.id } }, makeId);
}

test('new editor sequences are automatic before history begins and inspector fields grow and shrink their endpoint', async t => {
  const f = await fixture(t); const initial = f.view.draft.draft!;
  assert.deepEqual(initial.end, { kind: 'fixed', durationMs: 5000, automatic: true });
  assert.equal(f.view.draft.canUndo, false); assert.equal(f.fields.get('ending')!.value, 'automatic');
  assert.equal(f.fields.get('sequence-duration')!.disabled, true);
  const held = f.fields.get('bars-duration-mode')!.options.find(option => option.value === 'sequence-end')!;
  assert.equal(held.disabled, true); assert.equal(held.hidden, true);
  f.edit('bars-start', '10'); assert.equal(f.view.draft.draft!.end.kind === 'fixed' && f.view.draft.draft!.end.durationMs, 15000);
  f.edit('bars-start', '1'); assert.equal(f.view.draft.draft!.end.kind === 'fixed' && f.view.draft.draft!.end.durationMs, 6000);
  f.edit('bars-duration', '3'); assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 4000, automatic: true });
  assert.equal(f.fields.get('sequence-duration')!.value, '4');
});

test('legacy media loads unchanged, style keeps its policy, and first timing edit materializes held bars without stale form end overwriting it', async t => {
  const original = legacyMedia(), f = await fixture(t, original);
  assert.deepEqual(f.view.draft.draft, original); assert.equal(f.view.draft.canUndo, false);
  assert.equal(f.fields.get('ending')!.value, 'media'); assert.equal(f.fields.get('sequence-duration')!.value, '8');
  assert.equal(f.fields.get('bars-duration')!.value, '8');
  f.edit('bars-height', '15'); assert.deepEqual(f.view.draft.draft!.end, original.end);
  const styled = f.view.draft.draft!;
  f.edit('bars-start', '2');
  assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 10000, automatic: true });
  assert.deepEqual(f.view.draft.draft!.clips[0]!.duration, { kind: 'fixed', milliseconds: 8000 });
  assert.equal(f.fields.get('ending')!.value, 'automatic'); assert.equal(f.fields.get('bars-duration-mode')!.value, 'fixed');
  assert.equal(f.fields.get('bars-start')!.value, '2');
  assert.deepEqual(f.view.draft.undo(), styled, 'policy conversion and temporal edit are one undo step');
});

test('hidden saved launch settings survive ordinary inspector edits, undo, save, reload and duplicate', async t => {
  let sourceId = 0;
  const source = withSequenceAudience(createBarsSequence('Audience', () => `audience-source-${++sourceId}`, 1), {
    mode: 'selected', userIds: ['offline', 'removed', 'promoted'], includeGM: false
  });
  const f = await fixture(t, source);
  assert.equal(f.root.querySelector('[data-stagecraft-audience-group]'), null);
  assert.deepEqual(f.view.draft.draft, source);
  f.edit('bars-height', '25');
  assert.deepEqual(getSequenceAudience(f.view.draft.draft!), source.launch!.audience);
  await f.clickAction('undo');
  assert.deepEqual(f.view.draft.draft, source);
  await f.clickAction('redo');
  await f.clickAction('save');
  assert.equal(f.view.draft.dirty, false);
  const saved = structuredClone(f.view.draft.draft!);
  await f.clickAction('reload');
  assert.deepEqual(f.view.draft.draft, saved);
  await f.clickAction('duplicate');
  assert.notEqual(f.view.draft.draft!.id, source.id);
  assert.deepEqual(getSequenceAudience(f.view.draft.draft!), source.launch!.audience);
});

test('manual editor preparation delegates without rewriting the saved audience or starting local playback', async t => {
  let sourceId = 0;
  const source = withSequenceAudience(createBarsSequence('Manual', () => `manual-source-${++sourceId}`, 1), {
    mode: 'selected', userIds: ['stored-auto-target'], includeGM: false
  });
  const f = await fixture(t, source);
  const prepared: SequenceV1[] = [];
  f.services.prepareGroup = async value => { prepared.push(structuredClone(value)); };
  await f.clickAction('prepare-group');
  assert.deepEqual(prepared, [source]);
  assert.deepEqual(f.view.draft.draft, source);
  assert.equal(f.view.draft.dirty, false);
  assert.equal(f.services.localPlayer.getState().phase, 'idle');
});

test('canceling the manual chooser retains editor preview; accepted preparation clears it', async t => {
  const source = createBarsSequence('Cancel preview', ids(), 1);
  const f = await fixture(t, source);
  let stopped = 0, cleared = 0;
  const editor = f.view as unknown as { preview: { stop(): void }; clearStill(): void };
  editor.preview.stop = () => { stopped++; };
  editor.clearStill = () => { cleared++; };
  f.services.prepareGroup = async () => false;
  await f.clickAction('prepare-group');
  assert.equal(stopped, 0); assert.equal(cleared, 0);
  assert.deepEqual(f.view.draft.draft, source);
  f.services.prepareGroup = async () => true;
  await f.clickAction('prepare-group');
  assert.equal(stopped, 1); assert.equal(cleared, 1);
  assert.equal(f.view.draft.dirty, false);
});

test('automatic selection is one undo step and explicit fixed selection permits a preserved fixed endpoint', async t => {
  const original = legacyMedia(), f = await fixture(t, original);
  f.edit('ending', 'automatic'); assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 8000, automatic: true });
  assert.deepEqual(f.view.draft.undo(), original); assert.equal(f.view.draft.canUndo, false);
  f.view.draft.redo(); f.edit('ending', 'fixed');
  assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 8000, automatic: false });
  f.edit('bars-duration', '3'); assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 8000, automatic: false });
  assert.equal(f.fields.get('sequence-duration')!.disabled, false);
});

test('the inspector accepts manual video ending and preserves it through clip edits and undo', async t => {
  const original = legacyMedia(), f = await fixture(t, original);
  f.edit('ending', 'manual');
  assert.deepEqual(f.view.draft.draft!.end, { kind: 'manual' });
  assert.equal(f.fields.get('ending')!.value, 'manual');
  assert.equal(f.fields.get('sequence-duration')!.disabled, true);
  assert.equal(f.fields.get('end-media')!.disabled, true);
  assert.deepEqual(f.view.draft.undo(), original);
  f.view.draft.redo();
  f.driver.selectClip(original.clips[1]!.id);
  f.edit('video-start', '2');
  assert.deepEqual(f.view.draft.draft!.end, { kind: 'manual' });
  f.edit('video-out', '5');
  assert.deepEqual(f.view.draft.draft!.end, { kind: 'manual' });
  assert.equal(f.fields.get('ending')!.value, 'manual');
});

test('DraftService keeps the existing default for noneditor callers and creates automatic drafts without an undo entry', () => {
  const draft = new DraftService({ list: async () => [], read: async () => null, save: async value => value, delete: async () => {} }, ids());
  assert.deepEqual(draft.create('Default').end, { kind: 'fixed', durationMs: 5000 });
  assert.equal(draft.canUndo, false);
  assert.deepEqual(draft.create('Automatic', { automaticEnd: true }).end, { kind: 'fixed', durationMs: 5000, automatic: true });
  assert.equal(draft.canUndo, false);
});

test('automatic video metadata refresh and source trim update the displayed endpoint in both directions', async t => {
  const legacy = legacyMedia();
  const automatic = enableAutomaticEnd({ ...legacy, clips: legacy.clips.map(clip => clip.type === 'bars' ? { ...clip, duration: { kind: 'fixed', milliseconds: 1000 } } : clip) });
  const f = await fixture(t, automatic); f.driver.selectClip(automatic.clips[1]!.id);
  let duration = 10;
  class MetadataVideo extends EventTarget {
    duration = duration; readyState = 1; error = null; src = ''; muted = true; preload = ''; playsInline = true;
    load() {} pause() {} remove() {} removeAttribute() {}
  }
  const createElement = document.createElement;
  document.createElement = ((tag: string) => tag === 'video' ? new MetadataVideo() : createElement(tag)) as typeof document.createElement;
  await f.driver.inspectCurrentVideo();
  assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 10000, automatic: true });
  assert.equal(f.fields.get('sequence-duration')!.value, '10');
  duration = 2; await f.driver.ensureMediaMetadata();
  assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 2000, automatic: true });
  assert.equal(f.fields.get('sequence-duration')!.value, '2');
  f.edit('video-start', '3'); assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 5000, automatic: true });
  f.edit('video-out', '1'); assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 4000, automatic: true });
  assert.equal(f.fields.get('ending')!.value, 'automatic');
});

test('legacy title timing conversion preserves typed title text and the active numeric field', async t => {
  const makeId = ids(); let legacy = legacyMedia();
  // Use a distinct ID factory so the additional title does not reuse an existing ID.
  for (let index = 0; index < 20; index++) makeId();
  legacy = applyTimelineCommand(legacy, { kind: 'add-track' }, makeId);
  legacy = applyTimelineCommand(legacy, { kind: 'add-clip', trackId: legacy.tracks[2]!.id, type: 'text', startMs: 0 }, makeId);
  const title = legacy.clips[2]!;
  assert.equal(title.type, 'text'); if (title.type !== 'text') throw new Error('Expected title fixture');
  legacy = applyTimelineCommand(legacy, { kind: 'replace-clip', clip: { ...title, duration: { kind: 'sequence-end' } } }, makeId);
  const f = await fixture(t, legacy); f.driver.selectClip(title.id);
  f.edit('title-text', 'A title I am editing'); assert.deepEqual(f.view.draft.draft!.end, legacy.end);
  f.edit('text-start', '1.250');
  assert.equal(f.fields.get('title-text')!.value, 'A title I am editing');
  assert.equal(f.fields.get('text-start')!.value, '1.250'); assert.equal(document.activeElement, f.fields.get('text-start'));
  assert.equal(f.fields.get('text-duration-mode')!.value, 'fixed');
  assert.equal(f.fields.get('text-duration')!.value, '8'); assert.equal(f.fields.get('ending')!.value, 'automatic');
});

test('reducing title length fits fades and the next text edit keeps those fitted transitions', async t => {
  const makeId = ids(); let sequence = createBarsSequence('Short title', makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track' }, makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'text', trackId: sequence.tracks[1]!.id, startMs: 0 }, makeId);
  const f = await fixture(t, enableAutomaticEnd(sequence)); f.driver.selectClip(sequence.clips[1]!.id);
  f.edit('text-duration', '0.5');
  const shortened = f.view.draft.draft!.clips[1]!;
  assert.deepEqual(shortened.duration, { kind: 'fixed', milliseconds: 500 });
  assert.equal(shortened.entrance.preset === 'fade' && shortened.entrance.durationMs, 250);
  assert.equal(shortened.exit.preset === 'fade' && shortened.exit.durationMs, 250);
  assert.equal(f.fields.get('text-entrance')!.value, '0.25'); assert.equal(f.fields.get('text-exit')!.value, '0.25');
  f.edit('title-text', 'Still short');
  assert.deepEqual(f.view.draft.draft!.clips[1]!.entrance, shortened.entrance);
  assert.deepEqual(f.view.draft.draft!.clips[1]!.exit, shortened.exit);
});
