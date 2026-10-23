import type { AudienceUser } from '../application/audience-resolver.js';
import type { SequenceAudience } from '../domain/sequence.js';
import { SEQUENCE_LIMITS } from '../domain/validation.js';

export type AudiencePickerTranslate = (key: string) => string;

let nextRadioGroup = 0;

/** A per-invocation audience choice for the manual prepare dialog. */
export class AudiencePicker {
  readonly element: HTMLElement;

  private readonly playerInputs: HTMLInputElement[] = [];
  private readonly activePlayerIds = new Set<string>();
  private readonly includeGMInput: HTMLInputElement;
  private readonly allInput: HTMLInputElement;
  private readonly selectedInput: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly usersGroup: HTMLElement;
  private readonly translate: AudiencePickerTranslate;
  private mode: 'all' | 'selected' = 'all';

  constructor(users: readonly AudienceUser[], localize: AudiencePickerTranslate) {
    this.translate = localize;
    const root = document.createElement('fieldset');
    root.className = 'stagecraft-audience-picker';

    const legend = document.createElement('legend');
    legend.textContent = this.t('Title');
    root.append(legend);

    const modeGroup = document.createElement('div');
    modeGroup.className = 'stagecraft-audience-picker__modes';
    const radioName = `stagecraft-audience-mode-${++nextRadioGroup}`;
    this.allInput = this.makeModeInput('all', radioName, true);
    this.selectedInput = this.makeModeInput('selected', radioName, false);
    modeGroup.append(this.makeModeLabel(this.allInput, this.t('All')),
      this.makeModeLabel(this.selectedInput, this.t('Selected')));
    root.append(modeGroup);

    this.includeGMInput = document.createElement('input');
    this.includeGMInput.type = 'checkbox';
    this.includeGMInput.checked = true;
    this.includeGMInput.dataset.audienceShowGm = '';
    const gmLabel = document.createElement('label');
    gmLabel.className = 'stagecraft-audience-picker__gm';
    const gmText = document.createElement('span');
    gmText.textContent = this.t('ShowGM');
    gmLabel.append(this.includeGMInput, gmText);
    root.append(gmLabel);

    this.usersGroup = document.createElement('div');
    this.usersGroup.className = 'stagecraft-audience-picker__users';
    this.usersGroup.setAttribute('role', 'group');
    this.usersGroup.setAttribute('aria-label', this.t('Selected'));
    this.usersGroup.hidden = true;

    const seen = new Set<string>();
    const players = users.filter(user => {
      if (user.role >= 3 || !this.isDomainId(user.id) || seen.has(user.id)) return false;
      seen.add(user.id);
      return true;
    });
    for (const user of players) {
      const row = document.createElement('label');
      row.className = 'stagecraft-audience-picker__user';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.audienceUser = user.id;
      input.disabled = true;
      if (user.active) this.activePlayerIds.add(user.id);
      else input.dataset.audienceOffline = 'true';
      const name = document.createElement('span');
      name.className = 'stagecraft-audience-picker__name';
      name.textContent = user.name;
      row.append(input, name);
      if (!user.active) {
        const offline = document.createElement('span');
        offline.className = 'stagecraft-audience-picker__offline';
        offline.textContent = this.t('Offline');
        row.append(offline);
      }
      this.usersGroup.append(row);
      this.playerInputs.push(input);
    }

    const empty = document.createElement('p');
    empty.className = 'stagecraft-audience-picker__empty';
    empty.textContent = this.t('NoPlayers');
    empty.hidden = players.length > 0;
    this.usersGroup.append(empty);
    root.append(this.usersGroup);

    this.status = document.createElement('p');
    this.status.className = 'stagecraft-audience-picker__status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    root.append(this.status);
    this.element = root;
    this.element.addEventListener('change', this.onChange);
    this.update();
  }

  get valid(): boolean {
    return this.read() !== null;
  }

  /** Returns only this dialog's current choice; nothing is written to a sequence. */
  read(): SequenceAudience | null {
    const includeGM = this.includeGMInput.checked;
    if (this.allInput.checked) {
      return this.activePlayerIds.size > 0 || includeGM ? { mode: 'all', userIds: [], includeGM } : null;
    }

    const userIds = this.playerInputs.filter(input => input.checked && input.dataset.audienceOffline !== 'true')
      .slice(0, SEQUENCE_LIMITS.audienceUsers).map(input => input.dataset.audienceUser!);
    if (userIds.length === 0 && !includeGM) return null;
    return { mode: 'selected', userIds, includeGM };
  }

  private readonly onChange = (): void => {
    const nextMode = this.selectedInput.checked ? 'selected' : 'all';
    if (nextMode !== this.mode) {
      if (this.mode === 'all' && nextMode === 'selected') this.includeGMInput.checked = false;
      this.mode = nextMode;
    }
    this.update();
  };

  private update(): void {
    const selectingPlayers = this.selectedInput.checked;
    this.usersGroup.hidden = !selectingPlayers;
    const selectedCount = this.playerInputs.filter(input => input.checked && input.dataset.audienceOffline !== 'true').length;
    const limitReached = selectingPlayers && selectedCount >= SEQUENCE_LIMITS.audienceUsers;
    for (const input of this.playerInputs) {
      input.disabled = !selectingPlayers || input.dataset.audienceOffline === 'true' || (limitReached && !input.checked);
    }
    const invalid = !this.valid;
    this.status.textContent = invalid ? this.t('NoRecipients') : limitReached ? this.t('SelectionLimit') : '';
    this.status.hidden = !invalid && !limitReached;
  }

  private makeModeInput(mode: 'all' | 'selected', name: string, checked: boolean): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = mode;
    input.checked = checked;
    input.dataset.audienceMode = mode;
    return input;
  }

  private makeModeLabel(input: HTMLInputElement, text: string): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'stagecraft-audience-picker__mode';
    const caption = document.createElement('span');
    caption.textContent = text;
    label.append(input, caption);
    return label;
  }

  private isDomainId(id: string): boolean {
    return id.length > 0 && id.length <= SEQUENCE_LIMITS.idLength && /^[A-Za-z0-9_-]+$/.test(id);
  }

  private t(key: string): string {
    return this.translate(`STAGECRAFT.Audience.${key}`);
  }
}
