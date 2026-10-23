import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { SequenceAutomationRule, SequenceV1, TriggerEvent } from '../src/domain/sequence.js';
import { createBarsSequence, duplicateSequence, SEQUENCE_LIMITS, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { getSequenceAutomation, getSequenceAudience, withSequenceAudience, withSequenceAutomation } from '../src/domain/sequence-audience.js';
import { matchingTriggerRules, validateTriggerEvent } from '../src/domain/sequence-triggers.js';

const old = await import(pathToFileURL(resolve('tests/fixtures/audience-baseline-validator-0.9.4.mjs')).href);
const selected = { mode: 'selected' as const, userIds: ['offline-player'], includeGM: false };
function ids(prefix = 'id'): () => string { let next = 0; return () => `${prefix}-${++next}`; }
function base(): SequenceV1 { return createBarsSequence('Trigger test', ids('seq'), 3); }
const rule = (id: string, event: SequenceAutomationRule['event'], actorId: string | null = null,
  enabled = true): SequenceAutomationRule => ({ id, enabled, event, actorId });
function event(kind: TriggerEvent['kind'], actorId: string | null): TriggerEvent {
  return { id: 'combat:opaque:forward:1', kind, combatId: 'combat-1', round: 2,
    turn: 1, combatantId: 'combatant-1', actorId };
}
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

test('launch v2 explicitly authors automation and old validators reject it before applying settings', () => {
  const source = base();
  const authored = withSequenceAutomation(source, { version: 1, enabled: true,
    rules: [rule('combat-open', 'combat-start'), rule('turn-open', 'turn-start', 'actor-1')] });
  assert.equal(authored.schemaVersion, 4);
  assert.equal(authored.playbackSchemaVersion, 3);
  assert.equal(authored.launch?.version, 2);
  assert.deepEqual(getSequenceAudience(authored), { mode: 'all', userIds: [], includeGM: true });
  assert.equal(source.schemaVersion, 3);
  assert.deepEqual(getSequenceAutomation(source), { version: 1, enabled: false, rules: [] });
  assert.throws(() => old.validateSequence(authored));

  const audienceEdit = withSequenceAudience(authored, selected);
  assert.equal(audienceEdit.launch?.version, 2, 'audience editing must not downgrade launch v2');
  assert.deepEqual(getSequenceAutomation(audienceEdit), getSequenceAutomation(authored));
  assert.deepEqual(getSequenceAudience(audienceEdit), selected);
});

test('launch automation edits preserve playback versions, legacy frames, Breaks and unknown JSON fields', () => {
  const futureRule = { ...rule('turn-open', 'turn-start', 'actor-1'), futureRuleField: { value: 9 } };
  const withFields = validateSequence({ ...withSequenceAutomation(base(), { version: 1, enabled: true,
    rules: [rule('turn-open', 'turn-start', 'actor-1')] }),
    extension: { futureSequence: true },
    launch: {
      ...withSequenceAutomation(base(), { version: 1, enabled: true, rules: [rule('turn-open', 'turn-start', 'actor-1')] }).launch,
      futureLaunch: { mode: 'later' },
      audience: { mode: 'selected', userIds: ['offline-player'], includeGM: false, futureAudience: ['keep'] },
      automation: { version: 1, enabled: true, futureAutomation: ['keep'], rules: [futureRule] }
    }
  });
  const edited = withSequenceAutomation(withFields, {
    ...getSequenceAutomation(withFields), enabled: false,
    rules: [{ ...getSequenceAutomation(withFields).rules[0]!, enabled: false }]
  });
  assert.ok(withFields.launch?.version === 2);
  assert.ok(edited.launch?.version === 2);
  assert.equal(edited.playbackSchemaVersion, 3);
  assert.deepEqual((edited as unknown as { extension: unknown }).extension, { futureSequence: true });
  const editedLaunch = edited.launch;
  assert.deepEqual((editedLaunch as unknown as Record<string, unknown>).futureLaunch, { mode: 'later' });
  assert.deepEqual((editedLaunch.audience as unknown as Record<string, unknown>).futureAudience, ['keep']);
  assert.deepEqual((editedLaunch.automation as unknown as Record<string, unknown>).futureAutomation, ['keep']);
  assert.deepEqual((editedLaunch.automation.rules[0] as unknown as Record<string, unknown>).futureRuleField, { value: 9 });
  assert.equal(editedLaunch.automation.enabled, false);
  assert.equal(editedLaunch.automation.rules[0]!.enabled, false);
});

test('trigger validation rejects malformed fields, repeated IDs, and rules beyond the bound', () => {
  const source = base();
  const invalid: unknown[] = [
    { version: 2, enabled: false, rules: [] },
    { version: 1, enabled: 'yes', rules: [] },
    { version: 1, enabled: false, rules: [{ ...rule('', 'turn-start') }] },
    { version: 1, enabled: false, rules: [rule('same', 'turn-start'), rule('same', 'turn-end')] },
    { version: 1, enabled: false, rules: [{ ...rule('bad-event', 'turn-start'), event: 'combat-update' }] },
    { version: 1, enabled: false, rules: [{ ...rule('bad-actor', 'turn-start'), actorId: 'bad actor' }] },
    { version: 1, enabled: false, rules: [rule('combat-start-actor', 'combat-start', 'actor-1')] },
    { version: 1, enabled: false, rules: [rule('combat-end-actor', 'combat-end', 'actor-1')] },
    { version: 1, enabled: false, rules: Array.from({ length: SEQUENCE_LIMITS.automationRules + 1 }, (_, i) => rule(`rule-${i}`, 'turn-start')) }
  ];
  for (const automation of invalid) {
    const candidate = { ...source, schemaVersion: 4, playbackSchemaVersion: 3,
      launch: { version: 2, audience: { mode: 'all', userIds: [], includeGM: true }, automation } };
    assert.throws(() => validateSequence(candidate), SequenceValidationError);
  }
  assert.throws(() => withSequenceAutomation(source, { version: 1, enabled: false,
    rules: Array.from({ length: SEQUENCE_LIMITS.automationRules + 1 }, (_, i) => rule(`rule-${i}`, 'turn-start')) }),
  (error: unknown) => errorCode(error) === 'LIMIT_EXCEEDED');
});

test('event IDs are opaque but bounded and event fields are validated', () => {
  const valid = { ...event('turn-end', 'actor-1'), id: 'native:14.367:combat update/turn:forward' };
  assert.deepEqual(validateTriggerEvent(valid), valid);
  const combatEnd = { ...event('combat-end', null), turn: null, combatantId: null };
  assert.deepEqual(validateTriggerEvent(combatEnd), combatEnd, 'combat-end is a supported fight-wide event');
  assert.throws(() => validateTriggerEvent({ ...valid, id: 'x'.repeat(SEQUENCE_LIMITS.triggerEventIdLength + 1) }),
    (error: unknown) => errorCode(error) === 'INVALID_VALUE');
  for (const bad of [
    { ...valid, id: '' }, { ...valid, kind: 'round-end' }, { ...valid, combatId: '../combat' },
    { ...valid, round: -1 }, { ...valid, turn: 1.5 }, { ...valid, actorId: 'bad actor' }
  ]) assert.throws(() => validateTriggerEvent(bad), SequenceValidationError);
});

test('matching is deterministic, keeps turn actor filters, and treats combat lifecycle events as fight-wide', () => {
  let sequence = withSequenceAutomation(base(), { version: 1, enabled: true, rules: [
    rule('unfiltered-start', 'turn-start'), rule('actor-start', 'turn-start', 'actor-1'),
    rule('other-start', 'turn-start', 'actor-2'), rule('actor-end', 'turn-end', 'actor-1'),
    rule('disabled', 'turn-start', null, false), rule('combat-start', 'combat-start'),
    rule('combat-end', 'combat-end')
  ] });
  assert.deepEqual(matchingTriggerRules(sequence, event('turn-start', 'actor-1')).map(item => item.id),
    ['unfiltered-start', 'actor-start']);
  assert.deepEqual(matchingTriggerRules(sequence, event('turn-end', 'actor-1')).map(item => item.id), ['actor-end']);
  assert.deepEqual(matchingTriggerRules(sequence, event('combat-start', null)).map(item => item.id), ['combat-start']);
  assert.deepEqual(matchingTriggerRules(sequence, event('combat-end', 'actor-2')).map(item => item.id), ['combat-end'],
    'fight-wide rules do not filter on the actor field');
  sequence = withSequenceAutomation(sequence, { ...getSequenceAutomation(sequence), enabled: false });
  assert.deepEqual(matchingTriggerRules(sequence, event('turn-start', 'actor-1')), []);
});

test('sequence copies retain authored audience and rules while disabling only the copied master switch', () => {
  const source = withSequenceAutomation(withSequenceAudience(base(), selected), { version: 1, enabled: true,
    rules: [rule('turn-open', 'turn-start', 'actor-1')] });
  const before = structuredClone(source);
  const sourceAutomation = getSequenceAutomation(source);
  const copy = duplicateSequence(source, 'Copy', ids('copy'));
  assert.deepEqual(source, before);
  assert.ok(copy.launch?.version === 2);
  assert.deepEqual(getSequenceAudience(copy), selected);
  assert.deepEqual(copy.launch.automation.rules, sourceAutomation.rules);
  assert.equal(copy.launch.automation.enabled, false);
  assert.ok(source.launch?.version === 2);
  assert.equal(source.launch.automation.enabled, true);
});
