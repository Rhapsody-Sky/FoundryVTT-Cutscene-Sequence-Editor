import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID } from '../src/application/foundation-status.js';
import { defaultButtonProperties } from '../src/domain/button.js';
import type { ButtonClip } from '../src/domain/sequence.js';
import { createBarsSequence } from '../src/domain/validation.js';
import { choiceChatId, createButtonChoiceChat, type ChoiceChatHost } from '../src/integrations/foundry/button-choice-chat.js';
import type { ButtonChoiceCardInput } from '../src/playback/personal-progression.js';

type ChatMessage = Record<string, unknown>;
type CreateFailure = 'before-persist' | 'after-persist';

class FakeChoiceChatHost implements ChoiceChatHost {
  readonly currentUser: { readonly id: string; readonly isGM: boolean };
  readonly users: readonly { readonly id: string; readonly name: string; readonly isGM: boolean }[];
  readonly messages = new Map<string, ChatMessage>();
  createCalls = 0;
  readCalls = 0;
  nextCreateFailure: CreateFailure | undefined;
  createBarrier: Promise<void> | undefined;

  constructor(currentUser = { id: 'gm-1', isGM: true }, playerName = 'Player') {
    this.currentUser = currentUser;
    this.users = [
      { id: 'gm-1', name: 'GM One', isGM: true },
      { id: 'gm-2', name: 'GM Two', isGM: true },
      { id: 'player-1', name: playerName, isGM: false },
    ];
  }

  async readMessage(id: string): Promise<readonly ChatMessage[]> {
    this.readCalls += 1;
    const message = this.messages.get(id);
    return message ? [structuredClone(message)] : [];
  }

  async createMessage(data: Record<string, unknown>): Promise<unknown> {
    this.createCalls += 1;
    if (this.createBarrier) await this.createBarrier;
    if (this.nextCreateFailure === 'before-persist') {
      this.nextCreateFailure = undefined;
      throw new Error('failed before persistence');
    }
    const id = data._id;
    if (typeof id !== 'string') throw new Error('native message ID is required');
    if (this.messages.has(id)) throw new Error('native message ID already exists');
    const stored = structuredClone(data);
    this.messages.set(id, stored);
    if (this.nextCreateFailure === 'after-persist') {
      this.nextCreateFailure = undefined;
      throw new Error('acknowledgement lost after persistence');
    }
    return structuredClone(stored);
  }
}

function makeInput(overrides: {
  operationId?: string;
  sequenceName?: string;
  label?: string;
  message?: string;
  visibility?: 'public' | 'gm';
} = {}): ButtonChoiceCardInput {
  let nextId = 0;
  const snapshot = createBarsSequence(overrides.sequenceName ?? 'Opening Scene', () => `generated-${++nextId}`, 3);
  const action = {
    kind: 'choice' as const,
    decisionId: 'decision-1',
    optionId: 'option-1',
    message: overrides.message ?? 'I choose this path.',
    visibility: overrides.visibility ?? 'public',
  };
  const button: ButtonClip = {
    type: 'button', typeVersion: 1, id: 'button-1', trackId: snapshot.tracks[0]!.id, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5_000 },
    entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    properties: { ...defaultButtonProperties(), label: overrides.label ?? 'Choose', action },
  };
  return {
    operationId: overrides.operationId ?? '["run-1","player-1","decision-1"]',
    runId: 'run-1',
    participant: { userId: 'player-1', sessionId: 'session-1' },
    snapshot,
    button,
    action,
  };
}

function storedFlag(input: ButtonChoiceCardInput, overrides: Partial<Record<string, unknown>> = {}): ChatMessage {
  return {
    _id: choiceChatId(input.operationId),
    author: 'gm-1',
    content: 'existing document must remain untouched',
    flags: { [MODULE_ID]: {
      role: 'button-choice', operationId: input.operationId, optionId: input.action.optionId,
      userId: input.participant.userId, ...overrides,
    } },
  };
}

test('choice cards use public delivery or whisper to every GM according to the authored visibility', async () => {
  const publicHost = new FakeChoiceChatHost();
  const publicInput = makeInput({ visibility: 'public' });
  await createButtonChoiceChat(publicHost)(publicInput);
  const publicMessage = publicHost.messages.get(choiceChatId(publicInput.operationId))!;
  assert.deepEqual(publicMessage.whisper, []);

  const gmHost = new FakeChoiceChatHost();
  const gmInput = makeInput({ visibility: 'gm' });
  await createButtonChoiceChat(gmHost)(gmInput);
  const gmMessage = gmHost.messages.get(choiceChatId(gmInput.operationId))!;
  assert.deepEqual(gmMessage.whisper, ['gm-1', 'gm-2']);
  assert.equal(gmMessage.author, 'gm-1');
});

test('choice-card HTML escapes sequence, player, button, and message text before adding line breaks', async () => {
  const hostile = `A&<>"'`;
  const host = new FakeChoiceChatHost({ id: 'gm-1', isGM: true }, hostile);
  const input = makeInput({ sequenceName: hostile, label: hostile, message: `${hostile}\r\n${hostile}` });
  await createButtonChoiceChat(host)(input);
  const message = host.messages.get(choiceChatId(input.operationId))!;

  assert.equal(message.content,
    '<section class="stagecraft-choice-card"><h3>A&amp;&lt;&gt;&quot;&#39;</h3>' +
    '<p><strong>A&amp;&lt;&gt;&quot;&#39;</strong>: A&amp;&lt;&gt;&quot;&#39;</p>' +
    '<p>A&amp;&lt;&gt;&quot;&#39;<br>A&amp;&lt;&gt;&quot;&#39;</p></section>');
  assert.deepEqual(message.speaker, { alias: hostile });
});

test('concurrent duplicate calls and a recreated adapter return one stable native message ID', async () => {
  const host = new FakeChoiceChatHost();
  let releaseCreate!: () => void;
  host.createBarrier = new Promise<void>(resolve => { releaseCreate = resolve; });
  const input = makeInput();
  const write = createButtonChoiceChat(host);
  const first = write(input);
  const duplicate = write(input);
  assert.equal(first, duplicate, 'concurrent retries share the pending operation');
  releaseCreate();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(firstResult.messageId, choiceChatId(input.operationId));
  assert.equal(duplicateResult.messageId, firstResult.messageId);
  assert.equal(host.createCalls, 1);
  assert.equal(host.messages.size, 1);

  const recreatedResult = await createButtonChoiceChat(host)(input);
  assert.equal(recreatedResult.messageId, firstResult.messageId);
  assert.equal(host.createCalls, 1, 'the persisted document is recovered by the new adapter');
  assert.equal(host.messages.size, 1);
});

test('an acknowledgement loss after persistence reconciles to the stored message', async () => {
  const host = new FakeChoiceChatHost();
  host.nextCreateFailure = 'after-persist';
  const input = makeInput();
  const result = await createButtonChoiceChat(host)(input);

  assert.equal(result.messageId, choiceChatId(input.operationId));
  assert.equal(host.createCalls, 1);
  assert.equal(host.messages.size, 1);
});

test('a failure before persistence rejects, and retry creates the choice exactly once', async () => {
  const host = new FakeChoiceChatHost();
  host.nextCreateFailure = 'before-persist';
  const input = makeInput();
  const write = createButtonChoiceChat(host);

  await assert.rejects(write(input), { message: 'failed before persistence' });
  assert.equal(host.messages.size, 0);
  const retried = await write(input);
  assert.equal(retried.messageId, choiceChatId(input.operationId));
  assert.equal(host.createCalls, 2);
  assert.equal(host.messages.size, 1);
});

test('an occupied deterministic ID or mismatched choice flags rejects without overwriting the native document', async () => {
  const cases = [
    { name: 'different operation at the same deterministic ID', flags: { operationId: 'another-operation' } },
    { name: 'wrong role flag', flags: { role: 'other' } },
    { name: 'wrong option flag', flags: { optionId: 'another-option' } },
  ];
  for (const item of cases) {
    const host = new FakeChoiceChatHost();
    const input = makeInput();
    const existing = storedFlag(input, item.flags);
    host.messages.set(choiceChatId(input.operationId), structuredClone(existing));

    await assert.rejects(createButtonChoiceChat(host)(input), /BUTTON_CHAT_CONFLICT/, item.name);
    assert.equal(host.createCalls, 0, item.name);
    assert.deepEqual(host.messages.get(choiceChatId(input.operationId)), existing, item.name);
  }
});

test('non-GM writers are forbidden before any world read or create', async () => {
  const host = new FakeChoiceChatHost({ id: 'player-1', isGM: false });
  await assert.rejects(createButtonChoiceChat(host)(makeInput()), { message: 'GM_ONLY' });
  assert.equal(host.readCalls, 0);
  assert.equal(host.createCalls, 0);
});

test('a player-authored message cannot impersonate the GM choice receipt by copying its flags', async () => {
  const host = new FakeChoiceChatHost();
  const input = makeInput();
  host.messages.set(choiceChatId(input.operationId), { ...storedFlag(input), author: 'player-1' });
  await assert.rejects(createButtonChoiceChat(host)(input), /BUTTON_CHAT_CONFLICT/);
  assert.equal(host.createCalls, 0);
});

test('another GM can reconcile an existing choice card after writer handover', async () => {
  const host = new FakeChoiceChatHost({ id: 'gm-2', isGM: true });
  const input = makeInput();
  host.messages.set(choiceChatId(input.operationId), storedFlag(input));
  const result = await createButtonChoiceChat(host)(input);
  assert.equal(result.messageId, choiceChatId(input.operationId));
  assert.equal(host.createCalls, 0);
});
