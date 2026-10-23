import test from 'node:test';
import assert from 'node:assert/strict';
import { AudiencePicker } from '../src/ui/audience-picker.js';
import type { AudienceUser } from '../src/application/audience-resolver.js';

class PickerElement extends EventTarget {
  readonly children: PickerElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  parentElement: PickerElement | null = null;
  className = '';
  tagName: string;
  type = '';
  name = '';
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  private text = '';

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    return this.text + this.children.map(child => child.textContent).join('');
  }

  set textContent(value: string | null) {
    this.text = value ?? '';
    this.children.length = 0;
  }

  append(...nodes: PickerElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }

  override dispatchEvent(event: Event): boolean {
    const result = super.dispatchEvent(event);
    if (event.bubbles && this.parentElement) {
      this.parentElement.dispatchEvent(new Event(event.type, { bubbles: true }));
    }
    return result;
  }

  querySelectorAll<T extends PickerElement = PickerElement>(selector: string): T[] {
    const result: T[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child as T);
      result.push(...child.querySelectorAll<T>(selector));
    }
    return result;
  }

  querySelector<T extends PickerElement = PickerElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
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

class PickerDocument {
  createElement(tagName: string): PickerElement { return new PickerElement(tagName); }
}

const translations: Record<string, string> = {
  'STAGECRAFT.Audience.Title': 'Audience',
  'STAGECRAFT.Audience.All': 'All players',
  'STAGECRAFT.Audience.Selected': 'Selected players',
  'STAGECRAFT.Audience.ShowGM': 'Also show to GM',
  'STAGECRAFT.Audience.Offline': 'offline',
  'STAGECRAFT.Audience.NoPlayers': 'No player accounts are available.',
  'STAGECRAFT.Audience.NoRecipients': 'Choose at least one available player or the GM.',
  'STAGECRAFT.Audience.SelectionLimit': 'You can select up to 100 players.'
};
const localize = (key: string): string => translations[key] ?? key;

function withPickerDocument<T>(run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new PickerDocument() });
  try { return run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

function input(root: PickerElement, selector: string): PickerElement {
  const result = root.querySelector(selector);
  assert.ok(result, `missing ${selector}`);
  return result;
}

function change(element: PickerElement): void { element.dispatchEvent(new Event('change', { bubbles: true })); }

const users: readonly AudienceUser[] = [
  { id: 'player-a', name: 'Ari', role: 1, active: true },
  { id: 'player-b', name: 'Bea', role: 2, active: true },
  { id: 'player-offline', name: 'Offline Player', role: 1, active: false },
  { id: 'another-gm', name: 'Second GM', role: 4, active: true }
];

test('starts each manual invocation at all players with GM included and does not share selection', () => withPickerDocument(() => {
  const picker = new AudiencePicker(users, localize);
  const root = picker.element as unknown as PickerElement;
  assert.deepEqual(picker.read(), { mode: 'all', userIds: [], includeGM: true });
  assert.equal(picker.valid, true);
  assert.equal(input(root, 'input[data-audience-mode="all"]').checked, true);
  assert.equal(input(root, 'input[data-audience-show-gm]').checked, true);
  const usersGroup = root.querySelector('.stagecraft-audience-picker__users');
  assert.equal(usersGroup?.hidden, true);
  const playerRows = root.querySelectorAll('input[data-audience-user]');
  assert.equal(playerRows.every(player => player.disabled), true);

  const names = root.querySelectorAll('.stagecraft-audience-picker__name').map(node => node.textContent);
  assert.deepEqual(names, ['Ari', 'Bea', 'Offline Player']);
  assert.equal(root.querySelectorAll('input[data-audience-user]').length, 3);
  assert.equal(root.querySelector('legend')?.textContent, 'Audience');

  const selected = input(root, 'input[data-audience-mode="selected"]');
  input(root, 'input[data-audience-mode="all"]').checked = false;
  selected.checked = true;
  change(selected);
  assert.equal(usersGroup?.hidden, false);
  assert.equal(input(root, 'input[data-audience-user="player-a"]').disabled, false);
  const player = input(root, 'input[data-audience-user="player-a"]');
  player.checked = true;
  change(player);
  assert.deepEqual(picker.read(), { mode: 'selected', userIds: ['player-a'], includeGM: false });

  selected.checked = false;
  const all = input(root, 'input[data-audience-mode="all"]');
  all.checked = true;
  change(all);
  assert.equal(usersGroup?.hidden, true);
  assert.equal(player.disabled, true);
  assert.equal(player.checked, true, 'the retained check is hidden and cannot affect all-player mode');
  assert.deepEqual(picker.read(), { mode: 'all', userIds: [], includeGM: false });

  const nextInvocation = new AudiencePicker(users, localize);
  assert.deepEqual(nextInvocation.read(), { mode: 'all', userIds: [], includeGM: true });
}));

test('offline rows stay visible and disabled; validation updates when no recipient remains', () => withPickerDocument(() => {
  const picker = new AudiencePicker(users, localize);
  const root = picker.element as unknown as PickerElement;
  const received: string[] = [];
  root.addEventListener('change', event => received.push(event.type));

  const offline = input(root, 'input[data-audience-user="player-offline"]');
  assert.equal(offline.disabled, true);
  assert.equal(root.textContent.includes('offline'), true);

  const all = input(root, 'input[data-audience-mode="all"]');
  const selected = input(root, 'input[data-audience-mode="selected"]');
  all.checked = false;
  selected.checked = true;
  change(selected);
  const gm = input(root, 'input[data-audience-show-gm]');
  gm.checked = false;
  change(gm);
  assert.equal(picker.valid, false);
  assert.equal(picker.read(), null);
  const status = root.querySelector('.stagecraft-audience-picker__status');
  assert.equal(status?.hidden, false);
  assert.equal(status?.textContent, translations['STAGECRAFT.Audience.NoRecipients']);
  assert.deepEqual(received, ['change', 'change']);

  const active = input(root, 'input[data-audience-user="player-b"]');
  active.checked = true;
  change(active);
  assert.deepEqual(picker.read(), { mode: 'selected', userIds: ['player-b'], includeGM: false });
  assert.equal(picker.valid, true);
  assert.equal(status?.hidden, true);
}));

test('handles empty and unavailable rosters without displaying GMs as player rows', () => withPickerDocument(() => {
  const picker = new AudiencePicker([
    { id: 'gm', name: 'GM account', role: 4, active: true }
  ], localize);
  const root = picker.element as unknown as PickerElement;
  assert.equal(root.querySelectorAll('input[data-audience-user]').length, 0);
  assert.equal(root.querySelector('.stagecraft-audience-picker__users')?.hidden, true);
  assert.equal(root.querySelector('.stagecraft-audience-picker__empty')?.hidden, false);
  assert.deepEqual(picker.read(), { mode: 'all', userIds: [], includeGM: true });

  const selected = input(root, 'input[data-audience-mode="selected"]');
  input(root, 'input[data-audience-mode="all"]').checked = false;
  selected.checked = true;
  change(selected);
  assert.equal(root.querySelector('.stagecraft-audience-picker__users')?.hidden, false);
  assert.equal(root.querySelector('.stagecraft-audience-picker__empty')?.hidden, false);
  const gm = input(root, 'input[data-audience-show-gm]');
  gm.checked = false;
  change(gm);
  assert.equal(picker.read(), null);
}));

test('keeps audience IDs valid and caps selected players at the domain limit', () => withPickerDocument(() => {
  const many: AudienceUser[] = Array.from({ length: 101 }, (_, index) => ({
    id: `player-${index}`,
    name: `Player ${index}`,
    role: 1,
    active: true
  }));
  many.push({ id: 'bad id', name: '<img src=x>', role: 1, active: true });
  const picker = new AudiencePicker(many, localize);
  const root = picker.element as unknown as PickerElement;
  const safeName = root.querySelector('.stagecraft-audience-picker__name');
  assert.equal(safeName?.textContent, 'Player 0');
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelectorAll('input[data-audience-user]').length, 101);

  const selected = input(root, 'input[data-audience-mode="selected"]');
  input(root, 'input[data-audience-mode="all"]').checked = false;
  selected.checked = true;
  change(selected);
  const players = root.querySelectorAll('input[data-audience-user]');
  for (const player of players.slice(0, 100)) {
    player.checked = true;
    change(player);
  }
  assert.equal(players[100]?.disabled, true);
  const audience = picker.read();
  assert.equal(audience?.mode, 'selected');
  assert.equal(audience?.userIds.length, 100);
  assert.equal(audience?.userIds.includes('bad id'), false);
  assert.equal(root.querySelector('.stagecraft-audience-picker__status')?.textContent,
    translations['STAGECRAFT.Audience.SelectionLimit']);
}));
