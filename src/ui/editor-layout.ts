export interface EditorLayoutSizes { library: number; inspector: number; timeline: number; }
type Panel = keyof EditorLayoutSizes;
export interface EditorLayoutGeometry { width: number; height: number; chromeHeight: number; }
export interface EditorLayoutLimits { sizes: EditorLayoutSizes; maximum: EditorLayoutSizes; stacked: boolean; }

const HANDLE = 6;
const MINIMUM: EditorLayoutSizes = { library: 140, inspector: 240, timeline: 200 };
const DEFAULT: EditorLayoutSizes = { library: 180, inspector: 300, timeline: 250 };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const valid = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;

/** Keep enough room for the preview and transport, including the stacked narrow layout. */
export function fitEditorLayout(preferred: EditorLayoutSizes, geometry: EditorLayoutGeometry): EditorLayoutLimits {
  const width = Math.max(0, valid(geometry.width, 0));
  const stacked = width <= 850;
  const available = width - (stacked ? 240 + HANDLE : 320 + 2 * HANDLE);
  const maxLibrary = Math.max(MINIMUM.library, available - (stacked ? 0 : MINIMUM.inspector));
  const library = clamp(valid(preferred.library, DEFAULT.library), MINIMUM.library, maxLibrary);
  const maxInspector = Math.max(MINIMUM.inspector, available - library);
  const inspector = stacked ? clamp(valid(preferred.inspector, DEFAULT.inspector), MINIMUM.inspector, 600)
    : clamp(valid(preferred.inspector, DEFAULT.inspector), MINIMUM.inspector, maxInspector);
  const maxTimeline = Math.max(MINIMUM.timeline, valid(geometry.height, 0) - valid(geometry.chromeHeight, 0) - (stacked ? 330 : 260) - HANDLE);
  return {
    sizes: { library, inspector, timeline: clamp(valid(preferred.timeline, DEFAULT.timeline), MINIMUM.timeline, maxTimeline) },
    maximum: { library: Math.max(MINIMUM.library, available - (stacked ? 0 : inspector)), inspector: maxInspector, timeline: maxTimeline },
    stacked
  };
}

interface Gesture {
  panel: Panel; pointerId: number; start: number; size: number; original: EditorLayoutSizes; handle: HTMLElement;
}

/** UI-only panel sizing. The supplied object retains user choices across editor remounts. */
export class EditorLayout {
  private readonly listeners = new AbortController();
  private readonly observer: ResizeObserver | null;
  private readonly handles = new Map<Panel, HTMLElement>();
  private limits: EditorLayoutLimits;
  private gesture: Gesture | null = null;
  private disposed = false;

  constructor(private readonly root: HTMLElement, private readonly preferred: EditorLayoutSizes) {
    for (const handle of root.querySelectorAll<HTMLElement>('[data-stagecraft-splitter]')) {
      const panel = handle.dataset.stagecraftSplitter;
      if (panel === 'library' || panel === 'inspector' || panel === 'timeline') this.handles.set(panel, handle);
    }
    this.limits = fitEditorLayout(preferred, this.geometry());
    const options = { signal: this.listeners.signal };
    root.addEventListener('pointerdown', event => this.begin(event), options);
    root.addEventListener('pointermove', event => this.move(event), options);
    root.addEventListener('pointerup', event => this.finish(event), options);
    root.addEventListener('pointercancel', event => { if (event.pointerId === this.gesture?.pointerId) this.cancel(); }, options);
    root.addEventListener('lostpointercapture', event => { if (event.pointerId === this.gesture?.pointerId) this.cancel(); }, options);
    root.addEventListener('keydown', event => this.keyboard(event), options);
    root.ownerDocument.defaultView?.addEventListener('resize', () => this.refresh(), options);
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.refresh());
    this.observer?.observe(root.parentElement ?? root);
    this.refresh();
  }

  private geometry(): EditorLayoutGeometry {
    const host = this.root.parentElement;
    return {
      width: this.root.getBoundingClientRect().width,
      height: host?.clientHeight || this.root.getBoundingClientRect().height,
      chromeHeight: (this.root.querySelector<HTMLElement>('.stagecraft-editor-toolbar')?.getBoundingClientRect().height ?? 0)
        + (this.root.querySelector<HTMLElement>('.stagecraft-editor-footer')?.getBoundingClientRect().height ?? 0)
    };
  }

  refresh(): void {
    if (this.disposed) return;
    this.limits = fitEditorLayout(this.preferred, this.geometry());
    if (this.limits.stacked && this.gesture?.panel === 'inspector') { this.cancel(); return; }
    for (const panel of ['library', 'inspector', 'timeline'] as const) {
      this.root.style.setProperty('--stagecraft-' + panel + (panel === 'timeline' ? '-height' : '-width'), this.limits.sizes[panel] + 'px');
      const handle = this.handles.get(panel);
      if (!handle) continue;
      const inactive = panel === 'inspector' && this.limits.stacked;
      handle.tabIndex = inactive ? -1 : 0;
      handle.setAttribute('aria-disabled', String(inactive));
      handle.setAttribute('aria-valuemin', String(MINIMUM[panel]));
      handle.setAttribute('aria-valuemax', String(Math.floor(this.limits.maximum[panel])));
      handle.setAttribute('aria-valuenow', String(Math.round(this.limits.sizes[panel])));
    }
  }

  private handle(target: EventTarget | null): { panel: Panel; node: HTMLElement } | null {
    const node = target instanceof Element ? target.closest<HTMLElement>('[data-stagecraft-splitter]') : null;
    if (!node || !this.root.contains(node)) return null;
    for (const [panel, handle] of this.handles) if (node === handle) return { panel, node };
    return null;
  }

  private begin(event: PointerEvent): void {
    if (this.gesture || event.button !== 0 || event.isPrimary === false) return;
    const handle = this.handle(event.target);
    if (!handle) return;
    this.refresh();
    if (handle.panel === 'inspector' && this.limits.stacked) return;
    const start = handle.panel === 'timeline' ? event.clientY : event.clientX;
    if (!Number.isFinite(start)) return;
    event.preventDefault(); event.stopPropagation();
    handle.node.focus({ preventScroll: true });
    try { this.root.setPointerCapture(event.pointerId); } catch { return; }
    this.gesture = { panel: handle.panel, handle: handle.node, pointerId: event.pointerId, start,
      size: this.limits.sizes[handle.panel], original: { ...this.preferred } };
    handle.node.classList.add('stagecraft-splitter-active');
    this.root.classList.add('stagecraft-layout-dragging');
    this.root.style.cursor = handle.panel === 'timeline' ? 'ns-resize' : 'ew-resize';
  }

  private move(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const position = gesture.panel === 'timeline' ? event.clientY : event.clientX;
    if (!Number.isFinite(position)) return;
    event.preventDefault(); event.stopPropagation();
    const direction = gesture.panel === 'library' ? 1 : -1;
    this.preferred[gesture.panel] = clamp(gesture.size + (position - gesture.start) * direction, MINIMUM[gesture.panel], this.limits.maximum[gesture.panel]);
    this.refresh();
  }

  private finish(event: PointerEvent): void {
    if (event.pointerId !== this.gesture?.pointerId) return;
    this.move(event);
    this.clearGesture();
  }

  private clearGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    gesture.handle.classList.remove('stagecraft-splitter-active');
    this.root.classList.remove('stagecraft-layout-dragging');
    this.root.style.cursor = '';
    if (this.root.hasPointerCapture(gesture.pointerId)) this.root.releasePointerCapture(gesture.pointerId);
  }

  private cancel(): void {
    if (!this.gesture) return;
    Object.assign(this.preferred, this.gesture.original);
    this.clearGesture();
    this.refresh();
  }

  private keyboard(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.gesture) {
      event.preventDefault(); event.stopImmediatePropagation(); this.cancel(); return;
    }
    const handle = this.handle(event.target);
    if (!handle || (handle.panel === 'inspector' && this.limits.stacked)) return;
    // A focused separator must never invoke the editor's clip deletion shortcuts.
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopImmediatePropagation(); return; }
    const increase = handle.panel === 'library' ? 'ArrowRight' : handle.panel === 'inspector' ? 'ArrowLeft' : 'ArrowUp';
    const decrease = handle.panel === 'library' ? 'ArrowLeft' : handle.panel === 'inspector' ? 'ArrowRight' : 'ArrowDown';
    if (![increase, decrease, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (this.gesture) this.cancel();
    this.refresh();
    const value = event.key === 'Home' ? MINIMUM[handle.panel] : event.key === 'End' ? this.limits.maximum[handle.panel]
      : this.limits.sizes[handle.panel] + (event.key === increase ? 1 : -1) * (event.shiftKey ? 40 : 10);
    this.preferred[handle.panel] = clamp(value, MINIMUM[handle.panel], this.limits.maximum[handle.panel]);
    this.refresh();
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
    this.listeners.abort();
    this.observer?.disconnect();
  }
}
