import type {
  OrchestrationCommand,
  OrchestrationRecord,
  OrchestrationState,
} from '../../playback/orchestration-protocol.js';
import { reduceOrchestration } from '../../playback/orchestration-protocol.js';
import type {
  RepositoryHost,
  RepositoryPack,
} from './sequence-repository.js';

import { MODULE_ID } from '../../module-identity.js';
const PACK_COLLECTION = 'world.stagecraft-sequences';
const ROOT_ROLE = 'authority';
const ROOT_SCHEMA_VERSION = 1;
const SESSION_RECORD_ROLE = 'session-control';
const SESSION_RECORD_VERSION = 4;
const MAX_SESSION_RECORDS = 20_000;

import { SessionStoreError } from './session-store.js';
export { SessionStoreError } from './session-store.js';

export interface OrchestrationStore {
  read(): Promise<OrchestrationState>;
  append(command: OrchestrationCommand, expectedHead: number): Promise<OrchestrationState>;
}

interface EntryRecord {
  readonly _id?: unknown;
  readonly flags?: unknown;
  readonly pages?: unknown;
}

interface PageRecord {
  readonly _id?: unknown;
  readonly flags?: unknown;
  readonly _stats?: unknown;
}

interface SessionSnapshot {
  readonly rootId: string;
  readonly records: readonly OrchestrationRecord[];
  readonly state: OrchestrationState;
}

interface NativeResponse {
  readonly result?: unknown;
  readonly error?: unknown;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function flagsOf(value: unknown): Record<string, unknown> | undefined {
  return object(object(value)?.[MODULE_ID]);
}

function slotId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_SESSION_RECORDS) {
    throw new SessionStoreError(
      'SESSION_UNSUPPORTED',
      `The session log exceeds ${MAX_SESSION_RECORDS} records.`
    );
  }
  return `s${index.toString(36).padStart(15, '0')}`;
}

function storageFailure(message: string, cause: unknown): SessionStoreError {
  if (cause instanceof SessionStoreError) return cause;
  return new SessionStoreError('SESSION_STORAGE_FAILURE', message, { cause });
}

function responseResult(value: unknown): unknown {
  const response = object(value) as NativeResponse | undefined;
  if (!response) {
    throw new SessionStoreError('SESSION_STORAGE_FAILURE', 'Foundry returned an invalid session document response.');
  }
  if (response.error !== undefined) {
    const details = object(response.error);
    throw new SessionStoreError(
      'SESSION_STORAGE_FAILURE',
      stringValue(details?.message) ?? 'Foundry rejected the session document operation.'
    );
  }
  return response.result;
}

function assertRootVersion(value: unknown): void {
  if (value === ROOT_SCHEMA_VERSION) return;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > ROOT_SCHEMA_VERSION) {
    throw new SessionStoreError('SESSION_UNSUPPORTED', `Unsupported authority root version ${value}.`);
  }
  throw new SessionStoreError('SESSION_CORRUPT', 'The authority root has no valid schema version.');
}

function assertRecordVersion(value: unknown): void {
  if (value === 1 || value === 2 || value === 3 || value === SESSION_RECORD_VERSION) return;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > SESSION_RECORD_VERSION) {
    throw new SessionStoreError('SESSION_UNSUPPORTED', `Unsupported session record version ${value}.`);
  }
  throw new SessionStoreError('SESSION_CORRUPT', 'A session record has no valid version marker.');
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('A session command contains a non-finite number.');
      return item;
    }
    if (Array.isArray(item)) return item.map(normalize);
    const record = object(item);
    if (!record) throw new TypeError('A session command must contain only JSON-compatible values.');
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])]));
  };
  return JSON.stringify(normalize(value));
}

export function createOrchestrationStore(host: RepositoryHost): OrchestrationStore {
  return new FoundryOrchestrationStore(host);
}

class FoundryOrchestrationStore implements OrchestrationStore {
  constructor(private readonly host: RepositoryHost) {}

  async read(): Promise<OrchestrationState> {
    return structuredClone((await this.readSnapshot()).state);
  }

  async append(command: OrchestrationCommand, expectedHead: number): Promise<OrchestrationState> {
    if (!Number.isSafeInteger(expectedHead) || expectedHead < 0 || expectedHead >= MAX_SESSION_RECORDS) {
      throw new SessionStoreError('SESSION_INVALID', 'The expected session head is invalid.');
    }

    const pack = this.requirePack();
    this.assertSafePermissions(pack);

    const snapshot = await this.readSnapshot();
    if (snapshot.state.head !== expectedHead) {
      throw new SessionStoreError('SESSION_CONFLICT', `The session changed after head ${expectedHead}.`);
    }

    const index = expectedHead + 1;
    const requestId = this.requireRequestId(this.host.makeId());
    if (snapshot.records.some((record) => record.requestId === requestId)) {
      throw new SessionStoreError('SESSION_STORAGE_FAILURE', 'Foundry generated a duplicate session request ID.');
    }
    const actor = this.requireWriterId();
    let payload: OrchestrationCommand;
    try {
      payload = structuredClone(command);
      stableJson(payload);
    } catch (error) {
      throw new SessionStoreError('SESSION_INVALID', 'The session command is not valid JSON data.', { cause: error });
    }

    const record: OrchestrationRecord = {
      recordVersion: payload.kind === 'upgrade4' ? 4 : payload.kind === 'upgrade3' ? 3 : payload.kind === 'upgrade' ? 2 : snapshot.state.version,
      index,
      previous: expectedHead,
      requestId,
      actor,
      payload,
    };
    this.preview(snapshot.rootId, [...snapshot.records, record]);
    this.assertAudienceAdmission(payload, snapshot.state);

    const operation = this.pageCreateOperation(snapshot.rootId, record);
    this.assertSafePermissions(this.requirePack());
    try {
      const response = await this.host.rpc('modifyDocument', {
        type: 'JournalEntryPage',
        action: 'create',
        operation,
      });
      const result = responseResult(response);
      if (!Array.isArray(result) || result.length !== 1 || object(result[0])?._id !== slotId(index)) {
        throw new SessionStoreError('SESSION_STORAGE_FAILURE', 'Foundry did not confirm the session append.');
      }
    } catch (error) {
      const reconciled = await this.reconcileAppend(record, error);
      return structuredClone(reconciled.state);
    }

    const confirmed = await this.readSnapshot();
    if (this.findRequest(confirmed, record)) return structuredClone(confirmed.state);
    if (confirmed.state.head >= index) {
      throw new SessionStoreError('SESSION_CONFLICT', 'Another session record occupies the append slot.');
    }
    throw new SessionStoreError('SESSION_STORAGE_FAILURE', 'Foundry acknowledged a session append that could not be read back.');
  }

  /** Current roles apply at admission; committed snapshots keep their identities. */
  private assertAudienceAdmission(command: OrchestrationCommand, state: OrchestrationState): void {
    if (command.kind !== 'enqueue' && command.kind !== 'prepare' && command.kind !== 'start') return;
    const users = new Map(this.host.users.map(user => [user.id, user]));
    const launch = command.kind === 'prepare' || command.kind === 'start'
      ? state.launches.find(item => item.runId === command.runId) : undefined;
    const ids = command.kind === 'enqueue' ? command.userIds
      : [...(launch?.userIds ?? []), ...command.recipients.map(item => item.userId)];
    for (const id of ids) {
      const user = users.get(id);
      if (!user) throw new SessionStoreError('SESSION_INVALID', 'A reserved audience user no longer exists.');
      if (user.role >= 3 && id !== state.owner?.userId) {
        throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'Only the directing GM may be included in the audience.');
      }
    }
  }

  private requirePack(): RepositoryPack {
    if (!this.host.worldId) {
      throw new SessionStoreError('SESSION_UNAVAILABLE', 'A loaded Foundry world is required for group playback.');
    }
    const pack = this.host.findPack(PACK_COLLECTION);
    if (!pack) {
      throw new SessionStoreError('SESSION_UNAVAILABLE', 'The sequence authority store is not initialized.');
    }
    if (pack.documentName !== 'JournalEntry') {
      throw new SessionStoreError('SESSION_UNAVAILABLE', 'The sequence authority store is not a JournalEntry compendium.');
    }
    return pack;
  }

  private assertSafePermissions(pack: RepositoryPack): void {
    const currentUser = this.host.currentUser;
    if (!currentUser?.id || !Number.isSafeInteger(currentUser.role) || currentUser.role < 3) {
      throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'Only an Assistant or Gamemaster can control group playback.');
    }
    if (pack.documentName !== 'JournalEntry') {
      throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'The authority store has an unsafe document type.');
    }

    let users: readonly { readonly id: string; readonly role: number }[];
    try {
      users = this.host.users;
      for (const user of users) {
        if (!user.id || !Number.isSafeInteger(user.role) || user.role < 1 || user.role > 4) {
          throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'Foundry returned an unknown user role; session writes are blocked.');
        }
        if (user.role >= 3) continue;
        const canModifySettings: unknown = this.host.canModifySettings(user.id);
        const level = pack.permissionLevel(user.id);
        if (typeof canModifySettings !== 'boolean' || canModifySettings) {
          throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'A Player or Trusted user can modify world settings.');
        }
        if (level !== 'OBSERVER') {
          throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'Players and Trusted users must have exactly Observer access to the authority store.');
        }
      }

      if (pack.permissionLevel(currentUser.id) !== 'OWNER') {
        throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'The current controller must have effective Owner access to the authority store.');
      }
      for (const user of users) {
        if (user.role >= 3 && pack.permissionLevel(user.id) !== 'OWNER') {
          throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'Assistant and Gamemaster users must have effective Owner access to the authority store.');
        }
      }
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'Effective world permissions could not be checked.', { cause: error });
    }
  }

  private async readSnapshot(): Promise<SessionSnapshot> {
    this.requirePack();
    let response: unknown;
    try {
      response = await this.host.rpc('modifyDocument', {
        type: 'JournalEntry',
        action: 'get',
        operation: { pack: PACK_COLLECTION, query: {} },
      });
    } catch (error) {
      throw storageFailure('The session authority store could not be read.', error);
    }
    const result = responseResult(response);
    if (!Array.isArray(result) || !result.every((entry) => object(entry) !== undefined)) {
      throw new SessionStoreError('SESSION_STORAGE_FAILURE', 'Foundry returned an invalid authority store read.');
    }
    const entries = result as EntryRecord[];
    const roots = entries.filter((entry) => flagsOf(entry.flags)?.role === ROOT_ROLE);
    if (roots.length === 0) {
      throw new SessionStoreError('SESSION_UNAVAILABLE', 'The sequence authority root is missing; session storage is unavailable.');
    }
    if (roots.length !== 1) {
      throw new SessionStoreError('SESSION_CORRUPT', 'The sequence authority root is ambiguous; no root was selected.');
    }
    const root = roots[0];
    if (!root) throw new SessionStoreError('SESSION_CORRUPT', 'The sequence authority root could not be selected.');
    const rootFlags = flagsOf(root.flags);
    assertRootVersion(rootFlags?.schemaVersion);
    const rootId = stringValue(root._id);
    if (!rootId) throw new SessionStoreError('SESSION_CORRUPT', 'The sequence authority root has no server-assigned ID.');
    if (root.pages !== undefined && !Array.isArray(root.pages)) {
      throw new SessionStoreError('SESSION_CORRUPT', 'The authority root has an invalid page collection.');
    }

    const rawPages = (root.pages ?? []) as PageRecord[];
    const sessionPages = rawPages.filter((page) => flagsOf(page.flags)?.role === SESSION_RECORD_ROLE);
    if (sessionPages.length > MAX_SESSION_RECORDS) {
      throw new SessionStoreError('SESSION_UNSUPPORTED', `The session log exceeds ${MAX_SESSION_RECORDS} records.`);
    }

    const recordsByIndex = new Map<number, OrchestrationRecord>();
    const requestIds = new Set<string>();
    const gmIds = this.readGamemasterIds();
    for (const page of sessionPages) {
      const flags = flagsOf(page.flags);
      if (!flags) throw new SessionStoreError('SESSION_CORRUPT', 'A session page has no module record.');
      assertRecordVersion(flags.recordVersion);
      const index = flags.index;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 1 || index > MAX_SESSION_RECORDS) {
        throw new SessionStoreError('SESSION_CORRUPT', 'A session record has an invalid index.');
      }
      if (recordsByIndex.has(index)) {
        throw new SessionStoreError('SESSION_CORRUPT', `Duplicate session index ${index} is present.`);
      }
      if (page._id !== slotId(index)) {
        throw new SessionStoreError('SESSION_CORRUPT', `Session slot ${index} has an unexpected page ID.`);
      }
      if (flags.previous !== index - 1) {
        throw new SessionStoreError('SESSION_CORRUPT', `Session record ${index} has broken ancestry.`);
      }
      const requestId = stringValue(flags.requestId);
      if (!requestId || requestIds.has(requestId)) {
        throw new SessionStoreError('SESSION_CORRUPT', `Session record ${index} has a missing or duplicate request ID.`);
      }
      requestIds.add(requestId);
      const actor = stringValue(object(page._stats)?.lastModifiedBy);
      if (!actor || !gmIds.has(actor)) {
        throw new SessionStoreError('SESSION_CORRUPT', `Session record ${index} was not written by a current Assistant or Gamemaster.`);
      }
      if (!Object.prototype.hasOwnProperty.call(flags, 'payload')) {
        throw new SessionStoreError('SESSION_CORRUPT', `Session record ${index} has no command payload.`);
      }
      recordsByIndex.set(index, {
        recordVersion: flags.recordVersion as 1 | 2 | 3,
        index,
        previous: index - 1,
        requestId,
        actor,
        payload: flags.payload as OrchestrationCommand,
      });
    }

    const records: OrchestrationRecord[] = [];
    for (let expectedIndex = 1; expectedIndex <= recordsByIndex.size; expectedIndex += 1) {
      const record = recordsByIndex.get(expectedIndex);
      if (!record) throw new SessionStoreError('SESSION_CORRUPT', `The session log has a gap at record ${expectedIndex}.`);
      records.push(record);
    }
    if (recordsByIndex.size !== sessionPages.length) {
      throw new SessionStoreError('SESSION_CORRUPT', 'The session log has duplicate or unindexed records.');
    }

    let state: OrchestrationState;
    try {
      state = reduceOrchestration(rootId, records, (userId) => gmIds.has(userId));
    } catch (error) {
      throw new SessionStoreError('SESSION_CORRUPT', 'The session log contains an invalid control history.', { cause: error });
    }
    return { rootId, records, state };
  }

  private readGamemasterIds(): ReadonlySet<string> {
    let users: RepositoryHost['users'];
    try {
      users = this.host.users;
    } catch (error) {
      throw new SessionStoreError('SESSION_STORAGE_FAILURE', 'Foundry user roles could not be read.', { cause: error });
    }
    const ids = new Set<string>();
    for (const user of users) {
      if (!user.id || !Number.isSafeInteger(user.role) || user.role < 1 || user.role > 4) {
        throw new SessionStoreError('SESSION_STORAGE_FAILURE', 'Foundry returned an unknown user role.');
      }
      if (user.role >= 3) ids.add(user.id);
    }
    return ids;
  }

  private preview(rootId: string, records: readonly OrchestrationRecord[]): void {
    const gmIds = this.readGamemasterIds();
    try {
      reduceOrchestration(rootId, records, (userId) => gmIds.has(userId));
    } catch (error) {
      throw new SessionStoreError('SESSION_INVALID', 'The session command is not valid for the current state.', { cause: error });
    }
  }

  private pageCreateOperation(rootId: string, record: OrchestrationRecord): Record<string, unknown> {
    return {
      pack: PACK_COLLECTION,
      parentUuid: `Compendium.${PACK_COLLECTION}.JournalEntry.${rootId}`,
      keepId: true,
      render: false,
      renderSheet: false,
      data: [{
        _id: slotId(record.index),
        name: `Session ${record.index}`,
        type: 'text',
        flags: {
          [MODULE_ID]: {
            role: SESSION_RECORD_ROLE,
            recordVersion: record.recordVersion,
            index: record.index,
            previous: record.previous,
            requestId: record.requestId,
            payload: structuredClone(record.payload),
          },
        },
      }],
    };
  }

  private async reconcileAppend(record: OrchestrationRecord, cause: unknown): Promise<SessionSnapshot> {
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.readSnapshot();
    } catch (readError) {
      throw storageFailure('The append acknowledgement was lost and the session could not be reconciled.', readError);
    }
    if (this.findRequest(snapshot, record)) return snapshot;
    if (snapshot.state.head >= record.index) {
      throw new SessionStoreError('SESSION_CONFLICT', 'Another session record won this append slot; the staged command was not retried.', { cause });
    }
    throw storageFailure('The session append could not be confirmed. Reload the session before trying again.', cause);
  }

  private findRequest(snapshot: SessionSnapshot, expected: OrchestrationRecord): boolean {
    const stored = snapshot.records.find((record) => record.requestId === expected.requestId);
    if (!stored) return false;
    return stored.index === expected.index
      && stored.previous === expected.previous
      && stored.actor === expected.actor
      && stableJson(stored.payload) === stableJson(expected.payload);
  }

  private requireWriterId(): string {
    const user = this.host.currentUser;
    if (!user?.id || !Number.isSafeInteger(user.role) || user.role < 3) {
      throw new SessionStoreError('SESSION_PERMISSION_DENIED', 'Only an Assistant or Gamemaster can control group playback.');
    }
    return user.id;
  }

  private requireRequestId(value: string): string {
    const requestId = stringValue(value);
    if (!requestId) throw new SessionStoreError('SESSION_STORAGE_FAILURE', 'Foundry could not generate a session request ID.');
    return requestId;
  }
}
