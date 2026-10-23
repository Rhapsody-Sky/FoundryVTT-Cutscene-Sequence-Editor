import type { SequenceV1, TextClip, Transition } from '../domain/sequence.js';
import { textMotionPreset, type TextMotionPhase } from '../domain/text-motion.js';
import { compileSequence, evaluate } from '../playback/evaluate.js';
import type { PlayerFrame } from '../playback/local-player.js';

export const TEXT_ANIMATION_PREVIEW_SIZE = Object.freeze({ width: 640, height: 320 });

export interface TextAnimationPreview {
  readonly clip: TextClip;
  /** Phase-local chronological progress; finite values are clamped to [0, 1]. */
  frameAt(progress: number): PlayerFrame;
}

const NONE: Transition = Object.freeze({ preset: 'none', version: 1 });
const BASIC_PRESETS = ['fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'] as const;
const DEFAULT_SAMPLE = 'YOUR STORY\nSTARTS HERE';

function previewTransition(value: string, phase: TextMotionPhase, source?: Transition): Transition {
  if (value === 'none') return NONE;
  const motion = value.startsWith('text-motion:') ? textMotionPreset(value.slice('text-motion:'.length)) : undefined;
  const basic = BASIC_PRESETS.find(preset => preset === value);
  if (!basic && !motion) throw new RangeError('Unknown text animation preview option.');
  const same = source && source.preset !== 'none' && (motion
    ? source.preset === 'text-motion' && source.motion === motion.id
    : source.preset === basic);
  if (same) {
    // A disabled/zero-length animation has no interval to demonstrate. The
    // preview stays readable; this never repairs or changes the authored value.
    if (source.durationMs === 0) return NONE;
    const common = { version: 1 as const, durationMs: source.durationMs, easing: source.easing };
    if (motion) return { ...common, preset: 'text-motion', motion: motion.id,
      ...(source.amount === undefined ? {} : { amount: source.amount }),
      ...(source.stagger === undefined ? {} : { stagger: source.stagger }),
      ...(source.motionDirection === undefined ? {} : { motionDirection: source.motionDirection }),
      ...(source.motionOrder === undefined ? {} : { motionOrder: source.motionOrder }) };
    return { ...common, preset: basic!,
      ...(basic === 'slide' || basic === 'fade-slide' ? {
        ...(source.direction === undefined ? {} : { direction: source.direction }),
        ...(source.distance === undefined ? {} : { distance: source.distance })
      } : {}),
      ...(basic === 'zoom' || basic === 'fade-zoom'
        ? source.scale === undefined ? {} : { scale: source.scale } : {}) };
  }
  if (motion) return { preset: 'text-motion', version: 1, motion: motion.id, durationMs: motion.durationMs,
    easing: phase === 'entrance' ? 'ease-out' : 'ease-in', amount: 1, stagger: 0.35,
    motionDirection: 'default', motionOrder: 'default' };
  return { preset: basic!, version: 1, durationMs: 800, easing: 'ease-in-out' };
}

/** A local immutable sample evaluated by the production timeline, compiled once.
 * The real text renderer handles segmented poses and reverse-phase playback.
 * Fixed clip Out endpoints are empty, matching production [start, end) timing.
 */
export function createTextAnimationPreview(value: string, phase: TextMotionPhase,
  source?: Transition, sampleText = DEFAULT_SAMPLE): TextAnimationPreview {
  if (phase !== 'entrance' && phase !== 'exit') throw new RangeError('Unknown text animation preview phase.');
  const transition = previewTransition(value, phase, source);
  const durationMs = transition.preset === 'none' ? 0 : transition.durationMs;
  // Bound both the rendered glyph count and the amount of metadata compiled
  // for each thumbnail, regardless of the caller's localized sample text.
  const text = Array.from(sampleText).slice(0, 128).join('').trim() || DEFAULT_SAMPLE;
  const clip: TextClip = {
    id: 'text-animation-preview', trackId: 'preview-track', type: 'text', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: Math.max(1, durationMs + (phase === 'entrance' ? 1 : 0)) },
    entrance: phase === 'entrance' ? transition : NONE,
    exit: phase === 'exit' ? transition : NONE,
    properties: { text, fontFamily: 'sans-serif', fontSize: 64, minimumFontSize: 24,
      color: '#ffffff', align: 'center', box: { x: 32, y: 80, width: 576, height: 160 }, shrinkToFit: true }
  };
  const sequence: SequenceV1 = {
    schemaVersion: 1, id: 'text-animation-preview', revision: 0, name: 'Text animation preview',
    composition: TEXT_ANIMATION_PREVIEW_SIZE,
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 0 },
    tracks: [{ id: 'preview-track', name: 'Preview', kind: 'visual', order: 0, enabled: true, locked: false }],
    clips: [clip], end: { kind: 'fixed', durationMs: clip.duration.kind === 'fixed' ? clip.duration.milliseconds : 1 }
  };
  const plan = compileSequence(sequence);
  return Object.freeze({
    clip: plan.clips[0] as TextClip,
    frameAt(progress: number): PlayerFrame {
      if (!Number.isFinite(progress)) throw new RangeError('Text animation preview progress must be finite.');
      const positionMs = Math.max(0, Math.min(1, progress)) * durationMs;
      return Object.freeze({ positionMs, items: evaluate(plan, positionMs), opacity: 1, phase: 'playing' });
    }
  });
}
