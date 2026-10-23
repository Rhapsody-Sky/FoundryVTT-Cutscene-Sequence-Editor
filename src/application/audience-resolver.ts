import type { SequenceV1 } from '../domain/sequence.js';
import { getSequenceAudience } from '../domain/sequence-audience.js';

export interface AudienceUser {
  readonly id: string;
  readonly name: string;
  readonly role: number;
  readonly active: boolean;
}

export interface UnavailableAudienceUser {
  readonly userId: string;
  readonly reason: 'offline' | 'removed' | 'not-player';
}

export interface ResolvedAudience {
  readonly includeGM: boolean;
  readonly players: readonly AudienceUser[];
  readonly unavailable: readonly UnavailableAudienceUser[];
}

/** Resolves authored user identities; discovery and browser-session selection stay in the coordinator. */
export function resolveSequenceAudience(sequence: SequenceV1, users: readonly AudienceUser[], controllerUserId: string): ResolvedAudience {
  const audience = getSequenceAudience(sequence);
  const byId = new Map(users.map(user => [user.id, user]));
  const players: AudienceUser[] = [];
  const unavailable: UnavailableAudienceUser[] = [];
  const ids = audience.mode === 'all'
    ? users.filter(user => user.id !== controllerUserId && user.role < 3 && user.active).map(user => user.id)
    : audience.userIds;
  for (const id of new Set(ids)) {
    const user = byId.get(id);
    if (!user) unavailable.push({ userId: id, reason: 'removed' });
    else if (user.id === controllerUserId || user.role >= 3) unavailable.push({ userId: id, reason: 'not-player' });
    else if (!user.active) unavailable.push({ userId: id, reason: 'offline' });
    else players.push({ ...user });
  }
  return Object.freeze({ includeGM: audience.includeGM, players: Object.freeze(players),
    unavailable: Object.freeze(unavailable.map(user => Object.freeze(user))) });
}
