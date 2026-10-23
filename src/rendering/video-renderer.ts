import { videoBoxRect } from './video-geometry.js';
import { videoContentRect } from './video-blend-backdrop.js';
import type { VideoClip } from '../domain/sequence.js';
import { videoDurationMs } from '../domain/clip-timing.js';
import type { FrameItem } from '../playback/evaluate.js';
import type { PlayerFrame } from '../playback/local-player.js';
import type { ElementRenderer, RendererOptions } from './element-renderer.js';
import { abortError, assertFoundryMediaPath, bounded, hasStartBuffer, MediaPreparationError, releaseVideo, waitForVideo } from './media-preparation.js';
import { videoSync } from './video-sync.js';
import { drawClipAppearance, setClipBlend } from './clip-appearance.js';
import { VideoKeyingFilter } from './video-keying.js';

export function videoRenderer(clip: VideoClip, parent: HTMLElement, options: RendererOptions, size: { width: number; height: number } = { width: 1920, height: 1080 }): ElementRenderer {
  assertFoundryMediaPath(clip.properties.source.path);
  const video = document.createElement('video');
  video.className = 'stagecraft-video-layer'; video.dataset.clipId = clip.id;
  video.playsInline = true; video.preload = 'auto'; video.controls = false;
  video.disablePictureInPicture = true;
  video.muted = options.still === true || clip.properties.muted || clip.properties.volume === 0;
  video.volume = 0;
  Object.assign(video.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
    objectFit: clip.properties.fit, backgroundColor: '#000', pointerEvents: 'none', opacity: '0' });
  setClipBlend(video, clip);
  parent.append(video);
  const events = new AbortController();
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  let context: AudioContext | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let localVolume = options.playbackVolume?.value ?? 1;
  let unsubscribeVolume: (() => void) | undefined;
  const releaseVolume = () => { unsubscribeVolume?.(); unsubscribeVolume = undefined; };
  let disposed = false;
  let prepared = false;
  let failure: unknown;
  let lastFrame: PlayerFrame | null = null;
  let lastItem: FrameItem | undefined;
  let visualClip = clip;
  let keyingSurface: { width: number; height: number } | undefined;
  let keying: VideoKeyingFilter | null = null;
  let pendingSeek = false;
  let pendingPlay = false;
  let playGeneration = 0;
  let decoderEnded = false;
  let lastConsumedBreakId: string | undefined;
  let resyncBreakId: string | null = null;
  let lastMediaTimeMs: number | null = null;
  let lastMediaCycle: number | undefined;
  // Record the cycle actually submitted to the decoder, rather than the last
  // frame received while a seek is pending. Its completion reconciles that frame.
  let loopPosition: { cycle: number; localTimeMs: number; periodMs: number; startMs: number } | null = null;
  let bufferTimer: ReturnType<typeof setTimeout> | null = null;
  const fail = (error: unknown) => {
    if (disposed || failure !== undefined) return;
    failure = error; releaseVolume(); pause(); clearBuffer(); silence();
    options.onError?.(error);
  };
  const clearBuffer = () => { if (bufferTimer !== null) clearTimeout(bufferTimer); bufferTimer = null; };
  const silence = () => { if (gain) gain.gain.value = 0; else video.volume = 0; };
  const pause = () => { playGeneration += 1; pendingPlay = false; video.pause(); };
  const abortFromSurface = () => { releaseVolume(); lifetime.abort(); events.abort(); pause(); clearBuffer(); silence(); };
  if (options.signal.aborted) abortFromSurface();
  else options.signal.addEventListener('abort', abortFromSurface, { once: true });
  const currentClip = () => lastItem?.clip.type === 'video' ? lastItem.clip : clip;
  const presentation = () => keying?.node ?? video;
  const layout = () => {
    const box = visualClip.properties.box;
    const motion = visualClip.typeVersion === 7 ? lastItem?.textTransform : undefined;
    const viewport = { width: parent.clientWidth, height: parent.clientHeight };
    const rect = box ? videoBoxRect(visualClip, viewport, size) : undefined;
    if (visualClip.typeVersion === 7 && keying) {
      // Parent bounds retain editor/ancestor CSS scaling, while excluding this
      // layer's motion. Older clips keep their historical measured sizing.
      const bounds = parent.getBoundingClientRect();
      const surface = rect ?? viewport;
      keyingSurface = { width: viewport.width > 0 ? surface.width * bounds.width / viewport.width : surface.width,
        height: viewport.height > 0 ? surface.height * bounds.height / viewport.height : surface.height };
    } else keyingSurface = undefined;
    const scale = Math.min(viewport.width / size.width, viewport.height / size.height);
    for (const layer of [video, ...(keying ? [keying.node] : [])]) {
      // Keep the decoder/GPU output size stable through zooms. CSS presents the
      // existing surface; blend footprints use the same projected transform.
      layer.style.transformOrigin = 'center center';
      layer.style.transform = motion ? `translate(${motion.x * scale}px, ${motion.y * scale}px) scale(${motion.scale})` : '';
      if (!rect) { Object.assign(layer.style, { inset: '0', left: '0', top: '0', width: '100%', height: '100%' }); continue; }
      Object.assign(layer.style, { inset: 'auto', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { layout(); refreshVisual(); });
  observer?.observe(parent);
  const updateAppearance = (next: VideoClip) => {
    visualClip = next;
    if (next.properties.keying?.enabled) {
      if (!keying) {
        keying = options.createVideoKeyingFilter?.() ?? new VideoKeyingFilter();
        keying.onContextLost = () => fail(new MediaPreparationError('VIDEO_KEYING_CONTEXT_LOST'));
        const layer = keying.node;
        layer.className = 'stagecraft-video-layer stagecraft-video-keyed'; layer.dataset.clipId = clip.id;
        Object.assign(layer.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
          pointerEvents: 'none', opacity: '0', backgroundColor: 'transparent' });
        parent.insertBefore(layer, video);
      }
      video.style.opacity = '0';
    } else if (keying) { keying.dispose(); keying = null; }
    presentation().style.objectFit = next.properties.fit;
    // A blended/keyed contained image exposes the board outside its content.
    presentation().style.backgroundColor = keying || (next.appearance?.blendMode ?? 'normal') !== 'normal' ? 'transparent' : '#000';
    setClipBlend(presentation(), next);
    layout();
  };
  const refreshVisual = () => {
    if (disposed || failure !== undefined || !keying || !lastItem || !visualClip.properties.keying?.enabled) return;
    try { keying.draw(video, visualClip.properties.keying, visualClip.properties.fit, keyingSurface); }
    catch (error) { fail(error); }
  };
  const sourceEndSeconds = () => {
    const range = currentClip().properties.sourceRange;
    return range ? Math.min(range.outMs / 1000, video.duration) : video.duration;
  };
  const selectedDurationMs = () => Math.min(videoDurationMs(currentClip()) ?? 0,
    sourceEndSeconds() * 1000 - (currentClip().properties.sourceRange?.inMs ?? 0));
  const resolvedPosition = (item: FrameItem) => {
    const startMs = currentClip().properties.sourceRange?.inMs ?? 0;
    // Authored metadata is the shared clock period. A tolerated shorter decoder
    // holds its last frame until this period ends, rather than accumulating drift.
    const periodMs = videoDurationMs(currentClip()) ?? 0;
    const looping = item.videoLoop === true && periodMs > 0;
    const anchored = item.mediaTimeMs !== undefined;
    const localTimeMs = Math.max(0, item.mediaTimeMs ?? item.localTimeMs);
    const mediaTimeMs = anchored && decoderEnded ? selectedDurationMs()
      : !anchored && looping ? localTimeMs % periodMs : localTimeMs;
    return { startMs, periodMs, looping, localTimeMs,
      cycle: looping ? item.mediaCycle ?? Math.floor(localTimeMs / periodMs) : 0,
      sourceTimeMs: startMs + mediaTimeMs,
      playable: mediaTimeMs < selectedDurationMs() };
  };
  const expectsPlayback = () => failure === undefined && !disposed && !signal.aborted
    && !options.still && lastItem !== undefined
    && (lastItem.mediaPlayback === undefined ? lastFrame?.phase === 'playing'
      : lastFrame?.phase !== 'paused' && !decoderEnded && lastItem.mediaPlayback !== 'paused' && lastItem.mediaPlayback !== 'finished')
    && resolvedPosition(lastItem).playable;
  const applyVolume = () => {
    video.muted = options.still === true || currentClip().properties.muted || currentClip().properties.volume === 0;
    const envelope = prepared && !disposed && !signal.aborted && failure === undefined && !pendingSeek
      && !options.still && lastItem && lastFrame && lastFrame.phase !== 'paused'
      && (lastItem.mediaPlayback === undefined || expectsPlayback()) ? lastItem.opacity * lastFrame.opacity : 0;
    video.volume = gain ? currentClip().properties.volume : currentClip().properties.volume * envelope * localVolume;
    if (gain) gain.gain.value = envelope * localVolume;
  };
  const guardedPlay = () => {
    const generation = playGeneration;
    return video.play().then(() => {
      // This guard also runs after a bounded wait has aborted or timed out. Native
      // play promises may settle late during preparation, unlock, or playback.
      if (generation !== playGeneration || !prepared || !expectsPlayback() || pendingSeek) { silence(); video.pause(); }
    });
  };
  const waitBuffer = () => {
    if (!prepared || !expectsPlayback() || pendingSeek || (video.ended && !lastItem?.videoLoop) || bufferTimer !== null) return;
    bufferTimer = setTimeout(() => { bufferTimer = null; fail(new MediaPreparationError('MEDIA_BUFFER_TIMEOUT')); }, 8000);
  };
  const seek = (seconds: number): Promise<void> => {
    if (signal.aborted) return Promise.reject(abortError());
    pendingSeek = true; silence();
    try { video.currentTime = seconds; } catch (error) { pendingSeek = false; return Promise.reject(error); }
    return waitForVideo(video, signal, () => !video.seeking && video.readyState >= 2, 8000, 'MEDIA_SEEK_FAILED')
      .finally(() => { pendingSeek = false; });
  };
  const hasClipStartBuffer = () => {
    const range = clip.properties.sourceRange;
    if (!range) return hasStartBuffer(video);
    if (video.readyState < 2) return false;
    const start = range.inMs / 1000;
    const target = Math.min(start + 2, range.outMs / 1000, video.duration);
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= start + 0.05
          && video.buffered.end(index) >= target - Math.min(0.05, (target - start) * 0.1)) return true;
    }
    return false;
  };
  const play = () => {
    if (disposed || pendingPlay || !video.paused || !expectsPlayback()) return;
    pendingPlay = true;
    const generation = ++playGeneration;
    const resumed = context?.state === 'suspended' ? context.resume() : Promise.resolve();
    const played = guardedPlay();
    bounded(Promise.all([played, resumed]), signal, 8000, 'MEDIA_BUFFER_TIMEOUT').then(() => {
      if (disposed || !expectsPlayback() || pendingSeek) video.pause();
    }, error => {
      if (!disposed && !signal.aborted && generation === playGeneration && expectsPlayback() && !pendingSeek) {
        fail(error instanceof MediaPreparationError ? error : new MediaPreparationError('MEDIA_AUTOPLAY'));
      }
    }).finally(() => { if (generation === playGeneration) pendingPlay = false; });
  };
  video.addEventListener('error', () => { if (prepared) fail(new MediaPreparationError('MEDIA_LOAD_FAILED')); }, { signal: events.signal });
  video.addEventListener('durationchange', () => {
    if (prepared && (!Number.isFinite(video.duration) || Math.abs(video.duration * 1000 - (clip.properties.durationMs ?? 0)) > 250
        || (clip.properties.sourceRange?.inMs ?? 0) / 1000 >= video.duration)) {
      fail(new MediaPreparationError('MEDIA_DURATION_CHANGED'));
    }
  }, { signal: events.signal });
  for (const event of ['waiting', 'stalled']) video.addEventListener(event, waitBuffer, { signal: events.signal });
  for (const event of ['playing', 'canplay', 'seeked']) video.addEventListener(event, () => {
    if (video.readyState >= 3 && !video.seeking) clearBuffer();
  }, { signal: events.signal });
  for (const event of ['loadeddata', 'seeked', 'emptied']) video.addEventListener(event, () => {
    keying?.invalidate();
    if (prepared && event !== 'emptied') refreshVisual();
  }, { signal: events.signal });
  video.addEventListener('ended', () => {
    // Native source endings are decoder events, never an independent loop clock.
    // Recover against the most recently supplied absolute timeline frame.
    if (prepared && lastItem?.videoLoop && lastFrame && expectsPlayback()) {
      try { renderer.draw(lastItem, lastFrame); } catch (error) { fail(error); }
    }
  }, { signal: events.signal });
  const anchoredSourceEnded = (reconcile = true) => {
    if (!prepared || lastItem?.mediaTimeMs === undefined || !expectsPlayback() || pendingSeek) return;
    if (!video.ended && video.currentTime < sourceEndSeconds()) return;
    // A decoder may reach its native/trimmed end slightly before the shared
    // clock. Hold its final image until that clock finishes or wraps; play() on
    // a native ended element would otherwise restart a one-shot finish.
    decoderEnded = true; pause(); clearBuffer(); if (gain) gain.gain.value = 0;
    if (reconcile && lastFrame) {
      try { renderer.draw(lastItem, lastFrame); } catch (error) { fail(error); }
    }
  };
  for (const event of ['timeupdate', 'ended']) video.addEventListener(event, () => anchoredSourceEnded(), { signal: events.signal });
  const renderer: ElementRenderer = {
    get node() { return presentation(); },
    videoSource: () => video,
    updateAppearance(next) { if (next.type === 'video') updateAppearance(next); },
    refreshVisual,
    backdropFootprints(item, bounds) {
      const current = item.clip.type === 'video' ? item.clip : visualClip;
      const box = videoBoxRect(current, bounds, size, current.typeVersion === 7 ? item.textTransform : undefined);
      const content = videoContentRect(box.width, box.height, video.videoWidth, video.videoHeight, current.properties.fit);
      const x = box.x + content.x, y = box.y + content.y;
      return [{ points: [{ x, y }, { x: x + content.width, y }, { x: x + content.width, y: y + content.height }, { x, y: y + content.height }] }];
    },
    deactivateVisual() { keying?.deactivate(); },
    async prepare() {
      if (disposed || signal.aborted) throw abortError();
      if (failure !== undefined) throw failure;
      try {
        updateAppearance(visualClip);
        const deadline = performance.now() + 30_000;
        video.src = clip.properties.source.path; video.load();
        await waitForVideo(video, signal, () => video.readyState >= 1, deadline - performance.now(), 'MEDIA_TIMEOUT');
        if (!Number.isFinite(video.duration) || video.duration <= 0) throw new MediaPreparationError('MEDIA_LOAD_FAILED');
        if (Math.abs(video.duration * 1000 - (clip.properties.durationMs ?? 0)) > 250) throw new MediaPreparationError('MEDIA_DURATION_CHANGED');
        if (clip.properties.sourceRange) {
          if (clip.properties.sourceRange.inMs / 1000 >= video.duration) throw new MediaPreparationError('MEDIA_DURATION_CHANGED');
          await seek(clip.properties.sourceRange.inMs / 1000);
        }
        await waitForVideo(video, signal, hasClipStartBuffer, deadline - performance.now(), 'MEDIA_TIMEOUT');
        if (!options.still) {
          if (!video.muted) {
            if (typeof AudioContext === 'undefined') throw new MediaPreparationError('MEDIA_AUDIO_UNAVAILABLE');
            try {
              context = new AudioContext(); gain = context.createGain(); gain.gain.value = 0;
              source = context.createMediaElementSource(video); source.connect(gain); gain.connect(context.destination);
              // Keep audible permission preflight independent of the personal mute;
              // the downstream gain protects hidden preparation from producing sound.
              video.volume = clip.properties.volume;
            } catch { throw new MediaPreparationError('MEDIA_AUDIO_UNAVAILABLE'); }
          }
          let blocked = false;
          try { await bounded(guardedPlay(), signal, 8000, 'MEDIA_TIMEOUT'); }
          catch (error) {
            if (signal.aborted) throw abortError();
            if (error instanceof DOMException && error.name === 'NotAllowedError') blocked = true;
            else throw error instanceof MediaPreparationError ? error : new MediaPreparationError('MEDIA_LOAD_FAILED');
          } finally { video.pause(); }
          if (blocked || (context && context.state !== 'running')) {
            if (!options.requestAudioUnlock) throw new MediaPreparationError('MEDIA_AUTOPLAY');
            const unlock = async () => {
              if (disposed || signal.aborted) throw abortError();
              // Gesture-sensitive calls run synchronously inside the UI click callback.
              const resumed = context?.resume() ?? Promise.resolve();
              const played = guardedPlay();
              try { await bounded(Promise.all([resumed, played]), signal, 8000, 'MEDIA_AUTOPLAY'); }
              catch { throw signal.aborted ? abortError() : new MediaPreparationError('MEDIA_AUTOPLAY'); }
              finally { video.pause(); }
            };
            await bounded(options.requestAudioUnlock(unlock, signal), signal, 10 * 60_000, 'MEDIA_AUTOPLAY');
            if (context && context.state !== 'running') throw new MediaPreparationError('MEDIA_AUTOPLAY');
          }
        }
        video.pause();
        const initialSeconds = (clip.properties.sourceRange?.inMs ?? 0) / 1000;
        if (Math.abs(video.currentTime - initialSeconds) > 0.001) await seek(initialSeconds);
        if (disposed || signal.aborted) throw abortError();
        prepared = true;
        // Keying was preflighted above; decoded frames are uploaded only when the
        // player supplies an active item. Sequential clips do not allocate outputs.
      } catch (error) {
        if (!signal.aborted) failure = error;
        releaseVolume(); pause(); clearBuffer(); silence(); video.volume = 0;
        source?.disconnect(); gain?.disconnect();
        if (context) void context.close().catch(() => {});
        source = null; gain = null; context = null;
        throw error;
      }
    },
    draw(item, frame) {
      if (disposed) return;
      if (failure !== undefined) { if (!options.onError) throw failure; return; }
      lastFrame = frame; lastItem = item;
      const consumedBreak = frame.breakHistory?.at(-1);
      if (consumedBreak?.id !== lastConsumedBreakId) {
        lastConsumedBreakId = consumedBreak?.id;
        if (consumedBreak && item && currentClip().properties.onBreak === 'loop'
          && consumedBreak.positionMs >= currentClip().startMs) resyncBreakId = consumedBreak.id;
      }
      if (resyncBreakId !== null) decoderEnded = false;
      if (item?.mediaTimeMs !== undefined) {
        if (lastMediaTimeMs !== null && (item.mediaTimeMs < lastMediaTimeMs || item.mediaCycle !== lastMediaCycle)) decoderEnded = false;
        lastMediaTimeMs = item.mediaTimeMs; lastMediaCycle = item.mediaCycle;
      } else { decoderEnded = false; lastMediaTimeMs = null; lastMediaCycle = undefined; }
      if (!item) keying?.deactivate();
      if (item?.clip.type === 'video' && visualClip !== item.clip) updateAppearance(item.clip);
      layout();
      drawClipAppearance(presentation(), item);
      if (keying) video.style.opacity = '0';
      refreshVisual();
      if (disposed || failure !== undefined) return;
      // Legacy frames retain their historical envelope; Break frames explicitly
      // silence paused and completed decoders while their image remains visible.
      applyVolume();
      if (!item) { pause(); clearBuffer(); loopPosition = null; return; }
      const playing = expectsPlayback();
      if (!playing) { pause(); clearBuffer(); }
      // A newly supplied source cycle supersedes the previous decoder ending.
      if (resyncBreakId === null && (item.mediaCycle === undefined || loopPosition?.cycle === item.mediaCycle)) anchoredSourceEnded(false);
      const position = resolvedPosition(item);
      const sourceTimeMs = position.sourceTimeMs;
      const endSeconds = position.looping
        ? Math.min((position.startMs + position.periodMs) / 1000, sourceEndSeconds()) : sourceEndSeconds();
      const activePlayback = expectsPlayback();
      const sync = videoSync(video.currentTime, sourceTimeMs, endSeconds, activePlayback);
      video.playbackRate = sync.rate;
      const needsLoopSeek = position.looping && (loopPosition === null || loopPosition.cycle !== position.cycle
        || loopPosition.periodMs !== position.periodMs || loopPosition.startMs !== position.startMs
        || position.localTimeMs < loopPosition.localTimeMs || video.ended
        || (!activePlayback && Math.abs(video.currentTime - sync.targetSeconds) > 0.001));
      const needsFinalFrame = !activePlayback && sourceTimeMs >= endSeconds * 1000
        && Math.abs(video.currentTime - sync.targetSeconds) > 0.001;
      const exactPauseSeek = item.mediaTimeMs !== undefined && !activePlayback
        && Math.abs(video.currentTime - sync.targetSeconds) > 0.001;
      // A newly consumed inner Break demands one exact seek. An older pending
      // seek may finish first; its reconciliation submits the latest Continue
      // target without treating Finish media as a resynchronization request.
      const breakSeek = resyncBreakId !== null;
      if ((sync.seek || needsFinalFrame || needsLoopSeek || exactPauseSeek || breakSeek) && !pendingSeek
          && (breakSeek || needsLoopSeek || !activePlayback || bufferTimer === null || video.readyState >= 3)) {
        pause(); clearBuffer();
        video.playbackRate = 1;
        loopPosition = position.looping ? position : null;
        resyncBreakId = null;
        seek(sync.targetSeconds).then(() => {
          // A pause/new anchor may arrive while the decoder is seeking. Reconcile
          // that latest frame even when the paused player schedules no more RAFs.
          if (!disposed && lastFrame) {
            try { renderer.draw(lastItem, lastFrame); } catch (error) { fail(error); }
          }
        }, error => {
          if (!disposed && !signal.aborted) fail(error instanceof MediaPreparationError ? error : new MediaPreparationError('MEDIA_SEEK_FAILED'));
        });
      } else if (!pendingSeek) {
        loopPosition = position.looping ? position : null;
        play();
      }
      if (activePlayback && video.readyState < 3) waitBuffer();
    },
    dispose() {
      if (disposed) return;
      disposed = true; observer?.disconnect(); prepared = false; clearBuffer(); lifetime.abort(); events.abort();
      releaseVolume(); silence(); video.volume = 0;
      options.signal.removeEventListener('abort', abortFromSurface);
      if (gain) gain.gain.value = 0;
      source?.disconnect(); gain?.disconnect();
      if (context) void context.close().catch(() => {});
      keying?.dispose(); keying = null;
      releaseVideo(video); context = null; source = null; gain = null; lastFrame = null; lastItem = undefined; loopPosition = null;
    }
  };
  if (!signal.aborted) unsubscribeVolume = options.playbackVolume?.subscribe(value => {
    localVolume = value;
    if (!disposed && !signal.aborted && failure === undefined) applyVolume();
  });
  return renderer;
}
