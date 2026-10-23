import test from 'node:test';
import assert from 'node:assert/strict';
import type { TemplateEnvelopeV1 } from '../src/domain/element-template.js';
import { createAnimationTemplate, createElementTemplate } from '../src/domain/element-template.js';
import { createFoundryTemplateRepository, TemplateRepositoryError } from '../src/integrations/foundry/template-repository.js';
import type {
  RepositoryHost, RepositoryPack, RepositoryPermissionLevel, RepositoryRpcEvent, RepositoryUser,
} from '../src/integrations/foundry/sequence-repository.js';
import type { TemplateRepository } from '../src/application/template-ports.js';
import type { BarsClip } from '../src/domain/sequence.js';

const MODULE_ID = 'stagecraft';
const TEMPLATE_PACK = 'world.stagecraft-templates';

interface FakePage {
  _id: string;
  name: string;
  flags: Record<string, unknown>;
  _stats: { lastModifiedBy: string };
}

interface FakeEntry {
  _id: string;
  name: string;
  flags: Record<string, unknown>;
  pages: FakePage[];
}

function moduleFlags(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const flags = value?.[MODULE_ID];
  return flags && typeof flags === 'object' ? flags as Record<string, unknown> : undefined;
}

function firstData(operation: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const data = operation?.data;
  return Array.isArray(data) && data[0] && typeof data[0] === 'object' ? data[0] as Record<string, unknown> : undefined;
}

class FakeWorld {
  readonly users: RepositoryUser[] = [
    { id: 'gm', role: 4 }, { id: 'assistant', role: 3 }, { id: 'trusted', role: 2 }, { id: 'player', role: 1 },
  ];
  readonly entries: FakeEntry[] = [];
  readonly sequenceRecords = [{ sentinel: 'keep' }];
  readonly packLevels = new Map<string, RepositoryPermissionLevel>();
  packExists = false;
  packDocumentName = 'JournalEntry';
  nextDocument = 0;
  nextRequest = 0;
  writeCount = 0;

  host(userId = 'gm'): RepositoryHost {
    const world = this;
    return {
      worldId: 'world-test',
      get currentUser() {
        const user = world.users.find(item => item.id === userId);
        if (!user) throw new Error('Unknown fake user.');
        return user;
      },
      get users() { return world.users; },
      findPack(collection): RepositoryPack | undefined {
        if (collection === 'world.stagecraft-sequences') throw new Error('Template storage inspected the sequence compendium.');
        if (collection !== TEMPLATE_PACK || !world.packExists) return undefined;
        return { documentName: world.packDocumentName, permissionLevel: id => world.packLevels.get(id) };
      },
      canModifySettings: () => false,
      createPack: async metadata => {
        assert.equal(metadata.name, 'stagecraft-templates');
        assert.equal(metadata.label, 'Stagecraft Templates');
        if (world.packExists) throw new Error('Compendium already exists.');
        world.packExists = true;
        world.packLevels.set('gm', 'OWNER');
        world.packLevels.set('assistant', 'OWNER');
        world.packLevels.set('trusted', 'OBSERVER');
        world.packLevels.set('player', 'OBSERVER');
      },
      makeId: () => `request-${++world.nextRequest}`,
      rpc: async (event, request) => world.dispatch(event, request, userId),
    };
  }

  private dispatch(event: RepositoryRpcEvent, request: Record<string, unknown>, actor: string): unknown {
    assert.equal(event, 'modifyDocument');
    const operation = request.operation as Record<string, unknown> | undefined;
    assert.equal(operation?.pack, TEMPLATE_PACK);
    const type = request.type;
    const action = request.action;
    if (type === 'JournalEntry' && action === 'get') return { result: structuredClone(this.entries) };
    if (type === 'JournalEntry' && action === 'create') {
      const data = firstData(operation);
      assert.ok(data);
      const entry: FakeEntry = {
        _id: `entry-${++this.nextDocument}`,
        name: String(data.name),
        flags: structuredClone(data.flags as Record<string, unknown>),
        pages: [],
      };
      this.entries.push(entry);
      this.writeCount += 1;
      return { result: [{ _id: entry._id }] };
    }
    if (type === 'JournalEntryPage' && action === 'create') {
      const pageData = firstData(operation);
      assert.ok(pageData);
      const parentId = String(operation?.parentUuid).split('.').at(-1);
      const parent = this.entries.find(entry => entry._id === parentId);
      assert.ok(parent);
      const pageId = String(pageData._id);
      if (parent.pages.some(page => page._id === pageId)) throw new Error('Duplicate immutable page slot.');
      parent.pages.push({
        _id: pageId, name: String(pageData.name), flags: structuredClone(pageData.flags as Record<string, unknown>),
        _stats: { lastModifiedBy: actor },
      });
      this.writeCount += 1;
      return { result: [{ _id: pageId }] };
    }
    throw new Error(`Unexpected fake operation ${String(type)} ${String(action)}.`);
  }
}

function barsClip(): BarsClip {
  return {
    id: 'source-clip', trackId: 'source-track', type: 'bars', typeVersion: 1, startMs: 2_000,
    duration: { kind: 'fixed', milliseconds: 4_000 },
    entrance: { preset: 'fade', version: 1, durationMs: 500, easing: 'ease-in-out' },
    exit: { preset: 'none', version: 1 },
    properties: { heightFraction: 0.14, color: '#101010' },
  };
}

function elementTemplate(id: string, name = `Template ${id}`): TemplateEnvelopeV1 {
  return createElementTemplate(id, name, barsClip(), { width: 1920, height: 1080 });
}

function assertCode(code: TemplateRepositoryError['code']) {
  return (error: unknown): boolean => error instanceof TemplateRepositoryError && error.code === code;
}

test('template repository uses its own world compendium and preserves immutable revisions', async () => {
  const world = new FakeWorld();
  const repository = createFoundryTemplateRepository(world.host());
  assert.deepEqual(await repository.list(), []);
  const created = await repository.save(elementTemplate('bars-title'), null);
  assert.equal(created.revision, 1);
  assert.equal(world.packExists, true);
  assert.equal(world.sequenceRecords[0]?.sentinel, 'keep');
  const saved = await repository.read('bars-title') as TemplateEnvelopeV1;
  assert.equal(saved.name, 'Template bars-title');
  assert.equal(saved.content.kind, 'element');
  if (saved.content.kind !== 'element') throw new Error('Expected an element template.');
  assert.equal(saved.content.clip.type, 'bars');
  assert.deepEqual((await repository.list()).map(item => [item.id, item.revision]), [['bars-title', 1]]);

  const renamed = await repository.save({ ...saved, name: 'Revised name' }, 1);
  assert.equal(renamed.revision, 2);
  assert.equal((await repository.read('bars-title') as TemplateEnvelopeV1).name, 'Revised name');
  await assert.rejects(repository.save(saved, 1), assertCode('CONFLICT'));
  await repository.delete('bars-title', 2);
  assert.deepEqual(await repository.list(), []);
  await assert.rejects(repository.read('bars-title'), assertCode('NOT_FOUND'));
  assert.deepEqual(world.sequenceRecords, [{ sentinel: 'keep' }]);
});

test('concurrent writers cannot overwrite a template revision', async () => {
  const world = new FakeWorld();
  const first = createFoundryTemplateRepository(world.host());
  const created = await first.save(elementTemplate('race'), null);
  const second = createFoundryTemplateRepository(world.host('assistant'));
  const outcomes = await Promise.allSettled([
    first.save({ ...created, name: 'First writer' }, 1),
    second.save({ ...created, name: 'Second writer' }, 1),
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(item => item.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof TemplateRepositoryError);
  assert.equal(rejected.reason.code, 'CONFLICT');
  assert.equal((await first.read('race') as TemplateEnvelopeV1).revision, 2);
});

test('template writes fail closed for a non-GM and invalid persisted templates stay visible', async () => {
  const world = new FakeWorld();
  const playerRepository = createFoundryTemplateRepository(world.host('player'));
  await assert.rejects(playerRepository.save(elementTemplate('blocked'), null), assertCode('UNSAFE_PERMISSIONS'));
  assert.equal(world.packExists, false);

  const repository = createFoundryTemplateRepository(world.host());
  await repository.save(elementTemplate('bad-record'), null);
  const entry = world.entries.find(candidate => moduleFlags(candidate.flags)?.templateId === 'bad-record');
  assert.ok(entry);
  const revision = entry.pages.find(page => moduleFlags(page.flags)?.operation === 'save');
  assert.ok(revision);
  const flags = moduleFlags(revision.flags);
  assert.ok(flags);
  const payload = flags.template as Record<string, unknown>;
  flags.template = { ...payload, schemaVersion: 99 };
  const listed = await repository.list();
  assert.equal(listed.length, 1);
  assert.ok(listed[0]?.issue);
  await assert.rejects(repository.read('bad-record'), error => error instanceof TemplateRepositoryError && error.code === 'UNSUPPORTED_DATA');
  await assert.rejects(repository.save(elementTemplate('bad-record'), 1), assertCode('UNSUPPORTED_DATA'));
});

test('animation records persist one transition and its source composition', async () => {
  const world = new FakeWorld();
  const repository: TemplateRepository = createFoundryTemplateRepository(world.host());
  const template = createAnimationTemplate('fade-out', 'Fade out', {
    preset: 'fade', version: 1, durationMs: 450, easing: 'ease-in',
  }, { width: 1920, height: 1080 }, 'bars');
  const saved = await repository.save(template, null);
  assert.equal(saved.revision, 1);
  const read = await repository.read('fade-out') as TemplateEnvelopeV1;
  assert.equal(read.content.kind, 'animation');
  if (read.content.kind !== 'animation') throw new Error('Expected animation template.');
  assert.deepEqual(read.content.sourceComposition, { width: 1920, height: 1080 });
  assert.equal(read.content.sourceType, 'bars');
  assert.equal(read.content.transition.preset, 'fade');
});
