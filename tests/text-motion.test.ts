import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TEXT_MOTION_PRESETS,
  evaluateTextMotion,
  segmentTextMotion,
  textMotionControls,
  textMotionPreset,
  type TextMotionDirection,
  type TextMotionId,
  type TextMotionOrder,
  type TextMotionPhase,
  type TextMotionPose
} from '../src/domain/text-motion.js';
import type { TransitionEasing } from '../src/domain/sequence.js';

const identity: TextMotionPose = {
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1, blur: 0
};

test('contextual controls hide ineffective fields across the entire motion catalog', () => {
  for (const preset of TEXT_MOTION_PRESETS) {
    assert.equal(textMotionControls(preset.id, { segmentCount: 1 }).order, false, preset.id);
    assert.equal(textMotionControls(preset.id, { segmentCount: 4, stagger: 0 }).order, false, preset.id);
    assert.equal(textMotionControls(preset.id, { segmentCount: 4, amount: 0 }).directions, false, preset.id);
    assert.deepEqual(textMotionControls(preset.id, { segmentCount: 0 }), { directions: false, order: false });
    assert.equal(textMotionControls(preset.id, { segmentCount: 4, amount: 0, stagger: 0.5 }).order, true);
    const snapshot = (count: number, stagger: number, order: TextMotionOrder) =>
      Array.from({ length: count }, (_, index) => evaluateTextMotion(preset.id, 0.45, index, count, 1, stagger, 'linear', { order }));
    assert.deepEqual(snapshot(1, 0.5, 'forward'), snapshot(1, 0.5, 'reverse'), preset.id + ': one segment');
    assert.deepEqual(snapshot(4, 0, 'forward'), snapshot(4, 0, 'reverse'), preset.id + ': simultaneous');
    assert.notDeepEqual(snapshot(4, 0.5, 'forward'), snapshot(4, 0.5, 'reverse'), preset.id + ': order changes timing');
  }
});

function pose(
  id: TextMotionId,
  progress: number,
  index = 0,
  count = 1,
  amount = 1,
  stagger = 0.35,
  easing?: TransitionEasing,
  options?: {
    readonly phase?: TextMotionPhase;
    readonly direction?: TextMotionDirection;
    readonly order?: TextMotionOrder;
  }
): TextMotionPose {
  return evaluateTextMotion(id, progress, index, count, amount, stagger, easing, options);
}

function close(actual: number, expected: number, epsilon = 1e-10): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, actual + ' must be close to ' + expected);
}

test('the preset catalog has 19 entrance and 9 exit descriptors with stable lookup', () => {
  const ids = TEXT_MOTION_PRESETS.map(preset => preset.id);
  assert.equal(TEXT_MOTION_PRESETS.length, 28);
  assert.equal(new Set(ids).size, 28);
  assert.equal(TEXT_MOTION_PRESETS.filter(preset => preset.phase === 'entrance').length, 19);
  assert.equal(TEXT_MOTION_PRESETS.filter(preset => preset.phase === 'exit').length, 9);
  for (const id of ['stretch-rise', 'vertical-unfold', 'tilt-scale', 'smear-in', 'elastic-pop'] as const) {
    assert.equal(textMotionPreset(id)?.unit, 'character', id + ' animates glyphs');
  }
  for (const preset of TEXT_MOTION_PRESETS) {
    assert.ok(preset.durationMs > 0 && Number.isInteger(preset.durationMs));
    assert.ok(preset.label.length > 0);
    assert.equal(textMotionPreset(preset.id), preset);
  }
  assert.equal(textMotionPreset('not-a-preset'), undefined);
});

test('all presets can run in either phase by time-reversing the complete authored motion', () => {
  for (const preset of TEXT_MOTION_PRESETS) {
    const oppositePhase = preset.phase === 'entrance' ? 'exit' : 'entrance';
    for (const progress of [0, 0.17, 0.5, 0.83, 1]) {
      const options = { phase: oppositePhase } as const;
      const reversed = pose(preset.id, progress, 2, 5, 1.3, 0.45, 'ease-in-out', options);
      const expected = pose(preset.id, 1 - progress, 2, 5, 1.3, 0.45, 'ease-in-out');
      assert.deepEqual(reversed, expected, preset.id + ' at ' + progress + ' in ' + oppositePhase);
    }

    const entranceAtZero = pose(preset.id, 0, 2, 5, 1, 0.35, undefined, { phase: 'entrance' });
    const entranceAtOne = pose(preset.id, 1, 2, 5, 1, 0.35, undefined, { phase: 'entrance' });
    assert.deepEqual(entranceAtOne, identity, preset.id + ' entrance can finish readable');
    assert.ok(entranceAtZero.opacity === 0 || entranceAtZero.clipInset === 1
      || entranceAtZero.scaleX === 0 || entranceAtZero.scaleY === 0 || entranceAtZero.noise === 1,
    preset.id + ' entrance begins hidden');

    const exitAtZero = pose(preset.id, 0, 2, 5, 1, 0.35, undefined, { phase: 'exit' });
    const exitAtOne = pose(preset.id, 1, 2, 5, 1, 0.35, undefined, { phase: 'exit' });
    assert.deepEqual(exitAtZero, identity, preset.id + ' exit begins readable');
    assert.ok(exitAtOne.opacity === 0 || exitAtOne.clipInset === 1
      || exitAtOne.scaleX === 0 || exitAtOne.scaleY === 0 || exitAtOne.noise === 1,
    preset.id + ' exit finishes hidden');
  }
});

test('control metadata offers order to every preset and direction only to authored directional motions', () => {
  const directional = new Set<TextMotionId>([
    'line-reveal', 'word-ghost', 'kinetic-lines', 'character-fade-up', 'word-fade-up',
    'character-slide-down', 'alternating-lines', 'stretch-rise', 'vertical-unfold', 'smear-in',
    'soft-wave', 'character-exit-up', 'fade-down-out', 'blur-out', 'gravity-out', 'reverse-erase'
  ]);
  for (const preset of TEXT_MOTION_PRESETS) {
    assert.deepEqual(textMotionControls(preset.id), {
      directions: directional.has(preset.id),
      order: true
    }, preset.id + ' controls');
  }
  assert.deepEqual(textMotionControls('not-a-preset'), { directions: false, order: false });
});

test('explicit segment order follows chronological playback even when the native design is reversed', () => {
  for (const preset of TEXT_MOTION_PRESETS) for (const phase of ['entrance', 'exit'] as const) {
    const completion = (order: TextMotionOrder) => Array.from({ length: 5 }, (_, index) => {
      const current = pose(preset.id, 0.25, index, 5, 1, 0.8, 'linear', { phase, order });
      return phase === 'entrance' ? current.opacity : 1 - current.opacity;
    });
    const forward = completion('forward'), reverse = completion('reverse');
    assert.ok(forward[0]! > forward[4]!, preset.id + ' ' + phase + ': forward starts at index zero');
    assert.ok(reverse[0]! < reverse[4]!, preset.id + ' ' + phase + ': reverse starts at last index');
    const center = completion('center-out'), edges = completion('edges-in');
    assert.ok(center[2]! > center[0]!, preset.id + ' ' + phase + ': center starts first');
    assert.ok(edges[0]! > edges[2]!, preset.id + ' ' + phase + ': edges start first');
  }
});

test('explicit center ranks fill the interval for even counts and animate a center pair together for the full duration', () => {
  for (const phase of ['entrance', 'exit'] as const) for (const order of ['center-out', 'edges-in'] as const) {
    const pair = [0, 1].map(index => pose('character-fade-up', 0.5, index, 2, 1, 0.9, 'linear', { phase, order }));
    assert.equal(pair[0]!.opacity, 0.5);
    assert.equal(pair[1]!.opacity, 0.5);
    for (const count of [4, 6]) {
      const at = (p: number) => Array.from({ length: count }, (_, index) => pose('character-fade-up', p, index, count, 1, 0.9, 'linear', { phase, order }).opacity);
      assert.ok(at(0.01).some(alpha => phase === 'entrance' ? alpha > 0 : alpha < 1), `${count} ${phase} ${order} starts immediately`);
      assert.ok(at(0.99).some(alpha => phase === 'entrance' ? alpha < 1 : alpha > 0), `${count} ${phase} ${order} uses the full duration`);
    }
  }
});

test('explicit directions orient motion axes, anisotropic scales, phase endpoints, and clip edges', () => {
  const directions: readonly Exclude<TextMotionDirection, 'default'>[] = ['up', 'down', 'left', 'right'];
  for (const direction of directions) {
    const movingIn = pose('character-fade-up', 0, 0, 1, 1, 0, undefined, { direction });
    const movingOut = pose('character-exit-up', 1, 0, 1, 1, 0, undefined, { direction, phase: 'exit' });
    const reversedExit = pose('character-exit-up', 0, 0, 1, 1, 0, undefined, { direction, phase: 'entrance' });
    for (const current of [movingIn, movingOut, reversedExit]) {
      for (const value of [current.x, current.y, current.scaleX, current.scaleY, current.rotate,
        current.opacity, current.blur, current.clipInset ?? 0]) {
        assert.ok(Number.isFinite(value), direction + ' pose remains finite');
      }
    }
    assert.deepEqual(reversedExit, movingOut, direction + ' has the same hidden endpoint in either phase');

    if (direction === 'up') assert.ok(movingIn.y < 0);
    if (direction === 'down') assert.ok(movingIn.y > 0);
    if (direction === 'left') assert.ok(movingIn.x < 0);
    if (direction === 'right') assert.ok(movingIn.x > 0);

    const reveal = pose('line-reveal', 0, 0, 1, 1, 0, undefined, { direction });
    assert.equal(reveal.clipInset, 1);
    assert.equal(reveal.clipEdge, direction, 'line reveal clip tracks its rotated bottom edge');
    const reversedReveal = pose('line-reveal', 1, 0, 1, 1, 0, undefined, { direction, phase: 'exit' });
    assert.equal(reversedReveal.clipEdge, direction, 'reversed line reveal keeps the requested hidden edge');
  }

  const stretched = pose('stretch-rise', 0, 0, 1, 1, 0, undefined, { direction: 'left' });
  assert.ok(stretched.scaleX > 2 && stretched.scaleY < 0.3, 'vertical stretch becomes horizontal');
  const smeared = pose('smear-in', 0, 0, 1, 1, 0, undefined, { direction: 'up' });
  assert.equal(smeared.scaleX, 1);
  assert.equal(smeared.scaleY, 6, 'horizontal smear becomes vertical');

  const alternatingUp = pose('alternating-lines', 0, 0, 2, 1, 0, undefined, { direction: 'up' });
  const alternatingDown = pose('alternating-lines', 0, 0, 2, 1, 0, undefined, { direction: 'down' });
  assert.ok(alternatingUp.y < 0 && Math.abs(alternatingUp.x) < Math.abs(alternatingUp.y),
    'alternating lines can start on the vertical axis');
  assert.ok(alternatingDown.y > 0 && Math.abs(alternatingDown.x) < Math.abs(alternatingDown.y));

  const wave = pose('soft-wave', 0.4, 0, 4, 1, 0, undefined, { direction: 'left' });
  assert.notEqual(wave.x, 0);
  assert.equal(wave.y, 0, 'wave moves along the selected axis');

  const clippedSlide = pose('character-slide-down', 0, 0, 1, 1, 0, undefined, { direction: 'up' });
  assert.equal(clippedSlide.clipEdge, 'down', 'clipInset retains its authored bottom edge at zero rotation');
  const rotatedClip = pose('character-slide-down', 0, 0, 1, 1, 0, undefined, { direction: 'left' });
  assert.equal(rotatedClip.clipEdge, 'right', 'clipInset edge rotates with the authored geometry');
});

test('default options preserve authored poses and stagger overrides are stable temporal ranks', () => {
  for (const preset of TEXT_MOTION_PRESETS) {
    for (const progress of [0, 0.24, 0.5, 0.91, 1]) {
      const original = pose(preset.id, progress, 2, 5, 1.2, 0.4, 'ease-out');
      const explicitDefaults = pose(preset.id, progress, 2, 5, 1.2, 0.4, 'ease-out', {
        phase: preset.phase, direction: 'default', order: 'default'
      });
      assert.equal(JSON.stringify(explicitDefaults), JSON.stringify(original), preset.id + ' byte-compatible defaults');
    }
  }

  const orders: readonly TextMotionOrder[] = ['default', 'forward', 'reverse', 'center-out', 'edges-in', 'random'];
  for (const order of orders) {
    const first = Array.from({ length: 5 }, (_, index) => pose('character-fade-up', 0.53, index, 5, 1, 0.8, 'linear', { order }));
    const second = Array.from({ length: 5 }, (_, index) => pose('character-fade-up', 0.53, index, 5, 1, 0.8, 'linear', { order }));
    assert.deepEqual(first, second, order + ' rank is deterministic');
    assert.deepEqual(pose('character-fade-up', 0.6, 0, 1, 1, 0.9, undefined, { order }),
      pose('character-fade-up', 0.6, 0, 1, 1, 0.9), order + ' is a no-op for one segment');
  }

  const forwardAtHalf = pose('scatter-assemble', 0.3, 1, 5, 1, 0.8, 'linear', { order: 'forward' });
  const reverseAtHalf = pose('scatter-assemble', 0.7, 1, 5, 1, 0.8, 'linear', { order: 'reverse' });
  for (const field of ['x', 'y', 'scaleX', 'scaleY', 'rotate', 'opacity', 'blur'] as const) {
    close(forwardAtHalf[field], reverseAtHalf[field], 1e-12);
  }

  assert.deepEqual(pose('character-fade-up', 0.2, 0, 5), pose('character-fade-up', 0.2, 0, 5, 1, 0.35, undefined, { order: 'forward' }));
  assert.deepEqual(pose('character-fade-up', 0.2, 0, 5, 1, 0.35, undefined, { order: 'reverse' }),
    pose('character-fade-up', 0.2, 4, 5), 'reverse uses descending segment ranks');
  assert.deepEqual(pose('character-fade-up', 0.2, 2, 5, 1, 0.35, undefined, { order: 'center-out' }),
    pose('character-fade-up', 0.2, 0, 5), 'center-out moves the center rank first');
  assert.deepEqual(pose('character-fade-up', 0.2, 0, 5, 1, 0.35, undefined, { order: 'edges-in' }),
    pose('character-fade-up', 0.2, 0, 5), 'edges-in moves outer ranks first');
});

test('entrances settle to exact identity and exits begin at identity and finish fully transparent', () => {
  for (const preset of TEXT_MOTION_PRESETS) {
    const start = pose(preset.id, 0, 2, 5);
    const end = pose(preset.id, 1, 2, 5);
    if (preset.phase === 'entrance') {
      assert.deepEqual(end, identity, preset.id + ' entrance endpoint');
      assert.ok(start.opacity === 0 || start.clipInset === 1 || start.scaleY === 0,
        preset.id + ' has a hidden start pose');
    } else {
      assert.deepEqual(start, identity, preset.id + ' exit start');
      assert.equal(end.opacity, 0, preset.id + ' exit endpoint');
      if (end.clipInset !== undefined) assert.equal(end.clipInset, 1);
      if (end.noise !== undefined) assert.equal(end.noise, 1);
    }
  }
});

test('random-order builds use the complete interval even for two glyphs and high stagger', () => {
  for (const id of ['scatter-assemble', 'random-fade', 'gravity-out'] as const) {
    for (const count of [2, 3, 13]) {
      const before = Array.from({ length: count }, (_, index) => pose(id, 0.95, index, count, 1, 0.9, 'linear'));
      if (id === 'gravity-out') {
        assert.ok(before.some(value => value.opacity > 0), id + ' still has an active final glyph');
        assert.ok(before.some(value => value.opacity === 0), id + ' earlier glyphs already finish');
      } else {
        assert.ok(before.some(value => value.opacity < 1), id + ' still has an active final glyph');
        assert.ok(before.some(value => value.opacity === 1), id + ' earlier glyphs already finish');
      }
      assert.deepEqual(before, Array.from({ length: count }, (_, index) => pose(id, 0.95, index, count, 1, 0.9, 'linear')));
    }
  }
});

test('stagger is a fraction of the fixed interval, with preset-specific order and no length multiplier', () => {
  const early = pose('character-fade-up', 0.2, 0, 5, 1, 0.5);
  const late = pose('character-fade-up', 0.2, 4, 5, 1, 0.5);
  assert.ok(early.opacity > late.opacity);
  assert.equal(late.opacity, 0);
  close(pose('character-fade-up', 0.95, 4, 5, 1, 0.9).opacity, 0.5);

  const center = pose('center-out', 0.35, 2, 5, 1, 0.6);
  const outside = pose('center-out', 0.35, 0, 5, 1, 0.6);
  assert.ok(center.opacity > outside.opacity);
  close(pose('center-out', 0.4, 1, 5, 1, 0.6).opacity,
    pose('center-out', 0.4, 3, 5, 1, 0.6).opacity);

  const firstToLeave = pose('fade-down-out', 0.3, 3, 4, 1, 0.6);
  const lastToLeave = pose('fade-down-out', 0.3, 0, 4, 1, 0.6);
  assert.ok(firstToLeave.opacity < lastToLeave.opacity);

  assert.equal(textMotionPreset('character-fade-up')!.durationMs, 620);
  for (const count of [1, 5, 500]) assert.deepEqual(pose('character-fade-up', 1, 0, count), identity);
});

test('amount and progress are normalized while poses stay finite and bounded on fade channels', () => {
  const normal = pose('character-fade-up', 0.4, 0, 1, 1, 0);
  const doubled = pose('character-fade-up', 0.4, 0, 1, 2, 0);
  close(doubled.y, normal.y * 2);
  close(doubled.opacity, normal.opacity);
  for (const preset of TEXT_MOTION_PRESETS) {
    const zero = pose(preset.id, 0.43, 2, 5, 0, 0.4);
    assert.ok(zero.x === 0 && zero.y === 0 && zero.scaleX === 1 && zero.scaleY === 1
      && zero.rotate === 0 && zero.blur === 0, preset.id + ' amount zero leaves geometry at identity');
    if (zero.clipInset !== undefined) assert.equal(zero.clipInset, 0);
    if (zero.noise !== undefined) assert.equal(zero.noise, 0);
  }
  assert.ok(pose('character-fade-up', 0.5, 0, 1, 0, 0).opacity > 0);
  assert.ok(pose('character-fade-up', 0.5, 0, 1, 0, 0).opacity < 1);
  assert.ok(pose('character-exit-up', 0.5, 0, 1, 0, 0).opacity > 0);
  assert.ok(pose('character-exit-up', 0.5, 0, 1, 0, 0).opacity < 1);
  assert.deepEqual(pose('character-fade-up', -10), pose('character-fade-up', 0));
  assert.deepEqual(pose('character-fade-up', 10), identity);

  for (const preset of TEXT_MOTION_PRESETS) {
    const current = pose(preset.id, 0.43, 2, 5, 1.5, 0.4);
    for (const value of [current.x, current.y, current.scaleX, current.scaleY, current.rotate,
      current.opacity, current.blur, current.clipInset ?? 0, current.noise ?? 0]) {
      assert.ok(Number.isFinite(value), preset.id + ' pose values remain finite');
    }
    assert.ok(current.opacity >= 0 && current.opacity <= 1, preset.id + ' opacity is bounded');
    if (current.clipInset !== undefined) assert.ok(current.clipInset >= 0 && current.clipInset <= 1);
    if (current.noise !== undefined) assert.ok(current.noise >= 0 && current.noise <= 1);
  }
});

test('selected easing is applied after per-segment stagger and may overshoot geometry without overshooting opacity', () => {
  const linear = pose('character-fade-up', 0.25, 0, 1, 1, 0, 'linear');
  const eased = pose('character-fade-up', 0.25, 0, 1, 1, 0, 'ease-in');
  close(linear.y, 0.62 * 0.75);
  close(eased.y, 0.62 * 0.9375);
  assert.ok(linear.opacity > eased.opacity);

  const early = pose('character-fade-up', 0.4, 0, 2, 1, 0.5, 'ease-in');
  const late = pose('character-fade-up', 0.4, 1, 2, 1, 0.5, 'ease-in');
  close(early.opacity, 0.64);
  assert.equal(late.opacity, 0);

  const overshoot = pose('character-fade-up', 0.8, 0, 1, 1, 0, 'back-out');
  assert.ok(overshoot.y < 0);
  assert.equal(overshoot.opacity, 1);
  const exitOvershoot = pose('fade-down-out', 0.8, 0, 1, 1, 0, 'back-out');
  assert.ok(exitOvershoot.y > 0);
  assert.equal(exitOvershoot.opacity, 0);
});

test('the named entrances produce distinct masks, distances, directions, and overshoot', () => {
  assert.equal(pose('line-reveal', 0, 0, 1).clipInset, 1);
  assert.equal(pose('line-reveal', 1, 0, 1).clipInset, undefined);

  const firstGhost = pose('word-ghost', 0.25, 0, 3, 1, 0);
  const lastGhost = pose('word-ghost', 0.25, 2, 3, 1, 0);
  assert.ok(Math.abs(firstGhost.x) > Math.abs(lastGhost.x));

  const alternatingLeft = pose('alternating-lines', 0, 0, 2, 1, 0);
  const alternatingRight = pose('alternating-lines', 0, 1, 2, 1, 0);
  assert.ok(alternatingLeft.x < 0 && alternatingRight.x > 0);

  const stretched = pose('stretch-rise', 0, 0, 1);
  const squash = pose('stretch-rise', 0.72, 0, 1, 1, 0);
  assert.ok(stretched.scaleY > 2 && stretched.scaleX < 0.3);
  assert.ok(squash.scaleY < 0.8 && squash.scaleX > 1);
  assert.equal(pose('vertical-unfold', 0, 0, 1).scaleY, 0);

  const centerConverges = pose('converge-spread', 0, 2, 5, 1, 0);
  const leftConverges = pose('converge-spread', 0, 0, 5, 1, 0);
  const rightConverges = pose('converge-spread', 0, 4, 5, 1, 0);
  assert.equal(centerConverges.x, 0);
  assert.ok(leftConverges.x < 0 && rightConverges.x > 0);
  assert.ok(pose('tracking-expand', 0, 0, 5).x > 0);
  assert.ok(pose('tracking-expand', 0, 4, 5).x < 0);

  const assembled = pose('scatter-assemble', 0.25, 1, 5);
  assert.deepEqual(assembled, pose('scatter-assemble', 0.25, 1, 5));
  assert.notDeepEqual(assembled, pose('scatter-assemble', 0.25, 2, 5));
  const tilted = pose('tilt-scale', 0, 1, 4);
  assert.ok(Math.abs(tilted.rotate) <= 20);
  assert.ok(pose('elastic-pop', 0.25).scaleX > 1);
  assert.notEqual(pose('soft-wave', 0.4, 0, 4).y, pose('soft-wave', 0.4, 2, 4).y);
  assert.ok(pose('emoji-pop', 0.5).scaleY > 0.18);

  const smearEarly = pose('smear-in', 0.2, 0, 4);
  const smearLate = pose('smear-in', 0.2, 3, 4);
  assert.ok(smearLate.opacity > smearEarly.opacity);
  assert.equal(pose('smear-in', 0, 0, 1, 0, 0).scaleX, 1);
  assert.equal(pose('smear-in', 0, 0, 1, 1, 0).scaleX, 6);
  assert.equal(pose('elastic-pop', 0, 0, 1, 0, 0).scaleX, 1);
  close(pose('elastic-pop', 0, 0, 1, 1, 0).scaleX, 0.42);
  assert.notEqual(pose('tilt-scale', 0, 1, 4, 1, 0).rotate, 0);
});

test('exit poses cover rise, blur, scatter, gravity, scaling, reverse erasure, collapse, and erosion', () => {
  assert.ok(pose('character-exit-up', 0.5).y < 0);
  assert.ok(pose('fade-down-out', 0.5).y > 0);
  assert.ok(pose('blur-out', 0.5).blur > 0);
  assert.deepEqual(pose('scatter-out', 0.4, 1, 4), pose('scatter-out', 0.4, 1, 4));

  const fallingA = pose('gravity-out', 0.5, 1, 4);
  const fallingB = pose('gravity-out', 0.5, 2, 4);
  assert.notDeepEqual(fallingA, fallingB);
  assert.ok(fallingA.y > 0);
  assert.ok(pose('scale-down-out', 0.5).scaleX < 1);
  assert.ok(pose('reverse-erase', 0.5).clipInset! > 0);

  const outer = pose('collapse-center', 0.35, 0, 5, 1, 0.6);
  const middle = pose('collapse-center', 0.35, 2, 5, 1, 0.6);
  assert.ok(outer.opacity < middle.opacity);
  const dissolved = pose('noise-dissolve', 0.5, 0, 1, 1, 0);
  close(dissolved.noise!, 0.5);
  close(dissolved.opacity, 0.5);
});

test('text segmentation is grapheme-safe and preserves words, punctuation, whitespace, and line endings', () => {
  const graphemes = segmentTextMotion('A\u0308👩🏽‍🚀🇩🇪', 'character');
  assert.deepEqual(graphemes, ['A\u0308', '👩🏽‍🚀', '🇩🇪']);

  const text = '  Hallo, Welt!\n42.';
  const words = segmentTextMotion(text, 'word');
  assert.deepEqual(words, ['  Hallo, ', 'Welt!\n', '42.']);
  assert.equal(words.join(''), text);

  const linesText = 'erste\r\nzweite\n\rdritte\r';
  const lines = segmentTextMotion(linesText, 'line');
  assert.deepEqual(lines, ['erste\r\n', 'zweite\n', '\r', 'dritte\r']);
  assert.equal(lines.join(''), linesText);
  assert.deepEqual(segmentTextMotion('', 'character'), []);
});
