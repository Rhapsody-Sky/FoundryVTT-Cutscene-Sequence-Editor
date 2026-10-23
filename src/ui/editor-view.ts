import { InspectorAvailability } from './editor/inspector-availability.js';
import { InspectorForm, type FieldElement } from './editor/inspector-form.js';
import { InspectorFields } from './editor/inspector-fields.js';
import { readElementValues, audioValuesFromClip, sameJsonData, stableJson, type NonMediaEnd } from './editor/inspector-values.js';
import type { SequenceRepository, SequenceSummary } from '../application/ports.js';
import type { AudienceUser } from '../application/audience-resolver.js';
import { DraftService } from '../application/draft-service.js';
import { applyEditorTimelineCommand, applyTimelineCommand, enableAutomaticEnd, timelineConflicts, type TimelineCommand } from '../application/timeline-commands.js';
import { audioDurationMs, clipDurationMs, sequenceDurationMs, videoTypeVersion } from '../domain/clip-timing.js';
import { getPlaybackSchemaVersion, withSequenceAudience, withSequenceAutomation } from '../domain/sequence-audience.js';
import { upgradeSequenceToBreaks } from '../domain/breaks.js';
import { SEQUENCE_LIMITS } from '../domain/validation.js';
import { createAnimatedPattern, type AnimatedPattern } from '../domain/animated-pattern.js';
import { resetPatternPalette } from './animated-surface-inspector.js';
import { TimelineView, type TimelineContextTarget } from './timeline-view.js';
import type { TimelineContextMenuItem } from './timeline-context-menu.js';
import { TimelineClipboard, type TimelineClipboardSelection } from '../application/timeline-clipboard.js';
import { EditorLayout, type EditorLayoutSizes } from './editor-layout.js';
import { InspectorTabs } from './inspector-tabs.js';
import { ClipInspectorSections } from './clip-inspector-sections.js';
import { PatternPicker } from './pattern-picker.js';
import { TextAnimationPicker } from './text-animation-picker.js';
import { AnimationPicker } from './animation-picker.js';
import { createElementAnimationPreview, createElementAnimationPreviewRenderer, type ElementAnimationPreviewKind } from './element-animation-preview.js';
import { EFFECT_PRESETS, buttonDesign, effectPreset } from './effect-presets.js';
import { patchInspectedClip, selectedClip } from './clip-inspector.js';
import type { AudioClip, BarsClip, ButtonClip, ImageClip, SolidClip, SequenceClip, SequenceV1, TextClip, VideoClip } from '../domain/sequence.js';
import { LocalPlayer, type PlayerFrame, type PlayerState, type Runtime } from '../playback/local-player.js';
import { compileSequence, evaluate, type CompiledSequence } from '../playback/evaluate.js';
import { DomSurface } from '../rendering/dom-surface.js';
import type { RendererOptions } from '../rendering/element-renderer.js';
import { probeAudio, probeVideo } from '../rendering/media-preparation.js';
import type { SimpleElementType } from './simple-composition.js';
import { VisualHandles, type VisualHandleState, type EditableVisualClip } from './image-handles.js';
import { PreviewViewport } from './preview-viewport.js';
import { legacyVideoBox } from '../rendering/video-geometry.js';
import type { TemplateRepository } from '../application/template-ports.js';
import { TemplateService } from '../application/template-service.js';
import { TemplateLibraryView, type TemplateLibrarySelection, type TemplateLibraryPlacement } from './template-library.js';
import { NumericScrubbers, type NumericScrubberContext } from './numeric-scrubber.js';
import { TriggerSettingsView, type TriggerActorOption, type TriggerSettingsValue } from './trigger-settings.js';
import { ColorInputPreview, type ColorPreviewSession } from './color-input-preview.js';
import { FormValidation } from './form-validation.js';
import type { TextMotionLayout } from '../rendering/text-motion-renderer.js';

export const browserRuntime: Runtime = {
  now: () => performance.now(),
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id)
};
export type Translate = (key: string) => string;

export interface EditorServices {
  timelineClipboard?: TimelineClipboard;
  makeId(): string;
  repository: SequenceRepository;
  templateRepository?: TemplateRepository;
  confirmDeleteTemplate?(name: string): Promise<boolean>;
  localPlayer: LocalPlayer;
  localize: Translate;
  confirmDiscard(): Promise<boolean>;
  confirmDeleteSequence(name: string, hasUnsavedChanges: boolean): Promise<boolean>;
  refreshSequenceShortcuts?(): Promise<void>;
  listTriggerActors?(): readonly TriggerActorOption[];
  listTriggerUsers?(): readonly AudienceUser[];
  observeLocal(listener: (state: Readonly<PlayerState>) => void): () => void;
  prepareGroup(sequence: SequenceV1): Promise<boolean | void>;
  openSession(): void;
  groupActive(): boolean;
  chooseVideo(currentPath: string): Promise<string | null>;
  chooseImage?(currentPath: string): Promise<string | null>;
  chooseAudio?(currentPath: string): Promise<string | null>;
  requestAudioUnlock(unlock: () => Promise<void>, signal: AbortSignal): Promise<void>;
  createBoardBackdrop?(target: 'preview' | 'window' | 'canvas'): NonNullable<RendererOptions['boardBackdrop']>;
}

interface StillRequest { readonly version: number; readonly plan: CompiledSequence; readonly frame: PlayerFrame; }

type EditorElementType = SimpleElementType | 'audio' | 'image' | 'solid' | 'button';
type EditorSelection = { readonly kind: 'clip'; readonly id: string } | { readonly kind: 'break'; readonly id: string } | { readonly kind: 'none' };
const ELEMENTS: readonly EditorElementType[] = ['bars', 'text', 'image', 'solid', 'video', 'audio', 'button'];
/** Edits arbitrary visual tracks through targeted clip and timeline commands. */
export class EditorView {
  readonly draft: DraftService;
  private root: HTMLElement | null = null;
  private listeners = new AbortController();
  private unobserve: (() => void) | null = null;
  private readonly preview: LocalPlayer;
  private staticPreview: DomSurface | null = null;
  private staticAbort: AbortController | null = null;
  private staticSourceKey: string | null = null;
  private staticPrepared = false;
  private staticVersion = 0;
  private staticLatest: StillRequest | null = null;
  private staticQueue: Promise<void> = Promise.resolve();
  private staticUpdating: DomSurface | null = null;
  private readonly textMotionLayouts = new Map<string, TextMotionLayout>();
  private items: readonly SequenceSummary[] = [];
  private busy = false;
  private invalid = false;
  private readonly formValidation = new FormValidation();
  private mounted = false;
  private actionSerial = 0;
  private metadataController: AbortController | null = null;
  private metadataGeneration = 0;
  private imagePickerGeneration = 0;
  private imageHandles: VisualHandles | null = null;
  private previewViewport: PreviewViewport | null = null;
  private templateLibrary: TemplateLibraryView | null = null;
  private readonly templateProbes = new Set<AbortController>();
  private numericScrubbers: NumericScrubbers | null = null;
  private colorInputs: ColorInputPreview | null = null;
  private triggerSettings: TriggerSettingsView | null = null;
  private activeElement: EditorElementType = 'bars';
  private selection: EditorSelection = { kind: 'none' };
  private get selectedId(): string | null { return this.selection.kind === 'clip' ? this.selection.id : null; }
  private set selectedId(id: string | null) { this.selection = id ? { kind: 'clip', id } : { kind: 'none' }; }
  private get selectedBreakId(): string | null { return this.selection.kind === 'break' ? this.selection.id : null; }
  private playheadMs = 0;
  private timeline: TimelineView | null = null;
  private layout: EditorLayout | null = null;
  private inspectorTabs: InspectorTabs | null = null;
  private clipInspectorSections: ClipInspectorSections | null = null;
  private patternPicker: PatternPicker | null = null;
  private readonly textAnimationPickers = new Map<'entrance' | 'exit', TextAnimationPicker>();
  private readonly elementAnimationPickers = new Map<string, { kind: ElementAnimationPreviewKind; phase: 'entrance' | 'exit'; picker: AnimationPicker<SequenceClip> }>();
  private static readonly sharedTimelineClipboard = new TimelineClipboard();
  private readonly timelineClipboard: TimelineClipboard;
  private static readonly layoutSizes: EditorLayoutSizes = { library: 180, inspector: 300, timeline: 250 };
  private fieldHistoryGroup: string | undefined;
  private renaming = false;
  private lastNonMediaEnd: NonMediaEnd = { kind: 'fixed', durationMs: 5_000 };
  private localPhase: PlayerState['phase'] = 'idle';
  private previewPhase: PlayerState['phase'] = 'idle';

  constructor(private readonly services: EditorServices) {
    this.timelineClipboard = services.timelineClipboard ?? EditorView.sharedTimelineClipboard;
    this.draft = new DraftService(services.repository, services.makeId);
    this.preview = new LocalPlayer(browserRuntime, state => this.showPlayerState(state, 'preview'));
  }

  private t(key: string): string { return this.services.localize('STAGECRAFT.Editor.' + key); }

  async mount(root: HTMLElement): Promise<void> {
    this.detach();
    this.root = root;
    this.mounted = true;
    this.listeners = new AbortController();
    this.colorInputs = new ColorInputPreview(input => this.beginColorPreview(input), browserRuntime);
    const triggerSettingsSlot = root.querySelector<HTMLElement>('[data-stagecraft-trigger-settings]');
    if (triggerSettingsSlot) {
      this.triggerSettings = new TriggerSettingsView(triggerSettingsSlot, {
        makeId: this.services.makeId,
        localize: this.services.localize,
        listTriggerActors: () => this.services.listTriggerActors?.() ?? [],
        listTriggerUsers: () => this.services.listTriggerUsers?.() ?? [],
        onChange: value => this.applyTriggerSettings(value)
      });
    }
    this.clipInspectorSections = new ClipInspectorSections(root, () => {
      this.numericScrubbers?.cancel();
      this.imageHandles?.cancel();
    });
    this.inspectorTabs = new InspectorTabs(root, tab => this.clipInspectorSections?.setVisible(tab === 'clip'));
    const patternPickerHost = root.querySelector<HTMLElement>('[data-stagecraft-pattern-picker]');
    const patternPickerSelect = root.querySelector<HTMLSelectElement>('[name="solid-pattern-preset"]');
    if (patternPickerHost && patternPickerSelect) {
      this.patternPicker = new PatternPicker(root, patternPickerHost, patternPickerSelect, this.services.localize);
    }
    for (const phase of ['entrance', 'exit'] as const) {
      const host = root.querySelector<HTMLElement>(`[data-stagecraft-text-animation-picker="${phase}"]`);
      const select = root.querySelector<HTMLSelectElement>(`[name="text-${phase}-preset"]`);
      if (host && select) {
        const picker = new TextAnimationPicker(root, host, select, this.services.localize, phase);
        this.textAnimationPickers.set(phase, picker);
        host.classList.add('stagecraft-text-animation-enhanced');
      }
    }
    for (const kind of ['bars', 'image', 'solid', 'video', 'audio', 'button'] as const) {
      for (const phase of ['entrance', 'exit'] as const) {
        const key = `${kind}-${phase}`;
        const host = root.querySelector<HTMLElement>(`[data-stagecraft-element-animation-picker="${key}"]`);
        const select = root.querySelector<HTMLSelectElement>(`[name="${key}-preset"]`);
        if (!host || !select) continue;
        const picker = new AnimationPicker(root, host, select, this.services.localize, phase, {
          createPreview: (value, edge, source) => createElementAnimationPreview(kind, value, edge, source),
          createRenderer: createElementAnimationPreviewRenderer
        });
        this.elementAnimationPickers.set(key, { kind, phase, picker });
        host.classList.add('stagecraft-text-animation-enhanced');
      }
    }
    this.numericScrubbers = new NumericScrubbers(root, key => this.t(key), {
      read: input => this.numericScrubberContext(input),
      before: input => {
        const accepted = this.readForm(undefined, false, true);
        if (!accepted || !this.numericScrubberContext(input).editable) return false;
        this.fieldHistoryGroup = this.services.makeId();
        return true;
      },
      preview: (input, _value) => this.readForm(input.name, true),
      commit: (input, value) => {
        input.value = String(value);
        const accepted = this.readForm(input.name);
        this.fieldHistoryGroup = undefined;
        return accepted;
      },
      cancel: () => {
        this.fieldHistoryGroup = undefined;
        if (this.draft.draft) this.preview.updatePreview(this.draft.draft);
        if (this.mounted) this.paint();
        else this.drawStill();
      }
    });
    const viewer = root.querySelector<HTMLElement>('[data-stagecraft-viewer]');
    this.previewViewport = new PreviewViewport(root);
    const templateSlot = root.querySelector<HTMLElement>('[data-stagecraft-templates]');
    if (templateSlot && this.services.templateRepository) {
      const service = new TemplateService(this.services.templateRepository, this.services.makeId, async (path, type) => {
        const controller = new AbortController(); this.templateProbes.add(controller);
        try { return (await (type === 'audio' ? probeAudio(path, controller.signal) : probeVideo(path, controller.signal))).durationMs; }
        finally { this.templateProbes.delete(controller); }
      });
      this.templateLibrary = new TemplateLibraryView({ service, translate: key => this.t(key),
        selectedClip: () => this.templateSelection(), placement: type => this.templatePlacement(type),
        insertElement: (clip, expected) => this.insertTemplateClip(clip, expected),
        replaceSelectedClip: (clip, expected) => this.applyTemplateAnimation(clip, expected),
        ...(this.services.confirmDeleteTemplate ? { confirmDelete: template => this.services.confirmDeleteTemplate!(template.name) } : {}),
        onError: (_message, error) => this.message(this.errorMessage(error), 'error')
      });
      this.templateLibrary.mount(templateSlot, root.querySelector<HTMLElement>('[data-stagecraft-template-save]') ?? undefined);
    }
    if (viewer) this.imageHandles = new VisualHandles(viewer, key => this.t(key), {
      read: () => this.imageHandleState(),
      before: () => {
        if (!this.imageHandleState().editable) return false;
        const accepted = this.readForm();
        this.fieldHistoryGroup = undefined;
        return accepted && this.imageHandleState().editable;
      },
      preview: clip => this.previewImageClip(clip),
      commit: (sequenceId, clipId, clip) => this.commitImageHandleEdit(sequenceId, clipId, clip),
      cancel: () => this.drawStill()
    });
    const shell = root.querySelector<HTMLElement>('.stagecraft-editor-shell');
    if (shell) this.layout = new EditorLayout(shell, EditorView.layoutSizes);
    const timelineRoot = root.querySelector<HTMLElement>('[data-stagecraft-timeline]');
    if (timelineRoot) this.timeline = new TimelineView(timelineRoot, key => this.t(key), {
      select: id => this.selectClip(id), scrub: time => this.scrub(time), command: command => this.timelineCommand(command),
      selectBreak: id => this.selectBreak(id),
      breakPosition: (id, time) => { if (id === this.selectedBreakId) this.setValue('break-position', String(time / 1000)); },
      contextItems: target => this.timelineContextItems(target),
      contextAction: (action, target) => this.timelineContextAction(action, target),
      beforeEdit: () => { this.colorInputs?.finish(); this.preview.stop(); }, error: error => this.message(this.errorMessage(error), 'error')
    });
    root.addEventListener('keydown', event => this.keyboard(event), { signal: this.listeners.signal });
    root.addEventListener('focusin', event => { const target = event.target; if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) { this.colorInputs?.finish(); this.fieldHistoryGroup = this.services.makeId(); } }, { signal: this.listeners.signal });
    root.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-stagecraft-action]') : null;
      if (target && root.contains(target)) void this.act(target.dataset.stagecraftAction!, target.dataset.sequenceId ?? target.dataset.presetId, target.dataset.elementType as EditorElementType | undefined);
    }, { signal: this.listeners.signal });
    root.addEventListener('input', event => {
      if (this.busy) return;
      const target = event.target;
      if ((target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) && target.name && !['video-path', 'audio-path', 'image-path', 'sequence-name', 'button-decision-name', 'button-design'].includes(target.name)) {
        if (target.disabled) return;
        if (target instanceof HTMLInputElement && target.type === 'color') {
          this.colorInputs?.input(target);
          return;
        }
        if (['audio-loop', 'audio-in', 'audio-out', 'audio-loop-indefinitely'].includes(target.name)) {
          if (target instanceof HTMLInputElement && target.name === 'audio-loop-indefinitely') {
            const loop = this.field<HTMLInputElement>('audio-loop');
            if (target.checked && loop) loop.checked = true;
            else if (!loop?.checked) target.checked = false;
          }
          this.updateAudioDurationBounds(true);
        }
        this.readForm(target.name);
      }
    }, { signal: this.listeners.signal });
    root.addEventListener('focusout', event => {
      if (event.target === this.field('sequence-name')) this.finishRename(true);
      else if (event.target === this.field('break-position')) this.finishBreakPosition();
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
        this.checkFormFields([target]);
      }
    }, { signal: this.listeners.signal });
    root.addEventListener('change', event => {
      if (this.busy) return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
      if (target.disabled) return;
      if (target instanceof HTMLInputElement && target.type === 'color') {
        this.colorInputs?.change(target);
        return;
      }
      if (target instanceof HTMLSelectElement && 'stagecraftSequencePicker' in target.dataset) {
        void this.act('load', target.value).finally(() => this.paintSequencePicker());
      } else if (target.name === 'sequence-name') {
        return;
      } else if (target.name === 'break-position') {
        this.finishBreakPosition();
      } else if (target.name === 'video-path') {
        void this.perform(async () => this.applyVideoPath(target.value));
      } else if (target.name === 'audio-path') {
        void this.perform(async () => this.applyAudioPath(target.value));
      } else if (target.name === 'image-path') {
        void this.perform(async () => this.applyImagePath(target.value));
      } else if (target.name === 'button-decision-name') {
        this.readForm(target.name);
      } else if (target.name === 'button-design') {
        this.fieldHistoryGroup = undefined;
        void this.perform(async () => this.applyButtonDesign(target.value));
      } else if (target instanceof HTMLSelectElement || target.type === 'checkbox' || target.type === 'color') {
        this.readForm(target.name);
      }
    }, { signal: this.listeners.signal });
    this.unobserve = this.services.observeLocal(state => this.showPlayerState(state, 'local'));
    await this.perform(async () => {
      await this.refreshList();
      if (!this.draft.draft) {
        const first = this.items.find(item => !item.issue);
        if (first) await this.draft.load(first.id);
        else this.draft.create(this.t('DefaultName'), { automaticEnd: true });
      }
      this.paint();
    });
  }

  detach(): void {
    this.formValidation.clearAll();
    this.colorInputs?.finish();
    this.colorInputs = null;
    this.finishRename(true);
    this.mounted = false;
    this.textMotionLayouts.clear();
    this.actionSerial++;
    this.busy = false;
    this.numericScrubbers?.dispose();
    this.numericScrubbers = null;
    this.triggerSettings?.dispose();
    this.triggerSettings = null;
    this.imageHandles?.dispose();
    this.imageHandles = null;
    this.previewViewport?.dispose();
    this.previewViewport = null;
    this.templateLibrary?.detach();
    this.templateLibrary = null;
    for (const controller of this.templateProbes) controller.abort();
    this.templateProbes.clear();
    this.cancelMediaWork();
    this.listeners.abort();
    this.layout?.dispose();
    this.layout = null;
    this.inspectorTabs?.dispose();
    this.inspectorTabs = null;
    this.clipInspectorSections?.dispose();
    this.clipInspectorSections = null;
    this.patternPicker?.dispose();
    this.patternPicker = null;
    for (const picker of this.textAnimationPickers.values()) picker.dispose();
    this.textAnimationPickers.clear();
    for (const { picker } of this.elementAnimationPickers.values()) picker.dispose();
    this.elementAnimationPickers.clear();
    for (const host of this.root?.querySelectorAll<HTMLElement>('[data-stagecraft-text-animation-picker], [data-stagecraft-element-animation-picker]') ?? []) host.classList.remove('stagecraft-text-animation-enhanced');
    this.timeline?.dispose();
    this.timeline = null;
    this.unobserve?.();
    this.unobserve = null;
    this.preview.stop();
    this.clearStill();
    this.root = null;
  }

  async mayClose(): Promise<boolean> {
    if (this.busy) return false;
    this.colorInputs?.finish();
    this.finishRename(true);
    return !(this.draft.dirty || this.invalid) || await this.services.confirmDiscard();
  }

  private field<T extends FieldElement = HTMLInputElement>(name: string): T | null {
    return this.root?.querySelector<T>('[name="' + name + '"]') ?? null;
  }

  private message(text: string, tone: 'error' | 'warning' | 'normal' = 'normal'): void {
    const node = this.root?.querySelector<HTMLElement>('[data-stagecraft-message]');
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('stagecraft-error', tone === 'error');
    node.classList.toggle('stagecraft-warning', tone === 'warning');
  }

  private errorMessage(error: unknown): string {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code) : typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    const key = 'STAGECRAFT.Error.' + code;
    const translated = this.services.localize(key);
    return translated !== key ? translated : this.t('OperationFailed');
  }

  private async perform(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.colorInputs?.finish();
    const returnFocus = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    const serial = this.actionSerial;
    this.busy = true;
    this.timeline?.cancel();
    this.updateButtons();
    try { await work(); }
    catch (error) {
      if (this.mounted && serial === this.actionSerial) this.message(this.errorMessage(error), 'error');
    } finally {
      if (serial === this.actionSerial) {
        this.busy = false;
        this.updateButtons();
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        if ((!active || active === document.body) && returnFocus?.isConnected
          && !returnFocus.closest('[hidden], [inert], :disabled')) returnFocus.focus();
      }
    }
  }

  private async act(action: string, id?: string, elementType?: EditorElementType): Promise<void> {
    if (this.busy) return;
    this.colorInputs?.finish();
    if (action === 'rename') { this.beginRename(); return; }
    this.finishRename(true);
    // Validate before perform() temporarily disables the inspector. Save remains
    // reachable so users can ask for native, field-specific recovery guidance.
    if (action === 'save') {
      const invalid = this.checkFormFields(true);
      if (invalid.length) {
        this.invalid = true;
        this.message(this.t('InvalidFields'), 'error');
        this.updateButtons();
        const first = invalid[0]!;
        this.revealInvalidField(first);
        first.focus();
        first.reportValidity();
        return;
      }
      if (!this.readForm()) return;
    }
    if (['choose-video', 'choose-image', 'choose-button-texture', 'choose-solid-alpha', 'clear-solid-alpha', 'choose-audio'].includes(action)) {
      // Read while the inspector still participates in native validation. Busy
      // disables its fieldset, which must not erase errors or admit invalid edits.
      const pathNames: Readonly<Record<string, string>> = {
        'choose-video': 'video-path', 'choose-image': 'image-path', 'choose-audio': 'audio-path',
        'choose-button-texture': 'button-texture-path', 'choose-solid-alpha': 'solid-alpha-path'
      };
      const pathField = pathNames[action] ? this.field(pathNames[action]!) : null;
      const required = pathField?.required ?? false;
      const enteredPath = pathField?.value;
      const emptyPath = pathField && !pathField.value.trim();
      try {
        if (emptyPath) {
          pathField.required = false;
          // Browse is itself recovery for an empty path. Preserve the clip's
          // existing source while committing the other valid inspector values.
          const source = this.draft.draft, clip = source && selectedClip(source, this.selectedId);
          if (clip?.type === 'video' || clip?.type === 'audio' || clip?.type === 'image') pathField.value = clip.properties.source.path;
          else if (clip?.type === 'button' && clip.properties.texture?.kind === 'foundry-file') pathField.value = clip.properties.texture.path;
          else if (clip?.type === 'solid') pathField.value = clip.properties.alphaMap?.path ?? '';
        }
        if (!this.readForm()) return;
      } finally {
        if (pathField) {
          pathField.required = required;
          if (emptyPath) pathField.value = enteredPath!;
        }
      }
    }
    if (action === 'load' && id === this.draft.draft?.id) { this.paintSequencePicker(); return; }
    if (action === 'undo' || action === 'redo') { if(this.busy)return; this.timeline?.cancel(); this.imageHandles?.cancel(); this.numericScrubbers?.cancel(); this.fieldHistoryGroup=undefined; this.preview.stop(); this.draft[action](); this.invalid = false; this.paint(); this.message(this.draft.dirty ? this.t('Unsaved') : ''); return; }
    if (action === 'duplicate-clip' || action === 'remove-clip') { if (this.selectedId) this.timelineCommand({ kind: action, clipId: this.selectedId }); return; }
    if (action === 'remove-break') { if (this.selectedBreakId) this.timeline?.removeBreak(this.selectedBreakId); return; }
    if (action === 'add-preset' && effectPreset(id)?.type === 'break') {
      this.fieldHistoryGroup = undefined;
      this.timeline?.addBreakAtPlayhead();
      return;
    }
    if (action === 'reset-image-mask') { this.resetImageMask(); return; }
    if (action === 'reset-solid-mask') { this.resetImageMask('solid'); return; }
    if (action === 'solid-add-point' || action === 'solid-remove-point') { this.fieldHistoryGroup = undefined; this.imageHandles?.editPoint(action === 'solid-add-point' ? 'add' : 'remove'); return; }
    if (action === 'solid-pattern-variant' || action === 'solid-pattern-palette') { this.changeSolidPattern(action); return; }
    if (action === 'stop-preview') { this.preview.stop(); this.drawStill(); return; }
    if (action === 'fade-preview') { this.preview.fadeOut(); return; }
    if (action === 'continue-preview') { this.preview.continueFromBreak(); return; }
    if (action === 'pause-preview') {
      if (this.preview.getState().phase === 'paused') this.preview.resume();
      else this.preview.pause();
      return;
    }
    if (action === 'select-element' && elementType && ELEMENTS.includes(elementType)) {
      const clip = this.draft.draft?.clips.find(clip => clip.type === elementType);
      if (clip) this.selectClip(clip.id);
      return;
    }
    if (this.busy) return;
    await this.perform(async () => {
      if (action === 'add-preset') {
        const preset = effectPreset(id);
        if (preset && preset.type !== 'break') await this.toggleElement(preset.type, preset.id === 'animated-surface');
      } else if (action === 'toggle-element' && elementType && ELEMENTS.includes(elementType)) {
        await this.toggleElement(elementType);
      } else if (['new', 'load', 'reload'].includes(action)) {
        if ((this.draft.dirty || this.invalid) && !await this.services.confirmDiscard()) return;
        this.imageHandles?.cancel();
        this.cancelMediaWork();
        this.preview.stop();
        this.clearStill();
        this.lastNonMediaEnd = { kind: 'fixed', durationMs: 5_000 };
        if (action === 'new') this.draft.create(this.t('DefaultName'), { automaticEnd: true });
        else { await this.draft.load(id ?? this.draft.draft!.id); await this.refreshList(); }
        this.selectedId = null;
        this.playheadMs = 0;
        this.invalid = false;
        this.message('');
        this.paint();
      } else if (action === 'refresh') {
        await this.refreshList();
        this.paintSequencePicker();
      } else if (action === 'delete-sequence') {
        await this.deleteCurrentSequence();
      } else if (action === 'choose-video') {
        await this.chooseVideo();
      } else if (action === 'choose-image') {
        await this.chooseImage();
      } else if (action === 'choose-button-texture') {
        await this.chooseButtonTexture();
      } else if (action === 'choose-solid-alpha') {
        await this.chooseSolidAlpha();
      } else if (action === 'clear-solid-alpha') {
        this.applySolidAlphaPath('');
      } else if (action === 'inspect-video') {
        const path=this.field('video-path')?.value;
        if(path && path!==this.videoPath(this.draft.draft!))await this.applyVideoPath(path);
        else await this.inspectCurrentVideo();
      } else if (action === 'choose-audio') {
        await this.chooseAudio();
      } else if (action === 'inspect-audio') {
        const path=this.field('audio-path')?.value;
        if(path && path!==this.audioPath(this.draft.draft!))await this.applyAudioPath(path);
        else await this.inspectCurrentAudio();
      } else if (action === 'save') {
        await this.validateForPlayback();
        await this.draft.save();
        await this.refreshList();
        this.paint();
        this.message(this.t('Saved'));
      } else if (action === 'duplicate') {
        if (!this.readForm()) return;
        this.draft.duplicate(this.draft.draft!.name + ' ' + this.t('CopySuffix'));
        this.invalid = false;
        this.paint();
        this.message(this.t('Unsaved'));
      } else if (action === 'session') {
        this.services.openSession();
      } else if (action === 'prepare-group') {
        if (!this.readForm(undefined, false, true) || this.draft.dirty || this.draft.expectedRevision === null) {
          this.message(this.t('SaveFirst'), 'error');
          return;
        }
        await this.validateForPlayback();
        if (this.draft.dirty) { this.message(this.t('SaveFirst'), 'error'); return; }
        if (await this.services.prepareGroup(this.draft.draft!) !== false) {
          this.preview.stop();
          this.clearStill();
        }
      } else if (action === 'preview' || action === 'play') {
        if (this.services.groupActive()) { this.message(this.t('GroupActive'), 'error'); return; }
        if (!this.readForm()) return;
        await this.validateForPlayback();
        const sequence = this.draft.draft!;
        this.imageHandles?.cancel();
        this.preview.stop();
        this.clearStill();
        if (action === 'preview') {
          if (!['idle', 'ended'].includes(this.services.localPlayer.getState().phase)) {
            this.message(this.t('LocalActive'), 'error');
            return;
          }
          const viewer = this.root!.querySelector<HTMLElement>('[data-stagecraft-viewer]')!;
          await this.preview.startPreview(sequence, this.makeSurface('preview', viewer));
        } else {
          await this.services.localPlayer.start(sequence, this.makeSurface(sequence.presentation.surface));
        }
      }
    });
  }

  private makeSurface(target: 'preview' | 'window' | 'canvas', preview?: HTMLElement): DomSurface {
    const boardBackdrop = this.services.createBoardBackdrop?.(target);
    return new DomSurface({
      target, ...(preview ? { preview } : {}),
      ...(target === 'canvas' && document.querySelector<HTMLElement>('#board')
        ? { board: document.querySelector<HTMLElement>('#board')! } : {}),
      requestAudioUnlock: this.services.requestAudioUnlock,
      ...(boardBackdrop ? { boardBackdrop } : {}),
      onButtonActivate: async () => {
        const player = target === 'preview' ? this.preview : this.services.localPlayer;
        player.continueFromBreak();
      },
      onInteractionError: error => {
        if (this.mounted) this.message(this.errorMessage(error), 'warning');
      },
      onError: error => {
        if (target === 'preview') this.preview.fail(error);
        else this.services.localPlayer.fail(error);
        this.message(this.errorMessage(error), 'error');
      },
      onWarning: code => this.message(this.errorMessage(code), 'warning'),
      ...(target === 'preview' ? { onTextMotionLayout: (layout: TextMotionLayout) => this.receiveTextMotionLayout(layout) } : {}),
      ...(target === 'preview' ? {} : {
        controls: {
          stop: () => this.services.localPlayer.stop(),
          fade: () => this.services.localPlayer.fadeOut(),
          continue: () => this.services.localPlayer.continueFromBreak(),
          togglePause: () => this.services.localPlayer.getState().phase === 'paused'
            ? this.services.localPlayer.resume() : this.services.localPlayer.pause(),
          labels: {
            stop: this.t('Stop'), fade: this.t('FadeOut'), pause: this.t('Pause'),
            resume: this.t('Resume'), playback: this.t('LocalPlayback'), continue: this.t('Continue')
          }
        }
      })
    });
  }

  private inspectedClip(sequence: SequenceV1, type: EditorElementType): SequenceClip | undefined {
    const clip = selectedClip(sequence, this.selectedId);
    return clip?.type === type ? clip : undefined;
  }

  private selectClip(id: string): void {
    this.colorInputs?.finish();
    const clip = this.draft.draft?.clips.find(clip => clip.id === id);
    if (!clip) return;
    if (this.selectedId !== id) { this.imagePickerGeneration++; this.imageHandles?.cancel(); this.numericScrubbers?.cancel(); }
    this.selectedId = id; this.activeElement = clip.type; this.fieldHistoryGroup = undefined;
    this.invalid = false;
    this.paint();
    this.inspectorTabs?.showClip();
  }

  private selectBreak(id: string | null): void {
    this.colorInputs?.finish();
    if (id && !this.draft.draft?.breaks?.some(marker => marker.id === id)) return;
    // A callback after the last marker is removed must preserve the fallback clip.
    if (!id && this.selection.kind !== 'break') return;
    this.imageHandles?.cancel();
    this.numericScrubbers?.cancel();
    this.selection = id ? { kind: 'break', id } : { kind: 'none' };
    this.fieldHistoryGroup = undefined;
    this.invalid = false;
    this.timeline?.setSelectedBreak(id);
    const marker = this.draft.draft?.breaks?.find(item => item.id === id);
    if (marker) this.setValue('break-position', String(marker.positionMs / 1000));
    this.updateButtons();
    this.inspectorTabs?.showClip();
  }

  private scrub(timeMs: number): void {
    this.colorInputs?.finish();
    this.numericScrubbers?.cancel();
    this.preview.stop(); this.playheadMs = Math.max(0, Math.round(timeMs));
    this.timeline?.setPlayhead(this.playheadMs);
    if ((this.draft.draft?.breaks?.length ?? 0) >= SEQUENCE_LIMITS.breaks) this.paintLibrary();
    this.setOutput('[data-stagecraft-clock]', (this.playheadMs / 1000).toFixed(2) + ' s');
    this.drawStill();
    this.imageHandles?.update();
    this.numericScrubbers?.update();
  }

  private timelineCommand(command: TimelineCommand): boolean {
    if (this.busy || !this.draft.draft) return false;
    this.colorInputs?.finish();
    this.preview.stop(); this.fieldHistoryGroup = undefined;
    try {
      const old = this.draft.draft;
      // Adding a Break adopts its semantics within the same undoable edit.
      // Replace the draft only after adoption and marker validation both succeed.
      const base = command.kind === 'add-break' && getPlaybackSchemaVersion(old) === 1 ? upgradeSequenceToBreaks(old) : old;
      const next = applyEditorTimelineCommand(base, command, this.services.makeId);
      this.replaceDraft(next);
      if (command.kind === 'duplicate-clip' || command.kind === 'add-clip' || command.kind === 'insert-clip') this.selectedId = next.clips.find(c => !old.clips.some(o => o.id === c.id))?.id ?? this.selectedId;
      if (command.kind === 'add-break') {
        const added = next.breaks?.find(marker => !old.breaks?.some(previous => previous.id === marker.id));
        if (added) this.selection = { kind: 'break', id: added.id };
      } else if (command.kind === 'remove-break' && command.breakId === this.selectedBreakId) {
        const removed = old.breaks?.find(marker => marker.id === command.breakId);
        const nearest = [...(next.breaks ?? [])].sort((a, b) => Math.abs(a.positionMs - (removed?.positionMs ?? 0)) - Math.abs(b.positionMs - (removed?.positionMs ?? 0)))[0];
        this.selection = nearest ? { kind: 'break', id: nearest.id } : { kind: 'none' };
      }
      this.paint(); this.message(this.t('Unsaved'));
      return true;
    } catch (error) { this.message(this.errorMessage(error), 'error'); this.paint(); return false; }
  }

  private clipboardSelection(): TimelineClipboardSelection | null {
    return this.selectedBreakId ? { kind: 'break', id: this.selectedBreakId }
      : this.selectedId ? { kind: 'clip', id: this.selectedId } : null;
  }

  private clipboardTrack(trackId?: string): string | undefined {
    if (trackId) return trackId;
    const sequence = this.draft.draft;
    const selected = sequence && selectedClip(sequence, this.selectedId);
    const kind = this.timelineClipboard.clipType === 'audio' ? 'audio' : 'visual';
    return selected && sequence?.tracks.find(track => track.id === selected.trackId)?.kind === kind ? selected.trackId : undefined;
  }

  private canPasteTimeline(trackId?: string): boolean {
    if (this.busy || !this.draft.draft || !this.timelineClipboard.hasContent) return false;
    if (this.timelineClipboard.kind === 'break') return (this.draft.draft.breaks?.length ?? 0) < SEQUENCE_LIMITS.breaks;
    const track = this.draft.draft.tracks.find(item => item.id === this.clipboardTrack(trackId));
    return !track || !track.locked && track.kind === (this.timelineClipboard.clipType === 'audio' ? 'audio' : 'visual');
  }

  private timelineContextItems(target: TimelineContextTarget): readonly TimelineContextMenuItem[] {
    const sequence = this.draft.draft;
    if (!sequence) return [];
    const clip = target.kind === 'clip' ? sequence.clips.find(item => item.id === target.id) : undefined;
    const marker = target.kind === 'break' ? sequence.breaks?.find(item => item.id === target.id) : undefined;
    if (target.kind !== 'space' && !clip && !marker) return [];
    const trackId = target.kind === 'break' ? undefined : target.trackId;
    const track = sequence.tracks.find(item => item.id === trackId);
    const locked = track?.locked === true;
    const editable = !this.busy && !locked && (target.kind !== 'break' || getPlaybackSchemaVersion(sequence) === 3);
    const item = (id: string, key: string, icon: string, disabled = false, shortcut?: string, separatorBefore = false): TimelineContextMenuItem => ({
      id, label: this.t(key), icon: 'fa-solid ' + icon, disabled, ...(shortcut ? { shortcut } : {}), ...(separatorBefore ? { separatorBefore } : {})
    });
    const paste = item('paste', 'ContextPaste', 'fa-paste', !this.canPasteTimeline(trackId), 'Ctrl/Cmd+V');
    if (target.kind === 'space') return [paste,
      item('paste-here', 'ContextPasteHere', 'fa-location-dot', !this.canPasteTimeline(trackId)),
      item('add-break-here', 'ContextAddBreakHere', 'fa-pause', this.busy || (sequence.breaks?.length ?? 0) >= SEQUENCE_LIMITS.breaks
        || sequence.breaks?.some(value => value.positionMs === target.positionMs) === true, undefined, true)];
    const end = clip ? clipDurationMs(sequence, clip) : undefined;
    const entries = [
      item('cut', 'ContextCut', 'fa-scissors', !editable, 'Ctrl/Cmd+X'),
      item('copy', 'ContextCopy', 'fa-copy', this.busy, 'Ctrl/Cmd+C'), paste,
      item('duplicate', 'ContextDuplicate', 'fa-clone', !editable || !!marker && (sequence.breaks?.length ?? 0) >= SEQUENCE_LIMITS.breaks, 'Ctrl/Cmd+D'),
      item('delete', 'ContextDelete', 'fa-trash', !editable, 'Del'),
      item('inspect', 'ContextInspect', 'fa-sliders', this.busy, undefined, true),
      item('go-start', clip ? 'ContextGoStart' : 'ContextGoBreak', 'fa-backward-step', this.busy),
      ...(clip ? [item('go-end', 'ContextGoEnd', 'fa-forward-step', this.busy || typeof end !== 'number')] : [])
    ];
    if (track) entries.push(
      item('track-enabled', track.enabled ? 'ContextDisableTrack' : 'ContextEnableTrack', 'fa-eye', this.busy || locked, undefined, true),
      item('track-locked', locked ? 'ContextUnlockTrack' : 'ContextLockTrack', 'fa-lock', this.busy));
    return entries;
  }

  private timelineContextAction(action: string, target?: TimelineContextTarget): void {
    this.colorInputs?.finish();
    if (this.busy || !this.draft.draft) return;
    this.timeline?.closeContextMenu();
    if (target && this.timelineContextItems(target).find(item => item.id === action)?.disabled) return;
    const selected: TimelineClipboardSelection | null = target && target.kind !== 'space' ? { kind: target.kind, id: target.id } : this.clipboardSelection();
    const trackId = target && target.kind !== 'break' ? target.trackId : undefined;
    try {
      if (action === 'inspect' && selected) {
        if (selected.kind === 'clip') this.selectClip(selected.id); else this.selectBreak(selected.id);
        return;
      }
      if (action === 'copy' && selected) { this.timelineClipboard.copy(this.draft.draft, selected); return; }
      if (action === 'go-start' || action === 'go-end') {
        const sequence = this.draft.draft;
        const clip = selected?.kind === 'clip' ? sequence.clips.find(item => item.id === selected.id) : undefined;
        const marker = selected?.kind === 'break' ? sequence.breaks?.find(item => item.id === selected.id) : undefined;
        if (clip) { const duration = clipDurationMs(sequence, clip); if (action !== 'go-end' || typeof duration === 'number') this.scrub(clip.startMs + (action === 'go-end' ? duration! : 0)); }
        else if (marker) this.scrub(marker.positionMs);
        return;
      }
      if (action === 'track-enabled' || action === 'track-locked') {
        if (trackId) this.timelineCommand({ kind: 'toggle-track', trackId, property: action === 'track-enabled' ? 'enabled' : 'locked' });
        return;
      }
      if (action === 'delete') {
        if (selected) this.timelineCommand(selected.kind === 'clip' ? { kind: 'remove-clip', clipId: selected.id } : { kind: 'remove-break', breakId: selected.id });
        return;
      }
      this.numericScrubbers?.cancel(); this.imageHandles?.cancel(); this.timeline?.cancel();
      this.fieldHistoryGroup = undefined;
      if (!this.readForm()) return;
      const sequence = this.draft.draft!;
      this.preview.stop();
      if (action === 'cut' && selected) {
        const commit = this.timelineClipboard.stageCopy(sequence, selected);
        if (this.timelineCommand(selected.kind === 'clip' ? { kind: 'remove-clip', clipId: selected.id } : { kind: 'remove-break', breakId: selected.id })) commit();
      } else if (action === 'duplicate' && selected?.kind === 'clip') {
        this.timelineCommand({ kind: 'duplicate-clip', clipId: selected.id });
      } else if (action === 'duplicate' && selected?.kind === 'break') {
        const marker = sequence.breaks?.find(item => item.id === selected.id);
        if (!marker) return;
        let positionMs = marker.positionMs + 100;
        while (sequence.breaks?.some(item => item.positionMs === positionMs) && positionMs <= SEQUENCE_LIMITS.timelineMs) positionMs += 100;
        const temporary = new TimelineClipboard(); temporary.copy(sequence, selected);
        const pasted = temporary.paste(sequence, { positionMs }, this.services.makeId);
        this.replaceDraft(pasted.sequence); this.selectBreak(pasted.selection.id); this.paint(); this.message(this.t('Unsaved'));
      } else if (action === 'paste' || action === 'paste-here') {
        if (!this.canPasteTimeline(trackId)) return;
        const positionMs = action === 'paste-here' && target?.kind === 'space' ? target.positionMs : this.playheadMs;
        const preferredTrack = this.clipboardTrack(trackId);
        const pasted = this.timelineClipboard.paste(sequence, { positionMs, ...(preferredTrack ? { trackId: preferredTrack } : {}) }, this.services.makeId);
        this.replaceDraft(pasted.sequence);
        if (pasted.selection.kind === 'clip') this.selectClip(pasted.selection.id); else this.selectBreak(pasted.selection.id);
        this.paint(); this.message(this.t('Unsaved'));
      } else if (action === 'add-break-here' && target?.kind === 'space') {
        this.timelineCommand({ kind: 'add-break', positionMs: target.positionMs }); this.inspectorTabs?.showClip();
      }
    } catch (error) { this.message(this.errorMessage(error), 'error'); }
  }

  private keyboard(event: KeyboardEvent): void {
    if (event.target === this.field('break-position') && event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); this.finishBreakPosition(); return;
    }
    if (event.target === this.field('sequence-name') && this.renaming) {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        this.finishRename(event.key === 'Enter');
        this.root?.querySelector<HTMLSelectElement>('[data-stagecraft-sequence-picker]')?.focus();
      }
      return;
    }
    if (!this.root?.contains(document.activeElement) || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
    if (event.key === 'Escape') { this.timeline?.cancel(); return; }
    if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v', 'd'].includes(event.key.toLowerCase()) && !event.altKey) {
      const action = ({ c: 'copy', x: 'cut', v: 'paste', d: 'duplicate' } as const)[event.key.toLowerCase() as 'c' | 'x' | 'v' | 'd'];
      event.preventDefault(); event.stopPropagation(); this.timelineContextAction(action); this.timeline?.focusSelection(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); void this.act(event.shiftKey ? 'redo' : 'undo'); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); void this.act(this.selectedBreakId ? 'remove-break' : 'remove-clip'); }
  }

  private async toggleElement(type: EditorElementType, animated = false): Promise<void> {
    let source = this.draft.draft;
    if (!source) return;
    let path: string | undefined, sourceDurationMs: number | undefined;
    if (type === 'image') {
      if (!this.services.chooseImage) throw new Error('IMAGE_PICKER_UNAVAILABLE');
      const sequenceId = source.id, generation = ++this.imagePickerGeneration;
      const chosen = await this.services.chooseImage('');
      if (!chosen || !this.mounted || generation !== this.imagePickerGeneration || this.draft.draft?.id !== sequenceId) return;
      // Do not touch the draft until a file has actually been chosen.
      if (!this.readForm()) return;
      const latest = this.draft.draft;
      if (!latest || latest.id !== sequenceId) return;
      source = latest;
      path = chosen;
    } else {
      if (!this.readForm()) return;
      const latest = this.draft.draft;
      if (!latest) return;
      source = latest;
    }
    this.fieldHistoryGroup = undefined;
    this.imageHandles?.cancel();
    this.preview.stop();
    if (type === 'video' || type === 'audio') {
      const sequenceId = source.id;
      const chosen = type === 'audio'
        ? await (this.services.chooseAudio ? this.services.chooseAudio('') : Promise.reject(new Error('AUDIO_PICKER_UNAVAILABLE')))
        : await this.services.chooseVideo('');
      if (!chosen || !this.mounted || this.draft.draft?.id !== sequenceId) return;
      path = chosen;
      const controller = new AbortController(); this.metadataController = controller;
      const generation = ++this.metadataGeneration;
      this.message(this.t(type === 'audio' ? 'ReadingAudio' : 'ReadingVideo'));
      try { sourceDurationMs = (await (type === 'audio' ? probeAudio(path, controller.signal) : probeVideo(path, controller.signal))).durationMs; }
      finally { if (this.metadataController === controller) this.metadataController = null; }
      if (!this.mounted || generation !== this.metadataGeneration || this.draft.draft?.id !== sequenceId) return;
      source = this.draft.draft!;
    }
    if (!source) return;
    let nextSource: SequenceV1 = source;
    const trackKind = type === 'audio' ? 'audio' : 'visual';
    const selectedTrack = nextSource.tracks.find(track => track.id === this.field('clip-track')?.value);
    const usable = (trackId: string) => {
      const track = nextSource.tracks.find(item => item.id === trackId);
      if (!track || track.kind !== trackKind || track.locked) return false;
      if (type !== 'audio') return !nextSource.clips.some(clip => clip.trackId === trackId);
      return !this.audioTrackHasOverlap(nextSource, trackId, this.playheadMs, sourceDurationMs!);
    };
    const target = (selectedTrack && usable(selectedTrack.id) ? selectedTrack : undefined)
      ?? nextSource.tracks.filter(track => track.kind === trackKind).sort((a,b)=>a.order-b.order).find(track=>usable(track.id));
    let trackId = target?.id;
    if (!trackId) {
      const previous = nextSource;
      nextSource = applyEditorTimelineCommand(nextSource, { kind: 'add-track', trackKind }, this.services.makeId);
      trackId = nextSource.tracks.find(track => !previous.tracks.some(old => old.id === track.id))!.id;
    }
    const mediaSource = path ? { sourcePath: path, ...(type === 'image' ? {} : { sourceDurationMs: sourceDurationMs! }) } : {};
    let next = applyEditorTimelineCommand(nextSource, { kind: 'add-clip', trackId, type, startMs: this.playheadMs, ...mediaSource }, this.services.makeId);
    const addedClipId = next.clips.find(c => !this.draftBeforeIds(nextSource).has(c.id))!.id;
    if (animated) {
      const configured: SequenceV1 = { ...next, clips: next.clips.map(clip => clip.id === addedClipId && clip.type === 'solid'
        ? { ...clip, typeVersion: 2, exit: { preset: 'none', version: 1 }, properties: { ...clip.properties, pattern: createAnimatedPattern() } } : clip) };
      next = configured;
      if (configured.end.kind === 'manual') {
        // Held clips inherit the endpoint and cannot extend it. A late insertion
        // retains the validated fixed duration instead of invalidating that endpoint.
        const held: SequenceV1 = { ...configured, clips: configured.clips.map(clip => clip.id === addedClipId && clip.type === 'solid'
          ? { ...clip, duration: { kind: 'sequence-end' } } : clip) };
        if (!timelineConflicts(held).length) {
          try { compileSequence(held); next = held; } catch { next = configured; }
        }
      }
      compileSequence(next);
    }
    this.replaceDraft(next);
    this.selectClip(addedClipId);
  }
  private draftBeforeIds(sequence: SequenceV1): Set<string> { return new Set(sequence.clips.map(c=>c.id)); }

  private audioTrackHasOverlap(sequence: SequenceV1, trackId: string, startMs: number, durationMs: number): boolean {
    const endMs = startMs + durationMs;
    return sequence.clips.some(clip => {
      if (clip.type !== 'audio' || clip.trackId !== trackId) return false;
      const otherDuration = audioDurationMs(clip);
      const otherEnd = otherDuration === undefined ? Number.POSITIVE_INFINITY : clip.startMs + otherDuration;
      return startMs < otherEnd && clip.startMs < endMs;
    });
  }

  private async chooseVideo(): Promise<void> {
    const source = this.draft.draft!, clip = this.inspectedClip(source,'video') as VideoClip | undefined;
    if (!clip) return;
    if(source.tracks.find(track=>track.id===clip.trackId)?.locked)throw new Error('TRACK_LOCKED');
    const sequenceId = source.id, clipId = clip.id, oldPath = clip.properties.source.path, generation = this.metadataGeneration;
    const path = await this.services.chooseVideo(clip.properties.source.path); if (!path) return;
    const current=this.draft.draft;
    if(!this.mounted || generation!==this.metadataGeneration || current?.id!==sequenceId) return;
    await this.applyVideoPath(path,{sequenceId,clipId,oldPath});
  }

  private async chooseImage(): Promise<void> {
    const source = this.draft.draft, image = source && this.inspectedClip(source, 'image') as ImageClip | undefined;
    if (!source || !image) return;
    if (!this.services.chooseImage) throw new Error('IMAGE_PICKER_UNAVAILABLE');
    if (source.tracks.find(track => track.id === image.trackId)?.locked) throw new Error('TRACK_LOCKED');
    const sequenceId = source.id, clipId = image.id, oldPath = image.properties.source.path;
    const generation = ++this.imagePickerGeneration;
    const path = await this.services.chooseImage(oldPath);
    if (!path) return;
    const current = this.draft.draft;
    const latest = current?.clips.find(clip => clip.id === clipId && clip.type === 'image') as ImageClip | undefined;
    if (!this.mounted || generation !== this.imagePickerGeneration || current?.id !== sequenceId
      || this.selectedId !== clipId || !latest || latest.properties.source.path !== oldPath) return;
    await this.applyImagePath(path, { sequenceId, clipId, oldPath });
  }

  private async chooseButtonTexture(): Promise<void> {
    const source = this.draft.draft, button = source && this.inspectedClip(source, 'button') as ButtonClip | undefined;
    if (!source || !button) return;
    if (!this.services.chooseImage) throw new Error('IMAGE_PICKER_UNAVAILABLE');
    if (source.tracks.find(track => track.id === button.trackId)?.locked) throw new Error('TRACK_LOCKED');
    const sequenceId = source.id, clipId = button.id;
    const oldPath = button.properties.texture?.kind === 'foundry-file' ? button.properties.texture.path : '';
    const generation = ++this.imagePickerGeneration;
    const path = await this.services.chooseImage(oldPath);
    if (!path) return;
    const current = this.draft.draft;
    const latest = current?.clips.find((clip): clip is ButtonClip => clip.id === clipId && clip.type === 'button');
    const latestPath = latest?.properties.texture?.kind === 'foundry-file' ? latest.properties.texture.path : '';
    if (!this.mounted || generation !== this.imagePickerGeneration || current?.id !== sequenceId
      || this.selectedId !== clipId || !latest || latestPath !== oldPath) return;
    this.applyButtonTexturePath(path);
  }

  private applyButtonDesign(id: string): void {
    const design = buttonDesign(id);
    const source = this.draft.draft;
    const button = source && this.inspectedClip(source, 'button') as ButtonClip | undefined;
    if (!source || !button || !design || source.tracks.find(track => track.id === button.trackId)?.locked) return;

    const properties = {
      ...button.properties,
      shape: design.shape,
      backgroundColor: design.backgroundColor,
      color: design.color
    };
    if (design.texture) {
      const previous = properties.texture;
      properties.texture = previous?.kind === 'builtin' && previous.id === design.texture.id ? previous : design.texture;
    } else {
      delete properties.texture;
    }
    const replacement: ButtonClip = { ...button, properties };
    const next: SequenceV1 = { ...source, clips: source.clips.map(clip => clip.id === button.id ? replacement : clip) };

    // A design is a single explicit edit, independent from text-field history groups.
    this.fieldHistoryGroup = undefined;
    this.preview.stop();
    this.replaceDraft(next);
    this.paint();
    this.message(this.draft.dirty ? this.t('Unsaved') : '');
  }

  private applyButtonTexturePath(path: string): void {
    const source = this.draft.draft, button = source && this.inspectedClip(source, 'button') as ButtonClip | undefined;
    if (!source || !button) return;
    if (source.tracks.find(track => track.id === button.trackId)?.locked) throw new Error('TRACK_LOCKED');
    const normalized = path.trim();
    if (!normalized) throw new Error('BUTTON_TEXTURE_REQUIRED');
    if (button.properties.texture?.kind === 'foundry-file' && button.properties.texture.path === normalized) { this.paint(); return; }
    this.imagePickerGeneration++;
    this.imageHandles?.cancel();
    this.fieldHistoryGroup = undefined;
    const replacement: ButtonClip = { ...button, properties: { ...button.properties, texture: {
      kind: 'foundry-file', path: normalized,
      fit: button.properties.texture?.kind === 'foundry-file' ? button.properties.texture.fit : 'cover'
    } } };
    const next = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: replacement }, this.services.makeId);
    this.replaceDraft(next);
    this.paint();
    this.message(this.t('Unsaved'));
  }

  private async applyImagePath(path: string, expected?: { sequenceId: string; clipId: string; oldPath: string }): Promise<void> {
    const source = this.draft.draft;
    if (!source || expected && source.id !== expected.sequenceId) return;
    const image = (expected
      ? source.clips.find(clip => clip.id === expected.clipId && clip.type === 'image')
      : this.inspectedClip(source, 'image')) as ImageClip | undefined;
    if (expected && (!image || image.properties.source.path !== expected.oldPath)) return;
    if (!image || !path.trim()) throw new Error('IMAGE_SOURCE_REQUIRED');
    if (source.tracks.find(track => track.id === image.trackId)?.locked) throw new Error('TRACK_LOCKED');
    if (path === image.properties.source.path) { this.paint(); return; }
    this.imagePickerGeneration++;
    this.imageHandles?.cancel();
    this.fieldHistoryGroup = undefined;
    const replacement: ImageClip = {
      ...image,
      properties: { ...image.properties, source: { ...image.properties.source, path } }
    };
    this.replaceDraft(applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: replacement }, this.services.makeId));
    this.paint();
    this.message(this.t('Unsaved'));
  }

  private async chooseSolidAlpha(): Promise<void> {
    const source = this.draft.draft, solid = source && this.inspectedClip(source, 'solid') as SolidClip | undefined;
    if (!source || !solid) return;
    if (!this.services.chooseImage) throw new Error('IMAGE_PICKER_UNAVAILABLE');
    if (source.tracks.find(track => track.id === solid.trackId)?.locked) throw new Error('TRACK_LOCKED');
    const sequenceId = source.id, clipId = solid.id, oldPath = solid.properties.alphaMap?.path ?? '';
    const generation = ++this.imagePickerGeneration;
    const path = await this.services.chooseImage(oldPath);
    if (!path) return;
    const current = this.draft.draft;
    const latest = current?.clips.find((clip): clip is SolidClip => clip.id === clipId && clip.type === 'solid');
    if (!this.mounted || generation !== this.imagePickerGeneration || current?.id !== sequenceId
      || this.selectedId !== clipId || !latest || (latest.properties.alphaMap?.path ?? '') !== oldPath) return;
    this.applySolidAlphaPath(path);
  }

  private applySolidAlphaPath(path: string): void {
    const source = this.draft.draft, solid = source && this.inspectedClip(source, 'solid') as SolidClip | undefined;
    if (!source || !solid) return;
    if (source.tracks.find(track => track.id === solid.trackId)?.locked) throw new Error('TRACK_LOCKED');
    if (path === (solid.properties.alphaMap?.path ?? '')) { this.paint(); return; }
    const properties = { ...solid.properties };
    if (path === '') delete properties.alphaMap;
    else properties.alphaMap = { ...properties.alphaMap, kind: 'foundry-file', path };
    const replacement = { ...solid, properties } as SolidClip;
    const next = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: replacement }, this.services.makeId);
    this.imagePickerGeneration++;
    this.imageHandles?.cancel();
    this.fieldHistoryGroup = undefined;
    this.replaceDraft(next);
    this.paint();
    this.message(this.t('Unsaved'));
  }

  private resetImageMask(type: 'image' | 'solid' = 'image'): void {
    const source = this.draft.draft, image = source && this.inspectedClip(source, type) as ImageClip | SolidClip | undefined;
    if (!source || !image || source.tracks.find(track => track.id === image.trackId)?.locked) return;
    const rectangle = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] as const;
    const mask = rectangle.map((point, index) => ({ ...image.properties.mask[index], ...point })) as unknown as ImageClip['properties']['mask'];
    const replacement: ImageClip | SolidClip = image.type === 'image'
      ? { ...image, properties: { ...image.properties, mask } }
      : image.typeVersion === 2 ? { ...image, properties: { ...image.properties, mask } }
      : { ...image, properties: { ...image.properties, mask } };
    this.imageHandles?.cancel();
    this.fieldHistoryGroup = undefined;
    this.replaceDraft(applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: replacement }, this.services.makeId));
    this.paint();
    this.message(this.t('Unsaved'));
  }

  private changeSolidPattern(action: string): void {
    if (!this.readForm()) return;
    const source = this.draft.draft, clip = source && this.inspectedClip(source, 'solid') as SolidClip | undefined;
    if (!source || !clip?.properties.pattern || source.tracks.find(track => track.id === clip.trackId)?.locked) return;
    const pattern = action === 'solid-pattern-palette' ? resetPatternPalette(clip.properties.pattern)
      : { ...clip.properties.pattern, seed: (clip.properties.pattern.seed + 0x9e3779b9) >>> 0 };
    this.fieldHistoryGroup = undefined; this.imageHandles?.cancel();
    this.replaceDraft(applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: { ...clip, typeVersion: 2, properties: { ...clip.properties, pattern } } }, this.services.makeId));
    this.paint(); this.message(this.t('Unsaved'));
  }

  private async applyVideoPath(path: string, expected?: { sequenceId: string; clipId: string; oldPath: string }): Promise<void> {
    const source=this.draft.draft!;
    if(expected && source.id!==expected.sequenceId)return;
    const video=(expected?source.clips.find(clip=>clip.id===expected.clipId && clip.type==='video'):this.inspectedClip(source,'video')) as VideoClip | undefined;
    if(expected && (!video || video.properties.source.path!==expected.oldPath))return;
    if(!video || !path.trim()) throw new Error('VIDEO_SOURCE_REQUIRED');
    if(source.tracks.find(track=>track.id===video.trackId)?.locked)throw new Error('TRACK_LOCKED');
    const sequenceId=source.id, clipId=video.id, oldPath=video.properties.source.path;
    const generation=++this.metadataGeneration;
    this.metadataController?.abort(); const controller=new AbortController(); this.metadataController=controller;
    this.preview.stop(); this.message(this.t('ReadingVideo'));
    try {
      const metadata=await probeVideo(path,controller.signal);
      const current=this.draft.draft, old=current?.clips.find(c=>c.id===clipId && c.type==='video') as VideoClip|undefined;
      if(!this.mounted || controller.signal.aborted || generation!==this.metadataGeneration || !current || current.id!==sequenceId || !old || old.properties.source.path!==oldPath)return;
      const samePath = path === oldPath;
      const properties={...old.properties,source:{...old.properties.source,path},durationMs:metadata.durationMs};
      if (!samePath) delete properties.sourceRange;
      this.fieldHistoryGroup=undefined;
      const replacement = { ...old, typeVersion: videoTypeVersion(properties, old.typeVersion), properties };
      this.replaceDraft(samePath
        ? applyTimelineCommand(current, { kind: 'replace-clip', clip: replacement }, this.services.makeId)
        : applyEditorTimelineCommand(current, { kind: 'replace-clip', clip: replacement }, this.services.makeId));
      this.paint();this.message(this.t('VideoMetadataReady'));
    } catch(error) { if(!controller.signal.aborted && this.mounted && generation===this.metadataGeneration) { this.invalid=true;this.message(this.errorMessage(error),'error');this.updateButtons(); } }
    finally {if(this.metadataController===controller)this.metadataController=null;}
  }

  private videoPath(sequence: SequenceV1): string {
    return (this.inspectedClip(sequence, 'video') as VideoClip | undefined)?.properties.source.path ?? '';
  }

  private async chooseAudio(): Promise<void> {
    const source = this.draft.draft!, clip = this.inspectedClip(source, 'audio') as AudioClip | undefined;
    if (!clip) return;
    if (source.tracks.find(track => track.id === clip.trackId)?.locked) throw new Error('TRACK_LOCKED');
    if (!this.services.chooseAudio) throw new Error('AUDIO_PICKER_UNAVAILABLE');
    const sequenceId = source.id, clipId = clip.id, oldPath = clip.properties.source.path, generation = this.metadataGeneration;
    const path = await this.services.chooseAudio(oldPath); if (!path) return;
    const current = this.draft.draft, latest = current?.clips.find(item => item.id === clipId && item.type === 'audio') as AudioClip | undefined;
    if (!this.mounted || generation !== this.metadataGeneration || current?.id !== sequenceId || !latest || latest.properties.source.path !== oldPath) return;
    await this.applyAudioPath(path, { sequenceId, clipId, oldPath });
  }

  private async applyAudioPath(path: string, expected?: { sequenceId: string; clipId: string; oldPath: string }): Promise<void> {
    const source = this.draft.draft!;
    if (expected && source.id !== expected.sequenceId) return;
    const audio = (expected ? source.clips.find(clip => clip.id === expected.clipId && clip.type === 'audio') : this.inspectedClip(source, 'audio')) as AudioClip | undefined;
    if (expected && (!audio || audio.properties.source.path !== expected.oldPath)) return;
    if (!audio || !path.trim()) throw new Error('AUDIO_SOURCE_REQUIRED');
    if (source.tracks.find(track => track.id === audio.trackId)?.locked) throw new Error('TRACK_LOCKED');
    const sequenceId = source.id, clipId = audio.id, oldPath = audio.properties.source.path;
    const generation = ++this.metadataGeneration;
    this.metadataController?.abort(); const controller = new AbortController(); this.metadataController = controller;
    this.preview.stop(); this.message(this.t('ReadingAudio'));
    try {
      const metadata = await probeAudio(path, controller.signal);
      const current = this.draft.draft, old = current?.clips.find(item => item.id === clipId && item.type === 'audio') as AudioClip | undefined;
      if (!this.mounted || controller.signal.aborted || generation !== this.metadataGeneration || !current || current.id !== sequenceId || !old || old.properties.source.path !== oldPath) return;
      const properties = { ...old.properties, source: { ...old.properties.source, path }, durationMs: metadata.durationMs };
      if (path !== oldPath) delete properties.sourceRange;
      else if (properties.sourceRange && properties.sourceRange.outMs > metadata.durationMs) {
        const inMs = Math.min(properties.sourceRange.inMs, metadata.durationMs - 1);
        properties.sourceRange = { ...properties.sourceRange, inMs, outMs: metadata.durationMs };
      }
      const selectedSourceMs = properties.sourceRange
        ? properties.sourceRange.outMs - properties.sourceRange.inMs
        : metadata.durationMs;
      const replacement: AudioClip = old.typeVersion === 2 && properties.loop !== true && old.duration.milliseconds > selectedSourceMs
        ? { ...old, duration: { ...old.duration, milliseconds: selectedSourceMs }, properties }
        : { ...old, properties };
      this.replaceDraft(applyEditorTimelineCommand(current, { kind: 'replace-clip', clip: replacement }, this.services.makeId));
      this.paint(); this.message(this.t('AudioMetadataReady'));
    } catch (error) {
      if (!controller.signal.aborted && this.mounted && generation === this.metadataGeneration) { this.invalid = true; this.message(this.errorMessage(error), 'error'); this.updateButtons(); }
    } finally { if (this.metadataController === controller) this.metadataController = null; }
  }

  private audioPath(sequence: SequenceV1): string {
    return (this.inspectedClip(sequence, 'audio') as AudioClip | undefined)?.properties.source.path ?? '';
  }

  private async inspectCurrentVideo(): Promise<void> {
    const sequence = this.draft.draft;
    const video = sequence && this.inspectedClip(sequence, 'video') as VideoClip | undefined;
    if (!sequence || !video || !video.properties.source.path) {
      this.message(this.t('VideoPathRequired'), 'error');
      return;
    }
    const path = video.properties.source.path;
    const clipId = video.id, sequenceId = sequence.id;
    const generation = ++this.metadataGeneration;
    this.metadataController?.abort();
    const controller = new AbortController();
    this.metadataController = controller;
    this.message(this.t('ReadingVideo'));
    try {
      const metadata = await probeVideo(path, controller.signal);
      if (!this.mounted || generation !== this.metadataGeneration || controller.signal.aborted) return;
      const current = this.draft.draft;
      const currentVideo = current?.clips.find(c=>c.id===clipId && c.type==='video') as VideoClip | undefined;
      if (!current || current.id !== sequenceId || !currentVideo || currentVideo.properties.source.path !== path) return;
      const updated = { ...currentVideo, properties: { ...currentVideo.properties, durationMs: metadata.durationMs } };
      this.fieldHistoryGroup=undefined;
      this.replaceDraft(applyEditorTimelineCommand(current, { kind: 'replace-clip', clip: updated }, this.services.makeId));
      this.invalid = false;
      this.paint();
      this.message(this.t('VideoMetadataReady'));
    } catch (error) {
      if (controller.signal.aborted || !this.mounted || generation !== this.metadataGeneration) return;
      // A failed probe keeps the entered path and the rest of the user's draft.
      this.message(this.errorMessage(error), 'error');
      this.invalid = true;
      this.updateButtons();
    } finally {
      if (this.metadataController === controller) this.metadataController = null;
    }
  }

  private async inspectCurrentAudio(): Promise<void> {
    const sequence = this.draft.draft;
    const audio = sequence && this.inspectedClip(sequence, 'audio') as AudioClip | undefined;
    if (!sequence || !audio || !audio.properties.source.path) {
      this.message(this.t('AudioPathRequired'), 'error');
      return;
    }
    await this.applyAudioPath(audio.properties.source.path, { sequenceId: sequence.id, clipId: audio.id, oldPath: audio.properties.source.path });
  }

  private cancelMediaWork(): void {
    this.cancelMetadataProbe();
    this.imagePickerGeneration++;
    this.imageHandles?.cancel();
    this.clearStill();
  }

  private cancelMetadataProbe(): void {
    this.metadataGeneration++;
    this.metadataController?.abort();
    this.metadataController = null;
  }

  private async ensureMediaMetadata(): Promise<void> {
    const snapshot = this.draft.draft!;
    const controller = new AbortController(); this.metadataController?.abort(); this.metadataController=controller;
    const generation = ++this.metadataGeneration;
    const durations=new Map<string,number>();
    try {
      for (const media of snapshot.clips.filter((clip): clip is VideoClip | AudioClip => clip.type === 'video' || clip.type === 'audio')) {
        const metadata = await (media.type === 'audio' ? probeAudio(media.properties.source.path, controller.signal) : probeVideo(media.properties.source.path, controller.signal));
        const current=this.draft.draft, clip=current?.clips.find(c=>c.id===media.id && c.type===media.type) as VideoClip | AudioClip | undefined;
        if (!this.mounted || controller.signal.aborted || generation!==this.metadataGeneration || !current || current.id!==snapshot.id || !clip || clip.properties.source.path!==media.properties.source.path) throw new Error('MEDIA_PREPARATION_CANCELLED');
        durations.set(clip.id,metadata.durationMs);
      }
      const current=this.draft.draft!;
      const clips: SequenceClip[] = current.clips.map((clip): SequenceClip => {
        const durationMs=durations.get(clip.id);
        if (durationMs === undefined || (clip.type !== 'video' && clip.type !== 'audio')) return clip;
        if (clip.type === 'video') {
          const properties = { ...clip.properties, durationMs };
          if (properties.sourceRange && properties.sourceRange.outMs > durationMs) delete properties.sourceRange;
          return { ...clip, properties };
        }
        const properties = { ...clip.properties, durationMs };
        if (properties.sourceRange && properties.sourceRange.outMs > durationMs) delete properties.sourceRange;
        return { ...clip, properties };
      });
      const full={...current,clips};
      // Probing imported media may resolve several unknown durations together.
      this.fieldHistoryGroup=undefined;
      this.replaceDraft(current.end.kind === 'fixed' && current.end.automatic === true ? enableAutomaticEnd(full) : full);
      this.paint();
    } finally { if(this.metadataController===controller)this.metadataController=null; }
  }

  private async validateForPlayback(): Promise<CompiledSequence> {
    await this.ensureMediaMetadata();
    const sequence=this.draft.draft!, conflicts=timelineConflicts(sequence);
    this.showTimingConflicts(conflicts);
    if (conflicts.length) { this.invalid=true; this.updateButtons(); throw new Error(conflicts[0]!.code); }
    const plan=compileSequence(sequence); this.invalid=false; this.updateButtons(); return plan;
  }

  private showTimingConflicts(conflicts: ReturnType<typeof timelineConflicts>): void {
    const list=this.root?.querySelector<HTMLElement>('[data-stagecraft-timing-errors]'); if (!list) return;
    list.replaceChildren();
    for(const conflict of conflicts) { const line=document.createElement('p'); line.textContent=this.errorMessage(conflict); list.append(line); }
    list.hidden=conflicts.length===0;
  }

  private readElementValues(source: SequenceV1, editField?: string): ReturnType<typeof readElementValues> {
    return readElementValues(this.inspectorForm(), source, selectedClip(source, this.selectedId), this.lastNonMediaEnd,
      () => this.videoDefaultBox(source), editField);
  }

  private templateEditingAllowed(): boolean {
    return this.mounted && !this.busy && !this.invalid && ['idle', 'ended'].includes(this.preview.getState().phase)
      && ['idle', 'ended'].includes(this.localPhase);
  }

  private templateSelection(): TemplateLibrarySelection | undefined {
    this.colorInputs?.finish();
    const sequence = this.draft.draft, clip = sequence && selectedClip(sequence, this.selectedId);
    if (!this.templateEditingAllowed() || !sequence || !clip || sequence.tracks.find(track => track.id === clip.trackId)?.locked) return;
    return { sequence, clip };
  }

  private templatePlacement(type?: SequenceClip['type']): TemplateLibraryPlacement | undefined {
    this.colorInputs?.finish();
    const sequence = this.draft.draft;
    if (!this.templateEditingAllowed() || !sequence) return;
    const kind = type === 'audio' ? 'audio' : 'visual';
    const current = selectedClip(sequence, this.selectedId);
    const candidates = sequence.tracks.filter(track => !track.locked && track.kind === kind);
    const track = candidates.find(track => track.id === current?.trackId) ?? candidates[0];
    return { sequence, trackId: track?.id ?? '__template-new-track__', playheadMs: this.playheadMs };
  }

  private insertTemplateClip(clip: SequenceClip, expected: TemplateLibraryPlacement): void {
    this.colorInputs?.finish();
    const source = this.draft.draft;
    if (!this.templateEditingAllowed() || !source || !sameJsonData(source, expected.sequence) || this.playheadMs !== expected.playheadMs) throw new Error('TEMPLATE_CONTEXT_CHANGED');
    this.numericScrubbers?.cancel(); this.imageHandles?.cancel(); this.fieldHistoryGroup = undefined;
    let base = source, trackId = clip.trackId;
    if (!base.tracks.some(track => track.id === trackId)) {
      base = applyEditorTimelineCommand(base, { kind: 'add-track', trackKind: clip.type === 'audio' ? 'audio' : 'visual' }, this.services.makeId);
      trackId = base.tracks.find(track => !source.tracks.some(previous => previous.id === track.id))!.id;
    }
    const next = applyEditorTimelineCommand(base, { kind: 'insert-clip', clip: { ...clip, trackId } }, this.services.makeId);
    this.replaceDraft(next); this.selectClip(clip.id); this.message(this.t('Unsaved'));
  }

  private applyTemplateAnimation(clip: SequenceClip, expected: TemplateLibrarySelection): void {
    this.colorInputs?.finish();
    const source = this.draft.draft;
    if (!this.templateEditingAllowed() || !source || !sameJsonData(source, expected.sequence) || this.selectedId !== expected.clip.id
      || clip.id !== expected.clip.id || clip.type !== expected.clip.type || clip.trackId !== expected.clip.trackId) throw new Error('TEMPLATE_CONTEXT_CHANGED');
    this.numericScrubbers?.cancel(); this.imageHandles?.cancel(); this.fieldHistoryGroup = undefined;
    this.replaceDraft(applyEditorTimelineCommand(source, { kind: 'replace-clip', clip }, this.services.makeId));
    this.paint(); this.message(this.t('Unsaved'));
  }

  private videoDefaultBox(sequence: SequenceV1): NonNullable<VideoClip['properties']['box']> {
    const viewer = this.root?.querySelector<HTMLElement>('[data-stagecraft-viewer]');
    return legacyVideoBox({ width: viewer?.clientWidth ?? 0, height: viewer?.clientHeight ?? 0 }, sequence.composition);
  }

  private updateAudioDurationBounds(clampNonLooping = false): void {
    const sequence = this.draft.draft;
    const clip = sequence ? this.inspectedClip(sequence, 'audio') as AudioClip | undefined : undefined;
    this.inspectorAvailability().updateAudioDurationBounds(sequence, clip, this.busy, clampNonLooping);
  }

  private replaceDraft(next: SequenceV1): void {
    this.numericScrubbers?.cancel();
    const current = this.draft.draft;
    if (current && !sameJsonData(current, next)) this.draft.replace(next, this.fieldHistoryGroup ? { historyGroup: this.fieldHistoryGroup } : undefined);
    this.invalid = false;
    if (this.draft.draft) this.timeline?.render(this.draft.draft, this.selectedId, this.playheadMs, this.selectedBreakId);
    this.updateButtons();
  }

  private applyTriggerSettings(value: TriggerSettingsValue): void {
    this.colorInputs?.finish();
    const source = this.draft.draft;
    if (!source || this.busy) return;
    try {
      const withAudience = withSequenceAudience(source, value.audience);
      const next = withSequenceAutomation(withAudience, value.automation);
      if (sameJsonData(source, next)) return;
      // Each authoring action gets one independent undo entry, even after a field has focus.
      this.fieldHistoryGroup = undefined;
      this.draft.replace(next);
      this.invalid = false;
      this.message(this.draft.dirty ? this.t('Unsaved') : '');
      this.paint();
    } catch (error) {
      this.triggerSettings?.update(source);
      this.message(this.errorMessage(error), 'error');
    }
  }

  private imageHandleState(): VisualHandleState {
    const sequence = this.draft.draft;
    const selected = sequence ? selectedClip(sequence, this.selectedId) : undefined;
    const clip = selected && ['image', 'solid', 'text', 'video', 'button'].includes(selected.type) ? selected as EditableVisualClip : null;
    const track = clip && sequence?.tracks.find(item => item.id === clip.trackId);
    const previewIdle = ['idle', 'ended'].includes(this.previewPhase);
    const localIdle = ['idle', 'ended'].includes(this.localPhase);
    return {
      sequence, clip, positionMs: this.playheadMs,
      editable: this.mounted && !this.busy && !this.invalid && previewIdle && localIdle
        && !!track && track.enabled && !track.locked
    };
  }

  private numericScrubberContext(input: HTMLInputElement): NumericScrubberContext {
    const sequence = this.draft.draft;
    const disabled = input.disabled || input.readOnly || (input.matches?.(':disabled') ?? false);
    const previewEditable = this.previewPhase !== 'preparing';
    const localIdle = ['idle', 'ended'].includes(this.localPhase);
    const trackLocked = !!sequence && !!selectedClip(sequence, this.selectedId)
      && sequence.tracks.find(track => track.id === selectedClip(sequence, this.selectedId)?.trackId)?.locked === true;
    const isClipField = /^(bars|text|image|solid|video|audio|button)-/.test(input.name);
    const editable = this.mounted && !!sequence && !this.busy && !this.invalid && previewEditable && localIdle
      && !disabled && (!isClipField || !trackLocked)
      && this.root?.contains(input) === true;
    return {
      editable,
      identity: `${sequence?.id ?? ''}|${this.selection.kind}|${this.selectedId ?? ''}|${this.selectedBreakId ?? ''}|${sequence ? stableJson(sequence) : ''}`
    };
  }

  /** Only private, prepared preview runs accept numeric edits. Other playback
   * keeps its immutable snapshot; resource-changing edits use the existing path. */
  private liveNumericPreview(fieldName: string | undefined): boolean {
    const field = fieldName ? this.field<HTMLInputElement>(fieldName) : undefined;
    return field?.type === 'number' && ['playing', 'holding', 'paused', 'exiting'].includes(this.previewPhase)
      && ['idle', 'ended'].includes(this.localPhase);
  }

  private beginColorPreview(input: HTMLInputElement): ColorPreviewSession | undefined {
    const source = this.draft.draft;
    const clip = source && selectedClip(source, this.selectedId);
    if (!source || !clip || !this.root || this.busy || !this.mounted || input.disabled
      || input.matches(':disabled') || !this.root.contains(input)
      || source.tracks.find(track => track.id === clip.trackId)?.locked) return;
    // Validate once on opening a gesture, rather than scanning the entire form
    // for every color delivered by the native dialog.
    if ([...this.root.querySelectorAll<FieldElement>('[name]')].some(field => field.name !== 'sequence-name'
      && !field.disabled && !field.checkValidity())) {
      this.readForm(input.name);
      return;
    }
    if (!['idle', 'ended'].includes(this.preview.getState().phase)) this.preview.stop();
    const fingerprint = stableJson(source);
    const current = (): boolean => this.mounted && !this.busy && !input.disabled && !input.matches(':disabled')
      && this.root?.contains(input) === true && this.selectedId === clip.id
      && stableJson(this.draft.draft) === fingerprint;
    const group = this.services.makeId();
    return {
      preview: value => {
        if (!current()) return;
        const changed = this.previewClipColor(clip, input.name, value);
        if (changed) this.drawStill({ ...source, clips: source.clips.map(item => item.id === clip.id ? changed : item) });
      },
      commit: value => {
        if (!current()) { if (this.mounted && !this.busy) this.paint(); return; }
        // Do not assign even an equal value back into an open native dialog.
        if (input.value !== value) input.value = value;
        this.fieldHistoryGroup = group;
        if (!this.readForm(input.name)) this.drawStill();
        this.fieldHistoryGroup = undefined;
      }
    };
  }

  /** A live color cannot affect timing, tracks or media preparation. Patch only
   * that property for the still renderer; the final form read remains canonical. */
  private previewClipColor(clip: SequenceClip, field: string, value: string): SequenceClip | undefined {
    if (!/^#[0-9a-f]{6}$/i.test(value)) return;
    if (clip.type === 'button') {
      if (field === 'button-color') return { ...clip, properties: { ...clip.properties, color: value } };
      if (field === 'button-background') return { ...clip, properties: { ...clip.properties, backgroundColor: value } };
      for (const effect of ['outline', 'shadow', 'glow'] as const) {
        if (field === `button-${effect}-color` && clip.properties[effect]) {
          return { ...clip, properties: { ...clip.properties, [effect]: { ...clip.properties[effect], color: value } } };
        }
      }
    }
    if ((clip.type === 'text' && field === 'title-color') || (clip.type === 'solid' && field === 'solid-color')) {
      return { ...clip, properties: { ...clip.properties, color: value } } as SequenceClip;
    }
    if (clip.type === 'solid' && /^solid-pattern-color-[0-2]$/.test(field) && clip.properties.pattern) {
      const pattern = clip.properties.pattern;
      return { ...clip, properties: { ...clip.properties, pattern: { ...pattern,
        colors: pattern.colors.map((color, index) => index === Number(field.slice(-1)) ? value : color) as unknown as AnimatedPattern['colors'] } } } as SolidClip;
    }
    if (clip.type === 'video' && field === 'video-keying-color') {
      const keying = clip.properties.keying;
      if (keying) return { ...clip, properties: { ...clip.properties, keying: { ...keying, color: value } } };
    }
    if (clip.type === 'text' || clip.type === 'image' || clip.type === 'solid') {
      const prefix = clip.type === 'text' ? '' : clip.type + '-';
      for (const effect of ['outline', 'shadow', 'glow'] as const) {
        if (field === `${prefix}${effect}-color` && clip.properties[effect]) {
          return { ...clip, properties: { ...clip.properties, [effect]: { ...clip.properties[effect], color: value } } } as SequenceClip;
        }
      }
    }
    return;
  }

  private previewImageClip(clip: EditableVisualClip): void {
    const sequence = this.draft.draft;
    if (!sequence || this.selectedId !== clip.id
      || !sequence.clips.some(item => item.id === clip.id && item.type === clip.type)) return;
    this.drawStill({ ...sequence, clips: sequence.clips.map(item => item.id === clip.id ? clip : item) });
  }

  private commitImageHandleEdit(sequenceId: string, clipId: string, replacement: EditableVisualClip): boolean {
    const source = this.draft.draft;
    const state = this.imageHandleState();
    const image = source?.clips.find(item => item.id === clipId && item.type === replacement.type);
    if (!source || source.id !== sequenceId || !state.editable || state.clip?.id !== clipId || !image
      || replacement.id !== clipId || replacement.trackId !== image.trackId) return false;
    this.fieldHistoryGroup = undefined;
    const next = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: replacement }, this.services.makeId);
    if (sameJsonData(next, source)) return false;
    this.replaceDraft(next);
    this.paint();
    this.message(this.t('Unsaved'));
    return true;
  }

  private readBreakPosition(previewOnly = false, preservePreview = false): boolean {
    const source = this.draft.draft, field = this.field('break-position'), id = this.selectedBreakId;
    if (!source || !field || field.disabled || !id) return true;
    if (this.checkFormFields().includes(field) || field.value.trim() === '' || !Number.isFinite(Number(field.value))) {
      if (!previewOnly) {
        this.invalid = true;
        this.updateButtons();
      }
      return false;
    }
    try {
      const next = applyEditorTimelineCommand(source, { kind: 'move-break', breakId: id, positionMs: Math.round(Number(field.value) * 1000) }, this.services.makeId);
      const live = this.liveNumericPreview('break-position');
      if (live) {
        if (!this.preview.updatePreview(next) && !['idle', 'ended'].includes(this.preview.getState().phase)) return false;
      } else if (!preservePreview || !sameJsonData(source, next)) this.preview.stop();
      if (!previewOnly) this.replaceDraft(next);
      this.message(this.draft.dirty ? this.t('Unsaved') : '');
      this.drawStill(previewOnly ? next : undefined);
      return true;
    } catch (error) {
      if (!previewOnly) {
        this.invalid = true;
        this.message(this.errorMessage(error), 'error');
        this.updateButtons();
      }
      return false;
    }
  }

  private finishBreakPosition(): void {
    if (this.busy || !this.readBreakPosition()) return;
    const marker = this.draft.draft?.breaks?.find(item => item.id === this.selectedBreakId);
    if (marker) this.setValue('break-position', String(marker.positionMs / 1000));
  }

  private readForm(editField?: string, previewOnly = false, preservePreview = false): boolean {
    this.colorInputs?.finish();
    if (editField && this.field(editField)?.disabled) return true;
    if (!previewOnly && (editField === 'solid-polygon-preset' || editField === 'solid-pattern-preset'
      || /^(bars|text|image|solid|video|audio|button)-(entrance|exit)-preset$/.test(editField ?? ''))) this.fieldHistoryGroup = undefined;
    if (editField === 'break-position') return this.readBreakPosition(previewOnly, preservePreview);
    if (!editField && !this.readBreakPosition(previewOnly, preservePreview)) return false;
    const source = this.draft.draft;
    if (!source || !this.root) return false;
    this.prepareMediaFadePreset(source, editField);
    this.prepareAnimationPreset(source, editField);
    if (editField === 'bars-duration-mode' || editField === 'text-duration-mode' || editField === 'image-duration-mode' || editField === 'solid-duration-mode' || editField === 'button-duration-mode' ||
      (editField?.startsWith('bars-') || editField?.startsWith('text-') || editField?.startsWith('image-') || editField?.startsWith('solid-') || editField?.startsWith('video-') || editField?.startsWith('button-')) && editField.endsWith('-preset')) this.paintInspector(editField);
    else if (editField === 'button-action' || editField === 'button-decision-group' || editField === 'button-texture') this.paintInspector(editField);
    if (this.checkFormFields().length) {
      if (!previewOnly) {
        this.invalid = true;
        this.showTimingConflicts([]);
        this.updateButtons();
      }
      return false;
    }
    try {
      const live = this.liveNumericPreview(editField);
      if (!preservePreview && !live) this.preview.stop();
      const values = this.readElementValues(source, editField);
      const selectsBreakBehavior = editField === 'video-on-break' || editField === 'audio-on-break';
      const choosesIndefiniteAudio = editField === 'audio-loop-indefinitely'
        && this.field<HTMLInputElement>('audio-loop-indefinitely')?.checked === true;
      const choosesManualEnd = editField === 'ending' && this.field<HTMLSelectElement>('ending')?.value === 'manual';
      const base = getPlaybackSchemaVersion(source) === 1 && (selectsBreakBehavior || choosesIndefiniteAudio || choosesManualEnd)
        ? upgradeSequenceToBreaks(source) : source;
      let changed: SequenceV1 = { ...base, name: values.name, presentation: values.presentation };
      const old = selectedClip(base, this.selectedId);
      if (base !== source && old?.type === 'audio' && values.audio) {
        // Legacy form defaults do not describe the migrated clip's effective
        // loops. Keep the explicit field edit, and use the adopted semantics
        // for fields the user did not change in this action.
        const adopted = audioValuesFromClip(old);
        values.audio = { ...values.audio,
          loop: editField === 'audio-loop-indefinitely' ? values.audio.loop : adopted.loop,
          loopIndefinitely: editField === 'audio-loop-indefinitely' ? values.audio.loopIndefinitely : adopted.loopIndefinitely,
          ...(editField === 'audio-on-break' ? {} : { onBreak: old.properties.onBreak! })
        };
      }
      if (old && !base.tracks.find(t=>t.id===old.trackId)?.locked) {
        let clip = patchInspectedClip(old, values);
        const targetTrack = this.field('clip-track')?.value ?? old.trackId;
        const target = base.tracks.find(track => track.id === targetTrack);
        if (!target || target.kind !== (clip.type === 'audio' ? 'audio' : 'visual')) throw new Error('INCOMPATIBLE_TRACK');
        clip = { ...clip, trackId: targetTrack };
        if (clip.type === 'video' && clip.properties.durationMs !== undefined) {
          const inMs=Math.round(Number(this.field('video-in')?.value ?? 0)*1000);
          const outMs=Math.round(Number(this.field('video-out')?.value ?? clip.properties.durationMs/1000)*1000);
          const properties = { ...clip.properties };
          if (inMs === 0 && outMs === clip.properties.durationMs) delete properties.sourceRange;
          else properties.sourceRange = { ...clip.properties.sourceRange, inMs, outMs };
          clip = { ...clip, typeVersion: videoTypeVersion(properties, clip.typeVersion), properties };
        }
        if(!sameJsonData(clip, old)) changed = applyEditorTimelineCommand(changed, {kind:'replace-clip',clip}, this.services.makeId);
      }
      // Only an explicit ending edit may replace the policy. Clip timing may have
      // just converted a legacy endpoint, while its selector still shows media/fixed.
      if (editField === 'ending' || editField === 'sequence-duration' || editField === 'end-media') {
        const ending = this.field<HTMLSelectElement>('ending')?.value;
        if (ending === 'automatic') changed = enableAutomaticEnd(changed);
        else {
          const end = ending === 'media'
            ? { ...source.end, kind: 'media' as const, clipId: this.field('end-media')?.value ?? '' }
            : values.end;
          if (!sameJsonData(end, changed.end)) changed = applyEditorTimelineCommand(changed, { kind: 'set-end', end }, this.services.makeId);
        }
      }
      const conflicts = timelineConflicts(changed);
      this.showTimingConflicts(conflicts);
      if (conflicts.some(conflict => !['MEDIA_METADATA_REQUIRED','UNKNOWN_DURATION','UNKNOWN_SEQUENCE_END'].includes(conflict.code))) {
        if (!previewOnly) {
          this.invalid = true;
          this.message(this.t('InvalidFields'), 'error');
          this.updateButtons();
        }
        return false;
      }
      if (live) {
        if (!this.preview.updatePreview(changed) && !['idle', 'ended'].includes(this.preview.getState().phase)) return false;
      } else if (preservePreview && !sameJsonData(source, changed)) this.preview.stop();
      if (!previewOnly) this.replaceDraft(changed);
      this.paintEnding(changed, editField);
      const selected = selectedClip(changed, this.selectedId);
      if (!previewOnly && selected?.type === 'button' && selected.properties.action.kind === 'choice') {
        const groupSelect = this.field<HTMLSelectElement>('button-decision-group');
        if (groupSelect?.value === '__new__') {
          this.paintButtonDecisionGroups(changed, selected);
          groupSelect.value = `existing:${selected.properties.action.decisionId}`;
          this.setValue('button-decision-name', '');
          this.paintInspector();
        }
      }
      if (selected) {
        if (selected.type === 'bars') this.paintBarsAnimations(selected, editField);
        else if (selected.type === 'text') this.paintTextAnimations(selected, editField);
        else if (selected.type === 'image') this.paintImageAnimations(selected, editField);
        else if (selected.type === 'solid') {
          this.paintMotionAnimations('solid', selected, editField);
          if (editField === 'solid-polygon-preset' || editField === 'solid-pattern-preset') this.paintSolidFields(changed);
        } else if (selected.type === 'video') this.paintVideoAnimations(selected, editField);
        else if (selected.type === 'button') this.paintMotionAnimations('button', selected, editField);
        else if (editField !== selected.type + '-entrance') this.setValue(selected.type + '-entrance', String((selected.entrance.preset === 'fade' ? selected.entrance.durationMs : 0) / 1000));
        if (selected.type === 'audio' && editField !== 'audio-exit') this.setValue('audio-exit', String((selected.exit.preset === 'fade' ? selected.exit.durationMs : 0) / 1000));
      }
      if (selected && selected.type !== 'video' && selected.duration.kind === 'fixed' && old?.duration.kind === 'sequence-end') {
        this.setValue(selected.type + '-duration-mode', 'fixed');
        if (editField !== selected.type + '-duration') this.setValue(selected.type + '-duration', String(selected.duration.milliseconds / 1000));
      }
      if (selected?.trackId !== old?.trackId || changed.tracks.length !== source.tracks.length) this.paintTrackPicker(changed, selected);
      if (this.videoPath(source) !== this.videoPath(changed)) {
        this.setOutput('[data-stagecraft-video-duration]', this.t('MetadataMissing'));
        this.clearStill();
        this.cancelMetadataProbe();
      }
      if (this.audioPath(source) !== this.audioPath(changed)) {
        this.setOutput('[data-stagecraft-audio-duration]', this.t('MetadataMissing'));
        this.clearStill();
        this.cancelMetadataProbe();
      }
      this.message(this.draft.conflict ? this.t('Conflict') : this.draft.dirty ? this.t('Unsaved') : '');
      if (!previewOnly) this.updateButtons();
      this.drawStill(previewOnly ? changed : undefined);
      return true;
    } catch (error) {
      if (!previewOnly) {
        this.invalid = true;
        this.message(this.errorMessage(error), 'error');
        this.updateButtons();
      }
      return false;
    }
  }

  private async refreshList(): Promise<void> { this.items = await this.services.repository.list(); }

  private checkFormFields(show: true | readonly FieldElement[] = []): FieldElement[] {
    return this.formValidation.check([...this.root?.querySelectorAll<FieldElement>('[name]') ?? []]
      .filter(field => field.name !== 'sequence-name'), show);
  }

  private revealInvalidField(field: FieldElement): void {
    const page = field.closest<HTMLElement>('[data-stagecraft-inspector-page]')?.dataset.stagecraftInspectorPage;
    if (page) this.root?.querySelector<HTMLButtonElement>(`[data-stagecraft-inspector-tab="${page}"]`)?.click();
    const section = field.closest<HTMLElement>('[data-stagecraft-clip-section-page]')?.dataset.stagecraftClipSectionPage;
    if (section) this.root?.querySelector<HTMLButtonElement>(`[data-stagecraft-clip-section-tab="${section}"]`)?.click();
  }

  private async deleteCurrentSequence(): Promise<void> {
    const sequence = this.draft.draft;
    const expectedRevision = this.draft.expectedRevision;
    if (!sequence || expectedRevision === null) return;

    const id = sequence.id;
    const savedName = this.items.find(item => item.id === id)?.name ?? sequence.name;
    const hasUnsavedChanges = this.draft.dirty || this.invalid;
    const actionSerial = this.actionSerial;
    const previousIndex = this.items.findIndex(item => item.id === id);
    const confirmed = await this.services.confirmDeleteSequence(savedName, hasUnsavedChanges);
    if (!this.mounted || actionSerial !== this.actionSerial) return;
    if (this.draft.draft?.id !== id || this.draft.expectedRevision !== expectedRevision || !confirmed) return;

    await this.services.repository.delete(id, expectedRevision);
    if (!this.mounted || actionSerial !== this.actionSerial) return;

    this.cancelMediaWork();
    this.preview.stop();
    this.lastNonMediaEnd = { kind: 'fixed', durationMs: 5_000 };
    this.selectedId = null;
    this.playheadMs = 0;
    this.activeElement = 'bars';
    this.fieldHistoryGroup = undefined;
    this.renaming = false;
    this.invalid = false;
    this.items = this.items.filter(item => item.id !== id);
    this.draft.create(this.t('DefaultName'), { automaticEnd: true });

    let refreshError: unknown;
    try {
      const refreshed = await this.services.repository.list();
      if (!this.mounted || actionSerial !== this.actionSerial) return;
      this.items = refreshed;
    }
    catch (error) {
      if (!this.mounted || actionSerial !== this.actionSerial) return;
      refreshError = error;
      this.items = this.items.filter(item => item.id !== id);
    }
    if (!this.mounted || actionSerial !== this.actionSerial) return;

    let loadError: unknown;
    if (refreshError === undefined && this.items.length) {
      const start = Math.min(Math.max(previousIndex, 0), this.items.length - 1);
      const ordered = [...this.items.slice(start), ...this.items.slice(0, start)];
      for (const item of ordered) {
        if (item.issue) continue;
        try {
          await this.draft.load(item.id, { shouldApply: () => this.mounted && actionSerial === this.actionSerial });
          break;
        } catch (error) { loadError ??= error; }
        if (!this.mounted || actionSerial !== this.actionSerial) return;
      }
    }
    if (!this.mounted || actionSerial !== this.actionSerial) return;
    this.paint();
    if (refreshError !== undefined) this.message(this.errorMessage(refreshError), 'error');
    else if (loadError !== undefined && this.draft.expectedRevision === null) this.message(this.errorMessage(loadError), 'error');
    else this.message(this.draft.dirty ? this.t('Unsaved') : '');
    await this.services.refreshSequenceShortcuts?.();
  }

  private beginRename(): void {
    const sequence = this.draft.draft, field = this.field('sequence-name');
    if (this.renaming || !sequence || !field) return;
    this.renaming = true;
    field.value = sequence.name;
    this.updateButtons();
    field.focus(); field.select();
  }

  private finishRename(commit: boolean): void {
    if (!this.renaming) return;
    const field = this.field('sequence-name'), sequence = this.draft.draft;
    this.renaming = false;
    if (commit && field && sequence) {
      try {
        this.draft.replace({ ...sequence, name: field.value });
        this.message(this.draft.dirty ? this.t('Unsaved') : '');
      } catch (error) { this.message(this.errorMessage(error), 'error'); }
    }
    this.fieldHistoryGroup = undefined;
    if (field && sequence) field.value = this.draft.draft?.name ?? sequence.name;
    this.paintSequencePicker();
    this.updateButtons();
  }

  private paintSequencePicker(): void {
    const picker = this.root?.querySelector<HTMLSelectElement>('[data-stagecraft-sequence-picker]');
    if (!picker) return;
    const current = this.draft.draft;
    const items = [...this.items];
    if (current && !items.some(item => item.id === current.id)) items.unshift(current);
    picker.replaceChildren();
    for (const item of items) {
      const option = document.createElement('option'); option.value = item.id;
      option.textContent = item.id === current?.id ? current.name : item.name;
      if (item.id === current?.id && this.draft.expectedRevision === null) option.textContent += ' (' + this.t('Unsaved') + ')';
      if (item.issue) { option.textContent += ' (' + this.t('Unreadable') + ')'; option.disabled = true; }
      picker.append(option);
    }
    if (current) picker.value = current.id;
  }

  private paintLibrary(): void {
    const list = this.root?.querySelector<HTMLElement>('[data-stagecraft-library]');
    if (!list) return;
    list.replaceChildren();
    for (const preset of EFFECT_PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.stagecraftAction = 'add-preset';
      button.dataset.presetId = preset.id;
      button.className = 'stagecraft-preset-row';
      const sequence = this.draft.draft;
      const breakLimit = preset.type === 'break' && (sequence?.breaks?.length ?? 0) >= SEQUENCE_LIMITS.breaks
        && !sequence?.breaks?.some(marker => marker.positionMs === this.playheadMs);
      button.title = this.t(breakLimit ? 'BreakLimit' : preset.type === 'button' ? 'AddButton' : preset.type === 'break' ? 'AddBreakHint' : preset.type === 'bars' ? 'AddBars' : preset.type === 'text' ? 'AddTitle' : preset.type === 'audio' ? 'AddAudio' : preset.type === 'image' ? 'AddImage' : preset.id === 'animated-surface' ? 'AddAnimatedSurface' : preset.type === 'solid' ? 'AddColorSurface' : 'AddVideo');
      button.setAttribute('aria-label', button.title);
      const icon = document.createElement('i'); icon.className = 'fa-solid ' + preset.icon; icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.textContent = this.t(preset.label);
      button.append(icon, name);
      button.disabled = this.busy || !sequence || breakLimit || preset.type === 'image' && !this.services.chooseImage;
      list.append(button);
    }
  }

  private paint(): void {
    if (!this.root) return;
    this.formValidation.clearAll();
    this.numericScrubbers?.cancel();
    this.paintLibrary();
    this.paintSequencePicker();
    const value = this.draft.draft;
    if (!value) return;
    this.previewViewport?.setComposition(value.composition);
    if (this.selection.kind === 'break' && !value.breaks?.some(marker => marker.id === this.selectedBreakId)) this.selection = { kind: 'none' };
    if (this.selection.kind !== 'break' && !value.clips.some(c=>c.id===this.selectedId)) this.selectedId=value.clips[0]?.id ?? null;
    const selected=selectedClip(value,this.selectedId); if(selected)this.activeElement=selected.type;
    if (!this.renaming) this.setValue('sequence-name', value.name);
    this.paintTrackPicker(value, selected);
    this.setOutput('[data-stagecraft-selected-type]', selected?this.t(selected.type==='bars'?'Bars':selected.type==='text'?'TitleElement':selected.type==='audio'?'Audio':selected.type==='image'?'Image':selected.type==='solid'?(selected.properties.pattern?'AnimatedSurface':'ColorSurface'):selected.type==='button'?'Button':'Video'):this.t('SelectClip'));
    const endSelect=this.field<HTMLSelectElement>('end-media'); if(endSelect) { endSelect.replaceChildren(); for(const clip of value.clips.filter((c):c is VideoClip|AudioClip=>c.type==='video'||c.type==='audio')) {const option=document.createElement('option');option.value=clip.id;option.textContent=clip.properties.source.path.split('/').at(-1)??clip.id;endSelect.append(option);} if(value.end.kind==='media')endSelect.value=value.end.clipId; }
    const supported = !!value;
    const inspector = this.root.querySelector<HTMLFieldSetElement>('[data-stagecraft-inspector]')!;
    inspector.dataset.editable = String(supported);
    this.paintEnding(value);
    this.setValue('exit', String(value.presentation.exitDurationMs / 1000));
    this.setValue('surface', value.presentation.surface);
    this.setChecked('block-input', value.presentation.blockInput);

    this.inspectorFields().paintClipFields(value, selected, () => this.videoDefaultBox(value));

    if (value.clips.length && !value.clips.some(clip => clip.type === this.activeElement)) {
      this.activeElement = value.clips[0]!.type;
    }
    this.timeline?.render(value,this.selectedId,this.playheadMs,this.selectedBreakId);
    this.showTimingConflicts(timelineConflicts(value));
    this.paintInspector();
    if (['idle', 'ended'].includes(this.preview.getState().phase)) {
      this.showPlayerState({ phase: 'idle', positionMs: 0, durationMs: null }, 'preview');
    }
    this.updateButtons();
    this.drawStill();
  }

  private paintTrackPicker(value: SequenceV1, selected: SequenceClip | undefined): void {
    const picker = this.field<HTMLSelectElement>('clip-track');
    if (!picker) return;
    picker.replaceChildren();
    const expectedKind = selected?.type === 'audio' ? 'audio' : 'visual';
    const compatibleTracks = [...value.tracks].filter(track => track.kind === expectedKind).sort((a, b) => b.order - a.order);
    for (const track of compatibleTracks) {
      const option = document.createElement('option');
      option.value = track.id; option.textContent = track.name;
      option.disabled = track.locked && track.id !== selected?.trackId;
      picker.append(option);
    }
    picker.value = selected?.trackId ?? compatibleTracks[0]?.id ?? '';
  }

  private paintEnding(value: SequenceV1, editField?: string): void {
    const resolved = sequenceDurationMs(value);
    if (value.end.kind !== 'media') this.lastNonMediaEnd = value.end;
    else if (typeof resolved === 'number') this.lastNonMediaEnd = { kind: 'fixed', durationMs: resolved };
    this.setValue('ending', value.end.kind === 'fixed' && value.end.automatic === true ? 'automatic' : value.end.kind);
    if (editField !== 'sequence-duration') {
      const duration = resolved ?? (this.lastNonMediaEnd.kind === 'fixed' ? this.lastNonMediaEnd.durationMs : 5_000);
      this.setValue('sequence-duration', String(duration / 1000));
    }
  }

  private inspectorForm(): InspectorForm {
    return new InspectorForm(this.root, key => this.services.localize(key), <T extends FieldElement>(name: string) => this.field<T>(name));
  }

  private inspectorFields(): InspectorFields { return new InspectorFields(this.inspectorForm()); }
  private inspectorAvailability(): InspectorAvailability { return new InspectorAvailability(this.inspectorForm()); }

  private setValue(name: string, value: string): void { this.inspectorForm().setValue(name, value); }
  private setOutput(selector: string, value: string): void { this.inspectorForm().setOutput(selector, value); }
  private setChecked(name: string, value: boolean): void { this.inspectorForm().setChecked(name, value); }

  private prepareMediaFadePreset(sequence: SequenceV1, editField?: string): void {
    this.inspectorFields().prepareMediaFadePreset(sequence, selectedClip(sequence, this.selectedId), editField);
  }

  private prepareAnimationPreset(sequence: SequenceV1, editField?: string): void {
    this.inspectorFields().prepareAnimationPreset(sequence, selectedClip(sequence, this.selectedId), editField);
  }

  private paintBarsAnimations(clip?: BarsClip, editField?: string): void {
    this.inspectorFields().paintBarsAnimations(clip, editField);
  }

  private paintTextAnimations(clip?: TextClip, editField?: string): void {
    this.inspectorFields().paintTextAnimations(clip, editField);
  }

  private paintImageAnimations(clip?: ImageClip, editField?: string): void {
    this.inspectorFields().paintImageAnimations(clip, editField);
  }

  private paintVideoAnimations(clip?: VideoClip, editField?: string): void {
    this.inspectorFields().paintVideoAnimations(clip, editField);
  }

  private paintSolidFields(sequence: SequenceV1): void {
    this.inspectorFields().paintSolidFields(sequence, this.inspectedClip(sequence, 'solid') as SolidClip | undefined);
  }

  private paintMotionAnimations(type: 'text' | 'image' | 'solid' | 'video' | 'button', clip?: TextClip | ImageClip | SolidClip | VideoClip | ButtonClip, editField?: string): void {
    this.inspectorFields().paintMotionAnimations(type, clip, editField);
  }

  private paintButtonDecisionGroups(sequence: SequenceV1, clip?: ButtonClip): void {
    this.inspectorFields().paintButtonDecisionGroups(sequence, clip);
  }

  private receiveTextMotionLayout(layout: TextMotionLayout): void {
    const sequence = this.draft.draft;
    const clip = sequence?.clips.find(candidate => candidate.id === layout.clipId);
    if (!this.mounted || clip?.type !== 'text'
      || !sameJsonData(clip.properties, layout.clip.properties)) return;
    for (const id of this.textMotionLayouts.keys()) {
      if (!sequence?.clips.some(candidate => candidate.id === id)) this.textMotionLayouts.delete(id);
    }
    const previous = this.textMotionLayouts.get(layout.clipId);
    this.textMotionLayouts.set(layout.clipId, layout);
    if (this.selectedId === layout.clipId && (!previous || !sameJsonData(previous.counts, layout.counts)
      || !sameJsonData(previous.clip.properties, layout.clip.properties))) this.paintInspector();
  }

  private paintInspector(preserveAnimationPreset?: string): void {
    if (!this.root) return;
    const sequence=this.draft.draft, clip=sequence?selectedClip(sequence,this.selectedId):undefined;
    if (sequence) this.triggerSettings?.update(sequence);
    const marker = sequence?.breaks?.find(item => item.id === this.selectedBreakId);
    this.inspectorTabs?.setSelectionLabel(this.t(marker ? 'InnerBreak' : 'InspectorTabClip'));
    const clipSection = this.root.querySelector<HTMLElement>('.stagecraft-selected-clip-section');
    const templateSave = this.root.querySelector<HTMLElement>('[data-stagecraft-template-save-group]');
    if (templateSave) templateSave.hidden = !this.services.templateRepository || !clip;
    if (clipSection) clipSection.hidden = !!marker;
    const breakPanel = this.root.querySelector<HTMLElement>('[data-stagecraft-break-panel]');
    if (breakPanel) breakPanel.hidden = !marker;
    const locked = this.inspectorAvailability().paint(sequence, clip, marker, this.busy, !!this.services.chooseImage, this.textMotionLayouts);
    this.clipInspectorSections?.setSelection(marker ? 'break' : clip?.type ?? null,
      `${sequence?.id ?? ''}|${marker?.id ?? clip?.id ?? ''}`);
    this.patternPicker?.update(clip?.type === 'solid' ? clip.properties.pattern : undefined,
      `${sequence?.id ?? ''}|${clip?.id ?? ''}`, this.busy || locked || !!marker,
      clip?.type === 'solid' ? clip.properties.box.width : undefined,
      clip?.type === 'solid' ? clip.properties.box.height : undefined);
    for (const kind of ['video', 'audio'] as const) {
      for (const phase of ['entrance', 'exit'] as const) {
        const transition = clip?.type === kind ? clip[phase] : undefined;
        const value = transition?.preset ?? 'none';
        const options = this.field<HTMLSelectElement>(`${kind}-${phase}-preset`)?.options;
        const hasDuration = value === 'none' || (transition !== undefined && transition.preset !== 'none' && transition.durationMs > 0);
        const supported = !!options && Array.from(options).some(option => option.value === value) && hasDuration;
        const fieldName = `${kind}-${phase}-preset`;
        if (preserveAnimationPreset !== fieldName) this.setValue(fieldName, supported ? value : 'none');
        const preset = this.field(fieldName);
        if (preset) preset.disabled = this.busy || locked || !!marker || clip?.type !== kind
          || kind === 'audio' && phase === 'exit' && clip?.duration.kind === 'sequence-end';
      }
    }
    for (const [phase, picker] of this.textAnimationPickers) {
      picker.update(clip?.type === 'text' ? clip[phase] : undefined,
        `${sequence?.id ?? ''}|${clip?.id ?? ''}`, this.busy || locked || !!marker
          || this.field(`text-${phase}-preset`)?.disabled !== false);
    }
    for (const [key, { kind, phase, picker }] of this.elementAnimationPickers) {
      picker.update(clip?.type === kind ? clip[phase] : undefined,
        `${sequence?.id ?? ''}|${clip?.id ?? ''}`, this.busy || locked || !!marker
          || this.field(`${key}-preset`)?.disabled !== false);
    }
  }

  private updateButtons(): void {
    if (!this.root) return;
    const timelineRoot = this.root.querySelector<HTMLElement>('[data-stagecraft-timeline]');
    if (timelineRoot) {
      timelineRoot.inert = this.busy;
      timelineRoot.setAttribute('aria-busy', String(this.busy));
    }
    const sequence = this.draft.draft;
    const supported = !!sequence;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-stagecraft-action]')) {
      const action = button.dataset.stagecraftAction;
      if (['stop-preview', 'fade-preview', 'pause-preview'].includes(action!)) continue;
      if (['select-element', 'toggle-element'].includes(action!)) continue;
      if (action === 'continue-preview') {
        const state = this.preview.getState();
        const heldBreak = state.phase === 'holding' || state.phase === 'paused' && state.holdElapsedMs !== undefined;
        button.disabled = this.busy || !heldBreak;
        continue;
      }
      button.disabled = this.busy;
      if (action === 'save') button.disabled ||= !supported;
      if (['preview', 'play', 'duplicate'].includes(action!)) button.disabled ||= !supported || this.invalid;
      if (action === 'undo') button.disabled ||= !this.draft.canUndo;
      if (action === 'redo') button.disabled ||= !this.draft.canRedo;
      if (action === 'rename' || action === 'add-preset') button.disabled ||= !supported;
      if (action === 'add-preset' && effectPreset(button.dataset.presetId)?.type === 'break') {
        button.disabled ||= (sequence?.breaks?.length ?? 0) >= SEQUENCE_LIMITS.breaks
          && !sequence?.breaks?.some(marker => marker.positionMs === this.playheadMs);
      }
      if (action === 'reload') button.disabled ||= this.draft.expectedRevision === null;
      if (action === 'delete-sequence') button.disabled ||= !supported || this.draft.expectedRevision === null;
      if (action === 'load') button.disabled ||= !!this.items.find(item => item.id === button.dataset.sequenceId)?.issue;
      if (action === 'prepare-group') {
        button.disabled ||= !supported || this.invalid || this.draft.dirty || this.draft.expectedRevision === null;
        button.title = this.draft.dirty || this.draft.expectedRevision === null ? this.t('SaveFirst') : '';
      }
      if (action === 'choose-video' || action === 'inspect-video') button.disabled ||= !supported;
      if(action==='choose-video')button.disabled ||= !sequence || sequence.tracks.find(track=>track.id===selectedClip(sequence,this.selectedId)?.trackId)?.locked===true;
      if (action === 'choose-audio' || action === 'inspect-audio') button.disabled ||= !supported;
      if(action==='choose-audio'||action==='inspect-audio')button.disabled ||= !sequence || sequence.tracks.find(track=>track.id===selectedClip(sequence,this.selectedId)?.trackId)?.locked===true;
      if (action === 'choose-image') button.disabled ||= !supported || !this.services.chooseImage
        || selectedClip(sequence!, this.selectedId)?.type !== 'image'
        || sequence!.tracks.find(track => track.id === selectedClip(sequence!, this.selectedId)?.trackId)?.locked === true;
      if (action === 'choose-button-texture') button.disabled ||= !supported || !this.services.chooseImage
        || selectedClip(sequence!, this.selectedId)?.type !== 'button'
        || sequence!.tracks.find(track => track.id === selectedClip(sequence!, this.selectedId)?.trackId)?.locked === true;
    }
    const inspector = this.root.querySelector<HTMLFieldSetElement>('[data-stagecraft-inspector]');
    if (inspector) inspector.disabled = this.busy || !supported;
    const name = this.field('sequence-name');
    if (name) { name.disabled = this.busy || !supported || !this.renaming; name.hidden = !this.renaming; }
    const picker = this.root.querySelector<HTMLSelectElement>('[data-stagecraft-sequence-picker]');
    if (picker) { picker.disabled = this.busy || !supported; picker.hidden = this.renaming; }
    const saveState = this.root.querySelector<HTMLElement>('[data-stagecraft-save-state]');
    if (saveState) saveState.textContent = this.busy ? this.t('Working') : (this.draft.dirty || this.invalid) ? this.t('Unsaved') : this.t('Saved');
    this.paintInspector();
    if (!this.busy) this.formValidation.refresh();
    this.imageHandles?.update();
    this.numericScrubbers?.update();
  }

  private clearStill(): void {
    this.staticVersion++;
    const controller = this.staticAbort;
    const surface = this.staticPreview;
    this.staticAbort = null;
    this.staticPreview = null;
    this.staticSourceKey = null;
    this.staticPrepared = false;
    this.staticLatest = null;
    this.staticUpdating = null;
    this.staticQueue = Promise.resolve();
    controller?.abort();
    surface?.dispose();
  }

  private createStillSurface(options: ConstructorParameters<typeof DomSurface>[0]): DomSurface {
    return new DomSurface(options);
  }

  private failStillSurface(surface: DomSurface, error: unknown): void {
    if (this.staticPreview !== surface) {
      surface.dispose();
      return;
    }
    this.clearStill();
    if (this.mounted) this.message(this.errorMessage(error), 'error');
  }

  private drawStill(sequenceOverride?: SequenceV1): void {
    const draft = this.draft.draft;
    const sequence = sequenceOverride ?? draft;
    if (!this.root || !sequence || this.invalid) return;
    if (!['idle', 'ended'].includes(this.preview.getState().phase)) return;
    const videos=sequence.clips.filter((c):c is VideoClip=>c.type==='video');
    if (videos.some(video=>typeof video.properties.durationMs !== 'number' || video.properties.durationMs <= 0)) {
      if (this.staticSourceKey !== this.videoPath(sequence)) this.clearStill();
      return;
    }
    const viewer = this.root.querySelector<HTMLElement>('[data-stagecraft-viewer]');
    if (!viewer) return;
    let plan: CompiledSequence;
    try { plan = compileSequence(sequence); }
    catch (error) { this.message(this.errorMessage(error), 'error'); return; }
    const positionMs = this.playheadMs;
    const frame: PlayerFrame = { positionMs, items: evaluate(plan, positionMs), opacity: 1, phase: 'paused' };
    const images = sequence.clips.filter((clip): clip is ImageClip => clip.type === 'image');
    const alphaMaps = sequence.clips.filter((clip): clip is SolidClip => clip.type === 'solid' && !!clip.properties.alphaMap);
    const sourceKey = sequence.id+'|v:'+videos.map(video=>video.id+'|'+video.properties.source.path+'|'+video.properties.durationMs).join(';')
      +'|i:'+images.map(image=>image.id+'|'+image.properties.source.path).join(';')
      +'|a:'+alphaMaps.map(clip=>clip.id+'|'+clip.properties.alphaMap!.path).join(';');
    const request: StillRequest = { version: ++this.staticVersion, plan, frame };
    this.staticLatest = request;
    if (this.staticPreview && this.staticSourceKey === sourceKey) {
      if (this.staticPrepared) this.queueStillUpdate(this.staticPreview, request);
      return;
    }
    this.clearStill();
    const start = { ...request, version: ++this.staticVersion };
    this.staticLatest = start;
    this.staticSourceKey = sourceKey;
    const controller = new AbortController();
    this.staticAbort = controller;
    let surface!: DomSurface;
    surface = this.createStillSurface({
      target: 'preview', preview: viewer, still: true,
      ...(this.services.createBoardBackdrop ? { boardBackdrop: this.services.createBoardBackdrop('preview') } : {}),
      onError: error => this.failStillSurface(surface, error),
      onTextMotionLayout: layout => {
        if (this.staticPreview === surface) this.receiveTextMotionLayout(layout);
      },
      onWarning: code => {
        if (this.mounted && this.staticPreview === surface) this.message(this.errorMessage(code), 'warning');
      }
    });
    this.staticPreview = surface;
    void surface.prepare(plan, controller.signal).then(() => {
      if (!this.mounted || controller.signal.aborted || this.staticPreview !== surface) return;
      this.staticPrepared = true;
      const latest = this.staticLatest;
      if (latest) this.queueStillUpdate(surface, latest);
    }).catch(error => {
      if (controller.signal.aborted || !this.mounted || this.staticPreview !== surface) {
        surface.dispose();
        return;
      }
      this.failStillSurface(surface, error);
    });
  }

  private queueStillUpdate(surface: DomSurface, _request: StillRequest): Promise<void> {
    // Keep one worker per surface; pointer bursts replace the pending frame.
    if (this.staticUpdating === surface) return this.staticQueue;
    this.staticUpdating = surface;
    this.staticQueue = (async () => {
      if (!this.mounted || this.staticPreview !== surface || !this.staticPrepared || this.staticAbort?.signal.aborted) return;
      let latest = this.staticLatest;
      while (latest) {
        const version = latest.version;
        await surface.updateStill(latest.plan);
        if (!this.mounted || this.staticPreview !== surface || this.staticAbort?.signal.aborted) return;
        latest = this.staticLatest;
        if (!latest || latest.version === version) {
          if (latest) surface.render(latest.frame);
          return;
        }
      }
    })().catch(error => {
      if (this.staticPreview === surface) this.failStillSurface(surface, error);
      else surface.dispose();
    }).finally(() => {
      if (this.staticUpdating === surface) this.staticUpdating = null;
    });
    return this.staticQueue;
  }

  private showPlayerState(state: Readonly<PlayerState>, kind: 'preview' | 'local'): void {
    const phaseChanged = state.phase !== (kind === 'preview' ? this.previewPhase : this.localPhase);
    if (kind === 'preview') this.previewPhase = state.phase;
    else this.localPhase = state.phase;
    if (!this.root) return;
    if (!['idle', 'ended'].includes(state.phase)) this.imageHandles?.cancel();
    if (kind === 'local' && !['idle', 'ended'].includes(state.phase)
      || kind === 'preview' && state.phase === 'preparing') this.numericScrubbers?.cancel();
    const node = this.root.querySelector<HTMLElement>('[data-stagecraft-' + kind + '-state]');
    const phaseText = this.t('State.' + state.phase);
    if (node && node.textContent !== phaseText) node.textContent = phaseText;
    this.timeline?.setPlaybackState(state);
    if (kind === 'preview') {
      if (!['idle','ended'].includes(state.phase)) {
        // Playback can advance between animation frames. Keep the editor's
        // authored timeline position on the integer-millisecond boundary.
        this.playheadMs = Math.max(0, Math.round(state.positionMs));
        this.timeline?.setPlayhead(this.playheadMs);
      }
      const clock = this.root.querySelector<HTMLElement>('[data-stagecraft-clock]');
      const clockText = ((['idle','ended'].includes(state.phase)?this.playheadMs:state.positionMs) / 1000).toFixed(2) + ' s';
      if (clock && clock.textContent !== clockText) clock.textContent = clockText;
      const button = this.root.querySelector<HTMLButtonElement>('[data-stagecraft-action="pause-preview"]');
      const buttonText = this.t(state.phase === 'paused' ? 'Resume' : 'Pause');
      if (button && button.textContent !== buttonText) button.textContent = buttonText;
      const continueButton = this.root.querySelector<HTMLButtonElement>('[data-stagecraft-action="continue-preview"]');
      if (continueButton) {
        const heldBreak = state.phase === 'holding' || state.phase === 'paused' && state.holdElapsedMs !== undefined;
        continueButton.hidden = !heldBreak;
        continueButton.disabled = this.busy || !heldBreak;
      }
    }
    // Restore the shared still preview after either transport releases its surface.
    if (['ended', 'idle'].includes(state.phase) && this.mounted) this.drawStill();
    if (state.error) this.message(this.errorMessage(state.error), 'error');
    this.imageHandles?.update();
    // The advancing clock does not change numeric editability or gesture identity.
    // Rechecking every field here would clone/serialize the draft on every frame.
    if (phaseChanged) this.numericScrubbers?.update();
  }
}
