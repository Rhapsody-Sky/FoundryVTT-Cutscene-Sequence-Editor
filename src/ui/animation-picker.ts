import type { SequenceClip, Transition } from '../domain/sequence.js';
import type { ElementRenderer, RendererOptions } from '../rendering/element-renderer.js';
import type { PlayerFrame } from '../playback/local-player.js';

export type AnimationPhase = 'entrance' | 'exit';

const FRAME_INTERVAL = 1000 / 24;
const START_PAUSE_MS = 420;
const MOTION_MS = 1_050;
const END_PAUSE_MS = 620;
const CYCLE_MS = START_PAUSE_MS + MOTION_MS + END_PAUSE_MS;
const ENTRANCE_STILL_PROGRESS = 0.56;
const EXIT_STILL_PROGRESS = 0.34;
export const ANIMATION_PICKER_PREVIEW_SIZE = Object.freeze({ width: 640, height: 320 });
let nextPickerId = 0;

export type AnimationPickerRenderer = Pick<ElementRenderer, 'prepare' | 'draw' | 'dispose'>;

export interface AnimationPickerPreview<TClip extends SequenceClip = SequenceClip> {
  readonly clip: TClip;
  /** Phase-local chronological progress; finite values are clamped by the preview implementation. */
  frameAt(progress: number): PlayerFrame;
}

export interface AnimationPickerScheduler {
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
}

/** Inject element-specific preview and renderer factories while sharing gallery behavior. */
export interface AnimationPickerOptions<TClip extends SequenceClip,
  TPreview extends AnimationPickerPreview<TClip>> {
  readonly createPreview: (value: string, phase: AnimationPhase, source?: Transition) => TPreview;
  readonly createRenderer: (clip: TClip, parent: HTMLElement,
    size: { readonly width: number; readonly height: number }, options: RendererOptions) => AnimationPickerRenderer;
  readonly previewSize?: { readonly width: number; readonly height: number };
  readonly scheduler?: AnimationPickerScheduler;
}

/** Options plus a concrete frame scheduler, useful for callers that share one runtime object. */
export interface AnimationPickerRuntime<TClip extends SequenceClip,
  TPreview extends AnimationPickerPreview<TClip>>
  extends AnimationPickerOptions<TClip, TPreview>, AnimationPickerScheduler {}

const browserScheduler: AnimationPickerScheduler = {
  now: () => performance.now(),
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id)
};

interface PreviewCard {
  readonly value: string;
  readonly label: string;
  readonly optionDisabled: boolean;
  readonly button: HTMLButtonElement;
  readonly slot: HTMLElement;
  visible: boolean;
  preview: AnimationPickerPreview | undefined;
  renderer: AnimationPickerRenderer | undefined;
  abort: AbortController | undefined;
  ready: boolean;
  signature: string;
  failedSignature: string | undefined;
  staticFrameSignature: string | undefined;
}

/**
 * A local comparison gallery for an element animation select. Preset changes
 * still cross the native select's normal single change event.
 */
export class AnimationPicker<TClip extends SequenceClip = SequenceClip,
  TPreview extends AnimationPickerPreview<TClip> = AnimationPickerPreview<TClip>> {
  private readonly controller = new AbortController();
  private readonly addedHostClass: boolean;
  private readonly toggle: HTMLButtonElement;
  private readonly summaryPreview: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly action: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly cards: PreviewCard[] = [];
  private readonly intersection: IntersectionObserver | undefined;
  private readonly mutations: MutationObserver | undefined;
  private readonly motionPreference: MediaQueryList | undefined;
  private transition: Transition | undefined;
  private identity = '';
  private open = false;
  private disabled = true;
  private focusedCard: PreviewCard | undefined;
  private reducedMotion = false;
  private disposed = false;
  private intersecting = true;
  private frame: number | undefined;
  private clockStartedAt: number | undefined;
  private elapsedMs = 0;
  private lastDraw = -Infinity;
  private readonly scheduler: AnimationPickerScheduler;

  constructor(private readonly root: HTMLElement, private readonly host: HTMLElement,
    private readonly select: HTMLSelectElement, private readonly t: (key: string) => string,
    private readonly phase: AnimationPhase,
    private readonly options: AnimationPickerOptions<TClip, TPreview>) {
    const doc = host.ownerDocument;
    const id = `stagecraft-text-animation-picker-${++nextPickerId}`;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.intersecting = typeof IntersectionObserver === 'undefined';
    this.addedHostClass = !host.classList.contains('stagecraft-text-animation-picker');
    host.classList.add('stagecraft-text-animation-picker');

    this.toggle = doc.createElement('button');
    this.toggle.type = 'button'; this.toggle.className = 'stagecraft-text-animation-toggle';
    this.toggle.setAttribute('aria-expanded', 'false'); this.toggle.setAttribute('aria-controls', id);
    this.toggle.setAttribute('aria-haspopup', 'listbox');
    this.summaryPreview = doc.createElement('span'); this.summaryPreview.className = 'stagecraft-text-animation-summary-preview';
    this.caption = doc.createElement('span'); this.caption.className = 'stagecraft-text-animation-summary-label';
    this.action = doc.createElement('span'); this.action.className = 'stagecraft-text-animation-toggle-action';
    this.toggle.append(this.summaryPreview, this.caption, this.action);
    this.grid = doc.createElement('div'); this.grid.className = 'stagecraft-text-animation-grid'; this.grid.id = id;
    this.grid.hidden = true; this.grid.setAttribute('role', 'listbox');
    host.append(this.toggle, this.grid);
    this.createCards();
    this.toggle.addEventListener('click', () => this.setOpen(!this.open), { signal: this.controller.signal });
    this.grid.addEventListener('click', event => {
      const card = this.cards.find(item => item.button === event.target || item.button.contains(event.target as Node));
      if (card) this.choose(card);
    }, { signal: this.controller.signal });
    host.addEventListener('keydown', event => this.onKeyDown(event), { signal: this.controller.signal });
    host.addEventListener('focusin', event => {
      if (!this.open) return;
      const card = this.cards.find(item => item.button === event.target || item.button.contains(event.target as Node));
      if (card) { this.focusedCard = card; this.setRovingTabStop(card); }
    }, { signal: this.controller.signal });
    doc.addEventListener('visibilitychange', () => this.syncWork(), { signal: this.controller.signal });

    this.motionPreference = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (this.motionPreference) {
      this.reducedMotion = this.motionPreference.matches;
      this.motionPreference.addEventListener?.('change', this.onMotionPreferenceChange, { signal: this.controller.signal });
    }

    if (typeof IntersectionObserver !== 'undefined') {
      this.intersecting = false;
      this.intersection = new IntersectionObserver(entries => {
        if (this.disposed) return;
        for (const entry of entries) {
          if (entry.target === host) this.intersecting = entry.isIntersecting;
          const card = this.cards.find(item => item.button === entry.target);
          if (card) card.visible = entry.isIntersecting;
        }
        this.syncWork();
      });
      this.intersection.observe(host);
      for (const card of this.cards) this.intersection.observe(card.button);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.mutations = new MutationObserver(records => {
        if (records.some(record => record.target.contains(host) || record.target.contains(select))) this.syncWork();
      });
      this.mutations.observe(root, { subtree: true, attributes: true,
        attributeFilter: ['hidden', 'disabled', 'inert', 'aria-hidden', 'class', 'style'] });
      for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
        this.mutations.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'class', 'style'] });
      }
    }
    this.paintSelection();
  }

  update(transition: Transition | undefined, identity: string, disabled: boolean): void {
    if (this.disposed) return;
    if (identity !== this.identity) {
      this.setOpen(false);
      this.identity = identity;
      this.releaseAllPreviews();
    }
    this.transition = transition;
    this.disabled = disabled || !transition;
    if (this.toggle.disabled !== this.disabled) this.toggle.disabled = this.disabled;
    if (!transition) {
      this.setOpen(false);
      this.releaseAllPreviews();
    } else if (this.disabled) this.setOpen(false);
    this.paintSelection();
    this.syncWork();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();
    this.controller.abort();
    this.intersection?.disconnect(); this.mutations?.disconnect();
    this.releaseAllPreviews();
    this.toggle.remove(); this.grid.remove();
    if (this.addedHostClass) this.host.classList.remove('stagecraft-text-animation-picker');
  }

  private createCards(): void {
    const doc = this.host.ownerDocument;
    for (const option of Array.from(this.select.options)) {
      const label = option.textContent ?? option.value;
      const button = doc.createElement('button');
      button.type = 'button'; button.className = 'stagecraft-text-animation-choice';
      button.dataset.stagecraftTextAnimationValue = option.value; button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false'); button.setAttribute('aria-label', label || option.value);
      button.disabled = option.disabled;
      const slot = doc.createElement('span'); slot.className = 'stagecraft-text-animation-miniature';
      const caption = doc.createElement('span'); caption.className = 'stagecraft-text-animation-choice-label'; caption.textContent = label;
      button.append(slot, caption); this.grid.append(button);
      this.cards.push({ value: option.value, label, optionDisabled: option.disabled, button, slot,
        visible: typeof IntersectionObserver === 'undefined', preview: undefined, renderer: undefined, abort: undefined,
        ready: false, signature: '', failedSignature: undefined, staticFrameSignature: undefined });
    }
  }

  private paintSelection(): void {
    const controlsDisabled = this.disabled || this.isSelectDisabled();
    if (this.toggle.disabled !== controlsDisabled) this.toggle.disabled = controlsDisabled;
    const selected = this.cards.find(card => card.value === this.select.value);
    for (const card of this.cards) {
      const active = card === selected;
      if (card.button.getAttribute('aria-selected') !== String(active)) card.button.setAttribute('aria-selected', String(active));
      const tabStop = this.open && this.focusedCard ? card === this.focusedCard : active;
      if (card.button.tabIndex !== (tabStop ? 0 : -1)) card.button.tabIndex = tabStop ? 0 : -1;
      const disabled = controlsDisabled || card.optionDisabled;
      if (card.button.disabled !== disabled) card.button.disabled = disabled;
      const container = this.open || !active ? card.button : this.summaryPreview;
      if (card.slot.parentElement !== container) {
        if (container === card.button) card.button.prepend(card.slot);
        else container.append(card.slot);
      }
    }
    if (this.summaryPreview.hidden !== this.open) this.summaryPreview.hidden = this.open;
    const stage = this.phase === 'entrance' ? this.t('STAGECRAFT.Editor.AnimationIn') : this.t('STAGECRAFT.Editor.AnimationOut');
    if (this.grid.getAttribute('aria-label') !== stage) this.grid.setAttribute('aria-label', stage);
    if (this.caption.textContent !== (selected?.label ?? '')) this.caption.textContent = selected?.label ?? '';
    const action = this.t(this.open ? 'STAGECRAFT.Editor.TextAnimationCollapse' : 'STAGECRAFT.Editor.TextAnimationCompare');
    if (this.action.textContent !== action) this.action.textContent = action;
    const accessible = `${stage}: ${selected?.label ?? ''}. ${action}`;
    if (this.toggle.getAttribute('aria-label') !== accessible) this.toggle.setAttribute('aria-label', accessible);
  }

  private setOpen(open: boolean): void {
    if (this.disposed || open && (this.disabled || !this.transition || this.isSelectDisabled())) return;
    if (this.open === open) return;
    this.open = open;
    this.grid.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      const selected = this.cards.find(card => card.value === this.select.value && !card.optionDisabled);
      this.focusedCard = selected ?? this.cards.find(card => !card.optionDisabled);
      this.stopAnimation(); this.elapsedMs = 0; this.lastDraw = -Infinity;
    } else {
      this.focusedCard = undefined;
      this.stopAnimation();
      const selected = this.cards.find(card => card.value === this.select.value);
      for (const card of this.cards) if (card !== selected) this.releasePreview(card);
    }
    this.paintSelection();
    this.syncWork();
  }

  private choose(card: PreviewCard): void {
    if (!this.open || this.disabled || this.isSelectDisabled() || this.disposed || !this.cards.includes(card)
      || card.optionDisabled || this.select.value === card.value) return;
    this.focusedCard = card;
    this.select.value = card.value;
    const EventClass = this.host.ownerDocument.defaultView?.Event ?? Event;
    this.select.dispatchEvent(new EventClass('change', { bubbles: true }));
    this.paintSelection();
    this.syncWork();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.target === this.toggle && event.key === 'ArrowDown' && !this.disabled) {
      event.preventDefault(); event.stopPropagation(); this.setOpen(true);
      this.focusedCard?.button.focus();
      return;
    }
    if (event.key === 'Escape' && this.open) {
      event.preventDefault(); event.stopPropagation(); this.setOpen(false); this.toggle.focus(); return;
    }
    if (!this.open || this.disabled) return;
    const current = this.cards.find(card => card.button === event.target);
    if (!current) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation(); this.choose(current); return;
    }
    const navigable = this.cards.filter(card => !card.button.disabled);
    const index = navigable.indexOf(current);
    if (index < 0) return;
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1
      : event.key === 'ArrowDown' ? 2 : event.key === 'ArrowUp' ? -2 : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? navigable.length - 1
      : delta ? (index + delta + navigable.length) % navigable.length : -1;
    if (next < 0) return;
    event.preventDefault(); event.stopPropagation();
    const target = navigable[next]!; this.focusedCard = target; this.setRovingTabStop(target);
    target.button.focus(); target.button.scrollIntoView?.({ block: 'nearest' });
  }

  private setRovingTabStop(target: PreviewCard): void {
    for (const card of this.cards) card.button.tabIndex = card === target ? 0 : -1;
  }

  private onMotionPreferenceChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
    this.syncWork();
  };

  private syncWork(): void {
    if (this.disposed) return;
    this.paintSelection();
    this.reconcileStalePreviews();
    if (!this.visible() || !this.transition) { this.stopAnimation(); return; }
    if (this.open && (this.disabled || this.isSelectDisabled())) { this.setOpen(false); return; }
    if (!this.open) {
      this.stopAnimation();
      const selected = this.cards.find(card => card.value === this.select.value);
      for (const card of this.cards) if (card !== selected) this.releasePreview(card);
      if (selected) {
        this.ensurePreview(selected);
        this.drawStatic(selected);
      }
      return;
    }

    const visibleCards = this.cards.filter(card => card.visible);
    for (const card of visibleCards) this.ensurePreview(card);
    if (this.reducedMotion) {
      this.stopAnimation();
      for (const card of visibleCards) this.drawStatic(card);
      return;
    }
    if (!visibleCards.some(card => card.ready && card.renderer && card.preview)) { this.stopAnimation(); return; }
    if (this.clockStartedAt === undefined) this.clockStartedAt = this.scheduler.now();
    if (this.frame === undefined) this.frame = this.scheduler.requestFrame(time => this.tick(time));
  }

  private reconcileStalePreviews(): void {
    for (const card of this.cards) {
      if (!card.renderer && !card.preview && !card.abort) continue;
      const expected = this.signatureFor(card);
      if (card.signature !== expected) this.releasePreview(card);
    }
  }

  private signatureFor(card: PreviewCard): string {
    const source = card.value === this.select.value ? this.transition : undefined;
    return JSON.stringify([card.value, this.phase, source]);
  }

  private ensurePreview(card: PreviewCard): void {
    const signature = this.signatureFor(card);
    if (card.signature !== signature) this.releasePreview(card);
    if (card.renderer || card.abort || card.failedSignature === signature) return;
    card.signature = signature;
    const abort = new AbortController(); card.abort = abort;
    let preview: TPreview;
    let renderer: AnimationPickerRenderer;
    try {
      preview = this.options.createPreview(card.value, this.phase,
        card.value === this.select.value ? this.transition : undefined);
      renderer = this.options.createRenderer(preview.clip, card.slot,
        this.options.previewSize ?? ANIMATION_PICKER_PREVIEW_SIZE, { signal: abort.signal });
    } catch {
      card.abort = undefined; card.signature = ''; card.failedSignature = signature;
      return;
    }
    card.preview = preview; card.renderer = renderer; card.ready = false;
    void Promise.resolve().then(() => renderer.prepare()).then(() => {
      if (this.disposed || card.renderer !== renderer || abort.signal.aborted) return;
      card.ready = true;
      this.drawCurrent(card);
      this.syncWork();
    }).catch(() => {
      if (card.renderer !== renderer) return;
      this.releasePreview(card); card.failedSignature = signature;
      this.syncWork();
    });
  }

  private drawCurrent(card: PreviewCard): void {
    if (!card.ready || !card.renderer || !card.preview) return;
    if (!this.open || this.reducedMotion) this.drawStatic(card);
    else if (card.visible && this.visible()) this.drawAt(card, this.progressAt(this.elapsedAt(this.scheduler.now())));
  }

  private drawStatic(card: PreviewCard): void {
    if (!card.ready || !card.renderer || !card.preview) return;
    const progress = this.phase === 'entrance' ? ENTRANCE_STILL_PROGRESS : EXIT_STILL_PROGRESS;
    const frameSignature = `${card.signature}|static|${progress}`;
    if (card.staticFrameSignature === frameSignature) return;
    card.staticFrameSignature = frameSignature;
    this.drawAt(card, progress);
  }

  private drawAt(card: PreviewCard, progress: number): void {
    if (!card.renderer || !card.preview) return;
    const frame = card.preview.frameAt(progress);
    const item = frame.items.find(candidate => candidate.clip.id === card.preview!.clip.id);
    card.renderer.draw(item, frame);
  }

  private tick(time: number): void {
    this.frame = undefined;
    if (!this.canAnimate()) { this.stopAnimation(); return; }
    if (time - this.lastDraw >= FRAME_INTERVAL) {
      this.lastDraw = time;
      const progress = this.progressAt(this.elapsedAt(time));
      for (const card of this.cards) if (card.visible && card.ready && card.renderer && card.preview) {
        card.staticFrameSignature = undefined;
        this.drawAt(card, progress);
      }
    }
    if (this.canAnimate()) this.frame = this.scheduler.requestFrame(nextTime => this.tick(nextTime));
    else this.stopAnimation();
  }

  private progressAt(elapsedMs: number): number {
    const cycle = elapsedMs % CYCLE_MS;
    if (cycle < START_PAUSE_MS) return 0;
    if (cycle < START_PAUSE_MS + MOTION_MS) return (cycle - START_PAUSE_MS) / MOTION_MS;
    return 1;
  }

  private elapsedAt(time: number): number {
    return this.elapsedMs + (this.clockStartedAt === undefined ? 0 : Math.max(0, time - this.clockStartedAt));
  }

  private visible(): boolean {
    if (!this.root.isConnected || !this.host.isConnected || !this.intersecting || this.host.ownerDocument.hidden) return false;
    for (let node: HTMLElement | null = this.host; node; node = node.parentElement) {
      if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false;
      const style = this.host.ownerDocument.defaultView?.getComputedStyle(node);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
    }
    return true;
  }

  private isSelectDisabled(): boolean {
    return this.select.disabled || this.select.matches(':disabled');
  }

  private canAnimate(): boolean {
    return !this.disposed && this.open && !this.disabled && !this.reducedMotion && !this.isSelectDisabled()
      && this.visible() && this.cards.some(card => card.visible && card.ready && card.renderer && card.preview);
  }

  private stopAnimation(): void {
    if (this.frame !== undefined) this.scheduler.cancelFrame(this.frame);
    this.frame = undefined;
    if (this.clockStartedAt !== undefined) {
      this.elapsedMs += Math.max(0, this.scheduler.now() - this.clockStartedAt);
      this.clockStartedAt = undefined;
    }
  }

  private releasePreview(card: PreviewCard): void {
    card.abort?.abort(); card.abort = undefined;
    card.renderer?.dispose(); card.renderer = undefined;
    card.preview = undefined; card.ready = false; card.signature = '';
    card.failedSignature = undefined; card.staticFrameSignature = undefined;
  }

  private releaseAllPreviews(): void {
    this.stopAnimation();
    for (const card of this.cards) this.releasePreview(card);
  }
}
