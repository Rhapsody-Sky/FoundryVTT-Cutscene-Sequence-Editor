import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyTimelineCommand } from '../src/application/timeline-commands.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import { videoTypeVersion } from '../src/domain/clip-timing.js';
import type { BarsClip, SequenceV1, VideoClip } from '../src/domain/sequence.js';
import { LocalPlayer } from '../src/playback/local-player.js';
import { patchInspectedClip } from '../src/ui/clip-inspector.js';
import { buildSimpleSequence } from '../src/ui/simple-composition.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';

function ids() { let next = 0; return () => `loop-editor-${++next}`; }

function fixtureSequence(): SequenceV1 {
  const makeId = ids(); let sequence = createBarsSequence('Loop editor', makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track' }, makeId);
  const videoTrack = sequence.tracks.find(track => track.id !== sequence.tracks[0]!.id)!;
  sequence = applyTimelineCommand(sequence, {
    kind: 'add-clip', type: 'video', trackId: videoTrack.id, startMs: 0,
    sourcePath: 'first.webm', sourceDurationMs: 8000
  }, makeId);
  return validateSequence({ ...sequence, end: { kind: 'manual' }, clips: sequence.clips.map(clip => clip.type === 'video'
    ? { ...clip, futureClip: 'keep', properties: { ...clip.properties, futureProperty: 'keep', source: { ...clip.properties.source, futureSource: 'keep' } } }
    : { ...clip, futureSibling: 'keep' }) });
}

function dom(t: TestContext) {
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
    focus() {} select() {} checkValidity() { return true; }
  }
  const globals: Record<string, unknown> = {
    Element: Field, HTMLElement: Field, HTMLInputElement: Field, HTMLSelectElement: Field, HTMLTextAreaElement: Field,
    document: { createElement: (tag: string) => new Field(tag) }
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  function dispatch(root: Field, type: string, target: Field) {
    const event = new Event(type); Object.defineProperty(event, 'target', { value: target }); root.dispatchEvent(event);
  }
  return { Field, dispatch };
}

async function editorFixture(t: TestContext, sequence = fixtureSequence(), chosenPath: string | null = null) {
  const ui = dom(t), root = new ui.Field(), inspector = new ui.Field(), status = new ui.Field(), makeId = ids();
  inspector.dataset.stagecraftInspector = ''; root.append(inspector);
  status.dataset.stagecraftMessage = ''; root.append(status);
  const fields = new Map<string, InstanceType<typeof ui.Field>>();
  const field = (name: string, parent = root, options?: string[], type = 'number') => {
    const node = new ui.Field(options ? 'select' : 'input'); node.name = name; node.type = options ? 'select-one' : type;
    for (const value of options ?? []) { const option = new ui.Field('option'); option.value = value; node.append(option); }
    parent.append(node); fields.set(name, node); return node;
  };
  field('ending', root, ['automatic', 'fixed', 'manual', 'media'], 'select-one'); field('sequence-duration'); field('end-media', root, [], 'select-one'); field('clip-track', root, [], 'select-one');
  for (const type of ['bars', 'video']) {
    const panel = new ui.Field(); panel.dataset.stagecraftElementPanel = type; root.append(panel);
    if (type === 'video') {
      field('video-start', panel); field('video-entrance', panel); field('video-in', panel); field('video-out', panel);
      field('video-path', panel, undefined, 'text'); field('video-fit', panel, ['contain', 'cover'], 'select-one');
      field('video-volume', panel); field('video-muted', panel, undefined, 'checkbox'); field('video-loop', panel, undefined, 'checkbox');
      field('video-blend-mode', panel, ['normal'], 'select-one'); field('video-opacity', panel);
    }
  }
  const services: EditorServices = {
    makeId, repository: { list: async () => [sequence], read: async () => sequence, save: async value => value, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }), localize: key => key,
    confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {}, prepareGroup: async () => {}, openSession() {},
    groupActive: () => false, chooseVideo: async () => chosenPath, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services); await view.mount(root as unknown as HTMLElement); t.after(() => view.detach());
  const driver = view as unknown as { selectClip(id: string): void; chooseVideo(): Promise<void> };
  return { ...ui, root, fields, sequence, status, view, driver };
}

function videoOf(sequence: SequenceV1): VideoClip {
  const clip = sequence.clips.find((candidate): candidate is VideoClip => candidate.type === 'video');
  if (!clip) throw new Error('Expected a video clip');
  return clip;
}

function useProbeDuration(t: TestContext, durationMs: number): void {
  const targetDocument = document, createElement = targetDocument.createElement;
  class MetadataVideo extends EventTarget {
    readyState = 1; duration = durationMs / 1000; error = null; src = ''; muted = true; preload = ''; playsInline = true;
    load() {} pause() {} remove() {} removeAttribute() {}
  }
  targetDocument.createElement = ((tag: string) => tag === 'video' ? new MetadataVideo() : createElement(tag)) as typeof document.createElement;
  t.after(() => { targetDocument.createElement = createElement; });
}

function trimmedSequence(version: 2 | 3): SequenceV1 {
  const original = fixtureSequence(), clip = videoOf(original);
  return validateSequence({ ...original, end: { kind: 'media', clipId: clip.id }, clips: original.clips.map(candidate => candidate.id === clip.id
    ? { ...candidate, typeVersion: version, properties: {
      ...candidate.properties, sourceRange: { inMs: 1000, outMs: 4000 }, ...(version === 3 ? { loop: true } : {})
    } }
    : candidate) });
}

test('loop checkbox writes v3, preserves siblings, and participates in draft undo and redo', async t => {
  const original = fixtureSequence(), f = await editorFixture(t, original), video = videoOf(original);
  f.driver.selectClip(video.id);
  assert.equal(f.fields.get('video-loop')!.checked, false);
  f.fields.get('video-loop')!.checked = true;
  f.dispatch(f.root, 'input', f.fields.get('video-loop')!);
  const looped = f.view.draft.draft!;
  assert.equal(videoOf(looped).properties.loop, true); assert.equal(videoOf(looped).typeVersion, 3);
  assert.deepEqual(looped.clips.find(clip => clip.type === 'bars'), original.clips.find(clip => clip.type === 'bars'));
  assert.deepEqual(f.view.draft.undo(), original);
  assert.deepEqual(f.view.draft.redo(), looped);
});

test('legacy video style edits keep loop absent, while loop trims retain v3 and full-range removal clears only the range', async t => {
  const original = fixtureSequence(), f = await editorFixture(t, original), video = videoOf(original);
  f.driver.selectClip(video.id);
  f.fields.get('video-volume')!.value = '0.5'; f.dispatch(f.root, 'input', f.fields.get('video-volume')!);
  assert.equal(Object.hasOwn(videoOf(f.view.draft.draft!).properties, 'loop'), false);
  f.fields.get('video-loop')!.checked = true; f.dispatch(f.root, 'input', f.fields.get('video-loop')!);
  f.fields.get('video-in')!.value = '1'; f.fields.get('video-out')!.value = '4'; f.dispatch(f.root, 'input', f.fields.get('video-in')!);
  let trimmed = videoOf(f.view.draft.draft!);
  assert.deepEqual(trimmed.properties.sourceRange, { inMs: 1000, outMs: 4000 }); assert.equal(trimmed.typeVersion, 3);
  f.fields.get('video-in')!.value = '0'; f.fields.get('video-out')!.value = '8'; f.dispatch(f.root, 'input', f.fields.get('video-in')!);
  trimmed = videoOf(f.view.draft.draft!);
  assert.equal(Object.hasOwn(trimmed.properties, 'sourceRange'), false); assert.equal(trimmed.typeVersion, 3);
  assert.equal(trimmed.properties.loop, true);
});

test('changing a looped source clears inspected metadata and range but retains loop and JSON extensions', () => {
  const original = fixtureSequence(), clip = videoOf(original);
  const looped = validateSequence({ ...original, clips: original.clips.map(candidate => candidate.id === clip.id
    ? { ...candidate, typeVersion: 3, properties: { ...candidate.properties, loop: true, sourceRange: { inMs: 1000, outMs: 4000 } } }
    : candidate) });
  const oldVideo = videoOf(looped);
  const changed = patchInspectedClip(oldVideo, { video: {
    startMs: oldVideo.startMs, entranceMs: 0, sourcePath: 'second.webm', fit: oldVideo.properties.fit,
    volume: oldVideo.properties.volume, muted: oldVideo.properties.muted, loop: true
  } }) as VideoClip;
  assert.equal(changed.typeVersion, 3); assert.equal(changed.properties.loop, true);
  assert.equal(changed.properties.durationMs, undefined); assert.equal(changed.properties.sourceRange, undefined);
  assert.equal((changed as VideoClip & { futureClip: string }).futureClip, 'keep');
  assert.equal((changed.properties as VideoClip['properties'] & { futureProperty: string }).futureProperty, 'keep');
  assert.equal((changed.properties.source as VideoClip['properties']['source'] & { futureSource: string }).futureSource, 'keep');
  assert.equal(videoTypeVersion(changed.properties), 3);
});

test('simple-composition source changes clear stale range metadata and keep loop and sibling extensions', () => {
  const original = fixtureSequence(), clip = videoOf(original);
  const looped = validateSequence({ ...original, clips: original.clips.map(candidate => candidate.id === clip.id
    ? { ...candidate, typeVersion: 3, properties: { ...candidate.properties, loop: true, sourceRange: { inMs: 1000, outMs: 4000 } } }
    : candidate) });
  const bars = looped.clips.find((candidate): candidate is BarsClip => candidate.type === 'bars')!;
  const rebuilt = buildSimpleSequence(looped, ids(), {
    name: looped.name, presentation: looped.presentation, end: looped.end,
    bars: { startMs: bars.startMs, entranceMs: 0, durationMode: 'sequence-end', durationMs: 5000, heightFraction: bars.properties.heightFraction },
    video: {
      startMs: clip.startMs, entranceMs: 0, sourcePath: 'second.webm', fit: clip.properties.fit,
      volume: clip.properties.volume, muted: clip.properties.muted, loop: true
    }
  });
  const changed = videoOf(rebuilt);
  assert.equal(changed.typeVersion, 3); assert.equal(changed.properties.loop, true);
  assert.equal(changed.properties.durationMs, undefined); assert.equal(changed.properties.sourceRange, undefined);
  assert.equal((changed.properties as VideoClip['properties'] & { futureProperty: string }).futureProperty, 'keep');
  assert.equal((changed as VideoClip & { futureClip: string }).futureClip, 'keep');
  assert.equal(rebuilt.clips.find(candidate => candidate.type === 'bars')?.id, bars.id);
  assert.equal((rebuilt.clips.find(candidate => candidate.type === 'bars') as BarsClip & { futureSibling: string }).futureSibling, 'keep');
});

test('video loop control and its tooltip are localized in both editor languages', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const template = readFileSync(`${root}/templates/editor.hbs`, 'utf8');
  const en = JSON.parse(readFileSync(`${root}/lang/en.json`, 'utf8')) as Record<string, string>;
  const de = JSON.parse(readFileSync(`${root}/lang/de.json`, 'utf8')) as Record<string, string>;
  assert.match(template, /name="video-loop"/);
  assert.match(template, /STAGECRAFT\.Editor\.LoopWhileHeldHint/);
  assert.equal(en['STAGECRAFT.Editor.LoopWhileHeld'], 'Loop while held');
  assert.equal(de['STAGECRAFT.Editor.LoopWhileHeld'], 'Während des Halts wiederholen');
  assert.equal(en['STAGECRAFT.Editor.LoopWhileHeldHint'], 'Repeat the video or selected range until the sequence is ended manually.');
  assert.equal(de['STAGECRAFT.Editor.LoopWhileHeldHint'], 'Wiederholt das Video oder den gewählten Quellbereich, bis die Sequenz manuell beendet wird.');
});

test('reselecting the same trimmed source preserves v2 and v3 ranges, loop state, extensions, and the media ending', async t => {
  for (const version of [2, 3] as const) {
    await t.test(`version ${version}`, async t => {
      const original = trimmedSequence(version), video = videoOf(original), f = await editorFixture(t, original, video.properties.source.path);
      f.driver.selectClip(video.id); useProbeDuration(t, 9000);
      await f.driver.chooseVideo();
      const refreshed = f.view.draft.draft!, refreshedVideo = videoOf(refreshed);
      assert.deepEqual(refreshed.end, original.end);
      assert.deepEqual(refreshedVideo.properties.sourceRange, video.properties.sourceRange);
      assert.equal(refreshedVideo.properties.durationMs, 9000); assert.equal(refreshedVideo.typeVersion, version);
      assert.equal(refreshedVideo.properties.loop, version === 3 ? true : undefined);
      assert.equal((refreshedVideo as VideoClip & { futureClip: string }).futureClip, 'keep');
      assert.equal((refreshedVideo.properties as VideoClip['properties'] & { futureProperty: string }).futureProperty, 'keep');
      assert.equal((refreshedVideo.properties.source as VideoClip['properties']['source'] & { futureSource: string }).futureSource, 'keep');
    });
  }
});

test('rechecking the same legacy media path leaves its media ending unchanged', async t => {
  const initial = fixtureSequence(), video = videoOf(initial);
  const original = validateSequence({ ...initial, end: { kind: 'media', clipId: video.id } });
  const f = await editorFixture(t, original, video.properties.source.path);
  f.driver.selectClip(video.id); useProbeDuration(t, 9000);
  await f.driver.chooseVideo();
  assert.deepEqual(f.view.draft.draft!.end, original.end);
  assert.equal(videoOf(f.view.draft.draft!).typeVersion, 1);
  assert.equal(videoOf(f.view.draft.draft!).properties.durationMs, 9000);
  assert.equal(Object.hasOwn(videoOf(f.view.draft.draft!).properties, 'sourceRange'), false);
});

test('a same-path metadata refresh that invalidates the trim leaves the entire draft intact', async t => {
  const original = trimmedSequence(3), video = videoOf(original), f = await editorFixture(t, original, video.properties.source.path);
  f.driver.selectClip(video.id); useProbeDuration(t, 3500);
  await f.driver.chooseVideo();
  assert.deepEqual(f.view.draft.draft, original);
  assert.deepEqual(videoOf(f.view.draft.draft!).properties.sourceRange, { inMs: 1000, outMs: 4000 });
  assert.equal(videoOf(f.view.draft.draft!).properties.loop, true);
  assert.deepEqual(f.view.draft.draft!.end, original.end);
  assert.equal(f.view.draft.dirty, false);
  assert.ok(f.status.textContent.length > 0, 'the rejected metadata refresh is surfaced to the user');
});
