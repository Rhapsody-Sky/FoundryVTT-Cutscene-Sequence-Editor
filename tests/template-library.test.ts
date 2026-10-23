import test from 'node:test';
import assert from 'node:assert/strict';
import type { SequenceV1, TextClip, VideoClip } from '../src/domain/sequence.js';
import { createElementTemplate, createAnimationTemplate, type TemplateEnvelopeV1 } from '../src/domain/element-template.js';
import type { TemplateRepository, TemplateSummary } from '../src/application/template-ports.js';
import { TemplateService } from '../src/application/template-service.js';
import { createBarsSequence } from '../src/domain/validation.js';
import { TemplateLibraryView, type TemplateLibraryOptions, type TemplateLibrarySelection } from '../src/ui/template-library.js';

type Listener = (event: Event) => void;

class FixtureElement {
  readonly children: FixtureElement[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly dataset: Record<string, string> = {};
  parent: FixtureElement | null = null;
  className = '';
  textContent = '';
  title = '';
  type = '';
  value = '';
  disabled = false;
  selected = false;
  connectedRoot = false;
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  get isConnected(): boolean {
    let node: FixtureElement = this;
    while (node.parent) node = node.parent;
    return node.connectedRoot;
  }

  append(...nodes: FixtureElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
      if (this.tagName === 'SELECT' && node.tagName === 'OPTION' && node.selected) this.value = node.value;
    }
  }

  replaceChildren(...nodes: FixtureElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  contains(target: FixtureElement): boolean {
    for (let node: FixtureElement | null = target; node; node = node.parent) if (node === this) return true;
    return false;
  }

  matches(selector: string): boolean {
    if (selector === 'button[data-template-action]') return this.tagName === 'BUTTON' && this.dataset.templateAction !== undefined;
    if (selector === '[data-template-name]') return this.dataset.templateName !== undefined;
    if (selector === '[data-template-source-phase]') return this.dataset.templateSourcePhase !== undefined;
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return false;
  }

  closest<T extends FixtureElement>(selector: string): T | null {
    for (let node: FixtureElement | null = this; node; node = node.parent) if (node.matches(selector)) return node as T;
    return null;
  }

  querySelector<T extends FixtureElement>(selector: string): T | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child as T;
      const nested = child.querySelector<T>(selector);
      if (nested) return nested;
    }
    return null;
  }

  click(): void {
    const event = { target: this, preventDefault() {} } as unknown as Event;
    for (let node: FixtureElement | null = this; node; node = node.parent) {
      for (const listener of node.listeners.get('click') ?? []) listener(event);
    }
  }
}

class FixtureInput extends FixtureElement {
  constructor() { super('INPUT'); }
}

class FixtureSelect extends FixtureElement {
  constructor() { super('SELECT'); }
}

function installDOMFixture(): FixtureElement {
  const body = new FixtureElement('BODY');
  body.connectedRoot = true;
  const fakeDocument = {
    createElement(tag: string): FixtureElement {
      if (tag === 'input') return new FixtureInput();
      if (tag === 'select') return new FixtureSelect();
      return new FixtureElement(tag.toUpperCase());
    },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: FixtureElement });
  Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: FixtureInput });
  Object.defineProperty(globalThis, 'HTMLSelectElement', { configurable: true, value: FixtureSelect });
  return body;
}

function makeSequence(): SequenceV1 {
  let id = 0;
  return createBarsSequence('Template view test', () => `sequence-${++id}`, 3);
}

function video(): VideoClip {
  return {
    id: 'video-source', trackId: 'visual', type: 'video', typeVersion: 1, startMs: 0,
    duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: {
      source: { kind: 'foundry-file', path: 'worlds/test/video.webm' }, fit: 'contain', volume: 1, muted: false,
    },
  };
}

function textClip(id: string): TextClip {
  return {
    id, trackId: 'visual', type: 'text', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: {
      text: id, fontFamily: 'sans-serif', fontSize: 48, minimumFontSize: 1, color: '#ffffff', align: 'center',
      box: { x: 0, y: 0, width: 1_920, height: 1_080 }, shrinkToFit: true,
    },
  };
}

function repoFor(
  template: TemplateEnvelopeV1,
  summary: TemplateSummary,
  overrides: Partial<TemplateRepository> = {},
): TemplateRepository {
  return {
    async list() { return [summary]; },
    async read() { return structuredClone(template); },
    async save(value) { return structuredClone(value); },
    async delete() {},
    ...overrides,
  };
}

function findAction(root: FixtureElement, action: string): FixtureElement | undefined {
  for (const child of root.children) {
    if (child.dataset.templateAction === action) return child;
    const nested = findAction(child, action);
    if (nested) return nested;
  }
  return undefined;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30 && !predicate(); attempt += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  assert.ok(predicate(), 'fixture did not reach the expected async state');
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function makeView(
  repository: TemplateRepository,
  extra: Partial<TemplateLibraryOptions> = {},
): TemplateLibraryView {
  const options: TemplateLibraryOptions = {
    service: extra.service ?? new TemplateService(repository, () => 'fresh-clip', async () => 4_000),
    translate: key => key,
    selectedClip: () => undefined,
    placement: () => ({ sequence: makeSequence(), trackId: 'visual', playheadMs: 1_500 }),
    insertElement: () => {},
    replaceSelectedClip: () => {},
    ...extra,
  };
  return new TemplateLibraryView(options);
}

test('detaching while a template read is pending prevents the insertion callback', async () => {
  const body = installDOMFixture();
  const template = createElementTemplate('video-template', 'Video', video(), { width: 1_920, height: 1_080 });
  const summary: TemplateSummary = { id: template.id, revision: 1, name: template.name, kind: 'element', elementType: 'video' };
  const readGate = deferred<unknown>();
  let readCalls = 0;
  let commits = 0;
  const repository = repoFor(template, summary, { async read() { readCalls += 1; return readGate.promise; } });
  const view = makeView(repository, { insertElement: () => { commits += 1; } });
  view.mount(body as unknown as HTMLElement);
  await waitFor(() => findAction(body, 'apply-element') !== undefined);
  findAction(body, 'apply-element')!.click();
  await waitFor(() => readCalls === 1);
  view.detach();
  readGate.resolve(template);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(commits, 0);
});

test('busy state blocks duplicate insertion clicks and passes the placement snapshot to the command callback', async () => {
  const body = installDOMFixture();
  const template = createElementTemplate('video-template', 'Video', video(), { width: 1_920, height: 1_080 });
  const summary: TemplateSummary = { id: template.id, revision: 1, name: template.name, kind: 'element', elementType: 'video' };
  const probeGate = deferred<number>();
  let probeCalls = 0;
  let insertCalls = 0;
  let expectedTrack = '';
  const repository = repoFor(template, summary);
  const view = makeView(repository, {
    service: new TemplateService(repository, () => 'fresh-clip', async (_path, type) => {
      assert.equal(type, 'video');
      probeCalls += 1;
      return probeGate.promise;
    }),
    insertElement: (clip, expected) => {
      insertCalls += 1;
      expectedTrack = expected.trackId;
      assert.equal(clip.id, 'fresh-clip');
    },
  });
  view.mount(body as unknown as HTMLElement);
  await waitFor(() => findAction(body, 'apply-element') !== undefined);
  const firstButton = findAction(body, 'apply-element')!;
  firstButton.click();
  await waitFor(() => probeCalls === 1);
  firstButton.click();
  const disabledButton = findAction(body, 'apply-element');
  disabledButton?.click();
  assert.equal(probeCalls, 1);
  probeGate.resolve(4_000);
  await waitFor(() => insertCalls === 1);
  assert.equal(expectedTrack, 'visual');
  assert.equal(insertCalls, 1);
});

test('a placement change while media duration is re-probed cancels late insertion', async () => {
  const body = installDOMFixture();
  const template = createElementTemplate('video-template', 'Video', video(), { width: 1_920, height: 1_080 });
  const summary: TemplateSummary = { id: template.id, revision: 1, name: template.name, kind: 'element', elementType: 'video' };
  const probeGate = deferred<number>();
  let placement = { sequence: makeSequence(), trackId: 'visual', playheadMs: 1_500 };
  let commits = 0;
  const repository = repoFor(template, summary);
  const view = makeView(repository, {
    service: new TemplateService(repository, () => 'fresh-clip', () => probeGate.promise),
    placement: () => placement,
    insertElement: () => { commits += 1; },
  });
  view.mount(body as unknown as HTMLElement);
  await waitFor(() => findAction(body, 'apply-element') !== undefined);
  findAction(body, 'apply-element')!.click();
  await waitFor(() => findAction(body, 'apply-element')?.disabled === true);
  placement = { ...placement, playheadMs: 2_000 };
  probeGate.resolve(4_000);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(commits, 0);
});

test('a selected clip change after animation read cancels replacement', async () => {
  const body = installDOMFixture();
  const animation = createAnimationTemplate('fade', 'Fade', {
    preset: 'fade', version: 1, durationMs: 400, easing: 'linear',
  }, { width: 1_920, height: 1_080 }, 'text');
  const summary: TemplateSummary = { id: animation.id, revision: 3, name: animation.name, kind: 'animation' };
  const readGate = deferred<unknown>();
  const sequence = makeSequence();
  let selection: TemplateLibrarySelection = { sequence, clip: textClip('first') };
  let replacements = 0;
  const repository = repoFor(animation, summary, { async read() { return readGate.promise; } });
  const view = makeView(repository, {
    selectedClip: () => selection,
    replaceSelectedClip: () => { replacements += 1; },
  });
  view.mount(body as unknown as HTMLElement);
  await waitFor(() => findAction(body, 'apply-entrance') !== undefined);
  findAction(body, 'apply-entrance')!.click();
  await waitFor(() => findAction(body, 'apply-entrance')?.disabled === true);
  selection = { sequence, clip: textClip('second') };
  readGate.resolve(animation);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(replacements, 0);
});

test('delete uses the revision shown in the list so a newer record conflicts safely', async () => {
  const body = installDOMFixture();
  const template = createElementTemplate('video-template', 'Video', video(), { width: 1_920, height: 1_080 });
  const summary: TemplateSummary = { id: template.id, revision: 7, name: template.name, kind: 'element', elementType: 'video' };
  const latestRevision = 9;
  let requestedRevision: number | undefined;
  let reads = 0;
  let deleted = false;
  const repository = repoFor(template, summary, {
    async read() { reads += 1; return template; },
    async delete(_id, expectedRevision) {
      requestedRevision = expectedRevision;
      if (expectedRevision !== latestRevision) throw Object.assign(new Error('revision conflict'), { code: 'CONFLICT' });
      deleted = true;
    },
  });
  const view = makeView(repository, { confirmDelete: async shown => shown.revision === 7 });
  view.mount(body as unknown as HTMLElement);
  await waitFor(() => findAction(body, 'delete') !== undefined);
  findAction(body, 'delete')!.click();
  await waitFor(() => requestedRevision !== undefined);
  assert.equal(requestedRevision, 7);
  assert.equal(latestRevision, 9);
  assert.equal(deleted, false);
  assert.equal(reads, 0);
});
