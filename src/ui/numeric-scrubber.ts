export interface NumericScrubberContext {
  readonly editable: boolean;
  /** Changes with the draft or selection, but not with the advancing preview clock. */
  readonly identity: string;
}

export interface NumericScrubberCallbacks {
  read(input: HTMLInputElement): NumericScrubberContext;
  before(input: HTMLInputElement): boolean;
  preview(input: HTMLInputElement, value: number): boolean;
  commit(input: HTMLInputElement, value: number): boolean;
  cancel(input: HTMLInputElement): void;
}

interface Control {
  readonly input: HTMLInputElement;
  readonly title: string;
}

interface PendingDrag {
  readonly pointerId: number;
  readonly control: Control;
  readonly identity: string;
  readonly startX: number;
  readonly startY: number;
  readonly startText: string;
}

interface Gesture {
  readonly pointerId: number;
  readonly control: Control;
  readonly identity: string;
  readonly startX: number;
  readonly startValue: number;
  readonly startText: string;
  value: number;
  text: string;
}

const DRAG_PIXELS_PER_STEP = 4;
const DRAG_THRESHOLD = 4;
const FINE_DRAG_PIXELS_PER_STEP = 20;
const MAX_DECIMAL_PLACES = 20;

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  const [mantissa = '', exponentText] = text.split('e');
  const fraction = mantissa.split('.')[1]?.length ?? 0;
  return Math.max(0, Math.min(MAX_DECIMAL_PLACES, fraction - Number(exponentText ?? 0)));
}

function numberText(value: number, precision: number): string {
  const rounded = Number(value.toFixed(Math.max(0, Math.min(MAX_DECIMAL_PLACES, precision))));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function fallbackStep(input: HTMLInputElement, value: number): number {
  const name = input.name.toLowerCase();
  if (/^(video|image|solid)-(x|y|width|height)$/.test(name)
    || /^title-(x|y|width|height|size|minimum-size)$/.test(name)) return 1;
  if (/^(?:title-(?:size|minimum-size)|(?:(?:image|solid)-)?outline-width|(?:(?:image|solid)-)?shadow-(?:offset-x|offset-y|blur)|(?:(?:image|solid)-)?glow-radius)$/.test(name)) return 1;
  if (/^solid-pattern-(speed|scale|density|intensity)$/.test(name)) return 0.05;
  if (name === 'bars-height') return 0.1;
  if (/(opacity|volume|tolerance|softness|crop-|mask-|percent)/.test(name)) return 0.1;
  if (/(start|duration|entrance|exit|break-position|video-(in|out)|audio-(in|out))/.test(name)) return 0.1;
  const places = decimalPlaces(value);
  return places ? 10 ** -places : 1;
}

function baseStep(input: HTMLInputElement, value: number): number {
  if (input.step && input.step !== 'any') {
    const parsed = Number(input.step);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallbackStep(input, value);
}

function limits(input: HTMLInputElement): { min: number; max: number } {
  const minimum = input.min.trim() === '' ? Number.NEGATIVE_INFINITY : Number(input.min);
  const maximum = input.max.trim() === '' ? Number.POSITIVE_INFINITY : Number(input.max);
  return {
    min: Number.isFinite(minimum) ? minimum : Number.NEGATIVE_INFINITY,
    max: Number.isFinite(maximum) ? maximum : Number.POSITIVE_INFINITY
  };
}

function effectiveValue(input: HTMLInputElement, gesture: Gesture, clientX: number, shift: boolean, alt: boolean): number {
  const base = baseStep(input, gesture.startValue);
  const fineStepIsValid = input.step === 'any';
  const fine = alt && !shift;
  const quantum = shift ? base * 10 : fine && fineStepIsValid ? base / 10 : base;
  const pixelsPerStep = fine ? FINE_DRAG_PIXELS_PER_STEP : DRAG_PIXELS_PER_STEP;
  const deltaSteps = Math.trunc((clientX - gesture.startX) / pixelsPerStep);
  if (deltaSteps === 0) return gesture.startValue;
  const { min, max } = limits(input);
  const validationStep = input.step === 'any' ? quantum : base;

  // Step from the gesture's valid starting point so min-based step grids stay valid.
  let next = gesture.startValue + deltaSteps * quantum;
  const precision = Math.max(decimalPlaces(gesture.startValue), decimalPlaces(base), decimalPlaces(quantum)) + (fine && fineStepIsValid ? 1 : 0);
  next = Number(next.toFixed(Math.min(MAX_DECIMAL_PLACES, precision)));

  if (deltaSteps > 0 && next > max) {
    if (input.step === 'any' && Number.isFinite(max)) next = max;
    else {
      const count = Number.isFinite(max) ? Math.max(0, Math.floor((max - gesture.startValue) / validationStep + 1e-9)) : deltaSteps;
      next = gesture.startValue + count * validationStep;
    }
  } else if (deltaSteps < 0 && next < min) {
    if (input.step === 'any' && Number.isFinite(min)) next = min;
    else {
      const count = Number.isFinite(min) ? Math.max(0, Math.floor((gesture.startValue - min) / validationStep + 1e-9)) : -deltaSteps;
      next = gesture.startValue - count * validationStep;
    }
  }
  return next;
}

function hasHiddenAncestor(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden) return true;
  }
  return false;
}

function isUsable(control: Control, root: HTMLElement, context: NumericScrubberContext): boolean {
  const { input } = control;
  const nativeDisabled = input.matches?.(':disabled') ?? input.disabled;
  return context.editable && root.contains(input) && !input.disabled && !nativeDisabled && !input.readOnly
    && !hasHiddenAncestor(input);
}

/** Number fields retain native editing until a horizontal drag crosses the threshold. */
export class NumericScrubbers {
  private readonly listeners = new AbortController();
  private readonly controls = new Map<HTMLInputElement, Control>();
  private gesture: Gesture | null = null;
  private pending: PendingDrag | null = null;
  private disposed = false;

  constructor(private readonly root: HTMLElement, private readonly t: (key: string) => string, private readonly callbacks: NumericScrubberCallbacks) {
    root.addEventListener('pointerdown', event => this.down(event), { signal: this.listeners.signal });
    // PointerEvent.detail is commonly zero. The following native mousedown carries
    // the click count, so a second-click text selection must disarm the pending drag.
    root.addEventListener('mousedown', event => { if (event.detail > 1) this.pending = null; }, { signal: this.listeners.signal });
    // Pending clicks have no capture, so watch their release even outside the inspector.
    const pointerSurface = root.ownerDocument ?? root;
    pointerSurface.addEventListener('pointermove', event => this.move(event), { signal: this.listeners.signal });
    pointerSurface.addEventListener('pointerup', event => this.up(event), { signal: this.listeners.signal });
    pointerSurface.addEventListener('pointercancel', event => {
      if (this.gesture?.pointerId === event.pointerId || this.pending?.pointerId === event.pointerId) this.cancel();
    }, { signal: this.listeners.signal });
    root.addEventListener('lostpointercapture', event => { if (this.gesture?.pointerId === event.pointerId) this.cancel(); }, { signal: this.listeners.signal });
    root.addEventListener('keydown', event => this.keydown(event), { capture: true, signal: this.listeners.signal });
    for (const type of ['beforeinput', 'input', 'change', 'blur', 'focusout']) {
      root.addEventListener(type, event => this.blockNativeEdit(event), { capture: true, signal: this.listeners.signal });
    }
    this.update();
  }

  update(): void {
    if (this.disposed) return;
    if (this.pending && !this.matchesPending(this.pending)) this.pending = null;
    if (this.gesture && !this.matches(this.gesture)) this.cancel();
    this.syncControls();
    for (const control of this.controls.values()) {
      const context = this.callbacks.read(control.input);
      const usable = isUsable(control, this.root, context);
      if (usable) control.input.classList.add('stagecraft-numeric-scrubbable');
      else control.input.classList.remove('stagecraft-numeric-scrubbable');
    }
  }

  /** Polygon coordinate lists can replace or add fields after construction. */
  private syncControls(): void {
    const inputs = new Set(this.root.querySelectorAll<HTMLInputElement>('[data-stagecraft-inspector] input[type="number"]'));
    for (const [input, control] of this.controls) {
      if (inputs.has(input)) continue;
      input.title = control.title;
      input.classList.remove('stagecraft-numeric-scrubbable'); input.classList.remove('stagecraft-numeric-scrubbing');
      this.controls.delete(input);
    }
    for (const input of inputs) {
      if (this.controls.has(input)) continue;
      this.controls.set(input, { input, title: input.title });
      input.title = [input.title, this.t('NumericScrubberHelp')].filter(Boolean).join(' ');
    }
  }

  cancel(): void {
    this.pending = null;
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    gesture.control.input.classList.remove('stagecraft-numeric-scrubbing');
    this.release(gesture);
    gesture.control.input.value = gesture.startText;
    this.callbacks.cancel(gesture.control.input);
    this.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.listeners.abort();
    for (const { input, title } of this.controls.values()) {
      input.title = title;
      input.classList.remove('stagecraft-numeric-scrubbable');
      input.classList.remove('stagecraft-numeric-scrubbing');
    }
    this.controls.clear();
  }

  private target(event: Event): Control | null {
    return event.target instanceof HTMLInputElement ? this.controls.get(event.target) ?? null : null;
  }

  private down(event: PointerEvent): void {
    const control = this.target(event);
    if (!control || event.button !== 0 || this.gesture || this.pending || event.ctrlKey || event.metaKey || event.detail > 1) return;
    const context = this.callbacks.read(control.input);
    if (!isUsable(control, this.root, context)) return;
    // Do not interfere with native focusing, caret placement, or number spinner clicks.
    this.pending = { pointerId: event.pointerId, control, identity: context.identity, startX: event.clientX,
      startY: event.clientY, startText: control.input.value };
  }

  private begin(event: PointerEvent): void {
    const pending = this.pending;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (!this.matchesPending(pending)) { this.pending = null; return; }
    const horizontal = Math.abs(event.clientX - pending.startX);
    const vertical = Math.abs(event.clientY - pending.startY);
    if (vertical >= DRAG_THRESHOLD && vertical > horizontal) { this.pending = null; return; }
    if (horizontal < DRAG_THRESHOLD) return;
    this.pending = null;
    const control = pending.control;
    // checkValidity dispatches native invalid events: only validate an intended
    // drag, never the click used to focus or correct an incomplete number.
    if (!control.input.checkValidity()) return;
    if (!this.callbacks.before(control.input)) return;
    const current = this.callbacks.read(control.input);
    const value = control.input.value.trim() === '' ? Number.NaN : Number(control.input.value);
    if (!isUsable(control, this.root, current) || !Number.isFinite(value)
      || !control.input.checkValidity()) { this.callbacks.cancel(control.input); return; }
    const gesture: Gesture = { pointerId: event.pointerId, control, identity: current.identity, startX: pending.startX,
      startValue: value, startText: control.input.value, value, text: control.input.value };
    this.gesture = gesture;
    control.input.classList.add('stagecraft-numeric-scrubbing');
    try { control.input.setPointerCapture(event.pointerId); }
    catch { this.cancel(); return; }
    event.preventDefault();
    event.stopPropagation();
  }

  private move(event: PointerEvent): void {
    if (!this.gesture) this.begin(event);
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!this.matches(gesture)) { this.cancel(); return; }
    const value = effectiveValue(gesture.control.input, gesture, event.clientX, event.shiftKey, event.altKey);
    const text = value === gesture.startValue ? gesture.startText
      : numberText(value, Math.max(decimalPlaces(gesture.startValue), decimalPlaces(value), decimalPlaces(baseStep(gesture.control.input, gesture.startValue)) + (event.altKey && !event.shiftKey && gesture.control.input.step === 'any' ? 1 : 0)));
    if (text !== gesture.text) {
      gesture.control.input.value = text;
      if (gesture.control.input.checkValidity() && this.callbacks.preview(gesture.control.input, value)) {
        gesture.value = value;
        gesture.text = text;
      } else gesture.control.input.value = gesture.text;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  private up(event: PointerEvent): void {
    // A release alone never turns a click into a drag.
    if (this.pending?.pointerId === event.pointerId) { this.pending = null; return; }
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.move(event);
    if (this.gesture !== gesture) return;
    this.gesture = null;
    gesture.control.input.classList.remove('stagecraft-numeric-scrubbing');
    this.release(gesture);
    if (gesture.text === gesture.startText || !this.matchesIdentity(gesture)) {
      gesture.control.input.value = gesture.startText;
      this.callbacks.cancel(gesture.control.input);
      this.update();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    gesture.control.input.value = gesture.text;
    if (!gesture.control.input.checkValidity() || !this.callbacks.commit(gesture.control.input, gesture.value)) {
      gesture.control.input.value = gesture.startText;
      this.callbacks.cancel(gesture.control.input);
    }
    this.update();
    event.preventDefault();
    event.stopPropagation();
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.gesture) { this.cancel(); event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); return; }
    // Pointer movement is one transaction. Keyboard input during that capture
    // must not commit a second edit or make Escape unable to restore the start.
    if (!this.gesture) { this.pending = null; return; }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  private blockNativeEdit(event: Event): void {
    const gesture = this.gesture;
    if (!gesture || event.target !== gesture.control.input) return;
    gesture.control.input.value = gesture.text;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private matchesPending(pending: PendingDrag): boolean {
    const context = this.callbacks.read(pending.control.input);
    return isUsable(pending.control, this.root, context) && context.identity === pending.identity
      && pending.control.input.value === pending.startText;
  }

  private matches(gesture: Gesture): boolean {
    const context = this.callbacks.read(gesture.control.input);
    return isUsable(gesture.control, this.root, context) && context.identity === gesture.identity;
  }

  private matchesIdentity(gesture: Gesture): boolean {
    const context = this.callbacks.read(gesture.control.input);
    return context.editable && context.identity === gesture.identity && this.root.contains(gesture.control.input);
  }

  private release(gesture: Gesture): void {
    const input = gesture.control.input;
    if (input.hasPointerCapture(gesture.pointerId)) input.releasePointerCapture(gesture.pointerId);
  }
}
