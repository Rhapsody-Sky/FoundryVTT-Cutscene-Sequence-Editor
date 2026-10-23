import { legacyVideoBox } from '../rendering/video-geometry.js';
import type { ButtonClip, ImageClip, ImagePoint, SequenceV1, SolidClip, TextClip, VideoClip } from '../domain/sequence.js';
import { compileSequence, evaluate } from '../playback/evaluate.js';
import { roundCompositionUnits, roundMaskCoordinate } from '../domain/spatial-precision.js';
import { MAX_POLYGON_POINTS } from '../domain/animated-pattern.js';

export type EditableVisualClip = ImageClip | SolidClip | TextClip | VideoClip | ButtonClip;
export interface VisualHandleState<T extends EditableVisualClip = EditableVisualClip> {
  readonly sequence: SequenceV1 | null;
  readonly clip: T | null;
  readonly editable: boolean;
  readonly positionMs?: number;
}
export interface VisualHandleCallbacks<T extends EditableVisualClip = EditableVisualClip> {
  read(): VisualHandleState<T>;
  before(): boolean;
  preview(clip: T): void;
  commit(sequenceId: string, clipId: string, clip: T): boolean;
  cancel(): void;
}
export type ImageHandleState = VisualHandleState<ImageClip>;
export type ImageHandleCallbacks = VisualHandleCallbacks<ImageClip>;
type Mode = 'mask' | 'transform';
export type TextBoxEdge = 'top' | 'right' | 'bottom' | 'left';
type VisualOperation = { readonly kind: 'corner'; readonly corner: number }
  | { readonly kind: 'edge'; readonly edge: TextBoxEdge }
  | { readonly kind: 'move' };
type Motion = { readonly x: number; readonly y: number; readonly scale: number };
type SurfaceBox = ImageClip['properties']['box'];
type BoxedClip = { readonly properties: { readonly box: SurfaceBox } };
type MaskedClip = { readonly properties: { readonly mask: readonly ImagePoint[] } };
const NO_MOTION: Motion = { x: 0, y: 0, scale: 1 };
const RECTANGLE: readonly ImagePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function roundWithin(value: number, low: number, high: number): number {
  const minimumTick = Math.ceil(low * 100 - 1e-7);
  const maximumTick = Math.floor(high * 100 + 1e-7);
  if (minimumTick > maximumTick) return clamp(roundCompositionUnits(value), low, high);
  const tick = Math.min(maximumTick, Math.max(minimumTick, Math.round(roundCompositionUnits(value) * 100)));
  return tick / 100;
}

/** Mask edits preserve clip identity, timing and all JSON extensions. */
function moveMaskCorner<Clip extends MaskedClip>(clip: Clip, corner: number, dx: number, dy: number): Clip {
  if (!Number.isInteger(corner) || corner < 0 || corner >= clip.properties.mask.length || !Number.isFinite(dx) || !Number.isFinite(dy)) return clip;
  if (dx === 0 && dy === 0) return clip;
  const original = clip.properties.mask[corner]!;
  const rawX = dx === 0 ? original.x : clamp(original.x + dx, 0, 1);
  const rawY = dy === 0 ? original.y : clamp(original.y + dy, 0, 1);
  const x = rawX === original.x ? original.x : clamp(roundMaskCoordinate(rawX), 0, 1);
  const y = rawY === original.y ? original.y : clamp(roundMaskCoordinate(rawY), 0, 1);
  if (x === original.x && y === original.y) return clip;
  const mask = clip.properties.mask.map((point, index) => index === corner ? { ...point, x, y } : point) as Clip['properties']['mask'];
  return { ...clip, properties: { ...clip.properties, mask } } as Clip;
}

/** Image and color surfaces expose the same normalized mask geometry. */
export function moveImageCorner(clip: ImageClip, corner: number, dx: number, dy: number): ImageClip {
  return moveMaskCorner(clip, corner, dx, dy);
}
export function moveSolidCorner(clip: SolidClip, corner: number, dx: number, dy: number): SolidClip {
  return moveMaskCorner(clip, corner, dx, dy);
}

/** Insert after the selected vertex, halfway along its outgoing edge. */
export function insertSolidPoint(clip: SolidClip, after: number): SolidClip {
  const old = clip.properties.mask;
  if (!Number.isInteger(after) || after < 0 || after >= old.length || old.length >= MAX_POLYGON_POINTS) return clip;
  const a = old[after]!, b = old[(after + 1) % old.length]!;
  const mask = [...old];
  mask.splice(after + 1, 0, { x: roundMaskCoordinate((a.x + b.x) / 2), y: roundMaskCoordinate((a.y + b.y) / 2) });
  return { ...clip, typeVersion: 2, properties: { ...clip.properties, mask } };
}

export function removeSolidPoint(clip: SolidClip, index: number): SolidClip {
  if (!Number.isInteger(index) || index < 0 || index >= clip.properties.mask.length || clip.properties.mask.length <= 3) return clip;
  return { ...clip, typeVersion: 2, properties: { ...clip.properties, mask: clip.properties.mask.filter((_point, i) => i !== index) } };
}

/** Box edits preserve the concrete visual clip type and its source-free properties. */
function transformBox<Clip extends BoxedClip>(clip: Clip, corner: number | null, dx: number, dy: number): Clip {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return clip;
  if (dx === 0 && dy === 0) return clip;
  const old = clip.properties.box;
  let { x, y, width, height } = old;
  if (corner === null) {
    if (dx !== 0) {
      const next = clamp(x + dx, -32768, 32768);
      if (next !== old.x) x = roundWithin(next, -32768, 32768);
    }
    if (dy !== 0) {
      const next = clamp(y + dy, -32768, 32768);
      if (next !== old.y) y = roundWithin(next, -32768, 32768);
    }
  }
  else if (corner >= 0 && corner <= 3 && Number.isInteger(corner)) {
    if (dx !== 0 && (corner === 0 || corner === 3)) {
      const right = x + width;
      const minimumX = Math.max(-32768, right - 32768), maximumX = Math.min(32768, right - 1);
      const next = clamp(x + dx, minimumX, maximumX);
      if (next !== old.x) {
        const rounded = roundWithin(next, minimumX, maximumX);
        if (rounded !== old.x) { x = rounded; width = roundWithin(right - x, 1, 32768); }
      }
    } else if (dx !== 0) {
      const next = clamp(width + dx, 1, 32768);
      if (next !== old.width) width = roundWithin(next, 1, 32768);
    }
    if (dy !== 0 && (corner === 0 || corner === 1)) {
      const bottom = y + height;
      const minimumY = Math.max(-32768, bottom - 32768), maximumY = Math.min(32768, bottom - 1);
      const next = clamp(y + dy, minimumY, maximumY);
      if (next !== old.y) {
        const rounded = roundWithin(next, minimumY, maximumY);
        if (rounded !== old.y) { y = rounded; height = roundWithin(bottom - y, 1, 32768); }
      }
    } else if (dy !== 0) {
      const next = clamp(height + dy, 1, 32768);
      if (next !== old.height) height = roundWithin(next, 1, 32768);
    }
  } else return clip;
  if (x === old.x && y === old.y && width === old.width && height === old.height) return clip;
  return { ...clip, properties: { ...clip.properties, box: { ...old, x, y, width, height } } } as Clip;
}

export function transformImageBox(clip: ImageClip, corner: number | null, dx: number, dy: number): ImageClip {
  return transformBox(clip, corner, dx, dy);
}
export function transformSolidBox(clip: SolidClip, corner: number | null, dx: number, dy: number): SolidClip {
  return transformBox(clip, corner, dx, dy);
}

/** Text corners scale the entire visual proportionally around the opposite corner. */
export function transformTextBox(clip: TextClip, corner: number | null, dx: number, dy: number): TextClip {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return clip;
  if (dx === 0 && dy === 0) return clip;
  if (corner === null) return transformImageBox(clip as unknown as ImageClip, null, dx, dy) as unknown as TextClip;
  if (!Number.isInteger(corner) || corner < 0 || corner > 3) return clip;
  const p = clip.properties, box = p.box;
  const left = corner === 0 || corner === 3, top = corner === 0 || corner === 1;
  const squaredDiagonal = box.width ** 2 + box.height ** 2;
  const desired = 1 + (dx / squaredDiagonal) * (left ? -box.width : box.width)
    + (dy / squaredDiagonal) * (top ? -box.height : box.height);
  if (desired === 1) return clip;
  const limits = [32768 / box.width, 32768 / box.height, 512 / p.fontSize];
  const limit = (value: number, maximum: number) => { if (value !== 0) limits.push(maximum / Math.abs(value)); };
  if (p.outline) limit(p.outline.width, 32);
  if (p.shadow) { limit(p.shadow.offsetX, 256); limit(p.shadow.offsetY, 256); limit(p.shadow.blur, 128); }
  if (p.glow) limit(p.glow.radius, 128);
  if (left) limits.push((box.x + box.width + 32768) / box.width);
  if (top) limits.push((box.y + box.height + 32768) / box.height);
  const minimum = Math.max(1 / box.width, 1 / box.height, 1 / p.minimumFontSize,
    left ? (box.x + box.width - 32768) / box.width : 0, top ? (box.y + box.height - 32768) / box.height : 0);
  const factor = clamp(desired, minimum, Math.min(...limits));
  if (factor === 1) return clip;
  let width = roundWithin(box.width * factor, 1, 32768);
  let height = roundWithin(box.height * factor, 1, 32768);
  const x = left ? roundWithin(box.x + box.width - width, -32768, 32768) : box.x;
  const y = top ? roundWithin(box.y + box.height - height, -32768, 32768) : box.y;
  if (left) width = roundWithin(box.x + box.width - x, 1, 32768);
  if (top) height = roundWithin(box.y + box.height - y, 1, 32768);
  const fontSize = roundWithin(p.fontSize * factor, 1, 512);
  const minimumFontSize = roundWithin(p.minimumFontSize * factor, 1, fontSize);
  return { ...clip, properties: { ...p,
    box: { ...box, x, y, width, height },
    fontSize, minimumFontSize,
    ...(p.outline ? { outline: { ...p.outline, width: roundWithin(p.outline.width * factor, 0, 32) } } : {}),
    ...(p.shadow ? { shadow: { ...p.shadow, offsetX: roundWithin(p.shadow.offsetX * factor, -256, 256),
      offsetY: roundWithin(p.shadow.offsetY * factor, -256, 256), blur: roundWithin(p.shadow.blur * factor, 0, 128) } } : {}),
    ...(p.glow ? { glow: { ...p.glow, radius: roundWithin(p.glow.radius * factor, 0, 128) } } : {})
  } };
}

/** Text edge handles change only the box axis they represent. */
export function transformTextBoxEdge(clip: TextClip, edge: TextBoxEdge, dx: number, dy: number): TextClip {
  const horizontal = edge === 'left' || edge === 'right';
  const delta = horizontal ? dx : dy;
  if (!Number.isFinite(delta) || delta === 0) return clip;
  const old = clip.properties.box;
  let { x, y, width, height } = old;
  if (edge === 'right') {
    const next = clamp(width + delta, 1, 32768);
    if (next === width) return clip;
    width = roundWithin(next, 1, 32768);
  } else if (edge === 'left') {
    const right = x + width;
    const minimumX = Math.max(-32768, right - 32768), maximumX = Math.min(32768, right - 1);
    const next = clamp(x + delta, minimumX, maximumX);
    if (next === x) return clip;
    x = roundWithin(next, minimumX, maximumX);
    width = roundWithin(right - x, 1, 32768);
  } else if (edge === 'bottom') {
    const next = clamp(height + delta, 1, 32768);
    if (next === height) return clip;
    height = roundWithin(next, 1, 32768);
  } else if (edge === 'top') {
    const bottom = y + height;
    const minimumY = Math.max(-32768, bottom - 32768), maximumY = Math.min(32768, bottom - 1);
    const next = clamp(y + delta, minimumY, maximumY);
    if (next === y) return clip;
    y = roundWithin(next, minimumY, maximumY);
    height = roundWithin(bottom - y, 1, 32768);
  } else return clip;
  if (x === old.x && y === old.y && width === old.width && height === old.height) return clip;
  return { ...clip, properties: { ...clip.properties, box: { ...old, x, y, width, height } } };
}

export function transformVisualBox<T extends EditableVisualClip>(clip: T, corner: number | null, dx: number, dy: number,
  fallbackBox?: TextClip['properties']['box']): T {
  if (dx === 0 && dy === 0) return clip;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (corner !== null && (!Number.isInteger(corner) || corner < 0 || corner > 3))) return clip;
  if (clip.type === 'text') return transformTextBox(clip, corner, dx, dy) as T;
  if (clip.type === 'image') return transformImageBox(clip, corner, dx, dy) as T;
  if (clip.type === 'solid') return transformSolidBox(clip, corner, dx, dy) as T;
  const box = clip.properties.box ?? fallbackBox;
  if (!box || !Object.values(box).filter(value => typeof value === 'number').every(Number.isFinite)) return clip;
  const boundedBox = { ...box, x: clamp(box.x, -32768, 32768), y: clamp(box.y, -32768, 32768),
    width: clamp(box.width, 1, 32768), height: clamp(box.height, 1, 32768) };
  const boxed = { ...clip, properties: { ...clip.properties, box: boundedBox } };
  const transformed = transformBox(boxed, corner, dx, dy);
  const transformedBox = transformed.properties.box;
  if (transformedBox && transformedBox.x === box.x && transformedBox.y === box.y
    && transformedBox.width === box.width && transformedBox.height === box.height) return clip;
  return clip.type === 'video' ? { ...transformed, type: 'video', typeVersion: 6 } as unknown as T : transformed as T;
}

function motionFor(state: VisualHandleState): Motion {
  if (!state.sequence || !state.clip) return NO_MOTION;
  try { return evaluate(compileSequence(state.sequence), state.positionMs ?? 0).find(item => item.clip.id === state.clip!.id)?.textTransform ?? NO_MOTION; }
  catch { return NO_MOTION; }
}
function projectedPoint(box: TextClip['properties']['box'], point: ImagePoint, motion: Motion): ImagePoint {
  return { x: box.x + box.width / 2 + (point.x - 0.5) * box.width * motion.scale + motion.x,
    y: box.y + box.height / 2 + (point.y - 0.5) * box.height * motion.scale + motion.y };
}
function midpoint(a: ImagePoint, b: ImagePoint): ImagePoint { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
interface Gesture<T extends EditableVisualClip> {
  readonly pointerId: number;
  readonly sequenceId: string;
  readonly snapshot: string;
  readonly clip: T;
  readonly box: TextClip['properties']['box'];
  readonly mode: Mode;
  readonly operation: VisualOperation;
  readonly startX: number;
  readonly startY: number;
  readonly projectionScale: number;
  readonly motion: Motion;
  readonly positionMs: number;
  candidate: T;
}

/** Preview-only manipulation: no draft changes before pointerup, no independent clock. */
export class VisualHandles<T extends EditableVisualClip = EditableVisualClip> {
  private readonly node = document.createElement('div');
  private readonly tools = document.createElement('div');
  private readonly buttons = new Map<Mode, HTMLButtonElement>();
  private readonly listeners = new AbortController();
  private readonly observer: ResizeObserver | null;
  private polygon: SVGPolygonElement | null = null;
  private move: HTMLButtonElement | null = null;
  private corners: HTMLButtonElement[] = [];
  private edges = new Map<TextBoxEdge, HTMLButtonElement>();
  private mode: Mode = 'mask';
  private gesture: Gesture<T> | null = null;
  private selection: string | null = null;
  private selectedPoint = 0;
  private disposed = false;

  constructor(private readonly viewer: HTMLElement, private readonly t: (key: string) => string, private readonly callbacks: VisualHandleCallbacks<T>) {
    this.node.className = 'stagecraft-image-handles'; this.node.hidden = true;
    this.tools.className = 'stagecraft-image-tools';
    for (const [mode, label, icon] of [['mask', 'ImageEditMask', 'fa-vector-square'], ['transform', 'ImageTransform', 'fa-up-down-left-right']] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.imageMode = mode;
      button.title = t(label); button.setAttribute('aria-label', button.title);
      const glyph = document.createElement('i'); glyph.className = 'fa-solid ' + icon; glyph.setAttribute('aria-hidden', 'true'); button.append(glyph);
      this.buttons.set(mode, button); this.tools.append(button);
    }
    for (const [action, label, icon] of [['add', 'PolygonAddPoint', 'fa-plus'], ['remove', 'PolygonRemovePoint', 'fa-minus']] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.polygonAction = action;
      button.title = t(label); button.setAttribute('aria-label', button.title);
      const glyph = document.createElement('i'); glyph.className = 'fa-solid ' + icon; glyph.setAttribute('aria-hidden', 'true'); button.append(glyph);
      this.tools.append(button);
    }
    this.node.append(this.tools); viewer.append(this.node);
    this.node.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      const mode = event.target.closest<HTMLElement>('[data-image-mode]')?.dataset.imageMode;
      if (mode === 'mask' || mode === 'transform') { this.cancel(); this.mode = mode; this.update(); event.stopPropagation(); }
      const action = event.target.closest<HTMLElement>('[data-polygon-action]')?.dataset.polygonAction;
      if (action === 'add' || action === 'remove') { this.editPoint(action); event.stopPropagation(); }
    }, { signal: this.listeners.signal });
    this.node.addEventListener('pointerdown', event => this.down(event), { signal: this.listeners.signal });
    this.node.addEventListener('pointermove', event => this.drag(event), { signal: this.listeners.signal });
    this.node.addEventListener('pointerup', event => this.up(event), { signal: this.listeners.signal });
    this.node.addEventListener('pointercancel', event => { if (this.gesture?.pointerId === event.pointerId) this.cancel(); }, { signal: this.listeners.signal });
    this.node.addEventListener('lostpointercapture', event => { if (this.gesture?.pointerId === event.pointerId) this.cancel(); }, { signal: this.listeners.signal });
    this.node.addEventListener('keydown', event => this.key(event), { signal: this.listeners.signal });
    this.node.addEventListener('focusin', event => {
      const operation = this.operation(event.target);
      if (operation?.kind === 'corner' && this.mode === 'mask') { this.selectedPoint = operation.corner; this.update(); }
    }, { signal: this.listeners.signal });
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { this.cancel(); this.update(); });
    this.observer?.observe(viewer);
  }

  update(): void {
    if (this.disposed) return;
    const state = this.callbacks.read();
    if (this.gesture && !this.matches(state, this.gesture)) this.cancel();
    this.node.hidden = !state.editable || !state.sequence || !state.clip;
    if (this.node.hidden || !state.sequence || !state.clip) return;
    const selection = state.sequence.id + '|' + state.clip.id;
    const hasMask = state.clip.type === 'image' || state.clip.type === 'solid';
    if (this.selection !== selection) { this.mode = hasMask ? 'mask' : 'transform'; this.selection = selection; this.selectedPoint = 0; }
    if (!hasMask) this.mode = 'transform';
    this.tools.hidden = !hasMask;
    const pointCount = this.mode === 'mask' && hasMask ? (state.clip as ImageClip | SolidClip).properties.mask.length : 4;
    this.selectedPoint = Math.min(this.selectedPoint, pointCount - 1);
    this.ensureGeometry(pointCount);
    for (const button of Array.from(this.tools.children) as HTMLButtonElement[]) {
      const action = button.dataset.polygonAction;
      if (!action) continue;
      button.hidden = state.clip.type !== 'solid' || this.mode !== 'mask';
      button.disabled = action === 'add' ? pointCount >= MAX_POLYGON_POINTS : pointCount <= 3;
    }
    for (const [mode, button] of this.buttons) {
      button.setAttribute('aria-pressed', String(mode === this.mode));
      const label = state.clip.type === 'solid' ? 'Solid' : state.clip.type === 'button' ? 'Button' : 'Image';
      button.title = this.t(label + (mode === 'mask' ? 'EditMask' : 'Transform'));
      button.setAttribute('aria-label', button.title);
    }
    this.node.dataset.imageEditMode = this.mode;
    this.paint(state.sequence, this.gesture?.candidate ?? state.clip, this.gesture?.motion ?? motionFor(state));
  }

  cancel(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    if (this.node.hasPointerCapture(gesture.pointerId)) this.node.releasePointerCapture(gesture.pointerId);
    this.callbacks.cancel();
    this.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancel(); this.listeners.abort(); this.observer?.disconnect();
    this.node.parentElement?.removeChild(this.node);
  }

  editPoint(action: 'add' | 'remove'): void {
    this.cancel();
    if (!this.callbacks.read().editable || !this.callbacks.before()) return;
    const state = this.callbacks.read();
    if (!state.editable || !state.sequence || state.clip?.type !== 'solid') return;
    const candidate = action === 'add' ? insertSolidPoint(state.clip, this.selectedPoint) : removeSolidPoint(state.clip, this.selectedPoint);
    if (candidate === state.clip) return;
    if (action === 'add') this.selectedPoint++;
    else this.selectedPoint = Math.min(this.selectedPoint, candidate.properties.mask.length - 1);
    this.callbacks.commit(state.sequence.id, state.clip.id, candidate as T);
    this.update();
  }

  private ensureGeometry(count: number): void {
    if (!this.polygon) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('stagecraft-image-guide'); svg.setAttribute('aria-hidden', 'true');
      this.polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      this.polygon.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(this.polygon); this.node.append(svg);
      this.move = document.createElement('button'); this.move.type = 'button'; this.move.dataset.imageMove = '';
      this.move.className = 'stagecraft-image-move'; this.move.title = this.t('ImageMove'); this.move.setAttribute('aria-label', this.move.title); this.node.append(this.move);
      for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
        const handle = document.createElement('button'); handle.type = 'button'; handle.dataset.imageEdge = edge;
        handle.className = 'stagecraft-image-edge-handle'; handle.hidden = true; this.edges.set(edge, handle); this.node.append(handle);
      }
    }
    while (this.corners.length > count) { const handle = this.corners.pop()!; handle.parentElement?.removeChild(handle); }
    while (this.corners.length < count) {
      const handle = document.createElement('button'); handle.type = 'button'; handle.dataset.imageCorner = String(this.corners.length);
      handle.className = 'stagecraft-image-handle'; this.corners.push(handle); this.node.append(handle);
    }
  }

  private paint(sequence: SequenceV1, clip: T, motion: Motion): void {
    // CSS positions use local layout pixels; pointer deltas below use visual
    // bounds so Foundry's application scale is applied exactly once.
    const rect = { width: this.viewer.clientWidth, height: this.viewer.clientHeight };
    const { width, height } = sequence.composition;
    const scale = Math.min(rect.width / width, rect.height / height);
    if (!(scale > 0) || !this.polygon) return;
    const offsetX = (rect.width - width * scale) / 2, offsetY = (rect.height - height * scale) / 2;
    this.polygon.parentElement!.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const box = clip.properties.box ?? legacyVideoBox(rect, sequence.composition);
    const points = (this.mode === 'mask' && (clip.type === 'image' || clip.type === 'solid') ? clip.properties.mask : RECTANGLE).map(point => projectedPoint(box, point, motion));
    this.polygon.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
    points.forEach((point, index) => {
      const button = this.corners[index]!;
      const element = clip.type === 'solid' ? 'Solid' : clip.type === 'image' ? 'Image' : 'Element';
      button.title = this.t(this.mode === 'mask' ? element + 'EditMask' : element + 'Resize') + ': '
        + (clip.type === 'solid' && this.mode === 'mask' ? `${this.t('PolygonPoint')} ${index + 1}` : this.t('ImageCorner' + (index + 1)));
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(this.mode === 'mask' && clip.type === 'solid' && index === this.selectedPoint));
      button.style.left = `${offsetX + point.x * scale}px`; button.style.top = `${offsetY + point.y * scale}px`;
    });
    const edgePoints: Record<TextBoxEdge, ImagePoint> = {
      top: midpoint(points[0]!, points[1]!),
      right: midpoint(points[1]!, points[2]!),
      bottom: midpoint(points[2]!, points[3] ?? points[0]!),
      left: midpoint(points[3] ?? points[0]!, points[0]!)
    };
    for (const [edge, button] of this.edges) {
      button.hidden = clip.type !== 'text';
      button.title = this.t('ElementResize') + ': ' + this.t('TextEdge' + edge[0]!.toUpperCase() + edge.slice(1));
      button.setAttribute('aria-label', button.title);
      const point = edgePoints[edge];
      button.style.left = `${offsetX + point.x * scale}px`; button.style.top = `${offsetY + point.y * scale}px`;
    }
    if (this.move) {
      this.move.hidden = this.mode !== 'transform';
      this.move.title = this.t(clip.type === 'solid' ? 'SolidMove' : clip.type === 'image' ? 'ImageMove' : 'ElementMove');
      this.move.setAttribute('aria-label', this.move.title);
      Object.assign(this.move.style, { left: `${offsetX + points[0]!.x * scale}px`, top: `${offsetY + points[0]!.y * scale}px`,
        width: `${box.width * motion.scale * scale}px`, height: `${box.height * motion.scale * scale}px` });
    }
  }

  private matches(state: VisualHandleState<T>, gesture: Gesture<T>): boolean {
    return state.editable && state.sequence?.id === gesture.sequenceId && state.clip?.id === gesture.clip.id
      && (state.positionMs ?? 0) === gesture.positionMs && JSON.stringify(state.sequence) === gesture.snapshot;
  }
  private operation(target: EventTarget | null): VisualOperation | null {
    if (!(target instanceof Element)) return null;
    const corner = target.closest<HTMLElement>('[data-image-corner]');
    if (corner) return { kind: 'corner', corner: Number(corner.dataset.imageCorner) };
    const edge = target.closest<HTMLElement>('[data-image-edge]')?.dataset.imageEdge;
    if (edge && this.mode === 'transform' && this.callbacks.read().clip?.type === 'text'
      && (edge === 'top' || edge === 'right' || edge === 'bottom' || edge === 'left')) return { kind: 'edge', edge };
    return this.mode === 'transform' && target.closest('[data-image-move]') ? { kind: 'move' } : null;
  }
  private down(event: PointerEvent): void {
    const operation = this.operation(event.target);
    if (!operation || event.button !== 0 || this.gesture || !this.callbacks.read().editable || !this.callbacks.before()) return;
    const state = this.callbacks.read();
    if (!state.editable || !state.sequence || !state.clip) return;
    if (operation.kind === 'corner' && this.mode === 'mask') this.selectedPoint = operation.corner;
    if (operation.kind === 'edge' && state.clip.type !== 'text') return;
    const rect = this.viewer.getBoundingClientRect();
    const scale = Math.min(rect.width / state.sequence.composition.width, rect.height / state.sequence.composition.height);
    if (!(scale > 0)) return;
    this.gesture = { pointerId: event.pointerId, sequenceId: state.sequence.id, snapshot: JSON.stringify(state.sequence), clip: state.clip,
      box: state.clip.properties.box ?? legacyVideoBox({ width: this.viewer.clientWidth, height: this.viewer.clientHeight }, state.sequence.composition),
      mode: this.mode, operation, startX: event.clientX, startY: event.clientY, projectionScale: scale,
      motion: motionFor(state), positionMs: state.positionMs ?? 0, candidate: state.clip };
    // Canceled pointerdown suppresses native focus transfer; keep Escape on the active handle.
    if (event.target instanceof Element) event.target.closest<HTMLButtonElement>('[data-image-corner], [data-image-edge], [data-image-move]')?.focus({ preventScroll: true });
    this.node.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
  }
  private drag(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const state = this.callbacks.read();
    if (!this.matches(state, gesture)) { this.cancel(); return; }
    let dx = (event.clientX - gesture.startX) / gesture.projectionScale;
    let dy = (event.clientY - gesture.startY) / gesture.projectionScale;
    const previous = gesture.candidate;
    if (gesture.mode === 'mask' && (gesture.clip.type === 'image' || gesture.clip.type === 'solid') && gesture.operation.kind === 'corner') {
      gesture.candidate = moveMaskCorner(gesture.clip, gesture.operation.corner,
        dx / (gesture.box.width * gesture.motion.scale), dy / (gesture.box.height * gesture.motion.scale)) as T;
    } else {
      if (gesture.operation.kind === 'corner' || gesture.operation.kind === 'edge') {
        const correction = 2 / (1 + gesture.motion.scale);
        dx *= correction; dy *= correction;
      }
      if (gesture.operation.kind === 'edge' && gesture.clip.type === 'text') {
        gesture.candidate = transformTextBoxEdge(gesture.clip, gesture.operation.edge, dx, dy) as T;
      } else {
        const corner = gesture.operation.kind === 'corner' ? gesture.operation.corner : null;
        gesture.candidate = transformVisualBox(gesture.clip, corner, dx, dy, gesture.box);
      }
    }
    if (gesture.candidate !== previous) this.callbacks.preview(gesture.candidate);
    this.paint(state.sequence!, gesture.candidate, gesture.motion);
    event.preventDefault(); event.stopPropagation();
  }
  private up(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.drag(event);
    if (!this.gesture) return;
    this.gesture = null;
    if (this.node.hasPointerCapture(event.pointerId)) this.node.releasePointerCapture(event.pointerId);
    if (!this.matches(this.callbacks.read(), gesture) || gesture.candidate === gesture.clip
      || !this.callbacks.commit(gesture.sequenceId, gesture.clip.id, gesture.candidate)) this.callbacks.cancel();
    this.update(); event.preventDefault(); event.stopPropagation();
  }
  private key(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.gesture) { this.cancel(); event.preventDefault(); event.stopPropagation(); return; }
    const operation = this.operation(event.target);
    if (!operation || this.gesture || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      || !this.callbacks.read().editable || !this.callbacks.before()) return;
    const state = this.callbacks.read();
    if (!state.editable || !state.sequence || !state.clip) return;
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    const replacement = this.mode === 'mask' && (state.clip.type === 'image' || state.clip.type === 'solid') && operation.kind === 'corner'
      ? moveMaskCorner(state.clip, operation.corner, dx / state.clip.properties.box.width, dy / state.clip.properties.box.height)
      : operation.kind === 'edge' && state.clip.type === 'text'
        ? transformTextBoxEdge(state.clip, operation.edge, dx, dy)
        : transformVisualBox(state.clip, operation.kind === 'corner' ? operation.corner : null, dx, dy,
          state.clip.properties.box ?? legacyVideoBox({ width: this.viewer.clientWidth, height: this.viewer.clientHeight }, state.sequence.composition));
    if (replacement === state.clip) { this.update(); event.preventDefault(); event.stopPropagation(); return; }
    this.callbacks.commit(state.sequence.id, state.clip.id, replacement as T);
    this.update(); event.preventDefault(); event.stopPropagation();
  }
}

/** Compatibility entry point for existing image-only integrations. */
export class ImageHandles extends VisualHandles<ImageClip> {}
