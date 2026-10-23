import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { FormValidation, type ValidatedField } from '../src/ui/form-validation.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { LocalPlayer } from '../src/playback/local-player.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import { applyTimelineCommand } from '../src/application/timeline-commands.js';

/** Native validity is an input to this UI test, never a second constraint implementation. */
class ElementStub {
  readonly children: ElementStub[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classList = { toggle() {} };
  parentElement: ElementStub | null = null;
  hidden = false; disabled = false; inert = false; isConnected = true; required = false;
  type = 'number'; name = ''; value = ''; id = ''; className = ''; title = ''; textContent = '';
  nativeReason = ''; reportCount = 0; clickCount = 0;
  onClick: (() => void) | undefined;
  get validity() { return { valid: this.nativeReason === '' }; }
  get validationMessage() { return this.nativeReason; }
  get willValidate() { return !this.matches(':disabled'); }
  get ownerDocument() { return document; }
  get nextSibling(): ElementStub | null { const siblings = this.parentElement?.children ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
  constructor(readonly tag = 'input') {}
  append(...children: ElementStub[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  insertBefore(child: ElementStub, before: ElementStub | null) {
    child.parentElement = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
  }
  remove() { const siblings = this.parentElement?.children; if (siblings) siblings.splice(siblings.indexOf(this), 1); this.parentElement = null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector === ':disabled') {
      for (let node: ElementStub | null = this; node; node = node.parentElement) {
        if (node.disabled && (node === this || node.tag === 'fieldset')) return true;
      }
      return false;
    }
    if (selector === '[hidden]') return this.hidden;
    if (selector === '[inert]') return this.inert;
    if (selector === '[name]') return !!this.name;
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === 'button[data-stagecraft-action]') return this.tag === 'button' && this.dataset.stagecraftAction !== undefined;
    const name = selector.match(/^\[name="([^"]+)"\]$/); if (name) return this.name === name[1];
    const data = selector.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/);
    if (!data) return false;
    const key = data[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return key in this.dataset && (data[2] === undefined || this.dataset[key] === data[2]);
  }
  closest(selector: string): ElementStub | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector: string): ElementStub[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): ElementStub | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { (document as unknown as { activeElement: ElementStub }).activeElement = this; }
  click() { this.clickCount++; this.onClick?.(); }
  checkValidity(): never { throw new Error('Use the native validity state without firing invalid events during edits.'); }
  reportValidity() { this.reportCount++; return this.validity.valid; }
}

function setup(t: TestContext) {
  const body = new ElementStub('body');
  const fakeDocument = { body, activeElement: body as ElementStub | null, createElement: (tag: string) => new ElementStub(tag) };
  for (const [key, value] of Object.entries({ document: fakeDocument, HTMLElement: ElementStub, Element: ElementStub })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const root = new ElementStub('div'), row = new ElementStub('label'), input = new ElementStub();
  input.name = 'bars-height'; input.value = '12'; row.append(input); root.append(row);
  return { root, row, input, fakeDocument, fields: [input as unknown as ValidatedField] };
}

test('required and range reasons remain native, inline and associated; descriptions survive recovery', t => {
  const f = setup(t), validation = new FormValidation();
  f.input.setAttribute('aria-describedby', 'bounds-hint units-hint');
  f.input.nativeReason = 'Please fill out this field.';
  assert.deepEqual(validation.check(f.fields), f.fields);
  assert.equal(f.row.children.length, 1, 'typing does not reveal new errors');
  validation.check(f.fields, f.fields);
  const error = f.row.children[1]!;
  assert.equal(error.textContent, f.input.nativeReason);
  assert.equal(error.getAttribute('aria-hidden'), 'true', 'inline message is excluded from the wrapping label name');
  assert.equal(f.input.getAttribute('aria-invalid'), 'true');
  assert.equal(f.input.getAttribute('aria-describedby'), `bounds-hint units-hint ${error.id}`, 'direct reference exposes the message as description once');
  assert.equal(f.input.reportCount, 0);
  f.input.nativeReason = 'Value must be less than or equal to 50.';
  validation.check(f.fields);
  assert.equal(f.row.children.length, 2);
  assert.equal(error.textContent, f.input.nativeReason);
  f.input.setAttribute('aria-describedby', `${f.input.getAttribute('aria-describedby')} new-hint`);
  f.input.nativeReason = '';
  assert.deepEqual(validation.check(f.fields), []);
  assert.equal(f.input.getAttribute('aria-invalid'), null);
  assert.equal(f.input.getAttribute('aria-describedby'), 'bounds-hint units-hint new-hint');
  assert.equal(f.row.children.length, 1);
});

test('conditional hidden, disabled and removed controls clear errors; enabled tab pages keep constraints', t => {
  const f = setup(t), validation = new FormValidation();
  f.input.nativeReason = 'Please fill out this field.';
  validation.check(f.fields, true);
  f.row.hidden = true;
  assert.deepEqual(validation.check(f.fields), []);
  assert.equal(f.input.getAttribute('aria-describedby'), null);
  f.row.dataset.stagecraftClipSectionPage = 'timing';
  assert.deepEqual(validation.check(f.fields), f.fields, 'inactive tab values still require validation');
  validation.check(f.fields, true);
  f.input.disabled = true;
  assert.deepEqual(validation.check(f.fields), []);
  assert.equal(f.row.children.length, 1);
  f.input.disabled = false;
  f.row.hidden = false;
  validation.check(f.fields, true);
  f.input.isConnected = false;
  validation.refresh();
  assert.equal(f.input.getAttribute('aria-invalid'), null);
  f.input.isConnected = true;
  validation.check(f.fields, true);
  validation.check([]);
  assert.equal(f.input.getAttribute('aria-invalid'), null);
  validation.check(f.fields, true);
  validation.clearAll();
  assert.equal(f.row.children.length, 1);
});

test('a disabled fieldset and native barred controls do not create validation errors', t => {
  const f = setup(t), validation = new FormValidation(), fieldset = new ElementStub('fieldset');
  f.row.remove(); fieldset.append(f.row); f.root.append(fieldset);
  f.input.nativeReason = 'Please fill out this field.';
  validation.check(f.fields, true);
  fieldset.disabled = true;
  validation.refresh();
  assert.equal(f.input.getAttribute('aria-invalid'), null);
  assert.deepEqual(validation.check(f.fields, true), []);
  fieldset.disabled = false;
  f.input.type = 'hidden';
  assert.deepEqual(validation.check(f.fields, true), []);
});

test('file path errors follow the entire picker row and preserve existing aria-invalid state', t => {
  const f = setup(t), validation = new FormValidation(), picker = new ElementStub('div'), browse = new ElementStub('button');
  picker.className = 'stagecraft-file-field';
  f.input.remove(); picker.append(f.input, browse); f.row.append(picker);
  f.input.nativeReason = 'Please fill out this field.';
  f.input.setAttribute('aria-invalid', 'false');
  validation.check(f.fields, true);
  assert.deepEqual(picker.children, [f.input, browse], 'message does not split the flex row');
  assert.equal(f.row.children[1]!.textContent, f.input.nativeReason);
  validation.clearAll();
  assert.equal(f.input.getAttribute('aria-invalid'), 'false');
});

function editor(t: TestContext) {
  const f = setup(t);
  let id = 0, writes = 0;
  const services: EditorServices = {
    makeId: () => `validation-${++id}`,
    repository: { list: async () => [], read: async () => null,
      save: async value => { writes++; return { ...value, revision: value.revision + 1 }; }, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }),
    localize: key => key, confirmDiscard: async () => true, confirmDeleteSequence: async () => false,
    observeLocal: () => () => {}, prepareGroup: async () => {}, openSession() {},
    groupActive: () => false, chooseVideo: async () => null, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services);
  view.draft.create('Validation');
  const driver = view as unknown as {
    root: HTMLElement; mounted: boolean; selectedId: string; invalid: boolean; busy: boolean;
    act(action: string): Promise<void>; readForm(field?: string, previewOnly?: boolean): boolean;
    checkFormFields(show?: true | readonly ValidatedField[]): ValidatedField[];
    updateButtons(): void; paintInspector(): void; paint(): void; drawStill(): void;
    perform(work: () => Promise<void>): Promise<void>;
  };
  driver.root = f.root as unknown as HTMLElement; driver.mounted = true;
  driver.selectedId = view.draft.draft!.clips[0]!.id;
  // The harness omits unrelated renderer/picker DOM, retaining real form reads,
  // domain validation, draft history, Save, playback validation and button states.
  driver.paintInspector = () => {}; driver.paint = () => {}; driver.drawStill = () => {};
  const save = new ElementStub('button'); save.dataset.stagecraftAction = 'save';
  const preview = new ElementStub('button'); preview.dataset.stagecraftAction = 'preview';
  f.root.append(save, preview);
  return { ...f, services, view, driver, save, preview, writes: () => writes };
}

test('invalid Save stays reachable, reveals the relevant tabs, focuses/reports once and does not save', async t => {
  const f = editor(t), source = structuredClone(f.view.draft.draft);
  const page = new ElementStub('div'), section = new ElementStub('div');
  page.dataset.stagecraftInspectorPage = 'clip'; page.hidden = true;
  section.dataset.stagecraftClipSectionPage = 'timing'; section.hidden = true;
  f.row.remove(); section.append(f.row); page.append(section); f.root.append(page);
  const tab = new ElementStub('button'); tab.dataset.stagecraftInspectorTab = 'clip'; tab.onClick = () => { page.hidden = false; };
  const sectionTab = new ElementStub('button'); sectionTab.dataset.stagecraftClipSectionTab = 'timing'; sectionTab.onClick = () => { section.hidden = false; };
  f.root.append(tab, sectionTab);
  f.input.value = '99'; f.input.nativeReason = 'Value must be less than or equal to 50.';
  assert.equal(f.driver.readForm('bars-height'), false);
  assert.equal(f.save.disabled, false);
  assert.equal(f.preview.disabled, true);
  assert.equal(f.row.children.length, 1);
  await f.driver.act('save');
  assert.equal(f.writes(), 0);
  assert.deepEqual(f.view.draft.draft, source);
  assert.equal(f.input.getAttribute('aria-invalid'), 'true');
  assert.equal(f.row.children[1]!.textContent, f.input.nativeReason);
  assert.equal(f.fakeDocument.activeElement, f.input);
  assert.equal(f.input.reportCount, 1);
  assert.equal(page.hidden, false); assert.equal(section.hidden, false);
  assert.equal(tab.clickCount, 1); assert.equal(sectionTab.clickCount, 1);
  f.input.value = '13'; f.input.nativeReason = '';
  assert.equal(f.driver.readForm('bars-height'), true);
  assert.equal(f.input.getAttribute('aria-invalid'), null);
  assert.equal(f.preview.disabled, false);
  await f.driver.act('save');
  assert.equal(f.writes(), 1);
  assert.equal(f.input.reportCount, 1, 'valid Save never invokes a native popup');
});

test('valid numeric preview retains draft state; grouped commits still produce one undo step', t => {
  const f = editor(t), source = structuredClone(f.view.draft.draft);
  f.input.value = '14';
  assert.equal(f.driver.readForm('bars-height', true), true);
  assert.deepEqual(f.view.draft.draft, source);
  (f.driver as unknown as { fieldHistoryGroup: string }).fieldHistoryGroup = 'one-drag';
  assert.equal(f.driver.readForm('bars-height'), true);
  f.input.value = '15';
  assert.equal(f.driver.readForm('bars-height'), true);
  assert.equal(f.view.draft.canUndo, true);
  assert.deepEqual(f.view.draft.undo(), source);
  assert.equal(f.view.draft.canUndo, false);
  assert.equal(f.writes(), 0);
});

test('valid Save persists edited values and never reports validity', async t => {
  const f = editor(t);
  f.input.value = '17';
  let saved: SequenceV1 | undefined;
  const originalSave = f.services.repository.save;
  f.services.repository.save = async (...args) => { saved = args[0]; return originalSave(...args); };
  await f.driver.act('save');
  assert.equal(f.writes(), 1);
  assert.ok(saved);
  const bars = saved.clips.find(clip => clip.type === 'bars')!;
  assert.equal(bars.properties.heightFraction, 0.17);
  assert.equal(f.input.reportCount, 0);
  assert.equal(f.row.children.length, 1);
});

test('chooser actions validate before disabling the inspector and retain existing errors without committing invalid edits', async t => {
  const f = editor(t), inspector = new ElementStub('fieldset'), source = structuredClone(f.view.draft.draft);
  inspector.dataset.stagecraftInspector = '';
  f.row.remove(); inspector.append(f.row); f.root.append(inspector);
  let chooserCalls = 0;
  const choose = async () => { chooserCalls++; assert.equal(inspector.disabled, true); };
  Object.assign(f.driver, { chooseVideo: choose, chooseImage: choose, chooseAudio: choose,
    chooseButtonTexture: choose, chooseSolidAlpha: choose, applySolidAlphaPath: () => { chooserCalls++; } });
  f.input.value = '14.5';
  f.input.nativeReason = 'Please enter a valid value. The two nearest valid values are 14 and 15.';
  f.driver.checkFormFields(true);
  const error = f.row.children[1]!;
  for (const action of ['choose-video', 'choose-image', 'choose-audio', 'choose-button-texture', 'choose-solid-alpha', 'clear-solid-alpha']) {
    await f.driver.act(action);
    assert.equal(chooserCalls, 0, `${action} cannot bypass an invalid enabled field`);
    assert.equal(inspector.disabled, false);
    assert.equal(f.row.children[1], error, `${action} preserves the visible error node`);
    assert.equal(f.input.getAttribute('aria-invalid'), 'true');
    assert.deepEqual(f.view.draft.draft, source, `${action} keeps the last valid draft`);
  }
  f.input.nativeReason = '';
  await f.driver.act('choose-image');
  assert.equal(chooserCalls, 1);
  assert.equal(f.input.getAttribute('aria-invalid'), null);
  const bars = f.view.draft.draft!.clips.find(clip => clip.type === 'bars')!;
  assert.equal(bars.properties.heightFraction, 0.145);
  assert.equal(f.input.reportCount, 0);
});

test('Browse recovers an empty own path while other invalid fields still block it and required is restored', async t => {
  for (const type of ['image', 'video', 'audio', 'button', 'solid'] as const) {
    const f = editor(t), inspector = new ElementStub('fieldset');
    inspector.dataset.stagecraftInspector = '';
    f.row.remove(); inspector.append(f.row); f.root.append(inspector);
    let nextId = 0;
    const makeId = () => `browse-${type}-${++nextId}`;
    let sequence = applyTimelineCommand(f.view.draft.draft!, { kind: 'add-track', trackKind: type === 'audio' ? 'audio' : 'visual' }, makeId);
    sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type, trackId: sequence.tracks.at(-1)!.id,
      startMs: 0, sourcePath: `existing-${type}.webm`, sourceDurationMs: 5_000 }, makeId);
    const added = sequence.clips.at(-1)!;
    if (added.type === 'button') sequence = applyTimelineCommand(sequence, { kind: 'replace-clip', clip: {
      ...added, properties: { ...added.properties, texture: { kind: 'foundry-file', path: 'existing-button.png', fit: 'contain' } }
    } }, makeId);
    else if (added.type === 'solid') {
      assert.ok(added.typeVersion === 1);
      sequence = applyTimelineCommand(sequence, { kind: 'replace-clip', clip: {
        ...added, properties: { ...added.properties, alphaMap: { kind: 'foundry-file', path: 'existing-solid.png' } }
      } }, makeId);
    }
    f.view.draft.replace(sequence);
    const clip = sequence.clips.at(-1)!;
    f.driver.selectedId = clip.id;
    const path = new ElementStub(); path.name = type === 'button' ? 'button-texture-path' : type === 'solid' ? 'solid-alpha-path' : `${type}-path`;
    path.type = 'text'; path.value = ''; path.required = type !== 'solid'; inspector.append(path);
    // Represent the browser's required-field state as this test toggles the
    // chooser's temporary exemption, without reimplementing other constraints.
    Object.defineProperty(path, 'validity', { get: () => ({ valid: !path.required || path.value !== '' }) });
    Object.defineProperty(path, 'validationMessage', { get: () => path.validity.valid ? '' : 'Please fill out this field.' });
    const action = type === 'button' ? 'choose-button-texture' : type === 'solid' ? 'choose-solid-alpha' : `choose-${type}`;
    const method = type === 'button' ? 'chooseButtonTexture' : type === 'image' ? 'chooseImage' : type === 'audio' ? 'chooseAudio' : type === 'solid' ? 'chooseSolidAlpha' : 'chooseVideo';
    let calls = 0;
    Object.assign(f.driver, { [method]: async () => { calls++; assert.equal(inspector.disabled, true); } });
    f.input.nativeReason = 'Please enter a valid value.';
    f.driver.checkFormFields(true);
    const otherError = f.row.children[1]!;
    await f.driver.act(action);
    assert.equal(calls, 0, `${type} Browse still validates unrelated fields`);
    assert.equal(f.row.children[1], otherError);
    assert.equal(path.required, type !== 'solid');
    assert.equal(path.value, '');
    f.input.nativeReason = '';
    await f.driver.act(action);
    assert.equal(calls, 1, `${type} Browse remains available for its own empty source`);
    assert.equal(path.required, type !== 'solid');
    assert.equal(path.value, '', 'cancelling Browse preserves the entered path text');
    const current = f.view.draft.draft!.clips.find(item => item.id === clip.id)!;
    if (current.type === 'image' || current.type === 'audio' || current.type === 'video') {
      assert.equal(current.properties.source.path, `existing-${type}.webm`, 'empty form text never enters the valid draft');
    } else if (current.type === 'button') assert.deepEqual(current.properties.texture, { kind: 'foundry-file', path: 'existing-button.png', fit: 'contain' }, 'cancel keeps the authored file texture and fit');
    else if (current.type === 'solid') assert.deepEqual(current.properties.alphaMap, { kind: 'foundry-file', path: 'existing-solid.png' }, 'cancel keeps the authored alpha map');
    assert.equal(path.reportCount, 0);
  }
});

test('perform restores a disabled opener after dialog cancellation without overriding deliberate focus', async t => {
  const f = editor(t), opener = f.save;
  opener.focus();
  await f.driver.perform(async () => {
    assert.equal(opener.disabled, true);
    f.fakeDocument.activeElement = f.fakeDocument.body;
  });
  assert.equal(opener.disabled, false);
  assert.equal(f.fakeDocument.activeElement, opener);
  opener.focus();
  await f.driver.perform(async () => { f.input.focus(); });
  assert.equal(f.fakeDocument.activeElement, f.input);
  for (const unavailable of ['hidden', 'inert', 'isConnected'] as const) {
    opener.hidden = false; opener.inert = false; opener.isConnected = true;
    opener.focus();
    await f.driver.perform(async () => {
      opener[unavailable] = unavailable !== 'isConnected';
      f.fakeDocument.activeElement = f.fakeDocument.body;
    });
    assert.equal(f.fakeDocument.activeElement, f.fakeDocument.body, `do not restore ${unavailable} opener`);
  }
});
