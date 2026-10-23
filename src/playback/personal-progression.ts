import type { ButtonClip, SequenceV1 } from '../domain/sequence.js';
import { getSequenceProgressionMode } from '../domain/sequence-audience.js';
import { compileSequence, continuePlaybackAnchor, copyPlaybackAnchor, evaluate, playbackHoldElapsedAt, playbackPositionAt, projectPlaybackAnchor, validatePlaybackBreakState, type PlaybackClockAnchor } from './evaluate.js';
import { SESSION_LIMITS, SessionProtocolError, sessionPlayback, type Participant, type SessionRun } from './session-protocol.js';

export interface PersonalChoice {
  readonly decisionId: string;
  readonly optionId: string;
  readonly clipId: string;
  readonly operationId: string;
  readonly status: 'pending' | 'confirmed';
  readonly messageId?: string;
}
export interface RecipientProgress extends Participant {
  readonly revision: number;
  readonly anchor: PlaybackClockAnchor;
  readonly terminal: boolean;
  readonly choices: readonly PersonalChoice[];
}
export interface ButtonChoiceCardInput {
  readonly operationId: string;
  readonly runId: string;
  readonly participant: Participant;
  readonly snapshot: SequenceV1;
  readonly button: ButtonClip;
  readonly action: Extract<ButtonClip['properties']['action'], { kind: 'choice' }>;
}
export type PersonalCommand = {
  readonly kind: 'button' | 'choice-confirm' | 'recipient-terminal';
  readonly sessionId: string;
  readonly generation: string;
  readonly runId: string;
  readonly participant: Participant;
  readonly expectedRevision: number;
  readonly atServerMs: number;
  readonly clipId?: string;
  readonly expectedBreakId?: string;
  readonly messageId?: string;
};
function invalid(message: string): never { throw new SessionProtocolError('SESSION_INVALID', message); }
function conflict(message: string): never { throw new SessionProtocolError('SESSION_CONFLICT', message); }
function plainData(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid('Personal state requires plain data objects.');
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !field?.enumerable || !('value' in field)) invalid('Unsupported personal state field.');
  }
}
export function isPersonalSequence(sequence: SequenceV1): boolean { return getSequenceProgressionMode(sequence) === 'per-recipient'; }
export function recipientProgress(run: SessionRun, participant: Participant): RecipientProgress | undefined {
  return run.recipientStates?.find(item => item.userId === participant.userId && item.sessionId === participant.sessionId);
}
/** This projection retains the one shared immutable snapshot. */
export function recipientRun(run: SessionRun, participant: Participant): SessionRun {
  const progress = recipientProgress(run, participant);
  if (!progress || run.phase === 'preparing') return run;
  const { recipientStates: _states, holdElapsedMs: _held, pausedFrom: _paused, exitFrom: _exit, breakId: _break, ...rest } = run;
  const anchor = progress.anchor;
  return { ...rest, phase: anchor.phase, positionMs: anchor.positionMs, atServerMs: anchor.atMs,
    exitDurationMs: anchor.exitDurationMs ?? run.snapshot.presentation.exitDurationMs,
    ...(anchor.breakHistory !== undefined ? { breakHistory: anchor.breakHistory } : {}),
    ...(anchor.breakId !== undefined ? { breakId: anchor.breakId } : {}),
    ...(anchor.holdElapsedMs !== undefined ? { holdElapsedMs: anchor.holdElapsedMs } : {}),
    ...(anchor.pausedFrom !== undefined ? { pausedFrom: anchor.pausedFrom } : {}),
    ...(anchor.exitFrom !== undefined ? { exitFrom: anchor.exitFrom } : {}) };
}
export function initialRecipientStates(run: SessionRun): readonly RecipientProgress[] {
  return run.recipients.map(participant => ({ ...participant, revision: 0,
    anchor: { phase: 'playing', positionMs: 0, atMs: 0, breakHistory: [] }, terminal: false, choices: [] }));
}
export function personalEndAt(run: SessionRun, progress: RecipientProgress): number | null {
  const projected = projectPlaybackAnchor(compileSequence(run.snapshot), progress.anchor, Number.MAX_SAFE_INTEGER);
  return projected.phase === 'exiting' ? projected.atMs + (projected.exitDurationMs ?? run.snapshot.presentation.exitDurationMs) : null;
}
export function eligibleButton(run: SessionRun, progress: RecipientProgress, clipId: string, breakId: string | undefined, now: number): ButtonClip {
  if (run.phase === 'preparing' || progress.terminal) conflict('The recipient is not playing.');
  const plan = compileSequence(run.snapshot);
  const anchor = projectPlaybackAnchor(plan, progress.anchor, now);
  if (anchor.phase !== 'holding' || anchor.breakId !== breakId) conflict('The button requires the current unpaused Break.');
  const frame = evaluate(plan, playbackPositionAt(plan, anchor, now), { holding: { elapsedMs: playbackHoldElapsedAt(anchor, now) }, breakHistory: anchor.breakHistory ?? [] });
  const item = frame.find(item => item.clip.id === clipId && item.clip.type === 'button' && item.opacity > 0 && (item.clip.appearance?.opacity ?? 1) > 0);
  if (!item || item.clip.type !== 'button') conflict('The button is not visible and enabled at this Break.');
  return item.clip;
}
export function choiceOperationId(runId: string, userId: string, decisionId: string): string {
  return JSON.stringify([runId, userId, decisionId]);
}
/** Writer-only transitions. The authenticated query handler supplies the participant and GM time. */
export function applyPersonalCommand(run: SessionRun, command: PersonalCommand): SessionRun {
  const progress = recipientProgress(run, command.participant);
  if (!progress || progress.revision !== command.expectedRevision || progress.terminal) conflict('The recipient revision is absent, terminal or stale.');
  if (!Number.isSafeInteger(command.atServerMs) || command.atServerMs < progress.anchor.atMs) invalid('Invalid authoritative action time.');
  let next: RecipientProgress;
  if (command.kind === 'recipient-terminal') {
    const endAt = personalEndAt(run, progress);
    if (endAt === null || command.atServerMs < endAt) conflict('Playback has not completed its final fade.');
    next = { ...progress, terminal: true, revision: progress.revision + 1 };
  } else {
    if (typeof command.clipId !== 'string') invalid('A button identity is required.');
    const button = eligibleButton(run, progress, command.clipId, command.expectedBreakId, command.atServerMs);
    const pending = progress.choices.find(choice => choice.status === 'pending');
    if (command.kind === 'choice-confirm') {
      if (button.properties.action.kind !== 'choice' || !pending || pending.clipId !== button.id || !command.messageId?.trim()) conflict('No matching pending choice can be confirmed.');
      next = { ...progress, revision: progress.revision + 1,
        choices: progress.choices.map(choice => choice === pending ? { ...choice, status: 'confirmed' as const, messageId: command.messageId! } : choice),
        anchor: continuePlaybackAnchor(compileSequence(run.snapshot), progress.anchor, command.atServerMs) };
    } else if (button.properties.action.kind === 'choice') {
      const action = button.properties.action;
      const existing = progress.choices.find(choice => choice.decisionId === action.decisionId);
      if (pending || existing) conflict('A choice for this decision is already pending or confirmed.');
      next = { ...progress, revision: progress.revision + 1, choices: [...progress.choices, {
        decisionId: button.properties.action.decisionId, optionId: button.properties.action.optionId, clipId: button.id,
        operationId: choiceOperationId(run.runId, progress.userId, button.properties.action.decisionId), status: 'pending' }] };
    } else {
      if (pending) conflict('Finish the pending choice before continuing.');
      next = { ...progress, revision: progress.revision + 1,
        anchor: continuePlaybackAnchor(compileSequence(run.snapshot), progress.anchor, command.atServerMs) };
    }
  }
  return { ...run, recipientStates: run.recipientStates!.map(item => item === progress ? next : item) };
}
/** One GM action transforms each live reader from their own clock exactly once. */
export function applyPersonalControl(run: SessionRun, kind: 'start' | 'pause' | 'resume' | 'continue' | 'fade', now: number, durationMs?: number): SessionRun {
  const plan = compileSequence(run.snapshot);
  const states = run.recipientStates!.map(progress => {
    if (progress.terminal) return progress;
    let anchor = projectPlaybackAnchor(plan, progress.anchor, now);
    if (kind === 'start') anchor = { phase: 'playing', positionMs: 0, atMs: now, breakHistory: [] };
    else if (kind === 'pause' && (anchor.phase === 'playing' || anchor.phase === 'holding')) {
      anchor = { phase: 'paused', positionMs: playbackPositionAt(plan, anchor, now), atMs: now, breakHistory: anchor.breakHistory ?? [],
        ...(anchor.phase === 'holding' ? { pausedFrom: 'holding', holdElapsedMs: playbackHoldElapsedAt(anchor, now), ...(anchor.breakId ? { breakId: anchor.breakId } : {}) } : {}) };
    } else if (kind === 'resume' && anchor.phase === 'paused') {
      const { pausedFrom, ...rest } = anchor;
      anchor = { ...rest, phase: pausedFrom === 'holding' ? 'holding' : 'playing', atMs: now };
    } else if (kind === 'continue') {
      if (progress.choices.some(choice => choice.status === 'pending')) return progress;
      if (anchor.phase !== 'holding' && !(anchor.phase === 'paused' && anchor.pausedFrom === 'holding')) return progress;
      anchor = continuePlaybackAnchor(plan, anchor, now);
    } else if (kind === 'fade' && anchor.phase !== 'exiting') {
      const exitFrom = anchor.phase === 'holding' ? 'holding' : anchor.pausedFrom === 'holding' ? 'paused-holding' : anchor.phase === 'paused' ? 'paused' : undefined;
      anchor = { phase: 'exiting', positionMs: playbackPositionAt(plan, anchor, now), atMs: now,
        exitDurationMs: durationMs ?? run.snapshot.presentation.exitDurationMs, breakHistory: anchor.breakHistory ?? [],
        ...(exitFrom ? { exitFrom } : {}), ...(anchor.holdElapsedMs !== undefined ? { holdElapsedMs: playbackHoldElapsedAt(anchor, now) } : {}),
        ...(anchor.breakId ? { breakId: anchor.breakId } : {}) };
    } else return progress;
    return { ...progress, revision: progress.revision + 1, anchor };
  });
  return { ...run, phase: kind === 'start' ? 'playing' : run.phase, recipientStates: states };
}
export function validateRecipientStates(run: SessionRun): void {
  if (!isPersonalSequence(run.snapshot)) {
    if (run.recipientStates !== undefined) invalid('Shared playback cannot carry recipient clocks.');
    return;
  }
  if (!Array.isArray(run.recipientStates) || run.recipientStates.length !== run.recipients.length) invalid('Each fixed participant requires a personal clock.');
  const seen = new Set<string>();
  const plan = compileSequence(run.snapshot);
  for (const progress of run.recipientStates) {
    plainData(progress, ['userId', 'sessionId', 'revision', 'anchor', 'terminal', 'choices']);
    const identity = JSON.stringify([progress.userId, progress.sessionId]);
    if (seen.has(identity) || !run.recipients.some(item => item.userId === progress.userId && item.sessionId === progress.sessionId)
      || !Number.isSafeInteger(progress.revision) || progress.revision < 0 || progress.revision > SESSION_LIMITS.records || typeof progress.terminal !== 'boolean'
      || !Array.isArray(progress.choices) || progress.choices.length > 1000) invalid('Invalid personal recipient state.');
    seen.add(identity);
    plainData(progress.anchor, ['phase', 'positionMs', 'atMs', 'exitDurationMs', 'holdElapsedMs', 'pausedFrom', 'exitFrom', 'breakId', 'breakHistory']);
    try {
      const anchor = copyPlaybackAnchor(progress.anchor); validatePlaybackBreakState(plan, anchor);
      // Reuse the full existing run validator for bounds, clocks, histories and exit origins.
      if (run.phase !== 'preparing') sessionPlayback(recipientRun(run, progress), anchor.atMs);
      else if (anchor.phase !== 'playing' || anchor.positionMs !== 0 || anchor.atMs !== 0
        || anchor.breakHistory?.length !== 0 || progress.revision !== 0 || progress.terminal || progress.choices.length) invalid('Preparation must retain pristine personal clocks.');
    }
    catch { invalid('Invalid personal playback anchor.'); }
    const decisions = new Set<string>(); let pending = 0;
    for (const choice of progress.choices) {
      plainData(choice, ['decisionId', 'optionId', 'clipId', 'operationId', 'status', 'messageId']);
      const button = plan.clips.find(clip => clip.id === choice.clipId && clip.type === 'button');
      if (!button || button.type !== 'button' || button.properties.action.kind !== 'choice'
        || choice.decisionId !== button.properties.action.decisionId || choice.optionId !== button.properties.action.optionId
        || decisions.has(choice.decisionId) || choice.operationId !== choiceOperationId(run.runId, progress.userId, choice.decisionId)
        || (choice.status !== 'pending' && choice.status !== 'confirmed')
        || (choice.status === 'confirmed') !== (typeof choice.messageId === 'string' && choice.messageId.trim().length > 0)) invalid('Invalid durable choice.');
      decisions.add(choice.decisionId); if (choice.status === 'pending') pending++;
    }
    if (pending > 1) invalid('Only one choice may be pending per reader.');
  }
}

