import type { VideoKeying } from '../domain/sequence.js';
import { MediaPreparationError } from './media-preparation.js';

export type KeyRGB = readonly [number, number, number];

export function keyRGB(color: string): KeyRGB {
  return [parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255];
}

/** Mirrors the shader: normalized RGB distance followed by a smooth alpha edge. */
export function keyAlpha(rgb: KeyRGB, key: KeyRGB, tolerance: number, softness: number): number {
  const distance = Math.hypot(rgb[0] - key[0], rgb[1] - key[1], rgb[2] - key[2]) / Math.sqrt(3);
  if (softness === 0) return distance > tolerance ? 1 : 0;
  const edge = Math.max(0, Math.min(1, (distance - tolerance) / softness));
  return edge * edge * (3 - 2 * edge);
}

export const KEYING_FRAGMENT_SHADER = `
precision highp float;
varying vec2 uv;
uniform sampler2D image;
uniform vec3 keyColor;
uniform float tolerance;
uniform float softness;
void main() {
  vec4 pixel = texture2D(image, uv);
  float distance = length(pixel.rgb - keyColor) / sqrt(3.0);
  float alpha = softness <= 0.0 ? (distance > tolerance ? 1.0 : 0.0)
    : smoothstep(tolerance, tolerance + softness, distance);
  alpha *= pixel.a;
  gl_FragColor = vec4(pixel.rgb * alpha, alpha);
}`;

export interface KeyingSize { readonly width: number; readonly height: number }

/** Physical pixels occupied by the fitted source; never upscale the native image. */
export function keyingTargetSize(source: KeyingSize, surface: KeyingSize, fit: 'contain' | 'cover', ratio = 1): KeyingSize {
  if (!(surface.width > 0 && surface.height > 0)) return source;
  const scale = Math.min(1, Math.max(1, ratio) * (fit === 'cover'
    ? Math.max(surface.width / source.width, surface.height / source.height)
    : Math.min(surface.width / source.width, surface.height / source.height)));
  return { width: Math.max(1, Math.ceil(source.width * scale)), height: Math.max(1, Math.ceil(source.height * scale)) };
}

/** Direct GPU presentation target. Preserved scratch targets are overflow-only. */
export class VideoKeyingProcessor {
  readonly canvas = document.createElement('canvas');
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly buffer: WebGLBuffer;
  private readonly shaders: WebGLShader[] = [];
  private disposed = false;
  private lost = false;
  private readonly uniforms: { color: WebGLUniformLocation | null; tolerance: WebGLUniformLocation | null; softness: WebGLUniformLocation | null };
  private readonly validatedSources = new WeakMap<HTMLVideoElement, { source: string; width: number; height: number;
    outputWidth: number; outputHeight: number }>();
  private readonly contextLost = (event: Event) => { event.preventDefault(); this.lost = true; };

  constructor(preserveDrawingBuffer = false) {
    const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer });
    if (!gl) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', this.contextLost);
    const program = gl.createProgram(), texture = gl.createTexture(), buffer = gl.createBuffer();
    if (!program || !texture || !buffer) {
      if (program) gl.deleteProgram(program);
      if (texture) gl.deleteTexture(texture);
      if (buffer) gl.deleteBuffer(buffer);
      this.canvas.removeEventListener('webglcontextlost', this.contextLost);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
    }
    this.program = program; this.texture = texture; this.buffer = buffer;
    try {
      this.compile(gl.VERTEX_SHADER, 'attribute vec2 position; varying vec2 uv; void main(){ uv=vec2((position.x+1.0)/2.0,(1.0-position.y)/2.0); gl_Position=vec4(position,0.0,1.0); }');
      this.compile(gl.FRAGMENT_SHADER, KEYING_FRAGMENT_SHADER);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.uniform1i(gl.getUniformLocation(program, 'image'), 0);
      this.uniforms = { color: gl.getUniformLocation(program, 'keyColor'), tolerance: gl.getUniformLocation(program, 'tolerance'),
        softness: gl.getUniformLocation(program, 'softness') };
      gl.disable(gl.BLEND);
    } catch (error) { this.dispose(); throw error; }
  }

  private compile(type: number, source: string): void {
    const shader = this.gl.createShader(type);
    if (!shader) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
    this.shaders.push(shader); this.gl.shaderSource(shader, source); this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
    this.gl.attachShader(this.program, shader);
  }

  assertAvailable(): void {
    if (this.disposed) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
    if (this.lost || this.gl.isContextLost()) throw new MediaPreparationError('VIDEO_KEYING_CONTEXT_LOST');
  }

  draw(video: HTMLVideoElement, settings: VideoKeying, size: KeyingSize = { width: video.videoWidth, height: video.videoHeight }): HTMLCanvasElement | null {
    this.assertAvailable();
    if (video.readyState < 2 || video.seeking) return null;
    const { width, height } = size;
    if (!(width > 0 && height > 0 && video.videoWidth > 0 && video.videoHeight > 0)) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    gl.viewport(0, 0, width, height); gl.useProgram(this.program); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const key = keyRGB(settings.color);
    gl.uniform3f(this.uniforms.color, ...key);
    gl.uniform1f(this.uniforms.tolerance, settings.tolerance);
    gl.uniform1f(this.uniforms.softness, settings.softness);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); }
    catch { throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE'); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Detect unsupported native upload sizes/sources once, rather than forcing
    // a GPU error round trip on every frame. Context loss is checked separately.
    const source = video.currentSrc || video.src, previous = this.validatedSources.get(video);
    if (!previous || previous.source !== source
        || previous.width !== video.videoWidth || previous.height !== video.videoHeight
        || previous.outputWidth !== width || previous.outputHeight !== height) {
      if (gl.getError() !== gl.NO_ERROR) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
      this.validatedSources.set(video, { source, width: video.videoWidth, height: video.videoHeight, outputWidth: width, outputHeight: height });
    }
    return this.canvas;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const shader of this.shaders) this.gl.deleteShader(shader);
    this.gl.deleteBuffer(this.buffer); this.gl.deleteTexture(this.texture); this.gl.deleteProgram(this.program);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.width = 0; this.canvas.height = 0; this.canvas.remove();
  }
}

/**
 * Reserve context headroom for Foundry and other surfaces. More overlapping
 * clips remain supported through independent caches on one overflow processor.
 */
export const MAX_DIRECT_KEYING_CONTEXTS = 4;
interface KeyingLease { readonly processor: VideoKeyingProcessor; readonly direct: boolean }

export class VideoKeyingPool {
  private readonly direct = new Map<VideoKeyingProcessor, boolean>();
  private scratch: VideoKeyingProcessor | null = null;
  private overflow = 0;
  private disposed = false;

  prepare(): void {
    if (this.disposed) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
    if (!this.direct.size) this.direct.set(new VideoKeyingProcessor(), false);
    for (const processor of this.direct.keys()) processor.assertAvailable();
  }
  acquire(): KeyingLease {
    this.prepare();
    for (const [processor, busy] of this.direct) {
      if (!busy) { this.direct.set(processor, true); return { processor, direct: true }; }
    }
    if (this.direct.size < MAX_DIRECT_KEYING_CONTEXTS) {
      const processor = new VideoKeyingProcessor(); this.direct.set(processor, true);
      return { processor, direct: true };
    }
    const processor = this.scratch ??= new VideoKeyingProcessor(true);
    this.overflow += 1;
    return { processor, direct: false };
  }
  promote(lease: KeyingLease): KeyingLease {
    if (lease.direct || (this.direct.size >= MAX_DIRECT_KEYING_CONTEXTS && ![...this.direct.values()].some(busy => !busy))) return lease;
    this.release(lease); return this.acquire();
  }
  release(lease: KeyingLease): void {
    lease.processor.canvas.remove();
    if (this.disposed) return;
    if (lease.direct) this.direct.set(lease.processor, false);
    else this.overflow = Math.max(0, this.overflow - 1);
  }
  /** Retain one warm idle target, never historical peak-concurrency resources. */
  trim(): void {
    if (this.disposed) return;
    let idle = 0;
    for (const [processor, busy] of this.direct) {
      if (!busy && idle++ > 0) { processor.dispose(); this.direct.delete(processor); }
    }
    if (!this.overflow) { this.scratch?.dispose(); this.scratch = null; }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const processor of this.direct.keys()) processor.dispose();
    this.direct.clear(); this.scratch?.dispose(); this.scratch = null;
  }
}

/** Stable clip layer with a leased direct GPU canvas or an overflow frame cache. */
export class VideoKeyingFilter {
  readonly node = document.createElement('div');
  /** Surface failure stays observable while a normal keyed clip is paused. */
  onContextLost?: () => void;
  private readonly pool: VideoKeyingPool;
  private readonly ownsPool: boolean;
  private lease: KeyingLease | null = null;
  private copy: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null = null;
  private disposed = false;
  private readonly contextLost = () => { if (!this.disposed && this.lease) this.onContextLost?.(); };
  private rendered: { video: HTMLVideoElement; source: string; width: number; height: number;
    outputWidth: number; outputHeight: number; frame: number; color: string; tolerance: number; softness: number } | null = null;

  constructor(pool?: VideoKeyingPool) {
    this.ownsPool = pool === undefined;
    this.pool = pool ?? new VideoKeyingPool();
    this.pool.prepare();
  }

  /** Available after the first active draw; never allocate an inactive output. */
  get canvas(): HTMLCanvasElement {
    const canvas = this.copy?.canvas ?? this.lease?.processor.canvas;
    if (!canvas) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
    return canvas;
  }

  /** Optional physical base size excludes animated CSS scaling to keep GPU targets stable. */
  draw(video: HTMLVideoElement, settings: VideoKeying, fit: 'contain' | 'cover' = 'contain', surface?: KeyingSize): void {
    if (this.disposed) return;
    // Context loss remains observable even when a paused private frame is cached.
    this.lease?.processor.assertAvailable();
    if (video.readyState < 2 || video.seeking) return;
    const previousLease = this.lease;
    this.lease = previousLease ? this.pool.promote(previousLease) : this.pool.acquire();
    if (previousLease !== this.lease) {
      previousLease?.processor.canvas.removeEventListener('webglcontextlost', this.contextLost);
      this.lease.processor.canvas.addEventListener('webglcontextlost', this.contextLost);
      this.invalidate(); this.releaseCopy();
      if (!this.lease.direct) {
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { alpha: true });
        if (!context) throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE');
        this.copy = { canvas, context };
      }
      this.node.append(this.canvas);
    }
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: fit, pointerEvents: 'none' });
    const size = keyingTargetSize({ width: video.videoWidth, height: video.videoHeight }, surface ?? this.node.getBoundingClientRect(), fit, globalThis.devicePixelRatio || 1);
    // Playback-quality counters can remain batched while source time and decoded
    // images advance. They are statistics, not a reliable frame-cache identity.
    // Unchanged paused time still reuses the output; seeks/loads invalidate it.
    const frame = video.currentTime;
    const source = video.currentSrc || video.src;
    const cached = this.rendered;
    if (cached && cached.video === video && cached.source === source
        && cached.width === video.videoWidth && cached.height === video.videoHeight && cached.frame === frame
        && cached.outputWidth === size.width && cached.outputHeight === size.height
        && cached.color === settings.color && cached.tolerance === settings.tolerance && cached.softness === settings.softness) return;
    const image = this.lease.processor.draw(video, settings, size);
    if (!image) return;
    if (this.copy) {
      if (this.copy.canvas.width !== image.width || this.copy.canvas.height !== image.height) {
        this.copy.canvas.width = image.width; this.copy.canvas.height = image.height;
      }
      // Overflow caches replace transparent pixels as well as opaque ones.
      this.copy.context.globalCompositeOperation = 'copy';
      try { this.copy.context.drawImage(image, 0, 0); }
      catch { throw new MediaPreparationError('VIDEO_KEYING_UNAVAILABLE'); }
    }
    this.rendered = { video, source, width: video.videoWidth, height: video.videoHeight, frame,
      outputWidth: size.width, outputHeight: size.height, color: settings.color, tolerance: settings.tolerance, softness: settings.softness };
  }

  /** A seek/load may replace decoded pixels even at the same source time. */
  invalidate(): void { this.rendered = null; }

  private releaseCopy(): void {
    if (!this.copy) return;
    this.copy.canvas.width = 0; this.copy.canvas.height = 0; this.copy.canvas.remove(); this.copy = null;
  }
  deactivate(): void {
    if (this.lease) {
      this.lease.processor.canvas.removeEventListener('webglcontextlost', this.contextLost);
      this.pool.release(this.lease);
    }
    this.lease = null; this.releaseCopy(); this.invalidate();
    if (this.ownsPool) this.pool.trim();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deactivate(); this.node.remove();
    if (this.ownsPool) this.pool.dispose();
  }
}
