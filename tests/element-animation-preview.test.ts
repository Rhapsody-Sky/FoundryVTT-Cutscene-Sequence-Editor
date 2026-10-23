import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transition } from '../src/domain/sequence.js';
import type { TextMotionPhase } from '../src/domain/text-motion.js';
import { createElementAnimationPreview, createElementAnimationPreviewRenderer, ELEMENT_ANIMATION_PREVIEW_SIZE,
  type ElementAnimationPreviewKind } from '../src/ui/element-animation-preview.js';

const kinds: readonly ElementAnimationPreviewKind[] = ['image', 'solid', 'bars', 'video', 'audio', 'button'];
const phases = ['entrance', 'exit'] as const;
const options = (kind: ElementAnimationPreviewKind) => kind === 'audio'
  ? ['none', 'fade'] : kind === 'bars' ? ['none', 'fade', 'slide', 'fade-slide']
    : ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'];

for (const kind of kinds) for (const phase of phases) for (const value of options(kind)) {
  test(`${kind} ${phase} ${value}: production frames and exact endpoints`, () => {
    const preview = createElementAnimationPreview(kind, value, phase);
    const start = preview.frameAt(0), middle = preview.frameAt(0.5), end = preview.frameAt(1);
    assert.equal(preview.clip.type, kind);
    if (kind === 'video') assert.equal(preview.clip.typeVersion, value === 'slide' || value === 'fade-slide' || value === 'zoom' || value === 'fade-zoom' ? 7 : 1);
    assert.equal(start.items[0]!.clip, preview.clip);
    assert.equal(middle.items[0]!.clip, preview.clip);
    assert.ok(Object.isFrozen(preview));
    assert.ok(Object.isFrozen(preview.clip));
    assert.ok(Object.isFrozen(preview.clip.properties));
    assert.equal(preview.clip[phase === 'entrance' ? 'exit' : 'entrance'].preset, 'none');
    assert.equal(start.opacity, 1);
    assert.equal(start.phase, 'playing');
    if (value === 'none') {
      assert.deepEqual(start, middle);
      assert.deepEqual(start, end);
      return;
    }
    assert.equal(middle.positionMs, 400);
    if (phase === 'exit') assert.deepEqual(end.items, []);
    else assert.equal(end.items.length, 1);
    const item = middle.items[0]!;
    if (value.includes('fade')) {
      assert.equal(kind === 'audio' ? item.audioGain : item.opacity, 0.5);
      assert.equal(kind === 'audio' ? start.items[0]!.audioGain : start.items[0]!.opacity, phase === 'entrance' ? 0 : 1);
    }
    if (kind === 'bars' && value.includes('slide')) assert.equal(item.barsReveal, 0.5);
    else if (value.includes('slide')) assert.deepEqual(item.textTransform, { x: 0, y: 50, scale: 1 });
    if (value.includes('zoom')) assert.deepEqual(item.textTransform, { x: 0, y: 0, scale: 0.9 });
    if (phase === 'entrance') assert.equal(kind === 'audio' ? end.items[0]!.audioGain : end.items[0]!.opacity, 1);
  });
}

test('matching source preserves duration/easing/direction/distance/scale without sharing mutable data', () => {
  for (const kind of kinds) for (const phase of phases) {
    const fade: Transition = { preset: 'fade', version: 1, durationMs: 612, easing: 'ease-in' };
    const preview = createElementAnimationPreview(kind, 'fade', phase, fade);
    assert.deepEqual(preview.clip[phase], fade);
    assert.equal(preview.frameAt(0.5).positionMs, 306);
    assert.equal(kind === 'audio' ? preview.frameAt(0.5).items[0]!.audioGain : preview.frameAt(0.5).items[0]!.opacity,
      phase === 'entrance' ? 0.25 : 0.75);
    assert.equal(Object.isFrozen(fade), false);
  }
  for (const kind of ['image', 'solid', 'bars', 'video', 'button'] as const) for (const phase of phases) {
    const slide = { preset: 'fade-slide', version: 1, durationMs: 312, easing: 'ease-in', direction: 'left', distance: 72,
      future: { keep: ['original'] } } as const;
    const original = structuredClone(slide);
    const preview = createElementAnimationPreview(kind, 'fade-slide', phase, slide);
    assert.deepEqual(preview.clip[phase], { preset: 'fade-slide', version: 1, durationMs: 312,
      easing: 'ease-in', direction: 'left', distance: 72 });
    if (kind !== 'bars') assert.equal(preview.frameAt(0.5).items[0]!.textTransform!.x, phase === 'entrance' ? -54 : -18);
    else assert.equal(preview.frameAt(0.5).items[0]!.barsReveal, phase === 'entrance' ? 0.25 : 0.75);
    assert.deepEqual(slide, original);
    assert.equal(Object.isFrozen(slide.future), false);
  }
  for (const kind of ['image', 'solid', 'video', 'button'] as const) for (const phase of phases) {
    const zoom: Transition = { preset: 'zoom', version: 1, durationMs: 400, easing: 'linear', scale: 1.8 };
    assert.equal(createElementAnimationPreview(kind, 'zoom', phase, zoom).frameAt(0.5).items[0]!.textTransform!.scale, 1.4);
  }
});

test('other choices use canonical defaults; zero duration remains readable and sources stay unchanged', () => {
  const source: Transition = { preset: 'fade-slide', version: 1, durationMs: 42, easing: 'back-out', direction: 'up', distance: 1000 };
  for (const kind of kinds) for (const phase of phases) {
    assert.deepEqual(createElementAnimationPreview(kind, 'fade', phase, source).clip,
      createElementAnimationPreview(kind, 'fade', phase).clip);
    const zero: Transition = { preset: 'fade', version: 1, durationMs: 0, easing: 'linear' };
    const preview = createElementAnimationPreview(kind, 'fade', phase, zero);
    assert.equal(preview.clip[phase].preset, 'none');
    assert.deepEqual(preview.frameAt(0), preview.frameAt(1));
    assert.equal(zero.durationMs, 0);
    assert.equal(Object.isFrozen(zero), false);
  }
});

test('strict supported matrix, bounded size, clamped progress and production validation', () => {
  assert.deepEqual(ELEMENT_ANIMATION_PREVIEW_SIZE, { width: 640, height: 320 });
  for (const kind of kinds) {
    for (const value of ['unknown', '', '__proto__', 'text-motion:word-ghost', ...['slide', 'zoom', 'fade-zoom'].filter(value => !options(kind).includes(value))]) {
      assert.throws(() => createElementAnimationPreview(kind, value, 'entrance'), RangeError);
    }
    const preview = createElementAnimationPreview(kind, 'fade', 'entrance');
    assert.deepEqual(preview.frameAt(-1), preview.frameAt(0));
    assert.deepEqual(preview.frameAt(2), preview.frameAt(1));
    for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => preview.frameAt(value), RangeError);
    assert.throws(() => createElementAnimationPreview(kind, 'fade', 'invalid' as TextMotionPhase), RangeError);
    assert.throws(() => createElementAnimationPreview(kind, 'fade', 'entrance', {
      preset: 'fade', version: 1, durationMs: -1, easing: 'linear'
    }));
  }
  assert.throws(() => createElementAnimationPreview('text' as ElementAnimationPreviewKind, 'fade', 'entrance'), RangeError);
});

test('each sample compiles exactly once and repeated evaluation reuses its frozen clip', t => {
  const original = structuredClone;
  let clones = 0;
  t.mock.method(globalThis, 'structuredClone', (...args: Parameters<typeof structuredClone>) => {
    clones += 1;
    return original(...args);
  });
  for (const kind of kinds) {
    const before = clones;
    const preview = createElementAnimationPreview(kind, 'fade', 'entrance');
    assert.equal(clones, before + 1);
    for (let index = 0; index <= 50; index++) assert.equal(preview.frameAt(index / 50).items[0]!.clip, preview.clip);
    assert.equal(clones, before + 1);
  }
});

class FakeNode {
  readonly children: FakeNode[] = [];
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly clientWidth = 640;
  readonly clientHeight = 320;
  className = '';
  removed = false;
  constructor(readonly tagName: string) {}
  append(...nodes: FakeNode[]): void { this.children.push(...nodes); }
  setAttribute(name: string, value: string): void {
    assert.ok(name !== 'src' && name !== 'href', 'never set a media URL');
    this.attributes.set(name, value);
  }
  remove(): void { this.removed = true; }
}

test('renderers use only local primitives, honor production transforms/gain, and dispose on abort', async t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const created: FakeNode[] = [];
  const create = (tag: string) => {
    assert.ok(!['img', 'image', 'video', 'audio', 'source', 'canvas'].includes(tag), `no decoder or media request: ${tag}`);
    const node = new FakeNode(tag); created.push(node); return node;
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: create, createElementNS: (_namespace: string, tag: string) => create(tag)
  } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else Reflect.deleteProperty(globalThis, 'document'); });
  for (const kind of kinds) {
    const start = created.length;
    const preview = createElementAnimationPreview(kind, kind === 'image' || kind === 'solid' || kind === 'video' ? 'fade-slide' : 'fade', 'entrance');
    const controller = new AbortController();
    const parent = new FakeNode('parent');
    const renderer = createElementAnimationPreviewRenderer(preview.clip, parent as unknown as HTMLElement,
      ELEMENT_ANIMATION_PREVIEW_SIZE, { signal: controller.signal,
        createAudioContext() { throw new Error('No audio context may be created.'); },
        requestAudioUnlock() { throw new Error('No audio may be unlocked.'); } });
    await renderer.prepare();
    const frame = preview.frameAt(0.5);
    renderer.draw(frame.items[0], frame);
    const nodes = created.slice(start);
    if (kind === 'image') {
      assert.ok(nodes.some(node => node.attributes.get('transform')?.startsWith('translate(112 98)')));
      assert.ok(nodes.some(node => node.tagName === 'svg' && node.style.opacity === '0.5'));
    }
    if (kind === 'video') {
      assert.ok(nodes.some(node => node.attributes.get('transform')?.startsWith('translate(112 98)')));
      assert.ok(nodes.some(node => node.tagName === 'svg' && node.style.opacity === '0.5'));
    }
    if (kind === 'solid') assert.ok(nodes.some(node => node.style.transform === 'translate(0px, 50px) scale(1)'));
    if (kind === 'audio') assert.equal(nodes.filter(node => node.style.transform === 'scaleY(0.5)').length, 7);
    renderer.draw(undefined, frame);
    controller.abort();
    assert.equal(parent.children[0]!.removed, true);
    renderer.dispose();
    await assert.rejects(renderer.prepare(), { name: 'AbortError' });
  }
});
