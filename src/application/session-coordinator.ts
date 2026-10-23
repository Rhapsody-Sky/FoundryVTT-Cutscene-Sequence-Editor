import type { SequenceV1 } from '../domain/sequence.js';
import { getPlaybackSchemaVersion } from '../domain/sequence-audience.js';
import { resolveSequenceAudience } from './audience-resolver.js';
import { compileSequence } from '../playback/evaluate.js';
import { isPersonalSequence, recipientProgress, recipientRun, type ButtonChoiceCardInput } from '../playback/personal-progression.js';
import type { PlaybackAnchor } from '../playback/local-player.js';
import { SESSION_TIMING, sessionAnchor, sessionPlayback, type Participant, type SessionCommand, type SessionRun, type SessionState } from '../playback/session-protocol.js';

export interface CoordinatorHost {
  readonly userId: string;
  readonly sessionId: string;
  readonly isGM: boolean;
  /** A scoped orchestration run requires exact multi-run capability; legacy remains version 4. */
  readonly transportVersion?: 4 | 5 | 6 | 7;
  ensureButtonChoiceCard?(input: ButtonChoiceCardInput): Promise<{ messageId: string }>;
  onPlaybackTerminal?(runId: string): Promise<void>;
  users(): readonly { id: string; name: string; role: number; active: boolean }[];
  readonly store: {
    read(): Promise<SessionState>;
    append(command: SessionCommand, expectedHead: number): Promise<SessionState>;
  };
  now(): number;
  monotonicNow(): number;
  makeId(): string;
  query(userId: string, data: unknown, timeoutMs: number): Promise<unknown>;
  readonly playback: {
    validateTarget?(sequence: SequenceV1): void;
    prepare?(sequence: SequenceV1, signal: AbortSignal): Promise<void>;
    start(sequence: SequenceV1, anchor: PlaybackAnchor): Promise<void>;
    applyAnchor(anchor: PlaybackAnchor): void;
    stop(): void;
  };
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
  onChange?(): void;
}

export type CoordinatorPhase = 'idle' | 'preparing' | 'ready' | 'scheduled' | 'playing' | 'holding' | 'paused' | 'exiting' | 'exited' | 'failed';
export interface CoordinatorParticipantStatus extends Participant {
  readonly name: string;
  readonly status: CoordinatorPhase | 'missing';
  readonly error?: string;
  readonly positionMs?: number;
  readonly breakId?: string;
  readonly revision?: number;
  readonly terminal?: boolean;
}
export interface CoordinatorStatus {
  readonly phase: CoordinatorPhase;
  readonly runId: string | null;
  readonly isOwner: boolean;
  readonly canExit: boolean;
  readonly error: string | null;
}

export class CoordinatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CoordinatorError';
  }
}

const phases = new Set<CoordinatorPhase>(['idle', 'preparing', 'ready', 'scheduled', 'playing', 'holding', 'paused', 'exiting', 'exited', 'failed']);
const SESSION_TRANSPORT_VERSION = 4;
function supportedTransport(snapshot: SequenceV1, version: unknown, requiredVersion: 4 | 5 | 6 | 7 = 4): boolean {
  if (requiredVersion >= 5) return version === requiredVersion;
  if (snapshot.schemaVersion === 4) return version === SESSION_TRANSPORT_VERSION;
  if (version === 3 || version === SESSION_TRANSPORT_VERSION) return true;
  return getPlaybackSchemaVersion(snapshot) !== 3 && version === undefined;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function key(participant: Participant): string { return JSON.stringify([participant.userId, participant.sessionId]); }
function sameParticipant(left: Participant, right: Participant): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId;
}

/** Orchestrates one tab. Only the injected player owns drawing or overlay resources. */
export class SessionCoordinator {
  private currentState: SessionState | null = null;
  private localPhase: CoordinatorPhase = 'idle';
  private localRunId: string | null = null;
  private error: Error | null = null;
  private readError: Error | null = null;
  private readonly exitedRuns = new Set<string>();
  private readonly preparedRuns = new Set<string>();
  private readonly reports = new Map<string, CoordinatorParticipantStatus>();
  private readInFlight: Promise<void> | null = null;
  private commandTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private polling = false;
  private pollTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private startTimer: unknown = null;
  private endTimer: unknown = null;
  private deadlineTimer: unknown = null;
  private playbackRunId: string | null = null;
  private startToken = 0;
  private lastReadAt: number;
  private lastHeartbeatAt: number;
  private heartbeatInFlight = false;
  private readonly automaticStops = new Set<string>();
  private readonly completedRuns = new Set<string>();
  private terminalInFlight = false;
  private localPreparation: { readonly runId: string; readonly controller: AbortController } | null = null;

  constructor(private readonly host: CoordinatorHost) {
    this.lastReadAt = host.monotonicNow();
    this.lastHeartbeatAt = this.lastReadAt;
  }

  get state(): SessionState | null { return this.currentState; }
  get runPhase(): SessionRun['phase'] | null {
    const run = this.currentState?.run;
    return run ? sessionPlayback(recipientRun(run, this.self()), Math.max(0, Math.round(this.host.now()))).phase : null;
  }
  get lastError(): Error | null { return this.error; }
  get status(): CoordinatorStatus {
    const phase = this.localPhase === 'playing' && this.currentState?.run?.runId === this.localRunId
      ? this.runPhase as CoordinatorPhase : this.localPhase;
    return Object.freeze({ phase, runId: this.localRunId, isOwner: this.isOwner(),
      canExit: ['preparing', 'ready', 'scheduled', 'playing', 'holding', 'paused', 'exiting'].includes(phase),
      error: this.error?.message ?? null });
  }
  get participants(): readonly CoordinatorParticipantStatus[] {
    const run = this.currentState?.run;
    return Object.freeze([...this.reports.values()].map(report => {
      const progress = run ? recipientProgress(run, report) : undefined;
      if (!run || !progress) return report;
      const playback = sessionPlayback(recipientRun(run, report), Math.round(this.host.now()));
      return Object.freeze({ ...report, positionMs: playback.positionMs, ...(playback.breakId ? { breakId: playback.breakId } : {}), revision: progress.revision, terminal: progress.terminal });
    }));
  }
  getState(): SessionState | null { return this.state; }
  getStatus(): CoordinatorStatus { return this.status; }

  async initialize(): Promise<void> {
    try { await this.refresh(); } finally { this.startPolling(); }
  }

  startPolling(): void {
    if (this.polling || this.disposed) return;
    this.polling = true;
    this.schedulePoll();
    this.scheduleHeartbeat();
  }

  /** Concurrent hints share one read; only a newer head of the original root is accepted. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.readInFlight) return this.readInFlight;
    const operation = this.host.store.read().then(state => {
      if (this.disposed) return;
      this.checkRoot(state);
      this.lastReadAt = this.host.monotonicNow();
      this.accept(state);
      if (state.run && this.completedRuns.has(state.run.runId) && !recipientProgress(state.run, this.self())?.terminal) this.notifyTerminal(state.run.runId);
      if (this.readError && this.error === this.readError) { this.error = null; this.changed(); }
      this.readError = null;
      this.checkDeadline();
    }).catch((error: unknown) => {
      this.fail(error);
      this.readError = this.error;
      this.checkDeadline();
      throw error;
    });
    this.readInFlight = operation;
    void operation.finally(() => { if (this.readInFlight === operation) this.readInFlight = null; }).catch(() => {});
    return operation;
  }

  prepare(sequence: SequenceV1): Promise<void> {
    // Reject unsupported content before acquiring ownership or disturbing the current run.
    let snapshot: SequenceV1;
    try {
      snapshot = compileSequence(sequence).snapshot;
      if (isPersonalSequence(snapshot) && this.host.transportVersion !== 7) throw new CoordinatorError('SESSION_UNSUPPORTED', 'Personal progression requires the versioned orchestration controller.');
    } catch (error) { this.fail(error); return Promise.reject(error); }
    return this.enqueue(async () => {
      this.requireGM();
      await this.refresh();
      const state = this.requireState();
      if (state.owner && !this.isOwner()) throw new CoordinatorError('SESSION_OWNED', 'Another GM session owns the controller.');
      if (state.run) throw new CoordinatorError('SESSION_ACTIVE', 'Stop the active run before preparing another sequence.');
      const audience = resolveSequenceAudience(snapshot, this.host.users(), this.host.userId);
      // Empty, offline or removed selections never expand into the default audience.
      if (!audience.includeGM && !audience.players.length) {
        this.reports.clear();
        for (const user of audience.unavailable) this.setReport({ userId: user.userId, sessionId: '' }, 'missing',
          `SESSION_RECIPIENT_${user.reason.toUpperCase().replace('-', '_')}`);
        throw new CoordinatorError('SESSION_NO_RECIPIENTS', 'No selected viewer is available.');
      }
      if (!state.owner) await this.append({ kind: 'acquire', sessionId: this.host.sessionId });
      this.requireOwner();
      const recipients: Participant[] = audience.includeGM ? [this.self()] : [];
      const users = audience.players;
      const missing = audience.unavailable.map(user => ({ participant: { userId: user.userId, sessionId: '' },
        error: `SESSION_RECIPIENT_${user.reason.toUpperCase().replace('-', '_')}` }));
      const discovered = await Promise.allSettled(users.map(async user => {
        const response = object(await this.host.query(user.id, { kind: 'discover', ...(this.host.transportVersion ? { protocolVersion: this.host.transportVersion } : {}) }, SESSION_TIMING.queryTimeoutMs));
        if (response?.kind !== 'discover' || typeof response.sessionId !== 'string' || !response.sessionId
          || !supportedTransport(snapshot, response.protocolVersion, this.host.transportVersion)) return null;
        return { userId: user.id, sessionId: response.sessionId } satisfies Participant;
      }));
      for (const [index, result] of discovered.entries()) {
        if (result.status === 'fulfilled' && result.value) recipients.push(result.value);
        else missing.push({ participant: { userId: users[index]!.id, sessionId: '' }, error: 'SESSION_RECIPIENT_UNAVAILABLE' });
      }
      if (!recipients.length) {
        this.reports.clear();
        for (const entry of missing) this.setReport(entry.participant, 'missing', entry.error);
        throw new CoordinatorError('SESSION_NO_RECIPIENTS', 'No selected viewer could be discovered.');
      }
      const owner = this.requireOwner();
      const runId = this.host.makeId();
      await this.append({ kind: 'prepare', sessionId: owner.sessionId, generation: owner.generation, runId, snapshot, recipients });
      for (const entry of missing) this.setReport(entry.participant, 'missing', entry.error);
      this.changed();
      const run = this.requireRun('preparing');
      await this.queryRecipients(run, 'prepare');
    });
  }

  startReady(): Promise<void> {
    const intent = this.runIntent();
    return this.enqueue(async () => {
      this.checkRunIntent(intent);
      const owner = this.requireOwner();
      const run = this.requireRun('preparing');
      const recipients = run.recipients.filter(participant => this.reports.get(key(participant))?.status === 'ready');
      if (!recipients.length) throw new CoordinatorError('SESSION_NOT_READY', 'No participant is ready for this run.');
      await this.append({ kind: 'start', sessionId: owner.sessionId, generation: owner.generation, runId: run.runId,
        recipients, atServerMs: this.host.now() + SESSION_TIMING.startLeadMs });
    });
  }

  pause(): Promise<void> {
    if (this.currentState?.run?.recipientStates) return this.personalControl('pause');
    const intent = this.runIntent();
    return this.enqueue(async () => {
      this.checkRunIntent(intent);
      const owner = this.requireOwner(); const run = this.requireRun();
      const atServerMs = Math.round(this.host.now());
      const playback = sessionPlayback(run, atServerMs);
      if (playback.phase !== 'playing' && playback.phase !== 'holding') throw new CoordinatorError('SESSION_PHASE', 'Pause requires playing or holding.');
      this.requireBeforeNaturalExit(run);
      await this.append({ kind: 'pause', sessionId: owner.sessionId, generation: owner.generation,
        runId: run.runId, positionMs: Math.round(playback.positionMs),
        ...(getPlaybackSchemaVersion(run.snapshot) === 3 ? { atServerMs } : {}),
        ...(playback.breakId !== undefined ? { breakId: playback.breakId } : {}),
        ...(playback.phase === 'holding' ? { atServerMs, holdElapsedMs: playback.holdElapsedMs!, pausedFrom: 'holding' as const } : {}) });
    });
  }

  resume(): Promise<void> {
    if (this.currentState?.run?.recipientStates) return this.personalControl('resume');
    const intent = this.runIntent();
    return this.enqueue(async () => {
      this.checkRunIntent(intent);
      const owner = this.requireOwner(); const run = this.requireRun('paused');
      this.requireBeforeNaturalExit(run);
      await this.append({ kind: 'resume', sessionId: owner.sessionId, generation: owner.generation,
        runId: run.runId, positionMs: run.positionMs, atServerMs: Math.round(this.host.now()) });
    });
  }

  fade(durationMs?: number): Promise<void> {
    if (this.currentState?.run?.recipientStates) return this.personalControl('fade', durationMs);
    const intent = this.runIntent();
    return this.enqueue(async () => {
      this.checkRunIntent(intent);
      const owner = this.requireOwner(); const run = this.requireRun();
      if (run.phase === 'exiting') return;
      if (run.phase === 'preparing') throw new CoordinatorError('SESSION_NOT_STARTED', 'Start or stop the prepared run first.');
      this.requireBeforeNaturalExit(run);
      const atServerMs = Math.round(this.host.now());
      const playback = sessionPlayback(run, atServerMs);
      const exitFrom = playback.phase === 'holding' ? 'holding' as const : run.pausedFrom === 'holding' ? 'paused-holding' as const
        : playback.phase === 'paused' && getPlaybackSchemaVersion(run.snapshot) !== 1 ? 'paused' as const : undefined;
      await this.append({ kind: 'fade', sessionId: owner.sessionId, generation: owner.generation, runId: run.runId,
        positionMs: Math.round(playback.positionMs), atServerMs, durationMs: durationMs ?? run.snapshot.presentation.exitDurationMs,
        ...(exitFrom ? { exitFrom } : {}),
        ...(playback.breakId !== undefined ? { breakId: playback.breakId } : {}),
        ...(exitFrom === 'holding' || exitFrom === 'paused-holding' ? { holdElapsedMs: playback.holdElapsedMs! } : {}) });
    });
  }

  continueFromBreak(): Promise<void> {
    if (this.currentState?.run?.recipientStates) return this.personalControl('continue');
    const intent = this.runIntent();
    const intendedRun = this.currentState?.run;
    const intendedPlayback = intendedRun ? sessionPlayback(intendedRun, Math.round(this.host.now())) : null;
    const breakIntent = { id: intendedPlayback?.breakId, length: intendedRun?.breakHistory?.length };
    return this.enqueue(async () => {
      this.checkRunIntent(intent);
      const owner = this.requireOwner(); const run = this.requireRun();
      const atServerMs = Math.round(this.host.now());
      const playback = sessionPlayback(run, atServerMs);
      const exitFrom = playback.phase === 'holding' ? 'holding' as const
        : playback.phase === 'paused' && playback.pausedFrom === 'holding' ? 'paused-holding' as const : undefined;
      if (!exitFrom) throw new CoordinatorError('SESSION_PHASE', 'Continue requires a Break.');
      if (getPlaybackSchemaVersion(run.snapshot) === 3 && (breakIntent.id !== playback.breakId || breakIntent.length !== run.breakHistory?.length)) {
        throw new CoordinatorError('SESSION_CONFLICT', 'The Break changed before Continue could be submitted.');
      }
      await this.append({ kind: 'continue', sessionId: owner.sessionId, generation: owner.generation, runId: run.runId,
        positionMs: playback.positionMs, atServerMs, durationMs: run.snapshot.presentation.exitDurationMs,
        holdElapsedMs: playback.holdElapsedMs!, exitFrom,
        ...(getPlaybackSchemaVersion(run.snapshot) === 3 ? { expectedBreakHistoryLength: breakIntent.length! } : {}),
        ...(playback.breakId !== undefined ? { breakId: playback.breakId } : {}) });
    });
  }

  private personalControl(kind: 'pause' | 'resume' | 'continue' | 'fade', durationMs?: number): Promise<void> {
    const intent = this.runIntent();
    return this.enqueue(async () => {
      this.checkRunIntent(intent); const owner = this.requireOwner(); const run = this.requireRun();
      if (run.phase === 'preparing') throw new CoordinatorError('SESSION_PHASE', 'Start the prepared run first.');
      const common = { sessionId: owner.sessionId, generation: owner.generation, runId: run.runId, positionMs: 0, atServerMs: Math.round(this.host.now()) };
      await this.append(kind === 'continue' || kind === 'fade' ? { kind, ...common, durationMs: durationMs ?? run.snapshot.presentation.exitDurationMs } : { kind, ...common });
    });
  }

  /** Natural playback completion is distinct from a user emergency exit. */
  playbackStateChanged(state: { readonly phase: string }): void {
    if (state.phase !== 'ended' || !this.localRunId || this.exitedRuns.has(this.localRunId)) return;
    const run = this.currentState?.run;
    if (!run?.recipientStates || run.runId !== this.localRunId) return;
    this.completedRuns.add(run.runId);
    this.exitLocal();
    this.notifyTerminal(run.runId);
  }
  private notifyTerminal(runId: string): void {
    if (this.terminalInFlight || !this.host.onPlaybackTerminal || this.disposed) return;
    this.terminalInFlight = true;
    void this.host.onPlaybackTerminal(runId).catch(error => this.fail(error)).finally(() => { this.terminalInFlight = false; });
  }

  stopGlobal(): Promise<void> {
    const intent = this.runIntent();
    return this.enqueue(async () => {
      this.checkRunIntent(intent);
      const owner = this.requireOwner(); const run = this.currentState?.run;
      if (!run) return;
      await this.append({ kind: 'stop', sessionId: owner.sessionId, generation: owner.generation, runId: run.runId });
    });
  }

  release(): Promise<void> {
    const generation = this.currentState?.owner?.generation ?? null;
    return this.enqueue(async () => {
      this.checkOwnerIntent(generation);
      const owner = this.requireOwner();
      await this.append({ kind: 'revoke', generation: owner.generation });
    });
  }

  /** Explicit user action; never called by polling or controller-loss recovery. */
  revoke(): Promise<void> {
    const generation = this.currentState?.owner?.generation ?? null;
    return this.enqueue(async () => {
      this.requireGM();
      this.checkOwnerIntent(generation);
      const owner = this.requireState().owner;
      if (owner) await this.append({ kind: 'revoke', generation: owner.generation });
    });
  }

  exitLocal(): void {
    const runId = this.localRunId;
    if (runId) this.exitedRuns.add(runId);
    this.cancelLocalPreparation();
    this.cancelTimer('startTimer'); this.cancelTimer('deadlineTimer');
    this.startToken += 1;
    this.playbackRunId = null;
    try { this.host.playback.stop(); } catch (error) { this.fail(error); }
    if (runId) this.localPhase = 'exited';
    this.reportSelf(); this.changed();
  }

  /** The player may fail on a later frame, after its start promise has resolved. */
  playbackFailed(error: unknown): void {
    if (this.disposed || !this.localRunId || this.exitedRuns.has(this.localRunId)) return;
    this.fail(error);
    this.exitLocal();
    this.localPhase = 'failed';
    this.reportSelf(); this.changed();
  }

  /** senderId MUST come from native query context, never from data supplied by a socket. */
  async handleQuery(data: unknown, senderId: string): Promise<unknown> {
    if (this.disposed) return { kind: 'unavailable' };
    const request = object(data);
    if (!request) return { kind: 'invalid' };
    if (request.kind === 'discover') {
      if (!this.host.users().some(user => user.id === senderId && user.role >= 3)) return { kind: 'unauthorized' };
      return { kind: 'discover', sessionId: this.host.sessionId, status: this.status.phase, protocolVersion: this.host.transportVersion ?? SESSION_TRANSPORT_VERSION };
    }
    if (request.targetSessionId !== this.host.sessionId) return { kind: 'session-mismatch' };
    if (request.kind !== 'prepare' && request.kind !== 'heartbeat') return { kind: 'invalid' };
    // A native hint can prompt a ledger read; it does not itself confer ownership.
    if (request.kind === 'prepare') await this.refresh();
    const owner = this.currentState?.owner; const run = this.currentState?.run;
    if (run && !supportedTransport(run.snapshot, request.protocolVersion, this.host.transportVersion)) return { kind: 'unsupported' };
    if (!owner || !run || senderId !== owner.userId || request.ownerSessionId !== owner.sessionId
      || request.generation !== owner.generation || request.runId !== run.runId
      || request.prepareRevision !== run.prepareRevision || !this.includesSelf(run)) return { kind: 'stale' };
    if (request.kind === 'heartbeat' && this.localRunId === run.runId && !this.exitedRuns.has(run.runId)) {
      this.lastHeartbeatAt = this.host.monotonicNow();
      this.checkDeadline();
    }
    return { kind: 'status', runId: run.runId, prepareRevision: run.prepareRevision, sessionId: this.host.sessionId,
      status: this.localRunId === run.runId ? this.status.phase : 'missing', ...(this.error ? { error: this.error.message } : {}) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.polling = false;
    this.exitLocal();
    this.cancelTimer('pollTimer'); this.cancelTimer('heartbeatTimer'); this.cancelTimer('endTimer');
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.commandTail.then(async () => {
      if (this.disposed) throw new CoordinatorError('SESSION_DISPOSED', 'This session is closed.');
      this.error = null;
      await operation();
      this.changed();
    }).catch((error: unknown) => { this.fail(error); throw error; });
    this.commandTail = result.catch(() => {});
    return result;
  }

  private async append(command: SessionCommand): Promise<void> {
    if (this.disposed) throw new CoordinatorError('SESSION_DISPOSED', 'This session is closed.');
    const state = this.requireState();
    // An uncertain write remains uncertain. An intent is never automatically replayed.
    const result = await this.host.store.append(command, state.head);
    if (!this.disposed) {
      this.checkRoot(result);
      this.lastReadAt = this.host.monotonicNow();
      this.accept(result);
    }
  }

  private accept(state: SessionState): void {
    const previous = this.currentState;
    this.checkRoot(state);
    if (previous && state.head <= previous.head) return;
    this.currentState = state;
    const run = state.run;
    if (previous?.run && (!run || run.runId !== previous.run.runId
      || previous.owner?.generation !== state.owner?.generation)) {
      if (this.localRunId === previous.run.runId) this.exitLocal();
      this.cancelTimer('endTimer');
    }
    if (!run) { this.reports.clear(); this.changed(); return; }
    if (previous?.run?.runId !== run.runId) {
      this.reports.clear();
      for (const recipient of run.recipients) this.setReport(recipient, 'preparing');
    }
    if (this.includesSelf(run)) {
      const progress = recipientProgress(run, this.self());
      if (progress?.terminal) { if (!this.exitedRuns.has(run.runId)) this.exitLocal(); }
      else this.applyLocal(recipientRun(run, this.self()));
      if (this.completedRuns.has(run.runId) && !progress?.terminal) this.notifyTerminal(run.runId);
    }
    else if (this.localRunId === run.runId && !this.exitedRuns.has(run.runId)) this.exitLocal();
    this.scheduleEnd(run);
    this.changed();
  }

  private applyLocal(run: SessionRun): void {
    if (this.localPreparation && this.localPreparation.runId !== run.runId) this.exitLocal();
    if (this.exitedRuns.has(run.runId)) return;
    if (run.phase === 'preparing') {
      if (this.preparedRuns.has(run.runId) || this.localPreparation?.runId === run.runId) return;
      this.error = null;
      this.localRunId = run.runId; this.localPhase = 'preparing';
      this.lastHeartbeatAt = this.host.monotonicNow();
      this.reportSelf(); this.changed();
      if (this.exitedRuns.has(run.runId) || this.disposed) return;
      let compiled: ReturnType<typeof compileSequence>;
      try {
        compiled = compileSequence(run.snapshot);
        this.host.playback.validateTarget?.(run.snapshot);
      } catch (error) {
        this.fail(error); this.exitedRuns.add(run.runId); this.localPhase = 'failed';
        this.reportSelf(); this.checkDeadline();
        return;
      }
      const prepare = this.host.playback.prepare;
      if (!prepare) {
        this.preparedRuns.add(run.runId);
        this.localPhase = 'ready';
        this.reportSelf(); this.checkDeadline();
        return;
      }
      const attempt = { runId: run.runId, controller: new AbortController() };
      this.localPreparation = attempt;
      try {
        void Promise.resolve(prepare.call(this.host.playback, compiled.snapshot as SequenceV1, attempt.controller.signal)).then(() => {
          if (!this.isCurrentPreparation(attempt)) return;
          this.localPreparation = null;
          this.preparedRuns.add(run.runId);
          this.localPhase = 'ready';
          this.reportSelf(); this.checkDeadline(); this.changed();
        }, error => {
          if (!this.isCurrentPreparation(attempt)) return;
          this.playbackFailed(error);
        });
      } catch (error) {
        if (this.isCurrentPreparation(attempt)) this.playbackFailed(error);
      }
      this.checkDeadline();
      return;
    }
    // A reloaded/new coordinator may have the same nonce in a test, but never prepared this run.
    if (!this.preparedRuns.has(run.runId)) {
      this.localRunId = run.runId; this.exitLocal(); return;
    }
    this.cancelTimer('startTimer');
    if (run.phase === 'playing' && run.atServerMs > this.host.now() && this.playbackRunId !== run.runId) {
      this.localPhase = 'scheduled'; this.reportSelf();
      this.startTimer = this.host.schedule(() => {
        this.startTimer = null;
        const current = this.currentState?.run;
        if (current?.runId === run.runId && current.phase !== 'preparing'
          && !this.exitedRuns.has(run.runId) && this.includesSelf(current)) this.mount(current);
      }, run.atServerMs - this.host.now());
    } else this.mount(run);
    this.checkDeadline();
  }

  private mount(run: SessionRun): void {
    run = recipientRun(run, this.self());
    if (this.disposed || this.exitedRuns.has(run.runId)) return;
    const endAt = this.endAt(run);
    if (endAt !== null && endAt <= this.host.now()) {
      if (this.currentState?.run?.recipientStates) this.playbackStateChanged({ phase: 'ended' }); else this.exitLocal();
      return;
    }
    const anchor = this.anchor(run);
    if (this.playbackRunId === run.runId) {
      try { this.host.playback.applyAnchor(anchor); } catch (error) { this.playbackFailed(error); return; }
    } else {
      this.playbackRunId = run.runId;
      const token = ++this.startToken;
      let starting: Promise<void>;
      try { starting = this.host.playback.start(run.snapshot, anchor); }
      catch (error) { this.playbackFailed(error); return; }
      void starting.then(() => {
        // stop() cancels the player's asynchronous surface preparation immediately on exit.
        if (token !== this.startToken || this.disposed || this.exitedRuns.has(run.runId)) return;
        const current = this.currentState?.run;
        if (current?.runId === run.runId && current.phase !== 'preparing') this.host.playback.applyAnchor(this.anchor(current));
      }).catch((error: unknown) => {
        if (token !== this.startToken) return;
        this.playbackFailed(error);
      });
    }
    this.localPhase = sessionPlayback(run, Math.round(this.host.now())).phase as CoordinatorPhase;
    this.reportSelf(); this.changed();
  }

  private anchor(run: SessionRun): PlaybackAnchor {
    run = recipientRun(run, this.self());
    if (run.phase === 'preparing') throw new CoordinatorError('SESSION_NOT_STARTED', 'The run has no playback anchor.');
    if (getPlaybackSchemaVersion(run.snapshot) === 3) return sessionAnchor(run);
    const now = Math.round(this.host.now());
    const playback = sessionPlayback(run, now);
    if (playback.phase === 'holding') return { phase: 'holding', positionMs: playback.positionMs, atMs: now, holdElapsedMs: playback.holdElapsedMs! };
    return { phase: run.phase, positionMs: run.positionMs, atMs: run.atServerMs,
      ...(run.phase === 'exiting' ? { exitDurationMs: run.exitDurationMs } : {}),
      ...(run.holdElapsedMs !== undefined ? { holdElapsedMs: run.holdElapsedMs } : {}),
      ...(run.pausedFrom !== undefined ? { pausedFrom: run.pausedFrom } : {}),
      ...(run.exitFrom !== undefined ? { exitFrom: run.exitFrom } : {}) };
  }

  private position(run: SessionRun): number {
    return Math.round(sessionPlayback(run, Math.round(this.host.now())).positionMs);
  }

  private endAt(run: SessionRun): number | null {
    run = recipientRun(run, this.self());
    if (run.phase === 'exiting') return run.atServerMs + run.exitDurationMs;
    if (getPlaybackSchemaVersion(run.snapshot) !== 1 && run.snapshot.end.kind === 'manual') return null;
    if (getPlaybackSchemaVersion(run.snapshot) === 3 && compileSequence(run.snapshot).breaks
      .some(marker => marker.kind === 'inner' && !run.breakHistory?.some(entry => entry.id === marker.id))) return null;
    const durationMs = compileSequence(run.snapshot).durationMs;
    if (run.phase === 'playing' && durationMs !== null) {
      return run.atServerMs + Math.max(0, durationMs - run.positionMs) + run.snapshot.presentation.exitDurationMs;
    }
    return null;
  }

  private scheduleEnd(run: SessionRun): void {
    this.cancelTimer('endTimer');
    if (run.recipientStates) { this.schedulePersonalEnd(run); return; }
    const nextInner = getPlaybackSchemaVersion(run.snapshot) === 3 ? compileSequence(run.snapshot).breaks
      .find(marker => marker.kind === 'inner' && !run.breakHistory?.some(entry => entry.id === marker.id)) : undefined;
    if (run.phase === 'playing' && (nextInner || (getPlaybackSchemaVersion(run.snapshot) !== 1 && run.snapshot.end.kind === 'manual'))) {
      const durationMs = nextInner?.positionMs ?? compileSequence(run.snapshot).durationMs!;
      const breakAt = run.atServerMs + Math.max(0, durationMs - run.positionMs);
      if (breakAt > this.host.now()) {
        this.endTimer = this.host.schedule(() => {
          this.endTimer = null;
          if (this.currentState?.run !== run || this.disposed) return;
          if (this.preparedRuns.has(run.runId) && this.includesSelf(run) && !this.exitedRuns.has(run.runId)) this.mount(run);
          this.changed();
        }, breakAt - this.host.now());
      }
      return;
    }
    const endAt = this.endAt(run);
    if (endAt === null) return;
    this.endTimer = this.host.schedule(() => {
      this.endTimer = null;
      if (this.currentState?.run !== run || this.disposed) return;
      if (this.localRunId === run.runId && !this.exitedRuns.has(run.runId)) this.exitLocal();
      if (this.isOwner() && !this.automaticStops.has(run.runId)) {
        this.automaticStops.add(run.runId);
        const generation = this.currentState.owner?.generation;
        void this.enqueue(async () => {
          // This deadline belongs to one run, even if another command was already queued.
          if (this.currentState?.run?.runId !== run.runId || this.currentState.owner?.generation !== generation || !this.isOwner()) return;
          const owner = this.requireOwner();
          await this.append({ kind: 'stop', sessionId: owner.sessionId, generation: owner.generation, runId: run.runId });
        }).catch(() => {});
      }
    }, Math.max(0, endAt - this.host.now()));
  }

  private schedulePersonalEnd(run: SessionRun): void {
    const progress = recipientProgress(run, this.self());
    if (!progress || progress.terminal || this.exitedRuns.has(run.runId) || run.phase === 'preparing') return;
    const local = recipientRun(run, this.self());
    const nextInner = compileSequence(run.snapshot).breaks.find(marker => marker.kind === 'inner' && !local.breakHistory?.some(entry => entry.id === marker.id));
    const breakPosition = nextInner?.positionMs ?? (run.snapshot.end.kind === 'manual' ? compileSequence(run.snapshot).durationMs : null);
    const at = local.phase === 'playing' && breakPosition !== null ? local.atServerMs + Math.max(0, breakPosition - local.positionMs) : null;
    const end = this.endAt(local);
    const target = end ?? at;
    if (target === null || (end === null && target <= this.host.now())) return;
    this.endTimer = this.host.schedule(() => {
      this.endTimer = null;
      if (this.currentState?.run !== run || this.disposed || this.exitedRuns.has(run.runId)) return;
      if (end !== null) this.playbackStateChanged({ phase: 'ended' });
      else { this.mount(run); this.changed(); }
    }, Math.max(0, target - this.host.now()));
  }

  private async queryRecipients(run: SessionRun, kind: 'prepare' | 'heartbeat'): Promise<void> {
    const owner = this.currentState?.owner;
    if (!owner || !this.isOwner()) return;
    await Promise.allSettled(run.recipients.filter(recipient => !sameParticipant(recipient, this.self())).map(async recipient => {
      try {
        const result = object(await this.host.query(recipient.userId, {
          kind, ownerSessionId: owner.sessionId, generation: owner.generation, runId: run.runId,
          prepareRevision: run.prepareRevision, targetSessionId: recipient.sessionId,
          protocolVersion: this.host.transportVersion ?? (run.snapshot.schemaVersion === 4 ? SESSION_TRANSPORT_VERSION : 3)
        }, SESSION_TIMING.queryTimeoutMs));
        if (this.disposed || this.currentState?.run?.runId !== run.runId || this.currentState.owner?.generation !== owner.generation) return;
        if (result?.kind !== 'status' || result.runId !== run.runId || result.prepareRevision !== run.prepareRevision
          || result.sessionId !== recipient.sessionId || typeof result.status !== 'string' || !phases.has(result.status as CoordinatorPhase)) {
          this.setReport(recipient, 'missing');
        } else {
          this.setReport(recipient, result.status as CoordinatorPhase, typeof result.error === 'string' ? result.error : undefined);
        }
      } catch {
        if (this.currentState?.run?.runId === run.runId) this.setReport(recipient, 'missing');
      }
      this.changed();
    }));
  }

  private checkDeadline(): void {
    this.cancelTimer('deadlineTimer');
    if (this.disposed || !this.status.canExit || !this.currentState?.run) return;
    const now = this.host.monotonicNow();
    const lastAlive = this.isOwner() ? this.lastReadAt : Math.min(this.lastReadAt, this.lastHeartbeatAt);
    const remaining = SESSION_TIMING.controllerTimeoutMs - (now - lastAlive);
    if (remaining <= 0) {
      this.fail(new CoordinatorError('SESSION_CONTROLLER_LOST', 'The controller connection expired.'));
      this.exitLocal();
    } else this.deadlineTimer = this.host.schedule(() => { this.deadlineTimer = null; this.checkDeadline(); }, remaining);
  }

  private schedulePoll(): void {
    if (!this.polling || this.disposed) return;
    this.pollTimer = this.host.schedule(() => {
      this.pollTimer = null;
      void this.refresh().catch(() => {}).finally(() => this.schedulePoll());
    }, SESSION_TIMING.pollMs);
  }

  private scheduleHeartbeat(): void {
    if (!this.polling || this.disposed) return;
    this.heartbeatTimer = this.host.schedule(() => {
      this.heartbeatTimer = null;
      const run = this.currentState?.run;
      if (run && this.isOwner() && !this.heartbeatInFlight) {
        this.heartbeatInFlight = true;
        void this.queryRecipients(run, 'heartbeat').catch(error => this.fail(error)).finally(() => { this.heartbeatInFlight = false; });
      }
      this.scheduleHeartbeat();
    }, SESSION_TIMING.heartbeatMs);
  }

  private self(): Participant { return { userId: this.host.userId, sessionId: this.host.sessionId }; }
  private checkRoot(state: SessionState): void {
    if (this.currentState && state.rootId !== this.currentState.rootId) throw new CoordinatorError('SESSION_ROOT_CHANGED', 'The controller root changed.');
  }
  private includesSelf(run: SessionRun): boolean { return run.recipients.some(recipient => sameParticipant(recipient, this.self())); }
  private isOwner(): boolean { return this.currentState?.owner?.userId === this.host.userId && this.currentState.owner.sessionId === this.host.sessionId; }
  private requireGM(): void { if (!this.host.isGM) throw new CoordinatorError('SESSION_UNAUTHORIZED', 'Only a GM can control group playback.'); }
  private requireState(): SessionState {
    if (!this.currentState) throw new CoordinatorError('SESSION_UNAVAILABLE', 'The session ledger has not been read.');
    return this.currentState;
  }
  private requireOwner() {
    this.requireGM();
    if (!this.isOwner()) throw new CoordinatorError('SESSION_NOT_OWNER', 'This GM session does not own the controller.');
    return this.requireState().owner!;
  }
  private requireRun(phase?: SessionRun['phase']): SessionRun {
    const run = this.requireState().run;
    if (!run || (phase && run.phase !== phase)) throw new CoordinatorError('SESSION_PHASE', 'The run is not in the required state.');
    return run;
  }
  private requireBeforeNaturalExit(run: SessionRun): void {
    if (getPlaybackSchemaVersion(run.snapshot) !== 1 && run.snapshot.end.kind === 'manual') return;
    const durationMs = compileSequence(run.snapshot).durationMs;
    if (durationMs !== null && this.position(run) >= durationMs) {
      throw new CoordinatorError('SESSION_PHASE', 'The sequence end has already begun its final fade.');
    }
  }

  private isCurrentPreparation(attempt: { readonly runId: string; readonly controller: AbortController }): boolean {
    return this.localPreparation === attempt && !attempt.controller.signal.aborted && !this.disposed
      && !this.exitedRuns.has(attempt.runId) && this.localRunId === attempt.runId
      && this.currentState?.run?.runId === attempt.runId && this.currentState.run.phase === 'preparing';
  }

  private cancelLocalPreparation(): void {
    const attempt = this.localPreparation;
    if (!attempt) return;
    this.localPreparation = null;
    try { attempt.controller.abort(); } catch { /* Stale completion guards still prevent readiness. */ }
  }
  private runIntent(): { runId: string | null; generation: string | null } {
    return { runId: this.currentState?.run?.runId ?? null, generation: this.currentState?.owner?.generation ?? null };
  }
  private checkOwnerIntent(generation: string | null): void {
    if ((this.currentState?.owner?.generation ?? null) !== generation) {
      throw new CoordinatorError('SESSION_CONFLICT', 'Controller ownership changed before this action could be submitted.');
    }
  }
  private checkRunIntent(intent: { runId: string | null; generation: string | null }): void {
    this.checkOwnerIntent(intent.generation);
    if ((this.currentState?.run?.runId ?? null) !== intent.runId) {
      throw new CoordinatorError('SESSION_CONFLICT', 'The active run changed before this action could be submitted.');
    }
  }
  private setReport(participant: Participant, status: CoordinatorParticipantStatus['status'], error?: string): void {
    const name = this.host.users().find(user => user.id === participant.userId)?.name ?? participant.userId;
    this.reports.set(key(participant), Object.freeze({ ...participant, name, status, ...(error ? { error } : {}) }));
  }
  private reportSelf(): void {
    if (this.localRunId && this.currentState?.run?.runId === this.localRunId) this.setReport(this.self(), this.status.phase, this.error?.message);
  }
  private changed(): void { try { this.host.onChange?.(); } catch { /* Observers cannot block release. */ } }
  private fail(error: unknown): void { this.error = error instanceof Error ? error : new Error(String(error)); this.changed(); }
  private cancelTimer(field: 'pollTimer' | 'heartbeatTimer' | 'startTimer' | 'endTimer' | 'deadlineTimer'): void {
    const timer = this[field]; this[field] = null;
    if (timer !== null) { try { this.host.cancel(timer); } catch { /* State guards also invalidate late callbacks. */ } }
  }
}
