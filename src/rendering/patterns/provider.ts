/** Prepared SVG artwork; the host owns the paint server and external clock. */
export interface PatternProviderSettings {
  readonly colors: readonly [string, string, string];
  readonly speed: number;
  readonly direction: number;
  readonly seed: number;
  readonly parameters: Readonly<Record<string, number>>;
  /** Material strength; the base color remains opaque. */
  readonly intensity: number;
}

export interface PatternProvider {
  readonly node: SVGGElement;
  update(settings: PatternProviderSettings, width: number, height: number): void;
  draw(timeMs: number): void;
  dispose(): void;
}

export type PatternProviderFactory = (id: string, settings: PatternProviderSettings, width: number, height: number) => PatternProvider;

const NS = 'http://www.w3.org/2000/svg';
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
export function attributes(node: SVGElement, attrs: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, typeof value === 'number' ? n(value) : value);
}
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const n = (v: number): string => String(Math.round(v * 1000) / 1000);
