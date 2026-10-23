import type { VideoClip } from '../domain/sequence.js';
import type { FrameItem } from '../playback/evaluate.js';
import type { BackdropFootprint, BackdropRect, ElementRenderer, RendererOptions } from './element-renderer.js';
import { imageNeedsBackdrop } from './image-renderer.js';
import { solidNeedsBackdrop } from './solid-renderer.js';
import { MediaPreparationError } from './media-preparation.js';

export interface ContentRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** The content footprint, rather than the full CSS replaced-element box. */
export function videoContentRect(width: number, height: number, sourceWidth: number, sourceHeight: number, fit: VideoClip['properties']['fit']): ContentRect {
  if (fit === 'cover') return { x: 0, y: 0, width, height };
  if (!(sourceWidth > 0 && sourceHeight > 0)) throw new MediaPreparationError('VIDEO_BACKDROP_UNAVAILABLE');
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const contentWidth = sourceWidth * scale, contentHeight = sourceHeight * scale;
  return { x: (width - contentWidth) / 2, y: (height - contentHeight) / 2, width: contentWidth, height: contentHeight };
}

export function needsVideoBackdrop(item: FrameItem | undefined): boolean {
  return item?.clip.type === 'video' && (item.clip.appearance?.blendMode ?? 'normal') !== 'normal'
    && item.opacity * (item.clip.appearance?.opacity ?? 1) > 0;
}

export function needsImageBackdrop(item: FrameItem | undefined): boolean { return imageNeedsBackdrop(item); }

function needsBackdrop(item: FrameItem | undefined): boolean { return needsVideoBackdrop(item) || needsImageBackdrop(item) || solidNeedsBackdrop(item); }

/**
 * The borrowed board forms an opaque base beneath blended visual content.
 * A reusable alpha mask limits that base to the union of visual
 * footprints, including the separate fitted-crop aperture for contained images.
 * Clip opacity is still applied once by the clip root; the base never receives
 * that alpha, and the global composition fade remains on the outer root.
 */
export class VideoBlendBackdrop {
  readonly node = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly maskNode = document.createElement('canvas');
  private readonly maskContext: CanvasRenderingContext2D;
  private disposed = false;
  private waitingSince: number | null = null;

  constructor(private readonly root: HTMLElement, private readonly options: RendererOptions) {
    if (!options.boardBackdrop) throw new MediaPreparationError('VIDEO_BACKDROP_UNAVAILABLE');
    const context = this.node.getContext('2d', { alpha: true });
    const maskContext = this.maskNode.getContext('2d', { alpha: true });
    if (!context || !maskContext) throw new MediaPreparationError('VIDEO_BACKDROP_UNAVAILABLE');
    this.context = context;
    this.maskContext = maskContext;
    this.node.className = 'stagecraft-video-blend-backdrop';
    Object.assign(this.node.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', display: 'none' });
    root.prepend(this.node);
  }

  draw(items: ReadonlyMap<string, FrameItem>, elements: ReadonlyMap<string, { readonly renderer: ElementRenderer }>, opacity: number): 'inactive' | 'ready' | 'pending' {
    if (this.disposed) return 'inactive';
    const blended = opacity > 0 ? [...items.values()].filter(needsBackdrop) : [];
    if (!blended.length) { this.node.style.display = 'none'; return 'inactive'; }
    const bounds = this.root.getBoundingClientRect();
    if (!(bounds.width > 0 && bounds.height > 0)) { this.node.style.display = 'none'; return 'inactive'; }
    const rect: BackdropRect = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    const board = this.options.boardBackdrop!(rect, this.options.signal);
    if (!board) {
      // Foundry's tick may be slower than this visual refresh. Keep the group
      // hidden until a real snapshot arrives, with a bounded preparation grace.
      this.waitingSince ??= performance.now();
      if (performance.now() - this.waitingSince < 2000) return 'pending';
      throw new MediaPreparationError('VIDEO_BACKDROP_UNAVAILABLE');
    }
    this.waitingSince = null;
    if (!(board.rect.width > 0 && board.rect.height > 0)) throw new MediaPreparationError('VIDEO_BACKDROP_UNAVAILABLE');
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    const width = Math.max(1, Math.ceil(bounds.width * ratio)), height = Math.max(1, Math.ceil(bounds.height * ratio));
    if (this.node.width !== width || this.node.height !== height) { this.node.width = width; this.node.height = height; }
    if (this.maskNode.width !== width || this.maskNode.height !== height) { this.maskNode.width = width; this.maskNode.height = height; }
    const context = this.context, maskContext = this.maskContext;
    context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, width, height);
    maskContext.setTransform(1, 0, 0, 1, 0, 0); maskContext.clearRect(0, 0, width, height);
    const footprints: BackdropFootprint[] = [];
    try {
      for (const item of blended) {
        const renderer = elements.get(item.clip.id)?.renderer;
        if (item.clip.type === 'video') {
          const source = renderer?.videoSource?.();
          if (!source) throw new MediaPreparationError('VIDEO_BACKDROP_UNAVAILABLE');
          const videoFootprints = renderer?.backdropFootprints?.(item, bounds);
          if (videoFootprints?.length) { footprints.push(...videoFootprints); continue; }
          const content = videoContentRect(bounds.width, bounds.height, source.videoWidth, source.videoHeight, item.clip.properties.fit);
          footprints.push({ points: [
            { x: content.x, y: content.y }, { x: content.x + content.width, y: content.y },
            { x: content.x + content.width, y: content.y + content.height }, { x: content.x, y: content.y + content.height }
          ] });
        } else {
          const visualFootprints = renderer?.backdropFootprints?.(item, bounds);
          if (!visualFootprints?.length) throw new MediaPreparationError('VIDEO_BACKDROP_UNAVAILABLE');
          footprints.push(...visualFootprints);
        }
      }
      maskContext.save();
      try {
        maskContext.scale(ratio, ratio);
        maskContext.fillStyle = '#fff';
        maskContext.globalAlpha = 1;
        maskContext.globalCompositeOperation = 'source-over';
        for (const footprint of footprints) this.paintFootprint(maskContext, footprint);
      } finally { maskContext.restore(); }

      context.save();
      try {
        context.scale(ratio, ratio);
        const x = board.rect.left - bounds.left, y = board.rect.top - bounds.top;
        if (board.backgroundColor) { context.fillStyle = board.backgroundColor; context.fillRect(x, y, board.rect.width, board.rect.height); }
        context.drawImage(board.source, x, y, board.rect.width, board.rect.height);
      } finally { context.restore(); }
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(this.maskNode, 0, 0, width, height);
      context.globalCompositeOperation = 'source-over';
      this.node.style.display = '';
    } catch (error) {
      context.globalCompositeOperation = 'source-over';
      this.node.style.display = 'none';
      throw error instanceof MediaPreparationError ? error : new MediaPreparationError('VIDEO_BACKDROP_UNAVAILABLE');
    }
    return 'ready';
  }

  private paintFootprint(context: CanvasRenderingContext2D, footprint: BackdropFootprint): void {
    if (footprint.points.length < 3) return;
    context.save();
    try {
      if (footprint.clip) {
        context.beginPath();
        context.rect(footprint.clip.x, footprint.clip.y, footprint.clip.width, footprint.clip.height);
        context.clip();
      }
      context.beginPath();
      context.moveTo(footprint.points[0]!.x, footprint.points[0]!.y);
      for (const point of footprint.points.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      context.fill('evenodd');
    } finally { context.restore(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.node.width = 0; this.node.height = 0; this.maskNode.width = 0; this.maskNode.height = 0;
    this.node.remove();
  }
}
