import type { ButtonClip, ButtonShape } from '../domain/sequence.js';
import { BUTTON_TEXTURES, buttonShapePolygon } from '../domain/button.js';
import type { FrameItem } from '../playback/evaluate.js';
import type { PlayerFrame } from '../playback/local-player.js';
import type { ElementRenderer, RendererOptions } from './element-renderer.js';
import { drawClipAppearance, setClipBlend } from './clip-appearance.js';
import { abortError, assertFoundryMediaPath, bounded, MediaPreparationError } from './media-preparation.js';
import { waitForImage } from './image-renderer.js';

export interface ButtonActivationGate {
  isPending(): boolean;
  isLockedFor(holdKey: string | undefined): boolean;
  setActiveHold(holdKey: string | undefined): void;
  activate(intent: { readonly clipId: string; readonly breakId?: string }, holdKey: string): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** Undefined means no active hold; the sentinel represents a terminal hold with no named Break. */
export const TERMINAL_BUTTON_HOLD_KEY = '\u0000terminal-hold';

/** One composition-wide lock: all choices stay disabled until the host confirms or rejects. */
export function createButtonActivationGate(options: Pick<RendererOptions, 'onButtonActivate' | 'onInteractionError' | 'onWarning'>): ButtonActivationGate | undefined {
  const activate = options.onButtonActivate;
  if (!activate) return undefined;
  let pending = false;
  let disposed = false;
  let activeHoldKey: string | undefined;
  let completedHoldKey: string | undefined;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  return {
    isPending: () => pending,
    isLockedFor: holdKey => holdKey !== undefined && holdKey === completedHoldKey,
    setActiveHold(holdKey) {
      if (activeHoldKey === holdKey) return;
      activeHoldKey = holdKey;
      if (completedHoldKey !== holdKey) completedHoldKey = undefined;
      publish();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    activate(intent, holdKey) {
      if (disposed || pending || (holdKey !== undefined && holdKey === completedHoldKey)) return;
      pending = true;
      publish();
      void Promise.resolve().then(() => activate(intent)).then(() => {
        completedHoldKey = holdKey;
      }).catch(error => {
        try {
          if (options.onInteractionError) options.onInteractionError(error);
          else options.onWarning?.('BUTTON_INTERACTION_FAILED');
        } catch {
          // An error-reporting hook must not turn a recoverable action failure
          // into a fatal playback surface error.
          try { options.onWarning?.('BUTTON_INTERACTION_ERROR_HANDLER_FAILED'); } catch { /* Nonfatal by design. */ }
        }
      }).finally(() => {
        pending = false;
        publish();
      });
    },
    dispose() { disposed = true; listeners.clear(); }
  };
}

function rgba(color: string, opacity: number): string {
  return `rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)}, ${opacity})`;
}

function texturePath(clip: ButtonClip): string | undefined {
  const texture = clip.properties.texture;
  if (!texture) return undefined;
  if (texture.kind === 'foundry-file') return texture.path;
  return BUTTON_TEXTURES.find(candidate => candidate.id === texture.id)?.path;
}

function shapePath(shape: ButtonShape, width: number, height: number): string {
  if (shape === 'rounded' || shape === 'pill') {
    const radius = Math.min(width, height) * (shape === 'pill' ? 0.5 : 0.18);
    return `M ${radius} 0 H ${width - radius} Q ${width} 0 ${width} ${radius} V ${height - radius} Q ${width} ${height} ${width - radius} ${height} H ${radius} Q 0 ${height} 0 ${height - radius} V ${radius} Q 0 0 ${radius} 0 Z`;
  }
  const points = buttonShapePolygon(shape);
  return `M ${points[0]!.x * width} ${points[0]!.y * height} ${points.slice(1).map(point => `L ${point.x * width} ${point.y * height}`).join(' ')} Z`;
}

function polygonClip(shape: ButtonShape): string {
  return `polygon(${buttonShapePolygon(shape).map(point => `${point.x * 100}% ${point.y * 100}%`).join(', ')})`;
}

function availableFont(family: string): boolean {
  if (typeof document === 'undefined' || !document.fonts) return true;
  if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(family.trim())) return true;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return document.fonts.check(`48px ${family}`);
  const sample = 'mmmmmmWWWWii1234567890';
  for (const fallback of ['monospace', 'serif']) {
    context.font = `48px ${fallback}`;
    const reference = context.measureText(sample).width;
    context.font = `48px ${family}, ${fallback}`;
    if (Math.abs(context.measureText(sample).width - reference) > 0.01) return true;
  }
  return false;
}

/** Accessible live control; its handler emits an intent and never mutates playback state. */
export function buttonRenderer(clip: ButtonClip, parent: HTMLElement, size: { width: number; height: number },
  options: RendererOptions, sharedGate?: ButtonActivationGate): ElementRenderer {
  const sourcePath = texturePath(clip);
  if (sourcePath !== undefined) assertFoundryMediaPath(sourcePath);
  const gate = sharedGate ?? (options.still ? undefined : createButtonActivationGate(options));
  const ownsGate = gate !== undefined && gate !== sharedGate;
  const layer = document.createElement('div');
  layer.className = 'stagecraft-button-layer'; layer.dataset.clipId = clip.id;
  Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', opacity: '0', overflow: 'visible' });
  setClipBlend(layer, clip);
  const stage = document.createElement('div');
  Object.assign(stage.style, { position: 'absolute', width: `${size.width}px`, height: `${size.height}px`, transformOrigin: '0 0', overflow: 'visible', pointerEvents: 'none' });
  const motion = document.createElement('div');
  motion.className = 'stagecraft-button-motion';
  Object.assign(motion.style, { position: 'absolute', transformOrigin: 'center center', pointerEvents: 'none', overflow: 'visible' });

  const control = document.createElement('button');
  control.type = 'button'; control.className = 'stagecraft-button-control';
  control.setAttribute('aria-label', clip.properties.label);
  if (!options.still && options.onButtonActivate) control.dataset.stagecraftInteractive = '';
  Object.assign(control.style, { position: 'absolute', display: 'grid', placeItems: 'center', boxSizing: 'border-box',
    margin: '0', padding: '0', border: '0', appearance: 'none', overflow: 'hidden', pointerEvents: 'none', cursor: 'default' });
  const label = document.createElement('span');
  label.className = 'stagecraft-button-label';
  label.textContent = clip.properties.label;
  Object.assign(label.style, { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', minWidth: '0', minHeight: '0',
    boxSizing: 'border-box', padding: '0.25em 0.65em', overflow: 'hidden', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
    textAlign: 'center', lineHeight: '1.15', pointerEvents: 'none', color: clip.properties.color,
    fontFamily: `${clip.properties.fontFamily}, sans-serif`, fontSize: `${clip.properties.fontSize}px`, zIndex: '2' });
  let texture: HTMLImageElement | null = null;
  if (sourcePath !== undefined) {
    texture = document.createElement('img');
    texture.className = 'stagecraft-button-texture'; texture.alt = ''; texture.draggable = false;
    texture.setAttribute('aria-hidden', 'true');
    Object.assign(texture.style, { position: 'absolute', inset: '0', display: 'block', width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none',
      objectFit: clip.properties.texture?.kind === 'foundry-file' ? clip.properties.texture.fit : 'cover',
      pointerEvents: 'none', visibility: 'hidden', zIndex: '0', margin: '0', padding: '0', border: '0' });
    control.append(texture);
  }
  control.append(label);

  const namespace = 'http://www.w3.org/2000/svg';
  const svg = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] => document.createElementNS(namespace, tag);
  const outlineSvg = svg('svg');
  outlineSvg.classList.add('stagecraft-button-outline');
  outlineSvg.setAttribute('aria-hidden', 'true'); outlineSvg.setAttribute('focusable', 'false');
  Object.assign(outlineSvg.style, { position: 'absolute', pointerEvents: 'none', overflow: 'visible' });
  const outline = svg('path'); outline.setAttribute('fill', 'none'); outline.setAttribute('stroke-linejoin', 'round');
  outlineSvg.append(outline);
  const focusSvg = svg('svg');
  focusSvg.classList.add('stagecraft-button-focus-ring');
  focusSvg.setAttribute('aria-hidden', 'true'); focusSvg.setAttribute('focusable', 'false');
  Object.assign(focusSvg.style, { position: 'absolute', pointerEvents: 'none', overflow: 'visible' });
  const focusOuter = svg('path'); focusOuter.classList.add('stagecraft-button-focus-outer'); focusOuter.setAttribute('fill', 'none'); focusOuter.setAttribute('stroke-linejoin', 'round');
  const focusInner = svg('path'); focusInner.classList.add('stagecraft-button-focus-inner'); focusInner.setAttribute('fill', 'none'); focusInner.setAttribute('stroke-linejoin', 'round');
  focusSvg.append(focusOuter, focusInner);
  motion.append(control, outlineSvg, focusSvg); stage.append(motion); layer.append(stage); parent.append(layer);

  const lifetime = new AbortController();
  let visualClip = clip;
  let properties = clip.properties;
  let disposed = false;
  let prepared = false;
  let dirty = true;
  let warnedTexture = false;
  let fallbackFont = false;
  let lastMotion: FrameItem['textTransform'];
  let eligible = false;
  let activeBreakId: string | undefined;
  let activeHoldKey: string | undefined;
  let preparePromise: Promise<void> | null = null;
  const fits = (width: number, height: number) => {
    Object.assign(stage.style, { left: `${(width - size.width * Math.min(width / size.width, height / size.height)) / 2}px`,
      top: `${(height - size.height * Math.min(width / size.width, height / size.height)) / 2}px`,
      transform: `scale(${Math.min(width / size.width, height / size.height)})` });
  };
  const updateInteractionState = () => {
    if (disposed) return;
    const pending = gate?.isPending() ?? false;
    const enabled = eligible && !pending && !(gate?.isLockedFor(activeHoldKey) ?? false);
    control.disabled = !enabled;
    control.tabIndex = enabled ? 0 : -1;
    control.style.pointerEvents = enabled ? 'auto' : 'none';
    control.style.cursor = enabled ? 'pointer' : 'default';
    if (pending) control.setAttribute('aria-busy', 'true');
    else control.removeAttribute('aria-busy');
  };
  const syncAppearance = () => {
    properties = visualClip.properties;
    setClipBlend(layer, visualClip);
    control.setAttribute('aria-label', properties.label);
    control.style.backgroundColor = properties.backgroundColor;
    control.style.color = properties.color;
    control.style.fontFamily = `${properties.fontFamily}, sans-serif`;
    control.style.fontSize = `${properties.fontSize}px`;
    label.style.color = properties.color;
    label.style.fontFamily = fallbackFont ? 'sans-serif' : `${properties.fontFamily}, sans-serif`;
    label.style.fontSize = `${properties.fontSize}px`;
    label.textContent = properties.label;
    const { box, shape } = properties;
    Object.assign(motion.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
    const cornerRadius = Math.min(box.width, box.height) * (shape === 'pill' ? 0.5 : 0.18);
    Object.assign(control.style, { left: '0', top: '0', width: '100%', height: '100%',
      clipPath: shape === 'bevel' || shape === 'hexagon' ? polygonClip(shape)
        : shape === 'rounded' || shape === 'pill' ? `inset(0 round ${cornerRadius}px)` : '',
      borderRadius: shape === 'rounded' || shape === 'pill' ? `${cornerRadius}px` : '' });
    for (const node of [outlineSvg, focusSvg]) {
      node.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
      node.setAttribute('width', String(box.width)); node.setAttribute('height', String(box.height));
      Object.assign(node.style, { left: '0', top: '0', width: '100%', height: '100%' });
    }
    const path = shapePath(shape, box.width, box.height);
    outline.setAttribute('d', path);
    const outlineStyle = properties.outline;
    outline.setAttribute('stroke', outlineStyle?.enabled ? outlineStyle.color : 'transparent');
    outline.setAttribute('stroke-opacity', String(outlineStyle?.enabled ? outlineStyle.opacity : 0));
    outline.setAttribute('stroke-width', String(outlineStyle?.enabled ? outlineStyle.width : 0));
    outline.style.display = outlineStyle?.enabled ? '' : 'none';
    focusOuter.setAttribute('d', path); focusOuter.setAttribute('stroke', '#10151d'); focusOuter.setAttribute('stroke-width', '5');
    focusInner.setAttribute('d', path); focusInner.setAttribute('stroke', '#ffffff'); focusInner.setAttribute('stroke-width', '2.5');
    const shadows: string[] = [];
    if (properties.shadow?.enabled) shadows.push(`drop-shadow(${properties.shadow.offsetX}px ${properties.shadow.offsetY}px ${properties.shadow.blur}px ${rgba(properties.shadow.color, properties.shadow.opacity)})`);
    if (properties.glow?.enabled) shadows.push(`drop-shadow(0 0 ${properties.glow.radius}px ${rgba(properties.glow.color, properties.glow.opacity)})`);
    motion.style.filter = shadows.join(' ');
    if (texture) {
      texture.style.objectFit = properties.texture?.kind === 'foundry-file' ? properties.texture.fit : 'cover';
      texture.style.visibility = prepared && !warnedTexture ? 'visible' : 'hidden';
    }
    dirty = true;
  };
  const layout = () => {
    if (disposed) return;
    const width = parent.clientWidth, height = parent.clientHeight;
    if (!(width > 0 && height > 0) || !(size.width > 0 && size.height > 0)) { dirty = true; return; }
    fits(width, height); dirty = false;
  };
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(layout);
  observer?.observe(parent);
  syncAppearance();
  const unsubscribe = gate?.subscribe(updateInteractionState);
  const release = () => {
    if (disposed) return;
    disposed = true; prepared = false; lifetime.abort(); observer?.disconnect();
    if (unsubscribe) unsubscribe();
    options.signal.removeEventListener('abort', abortFromSurface);
    control.removeEventListener('click', onClick);
    if (texture) { texture.removeAttribute('src'); texture.remove(); }
    layer.remove();
    if (ownsGate) gate?.dispose();
  };
  const abortFromSurface = () => release();
  const onClick = (event: MouseEvent) => {
    if (disposed || options.still || !eligible || !gate || !activeHoldKey || gate.isPending()) return;
    event.preventDefault();
    gate.activate({ clipId: visualClip.id, ...(activeBreakId !== undefined ? { breakId: activeBreakId } : {}) }, activeHoldKey);
  };
  control.addEventListener('click', onClick);
  if (options.signal.aborted) release(); else options.signal.addEventListener('abort', abortFromSurface, { once: true });

  const renderer: ElementRenderer = {
    node: layer,
    async prepare() {
      if (preparePromise) return preparePromise;
      preparePromise = (async () => {
        if (disposed || lifetime.signal.aborted) throw abortError();
        const tasks: Promise<void>[] = [];
        if (texture && sourcePath !== undefined) tasks.push((async () => {
          try {
            texture!.src = sourcePath;
            await waitForImage(texture!, lifetime.signal);
            if (typeof texture!.decode === 'function') {
              try { await bounded(texture!.decode(), lifetime.signal, 15_000, 'MEDIA_TIMEOUT'); }
              catch (error) {
                if (lifetime.signal.aborted || (error instanceof MediaPreparationError && error.code === 'MEDIA_TIMEOUT')) throw error;
                throw new MediaPreparationError('MEDIA_LOAD_FAILED', sourcePath);
              }
            }
            if (disposed || lifetime.signal.aborted) throw abortError();
            if (!(texture!.naturalWidth > 0 && texture!.naturalHeight > 0)) throw new MediaPreparationError('MEDIA_LOAD_FAILED', sourcePath);
          } catch (error) {
            if (lifetime.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
            warnedTexture = true;
            texture!.removeAttribute('src'); texture!.style.visibility = 'hidden';
            options.onWarning?.('BUTTON_TEXTURE_FALLBACK');
          }
        })());
        if (document.fonts?.load) tasks.push((async () => {
          try {
            await bounded(document.fonts.load(`${properties.fontSize}px ${properties.fontFamily}`, properties.label), lifetime.signal, 3000, 'FONT_TIMEOUT');
            if (!availableFont(properties.fontFamily)) throw new Error('Font unavailable');
          } catch (error) {
            if (lifetime.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
            fallbackFont = true; label.style.fontFamily = 'sans-serif'; options.onWarning?.('FONT_FALLBACK');
          }
        })());
        try { await Promise.all(tasks); }
        catch (error) { release(); throw error; }
        if (disposed || lifetime.signal.aborted) throw abortError();
        prepared = true;
        syncAppearance(); layout(); updateInteractionState();
      })();
      return preparePromise;
    },
    draw(item, frame: PlayerFrame) {
      if (disposed) return;
      if (item?.clip.type === 'button' && visualClip !== item.clip) {
        const previous = texturePath(visualClip), next = texturePath(item.clip);
        if (previous !== next) throw new MediaPreparationError('BUTTON_TEXTURE_SOURCE_CHANGED', next);
        visualClip = item.clip; syncAppearance();
      }
      drawClipAppearance(layer, item);
      const motionState = item?.textTransform;
      if (motionState !== lastMotion) {
        lastMotion = motionState;
        motion.style.transform = motionState ? `translate(${motionState.x}px, ${motionState.y}px) scale(${motionState.scale})` : '';
      }
      if (dirty) layout();
      eligible = !options.still && prepared && !!gate && frame.phase === 'holding'
        && frame.opacity > 0 && item?.clip.type === 'button' && item.opacity > 0
        && (item.clip.appearance?.opacity ?? 1) > 0;
      activeBreakId = eligible ? frame.breakId : undefined;
      activeHoldKey = eligible ? frame.breakId ?? TERMINAL_BUTTON_HOLD_KEY : undefined;
      if (ownsGate) gate?.setActiveHold(activeHoldKey);
      updateInteractionState();
    },
    updateAppearance(next) {
      if (next.type !== 'button') return;
      const previous = texturePath(visualClip), nextPath = texturePath(next);
      if (previous !== nextPath) throw new MediaPreparationError('BUTTON_TEXTURE_SOURCE_CHANGED', nextPath);
      visualClip = next; syncAppearance();
    },
    dispose: release
  };
  return renderer;
}
