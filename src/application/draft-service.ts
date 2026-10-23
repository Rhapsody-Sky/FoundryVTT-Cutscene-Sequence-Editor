import { SequenceValidationError, createBreaksSequence, duplicateSequence, validateSequence } from '../domain/validation.js';
import type { SequenceV1 } from '../domain/sequence.js';
import type { SequenceRepository } from './ports.js';
import { enableAutomaticEnd } from './timeline-commands.js';

const MAX_HISTORY_ENTRIES = 100;

export interface DraftReplaceOptions {
  /** Consecutive replacements in the same group become one undo step. */
  readonly historyGroup?: string;
}

export interface DraftLoadOptions {
  /** Prevents an awaited read from replacing a draft after its initiating view is stale. */
  readonly shouldApply?: () => boolean;
}

export class DraftServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DraftServiceError';
    this.code = code;
  }
}

/** Keeps one editable copy separate from repository state until an explicit save. */
export class DraftService {
  private current: SequenceV1 | null = null;
  private baseRevision: number | null = null;
  private dirtyState = false;
  private conflictState = false;
  private documentEpoch = 0;
  private editGeneration = 0;
  private readonly saveInFlightByEpoch = new Map<number, Promise<SequenceV1>>();
  private saveQueue: Promise<void> = Promise.resolve();
  private undoHistory: SequenceV1[] = [];
  private redoHistory: SequenceV1[] = [];
  private historyGroup: string | undefined;
  private persistedSnapshot: SequenceV1 | null = null;

  constructor(private readonly repository: SequenceRepository, private readonly idFactory: () => string) {}

  get draft(): SequenceV1 | null {
    return this.current === null ? null : structuredClone(this.current);
  }

  get expectedRevision(): number | null {
    return this.baseRevision;
  }

  get dirty(): boolean {
    return this.dirtyState;
  }

  get conflict(): boolean {
    return this.conflictState;
  }

  get canUndo(): boolean {
    return this.undoHistory.length > 0;
  }

  get canRedo(): boolean {
    return this.redoHistory.length > 0;
  }

  create(name: string, options: { readonly automaticEnd?: boolean } = {}): SequenceV1 {
    const created = createBreaksSequence(name, this.idFactory);
    const next = options.automaticEnd ? enableAutomaticEnd(created) : created;
    this.current = next;
    this.baseRevision = null;
    this.dirtyState = true;
    this.conflictState = false;
    this.documentEpoch += 1;
    this.editGeneration += 1;
    this.resetHistory(null);
    return structuredClone(next);
  }

  async load(id: string, options: DraftLoadOptions = {}): Promise<SequenceV1> {
    if (options.shouldApply && !options.shouldApply()) {
      throw new DraftServiceError('LOAD_CANCELLED', 'The sequence load was cancelled because its requesting view is no longer current.');
    }
    const value = await this.repository.read(id);
    const loaded = validateSequence(value);
    if (loaded.id !== id) {
      throw new DraftServiceError('ID_MISMATCH', `The repository returned sequence "${loaded.id}" while loading "${id}".`);
    }
    if (options.shouldApply && !options.shouldApply()) {
      throw new DraftServiceError('LOAD_CANCELLED', 'The sequence load was cancelled because its requesting view is no longer current.');
    }
    this.current = loaded;
    this.baseRevision = loaded.revision;
    this.dirtyState = false;
    this.conflictState = false;
    this.documentEpoch += 1;
    this.editGeneration += 1;
    this.resetHistory(loaded);
    return structuredClone(loaded);
  }

  replace(value: SequenceV1, options: DraftReplaceOptions = {}): void {
    if (this.current === null) throw new DraftServiceError('NO_DRAFT', 'Create or load a sequence before replacing its draft.');
    const replacement = validateSequence(value);
    if (replacement.id !== this.current.id) {
      throw new DraftServiceError('ID_MISMATCH', 'A draft edit cannot change the sequence ID.');
    }
    if (replacement.revision !== this.current.revision) {
      throw new DraftServiceError('REVISION_MISMATCH', 'A draft edit cannot change its persisted revision.');
    }
    if (sameSequence(replacement, this.current)) {
      return;
    }
    if (!options.historyGroup || options.historyGroup !== this.historyGroup) {
      this.pushHistory(this.undoHistory, this.current);
    }
    this.redoHistory = [];
    this.historyGroup = options.historyGroup;
    this.current = replacement;
    this.dirtyState = this.persistedSnapshot === null || !sameSequence(replacement, this.persistedSnapshot);
    this.editGeneration += 1;
  }

  undo(): SequenceV1 | null {
    if (this.current === null || this.undoHistory.length === 0) return null;
    this.pushHistory(this.redoHistory, this.current);
    this.current = this.undoHistory.pop()!;
    this.historyGroup = undefined;
    this.dirtyState = this.persistedSnapshot === null || !sameSequence(this.current, this.persistedSnapshot);
    this.editGeneration += 1;
    return structuredClone(this.current);
  }

  redo(): SequenceV1 | null {
    if (this.current === null || this.redoHistory.length === 0) return null;
    this.pushHistory(this.undoHistory, this.current);
    this.current = this.redoHistory.pop()!;
    this.historyGroup = undefined;
    this.dirtyState = this.persistedSnapshot === null || !sameSequence(this.current, this.persistedSnapshot);
    this.editGeneration += 1;
    return structuredClone(this.current);
  }

  async save(): Promise<SequenceV1> {
    this.historyGroup = undefined;
    if (this.current === null) throw new DraftServiceError('NO_DRAFT', 'There is no sequence draft to save.');
    const documentEpoch = this.documentEpoch;
    const existingSave = this.saveInFlightByEpoch.get(documentEpoch);
    if (existingSave !== undefined) return existingSave;
    if (!this.dirtyState) return structuredClone(this.current);

    const snapshot = validateSequence(this.current);
    const expectedRevision = this.baseRevision;
    const editGeneration = this.editGeneration;
    const queued = this.saveQueue.then(() => this.performSave(snapshot, expectedRevision, documentEpoch, editGeneration));
    this.saveQueue = queued.then(() => undefined, () => undefined);
    let operation!: Promise<SequenceV1>;
    operation = queued.finally(() => {
      if (this.saveInFlightByEpoch.get(documentEpoch) === operation) this.saveInFlightByEpoch.delete(documentEpoch);
    });
    this.saveInFlightByEpoch.set(documentEpoch, operation);
    return operation;
  }

  duplicate(name: string): SequenceV1 {
    if (this.current === null) throw new DraftServiceError('NO_DRAFT', 'Load a sequence before duplicating it.');
    const next = duplicateSequence(this.current, name, this.idFactory);
    this.current = next;
    this.baseRevision = null;
    this.dirtyState = true;
    this.conflictState = false;
    this.documentEpoch += 1;
    this.editGeneration += 1;
    this.resetHistory(null);
    return structuredClone(next);
  }

  private async performSave(
    snapshot: SequenceV1,
    expectedRevision: number | null,
    documentEpoch: number,
    editGeneration: number
  ): Promise<SequenceV1> {
    try {
      const saved = validateSequence(await this.repository.save(snapshot, expectedRevision));
      if (saved.id !== snapshot.id) {
        throw new DraftServiceError('ID_MISMATCH', 'The repository saved a different sequence ID than requested.');
      }
      if (this.documentEpoch === documentEpoch && this.current?.id === snapshot.id) {
        this.baseRevision = saved.revision;
        this.conflictState = false;
        this.persistedSnapshot = structuredClone(saved);
        this.updateHistoryRevision(saved.id, saved.revision);
        if (this.editGeneration === editGeneration) {
          this.current = saved;
          this.dirtyState = false;
        } else {
          // Keep edits made while the repository was saving, but base the next save on this result.
          this.current = validateSequence({ ...this.current, revision: saved.revision });
          this.dirtyState = !sameSequence(this.current, saved);
        }
      }
      return structuredClone(saved);
    } catch (error) {
      if (this.documentEpoch === documentEpoch && this.current?.id === snapshot.id && hasErrorCode(error, 'CONFLICT')) {
        this.conflictState = true;
      }
      throw error;
    }
  }

  private resetHistory(persisted: SequenceV1 | null): void {
    this.undoHistory = [];
    this.redoHistory = [];
    this.historyGroup = undefined;
    this.persistedSnapshot = persisted === null ? null : structuredClone(persisted);
  }

  private pushHistory(history: SequenceV1[], value: SequenceV1): void {
    history.push(structuredClone(value));
    if (history.length > MAX_HISTORY_ENTRIES) history.splice(0, history.length - MAX_HISTORY_ENTRIES);
  }

  private updateHistoryRevision(id: string, revision: number): void {
    const update = (history: SequenceV1[]): void => {
      for (let index = 0; index < history.length; index += 1) {
        const snapshot = history[index]!;
        if (snapshot.id === id && snapshot.revision !== revision) {
          history[index] = validateSequence({ ...snapshot, revision });
        }
      }
    };
    update(this.undoHistory);
    update(this.redoHistory);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (error instanceof SequenceValidationError) return error.code === code;
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function sameSequence(left: SequenceV1, right: SequenceV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
