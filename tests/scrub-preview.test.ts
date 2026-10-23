import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { LocalPlayer, type PlayerFrame } from '../src/playback/local-player.js';
import { compileSequence, type CompiledSequence } from '../src/playback/evaluate.js';
import { createBarsSequence } from '../src/domain/validation.js';
import { DomSurface } from '../src/rendering/dom-surface.js';

function harness() {
  let id = 0;
  const makeId = () => `scrub-${++id}`;
  const services: EditorServices = {
    makeId, repository: { list: async () => [], read: async () => null, save: async s => s, delete: async () => {} },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }),
    localize: key => key, confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {},
    prepareGroup: async () => { throw new Error('Scrub cannot prepare a group'); }, openSession: () => {},
    groupActive: () => false, chooseVideo: async () => null, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services);
  const plan = compileSequence(createBarsSequence('Scrub', makeId));
  const request = (version: number) => ({ version, plan, frame: { positionMs: version, items: [], opacity: 1, phase: 'paused' } as PlayerFrame });
  type Request = ReturnType<typeof request>;
  const driver = view as unknown as {
    mounted: boolean; staticPrepared: boolean; staticPreview: DomSurface; staticAbort: AbortController;
    staticLatest: Request; staticQueue: Promise<void>;
    queueStillUpdate(surface: DomSurface, request: Request): void;
  };
  driver.mounted = true; driver.staticPrepared = true; driver.staticAbort = new AbortController();
  return { driver, request };
}

test('scrub bursts keep one pending worker and render only the latest request', async () => {
  const { driver, request } = harness();
  let release!: () => void, updates = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const frames: number[] = [];
  const surface = {
    updateStill: async (_plan: CompiledSequence) => { updates++; if (updates === 1) await blocked; },
    render: (frame: PlayerFrame) => frames.push(frame.positionMs)
  } as unknown as DomSurface;
  driver.staticPreview = surface;
  driver.staticLatest = request(1); driver.queueStillUpdate(surface, driver.staticLatest);
  const worker = driver.staticQueue;
  for (let version = 2; version <= 500; version++) {
    driver.staticLatest = request(version); driver.queueStillUpdate(surface, driver.staticLatest);
    assert.equal(driver.staticQueue, worker, 'no per-pointer promise chain');
  }
  release(); await driver.staticQueue;
  assert.deepEqual(frames, [500]); assert.equal(updates, 2);
  driver.staticLatest = request(501); driver.queueStillUpdate(surface, driver.staticLatest);
  await driver.staticQueue; assert.deepEqual(frames, [500, 501]);
});

test('a replaced preview does not wait for or render the old surface', async () => {
  const { driver, request } = harness();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let oldFrames = 0, newFrames = 0;
  const oldSurface = { updateStill: () => blocked, render: () => { oldFrames++; } } as unknown as DomSurface;
  driver.staticPreview = oldSurface; driver.staticLatest = request(1); driver.queueStillUpdate(oldSurface, driver.staticLatest);
  const oldWorker = driver.staticQueue;
  const nextSurface = { updateStill: async () => {}, render: () => { newFrames++; } } as unknown as DomSurface;
  driver.staticPreview = nextSurface; driver.staticLatest = request(2); driver.queueStillUpdate(nextSurface, driver.staticLatest);
  await driver.staticQueue; assert.equal(newFrames, 1);
  release(); await oldWorker; assert.equal(oldFrames, 0);
});

test('disposed still updates suppress cancellation notices but active failures are reported', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null, body: {} } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document'); });
  for (const cancelled of [true, false]) {
    const errors: unknown[] = [];
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const surface = new DomSurface({ target: 'preview', still: true, onError: error => errors.push(error) });
    (surface as unknown as { renderer: unknown }).renderer = { updateStill: () => pending, dispose() {} };
    const { request } = harness();
    const work = surface.updateStill(request(1).plan);
    if (cancelled) surface.dispose();
    const failure = new Error(cancelled ? 'aborted' : 'load failed');
    reject(failure); await assert.rejects(work, failure);
    assert.deepEqual(errors, cancelled ? [] : [failure]);
    surface.dispose();
  }
});
