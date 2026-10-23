import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageClip, SequenceV1, SolidClip, SolidClipV1, TextClip, Transition } from '../src/domain/sequence.js';
import { TRANSITION_EASINGS } from '../src/domain/sequence.js';
import { clipDurationMs } from '../src/domain/clip-timing.js';
import { applyTimelineCommand, TimelineCommandError } from '../src/application/timeline-commands.js';
import {
  applyAnimationTemplate, createAnimationTemplate, createElementTemplate, instantiateElementTemplate,
  scaleElementTemplateToComposition,
} from '../src/domain/element-template.js';
import { duplicateSequence, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';

const none: Transition = { preset: 'none', version: 1 };
const fade: Transition = { preset: 'fade', version: 1, durationMs: 800, easing: 'ease-in-out' };
const rectangularMask = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
] as const;

function ids(prefix = 'solid') {
  let index = 0;
  return () => `${prefix}_${++index}`;
}

function solid(properties: Partial<SolidClipV1['properties']> = {}): SolidClipV1 {
  return {
    id: 'surface', trackId: 'visual', type: 'solid', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: none, exit: none,
    properties: {
      color: '#ffffff', fit: 'cover', box: { x: 0, y: 0, width: 1280, height: 720 },
      crop: { x: 0, y: 0, width: 1, height: 1 }, mask: rectangularMask, ...properties,
    },
  };
}

function sequence(clip: SolidClip = solid(), end: SequenceV1['end'] = { kind: 'fixed', durationMs: 5_000 }): SequenceV1 {
  return {
    schemaVersion: 3, id: 'solid-sequence', revision: 0, name: 'Solid surfaces',
    composition: { width: 1280, height: 720 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 500 },
    tracks: [{ id: 'visual', name: 'Visual', kind: 'visual', order: 0, enabled: true, locked: false }],
    clips: [clip], end,
  };
}

function rejected(clip: unknown, path: string, code = 'INVALID_VALUE') {
  assert.throws(() => validateSequence({ ...sequence(), clips: [clip] }), error =>
    error instanceof SequenceValidationError && error.code === code
      && error.path === `sequence.clips[0]${path ? `.${path}` : ''}`);
}

test('add-clip creates a plain full-composition color surface without a file or image source', () => {
  const base = sequence();
  const empty = { ...base, clips: [] };
  const added = applyTimelineCommand(empty, { kind: 'add-clip', type: 'solid', trackId: 'visual', startMs: 0 }, ids());
  const clip = added.clips[0] as SolidClip;
  assert.equal(clip.type, 'solid');
  assert.equal(clip.typeVersion, 1);
  assert.deepEqual(clip.duration, { kind: 'fixed', milliseconds: 5_000 });
  assert.deepEqual(clip.properties, {
    color: '#ffffff', fit: 'cover', box: { x: 0, y: 0, width: 1280, height: 720 },
    crop: { x: 0, y: 0, width: 1, height: 1 }, mask: rectangularMask,
  });
  assert.equal(Object.hasOwn(clip.properties, 'alphaMap'), false);
  assert.equal(Object.hasOwn(clip.properties, 'source'), false);
  assert.deepEqual(empty.clips, []);
  assert.throws(() => applyTimelineCommand({ ...empty, tracks: [{ ...empty.tracks[0]!, kind: 'audio' }] },
    { kind: 'add-clip', type: 'solid', trackId: 'visual', startMs: 0 }, ids()),
  error => error instanceof TimelineCommandError && error.code === 'INCOMPATIBLE_TRACK');
});

test('solid validates color, optional alpha-map paths and kinds, geometry, crop, mask, and effects', () => {
  rejected(solid({ color: 'white' }), 'properties.color');
  rejected(solid({ color: '#fffff' }), 'properties.color');
  rejected(solid({ color: '#ffffff00' }), 'properties.color');
  rejected(solid({ alphaMap: { kind: 'remote', path: 'worlds/test/mask.png' } as unknown as NonNullable<SolidClipV1['properties']['alphaMap']> }),
    'properties.alphaMap.kind', 'UNSUPPORTED_TYPE');
  for (const path of ['', '../mask.png', 'https://example.com/mask.png', 'worlds/a.png?mode=1']) {
    rejected(solid({ alphaMap: { kind: 'foundry-file', path } }), 'properties.alphaMap.path');
  }
  rejected({ ...solid(), properties: { ...solid().properties, source: { kind: 'foundry-file', path: 'worlds/test/fake.png' } } },
    'properties.source', 'UNSUPPORTED_TYPE');
  rejected(solid({ fit: 'stretch' as SolidClip['properties']['fit'] }), 'properties.fit');
  rejected(solid({ box: { x: 0, y: 0, width: 0, height: 720 } }), 'properties.box.width');
  rejected(solid({ crop: { x: 0.5, y: 0, width: 0.6, height: 1 } }), 'properties.crop.width');
  rejected(solid({ crop: { x: 0, y: 0, width: 1, height: Number.NaN } }), 'properties.crop.height', 'INVALID_JSON_VALUE');
  rejected(solid({ mask: [{ x: 0, y: 0 }] as unknown as SolidClipV1['properties']['mask'] }), 'properties.mask', 'INVALID_SHAPE');
  rejected(solid({ mask: [{ x: 0, y: 0 }, { x: 1.01, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }), 'properties.mask[1].x');
  rejected(solid({ outline: { enabled: true, color: '#fff', opacity: 1, width: 1 } }), 'properties.outline.color');
  rejected(solid({ shadow: { enabled: true, color: '#000000', opacity: 1, offsetX: 0, offsetY: 0, blur: 129 } }), 'properties.shadow.blur');
  rejected(solid({ glow: { enabled: true, color: '#ffffff', opacity: 1, radius: 129 } }), 'properties.glow.radius');

  const withAlpha = solid({ alphaMap: { kind: 'foundry-file', path: 'modules/maps/alpha mask.png' } });
  assert.deepEqual(validateSequence(sequence(withAlpha)).clips[0], withAlpha);
});

test('fixed and sequence-end solid durations use the normal visual timing rules', () => {
  const fixed = validateSequence(sequence(solid({}))).clips[0]!;
  assert.equal(clipDurationMs(sequence(fixed as SolidClip), fixed), 5_000);
  const held = { ...solid(), startMs: 1_000, duration: { kind: 'sequence-end' as const }, entrance: fade, exit: fade };
  const heldSequence = sequence(held);
  assert.deepEqual(validateSequence(heldSequence).clips[0], held);
  assert.equal(clipDurationMs(heldSequence, held), 4_000);
  const plan = compileSequence(heldSequence);
  assert.equal(evaluate(plan, 5_000)[0]!.clip.type, 'solid');
  assert.equal(evaluate(plan, 5_000)[0]!.opacity, 1);
  rejected({ ...solid(), duration: { kind: 'media' } }, 'duration.kind');
  rejected({ ...solid(), duration: { kind: 'fixed', milliseconds: 1_000 }, entrance: fade, exit: fade }, '', 'INVALID_TIMING');
});

test('solid accepts every text/image motion preset and easing at both edges', () => {
  const presets = ['fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'] as const;
  for (const preset of presets) {
    for (const easing of TRANSITION_EASINGS) {
      const transition: Transition = {
        preset, version: 1, durationMs: 1_000, easing,
        ...(preset === 'slide' || preset === 'fade-slide' ? { direction: 'left' as const, distance: 120 } : {}),
        ...(preset === 'zoom' || preset === 'fade-zoom' ? { scale: 0.5 } : {}),
      };
      const clip = { ...solid(), entrance: transition, exit: transition };
      const plan = compileSequence(sequence(clip));
      for (const time of [500, 4_500]) {
        const frame = evaluate(plan, time)[0]!;
        assert.equal(frame.clip.type, 'solid');
        assert.ok(Number.isFinite(frame.opacity));
        if (preset === 'slide' || preset === 'fade-slide' || preset === 'zoom' || preset === 'fade-zoom') {
          assert.ok(frame.textTransform && Number.isFinite(frame.textTransform.x)
            && Number.isFinite(frame.textTransform.y) && Number.isFinite(frame.textTransform.scale));
        }
      }
    }
  }
});

test('element templates copy solid data exactly, scale geometry with finite precision, and retain extensions', () => {
  const extended = {
    ...solid({
      alphaMap: { kind: 'foundry-file', path: 'worlds/test/alpha.png', futureMap: 'kept' } as NonNullable<SolidClipV1['properties']['alphaMap']> & { futureMap: string },
      box: { x: 10.111, y: 20.223, width: 1_000, height: 500, futureBox: 'kept' } as SolidClipV1['properties']['box'] & { futureBox: string },
      crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6, futureCrop: 'kept' } as SolidClipV1['properties']['crop'] & { futureCrop: string },
      mask: rectangularMask.map((point, index) => ({ ...point, futurePoint: index })) as unknown as SolidClipV1['properties']['mask'],
      outline: { enabled: true, color: '#ff0000', opacity: 0.8, width: 3.333, futureOutline: true } as NonNullable<SolidClipV1['properties']['outline']> & { futureOutline: boolean },
      shadow: { enabled: true, color: '#000000', opacity: 0.7, offsetX: 8.888, offsetY: -4.444, blur: 9.999, futureShadow: true } as NonNullable<SolidClipV1['properties']['shadow']> & { futureShadow: boolean },
    }),
    extension: { keptAtClip: true },
    appearance: { blendMode: 'screen' as const, opacity: 0.8, futureAppearance: 'kept' },
    entrance: { preset: 'slide' as const, version: 1 as const, durationMs: 500, easing: 'linear' as const,
      direction: 'left' as const, distance: 109.891, futureEntrance: true },
    exit: { ...none, futureExit: true },
    duration: { kind: 'fixed' as const, milliseconds: 5_000, futureDuration: true },
  } as unknown as SolidClip;
  const template = createElementTemplate('solid-template', 'Color surface', extended, { width: 1_920, height: 1_080 });
  assert.equal(template.content.kind, 'element');
  if (template.content.kind !== 'element') throw new Error('Expected an element template.');
  const expectedTemplateClip = { ...extended } as Record<string, unknown>;
  delete expectedTemplateClip.id;
  delete expectedTemplateClip.trackId;
  delete expectedTemplateClip.startMs;
  assert.deepEqual(template.content.clip, expectedTemplateClip);

  const exact = instantiateElementTemplate(template, { trackId: 'visual', startMs: 750, composition: { width: 1_920, height: 1_080 } }, ids());
  assert.equal(exact.type, 'solid');
  assert.deepEqual({ ...exact, id: extended.id, trackId: extended.trackId, startMs: extended.startMs }, extended);

  const scaled = scaleElementTemplateToComposition(template, { width: 1_000, height: 1_000 });
  assert.equal(scaled.type, 'solid');
  if (scaled.type !== 'solid') throw new Error('Expected a solid template.');
  assert.deepEqual(scaled.properties.box, { x: 5.27, y: 229.28, width: 520.83, height: 260.42, futureBox: 'kept' });
  assert.equal(scaled.properties.outline?.width, 1.74);
  assert.equal(scaled.properties.shadow?.offsetX, 4.63);
  assert.equal(scaled.properties.shadow?.offsetY, -2.31);
  assert.equal(scaled.entrance.preset, 'slide');
  assert.equal((scaled.entrance as Exclude<Transition, { preset: 'none' }>).distance, 57.23);
  assert.deepEqual(scaled.properties.crop, extended.properties.crop);
  assert.deepEqual(scaled.properties.mask, extended.properties.mask);
  assert.deepEqual(scaled.properties.alphaMap, extended.properties.alphaMap);
  assert.deepEqual((scaled as typeof scaled & { extension: unknown }).extension, { keptAtClip: true });
  for (const value of [scaled.properties.box.x, scaled.properties.box.y, scaled.properties.box.width,
    scaled.properties.box.height, scaled.properties.outline!.width]) {
    assert.ok(Number.isFinite(value));
    assert.equal(Number(value.toFixed(2)), value);
  }
});

test('solid animation templates share slide applicability with text and images', () => {
  const slide: Transition = { preset: 'fade-slide', version: 1, durationMs: 500, easing: 'ease-out', direction: 'up', distance: 90 };
  for (const sourceType of ['text', 'image', 'solid'] as const) {
    const animation = createAnimationTemplate(`slide-${sourceType}`, 'Slide', slide, { width: 1_920, height: 1_080 }, sourceType);
    const applied = applyAnimationTemplate(animation, solid(), 'entrance', { width: 960, height: 540 });
    assert.equal(applied.type, 'solid');
    assert.equal(applied.entrance.preset, 'fade-slide');
    assert.equal((applied.entrance as Exclude<Transition, { preset: 'none' }>).distance, 45);
  }

  const text: TextClip = {
    id: 'text-target', trackId: 'visual', type: 'text', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: none, exit: none,
    properties: { text: 'Title', fontFamily: 'Arial', fontSize: 48, minimumFontSize: 12, color: '#ffffff',
      align: 'center', box: { x: 0, y: 0, width: 1_280, height: 720 }, shrinkToFit: true },
  };
  const image: ImageClip = {
    id: 'image-target', trackId: 'visual', type: 'image', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: none, exit: none,
    properties: { source: { kind: 'foundry-file', path: 'worlds/test/source.png' }, fit: 'cover',
      box: { x: 0, y: 0, width: 1_280, height: 720 }, crop: { x: 0, y: 0, width: 1, height: 1 }, mask: rectangularMask },
  };
  const solidAnimation = createAnimationTemplate('solid-slide', 'Solid slide', slide, { width: 1_920, height: 1_080 }, 'solid');
  assert.equal(applyAnimationTemplate(solidAnimation, text, 'exit', { width: 1_920, height: 1_080 }).exit.preset, 'fade-slide');
  assert.equal(applyAnimationTemplate(solidAnimation, image, 'exit', { width: 1_920, height: 1_080 }).exit.preset, 'fade-slide');
});

test('replace and duplicate operations preserve solid extensions at every authored level', () => {
  const base = solid({ alphaMap: { kind: 'foundry-file', path: 'worlds/test/alpha.png' } });
  const extended = {
    ...base, futureClip: 'clip',
    appearance: { blendMode: 'normal' as const, opacity: 1, futureAppearance: true },
    entrance: { ...none, futureEntrance: true }, exit: { ...none, futureExit: true },
    duration: { kind: 'fixed' as const, milliseconds: 5_000, futureDuration: true },
    properties: {
      ...base.properties, futureProperties: 'properties',
      alphaMap: { ...base.properties.alphaMap!, futureMap: true },
      box: { ...base.properties.box, futureBox: true }, crop: { ...base.properties.crop, futureCrop: true },
      mask: base.properties.mask.map((point, index) => ({ ...point, futurePoint: index })),
      outline: { enabled: true, color: '#ffffff', opacity: 1, width: 2, futureOutline: true },
      shadow: { enabled: true, color: '#000000', opacity: 1, offsetX: 1, offsetY: 2, blur: 3, futureShadow: true },
      glow: { enabled: true, color: '#ffffff', opacity: 1, radius: 4, futureGlow: true },
    },
  } as unknown as SolidClip;
  const source = sequence(extended, { kind: 'fixed', durationMs: 5_000, automatic: true });
  const replacement = {
    ...base, appearance: { blendMode: 'screen' as const, opacity: 0.6 },
    properties: { ...base.properties, box: { ...base.properties.box, x: 12 },
      outline: { enabled: false, color: '#ffffff', opacity: 1, width: 3 },
      shadow: { enabled: false, color: '#000000', opacity: 1, offsetX: 1, offsetY: 2, blur: 3 },
      glow: { enabled: false, color: '#ffffff', opacity: 1, radius: 4 } },
  };
  const changed = applyTimelineCommand(source, { kind: 'replace-clip', clip: replacement }, ids('replace'));
  const result = changed.clips[0] as SolidClip & Record<string, unknown>;
  assert.equal(result.futureClip, 'clip');
  assert.deepEqual(result.appearance, { ...extended.appearance, ...replacement.appearance });
  assert.deepEqual(result.entrance, extended.entrance);
  assert.deepEqual(result.exit, extended.exit);
  assert.deepEqual(result.duration, extended.duration);
  assert.deepEqual(result.properties.box, { ...extended.properties.box, x: 12 });
  assert.deepEqual(result.properties.alphaMap, extended.properties.alphaMap);
  assert.deepEqual(result.properties.crop, extended.properties.crop);
  assert.deepEqual(result.properties.mask, extended.properties.mask);
  assert.deepEqual(result.properties.outline, { ...extended.properties.outline, enabled: false, width: 3 });
  assert.deepEqual(result.properties.shadow, { ...extended.properties.shadow, enabled: false });
  assert.deepEqual(result.properties.glow, { ...extended.properties.glow, enabled: false });

  const copied = applyTimelineCommand(changed, { kind: 'duplicate-clip', clipId: 'surface' }, ids('copy'));
  assert.deepEqual(copied.clips[1]!.properties, result.properties);
  assert.notEqual(copied.clips[1]!.properties, result.properties);
  const sequenceCopy = duplicateSequence(changed, 'Solid copy', ids('sequence-copy'));
  assert.deepEqual(sequenceCopy.clips[0]!.properties, result.properties);
  assert.notEqual(sequenceCopy.clips[0]!.properties, result.properties);
});
