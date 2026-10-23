import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_CAPTURE_PRIORITY, createFoundryBoardBackdrop } from '../src/integrations/foundry/board-backdrop.js';
import type { BoardBackdropEnvironment, BoardBackdropHost, BoardTicker } from '../src/integrations/foundry/board-backdrop.js';

class FakeCanvas extends EventTarget {
  width = 800;
  height = 600;
  isConnected = true;
  rect = { left: 20, top: 30, width: 400, height: 300 };
  draws: unknown[][] = [];
  clears = 0;
  unavailable = false;
  getBoundingClientRect() { return this.rect; }
  getContext() {
    if (this.unavailable) return null;
    return {
      clearRect: () => { this.clears++; },
      drawImage: (...args: unknown[]) => { this.draws.push(args); }
    };
  }
}

function fixture() {
  let now = 0;
  let board: FakeCanvas | null = new FakeCanvas();
  const snapshots: FakeCanvas[] = [];
  const callbacks = new Map<() => void, number>();
  const timers = new Map<object, { readonly at: number; readonly callback: () => void }>();
  const ticker: BoardTicker = {
    add: (callback, _context, priority) => { callbacks.set(callback, priority!); },
    remove: callback => { callbacks.delete(callback); }
  };
  const canvas = { ready: true, scene: {} as object | null, app: { ticker } };
  const host: BoardBackdropHost = { canvas };
  const environment: BoardBackdropEnvironment = {
    board: () => board as unknown as HTMLCanvasElement | null,
    createCanvas: () => { const value = new FakeCanvas(); snapshots.push(value); return value as unknown as HTMLCanvasElement; },
    now: () => now,
    schedule: (callback, delayMs) => { const id = {}; timers.set(id, { callback, at: now + delayMs }); return id; },
    cancel: id => { timers.delete(id as object); }
  };
  const controller = new AbortController();
  const supplier = createFoundryBoardBackdrop(host, 'canvas', environment);
  const rect = { left: 100, top: 200, width: 320, height: 180 };
  return {
    supplier, rect, environment, controller, canvas, snapshots, callbacks, timers,
    get board() { return board; },
    set board(value: FakeCanvas | null) { board = value; },
    request: () => supplier(rect, controller.signal),
    tick: () => { for (const callback of [...callbacks.keys()]) callback(); },
    advance(ms: number) {
      now += ms;
      for (const [id, task] of [...timers]) {
        if (task.at <= now) { timers.delete(id); task.callback(); }
      }
    }
  };
}

test('live backdrop subscribes lazily and captures only after the native board render priority', () => {
  const f = fixture();
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.request(), null, 'an allocated but uncaptured image is not ready');
  assert.equal(f.callbacks.size, 1);
  assert.deepEqual([...f.callbacks.values()], [BOARD_CAPTURE_PRIORITY]);
  assert.ok(BOARD_CAPTURE_PRIORITY < -50);
  assert.equal(f.snapshots[0]!.draws.length, 0, 'the consumer never samples WebGL between native renders');
  f.tick();
  const frame = f.request()!;
  assert.deepEqual(f.snapshots[0]!.draws, [[f.board, 0, 0]]);
  assert.equal(f.request()!.source, frame.source, 'the frame borrows one stable readable source');
  assert.equal(f.snapshots[0]!.draws.length, 1, 'requesting the image does not redraw the board');
  assert.equal(f.board!.draws.length, 0);
  f.controller.abort();
});

test('capture demand expires when unused and resumes on the next consumer request', () => {
  const f = fixture();
  f.request();
  f.tick();
  const frame = f.request()!;
  f.advance(149);
  f.tick();
  assert.equal(f.snapshots[0]!.draws.length, 2);
  f.advance(1);
  assert.equal(f.callbacks.size, 0);
  f.tick();
  assert.equal(f.snapshots[0]!.draws.length, 2);
  assert.equal(f.request()!.source, frame.source);
  assert.equal(f.callbacks.size, 1);
  f.tick();
  assert.equal(f.snapshots[0]!.draws.length, 3);
  f.controller.abort();
});

test('abort detaches ticker and releases the capture canvas; separate surfaces retain their own resources', () => {
  const f = fixture();
  f.request();
  const otherController = new AbortController();
  const other = createFoundryBoardBackdrop({ canvas: f.canvas }, 'window', f.environment);
  assert.equal(other(f.rect, otherController.signal), null);
  f.tick();
  const second = other(f.rect, otherController.signal)!;
  assert.equal(f.callbacks.size, 2);
  assert.notEqual(second.source, f.snapshots[0]);
  f.controller.abort();
  assert.equal(f.callbacks.size, 1);
  assert.equal(f.snapshots[0]!.width, 0);
  assert.equal(f.snapshots[0]!.height, 0);
  assert.equal(f.request(), null);
  f.tick();
  assert.equal(f.snapshots[1]!.draws.length, 2);
  otherController.abort();
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.timers.size, 0);
});

test('board resize updates backing pixels and live viewport placement while preview uses the supplied rect', () => {
  const f = fixture();
  f.request(); f.tick();
  const first = f.request()!;
  assert.deepEqual(first.rect, f.board!.rect);
  f.board!.width = 1600;
  f.board!.height = 1200;
  f.board!.rect = { left: -40, top: 60, width: 700, height: 500 };
  assert.equal(f.request(), null, 'resizing invalidates the old captured frame');
  f.tick();
  const resized = f.request()!;
  assert.equal(resized.source, first.source);
  assert.deepEqual(resized.rect, f.board!.rect);
  assert.equal(f.snapshots[0]!.width, 1600);
  assert.equal(f.snapshots[0]!.height, 1200);
  const previewController = new AbortController();
  const preview = createFoundryBoardBackdrop({ canvas: f.canvas }, 'preview', f.environment);
  assert.equal(preview(f.rect, previewController.signal), null);
  f.tick();
  const frame = preview(f.rect, previewController.signal)!;
  assert.deepEqual(frame.rect, f.rect);
  assert.notEqual(frame.rect, f.rect);
  previewController.abort();
  f.controller.abort();
});

test('missing board, unavailable scene and context loss produce null and never retain a stale scene image', () => {
  const f = fixture();
  f.request();
  f.tick();
  const captured = f.snapshots[0]!;
  f.canvas.ready = false;
  assert.equal(f.request(), null);
  assert.equal(captured.width, 0);
  assert.equal(f.callbacks.size, 0);
  f.canvas.ready = true;
  f.canvas.scene = null;
  assert.equal(f.request(), null);
  f.canvas.scene = {};
  f.request();
  f.tick();
  const previous = f.snapshots.at(-1)!;
  f.canvas.scene = {};
  assert.equal(f.request(), null, 'a new scene cannot use its empty allocation as a snapshot');
  assert.notEqual(f.snapshots.at(-1), previous);
  assert.equal(previous.width, 0);
  assert.equal(f.snapshots.at(-1)!.draws.length, 0);
  f.board!.dispatchEvent(new Event('webglcontextlost'));
  assert.equal(f.request(), null);
  f.board!.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(f.request(), null);
  f.tick();
  assert.ok(f.request());
  f.board = null;
  assert.equal(f.request(), null);
  assert.equal(f.callbacks.size, 0);
  f.controller.abort();
});

test('disconnected, zero-sized and unreadable boards fail without a capture or UI screenshot', () => {
  const f = fixture();
  f.board!.isConnected = false;
  assert.equal(f.request(), null);
  f.board!.isConnected = true;
  f.board!.rect.width = 0;
  assert.equal(f.request(), null);
  f.board!.rect.width = 400;
  f.board!.width = 0;
  assert.equal(f.request(), null);
  assert.equal(f.snapshots.length, 0);
  f.board!.width = 800;
  const environment = { ...f.environment, createCanvas: () => {
    const canvas = new FakeCanvas(); canvas.unavailable = true;
    return canvas as unknown as HTMLCanvasElement;
  } };
  const supplier = createFoundryBoardBackdrop({ canvas: f.canvas }, 'canvas', environment);
  assert.equal(supplier(f.rect, f.controller.signal), null);
  assert.equal(f.callbacks.size, 0);
  f.controller.abort();
});
