import type { ButtonClip, ButtonShape, ImagePoint, SequenceV1 } from './sequence.js';
import { MODULE_ID } from '../module-identity.js';
import { upgradeSequenceToBreaks, upgradeSequenceToTimelineBreaks } from './breaks.js';
import { getPlaybackSchemaVersion, getSequenceAudience } from './sequence-audience.js';
import { validateSequence } from './validation.js';
export { getSequenceProgressionMode } from './sequence-audience.js';

export const BUTTON_SHAPES = ['rectangle', 'rounded', 'pill', 'bevel', 'hexagon'] as const;
export const BUTTON_TEXTURES = [
  { id: 'grain', path: `modules/${MODULE_ID}/assets/button-textures/grain.svg` },
  { id: 'diagonal', path: `modules/${MODULE_ID}/assets/button-textures/diagonal.svg` },
  { id: 'honeycomb', path: `modules/${MODULE_ID}/assets/button-textures/honeycomb.svg` },
  { id: 'facets', path: `modules/${MODULE_ID}/assets/button-textures/facets.svg` },
] as const;

export function defaultButtonProperties(composition = { width: 1920, height: 1080 }): ButtonClip['properties'] {
  const width = Math.min(360, composition.width);
  const height = Math.min(88, composition.height);
  return { action: { kind: 'continue' }, label: 'Continue', fontFamily: 'sans-serif', fontSize: 32, color: '#ffffff', backgroundColor: '#26334d',
    box: { x: (composition.width - width) / 2, y: Math.max(0, composition.height * 0.8 - height / 2), width, height }, shape: 'rounded' };
}

/** Explicit authoring adoption, retaining launch extensions and the existing media migration. */
export function withButtonProgression(sequence: SequenceV1): SequenceV1 {
  let source = validateSequence(sequence);
  if (getPlaybackSchemaVersion(source) === 1) source = upgradeSequenceToBreaks(source);
  if (getPlaybackSchemaVersion(source) === 2) source = upgradeSequenceToTimelineBreaks(source);
  return validateSequence({ ...source, schemaVersion: 5, playbackSchemaVersion: 3,
    launch: source.launch ?? { version: 1, audience: getSequenceAudience(source) },
    progression: { ...source.progression, version: 1, mode: 'per-recipient' } });
}

/** Polygon outlines use normalized box coordinates. Curved forms use their exact radius separately. */
export function buttonShapePolygon(shape: ButtonShape): readonly ImagePoint[] {
  if (shape === 'hexagon') return [{ x: 0.12, y: 0 }, { x: 0.88, y: 0 }, { x: 1, y: 0.5 }, { x: 0.88, y: 1 }, { x: 0.12, y: 1 }, { x: 0, y: 0.5 }];
  if (shape === 'bevel') return [{ x: 0.08, y: 0 }, { x: 0.92, y: 0 }, { x: 1, y: 0.2 }, { x: 1, y: 0.8 }, { x: 0.92, y: 1 }, { x: 0.08, y: 1 }, { x: 0, y: 0.8 }, { x: 0, y: 0.2 }];
  return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
}

/** Exact local logical-box hit test, including transparent corners. */
export function buttonContainsPoint(shape: ButtonShape, width: number, height: number, x: number, y: number): boolean {
  if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0 || x < 0 || y < 0 || x > width || y > height) return false;
  if (shape === 'rounded' || shape === 'pill') {
    const r = Math.min(width, height) * (shape === 'pill' ? 0.5 : 0.18);
    const dx = x - Math.max(r, Math.min(width - r, x));
    const dy = y - Math.max(r, Math.min(height - r, y));
    return dx * dx + dy * dy <= r * r;
  }
  const px = x / width, py = y / height;
  const polygon = buttonShapePolygon(shape);
  return polygon.every((a, index) => {
    const b = polygon[(index + 1) % polygon.length]!;
    return (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x) >= -1e-10;
  });
}
