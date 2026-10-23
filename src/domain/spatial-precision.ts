/** Newly authored geometry stays precise enough for smooth layout while avoiding noisy floats. */
export const COMPOSITION_UNIT_DECIMAL_PLACES = 2;
export const MASK_COORDINATE_DECIMAL_PLACES = 4;

function roundToPlaces(value: number, places: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Number(value.toFixed(places));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundCompositionUnits(value: number): number {
  return roundToPlaces(value, COMPOSITION_UNIT_DECIMAL_PLACES);
}

export function roundMaskCoordinate(value: number): number {
  return roundToPlaces(value, MASK_COORDINATE_DECIMAL_PLACES);
}

/** Shifts a decimal point without introducing binary multiplication residue. */
export function shiftDecimalText(value: string | number, places: number): string {
  const source = String(value).trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(source);
  if (!match) return source;

  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2] ?? '0';
  const fraction = match[3] ?? match[4] ?? '';
  const digits = integer + fraction;
  if (/^0+$/.test(digits)) return '0';
  const exponent = Number(match[5] ?? 0);
  const position = integer.length + exponent + places;
  let whole: string;
  let remainder: string;
  if (position <= 0) {
    whole = '0';
    remainder = '0'.repeat(-position) + digits;
  } else if (position >= digits.length) {
    whole = digits + '0'.repeat(position - digits.length);
    remainder = '';
  } else {
    whole = digits.slice(0, position);
    remainder = digits.slice(position);
  }
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  remainder = remainder.replace(/0+$/, '');
  return sign + whole + (remainder ? '.' + remainder : '');
}
