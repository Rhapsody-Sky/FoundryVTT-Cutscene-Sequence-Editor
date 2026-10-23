import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chooseManualAudience, type AudienceDialogConfig } from '../src/integrations/foundry/audience-dialog.js';
import type { AudienceUser } from '../src/application/audience-resolver.js';

class DialogNode extends EventTarget {
  children: DialogNode[] = [];
  parent: DialogNode | null = null;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = ''; textContent = ''; type = ''; name = ''; value = '';
  checked = false; disabled = false; hidden = false;
  isConnected = true; focusCalls = 0;
  constructor(readonly tag: string) { super(); }
  append(...nodes: DialogNode[]): void {
    for (const node of nodes) {
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
      node.parent = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes: DialogNode[]): void {
    for (const child of this.children) child.parent = null;
    this.children = []; this.append(...nodes);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null; this.isConnected = false;
    const documentStub = globalThis.document as unknown as { activeElement: DialogNode | null; body: DialogNode };
    if (this.tag === 'dialog' || this.contains(documentStub.activeElement)) documentStub.activeElement = documentStub.body;
  }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  focus(): void { this.focusCalls++; }
  contains(target: EventTarget | null): boolean {
    return this === target || this.children.some(child => child.contains(target));
  }
  closest(selector: string): DialogNode | null {
    for (let node: DialogNode | null = this; node; node = node.parent) {
      if (selector.includes('[hidden]') && node.hidden) return node;
      if (selector.includes('[inert]') && 'inert' in node.attributes) return node;
    }
    return null;
  }
  clone(): DialogNode {
    const node = new DialogNode(this.tag);
    Object.assign(node, { dataset: { ...this.dataset }, attributes: { ...this.attributes },
      className: this.className, textContent: this.textContent, type: this.type, name: this.name,
      value: this.value, disabled: this.disabled, hidden: this.hidden });
    // Native DialogV2 stringifies innerHTML: property-only checked values and listeners are absent.
    node.append(...this.children.map(child => child.clone()));
    return node;
  }
  querySelectorAll<T>(selector: string): T[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child as T] : []), ...child.querySelectorAll<T>(selector)]);
  }
  querySelector<T>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  private matches(selector: string): boolean {
    if (selector === ':disabled') return this.disabled;
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && tag !== this.tag) return false;
    const className = selector.match(/\.([\w-]+)/)?.[1];
    if (className && !this.className.split(/\s+/).includes(className)) return false;
    for (const match of selector.matchAll(/\[data-([\w-]+)(?:="([^"]*)")?\]/g)) {
      const key = match[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      if (!(key in this.dataset) || (match[2] !== undefined && this.dataset[key] !== match[2])) return false;
    }
    return true;
  }
  override dispatchEvent(event: Event): boolean {
    const result = super.dispatchEvent(event);
    if (event.bubbles && this.parent) this.parent.dispatchEvent(new Event(event.type, { bubbles: true }));
    return result;
  }
}

function dom(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
  const body = new DialogNode('body');
  const documentElement = new DialogNode('html'); documentElement.append(body);
  const documentStub = { body, documentElement, activeElement: body as DialogNode | null, createElement: (tag: string) => new DialogNode(tag) };
  const frames: FrameRequestCallback[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true,
    value: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; } });
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: undefined });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
    if (previousFrame) Object.defineProperty(globalThis, 'requestAnimationFrame', previousFrame);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (previousMutationObserver) Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver);
    else Reflect.deleteProperty(globalThis, 'MutationObserver');
  });
  return {
    document: documentStub,
    flushFrames(): void { for (const callback of frames.splice(0)) callback(0); },
    pendingFrames(): number { return frames.length; }
  };
}

const users: AudienceUser[] = [
  { id: 'player-a', name: '<b>Alice</b>', role: 1, active: true },
  { id: 'player-b', name: 'Bob', role: 2, active: true },
  { id: 'offline', name: 'Offline player', role: 1, active: false },
  { id: 'other-gm', name: 'Other GM', role: 4, active: true }
];

function rendered(config: AudienceDialogConfig, withPanel = true) {
  const root = new DialogNode('dialog'), panel = new DialogNode('div'); panel.className = 'dialog-content standard-form';
  (globalThis.document as unknown as { body: DialogNode }).body.append(root);
  const serializedContent = (config.content as unknown as DialogNode).clone();
  if (withPanel) { panel.append(...serializedContent.children); root.append(panel); }
  const prepare = new DialogNode('button'); prepare.dataset.action = 'prepare'; root.append(prepare);
  const copiedInput = panel.querySelector<DialogNode>('[data-audience-mode="all"]');
  config.render(new Event('render'), { element: root as unknown as HTMLElement });
  return { root, panel, prepare, copiedInput };
}

function field(root: DialogNode, selector: string): DialogNode {
  const node = root.querySelector<DialogNode>(selector); assert.ok(node, selector); return node;
}
function change(node: DialogNode): void { node.dispatchEvent(new Event('change', { bubbles: true })); }
function selectMode(root: DialogNode): void {
  field(root, '[data-audience-mode="all"]').checked = false;
  const selected = field(root, '[data-audience-mode="selected"]'); selected.checked = true; change(selected);
}

test('native content cloning is replaced with live controls and selecting A prepares only A without GM', async t => {
  dom(t);
  const chosen = await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      assert.equal(config.modal, true); assert.equal(config.rejectClose, false);
      const { root, panel, prepare, copiedInput } = rendered(config);
      assert.notEqual(field(root, '[data-audience-mode="all"]'), copiedInput);
      assert.equal(panel.children[0], config.content);
      assert.equal(field(root, 'strong').textContent, '<img src=x onerror=alert(1)>');
      assert.equal(field(root, '.stagecraft-audience-picker__name').textContent, '<b>Alice</b>');
      assert.equal(prepare.disabled, false);
      selectMode(root);
      assert.equal(prepare.disabled, true, 'empty selection disables the native confirmation button');
      const player = field(root, '[data-audience-user="player-a"]'); player.checked = true; change(player);
      assert.equal(prepare.disabled, false);
      return config.buttons[0]!.callback();
    }
  }, '<img src=x onerror=alert(1)>');
  assert.deepEqual(chosen, { mode: 'selected', userIds: ['player-a'], includeGM: false });
});

test('all-player manual selection can exclude the GM through the live dialog checkbox', async t => {
  dom(t);
  const chosen = await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      const { root, prepare } = rendered(config);
      const gm = field(root, '[data-audience-show-gm]'); gm.checked = false; change(gm);
      assert.equal(prepare.disabled, false);
      return config.buttons[0]!.callback();
    }
  }, 'All players');
  assert.deepEqual(chosen, { mode: 'all', userIds: [], includeGM: false });
});

for (const dismissal of ['cancel', 'close'] as const) {
  test(`${dismissal} declines the audience even after selecting a player`, async t => {
    dom(t);
    const chosen = await chooseManualAudience({ users: () => users, localize: key => key,
      async wait(config) {
        const { root } = rendered(config); selectMode(root);
        const player = field(root, '[data-audience-user="player-b"]'); player.checked = true; change(player);
        const result = dismissal === 'cancel' ? config.buttons[1]!.callback() : null;
        root.remove();
        return result;
      }
    }, 'Cancel me');
    assert.equal(chosen, null);
  });
}

test('an empty audience cannot be submitted even if the native callback is invoked directly', async t => {
  dom(t);
  const chosen = await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      const { root, prepare } = rendered(config); selectMode(root);
      assert.equal(prepare.disabled, true);
      assert.equal(config.buttons[0]!.callback(), false);
      root.remove();
    }
  }, 'Empty');
  assert.equal(chosen, null);
});

test('a missing native dialog content panel cannot confirm detached default controls', async t => {
  dom(t);
  const chosen = await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      const { root, prepare } = rendered(config, false);
      assert.equal(prepare.disabled, true);
      const result = config.buttons[0]!.callback();
      root.remove();
      return result;
    }
  }, 'Missing panel');
  assert.equal(chosen, null);
});

test('a native rerender moves the same live nodes and preserves the current manual choice', async t => {
  dom(t);
  const chosen = await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      const first = rendered(config); selectMode(first.root);
      const player = field(first.root, '[data-audience-user="player-b"]'); player.checked = true; change(player);
      const second = rendered(config);
      assert.equal(field(second.root, '[data-audience-user="player-b"]'), player);
      assert.equal(second.prepare.disabled, false);
      player.checked = false; change(player); assert.equal(second.prepare.disabled, true);
      player.checked = true; change(player); assert.equal(second.prepare.disabled, false);
      return config.buttons[0]!.callback();
    }
  }, 'Rerender');
  assert.deepEqual(chosen, { mode: 'selected', userIds: ['player-b'], includeGM: false });
});

test('cancel returns focus to the opener after the dialog settles and a frame passes', async t => {
  const env = dom(t);
  const opener = new DialogNode('button');
  env.document.activeElement = opener;
  opener.disabled = true;
  const chosen = await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      const { root } = rendered(config);
      env.document.activeElement = root;
      config.buttons[1]!.callback();
      root.remove();
      return null;
    }
  }, 'Cancel');

  assert.equal(chosen, null);
  assert.equal(opener.focusCalls, 0, 'focus restoration waits for the frame after the caller reenables its trigger');
  assert.equal(env.pendingFrames(), 1);
  opener.disabled = false;
  env.flushFrames();
  assert.equal(opener.focusCalls, 1);
});

test('cancel keeps the chooser pending until DialogV2 removes its modal after the close animation', async t => {
  const env = dom(t);
  const opener = new DialogNode('button');
  env.document.activeElement = opener;
  opener.disabled = true;
  const dialogHolder: { element: DialogNode | null } = { element: null };
  let settled = false;
  const choosing = chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      dialogHolder.element = rendered(config).root;
      env.document.activeElement = dialogHolder.element;
      config.buttons[1]!.callback();
      // Foundry's waiter can settle while the closing application remains mounted.
      return null;
    }
  }, 'Cancel').then(result => { settled = true; return result; });

  await Promise.resolve();
  assert.equal(settled, false, 'the chooser waits while the modal is still mounted');
  assert.equal(env.pendingFrames(), 1, 'the fallback polls for the asynchronous modal removal');
  assert.ok(dialogHolder.element);
  dialogHolder.element.remove();
  env.flushFrames();
  assert.equal(await choosing, null);
  assert.equal(env.pendingFrames(), 1, 'focus is scheduled after removal for the next frame');
  opener.disabled = false;
  env.flushFrames();
  assert.equal(opener.focusCalls, 1);
});

test('successful prepare leaves focus with the playback manager', async t => {
  const env = dom(t);
  const opener = new DialogNode('button');
  const manager = new DialogNode('button');
  env.document.activeElement = opener;
  const chosen = await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      const { root } = rendered(config);
      env.document.activeElement = root;
      const result = config.buttons[0]!.callback();
      root.remove();
      env.document.activeElement = manager;
      return result;
    }
  }, 'Prepare');

  assert.deepEqual(chosen, { mode: 'all', userIds: [], includeGM: true });
  assert.equal(env.pendingFrames(), 0);
  assert.equal(manager.focusCalls, 0);
  assert.equal(opener.focusCalls, 0);
  assert.equal(env.document.activeElement, manager);
});

test('dismissal does not steal focus if another control received focus meanwhile', async t => {
  const env = dom(t);
  const opener = new DialogNode('button');
  const elsewhere = new DialogNode('button');
  env.document.activeElement = opener;
  await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      const { root } = rendered(config);
      config.buttons[1]!.callback();
      root.remove();
      return null;
    }
  }, 'Cancel');

  env.document.activeElement = elsewhere;
  env.flushFrames();
  assert.equal(opener.focusCalls, 0);
  assert.equal(env.document.activeElement, elsewhere);
});

test('dismissal safely ignores a disconnected opener', async t => {
  const env = dom(t);
  const opener = new DialogNode('button');
  env.document.activeElement = opener;
  await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      const { root } = rendered(config);
      config.buttons[1]!.callback();
      root.remove();
      return null;
    }
  }, 'Cancel');

  opener.isConnected = false;
  env.flushFrames();
  assert.equal(opener.focusCalls, 0);
  assert.equal(env.document.activeElement, env.document.body);
});

test('dismissal does not focus an opener inside a hidden ancestor', async t => {
  const env = dom(t);
  const hiddenPanel = new DialogNode('div'); hiddenPanel.hidden = true;
  const opener = new DialogNode('button');
  hiddenPanel.append(opener);
  env.document.body.append(hiddenPanel);
  env.document.activeElement = opener;
  await chooseManualAudience({ users: () => users, localize: key => key,
    async wait(config) {
      const { root } = rendered(config);
      config.buttons[1]!.callback();
      root.remove();
      return null;
    }
  }, 'Cancel');

  env.flushFrames();
  assert.equal(opener.focusCalls, 0);
  assert.equal(env.document.activeElement, env.document.body);
});

for (const unavailable of ['hidden', 'disabled'] as const) {
  test(`dismissal does not focus an opener that became ${unavailable}`, async t => {
    const env = dom(t);
    const opener = new DialogNode('button');
    env.document.activeElement = opener;
    await chooseManualAudience({ users: () => users, localize: key => key,
      async wait(config) {
        const { root } = rendered(config);
        config.buttons[1]!.callback();
        root.remove();
        return null;
      }
    }, 'Cancel');
    opener[unavailable] = true;
    env.flushFrames();
    assert.equal(opener.focusCalls, 0);
    assert.equal(env.document.activeElement, env.document.body);
  });
}
