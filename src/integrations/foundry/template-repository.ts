import type { TemplateRepository, TemplateSummary } from '../../application/template-ports.js';
import { TemplateValidationError, validateTemplate } from '../../domain/element-template.js';
import type { TemplateEnvelopeV1 } from '../../domain/element-template.js';
import type { RepositoryHost, RepositoryPack, RepositoryPermissionLevel } from './sequence-repository.js';

import { MODULE_ID } from '../../module-identity.js';
const PACK_NAME = 'stagecraft-templates';
const PACK_COLLECTION = `world.${PACK_NAME}`;
const ROOT_ROLE = 'template-authority';
const ROOT_VERSION = 1;
const TEMPLATE_ROLE = 'template-record';
const TEMPLATE_HEADER_VERSION = 1;
const REVISION_ROLE = 'template-revision';
const REVISION_VERSION = 1;
const CLAIM_ROLE = 'template-creation-claim';
const CLAIM_VERSION = 1;
const DELETION_VERSION = 2;
const MAX_REVISIONS = 5_000;
const MAX_RECORDS = MAX_REVISIONS + 1;
const MAX_ID_LENGTH = 128;

export type TemplateRepositoryErrorCode =
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INVALID_TEMPLATE'
  | 'CORRUPT_STORAGE'
  | 'UNSUPPORTED_DATA'
  | 'UNSAFE_PERMISSIONS'
  | 'STORAGE_FAILURE';

export class TemplateRepositoryError extends Error {
  constructor(readonly code: TemplateRepositoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TemplateRepositoryError';
  }
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

interface StoredRevisionBase {
  readonly id: string;
  readonly index: number;
  readonly previous: number;
  readonly requestId: string;
}

interface StoredSaveRevision extends StoredRevisionBase {
  readonly operation: 'save';
  readonly template: TemplateEnvelopeV1;
}

interface StoredDeletionRevision extends StoredRevisionBase {
  readonly operation: 'delete';
}

type StoredRevision = StoredSaveRevision | StoredDeletionRevision;

interface StoredClaim {
  readonly templateId: string;
  readonly pageId?: string;
  readonly createRequestId?: string;
  readonly issue?: TemplateRepositoryError;
}

interface StoredTemplate {
  readonly templateId: string;
  readonly parentId: string;
  readonly parentName: string;
  readonly template?: TemplateEnvelopeV1;
  readonly deletion?: StoredDeletionRevision;
  readonly revisions?: readonly StoredRevision[];
  readonly reservationPending?: boolean;
  readonly issue?: TemplateRepositoryError;
}

interface TemplateSnapshot {
  readonly records: ReadonlyMap<string, StoredTemplate>;
}

interface NativeResponse {
  readonly result?: unknown;
  readonly error?: unknown;
}

const PACK_METADATA: Parameters<RepositoryHost['createPack']>[0] = {
  name: PACK_NAME,
  label: 'Stagecraft Templates',
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
  if (!response) throw new TemplateRepositoryError('STORAGE_FAILURE', 'Foundry returned an invalid document response.');
  if (response.error !== undefined) {
    const details = object(response.error);
    throw new TemplateRepositoryError('STORAGE_FAILURE', stringValue(details?.message) ?? 'Foundry rejected the document operation.');
  }
  return response.result;
}

function slotId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_RECORDS) {
    throw new TemplateRepositoryError('UNSUPPORTED_DATA', `Template history exceeds ${MAX_REVISIONS} saved revisions and one terminal deletion.`);
  }
  return `r${index.toString(36).padStart(15, '0')}`;
}

function claimPageId(templateId: string): string {
  // A stable index for an atomic create claim; the full ID is always checked as the authority.
  let hash = 0xcbf29ce484222325n;
  const mask = (1n << 64n) - 1n;
  for (const byte of new TextEncoder().encode(templateId)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & mask;
  }
  return `c${hash.toString(16).padStart(16, '0').slice(0, 15)}`;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function assertVersion(value: unknown, expected: number, label: string): void {
  if (value === expected) return;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > expected) {
    throw new TemplateRepositoryError('UNSUPPORTED_DATA', `Unsupported ${label} version ${value}.`);
  }
  throw new TemplateRepositoryError('CORRUPT_STORAGE', `Stored ${label} has no valid version marker.`);
}

function persistedValidationError(error: unknown, id: string, revision: number): TemplateRepositoryError {
  const unsupported = error instanceof TemplateValidationError && error.code.startsWith('UNSUPPORTED');
  return new TemplateRepositoryError(
    unsupported ? 'UNSUPPORTED_DATA' : 'CORRUPT_STORAGE',
    unsupported
      ? `Template ${id} uses an unsupported format at revision ${revision}.`
      : `Template ${id} has invalid revision data at ${revision}.`,
    { cause: error },
  );
}

function storageError(message: string, cause: unknown): TemplateRepositoryError {
  if (cause instanceof TemplateRepositoryError) return cause;
  return new TemplateRepositoryError('STORAGE_FAILURE', message, { cause });
}

export function createFoundryTemplateRepository(host: RepositoryHost): TemplateRepository {
  if (!host.worldId) throw new TemplateRepositoryError('STORAGE_FAILURE', 'A loaded Foundry world is required.');
  return new FoundryTemplateRepository(host);
}

class FoundryTemplateRepository implements TemplateRepository {
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(private readonly host: RepositoryHost) {}

  async list(): Promise<readonly TemplateSummary[]> {
    const pack = this.host.findPack(PACK_COLLECTION);
    if (!pack) return [];
    this.assertPackType(pack);
    const snapshot = await this.readSnapshot();
    return [...snapshot.records.values()]
      .filter(record => !record.deletion)
      .map(record => {
        const content = record.template?.content;
        return {
          id: record.templateId,
          revision: record.template?.revision ?? 0,
          name: record.template?.name ?? (record.parentName || 'Unavailable template'),
          ...(content?.kind === 'element' ? { kind: 'element' as const, elementType: content.clip.type }
            : content?.kind === 'animation' ? { kind: 'animation' as const }
              : { kind: 'element' as const }),
          ...(record.issue ? { issue: record.issue.code } : {}),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async read(id: string): Promise<unknown> {
    this.requireValidId(id);
    const pack = this.host.findPack(PACK_COLLECTION);
    if (!pack) throw new TemplateRepositoryError('NOT_FOUND', `Template ${id} was not found.`);
    this.assertPackType(pack);
    const record = (await this.readSnapshot()).records.get(id);
    if (!record) throw new TemplateRepositoryError('NOT_FOUND', `Template ${id} was not found.`);
    if (record.issue) throw record.issue;
    if (record.deletion || !record.template) throw new TemplateRepositoryError('NOT_FOUND', `Template ${id} was deleted or is unavailable.`);
    return structuredClone(record.template);
  }

  async save(value: TemplateEnvelopeV1, expectedRevision: number | null): Promise<TemplateEnvelopeV1> {
    const template = this.validateInput(value);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new TemplateRepositoryError('INVALID_TEMPLATE', 'Expected revision must be positive or null.');
    }
    this.requireValidId(template.id);
    return this.withWriteLock(template.id, () => this.saveLocked(template, expectedRevision));
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    this.requireValidId(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new TemplateRepositoryError('INVALID_TEMPLATE', 'Deletion requires a positive expected revision.');
    }
    return this.withWriteLock(id, () => this.deleteLocked(id, expectedRevision));
  }

  private validateInput(value: unknown): TemplateEnvelopeV1 {
    try {
      return validateTemplate(value);
    } catch (error) {
      throw new TemplateRepositoryError('INVALID_TEMPLATE', 'The template is invalid or uses an unsupported format.', { cause: error });
    }
  }

  private async saveLocked(input: TemplateEnvelopeV1, expectedRevision: number | null): Promise<TemplateEnvelopeV1> {
    const { pack } = await this.ensureWritablePack(expectedRevision);
    this.assertSafePermissions(pack);
    let snapshot = await this.readSnapshot();
    const existing = snapshot.records.get(input.id);
    if (existing?.issue) throw existing.issue;
    if (existing?.deletion) throw new TemplateRepositoryError('NOT_FOUND', `Template ${input.id} was deleted.`);

    if (expectedRevision === null) {
      if (existing) throw new TemplateRepositoryError('CONFLICT', `Template ${input.id} already exists.`);
      return this.createTemplate(input, pack);
    }
    if (!existing?.template || existing.template.revision !== expectedRevision) {
      throw new TemplateRepositoryError('CONFLICT', `Template ${input.id} changed since revision ${expectedRevision}.`);
    }
    if (expectedRevision >= MAX_REVISIONS) {
      throw new TemplateRepositoryError('UNSUPPORTED_DATA', `Template history exceeds ${MAX_REVISIONS} revisions.`);
    }

    const nextIndex = expectedRevision + 1;
    const requestId = this.requireGeneratedId(this.host.makeId(), 'request');
    const payload = this.validateInput({ ...input, revision: nextIndex });
    let writeError: unknown;
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send(this.revisionCreateOperation(existing.parentId, nextIndex, expectedRevision, requestId, {
        role: REVISION_ROLE, recordVersion: REVISION_VERSION, operation: 'save', template: payload,
      }));
    } catch (error) {
      writeError = error;
    }
    snapshot = await this.readSnapshot();
    const recovered = this.findRequest(snapshot, input.id, requestId);
    if (recovered) return structuredClone(recovered);
    const current = snapshot.records.get(input.id);
    if (current?.issue) throw current.issue;
    if (current?.deletion || (current?.template && current.template.revision >= nextIndex)) {
      throw new TemplateRepositoryError('CONFLICT', `Template ${input.id} was changed by another writer.`, { cause: writeError });
    }
    if (writeError !== undefined) {
      throw storageError('The template save could not be confirmed. Reload the library before retrying.', writeError);
    }
    throw new TemplateRepositoryError('STORAGE_FAILURE', 'Foundry acknowledged a template save that could not be read back.');
  }

  private async createTemplate(input: TemplateEnvelopeV1, pack: RepositoryPack): Promise<TemplateEnvelopeV1> {
    const requestId = this.requireGeneratedId(this.host.makeId(), 'request');
    const createRequestId = this.requireGeneratedId(this.host.makeId(), 'creation request');
    const payload = this.validateInput({ ...input, revision: 1 });
    const root = await this.findRoot();
    if (!root) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'The template compendium has no authority root.');
    const rootId = this.requireEntryId(root);
    if (!rootId) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'The template authority root has no server-assigned ID.');
    const reservationId = claimPageId(payload.id);
    await this.reserveTemplate(rootId, reservationId, payload.id, createRequestId, pack);

    const entries = await this.readEntries();
    if (entries.some(entry => flagsOf(entry.flags)?.role === TEMPLATE_ROLE && flagsOf(entry.flags)?.templateId === payload.id)) {
      throw new TemplateRepositoryError('CONFLICT', `Template ${payload.id} already has a stored entry.`);
    }
    const parentOperation = {
      pack: PACK_COLLECTION,
      data: [{ name: payload.name, flags: { [MODULE_ID]: {
        role: TEMPLATE_ROLE, schemaVersion: TEMPLATE_HEADER_VERSION, templateId: payload.id,
        createRequestId, reservationId,
      } } }],
      renderSheet: false,
    };
    let parentId: string | undefined;
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      parentId = this.resultDocumentId(await this.send({ type: 'JournalEntry', action: 'create', operation: parentOperation }));
      if (!parentId) parentId = this.findParentId(await this.readEntries(), payload.id, createRequestId, reservationId);
    } catch (error) {
      parentId = this.findParentId(await this.readEntries(), payload.id, createRequestId, reservationId);
      if (!parentId) throw storageError('Template creation could not be confirmed. Reload the library before retrying.', error);
    }
    if (!parentId) throw new TemplateRepositoryError('STORAGE_FAILURE', 'Foundry did not return the template entry ID.');

    let writeError: unknown;
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send(this.revisionCreateOperation(parentId, 1, 0, requestId, {
        role: REVISION_ROLE, recordVersion: REVISION_VERSION, operation: 'save', template: payload,
      }));
    } catch (error) {
      writeError = error;
    }
    const snapshot = await this.readSnapshot();
    const saved = this.findRequest(snapshot, payload.id, requestId);
    if (saved) return structuredClone(saved);
    const current = snapshot.records.get(payload.id);
    if (current?.issue) throw current.issue;
    if (writeError !== undefined) throw storageError('The template entry exists, but its first revision could not be confirmed.', writeError);
    throw new TemplateRepositoryError('STORAGE_FAILURE', 'The first template revision could not be read back.');
  }

  private async deleteLocked(id: string, expectedRevision: number): Promise<void> {
    this.assertWriterRole();
    const pack = this.host.findPack(PACK_COLLECTION);
    if (!pack) throw new TemplateRepositoryError('NOT_FOUND', `Template ${id} was not found.`);
    this.assertPackType(pack);
    this.assertSafePermissions(pack);
    const existing = (await this.readSnapshot()).records.get(id);
    if (existing?.issue) throw existing.issue;
    if (!existing?.template || existing.deletion) throw new TemplateRepositoryError('NOT_FOUND', `Template ${id} was not found or was deleted.`);
    if (existing.template.revision !== expectedRevision) {
      throw new TemplateRepositoryError('CONFLICT', `Template ${id} changed since revision ${expectedRevision}.`);
    }
    const requestId = this.requireGeneratedId(this.host.makeId(), 'request');
    let writeError: unknown;
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send(this.revisionCreateOperation(existing.parentId, expectedRevision + 1, expectedRevision, requestId, {
        role: REVISION_ROLE, recordVersion: DELETION_VERSION, operation: 'delete', templateId: id,
      }));
    } catch (error) {
      writeError = error;
    }
    const current = (await this.readSnapshot()).records.get(id);
    if (current?.issue) throw current.issue;
    if (current?.deletion?.requestId === requestId) return;
    if (current?.deletion || (current?.template && current.template.revision >= expectedRevision + 1)) {
      throw new TemplateRepositoryError('CONFLICT', `Template ${id} was changed by another writer.`, { cause: writeError });
    }
    if (writeError !== undefined) throw storageError('The template deletion could not be confirmed. Reload before retrying.', writeError);
    throw new TemplateRepositoryError('STORAGE_FAILURE', 'Foundry acknowledged a template deletion that could not be read back.');
  }

  private async ensureWritablePack(expectedRevision: number | null): Promise<{ readonly pack: RepositoryPack; readonly createdHere: boolean }> {
    this.assertWriterRole();
    let pack = this.host.findPack(PACK_COLLECTION);
    if (pack) {
      this.assertPackType(pack);
      this.assertSafePermissions(pack);
      return { pack, createdHere: false };
    }
    if (expectedRevision !== null) throw new TemplateRepositoryError('CONFLICT', 'The template library is not initialized. Reload before saving.');
    this.assertSafePermissions(undefined);
    let createdHere = false;
    try {
      await this.host.createPack(PACK_METADATA);
      createdHere = true;
    } catch (error) {
      pack = this.host.findPack(PACK_COLLECTION);
      if (!pack) throw storageError('The template compendium could not be created.', error);
    }
    pack = this.host.findPack(PACK_COLLECTION);
    if (!pack) throw new TemplateRepositoryError('STORAGE_FAILURE', 'Foundry created the template compendium but did not register it locally.');
    this.assertPackType(pack);
    this.assertSafePermissions(pack);
    if (await this.findRoot()) return { pack, createdHere };
    if (!createdHere) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'The template compendium has no authority root; automatic repair is blocked.');
    await this.createRoot(pack);
    return { pack, createdHere };
  }

  private async reserveTemplate(rootId: string, pageId: string, templateId: string, createRequestId: string, pack: RepositoryPack): Promise<void> {
    let writeError: unknown;
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send({
        type: 'JournalEntryPage', action: 'create', operation: {
          pack: PACK_COLLECTION,
          parentUuid: `Compendium.${PACK_COLLECTION}.JournalEntry.${rootId}`,
          keepId: true, render: false, renderSheet: false,
          data: [{
            _id: pageId, name: `Create ${templateId}`, type: 'text',
            flags: { [MODULE_ID]: { role: CLAIM_ROLE, recordVersion: CLAIM_VERSION, templateId, createRequestId } },
          }],
        },
      });
    } catch (error) {
      writeError = error;
    }
    const roots = (await this.readEntries()).filter(entry => flagsOf(entry.flags)?.role === ROOT_ROLE);
    if (roots.length !== 1) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'The template authority root could not be selected.');
    const root = roots[0]!;
    if (root.pages !== undefined && !Array.isArray(root.pages)) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'The template authority page collection is invalid.');
    const matches = ((root.pages ?? []) as PageRecord[]).filter(page => page._id === pageId);
    if (matches.length !== 1) {
      if (writeError !== undefined) throw storageError('Template creation reservation could not be confirmed. Reload before retrying.', writeError);
      throw new TemplateRepositoryError(matches.length > 1 ? 'CORRUPT_STORAGE' : 'STORAGE_FAILURE', 'The template creation reservation could not be read back.');
    }
    const record = flagsOf(matches[0]!.flags);
    if (record?.role !== CLAIM_ROLE || record.templateId !== templateId) {
      throw new TemplateRepositoryError('CONFLICT', `Template creation reservation ${pageId} is already occupied.`);
    }
    assertVersion(record.recordVersion, CLAIM_VERSION, 'template creation reservation');
    const actor = stringValue(object(matches[0]!._stats)?.lastModifiedBy);
    if (!actor) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${templateId} reservation has no server actor stamp.`);
    if (record.createRequestId !== createRequestId) throw new TemplateRepositoryError('CONFLICT', `Template ${templateId} is being created by another request.`);
  }

  private async createRoot(pack: RepositoryPack): Promise<void> {
    try {
      this.assertWriterRole();
      this.assertSafePermissions(pack);
      await this.send({ type: 'JournalEntry', action: 'create', operation: {
        pack: PACK_COLLECTION,
        data: [{ name: 'Stagecraft Template Authority', flags: { [MODULE_ID]: { role: ROOT_ROLE, schemaVersion: ROOT_VERSION } } }],
        renderSheet: false,
      } });
    } catch (error) {
      if (!(await this.findRoot())) throw storageError('The template authority root could not be confirmed.', error);
    }
    if (!(await this.findRoot())) throw new TemplateRepositoryError('STORAGE_FAILURE', 'The template authority root could not be read back.');
  }

  private async findRoot(): Promise<EntryRecord | undefined> {
    const roots = (await this.readEntries()).filter(entry => flagsOf(entry.flags)?.role === ROOT_ROLE);
    if (roots.length > 1) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'The template compendium has multiple authority roots.');
    const root = roots[0];
    if (!root) return undefined;
    assertVersion(flagsOf(root.flags)?.schemaVersion, ROOT_VERSION, 'template authority root');
    if (!this.requireEntryId(root)) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'The template authority root has no ID.');
    return root;
  }

  private async readSnapshot(): Promise<TemplateSnapshot> {
    const entries = await this.readEntries();
    const roots = entries.filter(entry => flagsOf(entry.flags)?.role === ROOT_ROLE);
    if (roots.length !== 1) throw new TemplateRepositoryError('CORRUPT_STORAGE', roots.length === 0
      ? 'The template compendium has no authority root; automatic repair is blocked.'
      : 'The template compendium has multiple authority roots; no root was selected.');
    const root = roots[0]!;
    assertVersion(flagsOf(root.flags)?.schemaVersion, ROOT_VERSION, 'template authority root');
    const rootId = this.requireEntryId(root);
    if (!rootId) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'The template authority root has no ID.');
    const claims = this.readClaims(root);
    const records = new Map<string, StoredTemplate>();
    for (const entry of entries) {
      if (entry === root) continue;
      const parentId = this.requireEntryId(entry);
      if (!parentId) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'A template JournalEntry has no ID.');
      const flags = flagsOf(entry.flags);
      if (flags?.role !== TEMPLATE_ROLE) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Unexpected JournalEntry ${parentId} is in the dedicated template compendium.`);
      const templateId = flags.templateId;
      if (!validId(templateId)) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template entry ${parentId} has no stable ID.`);
      if (records.has(templateId)) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Duplicate template ID ${templateId} is present; records were preserved.`);
      let stored: StoredTemplate;
      try {
        assertVersion(flags.schemaVersion, TEMPLATE_HEADER_VERSION, 'template header');
        this.assertClaimLink(flags, claims.get(templateId), templateId);
        const revisions = this.readRevisions(entry, templateId);
        const latest = revisions.at(-1);
        if (!latest) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${templateId} has no readable revision.`);
        stored = {
          templateId, parentId, parentName: typeof entry.name === 'string' ? entry.name : '', revisions,
          ...(latest.operation === 'save' ? { template: latest.template } : { deletion: latest }),
        };
      } catch (error) {
        if (!(error instanceof TemplateRepositoryError)) throw error;
        stored = { templateId, parentId, parentName: typeof entry.name === 'string' ? entry.name : '', issue: error };
      }
      records.set(templateId, stored);
    }
    for (const claim of claims.values()) {
      if (records.has(claim.templateId)) continue;
      records.set(claim.templateId, {
        templateId: claim.templateId, parentId: '', parentName: 'Unavailable template', reservationPending: !claim.issue,
        issue: claim.issue ?? new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${claim.templateId} has a reservation but no stored entry.`),
      });
    }
    return { records };
  }

  private readClaims(root: EntryRecord): ReadonlyMap<string, StoredClaim> {
    if (root.pages !== undefined && !Array.isArray(root.pages)) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'The template authority page collection is invalid.');
    const claims = new Map<string, StoredClaim>();
    for (const page of (root.pages ?? []) as PageRecord[]) {
      const record = flagsOf(page.flags);
      if (record?.role !== CLAIM_ROLE) continue;
      const templateId = record.templateId;
      if (!validId(templateId)) throw new TemplateRepositoryError('CORRUPT_STORAGE', 'A template creation reservation has no stable ID.');
      let issue: TemplateRepositoryError | undefined;
      let createRequestId: string | undefined;
      try {
        assertVersion(record.recordVersion, CLAIM_VERSION, 'template creation reservation');
        if (page._id !== claimPageId(templateId)) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${templateId} has an unexpected reservation slot.`);
        createRequestId = stringValue(record.createRequestId);
        if (!createRequestId) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${templateId} reservation has no request ID.`);
        if (!stringValue(object(page._stats)?.lastModifiedBy)) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${templateId} reservation has no server actor stamp.`);
      } catch (error) {
        if (!(error instanceof TemplateRepositoryError)) throw error;
        issue = error;
      }
      const prior = claims.get(templateId);
      claims.set(templateId, prior
        ? { templateId, issue: new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${templateId} has duplicate creation reservations.`) }
        : {
            templateId,
            ...(stringValue(page._id) ? { pageId: stringValue(page._id)! } : {}),
            ...(createRequestId ? { createRequestId } : {}),
            ...(issue ? { issue } : {}),
          });
    }
    return claims;
  }

  private assertClaimLink(flags: Record<string, unknown>, claim: StoredClaim | undefined, id: string): void {
    if (claim?.issue) throw claim.issue;
    if (!claim || flags.reservationId !== claim.pageId || flags.createRequestId !== claim.createRequestId) {
      throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${id} does not point to its matching creation reservation.`);
    }
  }

  private readRevisions(entry: EntryRecord, id: string): readonly StoredRevision[] {
    if (!Array.isArray(entry.pages) || entry.pages.length === 0) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${id} has no revisions.`);
    if (entry.pages.length > MAX_RECORDS) throw new TemplateRepositoryError('UNSUPPORTED_DATA', `Template ${id} exceeds the revision limit.`);
    const pages = [...entry.pages as PageRecord[]].sort((left, right) => Number(flagsOf(left.flags)?.index ?? 0) - Number(flagsOf(right.flags)?.index ?? 0));
    const revisions: StoredRevision[] = [];
    const requestIds = new Set<string>();
    for (let index = 1; index <= pages.length; index += 1) {
      const page = pages[index - 1]!;
      const record = flagsOf(page.flags);
      if (!record || record.role !== REVISION_ROLE) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${id} contains an unrecognized revision page.`);
      const deletion = record.recordVersion === DELETION_VERSION && record.operation === 'delete';
      if (!deletion) {
        assertVersion(record.recordVersion, REVISION_VERSION, 'template revision');
        if (record.operation !== undefined && record.operation !== 'save') throw new TemplateRepositoryError('UNSUPPORTED_DATA', `Template ${id} uses an unsupported revision operation.`);
        if (index > MAX_REVISIONS) throw new TemplateRepositoryError('UNSUPPORTED_DATA', `Template ${id} exceeds the saved revision limit.`);
      }
      if (record.index !== index || record.previous !== index - 1 || page._id !== slotId(index)) {
        throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${id} has a broken revision chain at ${index}.`);
      }
      const requestId = stringValue(record.requestId);
      if (!requestId || requestIds.has(requestId)) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${id} has a missing or duplicate revision request ID.`);
      requestIds.add(requestId);
      const actor = stringValue(object(page._stats)?.lastModifiedBy);
      if (!actor) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${id} revision ${index} has no server actor stamp.`);
      const user = this.host.users.find(candidate => candidate.id === actor);
      if (!user || !Number.isSafeInteger(user.role) || user.role < 3 || user.role > 4) {
        throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', `Template ${id} revision ${index} has no current Assistant or Gamemaster actor.`);
      }
      if (deletion) {
        if (index === 1 || index !== pages.length || record.templateId !== id || record.template !== undefined) {
          throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${id} has an invalid terminal deletion at ${index}.`);
        }
        revisions.push({ id: String(page._id), index, previous: index - 1, requestId, operation: 'delete' });
        continue;
      }
      let payload: TemplateEnvelopeV1;
      try {
        payload = validateTemplate(record.template);
      } catch (error) {
        throw persistedValidationError(error, id, index);
      }
      if (payload.id !== id || payload.revision !== index) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Template ${id} payload does not match revision ${index}.`);
      revisions.push({ id: String(page._id), index, previous: index - 1, requestId, operation: 'save', template: payload });
    }
    return revisions;
  }

  private async readEntries(): Promise<EntryRecord[]> {
    let response: unknown;
    try {
      response = await this.host.rpc('modifyDocument', {
        type: 'JournalEntry', action: 'get', operation: { pack: PACK_COLLECTION, query: {} },
      });
    } catch (error) {
      throw storageError('The template compendium could not be read.', error);
    }
    const result = responseResult(response);
    if (!Array.isArray(result) || !result.every(isRecord)) throw new TemplateRepositoryError('STORAGE_FAILURE', 'Foundry returned an invalid template compendium read.');
    return result as EntryRecord[];
  }

  private async send(request: Record<string, unknown>): Promise<unknown> {
    try {
      return responseResult(await this.host.rpc('modifyDocument', request));
    } catch (error) {
      if (error instanceof TemplateRepositoryError && error.code !== 'STORAGE_FAILURE') throw error;
      throw storageError('Foundry rejected the template storage operation.', error);
    }
  }

  private revisionCreateOperation(parentId: string, index: number, previous: number, requestId: string, record: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'JournalEntryPage', action: 'create', operation: {
        pack: PACK_COLLECTION,
        parentUuid: `Compendium.${PACK_COLLECTION}.JournalEntry.${parentId}`,
        keepId: true, render: false, renderSheet: false,
        data: [{ _id: slotId(index), name: `Revision ${index}`, type: 'text', flags: {
          [MODULE_ID]: { ...record, index, previous, requestId },
        } }],
      },
    };
  }

  private findRequest(snapshot: TemplateSnapshot, id: string, requestId: string): TemplateEnvelopeV1 | undefined {
    const record = snapshot.records.get(id);
    if (!record) return undefined;
    if (record.issue) throw record.issue;
    const revision = record.revisions?.find(item => item.requestId === requestId);
    return revision?.operation === 'save' ? revision.template : undefined;
  }

  private findParentId(entries: readonly EntryRecord[], id: string, request: string, reservationId: string): string | undefined {
    const matches = entries.filter(entry => {
      const flags = flagsOf(entry.flags);
      return flags?.role === TEMPLATE_ROLE && flags.templateId === id
        && flags.createRequestId === request && flags.reservationId === reservationId;
    });
    if (matches.length > 1) throw new TemplateRepositoryError('CORRUPT_STORAGE', `Duplicate template creation request ${request} was found.`);
    return matches[0] ? this.requireEntryId(matches[0]) : undefined;
  }

  private resultDocumentId(result: unknown): string | undefined {
    if (Array.isArray(result)) return stringValue(object(result[0])?._id);
    return stringValue(object(result)?._id);
  }

  private requireEntryId(entry: EntryRecord): string | undefined {
    return stringValue(entry._id);
  }

  private requireValidId(value: unknown): asserts value is string {
    if (!validId(value)) throw new TemplateRepositoryError('INVALID_TEMPLATE', 'Template ID is invalid.');
  }

  private requireGeneratedId(value: string, _label: string): string {
    this.requireValidId(value);
    return value;
  }

  private assertWriterRole(): void {
    const user = this.host.currentUser;
    if (!user?.id || !Number.isSafeInteger(user.role) || user.role < 3) {
      throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'Only an Assistant or Gamemaster can save templates.');
    }
  }

  private assertSafePermissions(pack: RepositoryPack | undefined): void {
    const current = this.host.currentUser;
    if (!current?.id || current.role < 3) throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'Only an Assistant or Gamemaster can write to this template library.');
    if (pack && pack.documentName !== 'JournalEntry') throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'The template compendium is not a JournalEntry compendium.');
    for (const user of this.host.users) {
      if (!user.id || !Number.isSafeInteger(user.role) || user.role < 1 || user.role > 4) {
        throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'Foundry returned an unknown user role; template writes are blocked.');
      }
      if (user.role >= 3) continue;
      let canModifySettings: unknown;
      let level: RepositoryPermissionLevel | undefined;
      try {
        canModifySettings = this.host.canModifySettings(user.id);
        level = pack?.permissionLevel(user.id);
      } catch (error) {
        throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'Effective world permissions could not be checked.', { cause: error });
      }
      if (typeof canModifySettings !== 'boolean') throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'The SETTINGS_MODIFY permission could not be checked.');
      if (canModifySettings) throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'A Player or Trusted user can modify world settings.');
      if (pack && level !== 'OBSERVER') throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'Players and Trusted users must have Observer access to the template compendium.');
    }
    if (pack) {
      if (pack.permissionLevel(current.id) !== 'OWNER') throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'The current user must have Owner access to the template compendium.');
      for (const user of this.host.users) {
        if (user.role >= 3 && pack.permissionLevel(user.id) !== 'OWNER') throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', 'Assistant and Gamemaster users must have Owner access to the template compendium.');
      }
    }
  }

  private assertPackType(pack: RepositoryPack): void {
    if (pack.documentName !== 'JournalEntry') throw new TemplateRepositoryError('UNSAFE_PERMISSIONS', `The reserved world collection ${PACK_COLLECTION} is not a JournalEntry compendium.`);
  }

  private async withWriteLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(id) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>(resolve => { release = resolve; });
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
