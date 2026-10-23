import type { PlaybackVolume } from '../application/playback-volume.js';

const HIDE_DELAY_MS = 2500;

function clampVolume(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** A local-only playback control; its caller chooses the playback surface root. */
export class PlaybackVolumeHud {
  readonly element: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLOutputElement;
  private readonly windowTarget: Window;
  private readonly listeners: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];
  private readonly unsubscribe: () => void;
  private currentValue: number;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private activePointerId: number | null = null;
  private pointerListenersAttached = false;
  private pointerInside = false;
  private focusWithin = false;
  private disposed = false;

  constructor(private readonly volume: PlaybackVolume, options: { label: string }) {
    this.windowTarget = window;
    this.currentValue = clampVolume(volume.value, 1);

    const element = document.createElement('div');
    element.className = 'stagecraft-playback-volume is-hidden';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', options.label);
    element.setAttribute('data-stagecraft-playback-volume', '');

    const slider = document.createElement('input');
    slider.className = 'stagecraft-playback-volume__slider';
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    slider.setAttribute('aria-label', options.label);
    slider.setAttribute('data-stagecraft-playback-volume-control', '');

    const readout = document.createElement('output');
    readout.className = 'stagecraft-playback-volume__value';
    readout.setAttribute('aria-hidden', 'true');

    element.append(slider, readout);
    this.element = element;
    this.slider = slider;
    this.readout = readout;

    this.listen(slider, 'input', this.onInput);
    this.listen(slider, 'pointerdown', this.onPointerDown);
    this.listen(element, 'pointerenter', this.onPointerEnter);
    this.listen(element, 'pointerleave', this.onPointerLeave);
    this.listen(element, 'focusin', this.onFocusIn);
    this.listen(element, 'focusout', this.onFocusOut);
    this.render(this.currentValue);
    this.unsubscribe = volume.subscribe(value => this.render(value));
  }

  /** Reveal the control without moving keyboard focus. */
  reveal(): void {
    if (this.disposed) return;
    this.setVisible(true);
    this.scheduleHide();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHideTimer();
    this.detachPointerListeners();
    this.activePointerId = null;
    this.unsubscribe();
    for (const { target, type, listener } of this.listeners) target.removeEventListener(type, listener);
    this.listeners.length = 0;
    this.element.remove();
  }

  private listen(target: EventTarget, type: string, callback: (event: Event) => void): void {
    const listener: EventListener = event => callback(event);
    target.addEventListener(type, listener);
    this.listeners.push({ target, type, listener });
  }

  private readonly onInput = (): void => {
    const value = Number(this.slider.value);
    if (!Number.isFinite(value)) {
      this.render(this.currentValue);
      return;
    }
    const normalized = clampVolume(value, this.currentValue);
    this.render(normalized);
    this.volume.set(normalized);
  };

  private readonly onPointerEnter = (): void => {
    this.pointerInside = true;
    this.reveal();
  };

  private readonly onPointerLeave = (): void => {
    this.pointerInside = false;
    this.scheduleHide();
  };

  private readonly onFocusIn = (): void => {
    this.focusWithin = true;
    this.reveal();
  };

  private readonly onFocusOut = (event: Event): void => {
    const nextTarget = (event as FocusEvent).relatedTarget;
    this.focusWithin = typeof nextTarget === 'object' && nextTarget !== null
      && typeof (nextTarget as { nodeType?: unknown }).nodeType === 'number'
      && this.element.contains(nextTarget as Node);
    this.scheduleHide();
  };

  private readonly onPointerDown = (event: Event): void => {
    if (this.disposed || this.activePointerId !== null) return;
    const pointerId = (event as PointerEvent).pointerId;
    this.activePointerId = Number.isFinite(pointerId) ? pointerId : 0;
    this.reveal();
    this.attachPointerListeners();
  };

  private readonly onPointerEnd = (event: Event): void => {
    if (this.activePointerId === null) return;
    const pointerId = (event as PointerEvent).pointerId;
    if (Number.isFinite(pointerId) && pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    this.detachPointerListeners();
    this.scheduleHide();
  };

  private attachPointerListeners(): void {
    if (this.pointerListenersAttached) return;
    this.pointerListenersAttached = true;
    this.windowTarget.addEventListener('pointerup', this.onPointerEnd);
    this.windowTarget.addEventListener('pointercancel', this.onPointerEnd);
  }

  private detachPointerListeners(): void {
    if (!this.pointerListenersAttached) return;
    this.pointerListenersAttached = false;
    this.windowTarget.removeEventListener('pointerup', this.onPointerEnd);
    this.windowTarget.removeEventListener('pointercancel', this.onPointerEnd);
  }

  private render(value: number): void {
    if (this.disposed) return;
    this.currentValue = clampVolume(value, this.currentValue);
    this.slider.value = String(this.currentValue);
    const percentage = Math.round(this.currentValue * 100);
    const text = `${percentage}%`;
    this.slider.setAttribute('aria-valuetext', text);
    this.readout.textContent = text;
  }

  private setVisible(visible: boolean): void {
    if (visible) this.element.classList.remove('is-hidden');
    else this.element.classList.add('is-hidden');
  }

  private clearHideTimer(): void {
    if (this.hideTimer === null) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private scheduleHide(): void {
    this.clearHideTimer();
    if (this.disposed || this.pointerInside || this.focusWithin || this.activePointerId !== null) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (this.disposed || this.pointerInside || this.focusWithin || this.activePointerId !== null) return;
      this.setVisible(false);
    }, HIDE_DELAY_MS);
  }
}
