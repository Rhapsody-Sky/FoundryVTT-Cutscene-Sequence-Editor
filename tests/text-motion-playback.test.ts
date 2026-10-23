import test from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_MOTION_PRESETS } from '../src/domain/text-motion.js';
import { type SequenceV1, type TextClip, type Transition } from '../src/domain/sequence.js';
import { createBreaksSequence, validateSequence } from '../src/domain/validation.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';
import { applyAnimationTemplate, createAnimationTemplate, createElementTemplate, instantiateElementTemplate } from '../src/domain/element-template.js';

const none = { preset: 'none', version: 1 } as const;
const reveal: Transition = { preset: 'text-motion', version: 1, motion: 'character-fade-up', durationMs: 1000, easing: 'linear', amount: 1.2, stagger: 0.4 };
const exit: Transition = { preset: 'text-motion', version: 1, motion: 'scatter-out', durationMs: 1000, easing: 'ease-in' };
function sequence(): SequenceV1 {
  let n = 0;
  const base = createBreaksSequence('Motion test', () => `motion-${++n}`);
  const clip: TextClip = { ...base.clips[0]!, type: 'text', typeVersion: 1, startMs: 500,
    entrance: reveal, exit, duration: { kind: 'fixed', milliseconds: 4000 },
    properties: { text: 'Ä 👩‍👩‍👧‍👦 hello\nWorld', fontFamily: 'sans-serif', fontSize: 96, minimumFontSize: 12,
      color: '#ffffff', align: 'center', box: { x: 100, y: 100, width: 1200, height: 400 }, shrinkToFit: true } };
  return validateSequence({ ...base, schemaVersion: 3, clips: [clip], end: { kind: 'manual', durationMs: 4500 }, breaks: [{ id: 'mid', positionMs: 1000 }] });
}

test('all 28 registered text motions validate on both phases without injecting defaults', () => {
  assert.equal(TEXT_MOTION_PRESETS.length, 28);
  for (const preset of TEXT_MOTION_PRESETS) {
    const source = sequence();
    const motion = { preset: 'text-motion', version: 1, durationMs: 500, easing: 'linear', motion: preset.id, future: { keep: true } };
    const candidate = { ...source, clips: [{ ...source.clips[0], entrance: none, exit: none, [preset.phase]: motion }] };
    const valid = validateSequence(JSON.parse(JSON.stringify(candidate)));
    assert.deepEqual(valid.clips[0]![preset.phase], motion);
    const opposite = preset.phase === 'entrance' ? 'exit' : 'entrance';
    const reversed = validateSequence({ ...source, clips: [{ ...source.clips[0], [opposite]: motion }] });
    assert.deepEqual(reversed.clips[0]![opposite], motion);
  }
});

test('motion validation rejects invalid parameters, unknown IDs and use on other element types', () => {
  const source = sequence();
  for (const patch of [{ motion: 'missing' }, { motion: null }, { amount: -1 }, { amount: 4.01 }, { amount: NaN }, { stagger: 0.91 }, { stagger: -0.1 }, { stagger: '0.2' }]) {
    assert.throws(() => validateSequence({ ...source, clips: [{ ...source.clips[0], entrance: { ...reveal, ...patch } }] }));
  }
  let n = 0;
  const bars = createBreaksSequence('Bars', () => `b-${++n}`);
  assert.throws(() => validateSequence({ ...bars, clips: [{ ...bars.clips[0], entrance: reveal }] }), /requires a title/);
});

test('phase clocks seek both ways and freeze on a Break independently of elapsed hold time', () => {
  const plan = compileSequence(sequence());
  const at = (position: number, elapsed = 0) => evaluate(plan, position, { holding: { elapsedMs: elapsed } })[0]!.textMotion!;
  assert.equal(evaluate(plan, 499).length, 0);
  assert.equal(at(500).entrance!.progress, 0);
  assert.equal(at(1000).entrance!.progress, 0.5);
  assert.deepEqual(at(1000, 30000), at(1000));
  assert.equal(at(2500).entrance!.progress, 1);
  assert.equal(at(3500).exit!.progress, 0);
  assert.equal(at(4000).exit!.progress, 0.5);
  assert.deepEqual(at(1000), at(1000, 50), 'backward seeks reproduce the original pose');
  assert.equal(at(4500).exit!.progress, 1);
  assert.ok(Object.isFrozen(at(1000).entrance));
});

test('sequence-end titles stay readable through the terminal hold and delegate ending to common fade', () => {
  const source = sequence();
  const plan = compileSequence(validateSequence({ ...source, clips: [{ ...source.clips[0], duration: { kind: 'sequence-end' } }] }));
  const item = evaluate(plan, 4500, { holding: { elapsedMs: 50000 } })[0]!;
  assert.equal(item.textMotion!.entrance!.progress, 1);
  assert.equal(item.textMotion!.exit, undefined);
  assert.equal(item.opacity, 1);
});

test('animation and element templates preserve segmented motion, adapt phase, enforce type and create independent copies', () => {
  const source = sequence(), clip = source.clips[0]!;
  for (const [phase, transition] of [['entrance', reveal], ['exit', exit]] as const) {
    const template = createAnimationTemplate('anim', 'Saved motion', transition, source.composition, 'text');
    const applied = applyAnimationTemplate(template, clip, phase, source.composition);
    assert.deepEqual(applied[phase], transition);
    assert.notEqual(applied[phase], transition);
    const opposite = phase === 'entrance' ? 'exit' : 'entrance';
    assert.deepEqual(applyAnimationTemplate(template, clip, opposite, source.composition)[opposite], transition);
    let n = 0;
    const bars = createBreaksSequence('Bars', () => `b-${++n}`).clips[0]!;
    assert.throws(() => applyAnimationTemplate(template, bars, phase, source.composition), /unsupported/);
  }
  const element = createElementTemplate('element', 'Saved title', clip, source.composition);
  const copy = instantiateElementTemplate(element, { composition: source.composition, trackId: clip.trackId, startMs: 0 }, () => 'copy');
  assert.deepEqual(copy.entrance, reveal);
  assert.deepEqual(copy.exit, exit);
});

test('direction and ordering validate, survive playback and template copies, and reject invalid controls', () => {
  const source = sequence(), clip = source.clips[0]! as TextClip;
  const directed = { ...reveal, motionDirection: 'left', motionOrder: 'reverse' } as const;
  const valid = validateSequence({ ...source, clips: [{ ...clip, entrance: directed }] });
  const frame = evaluate(compileSequence(valid), 1000)[0]!;
  assert.deepEqual(frame.textMotion!.entrance!.transition, directed);
  const template = createAnimationTemplate('directed', 'Directed', directed, source.composition, 'text');
  assert.deepEqual(applyAnimationTemplate(template, clip, 'exit', source.composition).exit, directed);
  const element = createElementTemplate('directed-title', 'Directed title', valid.clips[0]!, source.composition);
  assert.deepEqual(instantiateElementTemplate(element, { trackId: clip.trackId, startMs: 0, composition: source.composition }, () => 'new-title').entrance, directed);
  for (const patch of [{ motionDirection: 'diagonal' }, { motionDirection: true }, { motionOrder: 'wrong' }, { motionOrder: 1 }, { motion: 'noise-dissolve', motionDirection: 'left' }]) {
    assert.throws(() => validateSequence({ ...source, clips: [{ ...clip, exit: { ...exit, ...patch } }] }));
  }
});

test('exit animation templates cannot silently apply to sequence-end titles', () => {
  const source = sequence();
  const held: TextClip = { ...(source.clips[0]! as TextClip), duration: { kind: 'sequence-end' } };
  const template = createAnimationTemplate('out', 'Saved exit', exit, source.composition, 'text');
  assert.throws(() => applyAnimationTemplate(template, held, 'exit', source.composition), /fixed clip duration/);
  const entrance = createAnimationTemplate('in', 'Saved reveal', reveal, source.composition, 'text');
  assert.deepEqual(applyAnimationTemplate(entrance, held, 'entrance', source.composition).entrance, reveal);
});
