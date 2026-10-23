import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import {
  fitPreviewViewport, isValidPreviewViewportSize, PREVIEW_VIEWPORT_LIMITS, PREVIEW_VIEWPORT_PRESETS,
  PreviewViewport
} from '../src/ui/preview-viewport.js';

test('preview viewport fits landscape, portrait and ultrawide shapes inside local host dimensions', () => {
  assert.deepEqual(fitPreviewViewport(1000, 600, { width: 1920, height: 1080 }), { width: 1000, height: 562.5 });
  assert.deepEqual(fitPreviewViewport(500, 700, { width: 1080, height: 1920 }), { width: 393.75, height: 700 });
  assert.deepEqual(fitPreviewViewport(1000, 600, PREVIEW_VIEWPORT_PRESETS.ultrawide), { width: 1000, height: 421.875 });
  assert.deepEqual(fitPreviewViewport(0, 600, { width: 1, height: 1 }), { width: 0, height: 0 });
});

test('custom viewport dimensions accept inclusive integer bounds only', () => {
  assert.equal(PREVIEW_VIEWPORT_LIMITS.minimum, 64);
  assert.equal(PREVIEW_VIEWPORT_LIMITS.maximum, 16_384);
  assert.equal(isValidPreviewViewportSize({ width: 64, height: 16_384 }), true);
  assert.equal(isValidPreviewViewportSize({ width: 63, height: 1080 }), false);
  assert.equal(isValidPreviewViewportSize({ width: 1920.5, height: 1080 }), false);
  assert.equal(isValidPreviewViewportSize({ width: 1920, height: Number.NaN }), false);
});

function fixture(t: TestContext) {
  class FakeElement extends EventTarget {
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, string> = {};
    readonly attrs = new Map<string, string>();
    readonly classes = new Set<string>();
    hidden = false;
    value = '';
    textContent = '';
    clientWidth = 1000;
    clientHeight = 600;
    validityMessage = '';
    classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
    constructor(private readonly selectors: Record<string, FakeElement> = {}) { super(); }
    querySelector<T>(selector: string): T | null { return (this.selectors[selector] as unknown as T | undefined) ?? null; }
    setAttribute(name: string, value: string) { this.attrs.set(name, value); }
    removeAttribute(name: string) { this.attrs.delete(name); }
    setCustomValidity(message: string) { this.validityMessage = message; }
  }
  let observerCallback: (() => void) | undefined;
  let disconnected = false;
  class FakeResizeObserver {
    constructor(callback: () => void) { observerCallback = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  }
  const oldObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver });
  t.after(() => {
    if (oldObserver) Object.defineProperty(globalThis, 'ResizeObserver', oldObserver);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  });
  const controls = new FakeElement(); controls.dataset.invalidMessage = 'Invalid dimensions.';
  const space = new FakeElement();
  const viewer = new FakeElement();
  const preset = new FakeElement(); preset.value = 'composition';
  const custom = new FakeElement();
  const width = new FakeElement();
  const height = new FakeElement();
  const caption = new FakeElement();
  const status = new FakeElement();
  const root = new FakeElement({
    '[data-stagecraft-viewport-controls]': controls,
    '.stagecraft-viewer-space': space,
    '[data-stagecraft-viewer]': viewer,
    '[data-stagecraft-viewport-preset]': preset,
    '[data-stagecraft-viewport-custom]': custom,
    '[data-stagecraft-viewport-width]': width,
    '[data-stagecraft-viewport-height]': height,
    '[data-stagecraft-viewport-size]': caption,
    '[data-stagecraft-viewport-status]': status
  });
  return {
    root, space, viewer, preset, custom, width, height, caption, status,
    resize: () => observerCallback?.(), disconnected: () => disconnected
  };
}

test('controller defaults to current composition and follows editor host resizing', t => {
  const f = fixture(t), viewport = new PreviewViewport(f.root as unknown as HTMLElement);
  assert.equal(viewport.selectedPreset, 'composition');
  assert.deepEqual(viewport.selectedSize, { width: 1920, height: 1080 });
  assert.equal(f.caption.textContent, '1920 × 1080');
  assert.equal(f.viewer.style.width, '1000px');
  assert.equal(f.viewer.style.height, '562.5px');

  viewport.setComposition({ width: 1440, height: 1080 });
  assert.equal(f.caption.textContent, '1440 × 1080');
  assert.equal(f.viewer.style.width, '800px');
  assert.equal(f.viewer.style.height, '600px');
  assert.deepEqual(viewport.selectedSize, { width: 1440, height: 1080 });
  viewport.setComposition({ width: 32, height: 32 });
  assert.deepEqual(viewport.selectedSize, { width: 32, height: 32 }, 'composition dimensions retain their domain range below the custom viewport minimum');
  viewport.setComposition({ width: 1440, height: 1080 });

  f.space.clientWidth = 500; f.space.clientHeight = 700; f.resize();
  assert.equal(f.viewer.style.width, '500px');
  assert.equal(f.viewer.style.height, '375px');
  viewport.dispose();
  assert.equal(f.disconnected(), true);
});

test('controller selects presets and custom portrait size without changing composition state', t => {
  const f = fixture(t), viewport = new PreviewViewport(f.root as unknown as HTMLElement);
  const composition = { width: 1920, height: 1080 };
  viewport.setComposition(composition);

  f.preset.value = 'ultrawide'; f.preset.dispatchEvent(new Event('change'));
  assert.deepEqual(viewport.selectedSize, PREVIEW_VIEWPORT_PRESETS.ultrawide);
  assert.equal(f.caption.textContent, '2560 × 1080');
  assert.equal(f.custom.hidden, true);

  f.preset.value = 'custom'; f.preset.dispatchEvent(new Event('change'));
  assert.equal(f.custom.hidden, false);
  f.width.value = '1080'; f.width.dispatchEvent(new Event('input'));
  f.height.value = '1920'; f.height.dispatchEvent(new Event('input'));
  assert.deepEqual(viewport.selectedSize, { width: 1080, height: 1920 });
  assert.equal(f.caption.textContent, '1080 × 1920');
  assert.equal(f.viewer.style.width, '337.5px');
  assert.equal(f.viewer.style.height, '600px');

  f.width.value = '16385'; f.width.dispatchEvent(new Event('input'));
  assert.deepEqual(viewport.selectedSize, { width: 1080, height: 1920 }, 'invalid input retains the last valid viewport');
  assert.equal(f.caption.textContent, '1080 × 1920');
  assert.equal(f.width.validityMessage, 'Invalid dimensions.');
  assert.equal(f.width.attrs.get('aria-invalid'), 'true');
  assert.equal(f.status.textContent, 'Invalid dimensions.');

  f.width.value = '1080'; f.width.dispatchEvent(new Event('input'));
  assert.equal(f.status.textContent, '');
  assert.equal(f.width.attrs.has('aria-invalid'), false);
  viewport.setComposition({ width: 1366, height: 768 });
  assert.deepEqual(viewport.selectedSize, { width: 1080, height: 1920 }, 'custom mode remains selected when composition changes');
  f.preset.value = 'composition'; f.preset.dispatchEvent(new Event('change'));
  assert.deepEqual(viewport.selectedSize, { width: 1366, height: 768 });
  viewport.dispose();
});

test('controller disposal removes listeners and is safe when controls are absent', t => {
  const f = fixture(t), viewport = new PreviewViewport(f.root as unknown as HTMLElement);
  viewport.dispose();
  f.preset.value = 'ultrawide'; f.preset.dispatchEvent(new Event('change'));
  assert.deepEqual(viewport.selectedSize, { width: 1920, height: 1080 });
  assert.equal(f.disconnected(), true);
  const empty = new PreviewViewport({ querySelector: () => null } as unknown as HTMLElement);
  assert.deepEqual(empty.selectedSize, { width: 1920, height: 1080 });
  empty.dispose();
});
