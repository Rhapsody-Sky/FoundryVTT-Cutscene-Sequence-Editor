import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AudioGate } from '../src/ui/audio-gate.js';
import { CompositionRenderer } from '../src/rendering/composition-renderer.js';
import type { AudioClip } from '../src/domain/sequence.js';

class FakeTarget extends EventTarget {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  get listenerCount() { return [...this.listeners.values()].reduce((total, list) => total + list.size, 0); }
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    const [type, listener] = args;
    if (listener) { const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>(); listeners.add(listener); this.listeners.set(type, listeners); }
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    const [type, listener] = args;
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(...args);
  }
}
class FakeNode extends FakeTarget {
  children: FakeNode[] = []; parent: FakeNode | null = null;
  style: Record<string, string> = {}; dataset: Record<string, string> = {};
  className = ''; textContent = ''; type = ''; disabled = false; removed = false;
  readonly attributes = new Map<string, string>();
  constructor(readonly tag = 'div') { super(); }
  append(...children: FakeNode[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
}
const flush = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
function fixture(t: TestContext) {
  const body = new FakeNode('body'), window = new FakeTarget();
  let inClick = false;
  let elementFactory = (tag: string): FakeNode => new FakeNode(tag);
  function install(key: string, value: unknown) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  install('document', { body, createElement: (tag: string) => elementFactory(tag) });
  install('window', window);
  const gate = new AudioGate(key => key); t.after(() => gate.dispose());
  const panel = () => { assert.equal(body.children.length, 1); return body.children[0]!; };
  const enable = () => panel().children[1]!;
  const cancel = () => panel().children[2]!;
  const click = (node = enable()) => { inClick = true; try { node.dispatchEvent(new Event('click')); } finally { inClick = false; } };
  return { body, window, gate, panel, enable, cancel, click, install, inClick: () => inClick,
    setFactory: (factory: typeof elementFactory) => { elementFactory = factory; } };
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function trackedController() {
  const controller = new AbortController(), listeners = new Set<EventListenerOrEventListenerObject>();
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => {
    if (args[0] === 'abort' && args[1]) listeners.add(args[1]); add(...args);
  };
  controller.signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => {
    if (args[0] === 'abort' && args[1]) listeners.delete(args[1]); remove(...args);
  };
  return { controller, signal: controller.signal, listenerCount: () => listeners.size };
}

test('one panel invokes every pending unlock synchronously within one gesture', async t => {
  const { gate, panel, enable, body, window, click, inClick } = fixture(t);
  const a = deferred(), b = deferred(), first = trackedController(), second = trackedController();
  const calls: string[] = [];
  const one = gate.request(() => { assert.equal(inClick(), true); calls.push('first'); return a.promise; }, first.signal);
  const retained = panel();
  const two = gate.request(() => { assert.equal(inClick(), true); calls.push('second'); return b.promise; }, second.signal);
  assert.equal(panel(), retained); assert.equal(window.listenerCount, 1);
  click(); assert.deepEqual(calls, ['first', 'second']); assert.equal(enable().disabled, true);
  a.resolve(); await one; assert.equal(body.children.length, 1); assert.equal(first.listenerCount(), 0);
  b.resolve(); await two; assert.equal(body.children.length, 0); assert.equal(window.listenerCount, 0);
  assert.equal(second.listenerCount(), 0); assert.equal(retained.children[1]!.listenerCount, 0); assert.equal(retained.children[2]!.listenerCount, 0);
});

test('aborting one request retains the other request and removes only its signal listener', async t => {
  const { gate, panel, click, body } = fixture(t);
  const first = trackedController(), second = trackedController(); let calls = 0;
  const one = gate.request(async () => { assert.fail('Aborted request was invoked'); }, first.signal);
  const failed = assert.rejects(one, /MEDIA_CANCELLED/);
  const two = gate.request(async () => { calls += 1; }, second.signal);
  const retained = panel(); first.controller.abort(); await failed;
  assert.equal(panel(), retained); assert.equal(first.listenerCount(), 0); assert.equal(second.listenerCount(), 1);
  click(); await two; assert.equal(calls, 1); assert.equal(body.children.length, 0); assert.equal(second.listenerCount(), 0);
});

test('cancel, Escape, and dispose reject all pending requests and release panel/listeners', async t => {
  for (const action of ['cancel', 'escape', 'dispose']) {
    const { gate, panel, cancel, click, body, window } = fixture(t);
    const first = trackedController(), second = trackedController(); let calls = 0;
    const one = gate.request(async () => { calls += 1; }, first.signal);
    const two = gate.request(async () => { calls += 1; }, second.signal);
    const rejected = Promise.all([assert.rejects(one, /MEDIA_CANCELLED/), assert.rejects(two, /MEDIA_CANCELLED/)]);
    const retained = panel();
    if (action === 'cancel') click(cancel());
    if (action === 'escape') {
      const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value: 'Escape' });
      window.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
    }
    if (action === 'dispose') { gate.dispose(); gate.dispose(); }
    await rejected; assert.equal(calls, 0); assert.equal(body.children.length, 0); assert.equal(window.listenerCount, 0);
    assert.equal(first.listenerCount(), 0); assert.equal(second.listenerCount(), 0);
    assert.equal(retained.children[1]!.listenerCount, 0); assert.equal(retained.children[2]!.listenerCount, 0);
    retained.children[1]!.dispatchEvent(new Event('click')); assert.equal(calls, 0);
    gate.dispose(); await assert.rejects(gate.request(async () => {}, new AbortController().signal), /MEDIA_CANCELLED/);
  }
});

test('partial failure retries only remaining callbacks and keeps successful work completed', async t => {
  const { gate, panel, click, enable, body } = fixture(t);
  let completedCalls = 0, failedCalls = 0;
  const one = gate.request(async () => { completedCalls += 1; }, new AbortController().signal);
  const two = gate.request(async () => { failedCalls += 1; if (failedCalls === 1) throw new Error('Blocked'); }, new AbortController().signal);
  const retained = panel(); click(); await one; await flush();
  assert.equal(panel(), retained); assert.equal(enable().disabled, false);
  assert.equal(panel().children[3]!.textContent, 'STAGECRAFT.Error.MEDIA_AUTOPLAY');
  click(); await two; assert.equal(completedCalls, 1); assert.equal(failedCalls, 2); assert.equal(body.children.length, 0);
});

test('a synchronous callback failure does not stop other callbacks receiving the same gesture', async t => {
  const { gate, click, inClick, body } = fixture(t); let failures = 0, successes = 0;
  const one = gate.request(() => { assert.equal(inClick(), true); failures += 1; if (failures === 1) throw new Error('Blocked'); return Promise.resolve(); }, new AbortController().signal);
  const two = gate.request(() => { assert.equal(inClick(), true); successes += 1; return Promise.resolve(); }, new AbortController().signal);
  click(); assert.equal(failures, 1); assert.equal(successes, 1); await two;
  click(); await one; assert.equal(failures, 2); assert.equal(successes, 1); assert.equal(body.children.length, 0);
});

test('a new request during an in-flight unlock receives its own gesture without restarting that unlock', async t => {
  const { gate, panel, click, enable, inClick, body } = fixture(t);
  const first = deferred(); let firstCalls = 0, newCalls = 0;
  const one = gate.request(() => { firstCalls += 1; return first.promise; }, new AbortController().signal);
  click(); assert.equal(enable().disabled, true); const retained = panel();
  const two = gate.request(() => { assert.equal(inClick(), true); newCalls += 1; return Promise.resolve(); }, new AbortController().signal);
  assert.equal(panel(), retained); assert.equal(enable().disabled, false);
  click(); await two; assert.equal(firstCalls, 1); assert.equal(newCalls, 1); assert.equal(body.children.length, 1);
  first.resolve(); await one; assert.equal(body.children.length, 0);
});

test('late success or failure after cancel cannot resurrect a panel or interfere with a new request', async t => {
  const { gate, panel, click, cancel, body, window } = fixture(t);
  const first = deferred(), second = deferred();
  const one = gate.request(() => first.promise, new AbortController().signal);
  const two = gate.request(() => second.promise, new AbortController().signal);
  const rejected = Promise.all([assert.rejects(one, /MEDIA_CANCELLED/), assert.rejects(two, /MEDIA_CANCELLED/)]);
  const oldPanel = panel(); click(); click(cancel()); await rejected;
  const fresh = gate.request(async () => {}, new AbortController().signal); const newPanel = panel();
  assert.notEqual(newPanel, oldPanel); first.resolve(); second.reject(new Error('Late failure')); await flush();
  assert.equal(panel(), newPanel); assert.equal(newPanel.children[3]!.textContent, ''); assert.equal(window.listenerCount, 1);
  click(); await fresh; assert.equal(body.children.length, 0); assert.equal(window.listenerCount, 0);
});

test('an aborted in-flight request settles immediately without affecting the other unlock', async t => {
  const { gate, click, panel, body } = fixture(t);
  const first = deferred(), second = deferred(), controller = trackedController();
  const one = gate.request(() => first.promise, controller.signal);
  const rejected = assert.rejects(one, /MEDIA_CANCELLED/);
  const two = gate.request(() => second.promise, new AbortController().signal);
  click(); controller.controller.abort(); await rejected; assert.equal(controller.listenerCount(), 0); panel();
  first.resolve(); await flush(); panel(); second.resolve(); await two; assert.equal(body.children.length, 0);
});

test('two blocked sound renderers share one AudioGate and become ready after one synchronous click', async t => {
  const { gate, inClick, setFactory, install, click, body } = fixture(t);
  const media: FakeMedia[] = []; let contexts = 0, closed = 0, resumes = 0;
  class FakeMedia extends FakeNode {
    src = ''; preload = ''; controls = false; loop = false; muted = false; volume = 1;
    paused = true; seeking = false; ended = false; duration = 5; readyState = 4; currentTime = 0; playbackRate = 1;
    error = null; plays = 0; buffered = { length: 1, start: () => 0, end: () => 5 };
    play() {
      this.plays += 1;
      if (!inClick()) return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
      this.paused = false; return Promise.resolve();
    }
    pause() { this.paused = true; }
    load() {}
    removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  }
  class FakeContext {
    state = 'suspended'; destination = {};
    constructor() { contexts += 1; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    resume() { assert.equal(inClick(), true); resumes += 1; this.state = 'running'; return Promise.resolve(); }
    async close() { closed += 1; }
  }
  setFactory(tag => { if (tag !== 'audio') return new FakeNode(tag); const audio = new FakeMedia(tag); media.push(audio); return audio; });
  install('AudioContext', FakeContext);
  const clips: AudioClip[] = ['one', 'two'].map(id => ({
    id, trackId: `sound-${id}`, type: 'audio', typeVersion: 1, startMs: 0, duration: { kind: 'media' },
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { source: { kind: 'foundry-file', path: `worlds/test/${id}.ogg` }, durationMs: 5000, volume: 0.8, muted: false }
  }));
  const composition = new CompositionRenderer(clips, new FakeNode() as unknown as HTMLElement, { width: 100, height: 100 }, {
    signal: new AbortController().signal, requestAudioUnlock: (unlock, signal) => gate.request(unlock, signal)
  });
  t.after(() => composition.dispose());
  const preparation = composition.prepare(); await flush();
  assert.equal(body.children.length, 1); assert.equal(contexts, 1); assert.deepEqual(media.map(node => node.plays), [1, 1]);
  click(); assert.deepEqual(media.map(node => node.plays), [2, 2]); assert.equal(resumes, 2);
  await preparation; assert.equal(body.children.length, 0); assert.ok(media.every(node => node.paused));
  composition.dispose(); await flush(); assert.equal(closed, 1);
});
