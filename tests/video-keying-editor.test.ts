import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyTimelineCommand } from '../src/application/timeline-commands.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import { videoTypeVersion } from '../src/domain/clip-timing.js';
import { upgradeSequenceToBreaks } from '../src/domain/breaks.js';
import type { BarsClip, SequenceV1, VideoClip, VideoKeying } from '../src/domain/sequence.js';
import { LocalPlayer } from '../src/playback/local-player.js';
import { buildSimpleSequence } from '../src/ui/simple-composition.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';

function ids() { let next = 0; return () => `keying-editor-${++next}`; }

type ExtendedKeying = VideoKeying & { readonly futureKeying: string };
type ExtendedVideoProperties = VideoClip['properties'] & {
  readonly futureProperty: string;
  readonly keying?: VideoKeying & { readonly futureKeying?: string };
};

function fixtureSequence(keying?: ExtendedKeying): SequenceV1 {
  const makeId = ids(); let sequence = createBarsSequence('Keying editor', makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track' }, makeId);
  const videoTrack = sequence.tracks.find(track => track.id !== sequence.tracks[0]!.id)!;
  sequence = applyTimelineCommand(sequence, {
    kind: 'add-clip', type: 'video', trackId: videoTrack.id, startMs: 0,
    sourcePath: 'first.webm', sourceDurationMs: 8000
  }, makeId);
  return validateSequence({ ...sequence, end: { kind: 'manual' }, clips: sequence.clips.map(clip => clip.type === 'video'
    ? {
      ...clip, typeVersion: keying?.enabled ? 4 : 3, appearance: { blendMode: 'screen', opacity: 0.65 }, futureClip: 'keep',
      properties: {
        ...clip.properties, durationMs: 8000, loop: true, sourceRange: { inMs: 1000, outMs: 4000 },
        futureProperty: 'keep', source: { ...clip.properties.source, futureSource: 'keep' },
        ...(keying === undefined ? {} : { keying })
      } as ExtendedVideoProperties
    } as VideoClip
    : { ...clip, futureSibling: 'keep' }) });
}

function dom(t: TestContext) {
  let frameId = 0;
  const frames = new Map<number, () => void>();
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
    document: { createElement: (tag: string) => new Field(tag) },
    requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); }
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  function dispatch(root: Field, type: string, target: Field) {
    const event = new Event(type); Object.defineProperty(event, 'target', { value: target }); root.dispatchEvent(event);
  }
  const advanceFrame = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
  return { Field, dispatch, frames, advanceFrame };
}

async function editorFixture(t: TestContext, sequence = fixtureSequence(), chosenPath: string | null = null) {
  const ui = dom(t), root = new ui.Field(), inspector = new ui.Field(), status = new ui.Field(), makeId = ids();
  const localizations = { contextLostErrors: 0 };
  inspector.dataset.stagecraftInspector = ''; root.append(inspector);
  status.dataset.stagecraftMessage = ''; root.append(status);
  const fields = new Map<string, InstanceType<typeof ui.Field>>();
  const field = (name: string, parent = root, options?: string[], type = 'number') => {
    const node = new ui.Field(options ? 'select' : 'input'); node.name = name; node.type = options ? 'select-one' : type;
    for (const value of options ?? []) { const option = new ui.Field('option'); option.value = value; node.append(option); }
    parent.append(node); fields.set(name, node); return node;
  };
  field('ending', root, ['automatic', 'fixed', 'manual', 'media'], 'select-one'); field('sequence-duration'); field('end-media', root, [], 'select-one'); field('clip-track', root, [], 'select-one');
  const videoPanel = new ui.Field(); videoPanel.dataset.stagecraftElementPanel = 'video'; root.append(videoPanel);
  const animationOptions = ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'];
  const easingOptions = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-in', 'back-out', 'back-in-out'];
  for (const phase of ['entrance', 'exit'] as const) {
    field(`video-${phase}-preset`, videoPanel, animationOptions, 'select-one');
    field(`video-${phase}`, videoPanel);
    field(`video-${phase}-easing`, videoPanel, easingOptions, 'select-one');
    field(`video-${phase}-direction`, videoPanel, ['left', 'right', 'up', 'down'], 'select-one');
    field(`video-${phase}-distance`, videoPanel);
    field(`video-${phase}-scale`, videoPanel);
  }
  for (const [name, type] of [
    ['video-start', 'number'], ['video-in', 'number'], ['video-out', 'number'],
    ['video-path', 'text'], ['video-fit', 'select-one'], ['video-volume', 'number'], ['video-muted', 'checkbox'],
    ['video-loop', 'checkbox'], ['video-keying-enabled', 'checkbox'], ['video-keying-color', 'color'],
    ['video-keying-tolerance', 'number'], ['video-keying-softness', 'number'], ['video-blend-mode', 'select-one'], ['video-opacity', 'number']
  ] as const) {
    field(name, videoPanel, type === 'select-one' ? (name === 'video-fit' ? ['contain', 'cover'] : ['normal']) : undefined, type);
  }
  const barsPanel = new ui.Field(); barsPanel.dataset.stagecraftElementPanel = 'bars'; root.append(barsPanel);
  const actions = new Map<string, InstanceType<typeof ui.Field>>();
  for (const name of ['undo', 'redo', 'duplicate-clip']) {
    const button = new ui.Field('button'); button.dataset.stagecraftAction = name; root.append(button); actions.set(name, button);
  }
  const services: EditorServices = {
    makeId, repository: { list: async () => [sequence], read: async () => sequence, save: async value => value, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }),
    localize: key => { if (key === 'STAGECRAFT.Error.VIDEO_KEYING_CONTEXT_LOST') localizations.contextLostErrors++; return key; },
    confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {}, prepareGroup: async () => {}, openSession() {},
    groupActive: () => false, chooseVideo: async () => chosenPath, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services); await view.mount(root as unknown as HTMLElement); t.after(() => view.detach());
  const driver = view as unknown as { selectClip(id: string): void; chooseVideo(): Promise<void> };
  const setChosenPath = (value: string | null) => { chosenPath = value; services.chooseVideo = async () => chosenPath; };
  const action = async (name: 'undo' | 'redo' | 'duplicate-clip') => {
    ui.dispatch(root, 'click', actions.get(name)!); await Promise.resolve();
  };
  return { ...ui, root, fields, sequence, status, view, driver, setChosenPath, action, localizations };
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

function dispatchInput(f: Awaited<ReturnType<typeof editorFixture>>, name: string) {
  f.dispatch(f.root, 'input', f.fields.get(name)!);
}

test('video Fade choice edits the existing entrance and None/Undo preserve the media settings', async t => {
  const f = await editorFixture(t), video = videoOf(f.sequence);
  f.driver.selectClip(video.id);
  const original = f.view.draft.draft!;
  f.fields.get('video-entrance-preset')!.value = 'none';
  f.dispatch(f.root, 'change', f.fields.get('video-entrance-preset')!);
  assert.equal(videoOf(f.view.draft.draft!).entrance.preset, 'none');
  f.fields.get('video-entrance-preset')!.value = 'fade';
  f.dispatch(f.root, 'change', f.fields.get('video-entrance-preset')!);
  const entrance = videoOf(f.view.draft.draft!).entrance;
  assert.equal(entrance.preset, 'fade');
  assert.equal(entrance.durationMs, 800);
  assert.deepEqual(videoOf(f.view.draft.draft!).properties, video.properties);
  assert.deepEqual(videoOf(f.view.draft.draft!).exit, video.exit);
  f.view.draft.undo(); assert.equal(videoOf(f.view.draft.draft!).entrance.preset, 'none');
  f.view.draft.undo(); assert.deepEqual(f.view.draft.draft, original);
});

test('video entrance Slide and exit Zoom persist version 7, phase fields and independent undo steps', async t => {
  const initialSequence = upgradeSequenceToBreaks(fixtureSequence());
  const authored = validateSequence({ ...initialSequence, clips: initialSequence.clips.map(clip => clip.type === 'video' ? {
    ...clip, typeVersion: 6,
    entrance: { ...clip.entrance, futureTransitionField: 'keep-entrance' },
    exit: { ...clip.exit, futureTransitionField: 'keep-exit' },
    properties: { ...clip.properties, onBreak: 'loop' as const,
      keying: { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.05, futureKeying: 'keep' },
      futureProperty: 'keep' }
  } as unknown as VideoClip : clip) });
  const f = await editorFixture(t, authored), video = videoOf(authored);
  f.driver.selectClip(video.id);
  const original = structuredClone(f.view.draft.draft!);

  f.fields.get('video-entrance')!.value = '0.6';
  f.fields.get('video-entrance-easing')!.value = 'ease-out';
  f.fields.get('video-entrance-direction')!.value = 'left';
  f.fields.get('video-entrance-distance')!.value = '220';
  f.fields.get('video-entrance-preset')!.value = 'fade-slide';
  f.dispatch(f.root, 'change', f.fields.get('video-entrance-preset')!);
  let edited = videoOf(f.view.draft.draft!);
  assert.equal(edited.typeVersion, 7);
  assert.equal(edited.entrance.preset, 'fade-slide');
  assert.equal(edited.entrance.durationMs, 600);
  assert.equal(edited.entrance.easing, 'ease-out');
  assert.equal(edited.entrance.direction, 'left');
  assert.equal(edited.entrance.distance, 220);
  assert.equal((edited.entrance as VideoClip['entrance'] & { futureTransitionField: string }).futureTransitionField, 'keep-entrance');
  assert.deepEqual(edited.properties, video.properties);

  const entrance = edited.entrance;
  f.fields.get('video-exit')!.value = '0.45';
  f.fields.get('video-exit-easing')!.value = 'back-in';
  f.fields.get('video-exit-scale')!.value = '135';
  f.fields.get('video-exit-preset')!.value = 'fade-zoom';
  f.dispatch(f.root, 'change', f.fields.get('video-exit-preset')!);
  edited = videoOf(f.view.draft.draft!);
  assert.equal(edited.exit.preset, 'fade-zoom');
  assert.equal(edited.exit.durationMs, 450);
  assert.equal(edited.exit.easing, 'back-in');
  assert.equal(edited.exit.scale, 1.35);
  assert.equal((edited.exit as VideoClip['exit'] & { futureTransitionField: string }).futureTransitionField, 'keep-exit');
  assert.deepEqual(edited.entrance, entrance);
  assert.deepEqual(edited.properties, video.properties, 'keying, break policy, source trim and property extensions survive');

  f.view.draft.undo();
  assert.equal(videoOf(f.view.draft.draft!).exit.preset, 'none');
  assert.equal(videoOf(f.view.draft.draft!).entrance.preset, 'fade-slide');
  f.view.draft.undo();
  assert.deepEqual(f.view.draft.draft, original);
});

test('legacy video keying defaults stay unpersisted until enabled and active keying participates in undo and redo', async t => {
  const original = fixtureSequence(), sourceVideo = videoOf(original), f = await editorFixture(t, original);
  f.driver.selectClip(sourceVideo.id);
  assert.equal(f.fields.get('video-keying-enabled')!.checked, false);
  assert.equal(f.fields.get('video-keying-color')!.value, '#00ff00');
  assert.equal(f.fields.get('video-keying-tolerance')!.value, '10');
  assert.equal(f.fields.get('video-keying-softness')!.value, '5');
  assert.equal(f.fields.get('video-keying-color')!.disabled, true);

  f.fields.get('video-volume')!.value = '0.5'; dispatchInput(f, 'video-volume');
  let video = videoOf(f.view.draft.draft!);
  assert.equal(Object.hasOwn(video.properties, 'keying'), false);
  assert.equal(video.typeVersion, 3); assert.equal(video.properties.loop, true);
  assert.deepEqual(video.properties.sourceRange, { inMs: 1000, outMs: 4000 });
  assert.deepEqual(video.appearance, sourceVideo.appearance);

  f.fields.get('video-keying-enabled')!.checked = true; dispatchInput(f, 'video-keying-enabled');
  const enabled = f.view.draft.draft!; video = videoOf(enabled);
  assert.deepEqual(video.properties.keying, { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.05 });
  assert.equal(video.typeVersion, 4); assert.equal(video.properties.loop, true);
  assert.deepEqual(video.properties.sourceRange, { inMs: 1000, outMs: 4000 });
  assert.deepEqual(video.appearance, sourceVideo.appearance);
  assert.equal((video as VideoClip & { futureClip: string }).futureClip, 'keep');
  assert.equal((video.properties as ExtendedVideoProperties).futureProperty, 'keep');
  assert.equal((video.properties.keying as ExtendedKeying).futureKeying, undefined);
  assert.equal((video.properties.source as VideoClip['properties']['source'] & { futureSource: string }).futureSource, 'keep');
  assert.equal(f.fields.get('video-keying-color')!.disabled, false);

  const bars = enabled.clips.find((clip): clip is BarsClip => clip.type === 'bars')!;
  f.driver.selectClip(bars.id);
  assert.equal(f.fields.get('video-keying-color')!.disabled, true);
  f.driver.selectClip(sourceVideo.id);
  assert.equal(f.fields.get('video-keying-color')!.disabled, false);

  await f.action('undo');
  video = videoOf(f.view.draft.draft!);
  assert.equal(Object.hasOwn(video.properties, 'keying'), false);
  assert.equal(video.typeVersion, 3);
  await f.action('redo');
  assert.deepEqual(videoOf(f.view.draft.draft!).properties.keying, { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.05 });
  assert.equal(videoOf(f.view.draft.draft!).typeVersion, 4);
});

test('editing, disabling, re-enabling and undoing keying preserves its values and extensions', async t => {
  const keying: ExtendedKeying = { enabled: true, color: '#12ab34', tolerance: 0.23, softness: 0.4, futureKeying: 'keep' };
  const original = fixtureSequence(keying), video = videoOf(original), f = await editorFixture(t, original);
  f.driver.selectClip(video.id);
  assert.equal(f.fields.get('video-keying-tolerance')!.value, '23');
  assert.equal(f.fields.get('video-keying-softness')!.value, '40');

  const stills: SequenceV1[] = [];
  (f.view as unknown as { drawStill(sequence?: SequenceV1): void }).drawStill = sequence => { if (sequence) stills.push(sequence); };
  f.fields.get('video-keying-color')!.value = '#fedcba'; dispatchInput(f, 'video-keying-color');
  assert.equal(videoOf(f.view.draft.draft!).properties.keying!.color, keying.color, 'native input remains a transient preview');
  assert.equal(f.frames.size, 1); f.advanceFrame();
  assert.deepEqual(videoOf(stills[0]!).properties.keying, { ...keying, color: '#fedcba' }, 'live preview preserves video keying extensions');
  f.dispatch(f.root, 'change', f.fields.get('video-keying-color')!);
  assert.deepEqual(videoOf(f.view.draft.draft!).properties.keying, { ...keying, color: '#fedcba' });
  assert.equal(f.frames.size, 0);
  f.fields.get('video-keying-tolerance')!.value = '37.5'; dispatchInput(f, 'video-keying-tolerance');
  f.fields.get('video-keying-softness')!.value = '8.5'; dispatchInput(f, 'video-keying-softness');
  const edited = videoOf(f.view.draft.draft!);
  assert.deepEqual(edited.properties.keying, { enabled: true, color: '#fedcba', tolerance: 0.375, softness: 0.085, futureKeying: 'keep' });
  assert.equal(edited.typeVersion, 4);

  f.fields.get('video-keying-enabled')!.checked = false; dispatchInput(f, 'video-keying-enabled');
  const disabled = videoOf(f.view.draft.draft!);
  assert.deepEqual(disabled.properties.keying, { enabled: false, color: '#fedcba', tolerance: 0.375, softness: 0.085, futureKeying: 'keep' });
  assert.equal(disabled.typeVersion, 3);
  assert.equal(f.fields.get('video-keying-color')!.disabled, true);

  await f.action('undo');
  assert.deepEqual(videoOf(f.view.draft.draft!).properties.keying, edited.properties.keying);
  assert.equal(videoOf(f.view.draft.draft!).typeVersion, 4);
  await f.action('redo');
  assert.deepEqual(videoOf(f.view.draft.draft!).properties.keying, disabled.properties.keying);
  assert.equal(videoOf(f.view.draft.draft!).typeVersion, 3);

  f.fields.get('video-keying-enabled')!.checked = true; dispatchInput(f, 'video-keying-enabled');
  const reenabled = videoOf(f.view.draft.draft!);
  assert.deepEqual(reenabled.properties.keying, { enabled: true, color: '#fedcba', tolerance: 0.375, softness: 0.085, futureKeying: 'keep' });
  assert.equal(reenabled.typeVersion, 4);
});

test('same-path metadata, source changes, trims and clip duplication keep keying with video settings', async t => {
  const keying: ExtendedKeying = { enabled: true, color: '#0088ff', tolerance: 0.17, softness: 0.03, futureKeying: 'keep' };
  const original = fixtureSequence(keying), sourceVideo = videoOf(original), f = await editorFixture(t, original, sourceVideo.properties.source.path);
  f.driver.selectClip(sourceVideo.id); useProbeDuration(t, 9000);
  await f.driver.chooseVideo();
  let video = videoOf(f.view.draft.draft!);
  assert.equal(video.typeVersion, 4); assert.equal(video.properties.durationMs, 9000);
  assert.deepEqual(video.properties.sourceRange, sourceVideo.properties.sourceRange);
  assert.equal(video.properties.loop, true); assert.deepEqual(video.appearance, sourceVideo.appearance);
  assert.deepEqual(video.properties.keying, keying);

  f.setChosenPath('second.webm'); await f.driver.chooseVideo();
  video = videoOf(f.view.draft.draft!);
  assert.equal(video.properties.source.path, 'second.webm'); assert.equal(video.properties.durationMs, 9000);
  assert.equal(Object.hasOwn(video.properties, 'sourceRange'), false);
  assert.equal(video.typeVersion, 4); assert.equal(video.properties.loop, true);
  assert.deepEqual(video.properties.keying, keying); assert.deepEqual(video.appearance, sourceVideo.appearance);

  f.fields.get('video-in')!.value = '2'; f.fields.get('video-out')!.value = '6'; dispatchInput(f, 'video-in');
  video = videoOf(f.view.draft.draft!);
  assert.deepEqual(video.properties.sourceRange, { inMs: 2000, outMs: 6000 });
  assert.equal(video.typeVersion, 4); assert.equal(video.properties.loop, true);
  assert.deepEqual(video.properties.keying, keying); assert.deepEqual(video.appearance, sourceVideo.appearance);

  await f.action('duplicate-clip');
  const clips = f.view.draft.draft!.clips.filter((clip): clip is VideoClip => clip.type === 'video');
  assert.equal(clips.length, 2);
  const duplicate = clips.find(clip => clip.id !== sourceVideo.id)!;
  assert.deepEqual(duplicate.properties.keying, keying); assert.equal(duplicate.typeVersion, 4);
  assert.deepEqual(duplicate.properties.sourceRange, { inMs: 2000, outMs: 6000 });
  assert.equal(duplicate.properties.loop, true); assert.deepEqual(duplicate.appearance, sourceVideo.appearance);
  assert.equal((duplicate.properties as ExtendedVideoProperties).futureProperty, 'keep');
  assert.equal((duplicate as VideoClip & { futureClip: string }).futureClip, 'keep');

  await f.action('undo');
  assert.equal(f.view.draft.draft!.clips.filter(clip => clip.type === 'video').length, 1);
  await f.action('redo');
  const restored = f.view.draft.draft!.clips.find((clip): clip is VideoClip => clip.type === 'video' && clip.id !== sourceVideo.id)!;
  assert.deepEqual(restored.properties.keying, keying); assert.deepEqual(restored.properties.sourceRange, { inMs: 2000, outMs: 6000 });
});

test('simple-composition path changes retain keying and extensions while clearing only stale media metadata', () => {
  const keying: ExtendedKeying = { enabled: true, color: '#0088ff', tolerance: 0.17, softness: 0.03, futureKeying: 'keep' };
  const original = fixtureSequence(keying), video = videoOf(original);
  const bars = original.clips.find((clip): clip is BarsClip => clip.type === 'bars')!;
  const rebuilt = buildSimpleSequence(original, ids(), {
    name: original.name, presentation: original.presentation, end: original.end,
    bars: {
      startMs: bars.startMs, entranceMs: 0,
      durationMode: bars.duration.kind === 'fixed' ? 'fixed' : 'sequence-end',
      durationMs: bars.duration.kind === 'fixed' ? bars.duration.milliseconds : 5000,
      heightFraction: bars.properties.heightFraction, ...(bars.appearance === undefined ? {} : { appearance: bars.appearance })
    },
    video: {
      startMs: video.startMs, entranceMs: 0, sourcePath: 'next.webm', fit: video.properties.fit,
      volume: video.properties.volume, muted: video.properties.muted, loop: true,
      ...(video.appearance === undefined ? {} : { appearance: video.appearance })
    }
  });
  const updated = videoOf(rebuilt);
  assert.equal(updated.typeVersion, 4); assert.equal(updated.properties.loop, true);
  assert.equal(updated.properties.source.path, 'next.webm');
  assert.equal(updated.properties.durationMs, undefined); assert.equal(Object.hasOwn(updated.properties, 'sourceRange'), false);
  assert.deepEqual(updated.properties.keying, keying); assert.deepEqual(updated.appearance, video.appearance);
  assert.equal((updated.properties as ExtendedVideoProperties).futureProperty, 'keep');
  assert.equal((updated.properties.keying as ExtendedKeying).futureKeying, 'keep');
});

test('still-preview renderer errors dispose the failed surface and a keying edit recreates it once', async t => {
  const keying: ExtendedKeying = { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.05, futureKeying: 'keep' };
  const original = fixtureSequence(keying), video = videoOf(original), f = await editorFixture(t, original);
  f.driver.selectClip(video.id);
  const viewer = new f.Field(); viewer.dataset.stagecraftViewer = ''; f.root.append(viewer);

  type SurfaceOptions = { onError?: (error: unknown) => void };
  type StubSurface = {
    signal: AbortSignal | null;
    disposed: boolean;
    attached: boolean;
    resourcesCancelled: boolean;
    frames: string[];
    prepare(plan: unknown, signal: AbortSignal): Promise<void>;
    updateStill(plan: unknown): Promise<void>;
    render(frame: { phase: string }): void;
    dispose(): void;
  };
  type Driver = {
    staticPreview: unknown;
    staticAbort: AbortController | null;
    staticPrepared: boolean;
    staticSourceKey: string | null;
    staticQueue: Promise<void>;
    createStillSurface(options: SurfaceOptions): unknown;
    drawStill(): void;
  };
  const driver = f.view as unknown as Driver;
  let failNextUpdate = false;
  const surfaces: StubSurface[] = [];
  const surfaceErrors: Array<(error: unknown) => void> = [];
  driver.createStillSurface = options => {
    if (options.onError) surfaceErrors.push(options.onError);
    const surface: StubSurface = {
      signal: null, disposed: false, attached: false, resourcesCancelled: false, frames: [],
      prepare: async (_plan, signal) => {
        surface.signal = signal;
        signal.addEventListener('abort', () => { surface.resourcesCancelled = true; }, { once: true });
      },
      updateStill: async () => {
        await Promise.resolve();
        if (failNextUpdate) {
          failNextUpdate = false;
          const error = new Error('VIDEO_KEYING_CONTEXT_LOST');
          options.onError?.(error);
          throw error;
        }
      },
      render: frame => { surface.attached = true; surface.frames.push(frame.phase); },
      dispose: () => {
        if (surface.disposed) return;
        surface.disposed = true;
        surface.attached = false;
        surface.resourcesCancelled = true;
      }
    };
    surfaces.push(surface);
    return surface;
  };

  driver.drawStill();
  await Promise.resolve(); await driver.staticQueue;
  assert.equal(surfaces.length, 1);
  assert.deepEqual(surfaces[0]!.frames, ['paused'], 'the still surface rendered the paused editor frame');

  failNextUpdate = true;
  f.fields.get('video-volume')!.value = '0.7'; dispatchInput(f, 'video-volume');
  const failedWorker = driver.staticQueue;
  await failedWorker;
  assert.equal(surfaces[0]!.disposed, true);
  assert.equal(surfaces[0]!.attached, false);
  assert.equal(surfaces[0]!.signal?.aborted, true);
  assert.equal(surfaces[0]!.resourcesCancelled, true);
  assert.equal(driver.staticPreview, null); assert.equal(driver.staticAbort, null);
  assert.equal(driver.staticPrepared, false); assert.equal(driver.staticSourceKey, null);
  assert.equal(f.localizations.contextLostErrors, 1, 'the renderer error is reported once');
  assert.equal(surfaces.length, 1, 'an error does not trigger an automatic retry loop');

  f.fields.get('video-keying-enabled')!.checked = false; dispatchInput(f, 'video-keying-enabled');
  await Promise.resolve(); await driver.staticQueue;
  assert.equal(videoOf(f.view.draft.draft!).properties.keying?.enabled, false);
  assert.equal(videoOf(f.view.draft.draft!).typeVersion, 3);
  assert.equal(surfaces.length, 2, 'the next edit creates a fresh still surface');
  assert.equal(surfaces[1]!.disposed, false); assert.equal(surfaces[1]!.attached, true);
  assert.equal(surfaces[1]!.signal?.aborted, false);
  assert.deepEqual(surfaces[1]!.frames, ['paused']);

  // A late callback from the failed renderer cannot clear or report against its replacement.
  surfaceErrors[0]!(new Error('VIDEO_KEYING_CONTEXT_LOST'));
  assert.equal(driver.staticPreview, surfaces[1]);
  assert.equal(f.localizations.contextLostErrors, 1);
});

test('keying controls and labels are present in both editor languages', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const template = readFileSync(`${root}/templates/editor.hbs`, 'utf8');
  const en = JSON.parse(readFileSync(`${root}/lang/en.json`, 'utf8')) as Record<string, string>;
  const de = JSON.parse(readFileSync(`${root}/lang/de.json`, 'utf8')) as Record<string, string>;
  assert.match(template, /name="video-keying-enabled"/);
  assert.match(template, /name="video-keying-color"/);
  assert.match(template, /name="video-keying-tolerance"/);
  assert.match(template, /name="video-keying-softness"/);
  assert.equal(en['STAGECRAFT.Editor.Keying'], 'Keying');
  assert.equal(en['STAGECRAFT.Editor.KeyingTolerance'], 'Tolerance (%)');
  assert.equal(en['STAGECRAFT.Editor.KeyingSoftness'], 'Edge softness (%)');
  assert.equal(de['STAGECRAFT.Editor.Keying'], 'Chroma-Key');
  assert.equal(de['STAGECRAFT.Editor.KeyingTolerance'], 'Toleranz (%)');
  assert.equal(de['STAGECRAFT.Editor.KeyingSoftness'], 'Kantenweichheit (%)');
  for (const code of ['VIDEO_BACKDROP_UNAVAILABLE', 'VIDEO_KEYING_UNAVAILABLE', 'VIDEO_KEYING_FAILED', 'VIDEO_KEYING_CONTEXT_LOST']) {
    assert.ok(en[`STAGECRAFT.Error.${code}`]); assert.ok(de[`STAGECRAFT.Error.${code}`]);
  }
  assert.equal(videoTypeVersion({ keying: { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.05 } }), 4);
});
