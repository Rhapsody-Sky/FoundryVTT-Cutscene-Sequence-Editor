import type { TextClip, Transition } from '../domain/sequence.js';
import type { TextMotionPhase } from '../domain/text-motion.js';
import { textRenderer } from '../rendering/text-renderer.js';
import type { RendererOptions } from '../rendering/element-renderer.js';
import { createTextAnimationPreview, TEXT_ANIMATION_PREVIEW_SIZE, type TextAnimationPreview } from './text-animation-preview.js';
import { AnimationPicker, type AnimationPickerScheduler, type AnimationPickerRenderer } from './animation-picker.js';

/**
 * The optional factories are a deterministic test seam. Application callers
 * should normally provide only the frame scheduler and use production renderers.
 */
export interface TextAnimationPickerRuntime extends AnimationPickerScheduler {
  /** @internal */
  createPreview?(value: string, phase: TextMotionPhase, source?: Transition, sampleText?: string): TextAnimationPreview;
  /** @internal */
  createRenderer?(clip: TextClip, parent: HTMLElement, size: { readonly width: number; readonly height: number },
    options: RendererOptions): AnimationPickerRenderer;
}

const browserRuntime: TextAnimationPickerRuntime = {
  now: () => performance.now(),
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id)
};

/**
 * Backward-compatible text specialization of the shared per-element animation gallery.
 * Preset changes still cross the normal single select change event owned by EditorView.
 */
export class TextAnimationPicker {
  private readonly picker: AnimationPicker<TextClip, TextAnimationPreview>;

  constructor(root: HTMLElement, host: HTMLElement, select: HTMLSelectElement,
    t: (key: string) => string, phase: TextMotionPhase, runtime: TextAnimationPickerRuntime = browserRuntime) {
    const sampleText = t('STAGECRAFT.Editor.TextAnimationSample');
    this.picker = new AnimationPicker(root, host, select, t, phase, {
      previewSize: TEXT_ANIMATION_PREVIEW_SIZE,
      scheduler: runtime,
      createPreview: (value, previewPhase, source) => runtime.createPreview?.(value, previewPhase, source, sampleText)
        ?? createTextAnimationPreview(value, previewPhase, source, sampleText),
      createRenderer: (clip, parent, size, options) => runtime.createRenderer?.(clip, parent, size, options)
        ?? textRenderer(clip, parent, size, options)
    });
  }

  update(transition: Transition | undefined, identity: string, disabled: boolean): void {
    this.picker.update(transition, identity, disabled);
  }

  dispose(): void {
    this.picker.dispose();
  }
}
