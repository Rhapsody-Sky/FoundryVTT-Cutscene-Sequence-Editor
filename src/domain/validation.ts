import { BUTTON_SHAPES, BUTTON_TEXTURES } from './button.js';
import { CLIP_BLEND_MODES, SEQUENCE_SCHEMA_VERSION, TRANSITION_EASINGS } from './sequence.js';
import type { AudioClip, SequenceClip, SequenceV1, Transition, VisualClip } from './sequence.js';
import {
  MAX_POLYGON_POINTS, animatedPatternPreset, getAnimatedPatternParameterDescriptors,
} from './animated-pattern.js';
import { audioDurationMs, mediaDurationMs, videoDurationMs } from './clip-timing.js';
import { getPlaybackSchemaVersion } from './sequence-audience.js';
import { transitionChangesTextPosition, transitionChangesTextScale, transitionDurationMs as transitionDuration } from './transitions.js';
import { textMotionControls, textMotionPreset } from './text-motion.js';

/** Resource and timing bounds for persisted user-authored sequences. */
export const SEQUENCE_LIMITS = Object.freeze({
  idLength: 128,
  nameLength: 200,
  tracks: 64,
  clips: 512,
  breaks: 128,
  audienceUsers: 100,
  automationRules: 32,
  triggerRuleIdLength: 128,
  triggerEventIdLength: 256,
  compositionDimension: 16_384,
  compositionArea: 67_108_864,
  timelineMs: 7 * 24 * 60 * 60 * 1_000,
  transitionMs: 10 * 60 * 1_000,
  textLength: 10_000
});

export class SequenceValidationError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = 'SequenceValidationError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

type JsonObject = Record<string, unknown>;

function fail(code: string, message: string, path?: string): never {
  throw new SequenceValidationError(code, message, path);
}

function isObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Extensions must remain ordinary JSON data so cloning never silently loses them. */
function assertJsonCompatible(value: unknown, path: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_JSON_VALUE', 'Stored values must use finite numbers.', path);
    return;
  }
  if (typeof value !== 'object') {
    fail('INVALID_JSON_VALUE', 'Stored values must be JSON-compatible data.', path);
  }
  if (ancestors.has(value)) fail('INVALID_JSON_VALUE', 'Stored values cannot contain circular references.', path);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
        fail('INVALID_JSON_VALUE', 'Stored arrays cannot contain extra properties.', path);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        fail('INVALID_JSON_VALUE', 'Stored array entries must be enumerable data fields.', `${path}[${key}]`);
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) fail('INVALID_JSON_VALUE', 'Stored arrays cannot contain holes.', `${path}[${index}]`);
      assertJsonCompatible(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    if (!isObject(value)) fail('INVALID_JSON_VALUE', 'Stored objects must be plain JSON objects.', path);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail('INVALID_JSON_VALUE', 'Stored object keys must be strings.', path);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        fail('INVALID_JSON_VALUE', 'Stored object fields must be enumerable data fields.', `${path}.${key}`);
      }
      assertJsonCompatible(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!isObject(value)) fail('INVALID_SHAPE', 'Expected an object.', path);
  return value;
}

function stringAt(value: unknown, path: string, maxLength: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    fail('INVALID_VALUE', `${label} must be a non-empty string of at most ${maxLength} characters.`, path);
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('INVALID_VALUE', 'Expected true or false.', path);
  return value;
}

function numberAt(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) {
    fail('INVALID_VALUE', `Expected a finite number between ${min} and ${max}${integer ? ' with no fraction' : ''}.`, path);
  }
  return value;
}

function idAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > SEQUENCE_LIMITS.idLength || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('INVALID_ID', `IDs must use letters, numbers, underscores, or hyphens and be at most ${SEQUENCE_LIMITS.idLength} characters.`, path);
  }
  return value;
}

function triggerRuleIdAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SEQUENCE_LIMITS.triggerRuleIdLength
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('INVALID_ID', `Trigger rule IDs must use letters, numbers, underscores, or hyphens and be at most ${SEQUENCE_LIMITS.triggerRuleIdLength} characters.`, path);
  }
  return value;
}

function expectLiteral(value: unknown, expected: string | number, path: string, message: string): void {
  if (value !== expected) fail('UNSUPPORTED_VERSION', message, path);
}

function validateTransition(value: unknown, path: string): Transition {
  const transition = objectAt(value, path);
  if (transition.preset === 'none') {
    expectLiteral(transition.version, 1, `${path}.version`, 'This transition version is not supported.');
    return value as Transition;
  }
  if (transition.preset === 'fade' || transition.preset === 'slide' || transition.preset === 'fade-slide'
    || transition.preset === 'zoom' || transition.preset === 'fade-zoom' || transition.preset === 'text-motion') {
    expectLiteral(transition.version, 1, `${path}.version`, 'This transition version is not supported.');
    numberAt(transition.durationMs, `${path}.durationMs`, 1, SEQUENCE_LIMITS.transitionMs, true);
    if (!TRANSITION_EASINGS.some(easing => easing === transition.easing)) {
      fail('INVALID_VALUE', 'This transition easing is not supported.', `${path}.easing`);
    }
    if (transition.preset === 'text-motion') {
      if (typeof transition.motion !== 'string' || !textMotionPreset(transition.motion)) {
        fail('UNSUPPORTED_TYPE', 'This text motion is not supported.', `${path}.motion`);
      }
      if (transition.amount !== undefined) numberAt(transition.amount, `${path}.amount`, 0, 4);
      if (transition.stagger !== undefined) numberAt(transition.stagger, `${path}.stagger`, 0, 0.9);
      if (transition.motionDirection !== undefined) {
        if (!['default', 'up', 'down', 'left', 'right'].includes(transition.motionDirection as string)) {
          fail('INVALID_VALUE', 'This text motion direction is not supported.', `${path}.motionDirection`);
        }
        if (transition.motionDirection !== 'default' && !textMotionControls(transition.motion as string).directions) {
          fail('INVALID_VALUE', 'This text motion has no directional geometry.', `${path}.motionDirection`);
        }
      }
      if (transition.motionOrder !== undefined && !['default', 'forward', 'reverse', 'center-out', 'edges-in', 'random'].includes(transition.motionOrder as string)) {
        fail('INVALID_VALUE', 'This text motion order is not supported.', `${path}.motionOrder`);
      }
    }
    return value as Transition;
  }
  fail('UNSUPPORTED_TYPE', 'This transition preset is not supported.', `${path}.preset`);
}

function validateAppearance(value: unknown, path: string): void {
  const appearance = objectAt(value, path);
  if (!CLIP_BLEND_MODES.some(mode => mode === appearance.blendMode)) {
    fail('UNSUPPORTED_TYPE', 'This clip blend mode is not supported.', `${path}.blendMode`);
  }
  numberAt(appearance.opacity, `${path}.opacity`, 0, 1);
}

function validateTextEffect(value: unknown, path: string, kind: 'outline' | 'shadow' | 'glow'): void {
  const effect = objectAt(value, path);
  booleanAt(effect.enabled, `${path}.enabled`);
  if (typeof effect.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(effect.color)) {
    fail('INVALID_VALUE', 'Effect colors must use #RRGGBB.', `${path}.color`);
  }
  numberAt(effect.opacity, `${path}.opacity`, 0, 1);
  if (kind === 'outline') numberAt(effect.width, `${path}.width`, 0, 32);
  if (kind === 'shadow') {
    numberAt(effect.offsetX, `${path}.offsetX`, -256, 256);
    numberAt(effect.offsetY, `${path}.offsetY`, -256, 256);
    numberAt(effect.blur, `${path}.blur`, 0, 128);
  }
  if (kind === 'glow') numberAt(effect.radius, `${path}.radius`, 0, 128);
}

function validateAnimatedPattern(value: unknown, path: string): void {
  const pattern = objectAt(value, path);
  if (pattern.version !== 1 && pattern.version !== 2) {
    fail('UNSUPPORTED_VERSION', 'This animated pattern version is not supported.', `${path}.version`);
  }
  if (typeof pattern.preset !== 'string' || !animatedPatternPreset(pattern.preset)) {
    fail('UNSUPPORTED_TYPE', 'This animated pattern preset is not supported.', `${path}.preset`);
  }
  if (pattern.version === 2 && getAnimatedPatternParameterDescriptors(pattern.preset).length === 0) {
    fail('UNSUPPORTED_VERSION', 'Version 2 is supported only for presets with custom numeric controls.', `${path}.preset`);
  }
  if (!Array.isArray(pattern.colors) || pattern.colors.length !== 3) {
    fail('INVALID_SHAPE', 'Animated patterns require exactly three colors.', `${path}.colors`);
  }
  pattern.colors.forEach((color, index) => {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
      fail('INVALID_VALUE', 'Pattern colors must use #RRGGBB.', `${path}.colors[${index}]`);
    }
  });
  numberAt(pattern.speed, `${path}.speed`, 0, 4);
  numberAt(pattern.scale, `${path}.scale`, 0.25, 4);
  numberAt(pattern.density, `${path}.density`, 0.2, 3);
  numberAt(pattern.direction, `${path}.direction`, 0, 360);
  numberAt(pattern.intensity, `${path}.intensity`, 0, 1);
  booleanAt(pattern.reverse, `${path}.reverse`);
  numberAt(pattern.seed, `${path}.seed`, 0, 0xffff_ffff, true);
  if (pattern.onBreak !== 'loop' && pattern.onBreak !== 'pause') {
    fail('INVALID_VALUE', 'Pattern break behavior must be loop or pause.', `${path}.onBreak`);
  }
  if (pattern.version === 2) {
    const parametersPath = `${path}.parameters`;
    const parameters = objectAt(pattern.parameters, parametersPath);
    for (const descriptor of getAnimatedPatternParameterDescriptors(pattern.preset)) {
      numberAt(parameters[descriptor.key], `${parametersPath}.${descriptor.key}`, descriptor.min, descriptor.max, descriptor.integer === true);
    }
  }
}

/** Geometry and effects shared by source images and color surfaces. */
function validateImageSurfaceProperties(
  properties: JsonObject,
  path: string,
  maskPointRange: { readonly min: number; readonly max: number } = { min: 4, max: 4 },
): void {
  if (properties.fit !== 'contain' && properties.fit !== 'cover') {
    fail('INVALID_VALUE', 'Image fit must be contain or cover.', `${path}.fit`);
  }
  const boxPath = `${path}.box`;
  const box = objectAt(properties.box, boxPath);
  numberAt(box.x, `${boxPath}.x`, -32_768, 32_768);
  numberAt(box.y, `${boxPath}.y`, -32_768, 32_768);
  numberAt(box.width, `${boxPath}.width`, 1, 32_768);
  numberAt(box.height, `${boxPath}.height`, 1, 32_768);
  const cropPath = `${path}.crop`;
  const crop = objectAt(properties.crop, cropPath);
  const x = numberAt(crop.x, `${cropPath}.x`, 0, 1);
  const y = numberAt(crop.y, `${cropPath}.y`, 0, 1);
  const width = numberAt(crop.width, `${cropPath}.width`, 0, 1);
  const height = numberAt(crop.height, `${cropPath}.height`, 0, 1);
  if (width === 0 || x + width > 1) fail('INVALID_VALUE', 'Image crop width must be positive and stay within the source.', `${cropPath}.width`);
  if (height === 0 || y + height > 1) fail('INVALID_VALUE', 'Image crop height must be positive and stay within the source.', `${cropPath}.height`);
  const maskPath = `${path}.mask`;
  if (!Array.isArray(properties.mask)
    || properties.mask.length < maskPointRange.min || properties.mask.length > maskPointRange.max) {
    if (maskPointRange.min === 4 && maskPointRange.max === 4) {
      fail('INVALID_SHAPE', 'Image mask must contain exactly four points.', maskPath);
    }
    fail('INVALID_SHAPE', `Polygon mask must contain between ${maskPointRange.min} and ${maskPointRange.max} points.`, maskPath);
  }
  properties.mask.forEach((point, index) => {
    const pointPath = `${maskPath}[${index}]`;
    const coordinates = objectAt(point, pointPath);
    numberAt(coordinates.x, `${pointPath}.x`, 0, 1);
    numberAt(coordinates.y, `${pointPath}.y`, 0, 1);
  });
  for (const kind of ['outline', 'shadow', 'glow'] as const) {
    if (properties[kind] !== undefined) validateTextEffect(properties[kind], `${path}.${kind}`, kind);
  }
}

function validateClip(value: unknown, path: string, schemaVersion: 1 | 2 | 3): SequenceClip {
  const clip = objectAt(value, path);
  idAt(clip.id, `${path}.id`);
  idAt(clip.trackId, `${path}.trackId`);
  if (clip.type === 'video') {
    if (clip.typeVersion !== 1 && clip.typeVersion !== 2 && clip.typeVersion !== 3 && clip.typeVersion !== 4 && clip.typeVersion !== 5 && clip.typeVersion !== 6 && clip.typeVersion !== 7) {
      fail('UNSUPPORTED_VERSION', 'This clip type version is not supported.', `${path}.typeVersion`);
    }
  } else if (clip.type === 'audio') {
    if (clip.typeVersion !== 1 && clip.typeVersion !== 2 && clip.typeVersion !== 3) {
      fail('UNSUPPORTED_VERSION', 'This clip type version is not supported.', `${path}.typeVersion`);
    }
  } else if (clip.type === 'solid') {
    if (clip.typeVersion !== 1 && clip.typeVersion !== 2) {
      fail('UNSUPPORTED_VERSION', 'This clip type version is not supported.', `${path}.typeVersion`);
    }
  } else expectLiteral(clip.typeVersion, 1, `${path}.typeVersion`, 'This clip type version is not supported.');
  numberAt(clip.startMs, `${path}.startMs`, 0, SEQUENCE_LIMITS.timelineMs, true);
  const entrance = validateTransition(clip.entrance, `${path}.entrance`);
  const exit = validateTransition(clip.exit, `${path}.exit`);
  for (const [name, transition] of [['entrance', entrance], ['exit', exit]] as const) {
    const transitionPath = `${path}.${name}`;
    if (transition.preset === 'text-motion') {
      if (clip.type !== 'text') fail('UNSUPPORTED_TYPE', 'Text motion requires a title.', `${transitionPath}.preset`);
    }
    if (((clip.type === 'audio' || (clip.type === 'video' && clip.typeVersion !== 7)) && transition.preset !== 'none' && transition.preset !== 'fade')
      || (clip.type === 'bars' && transitionChangesTextScale(transition))) {
      fail('UNSUPPORTED_TYPE', 'This transition preset is not supported for this clip type.', `${transitionPath}.preset`);
    }
    if ((clip.type === 'text' || clip.type === 'image' || clip.type === 'solid' || clip.type === 'button' || (clip.type === 'video' && clip.typeVersion === 7)) && transition.preset !== 'none') {
      if (transitionChangesTextPosition(transition)) {
        if (transition.direction !== undefined && !['left', 'right', 'up', 'down'].includes(transition.direction)) {
          fail('INVALID_VALUE', 'Slide direction must be left, right, up, or down.', `${transitionPath}.direction`);
        }
        if (transition.distance !== undefined) numberAt(transition.distance, `${transitionPath}.distance`, 0, 32_768);
      }
      if (transitionChangesTextScale(transition) && transition.scale !== undefined) {
        numberAt(transition.scale, `${transitionPath}.scale`, 0.05, 4);
      }
    }
  }
  if (schemaVersion === 1 && ((clip.type === 'audio' && clip.typeVersion === 3) || (clip.type === 'video' && (clip.typeVersion === 5 || ((clip.typeVersion === 6 || clip.typeVersion === 7) && (clip.properties as Record<string, unknown>)?.onBreak !== undefined))))) {
    fail('UNSUPPORTED_VERSION', 'Break media require sequence schema version 2.', `${path}.typeVersion`);
  }
  const properties = objectAt(clip.properties, `${path}.properties`);
  if ((clip.type === 'audio' && clip.typeVersion === 3) || (clip.type === 'video' && (clip.typeVersion === 5 || ((clip.typeVersion === 6 || clip.typeVersion === 7) && properties.onBreak !== undefined)))) {
    if (!['pause', 'loop', 'finish'].includes(properties.onBreak as string)) {
      fail('INVALID_VALUE', 'Break behavior must be pause, loop, or finish.', `${path}.properties.onBreak`);
    }
  } else if (properties.onBreak !== undefined) {
    fail('UNSUPPORTED_VERSION', 'Break behavior requires audio version 3 or video version 5.', `${path}.properties.onBreak`);
  }
  if (clip.appearance !== undefined) validateAppearance(clip.appearance, `${path}.appearance`);

  if (clip.type === 'audio') {
    if (clip.typeVersion === 1) validateMediaDuration(clip.duration, `${path}.duration`);
    else {
      const duration = objectAt(clip.duration, `${path}.duration`);
      if (clip.typeVersion === 3 && duration.kind === 'sequence-end') {
        if (duration.milliseconds !== undefined) fail('INVALID_VALUE', 'Indefinite audio has no authored duration.', `${path}.duration.milliseconds`);
        if (properties.loop !== true || properties.loopIndefinitely !== true) fail('INVALID_VALUE', 'Sequence-end audio requires indefinite looping.', `${path}.duration`);
      } else {
        if (duration.kind !== 'fixed') fail('INVALID_VALUE', 'Audio requires fixed duration or indefinite sequence-end duration.', `${path}.duration.kind`);
        numberAt(duration.milliseconds, `${path}.duration.milliseconds`, 1, SEQUENCE_LIMITS.timelineMs, true);
        if (clip.typeVersion === 3 && properties.loopIndefinitely === true) fail('INVALID_VALUE', 'Indefinite audio must use sequence-end duration.', `${path}.duration`);
      }
      validateTransitionOverlap(clip.duration, entrance, exit, path);
    }
    const source = objectAt(properties.source, `${path}.properties.source`);
    if (source.kind !== 'foundry-file') fail('UNSUPPORTED_TYPE', 'This audio source kind is not supported.', `${path}.properties.source.kind`);
    stringAt(source.path, `${path}.properties.source.path`, 2_048, 'Audio path');
    numberAt(properties.volume, `${path}.properties.volume`, 0, 1);
    booleanAt(properties.muted, `${path}.properties.muted`);
    if (properties.loop !== undefined) booleanAt(properties.loop, `${path}.properties.loop`);
    if (properties.loopIndefinitely !== undefined) {
      if (clip.typeVersion !== 2 && clip.typeVersion !== 3) fail('UNSUPPORTED_VERSION', 'Indefinite audio looping requires audio type version 2.', `${path}.typeVersion`);
      booleanAt(properties.loopIndefinitely, `${path}.properties.loopIndefinitely`);
      if (properties.loopIndefinitely === true && properties.loop !== true) {
        fail('INVALID_VALUE', 'Indefinite audio looping requires looping.', `${path}.properties.loopIndefinitely`);
      }
    }
    if (properties.sourceRange !== undefined) {
      if (properties.durationMs === undefined) fail('MEDIA_METADATA_REQUIRED', 'Source trimming requires inspected source duration.', `${path}.properties.durationMs`);
      const sourceDuration = numberAt(properties.durationMs, `${path}.properties.durationMs`, 1, SEQUENCE_LIMITS.timelineMs, true);
      const range = objectAt(properties.sourceRange, `${path}.properties.sourceRange`);
      const inMs = numberAt(range.inMs, `${path}.properties.sourceRange.inMs`, 0, sourceDuration, true);
      const outMs = numberAt(range.outMs, `${path}.properties.sourceRange.outMs`, 1, sourceDuration, true);
      if (inMs >= outMs) fail('INVALID_TIMING', 'Source range must end after it starts.', `${path}.properties.sourceRange`);
    }
    if (properties.durationMs !== undefined) {
      numberAt(properties.durationMs, `${path}.properties.durationMs`, 1, SEQUENCE_LIMITS.timelineMs, true);
      const audio = value as AudioClip;
      const duration = audioDurationMs(audio);
      if (clip.typeVersion !== 1 && duration !== undefined && properties.loop !== true && duration > mediaDurationMs(audio)!) {
        fail('INVALID_TIMING', 'Audio without looping cannot exceed the selected source interval.', `${path}.duration`);
      }
      if (duration !== undefined && ((clip.startMs as number) + duration > SEQUENCE_LIMITS.timelineMs || transitionDuration(entrance) + transitionDuration(exit) > duration)) {
        fail('INVALID_TIMING', 'Audio duration and transitions conflict.', path);
      }
    }
    return value as AudioClip;
  }

  if (clip.type === 'bars') {
    validateNonMediaDuration(clip.duration, `${path}.duration`);
    numberAt(properties.heightFraction, `${path}.properties.heightFraction`, 0, 0.5);
    stringAt(properties.color, `${path}.properties.color`, 100, 'Bar color');
    validateTransitionOverlap(clip.duration, entrance, exit, path);
    return value as VisualClip;
  }

  if (clip.type === 'text') {
    validateNonMediaDuration(clip.duration, `${path}.duration`);
    stringAt(properties.text, `${path}.properties.text`, SEQUENCE_LIMITS.textLength, 'Text');
    stringAt(properties.fontFamily, `${path}.properties.fontFamily`, 256, 'Font family');
    const fontSize = numberAt(properties.fontSize, `${path}.properties.fontSize`, 1, 512);
    numberAt(properties.minimumFontSize, `${path}.properties.minimumFontSize`, 1, fontSize);
    stringAt(properties.color, `${path}.properties.color`, 100, 'Text color');
    if (properties.align !== 'left' && properties.align !== 'center' && properties.align !== 'right') {
      fail('INVALID_VALUE', 'Text alignment must be left, center, or right.', `${path}.properties.align`);
    }
    const box = objectAt(properties.box, `${path}.properties.box`);
    numberAt(box.x, `${path}.properties.box.x`, -32_768, 32_768);
    numberAt(box.y, `${path}.properties.box.y`, -32_768, 32_768);
    numberAt(box.width, `${path}.properties.box.width`, 1, 32_768);
    numberAt(box.height, `${path}.properties.box.height`, 1, 32_768);
    booleanAt(properties.shrinkToFit, `${path}.properties.shrinkToFit`);
    for (const kind of ['outline', 'shadow', 'glow'] as const) {
      if (properties[kind] !== undefined) validateTextEffect(properties[kind], `${path}.properties.${kind}`, kind);
    }
    validateTransitionOverlap(clip.duration, entrance, exit, path);
    return value as VisualClip;
  }

  if (clip.type === 'button') {
    validateNonMediaDuration(clip.duration, `${path}.duration`);
    validateTransitionOverlap(clip.duration, entrance, exit, path);
    stringAt(properties.label, `${path}.properties.label`, 200, 'Button label');
    stringAt(properties.fontFamily, `${path}.properties.fontFamily`, 200, 'Font family');
    numberAt(properties.fontSize, `${path}.properties.fontSize`, 1, 512);
    for (const key of ['color', 'backgroundColor']) {
      if (typeof properties[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(properties[key] as string)) fail('INVALID_VALUE', 'Button colors must use #RRGGBB.', `${path}.properties.${key}`);
    }
    if (!BUTTON_SHAPES.some(shape => shape === properties.shape)) fail('UNSUPPORTED_TYPE', 'Unsupported button shape.', `${path}.properties.shape`);
    const box = objectAt(properties.box, `${path}.properties.box`);
    numberAt(box.x, `${path}.properties.box.x`, -32_768, 32_768);
    numberAt(box.y, `${path}.properties.box.y`, -32_768, 32_768);
    numberAt(box.width, `${path}.properties.box.width`, 1, 32_768);
    numberAt(box.height, `${path}.properties.box.height`, 1, 32_768);
    for (const kind of ['outline', 'shadow', 'glow'] as const) if (properties[kind] !== undefined) validateTextEffect(properties[kind], `${path}.properties.${kind}`, kind);
    if (properties.texture !== undefined) {
      const texture = objectAt(properties.texture, `${path}.properties.texture`);
      if (texture.kind === 'builtin') {
        if (!BUTTON_TEXTURES.some(item => item.id === texture.id)) fail('UNSUPPORTED_TYPE', 'Unsupported button texture.', `${path}.properties.texture.id`);
      } else if (texture.kind === 'foundry-file') {
        validateImagePath(texture.path, `${path}.properties.texture.path`);
        if (texture.fit !== 'contain' && texture.fit !== 'cover') fail('INVALID_VALUE', 'Texture fit must be contain or cover.', `${path}.properties.texture.fit`);
      } else fail('UNSUPPORTED_TYPE', 'Unsupported button texture source.', `${path}.properties.texture.kind`);
    }
    const action = objectAt(properties.action, `${path}.properties.action`);
    if (action.kind === 'choice') {
      idAt(action.decisionId, `${path}.properties.action.decisionId`);
      idAt(action.optionId, `${path}.properties.action.optionId`);
      if (typeof action.message !== 'string' || action.message.length > SEQUENCE_LIMITS.textLength) fail('INVALID_VALUE', 'Choice message must be a bounded string.', `${path}.properties.action.message`);
      if (action.visibility !== 'public' && action.visibility !== 'gm') fail('INVALID_VALUE', 'Choice visibility must be public or gm.', `${path}.properties.action.visibility`);
    } else if (action.kind !== 'continue') fail('UNSUPPORTED_TYPE', 'Unsupported button action.', `${path}.properties.action.kind`);
    return value as SequenceClip;
  }

  if (clip.type === 'solid') {
    validateNonMediaDuration(clip.duration, `${path}.duration`);
    if (typeof properties.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(properties.color)) {
      fail('INVALID_VALUE', 'Solid colors must use #RRGGBB.', `${path}.properties.color`);
    }
    if (properties.source !== undefined) {
      fail('UNSUPPORTED_TYPE', 'Solid surfaces use alphaMap for optional image masks.', `${path}.properties.source`);
    }
    if (clip.typeVersion === 1 && properties.pattern !== undefined) {
      fail('UNSUPPORTED_VERSION', 'Animated patterns require solid type version 2.', `${path}.properties.pattern`);
    }
    if (properties.pattern !== undefined) validateAnimatedPattern(properties.pattern, `${path}.properties.pattern`);
    if (properties.alphaMap !== undefined) {
      const alphaMapPath = `${path}.properties.alphaMap`;
      const alphaMap = objectAt(properties.alphaMap, alphaMapPath);
      if (alphaMap.kind !== 'foundry-file') {
        fail('UNSUPPORTED_TYPE', 'This alpha map source kind is not supported.', `${alphaMapPath}.kind`);
      }
      validateImagePath(alphaMap.path, `${alphaMapPath}.path`);
    }
    validateImageSurfaceProperties(properties, `${path}.properties`, clip.typeVersion === 1
      ? { min: 4, max: 4 }
      : { min: 3, max: MAX_POLYGON_POINTS });
    validateTransitionOverlap(clip.duration, entrance, exit, path);
    return value as VisualClip;
  }

  if (clip.type === 'image') {
    validateNonMediaDuration(clip.duration, `${path}.duration`);
    const sourcePath = `${path}.properties.source`;
    const source = objectAt(properties.source, sourcePath);
    if (source.kind !== 'foundry-file') fail('UNSUPPORTED_TYPE', 'This image source kind is not supported.', `${sourcePath}.kind`);
    validateImagePath(source.path, `${sourcePath}.path`);
    validateImageSurfaceProperties(properties, `${path}.properties`);
    validateTransitionOverlap(clip.duration, entrance, exit, path);
    return value as VisualClip;
  }

  if (clip.type === 'video') {
    validateMediaDuration(clip.duration, `${path}.duration`);
    const source = objectAt(properties.source, `${path}.properties.source`);
    if (source.kind !== 'foundry-file') fail('UNSUPPORTED_TYPE', 'This video source kind is not supported.', `${path}.properties.source.kind`);
    stringAt(source.path, `${path}.properties.source.path`, 2_048, 'Video path');
    if (properties.fit !== 'contain' && properties.fit !== 'cover') {
      fail('INVALID_VALUE', 'Video fit must be contain or cover.', `${path}.properties.fit`);
    }
    if (properties.box !== undefined) {
      if (clip.typeVersion !== 6 && clip.typeVersion !== 7) fail('UNSUPPORTED_VERSION', 'Video geometry requires video type version 6 or later.', `${path}.typeVersion`);
      const boxPath = `${path}.properties.box`;
      const box = objectAt(properties.box, boxPath);
      numberAt(box.x, `${boxPath}.x`, -32_768, 32_768);
      numberAt(box.y, `${boxPath}.y`, -32_768, 32_768);
      numberAt(box.width, `${boxPath}.width`, 1, 32_768);
      numberAt(box.height, `${boxPath}.height`, 1, 32_768);
    }
    numberAt(properties.volume, `${path}.properties.volume`, 0, 1);
    booleanAt(properties.muted, `${path}.properties.muted`);
    if (properties.keying !== undefined) {
      const keyingPath = `${path}.properties.keying`;
      const keying = objectAt(properties.keying, keyingPath);
      booleanAt(keying.enabled, `${keyingPath}.enabled`);
      if (typeof keying.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(keying.color)) {
        fail('INVALID_VALUE', 'Key colors must use #RRGGBB.', `${keyingPath}.color`);
      }
      numberAt(keying.tolerance, `${keyingPath}.tolerance`, 0, 1);
      numberAt(keying.softness, `${keyingPath}.softness`, 0, 1);
      if (keying.enabled === true && clip.typeVersion !== 4 && clip.typeVersion !== 5 && clip.typeVersion !== 6 && clip.typeVersion !== 7) {
        fail('UNSUPPORTED_VERSION', 'Active video keying requires video type version 4.', `${path}.typeVersion`);
      }
    }
    if (clip.typeVersion === 4 && (!isObject(properties.keying) || properties.keying.enabled !== true)) {
      fail('INVALID_VALUE', 'Video type version 4 requires active keying.', `${path}.properties.keying.enabled`);
    }
    if (properties.loop !== undefined) booleanAt(properties.loop, `${path}.properties.loop`);
    if (properties.loop === true && clip.typeVersion !== 3 && clip.typeVersion !== 4 && clip.typeVersion !== 5 && clip.typeVersion !== 6 && clip.typeVersion !== 7) {
      fail('UNSUPPORTED_VERSION', 'Video looping requires video type version 3 or 4.', `${path}.typeVersion`);
    }
    if (clip.typeVersion === 3 && properties.loop !== true) {
      fail('INVALID_VALUE', 'Video type version 3 requires looping.', `${path}.properties.loop`);
    }
    if (properties.sourceRange !== undefined) {
      if (clip.typeVersion !== 2 && clip.typeVersion !== 3 && clip.typeVersion !== 4 && clip.typeVersion !== 5 && clip.typeVersion !== 6 && clip.typeVersion !== 7) {
        fail('UNSUPPORTED_VERSION', 'Source trimming requires video type version 2, 3 or 4.', `${path}.typeVersion`);
      }
      if (properties.durationMs === undefined) fail('MEDIA_METADATA_REQUIRED', 'Source trimming requires inspected source duration.', `${path}.properties.durationMs`);
      const range = objectAt(properties.sourceRange, `${path}.properties.sourceRange`);
      const sourceDuration = numberAt(properties.durationMs, `${path}.properties.durationMs`, 1, SEQUENCE_LIMITS.timelineMs, true);
      const inMs = numberAt(range.inMs, `${path}.properties.sourceRange.inMs`, 0, sourceDuration, true);
      const outMs = numberAt(range.outMs, `${path}.properties.sourceRange.outMs`, 1, sourceDuration, true);
      if (inMs >= outMs) fail('INVALID_TIMING', 'Source range must end after it starts.', `${path}.properties.sourceRange`);
    } else if (clip.typeVersion === 2) {
      fail('INVALID_VALUE', 'Video type version 2 requires a source range.', `${path}.properties.sourceRange`);
    }
    if (properties.durationMs !== undefined) {
      numberAt(properties.durationMs, `${path}.properties.durationMs`, 1, SEQUENCE_LIMITS.timelineMs, true);
      const duration = videoDurationMs(value as VisualClip & { type: 'video' })!;
      if ((clip.startMs as number) + duration > SEQUENCE_LIMITS.timelineMs || transitionDuration(entrance) + transitionDuration(exit) > duration) {
        fail('INVALID_TIMING', 'Video duration and transitions conflict.', path);
      }
    }
    return value as VisualClip;
  }

  fail('UNSUPPORTED_TYPE', 'This clip type is not supported.', `${path}.type`);
}

/** Keep the Foundry media path policy in the domain without depending on a renderer. */
function validateImagePath(value: unknown, path: string): void {
  const source = stringAt(value, path, 2_048, 'Image path');
  let decoded: string;
  try { decoded = decodeURIComponent(source); } catch { fail('INVALID_VALUE', 'Image path must be a safe Foundry file path.', path); }
  if (source !== source.trim() || decoded !== decoded.trim() || /[\\\u0000-\u001f\u007f?#]/.test(decoded)
    || decoded.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(decoded)
    || decoded.split('/').some(part => part === '..' || part === '.')) {
    fail('INVALID_VALUE', 'Image path must be a safe Foundry file path.', path);
  }
}

function validateMediaDuration(value: unknown, path: string): void {
  const duration = objectAt(value, path);
  if (duration.kind !== 'media') fail('INVALID_VALUE', 'A media clip must use media duration.', `${path}.kind`);
}

function validateNonMediaDuration(value: unknown, path: string): void {
  const duration = objectAt(value, path);
  if (duration.kind === 'fixed') {
    numberAt(duration.milliseconds, `${path}.milliseconds`, 1, SEQUENCE_LIMITS.timelineMs, true);
    return;
  }
  if (duration.kind === 'sequence-end') return;
  if (duration.kind === 'media') fail('INVALID_VALUE', 'This clip type cannot use media duration.', `${path}.kind`);
  fail('UNSUPPORTED_TYPE', 'This duration kind is not supported.', `${path}.kind`);
}

function validateTransitionOverlap(duration: unknown, entrance: Transition, exit: Transition, path: string): void {
  const endDuration = objectAt(duration, `${path}.duration`);
  if (endDuration.kind !== 'fixed') return;
  if (transitionDuration(entrance) + transitionDuration(exit) > (endDuration.milliseconds as number)) {
    fail('INVALID_TIMING', 'Entrance and exit transitions cannot overlap within this fixed-duration clip.', path);
  }
}

function validateAutomation(value: unknown, path: string): void {
  const automation = objectAt(value, path);
  expectLiteral(automation.version, 1, `${path}.version`, 'This automation version is not supported.');
  booleanAt(automation.enabled, `${path}.enabled`);
  if (!Array.isArray(automation.rules) || automation.rules.length > SEQUENCE_LIMITS.automationRules) {
    fail('LIMIT_EXCEEDED', `Automation rules must be an array of at most ${SEQUENCE_LIMITS.automationRules} entries.`, `${path}.rules`);
  }
  const ids = new Set<string>();
  automation.rules.forEach((entry: unknown, index: number) => {
    const rulePath = `${path}.rules[${index}]`;
    const rule = objectAt(entry, rulePath);
    const id = triggerRuleIdAt(rule.id, `${rulePath}.id`);
    if (ids.has(id)) fail('DUPLICATE_ID', `Trigger rule ID "${id}" is used more than once.`, `${rulePath}.id`);
    ids.add(id);
    booleanAt(rule.enabled, `${rulePath}.enabled`);
    if (rule.event !== 'combat-start' && rule.event !== 'combat-end' && rule.event !== 'turn-start' && rule.event !== 'turn-end') {
      fail('UNSUPPORTED_TYPE', 'This trigger event is not supported.', `${rulePath}.event`);
    }
    if (rule.actorId !== null) idAt(rule.actorId, `${rulePath}.actorId`);
    if ((rule.event === 'combat-start' || rule.event === 'combat-end') && rule.actorId !== null) {
      fail('INVALID_VALUE', 'Combat lifecycle rules cannot filter by actor.', `${rulePath}.actorId`);
    }
  });
}

/** Validate a persisted sequence without dropping supported extension fields. */
export function validateSequence(value: unknown): SequenceV1 {
  assertJsonCompatible(value, 'sequence');
  const sequence = objectAt(value, 'sequence');
  if (sequence.schemaVersion !== 1 && sequence.schemaVersion !== 2 && sequence.schemaVersion !== 3 && sequence.schemaVersion !== 4 && sequence.schemaVersion !== SEQUENCE_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', `Schema version ${String(sequence.schemaVersion)} is not supported.`, 'sequence.schemaVersion');
  }
  if (sequence.schemaVersion === 4 || sequence.schemaVersion === 5) {
    if (sequence.playbackSchemaVersion !== 1 && sequence.playbackSchemaVersion !== 2 && sequence.playbackSchemaVersion !== 3) {
      fail('UNSUPPORTED_VERSION', 'Schema 4 requires a supported playback schema version.', 'sequence.playbackSchemaVersion');
    }
    const launch = objectAt(sequence.launch, 'sequence.launch');
    if (launch.version !== 1 && launch.version !== 2) {
      fail('UNSUPPORTED_VERSION', 'This launch settings version is not supported.', 'sequence.launch.version');
    }
    const audience = objectAt(launch.audience, 'sequence.launch.audience');
    if (audience.mode !== 'all' && audience.mode !== 'selected') {
      fail('INVALID_VALUE', 'Audience mode must be all or selected.', 'sequence.launch.audience.mode');
    }
    booleanAt(audience.includeGM, 'sequence.launch.audience.includeGM');
    if (!Array.isArray(audience.userIds) || audience.userIds.length > SEQUENCE_LIMITS.audienceUsers) {
      fail('LIMIT_EXCEEDED', 'Audience user IDs must be a bounded array.', 'sequence.launch.audience.userIds');
    }
    const userIds = new Set<string>();
    audience.userIds.forEach((value: unknown, index: number) => {
      const path = `sequence.launch.audience.userIds[${index}]`;
      const id = idAt(value, path);
      if (userIds.has(id)) fail('DUPLICATE_ID', 'Audience user IDs must be unique.', path);
      userIds.add(id);
    });
    if (launch.version === 1) {
      if ('automation' in launch) fail('UNSUPPORTED_VERSION', 'Automation requires launch settings version 2.', 'sequence.launch.automation');
    } else {
      validateAutomation(launch.automation, 'sequence.launch.automation');
    }
  } else if ('launch' in sequence || 'playbackSchemaVersion' in sequence) {
    fail('UNSUPPORTED_VERSION', 'Launch settings require sequence schema version 4.', 'sequence.launch');
  }
  if (sequence.schemaVersion === 5) {
    const progression = objectAt(sequence.progression, 'sequence.progression');
    expectLiteral(progression.version, 1, 'sequence.progression.version', 'Unsupported progression version.');
    expectLiteral(progression.mode, 'per-recipient', 'sequence.progression.mode', 'Unsupported progression mode.');
    if (sequence.playbackSchemaVersion !== 3) fail('UNSUPPORTED_VERSION', 'Personal progression requires playback schema 3.', 'sequence.playbackSchemaVersion');
  } else if ('progression' in sequence) fail('UNSUPPORTED_VERSION', 'Progression requires sequence schema 5.', 'sequence.progression');
  const playbackSchemaVersion = getPlaybackSchemaVersion(sequence as unknown as SequenceV1);
  idAt(sequence.id, 'sequence.id');
  if (!Number.isSafeInteger(sequence.revision) || (sequence.revision as number) < 0) {
    fail('INVALID_VALUE', 'Revision must be a non-negative safe integer.', 'sequence.revision');
  }
  stringAt(sequence.name, 'sequence.name', SEQUENCE_LIMITS.nameLength, 'Sequence name');

  const composition = objectAt(sequence.composition, 'sequence.composition');
  const width = numberAt(composition.width, 'sequence.composition.width', 1, SEQUENCE_LIMITS.compositionDimension, true);
  const height = numberAt(composition.height, 'sequence.composition.height', 1, SEQUENCE_LIMITS.compositionDimension, true);
  if (width * height > SEQUENCE_LIMITS.compositionArea) {
    fail('LIMIT_EXCEEDED', `Composition area cannot exceed ${SEQUENCE_LIMITS.compositionArea} logical pixels.`, 'sequence.composition');
  }

  const presentation = objectAt(sequence.presentation, 'sequence.presentation');
  if (presentation.surface !== 'window' && presentation.surface !== 'canvas') {
    fail('INVALID_VALUE', 'Surface value is not supported.', 'sequence.presentation.surface');
  }
  booleanAt(presentation.blockInput, 'sequence.presentation.blockInput');
  numberAt(presentation.exitDurationMs, 'sequence.presentation.exitDurationMs', 0, SEQUENCE_LIMITS.transitionMs, true);

  if (!Array.isArray(sequence.tracks) || sequence.tracks.length < 1 || sequence.tracks.length > SEQUENCE_LIMITS.tracks) {
    fail('LIMIT_EXCEEDED', `A sequence must contain between 1 and ${SEQUENCE_LIMITS.tracks} tracks.`, 'sequence.tracks');
  }
  const trackIds = new Set<string>();
  const trackKinds = new Map<string, 'visual' | 'audio'>();
  const orders = new Set<number>();
  sequence.tracks.forEach((entry: unknown, index: number) => {
    const path = `sequence.tracks[${index}]`;
    const track = objectAt(entry, path);
    const id = idAt(track.id, `${path}.id`);
    if (trackIds.has(id)) fail('DUPLICATE_ID', `Track ID "${id}" is used more than once.`, `${path}.id`);
    trackIds.add(id);
    stringAt(track.name, `${path}.name`, 100, 'Track name');
    if (track.kind !== 'visual' && track.kind !== 'audio') fail('UNSUPPORTED_TYPE', 'This track kind is not supported.', `${path}.kind`);
    trackKinds.set(id, track.kind);
    const order = numberAt(track.order, `${path}.order`, 0, SEQUENCE_LIMITS.tracks - 1, true);
    if (orders.has(order)) fail('INVALID_ORDER', `Track order ${order} is used more than once.`, `${path}.order`);
    orders.add(order);
    booleanAt(track.enabled, `${path}.enabled`);
    booleanAt(track.locked, `${path}.locked`);
  });

  if (!Array.isArray(sequence.clips) || sequence.clips.length > SEQUENCE_LIMITS.clips) {
    fail('LIMIT_EXCEEDED', `A sequence cannot contain more than ${SEQUENCE_LIMITS.clips} clips.`, 'sequence.clips');
  }
  const clipIds = new Set<string>();
  const clips = sequence.clips.map((entry: unknown, index: number) => {
    const path = `sequence.clips[${index}]`;
    const clip = validateClip(entry, path, playbackSchemaVersion);
    if (clip.type === 'button' && sequence.schemaVersion !== 5) fail('UNSUPPORTED_VERSION', 'Buttons require sequence schema 5 and personal progression.', `${path}.type`);
    if (clipIds.has(clip.id)) fail('DUPLICATE_ID', `Clip ID "${clip.id}" is used more than once.`, `${path}.id`);
    clipIds.add(clip.id);
    if (!trackIds.has(clip.trackId)) fail('INVALID_REFERENCE', `Track "${clip.trackId}" does not exist.`, `${path}.trackId`);
    if (trackKinds.get(clip.trackId) !== (clip.type === 'audio' ? 'audio' : 'visual')) {
      fail('INCOMPATIBLE_TRACK', 'This clip type is incompatible with its track kind.', `${path}.trackId`);
    }
    const finiteEnd = clip.duration.kind === 'fixed' ? clip.startMs + clip.duration.milliseconds : clip.startMs;
    if (!Number.isSafeInteger(finiteEnd) || finiteEnd > SEQUENCE_LIMITS.timelineMs) {
      fail('INVALID_TIMING', `Clip timing cannot exceed ${SEQUENCE_LIMITS.timelineMs} milliseconds.`, path);
    }
    return clip;
  });

  if (sequence.breaks !== undefined) {
    if (!Array.isArray(sequence.breaks) || sequence.breaks.length > SEQUENCE_LIMITS.breaks) {
      fail('INVALID_SHAPE', 'Breaks must be a bounded array.', 'sequence.breaks');
    }
    if (playbackSchemaVersion !== 3) {
      fail('UNSUPPORTED_VERSION', 'Timeline Breaks require sequence schema version 3.', 'sequence.breaks');
    }
    const breakIds = new Set<string>();
    const breakPositions = new Set<number>();
    for (const [index, entry] of sequence.breaks.entries()) {
      const path = `sequence.breaks[${index}]`;
      const marker = objectAt(entry, path);
      const id = idAt(marker.id, `${path}.id`);
      const position = numberAt(marker.positionMs, `${path}.positionMs`, 0, SEQUENCE_LIMITS.timelineMs, true);
      if (breakIds.has(id)) fail('DUPLICATE_ID', 'Break IDs must be unique.', `${path}.id`);
      if (breakPositions.has(position)) fail('DUPLICATE_POSITION', 'Break positions must be unique.', `${path}.positionMs`);
      breakIds.add(id);
      breakPositions.add(position);
    }
  }

  const end = objectAt(sequence.end, 'sequence.end');
  if (end.kind === 'manual') {
    if (playbackSchemaVersion !== 1 && end.durationMs !== undefined) numberAt(end.durationMs, 'sequence.end.durationMs', 1, SEQUENCE_LIMITS.timelineMs, true);
  } else if (end.kind === 'fixed') {
    if (end.automatic !== undefined) booleanAt(end.automatic, 'sequence.end.automatic');
    const durationMs = numberAt(end.durationMs, 'sequence.end.durationMs', 1, SEQUENCE_LIMITS.timelineMs, true);
    for (const [index, clip] of clips.entries()) {
      const clipPath = `sequence.clips[${index}]`;
      if (clip.duration.kind === 'sequence-end' && clip.startMs >= durationMs) {
        fail('INVALID_TIMING', 'A sequence-end clip must start before the sequence ends.', `${clipPath}.startMs`);
      }
      if (clip.duration.kind === 'sequence-end' && clip.startMs + transitionDuration(clip.entrance) > durationMs) {
        fail('INVALID_TIMING', 'The entrance must finish before the sequence exit begins.', clipPath);
      }
      if (clip.duration.kind === 'fixed' && clip.startMs + clip.duration.milliseconds > durationMs) {
        fail('INVALID_TIMING', 'A fixed-duration clip cannot end after the sequence.', clipPath);
      }
    }
  } else if (end.kind === 'media') {
    const clipId = idAt(end.clipId, 'sequence.end.clipId');
    const target = clips.find(clip => clip.id === clipId);
    if (!target || (target.type !== 'video' && target.type !== 'audio') || target.duration.kind === 'sequence-end') {
      fail('INVALID_REFERENCE', 'The sequence media end must reference an existing media clip.', 'sequence.end.clipId');
    }
  } else {
    fail('UNSUPPORTED_TYPE', 'This sequence end kind is not supported.', 'sequence.end.kind');
  }

  // The validated value is a clone, so callers cannot mutate the persisted input through the result.
  return structuredClone(value) as SequenceV1;
}

export function createBarsSequence(name: string, idFactory: () => string, schemaVersion: SequenceV1['schemaVersion'] = 1): SequenceV1 {
  const id = idFactory();
  const trackId = idFactory();
  const clipId = idFactory();
  const sequence: SequenceV1 = {
    schemaVersion,
    ...(schemaVersion === 5 ? { progression: { version: 1 as const, mode: 'per-recipient' as const } } : {}),
    ...(schemaVersion === 4 || schemaVersion === 5 ? { playbackSchemaVersion: 3 as const,
      launch: { version: 1 as const, audience: { mode: 'all' as const, userIds: [], includeGM: true } } } : {}),
    id,
    revision: 0,
    name,
    composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: true, exitDurationMs: 800 },
    tracks: [{ id: trackId, name: 'Visual 1', kind: 'visual', order: 0, enabled: true, locked: false }],
    clips: [{
      id: clipId, trackId, type: 'bars', typeVersion: 1, startMs: 0,
      duration: { kind: 'sequence-end' },
      entrance: { preset: 'fade', version: 1, durationMs: 800, easing: 'ease-in-out' },
      exit: { preset: 'none', version: 1 },
      properties: { heightFraction: 0.12, color: '#000000' }
    }],
    end: { kind: 'fixed', durationMs: 5_000 }
  };
  return validateSequence(sequence);
}

/** Newly authored drafts opt into the explicit Break semantics. */
export function createBreaksSequence(name: string, idFactory: () => string): SequenceV1 {
  return createBarsSequence(name, idFactory, 2);
}

export function duplicateSequence(sequence: SequenceV1, name: string, idFactory: () => string): SequenceV1 {
  const source = validateSequence(sequence);
  const ids = new Map<string, string>();
  ids.set(source.id, idFactory());
  for (const track of source.tracks) ids.set(track.id, idFactory());
  for (const clip of source.clips) ids.set(clip.id, idFactory());
  const decisions = new Map<string, string>();
  for (const clip of source.clips) if (clip.type === 'button' && clip.properties.action.kind === 'choice' && !decisions.has(clip.properties.action.decisionId)) decisions.set(clip.properties.action.decisionId, idFactory());
  const duplicated = {
    ...source,
    id: ids.get(source.id)!,
    revision: 0,
    name,
    tracks: source.tracks.map(track => ({ ...track, id: ids.get(track.id)! })),
    clips: source.clips.map(clip => ({ ...clip, id: ids.get(clip.id)!, trackId: ids.get(clip.trackId)!,
      ...(clip.type === 'button' && clip.properties.action.kind === 'choice' ? { properties: { ...clip.properties, action: { ...clip.properties.action, decisionId: decisions.get(clip.properties.action.decisionId)!, optionId: idFactory() } } } : {}) })),
    ...(source.breaks ? { breaks: source.breaks.map(marker => ({ ...marker, id: idFactory() })) } : {}),
    ...((source.schemaVersion === 4 || source.schemaVersion === 5) && source.launch!.version === 2
      ? { launch: { ...source.launch!, automation: { ...source.launch!.automation, enabled: false,
        rules: source.launch!.automation.rules.map(rule => ({ ...rule })) } } }
      : {}),
    end: source.end.kind === 'media' ? { ...source.end, clipId: ids.get(source.end.clipId)! } : { ...source.end }
  };
  return validateSequence(duplicated);
}

export function isSimpleBarsSequence(value: SequenceV1): boolean {
  const sequence = validateSequence(value);
  if (sequence.breaks?.length) return false;
  if (sequence.clips.length !== 1 || sequence.tracks.length !== 1) return false;
  const [track] = sequence.tracks;
  const [clip] = sequence.clips;
  return track !== undefined && clip !== undefined
    && track.enabled && !track.locked
    && clip.type === 'bars'
    && clip.trackId === track.id
    && clip.duration.kind === 'sequence-end';
}

/** The small editor may edit one clip per type, but never flatten a richer timeline. */
export function isSimpleSequence(value: SequenceV1): boolean {
  const sequence=validateSequence(value);
  if(sequence.breaks?.length) return false;
  if(sequence.clips.some(clip=>clip.type==='audio' || clip.type==='image' || clip.type==='solid' || clip.type==='button') || sequence.tracks.some(track=>track.kind==='audio')) return false;
  if(sequence.clips.length>3 || sequence.tracks.some(track=>track.locked || !track.enabled)) return false;
  const types=new Set<string>();
  const tracks=new Set<string>();
  for(const clip of sequence.clips) {
    if(types.has(clip.type) || tracks.has(clip.trackId)) return false;
    types.add(clip.type);tracks.add(clip.trackId);
    if(clip.type==='bars' && clip.duration.kind!=='sequence-end') return false;
  }
  // Empty tracks are preserved but must not mask a previously authored timeline.
  if(sequence.tracks.length>Math.max(1,sequence.clips.length)) return false;
  const expected={video:0,bars:1,text:2};
  const ordered=[...sequence.clips as readonly Exclude<VisualClip, { readonly type: 'image' | 'solid' | 'button' }>[]].sort((a,b)=>sequence.tracks.find(t=>t.id===a.trackId)!.order-sequence.tracks.find(t=>t.id===b.trackId)!.order);
  return ordered.every((clip,index)=>index===0 || expected[ordered[index-1]!.type]<expected[clip.type]);
}
