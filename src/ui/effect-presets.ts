import type { SimpleElementType } from './simple-composition.js';
import type { ButtonClip, ButtonShape, ButtonTexture } from '../domain/sequence.js';

export type PresetElementType = SimpleElementType | 'image' | 'solid' | 'audio' | 'button' | 'break';

/** Palette entries use the existing timeline defaults and media picker. */
export interface EffectPreset {
  readonly id: string;
  readonly type: PresetElementType;
  readonly label: string;
  readonly icon: string;
}

export interface ButtonDesign {
  readonly id: string;
  readonly label: string;
  readonly shape: ButtonShape;
  readonly backgroundColor: string;
  readonly color: string;
  readonly texture?: Extract<ButtonTexture, { readonly kind: 'builtin' }>;
}

/** Built-in visual recipes are offered inside the Button inspector. */
export const BUTTON_DESIGNS: readonly ButtonDesign[] = Object.freeze([
  { id: 'solid', label: 'ButtonDesignSolidRounded', shape: 'rounded', backgroundColor: '#26334d', color: '#ffffff' },
  { id: 'diagonal', label: 'ButtonDesignDiagonalBevel', shape: 'bevel', backgroundColor: '#704334', color: '#fff4e5', texture: { kind: 'builtin', id: 'diagonal' } },
  { id: 'honeycomb', label: 'ButtonDesignHoneycombPill', shape: 'pill', backgroundColor: '#215b5c', color: '#eafff6', texture: { kind: 'builtin', id: 'honeycomb' } },
  { id: 'facets', label: 'ButtonDesignFacetedHexagon', shape: 'hexagon', backgroundColor: '#4d417c', color: '#fff9e8', texture: { kind: 'builtin', id: 'facets' } }
]);

export function buttonDesign(id: string | undefined): ButtonDesign | undefined {
  return BUTTON_DESIGNS.find(design => design.id === id);
}

export function buttonDesignId(properties: Pick<ButtonClip['properties'], 'shape' | 'backgroundColor' | 'color' | 'texture'>): string {
  const texture = properties.texture;
  return BUTTON_DESIGNS.find(design => properties.shape === design.shape
    && properties.backgroundColor === design.backgroundColor
    && properties.color === design.color
    && (design.texture === undefined ? texture === undefined
      : texture?.kind === 'builtin' && texture.id === design.texture.id))?.id ?? 'custom';
}

export const EFFECT_PRESETS: readonly EffectPreset[] = [
  { id: 'cinematic-bars', type: 'bars', label: 'Bars', icon: 'fa-grip-lines' },
  { id: 'title', type: 'text', label: 'TitleElement', icon: 'fa-heading' },
  { id: 'image', type: 'image', label: 'Image', icon: 'fa-image' },
  { id: 'color-surface', type: 'solid', label: 'ColorSurface', icon: 'fa-fill-drip' },
  { id: 'animated-surface', type: 'solid', label: 'AnimatedSurface', icon: 'fa-wand-magic-sparkles' },
  { id: 'video', type: 'video', label: 'Video', icon: 'fa-film' },
  { id: 'audio', type: 'audio', label: 'SoundFiles', icon: 'fa-volume-high' },
  { id: 'button', type: 'button', label: 'Button', icon: 'fa-hand-pointer' },
  { id: 'break', type: 'break', label: 'InnerBreak', icon: 'fa-pause' }
];

export function effectPreset(id: string | undefined): EffectPreset | undefined {
  return EFFECT_PRESETS.find(preset => preset.id === id);
}
