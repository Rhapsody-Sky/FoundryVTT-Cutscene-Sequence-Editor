import { ANIMATED_PATTERN_PRESETS, selectAnimatedPatternPreset, type AnimatedPattern, type AnimatedPatternPresetId } from '../domain/animated-pattern.js';
import { animatedPatternRenderer, type AnimatedPatternRenderer } from '../rendering/animated-pattern-renderer.js';

const NS = 'http://www.w3.org/2000/svg';
const FRAME_INTERVAL = 1000 / 24;
const STATIC_PREVIEW_TIME = 1000;
let nextPickerId = 0;

interface PatternPreview {
  readonly preset: AnimatedPatternPresetId;
  readonly button: HTMLButtonElement;
  readonly slot: HTMLElement;
  readonly svg: SVGSVGElement;
  readonly renderer: AnimatedPatternRenderer;
  visible: boolean;
  signature: string;
  staticFrameSignature: string;
}

export interface PatternPickerRuntime {
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
}
const browserRuntime: PatternPickerRuntime = {
  now: () => performance.now(),
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id)
};

/** Editor-only comparison clock. Selecting still goes through the original form change contract. */
export class PatternPicker {
  private readonly controller = new AbortController();
  private readonly toggle: HTMLButtonElement;
  private readonly summaryPreview: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly action: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly previews: PatternPreview[] = [];
  private readonly intersection: IntersectionObserver | undefined;
  private readonly mutations: MutationObserver | undefined;
  private readonly motionPreference: MediaQueryList | undefined;
  private settings: AnimatedPattern | undefined;
  private identity = '';
  private signature = '';
  private width = 1920;
  private height = 1080;
  private open = false;
  private disabled = true;
  private reducedMotion = false;
  private disposed = false;
  private intersecting = true;
  private frame: number | undefined;
  private startedAt = 0;
  private lastDraw = -Infinity;

  constructor(private readonly root: HTMLElement, private readonly host: HTMLElement,
    private readonly select: HTMLSelectElement, private readonly t: (key: string) => string,
    private readonly runtime: PatternPickerRuntime = browserRuntime) {
    const doc = host.ownerDocument;
    const id = `stagecraft-pattern-picker-${++nextPickerId}`;
    this.toggle = doc.createElement('button');
    this.toggle.type = 'button'; this.toggle.className = 'stagecraft-pattern-toggle';
    this.toggle.setAttribute('aria-expanded', 'false'); this.toggle.setAttribute('aria-controls', id);
    this.toggle.setAttribute('aria-haspopup', 'listbox');
    this.summaryPreview = doc.createElement('span'); this.summaryPreview.className = 'stagecraft-pattern-summary-preview';
    this.caption = doc.createElement('span'); this.caption.className = 'stagecraft-pattern-summary-label';
    this.action = doc.createElement('span'); this.action.className = 'stagecraft-pattern-toggle-action';
    this.action.textContent = t('STAGECRAFT.Editor.PatternCompare');
    this.toggle.append(this.summaryPreview, this.caption, this.action);
    this.grid = doc.createElement('div'); this.grid.className = 'stagecraft-pattern-grid'; this.grid.id = id; this.grid.hidden = true;
    this.grid.setAttribute('role', 'listbox'); this.grid.setAttribute('aria-label', t('STAGECRAFT.Editor.PatternPreset'));
    host.append(this.toggle, this.grid);
    this.motionPreference = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (this.motionPreference) {
      this.reducedMotion = this.motionPreference.matches;
      this.motionPreference.addEventListener?.('change', this.onMotionPreferenceChange, { signal: this.controller.signal });
    }
    this.toggle.addEventListener('click', () => this.setOpen(!this.open), { signal: this.controller.signal });
    this.grid.addEventListener('click', event => {
      const preview = this.previews.find(item => item.button === event.target || item.button.contains(event.target as Node));
      if (preview) this.choose(preview);
    }, { signal: this.controller.signal });
    host.addEventListener('keydown', event => this.onKeyDown(event), { signal: this.controller.signal });
    doc.addEventListener('visibilitychange', () => this.syncAnimation(), { signal: this.controller.signal });
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersecting = false;
      this.intersection = new IntersectionObserver(entries => {
        if (this.disposed) return;
        for (const entry of entries) {
          if (entry.target === host) this.intersecting = entry.isIntersecting;
          const preview = this.previews.find(item => item.button === entry.target);
          if (preview) preview.visible = entry.isIntersecting;
        }
        this.syncAnimation();
      });
      this.intersection.observe(host);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.mutations = new MutationObserver(records => {
        // Renderer styles/classes cannot hide the picker. Only its ancestors and
        // the original select (including a disabled fieldset) affect eligibility.
        if (records.some(record => record.target.contains(host) || record.target.contains(select))) this.syncAnimation();
      });
      // Inspector tabs/categories, locks, fieldsets and app minimization can hide an ancestor.
      this.mutations.observe(root, { subtree: true, attributes: true,
        attributeFilter: ['hidden', 'disabled', 'inert', 'aria-hidden', 'class', 'style'] });
      for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
        this.mutations.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'class', 'style'] });
      }
    }
  }

  update(settings: AnimatedPattern | undefined, identity: string, disabled: boolean, width = 1920, height = 1080): void {
    if (this.disposed) return;
    if (identity !== this.identity) { this.setOpen(false); this.identity = identity; this.releasePreviews(); }
    this.settings = settings;
    this.disabled = disabled || !settings;
    if (this.toggle.disabled !== this.disabled) this.toggle.disabled = this.disabled;
    if (!settings) { this.setOpen(false); this.releasePreviews(); return; }
    this.width = width; this.height = height;
    this.signature = JSON.stringify([settings, width, height]);
    if (!this.previews.length) this.createPreviews(settings, width, height);
    this.paintSelection();
    if (this.disabled) this.setOpen(false);
    this.syncAnimation();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.stopAnimation(); this.controller.abort();
    this.intersection?.disconnect(); this.mutations?.disconnect(); this.releasePreviews();
    this.toggle.remove(); this.grid.remove();
  }

  private createPreviews(settings: AnimatedPattern, width: number, height: number): void {
    const doc = this.host.ownerDocument;
    for (const preset of ANIMATED_PATTERN_PRESETS) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'stagecraft-pattern-choice';
      button.dataset.stagecraftPatternPreset = preset.id; button.setAttribute('role', 'option');
      const slot = doc.createElement('span'); slot.className = 'stagecraft-pattern-miniature';
      const svg = doc.createElementNS(NS, 'svg'); svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const id = `${this.grid.id}-${preset.id}`;
      const renderer = animatedPatternRenderer(id, selectAnimatedPatternPreset(settings, preset.id), width, height);
      const defs = doc.createElementNS(NS, 'defs'); defs.append(renderer.node);
      const fill = doc.createElementNS(NS, 'rect');
      fill.setAttribute('width', '100%'); fill.setAttribute('height', '100%'); fill.setAttribute('fill', `url(#${id})`);
      svg.append(defs, fill); slot.append(svg);
      const label = doc.createElement('span'); label.className = 'stagecraft-pattern-choice-label'; label.textContent = this.t(preset.label);
      button.append(slot, label); this.grid.append(button);
      const preview: PatternPreview = { preset: preset.id, button, slot, svg, renderer,
        visible: !this.intersection, signature: this.signature, staticFrameSignature: '' };
      this.previews.push(preview); this.intersection?.observe(button);
    }
  }

  private reconcile(preview: PatternPreview, time: number): void {
    if (!this.settings || preview.signature === this.signature) return;
    preview.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    preview.renderer.update(selectAnimatedPatternPreset(this.settings, preview.preset), this.width, this.height);
    preview.renderer.draw(time);
    preview.signature = this.signature;
    preview.staticFrameSignature = time === STATIC_PREVIEW_TIME ? preview.signature : '';
  }

  private reconcileVisible(): void {
    if (!this.open) {
      const selected = this.previews.find(preview => preview.preset === this.settings?.preset);
      if (selected) this.reconcile(selected, this.reducedMotion ? STATIC_PREVIEW_TIME : 0);
    } else if (this.previews.some(preview => preview.visible && preview.signature !== this.signature) && this.visible()) {
      const time = this.reducedMotion ? STATIC_PREVIEW_TIME : Math.max(0, this.runtime.now() - this.startedAt);
      for (const preview of this.previews) if (preview.visible) this.reconcile(preview, time);
    }
  }

  private drawStaticPreviews(): void {
    const candidates = this.open
      ? this.visible() ? this.previews.filter(preview => preview.visible) : []
      : this.previews.filter(preview => preview.preset === this.settings?.preset);
    for (const preview of candidates) {
      if (preview.staticFrameSignature === preview.signature) continue;
      preview.renderer.draw(STATIC_PREVIEW_TIME);
      preview.staticFrameSignature = preview.signature;
    }
  }

  private onMotionPreferenceChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
    this.syncAnimation();
  };

  private paintSelection(): void {
    const selected = this.previews.find(preview => preview.preset === this.settings?.preset);
    for (const preview of this.previews) {
      const active = preview === selected;
      if (preview.button.getAttribute('aria-selected') !== String(active)) preview.button.setAttribute('aria-selected', String(active));
      if (preview.button.tabIndex !== (active ? 0 : -1)) preview.button.tabIndex = active ? 0 : -1;
      if (preview.button.disabled !== this.disabled) preview.button.disabled = this.disabled;
      if (this.open || !active) { if (preview.svg.parentElement !== preview.slot) preview.slot.append(preview.svg); }
      else if (preview.svg.parentElement !== this.summaryPreview) this.summaryPreview.append(preview.svg);
    }
    if (this.summaryPreview.hidden !== this.open) this.summaryPreview.hidden = this.open;
    const caption = selected?.button.querySelector('.stagecraft-pattern-choice-label')?.textContent ?? '';
    if (this.caption.textContent !== caption) this.caption.textContent = caption;
    const action = this.t(this.open ? 'STAGECRAFT.Editor.PatternCollapse' : 'STAGECRAFT.Editor.PatternCompare');
    if (this.action.textContent !== action) this.action.textContent = action;
  }

  private setOpen(open: boolean): void {
    if (this.disposed || open && (this.disabled || !this.settings)) return;
    if (this.open === open) return;
    // Refresh deferred palettes/geometry before unhiding the gallery. Later
    // offscreen changes wait for the intersection/ancestor visibility callback.
    if (open) for (const preview of this.previews) this.reconcile(preview, this.reducedMotion ? STATIC_PREVIEW_TIME : 0);
    this.open = open; this.grid.hidden = !open; this.toggle.setAttribute('aria-expanded', String(open));
    if (open) { this.startedAt = this.runtime.now(); this.lastDraw = -Infinity; }
    this.paintSelection(); this.syncAnimation();
  }

  private choose(preview: PatternPreview): void {
    if (!this.open || this.disabled || this.select.disabled || this.select.matches(':disabled') || this.disposed
      || !this.previews.includes(preview)) return;
    if (this.select.value === preview.preset && !(this.settings?.version === 1
      && (preview.preset === 'halftone' || preview.preset === 'energy-trails'))) return;
    this.select.value = preview.preset;
    // Exactly one normal select change; the editor owns validation, draft replacement and Undo.
    const EventClass = this.host.ownerDocument.defaultView?.Event ?? Event;
    this.select.dispatchEvent(new EventClass('change', { bubbles: true }));
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.target === this.toggle && event.key === 'ArrowDown' && !this.disabled) {
      event.preventDefault(); event.stopPropagation(); this.setOpen(true);
      this.previews.find(preview => preview.preset === this.settings?.preset)?.button.focus(); return;
    }
    if (event.key === 'Escape' && this.open) {
      event.preventDefault(); event.stopPropagation(); this.setOpen(false); this.toggle.focus(); return;
    }
    if (!this.open || this.disabled) return;
    const index = this.previews.findIndex(preview => preview.button === event.target);
    if (index < 0) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation(); this.choose(this.previews[index]!); return;
    }
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1
      : event.key === 'ArrowDown' ? 2 : event.key === 'ArrowUp' ? -2 : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.previews.length - 1
      : delta ? (index + delta + this.previews.length) % this.previews.length : -1;
    if (next < 0) return;
    event.preventDefault(); event.stopPropagation();
    for (const [position, preview] of this.previews.entries()) preview.button.tabIndex = position === next ? 0 : -1;
    this.previews[next]!.button.focus(); this.previews[next]!.button.scrollIntoView?.({ block: 'nearest' });
  }

  private visible(): boolean {
    if (!this.root.isConnected || !this.intersecting || this.host.ownerDocument.hidden) return false;
    for (let node: HTMLElement | null = this.host; node; node = node.parentElement) {
      if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false;
      const style = this.host.ownerDocument.defaultView?.getComputedStyle(node);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
    }
    return true;
  }

  private canAnimate(): boolean {
    return !this.disposed && !this.reducedMotion && this.open && !this.disabled && !this.select.disabled && !this.select.matches(':disabled')
      && !!this.settings?.speed && this.visible() && this.previews.some(preview => preview.visible);
  }

  private syncAnimation(): void {
    if (this.disposed) return;
    this.reconcileVisible();
    if (this.reducedMotion) this.drawStaticPreviews();
    if (!this.canAnimate()) { this.stopAnimation(); return; }
    if (this.frame === undefined) this.frame = this.runtime.requestFrame(time => this.tick(time));
  }

  private tick(time: number): void {
    this.frame = undefined;
    if (!this.canAnimate()) return;
    if (time - this.lastDraw >= FRAME_INTERVAL) {
      this.lastDraw = time;
      for (const preview of this.previews) if (preview.visible) {
        preview.staticFrameSignature = '';
        preview.renderer.draw(Math.max(0, time - this.startedAt));
      }
    }
    this.syncAnimation();
  }

  private stopAnimation(): void {
    if (this.frame !== undefined) this.runtime.cancelFrame(this.frame);
    this.frame = undefined;
  }

  private releasePreviews(): void {
    this.stopAnimation();
    for (const preview of this.previews) {
      this.intersection?.unobserve(preview.button); preview.renderer.dispose(); preview.svg.remove(); preview.button.remove();
    }
    this.previews.length = 0; this.signature = ''; this.caption.textContent = '';
  }
}
