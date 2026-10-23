import type { SolidClip } from '../domain/sequence.js';
import type { FrameItem } from '../playback/evaluate.js';
import type { ElementRenderer, RendererOptions } from './element-renderer.js';
import { drawClipAppearance, setClipBlend } from './clip-appearance.js';
import { imageBackdropFootprints, imageContentGeometry, pathForMask, waitForImage } from './image-renderer.js';
import { abortError, assertFoundryMediaPath, bounded, MediaPreparationError } from './media-preparation.js';
import { animatedPatternRenderer, type AnimatedPatternRenderer } from './animated-pattern-renderer.js';

let nextSolidId = 1;

export function solidNeedsBackdrop(item: FrameItem | undefined): boolean {
  return item?.clip.type === 'solid' && (item.clip.appearance?.blendMode ?? 'normal') !== 'normal'
    && item.opacity * (item.clip.appearance?.opacity ?? 1) > 0;
}

/** Native SVG luminance masks multiply source luminance by its own alpha. */
export function solidRenderer(clip: SolidClip, parent: HTMLElement, size: { width: number; height: number },
  options: RendererOptions): ElementRenderer {
  const sourcePath = clip.properties.alphaMap?.path;
  if (sourcePath !== undefined) assertFoundryMediaPath(sourcePath);
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] => document.createElementNS(namespace, tag);
  const id = `stagecraft-solid-${nextSolidId++}`;
  const layer = document.createElement('div');
  layer.className = 'stagecraft-solid-layer'; layer.dataset.clipId = clip.id;
  Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', opacity: '0', overflow: 'visible' });
  setClipBlend(layer, clip);
  const stage = document.createElement('div');
  Object.assign(stage.style, { position: 'absolute', width: `${size.width}px`, height: `${size.height}px`, transformOrigin: '0 0', overflow: 'visible' });
  const effects = document.createElement('div');
  Object.assign(effects.style, { position: 'absolute', overflow: 'visible', transformOrigin: 'center center' });
  const graphic = svg('svg'), outlineSvg = svg('svg');
  for (const node of [graphic, outlineSvg]) {
    node.setAttribute('aria-hidden', 'true');
    Object.assign(node.style, { position: 'absolute', inset: '0', overflow: 'visible', pointerEvents: 'none' });
  }
  const defs = svg('defs');
  const mask = sourcePath !== undefined ? svg('mask') : null;
  const apertureClip = sourcePath !== undefined ? svg('clipPath') : null;
  const aperture = sourcePath !== undefined ? svg('rect') : null;
  const texture = sourcePath !== undefined ? svg('image') : null;
  // A detached HTML image is only a bounded readiness/decode probe. The SVG
  // image consumes the same cached local resource after successful preparation.
  const image = sourcePath !== undefined ? document.createElement('img') : null;
  if (image && mask && apertureClip && aperture && texture) {
    image.decoding = 'async';
    mask.setAttribute('id', `${id}-alpha`);
    mask.setAttribute('maskUnits', 'userSpaceOnUse'); mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
    mask.setAttribute('mask-type', 'luminance'); mask.style.maskType = 'luminance';
    // CSS sRGB preserves proportional gray coverage (linearRGB would darken it).
    mask.setAttribute('color-interpolation', 'sRGB');
    apertureClip.setAttribute('id', `${id}-crop`); apertureClip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    apertureClip.append(aperture); defs.append(apertureClip);
    texture.setAttribute('preserveAspectRatio', 'none'); texture.setAttribute('clip-path', `url(#${id}-crop)`);
    mask.append(texture); defs.append(mask);
  }
  const fill = svg('path'); fill.setAttribute('fill-rule', 'evenodd');
  if (mask) fill.setAttribute('mask', `url(#${id}-alpha)`);
  const outlinePath = svg('path');
  outlinePath.setAttribute('fill', 'none'); outlinePath.setAttribute('stroke-linejoin', 'round');
  outlineSvg.append(outlinePath);
  const filter = svg('filter');
  filter.setAttribute('id', `${id}-effects`); filter.setAttribute('filterUnits', 'userSpaceOnUse'); filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
  const shadowBlur = svg('feGaussianBlur'); shadowBlur.setAttribute('in', 'SourceAlpha'); shadowBlur.setAttribute('result', 'solidShadowBlur');
  const shadowOffset = svg('feOffset'); shadowOffset.setAttribute('in', 'solidShadowBlur'); shadowOffset.setAttribute('result', 'solidShadowOffset');
  const shadowFlood = svg('feFlood'); shadowFlood.setAttribute('result', 'solidShadowColor');
  const shadowComposite = svg('feComposite');
  shadowComposite.setAttribute('in', 'solidShadowColor'); shadowComposite.setAttribute('in2', 'solidShadowOffset');
  shadowComposite.setAttribute('operator', 'in'); shadowComposite.setAttribute('result', 'solidShadow');
  const glowBlur = svg('feGaussianBlur'); glowBlur.setAttribute('in', 'SourceAlpha'); glowBlur.setAttribute('result', 'solidGlowBlur');
  const glowFlood = svg('feFlood'); glowFlood.setAttribute('result', 'solidGlowColor');
  const glowComposite = svg('feComposite');
  glowComposite.setAttribute('in', 'solidGlowColor'); glowComposite.setAttribute('in2', 'solidGlowBlur');
  glowComposite.setAttribute('operator', 'in'); glowComposite.setAttribute('result', 'solidGlow');
  const merge = svg('feMerge');
  for (const input of ['solidShadow', 'solidGlow', 'SourceGraphic']) { const node = svg('feMergeNode'); node.setAttribute('in', input); merge.append(node); }
  filter.append(shadowBlur, shadowOffset, shadowFlood, shadowComposite, glowBlur, glowFlood, glowComposite, merge);
  defs.append(filter); graphic.append(defs, fill); effects.append(graphic, outlineSvg); stage.append(effects); layer.append(stage); parent.append(layer);

  const lifetime = new AbortController();
  let visualClip = clip, disposed = false, prepared = false, dirty = true;
  let preparePromise: Promise<void> | null = null;
  let lastMotion: FrameItem['textTransform'];
  let pattern: AnimatedPatternRenderer | undefined;
  let patternTimeMs = 0;
  const layout = (width = parent.clientWidth, height = parent.clientHeight) => {
    if (disposed) return;
    if (!(width > 0 && height > 0)) { dirty = true; return; }
    const scale = Math.min(width / size.width, height / size.height);
    stage.style.left = `${(width - size.width * scale) / 2}px`; stage.style.top = `${(height - size.height * scale) / 2}px`;
    stage.style.transform = `scale(${scale})`; dirty = false;
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    const rect = entries.find(entry => entry.target === parent)?.contentRect;
    if (rect) { dirty = true; layout(rect.width, rect.height); }
  });
  observer?.observe(parent);

  const layoutGeometry = () => {
    if (!prepared || disposed) return;
    const { box, crop, fit, shadow, glow, outline } = visualClip.properties;
    Object.assign(effects.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
    for (const node of [graphic, outlineSvg]) {
      node.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      node.setAttribute('width', String(box.width)); node.setAttribute('height', String(box.height));
    }
    fill.setAttribute('d', pathForMask(visualClip));
    const patternSettings = visualClip.typeVersion === 2 ? visualClip.properties.pattern : undefined;
    if (patternSettings) {
      if (!pattern) { pattern = animatedPatternRenderer(`${id}-pattern`, patternSettings, box.width, box.height); defs.append(pattern.node); }
      else pattern.update(patternSettings, box.width, box.height);
      pattern.draw(patternTimeMs); fill.setAttribute('fill', `url(#${id}-pattern)`);
    } else { pattern?.dispose(); pattern = undefined; fill.setAttribute('fill', visualClip.properties.color); }
    if (image && texture && mask && aperture) {
      const geometry = imageContentGeometry(box, image.naturalWidth, image.naturalHeight, crop, fit);
      for (const [node, rect] of [[texture, geometry.imageRect], [aperture, geometry.aperture]] as const) {
        node.setAttribute('x', String(rect.x - box.x)); node.setAttribute('y', String(rect.y - box.y));
        node.setAttribute('width', String(rect.width)); node.setAttribute('height', String(rect.height));
      }
      mask.setAttribute('x', '0'); mask.setAttribute('y', '0'); mask.setAttribute('width', String(box.width)); mask.setAttribute('height', String(box.height));
    }
    shadowBlur.setAttribute('stdDeviation', String(shadow?.enabled ? shadow.blur : 0));
    shadowOffset.setAttribute('dx', String(shadow?.enabled ? shadow.offsetX : 0)); shadowOffset.setAttribute('dy', String(shadow?.enabled ? shadow.offsetY : 0));
    shadowFlood.setAttribute('flood-color', shadow?.enabled ? shadow.color : '#000000'); shadowFlood.setAttribute('flood-opacity', String(shadow?.enabled ? shadow.opacity : 0));
    glowBlur.setAttribute('stdDeviation', String(glow?.enabled ? glow.radius : 0));
    glowFlood.setAttribute('flood-color', glow?.enabled ? glow.color : '#000000'); glowFlood.setAttribute('flood-opacity', String(glow?.enabled ? glow.opacity : 0));
    const outlinePadding = outline?.enabled ? outline.width / 2 : 0;
    const left = Math.max(outlinePadding, shadow?.enabled ? shadow.blur * 3 + Math.max(0, -shadow.offsetX) : 0, glow?.enabled ? glow.radius * 3 : 0);
    const right = Math.max(outlinePadding, shadow?.enabled ? shadow.blur * 3 + Math.max(0, shadow.offsetX) : 0, glow?.enabled ? glow.radius * 3 : 0);
    const top = Math.max(outlinePadding, shadow?.enabled ? shadow.blur * 3 + Math.max(0, -shadow.offsetY) : 0, glow?.enabled ? glow.radius * 3 : 0);
    const bottom = Math.max(outlinePadding, shadow?.enabled ? shadow.blur * 3 + Math.max(0, shadow.offsetY) : 0, glow?.enabled ? glow.radius * 3 : 0);
    filter.setAttribute('x', String(-left)); filter.setAttribute('y', String(-top));
    filter.setAttribute('width', String(box.width + left + right)); filter.setAttribute('height', String(box.height + top + bottom));
    graphic.style.filter = shadow?.enabled || glow?.enabled ? `url(#${id}-effects)` : '';
    outlinePath.setAttribute('d', pathForMask(visualClip));
    outlinePath.setAttribute('stroke', outline?.enabled ? outline.color : 'transparent');
    outlinePath.setAttribute('stroke-opacity', String(outline?.enabled ? outline.opacity : 0));
    outlinePath.setAttribute('stroke-width', String(outline?.enabled ? outline.width : 0)); outlinePath.style.display = outline?.enabled ? '' : 'none';
    dirty = true;
  };
  const updateAppearance = (next: SolidClip) => {
    if (next.properties.alphaMap?.path !== sourcePath) throw new MediaPreparationError('SOLID_SOURCE_CHANGED', next.properties.alphaMap?.path);
    visualClip = next; setClipBlend(layer, next); layoutGeometry();
  };
  const release = () => {
    if (disposed) return;
    disposed = true; prepared = false; lifetime.abort(); observer?.disconnect();
    pattern?.dispose(); pattern = undefined;
    options.signal.removeEventListener('abort', abortFromSurface);
    image?.removeAttribute('src'); image?.remove(); texture?.removeAttribute('href'); layer.remove();
  };
  const abortFromSurface = () => release();
  if (options.signal.aborted) release(); else options.signal.addEventListener('abort', abortFromSurface, { once: true });

  return {
    node: layer,
    async prepare() {
      if (preparePromise) return preparePromise;
      preparePromise = (async () => {
        if (disposed || lifetime.signal.aborted) throw abortError();
        try {
          if (image && sourcePath !== undefined) {
            image.src = sourcePath;
            await waitForImage(image, lifetime.signal);
            if (typeof image.decode === 'function') {
              try { await bounded(image.decode(), lifetime.signal, 15_000, 'MEDIA_TIMEOUT'); }
              catch (error) {
                if (lifetime.signal.aborted || (error instanceof MediaPreparationError && error.code === 'MEDIA_TIMEOUT')) throw error;
                throw new MediaPreparationError('MEDIA_LOAD_FAILED', sourcePath);
              }
            }
            if (disposed || lifetime.signal.aborted) throw abortError();
            if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) throw new MediaPreparationError('MEDIA_LOAD_FAILED', sourcePath);
            texture!.setAttribute('href', sourcePath);
          }
          prepared = true; layoutGeometry(); layout();
        } catch (error) { release(); throw error; }
      })();
      return preparePromise;
    },
    draw(item) {
      if (disposed) return;
      if (item?.clip.type === 'solid' && visualClip !== item.clip) updateAppearance(item.clip);
      if (prepared && item) { patternTimeMs = item.patternTimeMs ?? item.localTimeMs; pattern?.draw(patternTimeMs); }
      if (prepared) drawClipAppearance(layer, item);
      const motion = item?.textTransform;
      if (motion !== lastMotion) {
        lastMotion = motion; effects.style.transform = motion ? `translate(${motion.x}px, ${motion.y}px) scale(${motion.scale})` : '';
      }
      if (dirty) layout();
    },
    updateAppearance(next) { if (next.type === 'solid') updateAppearance(next); },
    backdropFootprints(item, surface) {
      if (!prepared || disposed || item.clip.type !== 'solid' || !solidNeedsBackdrop(item)) return [];
      const current = item.clip;
      const aperture = image ? imageContentGeometry(current.properties.box, image.naturalWidth, image.naturalHeight,
        current.properties.crop, current.properties.fit).aperture : current.properties.box;
      return imageBackdropFootprints(current, aperture, item.textTransform, surface, size);
    },
    dispose: release
  };
}
