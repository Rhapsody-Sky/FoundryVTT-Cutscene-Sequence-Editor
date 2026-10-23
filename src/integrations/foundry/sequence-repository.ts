import type { SequenceRepository, SequenceSummary } from '../../application/ports.js';
import { validateSequence } from '../../domain/validation.js';
import type { SequenceV1 } from '../../domain/sequence.js';

import { MODULE_ID } from '../../module-identity.js';
const PACK_NAME = 'stagecraft-sequences';
const PACK_COLLECTION = `world.${PACK_NAME}`;
const PACK_LABEL = 'Stagecraft Sequences';
const ROOT_MARKER = 'authority';
const ROOT_SCHEMA_VERSION = 1;
const SEQUENCE_SCHEMA_VERSION = 1;
const CREATION_CLAIM_ROLE = 'sequence-creation-claim';
const CREATION_CLAIM_VERSION = 1;
const REVISION_RECORD_VERSION = 1;
// V1 readers reject this version before looking for a sequence payload.
const DELETION_RECORD_VERSION = 2;
const MAX_REVISIONS = 5_000;
// Reserve one final slot so reaching the save limit cannot prevent deletion.
const MAX_REVISION_RECORDS = MAX_REVISIONS + 1;
const MAX_ID_LENGTH = 128;
const MAX_SUMMARY_NAME_LENGTH = 120;

export type RepositoryRpcEvent = 'modifyDocument';
export type RepositoryPermissionLevel = 'NONE' | 'LIMITED' | 'OBSERVER' | 'OWNER';

export interface RepositoryUser {
  readonly id: string;
  /** Foundry roles: Player 1, Trusted 2, Assistant 3, Gamemaster 4. */
  readonly role: number;
}

export interface RepositoryPack {
  readonly documentName: string;
  permissionLevel(userId: string): RepositoryPermissionLevel | undefined;
}

/** Values are read lazily by the adapter so a role change in the open world is observed. */
export interface RepositoryHost {
  readonly worldId: string;
  readonly currentUser: RepositoryUser;
  readonly users: readonly RepositoryUser[];
  findPack(collection: string): RepositoryPack | undefined;
  canModifySettings(userId: string): boolean;
  rpc(event: RepositoryRpcEvent, request: Record<string, unknown>): Promise<unknown>;
  /** Public CompendiumCollection.createCompendium wrapper; it registers the pack in game.packs. */
  createPack(metadata: {
    readonly name: string;
    readonly label: string;
    readonly type: 'JournalEntry';
    readonly ownership: {
      readonly PLAYER: 'OBSERVER';
      readonly TRUSTED: 'OBSERVER';
      readonly ASSISTANT: 'OWNER';
      readonly GAMEMASTER: 'OWNER';
    };
  }): Promise<void>;
  makeId(): string;
}

export type RepositoryErrorCode =
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INVALID_SEQUENCE'
  | 'CORRUPT_STORAGE'
  | 'UNSUPPORTED_DATA'
  | 'UNSAFE_PERMISSIONS'
  | 'STORAGE_FAILURE';

export class RepositoryError extends Error {
  constructor(
    readonly code: RepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'RepositoryError';
  }
}

interface StoredRevisionBase {
  readonly id: string;
  readonly index: number;
  readonly previous: number;
  readonly requestId: string;
}

interface StoredSaveRevision extends StoredRevisionBase {
  readonly operation: 'save';
  readonly sequence: SequenceV1;
}

interface StoredDeletionRevision extends StoredRevisionBase {
  readonly operation: 'delete';
}

type StoredRevision = StoredSaveRevision | StoredDeletionRevision;

interface StoredSequence {
  readonly sequenceId: string;
  readonly parentId: string;
  readonly parentName: string;
  readonly sequence?: SequenceV1;
  readonly revisions?: readonly StoredRevision[];
  readonly deletion?: StoredDeletionRevision;
  readonly reservationPending?: boolean;
  readonly issue?: RepositoryError;
}

interface StoredCreationClaim {
  readonly sequenceId: string;
  readonly pageId?: string | undefined;
  readonly createRequestId?: string | undefined;
  readonly issue?: RepositoryError | undefined;
}

interface RepositorySnapshot {
  readonly sequences: ReadonlyMap<string, StoredSequence>;
}

interface EntryRecord {
  readonly _id?: unknown;
  readonly name?: unknown;
  readonly flags?: unknown;
  readonly pages?: unknown;
}

interface PageRecord {
  readonly _id?: unknown;
  readonly flags?: unknown;
  readonly _stats?: unknown;
}

interface NativeResponse {
  readonly result?: unknown;
  readonly error?: unknown;
}

const PACK_METADATA: RepositoryHost['createPack'] extends (metadata: infer T) => Promise<void>
  ? T
  : never = {
    name: PACK_NAME,
    label: PACK_LABEL,
    type: 'JournalEntry',
    ownership: {
      PLAYER: 'OBSERVER',
      TRUSTED: 'OBSERVER',
      ASSISTANT: 'OWNER',
      GAMEMASTER: 'OWNER',
    },
  };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function flagsOf(value: unknown): Record<string, unknown> | undefined {
  return object(object(value)?.[MODULE_ID]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return object(value) !== undefined;
}

function responseResult(value: unknown): unknown {
  const response = object(value) as NativeResponse | undefined;
  if (!response) {
    throw new RepositoryError('STORAGE_FAILURE', 'Foundry returned an invalid document response.');
  }
  if (response.error !== undefined) {
    const details = object(response.error);
    throw new RepositoryError(
      'STORAGE_FAILURE',
      stringValue(details?.message) ?? 'Foundry rejected the document operation.'
    );
  }
  return response.result;
}

function slotId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_REVISION_RECORDS) {
    throw new RepositoryError('UNSUPPORTED_DATA', `Sequence history exceeds ${MAX_REVISIONS} saved revisions and one terminal deletion.`);
  }
  return `r${index.toString(36).padStart(15, '0')}`;
}

function creationClaimPageId(sequenceId: string): string {
  // This is only a deterministic Compendium page slot, not an authority token.
  // Always compare the full sequenceId in the stored claim to fail closed on collisions.
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(sequenceId)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & mask;
  }
  return `c${hash.toString(16).padStart(16, '0').slice(0, 15)}`;
}

function isValidSequenceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function summaryName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return 'Unavailable sequence';
  return value.length > MAX_SUMMARY_NAME_LENGTH
    ? `${value.slice(0, MAX_SUMMARY_NAME_LENGTH - 1)}…`
    : value;
}

function storageError(message: string, cause: unknown): RepositoryError {
  if (cause instanceof RepositoryError) return cause;
  return new RepositoryError('STORAGE_FAILURE', message, { cause });
}

function persistedValidationError(error: unknown, sequenceId: string, revision: number): RepositoryError {
  const validationCode = stringValue(object(error)?.code);
  const code = validationCode?.startsWith('UNSUPPORTED') ? 'UNSUPPORTED_DATA' : 'CORRUPT_STORAGE';
  const message = code === 'UNSUPPORTED_DATA'
    ? `Sequence ${sequenceId} uses an unsupported format at revision ${revision}.`
    : `Sequence ${sequenceId} has invalid revision data at ${revision}.`;
  return new RepositoryError(code, message, { cause: error });
}

function assertVersion(value: unknown, expected: number, label: string): void {
  if (value === expected) return;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > expected) {
    throw new RepositoryError('UNSUPPORTED_DATA', `Unsupported ${label} version ${value}.`);
  }
  throw new RepositoryError('CORRUPT_STORAGE', `Stored ${label} has no valid version marker.`);
}

export function createFoundryRepository(host: RepositoryHost): SequenceRepository {
  if (!host.worldId) throw new RepositoryError('STORAGE_FAILURE', 'A loaded Foundry world is required.');
  return new FoundrySequenceRepository(host);
}

class FoundrySequenceRepository implements SequenceRepository {
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(private readonly host: RepositoryHost) {}

  async list(): Promise<readonly SequenceSummary[]> {
    const pack = this.host.findPack(PACK_COLLECTION);
    if (!pack) return [];
    this.assertPackType(pack);
    const snapshot = await this.readSnapshot();
    return [...snapshot.sequences.values()]
      .filter((stored) => !stored.deletion)
      .map((stored): SequenceSummary => stored.sequence
        ? {
            id: stored.sequenceId,
            revision: stored.sequence.revision,
            name: stored.sequence.name,
          }
        : {
            id: stored.sequenceId,
            revision: 0,
            name: summaryName(stored.parentName),
            issue: stored.issue?.code ?? 'CORRUPT_STORAGE',
          })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async read(id: string): Promise<unknown> {
    if (!isValidSequenceId(id)) {
      throw new RepositoryError('INVALID_SEQUENCE', 'Sequence ID is invalid.');
    }
    if (!this.host.findPack(PACK_COLLECTION)) {
      throw new RepositoryError('NOT_FOUND', `Sequence ${id} was not found.`);
    }
    const snapshot = await this.readSnapshot();
    const stored = snapshot.sequences.get(id);
    if (!stored) throw new RepositoryError('NOT_FOUND', `Sequence ${id} was not found.`);
    if (stored.issue) throw stored.issue;
    if (stored.deletion) throw new RepositoryError('NOT_FOUND', `Sequence ${id} was deleted.`);
    if (!stored.sequence) {
      throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${id} has no readable revision.`);
    }
    return structuredClone(stored.sequence);
  }

  async save(sequence: SequenceV1, expectedRevision: number | null): Promise<SequenceV1> {
    const validated = this.validateInput(sequence);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new RepositoryError('INVALID_SEQUENCE', 'Expected revision must be a non-negative integer or null.');
    }
    if (!isValidSequenceId(validated.id)) {
      throw new RepositoryError('INVALID_SEQUENCE', 'Sequence ID is invalid.');
    }

    return this.withWriteLock(validated.id, () => this.saveLocked(validated, expectedRevision));
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    if (!isValidSequenceId(id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new RepositoryError('INVALID_SEQUENCE', 'Deletion requires a valid sequence ID and positive expected revision.');
    }
    return this.withWriteLock(id, () => this.deleteLocked(id, expectedRevision));
  }

  private async deleteLocked(id: string, expectedRevision: number): Promise<void> {
    this.assertWriterRole();
    const pack = this.host.findPack(PACK_COLLECTION);
    if (!pack) throw new RepositoryError('NOT_FOUND', `Sequence ${id} was not found.`);
    this.assertPackType(pack);
    this.assertSafePermissions(pack);
    const snapshot = await this.readSnapshot();
    const existing = snapshot.sequences.get(id);
    if (existing?.issue) throw existing.issue;
    if (!existing || existing.deletion) throw new RepositoryError('NOT_FOUND', `Sequence ${id} was not found or was deleted.`);
    if (!existing.sequence || existing.sequence.revision !== expectedRevision) {
      throw new RepositoryError('CONFLICT', `Sequence ${id} changed since revision ${expectedRevision}.`);
    }
    const nextIndex = expectedRevision + 1;
    const requestId = this.requireId(this.host.makeId(), 'request');
    const operation = this.revisionCreateOperation(existing.parentId, nextIndex, expectedRevision, requestId, {
      role: 'revision',
      recordVersion: DELETION_RECORD_VERSION,
      operation: 'delete',
      sequenceId: id,
    });

    let writeError: unknown;
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send(operation);
    } catch (error) {
      writeError = error;
    }
    const current = (await this.readSnapshot()).sequences.get(id);
    if (current?.issue) throw current.issue;
    if (current?.deletion?.requestId === requestId) return;
    if (current?.deletion || (current?.sequence && current.sequence.revision >= nextIndex)) {
      throw new RepositoryError('CONFLICT', `Sequence ${id} was changed by another writer.`, { cause: writeError });
    }
    if (writeError !== undefined) {
      throw storageError('The deletion could not be confirmed. Reload the library before retrying.', writeError);
    }
    throw new RepositoryError('STORAGE_FAILURE', 'Foundry acknowledged a deletion that could not be read back.');
  }

  private validateInput(value: unknown): SequenceV1 {
    try {
      return validateSequence(value);
    } catch (error) {
      throw new RepositoryError('INVALID_SEQUENCE', 'The sequence is invalid or uses an unsupported format.', { cause: error });
    }
  }

  private async saveLocked(input: SequenceV1, expectedRevision: number | null): Promise<SequenceV1> {
    const { pack } = await this.ensureWritablePack(expectedRevision);
    this.assertSafePermissions(pack);

    let snapshot = await this.readSnapshot();
    const existing = snapshot.sequences.get(input.id);
    if (expectedRevision === null && existing?.reservationPending) {
      throw new RepositoryError('CONFLICT', `Sequence ${input.id} already has a creation reservation.`);
    }
    if (existing?.issue) throw existing.issue;
    if (existing?.deletion) throw new RepositoryError('NOT_FOUND', `Sequence ${input.id} was deleted.`);

    if (expectedRevision === null) {
      if (existing) throw new RepositoryError('CONFLICT', `Sequence ${input.id} already exists.`);
      return this.createSequence(input, pack);
    }

    if (!existing?.sequence || existing.sequence.revision !== expectedRevision) {
      throw new RepositoryError('CONFLICT', `Sequence ${input.id} changed since revision ${expectedRevision}.`);
    }
    if (expectedRevision >= MAX_REVISIONS) {
      throw new RepositoryError('UNSUPPORTED_DATA', `Sequence history exceeds ${MAX_REVISIONS} revisions.`);
    }

    const nextIndex = expectedRevision + 1;
    const requestId = this.requireId(this.host.makeId(), 'request');
    const payload = this.validateInput({ ...input, revision: nextIndex });
    const operation = this.revisionCreateOperation(existing.parentId, nextIndex, expectedRevision, requestId, this.saveRecord(payload));

    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send(operation);
    } catch (error) {
      snapshot = await this.readSnapshot();
      const recovered = this.findRequest(snapshot, input.id, requestId);
      if (recovered) return structuredClone(recovered);
      const current = snapshot.sequences.get(input.id);
      if (current?.issue) throw current.issue;
      if (current?.deletion || (current?.sequence && current.sequence.revision >= nextIndex)) {
        throw new RepositoryError('CONFLICT', `Sequence ${input.id} was saved by another writer.`, { cause: error });
      }
      throw storageError('The save could not be confirmed. Do not retry until the sequence is reloaded.', error);
    }

    snapshot = await this.readSnapshot();
    const saved = this.findRequest(snapshot, input.id, requestId);
    if (!saved) {
      const current = snapshot.sequences.get(input.id);
      if (current?.deletion || (current?.sequence && current.sequence.revision >= nextIndex)) {
        throw new RepositoryError('CONFLICT', `Sequence ${input.id} was saved by another writer.`);
      }
      throw new RepositoryError('STORAGE_FAILURE', 'Foundry acknowledged a save that could not be read back.');
    }
    return structuredClone(saved);
  }

  private async createSequence(
    input: SequenceV1,
    pack: RepositoryPack
  ): Promise<SequenceV1> {
    const requestId = this.requireId(this.host.makeId(), 'request');
    const createRequestId = this.requireId(this.host.makeId(), 'creation request');
    const payload = this.validateInput({ ...input, revision: 1 });
    const claimPageId = creationClaimPageId(payload.id);
    const root = await this.findRoot();
    if (!root) {
      throw new RepositoryError('CORRUPT_STORAGE', 'The sequence compendium has no authority root; automatic repair is blocked.');
    }
    const rootId = this.requireEntryId(root);
    if (!rootId) throw new RepositoryError('CORRUPT_STORAGE', 'The authority root has no server-assigned ID.');

    await this.reserveSequence(rootId, claimPageId, payload.id, createRequestId, pack);

    // A reservation is the create-time compare-and-set. Check for a parent that may
    // have appeared after this client's first snapshot before creating another one.
    const entriesAfterReservation = await this.readEntries();
    const existingParents = entriesAfterReservation.filter((entry) => {
      const flags = flagsOf(entry.flags);
      return flags?.role === 'sequence' && flags.sequenceId === payload.id;
    });
    if (existingParents.length > 0) {
      throw new RepositoryError('CONFLICT', `Sequence ${payload.id} already has a sequence entry.`);
    }

    const parentOperation = {
      pack: PACK_COLLECTION,
      data: [{
        name: payload.name,
        flags: {
          [MODULE_ID]: {
            role: 'sequence',
            schemaVersion: SEQUENCE_SCHEMA_VERSION,
            sequenceId: payload.id,
            createRequestId,
            reservationId: claimPageId,
          },
        },
      }],
      renderSheet: false,
    };

    let parentId: string | undefined;
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      const created = await this.send({ type: 'JournalEntry', action: 'create', operation: parentOperation });
      parentId = this.resultDocumentId(created);
      if (!parentId) {
        const rawEntries = await this.readEntries();
        const matches = rawEntries.filter((entry) => {
          const flags = flagsOf(entry.flags);
          return flags?.role === 'sequence' && flags.sequenceId === payload.id
            && flags.createRequestId === createRequestId && flags.reservationId === claimPageId;
        });
        if (matches.length === 1) parentId = this.requireEntryId(matches[0]);
        else if (matches.length > 1) {
          throw new RepositoryError('CORRUPT_STORAGE', `Duplicate creation request ${createRequestId} was found.`);
        }
      }
    } catch (error) {
      const rawEntries = await this.readEntries();
      const matches = rawEntries.filter((entry) => {
        const flags = flagsOf(entry.flags);
        return flags?.role === 'sequence' && flags.sequenceId === payload.id
          && flags.createRequestId === createRequestId && flags.reservationId === claimPageId;
      });
      if (matches.length === 1) parentId = this.requireEntryId(matches[0]);
      else if (matches.length > 1) {
        throw new RepositoryError('CORRUPT_STORAGE', `Duplicate creation request ${createRequestId} was found.`, { cause: error });
      } else {
        throw storageError('Sequence creation could not be confirmed. Do not retry until the library is reloaded.', error);
      }
    }

    if (!parentId) throw new RepositoryError('STORAGE_FAILURE', 'Foundry did not return the new sequence entry ID.');
    const revisionOperation = this.revisionCreateOperation(parentId, 1, 0, requestId, this.saveRecord(payload));
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send(revisionOperation);
    } catch (error) {
      const snapshot = await this.readSnapshot();
      const recovered = this.findRequest(snapshot, input.id, requestId);
      if (recovered) return structuredClone(recovered);
      throw storageError('The sequence entry exists but its first revision could not be confirmed.', error);
    }

    const after = await this.readSnapshot();
    const saved = this.findRequest(after, input.id, requestId);
    if (!saved) {
      throw new RepositoryError('STORAGE_FAILURE', 'The first sequence revision could not be read back.');
    }
    this.assertSafePermissions(pack);
    return structuredClone(saved);
  }

  private async reserveSequence(
    rootId: string,
    pageId: string,
    sequenceId: string,
    createRequestId: string,
    pack: RepositoryPack
  ): Promise<void> {
    const operation = {
      type: 'JournalEntryPage',
      action: 'create',
      operation: {
        pack: PACK_COLLECTION,
        parentUuid: `Compendium.${PACK_COLLECTION}.JournalEntry.${rootId}`,
        keepId: true,
        render: false,
        renderSheet: false,
        data: [{
          _id: pageId,
          name: `Create ${sequenceId}`,
          type: 'text',
          flags: {
            [MODULE_ID]: {
              role: CREATION_CLAIM_ROLE,
              recordVersion: CREATION_CLAIM_VERSION,
              sequenceId,
              createRequestId,
            },
          },
        }],
      },
    };

    let writeError: unknown;
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send(operation);
    } catch (error) {
      writeError = error;
    }

    const entries = await this.readEntries();
    const roots = entries.filter((entry) => flagsOf(entry.flags)?.role === ROOT_MARKER);
    if (roots.length !== 1) {
      throw new RepositoryError('CORRUPT_STORAGE', 'The sequence compendium authority root could not be selected.');
    }
    const root = roots[0];
    if (!root) throw new RepositoryError('CORRUPT_STORAGE', 'The sequence compendium authority root could not be selected.');
    const rootPages = Array.isArray(root.pages) ? root.pages as PageRecord[] : [];
    const matches = rootPages.filter((page) => page._id === pageId);
    if (matches.length > 1) {
      throw new RepositoryError('CORRUPT_STORAGE', `Creation reservation slot ${pageId} is duplicated.`);
    }
    const claimPage = matches[0];
    if (!claimPage) {
      if (writeError !== undefined) {
        throw storageError('Sequence creation reservation could not be confirmed. Do not retry until the library is reloaded.', writeError);
      }
      throw new RepositoryError('STORAGE_FAILURE', 'Foundry acknowledged a creation reservation that could not be read back.');
    }

    const record = flagsOf(claimPage.flags);
    if (record?.role !== CREATION_CLAIM_ROLE) {
      throw new RepositoryError('CONFLICT', `Creation reservation slot ${pageId} is already occupied.`);
    }
    const claimedSequenceId = record.sequenceId;
    if (claimedSequenceId !== sequenceId) {
      throw new RepositoryError('CONFLICT', `Creation reservation hash collision for sequence ${sequenceId}.`);
    }
    assertVersion(record.recordVersion, CREATION_CLAIM_VERSION, 'sequence creation reservation');
    const actor = stringValue(object(claimPage._stats)?.lastModifiedBy);
    if (!actor) {
      throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} creation reservation has no server actor stamp.`);
    }
    const claimedRequestId = stringValue(record.createRequestId);
    if (!claimedRequestId) {
      throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} creation reservation has no request ID.`);
    }
    if (claimedRequestId !== createRequestId) {
      throw new RepositoryError('CONFLICT', `Sequence ${sequenceId} is already being created by another request.`);
    }
  }

  private revisionCreateOperation(
    parentId: string,
    index: number,
    previous: number,
    requestId: string,
    record: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      type: 'JournalEntryPage',
      action: 'create',
      operation: {
        pack: PACK_COLLECTION,
        parentUuid: `Compendium.${PACK_COLLECTION}.JournalEntry.${parentId}`,
        keepId: true,
        render: false,
        renderSheet: false,
        data: [{
          _id: slotId(index),
          name: `Revision ${index}`,
          type: 'text',
          flags: {
            [MODULE_ID]: {
              ...record,
              index,
              previous,
              requestId,
            },
          },
        }],
      },
    };
  }

  private saveRecord(payload: SequenceV1): Record<string, unknown> {
    return { role: 'revision', recordVersion: REVISION_RECORD_VERSION, payload };
  }

  private async ensureWritablePack(expectedRevision: number | null): Promise<{
    readonly pack: RepositoryPack;
    readonly createdByThisClient: boolean;
  }> {
    this.assertWriterRole();
    let pack = this.host.findPack(PACK_COLLECTION);
    if (pack) {
      this.assertPackType(pack);
      this.assertSafePermissions(pack);
      return { pack, createdByThisClient: false };
    }
    if (expectedRevision !== null) {
      throw new RepositoryError('CONFLICT', 'The sequence library is not initialized. Reload before saving.');
    }

    // Check non-GM permission paths before creating the world-owned pack.
    this.assertSafePermissions(undefined);
    let createdByThisClient = false;
    try {
      await this.host.createPack(PACK_METADATA);
      createdByThisClient = true;
    } catch (error) {
      pack = this.host.findPack(PACK_COLLECTION);
      if (!pack) throw storageError('The sequence compendium could not be created.', error);
    }

    pack = this.host.findPack(PACK_COLLECTION);
    if (!pack) {
      throw new RepositoryError('STORAGE_FAILURE', 'Foundry created the sequence compendium but did not register it locally.');
    }
    this.assertPackType(pack);
    this.assertSafePermissions(pack);

    const root = await this.findRoot();
    if (root) return { pack, createdByThisClient };
    if (!createdByThisClient) {
      throw new RepositoryError('CORRUPT_STORAGE', 'The sequence compendium has no authority root; automatic repair is blocked.');
    }

    await this.createRoot(pack);
    return { pack, createdByThisClient };
  }

  private assertWriterRole(): void {
    const user = this.host.currentUser;
    if (!user || !user.id || !Number.isSafeInteger(user.role) || user.role < 3) {
      throw new RepositoryError('UNSAFE_PERMISSIONS', 'Only an Assistant or Gamemaster can save sequences.');
    }
  }

  private assertSafePermissions(pack: RepositoryPack | undefined): void {
    const currentUser = this.host.currentUser;
    if (!currentUser?.id || currentUser.role < 3) {
      throw new RepositoryError('UNSAFE_PERMISSIONS', 'Only an Assistant or Gamemaster can write to this sequence library.');
    }
    if (pack && pack.documentName !== 'JournalEntry') {
      throw new RepositoryError('UNSAFE_PERMISSIONS', 'The sequence compendium is not a JournalEntry compendium.');
    }

    for (const user of this.host.users) {
      if (!user.id || !Number.isSafeInteger(user.role) || user.role < 1 || user.role > 4) {
        throw new RepositoryError('UNSAFE_PERMISSIONS', 'Foundry returned an unknown user role; sequence writes are blocked.');
      }
      if (user.role >= 3) continue;
      let canModifySettings: unknown = true;
      let level: RepositoryPermissionLevel | undefined;
      try {
        canModifySettings = this.host.canModifySettings(user.id);
        level = pack?.permissionLevel(user.id);
      } catch (error) {
        throw new RepositoryError('UNSAFE_PERMISSIONS', 'Effective world permissions could not be checked.', { cause: error });
      }
      if (typeof canModifySettings !== 'boolean') {
        throw new RepositoryError('UNSAFE_PERMISSIONS', 'The SETTINGS_MODIFY permission could not be checked.');
      }
      if (canModifySettings) {
        throw new RepositoryError('UNSAFE_PERMISSIONS', 'A Player or Trusted user can modify world settings.');
      }
      if (pack && level !== 'OBSERVER') {
        throw new RepositoryError('UNSAFE_PERMISSIONS', 'Players and Trusted users must have exactly Observer access to the sequence compendium.');
      }
    }

    if (pack) {
      const level = pack.permissionLevel(currentUser.id);
      if (level !== 'OWNER') {
        throw new RepositoryError('UNSAFE_PERMISSIONS', 'The current user must have effective Owner access to the sequence compendium.');
      }
      for (const user of this.host.users) {
        if (user.role >= 3 && pack.permissionLevel(user.id) !== 'OWNER') {
          throw new RepositoryError('UNSAFE_PERMISSIONS', 'Assistant and Gamemaster users must have effective Owner access to the sequence compendium.');
        }
      }
    }
  }

  private assertPackType(pack: RepositoryPack): void {
    if (pack.documentName !== 'JournalEntry') {
      throw new RepositoryError('UNSAFE_PERMISSIONS', `The reserved world collection ${PACK_COLLECTION} is not a JournalEntry compendium.`);
    }
  }

  private async createRoot(pack: RepositoryPack): Promise<void> {
    const operation = {
      pack: PACK_COLLECTION,
      data: [{
        name: 'Stagecraft Sequence Authority',
        flags: {
          [MODULE_ID]: {
            role: ROOT_MARKER,
            schemaVersion: ROOT_SCHEMA_VERSION,
          },
        },
      }],
      renderSheet: false,
    };
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send({ type: 'JournalEntry', action: 'create', operation });
    } catch (error) {
      // A lost acknowledgement can be resolved only by reading. Never create a second root.
      const root = await this.findRoot();
      if (!root) throw storageError('The authority root could not be confirmed.', error);
      return;
    }
    if (!(await this.findRoot())) {
      throw new RepositoryError('STORAGE_FAILURE', 'Foundry acknowledged root creation but the root could not be read back.');
    }
  }

  private async findRoot(): Promise<EntryRecord | undefined> {
    const entries = await this.readEntries();
    const roots = entries.filter((entry) => flagsOf(entry.flags)?.role === ROOT_MARKER);
    if (roots.length > 1) {
      throw new RepositoryError('CORRUPT_STORAGE', 'The sequence compendium has multiple authority roots; no root was selected.');
    }
    const root = roots[0];
    if (!root) return undefined;
    assertVersion(flagsOf(root.flags)?.schemaVersion, ROOT_SCHEMA_VERSION, 'authority root');
    if (!this.requireEntryId(root)) {
      throw new RepositoryError('CORRUPT_STORAGE', 'The authority root has no server-assigned ID.');
    }
    return root;
  }

  private async readSnapshot(): Promise<RepositorySnapshot> {
    const entries = await this.readEntries();
    const roots = entries.filter((entry) => flagsOf(entry.flags)?.role === ROOT_MARKER);
    if (roots.length !== 1) {
      throw new RepositoryError(
        'CORRUPT_STORAGE',
        roots.length === 0
          ? 'The sequence compendium has no authority root; automatic repair is blocked.'
          : 'The sequence compendium has multiple authority roots; no root was selected.'
      );
    }
    const root = roots[0];
    if (!root) throw new RepositoryError('CORRUPT_STORAGE', 'The authority root could not be selected.');
    assertVersion(flagsOf(root.flags)?.schemaVersion, ROOT_SCHEMA_VERSION, 'authority root');
    const rootId = this.requireEntryId(root);
    if (!rootId) throw new RepositoryError('CORRUPT_STORAGE', 'The authority root has no server-assigned ID.');

    const claims = await this.readCreationClaims(root);

    const sequences = new Map<string, StoredSequence>();
    for (const entry of entries) {
      if (entry === root) continue;
      const parentId = this.requireEntryId(entry);
      if (!parentId) throw new RepositoryError('CORRUPT_STORAGE', 'A JournalEntry in the sequence compendium has no ID.');
      const flags = flagsOf(entry.flags);
      if (flags?.role !== 'sequence') {
        throw new RepositoryError('CORRUPT_STORAGE', `Unexpected JournalEntry ${parentId} is present in the dedicated sequence compendium.`);
      }
      const sequenceId = flags.sequenceId;
      if (!isValidSequenceId(sequenceId)) {
        throw new RepositoryError('CORRUPT_STORAGE', `Sequence entry ${parentId} has no stable sequence ID.`);
      }
      if (sequences.has(sequenceId)) {
        throw new RepositoryError('CORRUPT_STORAGE', `Duplicate sequence ID ${sequenceId} is present; records were preserved.`);
      }

      let stored: StoredSequence;
      try {
        assertVersion(flags.schemaVersion, SEQUENCE_SCHEMA_VERSION, 'sequence header');
        this.assertCreationClaimLink(flags, claims.get(sequenceId), sequenceId);
        const revisions = this.readRevisionRecords(entry, sequenceId);
        const latest = revisions[revisions.length - 1];
        if (!latest) throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has no readable revision.`);
        stored = {
          sequenceId,
          parentId,
          parentName: typeof entry.name === 'string' ? entry.name : '',
          ...(latest.operation === 'save' ? { sequence: latest.sequence } : { deletion: latest }),
          revisions,
        };
      } catch (error) {
        if (!(error instanceof RepositoryError)) throw error;
        stored = {
          sequenceId,
          parentId,
          parentName: typeof entry.name === 'string' ? entry.name : '',
          issue: error,
        };
      }
      sequences.set(sequenceId, stored);
    }

    for (const claim of claims.values()) {
      if (sequences.has(claim.sequenceId)) continue;
      sequences.set(claim.sequenceId, {
        sequenceId: claim.sequenceId,
        parentId: '',
        parentName: 'Unavailable sequence',
        reservationPending: !claim.issue,
        issue: claim.issue ?? new RepositoryError(
          'CORRUPT_STORAGE',
          `Sequence ${claim.sequenceId} has a creation reservation but no sequence entry.`
        ),
      });
    }
    return { sequences };
  }

  private async readCreationClaims(root: EntryRecord): Promise<ReadonlyMap<string, StoredCreationClaim>> {
    if (root.pages !== undefined && !Array.isArray(root.pages)) {
      throw new RepositoryError('CORRUPT_STORAGE', 'The authority root has an invalid page collection.');
    }
    const claims = new Map<string, StoredCreationClaim>();
    const pages = (root.pages ?? []) as PageRecord[];
    for (const page of pages) {
      const record = flagsOf(page.flags);
      // Other page roles belong to later authority protocols and are deliberately ignored here.
      if (record?.role !== CREATION_CLAIM_ROLE) continue;
      const sequenceId = record.sequenceId;
      if (!isValidSequenceId(sequenceId)) {
        throw new RepositoryError('CORRUPT_STORAGE', 'A sequence creation reservation has no stable sequence ID.');
      }

      const pageId = stringValue(page._id);
      let issue: RepositoryError | undefined;
      let createRequestId: string | undefined;
      try {
        assertVersion(record.recordVersion, CREATION_CLAIM_VERSION, 'sequence creation reservation');
        const expectedPageId = creationClaimPageId(sequenceId);
        if (pageId !== expectedPageId) {
          throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has an unexpected creation reservation slot.`);
        }
        createRequestId = stringValue(record.createRequestId);
        if (!createRequestId) {
          throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} creation reservation has no request ID.`);
        }
        if (!stringValue(object(page._stats)?.lastModifiedBy)) {
          throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} creation reservation has no server actor stamp.`);
        }
      } catch (error) {
        if (!(error instanceof RepositoryError)) throw error;
        issue = error;
      }

      const prior = claims.get(sequenceId);
      if (prior) {
        claims.set(sequenceId, {
          sequenceId,
          issue: new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has duplicate creation reservations.`),
        });
      } else {
        claims.set(sequenceId, { sequenceId, pageId, createRequestId, issue });
      }
    }
    return claims;
  }

  private assertCreationClaimLink(
    sequenceFlags: Record<string, unknown>,
    claim: StoredCreationClaim | undefined,
    sequenceId: string
  ): void {
    const createRequestId = sequenceFlags.createRequestId;
    const reservationId = sequenceFlags.reservationId;
    const hasReservationLink = reservationId !== undefined;

    if (claim?.issue) throw claim.issue;
    if (!claim) {
      if (hasReservationLink) {
        throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} points to a missing creation reservation.`);
      }
      return; // V1 parents may have a createRequestId but predate creation reservations.
    }

    if (!hasReservationLink || typeof createRequestId !== 'string' || typeof reservationId !== 'string'
      || createRequestId !== claim.createRequestId || reservationId !== claim.pageId) {
      throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} does not point to its matching creation reservation.`);
    }
  }

  private readRevisionRecords(entry: EntryRecord, sequenceId: string): readonly StoredRevision[] {
    if (!Array.isArray(entry.pages)) {
      throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has no revision collection.`);
    }
    if (entry.pages.length === 0) {
      throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has no confirmed initial revision.`);
    }
    if (entry.pages.length > MAX_REVISION_RECORDS) {
      throw new RepositoryError('UNSUPPORTED_DATA', `Sequence ${sequenceId} exceeds ${MAX_REVISIONS} saved revisions and one terminal deletion.`);
    }

    const pages = entry.pages as PageRecord[];
    const ordered = [...pages].sort((left, right) => {
      const leftIndex = Number(flagsOf(left.flags)?.index ?? 0);
      const rightIndex = Number(flagsOf(right.flags)?.index ?? 0);
      return leftIndex - rightIndex;
    });
    const revisions: StoredRevision[] = [];
    const requestIds = new Set<string>();

    for (let index = 1; index <= ordered.length; index += 1) {
      const page = ordered[index - 1];
      if (!page) throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has a revision gap.`);
      const record = flagsOf(page.flags);
      if (!record || record.role !== 'revision') {
        throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} contains an unrecognized revision page.`);
      }
      const isDeletion = record.recordVersion === DELETION_RECORD_VERSION && record.operation === 'delete';
      if (!isDeletion) {
        assertVersion(record.recordVersion, REVISION_RECORD_VERSION, 'revision record');
        if (record.operation !== undefined && record.operation !== 'save') {
          throw new RepositoryError('UNSUPPORTED_DATA', `Sequence ${sequenceId} uses an unsupported revision operation.`);
        }
        if (index > MAX_REVISIONS) {
          throw new RepositoryError('UNSUPPORTED_DATA', `Sequence ${sequenceId} exceeds ${MAX_REVISIONS} saved revisions.`);
        }
      }
      if (record.index !== index || record.previous !== index - 1) {
        throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has a broken revision chain at ${index}.`);
      }
      const pageId = stringValue(page._id);
      if (pageId !== slotId(index)) {
        throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has an unexpected revision slot at ${index}.`);
      }
      const requestId = stringValue(record.requestId);
      if (!requestId) {
        throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has a revision with no request ID.`);
      }
      if (requestIds.has(requestId)) {
        throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has duplicate revision request IDs.`);
      }
      requestIds.add(requestId);
      const stats = object(page._stats);
      const actor = stringValue(stats?.lastModifiedBy);
      if (!actor) {
        throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has a revision without a server actor stamp.`);
      }

      if (isDeletion) {
        if (index === 1 || index !== ordered.length || record.sequenceId !== sequenceId || record.payload !== undefined) {
          throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has an invalid terminal deletion at ${index}.`);
        }
        const user = this.host.users.find((candidate) => candidate.id === actor);
        if (!user || !Number.isSafeInteger(user.role) || user.role < 3 || user.role > 4) {
          throw new RepositoryError('UNSAFE_PERMISSIONS', `Sequence ${sequenceId} deletion has no current Assistant or Gamemaster actor.`);
        }
        revisions.push({ id: pageId, index, previous: index - 1, requestId, operation: 'delete' });
        continue;
      }

      let payload: SequenceV1;
      try {
        payload = validateSequence(record.payload);
      } catch (error) {
        throw persistedValidationError(error, sequenceId, index);
      }
      if (payload.id !== sequenceId || payload.revision !== index) {
        throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} payload does not match revision ${index}.`);
      }
      revisions.push({
        id: pageId,
        index,
        previous: index - 1,
        requestId,
        operation: 'save',
        sequence: payload,
      });
    }

    if (!revisions.length) throw new RepositoryError('CORRUPT_STORAGE', `Sequence ${sequenceId} has no readable revision.`);
    return revisions;
  }

  private async readEntries(): Promise<EntryRecord[]> {
    let response: unknown;
    try {
      response = await this.host.rpc('modifyDocument', {
        type: 'JournalEntry',
        action: 'get',
        operation: { pack: PACK_COLLECTION, query: {} },
      });
    } catch (error) {
      throw storageError('The sequence compendium could not be read.', error);
    }
    const result = responseResult(response);
    if (!Array.isArray(result) || !result.every(isRecord)) {
      throw new RepositoryError('STORAGE_FAILURE', 'Foundry returned an invalid sequence compendium read.');
    }
    return result as EntryRecord[];
  }

  private async send(request: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await this.host.rpc('modifyDocument', request);
      return responseResult(response);
    } catch (error) {
      if (error instanceof RepositoryError && error.code !== 'STORAGE_FAILURE') throw error;
      throw storageError('Foundry rejected the sequence storage operation.', error);
    }
  }

  private resultDocumentId(result: unknown): string | undefined {
    if (Array.isArray(result)) return stringValue(object(result[0])?._id);
    return stringValue(object(result)?._id);
  }

  private requireEntryId(entry: EntryRecord | undefined): string | undefined {
    return stringValue(entry?._id);
  }

  private requireId(value: string, label: string): string {
    if (!isValidSequenceId(value)) {
      throw new RepositoryError('STORAGE_FAILURE', `Foundry did not provide a valid ${label} ID.`);
    }
    return value;
  }

  private findRequest(snapshot: RepositorySnapshot, sequenceId: string, requestId: string): SequenceV1 | undefined {
    const stored = snapshot.sequences.get(sequenceId);
    if (!stored) return undefined;
    if (stored.issue) throw stored.issue;
    const revision = stored.revisions?.find((item) => item.requestId === requestId);
    return revision?.operation === 'save' ? revision.sequence : undefined;
  }

  private async withWriteLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(id) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.writeTails.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.writeTails.get(id) === current) this.writeTails.delete(id);
    }
  }
}
