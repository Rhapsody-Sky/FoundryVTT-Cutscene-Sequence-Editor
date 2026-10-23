import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackVolumeHud } from '../src/ui/playback-volume-hud.js';
import type { PlaybackVolume } from '../src/application/playback-volume.js';

class TrackedEventTarget extends EventTarget {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, list) => total + list.size, 0);
  }

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (listener) {
      const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
}

class FakeElement extends TrackedEventTarget {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  className = '';
  textContent: string | null = '';
  type = '';
  min = '';
  max = '';
  step = '';
  value = '';
  focusCalls = 0;
  parent: FakeElement | null = null;
  removed = false;
  readonly classList = {
    add: (name: string) => { if (!this.hasClass(name)) this.className = [this.className, name].filter(Boolean).join(' '); },
    remove: (name: string) => { this.className = this.className.split(/\s+/).filter(item => item && item !== name).join(' '); },
    contains: (name: string) => this.hasClass(name)
  };

  constructor(readonly tagName: string) { super(); }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) { node.parent = this; this.children.push(node); }
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }

  contains(node: Node): boolean {
    return node === this as unknown as Node || this.children.some(child => child.contains(node));
  }

  focus(): void { this.focusCalls += 1; this.parent?.dispatchEvent(new Event('focusin')); }

  remove(): void {
    this.removed = true;
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  private hasClass(name: string): boolean { return this.className.split(/\s+/).includes(name); }
}

interface FakeClock {
  readonly pendingCount: number;
  pendingDelays(): number[];
  runNext(): boolean;
}

function fixture(t: TestContext) {
  const body = new FakeElement('body');
  const windowTarget = new TrackedEventTarget();
  let nextTimerId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };
  install('document', { body, createElement: (tag: string) => new FakeElement(tag) });
  install('window', windowTarget);
  install('setTimeout', (callback: () => void, delay = 0) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, delay });
    return id;
  });
  install('clearTimeout', (id: number) => { timers.delete(id); });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const clock: FakeClock = {
    get pendingCount() { return timers.size; },
    pendingDelays: () => [...timers.values()].map(timer => timer.delay),
    runNext: () => {
      const entry = timers.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
      if (!entry) return false;
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
      return true;
    }
  };
  return { body, windowTarget, clock };
}

function makeVolume(initial: number) {
  let value = initial;
  const listeners = new Set<(value: number) => void>();
  const writes: number[] = [];
  const publish = (next: number) => { value = next; for (const listener of listeners) listener(value); };
  const port: PlaybackVolume = {
    get value() { return value; },
    set(next) { writes.push(next); publish(next); },
    subscribe(listener) { listeners.add(listener); listener(value); return () => { listeners.delete(listener); }; }
  };
  return { port, publish, writes, subscriberCount: () => listeners.size };
}

function hudElements(hud: PlaybackVolumeHud): { root: FakeElement; slider: FakeElement; readout: FakeElement } {
  const root = hud.element as unknown as FakeElement;
  const slider = root.children[0]!;
  const readout = root.children[1]!;
  return { root, slider, readout };
}

function pointerEvent(type: string, pointerId: number): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

test('reveal stays detached, does not focus, and hides after 2500ms idle', t => {
  const { body, clock } = fixture(t);
  const volume = makeVolume(0.42);
  const hud = new PlaybackVolumeHud(volume.port, { label: 'Playback volume' });
  t.after(() => hud.dispose());
  const { root, slider, readout } = hudElements(hud);

  assert.equal(body.children.length, 0, 'the surface decides which root receives the HUD');
  assert.equal(root.classList.contains('is-hidden'), true);
  assert.equal(slider.type, 'range');
  assert.equal(slider.min, '0');
  assert.equal(slider.max, '1');
  assert.equal(slider.step, '0.01');
  assert.equal(slider.getAttribute('aria-label'), 'Playback volume');
  assert.equal(slider.getAttribute('aria-valuetext'), '42%');
  assert.equal(readout.textContent, '42%');

  hud.reveal();
  assert.equal(root.classList.contains('is-hidden'), false);
  assert.equal(slider.focusCalls, 0);
  assert.deepEqual(clock.pendingDelays(), [2500]);
  hud.reveal();
  assert.equal(clock.pendingCount, 1, 'movement refreshes a single idle timer');
  assert.equal(clock.runNext(), true);
  assert.equal(root.classList.contains('is-hidden'), true);
});

test('hover and keyboard focus hold the HUD open until both are gone', t => {
  const { clock } = fixture(t);
  const hud = new PlaybackVolumeHud(makeVolume(0.5).port, { label: 'Playback volume' });
  t.after(() => hud.dispose());
  const { root, slider } = hudElements(hud);

  hud.reveal();
  root.dispatchEvent(new Event('pointerenter'));
  assert.equal(clock.pendingCount, 0);
  clock.runNext();
  assert.equal(root.classList.contains('is-hidden'), false);

  root.dispatchEvent(new Event('pointerleave'));
  assert.equal(clock.pendingCount, 1);
  slider.focus();
  assert.equal(slider.focusCalls, 1);
  assert.equal(clock.pendingCount, 0);
  clock.runNext();
  assert.equal(root.classList.contains('is-hidden'), false);

  root.dispatchEvent(new Event('focusout'));
  assert.equal(clock.pendingCount, 1);
  clock.runNext();
  assert.equal(root.classList.contains('is-hidden'), true);
});

test('a drag stays visible and removes global listeners on pointerup or pointercancel', t => {
  for (const endType of ['pointerup', 'pointercancel']) {
    const { windowTarget, clock } = fixture(t);
    const hud = new PlaybackVolumeHud(makeVolume(0.7).port, { label: 'Playback volume' });
    const { root, slider } = hudElements(hud);

    slider.dispatchEvent(pointerEvent('pointerdown', 19));
    assert.equal(root.classList.contains('is-hidden'), false);
    assert.equal(windowTarget.listenerCount, 2);
    assert.equal(clock.pendingCount, 0);

    windowTarget.dispatchEvent(pointerEvent(endType, 3));
    assert.equal(windowTarget.listenerCount, 2, 'a different pointer cannot finish the drag');
    windowTarget.dispatchEvent(pointerEvent(endType, 19));
    assert.equal(windowTarget.listenerCount, 0);
    assert.equal(clock.pendingDelays()[0], 2500);
    clock.runNext();
    assert.equal(root.classList.contains('is-hidden'), true);
    hud.dispose();
    assert.equal(windowTarget.listenerCount, 0);
  }
});

test('the range sanitizes writes and follows external volume changes through the port', t => {
  const { clock } = fixture(t);
  const volume = makeVolume(0.33);
  const hud = new PlaybackVolumeHud(volume.port, { label: 'Playback volume' });
  t.after(() => hud.dispose());
  const { slider, readout } = hudElements(hud);

  slider.value = '1.6';
  slider.dispatchEvent(new Event('input'));
  assert.deepEqual(volume.writes, [1]);
  assert.equal(slider.value, '1');
  assert.equal(readout.textContent, '100%');

  slider.value = '-0.4';
  slider.dispatchEvent(new Event('input'));
  assert.deepEqual(volume.writes, [1, 0]);
  assert.equal(slider.value, '0');
  assert.equal(readout.textContent, '0%');

  slider.value = 'NaN';
  slider.dispatchEvent(new Event('input'));
  assert.deepEqual(volume.writes, [1, 0], 'invalid input never reaches the application port');
  assert.equal(slider.value, '0');

  volume.publish(2);
  assert.equal(slider.value, '1');
  assert.equal(readout.textContent, '100%');
  volume.publish(-0.25);
  assert.equal(slider.value, '0');
  assert.equal(readout.textContent, '0%');
  volume.publish(Number.NaN);
  assert.equal(slider.value, '0', 'a non-finite notification retains the last safe value');
  assert.equal(clock.pendingCount, 0);
});

test('dispose clears timers, active window listeners, local handlers, and port subscription', t => {
  const { windowTarget, clock } = fixture(t);
  const volume = makeVolume(0.2);
  const hud = new PlaybackVolumeHud(volume.port, { label: 'Playback volume' });
  const { root, slider } = hudElements(hud);

  hud.reveal();
  slider.dispatchEvent(pointerEvent('pointerdown', 5));
  assert.equal(volume.subscriberCount(), 1);
  assert.equal(windowTarget.listenerCount, 2);
  assert.equal(root.listenerCount + slider.listenerCount, 6);
  assert.equal(slider.focusCalls, 0);

  hud.dispose();
  hud.dispose();
  assert.equal(volume.subscriberCount(), 0);
  assert.equal(windowTarget.listenerCount, 0);
  assert.equal(root.listenerCount + slider.listenerCount, 0);
  assert.equal(clock.pendingCount, 0);
  assert.equal(root.removed, true);
  volume.publish(0.9);
  assert.equal(slider.value, '0.2', 'removed HUD ignores later port updates');
});
