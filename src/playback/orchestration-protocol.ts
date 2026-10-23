import type { SequenceV1 } from '../domain/sequence.js';
import type { TriggerEvent } from '../domain/sequence-triggers.js';
import { matchingTriggerRules, validateTriggerEvent } from '../domain/sequence-triggers.js';
import { compileSequence } from './evaluate.js';
import { applyPersonalCommand, applyPersonalControl, initialRecipientStates, isPersonalSequence, validateRecipientStates, type PersonalCommand } from './personal-progression.js';
import { applySessionRecord, initialSession, SESSION_LIMITS, SessionProtocolError, type Owner, type Participant, type SessionCommand, type SessionRecord, type SessionRun, type SessionState } from './session-protocol.js';

export interface LaunchRequest {
  readonly launchId: string;
  readonly snapshot: SequenceV1;
  readonly userIds: readonly string[];
  readonly mode: 'manual' | 'automatic';
  readonly trigger?: { readonly event: TriggerEvent; readonly ruleId: string };
  readonly status: 'waiting' | 'preparing' | 'active' | 'failed';
  readonly runId?: string;
  readonly error?: string;
  readonly order: number;
}
export interface OrchestrationState {
  readonly rootId: string;
  readonly head: number;
  readonly owner: Owner | null;
  /** Last authority transition record; normal playback/queue writes do not change it. */
  readonly authorityEpoch: number;
  readonly version: 1 | 2 | 3 | 4;
  readonly runs: readonly SessionRun[];
  readonly launches: readonly LaunchRequest[];
  readonly closedRuns: readonly string[];
  readonly closedLaunches: readonly string[];
  readonly automaticAdmissions: readonly AutomaticAdmission[];
}
export interface AutomaticAdmission { readonly eventId: string; readonly sequenceId: string; readonly ruleId: string }
type Owned = { readonly sessionId: string; readonly generation: string };
export type OrchestrationCommand = SessionCommand | PersonalCommand
  | (Owned & { readonly kind: 'upgrade4' })
  | (Owned & { readonly kind: 'upgrade' })
  | (Owned & { readonly kind: 'upgrade3' })
  | (Owned & { readonly kind: 'enqueue'; readonly launchId: string; readonly snapshot: SequenceV1; readonly userIds: readonly string[]; readonly mode?: 'manual' | 'automatic'; readonly trigger?: { readonly event: TriggerEvent; readonly ruleId: string } })
  | (Owned & { readonly kind: 'claim'; readonly launchId: string; readonly runId: string })
  | (Owned & { readonly kind: 'fail'; readonly launchId: string; readonly runId: string; readonly error: string })
  | (Owned & { readonly kind: 'cancel' | 'retry'; readonly launchId: string });
export interface OrchestrationRecord extends Omit<SessionRecord, 'payload'> {
  readonly recordVersion: 1 | 2 | 3 | 4;
  readonly payload: OrchestrationCommand;
}
export const ORCHESTRATION_LIMITS = Object.freeze({ launches: 100, activeRuns: 16, closedLaunches: 100_000, automaticAdmissions: 10_000, errorLength: 2_000 });
export const ORCHESTRATION_TRANSPORT_VERSION = 7;
const verifiedStates = new WeakSet<object>();
function invalid(message: string): never { throw new SessionProtocolError('SESSION_INVALID', message); }
function conflict(message: string): never { throw new SessionProtocolError('SESSION_CONFLICT', message); }
function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) invalid(`${label} contains an unsupported data field.`);
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid('Expected a bounded non-empty identity or message.');
  return value;
}
function integer(value: unknown, max: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid('Expected a bounded integer.');
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid('Expected a bounded array.');
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) invalid('Sparse arrays are unsupported.');
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || !descriptor?.enumerable || !('value' in descriptor)) invalid('Arrays must contain plain data entries.');
  }
  return value;
}
function identities(value: unknown, max: number): readonly string[] {
  const ids = array(value, max).map(item => string(item));
  if (new Set(ids).size !== ids.length) invalid('Duplicate identities are unsupported.');
  return ids;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot(value: unknown): SequenceV1 {
  try { return compileSequence(value as SequenceV1).snapshot as SequenceV1; }
  catch { return invalid('The launch snapshot is not a supported playable sequence.'); }
}
function stable(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(normalize(value));
}
function make(state: OrchestrationState): OrchestrationState {
  const result = freeze(state);
  verifiedStates.add(result);
  return result;
}
export function initialOrchestration(rootId: string): OrchestrationState {
  const legacy = initialSession(rootId);
  return make({ rootId: legacy.rootId, head: 0, owner: null, authorityEpoch: 0, version: 1, runs: [], launches: [], closedRuns: [], closedLaunches: [], automaticAdmissions: [] });
}
/** A child playback coordinator sees the common lease/head and just its own run. */
export function scopedSession(state: OrchestrationState, runId: string): SessionState {
  return { rootId: state.rootId, head: state.head, owner: state.owner, run: state.runs.find(run => run.runId === runId) ?? null, closedRuns: state.closedRuns };
}
function intersects(left: readonly string[], right: readonly string[]): boolean { return left.some(id => right.includes(id)); }
function participants(value: unknown): readonly Participant[] {
  return array(value, SESSION_LIMITS.recipients).map(item => {
    const participant = object(item, ['userId', 'sessionId'], 'participant');
    return { userId: string(participant.userId), sessionId: string(participant.sessionId) };
  });
}
function matchesAudience(userIds: readonly string[], recipients: readonly Participant[]): boolean {
  return recipients.length === userIds.length && new Set(recipients.map(item => item.userId)).size === recipients.length
    && recipients.every(item => userIds.includes(item.userId));
}
function matchesParticipants(prepared: readonly Participant[], requested: readonly Participant[]): boolean {
  const key = (participant: Participant): string => JSON.stringify([participant.userId, participant.sessionId]);
  const keys = new Set(requested.map(key));
  return requested.length === prepared.length && keys.size === requested.length && prepared.every(item => keys.has(key(item)));
}
function triggerContext(value: unknown): NonNullable<LaunchRequest['trigger']> {
  const context = object(value, ['event', 'ruleId'], 'trigger context');
  const raw = object(context.event, ['id', 'kind', 'combatId', 'round', 'turn', 'combatantId', 'actorId'], 'trigger event');
  // The domain validator below owns supported kinds for matching and transport.
  const event: TriggerEvent = { id: string(raw.id, 256), kind: raw.kind as TriggerEvent['kind'], combatId: string(raw.combatId),
    round: integer(raw.round, Number.MAX_SAFE_INTEGER),
    turn: raw.turn === null ? null : integer(raw.turn, Number.MAX_SAFE_INTEGER),
    combatantId: raw.combatantId === null ? null : string(raw.combatantId), actorId: raw.actorId === null ? null : string(raw.actorId) };
  try { validateTriggerEvent(event); } catch { invalid('The automatic trigger context is invalid.'); }
  return freeze({ event, ruleId: string(context.ruleId) });
}
function admission(value: unknown): AutomaticAdmission {
  const item = object(value, ['eventId', 'sequenceId', 'ruleId'], 'automatic admission');
  return freeze({ eventId: string(item.eventId, 256), sequenceId: string(item.sequenceId), ruleId: string(item.ruleId) });
}
export function hasAutomaticAdmission(state: OrchestrationState, eventId: string, sequenceId: string, ruleId: string): boolean {
  return state.automaticAdmissions.some(item => item.eventId === eventId && item.sequenceId === sequenceId && item.ruleId === ruleId);
}
/** Failed requests release their reservation but preserve ordering until Retry/Cancel. */
export function eligibleLaunches(state: OrchestrationState): readonly LaunchRequest[] {
  const checked = normalizeState(state);
  const reserved = checked.launches.filter(launch => launch.status === 'preparing' || launch.status === 'active');
  if (reserved.length >= ORCHESTRATION_LIMITS.activeRuns) return [];
  return checked.launches.filter(launch => launch.status === 'waiting'
    && !reserved.some(other => intersects(other.userIds, launch.userIds))
    && !checked.launches.some(other => other.order < launch.order && (other.status === 'waiting' || other.status === 'failed') && intersects(other.userIds, launch.userIds)));
}
function normalizeLaunch(value: unknown, head: number): LaunchRequest {
  const launch = object(value, ['launchId', 'snapshot', 'userIds', 'mode', 'trigger', 'status', 'runId', 'error', 'order'], 'launch');
  if (launch.mode !== 'manual' && launch.mode !== 'automatic') invalid('Unsupported launch mode.');
  if ((launch.mode === 'automatic') !== (launch.trigger !== undefined)) invalid('Only automatic launches require trigger context.');
  if (!['waiting', 'preparing', 'active', 'failed'].includes(String(launch.status))) invalid('Invalid launch status.');
  const userIds = identities(launch.userIds, SESSION_LIMITS.recipients);
  if (!userIds.length) invalid('A launch must reserve at least one viewer.');
  const status = launch.status as LaunchRequest['status'];
  if ((status === 'preparing' || status === 'active') !== (launch.runId !== undefined)) invalid('Only reserved launches have a run ID.');
  if ((status === 'failed') !== (launch.error !== undefined)) invalid('Only failed launches have an error.');
  const preparedSnapshot = snapshot(launch.snapshot);
  const trigger = launch.trigger === undefined ? undefined : triggerContext(launch.trigger);
  if (trigger && !matchingTriggerRules(preparedSnapshot, trigger.event).some(rule => rule.id === trigger.ruleId)) invalid('An automatic launch must preserve its enabled matching rule.');
  return freeze({ launchId: string(launch.launchId), snapshot: preparedSnapshot, userIds, mode: launch.mode, status,
    ...(trigger ? { trigger } : {}),
    order: integer(launch.order, head, 1), ...(launch.runId === undefined ? {} : { runId: string(launch.runId) }), ...(launch.error === undefined ? {} : { error: string(launch.error, ORCHESTRATION_LIMITS.errorLength) }) });
}
function normalizeState(value: OrchestrationState): OrchestrationState {
  if (verifiedStates.has(value)) return value;
  const state = object(value, ['rootId', 'head', 'owner', 'authorityEpoch', 'version', 'runs', 'launches', 'closedRuns', 'closedLaunches', 'automaticAdmissions'], 'state');
  const rootId = initialSession(string(state.rootId)).rootId;
  const head = integer(state.head, SESSION_LIMITS.records);
  const authorityEpoch = integer(state.authorityEpoch, head);
  if (state.version !== 1 && state.version !== 2 && state.version !== 3 && state.version !== 4) invalid('Unsupported orchestration state version.');
  const automaticAdmissions = array(state.automaticAdmissions ?? [], ORCHESTRATION_LIMITS.automaticAdmissions).map(admission);
  if (new Set(automaticAdmissions.map(stable)).size !== automaticAdmissions.length) invalid('Duplicate automatic admission identities.');
  if (state.version < 3 && automaticAdmissions.length) invalid('Automatic admissions require Record 3.');
  const closedRuns = identities(state.closedRuns, SESSION_LIMITS.closedRuns);
  const closedLaunches = identities(state.closedLaunches, ORCHESTRATION_LIMITS.closedLaunches);
  const runs = array(state.runs, ORCHESTRATION_LIMITS.activeRuns) as unknown as SessionRun[];
  const ownerValue = state.owner === null ? null : object(state.owner, ['userId', 'sessionId', 'generation'], 'owner');
  const owner: Owner | null = ownerValue === null ? null : {
    userId: string(ownerValue.userId), sessionId: string(ownerValue.sessionId), generation: string(ownerValue.generation, SESSION_LIMITS.generationLength)
  };
  // The old reducer remains the sole validator of clocks, breaks, participants and lease shape.
  for (const run of runs.length ? runs : [null]) {
    if (run && isPersonalSequence(run.snapshot)) {
      if (state.version < 4) invalid('Personal playback requires Record 4.');
      validateRecipientStates(run);
    }
    const scoped: SessionState = { rootId, head, owner, run, closedRuns };
    const payload: SessionCommand = owner ? { kind: 'revoke', generation: owner.generation } : { kind: 'acquire', sessionId: 'validation' };
    applySessionRecord(scoped, { index: head + 1, previous: head, requestId: 'validation', actor: owner?.userId ?? 'validation', payload }, () => true);
  }
  if (new Set(runs.map(run => run.runId)).size !== runs.length) invalid('Duplicate active run IDs.');
  const launches = array(state.launches, ORCHESTRATION_LIMITS.launches).map(item => normalizeLaunch(item, head));
  if (new Set(launches.map(launch => launch.launchId)).size !== launches.length || new Set(launches.map(launch => launch.order)).size !== launches.length) invalid('Duplicate launch identities or ordering slots.');
  if (launches.some((launch, index) => closedLaunches.includes(launch.launchId) || (index > 0 && launch.order <= launches[index - 1]!.order))) invalid('Launch order/history is invalid.');
  const reserved = launches.filter(launch => launch.runId !== undefined);
  if (reserved.length > ORCHESTRATION_LIMITS.activeRuns || new Set(reserved.map(launch => launch.runId)).size !== reserved.length) invalid('Invalid reservation limit or run IDs.');
  if (reserved.some((launch, index) => closedRuns.includes(launch.runId!) || reserved.slice(index + 1).some(other => intersects(launch.userIds, other.userIds)))) invalid('Reservations overlap or reuse a closed run.');
  if (!owner && (runs.length || launches.length)) invalid('Launches require an owner.');
  if (state.version === 1 && (launches.length || closedLaunches.length || runs.length > 1)) invalid('Legacy state cannot contain orchestration requests.');
  if (launches.some(launch => launch.mode === 'automatic' && ((state.version as number) < 3 || !automaticAdmissions.some(item =>
    item.eventId === launch.trigger!.event.id && item.sequenceId === launch.snapshot.id && item.ruleId === launch.trigger!.ruleId)))) invalid('Automatic launches must have an authoritative admission.');
  if (state.version >= 2) {
    for (const run of runs) {
      const launch = reserved.find(item => item.runId === run.runId);
      if (!launch || stable(launch.snapshot) !== stable(run.snapshot) || !matchesAudience(launch.userIds, run.recipients)
        || (launch.status === 'active') !== (run.phase !== 'preparing')) invalid('A run must match its reserved launch.');
    }
    if (launches.some(launch => launch.status === 'active' && !runs.some(run => run.runId === launch.runId))) invalid('An active launch needs a run.');
  }
  return make({ rootId, head, owner: structuredClone(owner), authorityEpoch, version: state.version, runs: structuredClone(runs), launches, closedRuns, closedLaunches, automaticAdmissions });
}
/** Validate and freeze external projections before any coordinator interprets them. */
export function normalizeOrchestrationState(value: OrchestrationState): OrchestrationState { return normalizeState(value); }
function owned(state: OrchestrationState, actor: string, command: Owned): void {
  const owner = state.owner;
  if (!owner || command.generation !== owner.generation) conflict('The controller generation is absent or stale.');
  if (actor !== owner.userId || command.sessionId !== owner.sessionId) throw new SessionProtocolError('SESSION_UNAUTHORIZED', 'The actor/browser does not own this controller.');
}
function close(ids: readonly string[], id: string, limit: number): readonly string[] {
  if (ids.includes(id)) return ids;
  if (ids.length >= limit) invalid('The terminal identity history reached its configured limit.');
  return [...ids, id];
}
export function applyOrchestrationRecord(state: OrchestrationState, value: unknown, isGM: (id: string) => boolean): OrchestrationState {
  state = normalizeState(state);
  const record = object(value, ['index', 'previous', 'requestId', 'actor', 'payload', 'recordVersion'], 'record');
  const index = integer(record.index, SESSION_LIMITS.records, 1);
  const previous = integer(record.previous, SESSION_LIMITS.records);
  const actor = string(record.actor), requestId = string(record.requestId);
  if (index !== state.head + 1 || previous !== state.head) conflict('The record does not extend the current head.');
  if (typeof isGM !== 'function') invalid('The authenticated actor check must be a function.');
  let verified: boolean;
  try { verified = isGM(actor); } catch { return invalid('The authenticated actor could not be verified.'); }
  if (verified !== true) throw new SessionProtocolError('SESSION_UNAUTHORIZED', 'The authenticated actor is not a GM.');
  if (record.recordVersion !== 1 && record.recordVersion !== 2 && record.recordVersion !== 3 && record.recordVersion !== 4) invalid('Unsupported session record version.');
  const raw = object(record.payload, ['kind', 'sessionId', 'generation', 'launchId', 'runId', 'snapshot', 'userIds', 'mode', 'trigger', 'error', 'recipients', 'atServerMs', 'positionMs', 'holdElapsedMs', 'pausedFrom', 'exitFrom', 'breakId', 'expectedBreakHistoryLength', 'durationMs', 'participant', 'expectedRevision', 'clipId', 'expectedBreakId', 'messageId'], 'payload');
  if (state.version === 1 && raw.kind !== 'upgrade') {
    if (record.recordVersion !== 1) conflict('The first version 2 record must explicitly upgrade an idle legacy session.');
    const legacy = applySessionRecord(scopedSession(state, state.runs[0]?.runId ?? ''), { index, previous, requestId, actor, payload: raw }, isGM);
    return make({ ...state, head: index, owner: legacy.owner, authorityEpoch: state.owner?.generation !== legacy.owner?.generation ? index : state.authorityEpoch,
      runs: legacy.run ? [legacy.run] : [], closedRuns: legacy.closedRuns });
  }
  const expectedVersion = raw.kind === 'upgrade4' && state.version >= 3 ? 4 : raw.kind === 'upgrade3' && state.version === 2 ? 3 : state.version === 1 ? 2 : state.version;
  if (record.recordVersion !== expectedVersion) conflict('The record version must match the explicitly upgraded ledger.');
  const queueKinds = ['upgrade', 'upgrade3', 'upgrade4', 'enqueue', 'claim', 'fail', 'cancel', 'retry'];
  if (queueKinds.includes(String(raw.kind))) {
    const extras = raw.kind === 'enqueue' ? ['snapshot', 'userIds', 'mode', ...(state.version >= 3 ? ['trigger'] : [])] : raw.kind === 'claim' ? ['runId'] : raw.kind === 'fail' ? ['runId', 'error'] : [];
    object(raw, ['kind', 'sessionId', 'generation', ...(['upgrade', 'upgrade3', 'upgrade4'].includes(String(raw.kind)) ? [] : ['launchId']), ...extras], 'payload');
    const command = { sessionId: string(raw.sessionId), generation: string(raw.generation, SESSION_LIMITS.generationLength) };
    owned(state, actor, command);
    if (raw.kind === 'upgrade') {
      if (state.version !== 1 || state.runs.length) conflict('Upgrade requires an idle legacy session.');
      return make({ ...state, head: index, version: 2 });
    }
    if (raw.kind === 'upgrade3') {
      if (state.version !== 2 || state.runs.length || state.launches.length) conflict('Record 3 upgrade requires an idle Record 2 ledger. Explicitly stop or cancel existing runs and launches.');
      return make({ ...state, head: index, version: 3 });
    }
    if (raw.kind === 'upgrade4') {
      if (state.version !== 3 || state.runs.length || state.launches.length) conflict('Record 4 upgrade requires an idle Record 3 ledger.');
      return make({ ...state, head: index, version: 4 });
    }
    const launchId = string(raw.launchId);
    if (raw.kind === 'enqueue') {
      if (state.launches.length >= ORCHESTRATION_LIMITS.launches) invalid('The launch queue reached its configured limit.');
      if (state.closedLaunches.includes(launchId) || state.launches.some(launch => launch.launchId === launchId)) conflict('A launch ID cannot be reused.');
      if (raw.mode !== undefined && raw.mode !== 'manual' && !(state.version >= 3 && raw.mode === 'automatic')) invalid('Unsupported launch mode for this ledger version.');
      if ((raw.mode === 'automatic') !== (raw.trigger !== undefined)) invalid('Only automatic launches require trigger context.');
      const userIds = identities(raw.userIds, SESSION_LIMITS.recipients);
      if (!userIds.length) invalid('A launch must reserve at least one viewer.');
      const preparedSnapshot = snapshot(raw.snapshot);
      if (isPersonalSequence(preparedSnapshot) && state.version < 4) conflict('Personal playback requires Record 4.');
      const trigger = raw.mode === 'automatic' ? triggerContext(raw.trigger) : undefined;
      if (trigger && !matchingTriggerRules(preparedSnapshot, validateTriggerEvent(trigger.event)).some(rule => rule.id === trigger.ruleId)) invalid('An automatic admission requires an enabled matching saved rule.');
      if (trigger && hasAutomaticAdmission(state, trigger.event.id, preparedSnapshot.id, trigger.ruleId)) conflict('This automatic event/sequence/rule was already admitted.');
      if (trigger && state.automaticAdmissions.length >= ORCHESTRATION_LIMITS.automaticAdmissions) invalid('The automatic event admission history reached its configured limit; no history was removed.');
      const launch: LaunchRequest = freeze({ launchId, snapshot: preparedSnapshot, userIds, mode: trigger ? 'automatic' : 'manual',
        ...(trigger ? { trigger } : {}), status: 'waiting', order: index });
      return make({ ...state, head: index, launches: [...state.launches, launch], automaticAdmissions: trigger
        ? [...state.automaticAdmissions, { eventId: trigger.event.id, sequenceId: preparedSnapshot.id, ruleId: trigger.ruleId }] : state.automaticAdmissions });
    }
    const launch = state.launches.find(item => item.launchId === launchId);
    if (!launch) conflict('The launch is absent or closed.');
    if (raw.kind === 'claim') {
      const runId = string(raw.runId);
      if (!eligibleLaunches(state).includes(launch)) conflict('The launch is reserved, blocked or out of turn.');
      if (state.closedRuns.includes(runId) || state.launches.some(item => item.runId === runId)) conflict('An attempt run ID cannot be reused.');
      return make({ ...state, head: index, launches: state.launches.map(item => item === launch ? freeze({ ...item, status: 'preparing' as const, runId }) : item) });
    }
    if (raw.kind === 'retry') {
      if (launch.status !== 'failed' && !(state.version >= 3 && launch.status === 'waiting')) conflict('Only a failed launch or an explicit unresolved waiting admission can retry.');
      const { error: _error, ...waiting } = launch;
      return make({ ...state, head: index, launches: state.launches.map(item => item === launch ? freeze({ ...waiting, status: 'waiting' as const }) : item) });
    }
    if (raw.kind === 'fail') {
      if (launch.status !== 'preparing' || raw.runId !== launch.runId) conflict('The failure does not match this preparation attempt.');
      const error = string(raw.error, ORCHESTRATION_LIMITS.errorLength);
      const { runId: _runId, ...failed } = launch;
      return make({ ...state, head: index, runs: state.runs.filter(run => run.runId !== launch.runId), closedRuns: close(state.closedRuns, launch.runId!, SESSION_LIMITS.closedRuns),
        launches: state.launches.map(item => item === launch ? freeze({ ...failed, status: 'failed' as const, error }) : item) });
    }
    if (launch.status === 'active') conflict('Stop the active run to close its launch.');
    return make({ ...state, head: index, runs: state.runs.filter(run => run.runId !== launch.runId), launches: state.launches.filter(item => item !== launch),
      closedRuns: launch.runId ? close(state.closedRuns, launch.runId, SESSION_LIMITS.closedRuns) : state.closedRuns,
      closedLaunches: close(state.closedLaunches, launchId, ORCHESTRATION_LIMITS.closedLaunches) });
  }
  if (['button', 'choice-confirm', 'recipient-terminal'].includes(String(raw.kind))) {
    object(raw, ['kind', 'sessionId', 'generation', 'runId', 'participant', 'expectedRevision', 'atServerMs', 'clipId', 'expectedBreakId', 'messageId'], 'personal command');
    owned(state, actor, { sessionId: string(raw.sessionId), generation: string(raw.generation, SESSION_LIMITS.generationLength) });
    const runId = string(raw.runId);
    const run = state.runs.find(item => item.runId === runId);
    if (state.version < 4 || !run?.recipientStates) conflict('No personal run exists.');
    const recipient = participants([raw.participant])[0]!;
    const personal: PersonalCommand = { kind: raw.kind as PersonalCommand['kind'], sessionId: string(raw.sessionId), generation: string(raw.generation), runId, participant: recipient,
      expectedRevision: integer(raw.expectedRevision, SESSION_LIMITS.records), atServerMs: integer(raw.atServerMs, SESSION_LIMITS.serverTimeMs),
      ...(raw.clipId !== undefined ? { clipId: string(raw.clipId) } : {}),
      ...(raw.expectedBreakId !== undefined ? { expectedBreakId: string(raw.expectedBreakId) } : {}),
      ...(raw.messageId !== undefined ? { messageId: string(raw.messageId, 256) } : {}) };
    const updated = applyPersonalCommand(run, personal);
    validateRecipientStates(updated);
    const complete = updated.recipientStates!.every(item => item.terminal);
    const launch = state.launches.find(item => item.runId === runId);
    return make({ ...state, head: index, runs: complete ? state.runs.filter(item => item.runId !== runId) : state.runs.map(item => item === run ? updated : item),
      launches: complete ? state.launches.filter(item => item !== launch) : state.launches,
      closedRuns: complete ? close(state.closedRuns, runId, SESSION_LIMITS.closedRuns) : state.closedRuns,
      closedLaunches: complete && launch ? close(state.closedLaunches, launch.launchId, ORCHESTRATION_LIMITS.closedLaunches) : state.closedLaunches });
  }
  const command = raw as unknown as SessionCommand;
  const runId = 'runId' in command ? command.runId : '';
  const launch = state.launches.find(item => item.runId === runId);
  if (command.kind === 'prepare') {
    if (!launch || launch.status !== 'preparing' || stable(snapshot(command.snapshot)) !== stable(launch.snapshot)
      || !matchesAudience(launch.userIds, participants(command.recipients))) conflict('Preparation must match the claimed snapshot and every reserved viewer exactly once.');
  }
  if (command.kind === 'start') {
    const prepared = state.runs.find(run => run.runId === runId);
    if (!prepared || !matchesParticipants(prepared.recipients, participants(command.recipients))) conflict('Start must retain every fixed prepared participant and browser session.');
  }
  const personalRun = state.runs.find(item => item.runId === runId && item.recipientStates);
  if (personalRun && ['pause', 'resume', 'continue', 'fade'].includes(command.kind)) {
    owned(state, actor, command as Owned);
    if (!('atServerMs' in command)) invalid('Personal controls require authoritative time.');
    const at = integer(command.atServerMs, SESSION_LIMITS.serverTimeMs);
    const duration = 'durationMs' in command ? integer(command.durationMs, SESSION_LIMITS.exitDurationMs) : undefined;
    const updated = applyPersonalControl(personalRun, command.kind as 'pause' | 'resume' | 'continue' | 'fade', at, duration);
    validateRecipientStates(updated);
    return make({ ...state, head: index, runs: state.runs.map(item => item === personalRun ? updated : item) });
  }
  const legacy = applySessionRecord(scopedSession(state, runId), { index, previous, requestId, actor, payload: command }, isGM, state.version === 4);
  if (command.kind === 'revoke') {
    let closedRuns = state.closedRuns, closedLaunches = state.closedLaunches;
    for (const item of state.launches) { if (item.runId) closedRuns = close(closedRuns, item.runId, SESSION_LIMITS.closedRuns); closedLaunches = close(closedLaunches, item.launchId, ORCHESTRATION_LIMITS.closedLaunches); }
    return make({ ...state, head: index, owner: null, authorityEpoch: index, runs: [], launches: [], closedRuns, closedLaunches });
  }
  const runs = state.runs.filter(run => run.runId !== runId);
  if (legacy.run) {
    let nextRun = legacy.run;
    if (command.kind === 'prepare' && isPersonalSequence(nextRun.snapshot)) nextRun = { ...nextRun, recipientStates: initialRecipientStates(nextRun) };
    if (command.kind === 'start' && nextRun.recipientStates) nextRun = applyPersonalControl(nextRun, 'start', command.atServerMs);
    runs.push(nextRun);
  }
  return make({ ...state, head: index, owner: legacy.owner, authorityEpoch: state.owner?.generation !== legacy.owner?.generation ? index : state.authorityEpoch, runs, closedRuns: legacy.closedRuns,
    launches: command.kind === 'stop' ? state.launches.filter(item => item !== launch)
      : command.kind === 'start' ? state.launches.map(item => item === launch ? freeze({ ...item, status: 'active' as const }) : item) : state.launches,
    closedLaunches: command.kind === 'stop' && launch ? close(state.closedLaunches, launch.launchId, ORCHESTRATION_LIMITS.closedLaunches) : state.closedLaunches });
}
export function reduceOrchestration(rootId: string, records: readonly OrchestrationRecord[], isGM: (id: string) => boolean): OrchestrationState {
  let state = initialOrchestration(rootId);
  const seen = new Set<string>();
  for (const value of array(records, SESSION_LIMITS.records)) {
    const record = object(value, ['index', 'previous', 'requestId', 'actor', 'payload', 'recordVersion'], 'record');
    const requestId = string(record.requestId);
    if (seen.has(requestId)) conflict('A request ID cannot be committed twice.');
    state = applyOrchestrationRecord(state, record, isGM);
    seen.add(requestId);
  }
  return state;
}
