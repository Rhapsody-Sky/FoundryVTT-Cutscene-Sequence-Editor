export interface PreviewViewportSize {
  readonly width: number;
  readonly height: number;
}

export type PreviewViewportPreset = 'composition' | '1920x1080' | '1366x768' | 'ultrawide' | 'portrait' | 'square' | 'custom';

export const PREVIEW_VIEWPORT_PRESETS: Readonly<Record<Exclude<PreviewViewportPreset, 'composition' | 'custom'>, PreviewViewportSize>> = {
  '1920x1080': { width: 1920, height: 1080 },
  '1366x768': { width: 1366, height: 768 },
  ultrawide: { width: 2560, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 }
};

export const PREVIEW_VIEWPORT_LIMITS = { minimum: 64, maximum: 16_384 } as const;
const DEFAULT_COMPOSITION: PreviewViewportSize = { width: 1920, height: 1080 };

/** Return the CSS-pixel rectangle that fits a virtual aspect ratio into the local preview host. */
export function fitPreviewViewport(hostWidth: number, hostHeight: number, viewport: PreviewViewportSize): PreviewViewportSize {
  if (!(hostWidth > 0 && hostHeight > 0 && viewport.width > 0 && viewport.height > 0)
    || ![hostWidth, hostHeight, viewport.width, viewport.height].every(Number.isFinite)) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(hostWidth / viewport.width, hostHeight / viewport.height);
  const precision = 1000;
  return {
    width: Math.min(hostWidth, Math.round(viewport.width * scale * precision) / precision),
    height: Math.min(hostHeight, Math.round(viewport.height * scale * precision) / precision)
  };
}

export function isValidPreviewViewportSize(size: PreviewViewportSize): boolean {
  return [size.width, size.height].every(value => Number.isSafeInteger(value)
    && value >= PREVIEW_VIEWPORT_LIMITS.minimum && value <= PREVIEW_VIEWPORT_LIMITS.maximum);
}

interface ViewportControls extends HTMLElement {
  readonly dataset: DOMStringMap & { invalidMessage?: string };
}

interface ViewportElements {
  readonly controls: ViewportControls;
  readonly space: HTMLElement;
  readonly viewer: HTMLElement;
  readonly preset: HTMLSelectElement;
  readonly custom: HTMLElement;
  readonly width: HTMLInputElement;
  readonly height: HTMLInputElement;
  readonly caption: HTMLOutputElement;
  readonly status: HTMLElement;
}

/**
 * Owns only the editor's simulated viewport geometry and form state. It never
 * reads or writes a sequence, draft, renderer, or playback instance.
 */
export class PreviewViewport {
  private readonly listeners = new AbortController();
  private readonly elements: ViewportElements | null;
  private observer: ResizeObserver | null = null;
  private mode: PreviewViewportPreset = 'composition';
  private composition: PreviewViewportSize = DEFAULT_COMPOSITION;
  private size: PreviewViewportSize = DEFAULT_COMPOSITION;
  private disposed = false;

  constructor(root: HTMLElement) {
    const controls = root.querySelector<ViewportControls>('[data-stagecraft-viewport-controls]');
    const space = root.querySelector<HTMLElement>('.stagecraft-viewer-space');
    const viewer = root.querySelector<HTMLElement>('[data-stagecraft-viewer]');
    const preset = root.querySelector<HTMLSelectElement>('[data-stagecraft-viewport-preset]');
    const custom = root.querySelector<HTMLElement>('[data-stagecraft-viewport-custom]');
    const width = root.querySelector<HTMLInputElement>('[data-stagecraft-viewport-width]');
    const height = root.querySelector<HTMLInputElement>('[data-stagecraft-viewport-height]');
    const caption = root.querySelector<HTMLOutputElement>('[data-stagecraft-viewport-size]');
    const status = root.querySelector<HTMLElement>('[data-stagecraft-viewport-status]');
    if (!controls || !space || !viewer || !preset || !custom || !width || !height || !caption || !status) {
      this.elements = null;
      return;
    }

    this.elements = { controls, space, viewer, preset, custom, width, height, caption, status };
    preset.value = this.mode;
    for (const type of ['change', 'input', 'focusin'] as const) {
      controls.addEventListener(type, event => event.stopPropagation(), { signal: this.listeners.signal });
    }
    preset.addEventListener('change', () => this.selectPreset(), { signal: this.listeners.signal });
    width.addEventListener('input', () => this.readCustomSize(), { signal: this.listeners.signal });
    height.addEventListener('input', () => this.readCustomSize(), { signal: this.listeners.signal });

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.fit());
      this.observer.observe(space);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.fit(), { signal: this.listeners.signal });
    }

    this.renderMode();
    this.renderSize();
    this.fit();
  }

  /** Keep the Composition choice in sync with the current sequence's logical size. */
  setComposition(size: PreviewViewportSize): void {
    if (!isValidCompositionSize(size)) return;
    this.composition = { width: size.width, height: size.height };
    if (this.mode === 'composition') {
      this.size = this.composition;
      this.renderSize();
      this.fit();
    }
  }

  get selectedSize(): PreviewViewportSize {
    return { ...this.size };
  }

  get selectedPreset(): PreviewViewportPreset {
    return this.mode;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.abort();
    this.observer?.disconnect();
    this.observer = null;
  }

  private selectPreset(): void {
    const elements = this.elements;
    if (!elements || this.disposed) return;
    const requested = elements.preset.value as PreviewViewportPreset;
    if (!['composition', ...Object.keys(PREVIEW_VIEWPORT_PRESETS), 'custom'].includes(requested)) {
      elements.preset.value = this.mode;
      return;
    }
    if (requested === 'custom' && this.mode !== 'custom') {
      elements.width.value = String(this.size.width);
      elements.height.value = String(this.size.height);
    }
    this.mode = requested;
    this.renderMode();
    if (requested === 'composition') this.size = this.composition;
    else if (requested !== 'custom') this.size = PREVIEW_VIEWPORT_PRESETS[requested];
    this.clearValidation();
    this.renderSize();
    this.fit();
  }

  private readCustomSize(): void {
    const elements = this.elements;
    if (!elements || this.disposed || this.mode !== 'custom') return;
    const width = parseDimension(elements.width.value);
    const height = parseDimension(elements.height.value);
    const candidate = { width, height };
    const message = elements.controls.dataset.invalidMessage ?? 'Enter whole dimensions from 64 to 16384 pixels.';
    if (!isValidPreviewViewportSize(candidate)) {
      const widthValid = isValidDimension(width);
      const heightValid = isValidDimension(height);
      elements.width.setCustomValidity(widthValid ? '' : message);
      elements.height.setCustomValidity(heightValid ? '' : message);
      elements.width.setAttribute('aria-invalid', String(!widthValid));
      elements.height.setAttribute('aria-invalid', String(!heightValid));
      elements.status.textContent = message;
      elements.status.classList.add('stagecraft-viewport-error');
      return;
    }

    this.size = candidate;
    this.clearValidation();
    this.renderSize();
    this.fit();
  }

  private clearValidation(): void {
    const elements = this.elements;
    if (!elements) return;
    elements.width.setCustomValidity('');
    elements.height.setCustomValidity('');
    elements.width.removeAttribute('aria-invalid');
    elements.height.removeAttribute('aria-invalid');
    elements.status.textContent = '';
    elements.status.classList.remove('stagecraft-viewport-error');
  }

  private renderMode(): void {
    const elements = this.elements;
    if (!elements) return;
    elements.preset.value = this.mode;
    elements.custom.hidden = this.mode !== 'custom';
  }

  private renderSize(): void {
    const elements = this.elements;
    if (!elements) return;
    elements.caption.textContent = `${this.size.width} × ${this.size.height}`;
  }

  private fit(): void {
    const elements = this.elements;
    if (!elements || this.disposed) return;
    const fit = fitPreviewViewport(elements.space.clientWidth, elements.space.clientHeight, this.size);
    if (!fit.width || !fit.height) return;
    elements.viewer.style.width = `${fit.width}px`;
    elements.viewer.style.height = `${fit.height}px`;
  }
}

function parseDimension(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function isValidDimension(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= PREVIEW_VIEWPORT_LIMITS.minimum && value <= PREVIEW_VIEWPORT_LIMITS.maximum;
}

function isValidCompositionSize(size: PreviewViewportSize): boolean {
  return [size.width, size.height].every(value => Number.isSafeInteger(value) && value > 0
    && value <= PREVIEW_VIEWPORT_LIMITS.maximum);
}
