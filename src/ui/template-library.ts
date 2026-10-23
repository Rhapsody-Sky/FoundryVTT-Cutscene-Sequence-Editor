import type { SequenceClip, SequenceV1 } from '../domain/sequence.js';
import type { TemplateSummary } from '../application/template-ports.js';
import { TemplateService } from '../application/template-service.js';

export type TemplateLibraryTranslate = (key: string) => string;

export interface TemplateLibrarySelection {
  readonly sequence: SequenceV1;
  readonly clip: SequenceClip;
}

export interface TemplateLibraryPlacement {
  readonly sequence: SequenceV1;
  readonly trackId: string;
  readonly playheadMs: number;
}

export interface TemplateLibraryOptions {
  readonly service: TemplateService;
  readonly translate: TemplateLibraryTranslate;
  readonly selectedClip: () => TemplateLibrarySelection | undefined;
  readonly placement: (elementType?: SequenceClip['type']) => TemplateLibraryPlacement | undefined;
  /** Must route through the editor's one-command insertion path; receives a captured guard snapshot. */
  readonly insertElement: (clip: SequenceClip, expectedPlacement: TemplateLibraryPlacement) => void | Promise<void>;
  /** Must route through the editor's one-command replacement path; receives a captured guard snapshot. */
  readonly replaceSelectedClip: (clip: SequenceClip, expectedSelection: TemplateLibrarySelection) => void | Promise<void>;
  readonly confirmDelete?: (template: TemplateSummary) => Promise<boolean>;
  readonly onError?: (message: string, error: unknown) => void;
}

/** A compact saved-template list with optional save controls in the Inspector. */
export class TemplateLibraryView {
  private root: HTMLElement | null = null;
  private controlsRoot: HTMLElement | null = null;
  private busy = false;
  private generation = 0;
  private templates: readonly TemplateSummary[] = [];
  private nameValue = '';
  private sourcePhase: 'entrance' | 'exit' = 'entrance';
  private statusMessage = '';

  constructor(private readonly options: TemplateLibraryOptions) {}

  /** Put the list in a compact library slot and, optionally, save controls elsewhere in the Inspector. */
  mount(container: HTMLElement, saveControlsContainer?: HTMLElement): void {
    this.detach();
    const generation = this.generation;
    this.root = document.createElement('section');
    this.root.className = 'stagecraft-template-library';
    this.root.setAttribute('aria-label', this.t('TemplateLibraryTitle'));
    this.root.addEventListener('click', this.onClick);
    if (saveControlsContainer) {
      this.controlsRoot = document.createElement('div');
      this.controlsRoot.className = 'stagecraft-template-save-controls';
      this.controlsRoot.addEventListener('click', this.onClick);
      this.controlsRoot.addEventListener('input', this.onInput);
      this.controlsRoot.addEventListener('change', this.onChange);
      saveControlsContainer.append(this.controlsRoot);
    } else {
      this.controlsRoot = this.root;
      this.root.addEventListener('input', this.onInput);
      this.root.addEventListener('change', this.onChange);
    }
    this.render();
    container.append(this.root);
    void this.refresh(generation);
  }

  detach(): void {
    this.generation += 1;
    this.root?.removeEventListener('click', this.onClick);
    this.root?.removeEventListener('input', this.onInput);
    this.root?.removeEventListener('change', this.onChange);
    if (this.controlsRoot && this.controlsRoot !== this.root) {
      this.controlsRoot.removeEventListener('click', this.onClick);
      this.controlsRoot.removeEventListener('input', this.onInput);
      this.controlsRoot.removeEventListener('change', this.onChange);
      this.controlsRoot.remove();
    }
    this.root?.remove();
    this.root = null;
    this.controlsRoot = null;
    this.busy = false;
  }

  async refresh(expectedGeneration = this.generation): Promise<void> {
    if (this.busy || !this.isCurrent(expectedGeneration)) return;
    this.busy = true;
    this.render();
    try {
      await this.loadTemplates(expectedGeneration);
    } catch (error) {
      if (this.isCurrent(expectedGeneration)) this.report(error);
    } finally {
      if (this.isCurrent(expectedGeneration)) {
        this.busy = false;
        this.render();
      }
    }
  }

  private readonly onInput = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.matches('[data-template-name]')) this.nameValue = target.value;
  };

  private readonly onChange = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.matches('[data-template-source-phase]')) {
      this.sourcePhase = target.value === 'exit' ? 'exit' : 'entrance';
    }
  };

  private readonly onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[data-template-action]');
    if (!button || button.disabled || this.busy || !this.root?.contains(button) && !this.controlsRoot?.contains(button)) return;
    event.preventDefault();
    void this.runAction(button, this.generation);
  };

  private async runAction(button: HTMLButtonElement, generation: number): Promise<void> {
    if (this.busy || !this.isCurrent(generation)) return;
    this.busy = true;
    this.nameValue = this.controlsRoot?.querySelector<HTMLInputElement>('[data-template-name]')?.value ?? this.nameValue;
    const phase = this.controlsRoot?.querySelector<HTMLSelectElement>('[data-template-source-phase]')?.value;
    if (phase === 'entrance' || phase === 'exit') this.sourcePhase = phase;
    this.render();
    try {
      await this.handleAction(button, generation);
    } catch (error) {
      if (this.isCurrent(generation)) this.report(error);
    } finally {
      if (this.isCurrent(generation)) {
        this.busy = false;
        this.render();
      }
    }
  }

  private async handleAction(button: HTMLButtonElement, generation: number): Promise<void> {
    const action = button.dataset.templateAction;
    const id = button.dataset.templateId;
    if (action === 'refresh') {
      await this.loadTemplates(generation);
      return;
    }
    if (action === 'save-element' || action === 'save-animation') {
      const selection = this.options.selectedClip();
      const name = this.nameValue.trim();
      if (!selection || !name) {
        this.setStatus(this.t(!name ? 'TemplateNameRequired' : 'TemplateSelectElement'));
        return;
      }
      if (action === 'save-element') {
        await this.options.service.saveElement(name, selection.clip, selection.sequence.composition);
      } else {
        const transition = this.sourcePhase === 'exit' ? selection.clip.exit : selection.clip.entrance;
        await this.options.service.saveAnimation(name, transition, selection.sequence.composition, selection.clip.type);
      }
      if (!this.isCurrent(generation)) return;
      this.setStatus(this.t('TemplateSaved'));
      await this.loadTemplates(generation);
      return;
    }
    if (!id) return;
    const summary = this.templates.find(item => item.id === id);
    if (!summary || summary.issue) return;
    if (action === 'apply-element') {
      const elementType = isClipType(summary.elementType) ? summary.elementType : undefined;
      const currentPlacement = this.options.placement(elementType);
      if (!currentPlacement) {
        this.setStatus(this.t('TemplateSelectPlacement'));
        return;
      }
      const expectedPlacement = capturePlacement(currentPlacement);
      const template = await this.options.service.read(id);
      if (!this.isCurrent(generation) || !samePlacement(expectedPlacement, this.options.placement(elementType))) return;
      const clip = await this.options.service.instantiateElement(
        template, expectedPlacement.sequence, expectedPlacement.trackId, expectedPlacement.playheadMs,
      );
      if (!this.isCurrent(generation) || !samePlacement(expectedPlacement, this.options.placement(elementType))) return;
      await this.options.insertElement(clip, expectedPlacement);
      if (this.isCurrent(generation)) this.setStatus(this.t('TemplateApplied'));
      return;
    }
    if (action === 'apply-entrance' || action === 'apply-exit') {
      const currentSelection = this.options.selectedClip();
      if (!currentSelection) {
        this.setStatus(this.t('TemplateSelectElement'));
        return;
      }
      const expectedSelection = captureSelection(currentSelection);
      const template = await this.options.service.read(id);
      if (!this.isCurrent(generation) || !sameSelection(expectedSelection, this.options.selectedClip())) return;
      const phase = action === 'apply-exit' ? 'exit' : 'entrance';
      const replacement = this.options.service.applyAnimation(template, expectedSelection.clip, phase, expectedSelection.sequence);
      await this.options.replaceSelectedClip(replacement, expectedSelection);
      if (this.isCurrent(generation)) this.setStatus(this.t('TemplateApplied'));
      return;
    }
    if (action === 'delete' && this.options.confirmDelete) {
      // Keep the exact revision displayed at click time; repository CAS rejects stale deletes.
      const expectedRevision = summary.revision;
      if (!await this.options.confirmDelete(summary) || !this.isCurrent(generation)) return;
      await this.options.service.delete(id, expectedRevision);
      if (!this.isCurrent(generation)) return;
      this.setStatus(this.t('TemplateDeleted'));
      await this.loadTemplates(generation);
    }
  }

  private async loadTemplates(generation: number): Promise<void> {
    const templates = await this.options.service.list();
    if (!this.isCurrent(generation)) return;
    this.templates = templates;
    this.render();
  }

  private render(): void {
    if (!this.root || !this.controlsRoot) return;
    const controls = document.createElement('div');
    controls.className = 'stagecraft-template-save-controls__form';
    const nameLabel = this.element('label', this.t('TemplateName'));
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 200;
    name.dataset.templateName = '';
    name.value = this.nameValue;
    name.disabled = this.busy;
    nameLabel.append(name);
    const phaseLabel = this.element('label', this.t('TemplateAnimationSourcePhase'));
    const phase = document.createElement('select');
    phase.dataset.templateSourcePhase = '';
    phase.disabled = this.busy;
    for (const [value, label] of [['entrance', 'TemplateEntrance'], ['exit', 'TemplateExit']] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = this.t(label);
      option.selected = value === this.sourcePhase;
      phase.append(option);
    }
    phaseLabel.append(phase);
    controls.append(nameLabel, phaseLabel,
      this.button('save-element', this.t('TemplateSaveElement'), this.busy),
      this.button('save-animation', this.t('TemplateSaveAnimation'), this.busy));

    const status = this.element('p', this.statusMessage);
    status.className = 'stagecraft-template-library__status';
    status.setAttribute('aria-live', 'polite');
    const list = document.createElement('ul');
    list.className = 'stagecraft-template-library__list';
    if (!this.busy && this.templates.length === 0) list.append(this.element('li', this.t('TemplateLibraryEmpty')));
    for (const template of this.templates) list.append(this.renderItem(template));
    const refresh = this.button('refresh', this.t('TemplateRefresh'), this.busy);
    const libraryControls = document.createElement('div');
    libraryControls.className = 'stagecraft-template-library__controls';
    libraryControls.append(refresh);

    if (this.controlsRoot === this.root) {
      this.root.replaceChildren(controls, status, libraryControls, list);
    } else {
      this.controlsRoot.replaceChildren(controls);
      this.root.replaceChildren(status, libraryControls, list);
    }
  }

  private renderItem(summary: TemplateSummary): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'stagecraft-template-library__item';
    row.dataset.templateId = summary.id;
    const name = this.element('span', summary.name);
    name.className = 'stagecraft-template-library__name';
    const kindKey = summary.kind === 'animation' ? 'TemplateKindAnimation' : 'TemplateKindElement';
    const kind = this.element('span', `${this.t(kindKey)}${summary.elementType ? ` · ${summary.elementType}` : ''}`);
    kind.className = 'stagecraft-template-library__kind';
    row.append(name, kind);
    if (summary.issue) {
      const issue = this.element('span', this.t('TemplateItemUnavailable'));
      issue.title = this.t('TemplateItemUnavailable');
      issue.className = 'stagecraft-template-library__issue';
      row.append(issue);
      return row;
    }
    if (summary.kind === 'element') {
      row.append(this.button('apply-element', this.t('TemplateApply'), this.busy, summary.id));
    } else {
      row.append(this.button('apply-entrance', this.t('TemplateApplyEntrance'), this.busy, summary.id));
      const untilSequenceEnd = this.options.selectedClip()?.clip.duration.kind === 'sequence-end';
      row.append(this.button('apply-exit', this.t('TemplateApplyExit'), this.busy || untilSequenceEnd, summary.id));
    }
    if (this.options.confirmDelete) row.append(this.button('delete', this.t('TemplateDelete'), this.busy, summary.id));
    return row;
  }

  private button(action: string, label: string, disabled: boolean, id?: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.templateAction = action;
    if (id) button.dataset.templateId = id;
    button.textContent = label;
    button.disabled = disabled;
    return button;
  }

  private element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }

  private setStatus(message: string): void {
    this.statusMessage = message;
    const status = this.root?.querySelector<HTMLElement>('.stagecraft-template-library__status');
    if (status) status.textContent = message;
  }

  private report(error: unknown): void {
    const message = this.t('TemplateOperationFailed');
    this.setStatus(message);
    this.options.onError?.(message, error);
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation && this.root !== null && this.root.isConnected;
  }

  private t(key: string): string {
    return this.options.translate(key);
  }
}

function capturePlacement(value: TemplateLibraryPlacement): TemplateLibraryPlacement {
  return { sequence: structuredClone(value.sequence), trackId: value.trackId, playheadMs: value.playheadMs };
}

function captureSelection(value: TemplateLibrarySelection): TemplateLibrarySelection {
  return { sequence: structuredClone(value.sequence), clip: structuredClone(value.clip) };
}

function samePlacement(expected: TemplateLibraryPlacement, current: TemplateLibraryPlacement | undefined): boolean {
  return current !== undefined && expected.sequence.id === current.sequence.id
    && expected.sequence.revision === current.sequence.revision
    && expected.trackId === current.trackId && expected.playheadMs === current.playheadMs
    && jsonEqual(expected.sequence, current.sequence);
}

function sameSelection(expected: TemplateLibrarySelection, current: TemplateLibrarySelection | undefined): boolean {
  return current !== undefined && expected.sequence.id === current.sequence.id
    && expected.sequence.revision === current.sequence.revision && expected.clip.id === current.clip.id
    && jsonEqual(expected.sequence, current.sequence) && jsonEqual(expected.clip, current.clip);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isClipType(value: unknown): value is SequenceClip['type'] {
  return value === 'bars' || value === 'video' || value === 'audio' || value === 'text' || value === 'image' || value === 'solid' || value === 'button';
}
