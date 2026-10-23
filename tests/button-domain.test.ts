import test from 'node:test';
import assert from 'node:assert/strict';
import type { ButtonClip, SequenceV1, ImageClip } from '../src/domain/sequence.js';
import { BUTTON_SHAPES, BUTTON_TEXTURES, buttonContainsPoint, defaultButtonProperties, withButtonProgression } from '../src/domain/button.js';
import { createBarsSequence, duplicateSequence, validateSequence } from '../src/domain/validation.js';
import { getPlaybackSchemaVersion, getSequenceProgressionMode, withSequenceAudience, withSequenceAutomation } from '../src/domain/sequence-audience.js';
import { applyTimelineCommand } from '../src/application/timeline-commands.js';
import { applyAnimationTemplate, createAnimationTemplate, createElementTemplate, instantiateElementTemplate } from '../src/domain/element-template.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';
import { TimelineClipboard } from '../src/application/timeline-clipboard.js';

function ids() { let n = 0; return () => `generated_${++n}`; }
function legacy(version: SequenceV1['schemaVersion'] = 3): SequenceV1 {
  const sequence = createBarsSequence('buttons', ids(), version);
  return { ...sequence, clips: [], end: { kind: 'manual', durationMs: 5000 } };
}
function button(): ButtonClip {
  return { type: 'button', typeVersion: 1, id: 'button', trackId: 'generated_2', startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5000 }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { ...defaultButtonProperties(), action: { kind: 'choice', decisionId: 'decision', optionId: 'option', message: 'I choose this.', visibility: 'public' } } };
}
function sequence(clip = button()): SequenceV1 { return { ...withButtonProgression(legacy()), clips: [clip] }; }

test('historical reads retain their schema and shared progression; adoption is explicit and retains extensions', () => {
  for (const version of [1, 2, 3, 4] as const) {
    const old = legacy(version);
    assert.deepEqual(validateSequence(old), old);
    assert.equal(getSequenceProgressionMode(old), 'shared');
    const adopted = withButtonProgression(old);
    assert.equal(adopted.schemaVersion, 5);
    assert.equal(getPlaybackSchemaVersion(adopted), 3);
    assert.equal(getSequenceProgressionMode(adopted), 'per-recipient');
  }
  const old = withSequenceAutomation(legacy(4), { version: 1, enabled: true, rules: [{ id: 'rule', enabled: true, event: 'combat-start', actorId: null }] });
  const extended = { ...old, custom: { retain: true }, launch: { ...old.launch!, marker: 'launch' } };
  const adopted = withButtonProgression(extended);
  assert.deepEqual(adopted.launch, extended.launch);
  assert.deepEqual((adopted as unknown as typeof extended).custom, extended.custom);
  const edited = withSequenceAutomation(withSequenceAudience(adopted, { mode: 'selected', userIds: ['player'], includeGM: false }), { version: 1, enabled: false, rules: [] });
  assert.equal(edited.schemaVersion, 5);
  assert.deepEqual(edited.progression, adopted.progression);
});

test('button schema rejects missing capabilities, scripts, bad IDs, shapes and unsafe texture sources', () => {
  assert.deepEqual(validateSequence(sequence()), sequence());
  const valid = sequence();
  const bad: unknown[] = [
    { ...legacy(), clips: [button()] }, { ...valid, playbackSchemaVersion: 2 }, { ...valid, progression: { version: 2, mode: 'per-recipient' } },
    ...[
      { shape: 'freeform' }, { box: { x: 0, y: 0, width: 0, height: 50 } }, { fontSize: -1 },
      { action: { kind: 'script', script: 'alert(1)' } }, { action: { kind: 'choice', decisionId: '', optionId: 'ok', message: '', visibility: 'public' } },
      { texture: { kind: 'builtin', id: 'unknown' } }, { texture: { kind: 'foundry-file', path: 'javascript:alert(1)', fit: 'cover' } },
      { texture: { kind: 'foundry-file', path: '../private.png', fit: 'contain' } }, { color: 'red' },
    ].map(properties => sequence({ ...button(), properties: { ...button().properties, ...properties } } as ButtonClip)),
  ];
  for (const value of bad) assert.throws(() => validateSequence(value));
  for (const texture of BUTTON_TEXTURES) validateSequence(sequence({ ...button(), properties: { ...button().properties, texture: { kind: 'builtin', id: texture.id } } }));
});

test('adding and duplicating buttons adopts personal progression and preserves independent choice option identity', () => {
  const makeId = ids();
  const added = applyTimelineCommand(legacy(1), { kind: 'add-clip', type: 'button', trackId: 'generated_2', startMs: 0 }, makeId);
  assert.equal(added.schemaVersion, 5);
  assert.equal(added.clips[0]?.type, 'button');
  const copied = applyTimelineCommand(sequence(), { kind: 'duplicate-clip', clipId: 'button' }, makeId);
  const options = copied.clips.filter(clip => clip.type === 'button').map(clip => clip.properties.action);
  assert.equal(options.length, 2);
  assert.ok(options.every(action => action.kind === 'choice' && action.decisionId === 'decision'));
  assert.equal(new Set(options.map(action => action.kind === 'choice' && action.optionId)).size, 2);
});

test('whole sequence copies remap decision groups together and disable automation', () => {
  const other = { ...button(), id: 'other', startMs: 5000, properties: { ...button().properties, action: { kind: 'choice' as const, decisionId: 'decision', optionId: 'other_option', message: '', visibility: 'gm' as const } } };
  const source = withSequenceAutomation({ ...sequence(), clips: [button(), other] }, { version: 1, enabled: true, rules: [] });
  const copy = duplicateSequence(source, 'copy', ids());
  const actions = copy.clips.filter(clip => clip.type === 'button').map(clip => clip.properties.action);
  assert.ok(actions.every(action => action.kind === 'choice' && action.decisionId !== 'decision'));
  assert.equal(new Set(actions.map(action => action.kind === 'choice' && action.decisionId)).size, 1);
  assert.equal(new Set(actions.map(action => action.kind === 'choice' && action.optionId)).size, 2);
  assert.equal(copy.launch?.version === 2 && copy.launch.automation.enabled, false);
});

test('button animation envelopes equal images, including held end and transition compatibility', () => {
  const clip = { ...button(), entrance: { preset: 'fade-slide' as const, version: 1 as const, durationMs: 1000, easing: 'linear' as const, distance: 200, direction: 'left' as const }, exit: { preset: 'fade-zoom' as const, version: 1 as const, durationMs: 1000, easing: 'linear' as const, scale: 0.5 } };
  const image: ImageClip = { ...clip, type: 'image', properties: { source: { kind: 'foundry-file', path: 'image.png' }, box: clip.properties.box, fit: 'cover', crop: { x: 0, y: 0, width: 1, height: 1 }, mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } };
  const plan = compileSequence(sequence(clip));
  const otherPlan = compileSequence({ ...sequence(), clips: [image] });
  for (const at of [0, 500, 1000, 3000, 4500, 5000]) {
    const actual = evaluate(plan, at)[0]!, expected = evaluate(otherPlan, at)[0]!;
    assert.equal(actual.opacity, expected.opacity); assert.deepEqual(actual.textTransform, expected.textTransform);
    assert.equal(actual.mediaTimeMs, undefined);
  }
  const template = createAnimationTemplate('slide', 'slide', clip.entrance, { width: 1920, height: 1080 }, 'image');
  const animated = applyAnimationTemplate(template, button(), 'entrance', { width: 960, height: 540 });
  assert.equal(animated.entrance.preset !== 'none' && animated.entrance.distance, 100);
});

test('button templates and clipboard scale geometry, typography and effects and generate fresh option IDs', () => {
  const clip = { ...button(), properties: { ...button().properties, outline: { enabled: true, color: '#000000', opacity: 1, width: 4 } } };
  const template = createElementTemplate('template', 'template', clip, { width: 1920, height: 1080 });
  const instance = instantiateElementTemplate(template, { trackId: clip.trackId, startMs: 0, composition: { width: 960, height: 540 } }, ids());
  assert.equal(instance.type, 'button');
  if (instance.type !== 'button') return;
  assert.equal(instance.properties.fontSize, 16); assert.equal(instance.properties.box.width, 180); assert.equal(instance.properties.outline?.width, 2);
  assert.equal(instance.properties.action.kind === 'choice' && instance.properties.action.decisionId, 'decision');
  assert.notEqual(instance.properties.action.kind === 'choice' && instance.properties.action.optionId, 'option');
  const clipboard = new TimelineClipboard(); clipboard.copy(sequence(clip), { kind: 'clip', id: clip.id });
  const pasted = clipboard.paste(legacy(3), { positionMs: 0 }, ids()).sequence;
  assert.equal(pasted.schemaVersion, 5); assert.equal(pasted.clips[0]?.type, 'button');
});

test('button shape hit tests reject transparent corners and accept edges and centers', () => {
  for (const shape of BUTTON_SHAPES) {
    assert.equal(buttonContainsPoint(shape, 200, 100, 100, 50), true);
    assert.equal(buttonContainsPoint(shape, 200, 100, -1, 50), false);
    assert.equal(buttonContainsPoint(shape, 200, 100, Number.NaN, 50), false);
    assert.equal(buttonContainsPoint(shape, 200, 100, 0, 0), shape === 'rectangle');
    assert.equal(buttonContainsPoint(shape, 200, 100, 100, 0), true);
  }
});
