import { defaultButtonProperties, withButtonProgression } from './button.js';
import { BREAKS_PLAYBACK_SCHEMA_VERSION } from './sequence.js';
import type { SequenceClip, SequenceV1, SolidClip, Transition, VideoClip } from './sequence.js';
import { textMotionPreset } from './text-motion.js';
import { SEQUENCE_LIMITS, validateSequence } from './validation.js';
import { roundCompositionUnits } from './spatial-precision.js';
import { videoTypeVersion } from './clip-timing.js';

export const TEMPLATE_ENVELOPE_VERSION = 1 as const;

type OmitClipPlacement<T> = T extends SequenceClip ? Omit<T, 'id' | 'trackId' | 'startMs'> : never;
export type ElementTemplateClip = OmitClipPlacement<SequenceClip>;

export interface CompositionSize {
  readonly width: number;
  readonly height: number;
}

export interface ElementTemplateContent {
  readonly kind: 'element';
  readonly sourceComposition: CompositionSize;
  /** Clip properties, effects, media reference, timing and both transitions are copied verbatim. */
  readonly clip: ElementTemplateClip;
}

export interface AnimationTemplateContent {
  readonly kind: 'animation';
  /** The source element type is required because some presets have type-specific meaning. */
  readonly sourceType: SequenceClip['type'];
  readonly sourceComposition: CompositionSize;
    /** One transition. Segmented text motions adapt automatically to the target edge. */
  readonly transition: Transition;
}

export type TemplateContent = ElementTemplateContent | AnimationTemplateContent;

export interface TemplateEnvelopeV1 {
  readonly format: 'stagecraft-template';
  readonly schemaVersion: typeof TEMPLATE_ENVELOPE_VERSION;
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly content: TemplateContent;
}

export class TemplateValidationError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TemplateValidationError';
  }
}

type JsonObject = Record<string, unknown>;

function fail(code: string, message: string, path?: string): never {
  throw new TemplateValidationError(code, message, path);
}

function isObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonCompatible(value: unknown, path: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_JSON_VALUE', 'Template values must use finite numbers.', path);
    return;
  }
  if (typeof value !== 'object') fail('INVALID_JSON_VALUE', 'Template values must be JSON-compatible.', path);
  if (ancestors.has(value)) fail('INVALID_JSON_VALUE', 'Template values cannot contain circular references.', path);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) fail('INVALID_JSON_VALUE', 'Template arrays cannot contain holes.', `${path}[${index}]`);
      assertJsonCompatible(value[index], `${path}[${index}]`, ancestors);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
        fail('INVALID_JSON_VALUE', 'Template arrays cannot contain extra properties.', path);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        fail('INVALID_JSON_VALUE', 'Template array values must be ordinary data.', `${path}[${key}]`);
      }
    }
  } else {
    if (!isObject(value)) fail('INVALID_JSON_VALUE', 'Template objects must be plain JSON objects.', path);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail('INVALID_JSON_VALUE', 'Template keys must be strings.', path);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        fail('INVALID_JSON_VALUE', 'Template fields must be ordinary data.', `${path}.${key}`);
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

function idAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > SEQUENCE_LIMITS.idLength
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('INVALID_ID', 'Template IDs must use letters, numbers, underscores or hyphens.', path);
  }
  return value;
}

function nameAt(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 200) {
    fail('INVALID_NAME', 'Template names must contain 1 to 200 characters.', 'template.name');
  }
  return value;
}

function compositionAt(value: unknown, path: string): CompositionSize {
  const composition = objectAt(value, path);
  const width = composition.width;
  const height = composition.height;
  if (!Number.isSafeInteger(width) || (width as number) < 1 || (width as number) > SEQUENCE_LIMITS.compositionDimension
    || !Number.isSafeInteger(height) || (height as number) < 1 || (height as number) > SEQUENCE_LIMITS.compositionDimension
    || (width as number) * (height as number) > SEQUENCE_LIMITS.compositionArea) {
    fail('INVALID_COMPOSITION', 'Template composition dimensions are outside supported limits.', path);
  }
  // Keep supported extension fields while checking the dimensions this version uses.
  return structuredClone(value) as CompositionSize;
}

function validateWrappedSequence(value: unknown, path: string): SequenceV1 {
  try {
    return validateSequence(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'The element is invalid.';
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code : 'INVALID_ELEMENT';
    const errorPath = typeof error === 'object' && error !== null && 'path' in error
      && typeof (error as { path?: unknown }).path === 'string'
      ? (error as { path: string }).path : undefined;
    throw new TemplateValidationError(code, detail, errorPath ? `${path}.${errorPath}` : path, { cause: error });
  }
}

function syntheticSequence(clip: SequenceClip, composition: CompositionSize): SequenceV1 {
  const audio = clip.type === 'audio';
  const positionedClip = { ...clip, id: 'template_clip', trackId: 'template_track', startMs: 0 } as SequenceClip;
  const end = positionedClip.duration.kind === 'media'
    ? { kind: 'media' as const, clipId: 'template_clip' }
    : { kind: 'fixed' as const, durationMs: SEQUENCE_LIMITS.timelineMs };
  const sequence: SequenceV1 = {
    schemaVersion: BREAKS_PLAYBACK_SCHEMA_VERSION,
    id: 'template_sequence',
    revision: 0,
    name: 'Template validation',
    composition,
    presentation: { surface: 'window', blockInput: true, exitDurationMs: 0 },
    tracks: [{ id: 'template_track', name: audio ? 'Audio' : 'Visual', kind: audio ? 'audio' : 'visual', order: 0, enabled: true, locked: false }],
    clips: [],
    end,
  };
  // Adopt before adding the authored capability so legacy validation remains strict.
  return { ...(clip.type === 'button' ? withButtonProgression(sequence) : sequence), clips: [positionedClip] };
}

function clipForSchemaValidation(clip: SequenceClip): SequenceClip {
  if (clip.type !== 'video' && clip.type !== 'audio') return clip;
  const durationMs = clip.properties.durationMs;
  if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > SEQUENCE_LIMITS.timelineMs)) {
    fail('INVALID_MEDIA_DURATION', 'Stored media duration metadata must be a positive integer.', 'template.content.clip.properties.durationMs');
  }
  const range = clip.properties.sourceRange;
  if (range && (!Number.isSafeInteger(range.inMs) || !Number.isSafeInteger(range.outMs)
    || range.inMs < 0 || range.outMs > SEQUENCE_LIMITS.timelineMs || range.inMs >= range.outMs)) {
    fail('INVALID_SOURCE_RANGE', 'Stored media source range is invalid.', 'template.content.clip.properties.sourceRange');
  }
  // Duration is external file metadata. Validate the clip's structure/range shape without
  // treating a previously inspected file length as authoritative.
  return { ...clip, properties: { ...clip.properties, durationMs: SEQUENCE_LIMITS.timelineMs } } as SequenceClip;
}

/** Builds and validates an independent element copy without its source identity or placement. */
export function createElementTemplate(
  id: string,
  name: string,
  clip: SequenceClip,
  sourceComposition: CompositionSize,
  revision = 0,
): TemplateEnvelopeV1 {
  const { id: _clipId, trackId: _trackId, startMs: _startMs, ...contentClip } = clip;
  void _clipId;
  void _trackId;
  void _startMs;
  return validateTemplate({
    format: 'stagecraft-template', schemaVersion: TEMPLATE_ENVELOPE_VERSION, id, revision, name,
    content: { kind: 'element', sourceComposition: structuredClone(sourceComposition), clip: contentClip },
  });
}

export function createAnimationTemplate(
  id: string,
  name: string,
  transition: Transition,
  sourceComposition: CompositionSize,
  sourceType: SequenceClip['type'],
  revision = 0,
): TemplateEnvelopeV1 {
  return validateTemplate({
    format: 'stagecraft-template', schemaVersion: TEMPLATE_ENVELOPE_VERSION, id, revision, name,
    content: { kind: 'animation', sourceType, sourceComposition: structuredClone(sourceComposition), transition: structuredClone(transition) },
  });
}

/** Validates the versioned template envelope. Element validation delegates to the sequence validator. */
export function validateTemplate(value: unknown): TemplateEnvelopeV1 {
  assertJsonCompatible(value, 'template');
  const template = objectAt(value, 'template');
  if (template.format !== 'stagecraft-template') fail('INVALID_FORMAT', 'This record is not a Stagecraft template.', 'template.format');
  if (template.schemaVersion !== TEMPLATE_ENVELOPE_VERSION) {
    const code = typeof template.schemaVersion === 'number' && template.schemaVersion > TEMPLATE_ENVELOPE_VERSION
      ? 'UNSUPPORTED_TEMPLATE_VERSION' : 'INVALID_TEMPLATE_VERSION';
    fail(code, `Template schema version ${String(template.schemaVersion)} is not supported.`, 'template.schemaVersion');
  }
  const id = idAt(template.id, 'template.id');
  if (!Number.isSafeInteger(template.revision) || (template.revision as number) < 0) {
    fail('INVALID_REVISION', 'Template revision must be a non-negative integer.', 'template.revision');
  }
  const name = nameAt(template.name);
  const content = objectAt(template.content, 'template.content');
  if (content.kind === 'element') {
    const sourceComposition = compositionAt(content.sourceComposition, 'template.content.sourceComposition');
    const clip = objectAt(content.clip, 'template.content.clip');
    for (const placementKey of ['id', 'trackId', 'startMs']) {
      if (Object.hasOwn(clip, placementKey)) {
        fail('PLACEMENT_INCLUDED', `Element templates cannot store ${placementKey}.`, `template.content.clip.${placementKey}`);
      }
    }
    const positioned = { ...clip, id: 'template_clip', trackId: 'template_track', startMs: 0 } as unknown as SequenceClip;
    const sequence = syntheticSequence(clipForSchemaValidation(positioned), sourceComposition);
    const validated = validateWrappedSequence(sequence, 'template.content.clip');
    const normalizedClip = validated.clips[0];
    if (!normalizedClip) fail('INVALID_ELEMENT', 'The element template contains no clip.', 'template.content.clip');
    return structuredClone({
      ...template,
      id,
      name,
      content: { ...content, sourceComposition, clip: stripPlacement(positioned) },
    }) as TemplateEnvelopeV1;
  }
  if (content.kind === 'animation') {
    const sourceComposition = compositionAt(content.sourceComposition, 'template.content.sourceComposition');
    const sourceType = clipTypeAt(content.sourceType, 'template.content.sourceType');
    const transition = objectAt(content.transition, 'template.content.transition') as unknown as Transition;
    const sample = animationValidationClip(transition, sourceType);
    validateWrappedSequence(syntheticSequence(sample, { width: 1920, height: 1080 }), 'template.content.transition');
    return structuredClone({ ...template, id, name, content: { ...content, sourceType, sourceComposition, transition } }) as TemplateEnvelopeV1;
  }
  fail('UNSUPPORTED_TEMPLATE_KIND', 'This template kind is not supported.', 'template.content.kind');
}

function stripPlacement(clip: SequenceClip): ElementTemplateClip {
  const { id: _clipId, trackId: _trackId, startMs: _startMs, ...contentClip } = clip;
  void _clipId;
  void _trackId;
  void _startMs;
  return contentClip;
}

function clipTypeAt(value: unknown, path: string): SequenceClip['type'] {
  if (value === 'bars' || value === 'video' || value === 'audio' || value === 'text' || value === 'image' || value === 'solid' || value === 'button') return value;
  fail('INVALID_SOURCE_TYPE', 'Animation source type is not supported.', path);
}

function animationValidationClip(transition: Transition, sourceType: SequenceClip['type']): SequenceClip {
  const common = {
    id: 'template_clip', trackId: 'template_track', typeVersion: 1 as const, startMs: 0,
    entrance: transition.preset === 'text-motion' && textMotionPreset(transition.motion!)?.phase === 'exit'
      ? { preset: 'none', version: 1 } as const : transition,
    exit: transition.preset === 'text-motion' && textMotionPreset(transition.motion!)?.phase === 'exit'
      ? transition : { preset: 'none', version: 1 } as const,
  };
  if (sourceType === 'button') return { ...common, type: 'button', duration: { kind: 'fixed', milliseconds: SEQUENCE_LIMITS.timelineMs }, properties: defaultButtonProperties() };
  if (sourceType === 'bars') {
    return { ...common, type: 'bars', duration: { kind: 'fixed', milliseconds: SEQUENCE_LIMITS.timelineMs }, properties: { heightFraction: 0.1, color: '#000000' } };
  }
  if (sourceType === 'image') {
    return {
      ...common, type: 'image', duration: { kind: 'fixed', milliseconds: SEQUENCE_LIMITS.timelineMs },
      properties: {
        source: { kind: 'foundry-file', path: 'worlds/template/image.png' }, fit: 'contain',
        box: { x: 0, y: 0, width: 1920, height: 1080 }, crop: { x: 0, y: 0, width: 1, height: 1 },
        mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      },
    };
  }
  if (sourceType === 'solid') {
    const solid: SolidClip = {
      ...common, type: 'solid', duration: { kind: 'fixed', milliseconds: SEQUENCE_LIMITS.timelineMs },
      properties: {
        color: '#ffffff', fit: 'contain',
        box: { x: 0, y: 0, width: 1920, height: 1080 }, crop: { x: 0, y: 0, width: 1, height: 1 },
        mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      },
    };
    return solid;
  }
  if (sourceType === 'video') {
    const properties: VideoClip['properties'] = { source: { kind: 'foundry-file', path: 'worlds/template/video.webm' }, fit: 'contain', volume: 1, muted: false };
    return {
      ...common, type: 'video', typeVersion: videoTypeVersion(properties, undefined, common), duration: { kind: 'media' },
      properties,
    };
  }
  if (sourceType === 'audio') {
    return {
      ...common, type: 'audio', duration: { kind: 'media' },
      properties: { source: { kind: 'foundry-file', path: 'worlds/template/audio.ogg' }, volume: 1, muted: false },
    };
  }
  return {
    ...common, type: 'text', duration: { kind: 'fixed', milliseconds: SEQUENCE_LIMITS.timelineMs },
    properties: {
      text: 'Template validation', fontFamily: 'sans-serif', fontSize: 48, color: '#ffffff', align: 'center',
      box: { x: 0, y: 0, width: 1920, height: 1080 }, shrinkToFit: true, minimumFontSize: 1,
    },
  };
}

function scaleEffectProperties<T extends object>(properties: T, factor: number): T {
  const scaled = { ...properties };
  const sourceRecord = properties as Record<string, unknown>;
  const scaledRecord = scaled as Record<string, unknown>;
  for (const key of ['outline', 'shadow', 'glow']) {
    const value = sourceRecord[key];
    if (!isObject(value)) continue;
    const effect = { ...value };
    const sizeKeys = key === 'outline' ? ['width']
      : key === 'shadow' ? ['offsetX', 'offsetY', 'blur'] : ['radius'];
    for (const sizeKey of sizeKeys) {
      if (typeof effect[sizeKey] === 'number') {
        const scaled = effect[sizeKey] * factor;
        effect[sizeKey] = scaled === effect[sizeKey] ? scaled : roundCompositionUnits(scaled);
      }
    }
    scaledRecord[key] = effect;
  }
  return scaled;
}

function scaleTransition(transition: Transition, factor: number, sourceType: SequenceClip['type']): Transition {
  if ((sourceType === 'text' || sourceType === 'image' || sourceType === 'solid' || sourceType === 'button' || sourceType === 'video')
    && (transition.preset === 'slide' || transition.preset === 'fade-slide')) {
    const distance = transition.distance ?? 100;
    const scaled = distance * factor;
    return { ...transition, distance: scaled === distance ? scaled : roundCompositionUnits(scaled) };
  }
  return transition;
}

/** Fits the source composition uniformly inside the target, then centers the fitted frame. */
export function scaleElementTemplateToComposition(
  templateValue: unknown,
  targetComposition: CompositionSize,
): ElementTemplateClip {
  const template = validateTemplate(templateValue);
  if (template.content.kind !== 'element') fail('TEMPLATE_KIND_MISMATCH', 'An element template is required.', 'template.content.kind');
  const target = compositionAt(targetComposition, 'targetComposition');
  const source = template.content.sourceComposition;
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const offsetX = (target.width - source.width * scale) / 2;
  const offsetY = (target.height - source.height * scale) / 2;
  const clip = structuredClone(template.content.clip) as ElementTemplateClip;
  const entrance = scaleTransition(clip.entrance, scale, clip.type);
  const exit = scaleTransition(clip.exit, scale, clip.type);
  const scaleValue = (value: number) => {
    const scaled = value * scale;
    return scaled === value ? value : roundCompositionUnits(scaled);
  };
  const positionValue = (value: number, offset: number) => {
    const positioned = offset + value * scale;
    return positioned === value ? value : roundCompositionUnits(positioned);
  };
  if (clip.type === 'text' || clip.type === 'image' || clip.type === 'solid' || clip.type === 'button') {
    const properties = scaleEffectProperties(clip.properties, scale);
    const box = clip.properties.box;
    const scaledBox = {
      ...box,
      x: positionValue(box.x, offsetX),
      y: positionValue(box.y, offsetY),
      width: scaleValue(box.width),
      height: scaleValue(box.height),
    };
    if (clip.type === 'button') return { ...clip, entrance, exit, properties: { ...properties, box: scaledBox, fontSize: Math.max(1, scaleValue(clip.properties.fontSize)) } } as unknown as ElementTemplateClip;
    if (clip.type === 'text') {
      const scaledFontSize = Math.max(1, clip.properties.fontSize * scale);
      const fontSize = scaledFontSize === clip.properties.fontSize ? clip.properties.fontSize : roundCompositionUnits(scaledFontSize);
      const scaledMinimumFontSize = Math.max(1, Math.min(clip.properties.fontSize * scale, clip.properties.minimumFontSize * scale));
      const minimumFontSize = scaledMinimumFontSize === clip.properties.minimumFontSize
        ? clip.properties.minimumFontSize : roundCompositionUnits(scaledMinimumFontSize);
      return {
        ...clip,
        entrance,
        exit,
        properties: {
          ...properties,
          box: scaledBox,
          fontSize,
          minimumFontSize: Math.min(fontSize, minimumFontSize),
        },
      } as unknown as ElementTemplateClip;
    }
    return { ...clip, entrance, exit, properties: { ...properties, box: scaledBox } } as unknown as ElementTemplateClip;
  }
  if (clip.type === 'video' && clip.properties.box) {
    const box = clip.properties.box;
    return {
      ...clip, entrance, exit,
      properties: {
        ...clip.properties,
        box: {
          ...box,
          x: positionValue(box.x, offsetX),
          y: positionValue(box.y, offsetY),
          width: scaleValue(box.width),
          height: scaleValue(box.height),
        },
      },
    };
  }
  return { ...clip, entrance, exit } as ElementTemplateClip;
}

/** Instantiates a fresh clip identity and placement; media duration is intentionally left for the caller to re-probe. */
export function instantiateElementTemplate(
  templateValue: unknown,
  placement: { readonly trackId: string; readonly startMs: number; readonly composition: CompositionSize },
  makeId: () => string,
): SequenceClip {
  const template = validateTemplate(templateValue);
  if (template.content.kind !== 'element') fail('TEMPLATE_KIND_MISMATCH', 'An element template is required.', 'template.content.kind');
  idAt(placement.trackId, 'placement.trackId');
  if (!Number.isSafeInteger(placement.startMs) || placement.startMs < 0 || placement.startMs > SEQUENCE_LIMITS.timelineMs) {
    fail('INVALID_PLACEMENT', 'Template placement must use a valid timeline position.', 'placement.startMs');
  }
  const id = idAt(makeId(), 'clip.id');
  const scaled = scaleElementTemplateToComposition(template, placement.composition);
  if (scaled.type === 'button' && scaled.properties.action.kind === 'choice') {
    // An inserted element creates a new option in the existing decision group.
    (scaled.properties as { action: typeof scaled.properties.action }).action = { ...scaled.properties.action, optionId: idAt(makeId(), 'clip.properties.action.optionId') };
  }
  const candidate = {
    ...scaled, id, trackId: placement.trackId, startMs: placement.startMs,
  } as SequenceClip;
  validateWrappedSequence(syntheticSequence(clipForSchemaValidation(candidate), placement.composition), 'template.content.clip');
  return structuredClone(candidate);
}

/** Applies one animation to either edge and validates it against the actual target element type. */
export function applyAnimationTemplate(
  templateValue: unknown,
  targetClip: SequenceClip,
  phase: 'entrance' | 'exit',
  composition: CompositionSize,
): SequenceClip {
  const template = validateTemplate(templateValue);
  if (template.content.kind !== 'animation') fail('TEMPLATE_KIND_MISMATCH', 'An animation template is required.', 'template.content.kind');
  if (!isAnimationCompatible(template.content.sourceType, targetClip.type, template.content.transition)) {
    fail('ANIMATION_INCOMPATIBLE', 'This animation has different motion semantics or is unsupported for the selected element type.', 'template.content.transition');
  }
  if (phase === 'exit' && targetClip.duration.kind === 'sequence-end') {
    fail('ANIMATION_INCOMPATIBLE', 'An exit animation requires a fixed clip duration.', 'template.content.transition');
  }
  const source = template.content.sourceComposition;
  const target = compositionAt(composition, 'composition');
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const candidate = { ...structuredClone(targetClip), [phase]: scaleTransition(template.content.transition, scale, targetClip.type) } as SequenceClip;
  const compatible = candidate.type === 'video'
    ? { ...candidate, typeVersion: videoTypeVersion(candidate.properties, candidate.typeVersion, candidate) } : candidate;
  validateWrappedSequence(syntheticSequence(compatible, composition), `template.content.transition.${phase}`);
  return structuredClone(compatible);
}

function isAnimationCompatible(sourceType: SequenceClip['type'], targetType: SequenceClip['type'], transition: Transition): boolean {
  if (transition.preset === 'text-motion') return sourceType === 'text' && targetType === 'text';
  if (transition.preset === 'slide' || transition.preset === 'fade-slide') {
    // Bars reveal their own geometry; other visual elements move a box through logical composition space.
    if (sourceType === 'bars') return targetType === 'bars';
    if (sourceType === 'text' || sourceType === 'image' || sourceType === 'solid' || sourceType === 'button' || sourceType === 'video') {
      return targetType === 'text' || targetType === 'image' || targetType === 'solid' || targetType === 'button' || targetType === 'video';
    }
    return false;
  }
  return true;
}
