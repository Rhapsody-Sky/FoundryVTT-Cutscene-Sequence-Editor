import { attributes, clamp, svg, type PatternProviderSettings, type PatternProvider } from './provider.js';

const TAU = Math.PI * 2;
const unit = (value: number): number => ((value % 1) + 1) % 1;
const finiteDimension = (value: number): number => Number.isFinite(value) && value > 0 ? value : 1;
const setting = (settings: PatternProviderSettings, key: string, fallback: number): number => {
  const value = settings.parameters[key];
  return Number.isFinite(value) ? value! : fallback;
};

/**
 * Returns a line that crosses the complete normalized view box. A direction of
 * zero runs from the upper-left to the lower-right, independent of aspect ratio.
 */
function diagonal(width: number, height: number, degrees: number): readonly [number, number, number, number] {
  const angle = (degrees + 45) * Math.PI / 180;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const halfSpan = 0.5 / Math.max(Math.abs(dx), Math.abs(dy));
  return [
    width * (0.5 - dx * halfSpan),
    height * (0.5 - dy * halfSpan),
    width * (0.5 + dx * halfSpan),
    height * (0.5 + dy * halfSpan),
  ];
}

function seedFraction(seed: number, salt: number): number {
  let value = (seed >>> 0) ^ salt;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

export function createHalftoneProvider(id: string, initial: PatternProviderSettings, width: number, height: number): PatternProvider {
  const node = svg('g', { 'shape-rendering': 'geometricPrecision' });
  const defs = svg('defs');
  const dotPatternId = `${id}-dots`;
  const fadeGradientId = `${id}-fade-gradient`;
  const fadeMaskId = `${id}-fade-mask`;
  const sweepGradientId = `${id}-sweep-gradient`;
  const sweepMaskId = `${id}-sweep-mask`;

  // Eight horizontal periods let the wave travel through genuinely different
  // dot sizes. Matching boundary copies keep both the lattice and wave seamless.
  const periods = 8;
  const lattice = [
    ...Array.from({ length: periods + 1 }, (_, column) => [column, 0] as const),
    ...Array.from({ length: periods }, (_, column) => [column + 0.5, 0.5] as const),
    ...Array.from({ length: periods + 1 }, (_, column) => [column, 1] as const),
  ];
  const dotPattern = svg('pattern', {
    id: dotPatternId,
    patternUnits: 'userSpaceOnUse',
    patternContentUnits: 'userSpaceOnUse',
  });
  const dots = lattice.map(() => svg('circle'));
  dotPattern.append(...dots);

  const accentPatternId = `${id}-accent-dots`;
  const accentPattern = svg('pattern', {
    id: accentPatternId,
    patternUnits: 'userSpaceOnUse',
    patternContentUnits: 'userSpaceOnUse',
  });
  const accentDots = lattice.map(() => svg('circle'));
  accentPattern.append(...accentDots);

  const fadeGradient = svg('linearGradient', {
    id: fadeGradientId,
    gradientUnits: 'userSpaceOnUse',
    spreadMethod: 'pad',
  });
  const fadeStops = [0, 0.36, 0.72, 1].map(offset => svg('stop', {
    offset,
    'stop-color': '#FFFFFF',
  }));
  fadeGradient.append(...fadeStops);

  const fadeMask = svg('mask', {
    id: fadeMaskId,
    maskUnits: 'userSpaceOnUse',
    maskContentUnits: 'userSpaceOnUse',
    'mask-type': 'alpha',
  });
  const fadeRect = svg('rect', { fill: `url(#${fadeGradientId})` });
  fadeMask.append(fadeRect);

  const sweepGradient = svg('linearGradient', {
    id: sweepGradientId,
    gradientUnits: 'userSpaceOnUse',
    spreadMethod: 'pad',
  });
  const sweepStops = [0, 0.36, 0.72, 1].map(offset => svg('stop', {
    offset,
    'stop-color': '#FFFFFF',
    'stop-opacity': 0,
  }));
  sweepGradient.append(...sweepStops);

  const sweepMask = svg('mask', {
    id: sweepMaskId,
    maskUnits: 'userSpaceOnUse',
    maskContentUnits: 'userSpaceOnUse',
    'mask-type': 'alpha',
  });
  const sweepRect = svg('rect', { fill: `url(#${sweepGradientId})` });
  sweepMask.append(sweepRect);

  defs.append(dotPattern, accentPattern, fadeGradient, fadeMask, sweepGradient, sweepMask);

  const background = svg('rect');
  const field = svg('g', { mask: `url(#${fadeMaskId})` });
  const mainField = svg('rect', { fill: `url(#${dotPatternId})` });
  const accentField = svg('rect', {
    fill: `url(#${accentPatternId})`,
    mask: `url(#${sweepMaskId})`,
    opacity: 0.7,
  });
  field.append(mainField, accentField);
  node.append(defs, background, field);

  let settings = initial;
  let logicalWidth = finiteDimension(width);
  let logicalHeight = finiteDimension(height);
  let spacing = 1;
  let rowSpacing = Math.sqrt(3);
  let disposed = false;
  let lastTimeMs = 0;
  let seedPhase = 0;
  let radius = 1;
  let waveStrength = 0;
  let waveSpeed = 0;
  let driftSpeed = 0;
  let direction = 0;

  const layout = () => {
    attributes(field, { opacity: settings.intensity });
    const density = clamp(setting(settings, 'density', 56), 0, 100) / 100;
    const diameter = clamp(setting(settings, 'dotSize', 42), 18, 88) / 100;
    const falloff = clamp(setting(settings, 'falloff', 58), 0, 100) / 100;
    waveStrength = clamp(setting(settings, 'waveStrength', 82), 0, 100) / 100;
    waveSpeed = clamp(setting(settings, 'waveSpeed', 0.55), 0, 2);
    driftSpeed = clamp(setting(settings, 'driftSpeed', 0.9), 0, 4);

    // Higher density means smaller repeat spacing and therefore more dots.
    // Spacing follows the short side, so portrait and wide previews retain a
    // similar screen scale while circle geometry remains isotropic.
    const shortSide = Math.min(logicalWidth, logicalHeight);
    spacing = Math.max(4, shortSide * (0.066 - density * 0.036));
    rowSpacing = Math.sqrt(3) * spacing;
    radius = spacing * diameter * 0.5;
    const offsetX = seedFraction(settings.seed, 0x51ed270b) * spacing;
    const offsetY = seedFraction(settings.seed, 0x2c1b3c6d) * rowSpacing;

    attributes(dotPattern, {
      x: -offsetX,
      y: -offsetY,
      width: spacing * periods,
      height: rowSpacing,
    });
    attributes(accentPattern, {
      x: -offsetX,
      y: -offsetY,
      width: spacing * periods,
      height: rowSpacing,
    });
    dots.forEach((dot, index) => attributes(dot, {
      cx: lattice[index]![0] * spacing,
      cy: lattice[index]![1] * rowSpacing,
      r: radius,
      fill: settings.colors[1],
    }));
    accentDots.forEach((dot, index) => attributes(dot, {
      cx: lattice[index]![0] * spacing,
      cy: lattice[index]![1] * rowSpacing,
      r: radius,
      fill: settings.colors[2],
    }));

    direction = Number.isFinite(settings.direction) ? settings.direction % 360 : 0;
    const line = diagonal(logicalWidth, logicalHeight, direction);
    for (const gradient of [fadeGradient, sweepGradient]) {
      attributes(gradient, { x1: line[0], y1: line[1], x2: line[2], y2: line[3] });
    }
    for (const mask of [fadeMask, sweepMask]) {
      attributes(mask, { x: 0, y: 0, width: logicalWidth, height: logicalHeight });
    }

    const stops = [1, 1 - 0.14 * falloff, 1 - 0.62 * falloff, 1 - 0.82 * falloff];
    fadeStops.forEach((stop, index) => attributes(stop, { 'stop-opacity': stops[index]! }));
    // This static color wash preserves all three palette colors. Animation
    // comes from circle geometry and lattice movement, never an opacity pulse.
    sweepStops.forEach((stop, index) => attributes(stop, {
      'stop-opacity': [0, 0.08, 0.62, 1][index]!,
    }));

    attributes(background, {
      x: 0, y: 0, width: logicalWidth, height: logicalHeight,
      fill: settings.colors[0],
    });
    for (const rect of [fadeRect, sweepRect, mainField, accentField]) {
      attributes(rect, { x: 0, y: 0, width: logicalWidth, height: logicalHeight });
    }
    seedPhase = seedFraction(settings.seed, 0x6a09e667) * TAU;
  };

  const draw = (timeMs: number) => {
    if (disposed) return;
    lastTimeMs = Number.isFinite(timeMs) ? timeMs : 0;
    const speed = Number.isFinite(settings.speed) ? settings.speed : 0;
    const seconds = lastTimeMs / 1000 * speed;
    const phase = unit(seconds * waveSpeed) * TAU;
    const amount = waveSpeed === 0 ? 0 : waveStrength;
    lattice.forEach(([column], index) => {
      // Reduce the repeated boundary column explicitly, ensuring identical
      // radii at x=0 and x=tileWidth even at extreme absolute timestamps.
      const wave = Math.sin((column % periods) / periods * TAU - phase + seedPhase);
      const animatedRadius = Math.min(spacing * 0.48, radius * (1 + 0.85 * amount * wave));
      attributes(dots[index]!, { r: animatedRadius });
      attributes(accentDots[index]!, { r: animatedRadius });
    });
    const drift = unit(seconds * driftSpeed / periods) * spacing * periods;
    const transform = `rotate(${direction} ${logicalWidth / 2} ${logicalHeight / 2}) translate(${drift} 0)`;
    attributes(dotPattern, { patternTransform: transform });
    attributes(accentPattern, { patternTransform: transform });
  };

  const update = (next: PatternProviderSettings, nextWidth: number, nextHeight: number) => {
    if (disposed) return;
    settings = next;
    logicalWidth = finiteDimension(nextWidth);
    logicalHeight = finiteDimension(nextHeight);
    layout();
    draw(lastTimeMs);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    node.remove();
  };

  update(initial, width, height);
  return { node, update, draw, dispose };
}
