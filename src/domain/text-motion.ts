import { evaluateEasing } from './transitions.js';
import type { TransitionEasing } from './sequence.js';

export type TextMotionPhase = 'entrance' | 'exit';
export type TextMotionUnit = 'character' | 'word' | 'line';
export type TextMotionDirection = 'default' | 'up' | 'down' | 'left' | 'right';
export type TextMotionOrder = 'default' | 'forward' | 'reverse' | 'center-out' | 'edges-in' | 'random';

export interface TextMotionControls {
  readonly directions: boolean;
  readonly order: boolean;
}

const PRESET_DEFINITIONS = [
  { id: 'line-reveal', phase: 'entrance', unit: 'line', durationMs: 720, label: 'Line Reveal' },
  { id: 'word-ghost', phase: 'entrance', unit: 'word', durationMs: 780, label: 'Ghost Words' },
  { id: 'kinetic-lines', phase: 'entrance', unit: 'line', durationMs: 680, label: 'Kinetic Lines' },
  { id: 'character-fade-up', phase: 'entrance', unit: 'character', durationMs: 620, label: 'Character Fade Up' },
  { id: 'word-fade-up', phase: 'entrance', unit: 'word', durationMs: 640, label: 'Word Fade Up' },
  { id: 'character-slide-down', phase: 'entrance', unit: 'character', durationMs: 620, label: 'Character Slide Down' },
  { id: 'alternating-lines', phase: 'entrance', unit: 'line', durationMs: 700, label: 'Alternating Lines' },
  { id: 'stretch-rise', phase: 'entrance', unit: 'character', durationMs: 760, label: 'Stretch Rise' },
  { id: 'vertical-unfold', phase: 'entrance', unit: 'character', durationMs: 620, label: 'Vertical Unfold' },
  { id: 'converge-spread', phase: 'entrance', unit: 'character', durationMs: 760, label: 'Converge and Spread' },
  { id: 'center-out', phase: 'entrance', unit: 'character', durationMs: 680, label: 'Center Out' },
  { id: 'scatter-assemble', phase: 'entrance', unit: 'character', durationMs: 820, label: 'Scatter Assembly' },
  { id: 'tilt-scale', phase: 'entrance', unit: 'character', durationMs: 680, label: 'Tilt and Scale' },
  { id: 'smear-in', phase: 'entrance', unit: 'character', durationMs: 640, label: 'Smear In' },
  { id: 'elastic-pop', phase: 'entrance', unit: 'character', durationMs: 700, label: 'Elastic Pop' },
  { id: 'soft-wave', phase: 'entrance', unit: 'character', durationMs: 880, label: 'Soft Wave' },
  { id: 'random-fade', phase: 'entrance', unit: 'character', durationMs: 740, label: 'Random Fade' },
  { id: 'tracking-expand', phase: 'entrance', unit: 'character', durationMs: 700, label: 'Tracking Expand' },
  { id: 'emoji-pop', phase: 'entrance', unit: 'character', durationMs: 700, label: 'Emoji Pop' },
  { id: 'character-exit-up', phase: 'exit', unit: 'character', durationMs: 560, label: 'Character Exit Up' },
  { id: 'fade-down-out', phase: 'exit', unit: 'character', durationMs: 600, label: 'Fade Down Out' },
  { id: 'blur-out', phase: 'exit', unit: 'word', durationMs: 640, label: 'Blur Out' },
  { id: 'scatter-out', phase: 'exit', unit: 'character', durationMs: 680, label: 'Scatter Out' },
  { id: 'gravity-out', phase: 'exit', unit: 'character', durationMs: 760, label: 'Gravity Out' },
  { id: 'scale-down-out', phase: 'exit', unit: 'character', durationMs: 520, label: 'Scale Down Out' },
  { id: 'reverse-erase', phase: 'exit', unit: 'character', durationMs: 600, label: 'Reverse Erase' },
  { id: 'collapse-center', phase: 'exit', unit: 'character', durationMs: 700, label: 'Collapse to Center' },
  { id: 'noise-dissolve', phase: 'exit', unit: 'character', durationMs: 720, label: 'Noise Dissolve' }
] as const satisfies readonly {
  readonly id: string;
  readonly phase: TextMotionPhase;
  readonly unit: TextMotionUnit;
  readonly durationMs: number;
  readonly label: string;
}[];

/** Preset recommendations for the editor; motion timing is normalized to the chosen interval. */
export const TEXT_MOTION_PRESETS = Object.freeze(PRESET_DEFINITIONS.map(preset => Object.freeze(preset)));

export type TextMotionId = typeof TEXT_MOTION_PRESETS[number]['id'];
export type TextMotionPreset = typeof TEXT_MOTION_PRESETS[number];

export interface TextMotionPose {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotate: number;
  readonly opacity: number;
  readonly blur: number;
  /** Fraction clipped from the bottom edge: zero is clear and one is fully clipped. */
  readonly clipInset?: number;
  /** Edge used by a direction-specific clip. Omitted for existing/default poses. */
  readonly clipEdge?: Exclude<TextMotionDirection, 'default'>;
  /** Fraction of the glyph surface eroded: zero is intact and one is gone. */
  readonly noise?: number;
}

const DIRECTIONAL_HIDDEN_EDGES: Partial<Record<TextMotionId, Exclude<TextMotionDirection, 'default'>>> = {
  'line-reveal': 'down',
  'word-ghost': 'left',
  'kinetic-lines': 'down',
  'character-fade-up': 'down',
  'word-fade-up': 'down',
  'character-slide-down': 'up',
  'alternating-lines': 'left',
  'stretch-rise': 'down',
  'vertical-unfold': 'down',
  'smear-in': 'left',
  'soft-wave': 'down',
  'character-exit-up': 'up',
  'fade-down-out': 'down',
  'blur-out': 'up',
  'gravity-out': 'down',
  'reverse-erase': 'up'
};

const DIRECTION_INDEX: Record<Exclude<TextMotionDirection, 'default'>, number> = {
  up: 0,
  right: 1,
  down: 2,
  left: 3
};
const DIRECTIONS_BY_INDEX: readonly Exclude<TextMotionDirection, 'default'>[] = ['up', 'right', 'down', 'left'];

const IDENTITY: TextMotionPose = Object.freeze({
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1, blur: 0
});

export function textMotionPreset(id: string): TextMotionPreset | undefined {
  return TEXT_MOTION_PRESETS.find(preset => preset.id === id);
}

/** Without context, reports supported fields for validation and preset catalogues.
 * With layout context, only exposes controls that can affect this title. */
export function textMotionControls(id: string, context?: {
  readonly segmentCount: number;
  readonly amount?: number;
  readonly stagger?: number;
}): TextMotionControls {
  const preset = textMotionPreset(id);
  return {
    directions: preset !== undefined && DIRECTIONAL_HIDDEN_EDGES[preset.id] !== undefined
      && (!context || context.segmentCount > 0 && (context.amount ?? 1) > 0),
    order: preset !== undefined && (!context || context.segmentCount > 1 && (context.stagger ?? 0.35) > 0)
  };
}

/**
 * Split text without losing separators. Character motion uses grapheme clusters,
 * word motion keeps punctuation and whitespace attached to a neighboring word,
 * and each line retains its own original newline sequence.
 */
export function segmentTextMotion(text: string, unit: TextMotionUnit): readonly string[] {
  if (text.length === 0) return Object.freeze([] as string[]);

  if (unit === 'line') {
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character !== '\n' && character !== '\r') continue;
      const end = character === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
      lines.push(text.slice(start, end));
      start = end;
      index = end - 1;
    }
    if (start < text.length) lines.push(text.slice(start));
    return Object.freeze(lines);
  }

  const granularity = unit === 'character' ? 'grapheme' : 'word';
  const parts = Array.from(new Intl.Segmenter(undefined, { granularity }).segment(text));
  if (unit === 'character') return Object.freeze(parts.map(part => part.segment));

  const words: string[] = [];
  let pending = '';
  let prefix = '';
  for (const part of parts) {
    if (part.isWordLike) {
      if (pending) {
        if (words.length > 0) words[words.length - 1] += pending;
        else prefix = pending;
        pending = '';
      }
      words.push(prefix + part.segment);
      prefix = '';
    } else {
      pending += part.segment;
    }
  }
  if (pending) {
    if (words.length > 0) words[words.length - 1] += pending;
    else words.push(prefix + pending);
  }
  return Object.freeze(words);
}

/** Evaluate one stable segment pose at chronological motion progress from zero to one. */
export function evaluateTextMotion(
  id: TextMotionId,
  progress: number,
  index: number,
  count: number,
  amount = 1,
  stagger = 0.35,
  easing?: TransitionEasing,
  options?: {
    readonly phase?: TextMotionPhase;
    readonly direction?: TextMotionDirection;
    readonly order?: TextMotionOrder;
  }
): TextMotionPose {
  const preset = textMotionPreset(id);
  if (!preset) return { ...IDENTITY };

  const requestedPhase = options?.phase ?? preset.phase;
  const phaseProgress = Number.isFinite(progress) ? progress : 0;
  const authoredProgress = requestedPhase === preset.phase ? progress : 1 - phaseProgress;
  const pose = evaluateAuthoredTextMotion(
    id, authoredProgress, index, count, amount, stagger, easing, options?.order ?? 'default',
    requestedPhase !== preset.phase && options?.order !== undefined && options.order !== 'default'
  );
  const direction = options?.direction ?? 'default';
  const baseline = DIRECTIONAL_HIDDEN_EDGES[preset.id];
  if (direction === 'default' || !baseline) return pose;
  return orientTextMotionPose(pose, baseline, direction);
}

function evaluateAuthoredTextMotion(
  id: TextMotionId,
  progress: number,
  index: number,
  count: number,
  amount: number,
  stagger: number,
  easing: TransitionEasing | undefined,
  orderOverride: TextMotionOrder,
  reverseOrder: boolean
): TextMotionPose {
  const preset = textMotionPreset(id);
  if (!preset) return { ...IDENTITY };

  const p = clamp01(Number.isFinite(progress) ? progress : 0);
  if (preset.phase === 'entrance' && p === 1) return { ...IDENTITY };
  if (preset.phase === 'exit' && p === 0) return { ...IDENTITY };

  const safeCount = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  const safeIndex = Math.max(0, Math.min(safeCount - 1, Math.floor(Number.isFinite(index) ? index : 0)));
  const safeAmount = Math.min(1_000, Math.max(0, Number.isFinite(amount) ? amount : 1));
  const safeStagger = clamp(Number.isFinite(stagger) ? stagger : 0.35, 0, 0.9);
  const authoredOrder = staggerOrder(id, safeIndex, safeCount, orderOverride);
  // An explicit order is a playback instruction. Native/default order remains
  // part of the fully reversed design, but "forward" always starts at index 0.
  const order = reverseOrder && safeCount > 1 ? 1 - authoredOrder : authoredOrder;
  const simultaneousCenterPair = safeCount === 2 && (orderOverride === 'center-out' || orderOverride === 'edges-in');
  const intervalStagger = safeCount <= 1 || simultaneousCenterPair ? 0 : safeStagger;
  const delay = intervalStagger * order;
  // Every segment keeps the same active duration. Earlier ranks finish first;
  // the last rank still finishes at the end of the chosen interval.
  const local = clamp01((p - delay) / (1 - intervalStagger));
  const t = easing === undefined ? smooth(local) : evaluateEasing(local, easing);
  const easedProgress = clamp01(t);
  const position = safeCount <= 1 ? 0 : safeIndex / (safeCount - 1);
  const center = (safeCount - 1) / 2;
  const centerDistance = safeCount <= 1 ? 0 : Math.abs(safeIndex - center) / Math.max(center, safeCount - 1 - center);
  const randX = seededUnit(id, safeIndex, 'x') * 2 - 1;
  const randY = seededUnit(id, safeIndex, 'y') * 2 - 1;
  const randAngle = seededUnit(id, safeIndex, 'angle') * 2 - 1;
  const fadeIn = easedProgress;
  const fadeOut = 1 - t;
  const fadeOutOpacity = clamp01(fadeOut);

  switch (id) {
    case 'line-reveal':
      return { ...IDENTITY, y: 0.42 * safeAmount * fadeOut, opacity: fadeIn,
        clipInset: clamp01(fadeOut * safeAmount) };
    case 'word-ghost': {
      const travel = 1 + (1 - position) * 2;
      return { ...IDENTITY, x: -travel * safeAmount * fadeOut, y: -0.28 * safeAmount * fadeOut,
        scaleX: scaleFromIdentity(1 + 0.12 * fadeOut, safeAmount),
        opacity: fadeIn, blur: Math.max(0, 0.24 * safeAmount * fadeOut) };
    }
    case 'kinetic-lines':
      return { ...IDENTITY, y: 0.9 * safeAmount * fadeOut, opacity: fadeIn,
        scaleY: scaleFromIdentity(0.92 + 0.08 * t, safeAmount) };
    case 'character-fade-up':
    case 'word-fade-up':
      return { ...IDENTITY, y: 0.62 * safeAmount * fadeOut, opacity: fadeIn };
    case 'character-slide-down':
      return { ...IDENTITY, y: -0.7 * safeAmount * fadeOut, opacity: fadeIn,
        clipInset: clamp01(fadeOut * safeAmount) };
    case 'alternating-lines': {
      const side = safeIndex % 2 === 0 ? -1 : 1;
      return { ...IDENTITY,
        x: (side * 0.72 + randX * 0.08) * safeAmount * fadeOut,
        y: randY * 0.06 * safeAmount * fadeOut,
        rotate: randAngle * 3 * safeAmount * fadeOut,
        opacity: fadeIn };
    }
    case 'stretch-rise': {
      const shapeProgress = easing === undefined ? local : t;
      const shapeSquash = smooth(clamp01(shapeProgress / 0.72));
      const shapeSettle = smooth(clamp01((shapeProgress - 0.72) / 0.28));
      const scaleX = shapeProgress < 0.72 ? 0.28 + 0.78 * shapeSquash : 1.06 - 0.06 * shapeSettle;
      const scaleY = shapeProgress < 0.72 ? 2.4 - 1.65 * shapeSquash : 0.75 + 0.25 * shapeSettle;
      return { ...IDENTITY, y: 0.6 * safeAmount * fadeOut, scaleX: scaleFromIdentity(scaleX, safeAmount),
        scaleY: scaleFromIdentity(scaleY, safeAmount), opacity: fadeIn };
    }
    case 'vertical-unfold':
      return { ...IDENTITY, scaleY: scaleFromIdentity(t, safeAmount),
        y: 0.08 * safeAmount * fadeOut, opacity: fadeIn };
    case 'converge-spread':
      return { ...IDENTITY, x: Math.sign(safeIndex - center) * centerDistance * 0.85 * safeAmount * fadeOut,
        scaleX: scaleFromIdentity(0.78 + 0.22 * t, safeAmount), opacity: fadeIn };
    case 'center-out':
      return { ...IDENTITY, y: 0.18 * safeAmount * fadeOut,
        scaleX: scaleFromIdentity(0.62 + 0.38 * t, safeAmount),
        scaleY: scaleFromIdentity(0.62 + 0.38 * t, safeAmount), opacity: fadeIn };
    case 'scatter-assemble':
      return { ...IDENTITY, x: randX * 2.4 * safeAmount * fadeOut,
        y: randY * 1.6 * safeAmount * fadeOut, rotate: randAngle * 75 * safeAmount * fadeOut,
        scaleX: scaleFromIdentity(0.65 + 0.35 * t, safeAmount),
        scaleY: scaleFromIdentity(0.65 + 0.35 * t, safeAmount), opacity: fadeIn };
    case 'tilt-scale':
      return { ...IDENTITY, x: randX * 0.12 * safeAmount * fadeOut,
        scaleX: scaleFromIdentity(0.62 + 0.38 * t, safeAmount),
        scaleY: scaleFromIdentity(0.62 + 0.38 * t, safeAmount),
        rotate: randAngle * 20 * safeAmount * fadeOut, opacity: fadeIn };
    case 'smear-in':
      return { ...IDENTITY, scaleX: scaleFromIdentity(1 + 5 * fadeOut, safeAmount),
        y: 0.08 * safeAmount * fadeOut, opacity: fadeIn,
        blur: Math.max(0, 0.18 * safeAmount * fadeOut) };
    case 'elastic-pop': {
      const spring = dampedSpring(easing === undefined ? local : t);
      return { ...IDENTITY, scaleX: scaleFromIdentity(0.42 + 0.58 * spring, safeAmount),
        scaleY: scaleFromIdentity(0.42 + 0.58 * spring, safeAmount),
        opacity: clamp01(t * 1.5) };
    }
    case 'soft-wave': {
      const wave = Math.sin((t * 2.4 - position) * Math.PI * 2) * Math.sin(Math.PI * easedProgress);
      return { ...IDENTITY, y: wave * 0.42 * safeAmount, opacity: fadeIn };
    }
    case 'random-fade':
      return { ...IDENTITY, y: 0.18 * safeAmount * fadeOut, opacity: fadeIn };
    case 'tracking-expand':
      return { ...IDENTITY, x: -Math.sign(safeIndex - center) * centerDistance * 1.15 * safeAmount * fadeOut,
        scaleX: scaleFromIdentity(0.76 + 0.24 * t, safeAmount), opacity: fadeIn };
    case 'emoji-pop': {
      const spring = dampedSpring(easing === undefined ? local : t);
      return { ...IDENTITY, scaleX: scaleFromIdentity(0.18 + 0.82 * spring, safeAmount),
        scaleY: scaleFromIdentity(0.18 + 0.82 * spring, safeAmount),
        rotate: randAngle * 8 * safeAmount * fadeOut, opacity: clamp01(t * 1.45) };
    }
    case 'character-exit-up':
      return { ...IDENTITY, y: -1.05 * safeAmount * t, opacity: fadeOutOpacity,
        clipInset: clamp01(t * safeAmount) };
    case 'fade-down-out':
      return { ...IDENTITY, y: 0.5 * safeAmount * t,
        scaleY: scaleFromIdentity(1 - 0.06 * t, safeAmount), opacity: fadeOutOpacity };
    case 'blur-out':
      return { ...IDENTITY, y: -0.26 * safeAmount * t, opacity: fadeOutOpacity,
        blur: Math.max(0, 1.25 * safeAmount * t) };
    case 'scatter-out':
      return { ...IDENTITY, x: randX * 2.4 * safeAmount * t, y: randY * 1.7 * safeAmount * t,
        rotate: randAngle * 70 * safeAmount * t, opacity: fadeOutOpacity };
    case 'gravity-out': {
      const phase = seededUnit(id, safeIndex, 'wobble') * Math.PI * 2;
      const direction = seededUnit(id, safeIndex, 'fall-direction') < 0.5 ? -1 : 1;
      const wobble = Math.sin(t * 8 * Math.PI + phase) * Math.sin(Math.PI * easedProgress);
      return { ...IDENTITY, y: safeAmount * (2.2 * t * t + 0.09 * wobble),
        rotate: safeAmount * direction * (22 * t * t + 2.8 * wobble),
        opacity: clamp01(1 - easedProgress ** 1.35) };
    }
    case 'scale-down-out':
      return { ...IDENTITY, scaleX: scaleFromIdentity(1 - t, safeAmount),
        scaleY: scaleFromIdentity(1 - t, safeAmount), opacity: fadeOutOpacity };
    case 'reverse-erase':
      return { ...IDENTITY, y: -0.34 * safeAmount * t, opacity: fadeOutOpacity,
        clipInset: clamp01(t * safeAmount) };
    case 'collapse-center':
      return { ...IDENTITY, x: -Math.sign(safeIndex - center) * centerDistance * 0.9 * safeAmount * t,
        scaleX: scaleFromIdentity(1 - 0.28 * t, safeAmount), opacity: fadeOutOpacity };
    case 'noise-dissolve':
      return { ...IDENTITY, opacity: fadeOutOpacity, blur: Math.max(0, 0.12 * safeAmount * t),
        noise: clamp01(t * safeAmount) };
  }

  return { ...IDENTITY };
}

function orientTextMotionPose(
  pose: TextMotionPose,
  baseline: Exclude<TextMotionDirection, 'default'>,
  direction: Exclude<TextMotionDirection, 'default'>
): TextMotionPose {
  let x = pose.x;
  let y = pose.y;
  let scaleX = pose.scaleX;
  let scaleY = pose.scaleY;
  const turns = (DIRECTION_INDEX[direction] - DIRECTION_INDEX[baseline] + 4) % 4;

  // Rotate the authored x/y axis into the chosen hidden edge. Quarter turns
  // also swap anisotropic scales so a vertical stretch can become horizontal.
  for (let turn = 0; turn < turns; turn += 1) {
    const nextX = -y;
    y = x;
    x = nextX;
    const nextScaleX = scaleY;
    scaleY = scaleX;
    scaleX = nextScaleX;
  }

  const result: TextMotionPose = { ...pose, x, y, scaleX, scaleY };
  if (pose.clipInset !== undefined) {
    const clipIndex = (DIRECTION_INDEX.down + turns) % 4;
    return { ...result, clipEdge: DIRECTIONS_BY_INDEX[clipIndex]! };
  }
  return result;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smooth(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function scaleFromIdentity(target: number, amount: number): number {
  return Math.max(0, 1 + (target - 1) * amount);
}

function dampedSpring(progress: number): number {
  const t = clamp01(progress);
  if (t === 0 || t === 1) return t;
  const raw = 1 - Math.exp(-6 * t) * Math.cos(10 * t);
  const endpoint = 1 - Math.exp(-6) * Math.cos(10);
  return raw / endpoint;
}

function seededUnit(id: string, index: number, salt: string): number {
  let hash = 0x811c9dc5;
  const key = id + ':' + index + ':' + salt;
  for (let position = 0; position < key.length; position += 1) {
    hash ^= key.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x1_0000_0000;
}

function centerOrder(index: number, count: number): number {
  if (count <= 1) return 0;
  const center = (count - 1) / 2;
  const maximumDistance = Math.max(center, count - 1 - center);
  return Math.abs(index - center) / maximumDistance;
}

/** Explicit center ordering uses the ranks that actually exist, even for even counts. */
function explicitCenterOrder(index: number, count: number): number {
  if (count <= 2) return 0;
  const center = (count - 1) / 2;
  const nearest = count % 2 === 0 ? 0.5 : 0;
  return (Math.abs(index - center) - nearest) / (center - nearest);
}

// Rank the fixed seeds, rather than using their raw values as delays: even a
// two-glyph random build must use the entire authored stagger interval.
const randomOrders = new Map<string, readonly number[]>();
function randomOrder(id: TextMotionId, index: number, count: number): number {
  if (count <= 1) return 0;
  // Renderer segments are capped at 256. Keep this pure helper bounded for
  // external callers with arbitrarily large counts as well.
  if (count > 1024) {
    const shift = Math.floor(seededUnit(id, 0, 'order') * count);
    return ((index + shift) % count) / (count - 1);
  }
  const key = `${id}:${count}`;
  let ranks = randomOrders.get(key);
  if (!ranks) {
    const order = Array.from({ length: count }, (_, position) => position)
      .sort((a, b) => seededUnit(id, a, 'order') - seededUnit(id, b, 'order') || a - b);
    const positions = new Array<number>(count);
    for (let rank = 0; rank < order.length; rank++) positions[order[rank]!] = rank / (count - 1);
    ranks = Object.freeze(positions);
    if (randomOrders.size >= 32) randomOrders.delete(randomOrders.keys().next().value!);
    randomOrders.set(key, ranks);
  }
  return ranks[index]!;
}

function staggerOrder(
  id: TextMotionId,
  index: number,
  count: number,
  orderOverride: TextMotionOrder = 'default'
): number {
  if (count <= 1) return 0;
  if (orderOverride !== 'default') {
    switch (orderOverride) {
      case 'forward': return index / (count - 1);
      case 'reverse': return 1 - index / (count - 1);
      case 'center-out': return explicitCenterOrder(index, count);
      case 'edges-in': return count <= 2 ? 0 : 1 - explicitCenterOrder(index, count);
      case 'random': return randomOrder(id, index, count);
    }
  }
  switch (id) {
    case 'center-out':
    case 'converge-spread':
    case 'scatter-out':
      return centerOrder(index, count);
    case 'collapse-center':
      return 1 - centerOrder(index, count);
    case 'smear-in':
    case 'fade-down-out':
    case 'blur-out':
    case 'reverse-erase':
      return 1 - index / (count - 1);
    case 'scatter-assemble':
    case 'random-fade':
    case 'gravity-out':
      return randomOrder(id, index, count);
    default:
      return index / (count - 1);
  }
}
