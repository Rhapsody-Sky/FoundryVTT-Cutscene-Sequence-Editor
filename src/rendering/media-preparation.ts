export class MediaPreparationError extends Error {
  constructor(readonly code: string, readonly path?: string) {
    super(code);
    this.name = 'MediaPreparationError';
  }
}

export function assertFoundryMediaPath(path: string): void {
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new MediaPreparationError('MEDIA_INVALID_PATH'); }
  if (!path.trim() || path !== path.trim() || decoded !== decoded.trim() || path.length > 2048 || /[\\\u0000-\u001f\u007f?#]/.test(decoded)
      || decoded.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(decoded)
      || decoded.split('/').some(part => part === '..' || part === '.')) {
    throw new MediaPreparationError('MEDIA_INVALID_PATH', path);
  }
}

export function abortError(): DOMException { return new DOMException('Aborted', 'AbortError'); }

/** The abort/timeout branch removes listeners even when play() never settles. */
export function bounded<T>(promise: Promise<T>, signal: AbortSignal, milliseconds: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      // The browser operation has already started; still consume a later rejection
      // after cancellation so it cannot escape as an unhandled play/font failure.
      void promise.catch(() => {});
      reject(abortError()); return;
    }
    const done = (action: () => void) => { clearTimeout(timer); signal.removeEventListener('abort', abort); action(); };
    const abort = () => done(() => reject(abortError()));
    const timer = setTimeout(() => done(() => reject(new MediaPreparationError(code))), Math.max(1, milliseconds));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => done(() => resolve(value)), error => done(() => reject(error)));
  });
}

export function waitForMedia(video: HTMLMediaElement, signal: AbortSignal, predicate: () => boolean,
  milliseconds: number, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'progress', 'seeked', 'durationchange'];
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      video.removeEventListener('error', error);
      for (const event of events) video.removeEventListener(event, check);
    };
    const check = () => { if (predicate()) { clean(); resolve(); } };
    const abort = () => { clean(); reject(abortError()); };
    const error = () => { clean(); reject(new MediaPreparationError('MEDIA_LOAD_FAILED', video.getAttribute('src') ?? undefined)); };
    const timer = setTimeout(() => { clean(); reject(new MediaPreparationError(code)); }, Math.max(1, milliseconds));
    signal.addEventListener('abort', abort, { once: true });
    video.addEventListener('error', error);
    for (const event of events) video.addEventListener(event, check);
    if (video.error) error(); else check();
  });
}

/** Compatibility alias for existing video consumers. */
export const waitForVideo = waitForMedia;

export function hasStartBuffer(video: Pick<HTMLVideoElement, 'duration' | 'readyState' | 'buffered'>): boolean {
  if (video.readyState < 2 || !Number.isFinite(video.duration) || video.duration <= 0) return false;
  const target = Math.min(2, video.duration);
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) <= 0.05 && video.buffered.end(index) >= target - Math.min(0.05, target * 0.1)) return true;
  }
  return false;
}

export function releaseMedia(video: HTMLMediaElement): void {
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.remove();
}

export const releaseVideo = releaseMedia;

/** Audio inspection retains only browser metadata and never starts playback. */
export async function probeAudio(path: string, signal: AbortSignal): Promise<{ durationMs: number }> {
  assertFoundryMediaPath(path);
  if (signal.aborted) throw abortError();
  const audio = document.createElement('audio');
  audio.preload = 'metadata'; audio.muted = true; audio.volume = 0;
  try {
    audio.src = path; audio.load();
    await waitForMedia(audio, signal, () => audio.readyState >= 1, 30_000, 'MEDIA_TIMEOUT');
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new MediaPreparationError('MEDIA_LOAD_FAILED', path);
    return { durationMs: Math.round(audio.duration * 1000) };
  } finally { releaseMedia(audio); }
}

/** Editor metadata only; no play, audio context, overlay, or full-file Blob download. */
export async function probeVideo(path: string, signal: AbortSignal): Promise<{ durationMs: number }> {
  assertFoundryMediaPath(path);
  if (signal.aborted) throw abortError();
  const video = document.createElement('video');
  video.preload = 'metadata'; video.muted = true; video.playsInline = true;
  try {
    video.src = path; video.load();
    await waitForVideo(video, signal, () => video.readyState >= 1, 30_000, 'MEDIA_TIMEOUT');
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new MediaPreparationError('MEDIA_LOAD_FAILED', path);
    return { durationMs: Math.round(video.duration * 1000) };
  } finally { releaseVideo(video); }
}
