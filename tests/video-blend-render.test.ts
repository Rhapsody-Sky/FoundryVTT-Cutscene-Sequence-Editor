import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageClip, VideoClip } from '../src/domain/sequence.js';
import type { FrameItem } from '../src/playback/evaluate.js';
import type { ElementRenderer } from '../src/rendering/element-renderer.js';
import { videoContentRect, needsImageBackdrop, needsVideoBackdrop, VideoBlendBackdrop } from '../src/rendering/video-blend-backdrop.js';

test('contain clips the sampled board to video content while cover fills the surface', () => {
  assert.deepEqual(videoContentRect(800, 600, 1920, 1080, 'contain'), { x: 0, y: 75, width: 800, height: 450 });
  assert.deepEqual(videoContentRect(800, 600, 1080, 1920, 'contain'), { x: 231.25, y: 0, width: 337.5, height: 600 });
  assert.deepEqual(videoContentRect(800, 600, 1920, 1080, 'cover'), { x: 0, y: 0, width: 800, height: 600 });
  assert.throws(() => videoContentRect(800, 600, 0, 0, 'contain'), { code: 'VIDEO_BACKDROP_UNAVAILABLE' });
});

test('normal, inactive and fully transparent video never request board compositing', () => {
  const video: VideoClip = { id: 'v', trackId: 'v', type: 'video', typeVersion: 1, startMs: 0, duration: { kind: 'media' },
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { source: { kind: 'foundry-file', path: 'worlds/test/a.webm' }, fit: 'contain', muted: true, volume: 0 } };
  assert.equal(needsVideoBackdrop(undefined), false);
  assert.equal(needsVideoBackdrop({ clip: video, opacity: 1, localTimeMs: 0 }), false);
  for (const mode of ['multiply', 'screen', 'plus-lighter', 'overlay', 'difference'] as const) {
    const styled = { ...video, appearance: { blendMode: mode, opacity: 0.5 } };
    assert.equal(needsVideoBackdrop({ clip: styled, opacity: 1, localTimeMs: 0 }), true);
    assert.equal(needsVideoBackdrop({ clip: styled, opacity: 0, localTimeMs: 0 }), false);
    assert.equal(needsVideoBackdrop({ clip: { ...styled, appearance: { ...styled.appearance, opacity: 0 } }, opacity: 1, localTimeMs: 0 }), false);
  }
});

test('image blend eligibility excludes normal and transparent images', () => {
  const image: ImageClip = { id: 'i', trackId: 'v', type: 'image', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 1000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { source: { kind: 'foundry-file', path: 'worlds/test/a.png' }, fit: 'contain',
      box: { x: 0, y: 0, width: 100, height: 100 }, crop: { x: 0, y: 0, width: 1, height: 1 },
      mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } };
  assert.equal(needsImageBackdrop(undefined), false);
  assert.equal(needsImageBackdrop({ clip: image, opacity: 1, localTimeMs: 0 }), false);
  const blended = { ...image, appearance: { blendMode: 'multiply' as const, opacity: 0.5 } };
  assert.equal(needsImageBackdrop({ clip: blended, opacity: 1, localTimeMs: 0 }), true);
  assert.equal(needsImageBackdrop({ clip: blended, opacity: 0, localTimeMs: 0 }), false);
  assert.equal(needsImageBackdrop({ clip: { ...blended, appearance: { ...blended.appearance, opacity: 0 } }, opacity: 1, localTimeMs: 0 }), false);
});

class FakeCanvasContext {
  readonly operations: Array<{ name: string; args: unknown[] }> = [];
  globalCompositeOperation = 'source-over';
  globalAlpha = 1;
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  setTransform(...args: number[]): void { this.record('setTransform', ...args); }
  clearRect(...args: number[]): void { this.record('clearRect', ...args); }
  save(): void { this.record('save'); }
  restore(): void { this.record('restore'); }
  scale(...args: number[]): void { this.record('scale', ...args); }
  beginPath(): void { this.record('beginPath'); }
  rect(...args: number[]): void { this.record('rect', ...args); }
  clip(...args: unknown[]): void { this.record('clip', ...args); }
  moveTo(...args: number[]): void { this.record('moveTo', ...args); }
  lineTo(...args: number[]): void { this.record('lineTo', ...args); }
  closePath(): void { this.record('closePath'); }
  fill(...args: unknown[]): void { this.record('fill', ...args); }
  fillRect(...args: number[]): void { this.record('fillRect', ...args); }
  drawImage(...args: unknown[]): void { this.record('drawImage', ...args); }
  private record(name: string, ...args: unknown[]): void { this.operations.push({ name, args }); }
}

class FakeCanvas {
  readonly style: Record<string, string> = {};
  readonly context = new FakeCanvasContext();
  className = '';
  width = 0;
  height = 0;
  removed = false;
  getContext(): FakeCanvasContext { return this.context; }
  remove(): void { this.removed = true; }
}

test('image and video blends share one reusable board mask; normal images do not need a snapshot', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const canvases: FakeCanvas[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => {
    assert.equal(tag, 'canvas'); const canvas = new FakeCanvas(); canvases.push(canvas); return canvas;
  } } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else Reflect.deleteProperty(globalThis, 'document'); });
  const root = { style: {}, prepend() {}, getBoundingClientRect() { return { left: 100, top: 50, width: 800, height: 600 }; } } as unknown as HTMLElement;
  const signal = new AbortController().signal;
  let boardCalls = 0;
  const backdrop = new VideoBlendBackdrop(root, { signal, boardBackdrop: rect => {
    boardCalls += 1; return { source: {} as CanvasImageSource, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, backgroundColor: '#000' };
  } });
  const video = { id: 'v', trackId: 'visual', type: 'video', typeVersion: 1, startMs: 0, duration: { kind: 'media' },
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 }, appearance: { blendMode: 'screen', opacity: 0.5 },
    properties: { source: { kind: 'foundry-file', path: 'worlds/test/a.webm' }, fit: 'contain', volume: 0, muted: true } } as const satisfies VideoClip;
  const image: ImageClip = { id: 'i', trackId: 'visual', type: 'image', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 1000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    appearance: { blendMode: 'multiply', opacity: 0.6 },
    properties: { source: { kind: 'foundry-file', path: 'worlds/test/a.png' }, fit: 'cover',
      box: { x: 40, y: 30, width: 250, height: 100 }, crop: { x: 0, y: 0, width: 1, height: 1 },
      mask: [{ x: 0, y: 0 }, { x: 1, y: 0.2 }, { x: 0.8, y: 1 }, { x: 0, y: 1 }] } };
  const normal = { ...image, appearance: { blendMode: 'normal' as const, opacity: 1 } };
  const normalItem: FrameItem = { clip: normal, opacity: 1, localTimeMs: 0 };
  assert.equal(backdrop.draw(new Map<string, FrameItem>([[normal.id, normalItem]]), new Map(), 1), 'inactive');
  assert.equal(boardCalls, 0);
  const videoItem: FrameItem = { clip: video, opacity: 1, localTimeMs: 0 };
  const imageItem: FrameItem = { clip: image, opacity: 1, localTimeMs: 0 };
  const elements = new Map<string, { renderer: ElementRenderer }>([
    ['v', { renderer: { videoSource: () => ({ videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement) } as unknown as ElementRenderer }],
    ['i', { renderer: { backdropFootprints: () => [{ points: [{ x: 20, y: 30 }, { x: 270, y: 50 }, { x: 240, y: 130 }, { x: 40, y: 130 }], clip: { x: 60, y: 30, width: 180, height: 100 } }] } as unknown as ElementRenderer }]
  ]);
  const blendedItems = new Map<string, FrameItem>([['v', videoItem], ['i', imageItem]]);
  assert.equal(backdrop.draw(blendedItems, elements, 1), 'ready');
  assert.equal(boardCalls, 1);
  assert.equal(canvases.length, 2, 'one presentation canvas and one reusable mask canvas');
  const mainOps = canvases[0]!.context.operations;
  const maskOps = canvases[1]!.context.operations;
  assert.equal(mainOps.filter(operation => operation.name === 'drawImage').length, 2, 'board source plus reusable mask');
  assert.equal(mainOps.filter(operation => operation.name === 'fillRect').length, 1, 'board base is painted once');
  assert.equal(mainOps.at(-1)?.name, 'drawImage');
  assert.equal(maskOps.filter(operation => operation.name === 'fill' && operation.args[0] === 'evenodd').length, 2);
  assert.equal(maskOps.filter(operation => operation.name === 'clip').length, 1, 'the image crop aperture stays separate from its quad');
  assert.equal(canvases[0]!.style.display, '');

  assert.equal(backdrop.draw(blendedItems, elements, 0.5), 'ready');
  assert.equal(canvases.length, 2, 'subsequent frames reuse the same mask canvas');
  backdrop.dispose();
  assert.equal(canvases[0]!.width, 0); assert.equal(canvases[1]!.height, 0);
});

test('missing board snapshots remain pending briefly then fail closed for a blended image', t => {
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const beforePerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const canvases: FakeCanvas[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => { const canvas = new FakeCanvas(); canvases.push(canvas); return canvas; } } });
  let now = 100;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  t.after(() => {
    if (beforeDocument) Object.defineProperty(globalThis, 'document', beforeDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (beforePerformance) Object.defineProperty(globalThis, 'performance', beforePerformance); else Reflect.deleteProperty(globalThis, 'performance');
  });
  const root = { style: {}, prepend() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } as unknown as HTMLElement;
  const backdrop = new VideoBlendBackdrop(root, { signal: new AbortController().signal, boardBackdrop: () => null });
  const image: ImageClip = { id: 'i', trackId: 'v', type: 'image', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 1000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    appearance: { blendMode: 'difference', opacity: 1 },
    properties: { source: { kind: 'foundry-file', path: 'worlds/test/a.png' }, fit: 'contain',
      box: { x: 0, y: 0, width: 100, height: 100 }, crop: { x: 0, y: 0, width: 1, height: 1 },
      mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } };
  const item: FrameItem = { clip: image, opacity: 1, localTimeMs: 0 };
  const items = new Map<string, FrameItem>([[image.id, item]]);
  const elements = new Map<string, { renderer: ElementRenderer }>([[image.id, { renderer: {
    backdropFootprints: () => [{ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }]
  } as unknown as ElementRenderer }]]);
  assert.equal(backdrop.draw(items, elements, 1), 'pending');
  now += 2001;
  assert.throws(() => backdrop.draw(items, elements, 1), { code: 'VIDEO_BACKDROP_UNAVAILABLE' });
  backdrop.dispose();
});
