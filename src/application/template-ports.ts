import type { TemplateEnvelopeV1 } from '../domain/element-template.js';

export interface TemplateSummary {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly kind: 'element' | 'animation';
  readonly elementType?: string;
  /** Invalid or unsupported records remain visible and preserved, but cannot be applied. */
  readonly issue?: string;
}

/** Independent world-local template storage; implementations must never share sequence records. */
export interface TemplateRepository {
  list(): Promise<readonly TemplateSummary[]>;
  read(id: string): Promise<unknown>;
  /** Null creates a new record; a numeric expected revision appends a new immutable revision. */
  save(template: TemplateEnvelopeV1, expectedRevision: number | null): Promise<TemplateEnvelopeV1>;
  delete(id: string, expectedRevision: number): Promise<void>;
}
