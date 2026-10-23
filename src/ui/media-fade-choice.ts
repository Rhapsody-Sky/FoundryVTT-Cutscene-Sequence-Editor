/** Choosing a visual Fade thumbnail still edits the existing media duration fields. */
export function mediaFadeChoiceDurations(preset: string, currentMs: number, oppositeMs: number,
  lengthMs: number | null): { durationMs: number; oppositeMs: number } {
  if (preset !== 'none' && preset !== 'fade') throw new RangeError('Unsupported media fade choice.');
  if (preset === 'none') return { durationMs: 0, oppositeMs };
  if (currentMs > 0) return { durationMs: currentMs, oppositeMs };
  const available = lengthMs === null ? 800 : Math.max(1, lengthMs - oppositeMs);
  const durationMs = Math.min(800, available);
  return { durationMs, oppositeMs: lengthMs === null ? oppositeMs : Math.min(oppositeMs, Math.max(0, lengthMs - durationMs)) };
}
