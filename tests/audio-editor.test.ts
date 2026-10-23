import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyTimelineCommand } from '../src/application/timeline-commands.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import { upgradeSequenceToBreaks } from '../src/domain/breaks.js';
import type { AudioClip, SequenceV1 } from '../src/domain/sequence.js';
import { LocalPlayer } from '../src/playback/local-player.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { simpleTimingConflicts } from '../src/ui/simple-composition.js';

function ids() { let next = 0; return () => `audio-editor-${++next}`; }

function fixtureSequence(options: { manual?: boolean; locked?: boolean; withVideo?: boolean } = {}): SequenceV1 {
  const makeId = ids();
  let sequence = createBarsSequence('Audio editor', makeId);
  let visualTrack = sequence.tracks[0]!;
  if (options.withVideo) {
    const previous = sequence;
    sequence = applyTimelineCommand(sequence, { kind: 'add-track' }, makeId);
    visualTrack = sequence.tracks.find(track => !previous.tracks.some(old => old.id === track.id))!;
    sequence = applyTimelineCommand(sequence, {
      kind: 'add-clip', type: 'video', trackId: visualTrack.id, startMs: 0,
      sourcePath: 'video.webm', sourceDurationMs: 9_000
    }, makeId);
  }
  sequence = applyTimelineCommand(sequence, { kind: 'add-track', trackKind: 'audio' }, makeId);
  const audioTrack = sequence.tracks.find(track => track.kind === 'audio')!;
  sequence = applyTimelineCommand(sequence, {
    kind: 'add-clip', type: 'audio', trackId: audioTrack.id, startMs: 0,
    sourcePath: 'sound.ogg', sourceDurationMs: 5_000
  }, makeId);
  const audio = sequence.clips.find((clip): clip is AudioClip => clip.type === 'audio')!;
  return validateSequence({ ...sequence, tracks: sequence.tracks.map(track => track.id === audioTrack.id
    ? { ...track, locked: options.locked ?? false }
    : track), end: options.manual ? { kind: 'manual' } : { kind: 'media', clipId: audio.id } });
}

function dom(t: TestContext, createElement?: (tag: string) => unknown) {
  class Field extends EventTarget {
    children: Field[] = [];
    dataset: Record<string, string> = {};
    name = ''; value = ''; checked = false; hidden = false; disabled = false; max = '604800';
    className = ''; type = ''; textContent = ''; title = ''; parent: Field | null = null;
    classList = { toggle() {}, add() {}, remove() {} };
    constructor(readonly tag = 'div') { super(); }
    get options() { return this.children; }
    append(...children: Field[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren() { this.children = []; }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector: string): boolean {
      if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
      if (selector === '[name]') return !!this.name;
      if (selector === 'button[data-stagecraft-action]') return this.tag === 'button' && 'stagecraftAction' in this.dataset;
      const tag = selector.match(/^([a-z]+)?(\[.+\])$/i);
      if (tag?.[1] && tag[1].toLowerCase() !== this.tag.toLowerCase()) return false;
      const attribute = tag?.[2] ?? selector;
      const name = attribute.match(/^\[name="([^"]+)"\]$/); if (name) return this.name === name[1];
      const data = attribute.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/);
      if (!data) return false;
      const key = data[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return key in this.dataset && (data[2] === undefined || this.dataset[key] === data[2]);
    }
    querySelectorAll<T>(selector: string): T[] {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child as unknown as T] : []), ...child.querySelectorAll<T>(selector)]);
    }
    querySelector<T>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
    closest<T>(selector: string): T | null { return this.matches(selector) ? this as unknown as T : this.parent?.closest<T>(selector) ?? null; }
    focus() {} select() {} checkValidity() { return true; }
  }
  const globals: Record<string, unknown> = {
    Element: Field, HTMLElement: Field, HTMLInputElement: Field, HTMLSelectElement: Field, HTMLTextAreaElement: Field,
    document: { createElement: (tag: string) => createElement?.(tag) ?? new Field(tag) }
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  function dispatch(root: Field, type: string, target: Field) {
    const event = new Event(type); Object.defineProperty(event, 'target', { value: target }); root.dispatchEvent(event);
  }
  return { Field, dispatch };
}

async function editorFixture(t: TestContext, sequence = fixtureSequence(), chooseAudio: EditorServices['chooseAudio'] = async () => null, createElement?: (tag: string) => unknown) {
  const ui = dom(t, createElement), root = new ui.Field(), inspector = new ui.Field(), makeId = ids();
  inspector.dataset.stagecraftInspector = ''; root.append(inspector);
  const fields = new Map<string, InstanceType<typeof ui.Field>>();
  const field = (name: string, parent = root, options?: string[], type = 'number') => {
    const node = new ui.Field(options ? 'select' : 'input'); node.name = name; node.type = options ? 'select-one' : type;
    for (const value of options ?? []) { const option = new ui.Field('option'); option.value = value; node.append(option); }
    parent.append(node); fields.set(name, node); return node;
  };
  field('ending', root, ['automatic', 'fixed', 'manual', 'media'], 'select-one');
  field('sequence-duration'); field('end-media', root, [], 'select-one'); field('clip-track', root, [], 'select-one');
  for (const type of ['bars', 'video', 'audio']) {
    const panel = new ui.Field(); panel.dataset.stagecraftElementPanel = type; root.append(panel);
    if (type !== 'audio') continue;
    for (const [name, kind] of [
      ['audio-path', 'text'], ['audio-start', 'number'], ['audio-clip-duration', 'number'], ['audio-in', 'number'], ['audio-out', 'number'],
      ['audio-entrance', 'number'], ['audio-exit', 'number'], ['audio-volume', 'number'], ['audio-muted', 'checkbox'], ['audio-loop', 'checkbox'], ['audio-loop-indefinitely', 'checkbox']
    ] as const) field(name, panel, undefined, kind);
    field('audio-on-break', panel, ['pause', 'loop', 'finish'], 'select-one');
    field('audio-entrance-preset', panel, ['none', 'fade'], 'select-one');
    field('audio-exit-preset', panel, ['none', 'fade'], 'select-one');
    for (const action of ['choose-audio', 'inspect-audio']) { const button = new ui.Field('button'); button.dataset.stagecraftAction = action; panel.append(button); }
    const output = new ui.Field('output'); output.dataset.stagecraftAudioDuration = ''; panel.append(output);
  }
  const services: EditorServices = {
    makeId, repository: { list: async () => [sequence], read: async () => sequence, save: async value => value, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }), localize: key => key,
    confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {}, prepareGroup: async () => {}, openSession() {},
    groupActive: () => false, chooseVideo: async () => null, chooseAudio, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services); await view.mount(root as unknown as HTMLElement); t.after(() => view.detach());
  const driver = view as unknown as {
    selectClip(id: string): void;
    chooseAudio(): Promise<void>;
    applyAudioPath(path: string): Promise<void>;
    showPlayerState(state: { phase: 'playing'; positionMs: number; durationMs: null }, kind: 'preview'): void;
    toggleElement(type: 'audio'): Promise<void>;
    act(action: string): Promise<void>;
  };
  return { ...ui, root, fields, sequence, view, driver };
}

function audioOf(sequence: SequenceV1): AudioClip {
  const clip = sequence.clips.find((candidate): candidate is AudioClip => candidate.type === 'audio');
  if (!clip) throw new Error('Expected an audio clip');
  return clip;
}

function fadeDuration(transition: AudioClip['entrance']): number {
  return transition.preset === 'fade' ? transition.durationMs : 0;
}

function dispatchInput(f: Awaited<ReturnType<typeof editorFixture>>, name: string) {
  f.dispatch(f.root, 'input', f.fields.get(name)!);
}

test('audio fade choices use existing duration fields and independent Undo without changing media or loops', async t => {
  const f = await editorFixture(t), original = audioOf(f.sequence);
  f.driver.selectClip(original.id);
  const before = f.view.draft.draft!;
  assert.equal(f.view.draft.dirty, false);
  f.fields.get('audio-entrance-preset')!.value = 'fade';
  f.dispatch(f.root, 'change', f.fields.get('audio-entrance-preset')!);
  assert.equal(fadeDuration(audioOf(f.view.draft.draft!).entrance), 800);
  assert.equal(f.fields.get('audio-entrance-preset')!.value, 'fade');
  const entrance = f.view.draft.draft!;
  f.fields.get('audio-exit-preset')!.value = 'fade';
  f.dispatch(f.root, 'change', f.fields.get('audio-exit-preset')!);
  assert.equal(fadeDuration(audioOf(f.view.draft.draft!).exit), 800);
  assert.deepEqual(audioOf(f.view.draft.draft!).properties, { ...original.properties, loop: false });
  f.view.draft.undo(); assert.deepEqual(f.view.draft.draft, entrance);
  f.view.draft.undo(); assert.deepEqual(f.view.draft.draft, before);
});

test('numeric audio fade editing synchronizes choices and selecting None clears only its edge', async t => {
  const f = await editorFixture(t), original = audioOf(f.sequence);
  f.driver.selectClip(original.id);
  f.fields.get('audio-entrance')!.value = '0.35'; dispatchInput(f, 'audio-entrance');
  f.fields.get('audio-exit')!.value = '0.6'; dispatchInput(f, 'audio-exit');
  assert.equal(f.fields.get('audio-entrance-preset')!.value, 'fade');
  f.fields.get('audio-entrance-preset')!.value = 'none';
  f.dispatch(f.root, 'change', f.fields.get('audio-entrance-preset')!);
  assert.equal(audioOf(f.view.draft.draft!).entrance.preset, 'none');
  assert.equal(fadeDuration(audioOf(f.view.draft.draft!).exit), 600);
  assert.equal(f.fields.get('audio-entrance')!.value, '0');
});

test('indefinite audio disables its ineffective Out choice and numeric fade while preserving authored settings', async t => {
  const upgraded = upgradeSequenceToBreaks(fixtureSequence({ manual: true }));
  const source = audioOf(upgraded);
  const sequence = validateSequence({ ...upgraded, clips: upgraded.clips.map(clip => clip.id === source.id ? {
    ...clip, typeVersion: 3, duration: { kind: 'sequence-end' }, exit: { preset: 'fade', version: 1, durationMs: 350, easing: 'linear' },
    properties: { ...clip.properties, loop: true, loopIndefinitely: true, onBreak: 'pause' }
  } : clip) });
  const f = await editorFixture(t, sequence); f.driver.selectClip(source.id);
  assert.equal(f.fields.get('audio-exit')!.disabled, true);
  assert.equal(f.fields.get('audio-exit-preset')!.disabled, true);
  assert.equal(f.fields.get('audio-entrance-preset')!.disabled, false);
  assert.deepEqual(f.view.draft.draft, sequence);
  f.fields.get('audio-exit-preset')!.value = 'none';
  f.dispatch(f.root, 'change', f.fields.get('audio-exit-preset')!);
  assert.deepEqual(f.view.draft.draft, sequence, 'disabled choice cannot clear the retained exit');
});

test('audio inspector edits clip length, source trim, fades, volume, mute, and ordinary looping while preserving extensions', async t => {
  const original = fixtureSequence({ manual: true }), source = audioOf(original);
  const extended = validateSequence({ ...original, clips: original.clips.map(clip => clip.id === source.id && clip.type === 'audio'
    ? { ...clip, futureClip: 'keep', entrance: { ...clip.entrance, futureFade: 'keep' }, properties: {
      ...clip.properties, futureProperty: 'keep', source: { ...clip.properties.source, futureSource: 'keep' },
      sourceRange: { inMs: 0, outMs: clip.properties.durationMs!, futureRange: 'keep' }
    } }
    : clip) });
  const f = await editorFixture(t, extended); f.driver.selectClip(source.id);
  assert.deepEqual(f.fields.get('clip-track')!.options.map(option => option.value), [source.trackId]);
  assert.equal(f.fields.get('audio-loop')!.disabled, false);

  f.fields.get('audio-in')!.value = '1'; f.fields.get('audio-out')!.value = '4';
  f.fields.get('audio-entrance')!.value = '0.25'; f.fields.get('audio-exit')!.value = '0.5';
  f.fields.get('audio-volume')!.value = '0.4'; f.fields.get('audio-muted')!.checked = true; f.fields.get('audio-loop')!.checked = true;
  dispatchInput(f, 'audio-in');

  const saved = audioOf(f.view.draft.draft!);
  assert.equal(saved.typeVersion, 2); assert.deepEqual(saved.duration, { kind: 'fixed', milliseconds: 5_000 });
  assert.deepEqual(saved.properties.sourceRange, { futureRange: 'keep', inMs: 1_000, outMs: 4_000 });
  assert.equal(saved.entrance.preset, 'fade'); assert.equal(saved.entrance.durationMs, 250);
  assert.equal(saved.exit.preset, 'fade'); assert.equal(saved.exit.durationMs, 500);
  assert.equal(saved.properties.volume, 0.4); assert.equal(saved.properties.muted, true); assert.equal(saved.properties.loop, true);
  assert.equal(saved.properties.loopIndefinitely, undefined);
  assert.equal((saved as AudioClip & { futureClip: string }).futureClip, 'keep');
  assert.equal((saved.properties as AudioClip['properties'] & { futureProperty: string }).futureProperty, 'keep');
  assert.equal((saved.properties.source as AudioClip['properties']['source'] & { futureSource: string }).futureSource, 'keep');
  assert.equal((saved.properties.sourceRange as AudioClip['properties']['sourceRange'] & { futureRange: string }).futureRange, 'keep');
  assert.equal((saved.entrance as AudioClip['entrance'] & { futureFade: string }).futureFade, 'keep');
  assert.deepEqual(f.view.draft.undo(), extended); assert.deepEqual(f.view.draft.redo(), f.view.draft.draft);
});

test('legacy manual loop defaults to both controls without writing to the loaded clip', async t => {
  const source = fixtureSequence({ manual: true }), audio = audioOf(source);
  const legacy = validateSequence({ ...source, clips: source.clips.map(clip => clip.id === audio.id && clip.type === 'audio'
    ? { ...clip, typeVersion: 1, duration: { kind: 'media' }, properties: { ...clip.properties, loop: true } }
    : clip) });
  const f = await editorFixture(t, legacy); f.driver.selectClip(audio.id);

  assert.deepEqual(f.view.draft.draft, legacy);
  assert.equal(f.view.draft.dirty, false);
  assert.equal(f.fields.get('audio-loop')!.checked, true);
  assert.equal(f.fields.get('audio-loop-indefinitely')!.checked, true);
});

test('editing a legacy audio clip does not replace its automatic fixed sequence end', async t => {
  const source = fixtureSequence({ manual: true }), audio = audioOf(source);
  const legacy = validateSequence({
    ...source,
    end: { kind: 'fixed', durationMs: 7_000, automatic: true },
    clips: source.clips.map(clip => clip.id === audio.id && clip.type === 'audio'
      ? { ...clip, typeVersion: 1, duration: { kind: 'media' } }
      : clip)
  });
  const f = await editorFixture(t, legacy); f.driver.selectClip(audio.id);
  f.fields.get('audio-volume')!.value = '0.4'; dispatchInput(f, 'audio-volume');

  assert.deepEqual(f.view.draft.draft!.end, { kind: 'fixed', durationMs: 7_000, automatic: true });
  assert.equal(f.view.draft.draft!.schemaVersion, 1);
  assert.equal(audioOf(f.view.draft.draft!).typeVersion, 1);
  assert.deepEqual(audioOf(f.view.draft.draft!).duration, { kind: 'media' });
  assert.equal(audioOf(f.view.draft.draft!).properties.volume, 0.4);
});

test('choosing audio Break behavior explicitly upgrades a legacy draft and preserves its manual end', async t => {
  const source = fixtureSequence({ manual: true }), audio = audioOf(source);
  const legacy = validateSequence({ ...source, clips: source.clips.map(clip => clip.id === audio.id && clip.type === 'audio'
    ? { ...clip, typeVersion: 1, duration: { kind: 'media' } }
    : clip) });
  const f = await editorFixture(t, legacy); f.driver.selectClip(audio.id);
  assert.equal(f.view.draft.dirty, false);

  f.fields.get('audio-on-break')!.value = 'finish';
  f.dispatch(f.root, 'change', f.fields.get('audio-on-break')!);
  const adopted = f.view.draft.draft!;
  assert.equal(adopted.schemaVersion, 2);
  assert.deepEqual(adopted.end, { kind: 'manual' });
  const configured = audioOf(adopted);
  assert.equal(configured.typeVersion, 3);
  assert.deepEqual(configured.duration, { kind: 'fixed', milliseconds: 5_000 });
  assert.equal(configured.properties.onBreak, 'finish');
  assert.equal(f.view.draft.dirty, true);
});

test('legacy volume edits stay schema 1 until audio Break behavior is chosen', async t => {
  const source = fixtureSequence({ manual: true }), audio = audioOf(source);
  const legacy = validateSequence({ ...source, clips: source.clips.map(clip => clip.id === audio.id && clip.type === 'audio'
    ? { ...clip, typeVersion: 1, duration: { kind: 'media' } }
    : clip) });
  const f = await editorFixture(t, legacy); f.driver.selectClip(audio.id);
  f.fields.get('audio-volume')!.value = '0.4'; dispatchInput(f, 'audio-volume');
  assert.equal(f.view.draft.draft!.schemaVersion, 1);
  assert.equal(audioOf(f.view.draft.draft!).typeVersion, 1);
  assert.equal(audioOf(f.view.draft.draft!).properties.onBreak, undefined);

  const beforeAdoption = structuredClone(f.view.draft.draft!);
  f.fields.get('audio-on-break')!.value = 'pause';
  f.dispatch(f.root, 'change', f.fields.get('audio-on-break')!);
  assert.equal(f.view.draft.draft!.schemaVersion, 2);
  assert.deepEqual(f.view.draft.draft!.end, { kind: 'manual' });
  assert.equal(audioOf(f.view.draft.draft!).properties.onBreak, 'pause');
  assert.equal(f.view.draft.dirty, true);
  assert.deepEqual(f.view.draft.undo(), beforeAdoption);
  assert.equal(audioOf(f.view.draft.redo()!).properties.onBreak, 'pause');
});

test('audio Break behavior adopts legacy drafts with non-manual endings too', async t => {
  const legacy = fixtureSequence(), f = await editorFixture(t, legacy);
  assert.equal(legacy.schemaVersion, 1);
  f.driver.selectClip(audioOf(legacy).id);
  f.fields.get('audio-on-break')!.value = 'finish';
  f.dispatch(f.root, 'change', f.fields.get('audio-on-break')!);
  assert.equal(f.view.draft.draft!.schemaVersion, 2);
  assert.deepEqual(f.view.draft.draft!.end, legacy.end, 'adoption keeps the existing non-manual endpoint');
});

for (const terminal of [false, true]) test(`Break selection adopts effective legacy looping (terminal=${terminal})`, async t => {
  const source = fixtureSequence({ manual: true }), audio = audioOf(source);
  const legacyAudio = { ...audio, typeVersion: 1 as const, duration: { kind: 'media' as const },
    properties: { ...audio.properties, loop: true } };
  const later = { ...audio, id: 'later-sound', startMs: 6_000 };
  const legacy = validateSequence({ ...source, clips: [
    ...source.clips.filter(clip => clip.id !== audio.id), legacyAudio, ...(terminal ? [] : [later])
  ] });
  const f = await editorFixture(t, legacy); f.driver.selectClip(audio.id);
  f.fields.get('audio-on-break')!.value = 'finish';
  f.dispatch(f.root, 'change', f.fields.get('audio-on-break')!);
  const adopted = audioOf(f.view.draft.draft!);
  assert.equal(f.view.draft.draft!.schemaVersion, 2);
  assert.equal(adopted.typeVersion, 3);
  assert.equal(adopted.properties.onBreak, 'finish');
  assert.equal(adopted.properties.loop, terminal);
  assert.equal(adopted.properties.loopIndefinitely === true, terminal);
  assert.deepEqual(adopted.duration, terminal ? { kind: 'sequence-end' } : { kind: 'fixed', milliseconds: 5_000 });
  assert.deepEqual(f.view.draft.undo(), legacy, 'one undo restores the complete saved semantics');
});

test('fitting audio fades to a shorter looped clip refreshes both controls for later edits', async t => {
  const source = fixtureSequence({ manual: true }), audio = audioOf(source);
  const looped = validateSequence({ ...source, clips: source.clips.map(clip => clip.id === audio.id && clip.type === 'audio'
    ? {
      ...clip, typeVersion: 2, duration: { kind: 'fixed', milliseconds: 8_000 },
      entrance: { preset: 'fade', version: 1, durationMs: 4_000, easing: 'ease-in-out' },
      exit: { preset: 'fade', version: 1, durationMs: 4_000, easing: 'ease-in-out' },
      properties: { ...clip.properties, loop: true }
    }
    : clip) });
  const f = await editorFixture(t, looped); f.driver.selectClip(audio.id);
  f.fields.get('audio-clip-duration')!.value = '5'; dispatchInput(f, 'audio-clip-duration');

  assert.equal(f.fields.get('audio-entrance')!.value, '2.5');
  assert.equal(f.fields.get('audio-exit')!.value, '2.5');
  const fitted = audioOf(f.view.draft.draft!);
  assert.equal(fadeDuration(fitted.entrance), 2_500);
  assert.equal(fadeDuration(fitted.exit), 2_500);

  f.fields.get('audio-volume')!.value = '0.4'; dispatchInput(f, 'audio-volume');
  const edited = audioOf(f.view.draft.draft!);
  assert.equal(edited.properties.volume, 0.4);
  assert.equal(fadeDuration(edited.entrance), 2_500);
  assert.equal(fadeDuration(edited.exit), 2_500);
});

test('indefinite audio becomes a sequence-end clip, then returns to a bounded length when disabled', async t => {
  const source = fixtureSequence({ manual: true }), f = await editorFixture(t, source), audio = audioOf(source);
  f.driver.selectClip(audio.id);
  const loop = f.fields.get('audio-loop')!, indefinite = f.fields.get('audio-loop-indefinitely')!, length = f.fields.get('audio-clip-duration')!;
  assert.equal(indefinite.disabled, true);

  loop.checked = true; dispatchInput(f, 'audio-loop');
  assert.equal(indefinite.disabled, false);
  length.value = '8'; dispatchInput(f, 'audio-clip-duration');
  indefinite.checked = true; dispatchInput(f, 'audio-loop-indefinitely');
  let saved = audioOf(f.view.draft.draft!);
  assert.equal(f.view.draft.draft!.schemaVersion, 2);
  assert.equal(saved.typeVersion, 3);
  assert.deepEqual(saved.duration, { kind: 'sequence-end' });
  assert.equal(saved.properties.loop, true); assert.equal(saved.properties.loopIndefinitely, true);

  indefinite.checked = false; dispatchInput(f, 'audio-loop-indefinitely');
  saved = audioOf(f.view.draft.draft!);
  assert.equal(saved.duration.kind, 'fixed');
  assert.equal(saved.duration.milliseconds, 8_000);

  loop.checked = false; dispatchInput(f, 'audio-loop');
  saved = audioOf(f.view.draft.draft!);
  assert.equal(indefinite.checked, false);
  assert.equal(saved.properties.loop, false); assert.equal(saved.properties.loopIndefinitely, undefined);
  assert.equal(saved.duration.kind, 'fixed');
  assert.equal(saved.duration.milliseconds, 5_000);
});

test('shortening a nonlooping source range clamps clip length while looping preserves it', async t => {
  const source = fixtureSequence({ manual: true }), f = await editorFixture(t, source), audio = audioOf(source);
  f.driver.selectClip(audio.id);
  f.fields.get('audio-out')!.value = '2'; dispatchInput(f, 'audio-out');
  const saved = audioOf(f.view.draft.draft!);
  assert.deepEqual(saved.properties.sourceRange, { inMs: 0, outMs: 2_000 });
  assert.equal(saved.duration.kind, 'fixed'); assert.equal(saved.duration.milliseconds, 2_000);

  const looped = validateSequence({ ...source, clips: source.clips.map(clip => clip.id === audio.id && clip.type === 'audio'
    ? { ...clip, typeVersion: 2, duration: { kind: 'fixed', milliseconds: 8_000 }, properties: { ...clip.properties, loop: true } }
    : clip) });
  const g = await editorFixture(t, looped); g.driver.selectClip(audio.id);
  g.fields.get('audio-out')!.value = '2'; dispatchInput(g, 'audio-out');
  const preserved = audioOf(g.view.draft.draft!);
  assert.deepEqual(preserved.properties.sourceRange, { inMs: 0, outMs: 2_000 });
  assert.equal(preserved.duration.kind, 'fixed'); assert.equal(preserved.duration.milliseconds, 8_000);
});

test('source swaps preserve looped authored length and clamp nonlooping length to refreshed metadata', async t => {
  class ShortAudio extends EventTarget {
    readyState = 1; duration = 2.5; error = null; src = ''; preload = ''; muted = false; volume = 1;
    load() {} pause() {} removeAttribute() { this.src = ''; } remove() {} getAttribute() { return this.src; }
  }
  const base = fixtureSequence({ manual: true }), baseAudio = audioOf(base);
  const makeV2 = (length: number, loop: boolean) => validateSequence({ ...base, clips: base.clips.map(clip => clip.id === baseAudio.id && clip.type === 'audio'
    ? { ...clip, typeVersion: 2, duration: { kind: 'fixed', milliseconds: length }, properties: { ...clip.properties, loop } }
    : clip) });
  const loopSource = makeV2(8_000, true), loopFixture = await editorFixture(t, loopSource, async () => null, tag => tag === 'audio' ? new ShortAudio() : undefined);
  loopFixture.driver.selectClip(baseAudio.id);
  await loopFixture.driver.applyAudioPath('short-loop.ogg');
  const looped = audioOf(loopFixture.view.draft.draft!);
  assert.equal(looped.duration.kind, 'fixed'); assert.equal(looped.duration.milliseconds, 8_000);
  assert.equal(looped.properties.durationMs, 2_500); assert.equal(looped.properties.loop, true);

  const plainSource = makeV2(4_000, false), plainFixture = await editorFixture(t, plainSource, async () => null, tag => tag === 'audio' ? new ShortAudio() : undefined);
  plainFixture.driver.selectClip(baseAudio.id);
  await plainFixture.driver.applyAudioPath('short-plain.ogg');
  const plain = audioOf(plainFixture.view.draft.draft!);
  assert.equal(plain.duration.kind, 'fixed'); assert.equal(plain.duration.milliseconds, 2_500);
  assert.equal(plain.properties.durationMs, 2_500); assert.equal(plain.properties.loop, false);
});

test('ordinary audio looping works in finite sequences; indefinite looping needs a terminal manual clip and locked audio disables editing', async t => {
  const finite = fixtureSequence(); const f = await editorFixture(t, finite); f.driver.selectClip(audioOf(finite).id);
  assert.equal(f.fields.get('audio-loop')!.disabled, false);
  assert.equal(f.fields.get('audio-loop-indefinitely')!.disabled, true);

  const locked = fixtureSequence({ manual: true, locked: true }); const g = await editorFixture(t, locked); g.driver.selectClip(audioOf(locked).id);
  assert.equal(g.fields.get('audio-loop')!.disabled, true);
  assert.equal(g.fields.get('audio-loop-indefinitely')!.disabled, true);
  const buttons = g.root.querySelectorAll<InstanceType<typeof g.Field>>('[data-stagecraft-action="choose-audio"],[data-stagecraft-action="inspect-audio"]');
  assert.equal(buttons.length, 2); assert.ok(buttons.every(button => button.disabled));
});

test('audio clip length and loop controls are localized in both editor languages', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const template = readFileSync(`${root}/templates/editor.hbs`, 'utf8');
  const en = JSON.parse(readFileSync(`${root}/lang/en.json`, 'utf8')) as Record<string, string>;
  const de = JSON.parse(readFileSync(`${root}/lang/de.json`, 'utf8')) as Record<string, string>;
  assert.match(template, /name="audio-clip-duration"/);
  assert.match(template, /name="audio-loop"/);
  assert.match(template, /name="audio-loop-indefinitely"/);
  assert.match(template, /name="audio-on-break"/);
  assert.equal(en['STAGECRAFT.Editor.AudioLoop'], 'Loop');
  assert.equal(en['STAGECRAFT.Editor.AudioLoopIndefinitely'], 'Loop indefinitely');
  assert.equal(en['STAGECRAFT.Editor.BreakPause'], 'Pause');
  assert.equal(en['STAGECRAFT.Editor.BreakLoop'], 'Loop');
  assert.equal(en['STAGECRAFT.Editor.BreakFinish'], 'Finish');
  assert.equal(en['STAGECRAFT.Editor.Continue'], 'Continue');
  assert.equal(en['STAGECRAFT.Session.Continue'], 'Continue');
  assert.equal(de['STAGECRAFT.Editor.AudioLoopIndefinitely'], 'Endlos wiederholen');
  assert.equal(de['STAGECRAFT.Editor.BreakPause'], 'Pausieren');
  assert.equal(de['STAGECRAFT.Editor.BreakLoop'], 'Wiederholen');
  assert.equal(de['STAGECRAFT.Editor.BreakFinish'], 'Zu Ende spielen');
});

test('ending media picker includes audio and video sources', async t => {
  const sequence = fixtureSequence({ withVideo: true }); const f = await editorFixture(t, sequence);
  const options = f.fields.get('end-media')!.options;
  assert.deepEqual(options.map(option => option.value).sort(), sequence.clips.filter(clip => clip.type === 'audio' || clip.type === 'video').map(clip => clip.id).sort());
});

test('simple timing checks resolve an audio-referenced media endpoint', () => {
  const sequence = fixtureSequence();
  assert.deepEqual(simpleTimingConflicts(sequence), []);
  const unknownDuration = validateSequence({ ...sequence, clips: sequence.clips.map(clip => {
    if (clip.type !== 'audio') return clip;
    const properties = { ...clip.properties }; delete properties.durationMs;
    return { ...clip, typeVersion: 1, duration: { kind: 'media' }, properties };
  }) });
  assert.deepEqual(simpleTimingConflicts(unknownDuration), [{ key: 'MediaMetadataRequired', element: 'audio' }]);
});

test('simple timing checks use authored audio length for a media-referenced endpoint', () => {
  const source = fixtureSequence(), audio = audioOf(source), makeId = ids();
  let withText = applyTimelineCommand(source, { kind: 'set-end', end: { kind: 'fixed', durationMs: 10_000 } }, makeId);
  withText = applyTimelineCommand(withText, { kind: 'add-track' }, makeId);
  const textTrack = withText.tracks.find(track => !source.tracks.some(old => old.id === track.id))!;
  withText = applyTimelineCommand(withText, { kind: 'add-clip', type: 'text', trackId: textTrack.id, startMs: 3_000 }, makeId);
  const title = withText.clips.find(clip => clip.type === 'text')!;
  withText = applyTimelineCommand(withText, { kind: 'replace-clip', clip: { ...title, duration: { kind: 'fixed', milliseconds: 2_000 } } }, makeId);
  const shortened = validateSequence({ ...withText, end: { kind: 'media', clipId: audio.id }, clips: withText.clips.map(clip => clip.id === audio.id && clip.type === 'audio'
    ? { ...clip, typeVersion: 2, duration: { kind: 'fixed', milliseconds: 2_000 } }
    : clip) });
  assert.ok(simpleTimingConflicts(shortened).some(conflict => conflict.key === 'ElementAfterEnd' && conflict.element === 'text'));
});

test('a late audio picker result updates only the captured clip after selecting another clip', async t => {
  class ReadyAudio extends EventTarget {
    readyState = 1; duration = 8; error = null; src = ''; preload = ''; muted = false; volume = 1;
    load() {} pause() {} removeAttribute() { this.src = ''; } remove() {} getAttribute() { return this.src; }
  }
  let resolvePath!: (path: string | null) => void;
  const selected = fixtureSequence({ manual: true });
  const f = await editorFixture(t, selected, () => new Promise(resolve => { resolvePath = resolve; }), tag => tag === 'audio' ? new ReadyAudio() : undefined);
  const audio = audioOf(selected), bars = selected.clips.find(clip => clip.type === 'bars')!;
  f.driver.selectClip(audio.id);
  const pending = f.driver.chooseAudio();
  f.driver.selectClip(bars.id);
  resolvePath('replacement.ogg');
  await pending;
  assert.equal(audioOf(f.view.draft.draft!).properties.source.path, 'replacement.ogg');
  assert.equal(f.view.draft.draft!.clips.find(clip => clip.type === 'bars')!.id, bars.id);
  assert.equal(f.view.draft.dirty, true);
});

test('a late audio metadata probe cannot edit a switched draft', async t => {
  class MetadataAudio extends EventTarget {
    readyState = 0; duration = 8; error = null; src = ''; preload = ''; muted = false; volume = 1; private sent = false;
    load() { if (this.src && !this.sent) { this.sent = true; setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); }, 0); } }
    pause() {} removeAttribute() { this.src = ''; } remove() {} getAttribute() { return this.src; }
  }
  const sequence = validateSequence({ ...fixtureSequence({ manual: true }), id: 'source-audio-sequence' });
  const f = await editorFixture(t, sequence, async () => null, tag => tag === 'audio' ? new MetadataAudio() : undefined);
  const audio = audioOf(sequence);
  f.driver.selectClip(audio.id);
  const pending = f.driver.applyAudioPath('replacement.ogg');
  f.view.draft.create('Another sequence');
  const switched = JSON.stringify(f.view.draft.draft);
  await pending;
  assert.notEqual(f.view.draft.draft!.id, sequence.id);
  assert.equal(f.view.draft.draft!.clips.some(clip => clip.type === 'audio'), false);
  assert.equal(JSON.stringify(f.view.draft.draft), switched);
});

test('adding a sound after preview rounds the fractional playhead to timeline milliseconds', async t => {
  class ReadyAudio extends EventTarget {
    readyState = 1; duration = 8; error = null; src = ''; preload = ''; muted = false; volume = 1;
    load() {} pause() {} removeAttribute() { this.src = ''; } remove() {} getAttribute() { return this.src; }
  }
  const sequence = fixtureSequence({ manual: true });
  const f = await editorFixture(t, sequence, async () => 'replacement.mp3', tag => tag === 'audio' ? new ReadyAudio() : undefined);

  f.driver.showPlayerState({ phase: 'playing', positionMs: 13_370.625, durationMs: null }, 'preview');
  await f.driver.toggleElement('audio');

  const added = f.view.draft.draft!.clips.find(clip => clip.type === 'audio' && clip.properties.source.path === 'replacement.mp3');
  assert.ok(added);
  assert.equal(added.startMs, 13_371);
  assert.ok(Number.isInteger(added.startMs));
});
