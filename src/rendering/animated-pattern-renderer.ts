import type { AnimatedPattern } from '../domain/animated-pattern.js';
import { createHalftoneProvider } from './patterns/halftone.js';
import { createEnergyProvider } from './patterns/energy.js';
import type { PatternProvider, PatternProviderFactory, PatternProviderSettings } from './patterns/provider.js';

const NS = 'http://www.w3.org/2000/svg';
/** Includes paint wrapper, gradients and artwork. No parameter grows the DOM. */
export const MAX_ANIMATED_PATTERN_NODES = 96;
/** Independent of node count: bounds total SVG path commands in one field. */
export const MAX_ANIMATED_PATTERN_PATH_COMMANDS = 4096;
const MAX_FLOW_BANDS = 220;
const MAX_SCANLINES = 220;
const MAX_HEX_COLUMNS = 24;
const MAX_HEX_ROWS = 16;
type Attributes = Record<string, string | number>;
const unit = (value: number) => ((value % 1) + 1) % 1;
const wave = (value: number) => (1 + Math.sin(value * Math.PI * 2)) / 2;
const number = (value: number) => String(Math.round(value * 10000) / 10000);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const edge = (position: number, extent: number, margin: number) => clamp((extent + margin - Math.abs(position)) / margin, 0, 1);
function attributes(node: SVGElement, values: Attributes): void {
  for (const [key, value] of Object.entries(values)) node.setAttribute(key, typeof value === 'number' ? number(value) : value);
}
function element<K extends keyof SVGElementTagNameMap>(tag: K, values: Attributes = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag); attributes(node, values); return node;
}
/** Integer mixing keeps variants identical across clients, seek and frame rates. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let bits = Math.imul(state ^ (state >>> 15), state | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
  };
}
const point = (x: number, y: number) => `${number(x)} ${number(y)}`;
const polygon = (points: readonly (readonly [number, number])[]) => `M ${points.map(([x, y]) => point(x, y)).join(' L ')} Z`;

export interface AnimatedPatternRenderer {
  readonly node: SVGPatternElement;
  /** Palette, geometry and timing updates reuse nodes. Preset/seed prepares new artwork. */
  update(settings: AnimatedPattern, width: number, height: number): void;
  draw(timeMs: number): void;
  dispose(): void;
}

/**
 * The SVG pattern is solely the existing solid-renderer paint-server contract.
 * Its single cell is exactly the clip box. Artwork uses an isotropic whole-field
 * viewBox and rotates inside that cell; there are no internal tile boundaries.
 */
function legacyAnimatedPatternRenderer(id: string, initial: AnimatedPattern, width: number, height: number,
  pattern: SVGPatternElement): AnimatedPatternRenderer {
  const background = element('rect');
  const group = element('g', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const defs = element('defs');
  const bloom = element('radialGradient', { id: `${id}-bloom` });
  const bloomStops = [element('stop', { offset: 0, 'stop-opacity': 0.85 }), element('stop', { offset: 0.42, 'stop-opacity': 0.28 }), element('stop', { offset: 1, 'stop-opacity': 0 })];
  bloom.append(...bloomStops);
  const flow = element('linearGradient', { id: `${id}-flow`, x1: '0%', y1: '0%', x2: '100%', y2: '100%' });
  const flowStops = [element('stop', { offset: 0 }), element('stop', { offset: 0.68 }), element('stop', { offset: 1 })];
  flow.append(...flowStops); defs.append(bloom, flow); pattern.append(background, group, defs);
  let settings = initial, logicalWidth = width, logicalHeight = height, disposed = false, lastTime = 0;
  let topology = '', phase = 0;
  // Coordinates are centred on the box and have 600 units on its short side.
  let w = 600, h = 600, ex = 300, ey = 300, radius = 425, frequency = 1, motif = 1;
  const nodes: SVGElement[] = [];
  const animations: Array<(time: number) => void> = [];
  const colored: Array<{ node: SVGElement; channel: 1 | 2; property: string }> = [];
  // Material paint servers belong to the prepared preset, not the shared pair
  // above. Count every stop as well as its gradient in the actual DOM budget.
  const materialDefs: SVGElement[] = [];
  const materialColors: Array<{ node: SVGStopElement; channel: 0 | 1 | 2 }> = [];
  let materialNodeCount = 0;
  const clearMaterial = () => {
    for (const node of materialDefs) node.remove();
    materialDefs.length = 0; materialColors.length = 0; materialNodeCount = 0;
  };
  const gradient = (kind: 'linearGradient' | 'radialGradient', values: Attributes,
    stops: ReadonlyArray<readonly [number, 0 | 1 | 2, number]>) => {
    const paintId = `${id}-material-${materialDefs.length}`;
    const node = element(kind, { id: paintId, ...values });
    const children = stops.map(([offset, channel, opacity]) => {
      const stop = element('stop', { offset, 'stop-opacity': opacity });
      materialColors.push({ node: stop, channel }); return stop;
    });
    node.append(...children); defs.append(node); materialDefs.push(node);
    materialNodeCount += 1 + children.length;
    return { node, stops: children, fill: `url(#${paintId})` };
  };
  const add = (tag: keyof SVGElementTagNameMap, values: Attributes = {}, channel: 0 | 1 | 2 = 1, property = 'fill') => {
    const node = element(tag, values); group.append(node); nodes.push(node);
    if (channel) colored.push({ node, channel, property });
    return node;
  };
  const animate = (node: SVGElement, change: (time: number) => Attributes) => animations.push(t => attributes(node, change(t)));
  const moving = (x: number, y: number, t: number, rate: number, margin = 100) => {
    const px = unit(x + t * rate / (2 * ex + margin * 2)) * (2 * ex + margin * 2) - ex - margin;
    const py = unit(y) * ey * 2 - ey;
    return { x: px, y: py, fade: edge(px, ex, margin) };
  };
  const build = () => {
    for (const node of nodes) node.remove(); nodes.length = 0; animations.length = 0; colored.length = 0;
    clearMaterial();
    const random = seeded(settings.seed); phase = random() * 16;
    switch (settings.preset) {
      case 'diagonal-flow': {
        // Infinite parallel bands are evaluated across the rotated box. Their
        // period wraps analytically, without moving a finite strip off screen.
        for (let layer = 0; layer < 3; layer++) {
          const band = add('path', { opacity: [0.24, 0.78, 0.65][layer]! }, layer === 2 ? 2 : 1);
          animate(band, t => {
            const period = Math.max(24, 230 / frequency, (ex * 2 + ey * 2) / (MAX_FLOW_BANDS - 4));
            const offset = unit(t * 0.12) * period;
            const half = layer === 0 ? period * 0.2 : layer === 1 ? period * 0.055 : period * 0.013;
            const d: string[] = [];
            const begin = Math.floor((-ex - ey - offset) / period) - 1, end = Math.ceil((ex + ey - offset) / period) + 1;
            // A combined path keeps even the finest setting bounded.
            const count = Math.min(MAX_FLOW_BANDS, end - begin + 1);
            for (let index = 0; index < count; index++) {
              const i = begin + index;
              const x = i * period + offset + layer * period * 0.22;
              d.push(polygon([[x - ey - half, -ey - 40], [x - ey + half, -ey - 40], [x + ey + half + 80, ey + 40], [x + ey - half + 80, ey + 40]]));
            }
            return { d: d.join(' ') };
          });
        }
        break;
      }
      case 'speed-lines':
        for (let i = 0; i < 38; i++) {
          const x = random(), y = random(), depth = random(), length = 110 + random() * 390;
          const line = add('path', { opacity: 0.7 }, i % 7 === 0 ? 2 : 1);
          animate(line, t => {
            const p = moving(x, y, t, 150 + depth * 260, length * motif + 80);
            const thick = (i % 6 === 0 ? 21 : 3 + depth * 7) * motif, len = length * motif;
            return { d: polygon([[p.x - len, p.y - thick / 2], [p.x - len * 0.3, p.y - thick / 3], [p.x, p.y], [p.x - len * 0.55, p.y + thick / 2]]), opacity: p.fade * (i % 6 === 0 ? 0.85 : 0.3 + depth * 0.45) * clamp(settings.density * 1.4 - i / 38, 0, 1) };
          });
        }
        break;
      case 'radial-burst': {
        const wash = add('circle', { fill: `url(#${id}-bloom)` }, 0);
        animate(wash, t => ({ r: radius * 1.15, opacity: 0.35 + wave(t * 0.11) * 0.2 }));
        for (let i = 0; i < 32; i++) {
          const jitter = random() * 4, inner = 95 + random() * 180;
          const ray = add('path', {}, i % 5 === 0 ? 2 : 1);
          animate(ray, t => {
            const angle = i * 360 / 32 + jitter + t * 3, wide = (i % 4 ? 0.024 : 0.078) / Math.sqrt(frequency);
            const reach = radius * 1.65, near = Math.min(radius * 0.7, inner * motif);
            return { d: polygon([[near, -near * wide * 0.12], [reach, -reach * wide], [reach, reach * wide], [near, near * wide * 0.12]]), transform: `rotate(${number(angle)})`, opacity: (i % 4 ? 0.23 : 0.58) + 0.15 * wave(t * 0.2 - i / 32) };
          });
        }
        break;
      }
      case 'halftone':
        // A field-wide staggered mesh fades diagonally; row boundaries never clip.
        for (let i = 0; i < 72; i++) {
          const column = i % 12, row = Math.floor(i / 12), shift = random() * 0.1;
          const dot = add('circle', {}, (column + row) % 11 === 0 ? 2 : 1);
          animate(dot, t => {
            const gapX = ex * 2 / 11, gapY = ey * 2 / 5;
            const diagonal = column / 15 + row / 14;
            const fade = clamp(1.18 - diagonal + Math.sin(t * 0.7 + shift) * 0.12, 0.03, 1);
            return { cx: -ex + column * gapX + (row % 2 ? gapX / 2 : 0), cy: -ey + row * gapY, r: Math.min(gapX, gapY) * 0.39 * fade * clamp(motif, 0.35, 1.1), opacity: 0.18 + 0.74 * fade };
          });
        }
        break;
      case 'floating-dots':
        for (let i = 0; i < 30; i++) {
          const x = random(), y = random(), drift = random(), r = 18 + random() * 64;
          const halo = add('circle', { fill: `url(#${id}-bloom)` }, 0), dot = add('circle', {}, i % 5 === 0 ? 2 : 1);
          const location = (t: number) => {
            const cy = unit(y - t * (17 + drift * 18) / (ey * 2 + 220)) * (ey * 2 + 220) - ey - 110;
            return { cx: x * ex * 2 - ex + Math.sin(t * 0.4 + drift * 6) * 35, cy, opacity: edge(cy, ey, 110) * clamp(settings.density * 1.4 - i / 30, 0, 1) };
          };
          animate(halo, t => ({ ...location(t), r: r * motif * 2.4 }));
          animate(dot, t => ({ ...location(t), r: r * motif * 0.18, opacity: location(t).opacity * 0.46 }));
        }
        break;
      case 'starfield':
        for (let i = 0; i < 48; i++) {
          const x = random(), y = random(), twinkle = random(), depth = 0.4 + random();
          const hero = i % 9 === 0;
          const star = add(hero ? 'path' : 'circle', hero ? { d: 'M -24 0 Q -3 -3 0 -28 Q 3 -3 24 0 Q 3 3 0 28 Q -3 3 -24 0 Z' } : { r: 1.5 + depth * 2 }, hero ? 2 : 1);
          animate(star, t => {
            const p = moving(x, y, t, 8 * depth, 60), pulse = 0.4 + wave(t * 0.22 + twinkle) * 0.6;
            return { transform: `translate(${point(p.x, p.y)}) scale(${number(motif * (hero ? pulse : 1))})`, opacity: p.fade * pulse * clamp(settings.density * 1.5 - i / 48, 0, 1) };
          });
        }
        break;
      case 'neon-grid': {
        const horizon = add('path', { fill: 'none', 'stroke-width': 1.8, opacity: 0.55 }, 1, 'stroke');
        animate(horizon, t => {
          const bottom = ey + 70, horizonY = -ey * 0.45, paths: string[] = [];
          const columns = Math.round(clamp(14 * frequency, 8, 44));
          for (let i = -columns; i <= columns; i++) {
            const x = i * (2 * ex / columns);
            paths.push(`M ${point(x * 0.14, horizonY)} L ${point(x * 2, bottom)}`);
          }
          for (let i = 0; i < 18; i++) {
            const depth = unit(i / 18 + t * 0.045), y = horizonY + depth * depth * (bottom - horizonY);
            paths.push(`M ${point(-ex - 70, y)} H ${number(ex + 70)}`);
          }
          return { d: paths.join(' ') };
        });
        const skyline = add('path', { fill: 'none', 'stroke-width': 3, opacity: 0.5 }, 2, 'stroke');
        animate(skyline, t => ({ d: `M ${point(-ex - 50, -ey * 0.45)} H ${number(ex + 50)}`, opacity: 0.4 + wave(t * 0.12) * 0.35 }));
        for (let i = 0; i < 5; i++) {
          const pulse = add('path', { fill: 'none', 'stroke-width': i ? 3 : 7 }, 2, 'stroke');
          animate(pulse, t => {
            const depth = unit(t * 0.13 + i / 5), horizonY = -ey * 0.45;
            const y = horizonY + depth * depth * (ey * 1.45 + 70), x = Math.sin(i * 4 + phase) * ex * depth;
            return { d: `M ${point(x - (55 + depth * 130) * motif, y)} H ${number(x + 30 * motif)}`, opacity: Math.sin(depth * Math.PI) * 0.9 };
          });
        }
        break;
      }
      case 'hex-pulse':
        for (let bucket = 0; bucket < 8; bucket++) {
          const outline = add('path', { fill: 'none', 'stroke-width': bucket === 0 ? 3 : 1.8 }, bucket === 0 ? 2 : 1, 'stroke');
          animate(outline, t => {
            // Increase cell spacing when needed rather than truncating a fine
            // mesh in the middle of a very wide or rotated field. The three
            // spare rows/columns cover the outer edges and staggered offset.
            const size = Math.max(32, 74 / frequency,
              ex * 2 / ((MAX_HEX_COLUMNS - 3) * 1.5),
              ey * 2 / ((MAX_HEX_ROWS - 3) * Math.sqrt(3)));
            const dx = size * 1.5, dy = size * Math.sqrt(3), paths: string[] = [];
            const columns = Math.min(MAX_HEX_COLUMNS, Math.ceil(ex * 2 / dx) + 3);
            const rows = Math.min(MAX_HEX_ROWS, Math.ceil(ey * 2 / dy) + 3);
            for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
              if ((col + row * 3) % 8 !== bucket) continue;
              const x = (col - columns / 2) * dx, y = (row - rows / 2) * dy + (col % 2 ? dy / 2 : 0);
              paths.push(polygon(Array.from({ length: 6 }, (_, k): [number, number] => [x + Math.cos(k * Math.PI / 3) * size * 0.91, y + Math.sin(k * Math.PI / 3) * size * 0.91])));
            }
            return { d: paths.join(' '), opacity: 0.12 + 0.58 * Math.pow(wave(t * 0.22 - bucket / 8), 3) };
          });
        }
        break;
      case 'orbit-rings':
        for (let i = 0; i < 8; i++) {
          const jitter = random() * 40;
          const ring = add('circle', { fill: 'none', 'stroke-width': i % 3 ? 1.5 : 4 }, i % 3 ? 1 : 2, 'stroke');
          const moon = add('circle', {}, 2);
          const rotation = (t: number) => `rotate(${number(t * (i % 2 ? -12 : 9) + i * 31 + jitter)})`;
          animate(ring, t => {
            const r = (70 + i * 49) * clamp(motif, 0.55, 1.6);
            return { r, 'stroke-dasharray': `${number(r * (i % 2 ? 1.8 : 3.2))} ${number(r * 0.35)} ${number(r * 0.14)} ${number(r * 0.35)}`, transform: rotation(t), opacity: 0.3 + i * 0.055 };
          });
          animate(moon, t => ({ cx: (70 + i * 49) * clamp(motif, 0.55, 1.6), cy: 0, r: (i % 3 ? 3 : 6) * motif, transform: rotation(t), opacity: 0.75 }));
        }
        const cross = add('path', { fill: 'none', 'stroke-width': 1.3, opacity: 0.3 }, 1, 'stroke');
        animate(cross, t => ({ d: `M ${point(-ex, 0)} H ${number(ex)} M ${point(0, -ey)} V ${number(ey)}`, 'stroke-dasharray': '3 13', opacity: 0.22 + wave(t * 0.1) * 0.1 }));
        break;
      case 'rotating-shards':
        for (let i = 0; i < 24; i++) {
          const direction = i % 2 ? -1 : 1, start = random() * 360, reach = random(), thin = random();
          const shard = add('path', { fill: i % 5 === 0 ? `url(#${id}-flow)` : '' }, i % 5 === 0 ? 0 : i % 3 === 0 ? 2 : 1);
          animate(shard, t => {
            const near = (45 + reach * 250) * motif, far = near + (130 + reach * radius * 0.55) * motif;
            return { d: polygon([[near, -10], [far, -(18 + thin * 75) * motif], [far * 0.78, (40 + thin * 140) * motif]]), transform: `rotate(${number(start + t * direction * (3 + reach * 5))})`, opacity: 0.18 + (i % 4 === 0 ? 0.5 : 0.27) * wave(t * 0.13 + reach) };
          });
        }
        break;
      case 'chevron-stream':
        for (let i = 0; i < 24; i++) {
          const chevron = add('path', {}, i % 6 === 0 ? 2 : 1);
          animate(chevron, t => {
            const spacing = Math.max(110 / frequency, (ex * 2 + ey * 0.9) / 20), x = (i - 12) * spacing;
            const reach = ey + 140, thickness = (i % 6 === 0 ? 24 : 9) * motif;
            // A travelling luminance wave preserves the primary/accent band
            // hierarchy continuously, including at the outer box edges.
            return { d: polygon([[x - reach * 0.43 - thickness, -reach], [x - reach * 0.43, -reach], [x + thickness, 0], [x - reach * 0.43, reach], [x - reach * 0.43 - thickness, reach], [x, 0]]), opacity: 0.13 + 0.68 * Math.pow(wave(i / 12 - t * 0.13), 3) };
          });
        }
        break;
      case 'diamond-drift':
        for (let i = 0; i < 30; i++) {
          const x = random(), y = random(), size = 18 + random() * 36, turn = random();
          const hero = i % 6 === 0;
          const diamond = add('path', { d: hero ? 'M -1 0 L 0 -1 L 1 0 L 0 1 Z M -.55 0 L 0 -.55 L .55 0 L 0 .55 Z' : 'M -.65 0 L 0 -1 L .65 0 L 0 1 Z', 'fill-rule': 'evenodd' }, hero ? 2 : 1);
          animate(diamond, t => {
            const p = moving(x, y, t, 18 + turn * 12, size * motif * 3 + 40);
            return { transform: `translate(${point(p.x, p.y + Math.sin(t * 0.4 + turn * 6) * 18)}) rotate(${number(Math.sin(t * 0.24 + turn * 6) * 12)}) scale(${number(size * motif * (hero ? 1.6 : 0.7))})`, opacity: p.fade * (hero ? 0.85 : 0.2 + turn * 0.3) * clamp(settings.density * 1.5 - i / 30, 0, 1) };
          });
        }
        break;
      case 'glitch-bands': {
        const scan = add('path', { fill: 'none', 'stroke-width': 0.9, opacity: 0.11 }, 1, 'stroke');
        animate(scan, t => {
          // Node count alone cannot bound SVG work: a valid 32768×1 rotated
          // box has millions of logical units. Coarsen spacing to preserve
          // whole-field coverage with at most 220 scanlines at any aspect.
          const paths: string[] = [], gap = Math.max(7, 17 / frequency, ey * 2 / (MAX_SCANLINES - 3));
          const count = Math.min(MAX_SCANLINES, Math.ceil(ey * 2 / gap) + 3);
          const offset = unit(t * 0.22) * gap;
          for (let i = 0; i < count; i++) {
            const y = -ey - gap + offset + i * gap;
            paths.push(`M ${point(-ex - 80, y)} H ${number(ex + 80)}`);
          }
          return { d: paths.join(' ') };
        });
        for (let i = 0; i < 22; i++) {
          const y = random(), offset = random(), width = 0.1 + random() * 0.6;
          const band = add('path', {}, i % 4 === 0 ? 2 : 1);
          animate(band, t => {
            const tick = Math.floor(t * 5 + offset * 8), x = Math.sin(tick * 2.3 + offset) * ex * 0.7, cy = (y * 2 - 1) * ey;
            const len = ex * width * clamp(motif, 0.5, 2), thick = (i % 5 === 0 ? 16 : 3) * motif;
            return { d: polygon([[x - len, cy], [x + len, cy], [x + len - 18 * motif, cy + thick], [x - len, cy + thick]]), opacity: (i % 5 === 0 ? 0.38 : 0.65) * (wave(tick / 11 + offset) > 0.25 ? 1 : 0.15) };
          });
        }
        break;
      }
      case 'wave-ribbons':
        for (let i = 0; i < 8; i++) {
          const ribbon = add('path', { fill: i % 3 === 0 ? `url(#${id}-flow)` : '', opacity: i % 3 === 0 ? 0.7 : 0.3 }, i % 3 === 0 ? 0 : 1);
          const seedPhase = random() * 6;
          animate(ribbon, t => {
            const left = -ex - 100, right = ex + 100, span = right - left;
            const y = (i - 3.5) * ey * 0.35, bend = (60 + Math.sin(t * 0.5 + seedPhase) * 45) * motif;
            const thickness = (i % 3 === 0 ? 65 : 28) * motif;
            return { d: `M ${point(left, y + bend)} C ${point(left + span * 0.32, y - bend * 1.7)} ${point(left + span * 0.58, y + bend * 1.9)} ${point(right, y - bend)} L ${point(right, y - bend + thickness)} C ${point(left + span * 0.58, y + bend * 1.9 + thickness)} ${point(left + span * 0.32, y - bend * 1.7 + thickness)} ${point(left, y + bend + thickness)} Z`, opacity: (i % 3 === 0 ? 0.65 : 0.22) + wave(t * 0.13 + i / 8) * 0.1 };
          });
        }
        break;
      case 'spark-trails':
        for (let i = 0; i < 20; i++) {
          const x = random(), y = random(), length = 85 + random() * 250, depth = random();
          const trail = add('path', {}, 1), head = add('path', { d: 'M -16 0 Q -3 -3 0 -12 Q 3 -3 18 0 Q 3 3 0 12 Q -3 3 -16 0 Z' }, 2);
          const position = (t: number) => moving(x, y, t, 75 + depth * 130, length * motif + 80);
          animate(trail, t => {
            const p = position(t), len = length * motif, bend = 35 * motif * Math.sin(t * 0.8 + depth * 6);
            return { d: `M ${point(p.x, p.y)} Q ${point(p.x - len * 0.45, p.y - bend)} ${point(p.x - len, p.y + bend)} Q ${point(p.x - len * 0.45, p.y - bend + 8 * motif)} ${point(p.x, p.y)} Z`, opacity: p.fade * 0.6 * clamp(settings.density * 1.6 - i / 20, 0, 1) };
          });
          animate(head, t => { const p = position(t); return { transform: `translate(${point(p.x, p.y)}) scale(${number(motif * (0.4 + depth * 0.6))})`, opacity: p.fade * clamp(settings.density * 1.6 - i / 20, 0, 1) }; });
        }
        break;
      case 'circuit-traces':
        for (let i = 0; i < 18; i++) {
          const offset = random(), turn = random(), pulseRate = 0.045 + random() * 0.035;
          const trace = add('path', { fill: 'none' }, 1, 'stroke');
          const pulse = add('path', { fill: 'none', pathLength: 100, 'stroke-dasharray': '4 96' }, 2, 'stroke');
          const junction = add('path', { fill: 'none' }, i % 4 === 0 ? 2 : 1, 'stroke');
          let route = '', terminal = '', visible = false;
          animate(trace, () => {
            const count = Math.round(clamp(10 * Math.sqrt(frequency), 6, 18));
            const gap = ey * 2 / (count - 3), y = -ey - gap + i * gap;
            const left = -ex - 100, span = ex * 2 + 200;
            const segments = Math.round(clamp(7 * Math.sqrt(frequency), 4, 14)), step = span / segments;
            const jog = Math.min(gap * 0.3, 65 * motif, step * 0.16) * (i % 2 ? -1 : 1);
            const paths = [`M ${point(left, y)}`];
            for (let j = 0; j < segments; j++) {
              const x = left + j * step, bend = x + step * (0.2 + offset * 0.12);
              paths.push(`H ${number(bend)} L ${point(bend + Math.abs(jog), y + jog)} H ${number(x + step * 0.72)} L ${point(x + step * 0.72 + Math.abs(jog), y)} H ${number(x + step)}`);
            }
            route = paths.join(' '); visible = i < count;
            // A short perpendicular branch and plated terminal give the traces
            // an electronic structure, independent of the travelling pulses.
            const bx = left + (1 + Math.floor(turn * (segments - 2))) * step + step * 0.06;
            const by = y - jog * 0.82, r = 5 * motif;
            terminal = `M ${point(bx, y)} V ${number(by)} M ${point(bx + r, by)} A ${number(r)} ${number(r)} 0 1 0 ${point(bx - r, by)} A ${number(r)} ${number(r)} 0 1 0 ${point(bx + r, by)}`;
            return { d: route, 'stroke-width': 1.7 * motif, opacity: visible ? 0.38 : 0 };
          });
          animate(pulse, t => ({ d: route, 'stroke-width': 3.5 * motif,
            'stroke-dashoffset': -unit(t * pulseRate + offset) * 100, opacity: visible ? 0.95 : 0 }));
          animate(junction, t => ({ d: terminal, 'stroke-width': 1.7 * motif,
            opacity: visible ? 0.48 + wave(t * 0.18 + turn) * 0.35 : 0 }));
        }
        break;
      case 'contour-lines': {
        const terrain = random() * Math.PI * 2, bend = random() * Math.PI * 2;
        for (let i = 0; i < 28; i++) {
          const major = i % 5 === 0;
          const contour = add('path', { fill: 'none' }, major ? 2 : 1, 'stroke');
          animate(contour, t => {
            const count = Math.round(clamp(18 * Math.sqrt(frequency), 12, 28));
            const cx = -ex * 0.16 + Math.sin(t * 0.17 + terrain) * 20 * motif;
            const cy = ey * 0.08 + Math.cos(t * 0.13 + bend) * 18 * motif;
            // The outermost terrain outline encloses the outer corners.
            // Fixed ring/segment caps keep extreme aspect ratios bounded.
            const reach = Math.hypot(ex + Math.abs(cx), ey + Math.abs(cy)) * 1.6;
            const r = (i + 0.7 + Math.sin(t * 0.24) * 0.12) * reach / (count - 2);
            const turn = terrain + t * 0.07 + i * 0.022;
            const location = (a: number): [number, number] => {
              const radial = r * (1 + 0.17 * Math.sin(a * 2 + turn) + 0.1 * Math.cos(a * 3 - bend + t * 0.11) + 0.045 * Math.sin(a * 5 + terrain));
              return [cx + Math.cos(a) * radial, cy + Math.sin(a) * radial];
            };
            const segments = 16, step = Math.PI * 2 / segments;
            const points = Array.from({ length: segments }, (_, k) => location(k * step));
            const paths = [`M ${point(...points[0]!)}`];
            for (let k = 0; k < segments; k++) {
              const before = points[(k + segments - 1) % segments]!, from = points[k]!;
              const to = points[(k + 1) % segments]!, after = points[(k + 2) % segments]!;
              paths.push(`C ${point(from[0] + (to[0] - before[0]) / 6, from[1] + (to[1] - before[1]) / 6)} ${point(to[0] - (after[0] - from[0]) / 6, to[1] - (after[1] - from[1]) / 6)} ${point(...to)}`);
            }
            return { d: `${paths.join(' ')} Z`, 'stroke-width': (major ? 3.2 : 1.4) * Math.sqrt(motif),
              opacity: i < count ? (major ? 0.72 : 0.28) + wave(t * 0.1 - i / count) * 0.13 : 0 };
          });
        }
        break;
      }
      case 'energy-trails':
        for (let i = 0; i < 12; i++) {
          const offset = random(), height = 0.65 + random() * 0.35, drift = 0.8 + random() * 0.4;
          const glow = add('path', { fill: 'none' }, 1, 'stroke');
          const core = add('path', { fill: 'none' }, 1, 'stroke');
          const charge = add('path', { fill: 'none', pathLength: 100, 'stroke-dasharray': '7 93' }, 2, 'stroke');
          let route = '', visible = false;
          animate(glow, t => {
            const count = Math.round(clamp(8 * Math.sqrt(frequency), 5, 12));
            const gap = ey * 2 / (count - 3), base = -ey - gap + i * gap;
            const left = -ex - 100, span = ex * 2 + 200, segments = 48;
            const cycles = clamp(span * frequency / 280, 2, 9), amplitude = Math.min(gap * 0.38, 55 * motif) * height;
            const y = (u: number) => {
              const envelope = 0.17 + 0.83 * Math.pow(wave(u - t * 0.075 * drift + offset), 3);
              return base + amplitude * envelope * (Math.sin(u * cycles * Math.PI * 2 - t * 2.4 * drift + offset * 9)
                + 0.23 * Math.sin(u * cycles * Math.PI * 4 + t * 1.3 + offset * 6));
            };
            const slope = (u: number) => (y(u + 0.0001) - y(u - 0.0001)) / 0.0002;
            const paths = [`M ${point(left, y(0))}`], step = 1 / segments;
            for (let k = 0; k < segments; k++) {
              const u = k * step, next = (k + 1) * step;
              paths.push(`C ${point(left + (u + step / 3) * span, y(u) + slope(u) * step / 3)} ${point(left + (next - step / 3) * span, y(next) - slope(next) * step / 3)} ${point(left + next * span, y(next))}`);
            }
            route = paths.join(' '); visible = i < count;
            return { d: route, 'stroke-width': 10 * motif, opacity: visible ? 0.12 : 0 };
          });
          animate(core, () => ({ d: route, 'stroke-width': 1.8 * motif, opacity: visible ? 0.64 : 0 }));
          animate(charge, t => ({ d: route, 'stroke-width': 3 * motif,
            'stroke-dashoffset': -unit(t * 0.075 * drift + offset) * 100, opacity: visible ? 0.96 : 0 }));
        }
        break;
      case 'aurora': {
        // Feather the actual curved edges with nested, very translucent sheets.
        // A tilted bounding-box gradient cannot fade every point on a curve;
        // these 24 layers follow both edges and start below one 8-bit alpha step.
        const atmosphere = add('ellipse', { fill: `url(#${id}-bloom)` }, 0);
        animate(atmosphere, t => ({ cx: Math.sin(t * 0.09) * ex * 0.35, cy: -ey * 0.2,
          rx: ex * 1.7, ry: ey * 1.7, opacity: 0.15 + wave(t * 0.04) * 0.08 }));
        const paints = [0, 1].map(i => gradient('linearGradient',
          { x1: '0%', y1: '0%', x2: '100%', y2: '0%' },
          [[0, 1, 0.18], [0.32, i ? 1 : 2, 0.9], [0.67, i ? 2 : 1, 0.9], [1, 2, 0.18]]));
        for (let i = 0; i < 3; i++) {
          const offset = random() * Math.PI * 2, drift = 0.7 + random() * 0.6;
          for (let layer = 0; layer < 24; layer++) {
            const fraction = layer / 23;
            const feather = 0.0015 + 0.052 * Math.sin(fraction * Math.PI) ** 2;
            const curtain = add('path', { fill: paints[i % 2]!.fill }, 0);
            animate(curtain, t => {
              const left = -ex * 1.35 - 80, right = ex * 1.35 + 80, span = right - left;
              const count = clamp(3 + frequency * 1.15, 3, 7);
              const center = (i - 1) * ey * 0.6 + Math.sin(t * 0.14 * drift + offset) * ey * 0.13;
              const depth = ey * clamp(0.85 * Math.sqrt(motif), 0.55, 1.3);
              const crest = (u: number) => center + ey * (0.24 * Math.sin(u * count + t * 0.19 * drift + offset)
                + 0.11 * Math.sin(u * count * 2.1 - t * 0.11 + offset));
              // Two independently curved edges form a luminous sheet, with a
              // broad upper body and a gently gathering, brighter lower fold.
              const sections = 12, step = 1 / sections;
              const y = (u: number, lower: boolean) => {
                const upper = crest(u) - depth, bottom = crest(u) + depth * (0.58 + 0.11 * Math.sin(u * 5 + offset + t * 0.08));
                const middle = (upper + bottom) / 2, half = (bottom - upper) / 2 * (1 - fraction * 0.88);
                return middle + (lower ? half : -half);
              };
              const route = [`M ${point(left, y(0, false))}`];
              for (const lower of [false, true]) {
                if (lower) route.push(`L ${point(right, y(1, true))}`);
                for (let k = 0; k < sections; k++) {
                  const u = lower ? 1 - k * step : k * step, v = u + (lower ? -step : step);
                  const slope = (at: number) => (y(at + 0.0001, lower) - y(at - 0.0001, lower)) / 0.0002;
                  route.push(`C ${point(left + (u + (v - u) / 3) * span, y(u, lower) + slope(u) * (v - u) / 3)} ${point(left + (v - (v - u) / 3) * span, y(v, lower) - slope(v) * (v - u) / 3)} ${point(left + v * span, y(v, lower))}`);
                }
              }
              return { d: `${route.join(' ')} Z`, opacity: feather * (0.8 + 0.2 * wave(t * 0.045 + i / 3))
                * clamp(settings.density * 1.2 - i / 9, 0.12, 1) };
            });
          }
        }
        break;
      }
      case 'silk-flow': {
        const underlay = add('rect', { fill: `url(#${id}-flow)`, opacity: 0.22 }, 0);
        animate(underlay, () => ({ x: -ex - 80, y: -ey - 80, width: ex * 2 + 160, height: ey * 2 + 160 }));
        const foldPhase = random() * Math.PI * 2;
        for (let i = 0; i < 7; i++) {
          const drift = random() * 0.5;
          const paint = gradient('linearGradient', { x1: '0%', y1: '0%', x2: '100%', y2: '0%' },
            [[0, 0, 1], [0.24, 1, 0.5], [0.51, 1, 0.92], [0.64, 2, 0.95],
              [0.7, 1, 0.86], [0.84, 0, 0.96], [1, 0, 1]]);
          const satin = add('path', { fill: paint.fill }, 0);
          const glint = add('path', { fill: 'none', opacity: 0.25 }, 2, 'stroke');
          let highlight = '', visible = false;
          animate(satin, t => {
            const count = Math.round(clamp(5 + Math.log2(frequency + 0.5), 4, 7));
            const gap = ex * 2 / (count - 3), top = -ey * 1.3 - 80, span = ey * 2.6 + 160;
            const cycles = clamp(2.7 / Math.sqrt(motif), 1.6, 5.3);
            // Adjacent folds share precisely the same moving boundary. The
            // first/last folds overscan, including extremely narrow boxes.
            const boundary = (index: number, v: number) => -ex - gap * 2 + index * gap
              + gap * (0.34 * Math.sin(v * cycles + foldPhase + t * 0.17 + index * 0.58)
                + 0.12 * Math.sin(v * cycles * 2 - t * 0.12 + index * 0.43));
            const crest = 0.61 + Math.sin(t * 0.2 + drift + i * 0.6) * 0.065;
            attributes(paint.stops[2]!, { offset: crest - 0.13 });
            attributes(paint.stops[3]!, { offset: crest });
            attributes(paint.stops[4]!, { offset: crest + 0.06 });
            const x = (v: number, side: number) => boundary(i, v) * (1 - side) + boundary(i + 1, v) * side;
            const curve = (side: number, reverse: boolean) => {
              const route: string[] = [], sections = 10, step = (reverse ? -1 : 1) / sections;
              for (let k = 0; k < sections; k++) {
                const v = (reverse ? 1 : 0) + k * step, next = v + step;
                const slope = (at: number) => (x(at + 0.0001, side) - x(at - 0.0001, side)) / 0.0002;
                route.push(`C ${point(x(v, side) + slope(v) * step / 3, top + (v + step / 3) * span)} ${point(x(next, side) - slope(next) * step / 3, top + (next - step / 3) * span)} ${point(x(next, side), top + next * span)}`);
              }
              return route.join(' ');
            };
            highlight = `M ${point(x(0, crest), top)} ${curve(crest, false)}`;
            visible = i < count;
            return { d: `M ${point(x(0, 0), top)} ${curve(0, false)} L ${point(x(1, 1), top + span)} ${curve(1, true)} Z`, opacity: visible ? 0.93 : 0 };
          });
          animate(glint, t => ({ d: highlight, 'stroke-width': Math.min(ex * 0.008, 2.8 * motif),
            opacity: visible ? 0.1 + wave(t * 0.13 + i / 7) * 0.2 : 0 }));
        }
        break;
      }
      case 'iridescent-field': {
        const underlay = add('rect', { fill: `url(#${id}-flow)`, opacity: 0.28 }, 0);
        animate(underlay, () => ({ x: -ex - 80, y: -ey - 80, width: ex * 2 + 160, height: ey * 2 + 160 }));
        for (let i = 0; i < 7; i++) {
          const offset = random() * Math.PI * 2, turn = random() * 360, drift = 0.7 + random() * 0.5;
          // In local coordinates every carrier segment stays outside radius
          // 0.87*cos(PI/8) > 0.803. Its zero-alpha circle (r=.74) therefore lies
          // strictly inside the whole carrier, independent of shape/focus motion.
          const paint = gradient('radialGradient', { gradientUnits: 'userSpaceOnUse', cx: 0, cy: 0, r: 0.74 },
            [[0, i % 2 ? 1 : 2, 0.9], [0.22, i % 2 ? 2 : 1, 0.82], [0.44, i % 2 ? 1 : 2, 0.63],
              [0.64, 1, 0.32], [0.84, 2, 0.1], [1, 2, 0]]);
          const field = add('path', { fill: paint.fill }, 0);
          animate(field, t => {
            const size = clamp(1.35 * Math.sqrt(motif), 0.75, 2.2);
            const cx = ex * (Math.cos(i * 2.4 + offset) * 0.65 + Math.sin(t * 0.1 * drift + offset) * 0.3);
            const cy = ey * (Math.sin(i * 2.4 + offset) * 0.65 + Math.cos(t * 0.08 * drift + offset) * 0.3);
            const locations = Array.from({ length: 8 }, (_, k): [number, number] => {
              const a = k * Math.PI / 4, reach = 1 + 0.13 * Math.sin(a * 3 + t * 0.09 + offset);
              return [Math.cos(a) * reach, Math.sin(a) * reach];
            });
            const route = [`M ${point(...locations[0]!)}`];
            for (let k = 0; k < 8; k++) {
              const before = locations[(k + 7) % 8]!, from = locations[k]!, to = locations[(k + 1) % 8]!, after = locations[(k + 2) % 8]!;
              route.push(`C ${point(from[0] + (to[0] - before[0]) / 6, from[1] + (to[1] - before[1]) / 6)} ${point(to[0] - (after[0] - from[0]) / 6, to[1] - (after[1] - from[1]) / 6)} ${point(...to)}`);
            }
            attributes(paint.node, { fx: Math.sin(t * 0.13 + offset) * 0.16,
              fy: Math.cos(t * 0.11 + offset) * 0.16 });
            return { d: `${route.join(' ')} Z`, transform: `translate(${point(cx, cy)}) scale(${number(ex * size * 2.15)} ${number(ey * size * 1.72)}) rotate(${number(turn + Math.sin(t * 0.07 + offset) * 18)})`,
              opacity: (0.5 + wave(t * 0.035 + i / 7) * 0.14) * clamp(settings.density * 1.3 - i / 14, 0.16, 1) };
          });
        }
        break;
      }
      case 'confetti':
        for (let i = 0; i < 36; i++) {
          const x = random(), y = random(), spin = random(), size = 0.7 + random() * 0.9;
          const piece = add('path', { d: i % 4 === 0 ? 'M -18 0 L 0 -24 L 18 0 L 0 24 Z' : i % 4 === 1 ? 'M -24 -8 L 20 -8 L 24 8 L -20 8 Z' : i % 4 === 2 ? 'M -18 14 L 0 -20 L 18 14 Z' : 'M -18 -18 H 18 V 18 H -18 Z M -10 -10 V 10 H 10 V -10 Z', 'fill-rule': 'evenodd' }, i % 3 === 0 ? 2 : 1);
          animate(piece, t => {
            const cy = unit(y + t * (32 + spin * 22) / (ey * 2 + 160)) * (ey * 2 + 160) - ey - 80;
            return { transform: `translate(${point(x * ex * 2 - ex + Math.sin(t * 0.7 + spin * 6) * 30, cy)}) rotate(${number(spin * 360 + t * (i % 2 ? 17 : -12))}) scale(${number(motif * size)} ${number(motif * size * (0.55 + wave(t * 0.18 + spin) * 0.45))})`, opacity: edge(cy, ey, 80) * (i % 4 === 0 ? 0.92 : 0.4 + spin * 0.3) * clamp(settings.density * 1.4 - i / 36, 0, 1) };
          });
        }
        break;
    }
    // pattern + backdrop + group + defs + two gradients + six stops = 12.
    if (nodes.length + materialNodeCount + 12 > MAX_ANIMATED_PATTERN_NODES) throw new RangeError('Animated pattern exceeds its SVG node budget.');
  };
  const draw = (timeMs: number) => {
    if (disposed) return;
    lastTime = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
    const t = phase + lastTime / 1000 * settings.speed * (settings.reverse ? -1 : 1);
    for (const update of animations) update(t);
  };
  const update = (next: AnimatedPattern, nextWidth: number, nextHeight: number) => {
    if (disposed) return;
    settings = next;
    logicalWidth = Number.isFinite(nextWidth) && nextWidth > 0 ? nextWidth : 1;
    logicalHeight = Number.isFinite(nextHeight) && nextHeight > 0 ? nextHeight : 1;
    const projection = 600 / Math.min(logicalWidth, logicalHeight); w = logicalWidth * projection; h = logicalHeight * projection;
    const angle = settings.direction * Math.PI / 180, cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
    ex = (w * cos + h * sin) / 2; ey = (w * sin + h * cos) / 2; radius = Math.hypot(w, h) / 2;
    frequency = clamp(Math.sqrt(settings.density) / settings.scale, 0.12, 7);
    motif = clamp(settings.scale / Math.pow(settings.density, 0.24), 0.2, 4);
    attributes(pattern, { width: logicalWidth, height: logicalHeight, viewBox: `0 0 ${number(w)} ${number(h)}`, preserveAspectRatio: 'xMidYMid meet' });
    attributes(background, { x: 0, y: 0, width: w, height: h, fill: settings.colors[0] });
    attributes(group, { transform: `translate(${point(w / 2, h / 2)}) rotate(${number(settings.direction)})`, opacity: settings.intensity });
    const key = `${next.preset}:${next.seed}`;
    if (key !== topology) { topology = key; build(); }
    for (const stop of bloomStops) attributes(stop, { 'stop-color': settings.colors[1] });
    flowStops.forEach((stop, i) => attributes(stop, { 'stop-color': settings.colors[i === 2 ? 2 : 1] }));
    for (const { node, channel, property } of colored) attributes(node, { [property]: settings.colors[channel] });
    for (const { node, channel } of materialColors) attributes(node, { 'stop-color': settings.colors[channel] });
    draw(lastTime);
  };
  update(initial, width, height);
  return { node: pattern, update, draw, dispose() {
    if (disposed) return;
    disposed = true; clearMaterial(); nodes.length = 0; animations.length = 0; colored.length = 0;
  } };
}

/** Versioned providers share the existing paint server and evaluated pattern clock. */
const providers: Readonly<Partial<Record<AnimatedPattern['preset'], PatternProviderFactory>>> = {
  halftone: createHalftoneProvider,
  'energy-trails': createEnergyProvider,
};

export function animatedPatternRenderer(id: string, initial: AnimatedPattern, width: number, height: number): AnimatedPatternRenderer {
  const node = element('pattern', { id, patternUnits: 'userSpaceOnUse', patternContentUnits: 'userSpaceOnUse', x: 0, y: 0 });
  let legacy: AnimatedPatternRenderer | undefined;
  let provider: PatternProvider | undefined;
  let topology = '', disposed = false, lastTime = 0;
  const draw = (timeMs: number): void => {
    if (disposed) return;
    lastTime = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
    (legacy ?? provider)?.draw(lastTime);
  };
  const update = (settings: AnimatedPattern, nextWidth: number, nextHeight: number): void => {
    if (disposed) return;
    const factory = settings.version === 2 ? providers[settings.preset] : undefined;
    const key = factory ? `2:${settings.preset}` : '1';
    if (key !== topology) {
      legacy?.dispose(); provider?.dispose(); legacy = undefined; provider = undefined;
      // The root stays attached to the solid fill. No definition or mask from a
      // previous version survives a transition to another prepared provider.
      for (const child of Array.from(node.children)) child.remove();
      topology = key;
    }
    if (factory && settings.version === 2) {
      const w = Number.isFinite(nextWidth) && nextWidth > 0 ? nextWidth : 1;
      const h = Number.isFinite(nextHeight) && nextHeight > 0 ? nextHeight : 1;
      attributes(node, { width: w, height: h, viewBox: `0 0 ${number(w)} ${number(h)}`, preserveAspectRatio: 'xMidYMid meet' });
      const input: PatternProviderSettings = { colors: settings.colors, speed: settings.speed * (settings.reverse ? -1 : 1),
        direction: settings.direction, seed: settings.seed, parameters: settings.parameters, intensity: settings.intensity };
      if (provider) provider.update(input, w, h);
      else { provider = factory(id, input, w, h); node.append(provider.node); }
      provider.draw(lastTime);
    } else {
      if (legacy) legacy.update(settings, nextWidth, nextHeight);
      else { legacy = legacyAnimatedPatternRenderer(id, settings, nextWidth, nextHeight, node); legacy.draw(lastTime); }
    }
  };
  update(initial, width, height);
  return { node, update, draw, dispose() {
    if (disposed) return;
    disposed = true; legacy?.dispose(); provider?.dispose(); node.remove();
  } };
}
