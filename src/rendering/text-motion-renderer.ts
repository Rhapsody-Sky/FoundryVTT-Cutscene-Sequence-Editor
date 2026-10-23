import type { TextClip, Transition } from '../domain/sequence.js';
import { evaluateTextMotion, segmentTextMotion, textMotionPreset } from '../domain/text-motion.js';
import type { FrameItem } from '../playback/evaluate.js';

type Unit = 'character' | 'word' | 'line';
export interface TextMotionSegmentCounts {
  readonly character: number;
  readonly word: number;
  readonly line: number;
}
export interface TextMotionLayout {
  readonly clip: TextClip;
  readonly clipId: string;
  readonly text: string;
  readonly counts: TextMotionSegmentCounts;
}
interface Part { readonly outer: HTMLElement; readonly inner: HTMLElement }
const MAX_UNITS = 256;
const noiseTiles = new Map<number, string>();

/** Animated rank slots, including the renderer's bounded-title fallback.
 * Blank line slots affect the timing of visible lines. Whitespace-only titles
 * have no visible animation. Prepared layouts also account for wrapped rows. */
export function textMotionSegmentCount(text: string, unit: Unit): number {
  const characters = segmentTextMotion(text, 'character');
  if (characters.length > MAX_UNITS) {
    const tokens = text.split(/(\s+)/u).filter(Boolean);
    if (tokens.length > MAX_UNITS || unit === 'line') return /\S/u.test(text) ? 1 : 0;
    return tokens.filter(value => /\S/u.test(value)).length;
  }
  if (unit === 'character') return characters.filter(value => /\S/u.test(value)).length;
  if (unit === 'line') return /\S/u.test(text) ? text.split(/\r\n|\r|\n/u).length : 0;
  return segmentTextMotion(text, 'word')
    .flatMap(value => value.split(/(\s+)/u)).filter(value => /\S/u.test(value)).length;
}

/** A fixed, seeded sand pattern. Only its hole radii change, so seeks are repeatable.
 * Each of the 65 cached tiles contains 36 holes, independently of title length. */
export function textNoiseMask(noise: number): string {
  const step = Math.round(Math.max(0, Math.min(1, noise)) * 64);
  const cached = noiseTiles.get(step);
  if (cached) return cached;
  const holes: string[] = [];
  for (let index = 0; index < 36; index++) {
    const seed = ((index * 73 + 19) % 101) / 101;
    const radius = Math.max(0, Math.min(1, (step / 64 - seed * 0.35) / 0.65)) * 13;
    holes.push(`<circle cx="${(index % 6) * 8 + 2 + seed * 4}" cy="${Math.floor(index / 6) * 8 + 2 + ((index * 31) % 7) / 2}" r="${radius.toFixed(3)}" fill="black"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><defs><mask id="sand"><rect width="48" height="48" fill="white"/>${holes.join('')}</mask></defs><rect width="48" height="48" fill="white" mask="url(#sand)"/></svg>`;
  const result = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  noiseTiles.set(step, result);
  return result;
}

function clear(part: Part): void {
  part.inner.style.transform = '';
  part.inner.style.transformOrigin = 'center center';
  part.inner.style.opacity = '';
  part.inner.style.filter = '';
  part.outer.style.clipPath = '';
  part.outer.style.maskImage = '';
  part.outer.style.maskSize = '';
  part.outer.style.maskRepeat = '';
}

/** Segments belong to a prepared title, never to a frame or an independent clock. */
export function createTextMotionRenderer(text: HTMLElement, onLayout?: (layout: TextMotionLayout) => void) {
  let source = '';
  let clip: TextClip | undefined;
  let parts: Part[] = [];
  let currentUnit: Unit | undefined;
  let preferredUnit: Unit = 'character';
  let disposed = false;
  let lastFrame: FrameItem['textMotion'];
  let centerOffsets: number[] = [];
  let measuredLines: readonly string[] | undefined;
  const centeredMotions = new Set(['collapse-center', 'converge-spread', 'tracking-expand']);

  const makePart = (value: string, parent: HTMLElement, block = false): Part => {
    const outer = document.createElement('span');
    const inner = document.createElement('span');
    outer.className = 'stagecraft-text-motion-unit'; inner.className = 'stagecraft-text-motion-glyph';
    outer.setAttribute('aria-hidden', 'true');
    Object.assign(outer.style, { display: block ? 'block' : 'inline-block', verticalAlign: 'baseline',
      whiteSpace: block ? 'pre' : 'pre-wrap' });
    Object.assign(inner.style, { display: 'inline-block', transformOrigin: 'center center', whiteSpace: 'pre' });
    inner.textContent = value; outer.append(inner); parent.append(outer);
    const part = { outer, inner }; parts.push(part); return part;
  };

  const wholeTitle = (): void => {
    const part = makePart(source, text, true);
    Object.assign(part.outer.style, { whiteSpace: 'pre-wrap', width: '100%' });
    Object.assign(part.inner.style, { whiteSpace: 'pre-wrap', display: 'block', width: '100%' });
  };

  const buildWords = (values: readonly string[]): void => {
    for (const value of values) for (const token of value.split(/(\s+)/u).filter(Boolean)) {
      if (/^\s+$/u.test(token)) text.append(document.createTextNode(token));
      else {
        const part = makePart(token, text);
        Object.assign(part.outer.style, { maxWidth: '100%' });
        Object.assign(part.inner.style, { whiteSpace: 'pre-wrap', maxWidth: '100%' });
      }
    }
  };

  const cacheCenters = (): void => {
    centerOffsets = [];
    if (!clip || ![clip.entrance, clip.exit].some(value => value.preset === 'text-motion' && value.motion && centeredMotions.has(value.motion))) return;
    const rects = parts.map(part => part.outer.getBoundingClientRect());
    const box = text.getBoundingClientRect();
    const scale = text.clientWidth > 0 && box.width > 0 ? box.width / text.clientWidth : 1;
    const fontSize = Number.parseFloat(text.style.fontSize) || clip.properties.fontSize;
    centerOffsets = rects.map(rect => {
      const row = rects.filter(other => Math.abs(other.top - rect.top) <= 0.5);
      const center = (Math.min(...row.map(value => value.left)) + Math.max(...row.map(value => value.right))) / 2;
      return (center - rect.left - rect.width / 2) / scale / fontSize;
    });
  };

  // Atomic word wrappers avoid the extra mid-word line breaks that bare
  // inline-block graphemes introduce. Only oversized words may wrap internally.
  const buildCharacters = (): { value: string; node?: HTMLElement }[] => {
    const measured: { value: string; node?: HTMLElement }[] = [];
    for (const token of source.split(/(\s+)/u)) {
      if (!token) continue;
      if (/^\s+$/u.test(token)) {
        text.append(document.createTextNode(token)); measured.push({ value: token }); continue;
      }
      const word = document.createElement('span');
      Object.assign(word.style, { display: 'inline-block', width: 'max-content', maxWidth: '100%', whiteSpace: 'pre-wrap', verticalAlign: 'baseline' });
      text.append(word);
      for (const value of segmentTextMotion(token, 'character')) {
        const part = makePart(value, word); measured.push({ value, node: part.outer });
      }
    }
    return measured;
  };

  const build = (unit: Unit): void => {
    text.textContent = ''; parts = []; centerOffsets = []; currentUnit = unit; preferredUnit = unit;
    const characters = segmentTextMotion(source, 'character');
    if (characters.length > MAX_UNITS) {
      const words = source.split(/(\s+)/u).filter(Boolean);
      if (words.length > MAX_UNITS || unit === 'line') { wholeTitle(); cacheCenters(); return; }
      buildWords(words); cacheCenters();
      return;
    }
    if (unit === 'character') { buildCharacters(); cacheCenters(); return; }
    if (unit === 'word') {
      buildWords(segmentTextMotion(source, 'word')); cacheCenters();
      return;
    }

    // Measure untransformed graphemes once after the font and authored box settle.
    // A reported layout also prepares rows for a later entrance/exit unit switch.
    if (!measuredLines) {
      const measured = buildCharacters();
      const lines: string[] = []; let line = ''; let top: number | undefined;
      for (const entry of measured) {
        if (entry.node) {
          const nextTop = entry.node.getBoundingClientRect().top;
          if (top !== undefined && Math.abs(nextTop - top) > 0.5) { lines.push(line); line = ''; }
          line += entry.value; top = nextTop;
        } else {
          const pieces = entry.value.split(/\r\n|\r|\n/u);
          for (let index = 0; index < pieces.length; index++) {
            line += pieces[index]!;
            if (index < pieces.length - 1) { lines.push(line); line = ''; top = undefined; }
          }
        }
      }
      lines.push(line);
      measuredLines = lines;
    }
    text.textContent = ''; parts = [];
    for (const value of measuredLines) {
      const part = makePart(value, text, true);
      // Empty explicit lines still occupy one line-height.
      part.outer.style.minHeight = '1.2em';
    }
  };

  const transitionUnit = (transition: Transition): Unit | undefined => transition.preset === 'text-motion'
    && transition.motion ? textMotionPreset(transition.motion)?.unit : undefined;

  const controller = {
    configure(next: TextClip): void {
      const changed = source !== next.properties.text;
      clip = next; source = next.properties.text;
      text.setAttribute('aria-label', source); text.setAttribute('role', 'img');
      if (changed || currentUnit === undefined) {
        preferredUnit = transitionUnit(next.entrance) ?? transitionUnit(next.exit) ?? 'character';
        currentUnit = undefined; text.textContent = source; parts = []; measuredLines = undefined;
      }
    },
    /** Restore plain text for the existing shrink-to-fit and overflow measurement. */
    prepareLayout(): void { text.textContent = source; parts = []; currentUnit = undefined; measuredLines = undefined; },
    layout(): void {
      if (disposed || !clip) return;
      measuredLines = undefined;
      const unit = preferredUnit;
      let lineCount = 0;
      if (onLayout) {
        build('line');
        lineCount = /\S/u.test(source) ? parts.length : 0;
      }
      if (!onLayout || unit !== 'line') build(unit);
      controller.draw(lastFrame);
      onLayout?.({ clip, clipId: clip.id, text: source, counts: {
        character: textMotionSegmentCount(source, 'character'),
        word: textMotionSegmentCount(source, 'word'), line: lineCount
      } });
    },
    draw(frame: FrameItem['textMotion']): void {
      if (disposed) return;
      lastFrame = frame;
      const phase = frame?.exit && (frame.exit.progress > 0 || !frame.entrance) ? 'exit' : 'entrance';
      const active = frame?.[phase];
      if (!active || active.transition.preset !== 'text-motion' || !active.transition.motion) {
        for (const part of parts) clear(part);
        return;
      }
      const transition = active.transition;
      const preset = textMotionPreset(transition.motion!);
      if (!preset) { for (const part of parts) clear(part); return; }
      if (currentUnit !== preset.unit) build(preset.unit);
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        const pose = evaluateTextMotion(transition.motion!, active.progress, index, parts.length, transition.amount, transition.stagger, transition.easing,
          { phase, ...(transition.motionDirection === undefined ? {} : { direction: transition.motionDirection }),
            ...(transition.motionOrder === undefined ? {} : { order: transition.motionOrder }) });
        // Normalized domain displacement becomes the actual row-center distance
        // for convergence/tracking, including proportionally spaced long titles.
        const x = centeredMotions.has(transition.motion!) && centerOffsets[index] !== undefined
          ? centerOffsets[index]! * (transition.motion === 'converge-spread' ? -1 : 1)
            * (1 - pose.opacity) * (transition.amount ?? 1) : pose.x;
        const unfoldOrigin = transition.motionDirection === 'left' ? 'left center'
          : transition.motionDirection === 'right' ? 'right center'
          : transition.motionDirection === 'down' ? 'center bottom' : 'center top';
        part.inner.style.transformOrigin = transition.motion === 'vertical-unfold' ? unfoldOrigin
          : transition.motion === 'elastic-pop' || transition.motion === 'emoji-pop' ? '50% 60%' : 'center center';
        part.inner.style.transform = `translate(${x}em, ${pose.y}em) rotate(${pose.rotate}deg) scale(${pose.scaleX}, ${pose.scaleY})`;
        part.inner.style.opacity = String(pose.opacity);
        part.inner.style.filter = pose.blur > 0 ? `blur(${pose.blur}em)` : '';
        const inset = `${Math.max(0, Math.min(1, pose.clipInset ?? 0)) * 100}%`;
        const edges = pose.clipEdge === 'up' ? [inset, '0', '0', '0']
          : pose.clipEdge === 'left' ? ['0', '0', '0', inset]
          : pose.clipEdge === 'right' ? ['0', inset, '0', '0'] : ['0', '0', inset, '0'];
        part.outer.style.clipPath = pose.clipInset === undefined ? '' : `inset(${edges.join(' ')})`;
        part.outer.style.maskImage = pose.noise !== undefined && pose.noise > 0 ? textNoiseMask(pose.noise) : '';
        part.outer.style.maskSize = pose.noise !== undefined && pose.noise > 0 ? '48px 48px' : '';
        part.outer.style.maskRepeat = pose.noise !== undefined && pose.noise > 0 ? 'repeat' : '';
      }
    },
    dispose(): void {
      disposed = true; parts = []; text.textContent = source;
      text.removeAttribute('aria-label'); text.removeAttribute('role');
    }
  };
  return controller;
}
