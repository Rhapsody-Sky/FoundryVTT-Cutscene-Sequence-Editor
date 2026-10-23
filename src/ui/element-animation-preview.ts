import type { ButtonClip, SequenceClip, SequenceV1, SolidClip, Transition } from '../domain/sequence.js';
import type { TextMotionPhase } from '../domain/text-motion.js';
import { videoTypeVersion } from '../domain/clip-timing.js';
import { buttonShapePolygon, defaultButtonProperties } from '../domain/button.js';
import { compileSequence, evaluate } from '../playback/evaluate.js';
import type { PlayerFrame } from '../playback/local-player.js';
import { barsRenderer } from '../rendering/bars-renderer.js';
import type { ElementRenderer, RendererOptions } from '../rendering/element-renderer.js';
import { solidRenderer } from '../rendering/solid-renderer.js';

export const ELEMENT_ANIMATION_PREVIEW_SIZE = Object.freeze({ width: 640, height: 320 });
export type ElementAnimationPreviewKind = 'image' | 'solid' | 'bars' | 'video' | 'audio' | 'button';
export interface ElementAnimationPreview {
  readonly clip: SequenceClip;
  /** Chronological phase-local progress; finite values are clamped to [0, 1]. */
  frameAt(progress: number): PlayerFrame;
}

const NONE: Transition = Object.freeze({ preset: 'none', version: 1 });
const PRESETS = ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'] as const;
const KINDS: readonly ElementAnimationPreviewKind[] = ['image', 'solid', 'bars', 'video', 'audio', 'button'];
const BOX = { x: 112, y: 48, width: 416, height: 224 };
const GEOMETRY = { fit: 'contain' as const, box: BOX, crop: { x: 0, y: 0, width: 1, height: 1 },
  mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] as const };

function previewTransition(kind: ElementAnimationPreviewKind, value: string, source?: Transition): Transition {
  const preset = PRESETS.find(option => option === value);
  if (!preset || (kind === 'audio' && preset !== 'none' && preset !== 'fade')
    || (kind === 'bars' && (preset === 'zoom' || preset === 'fade-zoom'))) {
    throw new RangeError('Unknown element animation preview option.');
  }
  if (preset === 'none') return NONE;
  if (source?.preset === preset) {
    if (source.durationMs === 0) return NONE;
    return { preset, version: 1, durationMs: source.durationMs, easing: source.easing,
      ...(preset === 'slide' || preset === 'fade-slide' ? {
        ...(source.direction === undefined ? {} : { direction: source.direction }),
        ...(source.distance === undefined ? {} : { distance: source.distance })
      } : {}),
      ...(preset === 'zoom' || preset === 'fade-zoom'
        ? source.scale === undefined ? {} : { scale: source.scale } : {}) };
  }
  return { preset, version: 1, durationMs: 800, easing: 'ease-in-out' };
}

/** Compile one deeply frozen neutral sample. Source names are inert validation
 * metadata, never requested: the thumbnail adapter below uses no media decoder.
 * A trailing millisecond leaves every exact clip Out endpoint empty, including
 * video, whose final sequence boundary otherwise holds its last frame.
 */
export function createElementAnimationPreview(kind: ElementAnimationPreviewKind, value: string,
  phase: TextMotionPhase, source?: Transition): ElementAnimationPreview {
  if (!KINDS.includes(kind)) throw new RangeError('Unknown element animation preview kind.');
  if (phase !== 'entrance' && phase !== 'exit') throw new RangeError('Unknown element animation preview phase.');
  const transition = previewTransition(kind, value, source);
  const durationMs = transition.preset === 'none' ? 0 : transition.durationMs;
  const milliseconds = Math.max(1, durationMs + (phase === 'entrance' ? 1 : 0));
  const base = { id: 'element-animation-preview', trackId: 'preview-track', startMs: 0,
    entrance: phase === 'entrance' ? transition : NONE, exit: phase === 'exit' ? transition : NONE };
  const videoVersion = kind === 'video'
    ? videoTypeVersion({}, undefined, { entrance: base.entrance, exit: base.exit }) : 1;
  let clip: SequenceClip;
  switch (kind) {
    case 'image': clip = { ...base, type: kind, typeVersion: 1, duration: { kind: 'fixed', milliseconds },
      properties: { ...GEOMETRY, source: { kind: 'foundry-file', path: 'stagecraft-preview-inert-image.svg' } } }; break;
    case 'solid': clip = { ...base, type: kind, typeVersion: 1, duration: { kind: 'fixed', milliseconds },
      properties: { ...GEOMETRY, color: '#64b9c9',
        mask: [{ x: 0.12, y: 0.08 }, { x: 0.94, y: 0 }, { x: 0.88, y: 0.94 }, { x: 0, y: 1 }] } }; break;
    case 'bars': clip = { ...base, type: kind, typeVersion: 1, duration: { kind: 'fixed', milliseconds },
      properties: { heightFraction: 0.22, color: '#111827' } }; break;
    case 'video': clip = { ...base, type: kind, typeVersion: videoVersion, duration: { kind: 'media' },
      properties: { source: { kind: 'foundry-file', path: 'stagecraft-preview-inert-video.webm' }, fit: 'contain',
        volume: 0, muted: true, durationMs: milliseconds } }; break;
    case 'audio': clip = { ...base, type: kind, typeVersion: 2, duration: { kind: 'fixed', milliseconds },
      properties: { source: { kind: 'foundry-file', path: 'stagecraft-preview-inert-audio.ogg' },
        volume: 1, muted: false, durationMs: milliseconds } }; break;
    case 'button': clip = { ...base, type: kind, typeVersion: 1, duration: { kind: 'fixed', milliseconds },
      properties: defaultButtonProperties(ELEMENT_ANIMATION_PREVIEW_SIZE) }; break;
  }
  const personal = kind === 'button';
  const sequence: SequenceV1 = { schemaVersion: personal ? 5 : 2, ...(personal ? { playbackSchemaVersion: 3 as const,
    launch: { version: 1 as const, audience: { mode: 'all' as const, includeGM: true, userIds: [] } },
    progression: { version: 1 as const, mode: 'per-recipient' as const } } : {}), id: 'element-animation-preview', revision: 0,
    name: 'Element animation preview', composition: ELEMENT_ANIMATION_PREVIEW_SIZE,
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 0 },
    tracks: [{ id: 'preview-track', name: 'Preview', kind: kind === 'audio' ? 'audio' : 'visual',
      order: 0, enabled: true, locked: false }], clips: [clip], end: { kind: 'fixed', durationMs: milliseconds + 1 } };
  const plan = compileSequence(sequence);
  return Object.freeze({ clip: plan.clips[0]!, frameAt(progress: number): PlayerFrame {
    if (!Number.isFinite(progress)) throw new RangeError('Element animation preview progress must be finite.');
    const positionMs = Math.max(0, Math.min(1, progress)) * durationMs;
    return Object.freeze({ positionMs, items: evaluate(plan, positionMs), opacity: 1, phase: 'playing' });
  } });
}

function shape<K extends keyof SVGElementTagNameMap>(parent: SVGElement, tag: K,
  attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  parent.append(node);
  return node;
}

/** Generated local artwork; all source pixels are SVG primitives. Video uses a
 * static film/play emblem to demonstrate transforms, never simulated playback.
 */
function landscape(parent: SVGElement, video = false): void {
  shape(parent, 'rect', { width: 416, height: 224, rx: 12, fill: '#25394f' });
  shape(parent, 'circle', { cx: 312, cy: 62, r: 29, fill: '#edc182' });
  shape(parent, 'path', { d: 'M0 176 L98 59 L222 184 L307 91 L416 184 V224 H0Z', fill: '#61758e' });
  shape(parent, 'path', { d: 'M0 198 L105 134 L220 208 L326 146 L416 201 V224 H0Z', fill: '#387c87' });
  shape(parent, 'path', { d: 'M0 211 Q106 166 220 211 T416 202 V224 H0Z', fill: '#81bec0' });
  if (video) {
    shape(parent, 'rect', { x: 148, y: 62, width: 120, height: 100, rx: 15, fill: '#111827', opacity: 0.88 });
    shape(parent, 'path', { d: 'M194 87 L231 112 L194 137Z', fill: '#f2ece0' });
    for (const y of [73, 103, 133]) for (const x of [157, 250]) {
      shape(parent, 'rect', { x, y, width: 9, height: 15, rx: 2, fill: '#81bec0' });
    }
  }
}

function buttonArtwork(parent: SVGElement, clip: ButtonClip): SVGTextElement {
  const { width, height } = clip.properties.box;
  const properties = clip.properties;
  if (properties.shape === 'pill' || properties.shape === 'rounded') {
    shape(parent, 'rect', { width, height, rx: properties.shape === 'pill' ? height / 2 : Math.min(width, height) * 0.18,
      fill: properties.backgroundColor });
  } else {
    const points = buttonShapePolygon(properties.shape).map(point => `${point.x * width},${point.y * height}`).join(' ');
    shape(parent, 'polygon', { points, fill: properties.backgroundColor });
  }
  const label = shape(parent, 'text', { x: width / 2, y: height / 2, fill: properties.color,
    'font-family': properties.fontFamily, 'font-size': properties.fontSize, 'font-weight': 600,
    'text-anchor': 'middle', 'dominant-baseline': 'central' });
  label.textContent = 'Continue';
  return label;
}

/** Adapt production frames without activating image/video/audio elements.
 * Solid and cinematic bars use production renderers. Image/video use inline
 * SVG driven by the evaluated opacity and textTransform; audio maps audioGain
 * to a silent level meter. It intentionally ignores all media source paths.
 */
export function createElementAnimationPreviewRenderer(clip: SequenceClip, parent: HTMLElement,
  size: { width: number; height: number }, options: RendererOptions): Pick<ElementRenderer, 'prepare' | 'draw' | 'dispose'> {
  if (clip.type === 'text') throw new RangeError('Unknown element animation preview kind.');
  const root = document.createElement('div');
  Object.assign(root.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none' });
  root.setAttribute('aria-hidden', 'true');
  parent.append(root);
  let disposed = false, prepared = false;
  let delegate: ElementRenderer | undefined;
  let safeSolid: SolidClip | undefined;
  const safeButton = clip.type === 'button' ? clip : undefined;
  let graphic: SVGSVGElement | undefined;
  let art: SVGGElement | undefined;
  const levels: SVGRectElement[] = [];
  if (clip.type === 'solid') {
    // Even an accidental authored clip cannot introduce an alpha-map request.
    safeSolid = { ...clip, typeVersion: 1, properties: { ...GEOMETRY, color: '#64b9c9',
      mask: [{ x: 0.12, y: 0.08 }, { x: 0.94, y: 0 }, { x: 0.88, y: 0.94 }, { x: 0, y: 1 }] } };
    delegate = solidRenderer(safeSolid, root, size, options);
  } else if (clip.type === 'bars') {
    graphic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    graphic.setAttribute('viewBox', '0 0 416 224');
    Object.assign(graphic.style, { width: '100%', height: '100%', opacity: '0.35' });
    landscape(graphic); root.append(graphic);
    delegate = barsRenderer(clip, root);
  } else {
    graphic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    graphic.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
    Object.assign(graphic.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', opacity: '0' });
    art = shape(graphic, 'g', { transform: `translate(${BOX.x} ${BOX.y})` });
    if (safeButton) {
      buttonArtwork(art, safeButton);
    } else if (clip.type === 'audio') {
      shape(art, 'rect', { width: 416, height: 224, rx: 16, fill: '#202f43' });
      shape(art, 'path', { d: 'M38 95 H59 L86 73 V151 L59 129 H38Z', fill: '#d0e2e6' });
      for (const [index, height] of [56, 100, 148, 112, 76, 132, 62].entries()) {
        const bar = shape(art, 'rect', { x: 125 + index * 34, y: 112 - height / 2,
          width: 19, height, rx: 7, fill: '#81bec0' });
        bar.style.transformBox = 'fill-box'; bar.style.transformOrigin = 'center'; levels.push(bar);
      }
    } else landscape(art, clip.type === 'video');
    root.append(graphic);
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true; prepared = false;
    options.signal.removeEventListener('abort', dispose);
    delegate?.dispose(); root.remove();
  };
  if (options.signal.aborted) dispose(); else options.signal.addEventListener('abort', dispose, { once: true });
  return {
    async prepare() {
      if (disposed) throw new DOMException('Preview was disposed.', 'AbortError');
      await delegate?.prepare();
      if (disposed) throw new DOMException('Preview was disposed.', 'AbortError');
      prepared = true;
    },
    draw(item, frame) {
      if (!prepared || disposed) return;
      if (delegate) {
        delegate.draw(item && safeSolid ? { ...item, clip: safeSolid } : item, frame);
        return;
      }
      graphic!.style.opacity = String(item ? item.opacity * frame.opacity : 0);
      const motion = item?.textTransform;
      const box = safeButton?.properties.box ?? BOX;
      art!.setAttribute('transform', `translate(${box.x + (motion?.x ?? 0)} ${box.y + (motion?.y ?? 0)})`
        + ` translate(${box.width / 2} ${box.height / 2}) scale(${motion?.scale ?? 1})`
        + ` translate(${-box.width / 2} ${-box.height / 2})`);
      const gain = Math.max(0, Math.min(1, item?.audioGain ?? 0));
      for (const level of levels) {
        level.style.transform = `scaleY(${gain})`;
        level.style.opacity = String(gain);
      }
    },
    dispose
  };
}
