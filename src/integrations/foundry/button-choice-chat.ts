import { MODULE_ID } from '../../application/foundation-status.js';
import type { ButtonChoiceCardInput } from '../../playback/personal-progression.js';

export interface ChoiceChatHost {
  readonly currentUser: { readonly id: string; readonly isGM: boolean };
  readonly users: readonly { readonly id: string; readonly name: string; readonly isGM: boolean }[];
  readMessage(id: string): Promise<readonly Record<string, unknown>[]>;
  createMessage(data: Record<string, unknown>): Promise<unknown>;
}

/** Deterministic native document identity also protects retries after an ambiguous write.
 * The flag is checked on every read, so a hash collision fails rather than reusing another choice. */
export function choiceChatId(operationId: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of operationId) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
function marker(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const flags = record.flags;
  if (!flags || typeof flags !== 'object') return undefined;
  const value = (flags as Record<string, unknown>)[MODULE_ID];
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

/** Only the GM writer calls this adapter, with the action from the immutable run snapshot. */
export function createButtonChoiceChat(host: ChoiceChatHost): (input: ButtonChoiceCardInput) => Promise<{ messageId: string }> {
  const pending = new Map<string, Promise<{ messageId: string }>>();
  async function ensure(input: ButtonChoiceCardInput): Promise<{ messageId: string }> {
    if (!host.currentUser.isGM) throw new Error('GM_ONLY');
    const id = choiceChatId(input.operationId);
    async function exists(): Promise<boolean> {
      const records = await host.readMessage(id);
      if (!records.length) return false;
      if (records.length !== 1 || records[0]!._id !== id) throw new Error('BUTTON_CHAT_CONFLICT');
      const flag = marker(records[0]!);
      const trustedAuthor = host.users.some(user => user.isGM && user.id === records[0]!.author);
      if (!trustedAuthor || flag?.role !== 'button-choice' || flag.operationId !== input.operationId
        || flag.optionId !== input.action.optionId || flag.userId !== input.participant.userId) {
        throw new Error('BUTTON_CHAT_CONFLICT');
      }
      return true;
    }
    if (await exists()) return { messageId: id };
    const player = host.users.find(user => user.id === input.participant.userId);
    if (!player) throw new Error('SESSION_RECIPIENT_UNAVAILABLE');
    const whisper = input.action.visibility === 'gm' ? host.users.filter(user => user.isGM).map(user => user.id) : [];
    if (input.action.visibility === 'gm' && !whisper.length) throw new Error('GM_ONLY');
    try {
      await host.createMessage({
        _id: id, author: host.currentUser.id, speaker: { alias: player.name },
        whisper, blind: false,
        content: `<section class="stagecraft-choice-card"><h3>${escape(input.snapshot.name)}</h3><p><strong>${escape(player.name)}</strong>: ${escape(input.button.properties.label)}</p><p>${escape(input.action.message).replace(/\r?\n/g, '<br>')}</p></section>`,
        flags: { [MODULE_ID]: { role: 'button-choice', version: 1, operationId: input.operationId,
          runId: input.runId, userId: player.id, sequenceId: input.snapshot.id,
          decisionId: input.action.decisionId, optionId: input.action.optionId, clipId: input.button.id } }
      });
    } catch (error) {
      // A server write can succeed after the acknowledgement was lost. A retry uses the same ID.
      if (!await exists()) throw error;
    }
    if (!await exists()) throw new Error('BUTTON_CHAT_UNCONFIRMED');
    return { messageId: id };
  }
  return input => {
    const previous = pending.get(input.operationId);
    if (previous) return previous;
    const task = ensure(input).finally(() => pending.delete(input.operationId));
    pending.set(input.operationId, task);
    return task;
  };
}
