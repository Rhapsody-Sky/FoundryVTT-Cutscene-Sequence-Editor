import type { TextClip } from '../domain/sequence.js';
import type { ElementRenderer, RendererOptions } from './element-renderer.js';
import { bounded } from './media-preparation.js';
import { drawClipAppearance, setClipBlend } from './clip-appearance.js';
import { createTextMotionRenderer } from './text-motion-renderer.js';

/** Effect alpha is independent of fill and clip opacity; validated #RRGGBB input only. */
function effectColor(color: string, opacity: number): string {
  return `rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)}, ${opacity})`;
}

function availableFont(family: string): boolean {
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

export function textRenderer(clip: TextClip, parent: HTMLElement, size: { width: number; height: number },
  options: RendererOptions): ElementRenderer {
  const layer = document.createElement('div');
  layer.className = 'stagecraft-text-layer'; layer.dataset.clipId = clip.id;
  Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', opacity: '0', overflow: 'visible' });
  setClipBlend(layer, clip);
  const stage = document.createElement('div');
  Object.assign(stage.style, { position: 'absolute', width: `${size.width}px`, height: `${size.height}px`, transformOrigin: '0 0', overflow: 'visible' });
  const text = document.createElement('div');
  text.className = 'stagecraft-text-content'; text.textContent = clip.properties.text;
  let properties = clip.properties;
  let visualClip = clip;
  let fallbackFont = false;
  let textMotion: ReturnType<typeof createTextMotionRenderer> | undefined;
  const appearance = () => {
  setClipBlend(layer, visualClip);
  Object.assign(text.style, {
    position: 'absolute', left: `${properties.box.x}px`, top: `${properties.box.y}px`,
    width: `${properties.box.width}px`, height: `${properties.box.height}px`,
    transformOrigin: 'center center',
    color: properties.color, textAlign: properties.align, fontSize: `${properties.fontSize}px`,
    fontFamily: `${properties.fontFamily}, sans-serif`, lineHeight: '1.2', whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', overflow: 'visible', margin: '0', padding: '0', border: '0'
  });
  if (text.style.webkitTextStroke) text.style.webkitTextStroke = '';
  if (text.style.paintOrder) text.style.paintOrder = '';
  if (text.style.textShadow) text.style.textShadow = '';
  const segmented = visualClip.entrance.preset === 'text-motion' || visualClip.exit.preset === 'text-motion';
  if (segmented) {
    textMotion ??= createTextMotionRenderer(text, options.onTextMotionLayout);
    textMotion.configure(visualClip);
  } else {
    textMotion?.dispose(); textMotion = undefined;
    text.textContent = properties.text;
  }
  if (fallbackFont) text.style.fontFamily = 'sans-serif';
  if (properties.outline?.enabled) {
    // Paint the stroke first so its inner half never eats into the title fill.
    text.style.webkitTextStroke = `${properties.outline.width}px ${effectColor(properties.outline.color, properties.outline.opacity)}`;
    text.style.paintOrder = 'stroke fill';
  }
  const shadows: string[] = [];
  if (properties.shadow?.enabled) {
    const shadow = properties.shadow;
    shadows.push(`${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${effectColor(shadow.color, shadow.opacity)}`);
  }
  if (properties.glow?.enabled) {
    const glow = properties.glow;
    shadows.push(`0px 0px ${glow.radius}px ${effectColor(glow.color, glow.opacity)}`);
  }
  if (shadows.length) text.style.textShadow = shadows.join(', ');
  };
  appearance();
  stage.append(text); layer.append(stage); parent.append(layer);
  let disposed = false;
  let warnedOverflow = false;
  let dirty = true;
  // CSS transforms do not affect these layout metrics, so animated scale stays
  // out of shrink-to-fit and overflow checks.
  const fits = () => text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1;
  const layout = () => {
    if (disposed || !parent.isConnected) return;
    const rect = { width: parent.clientWidth, height: parent.clientHeight };
    if (rect.width <= 0 || rect.height <= 0) return;
    const scale = Math.min(rect.width / size.width, rect.height / size.height);
    stage.style.left = `${(rect.width - size.width * scale) / 2}px`;
    stage.style.top = `${(rect.height - size.height * scale) / 2}px`;
    stage.style.transform = `scale(${scale})`;
    textMotion?.prepareLayout();
    text.style.fontSize = `${properties.fontSize}px`;
    if (properties.shrinkToFit && !fits()) {
      let low = properties.minimumFontSize;
      let high = properties.fontSize;
      text.style.fontSize = `${low}px`;
      if (fits()) {
        for (let step = 0; step < 10 && high - low > 0.25; step += 1) {
          const middle = (high + low) / 2;
          text.style.fontSize = `${middle}px`;
          if (fits()) low = middle; else high = middle;
        }
      }
      text.style.fontSize = `${low}px`;
    }
    const outside = properties.box.x < 0 || properties.box.y < 0
      || properties.box.x + properties.box.width > size.width || properties.box.y + properties.box.height > size.height;
    if ((!fits() || outside) && !warnedOverflow) { warnedOverflow = true; options.onWarning?.('TEXT_OVERFLOW'); }
    textMotion?.layout();
    dirty = false;
  };
  const observer = new ResizeObserver(() => { dirty = true; layout(); });
  observer.observe(parent);
  return {
    node: layer,
    updateAppearance(next) {
      if (next.type !== 'text') return;
      visualClip = next; properties = next.properties; warnedOverflow = false;
      appearance(); dirty = true;
    },
    async prepare() {
      try {
        await bounded(document.fonts.load(`${properties.fontSize}px ${properties.fontFamily}`, properties.text),
          options.signal, 3000, 'FONT_TIMEOUT');
        if (!availableFont(properties.fontFamily)) throw new Error('Font unavailable');
      } catch (error) {
        if (options.signal.aborted) throw error;
        fallbackFont = true; text.style.fontFamily = 'sans-serif'; options.onWarning?.('FONT_FALLBACK');
      }
      dirty = true;
    },
    draw(item) {
      if (item?.clip.type === 'text' && visualClip !== item.clip) { visualClip = item.clip; properties = visualClip.properties; appearance(); dirty = true; }
      drawClipAppearance(layer, item);
      const motion = item?.textTransform;
      text.style.transform = motion
        ? `translate(${motion.x}px, ${motion.y}px) scale(${motion.scale})`
        : '';
      if (dirty) layout();
      textMotion?.draw(item?.textMotion);
    },
    dispose() { disposed = true; observer.disconnect(); textMotion?.dispose(); layer.remove(); }
  };
}
