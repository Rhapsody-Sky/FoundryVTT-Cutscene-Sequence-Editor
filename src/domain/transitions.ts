import type { Transition, TransitionEasing } from './sequence.js';
export { TRANSITION_EASINGS } from './sequence.js';

/** Every timed preset occupies the same entrance/exit interval. */
export function transitionDurationMs(transition: Transition): number {
  return transition.preset === 'none' ? 0 : transition.durationMs;
}

export function transitionChangesOpacity(transition: Transition): boolean {
  return transition.preset === 'fade' || transition.preset === 'fade-slide' || transition.preset === 'fade-zoom';
}

/** Cinematic bars use slide presets to reveal their existing geometry. */
export function transitionChangesBarsReveal(transition: Transition): boolean {
  return transition.preset === 'slide' || transition.preset === 'fade-slide';
}

export function transitionChangesTextPosition(transition: Transition): boolean {
  return transition.preset === 'slide' || transition.preset === 'fade-slide';
}

export function transitionChangesTextScale(transition: Transition): boolean {
  return transition.preset === 'zoom' || transition.preset === 'fade-zoom';
}

/** Clamp clock progress, while retaining intentional back-curve motion overshoot. */
export function evaluateEasing(progress: number, easing: TransitionEasing): number {
  const normalized = Math.max(0, Math.min(1, progress));
  if (normalized === 0 || normalized === 1) return normalized;
  const back = 1.70158;
  switch (easing) {
    case 'linear': return normalized;
    case 'ease-in': return normalized * normalized;
    case 'ease-out': return 1 - (1 - normalized) * (1 - normalized);
    // Preserve the exact legacy smoothstep curve.
    case 'ease-in-out': return normalized * normalized * (3 - 2 * normalized);
    case 'back-in': return (back + 1) * normalized ** 3 - back * normalized ** 2;
    case 'back-out': return 1 + (back + 1) * (normalized - 1) ** 3 + back * (normalized - 1) ** 2;
    case 'back-in-out': {
      const amount = back * 1.525;
      return normalized < 0.5
        ? ((2 * normalized) ** 2 * ((amount + 1) * 2 * normalized - amount)) / 2
        : (((2 * normalized - 2) ** 2 * ((amount + 1) * (2 * normalized - 2) + amount)) + 2) / 2;
    }
  }
}
