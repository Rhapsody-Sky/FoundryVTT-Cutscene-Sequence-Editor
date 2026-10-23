import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEditorTimelineCommand, applyTimelineCommand, enableAutomaticEnd } from '../src/application/timeline-commands.js';
import { TRANSITION_EASINGS, type SequenceV1, type TextClip, type Transition, type TransitionEasing } from '../src/domain/sequence.js';
import { evaluateEasing, transitionChangesBarsReveal, transitionChangesOpacity,
  transitionChangesTextPosition, transitionChangesTextScale, transitionDurationMs } from '../src/domain/transitions.js';
import { createBarsSequence, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';
import { LocalPlayer, type PlayerFrame, type Runtime, type Surface } from '../src/playback/local-player.js';

const none: Transition = { preset: 'none', version: 1 };
type TimedTransition = Exclude<Transition, { readonly preset: 'none' }>;
function timed(preset: TimedTransition['preset'], durationMs = 200,
  properties: Partial<Omit<TimedTransition, 'preset' | 'version' | 'durationMs'>> = {}): TimedTransition {
  return { preset, version: 1, durationMs, easing: 'linear', ...properties };
}
function sequence(entrance: Transition = none, exit: Transition = none): SequenceV1 {
  let id = 0;
  const base = createBarsSequence('Title transitions', () => `title-${++id}`);
  const clip: TextClip = {
    ...base.clips[0]!, type: 'text', typeVersion: 1, startMs: 200,
    duration: { kind: 'fixed', milliseconds: 1_000 }, entrance, exit,
    properties: { text: 'Title', fontFamily: 'Arial', fontSize: 48, minimumFontSize: 12,
      color: '#ffffff', align: 'center', box: { x: 100, y: 120, width: 800, height: 200 }, shrinkToFit: true }
  };
  return validateSequence({ ...base, clips: [clip], end: { kind: 'fixed', durationMs: 1_400, automatic: false } });
}
function invalidTransition(source: SequenceV1, edge: 'entrance' | 'exit', transition: unknown, path: string, code = 'INVALID_VALUE'): void {
  assert.throws(() => validateSequence({ ...source, clips: [{ ...source.clips[0]!, [edge]: transition }] }),
    error => error instanceof SequenceValidationError && error.code === code && error.path === `sequence.clips[0].${edge}.${path}`);
}
function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} must equal ${expected}`);
}

test('all text presets and easing values validate without injecting defaults and preserve extensions', () => {
  for (const preset of ['fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'] as const) {
    for (const easing of TRANSITION_EASINGS) {
      const entrance = { ...timed(preset, 200, { easing }), future: { values: ['keep', 3] } };
      const source = sequence(entrance, timed(preset, 300, { easing }));
      assert.deepEqual(source.clips[0]!.entrance, entrance);
      assert.notEqual(source.clips[0]!.entrance, entrance);
      for (const key of ['direction', 'distance', 'scale']) assert.equal(Object.hasOwn(source.clips[0]!.entrance, key), false);
    }
  }
});

test('text slide and zoom parameters validate on both edges with precise bounds and paths', () => {
  const source = sequence();
  for (const edge of ['entrance', 'exit'] as const) {
    for (const preset of ['slide', 'fade-slide'] as const) {
      for (const direction of ['left', 'right', 'up', 'down'] as const) {
        for (const distance of [0, 32_768, 1.25]) {
          const transition = timed(preset, 200, { direction, distance });
          assert.deepEqual(validateSequence({ ...source, clips: [{ ...source.clips[0]!, [edge]: transition }] }).clips[0]![edge], transition);
        }
      }
      for (const direction of ['diagonal', 1, null]) invalidTransition(source, edge, { ...timed(preset), direction }, 'direction');
      for (const distance of [-1, 32_769, '100', null]) invalidTransition(source, edge, { ...timed(preset), distance }, 'distance');
    }
    for (const preset of ['zoom', 'fade-zoom'] as const) {
      for (const scale of [0.05, 4, 1.75]) {
        const transition = timed(preset, 200, { scale });
        assert.deepEqual(validateSequence({ ...source, clips: [{ ...source.clips[0]!, [edge]: transition }] }).clips[0]![edge], transition);
      }
      for (const scale of [0, 0.049, 4.001, '1', null]) invalidTransition(source, edge, { ...timed(preset), scale }, 'scale');
    }
    invalidTransition(source, edge, { ...timed('zoom'), easing: 'bounce' }, 'easing');
    invalidTransition(source, edge, { ...timed('zoom'), version: 2 }, 'version', 'UNSUPPORTED_VERSION');
    for (const durationMs of [0, -1, 1.5]) invalidTransition(source, edge, { ...timed('zoom'), durationMs }, 'durationMs');
  }
  assert.throws(() => sequence(timed('slide', 600), timed('zoom', 401)),
    error => error instanceof SequenceValidationError && error.code === 'INVALID_TIMING');
});

test('bars reject zoom presets and retain optional text-looking extensions without using them', () => {
  let id = 0;
  const bars = createBarsSequence('Bars', () => `bars-${++id}`);
  for (const edge of ['entrance', 'exit'] as const) for (const preset of ['zoom', 'fade-zoom'] as const) {
    invalidTransition(bars, edge, timed(preset), 'preset', 'UNSUPPORTED_TYPE');
  }
  const entrance = { ...timed('slide'), direction: 'future-direction', distance: -2, scale: 'future-scale' };
  const source = validateSequence({ ...bars, clips: [{ ...bars.clips[0]!, entrance }] });
  assert.deepEqual(source.clips[0]!.entrance, entrance);
  const item = evaluate(compileSequence(source), 100)[0]!;
  assert.equal(item.barsReveal, 0.5);
  assert.equal(Object.hasOwn(item, 'textTransform'), false);
});

test('easing endpoints and midpoints preserve smoothstep and provide standard back overshoot', () => {
  const midpoints: Record<TransitionEasing, number> = {
    linear: 0.5, 'ease-in': 0.25, 'ease-out': 0.75, 'ease-in-out': 0.5,
    'back-in': -0.0876975, 'back-out': 1.0876975, 'back-in-out': 0.5
  };
  for (const easing of TRANSITION_EASINGS) {
    assert.equal(evaluateEasing(0, easing), 0);
    assert.equal(evaluateEasing(1, easing), 1);
    assert.equal(evaluateEasing(-5, easing), 0);
    assert.equal(evaluateEasing(5, easing), 1);
    close(evaluateEasing(0.5, easing), midpoints[easing]);
  }
  for (const progress of [0.1, 0.25, 0.75, 0.9]) {
    assert.equal(evaluateEasing(progress, 'ease-in-out'), progress * progress * (3 - 2 * progress));
  }
  assert.ok(evaluateEasing(0.25, 'back-in-out') < 0);
  assert.ok(evaluateEasing(0.75, 'back-in-out') > 1);
});

test('preset helpers select only their intended opacity and motion channels', () => {
  assert.equal(transitionDurationMs(none), 0);
  for (const preset of ['fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'] as const) {
    const transition = timed(preset);
    assert.equal(transitionDurationMs(transition), 200);
    assert.equal(transitionChangesOpacity(transition), ['fade', 'fade-slide', 'fade-zoom'].includes(preset));
    assert.equal(transitionChangesBarsReveal(transition), ['slide', 'fade-slide'].includes(preset));
    assert.equal(transitionChangesTextPosition(transition), ['slide', 'fade-slide'].includes(preset));
    assert.equal(transitionChangesTextScale(transition), ['zoom', 'fade-zoom'].includes(preset));
  }
});

test('slide entrances and exits use composition distances and all four signed directions', () => {
  const directions = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] } as const;
  for (const [direction, [dx, dy]] of Object.entries(directions)) {
    for (const preset of ['slide', 'fade-slide'] as const) {
      const plan = compileSequence(sequence(timed(preset, 200, { direction: direction as keyof typeof directions, distance: 80 }),
        timed(preset, 400, { direction: direction as keyof typeof directions, distance: 120 })));
      for (const [position, offset, opacity] of [[200, 80, 0], [250, 60, 0.25], [300, 40, 0.5],
        [400, 0, 1], [700, 0, 1], [800, 0, 1], [900, 30, 0.75], [1_000, 60, 0.5], [1_100, 90, 0.25]] as const) {
        const item = evaluate(plan, position)[0]!;
        assert.deepEqual(item.textTransform, { x: dx * offset || 0, y: dy * offset || 0, scale: 1 });
        assert.equal(item.opacity, preset === 'slide' ? 1 : opacity);
        assert.equal(Object.hasOwn(item, 'barsReveal'), false);
        assert.ok(Object.isFrozen(item.textTransform));
      }
      assert.deepEqual(evaluate(plan, 199), []);
      assert.deepEqual(evaluate(plan, 1_200), []);
    }
  }
  const defaults = compileSequence(sequence(timed('slide')));
  assert.deepEqual(evaluate(defaults, 200)[0]!.textTransform, { x: 0, y: 100, scale: 1 });
  assert.deepEqual(evaluate(defaults, 300)[0]!.textTransform, { x: 0, y: 50, scale: 1 });
  const still = compileSequence(sequence(timed('slide', 200, { distance: 0 })));
  assert.deepEqual(evaluate(still, 200)[0]!.textTransform, { x: 0, y: 0, scale: 1 });
});

test('zoom entrances and exits interpolate independently with configured and legacy endpoints', () => {
  for (const preset of ['zoom', 'fade-zoom'] as const) {
    const plan = compileSequence(sequence(timed(preset, 200, { scale: 0.5 }), timed(preset, 400, { scale: 2 })));
    for (const [position, scale, opacity] of [[200, 0.5, 0], [300, 0.75, 0.5], [400, 1, 1],
      [700, 1, 1], [800, 1, 1], [1_000, 1.5, 0.5], [1_100, 1.75, 0.25]] as const) {
      assert.deepEqual(evaluate(plan, position)[0]!.textTransform, { x: 0, y: 0, scale });
      assert.equal(evaluate(plan, position)[0]!.opacity, preset === 'zoom' ? 1 : opacity);
    }
  }
  const defaults = compileSequence(sequence(timed('zoom')));
  assert.equal(evaluate(defaults, 200)[0]!.textTransform!.scale, 0.8);
  assert.equal(evaluate(defaults, 300)[0]!.textTransform!.scale, 0.9);
});

test('mixed entrance and exit presets support arbitrary backward seeks with a stable identity interval', () => {
  const source = sequence(timed('fade-slide', 200, { direction: 'left', distance: 160, easing: 'ease-in' }),
    timed('zoom', 400, { scale: 2, easing: 'ease-out' }));
  const plan = compileSequence(source);
  for (const position of [1_100, 250, 700, 300, 900, 250, 200]) {
    const item = evaluate(plan, position)[0]!;
    const inProgress = evaluateEasing((position - 200) / 200, 'ease-in');
    const outProgress = evaluateEasing((position - 800) / 400, 'ease-out');
    assert.deepEqual(item.textTransform, { x: -160 * (1 - inProgress) || 0, y: 0, scale: 1 + outProgress });
    assert.equal(item.opacity, inProgress);
    assert.deepEqual(item, evaluate(compileSequence(source), position)[0]);
  }
  const reverse = compileSequence(sequence(timed('zoom', 200, { scale: 2 }), timed('fade-slide', 400, { direction: 'up', distance: 80 })));
  assert.deepEqual(evaluate(reverse, 300)[0]!.textTransform, { x: 0, y: 0, scale: 1.5 });
  assert.deepEqual(evaluate(reverse, 1_000)[0]!.textTransform, { x: 0, y: -40, scale: 1 });
  assert.equal(evaluate(reverse, 1_000)[0]!.opacity, 0.5);
});

test('back easing overshoots text motion while every fade channel remains within zero and one', () => {
  for (const preset of ['fade-slide', 'fade-zoom'] as const) for (const easing of ['back-in', 'back-out', 'back-in-out'] as const) {
    const plan = compileSequence(sequence(timed(preset, 200, { easing }), timed(preset, 400, { easing })));
    for (let position = 200; position < 1_200; position += 5) {
      const item = evaluate(plan, position)[0]!;
      assert.ok(item.opacity >= 0 && item.opacity <= 1);
      const progress = position <= 400 ? evaluateEasing((position - 200) / 200, easing)
        : position >= 800 ? 1 - evaluateEasing((position - 800) / 400, easing) : 1;
      if (preset === 'fade-slide') close(item.textTransform!.y, 100 * (1 - progress));
      else close(item.textTransform!.scale, 1 + (0.8 - 1) * (1 - progress));
    }
  }
  const slide = compileSequence(sequence(timed('slide', 200, { easing: 'back-out' })));
  assert.ok(evaluate(slide, 300)[0]!.textTransform!.y < 0);
  const zoom = compileSequence(sequence(timed('zoom', 200, { easing: 'back-out' })));
  assert.ok(evaluate(zoom, 300)[0]!.textTransform!.scale > 1);
});

test('small zoom endpoints stay upright with back curves while enlarged zoom overshoot remains available', () => {
  for (const easing of TRANSITION_EASINGS) for (const scale of [0.05, 4]) {
    const plan = compileSequence(sequence(timed('fade-zoom', 400, { scale, easing }), timed('fade-zoom', 400, { scale, easing })));
    for (let position = 200; position < 1200; position += 20) {
      const item = evaluate(plan, position)[0]!;
      assert.ok(Number.isFinite(item.textTransform!.scale) && item.textTransform!.scale > 0, `${easing} scale ${scale} at ${position}`);
      assert.ok(item.opacity >= 0 && item.opacity <= 1);
    }
    close(evaluate(plan, 200)[0]!.textTransform!.scale, scale);
  }
  const small = compileSequence(sequence(timed('zoom', 400, { scale: 0.05, easing: 'back-in' }), timed('zoom', 400, { scale: 0.05, easing: 'back-out' })));
  assert.equal(evaluate(small, 400)[0]!.textTransform!.scale, 0.01);
  assert.equal(evaluate(small, 1000)[0]!.textTransform!.scale, 0.01);
  const enlarged = compileSequence(sequence(timed('zoom', 400, { scale: 4, easing: 'back-in' })));
  assert.ok(evaluate(enlarged, 400)[0]!.textTransform!.scale > 4, 'positive overshoot is retained');
});

test('legacy none and fade text frame shapes stay exact, and finite positions remain required', () => {
  for (const entrance of [none, timed('fade')]) {
    const plan = compileSequence(sequence(entrance));
    assert.deepEqual(evaluate(plan, 300)[0], { clip: plan.clips[0], localTimeMs: 100, opacity: entrance.preset === 'none' ? 1 : 0.5 });
    assert.deepEqual(evaluate(plan, -1), []);
    assert.deepEqual(evaluate(plan, 1_200), []);
    assert.throws(() => evaluate(plan, Number.NaN), RangeError);
  }
});

test('held titles ignore individual Out across finite and manual sequence endpoints', () => {
  for (const exit of [timed('fade-slide', 400, { direction: 'left' }), timed('fade-zoom', 400, { scale: 2 })]) {
    const source = sequence(timed('fade-slide'), exit);
    for (const end of [source.end, { kind: 'manual' } as const]) {
      const held = validateSequence({ ...source, end, clips: [{ ...source.clips[0]!, duration: { kind: 'sequence-end' } }] });
      const plan = compileSequence(held);
      assert.deepEqual(evaluate(plan, 300)[0]!.textTransform, { x: 0, y: 50, scale: 1 });
      assert.equal(evaluate(plan, 300)[0]!.opacity, 0.5);
      for (const position of [1_300, 1_400, 100_000]) {
        assert.deepEqual(evaluate(plan, position)[0]!.textTransform, { x: 0, y: 0, scale: 1 });
        assert.equal(evaluate(plan, position)[0]!.opacity, 1);
      }
    }
  }
});

test('global fade freezes the same title transform and changes only surface opacity', async () => {
  let now = 0;
  let callback: (() => void) | undefined;
  const runtime: Runtime = { now: () => now, requestFrame: next => { callback = next; return 1; }, cancelFrame: () => { callback = undefined; } };
  const frames: PlayerFrame[] = [];
  const surface: Surface = { prepare: async () => undefined, render: frame => frames.push(frame), dispose: () => undefined };
  const player = new LocalPlayer(runtime);
  await player.start(sequence(timed('fade-slide', 400)), surface);
  now = 300; callback!();
  const before = frames.at(-1)!;
  assert.deepEqual(before.items[0]!.textTransform, { x: 0, y: 75, scale: 1 });
  player.fadeOut(100);
  now = 350; callback!();
  const exiting = frames.at(-1)!;
  assert.equal(exiting.phase, 'exiting');
  assert.equal(exiting.positionMs, 300);
  assert.deepEqual(exiting.items, before.items);
  assert.equal(exiting.opacity, 0.5);
  player.stop();
});

test('trim preserves motion parameters and extensions and removes known parameters at zero duration', () => {
  const entrance = { ...timed('fade-slide', 400, { direction: 'right', distance: 240, easing: 'back-in' }), future: { in: true } };
  const exit = { ...timed('fade-zoom', 600, { scale: 1.5, easing: 'ease-out' }), future: { out: true } };
  const source = sequence(entrance, exit);
  const clip = source.clips[0]!;
  const trimmed = applyTimelineCommand(source, { kind: 'resize-clip', clipId: clip.id, edge: 'end', timeMs: 700 }, () => 'unused');
  assert.deepEqual(trimmed.clips[0]!.entrance, { ...entrance, durationMs: 200 });
  assert.deepEqual(trimmed.clips[0]!.exit, { ...exit, durationMs: 300 });
  const oneMs = applyTimelineCommand(source, { kind: 'resize-clip', clipId: clip.id, edge: 'end', timeMs: 201 }, () => 'unused');
  assert.deepEqual(oneMs.clips[0]!.entrance, { ...none, future: { in: true } });
  assert.deepEqual(oneMs.clips[0]!.exit, { ...exit, durationMs: 1 });
  assert.deepEqual(source.clips[0]!.entrance, entrance);
  const replacement = { ...clip, entrance: timed('slide'), exit: timed('zoom') };
  const replaced = applyTimelineCommand(source, { kind: 'replace-clip', clip: replacement }, () => 'unused');
  assert.deepEqual(replaced.clips[0]!.entrance, { ...timed('slide'), future: { in: true } });
  assert.deepEqual(replaced.clips[0]!.exit, { ...timed('zoom'), future: { out: true } });
});

test('automatic conversion preserves fitted title transitions while honoring explicit motion edits', () => {
  const entrance = { ...timed('slide', 800, { direction: 'left', distance: 240 }), future: { in: 'keep' } };
  const exit = { ...timed('zoom', 800, { scale: 2 }), future: { out: 'keep' } };
  const base = sequence();
  const clip = { ...base.clips[0]!, duration: { kind: 'sequence-end' }, entrance, exit } as TextClip;
  const source = validateSequence({ ...base, clips: [clip], end: { kind: 'fixed', durationMs: 1_400 } });
  const converted = enableAutomaticEnd(source);
  assert.deepEqual(converted.clips[0]!.entrance, { ...entrance, durationMs: 600 });
  assert.deepEqual(converted.clips[0]!.exit, { ...exit, durationMs: 600 });
  const stale = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: { ...clip, startMs: 300 } }, () => 'unused');
  assert.deepEqual(stale.clips[0]!.entrance, { ...entrance, durationMs: 600 });
  assert.deepEqual(stale.clips[0]!.exit, { ...exit, durationMs: 600 });
  const changed = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: {
    ...clip, startMs: 300, entrance: { ...entrance, direction: 'up', distance: 80 }, exit: { ...exit, scale: 0.5 }
  } }, () => 'unused');
  assert.equal(changed.clips[0]!.entrance.preset === 'none' ? undefined : changed.clips[0]!.entrance.direction, 'up');
  assert.equal(changed.clips[0]!.entrance.preset === 'none' ? undefined : changed.clips[0]!.entrance.distance, 80);
  assert.equal(changed.clips[0]!.exit.preset === 'none' ? undefined : changed.clips[0]!.exit.scale, 0.5);
  assert.equal(transitionDurationMs(changed.clips[0]!.entrance), 600);
  assert.equal(transitionDurationMs(changed.clips[0]!.exit), 600);
  const reset = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: {
    ...clip, startMs: 300, entrance: timed('slide', 800), exit: timed('zoom', 800)
  } }, () => 'unused');
  assert.deepEqual(reset.clips[0]!.entrance, { ...timed('slide', 600), future: { in: 'keep' } });
  assert.deepEqual(reset.clips[0]!.exit, { ...timed('zoom', 600), future: { out: 'keep' } });
});
