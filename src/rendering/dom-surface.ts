import type { CompiledSequence } from '../playback/evaluate.js';
import type { PlayerFrame, Surface } from '../playback/local-player.js';
import { CompositionRenderer } from './composition-renderer.js';
import type { RendererOptions } from './element-renderer.js';
import { abortError } from './media-preparation.js';
import type { PlaybackVolume } from '../application/playback-volume.js';
import { PlaybackVolumeHud } from '../ui/playback-volume-hud.js';

export interface SurfaceControls {
  stop(): void;
  fade?(): void;
  togglePause?(): void;
  continue?(): void;
  /** Shared transport UI is moved into the top layer and restored on disposal. */
  panel?: HTMLElement;
  labels: { stop: string; fade: string; pause: string; resume: string; playback: string; continue?: string };
}

/** All three targets use the same renderer and player. No Foundry globals here. */
export class DomSurface implements Surface {
  private root: HTMLElement | null = null;
  private renderer: CompositionRenderer | null = null;
  private controlsRoot: HTMLElement | null = null;
  private volumeHud: PlaybackVolumeHud | null = null;
  private pauseButton: HTMLButtonElement | null = null;
  private continueButton: HTMLButtonElement | null = null;
  private listeners = new AbortController();
  private resources = new AbortController();
  private plan: CompiledSequence | null = null;
  private mounted = false;
  private panelPlaceholder: Comment | null = null;
  private observer: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private focusBefore: HTMLElement | null = null;
  private movedFocus = false;
  private inertElements = new Set<HTMLElement>();
  private disposed = false;
  constructor(private readonly options: {
    target: 'preview' | 'window' | 'canvas';
    preview?: HTMLElement;
    board?: HTMLElement;
    controls?: SurfaceControls;
    /** Only received group playback exposes this local control; editor preview stays authored. */
    playbackVolume?: PlaybackVolume;
    volumeLabel?: string;
  } & Omit<RendererOptions, 'signal'>) {}

  async prepare(plan: CompiledSequence, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.disposed) throw abortError();
    const { target, preview, board, controls } = this.options;
    if (target === 'preview' && !preview?.isConnected) throw new Error('PREVIEW_UNAVAILABLE');
    if (target === 'canvas' && (!board?.isConnected || !board.getBoundingClientRect().height)) throw new Error('CANVAS_UNAVAILABLE');
    if (target !== 'preview' && !controls) throw new Error('CONTROLS_REQUIRED');
    this.plan = plan;
    const root = document.createElement('div');
    this.root = root;
    root.className = `stagecraft-surface stagecraft-surface-${target}`;
    root.dataset.stagecraftSurface = target;
    const composition = document.createElement('div');
    composition.className = 'stagecraft-composition';
    if (this.options.still || !this.options.onButtonActivate || !plan.clips.some(clip => clip.type === 'button')) {
      composition.setAttribute('aria-hidden', 'true');
    }
    root.append(composition);
    signal.addEventListener('abort', () => this.dispose(), { once: true, signal: this.listeners.signal });
    try {
      this.renderer = new CompositionRenderer(plan.clips, composition, plan.snapshot.composition,
        { ...this.options, signal: this.resources.signal });
      await this.renderer.prepare();
      if (signal.aborted || this.disposed) throw abortError();
    } catch (error) { this.dispose(); throw error; }
  }

  /** Preparation owns detached nodes only; interaction changes begin on the first player frame. */
  private mount(): void {
    if (this.mounted || this.disposed || !this.root || !this.plan) return;
    const root = this.root;
    const plan = this.plan;
    const { target, preview, board, controls } = this.options;
    if (target === 'preview' && !preview?.isConnected) throw new Error('PREVIEW_UNAVAILABLE');
    if (target === 'canvas' && (!board?.isConnected || !board.getBoundingClientRect().height)) throw new Error('CANVAS_UNAVAILABLE');
    this.focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (target === 'preview') {
      preview!.append(root);
      this.mounted = true;
      return;
    }
    if (!controls) throw new Error('CONTROLS_REQUIRED');
    // The controls live independently of the fading composition.
    const toolbar = controls.panel ?? document.createElement('div');
    if (controls.panel?.parentNode) {
      this.panelPlaceholder = document.createComment('stagecraft-controls-position');
      controls.panel.before(this.panelPlaceholder);
    }
    toolbar.classList.add('stagecraft-playback-controls');
    if (this.options.playbackVolume) toolbar.classList.add('stagecraft-playback-controls-with-volume');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', controls.labels.playback);
    const label = document.createElement('span');
    label.className = 'stagecraft-run-name';
    label.textContent = plan.snapshot.name;
    if (!controls.panel) toolbar.append(label);
    const button = (text: string, action: () => void) => {
      const element = document.createElement('button');
      element.type = 'button'; element.textContent = text;
      element.addEventListener('click', action, { signal: this.listeners.signal });
      toolbar.append(element); return element;
    };
    if (!controls.panel && controls.togglePause) this.pauseButton = button(controls.labels.pause, controls.togglePause);
    if (!controls.panel && controls.continue) {
      this.continueButton = button(controls.labels.continue ?? '', controls.continue);
      this.continueButton.dataset.stagecraftContinue = '';
      this.continueButton.hidden = true;
    }
    if (!controls.panel && controls.fade) button(controls.labels.fade, controls.fade);
    const stop = controls.panel?.querySelector<HTMLButtonElement>('[data-session-action="exit"]') ?? button(controls.labels.stop, controls.stop);
    stop.classList.add('stagecraft-stop');
    this.controlsRoot = toolbar;
    document.body.append(root);
    if (target === 'window') {
      // Native top layer stays above Foundry's ordinary application windows.
      root.setAttribute('popover', 'manual');
      root.append(toolbar);
      root.showPopover();
    } else {
      document.body.append(toolbar);
      const position = () => {
        const rect = board!.getBoundingClientRect();
        Object.assign(root.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      };
      position(); this.resizeObserver = new ResizeObserver(position); this.resizeObserver.observe(board!);
      window.addEventListener('resize', position, { signal: this.listeners.signal });
    }
    if (this.options.playbackVolume) {
      this.volumeHud = new PlaybackVolumeHud(this.options.playbackVolume, { label: this.options.volumeLabel ?? 'Volume' });
      root.append(this.volumeHud.element);
      // Capture still sees movement while the overlay blocks underlying game interaction.
      const revealVolume = () => this.volumeHud?.reveal();
      window.addEventListener('pointermove', revealVolume, { capture: true, passive: true, signal: this.listeners.signal });
      window.addEventListener('mousemove', revealVolume, { capture: true, passive: true, signal: this.listeners.signal });
      this.volumeHud.reveal();
    }
    const block = plan.snapshot.presentation.blockInput;
    root.classList.toggle('stagecraft-block-input', block);
    const lockNewElements = () => {
      if (target !== 'window' || !block) return;
      for (const element of document.body.children) {
        if (element instanceof HTMLElement && element !== root && element !== toolbar && !element.inert && !['SCRIPT','STYLE','LINK'].includes(element.tagName)) {
          element.inert = true; this.inertElements.add(element);
        }
      }
    };
    lockNewElements();
    this.observer = new MutationObserver(() => {
      if (!root.isConnected || (target === 'canvas' && !board!.isConnected)) { controls.stop(); return; }
      lockNewElements();
    });
    this.observer.observe(document.body, { childList: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.type === 'keydown' && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); controls.stop(); return; }
      const node = event.target;
      const authoredButton = node instanceof Element ? node.closest('[data-stagecraft-interactive]') : null;
      if (node instanceof Node && (toolbar.contains(node) || this.volumeHud?.element.contains(node)
        || (authoredButton && root.contains(authoredButton)))) {
        // Native button activation and Tab still run; Foundry must not also handle these keys.
        event.stopImmediatePropagation();
        return;
      }
      if (!block) return;
      const canvasKey = node === document.body || node === document.documentElement || node === board || node === root;
      if (target === 'window' || canvasKey) {
        // Keep browser focus navigation available when a control update leaves focus on the page.
        if (event.key !== 'Tab') event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', keyboard, { capture: true, signal: this.listeners.signal });
    window.addEventListener('keyup', keyboard, { capture: true, signal: this.listeners.signal });
    // A native modal owns its own top layer; release the game instead of stranding the exit behind it.
    document.addEventListener('toggle', event => {
      if (target === 'window' && event.target instanceof HTMLDialogElement && event.target.open) controls.stop();
    }, { capture: true, signal: this.listeners.signal });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !root.isConnected) controls.stop();
    }, { signal: this.listeners.signal });
    if (block) {
      stop.focus({ preventScroll: true });
      this.movedFocus = document.activeElement === stop && this.focusBefore !== stop;
    }
    this.mounted = true;
  }

  /** Editor callers serialize updates and retain the original lifetime abort signal. */
  async updateStill(plan: CompiledSequence): Promise<void> {
    if (!this.options.still || this.disposed || !this.renderer) return;
    this.plan = plan;
    try { await this.renderer.updateStill(plan.clips); }
    catch (error) {
      if (!this.disposed && !this.resources.signal.aborted) this.options.onError?.(error);
      throw error;
    }
  }

  updatePreview(plan: CompiledSequence): void {
    if (this.options.target !== 'preview' || this.disposed || !this.renderer) return;
    this.renderer.updatePreview(plan.clips);
    this.plan = plan;
  }

  render(frame: PlayerFrame): void {
    if (this.disposed) return;
    this.mount();
    this.renderer?.draw(frame);
    if (this.root) {
      this.root.dataset.firstPositionMs ??= String(frame.positionMs);
      this.root.dataset.positionMs = String(frame.positionMs); this.root.dataset.phase = frame.phase;
    }
    if (this.pauseButton && this.options.controls) {
      const label = frame.phase === 'paused' ? this.options.controls.labels.resume : this.options.controls.labels.pause;
      if (this.pauseButton.textContent !== label) this.pauseButton.textContent = label;
      this.pauseButton.disabled = frame.phase === 'exiting';
    }
    if (this.continueButton) this.continueButton.hidden = frame.phase !== 'holding'
      && !(frame.phase === 'paused' && frame.holdElapsedMs !== undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const focus = document.activeElement;
    const restoreFocus = this.movedFocus && (focus === document.body
      || this.root?.contains(focus) || this.controlsRoot?.contains(focus));
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    for (const element of this.inertElements) element.inert = false;
    this.inertElements.clear();
    this.controlsRoot?.classList.remove('stagecraft-playback-controls-with-volume');
    if (this.controlsRoot && this.options.controls?.panel) {
      if (this.panelPlaceholder?.isConnected) this.panelPlaceholder.replaceWith(this.controlsRoot);
      else document.body.append(this.controlsRoot);
    }
    else this.controlsRoot?.remove();
    this.panelPlaceholder?.remove(); this.panelPlaceholder = null;
    this.listeners.abort(); this.resources.abort();
    this.volumeHud?.dispose(); this.volumeHud = null;
    this.renderer?.dispose();
    this.root?.remove();
    if (restoreFocus && this.focusBefore?.isConnected) this.focusBefore.focus({ preventScroll: true });
    this.root = null; this.renderer = null; this.plan = null;
    this.pauseButton = null; this.continueButton = null;
  }
}
