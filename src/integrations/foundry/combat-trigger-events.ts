import type { TriggerEvent } from '../../domain/sequence-triggers.js';
import { validateTriggerEvent } from '../../domain/sequence-triggers.js';

/** Foundry-independent state needed to describe a combat position. */
export interface CombatTriggerSnapshot {
  readonly combatId: string;
  readonly round: number;
  readonly turn: number | null;
  readonly combatantId: string | null;
  readonly actorId: string | null;
  /** Foundry Combat._stats.modifiedTime, used only to reject stale callbacks after initialization. */
  readonly modifiedTime?: number;
}

/** Confirmed updateCombat metadata mapped by the Foundry hook adapter. */
export interface ConfirmedCombatUpdate {
  /** Foundry DatabaseUpdateOperation.modifiedTime from updateCombat options. */
  readonly modifiedTime: number | null;
  /** True only when the confirmed update payload contains `round` or `turn`. */
  readonly positionFieldsChanged: boolean;
  /** Foundry's `options.turnEvents`; false suppresses system turn workflows such as initiative reset. */
  readonly turnEventsEnabled?: boolean;
}

/** Confirmed deleteCombat metadata, independent of the collection after deletion. */
export interface ConfirmedCombatDeletion {
  readonly modifiedTime: number | null;
  /** Native Combat.isActive remains available on the deleted document. */
  readonly wasActive: boolean;
}

interface Position {
  readonly round: number;
  readonly turn: number | null;
}

interface CombatTracker {
  snapshot: CombatTriggerSnapshot;
  latestModifiedTime: number | null;
  /** Occurrences are counted per operation timestamp and exact position transition. */
  readonly occurrences: Map<string, number>;
}

const FOUNDRY_ID = /^[A-Za-z0-9_-]+$/;
const EVENT_ID_MAX_LENGTH = 256;

function validateSnapshot(value: CombatTriggerSnapshot): CombatTriggerSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a combat trigger snapshot.');
  }
  if (typeof value.combatId !== 'string' || value.combatId.length === 0 || value.combatId.length > 128
    || !FOUNDRY_ID.test(value.combatId)) {
    throw new TypeError('Combat trigger snapshots need a valid Foundry combat ID.');
  }
  if (!Number.isSafeInteger(value.round) || value.round < 0) {
    throw new TypeError('Combat trigger snapshots need a non-negative whole round.');
  }
  if (value.turn !== null && (!Number.isSafeInteger(value.turn) || value.turn < 0)) {
    throw new TypeError('Combat trigger snapshots need a non-negative whole turn or null.');
  }
  for (const [label, id] of [['combatant', value.combatantId], ['actor', value.actorId]] as const) {
    if (id !== null && (typeof id !== 'string' || id.length === 0 || id.length > 128 || !FOUNDRY_ID.test(id))) {
      throw new TypeError(`Combat trigger snapshots need a valid ${label} ID or null.`);
    }
  }
  if (value.modifiedTime !== undefined && (!Number.isSafeInteger(value.modifiedTime) || value.modifiedTime < 0)) {
    throw new TypeError('Combat trigger snapshots need a non-negative whole modifiedTime.');
  }
  return Object.freeze({
    combatId: value.combatId,
    round: value.round,
    turn: value.turn,
    combatantId: value.combatantId,
    actorId: value.actorId,
    ...(value.modifiedTime === undefined ? {} : { modifiedTime: value.modifiedTime }),
  });
}

function position(snapshot: CombatTriggerSnapshot): Position {
  return { round: snapshot.round, turn: snapshot.turn };
}

function samePosition(left: Position, right: Position): boolean {
  return left.round === right.round && left.turn === right.turn;
}

function comparePosition(left: Position, right: Position): -1 | 0 | 1 {
  if (left.round !== right.round) return left.round < right.round ? -1 : 1;
  const leftTurn = left.turn ?? -1;
  const rightTurn = right.turn ?? -1;
  if (leftTurn === rightTurn) return 0;
  return leftTurn < rightTurn ? -1 : 1;
}

function positionPart(value: number | null): string {
  return value === null ? 'n' : String(value);
}

function positionKey(value: Position): string {
  return `${value.round},${positionPart(value.turn)}`;
}

function latestTime(tracker: CombatTracker, timestamp: number): void {
  if (tracker.latestModifiedTime === null || timestamp > tracker.latestModifiedTime) {
    tracker.latestModifiedTime = timestamp;
    tracker.occurrences.clear();
  }
}

/**
 * Convert confirmed combat updates and deletions into neutral trigger events.
 *
 * The caller chooses the active combat, seeds all current combats at ready, and
 * supplies only updateCombat/deleteCombat callbacks as confirmed event input. Tracker/render
 * switches are baselines, never trigger sources.
 */
export class CombatTriggerEventAdapter {
  private readonly combats = new Map<string, CombatTracker>();
  private activeCombatId: string | null = null;

  /** Seed an initial/reload baseline. No trigger is emitted. */
  initialize(snapshots: readonly CombatTriggerSnapshot[], activeCombatId: string | null = null): void {
    this.combats.clear();
    this.activeCombatId = null;
    for (const snapshot of snapshots) {
      const checked = validateSnapshot(snapshot);
      if (this.combats.has(checked.combatId)) throw new TypeError('Combat initialization contains a duplicate combat ID.');
      this.combats.set(checked.combatId, {
        snapshot: checked,
        latestModifiedTime: checked.modifiedTime ?? null,
        occurrences: new Map(),
      });
    }
    this.setActiveCombat(activeCombatId);
  }

  /** Select the active combat without changing any baseline or emitting events. */
  setActiveCombat(combatId: string | null): void {
    if (combatId !== null && (typeof combatId !== 'string' || combatId.length === 0
      || combatId.length > 128 || !FOUNDRY_ID.test(combatId))) {
      throw new TypeError('Expected a valid active combat ID or null.');
    }
    this.activeCombatId = combatId;
  }

  /** Quietly add or refresh a baseline, for example after createCombat. */
  seed(snapshot: CombatTriggerSnapshot): void {
    const checked = validateSnapshot(snapshot);
    const existing = this.combats.get(checked.combatId);
    if (!existing) {
      this.combats.set(checked.combatId, {
        snapshot: checked,
        latestModifiedTime: checked.modifiedTime ?? null,
        occurrences: new Map(),
      });
      return;
    }
    if (checked.modifiedTime !== undefined && existing.latestModifiedTime !== null
      && checked.modifiedTime < existing.latestModifiedTime) return;
    existing.snapshot = checked;
    if (checked.modifiedTime !== undefined) latestTime(existing, checked.modifiedTime);
  }

  /** Quiet cleanup when no confirmed deletion metadata is available. */
  remove(combatId: string): void {
    this.combats.delete(combatId);
    if (this.activeCombatId === combatId) this.activeCombatId = null;
  }

  /**
   * End a started, scene-active fight exactly once after confirmed deletion.
   * Foundry has removed it from the collection and cleared its current turn by
   * this point, so use the last confirmed snapshot and the document's isActive.
   */
  processDeletion(combatId: string, deletion: ConfirmedCombatDeletion): readonly TriggerEvent[] {
    const timestamp = deletion.modifiedTime;
    if (timestamp !== null && (!Number.isSafeInteger(timestamp) || timestamp < 0)) {
      throw new TypeError('Confirmed combat deletions need a non-negative whole modifiedTime or null.');
    }
    if (typeof deletion.wasActive !== 'boolean') throw new TypeError('Expected a confirmed combat activity flag.');
    const tracker = this.combats.get(combatId);
    if (!tracker) return [];
    if (timestamp !== null && tracker.latestModifiedTime !== null && timestamp < tracker.latestModifiedTime) return [];
    this.remove(combatId);
    if (timestamp === null || !deletion.wasActive || tracker.snapshot.round === 0) return [];
    const state = tracker.snapshot;
    return [validateTriggerEvent({
      id: `v1:${combatId}:${timestamp}:delete:combat-end`,
      kind: 'combat-end',
      combatId,
      round: state.round,
      turn: state.turn,
      combatantId: state.combatantId,
      actorId: state.actorId,
    })];
  }

  /**
   * Observe a post-updateCombat snapshot. No output is produced for missing
   * baselines, stale operations, non-position updates, rewinds, or another
   * combat. Older callback snapshots never replace a newer baseline.
   */
  processUpdate(snapshot: CombatTriggerSnapshot, update: ConfirmedCombatUpdate): readonly TriggerEvent[] {
    const current = validateSnapshot(snapshot);
    const tracker = this.combats.get(current.combatId);
    if (!tracker) {
      this.seed(current);
      return [];
    }

    const timestamp = update.modifiedTime;
    if (timestamp !== null && (!Number.isSafeInteger(timestamp) || timestamp < 0)) {
      throw new TypeError('Confirmed combat updates need a non-negative whole modifiedTime or null.');
    }
    if (timestamp !== null && tracker.latestModifiedTime !== null && timestamp < tracker.latestModifiedTime) return [];

    const previous = tracker.snapshot;
    const previousPosition = position(previous);
    const currentPosition = position(current);
    tracker.snapshot = current;

    if (timestamp === null) {
      if (current.modifiedTime !== undefined) latestTime(tracker, current.modifiedTime);
      return [];
    }
    latestTime(tracker, timestamp);

    const positionMoved = update.positionFieldsChanged && !samePosition(previousPosition, currentPosition);
    if (!positionMoved) return [];

    const transition = `${positionKey(previousPosition)}>${positionKey(currentPosition)}`;
    const occurrence = tracker.occurrences.get(transition) ?? 0;
    tracker.occurrences.set(transition, occurrence + 1);

    if (this.activeCombatId !== current.combatId || update.turnEventsEnabled === false) return [];

    const direction = comparePosition(previousPosition, currentPosition);
    const combatStarted = previous.round === 0 && current.round > 0;
    const events: TriggerEvent[] = [];
    if (combatStarted) {
      events.push(this.event(current, 'combat-start', timestamp, previousPosition, currentPosition, occurrence));
      if (current.turn !== null && current.combatantId !== null) {
        events.push(this.event(current, 'turn-start', timestamp, previousPosition, currentPosition, occurrence));
      }
      return events;
    }

    if (previous.round > 0 && current.round > 0 && direction < 0) {
      if (previous.turn !== null && previous.combatantId !== null) {
        events.push(this.event(previous, 'turn-end', timestamp, previousPosition, currentPosition, occurrence));
      }
      if (current.turn !== null && current.combatantId !== null) {
        events.push(this.event(current, 'turn-start', timestamp, previousPosition, currentPosition, occurrence));
      }
    }
    return events;
  }

  private event(
    state: CombatTriggerSnapshot,
    kind: TriggerEvent['kind'],
    timestamp: number,
    from: Position,
    to: Position,
    occurrence: number,
  ): TriggerEvent {
    const id = `v1:${state.combatId}:${timestamp}:${positionKey(from)}>${positionKey(to)}:${occurrence.toString(36)}:${kind}`;
    if (id.length > EVENT_ID_MAX_LENGTH) throw new TypeError('Combat trigger event identity exceeds the transport limit.');
    return validateTriggerEvent({
      id,
      kind,
      combatId: state.combatId,
      round: state.round,
      turn: state.turn,
      combatantId: state.combatantId,
      actorId: state.actorId,
    });
  }
}
