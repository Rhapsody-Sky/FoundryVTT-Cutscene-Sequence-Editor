import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftService } from '../src/application/draft-service.js';
import type { AudienceUser } from '../src/application/audience-resolver.js';
import { getSequenceAutomation, withSequenceAudience, withSequenceAutomation } from '../src/domain/sequence-audience.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import { createBreaksSequence } from '../src/domain/validation.js';
import { TriggerSettingsView, type TriggerSettingsValue } from '../src/ui/trigger-settings.js';

type Listener = (event: Event) => void;

/** Small DOM surface for testing authoring data/actions without claiming browser layout coverage. */
class SettingsElement {
  readonly children: SettingsElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<Listener>>();
  parentElement: SettingsElement | null = null;
  className = '';
  tagName: string;
  type = '';
  name = '';
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  title = '';
  private text = '';

  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }

  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string | null) { this.replaceChildren(); this.text = value ?? ''; }

  append(...nodes: SettingsElement[]): void {
    for (const node of nodes) { node.parentElement = this; this.children.push(node); }
  }

  replaceChildren(...nodes: SettingsElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.text = '';
    this.append(...nodes);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  contains(candidate: SettingsElement): boolean { return candidate === this || this.children.some(child => child.contains(candidate)); }

  querySelectorAll<T extends SettingsElement = SettingsElement>(selector: string): T[] {
    const selectors = selector.split(',').map(part => part.trim());
    const result: T[] = [];
    for (const child of this.children) {
      if (selectors.some(part => child.matches(part))) result.push(child as T);
      result.push(...child.querySelectorAll<T>(selector));
    }
    return result;
  }

  querySelector<T extends SettingsElement = SettingsElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }

  dispatch(type: string, target: SettingsElement): void {
    const event = { type, target } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private matches(selector: string): boolean {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    const className = selector.match(/\.([\w-]+)/)?.[1];
    if (className && !this.className.split(/\s+/).includes(className)) return false;
    for (const match of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      const [, attribute, expected] = match;
      if (!attribute) continue;
      const dataName = attribute.startsWith('data-')
        ? attribute.slice(5).replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase())
        : undefined;
      const actual = dataName ? this.dataset[dataName] : this.attributes.get(attribute);
      if (actual === undefined || (expected !== undefined && actual !== expected)) return false;
    }
    return true;
  }
}

class SettingsDocument {
  activeElement: SettingsElement | null = null;
  createElement(tagName: string): SettingsElement { return new SettingsElement(tagName); }
}

const dictionary: Record<string, string> = {
  'STAGECRAFT.Editor.TriggerAudience': 'Audience for automatic starts',
  'STAGECRAFT.Editor.TriggerAudienceMode': 'Audience',
  'STAGECRAFT.Editor.TriggerRules': 'Start rules',
  'STAGECRAFT.Editor.TriggerEnabled': 'Enable automatic starts',
  'STAGECRAFT.Editor.TriggerRuleEnabled': 'Enabled',
  'STAGECRAFT.Editor.TriggerRule': 'Rule',
  'STAGECRAFT.Editor.TriggerEvent': 'Event',
  'STAGECRAFT.Editor.TriggerActor': 'Actor (optional)',
  'STAGECRAFT.Editor.TriggerAnyActor': 'Any actor',
  'STAGECRAFT.Editor.TriggerEventCombatStart': 'Combat starts',
  'STAGECRAFT.Editor.TriggerEventCombatEnd': 'Combat ends',
  'STAGECRAFT.Editor.TriggerEventTurnStart': 'Turn starts',
  'STAGECRAFT.Editor.TriggerEventTurnEnd': 'Turn ends',
  'STAGECRAFT.Editor.TriggerNoRules': 'No start rules yet.',
  'STAGECRAFT.Editor.TriggerDisabled': 'Automatic starts are off.',
  'STAGECRAFT.Editor.TriggerHint': 'Saved rules apply to automatic starts only.',
  'STAGECRAFT.Editor.TriggerAddRule': 'Add rule',
  'STAGECRAFT.Editor.TriggerRemoveRule': 'Remove rule',
  'STAGECRAFT.Editor.TriggerAudienceAllStatus': 'All active players are included.',
  'STAGECRAFT.Editor.TriggerAudienceSaved': 'Saved audience applies to automatic starts only.',
  'STAGECRAFT.Editor.TriggerNoPlayers': 'No players are available.',
  'STAGECRAFT.Editor.TriggerNoRecipients': 'Choose a recipient.',
  'STAGECRAFT.Editor.OfflinePlayer': 'offline',
  'STAGECRAFT.Editor.UnavailablePlayer': 'Unavailable player',
  'STAGECRAFT.Editor.UnavailableActor': 'Unavailable actor',
  'STAGECRAFT.Editor.AllPlayers': 'All players',
  'STAGECRAFT.Editor.SelectedPlayers': 'Selected players',
  'STAGECRAFT.Editor.ShowToGM': 'Show to GM',
  'STAGECRAFT.Editor.TriggerOneEnabledRule': '{count} enabled rule',
  'STAGECRAFT.Editor.TriggerEnabledRuleCount': '{count} enabled rules'
};
const localize = (key: string): string => dictionary[key] ?? key;

const users: readonly AudienceUser[] = [
  { id: 'active-player', name: 'Active Player', role: 1, active: true },
  { id: 'offline-player', name: 'Offline Player', role: 1, active: false },
  { id: 'gm', name: 'GM', role: 4, active: true }
];
const actors = [{ id: 'actor-one', name: 'Actor One' }];

function withDocument<T>(run: (document: SettingsDocument) => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = new SettingsDocument();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  try { return run(document); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

function required(root: SettingsElement, selector: string): SettingsElement {
  const found = root.querySelector(selector);
  assert.ok(found, `missing ${selector}`);
  return found;
}

function mountSettings(onChange: (value: TriggerSettingsValue) => void, ids = ['rule-new']): {
  readonly root: SettingsElement;
  readonly view: TriggerSettingsView;
} {
  const host = new SettingsElement('div');
  const rootView = new TriggerSettingsView(host as unknown as HTMLElement, {
    makeId: () => ids.shift() ?? 'rule-fallback', localize,
    listTriggerActors: () => actors, listTriggerUsers: () => users, onChange
  });
  const root = host.children[0]!;
  return { root, view: rootView };
}

test('settings render within the auto-trigger group, preserve offline IDs, and edit actor/event rules', () => withDocument(() => {
  const emitted: TriggerSettingsValue[] = [];
  const sequence = createBreaksSequence('Triggers', () => 'sequence-id');
  const savedAudience = { mode: 'selected' as const, userIds: ['offline-player', 'removed-player'], includeGM: false };
  const { root, view } = mountSettings(value => emitted.push(structuredClone(value)));
  const rendered = withSequenceAudience(sequence, savedAudience);
  view.update(rendered);

  assert.equal(root.dataset.stagecraftTriggerSettings, '');
  assert.ok(root.querySelector('fieldset.stagecraft-trigger-audience'));
  assert.ok(root.querySelector('fieldset.stagecraft-trigger-rules'));
  assert.equal(required(root, 'input[data-trigger-user-id="offline-player"]').checked, true);
  assert.equal(root.textContent.includes('Offline Player'), true);
  assert.equal(root.textContent.includes('offline'), true);
  assert.equal(required(root, 'input[data-trigger-user-id="removed-player"]').checked, true);

  root.dispatch('click', required(root, 'button[data-trigger-action="add-rule"]'));
  let rule = required(root, 'article[data-trigger-rule-id="rule-new"]');
  let event = rule.querySelector('select[data-trigger-control="rule-event"]')!;
  let actor = rule.querySelector('select[data-trigger-control="rule-actor"]')!;
  assert.equal(actor.parentElement?.hidden, false, 'turn-start rules expose optional actor filtering');
  assert.ok(event.children.some(option => option.value === 'combat-end' && option.textContent === 'Combat ends'),
    'the event selector offers the localized combat-end option');
  actor.value = 'actor-one'; root.dispatch('change', actor);
  assert.equal(emitted.at(-1)?.automation.rules[0]?.actorId, 'actor-one');

  rule = required(root, 'article[data-trigger-rule-id="rule-new"]');
  event = rule.querySelector('select[data-trigger-control="rule-event"]')!;
  event.value = 'turn-end'; root.dispatch('change', event);
  rule = required(root, 'article[data-trigger-rule-id="rule-new"]');
  actor = rule.querySelector('select[data-trigger-control="rule-actor"]')!;
  assert.equal(actor.parentElement?.hidden, false, 'turn-end rules also expose actor filtering');
  assert.equal(emitted.at(-1)?.automation.rules[0]?.actorId, 'actor-one', 'turn changes retain the selected actor');

  rule = required(root, 'article[data-trigger-rule-id="rule-new"]');
  event = rule.querySelector('select[data-trigger-control="rule-event"]')!;
  event.value = 'combat-start'; root.dispatch('change', event);
  rule = required(root, 'article[data-trigger-rule-id="rule-new"]');
  actor = rule.querySelector('select[data-trigger-control="rule-actor"]')!;
  assert.equal(actor.parentElement?.hidden, true, 'combat-start has no actor field');
  assert.equal(emitted.at(-1)?.automation.rules[0]?.actorId, null);

  rule = required(root, 'article[data-trigger-rule-id="rule-new"]');
  event = rule.querySelector('select[data-trigger-control="rule-event"]')!;
  event.value = 'turn-start'; root.dispatch('change', event);
  rule = required(root, 'article[data-trigger-rule-id="rule-new"]');
  actor = rule.querySelector('select[data-trigger-control="rule-actor"]')!;
  actor.value = 'actor-one'; root.dispatch('change', actor);
  rule = required(root, 'article[data-trigger-rule-id="rule-new"]');
  event = rule.querySelector('select[data-trigger-control="rule-event"]')!;
  event.value = 'combat-end'; root.dispatch('change', event);
  rule = required(root, 'article[data-trigger-rule-id="rule-new"]');
  actor = rule.querySelector('select[data-trigger-control="rule-actor"]')!;
  assert.equal(actor.parentElement?.hidden, true, 'combat-end has no actor field');
  assert.equal(emitted.at(-1)?.automation.rules[0]?.actorId, null, 'combat-end clears an existing actor filter');

  const enabled = required(root, 'input[data-trigger-control="automation-enabled"]');
  enabled.checked = true; root.dispatch('change', enabled);
  assert.equal(emitted.at(-1)?.automation.enabled, true);
  assert.deepEqual(emitted.at(-1)?.audience, savedAudience, 'rule edits leave a saved/offline audience untouched');

  root.dispatch('click', required(root, 'button[data-trigger-action="remove-rule"]'));
  assert.deepEqual(emitted.at(-1)?.automation.rules, []);
  assert.equal(getSequenceAutomation(sequence).enabled, false, 'editing emits data but never starts playback or mutates its source');
  view.dispose();
}));

test('one settings action becomes one draft undo step and writes only through explicit save', () => withDocument(() => {
  let saves = 0;
  let id = 0;
  const repository = {
    async list() { return []; },
    async read() { throw new Error('not used'); },
    async save(sequence: SequenceV1) { saves += 1; return sequence; },
    async delete() {}
  };
  const draft = new DraftService(repository, () => `draft-id-${++id}`);
  const original = draft.create('Undo trigger edit');
  const { root, view } = mountSettings(value => {
    const source = draft.draft!;
    draft.replace(withSequenceAutomation(withSequenceAudience(source, value.audience), value.automation));
  });
  view.update(original);
  root.dispatch('click', required(root, 'button[data-trigger-action="add-rule"]'));

  assert.equal(draft.canUndo, true);
  assert.equal(draft.dirty, true);
  assert.equal(saves, 0, 'authoring controls change only the draft');
  assert.equal(draft.draft?.schemaVersion, 4);
  assert.equal(getSequenceAutomation(draft.draft!).rules.length, 1);
  draft.undo();
  assert.deepEqual(draft.draft, original, 'one action restores the exact pre-edit draft');
  assert.equal(saves, 0);
  view.dispose();
}));

test('a future automatic audience may select offline accounts without silently changing its recipients', () => withDocument(() => {
  const emitted: TriggerSettingsValue[] = [];
  const sequence = createBreaksSequence('Future audience', () => 'sequence-id');
  const { root, view } = mountSettings(value => emitted.push(value));
  view.update(withSequenceAudience(sequence, { mode: 'selected', userIds: [], includeGM: false }));
  const offline = required(root, 'input[data-trigger-user-id="offline-player"]');
  assert.equal(offline.checked, false);
  assert.equal(offline.disabled, false);
  offline.checked = true;
  root.dispatch('change', offline);
  assert.deepEqual(emitted.at(-1)?.audience.userIds, ['offline-player']);
  assert.equal(required(root, 'input[data-trigger-user-id="offline-player"]').checked, true);
  assert.equal(root.textContent.includes('offline'), true);
  view.dispose();
}));
