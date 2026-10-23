import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANIMATED_PATTERN_PARAMETER_DESCRIPTORS, ANIMATED_PATTERN_PRESETS, ANIMATED_PATTERN_PRESET_IDS, MAX_POLYGON_POINTS, POLYGON_PRESETS,
  animatedPatternPreset, createAnimatedPattern, getAnimatedPatternParameterDefaults, getAnimatedPatternParameterDescriptors,
  getAnimatedPatternSettings, selectAnimatedPatternPreset, updateAnimatedPatternParameter,
} from '../src/domain/animated-pattern.js';
import type { AnimatedPattern, AnimatedPatternV1 } from '../src/domain/animated-pattern.js';
import type { ImagePoint, SequenceV1, SolidClip, SolidClipV1, SolidClipV2, Transition } from '../src/domain/sequence.js';
import { createElementTemplate, validateTemplate } from '../src/domain/element-template.js';
import { SequenceValidationError, validateSequence } from '../src/domain/validation.js';

const none: Transition = { preset: 'none', version: 1 };
const rectangle = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
] as const;
const legacyPatterns = [
  ['diagonal-flow', ['#10182B', '#54D6FF', '#FFB84D']],
  ['speed-lines', ['#17121E', '#FF5E7E', '#FFD166']],
  ['radial-burst', ['#1B1033', '#B46CFF', '#FFDB70']],
  ['halftone', ['#20202A', '#FF7892', '#70E1CE']],
  ['floating-dots', ['#0D2026', '#4FE0C1', '#F6C85F']],
  ['starfield', ['#090E24', '#8EB7FF', '#FFE8A3']],
  ['neon-grid', ['#100C27', '#F15BFF', '#63F5D1']],
  ['hex-pulse', ['#10211D', '#65E572', '#C4FF76']],
  ['orbit-rings', ['#111B32', '#61C7FF', '#FF7F9C']],
  ['rotating-shards', ['#271323', '#FF5874', '#FFB45C']],
  ['chevron-stream', ['#161D2C', '#55B8FF', '#A8F07A']],
  ['diamond-drift', ['#20172B', '#C58CFF', '#73E6D2']],
  ['glitch-bands', ['#10151D', '#FF526F', '#46E7E1']],
  ['wave-ribbons', ['#0E2034', '#3EC7E8', '#FF8C69']],
  ['spark-trails', ['#1A1426', '#FFB84D', '#FF668A']],
  ['confetti', ['#171A2D', '#FF6B8A', '#5DE0C5']],
] as const;
const addedPatterns = [
  { id: 'circuit-traces', colors: ['#071B27', '#35E4D2', '#B6FF62'] },
  { id: 'contour-lines', colors: ['#14231F', '#91C7A1', '#E6D28B'] },
  { id: 'energy-trails', colors: ['#1A0E24', '#FF4FB4', '#6CE8FF'] },
] as const;
const packTwoPatterns = [
  { id: 'aurora', label: 'STAGECRAFT.AnimatedSurface.Pattern.Aurora', colors: ['#071A24', '#55EFC4', '#A879FF'] },
  { id: 'silk-flow', label: 'STAGECRAFT.AnimatedSurface.Pattern.SilkFlow', colors: ['#171328', '#A17DDE', '#F2D9FF'] },
  { id: 'iridescent-field', label: 'STAGECRAFT.AnimatedSurface.Pattern.IridescentField', colors: ['#101B32', '#59D8DD', '#F49BCD'] },
] as const;

function solidV1(properties: Partial<SolidClipV1['properties']> = {}): SolidClipV1 {
  return {
    id: 'surface', trackId: 'visual', type: 'solid', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: none, exit: none,
    properties: {
      color: '#ffffff', fit: 'cover', box: { x: 0, y: 0, width: 1280, height: 720 },
      crop: { x: 0, y: 0, width: 1, height: 1 }, mask: rectangle, ...properties,
    },
  };
}

function solidV2(mask: readonly ImagePoint[], pattern?: AnimatedPattern): SolidClipV2 {
  return {
    id: 'surface-v2', trackId: 'visual', type: 'solid', typeVersion: 2, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: none, exit: none,
    properties: {
      color: '#ffffff', fit: 'cover', box: { x: 0, y: 0, width: 1280, height: 720 },
      crop: { x: 0, y: 0, width: 1, height: 1 }, mask,
      ...(pattern === undefined ? {} : { pattern }),
    },
  };
}

function sequence(clip: SolidClip): SequenceV1 {
  return {
    schemaVersion: 3, id: 'animated-surface-sequence', revision: 0, name: 'Animated surface',
    composition: { width: 1280, height: 720 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 500 },
    tracks: [{ id: 'visual', name: 'Visual', kind: 'visual', order: 0, enabled: true, locked: false }],
    clips: [clip], end: { kind: 'fixed', durationMs: 5_000 },
  };
}

function rejected(value: unknown, path: string, code = 'INVALID_VALUE'): void {
  assert.throws(() => validateSequence(value), (error: unknown) =>
    error instanceof SequenceValidationError && error.code === code && error.path === path);
}

test('shared pattern and polygon catalogs provide stable IDs and bounded defaults', () => {
  assert.deepEqual(ANIMATED_PATTERN_PRESETS.map(preset => preset.id), ANIMATED_PATTERN_PRESET_IDS);
  assert.deepEqual(ANIMATED_PATTERN_PRESETS.map(preset => [preset.id, preset.colors]), [
    ...legacyPatterns, ...addedPatterns.map(preset => [preset.id, preset.colors]),
    ...packTwoPatterns.map(({ id, colors }) => [id, colors]),
  ]);
  assert.deepEqual(ANIMATED_PATTERN_PRESET_IDS.slice(0, legacyPatterns.length), legacyPatterns.map(([id]) => id));
  assert.deepEqual(ANIMATED_PATTERN_PRESET_IDS.slice(0, 19), [
    ...legacyPatterns.map(([id]) => id), ...addedPatterns.map(preset => preset.id),
  ]);
  assert.deepEqual(ANIMATED_PATTERN_PRESETS.slice(19).map(({ id, label, colors }) => ({ id, label, colors })), packTwoPatterns);
  assert.equal(ANIMATED_PATTERN_PRESETS.length, 22);
  assert.equal(new Set(ANIMATED_PATTERN_PRESETS.map(preset => preset.id)).size, 22);
  for (const preset of ANIMATED_PATTERN_PRESETS) {
    assert.ok(preset.label.endsWith(preset.id.split('-').map(part => part[0]!.toUpperCase() + part.slice(1)).join('')));
    assert.equal(preset.colors.length, 3);
    for (const color of preset.colors) assert.match(color, /^#[0-9a-f]{6}$/i);
    const pattern = createAnimatedPattern(preset.id);
    assert.equal(pattern.preset, preset.id);
    assert.deepEqual(pattern.colors, preset.colors);
    if (preset.id === 'halftone' || preset.id === 'energy-trails') {
      assert.equal(pattern.version, 2);
      assert.equal(pattern.intensity, 1);
      assert.deepEqual(pattern.parameters, getAnimatedPatternParameterDefaults(preset.id));
    } else {
      assert.equal(pattern.version, 1);
      assert.equal(pattern.intensity, 0.75);
    }
    assert.deepEqual(
      [pattern.speed, pattern.scale, pattern.density, pattern.direction, pattern.reverse, pattern.seed, pattern.onBreak],
      [1, 1, 1, 0, false, 0x5eed2026, 'loop'],
    );
  }
  assert.equal(createAnimatedPattern().preset, 'diagonal-flow');
  assert.equal(animatedPatternPreset('diagonal-flow')?.id, 'diagonal-flow');
  assert.equal(animatedPatternPreset(undefined), undefined);
  assert.equal(animatedPatternPreset('future-pattern'), undefined);
  assert.throws(() => createAnimatedPattern('future-pattern' as never), RangeError);

  assert.deepEqual(POLYGON_PRESETS.map(preset => preset.id), [
    'rectangle', 'slanted-panel', 'triangle', 'diamond', 'hexagon', 'star',
  ]);
  for (const preset of POLYGON_PRESETS) {
    assert.ok(preset.points.length >= 3 && preset.points.length <= MAX_POLYGON_POINTS);
    for (const point of preset.points) {
      assert.ok(point.x >= 0 && point.x <= 1);
      assert.ok(point.y >= 0 && point.y <= 1);
    }
    const validated = validateSequence(sequence(solidV2(preset.points))).clips[0] as SolidClipV2;
    assert.deepEqual(validated.properties.mask, preset.points);
  }
});

test('new animated pattern IDs round-trip through saved sequence validation without changing versioned data', () => {
  for (const preset of [...addedPatterns, ...packTwoPatterns]) {
    const pattern = {
      ...createAnimatedPattern(preset.id),
      colors: ['#112233', '#445566', '#778899'] as const,
      speed: 2.25,
      scale: 1.5,
      density: 2.5,
      direction: 275,
      intensity: 0.4,
      reverse: true,
      seed: 123_456,
      onBreak: 'pause' as const,
      extension: { retained: preset.id },
    };
    const authored = sequence(solidV2(rectangle, pattern));
    const stored = JSON.parse(JSON.stringify(authored)) as unknown;
    const restored = validateSequence(stored);
    assert.deepEqual(restored, authored, `${preset.id} keeps its authored pattern through validation`);
    const clip = restored.clips[0] as SolidClipV2;
    assert.equal(clip.typeVersion, 2);
    assert.equal(clip.properties.pattern?.version, preset.id === 'energy-trails' ? 2 : 1);
    assert.equal(clip.properties.pattern?.preset, preset.id);
  }
});

test('pattern v1 and v2 save/template round trips retain parameter bags and extensions', () => {
  const generatedLegacy = createAnimatedPattern('halftone');
  if (generatedLegacy.version !== 2) throw new Error('Expected the current Halftone creator to use version 2.');
  const { parameters: _parameters, ...legacyFields } = generatedLegacy;
  const legacy = { ...legacyFields, version: 1 as const, extension: { renderer: 'legacy', values: [1, true] } } as AnimatedPatternV1 & { extension: unknown };
  const current = {
    ...createAnimatedPattern('energy-trails'),
    parameters: { ...createAnimatedPattern('energy-trails').parameters, calibration: 0.625 },
    extension: { renderer: 'future', values: [2, false] },
  };
  for (const pattern of [legacy, current] as const) {
    const clip = solidV2(rectangle, pattern);
    const authored = sequence(clip);
    const saved = JSON.parse(JSON.stringify(authored)) as unknown;
    assert.deepEqual(validateSequence(saved), authored, `v${pattern.version} sequence data remains exact`);

    const template = createElementTemplate('animated-surface', `Pattern v${pattern.version}`, clip, { width: 1280, height: 720 });
    const storedTemplate = JSON.parse(JSON.stringify(template)) as unknown;
    assert.deepEqual(validateTemplate(storedTemplate), template, `v${pattern.version} template data remains exact`);
  }
});

test('custom parameter metadata is the source for defaults, settings, edits, and bounded validation', () => {
  const expected: Record<'halftone' | 'energy-trails', readonly (readonly [string, string, number, number, number, number, boolean?])[]> = {
    halftone: [
      ['density', 'STAGECRAFT.AnimatedSurface.Parameter.density', 56, 0, 100, 1],
      ['dotSize', 'STAGECRAFT.AnimatedSurface.Parameter.dotSize', 42, 18, 88, 1],
      ['falloff', 'STAGECRAFT.AnimatedSurface.Parameter.falloff', 58, 0, 100, 1],
      ['waveStrength', 'STAGECRAFT.AnimatedSurface.Parameter.waveStrength', 82, 0, 100, 1],
      ['waveSpeed', 'STAGECRAFT.AnimatedSurface.Parameter.waveSpeed', 0.55, 0, 2, 0.05],
      ['driftSpeed', 'STAGECRAFT.AnimatedSurface.Parameter.driftSpeed', 0.9, 0, 4, 0.1],
    ],
    'energy-trails': [
      ['strandCount', 'STAGECRAFT.AnimatedSurface.Parameter.strandCount', 6, 3, 10, 1, true],
      ['thickness', 'STAGECRAFT.AnimatedSurface.Parameter.thickness', 1, 0.35, 2, 0.05],
      ['curvature', 'STAGECRAFT.AnimatedSurface.Parameter.curvature', 1.05, 0, 1.8, 0.05],
      ['pulseLength', 'STAGECRAFT.AnimatedSurface.Parameter.pulseLength', 0.27, 0.08, 0.5, 0.01],
    ],
  };
  for (const preset of ['halftone', 'energy-trails'] as const) {
    const controls = getAnimatedPatternParameterDescriptors(preset);
    assert.deepEqual(controls, expected[preset].map(([key, label, defaultValue, min, max, step, integer]) => ({
      key, label, defaultValue, min, max, step, ...(integer ? { integer } : {}),
    })));
    assert.deepEqual(controls, ANIMATED_PATTERN_PARAMETER_DESCRIPTORS[preset]);
    const defaults = getAnimatedPatternParameterDefaults(preset);
    assert.deepEqual(defaults, Object.fromEntries(controls.map(control => [control.key, control.defaultValue])));
    const pattern = createAnimatedPattern(preset);
    assert.deepEqual(pattern.parameters, defaults);
    assert.deepEqual(getAnimatedPatternSettings(pattern), controls.map(control => ({
      ...control, value: defaults[control.key],
    })));
    for (const control of controls) {
      const clip = solidV2(rectangle, { ...pattern, parameters: { ...pattern.parameters, [control.key]: control.min } });
      assert.equal((validateSequence(sequence(clip)).clips[0] as SolidClipV2).properties.pattern?.version, 2);
      for (const invalid of [control.min - 0.001, control.max + 0.001]) {
        const bad = { ...pattern, parameters: { ...pattern.parameters, [control.key]: invalid } };
        rejected(sequence(solidV2(rectangle, bad)), `sequence.clips[0].properties.pattern.parameters.${control.key}`);
      }
      for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const bad = { ...pattern, parameters: { ...pattern.parameters, [control.key]: invalid } };
        rejected(sequence(solidV2(rectangle, bad)), `sequence.clips[0].properties.pattern.parameters.${control.key}`, 'INVALID_JSON_VALUE');
      }
      if (control.integer) {
        const fractional = { ...pattern, parameters: { ...pattern.parameters, [control.key]: control.defaultValue + 0.5 } };
        rejected(sequence(solidV2(rectangle, fractional)), `sequence.clips[0].properties.pattern.parameters.${control.key}`);
        assert.throws(() => updateAnimatedPatternParameter(pattern, control.key, control.defaultValue + 0.5), RangeError);
      }
      assert.throws(() => updateAnimatedPatternParameter(pattern, control.key, control.max + 1), RangeError);
      const updated = updateAnimatedPatternParameter(pattern, control.key, control.max);
      assert.equal(updated.version, 2);
      if (updated.version === 2) assert.equal(updated.parameters[control.key], control.max);
    }
  }
  assert.deepEqual(getAnimatedPatternParameterDescriptors('diagonal-flow'), []);
  assert.deepEqual(getAnimatedPatternParameterDescriptors('toString'), []);
  assert.deepEqual(getAnimatedPatternParameterDescriptors('constructor'), []);
  assert.deepEqual(getAnimatedPatternParameterDescriptors('__proto__'), []);
  assert.deepEqual(getAnimatedPatternSettings(createAnimatedPattern('diagonal-flow')), []);
  assert.deepEqual(getAnimatedPatternParameterDefaults('diagonal-flow'), {});
});

test('v1 pattern save data stays authored as v1 and preset selection performs deliberate v2 upgrades', () => {
  const legacy = {
    ...createAnimatedPattern('diagonal-flow'),
    preset: 'halftone' as const,
    colors: ['#123456', '#abcdef', '#fedcba'] as const,
    speed: 2.5,
    scale: 1.7,
    density: 2.2,
    direction: 91,
    intensity: 0.63,
    reverse: true,
    seed: 321,
    onBreak: 'pause' as const,
    extension: { retained: ['v1', 3] },
  } satisfies Omit<AnimatedPatternV1, 'version'> & { version: 1; extension: unknown };
  const saved = sequence(solidV2(rectangle, legacy));
  const json = JSON.stringify(saved);
  const restored = validateSequence(JSON.parse(json) as unknown);
  assert.equal(JSON.stringify(restored), json);
  const storedPattern = (restored.clips[0] as SolidClipV2).properties.pattern!;
  assert.equal(storedPattern.version, 1);
  assert.deepEqual(storedPattern, legacy);
  assert.deepEqual(getAnimatedPatternSettings(storedPattern), []);

  const upgraded = selectAnimatedPatternPreset(storedPattern, 'halftone');
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.preset, 'halftone');
  assert.deepEqual(upgraded.colors, legacy.colors);
  assert.deepEqual(
    [upgraded.speed, upgraded.scale, upgraded.density, upgraded.direction, upgraded.intensity, upgraded.reverse, upgraded.seed, upgraded.onBreak],
    [legacy.speed, legacy.scale, legacy.density, legacy.direction, legacy.intensity, legacy.reverse, legacy.seed, legacy.onBreak],
  );
  assert.deepEqual(upgraded.version === 2 ? upgraded.parameters : {}, getAnimatedPatternParameterDefaults('halftone'));
  assert.deepEqual((upgraded as typeof upgraded & { extension: unknown }).extension, legacy.extension);

  const changed = selectAnimatedPatternPreset(upgraded, 'energy-trails');
  assert.equal(changed.version, 2);
  assert.equal(changed.preset, 'energy-trails');
  assert.deepEqual(changed.version === 2 ? changed.parameters : {}, getAnimatedPatternParameterDefaults('energy-trails'));
  assert.equal(selectAnimatedPatternPreset(changed, 'energy-trails'), changed, 'same v2 selection preserves authored controls');

  const legacySelected = selectAnimatedPatternPreset(createAnimatedPattern('diagonal-flow'), 'energy-trails');
  assert.equal(legacySelected.version, 2);
  assert.deepEqual(legacySelected.version === 2 ? legacySelected.parameters : {}, getAnimatedPatternParameterDefaults('energy-trails'));
  const generic = selectAnimatedPatternPreset(changed, 'wave-ribbons');
  assert.equal(generic.version, 1);
  assert.equal(generic.preset, 'wave-ribbons');
  assert.equal('parameters' in generic, false);
});

test('solid v1 saved data remains byte-for-byte stable through validation', () => {
  const simpleClip = solidV1({
      box: { x: 1.25, y: 2.5, width: 100, height: 50, legacyBoxField: true } as SolidClipV1['properties']['box'],
      mask: rectangle.map((point, index) => ({ ...point, legacyPointField: index })) as unknown as SolidClipV1['properties']['mask'],
      alphaMap: { kind: 'foundry-file', path: 'worlds/demo/alpha.png', legacyMapField: 'keep' } as unknown as NonNullable<SolidClipV1['properties']['alphaMap']>,
    });
  const legacyClip = {
    ...simpleClip,
    legacyClipField: 7,
    properties: { ...simpleClip.properties, legacyPropertiesField: { enabled: true } },
  };
  const legacy = { ...sequence(legacyClip), legacySequenceField: { nested: ['preserved'] } };
  const storedJson = JSON.stringify(legacy);
  const validated = validateSequence(legacy);
  assert.equal(JSON.stringify(validated), storedJson);
  assert.deepEqual(validated, legacy);
  assert.equal(validated.clips[0]!.type, 'solid');
  assert.equal((validated.clips[0] as SolidClipV1).typeVersion, 1);
  assert.equal(Object.hasOwn((validated.clips[0] as SolidClipV1).properties, 'pattern'), false);
});

test('solid v2 accepts bounded polygons and optional patterns while preserving extensions', () => {
  const smallest = solidV2([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }]);
  assert.deepEqual(validateSequence(sequence(smallest)).clips[0], smallest);

  const maximumPolygon = Array.from({ length: MAX_POLYGON_POINTS }, (_, index) => {
    const angle = (Math.PI * 2 * index) / MAX_POLYGON_POINTS;
    return { x: 0.5 + 0.49 * Math.cos(angle), y: 0.5 + 0.49 * Math.sin(angle) };
  });
  assert.equal(validateSequence(sequence(solidV2(maximumPolygon))).clips[0]!.typeVersion, 2);

  const pattern = {
    ...createAnimatedPattern('wave-ribbons'),
    speed: 3.5,
    density: 2.4,
    onBreak: 'pause' as const,
    extension: { rendererHint: 'future-shader', weights: [1, 2, 3] },
  };
  const extended = {
    ...solidV2(maximumPolygon, pattern),
    futureClip: { retained: true },
    properties: {
      ...solidV2(maximumPolygon, pattern).properties,
      futureProperties: ['retained'],
      pattern: { ...pattern, futurePatternField: 12 },
    },
  };
  const before = JSON.stringify(extended);
  const validated = validateSequence(sequence(extended)).clips[0]! as SolidClipV2 & { futureClip: unknown };
  assert.equal(JSON.stringify(validated), before);
  assert.deepEqual(validated.properties.pattern, extended.properties.pattern);
  assert.deepEqual(validated.properties.mask, maximumPolygon);
  assert.deepEqual(validated.futureClip, { retained: true });
});

test('solid mask rules keep images and v1 rectangles exact while bounding v2 polygons', () => {
  const base = solidV1();
  rejected(sequence({ ...base, properties: { ...base.properties, mask: base.properties.mask.slice(0, 3) as unknown as SolidClipV1['properties']['mask'] } }),
    'sequence.clips[0].properties.mask', 'INVALID_SHAPE');

  const v1WithPattern = {
    ...base,
    properties: { ...base.properties, pattern: createAnimatedPattern() },
  };
  rejected(sequence(v1WithPattern as unknown as SolidClip), 'sequence.clips[0].properties.pattern', 'UNSUPPORTED_VERSION');
  rejected(sequence({ ...base, typeVersion: 3 } as unknown as SolidClip), 'sequence.clips[0].typeVersion', 'UNSUPPORTED_VERSION');

  const v2 = solidV2(rectangle);
  rejected(sequence(solidV2([{ x: 0, y: 0 }, { x: 1, y: 1 }])), 'sequence.clips[0].properties.mask', 'INVALID_SHAPE');
  rejected(sequence(solidV2(Array.from({ length: MAX_POLYGON_POINTS + 1 }, (_, i) => ({ x: i / MAX_POLYGON_POINTS, y: 0.5 })))),
    'sequence.clips[0].properties.mask', 'INVALID_SHAPE');
  rejected(sequence(solidV2([{ x: 0, y: 0 }, { x: 1.01, y: 0 }, { x: 0.5, y: 1 }])),
    'sequence.clips[0].properties.mask[1].x');
  assert.equal(validateSequence(sequence(v2)).clips[0]!.typeVersion, 2);
});

test('pattern validator rejects unsupported versions, presets, malformed colors, and out-of-range values', () => {
  const base = createAnimatedPattern();
  const invalidCases: Array<{ pattern: unknown; path: string; code?: string }> = [
    { pattern: { ...base, version: 3 }, path: 'version', code: 'UNSUPPORTED_VERSION' },
    { pattern: { ...base, preset: 'unknown-pattern' }, path: 'preset', code: 'UNSUPPORTED_TYPE' },
    { pattern: { ...base, version: 2, parameters: {} }, path: 'preset', code: 'UNSUPPORTED_VERSION' },
    { pattern: { ...base, colors: ['#000000', '#ffffff'] }, path: 'colors', code: 'INVALID_SHAPE' },
    { pattern: { ...base, colors: ['#000000', 'blue', '#ffffff'] }, path: 'colors[1]' },
    { pattern: { ...base, speed: -0.01 }, path: 'speed' },
    { pattern: { ...base, speed: 4.01 }, path: 'speed' },
    { pattern: { ...base, scale: 0.24 }, path: 'scale' },
    { pattern: { ...base, scale: 4.01 }, path: 'scale' },
    { pattern: { ...base, density: 0.19 }, path: 'density' },
    { pattern: { ...base, density: 3.01 }, path: 'density' },
    { pattern: { ...base, direction: -0.01 }, path: 'direction' },
    { pattern: { ...base, direction: 360.01 }, path: 'direction' },
    { pattern: { ...base, intensity: -0.01 }, path: 'intensity' },
    { pattern: { ...base, intensity: 1.01 }, path: 'intensity' },
    { pattern: { ...base, reverse: 'false' }, path: 'reverse' },
    { pattern: { ...base, seed: -1 }, path: 'seed' },
    { pattern: { ...base, seed: 4_294_967_296 }, path: 'seed' },
    { pattern: { ...base, seed: 1.5 }, path: 'seed' },
    { pattern: { ...base, onBreak: 'finish' }, path: 'onBreak' },
  ];
  for (const entry of invalidCases) {
    const clip = { ...solidV2(rectangle), properties: { ...solidV2(rectangle).properties, pattern: entry.pattern } };
    rejected(sequence(clip as unknown as SolidClip), `sequence.clips[0].properties.pattern.${entry.path}`, entry.code ?? 'INVALID_VALUE');
  }
});

test('pattern pack 2 presets round-trip through element templates with v2 polygons and extensions', () => {
  for (const preset of packTwoPatterns) {
    const pattern = {
      ...createAnimatedPattern(preset.id),
      extension: { framePolicy: 'deterministic' },
    };
    const clip = {
      ...solidV2([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.75, y: 0.9 }, { x: 0.25, y: 0.9 }], pattern),
      futureClip: 'kept',
    };
    const template = createElementTemplate('animated-surface', 'Animated surface', clip, { width: 1280, height: 720 });
    const validated = validateTemplate(template);
    assert.deepEqual(validated, template, `${preset.id} remains unchanged in the saved template`);
    if (validated.content.kind !== 'element') throw new Error('Expected an element template.');
    assert.equal(validated.content.clip.type, 'solid');
    if (validated.content.clip.type !== 'solid') throw new Error('Expected a solid surface.');
    assert.equal(validated.content.clip.typeVersion, 2);
    assert.deepEqual(validated.content.clip.properties.pattern, pattern);
    assert.deepEqual(validated.content.clip.properties.mask, clip.properties.mask);
    assert.equal((validated.content.clip as typeof validated.content.clip & { futureClip: string }).futureClip, 'kept');
  }
});
