import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transition } from '../src/domain/sequence.js';
import { TEXT_MOTION_PRESETS, evaluateTextMotion, type TextMotionPhase } from '../src/domain/text-motion.js';
import { createTextAnimationPreview, TEXT_ANIMATION_PREVIEW_SIZE } from '../src/ui/text-animation-preview.js';

const basic = ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'];
const values = [...basic, ...TEXT_MOTION_PRESETS.map(preset => 'text-motion:' + preset.id)];
const phases = ['entrance', 'exit'] as const;
const identity = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1, blur: 0 };

for (const phase of phases) for (const value of values) {
  test(`${phase} preview: ${value} uses production phase timing and endpoints`, () => {
    const preview = createTextAnimationPreview(value, phase);
    const first = preview.frameAt(0), middle = preview.frameAt(0.5), end = preview.frameAt(1);
    assert.equal(first.items.length, 1);
    assert.equal(middle.items.length, 1);
    assert.equal(first.items[0]!.clip, preview.clip);
    assert.equal(middle.items[0]!.clip, preview.clip);
    assert.equal(first.opacity, 1);
    assert.equal(first.phase, 'playing');
    assert.ok(Object.isFrozen(preview.clip));
    assert.equal(preview.clip[phase === 'entrance' ? 'exit' : 'entrance'].preset, 'none');
    if (value === 'none') {
      assert.deepEqual(first, middle);
      assert.deepEqual(first, end);
      assert.equal(first.items[0]!.opacity, 1);
      return;
    }
    assert.ok(middle.positionMs > first.positionMs);
    if (phase === 'exit') assert.deepEqual(end.items, [], 'fixed clips leave at the exact end');
    else assert.equal(end.items.length, 1, 'entrances retain their readable endpoint');
    const transition = preview.clip[phase];
    assert.notEqual(transition.preset, 'none');
    if (transition.preset === 'none') return;
    assert.equal(middle.positionMs, transition.durationMs / 2);
    if (transition.preset === 'text-motion') {
      const descriptor = TEXT_MOTION_PRESETS.find(preset => preset.id === transition.motion)!;
      assert.equal(transition.durationMs, descriptor.durationMs);
      assert.equal(transition.easing, phase === 'entrance' ? 'ease-out' : 'ease-in');
      const active = middle.items[0]!.textMotion?.[phase];
      assert.equal(active?.progress, 0.5);
      assert.equal(active?.transition, transition);
      const pose = (progress: number) => evaluateTextMotion(transition.motion!, progress, 1, 3,
        transition.amount, transition.stagger, transition.easing, { phase });
      const startPose = pose(first.items[0]!.textMotion![phase]!.progress);
      const hidden = phase === 'entrance' ? startPose : pose(1);
      assert.ok(hidden.opacity === 0 || hidden.clipInset === 1 || hidden.scaleX === 0
        || hidden.scaleY === 0 || hidden.noise === 1, 'hidden endpoint uses the renderer domain pose');
      assert.deepEqual(phase === 'exit' ? startPose : pose(end.items[0]!.textMotion![phase]!.progress), identity);
      assert.notDeepEqual(pose(0.25), pose(0.75), 'mid-interval pose changes');
      if (descriptor.phase !== phase) {
        assert.deepEqual(pose(0.25), evaluateTextMotion(transition.motion!, 0.75, 1, 3,
          transition.amount, transition.stagger, transition.easing), 'opposite edge reverses the native design');
      }
    } else {
      assert.equal(transition.durationMs, 800);
      assert.equal(transition.easing, 'ease-in-out');
      const item = middle.items[0]!;
      if (value.includes('fade')) assert.equal(item.opacity, 0.5);
      else assert.equal(item.opacity, 1);
      if (value.includes('slide')) assert.equal(item.textTransform!.y, 50);
      if (value.includes('zoom')) assert.equal(item.textTransform!.scale, 0.9);
      if (phase === 'entrance') {
        assert.equal(end.items[0]!.opacity, 1);
        if (item.textTransform) assert.deepEqual(end.items[0]!.textTransform, { x: 0, y: 0, scale: 1 });
      } else assert.equal(first.items[0]!.opacity, 1);
    }
  });
}

test('matching authored values preserve timing, easing and relevant direction/scale without extensions or mutation', () => {
  for (const phase of phases) {
    const source = { preset: 'fade-slide', version: 1, durationMs: 312, easing: 'ease-in', direction: 'left',
      distance: 72, future: { keep: ['original'] } } as const;
    const before = structuredClone(source);
    const preview = createTextAnimationPreview('fade-slide', phase, source);
    assert.deepEqual(preview.clip[phase], { preset: 'fade-slide', version: 1, durationMs: 312,
      easing: 'ease-in', direction: 'left', distance: 72 });
    assert.equal(preview.frameAt(0.5).positionMs, 156);
    assert.equal(preview.frameAt(0.5).items[0]!.textTransform!.x, phase === 'entrance' ? -54 : -18);
    assert.equal(preview.frameAt(0.5).items[0]!.opacity, phase === 'entrance' ? 0.25 : 0.75);
    assert.deepEqual(source, before);
    assert.equal(Object.isFrozen(source), false);
    assert.equal(Object.isFrozen(source.future), false);
    const zoom: Transition = { preset: 'zoom', version: 1, durationMs: 400, easing: 'linear', scale: 1.8 };
    assert.equal(createTextAnimationPreview('zoom', phase, zoom).frameAt(0.5).items[0]!.textTransform!.scale, 1.4);
  }
});

test('matching segmented motion forwards authored geometry, explicit order and easing into production frames', () => {
  for (const phase of phases) {
    const source: Transition = { preset: 'text-motion', version: 1, motion: 'character-fade-up', durationMs: 957,
      easing: 'linear', amount: 2, stagger: 0.8, motionDirection: 'right', motionOrder: 'reverse' };
    const before = structuredClone(source);
    const preview = createTextAnimationPreview('text-motion:character-fade-up', phase, source);
    assert.deepEqual(preview.clip[phase], source);
    const active = preview.frameAt(0.25).items[0]!.textMotion![phase]!;
    assert.equal(active.progress, 0.25);
    assert.equal(active.transition, preview.clip[phase]);
    const pose = (index: number) => evaluateTextMotion(source.motion!, active.progress, index, 5,
      source.amount, source.stagger, source.easing, { phase, direction: source.motionDirection!, order: source.motionOrder! });
    assert.ok(phase === 'entrance' ? pose(4).opacity > pose(0).opacity : pose(4).opacity < pose(0).opacity,
      'explicit reverse order begins at the final segment even on the opposite phase');
    assert.ok(pose(0).y === 0, 'direction rotates geometry');
    assert.deepEqual(source, before);
    assert.equal(Object.isFrozen(source), false);
  }
});

test('different options always use canonical defaults and never inherit another motion settings', () => {
  const source: Transition = { preset: 'text-motion', version: 1, motion: 'line-reveal', durationMs: 20,
    easing: 'back-out', amount: 4, stagger: 0.9, motionDirection: 'left', motionOrder: 'random' };
  for (const phase of phases) for (const value of ['slide', 'text-motion:character-fade-up']) {
    assert.deepEqual(createTextAnimationPreview(value, phase, source).clip,
      createTextAnimationPreview(value, phase).clip);
  }
});

test('none and zero-duration authored options stay static and readable without repairing source', () => {
  for (const phase of phases) for (const preset of ['fade', 'text-motion'] as const) {
    const source: Transition = { preset, version: 1, durationMs: 0, easing: 'ease-in',
      ...(preset === 'text-motion' ? { motion: 'line-reveal' as const } : {}) };
    const value = preset === 'text-motion' ? 'text-motion:line-reveal' : preset;
    const preview = createTextAnimationPreview(value, phase, source);
    assert.equal(preview.clip[phase].preset, 'none');
    assert.equal(preview.frameAt(0).items[0]!.opacity, 1);
    assert.deepEqual(preview.frameAt(0), preview.frameAt(1));
    assert.equal(source.durationMs, 0);
    assert.equal(Object.isFrozen(source), false);
  }
});

test('thumbnail composition and glyph metadata are bounded; options and progress fail cleanly', () => {
  assert.equal(values.length, 34);
  assert.deepEqual(TEXT_ANIMATION_PREVIEW_SIZE, { width: 640, height: 320 });
  assert.equal(createTextAnimationPreview('none', 'entrance').clip.properties.text, 'YOUR STORY\nSTARTS HERE');
  assert.equal(Array.from(createTextAnimationPreview('none', 'entrance', undefined, '😀'.repeat(1000)).clip.properties.text).length, 128);
  assert.equal(createTextAnimationPreview('none', 'entrance', undefined, '  ').clip.properties.text, 'YOUR STORY\nSTARTS HERE');
  for (const value of ['', 'text-motion:', 'text-motion:unknown', 'unknown', '__proto__']) {
    assert.throws(() => createTextAnimationPreview(value, 'entrance'), /Unknown text animation preview option/);
  }
  assert.throws(() => createTextAnimationPreview('none', 'invalid' as TextMotionPhase), /Unknown text animation preview phase/);
  const preview = createTextAnimationPreview('fade', 'entrance');
  assert.deepEqual(preview.frameAt(-5), preview.frameAt(0));
  assert.deepEqual(preview.frameAt(5), preview.frameAt(1));
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => preview.frameAt(value), RangeError);
});

test('repeated frame evaluation reuses the compiled frozen clip and never clones or compiles again', t => {
  const clone = globalThis.structuredClone;
  let clones = 0;
  t.mock.method(globalThis, 'structuredClone', (...args: Parameters<typeof structuredClone>) => {
    clones += 1;
    return clone(...args);
  });
  const preview = createTextAnimationPreview('text-motion:word-ghost', 'entrance');
  assert.equal(clones, 1, 'production validation clones once while compiling');
  for (let index = 0; index <= 100; index++) assert.equal(preview.frameAt(index / 100).items[0]!.clip, preview.clip);
  assert.equal(clones, 1);
});
