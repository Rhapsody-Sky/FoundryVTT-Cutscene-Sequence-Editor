import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionCoordinator } from '../src/application/session-coordinator.js';
import { createBarsSequence } from '../src/domain/validation.js';
import { compileSequence } from '../src/playback/evaluate.js';
import { DomSurface } from '../src/rendering/dom-surface.js';
import { SessionView } from '../src/ui/session-view.js';
import { LocalPlaybackVolume } from '../src/application/playback-volume.js';
import { OrchestrationView, type OrchestrationCoordinator, type OrchestrationState } from '../src/ui/orchestration-view.js';

/** Fake DOM only: exercises production event handlers/tree ownership, not browser layout or native Tab/range behavior. */
function dom(t: { after(callback: () => void): void }) {
  const page = { activeElement: null as FakeElement | null, body: null as FakeElement | null };
  class FakeElement extends EventTarget {
    readonly tagName: string;
    children: FakeElement[] = [];
    parentNode: FakeElement | null = null;
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    className = '';
    classList = {
      add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name: string, force?: boolean) => {
        const present = this.className.split(/\s+/).includes(name);
        const next = force ?? !present;
        if (next) this.classList.add(name); else this.classList.remove(name);
        return next;
      }
    };
    textContent = '';
    hidden = false;
    disabled = false;
    inert = false;
    type = '';
    value = '';
    readonly attributes: Record<string, string> = {};
    constructor(tag = 'div') { super(); this.tagName = tag.toUpperCase(); }
    get isConnected(): boolean { return this === page.body || !!this.parentNode?.isConnected; }
    append(...nodes: FakeElement[]): void {
      for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); }
    }
    remove(): void {
      if (this.contains(page.activeElement)) page.activeElement = page.body;
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
    before(node: FakeElement): void {
      const parent = this.parentNode; if (!parent) return;
      node.remove(); node.parentNode = parent;
      parent.children.splice(parent.children.indexOf(this), 0, node);
    }
    replaceWith(node: FakeElement): void { this.before(node); this.remove(); }
    replaceChildren(): void { for (const child of [...this.children]) child.remove(); }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    setAttribute(name: string, value: string): void {
      this.attributes[name] = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
    }
    showPopover(): void {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; }
    focus(_options?: unknown): void {
      let ancestor: FakeElement | null = this;
      while (ancestor) { if (ancestor.inert || ancestor.hidden) return; ancestor = ancestor.parentNode; }
      if (!this.disabled && this.isConnected) page.activeElement = this;
    }
    private matches(selector: string): boolean {
      const tag = selector.match(/^[a-z]+/i)?.[0]?.toUpperCase();
      const attributes = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
      const classes = [...selector.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)];
      return (!tag || this.tagName === tag)
        && classes.every(match => this.className.split(/\s+/).includes(match[1]!))
        && attributes.every(match => match[1] === 'data-session-action'
          ? this.dataset.sessionAction !== undefined && (match[2] === undefined || this.dataset.sessionAction === match[2])
          : (() => {
            const name = match[1]!;
            const value = name.startsWith('data-')
              ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())]
              : name === 'hidden' ? (this.hidden ? '' : undefined) : this.attributes[name];
            return value !== undefined && (match[2] === undefined || value === match[2]);
          })())
        && (!selector.includes(':not(:disabled)') || !this.disabled);
    }
    closest<T>(selector: string): T | null {
      if (this.matches(selector)) return this as unknown as T;
      return this.parentNode?.closest<T>(selector) ?? null;
    }
    querySelector<T>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
    querySelectorAll<T>(selector: string): T[] {
      const result: T[] = [];
      for (const child of this.children) {
        if (child.matches(selector)) result.push(child as T);
        result.push(...child.querySelectorAll<T>(selector));
      }
      return result;
    }
  }
  page.body = new FakeElement('body'); page.activeElement = page.body;
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    body: page.body,
    documentElement: new FakeElement('html'),
    get activeElement() { return page.activeElement; },
    createElement: (tag: string) => new FakeElement(tag),
    createComment: (_text: string) => new FakeElement('#comment')
  });
  // Object.assign evaluates getters, so keep activeElement live while the fixture changes focus.
  Object.defineProperty(document, 'activeElement', { get: () => page.activeElement });
  const globals: Record<string, unknown> = {
    document, window: browser, Element: FakeElement, HTMLElement: FakeElement, Node: FakeElement,
    HTMLDialogElement: class extends FakeElement {},
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} }
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } });
  const key = (value: string, target: FakeElement, type = 'keydown') => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, { key: { value }, target: { value: target } });
    browser.dispatchEvent(event); return event;
  };
  return { page, document, browser, FakeElement, key };
}

function coordinatorFixture() {
  let phase = 'playing';
  let owner = true;
  let canExit = true;
  let completePause: (() => void) | null = null;
  const coordinator = {
    get runPhase() { return phase; },
    get status() { return { phase, isOwner: owner, canExit, runId: 'run', error: null }; },
    get state() { return { owner: { userId: 'gm' }, run: { phase, snapshot: { name: 'Focus test' } } }; },
    participants: [], lastError: null,
    pause: () => new Promise<void>(resolve => { completePause = () => { phase = 'paused'; resolve(); }; })
  };
  const view = new SessionView(coordinator as unknown as SessionCoordinator, {
    isGM: true, localize: key => key, userName: id => id, confirmRevoke: async () => true
  });
  return {
    view, setPhase: (next: string) => { phase = next; },
    stopParticipation: () => { owner = false; canExit = false; },
    completePause: () => { assert.ok(completePause); completePause(); }
  };
}

for (const target of ['window', 'canvas'] as const) for (const blockInput of [true, false]) {
  for (const exitMethod of ['escape', 'button'] as const) {
    test(`${target} dismissed GM manager retains local controls with blocking ${blockInput}, then ${exitMethod} cleans up`, async t => {
      const fixture = dom(t);
      type Element = InstanceType<typeof fixture.FakeElement>;
      const initial = new fixture.FakeElement('input'); fixture.document.body.append(initial); initial.focus();
      const board = new fixture.FakeElement('canvas'); fixture.document.body.append(board);
      const commands: string[] = [];
      let canExit = true;
      let localPhase: OrchestrationCoordinator['status']['phase'] = 'playing';
      let surface: DomSurface;
      const run: OrchestrationCoordinator['runs'][number]['run'] = {
        runId: 'local-run', snapshot: { name: 'Automatic bars' }, recipients: [{ userId: 'gm' }], phase: 'playing'
      };
      const waiting: OrchestrationCoordinator['queue'][number] = {
        launchId: 'waiting', snapshot: { name: 'Queued next' }, userIds: ['gm'], status: 'waiting', order: 1, mode: 'automatic'
      };
      const state: OrchestrationState = {
        rootId: 'root', head: 1, version: 3, owner: { userId: 'gm', sessionId: 'gm-tab', generation: 'owner-generation' },
        runs: [run], launches: [waiting], closedRuns: [], closedLaunches: []
      };
      const command = (name: string) => async () => { commands.push(name); };
      const coordinator: OrchestrationCoordinator = {
        state, lastError: null,
        get status() { return { phase: localPhase, runId: canExit ? run.runId : null, isOwner: true, canExit, error: null }; },
        get runs() { return [{ run, phase: localPhase === 'exited' ? 'playing' : localPhase, participants: [] }]; },
        queue: [waiting], startReady: command('start'), pause: command('pause'), resume: command('resume'),
        continueFromBreak: command('continue'), fade: command('fade'), stopGlobal: command('stop'),
        cancel: command('cancel'), retry: command('retry'), stopAll: command('stop-all'), release: command('release'),
        revoke: command('revoke'), exitLocal: () => {
          commands.push('exit-local'); canExit = false; localPhase = 'exited'; surface.dispose(); view.update();
        }
      };
      const view = new OrchestrationView(coordinator, {
        isGM: true, localize: key => key, userName: id => id, confirmRevoke: async () => true
      });
      t.after(() => { surface?.dispose(); view.dispose(); });
      const panel = view.element as unknown as Element;
      const panelParent = panel.parentNode;
      const action = (name: string) => {
        const button = panel.querySelector<Element>(`button[data-orchestration-action="${name}"]`);
        assert.ok(button, `${name} must exist in the real manager tree`);
        assert.equal(panel.hidden, false); assert.equal(button.disabled, false);
        button.focus(); assert.equal(fixture.page.activeElement, button, `${name} must be focusable through its ancestors`);
        return button;
      };
      const click = (button: Element) => {
        // EventTarget has no DOM bubbling; dispatch the delegated click with its actual button target.
        const event = new Event('click'); Object.defineProperty(event, 'target', { value: button }); panel.dispatchEvent(event);
      };
      view.openAutomatically();
      let nextId = 0;
      const sequence = createBarsSequence('Automatic bars', () => `id-${++nextId}`);
      const plan = compileSequence({ ...sequence, presentation: { ...sequence.presentation, surface: target, blockInput } });
      const storedVolume = new Map<string, string>();
      const persistence = { key: 'viewer-volume', storage: {
        getItem: (key: string) => storedVolume.get(key) ?? null,
        setItem: (key: string, value: string) => { storedVolume.set(key, value); }
      } };
      const volume = new LocalPlaybackVolume(persistence); volume.set(0.43);
      surface = new DomSurface({ target, board: board as unknown as HTMLElement, playbackVolume: volume,
        volumeLabel: 'Playback volume', controls: { panel: view.element, stop: coordinator.exitLocal,
          labels: { stop: 'Exit', fade: '', pause: '', resume: '', playback: 'Playback' } } });
      await surface.prepare(plan, new AbortController().signal);
      assert.equal(panel.parentNode, panelParent, 'preparing never moves the shared controls');
      assert.equal(fixture.document.body.querySelector('[data-stagecraft-surface]'), null);
      surface.render({ phase: 'playing', positionMs: 0, opacity: 1, items: [] });
      const root = fixture.document.body.querySelector<Element>(`[data-stagecraft-surface="${target}"]`)!;
      assert.ok(root); assert.equal(panel.parentNode, target === 'window' ? root : fixture.document.body);
      const hud = root.querySelector<Element>('[data-stagecraft-playback-volume]')!;
      const slider = hud.querySelector<Element>('[data-stagecraft-playback-volume-control]')!;
      assert.ok(slider); assert.equal(slider.value, '0.43');
      const authorityBefore = JSON.stringify(state);
      click(action('close'));
      assert.deepEqual(commands, [], 'closing cannot invoke local exit, transport, queue, or authority commands');
      assert.equal(JSON.stringify(state), authorityBefore);
      assert.equal(panel.dataset.orchestrationClosed, 'true');
      assert.equal(panel.querySelector('.stagecraft-orchestration__layout'), null, 'the manager content is actually removed');
      assert.equal(panel.querySelector('[data-orchestration-action="close"]'), null);
      assert.equal(fixture.page.activeElement?.dataset.orchestrationAction, 'exit', 'focus moves to the persistent emergency exit');
      assert.equal(panel.querySelectorAll('button').length, 1, 'only local Exit remains, with no floating reopen button');
      assert.equal(fixture.document.body.querySelectorAll('[role="toolbar"]').length, 1, 'the original shared controls remain the sole toolbar');
      action('exit');
      assert.equal(initial.inert, target === 'window' && blockInput, 'closing the manager leaves the underlying input lock intact');
      assert.ok(root.isConnected);
      let gameKeys = 0; fixture.browser.addEventListener('keydown', () => { gameKeys++; });
      assert.equal(fixture.key(' ', fixture.document.body).defaultPrevented, blockInput);
      assert.equal(gameKeys, blockInput ? 0 : 1, 'the input gate survives dismissing the manager');
      view.update(); view.openAutomatically();
      assert.equal(panel.dataset.orchestrationClosed, 'true', 'automatic updates respect the dismissal');
      assert.equal(panel.querySelector('.stagecraft-orchestration__layout'), null);
      assert.equal(root.querySelector('[data-stagecraft-playback-volume-control]'), slider, 'dismissal leaves the existing volume HUD attached');
      slider.focus(); assert.equal(fixture.page.activeElement, slider);
      slider.value = '0.31'; slider.dispatchEvent(new Event('input'));
      assert.equal(volume.value, 0.31, 'personal volume works while the manager is dismissed');
      const keysBeforeVolume = gameKeys;
      assert.equal(fixture.key('ArrowRight', slider).defaultPrevented, false);
      assert.equal(gameKeys, keysBeforeVolume, 'the real surface shields volume keys without cancelling native range behavior');
      const authoredButton = new fixture.FakeElement('button');
      authoredButton.dataset.stagecraftInteractive = '';
      const buttonLabel = new fixture.FakeElement('span'); authoredButton.append(buttonLabel); root.append(authoredButton);
      const keysBeforeAuthoredButton = gameKeys;
      assert.equal(fixture.key(' ', buttonLabel).defaultPrevented, false, 'authored buttons retain native Space activation even under input blocking');
      assert.equal(fixture.key('Enter', authoredButton).defaultPrevented, false);
      assert.equal(fixture.key('Tab', authoredButton).defaultPrevented, false);
      assert.equal(gameKeys, keysBeforeAuthoredButton, 'authored button keyboard input never reaches Foundry hotkeys');
      authoredButton.remove();
      view.open();
      assert.equal(panel.dataset.orchestrationClosed, 'false');
      assert.ok(panel.querySelector('.stagecraft-orchestration__layout'), 'explicit reopen restores the manager');
      assert.ok(panel.querySelector('[data-orchestration-action="close"]'));
      click(action('close'));
      const exit = action('exit');
      if (exitMethod === 'escape') assert.equal(fixture.key('Escape', exit).defaultPrevented, true);
      else click(exit);
      assert.deepEqual(commands, ['exit-local'], 'actual local exit never touches group playback or ownership');
      assert.equal(JSON.stringify(state), authorityBefore);
      assert.equal(root.isConnected, false); assert.equal(hud.isConnected, false);
      assert.equal(fixture.document.body.querySelectorAll('[data-stagecraft-surface]').length, 0);
      assert.equal(fixture.document.body.querySelectorAll('[data-stagecraft-orchestration]').length, 1);
      assert.equal(panel.parentNode, panelParent, 'surface cleanup returns the same controls to their original root');
      assert.equal(initial.inert, false); assert.equal(board.inert, false);
      assert.equal(panel.className.includes('stagecraft-playback-controls-with-volume'), false);
      assert.equal(panel.querySelector('[data-orchestration-action="exit"]'), null);
      assert.equal(panel.querySelectorAll('button').length, 0, 'no control survives local exit');
      assert.equal(panel.hidden, true);
      assert.equal(panel.dataset.orchestrationClosed, 'true');
      if (blockInput) assert.equal(fixture.page.activeElement, initial, 'cleanup restores focus owned by the input lock');
      assert.equal(panel.querySelector('[data-orchestration-action="open"]'), null);
      assert.equal(volume.value, 0.31, 'local volume survives local exit');
      assert.equal(new LocalPlaybackVolume(persistence).value, 0.31, 'the changed personal volume remains persisted for the next player');
      slider.value = '0.9'; slider.dispatchEvent(new Event('input'));
      assert.equal(volume.value, 0.31, 'disposed HUD input is disconnected');
      const keysBeforeCleanup = gameKeys;
      assert.equal(fixture.key(' ', fixture.document.body).defaultPrevented, false);
      assert.equal(gameKeys, keysBeforeCleanup + 1, 'surface cleanup releases game input');
      view.dispose();
      assert.equal(fixture.document.body.querySelectorAll('[role="toolbar"]').length, 0, 'disposing the view leaves no toolbar behind');
    });
  }
}

test('session phase changes retain focus on the enabled transport counterpart without stealing outside focus', t => {
  const fixture = dom(t); const { view, setPhase } = coordinatorFixture();
  const panel = view.element as unknown as InstanceType<typeof fixture.FakeElement>;
  panel.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-session-action="pause"]')!.focus();
  setPhase('paused'); view.update();
  assert.equal(fixture.page.activeElement?.dataset.sessionAction, 'resume');
  setPhase('playing'); view.update();
  assert.equal(fixture.page.activeElement?.dataset.sessionAction, 'pause');
  const input = new fixture.FakeElement('input'); fixture.document.body.append(input); input.focus();
  setPhase('paused'); view.update();
  assert.equal(fixture.page.activeElement, input);
  view.dispose();
});

test('an awaited session command keeps an enabled local exit focused during and after button repaint', async t => {
  const fixture = dom(t); const { view, completePause } = coordinatorFixture();
  const panel = view.element as unknown as InstanceType<typeof fixture.FakeElement>;
  const pause = panel.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-session-action="pause"]')!;
  pause.focus();
  const click = new Event('click'); Object.defineProperty(click, 'target', { value: pause });
  panel.dispatchEvent(click);
  assert.equal(fixture.page.activeElement?.dataset.sessionAction, 'exit');
  assert.equal(fixture.page.activeElement?.disabled, false);
  completePause(); await Promise.resolve(); await Promise.resolve();
  assert.equal(fixture.page.activeElement?.dataset.sessionAction, 'exit');
  assert.equal(fixture.page.activeElement?.disabled, false);
  view.dispose();
});

test('the GM can Continue a held group after exiting its local presentation', async t => {
  const fixture = dom(t);
  let continued = 0;
  const coordinator = {
    status: { phase: 'exited', isOwner: true, canExit: false, runId: 'run', error: null },
    runPhase: 'holding',
    state: { owner: { userId: 'gm' }, run: { phase: 'playing', snapshot: { name: 'Held group' } } },
    participants: [], lastError: null,
    continueFromBreak: async () => { continued++; }
  };
  const view = new SessionView(coordinator as unknown as SessionCoordinator, {
    isGM: true, localize: key => key, userName: id => id, confirmRevoke: async () => true
  });
  const panel = view.element as unknown as InstanceType<typeof fixture.FakeElement>;
  const button = panel.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-session-action="continue"]');
  assert.ok(button); assert.equal(button.disabled, false);
  const click = new Event('click'); Object.defineProperty(click, 'target', { value: button }); panel.dispatchEvent(click);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(continued, 1);
  assert.equal(panel.querySelector('[data-session-action="exit"]'), null);
  view.dispose();
});

for (const phase of ['preparing', 'playing', 'paused', 'holding', 'exiting']) {
  test(`a GM without a viewing surface sees the authoritative ${phase} phase and its controls`, t => {
    const fixture = dom(t);
    const coordinator = {
      status: { phase: 'idle', isOwner: true, canExit: false, runId: null, error: null },
      runPhase: phase,
      state: { owner: { userId: 'gm' }, run: { phase, snapshot: { name: 'Player A only' } } },
      participants: [{ userId: 'a', sessionId: 'a-tab', name: 'Player A', status: 'ready' }], lastError: null
    };
    const view = new SessionView(coordinator as unknown as SessionCoordinator, {
      isGM: true, localize: key => key, userName: id => id, confirmRevoke: async () => true
    });
    const panel = view.element as unknown as InstanceType<typeof fixture.FakeElement>;
    assert.equal(panel.hidden, false);
    assert.equal(panel.children[0]!.children[1]!.textContent, `STAGECRAFT.Session.State.${phase}`);
    const action = phase === 'preparing' ? 'start' : phase === 'paused' ? 'resume' : phase === 'holding' ? 'continue' : 'stop';
    assert.equal(panel.querySelector<InstanceType<typeof fixture.FakeElement>>(`[data-session-action="${action}"]`)!.disabled, false);
    assert.equal(panel.querySelector('[data-session-action="exit"]'), null);
    view.dispose();
  });
}

test('a vanished session action falls back to an enabled controller action when local exit is unavailable', t => {
  const fixture = dom(t); const { view, stopParticipation } = coordinatorFixture();
  const panel = view.element as unknown as InstanceType<typeof fixture.FakeElement>;
  panel.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-session-action="exit"]')!.focus();
  stopParticipation(); view.update();
  assert.equal(fixture.page.activeElement?.dataset.sessionAction, 'revoke');
  view.dispose();
});

for (const target of ['window', 'canvas'] as const) {
  test(`${target} input lock permits Tab navigation from body while blocking shortcuts and preserving Escape cleanup`, async t => {
    const fixture = dom(t);
    const input = new fixture.FakeElement('input'); fixture.document.body.append(input); input.focus();
    const board = new fixture.FakeElement('canvas'); fixture.document.body.append(board);
    let nextId = 0;
    const sequence = createBarsSequence('Keyboard test', () => `id-${++nextId}`);
    const plan = compileSequence({ ...sequence, presentation: { ...sequence.presentation, surface: target, blockInput: true } });
    let stops = 0;
    const surface = new DomSurface({ target, board: board as unknown as HTMLElement, controls: {
      stop: () => { stops++; surface.dispose(); }, labels: { stop: 'Exit', fade: 'Fade', pause: 'Pause', resume: 'Resume', playback: 'Playback' }
    } });
    await surface.prepare(plan, new AbortController().signal);
    surface.render({ phase: 'playing', positionMs: 0, opacity: 1, items: [] });
    let gameKeys = 0; fixture.browser.addEventListener('keydown', () => { gameKeys++; });
    fixture.page.activeElement = fixture.document.body;
    assert.equal(fixture.key('Tab', fixture.document.body).defaultPrevented, false);
    assert.equal(gameKeys, 0, 'browser focus navigation must not propagate into game shortcuts');
    assert.equal(fixture.key(' ', fixture.document.body).defaultPrevented, true);
    assert.equal(gameKeys, 0);
    assert.equal(fixture.key('Escape', fixture.document.body).defaultPrevented, true);
    assert.equal(stops, 1);
    assert.equal(fixture.page.activeElement, input, 'exit restores the previous connected focus target');
    assert.equal(input.inert, false);
    assert.equal(fixture.key(' ', fixture.document.body).defaultPrevented, false);
    assert.equal(gameKeys, 1, 'game input works again after cleanup');
  });
}

for (const scenario of [
  { target: 'window', blockInput: false, focus: 'sidebar' },
  { target: 'canvas', blockInput: false, focus: 'sidebar' },
  { target: 'canvas', blockInput: true, focus: 'sidebar' },
  { target: 'window', blockInput: true, focus: 'controls' },
  { target: 'window', blockInput: false, focus: 'controls' }
] as const) {
  test(`${scenario.target} cleanup respects ${scenario.focus} focus with input blocking ${scenario.blockInput}`, async t => {
    const fixture = dom(t);
    const initial = new fixture.FakeElement('input'); fixture.document.body.append(initial); initial.focus();
    const sidebar = new fixture.FakeElement('input'); fixture.document.body.append(sidebar);
    const board = new fixture.FakeElement('canvas'); fixture.document.body.append(board);
    let nextId = 0;
    const sequence = createBarsSequence('Focus ownership test', () => `id-${++nextId}`);
    const plan = compileSequence({ ...sequence, presentation: {
      ...sequence.presentation, surface: scenario.target, blockInput: scenario.blockInput
    } });
    const surface = new DomSurface({ target: scenario.target, board: board as unknown as HTMLElement, controls: {
      stop: () => surface.dispose(), labels: { stop: 'Exit', fade: 'Fade', pause: 'Pause', resume: 'Resume', playback: 'Playback' }
    } });
    await surface.prepare(plan, new AbortController().signal);
    surface.render({ phase: 'playing', positionMs: 0, opacity: 1, items: [] });
    if (!scenario.blockInput) assert.equal(fixture.page.activeElement, initial, 'unlocked playback must not move initial focus');
    if (scenario.focus === 'sidebar') sidebar.focus();
    else {
      const controls = fixture.document.body.children.flatMap(child => child.children)
        .concat(fixture.document.body.children).find(child => child.children.some(node => node.tagName === 'BUTTON'))!;
      controls.querySelector<InstanceType<typeof fixture.FakeElement>>('button')!.focus();
    }
    const focusAtEnd = fixture.page.activeElement;
    surface.dispose();
    if (scenario.focus === 'sidebar') {
      assert.equal(focusAtEnd, sidebar);
      assert.equal(fixture.page.activeElement, sidebar, 'cleanup must keep the field chosen during playback focused');
    } else if (scenario.blockInput) {
      assert.equal(fixture.page.activeElement, initial, 'cleanup restores focus moved into blocked playback controls');
    } else {
      assert.equal(fixture.page.activeElement, fixture.document.body, 'cleanup must not restore focus it never moved');
    }
    assert.equal(initial.inert, false);
  });
}

for (const target of ['window', 'canvas'] as const) for (const blockInput of [true, false]) {
  test(`${target} toolbar shields keydown and keyup from game shortcuts without canceling native controls, blocking ${blockInput}`, async t => {
    const fixture = dom(t);
    const board = new fixture.FakeElement('canvas'); fixture.document.body.append(board);
    let nextId = 0;
    const sequence = createBarsSequence('Toolbar keyboard test', () => `id-${++nextId}`);
    const plan = compileSequence({ ...sequence, presentation: { ...sequence.presentation, surface: target, blockInput } });
    let toggles = 0; let stops = 0;
    const surface = new DomSurface({ target, board: board as unknown as HTMLElement, controls: {
      stop: () => { stops++; surface.dispose(); }, togglePause: () => { toggles++; },
      labels: { stop: 'Exit', fade: 'Fade', pause: 'Pause', resume: 'Resume', playback: 'Playback' }
    } });
    await surface.prepare(plan, new AbortController().signal);
    surface.render({ phase: 'playing', positionMs: 0, opacity: 1, items: [] });
    const controls = fixture.document.body.children.flatMap(child => child.children)
      .concat(fixture.document.body.children).find(child => child.children.some(node => node.tagName === 'BUTTON'))!;
    const pause = controls.children.find(node => node.tagName === 'BUTTON' && node.textContent === 'Pause')!;
    pause.focus();
    let gameKeys = 0;
    fixture.browser.addEventListener('keydown', () => { gameKeys++; });
    fixture.browser.addEventListener('keyup', () => { gameKeys++; });
    for (const key of [' ', 'Enter', 'Tab']) for (const type of ['keydown', 'keyup']) {
      assert.equal(fixture.key(key, pause, type).defaultPrevented, false, `${type} ${key} retains browser default activation/navigation`);
    }
    assert.equal(gameKeys, 0, 'neither keydown nor keyup may also invoke Foundry shortcuts');
    pause.dispatchEvent(new Event('click'));
    assert.equal(toggles, 1, 'the production button click action remains connected');
    assert.equal(fixture.key('Escape', pause).defaultPrevented, true);
    assert.equal(stops, 1);
    assert.equal(fixture.key(' ', fixture.document.body).defaultPrevented, false);
    assert.equal(fixture.key(' ', fixture.document.body, 'keyup').defaultPrevented, false);
    assert.equal(gameKeys, 2, 'both game key listeners receive input again after disposal');
  });
}

for (const target of ['window', 'canvas'] as const) for (const blockInput of [true, false]) {
  test(`${target} personal volume is reachable under input blocking ${blockInput} and cleans up without changing the sequence`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = dom(t);
    const initial = new fixture.FakeElement('input'); fixture.document.body.append(initial); initial.focus();
    const board = new fixture.FakeElement('canvas'); fixture.document.body.append(board);
    const panel = new fixture.FakeElement('div'); fixture.document.body.append(panel);
    let nextId = 0;
    const sequence = createBarsSequence('Viewer volume', () => `id-${++nextId}`);
    const plan = compileSequence({ ...sequence, presentation: { ...sequence.presentation, surface: target, blockInput } });
    const snapshot = JSON.stringify(plan.snapshot);
    const volume = new LocalPlaybackVolume();
    const surface = new DomSurface({ target, board: board as unknown as HTMLElement, playbackVolume: volume,
      volumeLabel: 'Playback volume', controls: { panel: panel as unknown as HTMLElement,
        stop: () => surface.dispose(), labels: { stop: 'Exit', fade: '', pause: '', resume: '', playback: 'Playback' } } });
    await surface.prepare(plan, new AbortController().signal);
    assert.equal(fixture.document.body.querySelector('[data-stagecraft-playback-volume]'), null, 'preparation stays detached');
    surface.render({ phase: 'holding', positionMs: 5000, opacity: 1, items: [], holdElapsedMs: 100 });
    const hud = fixture.document.body.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-stagecraft-playback-volume]')!;
    const slider = hud.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-stagecraft-playback-volume-control]')!;
    assert.ok(hud && slider); assert.equal(hud.parentNode?.dataset.stagecraftSurface, target);
    assert.equal(slider.inert, false); assert.ok(panel.className.includes('stagecraft-playback-controls-with-volume'));
    if (target === 'window' && blockInput) assert.equal(initial.inert, true);
    else assert.equal(initial.inert, false);
    let gameKeys = 0; fixture.browser.addEventListener('keydown', () => { gameKeys++; });
    fixture.browser.addEventListener('keyup', () => { gameKeys++; });
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab']) for (const type of ['keydown', 'keyup']) {
      assert.equal(fixture.key(key, slider, type).defaultPrevented, false, 'the native range keyboard handler stays available');
    }
    assert.equal(gameKeys, 0, 'volume keys do not also control Foundry');
    slider.value = '0.4'; slider.dispatchEvent(new Event('input'));
    assert.equal(volume.value, 0.4); assert.equal(JSON.stringify(plan.snapshot), snapshot);
    t.mock.timers.tick(2500); assert.ok(hud.className.includes('is-hidden'));
    const beforeFocus = fixture.page.activeElement;
    fixture.browser.dispatchEvent(new Event('mousemove'));
    assert.equal(hud.className.includes('is-hidden'), false); assert.equal(fixture.page.activeElement, beforeFocus);
    t.mock.timers.tick(2500); fixture.browser.dispatchEvent(new Event('pointermove'));
    assert.equal(hud.className.includes('is-hidden'), false);
    surface.dispose();
    assert.equal(hud.isConnected, false); assert.equal(initial.inert, false);
    assert.equal(panel.className.includes('stagecraft-playback-controls-with-volume'), false);
    slider.value = '0.9'; slider.dispatchEvent(new Event('input'));
    assert.equal(volume.value, 0.4, 'disposed HUD input does not affect the next playback');
    assert.equal(fixture.key('ArrowRight', fixture.document.body).defaultPrevented, false);
    assert.equal(gameKeys, 1, 'game controls are released');
  });
}
