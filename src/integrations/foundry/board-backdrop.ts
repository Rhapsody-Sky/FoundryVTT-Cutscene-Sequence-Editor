import type { BackdropRect, BoardBackdropFrame } from '../../rendering/element-renderer.js';

export interface BoardTicker {
  add(callback: () => void, context?: unknown, priority?: number): unknown;
  remove(callback: () => void, context?: unknown): unknown;
}

export interface BoardBackdropHost {
  readonly canvas?: {
    readonly ready: boolean;
    readonly scene?: object | null;
    readonly app?: { readonly ticker: BoardTicker };
  };
}

/** Browser ports keep the capture policy testable without creating a Foundry renderer. */
export interface BoardBackdropEnvironment {
  board(): HTMLCanvasElement | null;
  createCanvas(): HTMLCanvasElement;
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

const browserEnvironment: BoardBackdropEnvironment = {
  board: () => document.querySelector<HTMLCanvasElement>('canvas#board'),
  createCanvas: () => document.createElement('canvas'),
  now: () => performance.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

/** PIXI's application render listener runs at -50; the snapshot follows in the same tick. */
export const BOARD_CAPTURE_PRIORITY = -51;
const ACTIVE_REQUEST_MS = 150;

/**
 * Copies only Foundry's board, immediately after its native render. The stable 2D
 * source remains readable after WebGL discards its drawing buffer at frame end.
 */
export function createFoundryBoardBackdrop(
  host: BoardBackdropHost,
  target: 'preview' | 'window' | 'canvas',
  environment: BoardBackdropEnvironment = browserEnvironment
): (surfaceRect: BackdropRect, signal: AbortSignal) => BoardBackdropFrame | null {
  let snapshot: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let board: HTMLCanvasElement | null = null;
  let scene: object | null | undefined;
  let ticker: BoardTicker | null = null;
  let currentSignal: AbortSignal | null = null;
  let timer: unknown;
  let lastRequest = Number.NEGATIVE_INFINITY;
  let disposed = false;
  let contextLost = false;
  let captured = false;

  const clearSnapshot = () => {
    captured = false;
    if (snapshot) { snapshot.width = 0; snapshot.height = 0; }
    snapshot = null;
    context = null;
  };
  const detachTicker = () => {
    ticker?.remove(capture);
    ticker = null;
    if (timer !== undefined) environment.cancel(timer);
    timer = undefined;
  };
  const lost = () => { contextLost = true; clearSnapshot(); };
  const restored = () => { contextLost = false; clearSnapshot(); };
  const detachBoard = () => {
    board?.removeEventListener('webglcontextlost', lost);
    board?.removeEventListener('webglcontextrestored', restored);
    board = null;
    contextLost = false;
    clearSnapshot();
  };
  const dispose = () => {
    disposed = true;
    detachTicker();
    detachBoard();
    currentSignal?.removeEventListener('abort', dispose);
    currentSignal = null;
  };

  function synchronize(): { readonly board: HTMLCanvasElement; readonly rect: BackdropRect; readonly ticker: BoardTicker } | null {
    const canvas = host.canvas;
    const liveBoard = environment.board();
    if (!canvas?.ready || canvas.scene === null || !canvas.app?.ticker || !liveBoard?.isConnected
      || !(liveBoard.width > 0 && liveBoard.height > 0)) {
      detachTicker();
      detachBoard();
      scene = canvas?.scene;
      return null;
    }
    const rect = liveBoard.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) { detachBoard(); return null; }
    if (liveBoard !== board || canvas.scene !== scene) {
      detachBoard();
      board = liveBoard;
      scene = canvas.scene;
      board.addEventListener('webglcontextlost', lost);
      board.addEventListener('webglcontextrestored', restored);
    }
    if (contextLost) return null;
    if (!snapshot) {
      snapshot = environment.createCanvas();
      context = snapshot.getContext('2d');
      if (!context) { clearSnapshot(); return null; }
    }
    if (snapshot.width !== liveBoard.width || snapshot.height !== liveBoard.height) {
      captured = false;
      snapshot.width = liveBoard.width;
      snapshot.height = liveBoard.height;
    }
    return { board: liveBoard, rect, ticker: canvas.app.ticker };
  }

  function capture(): void {
    if (disposed || currentSignal?.aborted || environment.now() - lastRequest >= ACTIVE_REQUEST_MS) {
      detachTicker();
      return;
    }
    const live = synchronize();
    if (!live || !snapshot || !context) return;
    // Changing scenes/apps must not read the new drawing buffer from an old ticker.
    if (live.ticker !== ticker) { detachTicker(); clearSnapshot(); return; }
    try {
      context.clearRect(0, 0, snapshot.width, snapshot.height);
      context.drawImage(live.board, 0, 0);
      captured = true;
    } catch {
      clearSnapshot();
    }
  }

  return (surfaceRect, signal) => {
    if (disposed || signal.aborted) { dispose(); return null; }
    if (!currentSignal) {
      currentSignal = signal;
      signal.addEventListener('abort', dispose, { once: true });
    }
    const live = synchronize();
    if (!live || !snapshot) return null;
    lastRequest = environment.now();
    if (ticker !== live.ticker) {
      detachTicker();
      ticker = live.ticker;
      ticker.add(capture, undefined, BOARD_CAPTURE_PRIORITY);
    }
    // Expire demand even when Foundry's ticker is stopped or the tab is hidden.
    if (timer !== undefined) environment.cancel(timer);
    timer = environment.schedule(detachTicker, ACTIVE_REQUEST_MS);
    if (!captured) return null;
    return {
      source: snapshot,
      rect: target === 'preview' ? { ...surfaceRect } : {
        left: live.rect.left, top: live.rect.top, width: live.rect.width, height: live.rect.height
      }
    };
  };
}
