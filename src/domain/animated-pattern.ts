import type { ImagePoint } from './sequence.js';

export const MAX_POLYGON_POINTS = 32 as const;

export const ANIMATED_PATTERN_PRESET_IDS = [
  'diagonal-flow',
  'speed-lines',
  'radial-burst',
  'halftone',
  'floating-dots',
  'starfield',
  'neon-grid',
  'hex-pulse',
  'orbit-rings',
  'rotating-shards',
  'chevron-stream',
  'diamond-drift',
  'glitch-bands',
  'wave-ribbons',
  'spark-trails',
  'confetti',
  'circuit-traces',
  'contour-lines',
  'energy-trails',
  'aurora',
  'silk-flow',
  'iridescent-field',
] as const;

export type AnimatedPatternPresetId = typeof ANIMATED_PATTERN_PRESET_IDS[number];

interface AnimatedPatternCommon {
  readonly preset: AnimatedPatternPresetId;
  /** Base, main, and accent colors in #RRGGBB form. */
  readonly colors: readonly [string, string, string];
  readonly speed: number;
  readonly scale: number;
  readonly density: number;
  readonly direction: number;
  readonly intensity: number;
  readonly reverse: boolean;
  readonly seed: number;
  readonly onBreak: 'loop' | 'pause';
}

/** Saved patterns authored before custom per-pattern controls were introduced. */
export interface AnimatedPatternV1 extends AnimatedPatternCommon {
  readonly version: 1;
}

export const ANIMATED_PATTERN_PARAMETER_DESCRIPTORS = Object.freeze({
  halftone: Object.freeze([
    { key: 'density', label: 'STAGECRAFT.AnimatedSurface.Parameter.density', defaultValue: 56, min: 0, max: 100, step: 1 },
    { key: 'dotSize', label: 'STAGECRAFT.AnimatedSurface.Parameter.dotSize', defaultValue: 42, min: 18, max: 88, step: 1 },
    { key: 'falloff', label: 'STAGECRAFT.AnimatedSurface.Parameter.falloff', defaultValue: 58, min: 0, max: 100, step: 1 },
    { key: 'waveStrength', label: 'STAGECRAFT.AnimatedSurface.Parameter.waveStrength', defaultValue: 82, min: 0, max: 100, step: 1 },
    { key: 'waveSpeed', label: 'STAGECRAFT.AnimatedSurface.Parameter.waveSpeed', defaultValue: 0.55, min: 0, max: 2, step: 0.05 },
    { key: 'driftSpeed', label: 'STAGECRAFT.AnimatedSurface.Parameter.driftSpeed', defaultValue: 0.9, min: 0, max: 4, step: 0.1 },
  ]),
  'energy-trails': Object.freeze([
    { key: 'strandCount', label: 'STAGECRAFT.AnimatedSurface.Parameter.strandCount', defaultValue: 6, min: 3, max: 10, step: 1, integer: true },
    { key: 'thickness', label: 'STAGECRAFT.AnimatedSurface.Parameter.thickness', defaultValue: 1, min: 0.35, max: 2, step: 0.05 },
    { key: 'curvature', label: 'STAGECRAFT.AnimatedSurface.Parameter.curvature', defaultValue: 1.05, min: 0, max: 1.8, step: 0.05 },
    { key: 'pulseLength', label: 'STAGECRAFT.AnimatedSurface.Parameter.pulseLength', defaultValue: 0.27, min: 0.08, max: 0.5, step: 0.01 },
  ]),
} as const);

export type AnimatedPatternWithParametersPresetId = keyof typeof ANIMATED_PATTERN_PARAMETER_DESCRIPTORS;
export type HalftoneParameterKey = typeof ANIMATED_PATTERN_PARAMETER_DESCRIPTORS.halftone[number]['key'];
export type EnergyTrailsParameterKey = typeof ANIMATED_PATTERN_PARAMETER_DESCRIPTORS['energy-trails'][number]['key'];
export type AnimatedPatternParameterKey = HalftoneParameterKey | EnergyTrailsParameterKey;
export type HalftonePatternParameters = Readonly<Record<HalftoneParameterKey, number> & Record<string, number>>;
export type EnergyTrailsPatternParameters = Readonly<Record<EnergyTrailsParameterKey, number> & Record<string, number>>;

export interface AnimatedPatternParameterDescriptor {
  readonly key: AnimatedPatternParameterKey;
  /** Localization key for this control label. */
  readonly label: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly integer?: boolean;
}

export interface AnimatedPatternSetting extends AnimatedPatternParameterDescriptor {
  readonly value: number;
}

export interface HalftoneAnimatedPatternV2 extends AnimatedPatternCommon {
  readonly version: 2;
  readonly preset: 'halftone';
  readonly parameters: HalftonePatternParameters;
}

export interface EnergyTrailsAnimatedPatternV2 extends AnimatedPatternCommon {
  readonly version: 2;
  readonly preset: 'energy-trails';
  readonly parameters: EnergyTrailsPatternParameters;
}

export type AnimatedPatternV2 = HalftoneAnimatedPatternV2 | EnergyTrailsAnimatedPatternV2;
export type AnimatedPattern = AnimatedPatternV1 | AnimatedPatternV2;

export interface AnimatedPatternPresetDescriptor {
  readonly id: AnimatedPatternPresetId;
  /** Localization key; the suffix is the stable preset ID. */
  readonly label: string;
  readonly colors: readonly [string, string, string];
}

export const ANIMATED_PATTERN_PRESETS: readonly AnimatedPatternPresetDescriptor[] = Object.freeze([
  { id: 'diagonal-flow', label: 'STAGECRAFT.AnimatedSurface.Pattern.DiagonalFlow', colors: ['#10182B', '#54D6FF', '#FFB84D'] },
  { id: 'speed-lines', label: 'STAGECRAFT.AnimatedSurface.Pattern.SpeedLines', colors: ['#17121E', '#FF5E7E', '#FFD166'] },
  { id: 'radial-burst', label: 'STAGECRAFT.AnimatedSurface.Pattern.RadialBurst', colors: ['#1B1033', '#B46CFF', '#FFDB70'] },
  { id: 'halftone', label: 'STAGECRAFT.AnimatedSurface.Pattern.Halftone', colors: ['#20202A', '#FF7892', '#70E1CE'] },
  { id: 'floating-dots', label: 'STAGECRAFT.AnimatedSurface.Pattern.FloatingDots', colors: ['#0D2026', '#4FE0C1', '#F6C85F'] },
  { id: 'starfield', label: 'STAGECRAFT.AnimatedSurface.Pattern.Starfield', colors: ['#090E24', '#8EB7FF', '#FFE8A3'] },
  { id: 'neon-grid', label: 'STAGECRAFT.AnimatedSurface.Pattern.NeonGrid', colors: ['#100C27', '#F15BFF', '#63F5D1'] },
  { id: 'hex-pulse', label: 'STAGECRAFT.AnimatedSurface.Pattern.HexPulse', colors: ['#10211D', '#65E572', '#C4FF76'] },
  { id: 'orbit-rings', label: 'STAGECRAFT.AnimatedSurface.Pattern.OrbitRings', colors: ['#111B32', '#61C7FF', '#FF7F9C'] },
  { id: 'rotating-shards', label: 'STAGECRAFT.AnimatedSurface.Pattern.RotatingShards', colors: ['#271323', '#FF5874', '#FFB45C'] },
  { id: 'chevron-stream', label: 'STAGECRAFT.AnimatedSurface.Pattern.ChevronStream', colors: ['#161D2C', '#55B8FF', '#A8F07A'] },
  { id: 'diamond-drift', label: 'STAGECRAFT.AnimatedSurface.Pattern.DiamondDrift', colors: ['#20172B', '#C58CFF', '#73E6D2'] },
  { id: 'glitch-bands', label: 'STAGECRAFT.AnimatedSurface.Pattern.GlitchBands', colors: ['#10151D', '#FF526F', '#46E7E1'] },
  { id: 'wave-ribbons', label: 'STAGECRAFT.AnimatedSurface.Pattern.WaveRibbons', colors: ['#0E2034', '#3EC7E8', '#FF8C69'] },
  { id: 'spark-trails', label: 'STAGECRAFT.AnimatedSurface.Pattern.SparkTrails', colors: ['#1A1426', '#FFB84D', '#FF668A'] },
  { id: 'confetti', label: 'STAGECRAFT.AnimatedSurface.Pattern.Confetti', colors: ['#171A2D', '#FF6B8A', '#5DE0C5'] },
  { id: 'circuit-traces', label: 'STAGECRAFT.AnimatedSurface.Pattern.CircuitTraces', colors: ['#071B27', '#35E4D2', '#B6FF62'] },
  { id: 'contour-lines', label: 'STAGECRAFT.AnimatedSurface.Pattern.ContourLines', colors: ['#14231F', '#91C7A1', '#E6D28B'] },
  { id: 'energy-trails', label: 'STAGECRAFT.AnimatedSurface.Pattern.EnergyTrails', colors: ['#1A0E24', '#FF4FB4', '#6CE8FF'] },
  { id: 'aurora', label: 'STAGECRAFT.AnimatedSurface.Pattern.Aurora', colors: ['#071A24', '#55EFC4', '#A879FF'] },
  { id: 'silk-flow', label: 'STAGECRAFT.AnimatedSurface.Pattern.SilkFlow', colors: ['#171328', '#A17DDE', '#F2D9FF'] },
  { id: 'iridescent-field', label: 'STAGECRAFT.AnimatedSurface.Pattern.IridescentField', colors: ['#101B32', '#59D8DD', '#F49BCD'] },
]);

export function animatedPatternPreset(id: string | undefined): AnimatedPatternPresetDescriptor | undefined {
  return id === undefined ? undefined : ANIMATED_PATTERN_PRESETS.find(preset => preset.id === id);
}

export function getAnimatedPatternParameterDescriptors(
  preset: string,
): readonly AnimatedPatternParameterDescriptor[] {
  return Object.hasOwn(ANIMATED_PATTERN_PARAMETER_DESCRIPTORS, preset)
    ? ANIMATED_PATTERN_PARAMETER_DESCRIPTORS[preset as AnimatedPatternWithParametersPresetId]
    : [];
}

/** Builds a new mutable bag from the same descriptor metadata used by the UI and validator. */
export function getAnimatedPatternParameterDefaults(preset: string): Record<string, number> {
  return Object.fromEntries(getAnimatedPatternParameterDescriptors(preset).map(({ key, defaultValue }) => [key, defaultValue]));
}

/** Version-aware controls: legacy v1 patterns keep their original common settings only. */
export function getAnimatedPatternSettings(pattern: AnimatedPattern): readonly AnimatedPatternSetting[] {
  if (pattern.version !== 2) return [];
  return getAnimatedPatternParameterDescriptors(pattern.preset).map(descriptor => ({
    ...descriptor,
    value: (pattern.parameters as Readonly<Record<string, number>>)[descriptor.key]!,
  }));
}

/** Convenient alias for UI code that paints metadata-driven custom controls. */
export const animatedPatternControls = getAnimatedPatternSettings;

export function updateAnimatedPatternParameter(
  pattern: AnimatedPattern,
  key: string,
  value: number,
): AnimatedPattern {
  if (pattern.version !== 2) throw new RangeError('Legacy animated patterns do not have custom parameters.');
  const descriptor = getAnimatedPatternParameterDescriptors(pattern.preset).find(control => control.key === key);
  if (!descriptor) throw new RangeError(`Unknown ${pattern.preset} parameter: ${key}`);
  if (!Number.isFinite(value) || value < descriptor.min || value > descriptor.max
    || (descriptor.integer === true && !Number.isSafeInteger(value))) {
    throw new RangeError(`${descriptor.key} must be a finite number between ${descriptor.min} and ${descriptor.max}${descriptor.integer ? ' with no fraction' : ''}.`);
  }
  return { ...pattern, parameters: { ...pattern.parameters, [descriptor.key]: value } } as AnimatedPattern;
}

export function createAnimatedPattern(preset: 'halftone'): HalftoneAnimatedPatternV2;
export function createAnimatedPattern(preset: 'energy-trails'): EnergyTrailsAnimatedPatternV2;
export function createAnimatedPattern(preset: AnimatedPatternWithParametersPresetId): AnimatedPatternV2;
export function createAnimatedPattern(preset?: Exclude<AnimatedPatternPresetId, AnimatedPatternWithParametersPresetId>): AnimatedPatternV1;
export function createAnimatedPattern(preset?: AnimatedPatternPresetId): AnimatedPattern;
export function createAnimatedPattern(preset: AnimatedPatternPresetId): AnimatedPattern;
export function createAnimatedPattern(preset: AnimatedPatternPresetId = 'diagonal-flow'): AnimatedPattern {
  const descriptor = animatedPatternPreset(preset);
  if (!descriptor) throw new RangeError(`Unknown animated pattern preset: ${String(preset)}`);
  const customParameters = getAnimatedPatternParameterDefaults(preset);
  if (preset === 'halftone') {
    return {
      version: 2,
      preset,
      colors: [...descriptor.colors],
      speed: 1,
      scale: 1,
      density: 1,
      direction: 0,
      intensity: 1,
      reverse: false,
      seed: 0x5eed2026,
      onBreak: 'loop',
      parameters: customParameters as unknown as HalftonePatternParameters,
    };
  }
  if (preset === 'energy-trails') {
    return {
      version: 2,
      preset,
      colors: [...descriptor.colors],
      speed: 1,
      scale: 1,
      density: 1,
      direction: 0,
      intensity: 1,
      reverse: false,
      seed: 0x5eed2026,
      onBreak: 'loop',
      parameters: customParameters as unknown as EnergyTrailsPatternParameters,
    };
  }
  return {
    version: 1,
    preset: descriptor.id,
    colors: [...descriptor.colors],
    speed: 1,
    scale: 1,
    density: 1,
    direction: 0,
    intensity: 0.75,
    reverse: false,
    seed: 0x5eed2026,
    onBreak: 'loop',
  };
}

/** A preset-picker choice is an explicit authorship action and can upgrade v1 custom presets. */
export function selectAnimatedPatternPreset(pattern: AnimatedPattern, preset: string): AnimatedPattern {
  const descriptor = animatedPatternPreset(preset);
  if (!descriptor) return pattern;

  const customParameters = getAnimatedPatternParameterDefaults(descriptor.id);
  if (descriptor.id === 'halftone' || descriptor.id === 'energy-trails') {
    if (pattern.version === 2 && pattern.preset === descriptor.id) return pattern;
    const next = {
      ...pattern,
      version: 2 as const,
      preset: descriptor.id,
      // Preserve the authored palette and common timing/settings while starting
      // this newly selected pattern with its own prototype-defined controls.
      parameters: customParameters,
    };
    return next as AnimatedPattern;
  }

  if (pattern.version === 1) return { ...pattern, preset: descriptor.id };
  const { parameters: _parameters, ...common } = pattern;
  return { ...common, version: 1, preset: descriptor.id } as AnimatedPatternV1;
}

export interface PolygonPresetDescriptor {
  readonly id: PolygonPresetId;
  /** Localization key; the suffix is the stable preset ID. */
  readonly label: string;
  readonly points: readonly ImagePoint[];
}

export const POLYGON_PRESET_IDS = [
  'rectangle', 'slanted-panel', 'triangle', 'diamond', 'hexagon', 'star',
] as const;

export type PolygonPresetId = typeof POLYGON_PRESET_IDS[number];

export const POLYGON_PRESETS: readonly PolygonPresetDescriptor[] = Object.freeze([
  { id: 'rectangle', label: 'STAGECRAFT.AnimatedSurface.Polygon.Rectangle', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
  { id: 'slanted-panel', label: 'STAGECRAFT.AnimatedSurface.Polygon.SlantedPanel', points: [{ x: 0.18, y: 0 }, { x: 1, y: 0 }, { x: 0.82, y: 1 }, { x: 0, y: 1 }] },
  { id: 'triangle', label: 'STAGECRAFT.AnimatedSurface.Polygon.Triangle', points: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] },
  { id: 'diamond', label: 'STAGECRAFT.AnimatedSurface.Polygon.Diamond', points: [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }] },
  { id: 'hexagon', label: 'STAGECRAFT.AnimatedSurface.Polygon.Hexagon', points: [
    { x: 0.25, y: 0 }, { x: 0.75, y: 0 }, { x: 1, y: 0.5 }, { x: 0.75, y: 1 }, { x: 0.25, y: 1 }, { x: 0, y: 0.5 },
  ] },
  { id: 'star', label: 'STAGECRAFT.AnimatedSurface.Polygon.Star', points: [
    { x: 0.5, y: 0 }, { x: 0.62, y: 0.36 }, { x: 1, y: 0.36 }, { x: 0.69, y: 0.59 }, { x: 0.81, y: 1 },
    { x: 0.5, y: 0.75 }, { x: 0.19, y: 1 }, { x: 0.31, y: 0.59 }, { x: 0, y: 0.36 }, { x: 0.38, y: 0.36 },
  ] },
]);
