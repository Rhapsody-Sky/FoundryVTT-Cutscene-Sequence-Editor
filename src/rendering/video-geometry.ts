import type { VideoClip } from '../domain/sequence.js';

export interface VideoRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** Project an authored box exactly like text/image; legacy video fills the actual viewport. */
export function videoBoxRect(clip: VideoClip, viewport: { width: number; height: number }, composition: { width: number; height: number }, motion?: { readonly x: number; readonly y: number; readonly scale: number }): VideoRect {
  const box = clip.properties.box;
  const scale = Math.min(viewport.width / composition.width, viewport.height / composition.height);
  const rect = box ? { x: (viewport.width - composition.width * scale) / 2 + box.x * scale,
    y: (viewport.height - composition.height * scale) / 2 + box.y * scale,
    width: box.width * scale, height: box.height * scale }
    : { x: 0, y: 0, width: viewport.width, height: viewport.height };
  if (!motion) return rect;
  return { x: rect.x + rect.width * (1 - motion.scale) / 2 + motion.x * scale,
    y: rect.y + rect.height * (1 - motion.scale) / 2 + motion.y * scale,
    width: rect.width * motion.scale, height: rect.height * motion.scale };
}

/** Opting into a box starts at the legacy actual surface, including its aspect ratio. */
export function legacyVideoBox(viewport: { width: number; height: number }, composition: { width: number; height: number }): VideoRect {
  const scale = Math.min(viewport.width / composition.width, viewport.height / composition.height);
  if (!(scale > 0)) return { x: 0, y: 0, ...composition };
  return { x: (composition.width - viewport.width / scale) / 2, y: (composition.height - viewport.height / scale) / 2,
    width: viewport.width / scale, height: viewport.height / scale };
}
