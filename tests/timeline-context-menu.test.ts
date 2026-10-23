import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineContextMenu } from '../src/ui/timeline-context-menu.js';

class MenuWindow extends EventTarget {
  innerWidth = 800;
  innerHeight = 600;
  private listeners = new Map<string, number>();

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) - 1);
    super.removeEventListener(type, callback, options);
  }

  listenerCount(type: string): number { return this.listeners.get(type) ?? 0; }
}

class MenuElement extends EventTarget {
  parentElement: MenuElement | null = null;
  children: MenuElement[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  type = '';
  disabled = false;
  tabIndex = 0;
  focusCalls = 0;
  focusOptions: FocusOptions | undefined;
  scrollLeft = 0;
  scrollTop = 0;
  attributes = new Map<string, string>();
  width = 220;
  height = 0;
  readonly tagName: string;
  readonly ownerDocument: MenuDocument;
  readonly classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove: (name: string) => { this.className = this.className.split(/\s+/).filter(value => value && value !== name).join(' '); }
  };

  constructor(tagName: string, ownerDocument: MenuDocument) {
    super();
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
  }

  get childElementCount(): number { return this.children.length; }
  get offsetWidth(): number { return this.width; }
  get offsetHeight(): number { return this.height || this.children.reduce((sum, child) => sum + (child.tagName === 'BUTTON' ? 30 : 8), 8); }
  get isConnected(): boolean { return this.ownerDocument.documentElement.contains(this); }

  override dispatchEvent(event: Event): boolean {
    if (!Object.hasOwn(event, 'target')) Object.defineProperty(event, 'target', { configurable: true, value: this });
    const accepted = super.dispatchEvent(event);
    if (!event.cancelBubble) {
      if (this.parentElement) this.parentElement.dispatchEvent(event);
      else this.ownerDocument.dispatchEvent(event);
    }
    return accepted;
  }

  append(...nodes: MenuElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }

  remove(): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  contains(node: unknown): boolean {
    return node === this || this.children.some(child => child.contains(node));
  }

  querySelectorAll(selector: string): MenuElement[] {
    assert.equal(selector, '*');
    return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]);
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  focus(options?: FocusOptions): void { this.focusCalls++; this.focusOptions = options; this.ownerDocument.activeElement = this as unknown as HTMLElement; }
  getBoundingClientRect(): DOMRect {
    const width = this.className.includes('stagecraft-timeline-context-menu') ? this.ownerDocument.menuWidth : this.width;
    const height = this.className.includes('stagecraft-timeline-context-menu') ? this.ownerDocument.menuHeight : this.offsetHeight;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
  }
}

class MenuDocument extends EventTarget {
  readonly defaultView = new MenuWindow();
  readonly documentElement: MenuElement;
  readonly body: MenuElement;
  activeElement: HTMLElement | null = null;
  menuWidth = 220;
  menuHeight = 100;
  private listeners = new Map<string, number>();

  constructor() {
    super();
    this.documentElement = new MenuElement('HTML', this);
    this.body = new MenuElement('BODY', this);
    this.documentElement.append(this.body);
  }

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) - 1);
    super.removeEventListener(type, callback, options);
  }

  createElement(tagName: string): HTMLElement { return new MenuElement(tagName.toUpperCase(), this) as unknown as HTMLElement; }
  listenerCount(type: string): number { return this.listeners.get(type) ?? 0; }
  get scrollingElement(): MenuElement { return this.documentElement; }
}

function fixture() {
  const document = new MenuDocument();
  const root = document.createElement('div') as unknown as MenuElement;
  const anchor = document.createElement('button') as unknown as MenuElement;
  document.body.append(anchor, root);
  const component = new TimelineContextMenu(root as unknown as HTMLElement);
  return { document, root, anchor, component };
}

function menuElement(document: MenuDocument): MenuElement {
  const menu = document.body.children.find(child => child.className.includes('stagecraft-timeline-context-menu'));
  assert.ok(menu, 'context menu exists in the document body');
  return menu;
}

function buttons(menu: MenuElement): MenuElement[] { return menu.children.filter(child => child.tagName === 'BUTTON'); }

test('scrolling the popup keeps it usable while scrolling the background closes it', () => {
  const f = fixture();
  f.component.open({ x: 10, y: 10, items: [{ id: 'one', label: 'One' }], onSelect() {} });
  const popup = menuElement(f.document);
  dispatch(f.document, 'scroll', { target: popup });
  assert.equal(f.component.isOpen, true);
  f.root.scrollTop = 10;
  dispatch(f.document, 'scroll', { target: f.root });
  assert.equal(f.component.isOpen, false);
});

test('queued restored scroll offsets and unrelated inspector scrolling keep the popup open', () => {
  const f = fixture();
  const timelineScroll = new MenuElement('DIV', f.document);
  const breakScroll = new MenuElement('DIV', f.document);
  const inspector = new MenuElement('DIV', f.document);
  f.root.append(timelineScroll, breakScroll); f.document.body.append(inspector);
  timelineScroll.scrollLeft = 400; timelineScroll.scrollTop = 60; breakScroll.scrollLeft = 400;
  f.component.open({ x: 10, y: 10, items: [{ id: 'copy', label: 'Copy' }], onSelect() {} });
  // Browser scroll notifications are queued, so restoration before open can
  // report its unchanged offsets only after the capture listener is installed.
  dispatch(f.document, 'scroll', { target: timelineScroll });
  dispatch(f.document, 'scroll', { target: breakScroll });
  inspector.scrollTop = 200;
  dispatch(f.document, 'scroll', { target: inspector });
  assert.equal(f.component.isOpen, true);
  timelineScroll.scrollLeft = 410;
  dispatch(f.document, 'scroll', { target: timelineScroll });
  assert.equal(f.component.isOpen, false, 'subsequent real timeline movement still dismisses');
});

test('scrolling an ancestor of the timeline closes its popup', () => {
  const f = fixture();
  f.component.open({ x: 10, y: 10, items: [{ id: 'copy', label: 'Copy' }], onSelect() {} });
  f.document.body.scrollTop = 30;
  dispatch(f.document, 'scroll', { target: f.document.body });
  assert.equal(f.component.isOpen, false);
});

function dispatch(target: EventTarget, type: string, properties: Record<string, unknown> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { configurable: true, value });
  target.dispatchEvent(event);
  return event;
}

test('constructs without touching the DOM and opens an accessible, safe body portal', t => {
  const f = fixture();
  const menu = f.component;
  assert.equal(f.document.body.children.length, 2, 'construction does not create menu DOM');
  assert.equal(f.document.listenerCount('pointerdown'), 0, 'construction installs no global listeners');
  t.after(() => menu.dispose());

  menu.open({
    x: 30, y: 40, anchor: f.anchor as unknown as HTMLElement, onSelect: () => {},
    items: [
      { id: 'copy', label: '<img src=x onerror=alert(1)>', icon: 'fa-solid fa-copy', shortcut: 'Ctrl+C' },
      { id: 'locked', label: 'Locked', disabled: true },
      { id: 'remove', label: 'Remove', separatorBefore: true }
    ]
  });

  const popup = menuElement(f.document);
  const itemButtons = buttons(popup);
  assert.equal(popup.parentElement, f.document.body, 'portal avoids the timeline clipping layer');
  assert.equal(popup.getAttribute('role'), 'menu');
  assert.equal(itemButtons[0]!.getAttribute('role'), 'menuitem');
  assert.equal(itemButtons[0]!.children.find(child => child.className.includes('__label'))!.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(itemButtons[0]!.children.find(child => child.className.includes('__shortcut'))!.textContent, 'Ctrl+C');
  assert.equal(itemButtons[0]!.children[0]!.className, 'fa-solid fa-copy');
  assert.equal(itemButtons[1]!.disabled, true);
  assert.equal(itemButtons[1]!.getAttribute('aria-disabled'), 'true');
  assert.equal(popup.children.filter(child => child.getAttribute('role') === 'separator').length, 1);
  assert.equal(f.document.activeElement, itemButtons[0] as unknown as HTMLElement);
  assert.deepEqual(itemButtons[0]!.focusOptions, { preventScroll: true }, 'opening does not move the timeline or viewport');
  assert.equal(menu.isOpen, true);
});

test('arrow keys skip disabled items, wrap, support Home/End, and Escape restores anchor focus', t => {
  const f = fixture();
  let globalKeydowns = 0;
  f.document.addEventListener('keydown', () => globalKeydowns++);
  f.component.open({
    x: 12, y: 14, anchor: f.anchor as unknown as HTMLElement, onSelect: () => {},
    items: [{ id: 'first', label: 'First' }, { id: 'disabled', label: 'Disabled', disabled: true }, { id: 'last', label: 'Last' }]
  });
  const popup = menuElement(f.document), itemButtons = buttons(popup);
  t.after(() => f.component.dispose());

  const key = (name: string) => dispatch(popup, 'keydown', { key: name });
  assert.equal(f.document.activeElement, itemButtons[0] as unknown as HTMLElement);
  key('ArrowDown'); assert.equal(f.document.activeElement, itemButtons[2] as unknown as HTMLElement);
  key('ArrowDown'); assert.equal(f.document.activeElement, itemButtons[0] as unknown as HTMLElement);
  key('ArrowUp'); assert.equal(f.document.activeElement, itemButtons[2] as unknown as HTMLElement);
  key('Home'); assert.equal(f.document.activeElement, itemButtons[0] as unknown as HTMLElement);
  key('End'); assert.equal(f.document.activeElement, itemButtons[2] as unknown as HTMLElement);
  const enter = key('Enter');
  const space = key(' ');
  assert.equal(enter.defaultPrevented, false, 'native Enter activation remains available');
  assert.equal(space.defaultPrevented, false, 'native Space activation remains available');
  assert.equal(globalKeydowns, 0, 'menu keystrokes do not reach editor shortcuts');
  assert.equal(key('Escape').defaultPrevented, true);
  assert.equal(f.component.isOpen, false);
  assert.equal(f.document.activeElement, f.anchor as unknown as HTMLElement);
  assert.equal(f.anchor.focusCalls, 1);
  assert.equal(f.document.listenerCount('pointerdown'), 0);
  assert.equal((f.document.defaultView as MenuWindow).listenerCount('resize'), 0);
});

test('disabled items cannot execute and selection closes before one callback without focusing a removed anchor', t => {
  const f = fixture();
  let calls: string[] = [];
  f.component.open({
    x: 0, y: 0, anchor: f.anchor as unknown as HTMLElement,
    items: [{ id: 'disabled', label: 'Disabled', disabled: true }, { id: 'copy', label: 'Copy' }],
    onSelect: id => {
      assert.equal(f.component.isOpen, false, 'popup closes before invoking the action');
      assert.equal(f.document.body.children.some(child => child.className.includes('stagecraft-timeline-context-menu')), false);
      calls.push(id);
      f.anchor.remove();
    }
  });
  const itemButtons = buttons(menuElement(f.document));
  t.after(() => f.component.dispose());

  dispatch(itemButtons[0]!, 'click');
  assert.deepEqual(calls, []);
  assert.equal(f.component.isOpen, true, 'attempting a disabled action leaves the menu open');
  dispatch(itemButtons[1]!, 'click');
  dispatch(itemButtons[1]!, 'click');
  assert.deepEqual(calls, ['copy']);
  assert.equal(f.anchor.focusCalls, 0, 'detached anchor is not refocused after its action');
  assert.equal(f.document.listenerCount('scroll'), 0);
  assert.equal((f.document.defaultView as MenuWindow).listenerCount('resize'), 0);
});

test('clamps actual menu dimensions at the right and bottom viewport edges', () => {
  const f = fixture();
  const window = f.document.defaultView as MenuWindow;
  window.innerWidth = 400; window.innerHeight = 240;
  f.document.menuWidth = 175; f.document.menuHeight = 90;
  f.component.open({ x: 390, y: 230, items: [{ id: 'one', label: 'One' }], onSelect: () => {} });
  const popup = menuElement(f.document);
  assert.equal(popup.style.left, '225px');
  assert.equal(popup.style.top, '150px');
  f.component.dispose();
});

test('outside pointer, context menu, scroll, and resize dismiss and remove all listeners', () => {
  for (const reason of ['pointerdown', 'contextmenu', 'scroll', 'resize']) {
    const f = fixture();
    const outside = f.document.createElement('div');
    f.component.open({ x: 4, y: 8, items: [{ id: 'one', label: 'One' }], onSelect: () => {} });
    const popup = menuElement(f.document);

    if (reason === 'resize') dispatch(f.document.defaultView, reason);
    else if (reason === 'scroll') {
      f.document.scrollingElement.scrollTop = 50;
      dispatch(f.document, reason);
    }
    else dispatch(f.document, reason, { target: outside });

    assert.equal(f.component.isOpen, false, `${reason} dismisses the menu`);
    assert.equal(f.document.listenerCount('pointerdown'), 0, `${reason} removes document listeners`);
    assert.equal(f.document.listenerCount('contextmenu'), 0, `${reason} removes context listeners`);
    assert.equal(f.document.listenerCount('scroll'), 0, `${reason} removes scroll listeners`);
    assert.equal((f.document.defaultView as MenuWindow).listenerCount('resize'), 0, `${reason} removes window listeners`);
    assert.equal(popup.parentElement, null);
  }
});

test('inside pointer events stay open, repeated opens replace the old popup, and dispose prevents reuse', t => {
  const f = fixture();
  let oldSelections = 0;
  f.component.open({ x: 0, y: 0, items: [{ id: 'old', label: 'Old' }], onSelect: () => oldSelections++ });
  const oldPopup = menuElement(f.document), oldButton = buttons(oldPopup)[0]!;
  dispatch(f.document, 'pointerdown', { target: oldButton });
  assert.equal(f.component.isOpen, true, 'pointer activity inside the popup does not dismiss it');

  f.component.open({ x: 20, y: 20, items: [{ id: 'new', label: 'New' }], onSelect: () => {} });
  const newPopup = menuElement(f.document), newButton = buttons(newPopup)[0]!;
  assert.notEqual(newPopup, oldPopup);
  assert.equal(f.document.body.children.filter(child => child.className.includes('stagecraft-timeline-context-menu')).length, 1);
  dispatch(oldButton, 'click');
  assert.equal(oldSelections, 0, 'a detached button cannot run a stale action');
  dispatch(newButton, 'click');
  assert.equal(f.component.isOpen, false);
  f.component.dispose();
  f.component.open({ x: 0, y: 0, items: [{ id: 'ignored', label: 'Ignored' }], onSelect: () => assert.fail('disposed menus cannot reopen') });
  assert.equal(f.component.isOpen, false);
  t.after(() => f.component.dispose());
});
