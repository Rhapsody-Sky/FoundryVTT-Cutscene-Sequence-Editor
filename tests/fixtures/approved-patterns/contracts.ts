export type PatternId = 'halftone' | 'energy-trails' | 'iridescent-field';
export type Palette = readonly [string, string, string];
export interface PatternSettings {
  colors: Palette;
  speed: number;
  direction: number;
  seed: number;
  values: Readonly<Record<string, number>>;
}
export interface PatternControl {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  unit?: string;
}
export interface PrototypeRenderer {
  readonly node: SVGGElement;
  update(settings: PatternSettings, width: number, height: number): void;
  draw(timeMs: number): void;
  dispose(): void;
}
export interface PatternDesign {
  id: PatternId;
  label: string;
  description: string;
  colors: Palette;
  controls: readonly PatternControl[];
  create(id: string, settings: PatternSettings, width: number, height: number): PrototypeRenderer;
}
export const NS = 'http://www.w3.org/2000/svg';
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
export function attributes(node: SVGElement, attrs: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : value);
}
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const n = (v: number): string => String(Math.round(v * 1000) / 1000);
export function defaults(design: PatternDesign): PatternSettings {
  return { colors: [...design.colors], speed: 1, direction: 0, seed: 0x5eed2026,
    values: Object.fromEntries(design.controls.map(control => [control.key, control.initial])) };
}
