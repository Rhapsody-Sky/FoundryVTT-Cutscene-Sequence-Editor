import type { SequenceV1 } from '../domain/sequence.js';


export interface SequenceSummary {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  /** An unreadable entry remains listed and preserved, but cannot be edited. */
  readonly issue?: string;
}

/** Package 1 implements the compendium revision-log adapter proven by G2. */
export interface SequenceRepository {
  list(): Promise<readonly SequenceSummary[]>;
  /** Unknown deliberately: validate versions and contents before using persisted data. */
  read(id: string): Promise<unknown>;
  /** Reject stale revisions without overwriting the existing record. Null means create. */
  save(sequence: SequenceV1, expectedRevision: number | null): Promise<SequenceV1>;
  /** Append a terminal deletion at the expected revision, preserving stored history. */
  delete(id: string, expectedRevision: number): Promise<void>;
}


