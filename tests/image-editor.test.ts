import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { applyTimelineCommand, timelineConflicts } from '../src/application/timeline-commands.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import type { ButtonClip, ImageClip, ImagePoint, SequenceV1, SolidClip, VideoClip, TextClip } from '../src/domain/sequence.js';
import { LocalPlayer } from '../src/playback/local-player.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { buildSimpleSequence, simpleClip, simpleTimingConflicts } from '../src/ui/simple-composition.js';
import { TimelineClipboard } from '../src/application/timeline-clipboard.js';
import type { TimelineContextTarget } from '../src/ui/timeline-view.js';
import type { TimelineContextMenuItem } from '../src/ui/timeline-context-menu.js';
import { ANIMATED_PATTERN_PRESET_IDS, ANIMATED_PATTERN_PRESETS, POLYGON_PRESET_IDS, createAnimatedPattern } from '../src/domain/animated-pattern.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';

function ids(prefix = 'image-editor') { let next = 0; return () => `${prefix}-${++next}`; }

function fixtureSequence(path: string | null = 'portraits/first.png'): SequenceV1 {
  const makeId = ids();
  let sequence = createBarsSequence('Image editor', makeId);
  if (path) {
    sequence = applyTimelineCommand(sequence, { kind: 'add-track' }, makeId);
    const imageTrack = sequence.tracks[1]!;
    sequence = applyTimelineCommand(sequence, {
      kind: 'add-clip', type: 'image', trackId: imageTrack.id, startMs: 0, sourcePath: path
    }, makeId);
  }
  return validateSequence({ ...sequence, end: { kind: 'manual' } });
}

class FakeField extends EventTarget {
  readonly children: FakeField[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  name = ''; value = ''; checked = false; hidden = false; disabled = false; max = '604800'; min = ''; step = 'any'; readOnly = false;
  className = ''; type = ''; textContent = ''; title = ''; id = ''; tabIndex = 0; scrollTop = 0;
  parent: FakeField | null = null;
  private readonly pointers = new Set<number>();
  classList = { toggle() {}, add() {}, remove() {} };
  constructor(readonly tag = 'div') { super(); }
  get options() { return this.children; }
  get parentElement() { return this.parent; }
  get ownerDocument() { return document; }
  append(...children: FakeField[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children: FakeField[]) { this.children.length = 0; this.append(...children); }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  setPointerCapture(id: number) { this.pointers.add(id); }
  hasPointerCapture(id: number) { return this.pointers.has(id); }
  releasePointerCapture(id: number) { this.pointers.delete(id); }
  focus() { (document as unknown as { activeElement: FakeField }).activeElement = this; }
  getBoundingClientRect() { return { left: 180, top: 0, right: 1180, bottom: 56, width: 1000, height: 56 }; }
  select() {}
  checkValidity() {
    if (this.type !== 'number' || this.value === '') return true;
    const value = Number(this.value);
    return (!this.min || value >= Number(this.min)) && (!this.max || value <= Number(this.max));
  }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector === '[name]') return !!this.name;
    if (selector === 'input[type="number"]') return this.tag === 'input' && this.type === 'number';
    if (selector === 'button[data-stagecraft-action]') return this.tag === 'button' && 'stagecraftAction' in this.dataset;
    const tag = selector.match(/^([a-z]+)?(\[.+\])$/i);
    if (tag?.[1] && tag[1].toLowerCase() !== this.tag.toLowerCase()) return false;
    const attribute = tag?.[2] ?? selector;
    const name = attribute.match(/^\[name="([^"]+)"\]$/); if (name) return this.name === name[1];
    const data = attribute.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/);
    if (data) {
      const key = data[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return key in this.dataset && (data[2] === undefined || this.dataset[key] === data[2]);
    }
    if (attribute.startsWith('.')) return this.className.split(/\s+/).includes(attribute.slice(1));
    return false;
  }
  querySelectorAll<T>(selector: string): T[] {
    if (selector === '[data-stagecraft-inspector] input[type="number"]') {
      return this.querySelectorAll<FakeField>('[data-stagecraft-inspector]').flatMap(panel => panel.querySelectorAll<T>('input[type="number"]'));
    }
    return this.children.flatMap(child => [...(child.matches(selector) ? [child as unknown as T] : []), ...child.querySelectorAll<T>(selector)]);
  }
  querySelector<T>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  closest<T>(selector: string): T | null { return this.matches(selector) ? this as unknown as T : this.parent?.closest<T>(selector) ?? null; }
}

function setupDom(t: TestContext) {
  const globals: Record<string, unknown> = {
    Element: FakeField, HTMLElement: FakeField, HTMLInputElement: FakeField, HTMLSelectElement: FakeField, HTMLTextAreaElement: FakeField,
    document: Object.assign(new EventTarget(), { activeElement: null, createElement: (tag: string) => new FakeField(tag) })
  };
  const original = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, value] of original) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } });
  const dispatch = (root: FakeField, type: string, target: FakeField, properties: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ target, button: 0, pointerId: 1, clientX: 0,
      clientY: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...properties }).map(([key, value]) => [key, { value }])));
    if (type.startsWith('pointer')) document.dispatchEvent(event);
    root.dispatchEvent(event);
    return event;
  };
  return { dispatch };
}

async function editorFixture(t: TestContext, sequence = fixtureSequence(), chooseImage: EditorServices['chooseImage'] = async () => null, numericInputs = false, compactSections = false, withTimeline = false) {
  const shapeType = sequence.clips.some(clip => clip.type === 'solid') ? 'solid' : 'image';
  const ui = setupDom(t), root = new FakeField(), inspector = new FakeField(), library = new FakeField(), status = new FakeField();
  inspector.dataset.stagecraftInspector = ''; root.append(inspector);
  library.dataset.stagecraftLibrary = ''; root.append(library);
  status.dataset.stagecraftMessage = ''; root.append(status);
  const clipTab = new FakeField('button'); clipTab.dataset.stagecraftInspectorTab = 'clip'; root.append(clipTab);
  const sequenceTab = new FakeField('button'); sequenceTab.dataset.stagecraftInspectorTab = 'sequence'; root.append(sequenceTab);
  const clipPage = new FakeField(); clipPage.dataset.stagecraftInspectorPage = 'clip'; (compactSections ? inspector : root).append(clipPage);
  const sequencePage = new FakeField(); sequencePage.dataset.stagecraftInspectorPage = 'sequence'; root.append(sequencePage);
  const fields = new Map<string, FakeField>();
  const storedField = fields.get.bind(fields);
  fields.get = name => root.querySelector<FakeField>(`[name="${name}"]`) ?? storedField(name);
  const sectionToolbar = new FakeField(); sectionToolbar.dataset.stagecraftClipSectionTabs = '';
  const sectionTabs = new Map<string, FakeField>(), sectionPages = new Map<string, FakeField>();
  if (compactSections) {
    root.append(sectionToolbar);
    for (const category of ['content', 'animation', 'timing']) {
      const tab = new FakeField('button'); tab.dataset.stagecraftClipSectionTab = category;
      sectionToolbar.append(tab); sectionTabs.set(category, tab);
    }
  }
  const sections = (parent: FakeField, type: string) => {
    if (!compactSections) return;
    for (const category of type === 'break' ? ['timing'] : ['content', 'animation', 'timing']) {
      const page = new FakeField(); page.dataset.stagecraftClipSectionPage = category; page.id = `stagecraft-clip-${type}-${category}`;
      parent.append(page); sectionPages.set(`${type}-${category}`, page);
    }
  };
  const sharedTiming = new FakeField();
  if (compactSections) {
    sharedTiming.dataset.stagecraftClipSectionPage = 'timing'; sharedTiming.dataset.stagecraftClipSectionShared = '';
    sharedTiming.id = 'stagecraft-clip-shared-timing'; clipPage.append(sharedTiming); sectionPages.set('shared-timing', sharedTiming);
    const breakPanel = new FakeField(); breakPanel.dataset.stagecraftBreakPanel = ''; clipPage.append(breakPanel); sections(breakPanel, 'break');
  }
  const field = (name: string, parent = root, options?: string[], type = 'number') => {
    const node = new FakeField(options ? 'select' : 'input'); node.name = name; node.type = options ? 'select-one' : type;
    if (/^(image|solid)-(crop|mask)-/.test(name)) { node.min = '0'; node.max = '100'; }
    for (const value of options ?? []) { const option = new FakeField('option'); option.value = value; node.append(option); }
    parent.append(node); fields.set(name, node); return node;
  };
  field('ending', root, ['automatic', 'fixed', 'manual', 'media'], 'select-one').value = 'manual';
  field('sequence-duration'); field('end-media', root, [], 'select-one'); field('clip-track', compactSections ? sharedTiming : root, [], 'select-one');
  if (compactSections) field('break-position', sectionPages.get('break-timing')!);
  const barsPanel = new FakeField(); barsPanel.dataset.stagecraftElementPanel = 'bars'; (compactSections ? clipPage : root).append(barsPanel); sections(barsPanel, 'bars');
  const imagePanel = new FakeField(); imagePanel.dataset.stagecraftElementPanel = shapeType; (compactSections ? clipPage : numericInputs ? inspector : root).append(imagePanel); sections(imagePanel, shapeType);
  const buttonPanel = new FakeField(); buttonPanel.dataset.stagecraftElementPanel = 'button'; (compactSections ? clipPage : numericInputs ? inspector : root).append(buttonPanel); sections(buttonPanel, 'button');
  const pointList = new FakeField(); pointList.dataset.stagecraftSolidPointList = ''; pointList.dataset.pointCount = '4';
  if (shapeType === 'solid') (compactSections ? sectionPages.get('solid-content')! : imagePanel).append(pointList);
  const alphaDependent = new FakeField(); alphaDependent.dataset.stagecraftSolidAlphaDependent = '';
  if (shapeType === 'solid') (compactSections ? sectionPages.get('solid-content')! : imagePanel).append(alphaDependent);
  const add = (name: string, options?: string[], type = 'number') => {
    const category = name.startsWith('image-entrance') || name.startsWith('image-exit') ? 'animation'
      : ['image-start', 'image-duration-mode', 'image-duration'].includes(name) ? 'timing' : 'content';
    const parent = shapeType === 'solid' && name.startsWith('image-mask-') ? pointList
      : shapeType === 'solid' && (name === 'image-fit' || name.startsWith('image-crop-'))
      ? alphaDependent : compactSections ? sectionPages.get(`${shapeType}-${category}`)! : imagePanel;
    return field(name.replace(/^image-/, shapeType + '-'), parent, options, type);
  };
  add('image-path', undefined, 'text'); add('image-start'); add('image-duration-mode', ['fixed', 'sequence-end'], 'select-one'); add('image-duration');
  if (shapeType === 'solid') { field('solid-alpha-path', compactSections ? sectionPages.get('solid-content')! : imagePanel, undefined, 'text'); field('solid-color', compactSections ? sectionPages.get('solid-content')! : imagePanel, undefined, 'color'); }
  if (shapeType === 'solid') {
    const content = compactSections ? sectionPages.get('solid-content')! : imagePanel;
    const group = new FakeField(); group.dataset.stagecraftPatternSettings = ''; content.append(group);
    field('solid-pattern-preset', group, [...ANIMATED_PATTERN_PRESET_IDS], 'select-one');
    for (let index = 0; index < 3; index++) field(`solid-pattern-color-${index}`, group, undefined, 'color');
    for (const [name, min, max] of [['speed', 0, 4], ['scale', 0.25, 4], ['density', 0.2, 3], ['direction', 0, 360], ['intensity', 0, 1]] as const) {
      const control = field('solid-pattern-' + name, group); control.min = String(min); control.max = String(max);
    }
    field('solid-pattern-reverse', group, undefined, 'checkbox');
    field('solid-pattern-onBreak', group, ['loop', 'pause'], 'select-one');
    field('solid-polygon-preset', content, ['custom', ...POLYGON_PRESET_IDS], 'select-one');
  }
  add('image-entrance-preset', ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'], 'select-one'); add('image-entrance');
  add('image-entrance-easing', ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-in', 'back-out', 'back-in-out'], 'select-one');
  add('image-entrance-direction', ['left', 'right', 'up', 'down'], 'select-one'); add('image-entrance-distance'); add('image-entrance-scale');
  add('image-exit-preset', ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'], 'select-one'); add('image-exit');
  add('image-exit-easing', ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-in', 'back-out', 'back-in-out'], 'select-one');
  add('image-exit-direction', ['left', 'right', 'up', 'down'], 'select-one'); add('image-exit-distance'); add('image-exit-scale');
  add('image-fit', ['contain', 'cover'], 'select-one'); add('image-x'); add('image-y'); add('image-width'); add('image-height');
  add('image-crop-x'); add('image-crop-y'); add('image-crop-width'); add('image-crop-height');
  for (let index = 0; index < 4; index++) { add(`image-mask-${index}-x`); add(`image-mask-${index}-y`); }
  add('image-blend-mode', ['normal', 'multiply', 'screen', 'plus-lighter', 'overlay', 'difference'], 'select-one'); add('image-opacity');
  for (const [prefix, names] of [
    ['outline', ['enabled', 'color', 'opacity', 'width']],
    ['shadow', ['enabled', 'color', 'opacity', 'offset-x', 'offset-y', 'blur']],
    ['glow', ['enabled', 'color', 'opacity', 'radius']]
  ] as const) for (const suffix of names) add(`image-${prefix}-${suffix}`, undefined, suffix === 'enabled' ? 'checkbox' : suffix === 'color' ? 'color' : 'number');
  const buttonField = (name: string, options?: string[], type = 'number', group = 'content') => {
    const parent = compactSections ? sectionPages.get(`button-${group}`)! : buttonPanel;
    return field(name, parent, options, type);
  };
  buttonField('button-label', undefined, 'text');
  buttonField('button-design', [], 'select-one');
  buttonField('button-action', ['continue', 'choice'], 'select-one');
  const buttonChoice = new FakeField(); buttonChoice.dataset.stagecraftButtonChoice = ''; (compactSections ? sectionPages.get('button-content')! : buttonPanel).append(buttonChoice);
  field('button-decision-group', buttonChoice, [], 'select-one');
  field('button-decision-name', buttonChoice, undefined, 'text');
  field('button-message', buttonChoice, undefined, 'text');
  field('button-visibility', buttonChoice, ['gm', 'public'], 'select-one');
  for (const name of ['button-start', 'button-duration']) buttonField(name);
  buttonField('button-duration-mode', ['fixed', 'sequence-end'], 'select-one', 'timing');
  for (const phase of ['entrance', 'exit']) {
    buttonField(`button-${phase}-preset`, ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'], 'select-one', 'animation');
    buttonField(`button-${phase}`, undefined, 'number', 'animation');
    buttonField(`button-${phase}-easing`, ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-in', 'back-out', 'back-in-out'], 'select-one', 'animation');
    buttonField(`button-${phase}-direction`, ['left', 'right', 'up', 'down'], 'select-one', 'animation');
    buttonField(`button-${phase}-distance`, undefined, 'number', 'animation');
    buttonField(`button-${phase}-scale`, undefined, 'number', 'animation');
  }
  buttonField('button-shape', ['rectangle', 'rounded', 'pill', 'bevel', 'hexagon'], 'select-one');
  buttonField('button-blend-mode', ['normal', 'multiply', 'screen', 'plus-lighter', 'overlay', 'difference'], 'select-one');
  buttonField('button-opacity'); buttonField('button-background', undefined, 'color');
  buttonField('button-texture', ['none', 'grain', 'diagonal', 'honeycomb', 'facets', 'foundry-file'], 'select-one');
  const customTexture = new FakeField(); customTexture.dataset.stagecraftButtonCustomTexture = ''; (compactSections ? sectionPages.get('button-content')! : buttonPanel).append(customTexture);
  field('button-texture-path', customTexture, undefined, 'text'); field('button-texture-fit', customTexture, ['cover', 'contain'], 'select-one');
  buttonField('button-font', ['Signika', 'Modesto Condensed', 'Arial', 'Arial Black', 'Georgia', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'serif', 'sans-serif', 'monospace'], 'select-one');
  buttonField('button-font-size'); buttonField('button-color', undefined, 'color');
  for (const name of ['button-x', 'button-y', 'button-width', 'button-height']) buttonField(name);
  for (const [prefix, names] of [
    ['button-outline', ['enabled', 'color', 'opacity', 'width']],
    ['button-shadow', ['enabled', 'color', 'opacity', 'offset-x', 'offset-y', 'blur']],
    ['button-glow', ['enabled', 'color', 'opacity', 'radius']]
  ] as const) for (const suffix of names) buttonField(`${prefix}-${suffix}`, undefined, suffix === 'enabled' ? 'checkbox' : suffix === 'color' ? 'color' : 'number');
  const actions = new Map<string, FakeField>();
  for (const name of ['undo', 'redo', 'choose-image', 'reset-image-mask', 'choose-solid-alpha', 'clear-solid-alpha', 'reset-solid-mask', 'solid-pattern-variant', 'solid-pattern-palette', 'choose-button-texture']) {
    const button = new FakeField('button'); button.dataset.stagecraftAction = name; root.append(button); actions.set(name, button);
  }
  const makeId = ids('image-ui');
  if (withTimeline) { const timeline = new FakeField(); timeline.dataset.stagecraftTimeline = ''; root.append(timeline); }
  const services: EditorServices = {
    timelineClipboard: new TimelineClipboard(),
    makeId, repository: { list: async () => [{ id: sequence.id, name: sequence.name, revision: sequence.revision }], read: async () => sequence, save: async value => value, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }), localize: key => key,
    confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {}, prepareGroup: async () => {}, openSession() {},
    groupActive: () => false, chooseVideo: async () => null, chooseImage, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services); await view.mount(root as unknown as HTMLElement); t.after(() => view.detach());
  const driver = view as unknown as {
    selectClip(id: string): void; selectBreak(id: string | null): void; scrub(ms: number): void; selectedId: string | null;
    act(action: string, id?: string): Promise<void>; chooseImage(): Promise<void>; applyImagePath(path: string): Promise<void>;
    chooseSolidAlpha(): Promise<void>; applySolidAlphaPath(path: string): void;
    readForm(editField?: string): boolean; paint(): void; playheadMs: number;
    timelineCommand(command: import('../src/application/timeline-commands.js').TimelineCommand): void;
    timelineContextItems(target: TimelineContextTarget): readonly TimelineContextMenuItem[];
    timelineContextAction(action: string, target?: TimelineContextTarget): void;
  };
  return { ...ui, root, inspector, library, status, fields, actions, clipTab, clipPage, sequenceTab, sequencePage, sectionToolbar, sectionTabs, sectionPages, alphaDependent, buttonPanel, buttonChoice, view, driver, services };
}

function solidFixtureSequence(): SequenceV1 {
  const makeId = ids('solid-root');
  let source = applyTimelineCommand(fixtureSequence(null), { kind: 'add-track' }, makeId);
  source = applyTimelineCommand(source, { kind: 'add-clip', trackId: source.tracks[1]!.id, type: 'solid', startMs: 0 }, makeId);
  return validateSequence({ ...source, end: { kind: 'manual' } });
}

function solidOf(sequence: SequenceV1, id?: string): SolidClip {
  const clip = sequence.clips.find((clip): clip is SolidClip => clip.type === 'solid' && (!id || clip.id === id));
  assert.ok(clip, 'The expected solid clip must exist.');
  return clip;
}

test('solid mode switches ignore obsolete invalid duration fields on the first event', async t => {
  const source = solidFixtureSequence(), original = solidOf(source), f = await editorFixture(t, source);
  f.driver.selectClip(original.id);
  const entrance = f.fields.get('solid-entrance')!;
  entrance.min = '0'; entrance.value = '-1';
  assert.equal(entrance.checkValidity(), false);
  f.fields.get('solid-entrance-preset')!.value = 'none';
  assert.equal(f.driver.readForm('solid-entrance-preset'), true);
  assert.equal(entrance.disabled, true);
  assert.equal(solidOf(f.view.draft.draft!).entrance.preset, 'none');

  const duration = f.fields.get('solid-duration')!;
  duration.min = '0.001'; duration.value = '-1';
  assert.equal(duration.checkValidity(), false);
  f.fields.get('solid-duration-mode')!.value = 'sequence-end';
  assert.equal(f.driver.readForm('solid-duration-mode'), true);
  assert.equal(duration.disabled, true);
  assert.equal(solidOf(f.view.draft.draft!).duration.kind, 'sequence-end');
});

test('color-surface Library preset adds without media picker and selects Clip Content as one undo step', async t => {
  let picked = 0;
  const f = await editorFixture(t, solidFixtureSequence(), async () => { picked++; return 'textures/mask.png'; }, false, true);
  f.driver.selectClip(solidOf(f.view.draft.draft!).id);
  const before = structuredClone(f.view.draft.draft!);
  await f.driver.act('add-preset', 'color-surface');
  const added = solidOf(f.view.draft.draft!, f.driver.selectedId!);
  assert.equal(added.type, 'solid'); assert.equal(added.properties.alphaMap, undefined);
  assert.equal(picked, 0); assert.equal(f.fields.get('solid-color')!.value, '#ffffff');
  assert.equal(f.clipTab.getAttribute('aria-selected'), 'true');
  assert.equal(f.sectionTabs.get('content')!.getAttribute('aria-selected'), 'true');
  assert.equal(f.alphaDependent.hidden, true); assert.equal(f.fields.get('solid-fit')!.disabled, true);
  assert.deepEqual(f.view.draft.undo(), before);
});

test('Button library adds one default element and the inspector applies designs independently in one undo step', async t => {
  const source = fixtureSequence(null), f = await editorFixture(t, source, async () => null, false, true);
  const buttonEntries = f.library.children.filter(item => item.dataset.presetId?.startsWith('button'));
  assert.equal(buttonEntries.length, 1);
  assert.equal(buttonEntries[0]!.dataset.presetId, 'button');
  assert.equal(buttonEntries[0]!.getAttribute('aria-label'), 'STAGECRAFT.Editor.AddButton');
  assert.deepEqual(f.fields.get('button-design')!.children.map(option => option.value), ['custom', 'solid', 'diagonal', 'honeycomb', 'facets']);
  await f.driver.act('add-preset', 'button');
  const added = f.view.draft.draft!.clips.find((clip): clip is ButtonClip => clip.type === 'button');
  assert.ok(added);
  assert.equal(added.properties.action.kind, 'continue');
  assert.equal(added.properties.shape, 'rounded');
  assert.equal(f.fields.get('button-design')!.value, 'solid');
  const afterAdd = structuredClone(f.view.draft.draft!);
  assert.deepEqual(f.view.draft.undo(), source, 'adding a Button is one undo operation');
  assert.deepEqual(f.view.draft.redo(), afterAdd, 'redo restores the single inserted Button');
  assert.equal(f.driver.selectedId, added.id);
  assert.equal(f.sectionTabs.get('content')!.getAttribute('aria-selected'), 'true');
  assert.equal(f.buttonPanel.hidden, false);
  assert.equal(f.fields.get('button-label')!.value, 'Continue');
  assert.equal(f.fields.get('button-shape')!.value, 'rounded');
  assert.equal(f.fields.get('button-texture')!.value, 'none');
  assert.equal(f.fields.get('button-x')!.value, String(added.properties.box.x));

  f.fields.get('button-action')!.value = 'choice';
  f.fields.get('button-decision-name')!.value = 'Hidden Door';
  f.fields.get('button-message')!.value = 'A hidden door opens.';
  f.fields.get('button-visibility')!.value = 'public';
  assert.equal(f.driver.readForm('button-action'), true);
  const beforeDesign = structuredClone(f.view.draft.draft!);
  const beforeClip = beforeDesign.clips.find((clip): clip is ButtonClip => clip.type === 'button')!;

  const design = f.fields.get('button-design')!;
  design.value = 'honeycomb';
  f.dispatch(f.root, 'input', design);
  assert.deepEqual(f.view.draft.draft, beforeDesign, 'design input does not run the general inspector parser');
  f.dispatch(f.root, 'change', design);
  await new Promise<void>(resolve => setImmediate(resolve));
  const afterDesign = structuredClone(f.view.draft.draft!);
  const styled = afterDesign.clips.find((clip): clip is ButtonClip => clip.type === 'button')!;
  assert.deepEqual(styled, { ...beforeClip, properties: { ...beforeClip.properties, shape: 'pill',
    backgroundColor: '#215b5c', color: '#eafff6', texture: { kind: 'builtin', id: 'honeycomb' } } });
  assert.deepEqual(f.view.draft.undo(), beforeDesign, 'one style selection is one undo operation');
  assert.deepEqual(f.view.draft.redo(), afterDesign, 'redo reapplies just the selected visual style');

  const handles = f.view as unknown as { imageHandleState(): { clip: ButtonClip | null }; previewClipColor(clip: ButtonClip, field: string, value: string): ButtonClip | undefined };
  assert.equal(handles.imageHandleState().clip?.id, added.id, 'selected buttons expose preview transform handles');
  f.fields.get('button-blend-mode')!.value = 'screen'; f.fields.get('button-opacity')!.value = '0.6';
  assert.equal(f.driver.readForm('button-opacity'), true);
  assert.deepEqual((f.view.draft.draft!.clips.find(clip => clip.id === added.id) as ButtonClip).appearance, { blendMode: 'screen', opacity: 0.6 });
  const stillColorPreview = handles.previewClipColor(added, 'button-background', '#aabbcc');
  assert.equal(stillColorPreview?.properties.backgroundColor, '#aabbcc');
  assert.equal(f.view.draft.draft!.clips.find(clip => clip.id === added.id)?.type, 'button', 'color previews do not replace draft data');
});

test('Button Choice groups can be created and selected again with separate message visibility per option', async t => {
  const f = await editorFixture(t, fixtureSequence(null), async () => null, false, true);
  await f.driver.act('add-preset', 'button');
  const first = f.view.draft.draft!.clips.find((clip): clip is ButtonClip => clip.type === 'button')!;
  f.fields.get('button-label')!.value = 'Open the hidden door';
  f.fields.get('button-action')!.value = 'choice';
  f.fields.get('button-decision-name')!.value = 'Hidden Door';
  f.fields.get('button-message')!.value = 'A hidden door opens.';
  f.fields.get('button-visibility')!.value = 'public';
  assert.equal(f.driver.readForm('button-action'), true);
  const firstChoice = f.view.draft.draft!.clips.find((clip): clip is ButtonClip => clip.id === first.id && clip.type === 'button')!;
  assert.deepEqual(firstChoice.properties.action, { kind: 'choice', decisionId: 'Hidden-Door', optionId: first.id,
    message: 'A hidden door opens.', visibility: 'public' });

  await f.driver.act('add-preset', 'button');
  const second = f.view.draft.draft!.clips.find((clip): clip is ButtonClip => clip.type === 'button' && clip.id !== first.id)!;
  const group = f.fields.get('button-decision-group')!;
  assert.ok(group.children.some(option => option.value === 'existing:Hidden-Door'));
  f.fields.get('button-action')!.value = 'choice';
  group.value = 'existing:Hidden-Door';
  f.fields.get('button-message')!.value = 'The lock clicks open.';
  f.fields.get('button-visibility')!.value = 'gm';
  assert.equal(f.driver.readForm('button-action'), true, 'the action selector change enables the choice fields');
  assert.equal(f.driver.readForm('button-decision-group'), true);
  assert.equal(group.value, 'existing:Hidden-Door', 'the selector change survives inspector repaint');
  const secondChoice = f.view.draft.draft!.clips.find((clip): clip is ButtonClip => clip.id === second.id && clip.type === 'button')!;
  assert.deepEqual(secondChoice.properties.action, { kind: 'choice', decisionId: 'Hidden-Door', optionId: second.id,
    message: 'The lock clicks open.', visibility: 'gm' });

  await f.driver.act('add-preset', 'button');
  const third = f.view.draft.draft!.clips.find((clip): clip is ButtonClip => clip.type === 'button' && clip.id !== first.id && clip.id !== second.id)!;
  f.fields.get('button-action')!.value = 'choice';
  f.fields.get('button-decision-name')!.value = 'Library Clue';
  f.fields.get('button-message')!.value = 'The map reveals a hidden passage.';
  assert.equal(f.driver.readForm('button-action'), true, 'a new named group can be created');
  assert.deepEqual((f.view.draft.draft!.clips.find(clip => clip.id === third.id) as ButtonClip).properties.action,
    { kind: 'choice', decisionId: 'Library-Clue', optionId: third.id, message: 'The map reveals a hidden passage.', visibility: 'gm' });

  f.driver.selectClip(second.id);
  f.fields.get('button-decision-group')!.value = 'existing:Library-Clue';
  f.fields.get('button-message')!.value = 'The map points to the passage.';
  f.fields.get('button-visibility')!.value = 'public';
  assert.equal(f.driver.readForm('button-decision-group'), true, 'an existing choice can be moved to another question group');
  assert.equal(f.fields.get('button-decision-group')!.value, 'existing:Library-Clue', 'the new group selection survives inspector repaint');
  assert.deepEqual((f.view.draft.draft!.clips.find(clip => clip.id === second.id) as ButtonClip).properties.action,
    { kind: 'choice', decisionId: 'Library-Clue', optionId: second.id, message: 'The map points to the passage.', visibility: 'public' });
  f.fields.get('button-decision-group')!.value = '__new__';
  f.fields.get('button-decision-name')!.value = 'Hidden Door';
  assert.equal(f.driver.readForm('button-decision-group'), false, 'a duplicate group name is rejected with a validation message');
});

test('animated-surface Library insertion selects configured v2 Clip Content and has one independent Undo', async t => {
  let picked = 0;
  const f = await editorFixture(t, solidFixtureSequence(), async () => { picked++; return 'unused.png'; }, false, true);
  const before = structuredClone(f.view.draft.draft!);
  await f.driver.act('add-preset', 'animated-surface');
  const added = solidOf(f.view.draft.draft!, f.driver.selectedId!);
  assert.equal(added.typeVersion, 2); assert.deepEqual(added.properties.pattern, createAnimatedPattern());
  assert.deepEqual(added.duration, { kind: 'sequence-end' }); assert.deepEqual(added.exit, { preset: 'none', version: 1 });
  assert.equal(picked, 0);
  assert.equal(f.clipTab.getAttribute('aria-selected'), 'true');
  assert.equal(f.sectionTabs.get('content')!.getAttribute('aria-selected'), 'true');
  assert.equal(f.fields.get('solid-pattern-density')!.disabled, false);
  assert.deepEqual(f.view.draft.undo(), before);
});

test('first animated surface uses the existing manual sequence fallback while holding to its end', async t => {
  const base = solidFixtureSequence(), empty: SequenceV1 = { ...base, clips: [], end: { kind: 'manual' } };
  const f = await editorFixture(t, empty); const before = structuredClone(f.view.draft.draft!);
  await f.driver.act('add-preset', 'animated-surface');
  const added = solidOf(f.view.draft.draft!, f.driver.selectedId!);
  assert.equal(added.duration.kind, 'sequence-end'); assert.equal(added.exit.preset, 'none');
  assert.deepEqual(f.view.draft.draft!.end, before.end);
  assert.deepEqual(f.view.draft.undo(), before);
});

test('late animated surfaces retain a valid fixed interval at, near and beyond manual or automatic endpoints', async t => {
  for (const kind of ['manual', 'automatic'] as const) for (const startMs of [4900, 5000, 8000]) {
    const base = solidFixtureSequence();
    const source: SequenceV1 = { ...base, schemaVersion: 3,
      clips: base.clips.map(clip => clip.type === 'bars' ? { ...clip, duration: { kind: 'fixed', milliseconds: 5000 } } : clip),
      end: kind === 'manual' ? { kind: 'manual' } : { kind: 'fixed', durationMs: 5000, automatic: true } };
    const f = await editorFixture(t, source); const before = structuredClone(f.view.draft.draft!);
    f.driver.playheadMs = startMs; await f.driver.act('add-preset', 'animated-surface');
    const result = f.view.draft.draft!, added = solidOf(result, f.driver.selectedId!);
    assert.deepEqual(added.duration, { kind: 'fixed', milliseconds: 5000 }); assert.equal(added.exit.preset, 'none');
    assert.deepEqual(result.clips.filter(clip => clip.id !== added.id), before.clips);
    assert.deepEqual(timelineConflicts(result), []);
    const compiled = compileSequence(result);
    assert.ok(evaluate(compiled, startMs + 1000).some(item => item.clip.id === added.id));
    assert.deepEqual(f.view.draft.undo(), before);
  }
});

test('pattern inspector preserves custom palette on preset edit and independently undoes palette reset and variant seed', async t => {
  const f = await editorFixture(t, solidFixtureSequence());
  await f.driver.act('add-preset', 'animated-surface');
  f.fields.get('solid-pattern-color-0')!.value = '#112233';
  f.fields.get('solid-pattern-preset')!.value = 'confetti';
  f.fields.get('solid-pattern-density')!.value = '2.75';
  f.fields.get('solid-pattern-onBreak')!.value = 'pause';
  assert.equal(f.driver.readForm('solid-pattern-preset'), true);
  const beforePalette = structuredClone(f.view.draft.draft!);
  const authored = solidOf(beforePalette, f.driver.selectedId!).properties.pattern!;
  assert.equal(authored.preset, 'confetti'); assert.equal(authored.colors[0], '#112233');
  assert.equal(authored.density, 2.75); assert.equal(authored.onBreak, 'pause');
  await f.driver.act('solid-pattern-palette');
  assert.deepEqual(solidOf(f.view.draft.draft!, f.driver.selectedId!).properties.pattern!.colors, ANIMATED_PATTERN_PRESETS.find(preset => preset.id === 'confetti')!.colors);
  assert.deepEqual(f.view.draft.undo(), beforePalette); f.driver.paint();
  await f.driver.act('solid-pattern-variant');
  assert.notEqual(solidOf(f.view.draft.draft!, f.driver.selectedId!).properties.pattern!.seed, authored.seed);
  assert.deepEqual(f.view.draft.undo(), beforePalette);
});

test('pattern density bounds, locked controls and palette actions cannot change the valid draft', async t => {
  const f = await editorFixture(t, solidFixtureSequence()); await f.driver.act('add-preset', 'animated-surface');
  const baseline = structuredClone(f.view.draft.draft!);
  for (const value of ['0.19', '3.01']) {
    f.fields.get('solid-pattern-density')!.value = value;
    assert.equal(f.driver.readForm('solid-pattern-density'), false);
    assert.deepEqual(f.view.draft.draft, baseline);
  }
  f.driver.paint();
  const clip = solidOf(baseline, f.driver.selectedId!);
  f.view.draft.replace(applyTimelineCommand(baseline, { kind: 'toggle-track', trackId: clip.trackId, property: 'locked' }, ids('pattern-lock'))); f.driver.paint();
  const locked = structuredClone(f.view.draft.draft!);
  assert.equal(f.fields.get('solid-pattern-density')!.disabled, true);
  await f.driver.act('solid-pattern-palette'); await f.driver.act('solid-pattern-variant');
  assert.deepEqual(f.view.draft.draft, locked);
});

test('shape presets upgrade legacy solids only for non-four-point geometry and never downgrade v2', async t => {
  const f = await editorFixture(t, solidFixtureSequence()); const clip = solidOf(f.view.draft.draft!); f.driver.selectClip(clip.id);
  const original = structuredClone(f.view.draft.draft!);
  f.fields.get('solid-polygon-preset')!.value = 'diamond'; assert.equal(f.driver.readForm('solid-polygon-preset'), true);
  assert.equal(solidOf(f.view.draft.draft!).typeVersion, 1);
  f.fields.get('solid-polygon-preset')!.value = 'triangle'; assert.equal(f.driver.readForm('solid-polygon-preset'), true);
  assert.equal(solidOf(f.view.draft.draft!).typeVersion, 2); assert.equal(solidOf(f.view.draft.draft!).properties.mask.length, 3);
  f.fields.get('solid-polygon-preset')!.value = 'rectangle'; assert.equal(f.driver.readForm('solid-polygon-preset'), true);
  assert.equal(solidOf(f.view.draft.draft!).typeVersion, 2); assert.equal(solidOf(f.view.draft.draft!).properties.mask.length, 4);
  f.view.draft.undo(); f.view.draft.undo(); assert.deepEqual(f.view.draft.undo(), original);
});

test('legacy solid mask precision survives unrelated edits while newly authored coordinates use four decimals', async t => {
  const source = solidFixtureSequence(), clip = solidOf(source);
  if (clip.typeVersion !== 1) throw new Error('Expected legacy solid fixture');
  const precise: SolidClip = { ...clip, typeVersion: 1, properties: { ...clip.properties,
    mask: [{ x: 0.123456, y: 0.234567 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } };
  const f = await editorFixture(t, { ...source, clips: source.clips.map(item => item.id === clip.id ? precise : item) });
  f.driver.selectClip(clip.id);
  assert.equal(f.fields.get('solid-mask-0-x')!.value, '12.3456');
  f.fields.get('solid-color')!.value = '#abc123';
  assert.equal(f.driver.readForm('solid-color'), true);
  assert.deepEqual(solidOf(f.view.draft.draft!).properties.mask, precise.properties.mask);
  assert.equal(solidOf(f.view.draft.draft!).typeVersion, 1);
  f.fields.get('solid-mask-0-x')!.value = '12.34567';
  assert.equal(f.driver.readForm('solid-mask-0-x'), true);
  assert.equal(solidOf(f.view.draft.draft!).properties.mask[0].x, 0.1235);
});

test('new polygon coordinate fields stay numerically draggable with one Undo and valid legacy step precision', async t => {
  const f = await editorFixture(t, solidFixtureSequence(), async () => null, true);
  const clip = solidOf(f.view.draft.draft!); f.driver.selectClip(clip.id);
  f.fields.get('solid-polygon-preset')!.value = 'hexagon'; assert.equal(f.driver.readForm('solid-polygon-preset'), true);
  const before = structuredClone(f.view.draft.draft!);
  const field = f.root.querySelector<FakeField>('[name="solid-mask-5-x"]')!;
  assert.ok(field); assert.equal(field.step, 'any'); assert.equal(field.value, '0');
  assert.ok(field.title.includes('NumericScrubberHelp'));
  f.dispatch(f.root, 'pointerdown', field);
  f.dispatch(f.root, 'pointermove', field, { clientX: 8 });
  assert.equal(field.value, '0.2'); assert.deepEqual(f.view.draft.draft, before);
  f.dispatch(f.root, 'pointerup', field, { clientX: 8 });
  assert.equal(solidOf(f.view.draft.draft!).properties.mask[5]!.x, 0.002);
  assert.deepEqual(f.view.draft.undo(), before);
});

test('solid Inspector edits timing, geometry, color, blend and animations without changing siblings', async t => {
  const f = await editorFixture(t, solidFixtureSequence(), async () => null, false, true);
  const clip = solidOf(f.view.draft.draft!); f.driver.selectClip(clip.id);
  const bars = f.view.draft.draft!.clips.find(item => item.type === 'bars');
  f.fields.get('solid-color')!.value = '#3b78a2'; f.fields.get('solid-x')!.value = '35.03';
  f.fields.get('solid-blend-mode')!.value = 'multiply'; f.fields.get('solid-mask-0-x')!.value = '25';
  f.fields.get('solid-entrance-preset')!.value = 'fade-slide'; f.fields.get('solid-entrance-direction')!.value = 'left';
  f.fields.get('solid-entrance')!.value = '0.4'; f.fields.get('solid-entrance-distance')!.value = '150';
  f.fields.get('solid-outline-enabled')!.checked = true;
  assert.equal(f.driver.readForm('solid-color'), true);
  const changed = solidOf(f.view.draft.draft!);
  assert.equal(changed.properties.color, '#3b78a2'); assert.equal(changed.properties.box.x, 35.03);
  assert.equal(changed.properties.mask[0].x, 0.25); assert.equal(changed.appearance!.blendMode, 'multiply');
  assert.equal(changed.properties.outline!.enabled, true);
  assert.equal(changed.entrance.preset, 'fade-slide');
  assert.equal(changed.entrance.direction, 'left'); assert.equal(changed.entrance.distance, 150); assert.equal(changed.entrance.durationMs, 400);
  assert.deepEqual(f.view.draft.draft!.clips.find(item => item.type === 'bars'), bars);
  assert.equal('source' in changed.properties, false);
});

test('alpha picker and clear retain solid settings; each operation is independently undoable', async t => {
  const f = await editorFixture(t, solidFixtureSequence(), async () => 'textures/alpha.png', false, true);
  const clip = solidOf(f.view.draft.draft!); f.driver.selectClip(clip.id);
  const before = structuredClone(f.view.draft.draft!);
  await f.driver.act('choose-solid-alpha');
  const mapped = structuredClone(f.view.draft.draft!);
  assert.deepEqual(solidOf(mapped).properties.alphaMap, { kind: 'foundry-file', path: 'textures/alpha.png' });
  assert.equal(f.fields.get('solid-alpha-path')!.value, 'textures/alpha.png');
  assert.equal(f.alphaDependent.hidden, false); assert.equal(f.fields.get('solid-crop-width')!.disabled, false);
  await f.driver.act('clear-solid-alpha');
  assert.deepEqual(f.view.draft.draft, before);
  assert.equal(f.alphaDependent.hidden, true);
  assert.deepEqual(f.view.draft.undo(), mapped); assert.deepEqual(f.view.draft.undo(), before);
});

test('cancelled, stale, detached and locked solid alpha pickers cannot change the draft', async t => {
  const cancelled = await editorFixture(t, solidFixtureSequence(), async () => null);
  cancelled.driver.selectClip(solidOf(cancelled.view.draft.draft!).id);
  const untouched = structuredClone(cancelled.view.draft.draft!);
  await cancelled.driver.chooseSolidAlpha(); assert.deepEqual(cancelled.view.draft.draft, untouched);
  cancelled.view.detach();
  for (const action of ['selection', 'path', 'detach', 'lock'] as const) {
    let finish!: (path: string) => void;
    const f = await editorFixture(t, solidFixtureSequence(), () => new Promise(resolve => { finish = resolve; }));
    const clip = solidOf(f.view.draft.draft!); f.driver.selectClip(clip.id);
    const pending = f.driver.chooseSolidAlpha();
    if (action === 'selection') f.driver.selectClip(f.view.draft.draft!.clips.find(item => item.type === 'bars')!.id);
    if (action === 'path') f.driver.applySolidAlphaPath('textures/newer.png');
    if (action === 'detach') f.view.detach();
    if (action === 'lock') f.view.draft.replace(applyTimelineCommand(f.view.draft.draft!, { kind: 'toggle-track', trackId: clip.trackId, property: 'locked' }, ids('solid-lock')));
    const before = structuredClone(f.view.draft.draft!);
    finish('textures/stale.png');
    if (action === 'lock') await assert.rejects(pending, /TRACK_LOCKED/); else await pending;
    assert.deepEqual(f.view.draft.draft, before, action);
    f.view.detach();
  }
});

function imageOf(sequence: SequenceV1, id?: string): ImageClip {
  const image = sequence.clips.find((clip): clip is ImageClip => clip.type === 'image' && (!id || clip.id === id));
  if (!image) throw new Error('Expected an image clip');
  return image;
}

test('context Copy is inert; paste creates a new overlap track and each edit has one Undo', async t => {
  const source = applyTimelineCommand(fixtureSequence(), { kind: 'add-track' }, ids('context-extra'));
  const f = await editorFixture(t, source, async () => null, false, true);
  const image = imageOf(f.view.draft.draft!); f.driver.selectClip(image.id);
  const target: TimelineContextTarget = { kind: 'clip', id: image.id, trackId: image.trackId };
  const before = structuredClone(f.view.draft.draft!);
  let externalCalls = 0;
  f.services.repository.save = async value => { externalCalls++; return value; };
  f.services.prepareGroup = async () => { externalCalls++; };
  f.driver.timelineContextAction('copy', target);
  assert.equal(f.services.timelineClipboard!.hasContent, true);
  assert.deepEqual(f.view.draft.draft, before); assert.equal(f.view.draft.canUndo, false);
  f.driver.timelineContextAction('paste', target);
  const pasted = f.view.draft.draft!;
  assert.equal(pasted.clips.length, before.clips.length + 1);
  assert.equal(pasted.tracks.length, before.tracks.length + 1, 'overlap creates a new track despite the available spare');
  const copy = imageOf(pasted, f.driver.selectedId!);
  assert.notEqual(copy.id, image.id); assert.notEqual(copy.trackId, image.trackId); assert.equal(copy.startMs, 0);
  assert.deepEqual(copy.properties, image.properties);
  assert.equal(f.sectionTabs.get('content')!.getAttribute('aria-selected'), 'true');
  assert.deepEqual(f.view.draft.undo(), before); assert.equal(f.view.draft.canUndo, false); f.driver.paint();
  f.driver.timelineContextAction('paste-here', { kind: 'space', positionMs: 7000, trackId: image.trackId });
  assert.equal(imageOf(f.view.draft.draft!, f.driver.selectedId!).startMs, 7000);
  assert.equal(f.view.draft.draft!.tracks.length, before.tracks.length);
  assert.deepEqual(f.view.draft.undo(), before); assert.equal(f.view.draft.canUndo, false);
  assert.equal(externalCalls, 0, 'context operations only affect the draft');
});

test('context Cut commits its clipboard only after removal, locked edits fail and Break actions are undoable', async t => {
  const f = await editorFixture(t, fixtureSequence(), async () => null, false, true);
  const image = imageOf(f.view.draft.draft!); f.driver.selectClip(image.id);
  const target: TimelineContextTarget = { kind: 'clip', id: image.id, trackId: image.trackId };
  const before = structuredClone(f.view.draft.draft!);
  f.driver.timelineContextAction('cut', target);
  assert.equal(f.services.timelineClipboard!.hasContent, true);
  assert.equal(f.view.draft.draft!.clips.some(clip => clip.id === image.id), false);
  assert.deepEqual(f.view.draft.undo(), before); assert.equal(f.view.draft.canUndo, false); f.driver.selectClip(image.id);
  f.driver.timelineContextAction('track-locked', target);
  const locked = structuredClone(f.view.draft.draft!);
  assert.equal(f.driver.timelineContextItems(target).find(item => item.id === 'cut')!.disabled, true);
  assert.equal(f.driver.timelineContextItems(target).find(item => item.id === 'paste')!.disabled, true);
  assert.equal(f.driver.timelineContextItems(target).find(item => item.id === 'copy')!.disabled, false);
  f.services.timelineClipboard!.clear();
  f.driver.timelineContextAction('cut');
  assert.equal(f.services.timelineClipboard!.hasContent, false, 'a rejected cut must not replace the clipboard');
  assert.deepEqual(f.view.draft.draft, locked);
  assert.deepEqual(f.view.draft.undo(), before); assert.equal(f.view.draft.canUndo, false); f.driver.paint();
  f.driver.timelineCommand({ kind: 'add-break', positionMs: 1200 });
  const marker = f.view.draft.draft!.breaks![0]!;
  const breakTarget: TimelineContextTarget = { kind: 'break', id: marker.id };
  const markerBefore = structuredClone(f.view.draft.draft!);
  f.driver.timelineContextAction('copy', breakTarget);
  f.driver.timelineContextAction('duplicate', breakTarget);
  assert.deepEqual(f.view.draft.draft!.breaks?.map(value => value.positionMs), [1200, 1300]);
  assert.deepEqual(f.view.draft.undo(), markerBefore); f.driver.selectBreak(marker.id);
  f.driver.timelineContextAction('delete', breakTarget);
  assert.equal(f.view.draft.draft!.breaks!.length, 0);
  assert.deepEqual(f.view.draft.undo(), markerBefore);
  f.driver.selectBreak(marker.id);
  f.driver.timelineContextAction('paste-here', { kind: 'space', positionMs: 2200 });
  assert.deepEqual(f.view.draft.draft!.breaks?.map(value => value.positionMs), [1200, 2200]);
  assert.deepEqual(f.view.draft.undo(), markerBefore);
});

test('clipboard shortcuts work for timeline selection while preserving ordinary input shortcuts', async t => {
  const f = await editorFixture(t, fixtureSequence(), async () => null, false, false, true);
  for (const [name, tag] of [['HTMLInputElement', 'input'], ['HTMLSelectElement', 'select'], ['HTMLTextAreaElement', 'textarea']] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: class {
      static [Symbol.hasInstance](node: unknown) { return node instanceof FakeField && node.tag === tag; }
    } });
  }
  const image = imageOf(f.view.draft.draft!); f.driver.selectClip(image.id);
  const focus = f.actions.get('undo')!;
  (document as unknown as { activeElement: FakeField }).activeElement = focus;
  assert.equal(f.dispatch(f.root, 'keydown', focus, { key: 'c', ctrlKey: true }).defaultPrevented, true);
  assert.equal(f.services.timelineClipboard!.hasContent, true);
  f.driver.scrub(6000);
  const before = structuredClone(f.view.draft.draft!);
  assert.equal(f.dispatch(f.root, 'keydown', focus, { key: 'v', metaKey: true }).defaultPrevented, true);
  assert.equal(imageOf(f.view.draft.draft!, f.driver.selectedId!).startMs, 6000);
  assert.deepEqual(f.view.draft.undo(), before); assert.equal(f.view.draft.canUndo, false);
  f.driver.selectClip(image.id);
  const oldClipNode = f.root.querySelector<FakeField>('[data-timeline-clip="' + image.id + '"]')!;
  oldClipNode.focus();
  assert.equal(f.dispatch(f.root, 'keydown', oldClipNode, { key: 'x', ctrlKey: true }).defaultPrevented, true);
  assert.equal(f.view.draft.draft!.clips.some(clip => clip.id === image.id), false);
  assert.equal(f.root.contains(document.activeElement), true, 'Cut must preserve editor focus after removing the focused clip');
  const afterCutFocus = document.activeElement as unknown as FakeField;
  assert.equal(f.dispatch(f.root, 'keydown', afterCutFocus, { key: 'v', ctrlKey: true }).defaultPrevented, true, 'Paste must work immediately after Cut without clicking back into the editor');
  assert.equal(imageOf(f.view.draft.draft!, f.driver.selectedId!).startMs, 6000);
  assert.equal(f.root.contains(document.activeElement), true);
  f.view.draft.undo(); assert.deepEqual(f.view.draft.undo(), before);
  f.services.timelineClipboard!.clear();
  const input = f.fields.get('image-width')!;
  (document as unknown as { activeElement: FakeField }).activeElement = input;
  assert.equal(f.dispatch(f.root, 'keydown', input, { key: 'c', ctrlKey: true }).defaultPrevented, false);
  assert.equal(f.services.timelineClipboard!.hasContent, false, 'editing a number retains native clipboard shortcuts');
});

test('inspector category switching preserves values and history, including hidden fields on edit and Undo', async t => {
  const f = await editorFixture(t, fixtureSequence(), async () => null, true, true);
  const image = imageOf(f.view.draft.draft!); f.driver.selectClip(image.id);
  const before = structuredClone(f.view.draft.draft!);
  let writes = 0; f.services.repository.save = async value => { writes++; return value; };
  f.services.prepareGroup = async () => { writes++; };
  const values = [...f.fields].map(([name, field]) => [name, field.value, field.checked, field.disabled]);
  assert.equal(f.sectionPages.get('image-content')!.hidden, false);
  f.inspector.scrollTop = 98;
  f.sectionTabs.get('animation')!.dispatchEvent(new Event('click'));
  assert.equal(f.sectionPages.get('image-animation')!.hidden, false);
  assert.equal(f.sectionPages.get('image-content')!.hidden, true);
  assert.equal(f.inspector.scrollTop, 0);
  f.driver.paint();
  assert.equal(f.sectionTabs.get('animation')!.getAttribute('aria-selected'), 'true', 'repainting the same selection must retain its category');
  f.sectionTabs.get('timing')!.dispatchEvent(new Event('click'));
  assert.equal(f.sectionPages.get('image-timing')!.hidden, false);
  assert.equal(f.sectionPages.get('shared-timing')!.hidden, false, 'track selection belongs beside clip timing');
  f.sectionTabs.get('content')!.dispatchEvent(new Event('click'));
  assert.equal(f.inspector.scrollTop, 98);
  assert.deepEqual([...f.fields].map(([name, field]) => [name, field.value, field.checked, field.disabled]), values);
  assert.deepEqual(f.view.draft.draft, before); assert.equal(f.view.draft.canUndo, false); assert.equal(writes, 0);

  f.sectionTabs.get('timing')!.dispatchEvent(new Event('click'));
  const duration = f.fields.get('image-duration')!; duration.value = '7'; f.dispatch(f.root, 'input', duration);
  assert.equal(imageOf(f.view.draft.draft!).duration.kind, 'fixed');
  assert.deepEqual(imageOf(f.view.draft.draft!).properties, image.properties, 'editing Timing must retain all hidden Content properties');
  assert.deepEqual(imageOf(f.view.draft.draft!).entrance, image.entrance, 'editing Timing must retain the hidden animation');
  assert.deepEqual(f.view.draft.undo(), before); assert.equal(f.view.draft.canUndo, false); assert.equal(writes, 0);
});

test('clip selection and library insertion open Content, while Break only exposes Timing', async t => {
  const f = await editorFixture(t, fixtureSequence(), async () => 'art/new.png', false, true);
  const image = imageOf(f.view.draft.draft!); f.driver.selectClip(image.id);
  f.sectionTabs.get('animation')!.dispatchEvent(new Event('click'));
  f.driver.selectClip(f.view.draft.draft!.clips.find(clip => clip.type === 'bars')!.id);
  assert.equal(f.sectionTabs.get('content')!.getAttribute('aria-selected'), 'true');
  f.driver.selectClip(image.id); f.sectionTabs.get('timing')!.dispatchEvent(new Event('click'));
  await f.driver.act('add-preset', 'image');
  assert.notEqual(f.driver.selectedId, image.id);
  assert.equal(f.sectionPages.get('image-content')!.hidden, false);
  assert.equal(f.sectionTabs.get('content')!.getAttribute('aria-selected'), 'true');
  f.driver.timelineCommand({ kind: 'add-break', positionMs: 2500 });
  assert.equal(f.view.draft.draft!.breaks?.length, 1);
  assert.equal(f.sectionPages.get('break-timing')!.hidden, false);
  assert.equal(f.sectionPages.get('shared-timing')!.hidden, true);
  assert.equal(f.sectionTabs.get('content')!.hidden, true); assert.equal(f.sectionTabs.get('animation')!.hidden, true);
  assert.equal(f.sectionTabs.get('timing')!.getAttribute('aria-selected'), 'true');
  f.driver.selectBreak(null); assert.equal(f.sectionToolbar.hidden, true);
});

test('outer Sequence tab hides category controls and category switch cancels a transient numeric gesture', async t => {
  const f = await editorFixture(t, fixtureSequence(), async () => null, true, true);
  f.driver.selectClip(imageOf(f.view.draft.draft!).id);
  const before = structuredClone(f.view.draft.draft!), width = f.fields.get('image-width')!;
  const initial = width.value;
  f.dispatch(f.root, 'pointerdown', width); f.dispatch(f.root, 'pointermove', width, { clientX: 40 });
  assert.notEqual(width.value, initial);
  f.sectionTabs.get('animation')!.dispatchEvent(new Event('click'));
  assert.equal(width.value, initial, 'hiding the field must cancel the transient gesture');
  f.dispatch(f.root, 'pointerup', width, { clientX: 40 });
  assert.deepEqual(f.view.draft.draft, before); assert.equal(f.view.draft.canUndo, false);
  assert.equal(f.sectionPages.get('image-animation')!.hidden, false);
  f.sequenceTab.dispatchEvent(new Event('click')); assert.equal(f.sectionToolbar.hidden, true);
  f.driver.paint(); assert.equal(f.sectionToolbar.hidden, true, 'repaint must not expose categories over Sequence settings');
  f.clipTab.dispatchEvent(new Event('click')); assert.equal(f.sectionToolbar.hidden, false);
  assert.equal(f.sectionPages.get('image-animation')!.hidden, false);
});

test('selecting a different clip from Sequence resets Content scroll and preserves Sequence scroll', async t => {
  const f = await editorFixture(t, fixtureSequence(), async () => null, false, true);
  f.driver.selectClip(imageOf(f.view.draft.draft!).id); f.inspector.scrollTop = 98;
  f.sequenceTab.dispatchEvent(new Event('click')); f.inspector.scrollTop = 217;
  f.driver.selectClip(f.view.draft.draft!.clips.find(clip => clip.type === 'bars')!.id);
  assert.equal(f.sectionPages.get('bars-content')!.hidden, false);
  assert.equal(f.inspector.scrollTop, 0, 'a newly selected clip starts at the top of Content');
  f.sequenceTab.dispatchEvent(new Event('click'));
  assert.equal(f.inspector.scrollTop, 217, 'clip selection must not overwrite Sequence scroll');
});

test('direct numeric input drags integrate with editor drafts, Escape, ordinary typing and one Undo', async t => {
  const f = await editorFixture(t, fixtureSequence(), async () => null, true);
  const image = imageOf(f.view.draft.draft!);
  f.driver.selectClip(image.id);
  const width = f.fields.get('image-width')!;
  const before = structuredClone(f.view.draft.draft!);
  const initial = Number(width.value);

  f.dispatch(f.root, 'pointerdown', width);
  f.dispatch(f.root, 'pointerup', width);
  assert.deepEqual(f.view.draft.draft, before, 'a plain input click must not create a draft change');
  assert.equal(f.view.draft.canUndo, false);

  f.dispatch(f.root, 'pointerdown', width);
  f.dispatch(f.root, 'pointermove', width, { clientX: 40 });
  assert.ok(Number(width.value) > initial, 'the actual input must scrub without a separate button');
  for (const type of ['input', 'change', 'focusout']) f.dispatch(f.root, type, width);
  assert.deepEqual(f.view.draft.draft, before, 'drag motion must remain transient');
  f.dispatch(f.root, 'keydown', width, { key: 'Escape' });
  assert.equal(Number(width.value), initial);
  assert.deepEqual(f.view.draft.draft, before);
  assert.equal(f.view.draft.canUndo, false);

  f.dispatch(f.root, 'pointerdown', width);
  f.dispatch(f.root, 'pointermove', width, { clientX: 40 });
  const resizedWidth = Number(width.value);
  f.dispatch(f.root, 'pointerup', width, { clientX: 40 });
  assert.equal(imageOf(f.view.draft.draft!).properties.box.width, resizedWidth);
  assert.deepEqual(f.view.draft.undo(), before, 'the completed drag is one Undo step');
  assert.equal(f.view.draft.canUndo, false);
  const paint = f.view as unknown as { paint(): void };
  paint.paint();

  width.value = String(initial + 7);
  f.dispatch(f.root, 'input', width);
  assert.equal(imageOf(f.view.draft.draft!).properties.box.width, initial + 7, 'ordinary input editing still updates the clip');
});

test('shared editor transforms select text/video, commit one edit and refuse a locked track', async t => {
  let nextId = 0; const makeId = () => 'shared-transform-' + ++nextId;
  let sequence = fixtureSequence(null);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track' }, makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'text', trackId: sequence.tracks.at(-1)!.id, startMs: 0 }, makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track' }, makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'video', trackId: sequence.tracks.at(-1)!.id,
    startMs: 0, sourcePath: 'test.webm', sourceDurationMs: 5000 }, makeId);
  const f = await editorFixture(t, sequence, async () => null);
  const driver = f.view as unknown as { imageHandleState(): { clip: TextClip | VideoClip | null; editable: boolean };
    commitImageHandleEdit(sequenceId: string, id: string, clip: TextClip | VideoClip): boolean; paint(): void };
  for (const type of ['text', 'video'] as const) {
    const original = f.view.draft.draft!.clips.find(clip => clip.type === type)! as TextClip | VideoClip;
    f.driver.selectClip(original.id);
    assert.equal(driver.imageHandleState().clip?.type, type);
    assert.equal(driver.imageHandleState().editable, true);
    const replacement = { ...original, ...(type === 'video' ? { typeVersion: 6 } : {}),
      properties: { ...original.properties, box: { x: 100, y: 200, width: 640, height: 360 } } } as TextClip | VideoClip;
    const before = f.view.draft.draft!;
    assert.equal(driver.commitImageHandleEdit(before.id, original.id, replacement), true);
    assert.deepEqual((f.view.draft.draft!.clips.find(clip => clip.id === original.id) as TextClip | VideoClip).properties.box, replacement.properties.box);
    f.view.draft.undo(); assert.deepEqual(f.view.draft.draft, before);
    f.view.draft.redo();
    const locked = f.view.draft.draft!;
    f.view.draft.replace({ ...locked, tracks: locked.tracks.map(track => track.id === original.trackId ? { ...track, locked: true } : track) });
    assert.equal(driver.imageHandleState().editable, false);
    assert.equal(driver.commitImageHandleEdit(before.id, original.id, replacement), false);
  }
});

test('editor template insertion routes overlaps, selects the new clip and undoes in one step', async t => {
  const sequence = fixtureSequence();
  const f = await editorFixture(t, sequence, async () => null);
  const driver = f.view as unknown as {
    templatePlacement(type: 'image'): { sequence: SequenceV1; trackId: string; playheadMs: number };
    insertTemplateClip(clip: ImageClip, expected: { sequence: SequenceV1; trackId: string; playheadMs: number }): void;
  };
  const old = imageOf(sequence);
  f.driver.selectClip(old.id);
  const expected = driver.templatePlacement('image');
  const clip: ImageClip = { ...structuredClone(old), id: 'new-template-image', trackId: expected.trackId, startMs: expected.playheadMs };
  driver.insertTemplateClip(clip, expected);
  const current = f.view.draft.draft!;
  assert.equal(f.driver.selectedId, clip.id);
  assert.notEqual(imageOf(current, clip.id).trackId, old.trackId);
  assert.equal(f.clipTab.getAttribute('aria-selected'), 'true');
  f.view.draft.undo(); assert.deepEqual(f.view.draft.draft, expected.sequence);
  f.view.draft.redo(); assert.deepEqual(f.view.draft.draft, current);
  assert.throws(() => driver.insertTemplateClip({ ...clip, id: 'stale-result' }, expected), /TEMPLATE_CONTEXT_CHANGED/);
  assert.deepEqual(f.view.draft.draft, current);
});

test('Image library picker cancellation is inert; choosing a file inserts at playhead and selects the Clip tab', async t => {
  let chosen: string | null = null, picks = 0;
  const sequence = fixtureSequence(null);
  const f = await editorFixture(t, sequence, async () => { picks++; return chosen; });
  f.driver.playheadMs = 1_250;
  const imageEntry = f.library.children.find(button => button.dataset.presetId === 'image');
  assert.ok(imageEntry); assert.equal(imageEntry.dataset.stagecraftAction, 'add-preset');
  assert.equal(imageEntry.children[0]!.className, 'fa-solid fa-image');
  assert.equal(imageEntry.children[1]!.textContent, 'STAGECRAFT.Editor.Image');

  await f.driver.act('add-preset', 'image');
  assert.equal(picks, 1); assert.deepEqual(f.view.draft.draft, sequence, 'cancel does not change the draft or history');
  assert.equal(f.view.draft.canUndo, false);

  chosen = 'portraits/selected.png';
  await f.driver.act('add-preset', 'image');
  const inserted = imageOf(f.view.draft.draft!);
  assert.equal(inserted.properties.source.path, chosen);
  assert.equal(inserted.startMs, 1_250);
  assert.deepEqual(inserted.duration, { kind: 'fixed', milliseconds: 5_000 });
  assert.equal(inserted.entrance.preset, 'fade'); assert.equal(inserted.entrance.durationMs, 800);
  assert.equal(inserted.exit.preset, 'fade'); assert.equal(inserted.exit.durationMs, 800);
  assert.deepEqual(inserted.properties.box, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(inserted.properties.crop, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(inserted.properties.mask, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  assert.equal(f.driver['selectedId'], inserted.id);
  assert.equal(f.clipTab.getAttribute('aria-selected'), 'true'); assert.equal(f.clipPage.hidden, false);
  assert.equal(f.view.draft.canUndo, true);
});

test('image inspector patches geometry, crop, mask, appearance and effects while retaining nested extensions', async t => {
  const source = fixtureSequence(), initial = imageOf(source);
  const extended = validateSequence({ ...source, clips: source.clips.map(clip => {
    if (clip.id !== initial.id) return clip;
    const image = clip as ImageClip;
    return {
      ...image, futureClip: 'keep', duration: { ...image.duration, futureDuration: 'keep' },
      entrance: { ...image.entrance, futureTransition: 'keep' }, appearance: { blendMode: 'screen', opacity: 0.8, futureAppearance: 'keep' },
      properties: {
        ...image.properties, futureProperty: 'keep', source: { ...image.properties.source, futureSource: 'keep' },
        box: { ...image.properties.box, futureBox: 'keep' }, crop: { ...image.properties.crop, futureCrop: 'keep' },
        mask: image.properties.mask.map(point => ({ ...point, futurePoint: 'keep' })) as unknown as ImageClip['properties']['mask'],
        outline: { enabled: true, color: '#123456', opacity: 0.6, width: 4, futureOutline: 'keep' },
        shadow: { enabled: true, color: '#000000', opacity: 0.5, offsetX: 2, offsetY: 3, blur: 8, futureShadow: 'keep' },
        glow: { enabled: true, color: '#abcdef', opacity: 0.7, radius: 12, futureGlow: 'keep' }
      }
    };
  }) });
  const f = await editorFixture(t, extended); f.driver.selectClip(initial.id);
  assert.equal(f.driver.selectedId, initial.id);
  assert.equal(f.fields.get('image-x')!.disabled, false);
  f.fields.get('image-x')!.value = '45'; f.fields.get('image-crop-x')!.value = '10';
  f.fields.get('image-crop-width')!.value = '80';
  f.fields.get('image-mask-0-x')!.value = '12'; f.fields.get('image-blend-mode')!.value = 'multiply';
  f.fields.get('image-outline-width')!.value = '9';
  f.dispatch(f.root, 'input', f.fields.get('image-x')!);
  assert.equal((f.driver as unknown as { invalid: boolean }).invalid, false, `valid image edits should pass sequence validation (${f.status.textContent})`);

  const edited = imageOf(f.view.draft.draft!, initial.id);
  assert.equal(edited.properties.box.x, 45); assert.equal(edited.properties.crop.x, 0.1);
  assert.equal(edited.properties.crop.width, 0.8);
  assert.equal(edited.properties.mask[0].x, 0.12); assert.equal(edited.appearance?.blendMode, 'multiply');
  assert.equal(edited.properties.outline?.width, 9);
  assert.equal((edited as ImageClip & { futureClip: string }).futureClip, 'keep');
  assert.equal((edited.duration as ImageClip['duration'] & { futureDuration: string }).futureDuration, 'keep');
  assert.equal((edited.entrance as ImageClip['entrance'] & { futureTransition: string }).futureTransition, 'keep');
  assert.equal((edited.appearance as ImageClip['appearance'] & { futureAppearance: string }).futureAppearance, 'keep');
  assert.equal((edited.properties as ImageClip['properties'] & { futureProperty: string }).futureProperty, 'keep');
  assert.equal((edited.properties.source as ImageClip['properties']['source'] & { futureSource: string }).futureSource, 'keep');
  assert.equal((edited.properties.box as ImageClip['properties']['box'] & { futureBox: string }).futureBox, 'keep');
  assert.equal((edited.properties.crop as ImageClip['properties']['crop'] & { futureCrop: string }).futureCrop, 'keep');
  assert.equal((edited.properties.mask[0] as ImagePoint & { futurePoint: string }).futurePoint, 'keep');
  assert.equal((edited.properties.outline as NonNullable<ImageClip['properties']['outline']> & { futureOutline: string }).futureOutline, 'keep');
  assert.equal((edited.properties.shadow as NonNullable<ImageClip['properties']['shadow']> & { futureShadow: string }).futureShadow, 'keep');
  assert.equal((edited.properties.glow as NonNullable<ImageClip['properties']['glow']> & { futureGlow: string }).futureGlow, 'keep');
  assert.deepEqual(f.view.draft.undo(), extended, 'the inspector edit is one undo step');
});

test('invalid crop and mask fractions leave the last valid image draft unchanged', async t => {
  const source = fixtureSequence(), image = imageOf(source), f = await editorFixture(t, source); f.driver.selectClip(image.id);
  const cropX = f.fields.get('image-crop-x')!, cropWidth = f.fields.get('image-crop-width')!;
  cropX.value = '99'; cropWidth.value = '2'; f.dispatch(f.root, 'input', cropWidth);
  assert.deepEqual(f.view.draft.draft, source); assert.equal((f.driver as unknown as { invalid: boolean }).invalid, true);

  cropX.value = '0'; cropWidth.value = '100'; f.dispatch(f.root, 'input', cropWidth);
  assert.equal((f.driver as unknown as { invalid: boolean }).invalid, false);
  const maskX = f.fields.get('image-mask-0-x')!; maskX.value = '101'; f.dispatch(f.root, 'input', maskX);
  assert.equal(imageOf(f.view.draft.draft!, image.id).properties.mask[0].x, 0);
  assert.equal((f.driver as unknown as { invalid: boolean }).invalid, true);
});

test('small valid source crops at the image boundary survive unrelated inspector edits', async t => {
  const initial = fixtureSequence(), image = imageOf(initial);
  const source = validateSequence({ ...initial, clips: initial.clips.map(clip => clip.id === image.id && clip.type === 'image'
    ? { ...clip, properties: { ...clip.properties, crop: { x: 0.99995, y: 0.99999, width: 0.00005, height: 0.00001 } } }
    : clip) });
  const f = await editorFixture(t, source); f.driver.selectClip(image.id);
  assert.equal(f.fields.get('image-crop-x')!.value, '99.995');
  assert.equal(f.fields.get('image-crop-width')!.value, '0.005');
  f.fields.get('image-x')!.value = '160'; f.dispatch(f.root, 'input', f.fields.get('image-x')!);
  const edited = imageOf(f.view.draft.draft!, image.id);
  assert.equal(edited.properties.box.x, 160);
  assert.equal(edited.properties.crop.x, 0.99995);
  assert.equal(edited.properties.crop.y, 0.99999);
  assert.equal(edited.properties.crop.width, 0.00005);
  assert.equal(edited.properties.crop.height, 0.00001);
});

test('fractional crop, mask and zoom values survive inspector roundtrip without phantom undo; mask display stays decimal', async t => {
  const seed = fixtureSequence(), image = imageOf(seed);
  const fraction = 0.12345678901234566;
  const source = validateSequence({ ...seed, clips: seed.clips.map(clip => clip.id === image.id && clip.type === 'image'
    ? { ...clip, entrance: { preset: 'zoom', version: 1, durationMs: 800, easing: 'linear', scale: fraction },
      properties: { ...clip.properties, crop: { ...clip.properties.crop, x: fraction, width: 1 - fraction },
        mask: [{ ...clip.properties.mask[0]!, x: fraction }, clip.properties.mask[1], clip.properties.mask[2], clip.properties.mask[3]] } }
    : clip) });
  const f = await editorFixture(t, source); f.driver.selectClip(image.id);
  assert.equal(f.fields.get('image-crop-x')!.value, '12.345678901234566');
  assert.equal(f.fields.get('image-mask-0-x')!.value, '12.345678901234566');
  assert.equal(f.fields.get('image-entrance-scale')!.value, '12.345678901234566');
  assert.equal(f.driver.readForm(), true);
  assert.deepEqual(f.view.draft.draft, source);
  assert.equal(f.view.draft.canUndo, false, 'reading existing fractional values must not create history');

  const sourceImage = imageOf(source, image.id);
  const replacement: ImageClip = { ...sourceImage, properties: { ...sourceImage.properties,
    mask: [{ ...sourceImage.properties.mask[0]!, x: 0.3001 }, sourceImage.properties.mask[1], sourceImage.properties.mask[2], sourceImage.properties.mask[3]] } };
  const driver = f.view as unknown as { commitImageHandleEdit(sequenceId: string, id: string, clip: ImageClip): boolean };
  assert.equal(driver.commitImageHandleEdit(source.id, image.id, replacement), true);
  assert.equal(f.fields.get('image-mask-0-x')!.value, '30.01');
  assert.equal(f.view.draft.canUndo, true);
  assert.deepEqual(f.view.draft.undo(), source, 'a mask gesture must be one undoable replacement');
  assert.equal(f.view.draft.canUndo, false);
});

test('leading-dot percentage input is parsed as a decimal percentage for crop and mask coordinates', async t => {
  const source = fixtureSequence(), image = imageOf(source), f = await editorFixture(t, source); f.driver.selectClip(image.id);
  f.fields.get('image-crop-x')!.value = '.5';
  f.fields.get('image-crop-width')!.value = '99.5';
  f.fields.get('image-mask-0-x')!.value = '.5';
  assert.equal(f.driver.readForm('image-crop-x'), true);
  const edited = imageOf(f.view.draft.draft!, image.id);
  assert.equal(edited.properties.crop.x, 0.005);
  assert.equal(edited.properties.crop.width, 0.995);
  assert.equal(edited.properties.mask[0].x, 0.005);
});

test('an image picker result is ignored after selection or source path changes', async t => {
  const source = fixtureSequence(), image = imageOf(source), bars = source.clips.find(clip => clip.type === 'bars')!;
  let finish!: (path: string | null) => void;
  const f = await editorFixture(t, source, () => new Promise(resolve => { finish = resolve; }));
  f.driver.selectClip(image.id);
  const switchedSelection = f.driver.chooseImage(); f.driver.selectClip(bars.id); finish('stale-selection.png'); await switchedSelection;
  assert.equal(imageOf(f.view.draft.draft!, image.id).properties.source.path, 'portraits/first.png');

  f.driver.selectClip(image.id);
  const switchedPath = f.driver.chooseImage(); await f.driver.applyImagePath('portraits/current.png');
  finish('stale-path.png'); await switchedPath;
  assert.equal(imageOf(f.view.draft.draft!, image.id).properties.source.path, 'portraits/current.png');
});

test('a stale image load or failure cannot clear a still preview for the latest source', async t => {
  const source = fixtureSequence(), image = imageOf(source), f = await editorFixture(t, source);
  f.driver.selectClip(image.id);
  const viewer = new FakeField(); viewer.dataset.stagecraftViewer = ''; f.root.append(viewer);
  const pending: Array<{ resolve(): void; reject(error: Error): void }> = [];
  const surfaces: Array<{ disposed: boolean; prepare(): Promise<void>; dispose(): void; updateStill(): Promise<void>; render(): void }> = [];
  const driver = f.view as unknown as {
    createStillSurface(options: unknown): typeof surfaces[number];
    drawStill(): void; staticPreview: typeof surfaces[number] | null;
  };
  driver.createStillSurface = () => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const surface = {
      disposed: false, prepare: () => promise, dispose() { this.disposed = true; },
      updateStill: async () => {}, render() {}
    };
    surfaces.push(surface); pending.push({ resolve, reject });
    return surface;
  };
  driver.drawStill();
  assert.equal(surfaces.length, 1);
  await f.driver.applyImagePath('portraits/second.png');
  assert.equal(surfaces.length, 2, 'a source change replaces a still surface while its image is loading');
  assert.equal(driver.staticPreview, surfaces[1]);
  pending[0]!.reject(new Error('stale image failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(driver.staticPreview, surfaces[1]);
  assert.equal(surfaces[1]!.disposed, false);

  await f.driver.applyImagePath('portraits/third.png');
  assert.equal(surfaces.length, 3);
  pending[1]!.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(driver.staticPreview, surfaces[2], 'a late completion cannot replace the latest still');
  assert.equal(surfaces[2]!.disposed, false);
});

test('legacy simple-composition helpers reject image clips rather than classifying them as titles', () => {
  const sequence = fixtureSequence();
  assert.equal(simpleClip(sequence, 'image' as never), undefined);
  assert.throws(() => buildSimpleSequence(sequence, ids(), { name: sequence.name, end: sequence.end, presentation: sequence.presentation }), /SIMPLE_COMPOSITION_UNSUPPORTED_IMAGE/);
  assert.throws(() => simpleTimingConflicts(sequence), /SIMPLE_COMPOSITION_UNSUPPORTED_IMAGE/);
});
