import { ANIMATED_PATTERN_PRESETS, animatedPatternPreset, getAnimatedPatternSettings, selectAnimatedPatternPreset, MAX_POLYGON_POINTS, POLYGON_PRESETS, type AnimatedPattern } from '../domain/animated-pattern.js';
import { shiftDecimalText } from '../domain/spatial-precision.js';
import type { SolidClip } from '../domain/sequence.js';

/** Explicit selection preserves common settings and initializes the selected recipe. */
export function changePatternPreset(pattern: AnimatedPattern, preset: string): AnimatedPattern {
  const selected = animatedPatternPreset(preset);
  return selected ? selectAnimatedPatternPreset(pattern, selected.id) : pattern;
}

export function resetPatternPalette(pattern: AnimatedPattern): AnimatedPattern {
  const preset = animatedPatternPreset(pattern.preset);
  return preset ? { ...pattern, colors: [...preset.colors] } : pattern;
}

export function changeSolidPolygon(clip: SolidClip, preset: string): SolidClip {
  const selected = POLYGON_PRESETS.find(item => item.id === preset);
  if (!selected) return clip;
  const mask = selected.points.map(point => ({ ...point }));
  if (clip.typeVersion === 1 && mask.length === 4) {
    return { ...clip, properties: { ...clip.properties, mask: mask as unknown as typeof clip.properties.mask } };
  }
  return { ...clip, typeVersion: 2, properties: { ...clip.properties, mask } };
}

function options(select: HTMLSelectElement | null, values: readonly { readonly id: string; readonly label: string }[], t: (key: string) => string): void {
  if (!select || select.options.length) return;
  for (const value of values) {
    const option = document.createElement('option'); option.value = value.id; option.textContent = t(value.label);
    select.append(option);
  }
}

/** Populate only changed geometry so focused controls and collapsed groups survive repaint. */
export function paintAnimatedSurfaceInspector(root: HTMLElement, clip: SolidClip | undefined, t: (key: string) => string,
  setValue: (name: string, value: string) => void): void {
  options(root.querySelector<HTMLSelectElement>('[name="solid-pattern-preset"]'), ANIMATED_PATTERN_PRESETS, t);
  options(root.querySelector<HTMLSelectElement>('[name="solid-polygon-preset"]'), [{ id: 'custom', label: 'PolygonCustom' }, ...POLYGON_PRESETS], t);
  if (clip) {
    const match = POLYGON_PRESETS.find(preset => preset.points.length === clip.properties.mask.length
      && preset.points.every((point, index) => point.x === clip.properties.mask[index]!.x && point.y === clip.properties.mask[index]!.y));
    setValue('solid-polygon-preset', match?.id ?? 'custom');
  }
  const pattern = clip?.properties.pattern;
  for (const group of root.querySelectorAll<HTMLElement>('[data-stagecraft-pattern-settings]')) group.hidden = !pattern;
  const settings = pattern ? getAnimatedPatternSettings(pattern) : [];
  const specific = root.querySelector<HTMLElement>('[data-stagecraft-pattern-parameters]');
  if (specific) {
    const signature = settings.map(setting => setting.key).join('|');
    if (specific.dataset.controls !== signature) {
      specific.replaceChildren(); specific.dataset.controls = signature;
      for (const setting of settings) {
        const label = document.createElement('label'), caption = document.createElement('span'), input = document.createElement('input');
        caption.textContent = t(setting.label); input.type = 'number'; input.name = `solid-pattern-parameter-${setting.key}`;
        input.min = String(setting.min); input.max = String(setting.max); input.step = String(setting.step); input.required = true;
        label.append(caption, input); specific.append(label);
      }
    }
    specific.hidden = settings.length === 0;
    for (const setting of settings) setValue(`solid-pattern-parameter-${setting.key}`, String(setting.value));
  }
  for (const label of root.querySelectorAll<HTMLElement>('[data-stagecraft-pattern-legacy]')) {
    label.hidden = pattern?.version === 2;
  }
  if (pattern) {
    setValue('solid-pattern-preset', pattern.preset);
    pattern.colors.forEach((color, index) => setValue(`solid-pattern-color-${index}`, color));
    for (const key of ['speed', 'scale', 'density', 'direction', 'intensity', 'onBreak'] as const) setValue('solid-pattern-' + key, String(pattern[key]));
    const reverse = root.querySelector<HTMLInputElement>('[name="solid-pattern-reverse"]');
    if (reverse) reverse.checked = pattern.reverse;
  }
  const list = root.querySelector<HTMLElement>('[data-stagecraft-solid-point-list]');
  const mask = clip?.properties.mask ?? [];
  if (list && list.dataset.pointCount !== String(mask.length)) {
    list.replaceChildren(); list.dataset.pointCount = String(mask.length);
    mask.forEach((_point, index) => {
      const row = document.createElement('div'); row.className = 'stagecraft-coordinate-row';
      const caption = document.createElement('span'); caption.className = 'stagecraft-row-label'; caption.textContent = `${t('PolygonPoint')} ${index + 1}`;
      const fields = document.createElement('div'); fields.className = 'stagecraft-coordinate-inputs';
      for (const axis of ['x', 'y'] as const) {
        const label = document.createElement('label'), text = document.createElement('span'), input = document.createElement('input');
        text.textContent = axis.toUpperCase(); input.type = 'number'; input.name = `solid-mask-${index}-${axis}`;
        input.min = '0'; input.max = '100'; input.step = 'any'; input.required = true;
        input.setAttribute('aria-label', `${t('PolygonPoint')} ${index + 1}: ${t(axis === 'x' ? 'XPercent' : 'YPercent')}`);
        label.append(text, input); fields.append(label);
      }
      row.append(caption, fields); list.append(row);
    });
  }
  mask.forEach((point, index) => {
    setValue(`solid-mask-${index}-x`, shiftDecimalText(point.x, 2));
    setValue(`solid-mask-${index}-y`, shiftDecimalText(point.y, 2));
  });
  const add = root.querySelector<HTMLButtonElement>('[data-stagecraft-action="solid-add-point"]');
  const remove = root.querySelector<HTMLButtonElement>('[data-stagecraft-action="solid-remove-point"]');
  if (add) add.dataset.boundDisabled = String(mask.length >= MAX_POLYGON_POINTS);
  if (remove) remove.dataset.boundDisabled = String(mask.length <= 3);
}
