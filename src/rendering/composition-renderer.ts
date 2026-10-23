import type { SequenceClip } from '../domain/sequence.js';
import type { PlayerFrame } from '../playback/local-player.js';
import { barsRenderer } from './bars-renderer.js';
import type { ElementRenderer, RendererOptions } from './element-renderer.js';
import { textRenderer } from './text-renderer.js';
import { videoRenderer } from './video-renderer.js';
import { imageRenderer } from './image-renderer.js';
import { solidRenderer } from './solid-renderer.js';
import { audioRenderer } from './audio-renderer.js';
import { setClipBlend } from './clip-appearance.js';
import { VideoBlendBackdrop } from './video-blend-backdrop.js';
import { VideoKeyingFilter, VideoKeyingPool } from './video-keying.js';
import { buttonRenderer, createButtonActivationGate, TERMINAL_BUTTON_HOLD_KEY, type ButtonActivationGate } from './button-renderer.js';

function buttonTextureKey(clip: Extract<SequenceClip, { type: 'button' }>): string {
  const texture = clip.properties.texture;
  return texture ? texture.kind === 'builtin' ? `builtin:${texture.id}` : `foundry:${texture.path}` : '';
}

export class CompositionRenderer {
  private readonly elements = new Map<string, { clip: SequenceClip; renderer: ElementRenderer }>();
  private disposed = false;
  private backdrop: VideoBlendBackdrop | null = null;
  private visualRequest: number | null = null;
  private lastFrame: PlayerFrame | null = null;
  private keyingPool: VideoKeyingPool | null = null;
  private audioContext: AudioContext | null = null;
  private previewOrder = false;
  private readonly buttonInteraction: ButtonActivationGate | undefined;
  constructor(clips: readonly SequenceClip[], private readonly root: HTMLElement,
    private readonly size: { width: number; height: number }, private readonly options: RendererOptions) {
    this.buttonInteraction = options.still ? undefined : createButtonActivationGate(options);
    // Keep one group even in popover/opacity stacking contexts. Blended visual
    // clips borrow a live board base; clip ordering and native effects remain.
    this.root.style.isolation = 'isolate';
    try {
      this.updateBackdrop(clips);
      for (const clip of clips) this.elements.set(clip.id, { clip, renderer: this.create(clip) });
    }
    catch (error) { this.dispose(); throw error; }
  }
  private updateBackdrop(clips: readonly SequenceClip[]): void {
    const required = clips.some(clip => (clip.type === 'video' || clip.type === 'image' || clip.type === 'solid')
      && (clip.appearance?.blendMode ?? 'normal') !== 'normal');
    if (required && !this.backdrop) {
      this.backdrop = new VideoBlendBackdrop(this.root, this.options);
      // Subscribe before asynchronous media preparation, while still detached.
      this.options.boardBackdrop?.(this.root.getBoundingClientRect(), this.options.signal);
    } else if (!required && this.backdrop) { this.backdrop.dispose(); this.backdrop = null; this.cancelVisual(); }
  }
  private cancelVisual(): void {
    if (this.visualRequest !== null) cancelAnimationFrame(this.visualRequest);
    this.visualRequest = null;
  }
  private paintBackdrop(): void {
    if (this.disposed || this.options.signal.aborted || !this.lastFrame || !this.backdrop) return;
    const active = new Map(this.lastFrame.items.map(item => [item.clip.id, item]));
    const result = this.backdrop.draw(active, this.elements, this.lastFrame.opacity);
    this.root.style.opacity = result === 'pending' ? '0' : String(this.lastFrame.opacity);
    if (result === 'inactive') { this.cancelVisual(); return; }
    // A visual refresh never changes a paused/still decoder's timeline anchor.
    if (this.visualRequest === null) this.visualRequest = requestAnimationFrame(() => {
      this.visualRequest = null;
      try {
        for (const entry of this.elements.values()) entry.renderer.refreshVisual?.();
        this.paintBackdrop();
      } catch (error) {
        this.dispose();
        if (this.options.onError) this.options.onError(error);
        else throw error;
      }
    });
  }
  private create(clip: SequenceClip): ElementRenderer {
    switch (clip.type) {
      case 'bars': return barsRenderer(clip, this.root);
      case 'text': return textRenderer(clip, this.root, this.size, this.options);
      case 'image': return imageRenderer(clip, this.root, this.size, this.options);
      case 'solid': return solidRenderer(clip, this.root, this.size, this.options);
      case 'button': return buttonRenderer(clip, this.root, this.size, this.options, this.buttonInteraction);
      case 'audio': return audioRenderer(clip, this.root, { ...this.options,
        createAudioContext: () => this.audioContext ??= new AudioContext() });
      case 'video': return videoRenderer(clip, this.root, { ...this.options,
        createVideoKeyingFilter: () => new VideoKeyingFilter(this.keyingPool ??= new VideoKeyingPool()) }, this.size);
    }
  }
  async prepare(): Promise<void> { await Promise.all([...this.elements.values()].map(element => element.renderer.prepare())); }
  /** Resource compatibility is checked by the private preview player first. */
  updatePreview(clips: readonly SequenceClip[]): void {
    if (this.disposed) return;
    this.updateBackdrop(clips);
    this.previewOrder = true;
    for (const clip of clips) {
      const entry = this.elements.get(clip.id);
      if (!entry) continue;
      entry.clip = clip;
      this.elements.delete(clip.id);
      this.elements.set(clip.id, entry);
      // Keep live media connected in place. Re-appending a decoder can invoke
      // browser removal steps even when its source and renderer are retained.
    }
  }
  async updateStill(clips: readonly SequenceClip[]): Promise<void> {
    if (!this.options.still || this.disposed) return;
    this.updateBackdrop(clips);
    const keep = new Set(clips.map(clip => clip.id));
    for (const [id, entry] of this.elements) {
      if (!keep.has(id)) { entry.renderer.dispose(); this.elements.delete(id); }
    }
    const prepares: Promise<void>[] = [];
    for (const clip of clips) {
      const old = this.elements.get(clip.id);
      if (old && JSON.stringify(old.clip) === JSON.stringify(clip)) {
        // Scrubbing changes time, not clip properties. Retain prepared nodes.
        this.root.append(old.renderer.node); continue;
      }
      if (old && old.clip.type === 'video' && clip.type === 'video'
          && old.clip.properties.source.path === clip.properties.source.path
          && old.clip.properties.durationMs === clip.properties.durationMs
          && old.clip.properties.sourceRange?.inMs === clip.properties.sourceRange?.inMs
          && old.clip.properties.sourceRange?.outMs === clip.properties.sourceRange?.outMs) {
        old.renderer.updateAppearance?.(clip);
        old.renderer.node.style.objectFit = clip.properties.fit;
        setClipBlend(old.renderer.node, clip);
        this.elements.set(clip.id, { clip, renderer: old.renderer });
        this.root.append(old.renderer.node); continue;
      }
      if (old && old.clip.type === 'text' && clip.type === 'text'
          && old.clip.properties.fontFamily === clip.properties.fontFamily
          && old.clip.properties.text === clip.properties.text) {
        old.renderer.updateAppearance?.(clip);
        this.elements.set(clip.id, { clip, renderer: old.renderer });
        this.root.append(old.renderer.node); continue;
      }
      if (old && old.clip.type === 'image' && clip.type === 'image'
          && old.clip.properties.source.path === clip.properties.source.path) {
        old.renderer.updateAppearance?.(clip);
        setClipBlend(old.renderer.node, clip);
        this.elements.set(clip.id, { clip, renderer: old.renderer });
        this.root.append(old.renderer.node); continue;
      }
      if (old && old.clip.type === 'solid' && clip.type === 'solid'
          && old.clip.properties.alphaMap?.path === clip.properties.alphaMap?.path) {
        old.renderer.updateAppearance?.(clip);
        this.elements.set(clip.id, { clip, renderer: old.renderer });
        this.root.append(old.renderer.node); continue;
      }
      if (old && old.clip.type === 'button' && clip.type === 'button'
          && buttonTextureKey(old.clip) === buttonTextureKey(clip)) {
        old.renderer.updateAppearance?.(clip);
        this.elements.set(clip.id, { clip, renderer: old.renderer });
        this.root.append(old.renderer.node); continue;
      }
      old?.renderer.dispose();
      const renderer = this.create(clip);
      this.elements.set(clip.id, { clip, renderer }); prepares.push(renderer.prepare());
      this.root.append(renderer.node);
    }
    await Promise.all(prepares);
    this.keyingPool?.trim();
    if (!clips.some(clip => clip.type === 'video' && clip.properties.keying?.enabled)) {
      this.keyingPool?.dispose(); this.keyingPool = null;
    }
  }
  draw(frame: PlayerFrame): void {
    if (this.disposed) return;
    this.lastFrame = frame;
    this.root.style.opacity = String(frame.opacity);
    this.buttonInteraction?.setActiveHold(frame.phase === 'holding' ? frame.breakId ?? TERMINAL_BUTTON_HOLD_KEY : undefined);
    const active = new Map(frame.items.map(item => [item.clip.id, item]));
    // Release first, independent of track order: the next sequential keyed clip
    // can reuse the previous GPU canvas rather than allocate another context.
    for (const [id, entry] of this.elements) {
      const item = active.get(id);
      if (!item || (item.clip.type === 'video' && !item.clip.properties.keying?.enabled)) entry.renderer.deactivateVisual?.();
    }
    let order = 0;
    for (const [id, entry] of this.elements) {
      entry.renderer.draw(active.get(id), frame);
      if (this.previewOrder) entry.renderer.node.style.zIndex = String(++order);
    }
    this.keyingPool?.trim();
    this.paintBackdrop();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelVisual(); this.lastFrame = null;
    this.backdrop?.dispose(); this.backdrop = null;
    for (const entry of this.elements.values()) { try { entry.renderer.dispose(); } catch { /* Continue releasing all elements. */ } }
    this.buttonInteraction?.dispose();
    if (this.audioContext) void this.audioContext.close().catch(() => {});
    this.audioContext = null;
    this.keyingPool?.dispose(); this.keyingPool = null;
    this.elements.clear(); this.root.remove();
  }
}
