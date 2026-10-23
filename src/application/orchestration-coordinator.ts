import type { SequenceV1 } from '../domain/sequence.js';
import type { TriggerEvent } from '../domain/sequence-triggers.js';
import { matchingTriggerRules, validateTriggerEvent } from '../domain/sequence-triggers.js';
import { getSequenceAudience, withSequenceAudience } from '../domain/sequence-audience.js';
import { compileSequence } from '../playback/evaluate.js';
import { eligibleButton, isPersonalSequence, recipientProgress, recipientRun, type PersonalCommand } from '../playback/personal-progression.js';
import { eligibleLaunches, hasAutomaticAdmission, normalizeOrchestrationState, ORCHESTRATION_LIMITS, ORCHESTRATION_TRANSPORT_VERSION, scopedSession, type LaunchRequest, type OrchestrationCommand, type OrchestrationState } from '../playback/orchestration-protocol.js';
import { SESSION_TIMING, sessionPlayback, type SessionCommand, type SessionRun, type SessionState } from '../playback/session-protocol.js';
import { CoordinatorError, SessionCoordinator, type CoordinatorHost, type CoordinatorParticipantStatus, type CoordinatorPhase, type CoordinatorStatus } from './session-coordinator.js';

export interface OrchestrationCoordinatorHost extends Omit<CoordinatorHost, 'store' | 'transportVersion'> {
  readonly store: {
    read(): Promise<OrchestrationState>;
    append(command: OrchestrationCommand, expectedHead: number): Promise<OrchestrationState>;
  };
}

export interface OrchestrationRunView {
  readonly run: SessionRun;
  readonly phase: CoordinatorPhase;
  readonly participants: readonly CoordinatorParticipantStatus[];
}
declare const automaticAdmissionBrand: unique symbol;
/** Issued only by its coordinator; callers can retain it but cannot forge or mutate authority. */
export interface AutomaticAdmissionIntent { readonly [automaticAdmissionBrand]: true }
interface AutomaticIntentState { epoch: number; generation: string | null }
class StaleAutomaticIntentError extends Error {}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** One authority log, independent run clocks, and at most one local group surface. */
export class OrchestrationCoordinator {
  private currentState: OrchestrationState | null = null;
  private readonly children = new Map<string, SessionCoordinator>();
  private readonly permittedLocalRuns = new Set<string>();
  private readonly pastRuns = new Set<string>();
  private readonly pastLaunches = new Set<string>();
  private readonly automaticStartAttempts = new Set<string>();
  private readonly automaticIntents = new WeakMap<AutomaticAdmissionIntent, AutomaticIntentState>();
  private sharedAutomaticIntent: AutomaticAdmissionIntent | null = null;
  private readonly failingLaunches = new Set<string>();
  private readonly unresolvedClaims = new Set<string>();
  private readonly explicitControls = new Map<string, SessionCommand['kind']>();
  private localRunId: string | null = null;
  private error: Error | null = null;
  private readError: Error | null = null;
  private readInFlight: Promise<void> | null = null;
  private commandTail: Promise<void> = Promise.resolve();
  private writeTail: Promise<void> = Promise.resolve();
  private pumpInFlight: Promise<void> | null = null;
  private pumpEnabled = false;
  private disposed = false;
  private initialized = false;
  private controllerLost = false;
  private lastReadAt: number;
  private pollTimer: unknown = null;
  private deadlineTimer: unknown = null;

  constructor(private readonly host: OrchestrationCoordinatorHost) { this.lastReadAt = host.monotonicNow(); }

  get state(): OrchestrationState | null { return this.currentState; }
  get lastError(): Error | null { return this.error; }
  /** Future saved events may acquire a free controller, but never displace another tab. */
  get canPrepareAutomatic(): boolean {
    return !this.disposed && !this.controllerLost && this.isCurrentGM() && !!this.currentState
      && (!this.currentState.owner || this.isOwner());
  }
  /** Capture before event dispatch awaits. Concurrent events while free share one acquisition. */
  captureAutomaticIntent(): AutomaticAdmissionIntent | null {
    if (!this.canPrepareAutomatic) return null;
    if (this.sharedAutomaticIntent && this.validAutomaticIntent(this.sharedAutomaticIntent)) return this.sharedAutomaticIntent;
    const intent = Object.freeze({}) as AutomaticAdmissionIntent;
    const state = this.requireState();
    this.automaticIntents.set(intent, { epoch: state.authorityEpoch, generation: state.owner?.generation ?? null });
    this.sharedAutomaticIntent = intent;
    return intent;
  }
  get status(): CoordinatorStatus {
    const local = this.localRunId ? this.children.get(this.localRunId)?.status : undefined;
    return Object.freeze({ phase: local?.phase ?? 'idle', runId: local?.runId ?? null, isOwner: this.isOwner(),
      canExit: local?.canExit ?? false, error: this.error?.message ?? local?.error ?? null });
  }
  get runs(): readonly OrchestrationRunView[] {
    return Object.freeze((this.currentState?.runs ?? []).map(run => {
      const child = this.children.get(run.runId);
      const participants = child?.participants ?? run.recipients.map(recipient => Object.freeze({ ...recipient,
        name: this.host.users().find(user => user.id === recipient.userId)?.name ?? recipient.userId, status: 'missing' as const }));
      const personalPhases = run.phase === 'preparing' ? [] : run.recipientStates?.filter(item => !item.terminal).map(item => sessionPlayback(recipientRun(run, item), Math.max(0, Math.round(this.host.now()))).phase);
      const personalPhase = personalPhases?.length ? (['paused', 'holding', 'playing', 'exiting'] as const).find(phase => personalPhases.includes(phase)) : undefined;
      const phase = run.phase === 'preparing' && participants.length > 0 && run.recipients.every(recipient => participants.some(
        report => report.userId === recipient.userId && report.sessionId === recipient.sessionId && report.status === 'ready'))
        ? 'ready' : personalPhase ?? sessionPlayback(run, Math.max(0, Math.round(this.host.now()))).phase;
      return Object.freeze({ run, phase: phase as CoordinatorPhase, participants });
    }));
  }
  get queue(): readonly LaunchRequest[] {
    return Object.freeze((this.currentState?.launches ?? []).filter(launch => !this.currentState?.runs.some(run => run.runId === launch.runId))
      .map(launch => {
        if (!this.unresolvedClaims.has(launch.launchId)) return launch;
        const { runId: _runId, ...unresolved } = launch;
        return Object.freeze({ ...unresolved, status: 'failed' as const, error: 'The reservation outcome is unconfirmed. Explicitly Retry or Cancel this launch.' });
      }));
  }
  getState(): OrchestrationState | null { return this.state; }
  getStatus(): CoordinatorStatus { return this.status; }

  async initialize(): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    try { await this.refresh(); } finally { this.schedulePoll(); }
  }

  /** All children and native hints share the same authoritative read. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.readInFlight) return this.readInFlight;
    const reading = this.host.store.read().then(state => {
      if (this.disposed) return;
      this.accept(state);
      this.lastReadAt = this.host.monotonicNow();
      if (this.error === this.readError) this.error = null;
      this.readError = null;
      this.checkDeadline();
    }).catch((error: unknown) => {
      this.fail(error); this.readError = this.error; this.checkDeadline(); throw error;
    });
    this.readInFlight = reading;
    void reading.finally(() => { if (this.readInFlight === reading) this.readInFlight = null; }).catch(() => {});
    return reading;
  }

  prepare(sequence: SequenceV1): Promise<void> { return this.admit(sequence).then(() => {}); }

  prepareAutomatic(sequence: SequenceV1, event: TriggerEvent, ruleId: string, intent = this.captureAutomaticIntent()): Promise<boolean> {
    if (!intent || !this.validAutomaticIntent(intent)) return Promise.resolve(false);
    try {
      const checkedEvent = validateTriggerEvent(event);
      if (!matchingTriggerRules(sequence, checkedEvent).some(rule => rule.id === ruleId)) return Promise.resolve(false);
      return this.admit(sequence, { event: structuredClone(checkedEvent), ruleId }, intent);
    } catch (error) { this.fail(error); return Promise.reject(error); }
  }

  private admit(sequence: SequenceV1, trigger?: NonNullable<LaunchRequest['trigger']>, automaticIntent?: AutomaticAdmissionIntent): Promise<boolean> {
    let snapshot: SequenceV1;
    let userIds: readonly string[];
    try {
      const compiled = compileSequence(sequence).snapshot;
      const audience = getSequenceAudience(compiled);
      const playerIds = audience.mode === 'all' ? this.host.users().filter(user => user.active && user.role < 3
        && user.id !== this.host.userId).map(user => user.id) : audience.userIds.filter(id => id !== this.host.userId);
      snapshot = withSequenceAudience(compiled, { ...audience, mode: 'selected', userIds: playerIds });
      userIds = Object.freeze([...new Set([...playerIds, ...(audience.includeGM ? [this.host.userId] : [])])]);
      if (!userIds.length) throw new CoordinatorError('SESSION_NO_RECIPIENTS', 'No selected viewer is available.');
    } catch (error) { this.fail(error); return Promise.reject(error); }
    return this.enqueue(async () => {
      try {
        if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) return false;
        this.requireGM(); await this.refresh();
        if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) return false;
        let state = this.requireState();
        if (trigger && (!this.canPrepareAutomatic || hasAutomaticAdmission(state, trigger.event.id, snapshot.id, trigger.ruleId))) return false;
        if (state.owner && !this.isOwner()) throw new CoordinatorError('SESSION_OWNED', 'Another GM session owns the controller.');
        if (state.version < 3 && (state.runs.length || state.launches.length)) throw new CoordinatorError('SESSION_ACTIVE', 'Explicitly stop or revoke legacy runs and cancel queued launches before upgrading to automatic playback.');
        if (!state.owner) {
          try { await this.append({ kind: 'acquire', sessionId: this.host.sessionId }, undefined, automaticIntent); }
          catch (error) {
            if (!trigger) throw error;
            await this.refresh();
            if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) return false;
            if (this.requireState().owner && !this.isOwner()) return false;
            throw error;
          }
        }
        if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) return false;
        let owner = this.requireOwner(); state = this.requireState();
        if (state.version === 1) await this.append({ kind: 'upgrade', sessionId: owner.sessionId, generation: owner.generation }, undefined, automaticIntent);
        if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) return false;
        if (this.requireState().version === 2) await this.append({ kind: 'upgrade3', sessionId: owner.sessionId, generation: owner.generation }, undefined, automaticIntent);
        if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) return false;
        if (isPersonalSequence(snapshot) && this.requireState().version === 3) {
          if (this.requireState().runs.length || this.requireState().launches.length) throw new CoordinatorError('SESSION_ACTIVE', 'Stop existing runs and cancel queued launches before enabling personal playback.');
          await this.append({ kind: 'upgrade4', sessionId: owner.sessionId, generation: owner.generation }, undefined, automaticIntent);
        }
        owner = this.requireOwner();
        await this.append({ kind: 'enqueue', sessionId: owner.sessionId, generation: owner.generation,
          launchId: this.host.makeId(), snapshot, userIds, mode: trigger ? 'automatic' : 'manual', ...(trigger ? { trigger } : {}) }, undefined, automaticIntent);
        if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) return false;
        this.pumpEnabled = true;
        await this.pump();
        if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) return false;
        return true;
      } catch (error) {
        if (error instanceof StaleAutomaticIntentError) return false;
        throw error;
      }
    });
  }

  startReady(runId: string): Promise<void> { return this.control(runId, 'start', async child => {
    const run = this.requireState().runs.find(entry => entry.runId === runId)!;
    const reports = child.participants;
    if (!run.recipients.every(recipient => reports.some(report => report.userId === recipient.userId
      && report.sessionId === recipient.sessionId && report.status === 'ready'))) {
      throw new CoordinatorError('SESSION_NOT_READY', 'All fixed participants must be ready before starting.');
    }
    await child.startReady();
  }); }
  pause(runId: string): Promise<void> { return this.control(runId, 'pause', child => child.pause()); }
  resume(runId: string): Promise<void> { return this.control(runId, 'resume', child => child.resume()); }
  continueFromBreak(runId: string): Promise<void> { return this.control(runId, 'continue', child => child.continueFromBreak()); }
  fade(runId: string): Promise<void> { return this.control(runId, 'fade', child => child.fade()); }
  stopGlobal(runId: string): Promise<void> { return this.control(runId, 'stop', child => child.stopGlobal()); }

  cancel(launchId: string): Promise<void> { return this.launchControl(launchId, 'cancel'); }
  retry(launchId: string): Promise<void> { return this.launchControl(launchId, 'retry'); }

  stopAll(): Promise<void> {
    const intent = this.ownerIntent();
    this.pumpEnabled = false;
    return this.enqueue(async () => {
      await this.pumpInFlight;
      await this.refresh(); this.checkOwnerIntent(intent); let owner = this.requireOwner();
      const runIds = this.requireState().runs.map(run => run.runId);
      const launchIds = this.requireState().launches.filter(launch => launch.status !== 'active').map(launch => launch.launchId);
      for (const runId of runIds) {
        if (!this.requireState().runs.some(run => run.runId === runId)) continue;
        await this.append({ kind: 'stop', sessionId: owner.sessionId, generation: owner.generation, runId });
      }
      for (const launchId of launchIds) {
        if (!this.requireState().launches.some(launch => launch.launchId === launchId)) continue;
        owner = this.requireOwner();
        await this.append({ kind: 'cancel', sessionId: owner.sessionId, generation: owner.generation, launchId });
      }
      this.pumpEnabled = true; await this.pump();
    });
  }
  release(): Promise<void> { return this.revokeController(true); }
  revoke(): Promise<void> { return this.revokeController(false); }

  exitLocal(): void { if (this.localRunId) this.children.get(this.localRunId)?.exitLocal(); }
  playbackFailed(error: unknown): void { if (this.localRunId) this.children.get(this.localRunId)?.playbackFailed(error); }

  activateButton(clipId: string, breakId?: string): Promise<void> {
    if (!this.localRunId || this.controllerLost || !this.children.get(this.localRunId)?.status.canExit) return Promise.reject(new CoordinatorError('SESSION_PHASE', 'No active local playback exists.'));
    return this.sendPersonalIntent(this.localRunId, 'button-activate', clipId, breakId).catch(error => { this.fail(error); throw error; });
  }
  playbackStateChanged(state: { readonly phase: string }): void { if (this.localRunId) this.children.get(this.localRunId)?.playbackStateChanged(state); }

  private async sendPersonalIntent(runId: string, kind: 'button-activate' | 'recipient-terminal', clipId?: string, breakId?: string): Promise<void> {
    const state = this.requireState(); const owner = state.owner;
    const run = state.runs.find(item => item.runId === runId);
    const participant = { userId: this.host.userId, sessionId: this.host.sessionId };
    const progress = run && recipientProgress(run, participant);
    if (!owner || !run || !progress || progress.terminal || !this.permittedLocalRuns.has(runId)) throw new CoordinatorError('SESSION_STALE', 'This browser is not an active personal recipient.');
    const request = { kind, targetSessionId: owner.sessionId, ownerSessionId: owner.sessionId,
      generation: owner.generation, protocolVersion: 7, runId, prepareRevision: run.prepareRevision,
      participantSessionId: this.host.sessionId, expectedRevision: progress.revision,
      ...(clipId !== undefined ? { clipId } : {}), ...(breakId !== undefined ? { breakId } : {}) };
    let response: Record<string, unknown> | null = null;
    let failure: unknown;
    try { response = object(this.isOwner() ? await this.handleQuery(request, this.host.userId)
      : await this.host.query(owner.userId, request, SESSION_TIMING.queryTimeoutMs)); }
    catch (error) { failure = error; }
    // An external card or terminal record may have committed despite a lost response.
    await this.refresh();
    const current = this.currentState?.runs.find(item => item.runId === runId);
    if (kind === 'recipient-terminal' && ((!current && this.currentState?.closedRuns.includes(runId)) || (current && recipientProgress(current, participant)?.terminal))) return;
    if (failure) throw failure;
    if (response?.kind !== 'accepted') throw new CoordinatorError('SESSION_ACTION_FAILED', typeof response?.error === 'string' ? response.error : 'The button action was rejected or its acknowledgement is unavailable.');
  }

  private handlePersonalQuery(request: Record<string, unknown>, senderId: string): Promise<unknown> {
    return this.enqueue(async () => {
      this.requireOwner(); await this.refresh();
      const state = this.requireState(); const owner = this.requireOwner();
      const run = state.runs.find(item => item.runId === request.runId);
      if (state.version !== 4 || request.protocolVersion !== 7 || request.ownerSessionId !== owner.sessionId
        || request.generation !== owner.generation || !run?.recipientStates || request.prepareRevision !== run.prepareRevision
        || typeof request.participantSessionId !== 'string' || !this.host.users().some(user => user.id === senderId)) throw new CoordinatorError('SESSION_STALE', 'The personal playback request is stale.');
      const participant = { userId: senderId, sessionId: request.participantSessionId };
      let progress = recipientProgress(run, participant);
      if (!progress || progress.terminal || progress.revision !== request.expectedRevision) throw new CoordinatorError('SESSION_CONFLICT', 'The recipient browser or action revision is stale.');
      const common = () => ({ sessionId: owner.sessionId, generation: owner.generation, runId: run.runId,
        participant, expectedRevision: progress!.revision, atServerMs: Math.round(this.host.now()) });
      if (request.kind === 'recipient-terminal') {
        await this.append({ kind: 'recipient-terminal', ...common() });
      } else {
        if (typeof request.clipId !== 'string' || (request.breakId !== undefined && typeof request.breakId !== 'string')) throw new CoordinatorError('SESSION_INVALID', 'A valid button and Break identity are required.');
        const button = eligibleButton(run, progress, request.clipId, request.breakId as string | undefined, Math.round(this.host.now()));
        const action = button.properties.action;
        const fields = { clipId: button.id, ...(request.breakId !== undefined ? { expectedBreakId: request.breakId as string } : {}) };
        const pending = progress.choices.find(choice => choice.status === 'pending');
        if (pending && (action.kind !== 'choice' || pending.clipId !== button.id)) throw new CoordinatorError('SESSION_CONFLICT', 'Complete the pending choice before choosing another option.');
        if (!pending) await this.append({ kind: 'button', ...common(), ...fields });
        if (action.kind === 'choice') {
          let latest = this.requireState().runs.find(item => item.runId === run.runId)!;
          progress = recipientProgress(latest, participant)!;
          const choice = progress.choices.find(item => item.status === 'pending' && item.clipId === button.id);
          if (!choice) throw new CoordinatorError('SESSION_CONFLICT', 'The choice is already confirmed.');
          if (!this.host.ensureButtonChoiceCard) throw new CoordinatorError('SESSION_CHAT_UNAVAILABLE', 'Choice cards are unavailable. Retry this choice when chat is available.');
          const card = await this.host.ensureButtonChoiceCard({ operationId: choice.operationId, runId: run.runId, participant,
            snapshot: run.snapshot, button, action });
          // Re-read after the external side effect. Pending identity is durable; retries reuse its operation ID.
          await this.refresh(); latest = this.requireState().runs.find(item => item.runId === run.runId)!;
          progress = latest && recipientProgress(latest, participant);
          if (!progress || !progress.choices.some(item => item.operationId === choice.operationId && item.status === 'pending')) throw new CoordinatorError('SESSION_CONFLICT', 'The pending choice changed before confirmation.');
          const command: PersonalCommand = { kind: 'choice-confirm', ...common(), ...fields, messageId: card.messageId };
          await this.append(command);
        }
      }
      this.pumpEnabled = true; await this.pump();
      return { kind: 'accepted' };
    }).catch((error: unknown) => ({ kind: 'error', error: error instanceof Error ? error.message : String(error) }));
  }

  /** The sender is authenticated native query context, never a payload field. */
  async handleQuery(data: unknown, senderId: string): Promise<unknown> {
    if (this.disposed) return { kind: 'unavailable' };
    const request = object(data);
    if (!request) return { kind: 'invalid' };
    if (request.kind === 'discover') {
      if (!this.host.users().some(user => user.id === senderId && user.role >= 3)) return { kind: 'unauthorized' };
      return { kind: 'discover', sessionId: this.host.sessionId, status: this.status.phase, protocolVersion: request.protocolVersion === 7 ? ORCHESTRATION_TRANSPORT_VERSION : 6 };
    }
    if (request.targetSessionId !== this.host.sessionId) return { kind: 'session-mismatch' };
    if (request.kind === 'button-activate' || request.kind === 'recipient-terminal') return this.handlePersonalQuery(request, senderId);
    if (request.kind !== 'prepare' && request.kind !== 'heartbeat') return { kind: 'invalid' };
    if (request.kind === 'prepare') await this.refresh();
    const transportVersion = this.currentState?.version === 2 ? 5 : this.currentState?.version === 4 ? 7 : 6;
    if (request.protocolVersion !== transportVersion) return { kind: 'unsupported' };
    const state = this.currentState;
    const owner = state?.owner;
    const run = state?.runs.find(entry => entry.runId === request.runId);
    if (!state || state.version < 2 || !owner || !run || senderId !== owner.userId
      || !this.host.users().some(user => user.id === senderId && user.role >= 3)
      || request.ownerSessionId !== owner.sessionId || request.generation !== owner.generation
      || request.prepareRevision !== run.prepareRevision || !this.includesSelf(run)) return { kind: 'stale' };
    if (request.kind === 'prepare' && run.phase === 'preparing' && !this.pastRuns.has(run.runId) && !this.controllerLost) {
      this.permittedLocalRuns.add(run.runId);
    }
    if (!this.permittedLocalRuns.has(run.runId)) return { kind: 'stale' };
    const child = this.child(run.runId);
    await child.refresh();
    return child.handleQuery(data, senderId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.children.values()) child.dispose();
    this.cancelTimer('pollTimer'); this.cancelTimer('deadlineTimer');
  }

  private control(runId: string, kind: SessionCommand['kind'], operation: (child: SessionCoordinator) => Promise<void>): Promise<void> {
    const generation = this.ownerIntent();
    const intendedRun = this.currentState?.runs.find(run => run.runId === runId);
    return this.enqueue(async () => {
      await this.refresh(); this.checkOwnerIntent(generation); this.requireOwner();
      const current = this.requireState().runs.find(run => run.runId === runId);
      if (!intendedRun || !current || JSON.stringify(intendedRun) !== JSON.stringify(current)) {
        throw new CoordinatorError('SESSION_CONFLICT', 'The selected run changed before this action could be submitted.');
      }
      const child = this.child(runId); await child.refresh();
      this.explicitControls.set(runId, kind);
      try { await operation(child); } finally { this.explicitControls.delete(runId); }
      this.pumpEnabled = true; await this.pump();
    });
  }

  private launchControl(launchId: string, kind: 'cancel' | 'retry'): Promise<void> {
    const generation = this.ownerIntent();
    const intended = this.currentState?.launches.find(launch => launch.launchId === launchId);
    return this.enqueue(async () => {
      await this.refresh(); this.checkOwnerIntent(generation); const owner = this.requireOwner();
      const current = this.requireState().launches.find(launch => launch.launchId === launchId);
      if (!intended || !current || JSON.stringify(intended) !== JSON.stringify(current)) {
        throw new CoordinatorError('SESSION_CONFLICT', 'The selected launch changed before this action could be submitted.');
      }
      if (kind === 'retry' && this.unresolvedClaims.has(launchId) && current.status === 'preparing' && current.runId) {
        await this.append({ kind: 'fail', sessionId: owner.sessionId, generation: owner.generation, launchId,
          runId: current.runId, error: 'The unconfirmed preparation attempt was explicitly closed before retrying.' });
      }
      await this.append({ kind, sessionId: owner.sessionId, generation: owner.generation, launchId });
      this.unresolvedClaims.delete(launchId);
      if (kind === 'retry') this.pastLaunches.delete(launchId);
      this.pumpEnabled = true; await this.pump();
    });
  }

  private revokeController(requireOwnership: boolean): Promise<void> {
    const generation = this.ownerIntent();
    return this.enqueue(async () => {
      this.requireGM(); await this.refresh(); this.checkOwnerIntent(generation);
      const owner = requireOwnership ? this.requireOwner(true) : this.requireState().owner;
      if (owner) await this.append({ kind: 'revoke', generation: owner.generation });
      this.controllerLost = false; this.pumpEnabled = false;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(async () => {
      if (this.disposed) throw new CoordinatorError('SESSION_DISPOSED', 'This session is closed.');
      this.error = null; const value = await operation(); this.changed(); return value;
    }).catch((error: unknown) => { this.fail(error); throw error; });
    this.commandTail = result.then(() => {}, () => {}); return result;
  }

  /** Only the writer chooses the current global head. It never retries an uncertain intent. */
  private append(command: OrchestrationCommand, child?: SessionCoordinator, automaticIntent?: AutomaticAdmissionIntent): Promise<void> {
    const result = this.writeTail.then(async () => {
      if (this.disposed) throw new CoordinatorError('SESSION_DISPOSED', 'This session is closed.');
      if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) throw new StaleAutomaticIntentError();
      if (this.controllerLost && command.kind !== 'revoke') throw new CoordinatorError('SESSION_CONTROLLER_LOST', 'Explicitly revoke the abandoned controller before continuing.');
      this.requireGM();
      const state = this.requireState();
      if (child && 'runId' in command && command.kind !== 'claim' && command.kind !== 'fail') {
        if (this.pastRuns.has(command.runId) && this.explicitControls.get(command.runId) !== command.kind) {
          throw new CoordinatorError('SESSION_NO_JOIN', 'Restored runs require an explicit control action; their timers cannot close them.');
        }
        const observed = child.state;
        const current = state.runs.find(run => run.runId === command.runId) ?? null;
        if (observed?.owner?.generation !== state.owner?.generation
          || (!current?.recipientStates && JSON.stringify(observed?.run ?? null) !== JSON.stringify(this.localProjection(current)))) {
          throw new CoordinatorError('SESSION_CONFLICT', 'The selected run changed before its command was written.');
        }
      }
      const accepted = await this.host.store.append(command, state.head);
      if (!this.disposed) { this.accept(accepted); this.lastReadAt = this.host.monotonicNow(); this.checkDeadline(); }
      if (automaticIntent && command.kind === 'acquire') {
        const captured = this.automaticIntents.get(automaticIntent)!;
        const acquired = this.requireState();
        const expectedEpoch = state.head + 1;
        if (captured.generation !== null || captured.epoch !== state.authorityEpoch || !this.isOwner()
          || acquired.authorityEpoch !== expectedEpoch || acquired.owner?.generation !== `${state.rootId}:${expectedEpoch}`) throw new StaleAutomaticIntentError();
        captured.epoch = expectedEpoch;
        captured.generation = acquired.owner.generation;
      }
      if (automaticIntent && !this.validAutomaticIntent(automaticIntent)) throw new StaleAutomaticIntentError();
    });
    this.writeTail = result.catch(() => {}); return result;
  }

  private accept(state: OrchestrationState): void {
    if (state.version !== 1 && state.version !== 2 && state.version !== 3 && state.version !== 4) throw new CoordinatorError('SESSION_INVALID', 'Unsupported orchestration state version.');
    if (this.currentState && this.currentState.rootId !== state.rootId) throw new CoordinatorError('SESSION_ROOT_CHANGED', 'The controller root changed.');
    if (!Number.isSafeInteger(state.head) || state.head < 0) throw new CoordinatorError('SESSION_INVALID', 'Invalid orchestration head.');
    if (this.currentState && state.head <= this.currentState.head) return;
    state = normalizeOrchestrationState(state);
    const previous = this.currentState;
    if (!previous) {
      for (const run of state.runs) this.pastRuns.add(run.runId);
      // A Prepare RPC may commit after this first read; its claimed ID already belongs to the old session.
      for (const launch of state.launches) if (launch.runId) this.pastRuns.add(launch.runId);
      for (const launch of state.launches) this.pastLaunches.add(launch.launchId);
    }
    this.currentState = state;
    if (previous?.owner?.generation !== state.owner?.generation) {
      if (previous?.owner) for (const child of this.children.values()) child.exitLocal();
      this.controllerLost = false;
    }
    for (const [runId, child] of this.children) {
      if (!state.runs.some(run => run.runId === runId) && !state.launches.some(launch => launch.runId === runId && launch.status === 'preparing')) {
        child.dispose(); this.children.delete(runId);
      } else void child.refresh().catch(error => this.fail(error));
    }
    if (this.isOwner()) for (const run of state.runs) {
      if (!this.pastRuns.has(run.runId) && !this.children.has(run.runId)) { const child = this.child(run.runId); void child.refresh().catch(error => this.fail(error)); }
    }
    this.changed();
    if (this.pumpEnabled && this.isOwner() && !this.controllerLost) void this.pump().catch(error => this.fail(error));
  }

  private localProjection(run: SessionRun | null): SessionRun | null {
    if (!run || this.permittedLocalRuns.has(run.runId)) return run;
    // Projection prevents a reloaded owner from adopting its old surface; the authoritative record is unchanged.
    if (!this.includesSelf(run)) return run;
    const keep = (recipient: { userId: string; sessionId: string }) => !(recipient.userId === this.host.userId && recipient.sessionId === this.host.sessionId);
    return { ...run, recipients: run.recipients.filter(keep), ...(run.recipientStates ? { recipientStates: run.recipientStates.filter(keep) } : {}) };
  }

  private scoped(runId: string): SessionState {
    const state = scopedSession(this.requireState(), runId);
    return { ...state, run: this.localProjection(state.run) };
  }

  private child(runId: string): SessionCoordinator {
    const existing = this.children.get(runId); if (existing) return existing;
    const playback = this.host.playback;
    let child!: SessionCoordinator;
    const guarded: CoordinatorHost['playback'] = {
      ...(playback.validateTarget ? { validateTarget: (sequence: SequenceV1) => playback.validateTarget!(sequence) } : {}),
      prepare: async (sequence, signal) => {
        this.claimLocal(runId);
        if (playback.prepare) await playback.prepare(sequence, signal);
      },
      start: async (sequence, anchor) => { this.claimLocal(runId); await playback.start(sequence, anchor); },
      applyAnchor: anchor => { if (this.localRunId === runId && !this.controllerLost) playback.applyAnchor(anchor); },
      stop: () => { if (this.localRunId === runId) playback.stop(); }
    };
    const coordinator = this;
    child = new SessionCoordinator({ ...this.host, get isGM() { return coordinator.isCurrentGM(); }, transportVersion: this.requireState().version === 2 ? 5 : this.requireState().version === 4 ? 7 : 6,
      store: { read: async () => { await this.refresh(); return this.scoped(runId); },
        append: async (command: SessionCommand) => { await this.append(command, child); return this.scoped(runId); } },
      makeId: () => runId, playback: guarded,
      onPlaybackTerminal: id => this.sendPersonalIntent(id, 'recipient-terminal'),
      onChange: () => { this.childChanged(runId, child); } });
    this.children.set(runId, child);
    child.startPolling();
    return child;
  }

  private claimLocal(runId: string): void {
    if (!this.permittedLocalRuns.has(runId) || this.pastRuns.has(runId) || this.controllerLost || this.disposed) {
      throw new CoordinatorError('SESSION_NO_JOIN', 'This browser did not prepare the current run.');
    }
    if (this.localRunId !== runId && this.localRunId && this.children.get(this.localRunId)?.status.canExit) {
      throw new CoordinatorError('SESSION_ACTIVE', 'This browser already has a group playback surface.');
    }
    this.localRunId = runId;
  }

  private childChanged(runId: string, child: SessionCoordinator): void {
    if (child?.lastError && (child.lastError as { code?: string }).code === 'SESSION_CONTROLLER_LOST') this.loseController();
    this.changed();
    if (!this.isOwner() || this.controllerLost || this.disposed || this.pastRuns.has(runId)) return;
    const state = this.currentState;
    const launch = state?.launches.find(entry => entry.runId === runId && entry.status === 'preparing');
    const run = state?.runs.find(entry => entry.runId === runId);
    if (!launch || !run || this.failingLaunches.has(launch.launchId)) return;
    const failed = child.participants.find(report => run.recipients.some(recipient => recipient.userId === report.userId
      && recipient.sessionId === report.sessionId) && (report.status === 'failed' || report.status === 'missing'));
    // Media preflight/audio gates own their deadlines. A ready manual launch may wait for the GM indefinitely.
    if (failed) void this.failLaunch(launch, failed.error ?? 'A fixed participant did not become ready.').catch(error => this.fail(error));
    else if (launch.mode === 'automatic' && run.recipients.every(recipient => child.participants.some(report =>
      report.userId === recipient.userId && report.sessionId === recipient.sessionId && report.status === 'ready'))) {
      this.startAutomatic(launch, run, child);
    }
  }

  private startAutomatic(launch: LaunchRequest, run: SessionRun, child: SessionCoordinator): void {
    if (this.automaticStartAttempts.has(run.runId)) return;
    this.automaticStartAttempts.add(run.runId);
    const generation = this.ownerIntent();
    void this.enqueue(async () => {
      await this.refresh();
      if (!this.isOwner() || this.controllerLost || this.ownerIntent() !== generation || this.pastRuns.has(run.runId)) return;
      const current = this.currentState?.runs.find(item => item.runId === run.runId);
      const admission = this.currentState?.launches.find(item => item.launchId === launch.launchId);
      if (!current || current.phase !== 'preparing' || current.prepareRevision !== run.prepareRevision
        || admission?.runId !== run.runId || admission.status !== 'preparing') return;
      await child.refresh();
      if (!current.recipients.every(recipient => child.participants.some(report => report.userId === recipient.userId
        && report.sessionId === recipient.sessionId && report.status === 'ready'))) return;
      await child.startReady();
    }).catch(error => this.fail(error));
  }

  private async failLaunch(launch: LaunchRequest, message: string): Promise<void> {
    if (!launch.runId || this.failingLaunches.has(launch.launchId)) return;
    this.failingLaunches.add(launch.launchId);
    try {
      const current = this.currentState?.launches.find(entry => entry.launchId === launch.launchId);
      if (current?.runId !== launch.runId || current.status !== 'preparing' || !this.isOwner() || this.controllerLost) return;
      const owner = this.requireOwner();
      await this.append({ kind: 'fail', sessionId: owner.sessionId, generation: owner.generation,
        launchId: launch.launchId, runId: launch.runId,
        error: (message.trim() || 'A fixed participant did not become ready.').slice(0, ORCHESTRATION_LIMITS.errorLength) });
    } finally { this.failingLaunches.delete(launch.launchId); }
  }

  private pump(): Promise<void> {
    if (this.pumpInFlight) return this.pumpInFlight;
    const pumping = Promise.resolve().then(async () => {
      while (!this.disposed && this.pumpEnabled && this.isOwner() && !this.controllerLost) {
        const launch = eligibleLaunches(this.requireState()).find(item => !this.pastLaunches.has(item.launchId) && !this.unresolvedClaims.has(item.launchId)); if (!launch) break;
        const owner = this.requireOwner(); const runId = this.host.makeId();
        this.unresolvedClaims.add(launch.launchId);
        await this.append({ kind: 'claim', sessionId: owner.sessionId, generation: owner.generation, launchId: launch.launchId, runId });
        this.unresolvedClaims.delete(launch.launchId);
        this.permittedLocalRuns.add(runId);
        const child = this.child(runId);
        // Preparation may await a slow native query. Independent launches and Cancel remain available.
        const preparing = child.prepare(launch.snapshot).catch(async (error: unknown) => {
          const current = this.currentState?.launches.find(entry => entry.launchId === launch.launchId);
          if (current?.runId === runId && current.status === 'preparing') {
            await this.failLaunch(current, error instanceof Error ? error.message : String(error)); this.fail(error);
          }
        });
        void preparing.catch(error => this.fail(error));
      }
    }).catch((error: unknown) => {
      // A rejected or uncertain claim is an unresolved intent. Polling never replays it.
      this.pumpEnabled = false;
      throw error;
    });
    this.pumpInFlight = pumping;
    void pumping.finally(() => {
      if (this.pumpInFlight === pumping) this.pumpInFlight = null;
      if (!this.disposed && this.pumpEnabled && this.isOwner() && !this.controllerLost && eligibleLaunches(this.requireState()).some(item => !this.pastLaunches.has(item.launchId) && !this.unresolvedClaims.has(item.launchId))) {
        void this.pump().catch(error => this.fail(error));
      }
    }).catch(() => {});
    return pumping;
  }

  private checkDeadline(): void {
    this.cancelTimer('deadlineTimer');
    if (this.disposed || this.controllerLost || !this.currentState?.owner || !this.currentState.runs.length) return;
    const remaining = SESSION_TIMING.controllerTimeoutMs - (this.host.monotonicNow() - this.lastReadAt);
    if (remaining <= 0) this.loseController();
    else this.deadlineTimer = this.host.schedule(() => { this.deadlineTimer = null; this.checkDeadline(); }, remaining);
  }
  private loseController(): void {
    if (this.controllerLost) return;
    this.controllerLost = true; this.pumpEnabled = false;
    this.error = new CoordinatorError('SESSION_CONTROLLER_LOST', 'The controller connection expired. Explicitly revoke the abandoned generation.');
    for (const child of this.children.values()) child.exitLocal();
    this.changed();
  }
  private schedulePoll(): void {
    if (this.disposed || !this.initialized) return;
    this.pollTimer = this.host.schedule(() => {
      this.pollTimer = null;
      void this.refresh().catch(() => {}).finally(() => {
        for (const [runId, child] of this.children) this.childChanged(runId, child);
        this.schedulePoll();
      });
    }, SESSION_TIMING.pollMs);
  }
  private ownerIntent(): string | null { return this.currentState?.owner?.generation ?? null; }
  private validAutomaticIntent(intent: AutomaticAdmissionIntent): boolean {
    const captured = this.automaticIntents.get(intent);
    const state = this.currentState;
    return !!captured && !!state && this.canPrepareAutomatic && state.authorityEpoch === captured.epoch
      && (state.owner?.generation ?? null) === captured.generation;
  }
  private checkOwnerIntent(generation: string | null): void {
    if (this.ownerIntent() !== generation) throw new CoordinatorError('SESSION_CONFLICT', 'Controller ownership changed before this action could be submitted.');
  }
  private includesSelf(run: SessionRun): boolean { return run.recipients.some(recipient => recipient.userId === this.host.userId && recipient.sessionId === this.host.sessionId); }
  private isCurrentGM(): boolean { return this.host.isGM && this.host.users().some(user => user.id === this.host.userId && user.role >= 3); }
  private isOwner(): boolean { return this.currentState?.owner?.userId === this.host.userId && this.currentState.owner.sessionId === this.host.sessionId; }
  private requireGM(): void { if (!this.isCurrentGM()) throw new CoordinatorError('SESSION_UNAUTHORIZED', 'Only a current GM can control group playback.'); }
  private requireState(): OrchestrationState { if (!this.currentState) throw new CoordinatorError('SESSION_UNAVAILABLE', 'The session ledger has not been read.'); return this.currentState; }
  private requireOwner(allowLost = false) {
    this.requireGM();
    if (!this.isOwner()) throw new CoordinatorError('SESSION_NOT_OWNER', 'This GM session does not own the controller.');
    if (this.controllerLost && !allowLost) throw new CoordinatorError('SESSION_CONTROLLER_LOST', 'Explicitly revoke the abandoned controller before continuing.');
    return this.requireState().owner!;
  }
  private changed(): void { try { this.host.onChange?.(); } catch { /* Observers cannot block release. */ } }
  private fail(error: unknown): void { this.error = error instanceof Error ? error : new Error(String(error)); this.changed(); }
  private cancelTimer(field: 'pollTimer' | 'deadlineTimer'): void {
    const timer = this[field]; this[field] = null;
    if (timer !== null) { try { this.host.cancel(timer); } catch { /* State guards invalidate late callbacks. */ } }
  }
}
