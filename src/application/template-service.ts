import { BREAKS_PLAYBACK_SCHEMA_VERSION } from '../domain/sequence.js';
import type { SequenceClip, SequenceV1, Transition } from '../domain/sequence.js';
import {
  applyAnimationTemplate, createAnimationTemplate, createElementTemplate, instantiateElementTemplate,
  TemplateValidationError, validateTemplate,
} from '../domain/element-template.js';
import type { CompositionSize, TemplateEnvelopeV1 } from '../domain/element-template.js';
import type { TemplateRepository, TemplateSummary } from './template-ports.js';
import { SEQUENCE_LIMITS, validateSequence } from '../domain/validation.js';

export interface TemplateMediaProbe {
  (path: string, type: 'audio' | 'video'): Promise<number>;
}

export class TemplateServiceError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TemplateServiceError';
  }
}

/** The application boundary for saving, reading and instantiating independent templates. */
export class TemplateService {
  constructor(
    private readonly repository: TemplateRepository,
    private readonly makeId: () => string,
    private readonly probeMediaDuration?: TemplateMediaProbe,
  ) {}

  list(): Promise<readonly TemplateSummary[]> {
    return this.repository.list();
  }

  async read(id: string): Promise<TemplateEnvelopeV1> {
    const stored = await this.repository.read(id);
    try {
      const template = validateTemplate(stored);
      if (template.id !== id) throw new TemplateServiceError('ID_MISMATCH', 'The template library returned a different template ID.');
      return template;
    } catch (error) {
      if (error instanceof TemplateServiceError) throw error;
      throw new TemplateServiceError('INVALID_TEMPLATE', 'This template is invalid or uses an unsupported format.', { cause: error });
    }
  }

  async saveElement(name: string, clip: SequenceClip, composition: CompositionSize): Promise<TemplateEnvelopeV1> {
    const template = createElementTemplate(this.makeId(), name, clip, composition);
    return this.repository.save(template, null);
  }

  async saveAnimation(
    name: string,
    transition: Transition,
    composition: CompositionSize,
    sourceType: SequenceClip['type'],
  ): Promise<TemplateEnvelopeV1> {
    const template = createAnimationTemplate(this.makeId(), name, transition, composition, sourceType);
    return this.repository.save(template, null);
  }

  async saveRevision(template: TemplateEnvelopeV1, expectedRevision: number): Promise<TemplateEnvelopeV1> {
    return this.repository.save(validateTemplate(template), expectedRevision);
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    return this.repository.delete(id, expectedRevision);
  }

  /**
   * Returns a newly placed clip. The editor must submit it as one timeline command
   * (and one DraftService replacement) so overlap routing and undo remain atomic.
   */
  async instantiateElement(
    templateValue: unknown,
    sequence: SequenceV1,
    trackId: string,
    playheadMs: number,
  ): Promise<SequenceClip> {
    const template = validateTemplate(templateValue);
    if (template.content.kind !== 'element') throw new TemplateServiceError('TEMPLATE_KIND_MISMATCH', 'Choose an element template.');
    let clip = instantiateElementTemplate(template, {
      trackId, startMs: playheadMs, composition: sequence.composition,
    }, this.makeId);
    if (clip.type === 'audio' || clip.type === 'video') {
      const probe = this.probeMediaDuration;
      if (!probe) throw new TemplateServiceError('MEDIA_PROBE_REQUIRED', 'Inspect the referenced media before using this template.');
      const durationMs = await probe(clip.properties.source.path, clip.type);
      clip = withFreshMediaDuration(clip, durationMs);
    }
    return clip;
  }

  applyAnimation(
    templateValue: unknown,
    targetClip: SequenceClip,
    phase: 'entrance' | 'exit',
    sequence: SequenceV1,
  ): SequenceClip {
    try {
      return applyAnimationTemplate(templateValue, targetClip, phase, sequence.composition);
    } catch (error) {
      if (error instanceof TemplateValidationError) {
        throw new TemplateServiceError(
          error.code === 'UNSUPPORTED_TYPE' ? 'ANIMATION_INCOMPATIBLE' : error.code,
          error.code === 'UNSUPPORTED_TYPE'
            ? `This animation is incompatible with a ${targetClip.type} element.`
            : error.message,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

function withFreshMediaDuration(clip: Extract<SequenceClip, { type: 'audio' | 'video' }>, durationMs: number): SequenceClip {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > SEQUENCE_LIMITS.timelineMs) {
    throw new TemplateServiceError('MEDIA_PROBE_INVALID', 'The media duration could not be verified.');
  }
  const range = clip.properties.sourceRange;
  if (range && range.outMs > durationMs) {
    throw new TemplateServiceError('SOURCE_RANGE_OUTSIDE_MEDIA', 'The saved source range no longer fits the referenced media file.');
  }
  const updated = {
    ...clip,
    properties: { ...clip.properties, durationMs },
  } as SequenceClip;
  // Validation uses the current sequence validator and therefore follows its type-version support.
  const synthetic: SequenceV1 = {
    schemaVersion: BREAKS_PLAYBACK_SCHEMA_VERSION,
    id: 'template_sequence', revision: 0, name: 'Template media validation',
    composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: true, exitDurationMs: 0 },
    tracks: [{ id: 'template_track', name: clip.type === 'audio' ? 'Audio' : 'Visual', kind: clip.type === 'audio' ? 'audio' : 'visual', order: 0, enabled: true, locked: false }],
    clips: [{ ...updated, id: 'template_clip', trackId: 'template_track', startMs: 0 }],
    end: clip.type === 'video' ? { kind: 'media', clipId: 'template_clip' } : { kind: 'fixed', durationMs: SEQUENCE_LIMITS.timelineMs },
  };
  try {
    // Importing here avoids maintaining a second set of media range/version rules.
    validateTemplateMediaClip(synthetic);
    // The wrapper exists only for schema validation. Keep the real insertion identity and placement.
    return structuredClone(updated);
  } catch (error) {
    throw new TemplateServiceError('MEDIA_REPROBE_INVALID', 'The referenced media no longer matches this template.', { cause: error });
  }
}

function validateTemplateMediaClip(sequence: SequenceV1): SequenceClip {
  // Kept as a tiny local boundary to make it obvious that only the media metadata changed.
  return validateSequenceForTemplate(sequence).clips[0]!;
}

function validateSequenceForTemplate(sequence: SequenceV1): SequenceV1 {
  // This remains delegated to the sequence schema, including newer media type versions.
  return validateSequence(sequence);
}
