import type { TriggerEvent } from '../../domain/sequence-triggers.js';
import { CombatTriggerEventAdapter, type CombatTriggerSnapshot } from './combat-trigger-events.js';

export interface NativeTriggerCombat {
  readonly id: string;
  readonly round: number;
  readonly turn: number | null;
  /** Scene-active status on the document, including after collection deletion. */
  readonly isActive?: boolean;
  readonly combatant?: { readonly id: string; readonly actorId?: string | null;
    readonly actor?: { readonly id: string } | null } | null;
  readonly _stats?: { readonly modifiedTime?: number | null };
}

type HookListener = (...args: unknown[]) => void;
export interface CombatTriggerBindingHost {
  readonly hooks: {
    on(event: string, listener: HookListener): unknown;
    off(event: string, listener: HookListener): unknown;
  };
  combats(): readonly NativeTriggerCombat[];
  /** Foundry's scene-active collection accessor; never the tracker-viewed game.combat. */
  activeCombatId(): string | null;
  events(events: readonly TriggerEvent[]): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function combatTriggerSnapshot(combat: NativeTriggerCombat): CombatTriggerSnapshot {
  const modifiedTime = combat._stats?.modifiedTime;
  return { combatId: combat.id, round: combat.round, turn: combat.turn,
    combatantId: combat.combatant?.id ?? null,
    actorId: combat.combatant?.actor?.id ?? combat.combatant?.actorId ?? null,
    ...(typeof modifiedTime === 'number' ? { modifiedTime } : {}) };
}

/** Native hook lifetime and field mapping, separate from event identity and matching. */
export class CombatTriggerBinding {
  private readonly adapter = new CombatTriggerEventAdapter();
  private readonly listeners: Array<{ event: string; listener: HookListener }> = [];
  private disposed = false;

  constructor(private readonly host: CombatTriggerBindingHost) {
    this.adapter.initialize(host.combats().map(combatTriggerSnapshot), host.activeCombatId());
    this.listen('updateCombat', (value, changedValue, optionsValue) => {
      const combat = this.combat(value);
      const changed = record(changedValue), options = record(optionsValue);
      if (!combat || !changed || !options || typeof options.modifiedTime !== 'number') return;
      this.adapter.setActiveCombat(this.host.activeCombatId());
      const events = this.adapter.processUpdate(combatTriggerSnapshot(combat), {
        modifiedTime: options.modifiedTime,
        positionFieldsChanged: Object.hasOwn(changed, 'round') || Object.hasOwn(changed, 'turn'),
        turnEventsEnabled: options.turnEvents !== false
      });
      if (events.length && !this.disposed) this.host.events(events);
    });
    this.listen('createCombat', value => {
      const combat = this.combat(value);
      if (combat) this.adapter.seed(combatTriggerSnapshot(combat));
      this.adapter.setActiveCombat(this.host.activeCombatId());
    });
    this.listen('deleteCombat', (value, optionsValue) => {
      const combat = this.combat(value);
      const options = record(optionsValue);
      const events = combat ? this.adapter.processDeletion(combat.id, {
        modifiedTime: typeof options?.modifiedTime === 'number' ? options.modifiedTime : null,
        wasActive: combat.isActive === true,
      }) : [];
      this.adapter.setActiveCombat(this.host.activeCombatId());
      if (events.length && !this.disposed) this.host.events(events);
    });
    for (const hook of ['createCombatant', 'updateCombatant', 'deleteCombatant']) {
      this.listen(hook, value => {
        const parent = this.combat(record(value)?.parent);
        if (!parent) return;
        // Child hooks precede the parent's synchronous setupTurns in Foundry v14.
        // Observe that confirmed roster change afterwards, without creating a turn event.
        queueMicrotask(() => {
          if (this.disposed) return;
          const current = this.host.combats().find(combat => combat.id === parent.id);
          if (current) this.adapter.seed(combatTriggerSnapshot(current));
        });
      });
    }
    for (const hook of ['renderCombatTracker', 'canvasReady']) {
      this.listen(hook, () => this.adapter.setActiveCombat(this.host.activeCombatId()));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { event, listener } of this.listeners) this.host.hooks.off(event, listener);
    this.listeners.length = 0;
  }

  private listen(event: string, callback: HookListener): void {
    const listener: HookListener = (...args) => { if (!this.disposed) callback(...args); };
    this.listeners.push({ event, listener });
    this.host.hooks.on(event, listener);
  }

  private combat(value: unknown): NativeTriggerCombat | null {
    const candidate = record(value);
    return candidate && typeof candidate.id === 'string' && typeof candidate.round === 'number'
      && (candidate.turn === null || typeof candidate.turn === 'number') ? value as NativeTriggerCombat : null;
  }
}
