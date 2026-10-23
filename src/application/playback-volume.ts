import { MODULE_ID } from '../module-identity.js';

/** A viewer preference; never part of a saved sequence or a shared playback command. */
export interface PlaybackVolume {
  readonly value: number;
  set(value: number): void;
  subscribe(listener: (value: number) => void): () => void;
}

export interface PlaybackVolumeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function playbackVolumeKey(worldId: string, userId: string): string {
  return `${MODULE_ID}.playback-volume.${encodeURIComponent(worldId)}:${encodeURIComponent(userId)}`;
}

export class LocalPlaybackVolume implements PlaybackVolume {
  private current = 1;
  private readonly listeners = new Set<(value: number) => void>();

  constructor(private readonly persistence?: { storage: PlaybackVolumeStorage; key: string }) {
    try {
      const stored = persistence?.storage.getItem(persistence.key);
      if (stored !== null && stored !== undefined && stored.trim() !== '') {
        const value = Number(stored);
        if (Number.isFinite(value) && value >= 0 && value <= 1) this.current = value;
      }
    } catch { /* Browser storage availability must not block playback. */ }
  }

  get value(): number { return this.current; }

  set(value: number): void {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(1, value));
    if (next === this.current) return;
    this.current = next;
    try { this.persistence?.storage.setItem(this.persistence.key, String(next)); }
    catch { /* Keep the live preference even when storage is disabled or full. */ }
    for (const listener of [...this.listeners]) {
      try { listener(next); } catch { /* One observer cannot prevent the others from becoming quieter. */ }
    }
  }

  subscribe(listener: (value: number) => void): () => void {
    this.listeners.add(listener);
    try { listener(this.current); } catch { /* The observer owns its own failure handling. */ }
    return () => { this.listeners.delete(listener); };
  }
}
