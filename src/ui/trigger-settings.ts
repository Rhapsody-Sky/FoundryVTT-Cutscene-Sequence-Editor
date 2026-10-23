import type { AudienceUser } from '../application/audience-resolver.js';
import type { SequenceAudience, SequenceAutomation, SequenceAutomationRule, SequenceTriggerKind, SequenceV1 } from '../domain/sequence.js';
import { getSequenceAudience, getSequenceAutomation } from '../domain/sequence-audience.js';
import { SEQUENCE_LIMITS } from '../domain/validation.js';

export interface TriggerActorOption {
  readonly id: string;
  readonly name: string;
}

export interface TriggerSettingsValue {
  readonly audience: SequenceAudience;
  readonly automation: SequenceAutomation;
}

export interface TriggerSettingsOptions {
  readonly makeId: () => string;
  readonly localize: (key: string) => string;
  readonly listTriggerActors: () => readonly TriggerActorOption[];
  readonly listTriggerUsers: () => readonly AudienceUser[];
  readonly onChange: (value: TriggerSettingsValue) => void;
}

const triggerKinds: readonly SequenceTriggerKind[] = ['combat-start', 'combat-end', 'turn-start', 'turn-end'];
const triggerEventLabelKeys: Readonly<Record<SequenceTriggerKind, string>> = {
  'combat-start': 'TriggerEventCombatStart',
  'combat-end': 'TriggerEventCombatEnd',
  'turn-start': 'TriggerEventTurnStart',
  'turn-end': 'TriggerEventTurnEnd'
};

/** Author-only controls for saved automatic starts and their separate future-start audience. */
export class TriggerSettingsView {
  private readonly root: HTMLElement;
  private value: TriggerSettingsValue | null = null;
  private renderKey = '';

  constructor(mount: HTMLElement, private readonly options: TriggerSettingsOptions) {
    this.root = document.createElement('div');
    this.root.className = 'stagecraft-trigger-settings';
    this.root.dataset.stagecraftTriggerSettings = '';
    this.root.addEventListener('change', this.onChange);
    this.root.addEventListener('click', this.onClick);
    mount.replaceChildren(this.root);
  }

  update(sequence: SequenceV1): void {
    const next: TriggerSettingsValue = {
      audience: getSequenceAudience(sequence),
      automation: getSequenceAutomation(sequence)
    };
    const actors = this.options.listTriggerActors();
    const users = this.options.listTriggerUsers();
    const key = JSON.stringify({ next, actors, users });
    if (key === this.renderKey) return;
    this.renderKey = key;
    this.value = structuredClone(next);
    this.render(next, actors, users);
  }

  dispose(): void {
    this.root.removeEventListener('change', this.onChange);
    this.root.removeEventListener('click', this.onClick);
    this.root.replaceChildren();
  }

  private t(key: string): string {
    return this.options.localize(`STAGECRAFT.Editor.${key}`);
  }

  private render(value: TriggerSettingsValue, actors: readonly TriggerActorOption[], users: readonly AudienceUser[]): void {
    this.root.replaceChildren();
    this.root.dataset.stagecraftAudienceGroup = '';
    this.root.append(this.renderAudience(value.audience, users), this.renderAutomation(value.automation, actors));
  }

  private renderAudience(audience: SequenceAudience, users: readonly AudienceUser[]): HTMLElement {
    const section = document.createElement('fieldset');
    section.className = 'stagecraft-sequence-setting-group stagecraft-trigger-audience';
    const legend = document.createElement('legend');
    legend.textContent = this.t('TriggerAudience');
    section.append(legend);

    section.append(this.selectField('TriggerAudienceMode', 'audience-mode', audience.mode, [
      ['all', this.t('AllPlayers')], ['selected', this.t('SelectedPlayers')]
    ]));
    section.append(this.checkboxField('ShowToGM', 'audience-show-gm', audience.includeGM));

    const list = document.createElement('div');
    list.className = 'stagecraft-trigger-user-list';
    list.dataset.stagecraftTriggerUsers = '';
    list.hidden = audience.mode !== 'selected';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', this.t('TriggerAudience'));

    const validUsers: AudienceUser[] = [];
    const known = new Set<string>();
    for (const user of users) {
      if (user.role >= 3 || !this.isId(user.id) || known.has(user.id)) continue;
      known.add(user.id);
      validUsers.push(user);
    }
    const selected = new Set(audience.userIds);
    const limitReached = audience.userIds.length >= SEQUENCE_LIMITS.audienceUsers;
    for (const user of validUsers) {
      const checked = selected.has(user.id);
      list.append(this.userRow(user.id, user.name, checked,
        limitReached && !checked,
        !user.active ? this.t('OfflinePlayer') : ''));
    }
    const knownIds = new Set(validUsers.map(user => user.id));
    for (const id of audience.userIds) {
      if (knownIds.has(id)) continue;
      list.append(this.userRow(id, id, true, false, this.t('UnavailablePlayer')));
    }
    if (validUsers.length === 0 && audience.userIds.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'stagecraft-trigger-empty';
      empty.textContent = this.t('TriggerNoPlayers');
      list.append(empty);
    }
    section.append(list);

    const status = document.createElement('p');
    status.className = 'stagecraft-trigger-status';
    status.dataset.stagecraftTriggerAudienceStatus = '';
    status.setAttribute('role', 'status');
    status.textContent = audience.mode === 'selected' && audience.userIds.length === 0 && !audience.includeGM
      ? this.t('TriggerNoRecipients')
      : audience.mode === 'selected' ? this.t('TriggerAudienceSaved') : this.t('TriggerAudienceAllStatus');
    section.append(status);
    return section;
  }

  private renderAutomation(automation: SequenceAutomation, actors: readonly TriggerActorOption[]): HTMLElement {
    const section = document.createElement('fieldset');
    section.className = 'stagecraft-sequence-setting-group stagecraft-trigger-rules';
    const legend = document.createElement('legend');
    legend.textContent = this.t('TriggerRules');
    section.append(legend, this.checkboxField('TriggerEnabled', 'automation-enabled', automation.enabled));

    const status = document.createElement('p');
    status.className = 'stagecraft-trigger-status';
    status.dataset.stagecraftTriggerStatus = '';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const activeRules = automation.rules.filter(rule => rule.enabled).length;
    status.textContent = automation.enabled
      ? activeRules === 0 ? this.t('TriggerNoEnabledRules') : this.t(activeRules === 1 ? 'TriggerOneEnabledRule' : 'TriggerEnabledRuleCount').replace('{count}', String(activeRules))
      : this.t('TriggerDisabled');
    const hint = document.createElement('p');
    hint.className = 'stagecraft-trigger-status';
    hint.textContent = this.t('TriggerHint');
    section.append(status, hint);

    const list = document.createElement('div');
    list.className = 'stagecraft-trigger-rule-list';
    list.dataset.stagecraftTriggerRuleList = '';
    if (automation.rules.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'stagecraft-trigger-empty';
      empty.textContent = this.t('TriggerNoRules');
      list.append(empty);
    } else {
      automation.rules.forEach((rule, index) => list.append(this.renderRule(rule, index, actors)));
    }
    section.append(list);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'stagecraft-trigger-add';
    add.dataset.triggerAction = 'add-rule';
    add.disabled = automation.rules.length >= SEQUENCE_LIMITS.automationRules;
    add.title = this.t('TriggerAddRule');
    add.setAttribute('aria-label', this.t('TriggerAddRule'));
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-plus';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = this.t('TriggerAddRule');
    add.append(icon, label);
    section.append(add);
    return section;
  }

  private renderRule(rule: SequenceAutomationRule, index: number, actors: readonly TriggerActorOption[]): HTMLElement {
    const row = document.createElement('article');
    row.className = 'stagecraft-trigger-rule';
    row.dataset.triggerRuleId = rule.id;

    const header = document.createElement('div');
    header.className = 'stagecraft-trigger-rule-header';
    const enabled = this.checkboxField('TriggerRuleEnabled', 'rule-enabled', rule.enabled);
    const enabledInput = enabled.querySelector<HTMLInputElement>('input');
    if (enabledInput) enabledInput.dataset.triggerRuleId = rule.id;
    const caption = enabled.querySelector('span');
    if (caption) caption.textContent = `${this.t('TriggerRule')} ${index + 1}`;
    header.append(enabled);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'stagecraft-trigger-remove';
    remove.dataset.triggerAction = 'remove-rule';
    remove.dataset.triggerRuleId = rule.id;
    remove.title = this.t('TriggerRemoveRule');
    remove.setAttribute('aria-label', this.t('TriggerRemoveRule'));
    const removeIcon = document.createElement('i');
    removeIcon.className = 'fa-solid fa-trash';
    removeIcon.setAttribute('aria-hidden', 'true');
    remove.append(removeIcon);
    header.append(remove);
    row.append(header);

    const eventField = this.selectField('TriggerEvent', 'rule-event', rule.event, triggerKinds.map(kind => [kind, this.t(triggerEventLabelKeys[kind])] as const));
    const eventSelect = eventField.querySelector<HTMLSelectElement>('select');
    if (eventSelect) eventSelect.dataset.triggerRuleId = rule.id;
    row.append(eventField);

    const actorField = this.selectField('TriggerActor', 'rule-actor', rule.actorId ?? '', [
      ['', this.t('TriggerAnyActor')], ...this.actorOptions(actors, rule.actorId)
    ]);
    const actorSelect = actorField.querySelector<HTMLSelectElement>('select');
    if (actorSelect) actorSelect.dataset.triggerRuleId = rule.id;
    actorField.hidden = rule.event === 'combat-start' || rule.event === 'combat-end';
    row.append(actorField);
    return row;
  }

  private actorOptions(actors: readonly TriggerActorOption[], selected: string | null): [string, string][] {
    const options: [string, string][] = [];
    const seen = new Set<string>();
    for (const actor of actors) {
      if (!this.isId(actor.id) || seen.has(actor.id)) continue;
      seen.add(actor.id);
      options.push([actor.id, actor.name]);
    }
    if (selected !== null && !seen.has(selected)) options.push([selected, `${this.t('UnavailableActor')} (${selected})`]);
    return options;
  }

  private selectField(labelKey: string, control: string, value: string, choices: readonly (readonly [string, string])[]): HTMLElement {
    const label = document.createElement('label');
    label.className = 'stagecraft-trigger-field';
    const caption = document.createElement('span');
    caption.textContent = this.t(labelKey);
    const select = document.createElement('select');
    select.dataset.triggerControl = control;
    for (const [optionValue, optionText] of choices) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionText;
      select.append(option);
    }
    select.value = value;
    label.append(caption, select);
    return label;
  }

  private checkboxField(labelKey: string, control: string, checked: boolean): HTMLElement {
    const label = document.createElement('label');
    label.className = 'stagecraft-checkbox stagecraft-wide stagecraft-trigger-checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.triggerControl = control;
    input.checked = checked;
    const caption = document.createElement('span');
    caption.textContent = this.t(labelKey);
    label.append(input, caption);
    return label;
  }

  private userRow(id: string, name: string, checked: boolean, disabled: boolean, status: string): HTMLElement {
    const label = document.createElement('label');
    label.className = 'stagecraft-trigger-user';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.triggerControl = 'audience-user';
    input.dataset.triggerUserId = id;
    input.checked = checked;
    input.disabled = disabled;
    const nameNode = document.createElement('span');
    nameNode.className = 'stagecraft-trigger-user-name';
    nameNode.textContent = name;
    label.append(input, nameNode);
    if (status) {
      const statusNode = document.createElement('span');
      statusNode.className = 'stagecraft-trigger-user-status';
      statusNode.textContent = status;
      label.append(statusNode);
    }
    return label;
  }

  private readonly onChange = (event: Event): void => {
    const target = event.target as (HTMLInputElement | HTMLSelectElement | null);
    const control = target?.dataset.triggerControl;
    if (!target || !control || !this.value) return;
    const current = this.value;
    if (control === 'audience-mode' && (target.value === 'all' || target.value === 'selected')) {
      this.publish({ ...current, audience: { ...current.audience, mode: target.value } });
    } else if (control === 'audience-show-gm' && target.type === 'checkbox') {
      this.publish({ ...current, audience: { ...current.audience, includeGM: target.checked } });
    } else if (control === 'audience-user' && target.type === 'checkbox') {
      const id = target.dataset.triggerUserId;
      if (!id) return;
      const ids = current.audience.userIds.filter(userId => userId !== id);
      if (target.checked) ids.push(id);
      this.publish({ ...current, audience: { ...current.audience, userIds: ids } });
    } else if (control === 'automation-enabled' && target.type === 'checkbox') {
      this.publish({ ...current, automation: { ...current.automation, enabled: target.checked } });
    } else if (control === 'rule-enabled' && target.type === 'checkbox') {
      this.updateRule(target.dataset.triggerRuleId, rule => ({ ...rule, enabled: target.checked }));
    } else if (control === 'rule-event' && triggerKinds.includes(target.value as SequenceTriggerKind)) {
      const eventKind = target.value as SequenceTriggerKind;
      this.updateRule(target.dataset.triggerRuleId, rule => ({ ...rule, event: eventKind,
        actorId: eventKind === 'combat-start' || eventKind === 'combat-end' ? null : rule.actorId }));
    } else if (control === 'rule-actor') {
      this.updateRule(target.dataset.triggerRuleId, rule => ({ ...rule, actorId: target.value || null }));
    }
  };

  private readonly onClick = (event: Event): void => {
    let target = event.target as HTMLElement | null;
    while (target && target !== this.root) {
      const action = target.dataset.triggerAction;
      if (action === 'add-rule') { this.addRule(); return; }
      if (action === 'remove-rule') { this.removeRule(target.dataset.triggerRuleId); return; }
      target = target.parentElement;
    }
  };

  private addRule(): void {
    if (!this.value || this.value.automation.rules.length >= SEQUENCE_LIMITS.automationRules) return;
    const used = new Set(this.value.automation.rules.map(rule => rule.id));
    let id = '';
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.options.makeId();
      if (this.isId(candidate) && candidate.length <= SEQUENCE_LIMITS.triggerRuleIdLength && !used.has(candidate)) { id = candidate; break; }
    }
    if (!id) return;
    const rule: SequenceAutomationRule = { id, enabled: true, event: 'turn-start', actorId: null };
    this.publish({ ...this.value, automation: { ...this.value.automation, rules: [...this.value.automation.rules, rule] } });
  }

  private removeRule(id: string | undefined): void {
    if (!this.value || !id) return;
    this.publish({ ...this.value, automation: { ...this.value.automation,
      rules: this.value.automation.rules.filter(rule => rule.id !== id) } });
  }

  private updateRule(id: string | undefined, update: (rule: SequenceAutomationRule) => SequenceAutomationRule): void {
    if (!this.value || !id) return;
    this.publish({ ...this.value, automation: { ...this.value.automation,
      rules: this.value.automation.rules.map(rule => rule.id === id ? update(rule) : rule) } });
  }

  private publish(value: TriggerSettingsValue): void {
    const focused = document.activeElement as (HTMLElement & { dataset: DOMStringMap }) | null;
    const focusKey = focused && this.root.contains(focused)
      ? { control: focused.dataset.triggerControl, action: focused.dataset.triggerAction,
          ruleId: focused.dataset.triggerRuleId, userId: focused.dataset.triggerUserId }
      : null;
    this.value = structuredClone(value);
    const key = JSON.stringify({ next: this.value, actors: this.options.listTriggerActors(), users: this.options.listTriggerUsers() });
    this.renderKey = key;
    this.options.onChange(structuredClone(this.value));
    this.render(this.value, this.options.listTriggerActors(), this.options.listTriggerUsers());
    if (focusKey) {
      const candidates = this.root.querySelectorAll<HTMLElement>('[data-trigger-control], [data-trigger-action]');
      const next = Array.from(candidates).find(element => element.dataset.triggerControl === focusKey.control
        && element.dataset.triggerAction === focusKey.action
        && element.dataset.triggerRuleId === focusKey.ruleId
        && element.dataset.triggerUserId === focusKey.userId);
      next?.focus();
    }
  }

  private isId(value: string): boolean {
    return value.length > 0 && value.length <= SEQUENCE_LIMITS.idLength && /^[A-Za-z0-9_-]+$/.test(value);
  }
}
