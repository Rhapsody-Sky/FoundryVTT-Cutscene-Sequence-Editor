import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEditorTimelineCommand, applyTimelineCommand, enableAutomaticEnd, timelineConflicts } from '../src/application/timeline-commands.js';
import type { BarsClip, SequenceV1, Transition } from '../src/domain/sequence.js';
import { createBarsSequence, SEQUENCE_LIMITS, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';

const none: Transition = { preset: 'none', version: 1 };
const timed = (preset: Exclude<Transition['preset'], 'none'>, durationMs: number, easing: 'linear' | 'ease-in-out' = 'linear'): Transition =>
  ({ preset, version: 1, durationMs, easing });
function sequence(entrance: Transition = none, exit: Transition = none): SequenceV1 {
  let id = 0;
  const base = createBarsSequence('Bars transitions', () => `bars-${++id}`);
  return validateSequence({
    ...base, clips: [{ ...base.clips[0]!, startMs: 200, duration: { kind: 'fixed', milliseconds: 1_000 }, entrance, exit }],
    end: { kind: 'fixed', durationMs: 1_400, automatic: false }
  });
}
function replaceClip(source: SequenceV1, patch: Record<string, unknown>): SequenceV1 {
  return validateSequence({ ...source, clips: [{ ...source.clips[0]!, ...patch }] });
}
function invalid(source: unknown, code: string, path?: string): void {
  assert.throws(() => validateSequence(source), error => error instanceof SequenceValidationError && error.code === code
    && (path === undefined || error.path === path));
}

test('bars timed presets validate bounded duration, easing, version, overlap, and preserve extensions', () => {
  for (const preset of ['slide', 'fade-slide'] as const) {
    const entrance = { ...timed(preset, 200), extension: { future: ['preserved'] } };
    const source = sequence(entrance);
    assert.deepEqual(source.clips[0]!.entrance, entrance);
    assert.notEqual(source.clips[0]!.entrance, entrance);
    for (const durationMs of [0, -1, 1.5, SEQUENCE_LIMITS.transitionMs + 1]) {
      invalid({ ...source, clips: [{ ...source.clips[0]!, entrance: { ...entrance, durationMs } }] }, 'INVALID_VALUE');
    }
    invalid({ ...source, clips: [{ ...source.clips[0]!, entrance: { ...entrance, version: 2 } }] }, 'UNSUPPORTED_VERSION');
    invalid({ ...source, clips: [{ ...source.clips[0]!, entrance: { ...entrance, easing: 'bounce' } }] }, 'INVALID_VALUE');
    invalid({ ...source, clips: [{ ...source.clips[0]!, entrance: timed(preset, 600), exit: timed(preset, 401) }] }, 'INVALID_TIMING');
    const bounded = validateSequence({ ...source,
      end: { kind: 'fixed', durationMs: 200 + SEQUENCE_LIMITS.transitionMs * 2 },
      clips: [{ ...source.clips[0]!, duration: { kind: 'fixed', milliseconds: SEQUENCE_LIMITS.transitionMs * 2 },
        entrance: timed(preset, SEQUENCE_LIMITS.transitionMs), exit: timed(preset, SEQUENCE_LIMITS.transitionMs) }]
    });
    // The sequence endpoint also needs to contain the expanded clip.
    assert.equal(bounded.clips.length, 1);
  }
});

test('text accepts slides while video rejects motion presets on both ends', () => {
  const source = sequence();
  const base = source.clips[0]!;
  const text = {
    ...base, type: 'text', properties: { text: 'Title', fontFamily: 'Arial', fontSize: 32, minimumFontSize: 12,
      color: '#ffffff', align: 'center', box: { x: 0, y: 0, width: 300, height: 100 }, shrinkToFit: true }
  };
  const video = {
    ...base, type: 'video', duration: { kind: 'media' }, properties: {
      source: { kind: 'foundry-file', path: 'worlds/demo/intro.webm' }, fit: 'contain', volume: 0, muted: true, durationMs: 1_000
    }
  };
  for (const edge of ['entrance', 'exit'] as const) for (const preset of ['slide', 'fade-slide', 'zoom', 'fade-zoom'] as const) {
    assert.equal(validateSequence({ ...source, clips: [{ ...text, [edge]: timed(preset, 200) }] }).clips[0]![edge].preset, preset);
    invalid({ ...source, clips: [{ ...video, [edge]: timed(preset, 200) }] }, 'UNSUPPORTED_TYPE', `sequence.clips[0].${edge}.preset`);
  }
});

test('absolute bars entrance and natural exit samples independently control opacity and reveal', () => {
  for (const preset of ['fade', 'slide', 'fade-slide'] as const) {
    const plan = compileSequence(sequence(timed(preset, 200), timed(preset, 400)));
    assert.deepEqual(evaluate(plan, 199), []);
    for (const [position, progress] of [[200, 0], [250, 0.25], [300, 0.5], [400, 1], [700, 1], [800, 1], [900, 0.75], [1_000, 0.5], [1_100, 0.25]] as const) {
      const item = evaluate(plan, position)[0]!;
      assert.equal(item.localTimeMs, position - 200);
      assert.equal(item.opacity, preset === 'slide' ? 1 : progress);
      assert.equal(item.barsReveal, preset === 'fade' ? undefined : progress);
      assert.equal(Object.hasOwn(item, 'barsReveal'), preset !== 'fade');
    }
    assert.deepEqual(evaluate(plan, 1_200), []);
    assert.deepEqual(evaluate(plan, 10_000), []);
  }
});

test('mixed bars transitions apply only the selected channel with smoothstep easing on arbitrary seeks', () => {
  const plan = compileSequence(sequence(timed('slide', 200, 'ease-in-out'), timed('fade', 400, 'ease-in-out')));
  for (const position of [1_100, 250, 700, 300, 900, 250]) {
    const item = evaluate(plan, position)[0]!;
    const smooth = (p: number) => p * p * (3 - 2 * p);
    assert.equal(item.barsReveal, position <= 400 ? smooth((position - 200) / 200) : 1);
    assert.equal(item.opacity, position < 800 ? 1 : 1 - smooth((position - 800) / 400));
  }
  const exitSlide = compileSequence(sequence(timed('fade', 200), timed('slide', 400)));
  assert.equal(evaluate(exitSlide, 300)[0]!.barsReveal, 1);
  assert.equal(evaluate(exitSlide, 300)[0]!.opacity, 0.5);
  assert.equal(evaluate(exitSlide, 1_000)[0]!.barsReveal, 0.5);
  assert.equal(evaluate(exitSlide, 1_000)[0]!.opacity, 1);
});

test('legacy none/fade frame shapes and no-transition bounds stay unchanged', () => {
  for (const entrance of [none, timed('fade', 200)]) {
    const plan = compileSequence(sequence(entrance));
    const item = evaluate(plan, 300)[0]!;
    assert.deepEqual(item, { clip: plan.clips[0], opacity: entrance.preset === 'none' ? 1 : 0.5, localTimeMs: 100 });
    assert.ok(Object.isFrozen(item));
    assert.deepEqual(evaluate(plan, -1), []);
    assert.deepEqual(evaluate(plan, 1_200), []);
    assert.throws(() => evaluate(plan, Number.NaN), RangeError);
  }
  const zeroStart = replaceClip(sequence(), { startMs: 0 });
  assert.equal(evaluate(compileSequence(zeroStart), -100)[0]!.opacity, 1);
});

test('held bars ignore per-clip Out, including at a finite boundary and after long manual seeks', () => {
  const source = replaceClip(sequence(timed('fade-slide', 200), timed('fade-slide', 400)), { duration: { kind: 'sequence-end' } });
  for (const end of [source.end, { kind: 'manual' } as const]) {
    const plan = compileSequence({ ...source, end });
    const early = evaluate(plan, 300)[0]!;
    assert.equal(early.opacity, 0.5); assert.equal(early.barsReveal, 0.5);
    for (const position of [1_300, 1_400, 100_000]) {
      const item = evaluate(plan, position)[0]!;
      assert.equal(item.opacity, 1); assert.equal(item.barsReveal, 1);
    }
  }
  const onlyOut = replaceClip(sequence(none, timed('slide', 400)), { duration: { kind: 'sequence-end' } });
  assert.equal(evaluate(compileSequence(onlyOut), 200)[0]!.barsReveal, 1);
});

test('sequence boundaries and timeline range checks account for slide entrance durations', () => {
  const source = replaceClip(sequence(timed('slide', 800)), { duration: { kind: 'sequence-end' } });
  invalid({ ...source, end: { kind: 'fixed', durationMs: 999 } }, 'INVALID_TIMING');
  assert.equal(timelineConflicts({ ...source, end: { kind: 'fixed', durationMs: 999 } })[0]!.code, 'INVALID_TIMING');
  const moved = applyTimelineCommand(source, { kind: 'move-clip', clipId: source.clips[0]!.id, trackId: source.tracks[0]!.id, startMs: 1_000 }, () => 'unused');
  assert.equal(moved.end.kind === 'fixed' && moved.end.durationMs, 2_200);
});

test('trim fits timed bars transitions, preserves presets and extensions, and uses none when rounded to zero', () => {
  const entrance = { ...timed('slide', 400), extension: { in: true } };
  const exit = { ...timed('fade-slide', 600), extension: { out: true } };
  const source = sequence(entrance, exit);
  const trimmed = applyTimelineCommand(source, { kind: 'resize-clip', clipId: source.clips[0]!.id, edge: 'end', timeMs: 700 }, () => 'unused');
  assert.deepEqual(trimmed.clips[0]!.entrance, { ...entrance, durationMs: 200 });
  assert.deepEqual(trimmed.clips[0]!.exit, { ...exit, durationMs: 300 });
  const oneMs = applyTimelineCommand(source, { kind: 'resize-clip', clipId: source.clips[0]!.id, edge: 'end', timeMs: 201 }, () => 'unused');
  assert.deepEqual(oneMs.clips[0]!.entrance, { ...none, extension: { in: true } });
  assert.deepEqual(oneMs.clips[0]!.exit, { ...exit, durationMs: 1 });
  assert.deepEqual(source.clips[0]!.entrance, entrance);
});

test('automatic conversion and stale inspector timing edits preserve fitted bars presets and extensions', () => {
  const entrance = { ...timed('slide', 800), extension: { in: 'keep' } };
  const exit = { ...timed('fade-slide', 800), extension: { out: 'keep' } };
  const base = sequence();
  const clip: BarsClip = { ...base.clips[0] as BarsClip, duration: { kind: 'sequence-end' }, entrance, exit };
  const source = validateSequence({ ...base, clips: [clip], end: { kind: 'fixed', durationMs: 1_400 } });
  const converted = enableAutomaticEnd(source);
  assert.deepEqual(converted.clips[0]!.entrance, { ...entrance, durationMs: 600 });
  assert.deepEqual(converted.clips[0]!.exit, { ...exit, durationMs: 600 });
  const edited = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: { ...clip, startMs: 300 } }, () => 'unused');
  assert.deepEqual(edited.clips[0]!.entrance, { ...entrance, durationMs: 600 });
  assert.deepEqual(edited.clips[0]!.exit, { ...exit, durationMs: 600 });
});
