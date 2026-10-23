import type { SequenceAutomationRule, SequenceTriggerKind, SequenceV1, TriggerEvent } from './sequence.js';
import { getSequenceAutomation } from './sequence-audience.js';
import { SEQUENCE_LIMITS, SequenceValidationError, validateSequence } from './validation.js';

export type { TriggerEvent } from './sequence.js';

function invalid(path: string, message: string): never {
  throw new SequenceValidationError('INVALID_VALUE', message, path);
}

function eventIdAt(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > SEQUENCE_LIMITS.triggerEventIdLength) {
    invalid('triggerEvent.id', `Event IDs must be non-empty opaque strings of at most ${SEQUENCE_LIMITS.triggerEventIdLength} characters.`);
  }
  return value;
}

function foundryIdAt(value: unknown, path: string, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > SEQUENCE_LIMITS.idLength
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    invalid(path, `Expected a Foundry ID of at most ${SEQUENCE_LIMITS.idLength} letters, numbers, underscores, or hyphens.`);
  }
  return value;
}

function nonNegativeIntegerAt(value: unknown, path: string, nullable: boolean): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(path, 'Expected a non-negative whole number.');
  }
  return value;
}

/** Validate a neutral event at the adapter boundary before it can reach matching or launch code. */
export function validateTriggerEvent(value: unknown): TriggerEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SequenceValidationError('INVALID_SHAPE', 'Expected a trigger event object.', 'triggerEvent');
  }
  const event = value as Record<string, unknown>;
  const kind = event.kind;
  if (kind !== 'combat-start' && kind !== 'combat-end' && kind !== 'turn-start' && kind !== 'turn-end') {
    throw new SequenceValidationError('UNSUPPORTED_TYPE', 'This trigger event is not supported.', 'triggerEvent.kind');
  }
  return {
    id: eventIdAt(event.id),
    kind: kind as SequenceTriggerKind,
    combatId: foundryIdAt(event.combatId, 'triggerEvent.combatId', false)!,
    round: nonNegativeIntegerAt(event.round, 'triggerEvent.round', false)!,
    turn: nonNegativeIntegerAt(event.turn, 'triggerEvent.turn', true),
    combatantId: foundryIdAt(event.combatantId, 'triggerEvent.combatantId', true),
    actorId: foundryIdAt(event.actorId, 'triggerEvent.actorId', true)
  };
}

/** Match enabled rules in authored order; combat lifecycle rules are fight-wide, while turn-end uses the prior actor. */
export function matchingTriggerRules(sequence: SequenceV1, event: TriggerEvent): readonly SequenceAutomationRule[] {
  const source = validateSequence(sequence);
  const currentEvent = validateTriggerEvent(event);
  const automation = getSequenceAutomation(source);
  if (!automation.enabled) return [];
  return automation.rules.filter(rule => rule.enabled && rule.event === currentEvent.kind
    && (rule.event === 'combat-start' || rule.event === 'combat-end'
      || rule.actorId === null || rule.actorId === currentEvent.actorId))
    .map(rule => structuredClone(rule));
}
