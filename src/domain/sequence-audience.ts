import type { PlaybackSchemaVersion, SequenceAudience, SequenceAutomation, SequenceV1 } from './sequence.js';
import { validateSequence } from './validation.js';

const DEFAULT_AUDIENCE: SequenceAudience = { mode: 'all', userIds: [], includeGM: true };
const DISABLED_AUTOMATION: SequenceAutomation = { version: 1, enabled: false, rules: [] };

/** Read timing only from its explicit compatibility version; never infer it from launch authoring. */
export function getPlaybackSchemaVersion(sequence: SequenceV1): PlaybackSchemaVersion {
  if (sequence.schemaVersion !== 4 && sequence.schemaVersion !== 5) {
    if (sequence.schemaVersion === 1 || sequence.schemaVersion === 2 || sequence.schemaVersion === 3) return sequence.schemaVersion;
    throw new TypeError('Unsupported sequence schema version.');
  }
  const version = sequence.playbackSchemaVersion;
  if (version !== 1 && version !== 2 && version !== 3) throw new TypeError('Unsupported playback schema version.');
  return version;
}

/** Historical sequences keep the existing players-and-controller default. */
export function getSequenceAudience(sequence: SequenceV1): SequenceAudience {
  const source = validateSequence(sequence);
  return (source.schemaVersion === 4 || source.schemaVersion === 5) ? structuredClone(source.launch!.audience) : structuredClone(DEFAULT_AUDIENCE);
}

/** Old launch records and historical sequences never acquire active rules while read. */
export function getSequenceAutomation(sequence: SequenceV1): SequenceAutomation {
  const source = validateSequence(sequence);
  return (source.schemaVersion === 4 || source.schemaVersion === 5) && source.launch!.version === 2
    ? structuredClone(source.launch!.automation)
    : structuredClone(DISABLED_AUTOMATION);
}

/** A launch edit wraps old timing without adopting new clip or Break semantics. */
export function withSequenceAudience(sequence: SequenceV1, audience: SequenceAudience): SequenceV1 {
  const source = validateSequence(sequence);
  const launchVersion = (source.schemaVersion === 4 || source.schemaVersion === 5) ? source.launch!.version : 1;
  return validateSequence({ ...source, schemaVersion: source.schemaVersion === 5 ? 5 : 4,
    playbackSchemaVersion: getPlaybackSchemaVersion(source),
    launch: { ...source.launch, version: launchVersion,
      audience: { ...source.launch?.audience, ...audience } } });
}

/** Explicit trigger authoring opts launch settings into version 2 without changing playback semantics. */
export function withSequenceAutomation(sequence: SequenceV1, automation: SequenceAutomation): SequenceV1 {
  const source = validateSequence(sequence);
  const previousAutomation = (source.schemaVersion === 4 || source.schemaVersion === 5) && source.launch!.version === 2
    ? source.launch!.automation
    : DISABLED_AUTOMATION;
  const previousRules = new Map(previousAutomation.rules.map(rule => [rule.id, rule]));
  const nextAutomation = {
    ...previousAutomation,
    ...automation,
    rules: automation.rules.map(rule => ({ ...previousRules.get(rule.id), ...rule }))
  };
  const launch = (source.schemaVersion === 4 || source.schemaVersion === 5) ? source.launch! : undefined;
  return validateSequence({ ...source, schemaVersion: source.schemaVersion === 5 ? 5 : 4,
    playbackSchemaVersion: getPlaybackSchemaVersion(source),
    launch: {
      ...launch,
      version: 2,
      audience: { ...(launch?.audience ?? DEFAULT_AUDIENCE) },
      automation: nextAutomation
    } });
}

/** Capability is explicit; legacy payloads never acquire personal progression while read. */
export function getSequenceProgressionMode(sequence: SequenceV1): 'shared' | 'per-recipient' {
  return sequence.schemaVersion === 5 && sequence.progression?.version === 1 && sequence.progression.mode === 'per-recipient' ? 'per-recipient' : 'shared';
}
