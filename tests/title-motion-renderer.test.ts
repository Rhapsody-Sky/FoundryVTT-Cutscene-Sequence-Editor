import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { FrameItem } from '../src/playback/evaluate.js';
import type { TextClip } from '../src/domain/sequence.js';
import { textRenderer } from '../src/rendering/text-renderer.js';

class FakeElement {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  textContent = '';
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  isConnected = true;
  clientWidth = 1400;
  clientHeight = 400;
  scrollWidth = 1400;
  scrollHeight = 400;
  rect = { width: 960, height: 540 };

  append(node: FakeElement) { node.remove(); this.children.push(node); node.parent = this; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  getBoundingClientRect() { return this.rect; }
}

class FakeResizeObserver {
  static latest: FakeResizeObserver | undefined;
  constructor(private readonly callback: () => void) { FakeResizeObserver.latest = this; }
  observe() {}
  disconnect() {}
  trigger() { this.callback(); }
}

function title(): TextClip {
  return {
    id: 'title-motion', trackId: 'track', type: 'text', typeVersion: 1, startMs: 0,
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    duration: { kind: 'sequence-end' },
    appearance: { blendMode: 'screen', opacity: 0.6 },
    properties: {
      text: 'A moving title', fontFamily: 'serif', fontSize: 96, minimumFontSize: 24,
      color: '#ffffff', align: 'center', box: { x: 100, y: 200, width: 1400, height: 400 },
      shrinkToFit: true,
      outline: { enabled: true, color: '#ff8800', opacity: 0.4, width: 8 },
      shadow: { enabled: true, color: '#123456', opacity: 0.3, offsetX: -12, offsetY: 15, blur: 24 },
      glow: { enabled: true, color: '#abcdef', opacity: 0.2, radius: 36 }
    }
  };
}

function installDom(t: TestContext) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new FakeElement() }
  });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver });
  FakeResizeObserver.latest = undefined;
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousResizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', previousResizeObserver);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    FakeResizeObserver.latest = undefined;
  });
}

const node = (value: FakeElement) => value as unknown as HTMLElement;
const frame = (item?: FrameItem) => ({
  phase: 'paused' as const, positionMs: 0, opacity: 1, items: item ? [item] : []
});
function item(clip: TextClip, textTransform?: { x: number; y: number; scale: number }): FrameItem {
  return {
    clip, opacity: 0.5, localTimeMs: 0,
    ...(textTransform === undefined ? {} : { textTransform })
  };
}

test('title motion applies frame transforms to content while retaining effects and clip appearance', t => {
  installDom(t);
  const clip = title();
  const parent = new FakeElement(); parent.clientWidth = 960; parent.clientHeight = 540;
  const renderer = textRenderer(clip, node(parent), { width: 1920, height: 1080 }, { signal: new AbortController().signal });
  const layer = parent.children[0]!;
  const stage = layer.children[0]!;
  const text = stage.children[0]!;

  renderer.draw(item(clip, { x: 0, y: 0, scale: 1 }), frame(item(clip, { x: 0, y: 0, scale: 1 })));
  assert.equal(text.style.transform, 'translate(0px, 0px) scale(1)', 'identity motion is represented by the evaluated frame');
  assert.equal(text.style.transformOrigin, 'center center');
  assert.equal(stage.style.transform, 'scale(0.5)', 'motion does not replace viewport stage scaling');
  assert.equal(text.style.fontSize, '96px', 'animated scale does not enter shrink-to-fit measurement');
  assert.equal(layer.style.opacity, '0.3');
  assert.equal(layer.style.mixBlendMode, 'screen');
  assert.equal(text.style.color, '#ffffff');
  assert.equal(text.style.paintOrder, 'stroke fill');
  assert.equal(text.style.webkitTextStroke, '8px rgba(255, 136, 0, 0.4)');
  assert.equal(text.style.textShadow, '-12px 15px 24px rgba(18, 52, 86, 0.3), 0px 0px 36px rgba(171, 205, 239, 0.2)');

  const forward = item(clip, { x: 120, y: -48, scale: 1.5 });
  renderer.draw(forward, frame(forward));
  assert.equal(text.style.transform, 'translate(120px, -48px) scale(1.5)');
  assert.equal(stage.style.transform, 'scale(0.5)');
  assert.equal(layer.style.opacity, '0.3', 'text motion leaves opacity blending independent');

  const backward = item(clip, { x: -24, y: 32, scale: 0.75 });
  renderer.draw(backward, frame(backward));
  assert.equal(text.style.transform, 'translate(-24px, 32px) scale(0.75)', 'backward seeks recompute motion from the requested frame');
  assert.equal(text.style.webkitTextStroke, '8px rgba(255, 136, 0, 0.4)');
  renderer.dispose();
});

test('motion stays on the title in composition units as the viewport stage changes scale', t => {
  installDom(t);
  const clip = title();
  const parent = new FakeElement(); parent.clientWidth = 960; parent.clientHeight = 540;
  const renderer = textRenderer(clip, node(parent), { width: 1920, height: 1080 }, { signal: new AbortController().signal });
  const stage = parent.children[0]!.children[0]!;
  const text = stage.children[0]!;
  const pose = item(clip, { x: 80, y: -40, scale: 1.25 });

  renderer.draw(pose, frame(pose));
  assert.equal(stage.style.transform, 'scale(0.5)');
  assert.equal(text.style.transform, 'translate(80px, -40px) scale(1.25)');

  parent.rect = { width: 1440, height: 810 }; parent.clientWidth = 1440; parent.clientHeight = 810;
  FakeResizeObserver.latest!.trigger();
  renderer.draw(pose, frame(pose));
  assert.equal(stage.style.transform, 'scale(0.75)');
  assert.equal(text.style.transform, 'translate(80px, -40px) scale(1.25)', 'the stage scales the whole title motion with the composition');
  renderer.dispose();
});

test('legacy frames and missing items reset title motion and disposal stays safe', t => {
  installDom(t);
  const clip = title();
  const parent = new FakeElement(); parent.clientWidth = 960; parent.clientHeight = 540;
  const renderer = textRenderer(clip, node(parent), { width: 1920, height: 1080 }, { signal: new AbortController().signal });
  const layer = parent.children[0]!;
  const text = layer.children[0]!.children[0]!;
  const moved = item(clip, { x: 64, y: 24, scale: 0.5 });

  renderer.draw(moved, frame(moved));
  assert.notEqual(text.style.transform, '');
  const legacy = item(clip);
  renderer.draw(legacy, frame(legacy));
  assert.equal(text.style.transform, '', 'legacy none/fade items keep an untransformed title');
  assert.equal(layer.style.opacity, '0.3');

  renderer.draw(moved, frame(moved));
  renderer.draw(undefined, frame());
  assert.equal(text.style.transform, '', 'an inactive title cannot retain a prior frame transform');
  assert.equal(layer.style.opacity, '0');
  renderer.dispose();
  assert.equal(parent.children.length, 0);
  renderer.dispose();
  assert.equal(parent.children.length, 0, 'disposal remains idempotent');
});
