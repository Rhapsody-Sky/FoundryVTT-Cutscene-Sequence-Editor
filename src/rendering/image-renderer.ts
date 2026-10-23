import type { ImageClip } from '../domain/sequence.js';
import type { FrameItem } from '../playback/evaluate.js';
import type { PlayerFrame } from '../playback/local-player.js';
import type { BackdropFootprint, BackdropRect, ElementRenderer, RendererOptions } from './element-renderer.js';
import { drawClipAppearance, setClipBlend } from './clip-appearance.js';
import { abortError, assertFoundryMediaPath, bounded, MediaPreparationError } from './media-preparation.js';

export interface ImageRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface ImageSourceCrop extends ImageRect {}
export interface ImageContentGeometry {
  /** Complete source image placement in logical composition coordinates. */
  readonly imageRect: ImageRect;
  /** Display-space aperture for the selected source crop. */
  readonly aperture: ImageRect;
  /** The selected source rectangle in intrinsic pixels. */
  readonly sourceRect: ImageSourceCrop;
}

let nextImageFilterId = 1;

/** Crop the source first, then fit that region into the authored box. */
export function imageContentGeometry(box: ImageRect, sourceWidth: number, sourceHeight: number,
  crop: ImageRect, fit: ImageClip['properties']['fit']): ImageContentGeometry {
  if (!(box.width > 0 && box.height > 0 && sourceWidth > 0 && sourceHeight > 0)
    || ![box.x, box.y, box.width, box.height, sourceWidth, sourceHeight, crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || !(crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
      && crop.x + crop.width <= 1 && crop.y + crop.height <= 1)) {
    throw new RangeError('Image box, source dimensions, and crop must be finite and positive.');
  }
  const sourceRect = { x: crop.x * sourceWidth, y: crop.y * sourceHeight,
    width: crop.width * sourceWidth, height: crop.height * sourceHeight };
  const scaleX = box.width / sourceRect.width, scaleY = box.height / sourceRect.height;
  const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  const fittedWidth = sourceRect.width * scale, fittedHeight = sourceRect.height * scale;
  const fittedX = box.x + (box.width - fittedWidth) / 2;
  const fittedY = box.y + (box.height - fittedHeight) / 2;
  const aperture = fit === 'cover'
    ? { ...box }
    : { x: fittedX, y: fittedY, width: fittedWidth, height: fittedHeight };
  return {
    sourceRect,
    aperture,
    imageRect: {
      x: fittedX - sourceRect.x * scale,
      y: fittedY - sourceRect.y * scale,
      width: sourceWidth * scale,
      height: sourceHeight * scale
    }
  };
}

export function imageMaskCss(mask: ImageClip['properties']['mask']): string {
  return `polygon(evenodd, ${mask.map(point => `${point.x * 100}% ${point.y * 100}%`).join(', ')})`;
}

function rgba(color: string, opacity: number): string {
  return `rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)}, ${opacity})`;
}

type PolygonVisual = { readonly properties: Pick<ImageClip['properties'], 'box' | 'outline' | 'shadow' | 'glow'> & {
  readonly mask: readonly { readonly x: number; readonly y: number }[];
} };

export function pathForMask(clip: PolygonVisual): string {
  const { box, mask } = clip.properties;
  return `M ${mask[0]!.x * box.width} ${mask[0]!.y * box.height} ${mask.slice(1).map(point => `L ${point.x * box.width} ${point.y * box.height}`).join(' ')} Z`;
}

function compositionProjection(surface: Pick<BackdropRect, 'width' | 'height'>, size: ImageRect): { x: number; y: number; scale: number } {
  const scale = Math.min(surface.width / size.width, surface.height / size.height);
  return { scale, x: (surface.width - size.width * scale) / 2, y: (surface.height - size.height * scale) / 2 };
}

function transformLocalPoint(clip: PolygonVisual, point: { readonly x: number; readonly y: number }, motion: FrameItem['textTransform']): { x: number; y: number } {
  const { box } = clip.properties;
  const centerX = box.x + box.width / 2, centerY = box.y + box.height / 2;
  const scale = motion?.scale ?? 1;
  return {
    x: (point.x - centerX) * scale + centerX + (motion?.x ?? 0),
    y: (point.y - centerY) * scale + centerY + (motion?.y ?? 0)
  };
}

function rectPoints(rect: ImageRect): readonly { readonly x: number; readonly y: number }[] {
  return [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }
  ];
}

function cssColor(value: string, opacity: number): string { return rgba(value, opacity); }

/** Bounded load plus decode; all event handlers are removed on every outcome. */
export function waitForImage(image: HTMLImageElement, signal: AbortSignal, milliseconds = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
    };
    const loaded = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) { clean(); resolve(); }
      else failed();
    };
    const failed = () => { clean(); reject(new MediaPreparationError('MEDIA_LOAD_FAILED', image.getAttribute('src') ?? undefined)); };
    const abort = () => { clean(); reject(abortError()); };
    const timer = setTimeout(() => { clean(); reject(new MediaPreparationError('MEDIA_TIMEOUT', image.getAttribute('src') ?? undefined)); }, Math.max(1, milliseconds));
    signal.addEventListener('abort', abort, { once: true });
    image.addEventListener('load', loaded);
    image.addEventListener('error', failed);
    if (image.complete) loaded();
  });
}

export function imageNeedsBackdrop(item: FrameItem | undefined): boolean {
  return item?.clip.type === 'image' && (item.clip.appearance?.blendMode ?? 'normal') !== 'normal'
    && item.opacity * (item.clip.appearance?.opacity ?? 1) > 0;
}

export function imageRenderer(clip: ImageClip, parent: HTMLElement, size: { width: number; height: number },
  options: RendererOptions): ElementRenderer {
  assertFoundryMediaPath(clip.properties.source.path);
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const layer = document.createElement('div');
  layer.className = 'stagecraft-image-layer'; layer.dataset.clipId = clip.id;
  Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', opacity: '0', overflow: 'visible' });
  setClipBlend(layer, clip);

  const stage = document.createElement('div');
  Object.assign(stage.style, { position: 'absolute', width: `${size.width}px`, height: `${size.height}px`, transformOrigin: '0 0', overflow: 'visible' });
  const effects = document.createElement('div');
  Object.assign(effects.style, { position: 'absolute', overflow: 'visible', transformOrigin: 'center center' });
  const imageEffects = document.createElement('div');
  Object.assign(imageEffects.style, { position: 'absolute', inset: '0', overflow: 'visible' });
  const masked = document.createElement('div');
  Object.assign(masked.style, { position: 'absolute', inset: '0', overflow: 'visible' });
  const cropWindow = document.createElement('div');
  Object.assign(cropWindow.style, { position: 'absolute', overflow: 'hidden', padding: '0', border: '0', margin: '0' });
  const image = document.createElement('img');
  image.alt = ''; image.decoding = 'async'; image.draggable = false;
  Object.assign(image.style, { position: 'absolute', display: 'block', maxWidth: 'none', maxHeight: 'none', objectFit: 'fill', margin: '0', padding: '0', border: '0' });
  const outlineSvg = document.createElementNS(svgNamespace, 'svg');
  outlineSvg.setAttribute('aria-hidden', 'true');
  Object.assign(outlineSvg.style, { position: 'absolute', inset: '0', overflow: 'visible', pointerEvents: 'none' });
  const outlinePath = document.createElementNS(svgNamespace, 'path');
  outlinePath.setAttribute('fill', 'none'); outlinePath.setAttribute('stroke-linejoin', 'round'); outlineSvg.append(outlinePath);
  const filterSvg = document.createElementNS(svgNamespace, 'svg');
  filterSvg.setAttribute('aria-hidden', 'true');
  Object.assign(filterSvg.style, { position: 'absolute', width: '0', height: '0', overflow: 'visible', pointerEvents: 'none' });
  const defs = document.createElementNS(svgNamespace, 'defs');
  const filter = document.createElementNS(svgNamespace, 'filter');
  const filterId = `stagecraft-image-effects-${nextImageFilterId++}`;
  filter.setAttribute('id', filterId); filter.setAttribute('filterUnits', 'userSpaceOnUse'); filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
  const shadowBlur = document.createElementNS(svgNamespace, 'feGaussianBlur');
  shadowBlur.setAttribute('in', 'SourceAlpha'); shadowBlur.setAttribute('result', 'imageShadowBlur');
  const shadowOffset = document.createElementNS(svgNamespace, 'feOffset');
  shadowOffset.setAttribute('in', 'imageShadowBlur'); shadowOffset.setAttribute('result', 'imageShadowOffset');
  const shadowFlood = document.createElementNS(svgNamespace, 'feFlood');
  shadowFlood.setAttribute('result', 'imageShadowColor');
  const shadowComposite = document.createElementNS(svgNamespace, 'feComposite');
  shadowComposite.setAttribute('in', 'imageShadowColor'); shadowComposite.setAttribute('in2', 'imageShadowOffset');
  shadowComposite.setAttribute('operator', 'in'); shadowComposite.setAttribute('result', 'imageShadow');
  const glowBlur = document.createElementNS(svgNamespace, 'feGaussianBlur');
  glowBlur.setAttribute('in', 'SourceAlpha'); glowBlur.setAttribute('result', 'imageGlowBlur');
  const glowFlood = document.createElementNS(svgNamespace, 'feFlood');
  glowFlood.setAttribute('result', 'imageGlowColor');
  const glowComposite = document.createElementNS(svgNamespace, 'feComposite');
  glowComposite.setAttribute('in', 'imageGlowColor'); glowComposite.setAttribute('in2', 'imageGlowBlur');
  glowComposite.setAttribute('operator', 'in'); glowComposite.setAttribute('result', 'imageGlow');
  const merge = document.createElementNS(svgNamespace, 'feMerge');
  const mergeShadow = document.createElementNS(svgNamespace, 'feMergeNode'); mergeShadow.setAttribute('in', 'imageShadow');
  const mergeGlow = document.createElementNS(svgNamespace, 'feMergeNode'); mergeGlow.setAttribute('in', 'imageGlow');
  const mergeGraphic = document.createElementNS(svgNamespace, 'feMergeNode'); mergeGraphic.setAttribute('in', 'SourceGraphic');
  merge.append(mergeShadow, mergeGlow, mergeGraphic);
  filter.append(shadowBlur, shadowOffset, shadowFlood, shadowComposite, glowBlur, glowFlood, glowComposite, merge);
  defs.append(filter); filterSvg.append(defs);
  cropWindow.append(image); masked.append(cropWindow); imageEffects.append(masked); effects.append(imageEffects, outlineSvg);
  stage.append(filterSvg, effects); layer.append(stage); parent.append(layer);

  const lifetime = new AbortController();
  let visualClip = clip;
  let disposed = false;
  let prepared = false;
  let preparePromise: Promise<void> | null = null;
  let lastMotion: FrameItem['textTransform'];
  let dirty = true;
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    const size = entries.find(entry => entry.target === parent)?.contentRect;
    if (!size) return;
    dirty = true; layout(size.width, size.height);
  });
  observer?.observe(parent);

  const updateEffects = (next: ImageClip) => {
    const shadow = next.properties.shadow, glow = next.properties.glow;
    shadowBlur.setAttribute('stdDeviation', shadow?.enabled ? String(shadow.blur) : '0');
    shadowOffset.setAttribute('dx', shadow?.enabled ? String(shadow.offsetX) : '0');
    shadowOffset.setAttribute('dy', shadow?.enabled ? String(shadow.offsetY) : '0');
    shadowFlood.setAttribute('flood-color', shadow?.enabled ? shadow.color : '#000000');
    shadowFlood.setAttribute('flood-opacity', shadow?.enabled ? String(shadow.opacity) : '0');
    glowBlur.setAttribute('stdDeviation', glow?.enabled ? String(glow.radius) : '0');
    glowFlood.setAttribute('flood-color', glow?.enabled ? glow.color : '#000000');
    glowFlood.setAttribute('flood-opacity', glow?.enabled ? String(glow.opacity) : '0');
    const outline = next.properties.outline;
    const outlinePadding = outline?.enabled ? outline.width / 2 : 0;
    const leftPadding = Math.max(outlinePadding, shadow?.enabled ? shadow.blur * 3 + Math.max(0, -shadow.offsetX) : 0, glow?.enabled ? glow.radius * 3 : 0);
    const rightPadding = Math.max(outlinePadding, shadow?.enabled ? shadow.blur * 3 + Math.max(0, shadow.offsetX) : 0, glow?.enabled ? glow.radius * 3 : 0);
    const topPadding = Math.max(outlinePadding, shadow?.enabled ? shadow.blur * 3 + Math.max(0, -shadow.offsetY) : 0, glow?.enabled ? glow.radius * 3 : 0);
    const bottomPadding = Math.max(outlinePadding, shadow?.enabled ? shadow.blur * 3 + Math.max(0, shadow.offsetY) : 0, glow?.enabled ? glow.radius * 3 : 0);
    filter.setAttribute('x', String(-leftPadding)); filter.setAttribute('y', String(-topPadding));
    filter.setAttribute('width', String(next.properties.box.width + leftPadding + rightPadding));
    filter.setAttribute('height', String(next.properties.box.height + topPadding + bottomPadding));
    imageEffects.style.filter = shadow?.enabled || glow?.enabled ? `url(#${filterId})` : '';
    outlineSvg.setAttribute('viewBox', `0 0 ${next.properties.box.width} ${next.properties.box.height}`);
    outlineSvg.setAttribute('width', String(next.properties.box.width));
    outlineSvg.setAttribute('height', String(next.properties.box.height));
    outlinePath.setAttribute('d', pathForMask(next));
    outlinePath.setAttribute('stroke', outline?.enabled ? cssColor(outline.color, outline.opacity) : 'transparent');
    outlinePath.setAttribute('stroke-width', String(outline?.enabled ? outline.width : 0));
    outlinePath.style.display = outline?.enabled ? '' : 'none';
  };

  const layoutGeometry = () => {
    if (!prepared || disposed) return;
    const next = visualClip;
    const { box, crop, fit, mask } = next.properties;
    const geometry = imageContentGeometry(box, image.naturalWidth, image.naturalHeight, crop, fit);
    effects.style.left = `${box.x}px`; effects.style.top = `${box.y}px`;
    effects.style.width = `${box.width}px`; effects.style.height = `${box.height}px`;
    const polygon = imageMaskCss(mask);
    masked.style.clipPath = polygon;
    cropWindow.style.left = `${geometry.aperture.x - box.x}px`;
    cropWindow.style.top = `${geometry.aperture.y - box.y}px`;
    cropWindow.style.width = `${geometry.aperture.width}px`;
    cropWindow.style.height = `${geometry.aperture.height}px`;
    image.style.left = `${geometry.imageRect.x - geometry.aperture.x}px`;
    image.style.top = `${geometry.imageRect.y - geometry.aperture.y}px`;
    image.style.width = `${geometry.imageRect.width}px`;
    image.style.height = `${geometry.imageRect.height}px`;
    updateEffects(next);
    dirty = true;
  };

  const layout = (width = parent.clientWidth, height = parent.clientHeight) => {
    if (disposed) return;
    // Preparation happens while a preview surface is detached. A zero-sized
    // measurement is not a completed layout: keep the first mounted draw able
    // to size the stage if the observer's first delivery has not run yet.
    if (!(width > 0 && height > 0)) { dirty = true; return; }
    // Use layout CSS pixels. getBoundingClientRect() includes Foundry's
    // ApplicationV2 transform:scale(), which would apply that scale twice.
    const scale = Math.min(width / size.width, height / size.height);
    stage.style.left = `${(width - size.width * scale) / 2}px`;
    stage.style.top = `${(height - size.height * scale) / 2}px`;
    stage.style.transform = `scale(${scale})`;
    dirty = false;
  };

  const updateMotion = (motion: FrameItem['textTransform']) => {
    lastMotion = motion;
    effects.style.transform = motion ? `translate(${motion.x}px, ${motion.y}px) scale(${motion.scale})` : '';
  };

  const updateAppearance = (next: ImageClip) => {
    if (next.properties.source.path !== clip.properties.source.path) throw new MediaPreparationError('IMAGE_SOURCE_CHANGED', next.properties.source.path);
    visualClip = next;
    setClipBlend(layer, next);
    if (prepared) layoutGeometry();
  };

  const release = () => {
    if (disposed) return;
    disposed = true; prepared = false; lifetime.abort(); observer?.disconnect();
    options.signal.removeEventListener('abort', abortFromSurface);
    image.removeAttribute('src'); image.remove(); outlinePath.remove(); outlineSvg.remove(); layer.remove();
  };
  const abortFromSurface = () => release();
  if (options.signal.aborted) release();
  else options.signal.addEventListener('abort', abortFromSurface, { once: true });

  const renderer: ElementRenderer = {
    node: layer,
    async prepare() {
      if (preparePromise) return preparePromise;
      preparePromise = (async () => {
        if (disposed || lifetime.signal.aborted) throw abortError();
        try {
          image.src = visualClip.properties.source.path;
          await waitForImage(image, lifetime.signal);
          if (typeof image.decode === 'function') {
            try { await bounded(image.decode(), lifetime.signal, 15_000, 'MEDIA_TIMEOUT'); }
            catch (error) {
              if (lifetime.signal.aborted || (error instanceof MediaPreparationError && error.code === 'MEDIA_TIMEOUT')) throw error;
              throw new MediaPreparationError('MEDIA_LOAD_FAILED', visualClip.properties.source.path);
            }
          }
          if (disposed || lifetime.signal.aborted) throw abortError();
          if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) throw new MediaPreparationError('MEDIA_LOAD_FAILED', visualClip.properties.source.path);
          prepared = true; layoutGeometry(); layout();
        } catch (error) { release(); throw error; }
      })();
      return preparePromise;
    },
    draw(item, _frame: PlayerFrame) {
      if (disposed) return;
      if (item?.clip.type === 'image' && visualClip !== item.clip) updateAppearance(item.clip);
      drawClipAppearance(layer, item);
      const motion = item?.textTransform;
      if (motion !== lastMotion) updateMotion(motion);
      if (dirty) layout();
    },
    updateAppearance(next) { if (next.type === 'image') updateAppearance(next); },
    backdropFootprints(item, surface) {
      if (!prepared || disposed || item.clip.type !== 'image' || !imageNeedsBackdrop(item)) return [];
      const current = item.clip;
      const { box, crop, fit } = current.properties;
      const geometry = imageContentGeometry(box, image.naturalWidth, image.naturalHeight, crop, fit);
      return imageBackdropFootprints(current, geometry.aperture, item.textTransform, surface, size);
    },
    dispose: release
  };
  return renderer;
}

/** Shared image/solid polygon footprint; alpha holes are intentionally conservative. */
export function imageBackdropFootprints(current: PolygonVisual, aperture: ImageRect,
  motion: FrameItem['textTransform'], surface: Pick<BackdropRect, 'width' | 'height'>,
  size: { width: number; height: number }): BackdropFootprint[] {
  const { box, mask, outline, shadow, glow } = current.properties;
  const projection = compositionProjection(surface, { x: 0, y: 0, width: size.width, height: size.height });
  const localPoints = mask.map(point => transformLocalPoint(current,
    { x: box.x + point.x * box.width, y: box.y + point.y * box.height }, motion));
  const project = (point: { readonly x: number; readonly y: number }) => ({
    x: projection.x + point.x * projection.scale, y: projection.y + point.y * projection.scale
  });
  const screenPoints = localPoints.map(project);
  const aperturePoints = rectPoints(aperture).map(point => transformLocalPoint(current, point, motion)).map(project);
  const footprint: BackdropFootprint[] = [{ points: screenPoints, clip: boundsOf(aperturePoints) }];
  if (outline?.enabled && outline.width > 0) footprint.push({ points: screenPoints });
  const effectPadding = Math.max(outline?.enabled ? outline.width / 2 : 0,
    shadow?.enabled ? shadow.blur * 3 + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) : 0,
    glow?.enabled ? glow.radius * 3 : 0);
  if (effectPadding > 0) {
    const boxPoints = rectPoints({ x: box.x, y: box.y, width: box.width, height: box.height })
      .map(point => transformLocalPoint(current, point, motion)).map(project);
    const bounds = boundsOf(boxPoints);
    const pad = effectPadding * projection.scale * (motion?.scale ?? 1);
    footprint.push({ points: rectPoints({ x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 }) });
  }
  return footprint;
}

function boundsOf(points: readonly { readonly x: number; readonly y: number }[]): ImageRect {
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
