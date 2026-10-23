import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { ClipInspectorSections } from '../src/ui/clip-inspector-sections.js';
import { InspectorTabs } from '../src/ui/inspector-tabs.js';

type Section = 'content' | 'animation' | 'timing';
type ClipType = 'bars' | 'text' | 'image' | 'video' | 'audio';
const clipTypes: readonly ClipType[] = ['bars', 'text', 'image', 'video', 'audio'];
const sections: readonly Section[] = ['content', 'animation', 'timing'];

class FakeDocument {
  activeElement: FakeElement | null = null;
}

class FakeElement extends EventTarget {
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  ownerDocument: FakeDocument;
  hidden = false;
  disabled = false;
  tabIndex = 0;
  scrollTop = 0;
  value = '';
  id = '';

  constructor(readonly tag = 'div', document = new FakeDocument()) {
    super();
    this.ownerDocument = document;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement?.removeChild(node);
      node.parentElement = this;
      node.setOwnerDocument(this.ownerDocument);
      this.children.push(node);
    }
  }

  removeChild(node: FakeElement): void {
    this.children = this.children.filter(child => child !== node);
    node.parentElement = null;
  }

  contains(node: unknown): boolean {
    return node === this || this.children.some(child => child.contains(node));
  }

  matches(selector: string): boolean {
    const match = selector.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/);
    if (!match) return false;
    const key = match[1]!.replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase());
    return key in this.dataset && (match[2] === undefined || this.dataset[key] === match[2]);
  }

  closest<T>(selector: string): T | null {
    return this.matches(selector) ? this as unknown as T : this.parentElement?.closest<T>(selector) ?? null;
  }

  querySelectorAll<T>(selector: string): T[] {
    const found: T[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child as unknown as T);
      found.push(...child.querySelectorAll<T>(selector));
    }
    return found;
  }

  querySelector<T>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? (name === 'id' && this.id ? this.id : null);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'id') this.id = '';
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  private setOwnerDocument(document: FakeDocument): void {
    this.ownerDocument = document;
    for (const child of this.children) child.setOwnerDocument(document);
  }
}

function fixture(t: TestContext, options: {
  types?: readonly ClipType[];
  includeShared?: boolean;
  timingTypes?: readonly ClipType[];
  beforeChange?: (from: Section | null, to: Section | null) => void;
} = {}) {
  const doc = new FakeDocument();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  const root = new FakeElement('div', doc);
  const toolbar = new FakeElement('div', doc); toolbar.dataset.stagecraftClipSectionTabs = '';
  root.append(toolbar);
  const tabs = new Map<Section, FakeElement>();
  for (const section of sections) {
    const tab = new FakeElement('button', doc); tab.dataset.stagecraftClipSectionTab = section;
    toolbar.append(tab); tabs.set(section, tab);
  }
  const inspector = new FakeElement('div', doc); inspector.dataset.stagecraftInspector = '';
  root.append(inspector);
  const clipPage = new FakeElement('section', doc); clipPage.dataset.stagecraftInspectorPage = 'clip';
  inspector.append(clipPage);
  const pages = new Map<string, FakeElement>();
  const contentFields = new Map<ClipType, FakeElement>();
  const types = options.types ?? clipTypes;
  const timingTypes = options.timingTypes ?? types;
  for (const type of types) {
    const panel = new FakeElement('fieldset', doc); panel.dataset.stagecraftElementPanel = type;
    clipPage.append(panel);
    for (const section of sections) {
      if (section === 'timing' && !timingTypes.includes(type)) continue;
      const page = new FakeElement('div', doc); page.dataset.stagecraftClipSectionPage = section;
      page.id = `stagecraft-clip-${type}-${section}`;
      panel.append(page);
      pages.set(`${type}-${section}`, page);
      if (section === 'content') {
        const field = new FakeElement('input', doc);
        field.value = `value-${type}`;
        field.disabled = true;
        page.append(field);
        contentFields.set(type, field);
      }
    }
  }
  if (options.includeShared) {
    const page = new FakeElement('div', doc); page.dataset.stagecraftClipSectionPage = 'timing'; page.dataset.stagecraftClipSectionShared = '';
    page.id = 'stagecraft-clip-shared-timing'; clipPage.append(page); pages.set('shared-timing', page);
  }
  const breakPanel = new FakeElement('section', doc); breakPanel.dataset.stagecraftBreakPanel = '';
  clipPage.append(breakPanel);
  const breakTiming = new FakeElement('div', doc); breakTiming.dataset.stagecraftClipSectionPage = 'timing';
  breakTiming.id = 'stagecraft-clip-break-timing'; breakPanel.append(breakTiming); pages.set('break-timing', breakTiming);

  const dispatchKey = (target: FakeElement, key: string): Event => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(event, { key: { value: key }, target: { value: target } });
    toolbar.dispatchEvent(event);
    return event;
  };
  const click = (target: FakeElement): void => { target.dispatchEvent(new Event('click')); };
  const controller = new ClipInspectorSections(root as unknown as HTMLElement, options.beforeChange);
  t.after(() => controller.dispose());
  return { root, toolbar, tabs, inspector, clipPage, pages, contentFields, dispatchKey, click, controller, doc };
}

test('clip section pages resolve independently for each supported clip type', t => {
  const f = fixture(t);
  for (const type of clipTypes) {
    f.controller.setSelection(type, `${type}-clip`);
    assert.equal(f.toolbar.hidden, false);
    assert.equal(f.pages.get(`${type}-content`)!.hidden, false, `${type} Content is active by default`);
    for (const section of sections.slice(1)) assert.equal(f.pages.get(`${type}-${section}`)!.hidden, true);
    for (const otherType of clipTypes.filter(candidate => candidate !== type)) {
      for (const section of sections) assert.equal(f.pages.get(`${otherType}-${section}`)!.hidden, true);
    }
    assert.equal(f.tabs.get('content')!.getAttribute('aria-controls'), `stagecraft-clip-${type}-content`);
    assert.equal(f.tabs.get('content')!.getAttribute('aria-selected'), 'true');
    assert.equal(f.tabs.get('content')!.tabIndex, 0);
    assert.equal(f.tabs.get('animation')!.tabIndex, -1);
  }
});

test('Break exposes only its scoped Timing page and null hides the category toolbar', t => {
  const f = fixture(t, { includeShared: true });
  f.controller.setSelection('break', 'marker-a');
  assert.equal(f.toolbar.hidden, false);
  assert.equal(f.tabs.get('content')!.hidden, true);
  assert.equal(f.tabs.get('animation')!.hidden, true);
  assert.equal(f.tabs.get('timing')!.hidden, false);
  assert.equal(f.tabs.get('timing')!.getAttribute('aria-controls'), 'stagecraft-clip-break-timing');
  assert.equal(f.pages.get('break-timing')!.hidden, false);
  assert.equal(f.pages.get('shared-timing')!.hidden, true);
  const singleTabArrow = f.dispatchKey(f.tabs.get('timing')!, 'ArrowRight');
  assert.equal(singleTabArrow.defaultPrevented, false);

  f.controller.setSelection(null);
  assert.equal(f.toolbar.hidden, true);
  assert.ok([...f.pages.values()].every(page => page.hidden));
  assert.ok([...f.tabs.values()].every(tab => tab.getAttribute('aria-controls') === null && tab.tabIndex === -1));
});

test('same clip keeps its category and each category scroll position; a new identity resets Content', t => {
  const f = fixture(t);
  f.controller.setSelection('text', 'clip-a');
  const contentTab = f.tabs.get('content')!;
  const animationTab = f.tabs.get('animation')!;
  const timingTab = f.tabs.get('timing')!;
  f.inspector.scrollTop = 11;
  f.click(animationTab);
  assert.equal(f.inspector.scrollTop, 0);
  f.inspector.scrollTop = 22;
  f.click(timingTab);
  f.inspector.scrollTop = 0;
  f.inspector.scrollTop = 33;
  f.click(contentTab);
  assert.equal(f.inspector.scrollTop, 11);
  f.inspector.scrollTop = 17;

  f.controller.setSelection('text', 'clip-a');
  assert.equal(f.tabs.get('content')!.getAttribute('aria-selected'), 'true');
  assert.equal(f.inspector.scrollTop, 17, 'paint with the same selection preserves the live scroll offset');
  f.controller.setSelection('text', 'clip-b');
  assert.equal(f.tabs.get('content')!.getAttribute('aria-selected'), 'true');
  assert.equal(f.inspector.scrollTop, 0);
  assert.equal(f.pages.get('text-content')!.hidden, false);
});

test('keyboard arrows, Home and End update focus, selection, and active page', t => {
  const f = fixture(t);
  f.controller.setSelection('image', 'image-a');
  const arrow = f.dispatchKey(f.tabs.get('content')!, 'ArrowRight');
  assert.equal(arrow.defaultPrevented, true);
  assert.equal(f.doc.activeElement, f.tabs.get('animation'));
  assert.equal(f.tabs.get('animation')!.getAttribute('aria-selected'), 'true');
  assert.equal(f.pages.get('image-animation')!.hidden, false);

  f.dispatchKey(f.tabs.get('animation')!, 'ArrowDown');
  assert.equal(f.tabs.get('timing')!.getAttribute('aria-selected'), 'true');
  f.dispatchKey(f.tabs.get('timing')!, 'End');
  assert.equal(f.tabs.get('timing')!.getAttribute('aria-selected'), 'true');
  f.dispatchKey(f.tabs.get('timing')!, 'Home');
  assert.equal(f.doc.activeElement, f.tabs.get('content'));
  assert.equal(f.pages.get('image-content')!.hidden, false);
  const up = f.dispatchKey(f.tabs.get('content')!, 'ArrowUp');
  assert.equal(up.defaultPrevented, true);
  assert.equal(f.tabs.get('timing')!.getAttribute('aria-selected'), 'true', 'arrows wrap across available categories');
});

test('typed and shared Timing pages stay scoped together; shared Timing is a fallback when no typed page exists', t => {
  const f = fixture(t, { includeShared: true });
  f.controller.setSelection('text', 'text-a');
  f.click(f.tabs.get('timing')!);
  assert.equal(f.tabs.get('timing')!.getAttribute('aria-controls'), 'stagecraft-clip-text-timing stagecraft-clip-shared-timing');
  assert.equal(f.pages.get('text-timing')!.hidden, false);
  assert.equal(f.pages.get('image-timing')!.hidden, true);
  assert.equal(f.pages.get('shared-timing')!.hidden, false);
});

test('shared Timing page supplies the track controls when a type has no Timing page', t => {
  const fallback = fixture(t, { types: ['audio'], timingTypes: [], includeShared: true });
  fallback.controller.setSelection('audio', 'audio-a');
  assert.equal(fallback.tabs.get('timing')!.getAttribute('aria-controls'), 'stagecraft-clip-shared-timing');
  fallback.click(fallback.tabs.get('timing')!);
  assert.equal(fallback.pages.get('shared-timing')!.hidden, false);
  assert.equal(fallback.pages.get('break-timing')!.hidden, true);
});

test('category switching retains field values and disabled state, and dispose removes listeners', t => {
  const f = fixture(t);
  f.controller.setSelection('bars', 'bars-a');
  const field = f.contentFields.get('bars')!;
  let committed = false;
  field.addEventListener('change', () => { committed = true; });
  field.focus();
  f.click(f.tabs.get('animation')!);
  assert.equal(f.doc.activeElement, f.tabs.get('animation'), 'programmatic category changes move focus out of a page they hide');
  f.click(f.tabs.get('content')!);
  assert.equal(field.value, 'value-bars');
  assert.equal(field.disabled, true);
  assert.equal(committed, false);

  f.controller.dispose();
  f.click(f.tabs.get('animation')!);
  assert.equal(f.tabs.get('content')!.getAttribute('aria-selected'), 'true');
  assert.equal(f.pages.get('bars-content')!.hidden, false);
});

test('changing selection moves focus out of a category page that becomes hidden', t => {
  const f = fixture(t);
  f.controller.setSelection('video', 'video-a');
  const animationPage = f.pages.get('video-animation')!;
  const focusedControl = new FakeElement('input', f.doc);
  animationPage.append(focusedControl);
  f.click(f.tabs.get('animation')!);
  focusedControl.focus();

  f.controller.setSelection('video', 'video-b');
  assert.equal(animationPage.hidden, true);
  assert.equal(f.doc.activeElement, f.tabs.get('content'));
});

test('beforeChange runs only for an actual user category switch', t => {
  const changes: [Section | null, Section | null][] = [];
  const f = fixture(t, { beforeChange: (from, to) => { changes.push([from, to]); } });
  f.controller.setSelection('text', 'clip-a');
  f.controller.setSelection('text', 'clip-b');
  assert.deepEqual(changes, [], 'selection paints and identity resets do not invoke the callback');
  f.click(f.tabs.get('animation')!);
  assert.deepEqual(changes, [['content', 'animation']]);
  f.controller.setSelection('text', 'clip-c');
  assert.deepEqual(changes, [['content', 'animation']], 'the callback is reserved for tab-driven category changes');
});

test('InspectorTabs notifies optional listeners after activation and remains compatible without one', () => {
  const makeRoot = () => {
    const doc = new FakeDocument();
    const root = new FakeElement('div', doc);
    const inspector = new FakeElement('div', doc); inspector.dataset.stagecraftInspector = ''; root.append(inspector);
    const tabs = new Map<'clip' | 'sequence', FakeElement>();
    for (const name of ['clip', 'sequence'] as const) {
      const tab = new FakeElement('button', doc); tab.dataset.stagecraftInspectorTab = name;
      const page = new FakeElement('section', doc); page.dataset.stagecraftInspectorPage = name;
      root.append(tab); inspector.append(page); tabs.set(name, tab);
    }
    return { root, tabs };
  };

  const f = makeRoot(), changes: string[] = [];
  const withCallback = new InspectorTabs(f.root as unknown as HTMLElement, tab => changes.push(tab));
  assert.deepEqual(changes, ['clip'], 'initial activation reports the visible Clip page');
  f.tabs.get('sequence')!.dispatchEvent(new Event('click'));
  assert.deepEqual(changes, ['clip', 'sequence']);
  withCallback.dispose();

  const legacy = makeRoot();
  const withoutCallback = new InspectorTabs(legacy.root as unknown as HTMLElement);
  legacy.tabs.get('sequence')!.dispatchEvent(new Event('click'));
  assert.equal(legacy.root.querySelector<HTMLElement>('[data-stagecraft-inspector-page="sequence"]')!.hidden, false);
  withoutCallback.dispose();
});
