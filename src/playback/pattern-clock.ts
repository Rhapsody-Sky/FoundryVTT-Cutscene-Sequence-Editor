import type { SequenceClip } from '../domain/sequence.js';
import type { EvaluationContext, FrameItem } from './evaluate.js';

const activeElapsed = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

/** Stateless clock: history contributes only while this authored clip was present. */
export function animatedPatternClock(clip: SequenceClip, positionMs: number, durationMs: number,
  context: EvaluationContext): Pick<FrameItem, 'patternTimeMs'> {
  if (clip.type !== 'solid' || clip.typeVersion !== 2 || !clip.properties.pattern) return {};
  const local = Math.max(0, positionMs - clip.startMs);
  const loop = clip.properties.pattern.onBreak === 'loop';
  const end = clip.startMs + durationMs;
  const completed = loop ? (context.breakHistory ?? []).reduce((total, entry) =>
    entry.positionMs >= clip.startMs && entry.positionMs <= positionMs
      && (entry.positionMs < end || clip.duration.kind === 'sequence-end')
      ? total + activeElapsed(entry.elapsedMs) : total, 0) : 0;
  const paused = context.paused === true || context.exiting?.paused === true;
  const exitElapsed = !paused && context.exiting ? activeElapsed(context.exiting.elapsedMs) : 0;
  // During an exit from a running hold the supplied holding clock already includes
  // exit time. Pause-at-Break surfaces still advance through the common active fade.
  const current = context.holding
    ? loop ? activeElapsed(context.holding.elapsedMs)
      : context.holding.paused ? 0 : exitElapsed
    : exitElapsed;
  return { patternTimeMs: Math.min(Number.MAX_SAFE_INTEGER, local + completed + current) };
}
