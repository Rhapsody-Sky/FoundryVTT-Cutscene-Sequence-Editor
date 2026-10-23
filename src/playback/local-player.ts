import type { SequenceV1 } from '../domain/sequence.js';
import { compileSequence, evaluate, copyPlaybackAnchor, validatePlaybackBreakState, projectPlaybackAnchor,
  playbackPositionAt, playbackHoldElapsedAt, continuePlaybackAnchor, type PlaybackClockAnchor, type BreakHistoryEntry, type CompiledSequence, type FrameItem } from './evaluate.js';

export interface Runtime {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}

export type PlayerPhase = 'idle' | 'preparing' | 'playing' | 'holding' | 'paused' | 'exiting' | 'ended';

export type PlaybackAnchor = PlaybackClockAnchor;

export interface PlayerFrame {
  readonly positionMs: number;
  readonly items: readonly FrameItem[];
  readonly opacity: number;
  readonly phase: 'playing' | 'holding' | 'paused' | 'exiting';
  readonly holdElapsedMs?: number;
  readonly breakId?: string;
  readonly breakHistory?: readonly BreakHistoryEntry[];
}

export interface Surface {
  prepare(plan: CompiledSequence, signal: AbortSignal): Promise<void>;
  /** Adopt compatible editor metadata without preparing or replacing resources. */
  updatePreview?(plan: CompiledSequence): void;
  render(frame: PlayerFrame): void;
  dispose(): void;
}

export interface PlayerState {
  readonly phase: PlayerPhase;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly error?: string;
  readonly holdElapsedMs?: number;
  readonly breakId?: string;
  readonly breakHistory?: readonly BreakHistoryEntry[];
  readonly items?: readonly FrameItem[];
}

type ActivePhase = Exclude<PlayerPhase, 'idle' | 'ended'>;

interface ActiveRun {
  readonly id: number;
  plan: CompiledSequence;
  readonly editablePreview: boolean;
  readonly surface: Surface;
  readonly abortController: AbortController;
  phase: ActivePhase;
  pendingAnchor: PlaybackAnchor | null;
  lastAnchor: PlaybackAnchor | null;
  anchorPositionMs: number;
  anchorAtMs: number;
  pausedPositionMs: number;
  holdingPositionMs: number;
  holdElapsedAtAnchorMs: number;
  holdAtMs: number;
  pausedHolding: boolean;
  exitHolding: Exclude<PlaybackAnchor['exitFrom'], 'paused'>;
  exitPaused: boolean;
  exitPositionMs: number;
  exitStartedAtMs: number;
  exitDurationMs: number;
  breakId: string | undefined;
  breakHistory: readonly BreakHistoryEntry[] | undefined;
  frameId: number | null;
  disposed: boolean;
  ready: boolean;
}

type StateListener = (state: Readonly<PlayerState>) => void;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function makeState(phase: PlayerPhase, positionMs: number, durationMs: number | null, error?: string, details: { holdElapsedMs?: number; items?: readonly FrameItem[]; breakId?: string; breakHistory?: readonly BreakHistoryEntry[] } = {}): Readonly<PlayerState> {
  return Object.freeze(error === undefined
    ? { phase, positionMs, durationMs, ...details }
    : { phase, positionMs, durationMs, error, ...details });
}

function copyAnchor(anchor: PlaybackAnchor): PlaybackAnchor {
  return copyPlaybackAnchor(anchor);
}

function anchorsMatch(left: PlaybackAnchor | null, right: PlaybackAnchor): boolean {
  return left !== null
    && left.phase === right.phase
    && left.positionMs === right.positionMs
    && left.atMs === right.atMs
    && left.exitDurationMs === right.exitDurationMs
    && left.holdElapsedMs === right.holdElapsedMs
    && left.pausedFrom === right.pausedFrom
    && left.exitFrom === right.exitFrom
    && left.breakId === right.breakId
    && JSON.stringify(left.breakHistory) === JSON.stringify(right.breakHistory);
}

/** Everything that requires resources, layout roots, or a different renderer. */
function previewResources(plan: CompiledSequence): string {
  const source = plan.snapshot;
  return JSON.stringify({
    schemaVersion: source.schemaVersion,
    playbackSchemaVersion: source.playbackSchemaVersion,
    composition: source.composition,
    tracks: source.tracks.map(track => [track.id, track.kind, track.enabled, track.order]),
    breaks: (source.breaks ?? []).map(marker => marker.id).sort(),
    clips: source.clips.map(clip => [clip.id, clip.trackId, clip.type,
      clip.type === 'text' ? [clip.properties.text, clip.properties.fontFamily]
        : clip.type === 'video' || clip.type === 'audio' ? [clip.properties.source, clip.properties.durationMs]
          : clip.type === 'image' ? clip.properties.source
            : clip.type === 'button' ? [clip.properties.label, clip.properties.fontFamily, clip.properties.texture]
            : clip.type === 'solid' ? [clip.properties.alphaMap, clip.properties.mask.length] : null
    ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  });
}

export class LocalPlayer {
  private current: ActiveRun | null = null;
  private nextRunId = 0;
  private state: Readonly<PlayerState> = makeState('idle', 0, null);

  constructor(private readonly runtime: Runtime, private readonly onState?: StateListener) {}

  async start(sequence: SequenceV1, surface: Surface, anchor?: PlaybackAnchor): Promise<void> {
    return this.begin(sequence,surface,anchor,false);
  }

  /** Private editor playback alone opts into compatible, immutable plan replacement. */
  async startPreview(sequence: SequenceV1, surface: Surface, anchor?: PlaybackAnchor): Promise<void> {
    return this.begin(sequence, surface, anchor, false, true);
  }

  /** Invalid drafts or resource changes leave the current preview untouched. */
  updatePreview(sequence: SequenceV1): boolean {
    const run = this.current;
    if (!run?.editablePreview || !run.ready || run.phase === 'preparing') return false;
    let plan: CompiledSequence;
    let anchor: PlaybackAnchor;
    let now: number;
    try {
      plan = compileSequence(sequence);
      if (previewResources(run.plan) !== previewResources(plan)) return false;
      now = this.readNow();
      anchor = this.replanPreviewAnchor(run, plan, now);
    } catch { return false; }
    // Validation and resource compatibility have completed before any publication.
    run.plan = plan;
    this.installAnchor(run, anchor);
    try {
      run.surface.updatePreview?.(plan);
      this.renderCycle(run, now);
      this.schedule(run);
    } catch (error) { this.finish(run, this.positionFromStoredPhase(run), messageOf(error)); }
    return true;
  }

  /** Load and validate the same surface without advancing time or mounting an overlay. */
  async prepare(sequence:SequenceV1,surface:Surface):Promise<void> {
    return this.begin(sequence,surface,undefined,true);
  }

  /** Start the retained prepared resources at the shared timeline anchor. */
  play(anchor?:PlaybackAnchor):void {
    const run=this.current;
    if(!run || !run.ready || run.phase!=='preparing') throw new Error('MEDIA_NOT_PREPARED');
    const now=this.readNow();
    const next=anchor ? copyAnchor(anchor) : run.pendingAnchor ?? {phase:'playing',positionMs:0,atMs:now} as const;
    validatePlaybackBreakState(run.plan, next);
    if(this.anchorHasEnded(run,next,now)) {this.finish(run,this.clampedPosition(run,next.positionMs));return;}
    this.installAnchor(run,next);
    try {this.renderCycle(run,now);this.schedule(run);}
    catch(error) {this.finish(run,0,messageOf(error));throw error;}
  }

  /** Asynchronous renderer/media failures use the same terminal cleanup as frame failures. */
  fail(error:unknown):void {
    const run=this.current;
    if(run) this.finish(run,this.positionFromStoredPhase(run),messageOf(error));
  }

  private async begin(sequence: SequenceV1, surface: Surface, anchor: PlaybackAnchor|undefined, prepareOnly:boolean, editablePreview = false): Promise<void> {
    // Compile first, so a rejected draft cannot disturb an existing run.
    const plan = compileSequence(sequence);
    const initialAnchor = anchor === undefined ? null : copyAnchor(anchor);
    if (initialAnchor) validatePlaybackBreakState(plan, initialAnchor);
    this.stop();

    const run: ActiveRun = {
      id: ++this.nextRunId,
      plan,
      editablePreview,
      surface,
      abortController: new AbortController(),
      phase: 'preparing',
      pendingAnchor: initialAnchor,
      lastAnchor: null,
      anchorPositionMs: 0,
      anchorAtMs: 0,
      pausedPositionMs: 0,
      holdingPositionMs: 0,
      holdElapsedAtAnchorMs: 0,
      holdAtMs: 0,
      pausedHolding: false,
      exitHolding: undefined,
      exitPaused: false,
      exitPositionMs: 0,
      exitStartedAtMs: 0,
      exitDurationMs: 0,
      breakId: undefined,
      breakHistory: undefined,
      frameId: null,
      disposed: false,
      ready: false
    };
    this.current = run;
    this.publish(makeState('preparing', 0, plan.durationMs));

    try {
      const beforePrepare = this.readNow();
      if (initialAnchor && this.anchorHasEnded(run, initialAnchor, beforePrepare)) {
        this.finish(run, this.clampedPosition(run, initialAnchor.positionMs));
        return;
      }
      await surface.prepare(plan, run.abortController.signal);
      if (!this.isCurrent(run) || run.abortController.signal.aborted) return;
      run.ready=true;
      if(prepareOnly) return;

      const now = this.readNow();
      const readyAnchor = run.pendingAnchor ?? Object.freeze({ phase: 'playing' as const, positionMs: 0, atMs: now });
      if (this.anchorHasEnded(run, readyAnchor, now)) {
        this.finish(run, this.clampedPosition(run, readyAnchor.positionMs));
        return;
      }
      this.installAnchor(run, readyAnchor);
      this.renderCycle(run, now);
      this.schedule(run);
    } catch (error) {
      if (!this.isCurrent(run)) return;
      this.finish(run, 0, messageOf(error));
      throw error;
    }
  }

  /** Replace this run's shared timeline anchor. Invalid anchors leave the run untouched. */
  applyAnchor(anchor: PlaybackAnchor): void {
    const nextAnchor = copyAnchor(anchor);
    const run = this.current;
    if (!run) return;
    if (run.phase === 'preparing' && anchorsMatch(run.pendingAnchor, nextAnchor)) return;
    if (anchorsMatch(run.lastAnchor, nextAnchor)) return;

    validatePlaybackBreakState(run.plan, nextAnchor);
    this.replaceAnchor(run, nextAnchor);
  }

  private replaceAnchor(run: ActiveRun, nextAnchor: PlaybackAnchor): void {
    const now = this.readNow();
    if (run.phase === 'preparing') {
      run.pendingAnchor = nextAnchor;
      if (this.anchorHasEnded(run, nextAnchor, now)) {
        this.finish(run, this.clampedPosition(run, nextAnchor.positionMs));
      }
      return;
    }

    if (this.anchorHasEnded(run, nextAnchor, now)) {
      this.finish(run, this.clampedPosition(run, nextAnchor.positionMs));
      return;
    }

    this.cancelScheduledFrame(run);
    this.installAnchor(run, nextAnchor);
    try {
      this.renderCycle(run, now);
      this.schedule(run);
    } catch (error) {
      this.finish(run, this.positionFromStoredPhase(run), messageOf(error));
    }
  }

  pause(): void {
    const run = this.current;
    if (!run || (run.phase !== 'playing' && run.phase !== 'holding')) return;
    try {
      const now = this.readNow();
      const reachedEnd = this.beginNaturalExitIfDue(run, now);
      if (!this.isCurrent(run) || (reachedEnd && run.phase !== 'holding')) return;
      const holding = run.phase === 'holding';
      this.applyTransportAnchor(run, { phase: 'paused', positionMs: this.positionAt(run, now), atMs: now, ...this.breakDetails(run),
        ...(holding ? { pausedFrom: 'holding' as const, holdElapsedMs: this.holdElapsedAt(run, now) } : {}) });
    } catch (error) { this.finish(run, this.positionFromStoredPhase(run), messageOf(error)); }
  }

  resume(): void {
    const run = this.current;
    if (!run || run.phase !== 'paused') return;
    try {
      this.applyTransportAnchor(run, { phase: run.pausedHolding ? 'holding' : 'playing', positionMs: run.pausedPositionMs, atMs: this.readNow(), ...this.breakDetails(run),
        ...(run.pausedHolding ? { holdElapsedMs: run.holdElapsedAtAnchorMs } : {}) });
    } catch (error) { this.finish(run, run.pausedPositionMs, messageOf(error)); }
  }

  /** Consume the current inner hold, or continue the endpoint into the global fade. */
  continueFromBreak(): void {
    const run = this.current;
    if (!run || run.phase === 'preparing') return;
    try {
      const now = this.readNow();
      this.beginNaturalExitIfDue(run, now);
      if (!this.isCurrent(run) || (run.phase !== 'holding' && !(run.phase === 'paused' && run.pausedHolding))) return;
      this.applyTransportAnchor(run, continuePlaybackAnchor(run.plan, this.clockAnchor(run), now));
    } catch (error) { this.finish(run, this.positionFromStoredPhase(run), messageOf(error)); }
  }

  /** Fade the current composition. Repeated requests never restart the fade. */
  fadeOut(durationMs?: number): void {
    const run = this.current;
    if (!run || run.phase === 'exiting') return;
    if (run.phase === 'preparing') { this.stop(); return; }
    const fadeDurationMs = durationMs ?? run.plan.snapshot.presentation.exitDurationMs;
    if (!Number.isFinite(fadeDurationMs) || fadeDurationMs < 0) throw new RangeError('Fade duration must be a finite, non-negative number.');
    try {
      const now = this.readNow();
      const reachedEnd = this.beginNaturalExitIfDue(run, now);
      if (!this.isCurrent(run) || (reachedEnd && run.phase !== 'holding')) return;
      const holding = run.phase === 'holding' || (run.phase === 'paused' && run.pausedHolding);
      this.applyTransportAnchor(run, { phase: 'exiting', positionMs: this.positionAt(run, now), atMs: now, exitDurationMs: fadeDurationMs, ...this.breakDetails(run),
        ...(holding ? { exitFrom: run.phase === 'paused' ? 'paused-holding' as const : 'holding' as const,
          holdElapsedMs: this.holdElapsedAt(run, now) } : run.phase === 'paused' ? { exitFrom: 'paused' as const } : {}) });
    } catch (error) { this.finish(run, this.positionFromStoredPhase(run), messageOf(error)); }
  }

  stop(): void {
    const run = this.current;
    if (!run) return;
    let position = this.positionFromStoredPhase(run);
    try {
      position = this.positionAt(run, this.runtime.now());
    } catch {
      // A local stop must still release the surface if the clock adapter fails.
    }
    this.finish(run, position);
  }

  getState(): Readonly<PlayerState> {
    const run = this.current;
    if (!run) return this.state;
    let position = this.positionFromStoredPhase(run);
    let now = run.holdAtMs;
    try {
      now = this.readNow();
      this.beginNaturalExitIfDue(run, now);
      if (!this.isCurrent(run)) return this.state;
      position = this.positionAt(run, now);
    } catch {
      // Report the last stable anchor if the clock is temporarily unavailable.
    }
    const holding = run.phase === 'holding' || (run.phase === 'paused' && run.pausedHolding) || (run.phase === 'exiting' && run.exitHolding !== undefined);
    const elapsed = holding ? this.holdElapsedAt(run, now) : undefined;
    return makeState(run.phase, position, run.plan.durationMs, undefined, {
      ...(elapsed !== undefined ? { holdElapsedMs: elapsed } : {}),
      ...this.breakDetails(run),
      items: evaluate(run.plan, position, { ...(run.breakHistory !== undefined ? { breakHistory: run.breakHistory } : {}), paused: run.phase === 'paused',
        ...(run.phase === 'exiting' ? { exiting: { elapsedMs: Math.max(0, now - run.exitStartedAtMs), paused: run.exitPaused } } : {}),
        ...(elapsed !== undefined ? { holding: { elapsedMs: elapsed, paused: run.phase === 'paused' || run.exitHolding === 'paused-holding' } } : {}) })
    });
  }

  private breakDetails(run: ActiveRun): { breakId?: string; breakHistory?: readonly BreakHistoryEntry[] } {
    return { ...(run.breakId !== undefined ? { breakId: run.breakId } : {}),
      ...(run.breakHistory !== undefined ? { breakHistory: run.breakHistory } : {}) };
  }

  private applyTransportAnchor(run: ActiveRun, anchor: PlaybackAnchor): void {
    // Editor replanning can reorder consumed markers or move a hold behind its
    // historical positions. That local history intentionally is not a wire prefix.
    if (run.editablePreview) this.replaceAnchor(run, anchor);
    else this.applyAnchor(anchor);
  }

  private replanPreviewAnchor(run: ActiveRun, plan: CompiledSequence, now: number): PlaybackAnchor {
    const current = projectPlaybackAnchor(run.plan, this.clockAnchor(run), now);
    const holding = current.phase === 'holding' || current.pausedFrom === 'holding'
      || current.exitFrom === 'holding' || current.exitFrom === 'paused-holding';
    const oldPosition = playbackPositionAt(run.plan, current, now);
    const heldPosition = current.breakId === undefined ? plan.durationMs ?? oldPosition
      : plan.snapshot.breaks?.find(marker => marker.id === current.breakId)?.positionMs ?? oldPosition;
    const positionMs = holding ? (plan.durationMs === null ? heldPosition : Math.min(heldPosition, plan.durationMs)) : oldPosition;
    const history = [...current.breakHistory ?? []];
    const consumed = new Set(history.map(entry => entry.id));
    for (const marker of plan.breaks) {
      if (marker.kind === 'inner' && marker.id !== current.breakId && !consumed.has(marker.id) && marker.positionMs < positionMs) {
        // A marker edited behind the clock must never rewind playback or replay.
        history.push(Object.freeze({ id: marker.id, positionMs, elapsedMs: 0 }));
        consumed.add(marker.id);
      }
    }
    const clockDetails = {
      ...(history.length || current.breakHistory !== undefined ? { breakHistory: Object.freeze(history) } : {}),
      ...(current.breakId !== undefined ? { breakId: current.breakId } : {})
    };
    if (current.phase === 'exiting') return Object.freeze({ ...current, positionMs, ...clockDetails,
      exitDurationMs: current.exitDurationMs === run.plan.snapshot.presentation.exitDurationMs
        ? plan.snapshot.presentation.exitDurationMs : current.exitDurationMs ?? plan.snapshot.presentation.exitDurationMs });
    return Object.freeze({ ...current, positionMs, atMs: Math.max(now, current.atMs), ...clockDetails,
      ...(holding ? { holdElapsedMs: playbackHoldElapsedAt(current, now) } : {}) });
  }

  private clockAnchor(run: ActiveRun): PlaybackAnchor {
    if (run.phase === 'holding') return { phase: 'holding', positionMs: run.holdingPositionMs, atMs: run.holdAtMs,
      holdElapsedMs: run.holdElapsedAtAnchorMs, ...this.breakDetails(run) };
    if (run.phase === 'paused') return { phase: 'paused', positionMs: run.pausedPositionMs, atMs: run.anchorAtMs,
      ...(run.pausedHolding ? { pausedFrom: 'holding', holdElapsedMs: run.holdElapsedAtAnchorMs } : {}), ...this.breakDetails(run) };
    if (run.phase === 'exiting') return { phase: 'exiting', positionMs: run.exitPositionMs, atMs: run.exitStartedAtMs,
      exitDurationMs: run.exitDurationMs,
      ...(run.exitHolding !== undefined ? { exitFrom: run.exitHolding, holdElapsedMs: run.holdElapsedAtAnchorMs }
        : run.exitPaused ? { exitFrom: 'paused' } : {}), ...this.breakDetails(run) };
    return { phase: 'playing', positionMs: run.anchorPositionMs, atMs: run.anchorAtMs, ...this.breakDetails(run) };
  }

  private positionAt(run: ActiveRun, now: number): number {
    return run.phase === 'preparing' ? 0 : playbackPositionAt(run.plan, this.clockAnchor(run), now);
  }

  private readNow(): number {
    const now = this.runtime.now();
    if (!Number.isFinite(now)) throw new RangeError('Runtime clock must return a finite number.');
    return now;
  }

  private clampedPosition(run: ActiveRun, positionMs: number): number {
    return run.plan.durationMs === null ? positionMs : Math.min(positionMs, run.plan.durationMs);
  }

  private anchorHasEnded(run: ActiveRun, anchor: PlaybackAnchor, now: number): boolean {
    if (anchor.phase === 'exiting') {
      const durationMs = anchor.exitDurationMs ?? run.plan.snapshot.presentation.exitDurationMs;
      return now >= anchor.atMs + durationMs;
    }
    const projected = projectPlaybackAnchor(run.plan, anchor, now);
    return projected.phase === 'exiting' && now >= projected.atMs + (projected.exitDurationMs ?? run.plan.snapshot.presentation.exitDurationMs);
  }

  private installAnchor(run: ActiveRun, anchor: PlaybackAnchor): void {
    run.breakId = anchor.breakId;
    run.breakHistory = anchor.breakHistory;
    run.pendingAnchor = anchor;
    run.lastAnchor = anchor;
    run.anchorPositionMs = anchor.positionMs;
    run.anchorAtMs = anchor.atMs;
    run.pausedPositionMs = anchor.positionMs;
    run.holdingPositionMs = anchor.positionMs;
    run.holdAtMs = anchor.atMs;
    run.holdElapsedAtAnchorMs = anchor.holdElapsedMs ?? 0;
    run.pausedHolding = anchor.pausedFrom === 'holding';
    run.exitHolding = anchor.exitFrom === 'paused' ? undefined : anchor.exitFrom;
    run.exitPaused = anchor.exitFrom === 'paused';
    if (anchor.phase === 'holding') { run.phase = 'holding'; return; }
    if (anchor.phase === 'playing') {
      run.phase = 'playing';
      return;
    }
    if (anchor.phase === 'paused') {
      run.phase = 'paused';
      return;
    }
    run.phase = 'exiting';
    run.exitPositionMs = anchor.positionMs;
    run.exitStartedAtMs = anchor.atMs;
    run.exitDurationMs = anchor.exitDurationMs ?? run.plan.snapshot.presentation.exitDurationMs;
  }

  private positionFromStoredPhase(run: ActiveRun): number {
    if (run.phase === 'holding') return run.holdingPositionMs;
    if (run.phase === 'paused') return run.pausedPositionMs;
    if (run.phase === 'exiting') return run.exitPositionMs;
    if (run.phase === 'playing') return run.anchorPositionMs;
    return 0;
  }

  private beginNaturalExitIfDue(run: ActiveRun, now: number): boolean {
    if (run.phase !== 'playing') return false;
    const current = this.clockAnchor(run);
    const projected = projectPlaybackAnchor(run.plan, current, now);
    if (projected.phase === 'playing') return false;
    // Remember externally applied identity so replaying the same network anchor is idempotent.
    const lastAnchor = run.lastAnchor;
    this.installAnchor(run, projected);
    run.lastAnchor = lastAnchor;
    if (projected.phase === 'holding') {
      this.publish(makeState('holding', projected.positionMs, run.plan.durationMs, undefined,
        { holdElapsedMs: this.holdElapsedAt(run, now), ...this.breakDetails(run) }));
    } else {
      this.publish(makeState('exiting', projected.positionMs, run.plan.durationMs, undefined, this.breakDetails(run)));
      if (run.exitDurationMs === 0) this.finish(run, run.exitPositionMs);
    }
    return true;
  }

  private renderCycle(run: ActiveRun, now: number): void {
    if (!this.isCurrent(run)) return;
    this.beginNaturalExitIfDue(run, now);
    if (!this.isCurrent(run)) return;

    if (run.phase === 'exiting') {
      const elapsed = Math.max(0, now - run.exitStartedAtMs);
      if (run.exitDurationMs === 0 || elapsed >= run.exitDurationMs) {
        this.finish(run, run.exitPositionMs);
        return;
      }
      const opacity = 1 - Math.max(0, Math.min(1, elapsed / run.exitDurationMs));
      this.render(run, run.exitPositionMs, opacity, 'exiting', now);
      return;
    }

    if (run.phase === 'playing' || run.phase === 'holding' || run.phase === 'paused') {
      // Prepared resources remain detached through a future shared start lead.
      if((run.phase==='playing' || run.phase==='holding') && now<run.anchorAtMs) return;
      const position = this.positionAt(run, now);
      this.render(run, position, 1, run.phase, now);
    }
  }

  private holdElapsedAt(run: ActiveRun, now: number): number {
    return playbackHoldElapsedAt(this.clockAnchor(run), now);
  }

  private render(run: ActiveRun, positionMs: number, opacity: number, phase: PlayerFrame['phase'], now: number): void {
    const holding = phase === 'holding' || (phase === 'paused' && run.pausedHolding) || (phase === 'exiting' && run.exitHolding !== undefined);
    const holdElapsedMs = holding ? this.holdElapsedAt(run, now) : undefined;
    const items = evaluate(run.plan, positionMs, { ...(run.breakHistory !== undefined ? { breakHistory: run.breakHistory } : {}), paused: phase === 'paused',
      ...(phase === 'exiting' ? { exiting: { elapsedMs: Math.max(0, now - run.exitStartedAtMs), paused: run.exitPaused } } : {}),
      ...(holdElapsedMs !== undefined ? { holding: { elapsedMs: holdElapsedMs, paused: phase === 'paused' || run.exitHolding === 'paused-holding' } } : {}) });
    run.surface.render(Object.freeze({ positionMs, items, opacity: Math.max(0, Math.min(1, opacity)), phase, ...this.breakDetails(run),
      ...(holdElapsedMs !== undefined ? { holdElapsedMs } : {}) }));
    if (this.isCurrent(run)) this.publish(makeState(phase, positionMs, run.plan.durationMs, undefined, { items, ...this.breakDetails(run),
      ...(holdElapsedMs !== undefined ? { holdElapsedMs } : {}) }));
  }

  private schedule(run: ActiveRun): void {
    if (!this.isCurrent(run) || run.frameId !== null || (run.phase !== 'playing' && run.phase !== 'holding' && run.phase !== 'exiting')) return;
    const frameId = this.runtime.requestFrame(() => {
      if (run.frameId === frameId) run.frameId = null;
      if (!this.isCurrent(run)) return;
      try {
        this.renderCycle(run, this.readNow());
        this.schedule(run);
      } catch (error) {
        this.finish(run, this.positionFromStoredPhase(run), messageOf(error));
      }
    });
    run.frameId = frameId;
  }

  private cancelScheduledFrame(run: ActiveRun): void {
    if (run.frameId === null) return;
    const frameId = run.frameId;
    run.frameId = null;
    try {
      this.runtime.cancelFrame(frameId);
    } catch {
      // A failed cancellation must not block abort or surface disposal.
    }
  }

  private isCurrent(run: ActiveRun): boolean {
    return this.current === run && run.id === this.nextRunId;
  }

  private finish(run: ActiveRun, positionMs: number, error?: string): void {
    if (!this.isCurrent(run)) return;
    this.current = null;
    this.cancelScheduledFrame(run);
    try {
      run.abortController.abort();
    } catch {
      // Continue to dispose even if a signal listener fails.
    }

    let finalError = error;
    if (!run.disposed) {
      run.disposed = true;
      try {
        run.surface.dispose();
      } catch (disposeError) {
        const message = messageOf(disposeError);
        finalError = finalError ? `${finalError}; surface disposal failed: ${message}` : `Surface disposal failed: ${message}`;
      }
    }

    const stablePosition = Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0;
    this.publish(makeState('ended', stablePosition, run.plan.durationMs, finalError));
  }

  private publish(state: Readonly<PlayerState>): void {
    this.state = state;
    try {
      this.onState?.(state);
    } catch {
      // Observers cannot interrupt playback or cleanup.
    }
  }
}
