import type { BarsClip } from '../domain/sequence.js';
import type { ElementRenderer } from './element-renderer.js';
import { drawClipAppearance, setClipBlend } from './clip-appearance.js';

export function barsRenderer(clip: BarsClip, parent: HTMLElement): ElementRenderer {
  const layer = document.createElement('div');
  layer.className = 'stagecraft-bars-layer';
  layer.dataset.clipId = clip.id;
  layer.style.opacity = '0';
  setClipBlend(layer, clip);
  let currentClip = clip;
  const bars: HTMLElement[] = [];
  for (const edge of ['top', 'bottom']) {
    const bar = document.createElement('div');
    bar.className = `stagecraft-bar stagecraft-bar-${edge}`;
    bar.style.height = `${clip.properties.heightFraction * 100}%`;
    bar.style.backgroundColor = clip.properties.color;
    layer.append(bar);
    bars.push(bar);
  }
  parent.append(layer);
  return {
    node: layer,
    async prepare() {},
    draw(item) {
      if (item?.clip.type === 'bars' && item.clip !== currentClip) {
        currentClip = item.clip;
        for (const bar of bars) {
          bar.style.height = `${currentClip.properties.heightFraction * 100}%`;
          bar.style.backgroundColor = currentClip.properties.color;
        }
      }
      drawClipAppearance(layer, item);
      // Reveal is evaluated from the absolute timeline position. The percentage
      // is relative to each bar's own height, so differently sized bars still
      // travel exactly one bar-height beyond their respective screen edge.
      const reveal = item?.barsReveal;
      if (reveal === undefined || !Number.isFinite(reveal)) {
        for (const bar of bars) bar.style.transform = '';
        return;
      }
      const offset = 100 * (1 - Math.max(0, Math.min(1, reveal)));
      bars[0]!.style.transform = `translateY(-${offset}%)`;
      bars[1]!.style.transform = `translateY(${offset}%)`;
    },
    dispose() { layer.remove(); }
  };
}
