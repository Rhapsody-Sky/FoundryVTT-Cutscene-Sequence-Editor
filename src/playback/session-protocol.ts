import { getPlaybackSchemaVersion, getSequenceAudience } from '../domain/sequence-audience.js';
import type { SequenceV1 } from '../domain/sequence.js';
import { SEQUENCE_LIMITS } from '../domain/validation.js';
import { compileSequence, projectPlaybackAnchor, continuePlaybackAnchor, playbackPositionAt, playbackHoldElapsedAt, type BreakHistoryEntry, type PlaybackClockAnchor } from './evaluate.js';
import { isPersonalSequence, validateRecipientStates, type RecipientProgress } from './personal-progression.js';

export interface Participant {
  readonly userId: string;
  readonly sessionId: string;
}

export interface Owner {
  readonly userId: string;
  readonly sessionId: string;
  readonly generation: string;
}

export type SessionPhase = 'preparing' | 'playing' | 'holding' | 'paused' | 'exiting';

export interface SessionRun {
  readonly recipientStates?: readonly RecipientProgress[];
  readonly runId: string;
  readonly snapshot: SequenceV1;
  /** Record index of the accepted preparation. */
  readonly prepareRevision: number;
  readonly recipients: readonly Participant[];
  readonly phase: SessionPhase;
  /** Sequence position at the current server-time anchor, or a frozen position. */
  readonly positionMs: number;
  /** Shared server-time anchor for playing and exiting phases. */
  readonly atServerMs: number;
  readonly exitDurationMs: number;
  /** Break clock at atServerMs; frozen when paused from holding. */
  readonly holdElapsedMs?: number;
  readonly pausedFrom?: 'holding';
  readonly exitFrom?: 'holding' | 'paused-holding' | 'paused';
  readonly breakId?: string;
  readonly breakHistory?: readonly BreakHistoryEntry[];
}

export interface SessionState {
  readonly rootId: string;
  readonly head: number;
  readonly owner: Owner | null;
  readonly run: SessionRun | null;
  readonly closedRuns: readonly string[];
}

export type SessionCommand =
  | { readonly kind: 'acquire'; readonly sessionId: string }
  | { readonly kind: 'revoke'; readonly generation: string }
  | {
      readonly kind: 'prepare';
      readonly sessionId: string;
      readonly generation: string;
      readonly runId: string;
      readonly snapshot: SequenceV1;
      readonly recipients: readonly Participant[];
    }
  | {
      readonly kind: 'start';
      readonly sessionId: string;
      readonly generation: string;
      readonly runId: string;
      readonly recipients: readonly Participant[];
      readonly atServerMs: number;
    }
  | {
      readonly kind: 'pause';
      readonly sessionId: string;
      readonly generation: string;
      readonly runId: string;
      readonly positionMs: number;
      readonly atServerMs?: number;
      readonly holdElapsedMs?: number;
      readonly pausedFrom?: 'holding';
      readonly breakId?: string;
    }
  | {
      readonly kind: 'resume';
      readonly sessionId: string;
      readonly generation: string;
      readonly runId: string;
      readonly positionMs: number;
      readonly atServerMs: number;
    }
  | {
      readonly kind: 'fade' | 'continue';
      readonly sessionId: string;
      readonly generation: string;
      readonly runId: string;
      readonly positionMs: number;
      readonly atServerMs: number;
      readonly durationMs: number;
      readonly holdElapsedMs?: number;
      readonly exitFrom?: 'holding' | 'paused-holding' | 'paused';
      readonly breakId?: string;
      /** Guards a Continue intent against a subsequent Break in the same run. */
      readonly expectedBreakHistoryLength?: number;
    }
  | {
      readonly kind: 'stop';
      readonly sessionId: string;
      readonly generation: string;
      readonly runId: string;
    };

export interface SessionRecord {
  readonly index: number;
  readonly previous: number;
  readonly requestId: string;
  /** Must come from the authenticated server-stamped actor field. */
  readonly actor: string;
  readonly payload: SessionCommand;
}

export const SESSION_TIMING = Object.freeze({
  startLeadMs: 1_500,
  pollMs: 1_000,
  heartbeatMs: 2_000,
  controllerTimeoutMs: 8_000,
  queryTimeoutMs: 3_000,
  prepareTimeoutMs: 15_000
} as const);

export const SESSION_LIMITS = Object.freeze({
  rootIdLength: 128,
  userIdLength: 128,
  sessionIdLength: 128,
  generationLength: 160,
  runIdLength: 128,
  requestIdLength: 128,
  recipients: 100,
  records: 100_000,
  closedRuns: 100_000,
  positionMs: SEQUENCE_LIMITS.timelineMs,
  exitDurationMs: SEQUENCE_LIMITS.transitionMs,
  serverTimeMs: Number.MAX_SAFE_INTEGER
} as const);

export type SessionErrorCode = 'SESSION_INVALID' | 'SESSION_CONFLICT' | 'SESSION_UNAUTHORIZED';

export class SessionProtocolError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = 'SessionProtocolError';
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;
type GmCheck = (id: string) => boolean;

const stateObjects = new WeakSet<object>();
const runObjects = new WeakSet<object>();
const runDurations = new WeakMap<object, number | null>();
const runPlans = new WeakMap<object, ReturnType<typeof compileSequence>>();

function runPlan(run: SessionRun): ReturnType<typeof compileSequence> {
  let plan = runPlans.get(run);
  if (!plan) { plan = compileSequence(run.snapshot); runPlans.set(run, plan); }
  return plan;
}

function fail(code: SessionErrorCode, message: string): never {
  throw new SessionProtocolError(code, message);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataObjectAt(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value)) fail('SESSION_INVALID', `${path} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('SESSION_INVALID', `${path} contains an unsupported field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      fail('SESSION_INVALID', `${path}.${key} must be a plain data field.`);
    }
  }
  return value;
}

function objectAt(value: unknown, path: string, allowedKeys: readonly string[]): JsonObject {
  const object = dataObjectAt(value, path);
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) fail('SESSION_INVALID', `${path} contains an unsupported field.`);
  }
  return object;
}

function arrayAt(value: unknown, path: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    fail('SESSION_INVALID', `${path} must be an array of at most ${maxLength} entries.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
      fail('SESSION_INVALID', `${path} contains an unsupported array field.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      fail('SESSION_INVALID', `${path}[${key}] must be a plain data field.`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) fail('SESSION_INVALID', `${path} cannot contain empty entries.`);
  }
  return value;
}

function stringAt(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    fail('SESSION_INVALID', `${path} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function integerAt(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('SESSION_INVALID', `${path} must be a safe integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function participantKey(participant: Participant): string {
  return JSON.stringify([participant.userId, participant.sessionId]);
}

function normalizeParticipants(value: unknown, path: string): readonly Participant[] {
  const entries = arrayAt(value, path, SESSION_LIMITS.recipients);
  if (entries.length < 1) fail('SESSION_INVALID', `${path} must contain at least one participant.`);

  const participants = entries.map((entry, index) => {
    const participant = objectAt(entry, `${path}[${index}]`, ['userId', 'sessionId']);
    return {
      userId: stringAt(participant.userId, `${path}[${index}].userId`, SESSION_LIMITS.userIdLength),
      sessionId: stringAt(participant.sessionId, `${path}[${index}].sessionId`, SESSION_LIMITS.sessionIdLength)
    };
  });

  const pairs = new Set<string>();
  const sessions = new Set<string>();
  for (const participant of participants) {
    const key = participantKey(participant);
    if (pairs.has(key) || sessions.has(participant.sessionId)) {
      fail('SESSION_INVALID', `${path} cannot contain a duplicate browser session.`);
    }
    pairs.add(key);
    sessions.add(participant.sessionId);
  }

  participants.sort((left, right) => compareText(left.userId, right.userId) || compareText(left.sessionId, right.sessionId));
  return freezeDeep(participants);
}

function normalizeCommand(value: unknown): SessionCommand {
  const object = dataObjectAt(value, 'payload');
  const kind = object.kind;
  if (typeof kind !== 'string') fail('SESSION_INVALID', 'payload.kind must be a string.');

  if (kind === 'acquire') {
    const command = objectAt(value, 'payload', ['kind', 'sessionId']);
    return freezeDeep({
      kind,
      sessionId: stringAt(command.sessionId, 'payload.sessionId', SESSION_LIMITS.sessionIdLength)
    });
  }

  if (kind === 'revoke') {
    const command = objectAt(value, 'payload', ['kind', 'generation']);
    return freezeDeep({
      kind,
      generation: stringAt(command.generation, 'payload.generation', SESSION_LIMITS.generationLength)
    });
  }

  const ownedKeys = ['kind', 'sessionId', 'generation', 'runId'];
  const owned = (extras: readonly string[]): JsonObject => objectAt(value, 'payload', [...ownedKeys, ...extras]);
  const normalizedOwned = (command: JsonObject) => ({
    sessionId: stringAt(command.sessionId, 'payload.sessionId', SESSION_LIMITS.sessionIdLength),
    generation: stringAt(command.generation, 'payload.generation', SESSION_LIMITS.generationLength),
    runId: stringAt(command.runId, 'payload.runId', SESSION_LIMITS.runIdLength)
  });

  if (kind === 'prepare') {
    const command = owned(['snapshot', 'recipients']);
    const common = normalizedOwned(command);
    let snapshot: SequenceV1;
    try {
      snapshot = compileSequence(command.snapshot as SequenceV1).snapshot as SequenceV1;
    } catch {
      fail('SESSION_INVALID', 'payload.snapshot is not a supported playable sequence.');
    }
    return freezeDeep({
      kind,
      ...common,
      snapshot,
      recipients: normalizeParticipants(command.recipients, 'payload.recipients')
    });
  }

  if (kind === 'start') {
    const command = owned(['recipients', 'atServerMs']);
    return freezeDeep({
      kind,
      ...normalizedOwned(command),
      recipients: normalizeParticipants(command.recipients, 'payload.recipients'),
      atServerMs: integerAt(command.atServerMs, 'payload.atServerMs', 0, SESSION_LIMITS.serverTimeMs)
    });
  }

  if (kind === 'pause') {
    const command = owned(['positionMs', 'atServerMs', 'holdElapsedMs', 'pausedFrom', 'breakId']);
    if (command.pausedFrom !== undefined && command.pausedFrom !== 'holding') fail('SESSION_INVALID', 'payload.pausedFrom is not supported.');
    return freezeDeep({
      kind,
      ...normalizedOwned(command),
      positionMs: integerAt(command.positionMs, 'payload.positionMs', 0, SESSION_LIMITS.positionMs),
      ...(command.atServerMs !== undefined ? { atServerMs: integerAt(command.atServerMs, 'payload.atServerMs', 0, SESSION_LIMITS.serverTimeMs) } : {}),
      ...(command.holdElapsedMs !== undefined ? { holdElapsedMs: integerAt(command.holdElapsedMs, 'payload.holdElapsedMs', 0, SESSION_LIMITS.serverTimeMs) } : {}),
      ...(command.pausedFrom !== undefined ? { pausedFrom: 'holding' as const } : {}),
      ...(command.breakId !== undefined ? { breakId: stringAt(command.breakId, 'payload.breakId', SESSION_LIMITS.runIdLength) } : {})
    });
  }

  if (kind === 'resume') {
    const command = owned(['positionMs', 'atServerMs']);
    return freezeDeep({
      kind,
      ...normalizedOwned(command),
      positionMs: integerAt(command.positionMs, 'payload.positionMs', 0, SESSION_LIMITS.positionMs),
      atServerMs: integerAt(command.atServerMs, 'payload.atServerMs', 0, SESSION_LIMITS.serverTimeMs)
    });
  }

  if (kind === 'fade' || kind === 'continue') {
    const command = owned(['positionMs', 'atServerMs', 'durationMs', 'holdElapsedMs', 'exitFrom', 'breakId', 'expectedBreakHistoryLength']);
    if (command.exitFrom !== undefined && command.exitFrom !== 'holding' && command.exitFrom !== 'paused-holding' && command.exitFrom !== 'paused') fail('SESSION_INVALID', 'payload.exitFrom is not supported.');
    return freezeDeep({
      kind,
      ...normalizedOwned(command),
      positionMs: integerAt(command.positionMs, 'payload.positionMs', 0, SESSION_LIMITS.positionMs),
      atServerMs: integerAt(command.atServerMs, 'payload.atServerMs', 0, SESSION_LIMITS.serverTimeMs),
      durationMs: integerAt(command.durationMs, 'payload.durationMs', 0, SESSION_LIMITS.exitDurationMs),
      ...(command.holdElapsedMs !== undefined ? { holdElapsedMs: integerAt(command.holdElapsedMs, 'payload.holdElapsedMs', 0, SESSION_LIMITS.serverTimeMs) } : {}),
      ...(command.exitFrom !== undefined ? { exitFrom: command.exitFrom as 'holding' | 'paused-holding' | 'paused' } : {}),
      ...(command.breakId !== undefined ? { breakId: stringAt(command.breakId, 'payload.breakId', SESSION_LIMITS.runIdLength) } : {}),
      ...(command.expectedBreakHistoryLength !== undefined ? { expectedBreakHistoryLength: integerAt(command.expectedBreakHistoryLength, 'payload.expectedBreakHistoryLength', 0, SESSION_LIMITS.records) } : {})
    });
  }

  if (kind === 'stop') {
    const command = owned([]);
    return freezeDeep({ kind, ...normalizedOwned(command) });
  }

  return fail('SESSION_INVALID', `payload.kind "${kind}" is not supported.`);
}

function normalizeRecord(value: unknown): SessionRecord {
  const record = objectAt(value, 'record', ['index', 'previous', 'requestId', 'actor', 'payload']);
  const index = integerAt(record.index, 'record.index', 1, Number.MAX_SAFE_INTEGER);
  const previous = integerAt(record.previous, 'record.previous', 0, Number.MAX_SAFE_INTEGER);
  return freezeDeep({
    index,
    previous,
    requestId: stringAt(record.requestId, 'record.requestId', SESSION_LIMITS.requestIdLength),
    actor: stringAt(record.actor, 'record.actor', SESSION_LIMITS.userIdLength),
    payload: normalizeCommand(record.payload)
  });
}

function normalizeRun(value: unknown): SessionRun {
  const run = objectAt(value, 'state.run', [
    'runId', 'snapshot', 'prepareRevision', 'recipients', 'phase', 'positionMs', 'atServerMs', 'exitDurationMs',
    'holdElapsedMs', 'pausedFrom', 'exitFrom', 'breakId', 'breakHistory', 'recipientStates'
  ]);
  let compiled: ReturnType<typeof compileSequence>;
  try {
    compiled = compileSequence(run.snapshot as SequenceV1);
  } catch {
    fail('SESSION_INVALID', 'state.run.snapshot is not a supported playable sequence.');
  }
  if (run.phase !== 'preparing' && run.phase !== 'playing' && run.phase !== 'holding' && run.phase !== 'paused' && run.phase !== 'exiting') {
    fail('SESSION_INVALID', 'state.run.phase is not supported.');
  }
  const positionMs = integerAt(run.positionMs, 'state.run.positionMs', 0, SESSION_LIMITS.positionMs);
  const durationMs = compiled.durationMs;
  if (durationMs !== null && positionMs > durationMs) {
    fail('SESSION_INVALID', 'state.run.positionMs cannot exceed the fixed sequence end.');
  }
  const exitDurationMs = integerAt(run.exitDurationMs, 'state.run.exitDurationMs', 0, SESSION_LIMITS.exitDurationMs);
  if (run.phase !== 'exiting' && exitDurationMs !== compiled.snapshot.presentation.exitDurationMs) {
    fail('SESSION_INVALID', 'state.run.exitDurationMs must match the prepared sequence.');
  }
  if (run.exitFrom === 'paused' && (getPlaybackSchemaVersion(compiled.snapshot) === 1 || run.phase !== 'exiting'
    || run.holdElapsedMs !== undefined || run.pausedFrom !== undefined)) {
    fail('SESSION_INVALID', 'Ordinary paused exit cannot carry a Break clock.');
  }
  const hasBreakFields = run.holdElapsedMs !== undefined || run.pausedFrom !== undefined
    || (run.exitFrom !== undefined && run.exitFrom !== 'paused') || run.phase === 'holding';
  let breakHistory: readonly BreakHistoryEntry[] | undefined;
  if (getPlaybackSchemaVersion(compiled.snapshot) === 3) {
    const inner = compiled.breaks.filter(marker => marker.kind === 'inner');
    breakHistory = arrayAt(run.breakHistory, 'state.run.breakHistory', inner.length).map((entry, index) => {
      const history = objectAt(entry, `state.run.breakHistory[${index}]`, ['id', 'positionMs', 'elapsedMs']);
      const marker = inner[index];
      const id = stringAt(history.id, 'state.run.breakHistory.id', SESSION_LIMITS.runIdLength);
      const position = integerAt(history.positionMs, 'state.run.breakHistory.positionMs', 0, SESSION_LIMITS.positionMs);
      const elapsedMs = integerAt(history.elapsedMs, 'state.run.breakHistory.elapsedMs', 0, SESSION_LIMITS.serverTimeMs);
      if (!marker || id !== marker.id || position !== marker.positionMs || position > positionMs) {
        fail('SESSION_INVALID', 'Completed Break history must be the chronological prefix of active inner markers.');
      }
      return { id, positionMs: position, elapsedMs };
    });
    const next = inner[breakHistory.length];
    if (next && positionMs > next.positionMs) fail('SESSION_INVALID', 'The anchor skipped an unconsumed inner Break.');
    if (run.phase === 'preparing' && (breakHistory.length !== 0 || positionMs !== 0 || run.atServerMs !== 0 || hasBreakFields || run.breakId !== undefined)) {
      fail('SESSION_INVALID', 'Preparation cannot contain consumed Breaks or a running clock.');
    }
    const stoppedAtBreak = (next?.positionMs === positionMs && positionMs !== 0)
      || (compiled.snapshot.end.kind === 'manual' && positionMs === durationMs);
    if ((run.phase === 'paused' || run.phase === 'exiting') && !hasBreakFields && stoppedAtBreak) {
      fail('SESSION_INVALID', 'A paused or exiting Break boundary requires its held clock and origin.');
    }
    if (run.breakId !== undefined) {
      stringAt(run.breakId, 'state.run.breakId', SESSION_LIMITS.runIdLength);
      if (!next || next.id !== run.breakId || next.positionMs !== positionMs) fail('SESSION_INVALID', 'The held Break must be the first unconsumed marker.');
    }
    if (hasBreakFields) {
      if (run.breakId === undefined && (compiled.snapshot.end.kind !== 'manual' || positionMs !== durationMs || next)) {
        fail('SESSION_INVALID', 'A terminal Break requires the manual endpoint after all inner Breaks.');
      }
      integerAt(run.holdElapsedMs, 'state.run.holdElapsedMs', 0, SESSION_LIMITS.serverTimeMs);
      const valid = (run.phase === 'holding' && run.pausedFrom === undefined && run.exitFrom === undefined)
        || (run.phase === 'paused' && run.pausedFrom === 'holding' && run.exitFrom === undefined)
        || (run.phase === 'exiting' && run.pausedFrom === undefined && (run.exitFrom === 'holding' || run.exitFrom === 'paused-holding'));
      if (!valid) fail('SESSION_INVALID', 'Break fields do not match the run phase.');
    } else if (run.breakId !== undefined) fail('SESSION_INVALID', 'A current Break ID requires a holding origin.');
  } else if (run.breakId !== undefined || run.breakHistory !== undefined) {
    fail('SESSION_INVALID', 'Inner Break fields require schema 3.');
  } else if (hasBreakFields) {
    if (getPlaybackSchemaVersion(compiled.snapshot) !== 2 || compiled.snapshot.end.kind !== 'manual' || durationMs === null || positionMs !== durationMs) {
      fail('SESSION_INVALID', 'Break state requires a schema 2 manual sequence at its finite endpoint.');
    }
    integerAt(run.holdElapsedMs, 'state.run.holdElapsedMs', 0, SESSION_LIMITS.positionMs);
    const valid = (run.phase === 'holding' && run.pausedFrom === undefined && run.exitFrom === undefined)
      || (run.phase === 'paused' && run.pausedFrom === 'holding' && run.exitFrom === undefined)
      || (run.phase === 'exiting' && run.pausedFrom === undefined && (run.exitFrom === 'holding' || run.exitFrom === 'paused-holding'));
    if (!valid) fail('SESSION_INVALID', 'Break fields do not match the run phase.');
  }
  const normalized: SessionRun = freezeDeep({
    runId: stringAt(run.runId, 'state.run.runId', SESSION_LIMITS.runIdLength),
    snapshot: compiled.snapshot as SequenceV1,
    prepareRevision: integerAt(run.prepareRevision, 'state.run.prepareRevision', 1, Number.MAX_SAFE_INTEGER),
    recipients: normalizeParticipants(run.recipients, 'state.run.recipients'),
    phase: run.phase,
    positionMs,
    atServerMs: integerAt(run.atServerMs, 'state.run.atServerMs', 0, SESSION_LIMITS.serverTimeMs),
    exitDurationMs,
    ...(run.holdElapsedMs !== undefined ? { holdElapsedMs: run.holdElapsedMs as number } : {}),
    ...(run.pausedFrom !== undefined ? { pausedFrom: 'holding' as const } : {}),
    ...(run.exitFrom !== undefined ? { exitFrom: run.exitFrom as 'holding' | 'paused-holding' | 'paused' } : {}),
    ...(run.breakId !== undefined ? { breakId: run.breakId as string } : {}),
    ...(breakHistory !== undefined ? { breakHistory } : {}),
    ...(run.recipientStates !== undefined ? { recipientStates: structuredClone(run.recipientStates) as readonly RecipientProgress[] } : {})
  });
  if (normalized.recipientStates !== undefined) validateRecipientStates(normalized);
  runObjects.add(normalized);
  runDurations.set(normalized, durationMs);
  runPlans.set(normalized, compiled);
  return normalized;
}

function normalizeState(value: unknown): SessionState {
  const state = objectAt(value, 'state', ['rootId', 'head', 'owner', 'run', 'closedRuns']);
  const rootId = stringAt(state.rootId, 'state.rootId', SESSION_LIMITS.rootIdLength);
  const head = integerAt(state.head, 'state.head', 0, Number.MAX_SAFE_INTEGER);
  const closedValues = arrayAt(state.closedRuns, 'state.closedRuns', SESSION_LIMITS.closedRuns);
  const closedRuns = closedValues.map((entry, index) => stringAt(entry, `state.closedRuns[${index}]`, SESSION_LIMITS.runIdLength));
  if (new Set(closedRuns).size !== closedRuns.length) fail('SESSION_INVALID', 'state.closedRuns cannot contain duplicates.');

  let owner: Owner | null = null;
  if (state.owner !== null) {
    const ownerValue = objectAt(state.owner, 'state.owner', ['userId', 'sessionId', 'generation']);
    const userId = stringAt(ownerValue.userId, 'state.owner.userId', SESSION_LIMITS.userIdLength);
    const sessionId = stringAt(ownerValue.sessionId, 'state.owner.sessionId', SESSION_LIMITS.sessionIdLength);
    const generation = stringAt(ownerValue.generation, 'state.owner.generation', SESSION_LIMITS.generationLength);
    const prefix = `${rootId}:`;
    const generationIndexText = generation.startsWith(prefix) ? generation.slice(prefix.length) : '';
    const generationIndex = Number(generationIndexText);
    if (!/^[1-9]\d*$/.test(generationIndexText) || !Number.isSafeInteger(generationIndex) || generationIndex > head) {
      fail('SESSION_INVALID', 'state.owner.generation is not an acquisition slot for this root.');
    }
    owner = freezeDeep({ userId, sessionId, generation });
  }

  const run = state.run === null ? null : normalizeRun(state.run);
  if (owner === null && run !== null) {
    fail('SESSION_INVALID', 'An active run and its owner must exist together.');
  }
  if (run) {
    if (run.prepareRevision > head || closedRuns.includes(run.runId)) {
      fail('SESSION_INVALID', 'state.run is newer than the log head or already closed.');
    }
  }

  return makeState(rootId, head, owner, run, closedRuns);
}

function makeState(
  rootId: string,
  head: number,
  owner: Owner | null,
  run: SessionRun | null,
  closedRuns: readonly string[]
): SessionState {
  const state = freezeDeep({ rootId, head, owner, run, closedRuns: [...closedRuns] });
  stateObjects.add(state);
  if (run) runObjects.add(run);
  return state;
}

function isVerifiedGm(actor: string, isGM: GmCheck): boolean {
  if (typeof isGM !== 'function') fail('SESSION_INVALID', 'isGM must be a function.');
  let verified: boolean;
  try {
    verified = isGM(actor);
  } catch {
    return fail('SESSION_INVALID', 'isGM could not verify the server-stamped actor.');
  }
  if (verified !== true) fail('SESSION_UNAUTHORIZED', 'The server-stamped actor is not a GM.');
  return true;
}

function assertNextRecord(state: SessionState, record: SessionRecord): void {
  if (record.previous !== state.head || record.index !== state.head + 1) {
    fail('SESSION_CONFLICT', 'The record is stale or does not continue the current log head.');
  }
}

function assertOwnedCommand(state: SessionState, record: SessionRecord, command: Exclude<SessionCommand, { kind: 'acquire' | 'revoke' }>): Owner {
  const owner = state.owner;
  if (!owner) fail('SESSION_CONFLICT', 'No controller currently owns this session.');
  if (record.actor !== owner.userId) fail('SESSION_UNAUTHORIZED', 'The actor does not own the controller lease.');
  if (command.sessionId !== owner.sessionId) fail('SESSION_UNAUTHORIZED', 'The browser session does not own the controller lease.');
  if (command.generation !== owner.generation) fail('SESSION_CONFLICT', 'The controller generation is stale.');
  return owner;
}

/** Launch authoring is enforced again at the authenticated ledger boundary. */
function assertAudienceRecipients(snapshot: SequenceV1, recipients: readonly Participant[], owner: Owner): void {
  if (snapshot.schemaVersion !== 4) return;
  const audience = getSequenceAudience(snapshot);
  const selected = new Set(audience.userIds);
  for (const recipient of recipients) {
    // Replay checks immutable identities. Current user roles belong to live admission,
    // otherwise promoting a past viewer would invalidate the entire historical log.
    if (recipient.userId === owner.userId) {
      if (!audience.includeGM || recipient.userId !== owner.userId || recipient.sessionId !== owner.sessionId) {
        fail('SESSION_UNAUTHORIZED', 'Only the included controlling GM browser may receive this sequence.');
      }
    } else if (audience.mode === 'selected' && !selected.has(recipient.userId)) {
      fail('SESSION_UNAUTHORIZED', 'A recipient is outside the prepared sequence audience.');
    }
  }
}

function requireRun(state: SessionState, runId: string): SessionRun {
  if (!state.run || state.run.runId !== runId) fail('SESSION_CONFLICT', 'The command does not target the active run.');
  return state.run;
}

function closeRun(run: SessionRun | null, closedRuns: readonly string[]): readonly string[] {
  if (!run || closedRuns.includes(run.runId)) return closedRuns;
  if (closedRuns.length >= SESSION_LIMITS.closedRuns) fail('SESSION_INVALID', 'The closed-run history reached its configured limit.');
  return freezeDeep([...closedRuns, run.runId]);
}

/** Convert persisted authority time to the shared, renderer-independent clock contract. */
export function sessionAnchor(run: SessionRun): PlaybackClockAnchor {
  if (run.phase === 'preparing') fail('SESSION_CONFLICT', 'Preparation has no playback anchor.');
  return freezeDeep({ phase: run.phase, positionMs: run.positionMs, atMs: run.atServerMs,
    ...(run.phase === 'exiting' ? { exitDurationMs: run.exitDurationMs } : {}),
    ...(run.holdElapsedMs !== undefined ? { holdElapsedMs: run.holdElapsedMs } : {}),
    ...(run.pausedFrom !== undefined ? { pausedFrom: run.pausedFrom } : {}),
    ...(run.exitFrom !== undefined ? { exitFrom: run.exitFrom } : {}),
    ...(run.breakId !== undefined ? { breakId: run.breakId } : {}),
    ...(run.breakHistory !== undefined ? { breakHistory: run.breakHistory } : {}) });
}

function applyInnerBreakCommand(state: SessionState, record: SessionRecord, run: SessionRun,
  command: Extract<SessionCommand, { kind: 'pause' | 'resume' | 'fade' | 'continue' }>): SessionState {
  if (run.phase === 'preparing' || run.phase === 'exiting') fail('SESSION_CONFLICT', 'The run cannot accept this playback transition.');
  const beforeScheduledStart = run.phase === 'playing' && command.atServerMs !== undefined && command.atServerMs < run.atServerMs;
  if (command.atServerMs === undefined || (command.atServerMs < run.atServerMs && !beforeScheduledStart)) {
    fail('SESSION_INVALID', 'Schema 3 commands require a shared time at or after their anchor.');
  }
  const plan = runPlan(run);
  const anchor = sessionAnchor(run);
  const playback = sessionPlayback(run, command.atServerMs);
  if (command.positionMs !== playback.positionMs) fail('SESSION_INVALID', 'The command must preserve the projected timeline position.');
  let next: PlaybackClockAnchor;
  if (command.kind === 'resume') {
    if (run.phase !== 'paused') fail('SESSION_CONFLICT', 'Resume requires an ordinary pause.');
    const { pausedFrom, ...rest } = anchor;
    next = { ...rest, phase: pausedFrom === 'holding' ? 'holding' : 'playing', atMs: command.atServerMs };
  } else if (command.kind === 'pause') {
    if (playback.phase !== 'playing' && playback.phase !== 'holding') fail('SESSION_CONFLICT', 'Pause requires playing or holding.');
    const held = playback.phase === 'holding';
    if (command.pausedFrom !== (held ? 'holding' : undefined) || command.holdElapsedMs !== playback.holdElapsedMs || command.breakId !== playback.breakId) {
      fail('SESSION_INVALID', 'Pause must preserve the derived Break ID, clock, and origin.');
    }
    next = { phase: 'paused', positionMs: playback.positionMs, atMs: command.atServerMs, breakHistory: run.breakHistory!,
      ...(held ? { pausedFrom: 'holding', holdElapsedMs: playback.holdElapsedMs!, ...(playback.breakId ? { breakId: playback.breakId } : {}) } : {}) };
  } else {
    if (playback.phase !== 'playing' && playback.phase !== 'paused' && playback.phase !== 'holding') fail('SESSION_CONFLICT', 'The natural sequence exit has already begun.');
    const exitFrom = playback.phase === 'holding' ? 'holding' as const
      : playback.pausedFrom === 'holding' ? 'paused-holding' as const
      : playback.phase === 'paused' ? 'paused' as const : undefined;
    if (command.kind === 'continue') {
      if (exitFrom !== 'holding' && exitFrom !== 'paused-holding') fail('SESSION_CONFLICT', 'Continue requires a Break.');
      if (command.expectedBreakHistoryLength !== run.breakHistory!.length || command.breakId !== playback.breakId) {
        fail('SESSION_CONFLICT', 'Continue targets a stale or unsupported Break.');
      }
      if (command.durationMs !== run.snapshot.presentation.exitDurationMs) fail('SESSION_INVALID', 'Continue must retain the prepared exit duration.');
    } else if (command.expectedBreakHistoryLength !== undefined) fail('SESSION_INVALID', 'Only Continue carries a Break-history intent.');
    if (command.holdElapsedMs !== playback.holdElapsedMs || command.exitFrom !== exitFrom || command.breakId !== playback.breakId) {
      fail('SESSION_INVALID', 'Exit must preserve the derived Break ID, clock, and origin.');
    }
    if (command.kind === 'continue' && playback.breakId !== undefined) {
      next = continuePlaybackAnchor(plan, anchor, command.atServerMs);
    } else {
      next = { phase: 'exiting', positionMs: playback.positionMs, atMs: command.atServerMs, exitDurationMs: command.durationMs,
        breakHistory: run.breakHistory!, ...(exitFrom ? { exitFrom } : {}),
        ...(playback.holdElapsedMs !== undefined ? { holdElapsedMs: playback.holdElapsedMs } : {}),
        ...(playback.breakId !== undefined ? { breakId: playback.breakId } : {}) };
    }
  }
  const nextRun = freezeDeep({ runId: run.runId, snapshot: run.snapshot, prepareRevision: run.prepareRevision, recipients: run.recipients,
    phase: next.phase, positionMs: next.positionMs, atServerMs: next.atMs, exitDurationMs: next.exitDurationMs ?? run.snapshot.presentation.exitDurationMs,
    breakHistory: next.breakHistory!, ...(next.breakId !== undefined ? { breakId: next.breakId } : {}),
    ...(next.holdElapsedMs !== undefined ? { holdElapsedMs: next.holdElapsedMs } : {}),
    ...(next.pausedFrom !== undefined ? { pausedFrom: next.pausedFrom } : {}), ...(next.exitFrom !== undefined ? { exitFrom: next.exitFrom } : {}) });
  return makeState(state.rootId, record.index, state.owner, nextRun, state.closedRuns);
}

function applyNormalizedRecord(state: SessionState, record: SessionRecord, isGM: GmCheck, personalOrchestration = false): SessionState {
  assertNextRecord(state, record);
  isVerifiedGm(record.actor, isGM);
  const command = record.payload;

  if (command.kind === 'acquire') {
    if (state.owner !== null || state.run !== null) fail('SESSION_CONFLICT', 'A controller lease is already active.');
    const owner = freezeDeep({
      userId: record.actor,
      sessionId: command.sessionId,
      generation: `${state.rootId}:${record.index}`
    });
    return makeState(state.rootId, record.index, owner, null, state.closedRuns);
  }

  if (command.kind === 'revoke') {
    if (!state.owner || command.generation !== state.owner.generation) {
      fail('SESSION_CONFLICT', 'The revoke command does not match the active controller generation.');
    }
    const closedRuns = closeRun(state.run, state.closedRuns);
    return makeState(state.rootId, record.index, null, null, closedRuns);
  }

  const owner = assertOwnedCommand(state, record, command);

  if (command.kind === 'prepare') {
    if (isPersonalSequence(command.snapshot) && !personalOrchestration) fail('SESSION_INVALID', 'Personal progression requires an explicitly upgraded orchestration ledger.');
    if (state.run !== null) fail('SESSION_CONFLICT', 'A session run is already active.');
    if (state.closedRuns.includes(command.runId)) fail('SESSION_CONFLICT', 'A closed run ID cannot be reused.');
    const compiled = compileSequence(command.snapshot);
    assertAudienceRecipients(compiled.snapshot, command.recipients, owner);
    const run = freezeDeep({
      runId: command.runId,
      snapshot: compiled.snapshot as SequenceV1,
      prepareRevision: record.index,
      recipients: command.recipients,
      phase: 'preparing' as const,
      positionMs: 0,
      atServerMs: 0,
      exitDurationMs: compiled.snapshot.presentation.exitDurationMs,
      ...(getPlaybackSchemaVersion(compiled.snapshot) === 3 ? { breakHistory: [] } : {})
    });
    return makeState(state.rootId, record.index, state.owner, run, state.closedRuns);
  }

  const run = requireRun(state, command.runId);

  // Schema 3 uses shared clock projection for every transition. Old shapes cannot
  // bypass a marker by inventing a pause position or send a Continue for a later hold.
  if (getPlaybackSchemaVersion(run.snapshot) === 3 && command.kind !== 'start' && command.kind !== 'stop') {
    return applyInnerBreakCommand(state, record, run, command);
  }
  if (('breakId' in command && command.breakId !== undefined)
    || ('expectedBreakHistoryLength' in command && command.expectedBreakHistoryLength !== undefined)) {
    fail('SESSION_INVALID', 'Inner Break command fields require schema 3.');
  }
  if ('holdElapsedMs' in command && command.holdElapsedMs !== undefined && command.holdElapsedMs > SESSION_LIMITS.positionMs) {
    fail('SESSION_INVALID', 'Legacy Break clock exceeds its supported range.');
  }

  if (command.kind === 'start') {
    if (run.phase !== 'preparing') fail('SESSION_CONFLICT', 'A run can start only from the preparing phase.');
    assertAudienceRecipients(run.snapshot, command.recipients, owner);
    const prepared = new Set(run.recipients.map(participantKey));
    if (!command.recipients.every(participant => prepared.has(participantKey(participant)))) {
      fail('SESSION_CONFLICT', 'The start recipients must be a subset of the prepared participants.');
    }
    const nextRun = freezeDeep({
      ...run,
      recipients: command.recipients,
      phase: 'playing' as const,
      positionMs: 0,
      atServerMs: command.atServerMs
    });
    return makeState(state.rootId, record.index, state.owner, nextRun, state.closedRuns);
  }

  if (command.kind === 'pause') {
    if (run.phase !== 'playing' && run.phase !== 'holding') fail('SESSION_CONFLICT', 'A run can pause only while playing or holding.');
    const hasBreakFields = command.atServerMs !== undefined || command.holdElapsedMs !== undefined || command.pausedFrom !== undefined;
    if (hasBreakFields || run.phase === 'holding') {
      if (command.atServerMs === undefined || command.pausedFrom !== 'holding') fail('SESSION_INVALID', 'A break pause requires its shared clock and holding origin.');
      if (command.atServerMs < run.atServerMs) fail('SESSION_INVALID', 'A break pause cannot precede its shared anchor.');
      const playback = sessionPlayback(run, command.atServerMs);
      if (playback.phase !== 'holding') fail('SESSION_CONFLICT', 'The run has not reached its end break.');
      if (command.positionMs !== playback.positionMs || command.holdElapsedMs !== playback.holdElapsedMs) {
        fail('SESSION_INVALID', 'A break pause must preserve its derived endpoint and break clock.');
      }
      const nextRun = freezeDeep({ ...run, phase: 'paused' as const, positionMs: playback.positionMs,
        atServerMs: command.atServerMs, holdElapsedMs: playback.holdElapsedMs!, pausedFrom: 'holding' as const });
      return makeState(state.rootId, record.index, state.owner, nextRun, state.closedRuns);
    }
    const duration=compileSequence(run.snapshot).durationMs;
    if (duration!==null && command.positionMs > duration) {
      fail('SESSION_INVALID', 'payload.positionMs cannot exceed the fixed sequence end.');
    }
    if (getPlaybackSchemaVersion(run.snapshot) === 2 && run.snapshot.end.kind === 'manual' && command.positionMs === duration) {
      fail('SESSION_INVALID', 'Pausing at the end break requires its holding clock.');
    }
    const nextRun = freezeDeep({ ...run, phase: 'paused' as const, positionMs: command.positionMs });
    return makeState(state.rootId, record.index, state.owner, nextRun, state.closedRuns);
  }

  if (command.kind === 'resume') {
    if (run.phase !== 'paused') fail('SESSION_CONFLICT', 'A run can resume only from the paused phase.');
    if (command.positionMs !== run.positionMs) fail('SESSION_CONFLICT', 'Resume must use the frozen pause position.');
    if (run.pausedFrom === 'holding' && command.atServerMs < run.atServerMs) fail('SESSION_INVALID', 'A break resume cannot precede its pause.');
    const { pausedFrom, ...resumeRun } = run;
    const nextRun = freezeDeep({
      ...resumeRun,
      phase: pausedFrom === 'holding' ? 'holding' as const : 'playing' as const,
      positionMs: command.positionMs,
      atServerMs: command.atServerMs
    });
    return makeState(state.rootId, record.index, state.owner, nextRun, state.closedRuns);
  }

  if (command.kind === 'fade' || command.kind === 'continue') {
    if (run.phase !== 'playing' && run.phase !== 'holding' && run.phase !== 'paused') {
      fail('SESSION_CONFLICT', 'A run can fade only while playing or paused.');
    }
    const playback = sessionPlayback(run, command.atServerMs);
    const exitFrom = playback.phase === 'holding' ? 'holding' as const
      : playback.phase === 'paused' && playback.pausedFrom === 'holding' ? 'paused-holding' as const
      : playback.phase === 'paused' && getPlaybackSchemaVersion(run.snapshot) === 2 ? 'paused' as const : undefined;
    if (command.kind === 'continue' && exitFrom !== 'holding' && exitFrom !== 'paused-holding') fail('SESSION_CONFLICT', 'Continue is available only at the end break.');
    if (exitFrom === 'holding' || exitFrom === 'paused-holding') {
      if (command.atServerMs < run.atServerMs) fail('SESSION_INVALID', 'A break exit cannot precede its shared anchor.');
      if (command.positionMs !== playback.positionMs || command.holdElapsedMs !== playback.holdElapsedMs || command.exitFrom !== exitFrom) {
        fail('SESSION_INVALID', 'Break exit must preserve its derived endpoint, clock, and origin.');
      }
    } else if (exitFrom === 'paused') {
      if (command.exitFrom !== 'paused' || command.holdElapsedMs !== undefined || command.atServerMs < run.atServerMs) {
        fail('SESSION_INVALID', 'A paused exit must retain its origin without a Break clock.');
      }
    } else if (command.holdElapsedMs !== undefined || command.exitFrom !== undefined) {
      fail('SESSION_INVALID', 'Break exit fields require an end break.');
    }
    const duration=compileSequence(run.snapshot).durationMs;
    if (duration!==null && command.positionMs > duration) {
      fail('SESSION_INVALID', 'payload.positionMs cannot exceed the fixed sequence end.');
    }
    if (run.phase === 'paused' && command.positionMs !== run.positionMs) {
      fail('SESSION_CONFLICT', 'Fading a paused run must keep its frozen position.');
    }
    const { pausedFrom: _pausedFrom, ...exitRun } = run;
    const nextRun = freezeDeep({
      ...exitRun,
      phase: 'exiting' as const,
      positionMs: command.positionMs,
      atServerMs: command.atServerMs,
      exitDurationMs: command.durationMs,
      ...(exitFrom !== undefined ? { exitFrom } : {}),
      ...(exitFrom === 'holding' || exitFrom === 'paused-holding' ? { holdElapsedMs: playback.holdElapsedMs! } : {})
    });
    return makeState(state.rootId, record.index, state.owner, nextRun, state.closedRuns);
  }

  // stop is terminal for this run ID. It is valid from every active phase.
  const closedRuns = closeRun(run, state.closedRuns);
  return makeState(state.rootId, record.index, state.owner, null, closedRuns);
}

export function initialSession(rootId: string): SessionState {
  const checkedRootId = stringAt(rootId, 'rootId', SESSION_LIMITS.rootIdLength);
  return makeState(checkedRootId, 0, null, null, []);
}

/** Apply one untrusted ledger entry after checking its server-stamped actor and exact chain position. */
export function applySessionRecord(state: SessionState, record: unknown, isGM: GmCheck, personalOrchestration = false): SessionState {
  const checkedState = stateObjects.has(state as object) ? state : normalizeState(state);
  const checkedRecord = normalizeRecord(record);
  return applyNormalizedRecord(checkedState, checkedRecord, isGM, personalOrchestration);
}

/** Replay the append log from its authority root. Every entry must be the next contiguous slot. */
export function reduceSession(rootId: string, records: readonly SessionRecord[], isGM: GmCheck): SessionState {
  let state = initialSession(rootId);
  const entries = arrayAt(records, 'records', SESSION_LIMITS.records);
  const seenRequestIds = new Set<string>();

  for (const entry of entries) {
    const record = normalizeRecord(entry);
    if (seenRequestIds.has(record.requestId)) fail('SESSION_CONFLICT', 'A requestId cannot be committed more than once.');
    seenRequestIds.add(record.requestId);
    state = applyNormalizedRecord(state, record, isGM);
  }
  return state;
}

export interface SessionPlayback {
  readonly phase: SessionPhase;
  readonly positionMs: number;
  readonly holdElapsedMs?: number;
  readonly pausedFrom?: 'holding';
  readonly exitFrom?: 'holding' | 'paused-holding' | 'paused';
  readonly breakId?: string;
  readonly breakHistory?: readonly BreakHistoryEntry[];
}

/** Derive an end break without adding records or requiring the controller to observe its boundary. */
export function sessionPlayback(run: SessionRun, serverNowMs: number): SessionPlayback {
  const now = integerAt(serverNowMs, 'serverNowMs', 0, SESSION_LIMITS.serverTimeMs);
  const checked = runObjects.has(run as object) ? run : normalizeRun(run);
  if (getPlaybackSchemaVersion(checked.snapshot) === 3 && checked.phase !== 'preparing') {
    const plan = runPlan(checked);
    const projected = projectPlaybackAnchor(plan, sessionAnchor(checked), now);
    return { phase: projected.phase,
      positionMs: playbackPositionAt(plan, projected, now),
      breakHistory: checked.breakHistory!,
      ...(projected.breakId !== undefined ? { breakId: projected.breakId } : {}),
      ...(projected.holdElapsedMs !== undefined ? { holdElapsedMs: playbackHoldElapsedAt(projected, now) } : {}),
      ...(projected.pausedFrom !== undefined ? { pausedFrom: projected.pausedFrom } : {}),
      ...(projected.exitFrom !== undefined ? { exitFrom: projected.exitFrom } : {}) };
  }
  let durationMs = runDurations.get(checked);
  if (durationMs === undefined) {
    durationMs = compileSequence(checked.snapshot).durationMs;
    runDurations.set(checked, durationMs);
  }
  const elapsedMs = Math.max(0, now - checked.atServerMs);
  if (checked.phase === 'playing') {
    const positionMs = Math.min(durationMs ?? SESSION_LIMITS.positionMs, SESSION_LIMITS.positionMs, checked.positionMs + elapsedMs);
    if (getPlaybackSchemaVersion(checked.snapshot) === 2 && checked.snapshot.end.kind === 'manual' && durationMs !== null && positionMs >= durationMs) {
      return { phase: 'holding', positionMs: durationMs,
        holdElapsedMs: Math.min(SESSION_LIMITS.positionMs, Math.max(0, elapsedMs - (durationMs - checked.positionMs))) };
    }
    return { phase: 'playing', positionMs };
  }
  const advancesHold = checked.phase === 'holding' || (checked.phase === 'exiting' && checked.exitFrom === 'holding');
  return { phase: checked.phase, positionMs: checked.positionMs,
    ...(checked.holdElapsedMs !== undefined ? { holdElapsedMs: Math.min(SESSION_LIMITS.positionMs, checked.holdElapsedMs + (advancesHold ? elapsedMs : 0)) } : {}),
    ...(checked.pausedFrom !== undefined ? { pausedFrom: checked.pausedFrom } : {}),
    ...(checked.exitFrom !== undefined ? { exitFrom: checked.exitFrom } : {}) };
}

/** Exiting keeps composition time frozen while permitted held media use their separate clock. */
export function sessionPosition(run: SessionRun, serverNowMs: number): number {
  return sessionPlayback(run, serverNowMs).positionMs;
}
