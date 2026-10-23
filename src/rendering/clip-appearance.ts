import type { VisualClip } from '../domain/sequence.js';
import type { FrameItem } from '../playback/evaluate.js';

/** The clip root composites the entire element once, including all title effects. */
export function setClipBlend(node: HTMLElement, clip: VisualClip): void {
  node.style.mixBlendMode = clip.appearance?.blendMode ?? 'normal';
}

export function drawClipAppearance(node: HTMLElement, item: FrameItem | undefined): void {
  if (item?.clip.type === 'audio') return;
  if (item) setClipBlend(node, item.clip);
  node.style.opacity = String((item?.opacity ?? 0) * (item?.clip.appearance?.opacity ?? 1));
}
