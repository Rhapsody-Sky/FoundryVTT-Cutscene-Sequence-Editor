import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestrationView, type OrchestrationCoordinator, type OrchestrationLaunch, type OrchestrationParticipant, type OrchestrationRun, type OrchestrationState, type OrchestrationCoordinatorStatus } from '../src/ui/orchestration-view.js';

function dom(t: { after(callback: () => void): void }) {
  const page = { activeElement: null as FakeElement | null, body: null as FakeElement | null };
  class FakeElement extends EventTarget {
    readonly tagName: string;
    children: FakeElement[] = [];
    parentNode: FakeElement | null = null;
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    className = '';
    classList = { add(..._names: string[]) {}, toggle(_name: string, _force?: boolean) {} };
    hidden = false;
    disabled = false;
    type = '';
    private ownText = '';
    readonly attributes: Record<string, string> = {};
    constructor(tag = 'div') { super(); this.tagName = tag.toUpperCase(); }
    get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set textContent(value: string) { this.replaceChildren(); this.ownText = value; }
    get isConnected(): boolean { return this === page.body || !!this.parentNode?.isConnected; }
    append(...nodes: FakeElement[]): void {
      for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); }
    }
    remove(): void {
      if (this.contains(page.activeElement)) page.activeElement = page.body;
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
    replaceChildren(...nodes: FakeElement[]): void {
      for (const child of [...this.children]) child.remove();
      this.children = [];
      this.append(...nodes);
      this.ownText = '';
    }
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    focus(_options?: unknown): void {
      let ancestor: FakeElement | null = this;
      while (ancestor) { if (ancestor.hidden) return; ancestor = ancestor.parentNode; }
      if (!this.disabled && this.isConnected) page.activeElement = this;
    }
    closest<T>(selector: string): T | null {
      const attr = selector.match(/\[data-([\w-]+)(?:=["']([^"']+)["'])?\]/);
      const key = attr?.[1]?.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      if (key && this.dataset[key] !== undefined && (!attr?.[2] || this.dataset[key] === attr[2])) return this as unknown as T;
      return this.parentNode?.closest<T>(selector) ?? null;
    }
    querySelectorAll<T>(selector: string): T[] {
      const result: FakeElement[] = [];
      const tag = selector.match(/^[a-z]+/i)?.[0]?.toUpperCase();
      const attrs = Array.from(selector.matchAll(/\[data-([\w-]+)(?:=["']([^"']+)["'])?\]/g));
      const matches = (node: FakeElement) => (!tag || node.tagName === tag) && attrs.every((match) => {
        const key = match[1]!.replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase());
        return node.dataset[key] !== undefined && (!match[2] || node.dataset[key] === match[2]);
      });
      const visit = (node: FakeElement) => { for (const child of node.children) { if (matches(child)) result.push(child); visit(child); } };
      visit(this);
      return result as unknown as T[];
    }
  }
  page.body = new FakeElement('body');
  page.activeElement = page.body;
  const document = Object.assign(new EventTarget(), {
    body: page.body,
    createElement: (tag: string) => new FakeElement(tag),
    get activeElement() { return page.activeElement; }
  });
  Object.defineProperty(document, 'activeElement', { get: () => page.activeElement });
  const globals: Record<string, unknown> = { document, Element: FakeElement, HTMLElement: FakeElement };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { page, FakeElement };
}

function runEntry(id: string, name: string, phase: OrchestrationCoordinatorStatus['phase'] = 'playing', userIds = ['player-a']) {
  const participantStatus = phase === 'preparing' ? 'ready' : phase;
  const participants: OrchestrationParticipant[] = userIds.map((userId, index) => ({
    userId, sessionId: `tab-${index}`, name: userId === 'player-a' ? 'Player A' : userId === 'player-b' ? 'Player B' : userId,
    status: participantStatus
  }));
  const run: OrchestrationRun = {
    runId: id, snapshot: { name }, recipients: userIds.map((userId, index) => ({ userId, sessionId: `tab-${index}` })),
    phase: phase === 'preparing' ? 'preparing' : phase === 'holding' ? 'holding' : phase === 'paused' ? 'paused' : phase === 'exiting' ? 'exiting' : 'playing',
    ...(phase === 'paused' ? { pausedFrom: 'holding' as const } : {})
  };
  return { run, phase, participants };
}

function launch(id: string, status: OrchestrationLaunch['status'], name = id): OrchestrationLaunch {
  return { launchId: id, snapshot: { name }, userIds: ['player-a'], status, order: 1, mode: 'manual', ...(status === 'failed' ? { error: 'MEDIA_LOAD_FAILED' } : {}) };
}

function fixture() {
  let state: OrchestrationState | null = { rootId: 'root', head: 1, owner: { userId: 'gm', sessionId: 'gm-tab', generation: 'generation' }, version: 2, runs: [], launches: [], closedRuns: [], closedLaunches: [] };
  let currentRuns: ReturnType<typeof runEntry>[] = [];
  let currentQueue: OrchestrationLaunch[] = [];
  let status: OrchestrationCoordinatorStatus = { phase: 'idle', runId: null, isOwner: true, canExit: false, error: null };
  let lastError: unknown = null;
  const calls: string[] = [];
  let pauseHandler: (runId: string) => Promise<unknown> = async runId => { calls.push(`pause:${runId}`); };
  const coordinator = {
    get state() { return state; },
    get status() { return status; },
    get lastError() { return lastError; },
    get runs() { return currentRuns; },
    get queue() { return currentQueue; },
    startReady: async (id: string) => { calls.push(`start:${id}`); },
    pause: (id: string) => pauseHandler(id),
    resume: async (id: string) => { calls.push(`resume:${id}`); },
    continueFromBreak: async (id: string) => { calls.push(`continue:${id}`); },
    fade: async (id: string) => { calls.push(`fade:${id}`); },
    stopGlobal: async (id: string) => { calls.push(`stop:${id}`); },
    cancel: async (id: string) => { calls.push(`cancel:${id}`); },
    retry: async (id: string) => { calls.push(`retry:${id}`); },
    stopAll: async () => { calls.push('stop-all'); },
    release: async () => { calls.push('release'); },
    revoke: async () => { calls.push('revoke'); },
    exitLocal: () => { calls.push(`exit-local:${status.runId ?? ''}`); }
  };
  return {
    coordinator,
    calls,
    setRuns(value: ReturnType<typeof runEntry>[]) { currentRuns = value; },
    setQueue(value: OrchestrationLaunch[]) { currentQueue = value; },
    setStatus(value: OrchestrationCoordinatorStatus) { status = value; },
    setState(value: OrchestrationState | null) { state = value; },
    setLastError(value: unknown) { lastError = value; },
    setPauseHandler(value: (runId: string) => Promise<unknown>) { pauseHandler = value; }
  };
}

function viewFor(coordinator: ReturnType<typeof fixture>['coordinator'], isGM = true, confirmRevoke = async () => true): OrchestrationView {
  return new OrchestrationView(coordinator as unknown as OrchestrationCoordinator, {
    isGM,
    localize: key => key === 'STAGECRAFT.Error.SESSION_CONFLICT' ? 'Playback control changed.' : key,
    userName: id => ({ 'player-a': 'Player A', 'player-b': 'Player B', gm: 'Game Master' }[id] ?? id),
    confirmRevoke
  });
}

function click(panel: InstanceType<ReturnType<typeof dom>['FakeElement']>, target: InstanceType<ReturnType<typeof dom>['FakeElement']>): void {
  const event = new Event('click');
  Object.defineProperty(event, 'target', { value: target });
  panel.dispatchEvent(event);
}

function action(panel: InstanceType<ReturnType<typeof dom>['FakeElement']>, name: string) {
  return panel.querySelectorAll<InstanceType<ReturnType<typeof dom>['FakeElement']>>('button[data-orchestration-action]')
    .find(button => button.dataset.orchestrationAction === name);
}

function select(panel: InstanceType<ReturnType<typeof dom>['FakeElement']>, kind: 'run' | 'launch', id: string) {
  return panel.querySelectorAll<InstanceType<ReturnType<typeof dom>['FakeElement']>>('button[data-orchestration-select]')
    .find(button => button.dataset.orchestrationSelect === kind && button.dataset.orchestrationId === id);
}

test('multiple active runs can be selected while an async command stays bound to the clicked run id', async t => {
  const page = dom(t);
  const f = fixture();
  f.setRuns([runEntry('run-a', 'Sequence A', 'holding'), runEntry('run-b', 'Sequence B', 'playing', ['player-b'])]);
  let finishPause!: () => void;
  f.setPauseHandler(id => { f.calls.push(`pause:${id}`); return new Promise<void>(resolve => { finishPause = resolve; }); });
  const view = viewFor(f.coordinator);
  const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  const pause = action(panel, 'pause')!;
  pause.focus();
  click(panel, pause);
  assert.deepEqual(f.calls, ['pause:run-a']);
  const runB = select(panel, 'run', 'run-b')!;
  click(panel, runB);
  assert.equal(panel.textContent.includes('Sequence B'), true);
  assert.equal(panel.querySelectorAll<InstanceType<ReturnType<typeof dom>['FakeElement']>>('button[data-orchestration-action]')
    .some(button => button.dataset.targetId === 'run-b'), true);
  finishPause();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.calls, ['pause:run-a']);
  view.dispose();
});

test('waiting, preparing, and failed queue entries expose cancel and retry for their launch ids', async t => {
  const page = dom(t); const f = fixture();
  f.setRuns([]);
  f.setQueue([launch('waiting-1', 'waiting', 'Waiting sequence'), launch('failed-2', 'failed', 'Failed sequence')]);
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  click(panel, action(panel, 'cancel')!);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('cancel:waiting-1'));
  click(panel, select(panel, 'launch', 'failed-2')!);
  click(panel, action(panel, 'retry')!);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('retry:failed-2'));
  click(panel, action(panel, 'cancel')!);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.filter(call => call === 'cancel:waiting-1').length, 1);
  assert.ok(f.calls.includes('cancel:failed-2'));
  f.setQueue([launch('preparing-3', 'preparing', 'Claimed preparation')]); view.update();
  click(panel, action(panel, 'cancel')!);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('cancel:preparing-3'), 'cancel addresses the whole preparing launch');
  view.dispose();
});

test('multiple queued starts expose a distinct bulk-cancel action', async t => {
  const page = dom(t); const f = fixture();
  f.setRuns([]);
  f.setQueue([launch('waiting-1', 'waiting'), launch('failed-2', 'failed')]);
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  assert.ok(action(panel, 'stop-all'));
  click(panel, action(panel, 'stop-all')!);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('stop-all'));
  assert.equal(f.calls.some(call => call.startsWith('cancel:')), false);
  view.dispose();
});

test('Stop targets one captured run and Stop all remains a distinct command', async t => {
  const page = dom(t); const f = fixture();
  f.setRuns([runEntry('run-a', 'Sequence A'), runEntry('run-b', 'Sequence B')]);
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  click(panel, action(panel, 'stop')!);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('stop:run-a'));
  assert.equal(f.calls.includes('stop-all'), false);
  click(panel, action(panel, 'stop-all')!);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('stop-all'));
  assert.equal(f.calls.filter(call => call.startsWith('stop:')).length, 1);
  view.dispose();
});

test('a fully prepared run reports Ready and exposes StartReady', async t => {
  const page = dom(t); const f = fixture();
  f.setRuns([runEntry('ready-run', 'Ready sequence', 'ready')]);
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  const start = action(panel, 'start');
  assert.ok(start);
  assert.equal(start.disabled, false);
  click(panel, start);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('start:ready-run'));
  view.dispose();
});

test('an automatically prepared run exposes Stop and omits the manual Start button', t => {
  const page = dom(t); const f = fixture();
  const run = runEntry('auto-run', 'Automatic sequence', 'ready');
  f.setRuns([run]);
  f.setState({ ...f.coordinator.state!, version: 3, runs: [run.run], launches: [
    { ...launch('auto-launch', 'preparing'), runId: 'auto-run', mode: 'automatic' }
  ] });
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  assert.equal(action(panel, 'start'), undefined);
  assert.ok(action(panel, 'stop'));
  assert.equal(action(panel, 'stop')!.dataset.targetId, 'auto-run');
  view.dispose();
});

test('a GM without a local viewer controls a globally paused run from its authoritative phase', async t => {
  const page = dom(t); const f = fixture();
  f.setStatus({ phase: 'idle', runId: null, isOwner: true, canExit: false, error: null });
  f.setRuns([runEntry('remote-run', 'Remote sequence', 'paused')]);
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  assert.equal(panel.hidden, false);
  assert.ok(action(panel, 'resume'));
  assert.equal(action(panel, 'exit'), undefined);
  click(panel, action(panel, 'resume')!);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('resume:remote-run'));
  view.dispose();
});

test('the same owner can confirm Revoke to recover after controller loss', async t => {
  const page = dom(t); const f = fixture();
  f.setRuns([runEntry('abandoned-run', 'Abandoned sequence')]);
  f.setLastError(Object.assign(new Error('Controller connection expired'), { code: 'SESSION_CONTROLLER_LOST' }));
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  assert.ok(action(panel, 'revoke'));
  assert.equal(action(panel, 'stop'), undefined);
  assert.equal(action(panel, 'stop-all'), undefined);
  click(panel, action(panel, 'revoke')!);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.calls.includes('revoke'));
  view.dispose();
});

test('revoke confirmation cannot revoke a replacement owner or generation', async t => {
  const page = dom(t); const f = fixture();
  f.setStatus({ phase: 'idle', runId: null, isOwner: false, canExit: false, error: null });
  f.setState({ ...f.coordinator.state!, owner: { userId: 'other-gm', sessionId: 'other-tab', generation: 'old-generation' } });
  let confirm!: (accepted: boolean) => void;
  const view = viewFor(f.coordinator, true, () => new Promise<boolean>(resolve => { confirm = resolve; }));
  const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  click(panel, action(panel, 'revoke')!);
  f.setState({ ...f.coordinator.state!, owner: { userId: 'other-gm', sessionId: 'other-tab', generation: 'new-generation' } });
  confirm(true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.includes('revoke'), false);
  assert.match(panel.textContent, /Playback control changed\./);
  view.dispose();
});

test('local exit stays enabled during another run command and always exits the local run', async t => {
  const page = dom(t); const f = fixture();
  f.setRuns([runEntry('remote-run', 'Remote sequence', 'playing', ['player-b'])]);
  f.setStatus({ phase: 'playing', runId: 'local-run', isOwner: true, canExit: true, error: null });
  let finishPause!: () => void;
  f.setPauseHandler(id => { f.calls.push(`pause:${id}`); return new Promise<void>(resolve => { finishPause = resolve; }); });
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  click(panel, select(panel, 'run', 'remote-run')!);
  click(panel, action(panel, 'pause')!);
  const exit = action(panel, 'exit')!;
  assert.equal(exit.disabled, false);
  click(panel, exit);
  assert.ok(f.calls.includes('exit-local:local-run'));
  assert.ok(f.calls.includes('pause:remote-run'));
  assert.equal(f.calls.some(call => call === 'stop:remote-run' || call === 'stop:local-run'), false);
  finishPause(); await Promise.resolve(); await Promise.resolve();
  view.dispose();
});

test('non-GM viewers see only their local sequence and exit control, never global runs or queue', t => {
  const page = dom(t); const f = fixture();
  f.setStatus({ phase: 'playing', runId: 'local-run', isOwner: false, canExit: true, error: null });
  f.setRuns([runEntry('local-run', 'My sequence'), runEntry('secret-run', 'Hidden GM sequence', 'playing', ['player-b'])]);
  f.setQueue([launch('secret-launch', 'waiting', 'Hidden queued sequence')]);
  f.setLastError(Object.assign(new Error('Controller recovery details'), { code: 'SESSION_CONTROLLER_LOST' }));
  const view = viewFor(f.coordinator, false); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /My sequence/);
  assert.doesNotMatch(panel.textContent, /Hidden GM sequence|Hidden queued sequence|Player B|Controller recovery details/);
  assert.ok(action(panel, 'exit'));
  assert.equal(action(panel, 'close'), undefined);
  assert.equal(action(panel, 'open'), undefined);
  assert.equal(select(panel, 'run', 'secret-run'), undefined);
  view.dispose();
});

test('repainting a run phase keeps focus on its matching transport action', t => {
  const page = dom(t); const f = fixture();
  const initial = runEntry('run-a', 'Sequence A', 'playing');
  f.setRuns([initial]);
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  action(panel, 'pause')!.focus();
  f.setRuns([runEntry('run-a', 'Sequence A', 'paused')]);
  view.update();
  assert.equal(page.page.activeElement?.dataset.orchestrationAction, 'resume');
  view.dispose();
});

test('a GM dismissal survives automatic state changes and only explicit open clears it', t => {
  const page = dom(t); const f = fixture();
  f.setStatus({ phase: 'idle', runId: null, isOwner: false, canExit: false, error: null });
  f.setState(null);
  f.setRuns([]); f.setQueue([]);
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  assert.equal(panel.hidden, true, 'the original implicit visibility remains idle and hidden');

  view.openAutomatically();
  assert.equal(panel.hidden, false);
  f.setRuns([runEntry('auto-run', 'Automatic sequence', 'playing')]);
  f.setQueue([launch('next-launch', 'waiting', 'Next automatic sequence')]);
  f.setState({ rootId: 'root', head: 2, owner: { userId: 'gm', sessionId: 'gm-tab' }, version: 3, runs: [], launches: [], closedRuns: [], closedLaunches: [] });
  f.setStatus({ phase: 'playing', runId: null, isOwner: true, canExit: false, error: null });
  view.update();
  const close = action(panel, 'close')!;
  assert.equal(close.textContent, '×');
  assert.equal(close.attributes['aria-label'], 'STAGECRAFT.Orchestration.Close');
  click(panel, close);

  assert.equal(panel.hidden, true, 'closing the manager leaves no floating control over the hotbar');
  assert.equal(panel.dataset.orchestrationClosed, 'true');
  assert.equal(action(panel, 'open'), undefined);
  assert.equal(panel.hidden, true);
  assert.equal(action(panel, 'close'), undefined);
  assert.equal(select(panel, 'run', 'auto-run'), undefined);
  assert.equal(panel.textContent.includes('STAGECRAFT.Orchestration.ActiveRuns'), false);
  assert.deepEqual(f.calls, [], 'closing changes no coordinator state');

  f.setRuns([runEntry('auto-run', 'Automatic sequence', 'holding')]);
  f.setQueue([launch('replacement-launch', 'preparing', 'Replacement queued sequence')]);
  f.setState({ ...f.coordinator.state!, owner: { userId: 'replacement-gm', sessionId: 'other-tab' } });
  f.setStatus({ phase: 'holding', runId: null, isOwner: false, canExit: false, error: null });
  view.update();
  assert.equal(panel.dataset.orchestrationClosed, 'true');
  assert.equal(action(panel, 'open'), undefined);
  assert.equal(panel.hidden, true);
  assert.equal(select(panel, 'run', 'auto-run'), undefined);

  f.setRuns([]); f.setQueue([]); f.setState(null);
  f.setStatus({ phase: 'idle', runId: null, isOwner: false, canExit: false, error: null });
  view.update();
  view.openAutomatically();
  assert.equal(panel.dataset.orchestrationClosed, 'true', 'a later automatic open respects the dismissal');
  assert.equal(action(panel, 'open'), undefined);
  assert.equal(panel.hidden, true);
  assert.equal(action(panel, 'close'), undefined);

  view.open();
  assert.equal(panel.dataset.orchestrationClosed, 'false');
  assert.ok(action(panel, 'close'), 'explicit open clears dismissal and shows the manager');
  assert.equal(f.calls.length, 0);
  view.dispose();
});

test('a dismissed manager keeps only local exit until local playback ends', t => {
  const page = dom(t); const f = fixture();
  f.setRuns([runEntry('local-run', 'Local sequence', 'playing')]);
  f.setStatus({ phase: 'playing', runId: 'local-run', isOwner: true, canExit: true, error: null });
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  click(panel, action(panel, 'close')!);

  assert.equal(panel.hidden, false);
  assert.ok(action(panel, 'exit'), 'local Exit remains available');
  assert.equal(action(panel, 'exit')!.disabled, false);
  assert.equal(action(panel, 'open'), undefined, 'reopening belongs to the scene controls and editor');
  assert.equal(action(panel, 'stop'), undefined);
  assert.equal(select(panel, 'run', 'local-run'), undefined);
  click(panel, action(panel, 'exit')!);
  assert.ok(f.calls.includes('exit-local:local-run'));

  f.setRuns([]); f.setState(null);
  f.setStatus({ phase: 'idle', runId: null, isOwner: false, canExit: false, error: null });
  view.update();
  assert.equal(panel.hidden, true);
  assert.equal(action(panel, 'exit'), undefined);
  assert.equal(action(panel, 'open'), undefined);
  assert.equal(panel.hidden, true);
  view.dispose();
});

test('close stays available during an async command and stays closed through completion and idle', async t => {
  const page = dom(t); const f = fixture();
  f.setRuns([runEntry('run-a', 'Sequence A', 'holding')]);
  let finishPause!: () => void;
  f.setPauseHandler(id => { f.calls.push(`pause:${id}`); return new Promise<void>(resolve => { finishPause = resolve; }); });
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  click(panel, action(panel, 'pause')!);
  const close = action(panel, 'close')!;
  assert.equal(close.disabled, false);
  click(panel, close);
  assert.equal(panel.dataset.orchestrationClosed, 'true');
  assert.deepEqual(f.calls, ['pause:run-a'], 'close did not call an additional coordinator operation');

  f.setRuns([runEntry('run-a', 'Sequence A', 'paused')]);
  f.setState({ ...f.coordinator.state!, head: 2 });
  f.setStatus({ phase: 'paused', runId: null, isOwner: true, canExit: false, error: null });
  view.update();
  assert.equal(panel.dataset.orchestrationClosed, 'true');
  assert.equal(action(panel, 'open'), undefined);
  assert.equal(panel.hidden, true);
  finishPause();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(panel.dataset.orchestrationClosed, 'true', 'the async completion cannot reopen the manager');
  assert.equal(action(panel, 'open'), undefined);
  assert.equal(panel.hidden, true);
  assert.deepEqual(f.calls, ['pause:run-a']);

  f.setRuns([]); f.setQueue([]); f.setState(null);
  f.setStatus({ phase: 'idle', runId: null, isOwner: false, canExit: false, error: null });
  view.update();
  assert.equal(panel.dataset.orchestrationClosed, 'true', 'idle after automatic playback remains dismissed');
  assert.equal(action(panel, 'open'), undefined);
  assert.equal(panel.hidden, true);
  view.dispose();
});

test('explicit open restores the dismissed manager without a persistent reopen button', t => {
  const page = dom(t); const f = fixture();
  const view = viewFor(f.coordinator); const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  click(panel, action(panel, 'close')!);
  assert.equal(panel.hidden, true);
  assert.equal(action(panel, 'open'), undefined);
  view.open();
  assert.equal(panel.hidden, false);
  assert.ok(action(panel, 'close'));
  assert.equal(action(panel, 'open'), undefined);
  assert.deepEqual(f.calls, [], 'opening the manager does not change playback');
  view.dispose();
});

test('explicit open focuses the manager and idle close returns to its external launcher', t => {
  const page = dom(t); const f = fixture();
  const launcher = new page.FakeElement('button');
  page.page.body!.append(launcher);
  launcher.focus();
  const view = viewFor(f.coordinator);
  const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
  view.open();
  assert.equal(page.page.activeElement?.dataset.orchestrationAction, 'close');
  click(panel, action(panel, 'close')!);
  assert.equal(panel.hidden, true);
  assert.equal(page.page.activeElement, launcher);
  view.dispose();
});

for (const ending of ['exit', 'natural'] as const) {
  test(`dismissed local controls return focus to the launcher after ${ending}`, t => {
    const page = dom(t); const f = fixture();
    const launcher = new page.FakeElement('button'); page.page.body!.append(launcher); launcher.focus();
    f.setRuns([runEntry('local-run', 'Local sequence', 'playing')]);
    f.setStatus({ phase: 'playing', runId: 'local-run', isOwner: true, canExit: true, error: null });
    const view = viewFor(f.coordinator);
    const panel = view.element as unknown as InstanceType<typeof page.FakeElement>;
    view.open(); click(panel, action(panel, 'close')!);
    assert.equal(page.page.activeElement?.dataset.orchestrationAction, 'exit');
    if (ending === 'exit') click(panel, action(panel, 'exit')!);
    f.setRuns([]); f.setState(null);
    f.setStatus({ phase: 'idle', runId: null, isOwner: false, canExit: false, error: null });
    view.update();
    assert.equal(panel.hidden, true);
    assert.equal(page.page.activeElement, launcher);
    view.dispose();
  });
}
