/** Small errors use modest rate correction. Large jumps seek once to the parent timeline. */
export function videoSync(currentSeconds: number, localTimeMs: number, durationSeconds: number,
  playing: boolean): { targetSeconds: number; seek: boolean; rate: number } {
  const targetSeconds = Math.max(0, Math.min(localTimeMs / 1000, Math.max(0, durationSeconds - 0.001)));
  const difference = targetSeconds - currentSeconds;
  const seek = Math.abs(difference) > (playing ? 0.5 : 0.08);
  const rate = !playing || seek || Math.abs(difference) < 0.12 ? 1 : difference > 0 ? 1.05 : 0.95;
  return { targetSeconds, seek, rate };
}
