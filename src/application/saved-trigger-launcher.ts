import type { SequenceRepository } from './ports.js';
import type { SequenceV1 } from '../domain/sequence.js';
import { matchingTriggerRules, validateTriggerEvent, type TriggerEvent } from '../domain/sequence-triggers.js';
import { validateSequence } from '../domain/validation.js';
import { getSequenceAudience, withSequenceAudience } from '../domain/sequence-audience.js';
import type { AudienceUser } from './audience-resolver.js';
import type { AutomaticAdmissionIntent } from './orchestration-coordinator.js';

export const SAVED_TRIGGER_LIMITS = Object.freeze({ sequences: 512, pendingBatches: 64, matchesPerBatch: 100 });

export class SavedTriggerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SavedTriggerError'; }
}

export interface SavedTriggerLauncherPorts {
  readonly repository: Pick<SequenceRepository, 'list' | 'read'>;
  readonly controllerUserId: string;
  users(): readonly AudienceUser[];
  readonly coordinator: {
    readonly canPrepareAutomatic: boolean;
    captureAutomaticIntent(): AutomaticAdmissionIntent | null;
    prepareAutomatic(sequence: SequenceV1, event: TriggerEvent, ruleId: string, intent: AutomaticAdmissionIntent): Promise<boolean>;
  };
  onAccepted?(): void;
  report?(error: Error): void;
}

interface CapturedLaunch { snapshot: SequenceV1; event: TriggerEvent; ruleId: string; }

/** Only confirmed repository data enters the cache; drafts and preview have no path here. */
export class SavedTriggerLauncher {
  private sequences: readonly SequenceV1[] = [];
  private ready = false;
  private disposed = false;
  private revision = 0;
  private refreshInFlight: Promise<void> | null = null;
  private dispatchTail: Promise<void> = Promise.resolve();
  private pendingBatches = 0;

  constructor(private readonly ports: SavedTriggerLauncherPorts) {}

  /** Invalidate synchronously, so a committed edit cannot trigger through an old cache. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.ready = false;
    this.revision++;
    if (this.refreshInFlight) return this.refreshInFlight;
    const reading = Promise.resolve().then(async () => {
      try {
        while (!this.disposed) {
          const revision = this.revision;
          try {
            const summaries = await this.ports.repository.list();
            if (summaries.length > SAVED_TRIGGER_LIMITS.sequences) {
              throw new SavedTriggerError('TRIGGER_LIBRARY_LIMIT', 'The saved trigger library exceeds its sequence limit.');
            }
            const next: SequenceV1[] = [];
            for (const summary of [...summaries].sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
              if (this.disposed || revision !== this.revision) break;
              if (summary.issue) continue;
              const value = await this.ports.repository.read(summary.id);
              if (this.disposed || revision !== this.revision) break;
              const snapshot = validateSequence(value);
              if (snapshot.id !== summary.id || snapshot.revision !== summary.revision || snapshot.revision < 1) {
                throw new SavedTriggerError('TRIGGER_LIBRARY_CHANGED', 'Saved trigger data changed while it was being read.');
              }
              next.push(snapshot);
            }
            if (this.disposed) return;
            if (revision !== this.revision) continue;
            this.sequences = next;
            this.ready = true;
            return;
          } catch (error) {
            if (this.disposed) return;
            if (revision !== this.revision) continue;
            throw error;
          }
        }
      } catch (error) { this.report(error); throw error; }
      finally {
        // Release before this task settles: a native hook in the next microtask
        // must start another read instead of joining an already completed one.
        if (this.refreshInFlight === reading) this.refreshInFlight = null;
      }
    });
    this.refreshInFlight = reading;
    return reading;
  }

  /** Freeze event, viewers and authority now; a loading cache may join this same saved revision. */
  dispatch(events: readonly TriggerEvent[]): Promise<number> {
    if (this.disposed || !this.ports.coordinator.canPrepareAutomatic) return Promise.resolve(0);
    const loading = this.ready ? null : this.refreshInFlight;
    if (!this.ready && !loading) return Promise.resolve(0);
    const intent = this.ports.coordinator.captureAutomaticIntent();
    if (!intent) return Promise.resolve(0);
    const revision = this.revision;
    let frozenEvents: TriggerEvent[], viewers: readonly AudienceUser[], captured: CapturedLaunch[] | null;
    try {
      frozenEvents = events.map(validateTriggerEvent);
      viewers = structuredClone(this.ports.users());
      captured = loading ? null : this.captureLaunches(frozenEvents, viewers);
    } catch (error) {
      this.report(error);
      return Promise.reject(error);
    }
    if (!frozenEvents.length || captured?.length === 0) return Promise.resolve(0);
    if (this.pendingBatches >= SAVED_TRIGGER_LIMITS.pendingBatches) {
      const error = new SavedTriggerError('TRIGGER_BATCH_LIMIT', 'Too many automatic combat updates are waiting.');
      this.report(error);
      return Promise.reject(error);
    }
    this.pendingBatches++;
    const dispatching = this.dispatchTail.then(async () => {
      let launches = captured;
      if (loading) {
        try { await loading; } catch { return 0; } // The refresh reports its own storage error once.
        // A later saved edit must never acquire an earlier event or activate a new rule retroactively.
        if (this.disposed || !this.ready || revision !== this.revision || !this.ports.coordinator.canPrepareAutomatic) return 0;
        launches = this.captureLaunches(frozenEvents, viewers);
      }
      let accepted = 0;
      for (const launch of launches ?? []) {
        if (this.disposed || !this.ports.coordinator.canPrepareAutomatic) break;
        try {
          if (await this.ports.coordinator.prepareAutomatic(launch.snapshot, launch.event, launch.ruleId, intent)) {
            accepted++;
            if (!this.disposed) this.ports.onAccepted?.();
          }
        } catch (error) { this.report(error); }
      }
      return accepted;
    }).catch(error => { this.report(error); throw error; }).finally(() => { this.pendingBatches--; });
    this.dispatchTail = dispatching.then(() => {}, () => {});
    return dispatching;
  }

  dispose(): void { this.disposed = true; this.ready = false; this.revision++; this.sequences = []; }

  private captureLaunches(events: readonly TriggerEvent[], viewers: readonly AudienceUser[]): CapturedLaunch[] {
    const captured: CapturedLaunch[] = [];
    for (const event of events) {
      for (const sequence of this.sequences) {
        const rules = matchingTriggerRules(sequence, event);
        if (!rules.length) continue;
        const audience = getSequenceAudience(sequence);
        const userIds = audience.mode === 'all' ? viewers.filter(user => user.active && user.role < 3
          && user.id !== this.ports.controllerUserId).map(user => user.id) : audience.userIds;
        const snapshot = withSequenceAudience(sequence, { ...audience, mode: 'selected', userIds });
        for (const rule of [...rules].sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
          captured.push({ snapshot: structuredClone(snapshot), event: structuredClone(event), ruleId: rule.id });
          if (captured.length > SAVED_TRIGGER_LIMITS.matchesPerBatch) {
            throw new SavedTriggerError('TRIGGER_BATCH_LIMIT', 'Too many automatic launches match this combat update.');
          }
        }
      }
    }
    return captured;
  }

  private report(error: unknown): void {
    if (this.disposed) return;
    try { this.ports.report?.(error instanceof Error ? error : new Error(String(error))); }
    catch { /* An observer cannot turn a confirmed launch into a retry. */ }
  }
}
