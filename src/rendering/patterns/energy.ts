import { attributes, clamp, n, svg, type PatternProviderSettings, type PatternProvider } from './provider.js';

const TAU = Math.PI * 2;
const unit = (v: number): number => v - Math.floor(v);
const finite = (v: number, fallback: number): number => Number.isFinite(v) ? v : fallback;

/** Original approved tapered slipstreams, evaluated from absolute supplied time. */
export function createEnergyProvider(id: string, initial: PatternProviderSettings, initialWidth: number, initialHeight: number): PatternProvider {
  const node = svg('g');
  const defs = svg('defs');
  const stage = svg('g');
  const background = svg('rect');
  node.append(defs, stage);
  stage.append(background);
  // Shared paints keep the retained SVG small even at the ten-strand maximum.
  const paints = [0, 1, 2].map(index => {
    const gradient = svg('linearGradient', { id: `${id}-energy-${index}`, x1: '0%', y1: '0%', x2: '100%', y2: '0%' });
    const stops = [0, 0.25, 0.6, 0.86, 1].map(offset => svg('stop', { offset }));
    gradient.append(...stops);
    defs.append(gradient);
    return { gradient, stops };
  });
  const strands = Array.from({ length: 10 }, (_, i) => {
    const group = svg('g');
    const wake = svg('path', { fill: `url(#${id}-energy-0)` });
    const body = svg('path', { fill: `url(#${id}-energy-1)` });
    const spine = svg('path', { fill: 'none', 'stroke-linecap': 'round', pathLength: 1 });
    const charge = svg('path', { fill: `url(#${id}-energy-2)` });
    group.append(wake, body, spine, charge);
    stage.append(group);
    return { group, wake, body, spine, charge, i };
  });
  let settings = initial, width = 1, height = 1, ex = 1, ey = 1, lastTime = 0, disposed = false;

  const draw = (timeMs: number): void => {
    if (disposed) return;
    lastTime = finite(timeMs, 0);
    const t = lastTime / 1000 * finite(settings.speed, 1);
    const count = Math.round(clamp(finite(settings.parameters.strandCount ?? 6, 6), 3, 10));
    const thickness = clamp(finite(settings.parameters.thickness ?? 1, 1), 0.35, 2);
    const bend = clamp(finite(settings.parameters.curvature ?? 1.05, 1.05), 0, 1.8);
    const pulse = clamp(finite(settings.parameters.pulseLength ?? 0.27, 0.27), 0.08, 0.5);
    const seed = unit(finite(settings.seed, 0) * 0.0000131) * TAU;
    const span = ex * 2 + 280;
    const left = -span / 2;
    const gap = ey * 2 / (count - 1);
    for (const strand of strands) {
      const { i, group, wake, body, spine, charge } = strand;
      attributes(group, { opacity: settings.intensity });
      if (i >= count) { group.setAttribute('display', 'none'); continue; }
      group.removeAttribute('display');
      const phase = seed + i * 2.39996;
      const major = i % 3 === 1;
      const lane = -ey + gap * i;
      const size = Math.min(gap * 0.19, 22) * thickness * (major ? 1.55 : 0.66 + unit(i * 0.319) * 0.4);
      const depth = Math.min(ey * 0.2, gap * 0.82) * bend;
      // Two broad, unequally weighted bends give each stream its own sweeping
      // silhouette. The shared broad drift reads as wind, not oscillating wire.
      const route = (u: number): number => lane + depth * (
        0.9 * Math.sin(u * 4.2 + phase + t * 0.32)
        + 0.36 * Math.sin(u * 7.3 - phase * 0.7 - t * 0.19))
        + Math.sin(t * 0.23 + phase) * gap * 0.09;
      const widthAt = (u: number): number => size * (0.16 + 0.84 * Math.pow(Math.sin(Math.PI * clamp(u, 0, 1)), 1.3))
        * (0.76 + 0.24 * Math.sin(u * 5 + phase + t * 0.7));
      const ribbon = (start: number, end: number, scale: number, tapered: boolean): string => {
        const parts: string[] = [];
        const segments = 20;
        for (let side = 0; side < 2; side++) {
          for (let k = 0; k <= segments; k++) {
            const f = (side ? segments - k : k) / segments;
            const u = start + (end - start) * f;
            const edge = tapered ? Math.pow(Math.sin(Math.PI * f), 0.8) * (0.24 + f * 0.76) : 1;
            const half = widthAt(u) * scale * edge;
            parts.push(`${side === 0 && k === 0 ? 'M' : 'L'}${n(left + span * u)} ${n(route(u) + (side ? 1 : -1) * half)}`);
          }
        }
        return `${parts.join(' ')} Z`;
      };
      attributes(wake, { d: ribbon(0, 1, 2.15, false), opacity: major ? 0.14 : 0.065 });
      attributes(body, { d: ribbon(0, 1, 1, false), opacity: major ? 0.65 : 0.32 });
      const line: string[] = [];
      for (let k = 0; k <= 24; k++) {
        const u = k / 24;
        line.push(`${k ? 'L' : 'M'}${n(left + span * u)} ${n(route(u) - widthAt(u) * 0.61)}`);
      }
      attributes(spine, { d: line.join(' '), stroke: settings.colors[2], 'stroke-width': major ? 1.25 : 0.65,
        opacity: major ? 0.52 : 0.22, 'stroke-dasharray': `${n(0.22 + unit(i * 0.37) * 0.26)} 0.18 0.05 0.55`,
        'stroke-dashoffset': n(-t * 0.023 * (1 + i * 0.02)) });
      // The head wraps only beyond the projected viewport; no on-screen pop.
      const head = unit(t * (0.115 + unit(i * 0.731) * 0.045) + unit(i * 0.618 + seed)) * (1 + pulse) - pulse;
      attributes(charge, { d: ribbon(head, head + pulse, 0.54, true), opacity: major ? 1 : 0.77 });
    }
  };
  const update = (next: PatternProviderSettings, nextWidth: number, nextHeight: number): void => {
    if (disposed) return;
    settings = next;
    width = Math.max(1, finite(nextWidth, 1)); height = Math.max(1, finite(nextHeight, 1));
    const scale = 600 / Math.min(width, height);
    const w = width * scale, h = height * scale;
    const direction = finite(settings.direction, 0), angle = direction * Math.PI / 180;
    ex = (w * Math.abs(Math.cos(angle)) + h * Math.abs(Math.sin(angle))) / 2;
    ey = (w * Math.abs(Math.sin(angle)) + h * Math.abs(Math.cos(angle))) / 2;
    attributes(node, { transform: `scale(${n(1 / scale)})` });
    attributes(stage, { transform: `translate(${n(w / 2)} ${n(h / 2)}) rotate(${n(direction)})` });
    attributes(background, { x: -ex - 3, y: -ey - 3, width: ex * 2 + 6, height: ey * 2 + 6, fill: settings.colors[0] });
    for (const [index, paint] of paints.entries()) {
      paint.stops.forEach((stop, j) => attributes(stop, {
        'stop-color': index === 2 && j >= 3 ? '#ffffff' : settings.colors[j < 2 ? 1 : 2],
        'stop-opacity': index === 2 ? [0, 0.35, 0.85, 1, 0.55][j]! : [0.05, 0.65, 0.9, 0.6, 0.06][j]!,
      }));
    }
    draw(lastTime);
  };
  update(initial, initialWidth, initialHeight);
  return { node, draw, update, dispose: () => { disposed = true; node.remove(); } };
}
