import type { AudioClip } from '../domain/sequence.js';
import { mediaDurationMs } from '../domain/clip-timing.js';
import type { FrameItem } from '../playback/evaluate.js';
import type { PlayerFrame } from '../playback/local-player.js';
import type { ElementRenderer, RendererOptions } from './element-renderer.js';
import { abortError, assertFoundryMediaPath, bounded, MediaPreparationError, releaseMedia, waitForMedia } from './media-preparation.js';
import { videoSync } from './video-sync.js';

/** A streaming decoder controlled by the composition clock; never decodes a full audio file. */
export function audioRenderer(clip: AudioClip, parent: HTMLElement, options: RendererOptions): ElementRenderer {
  assertFoundryMediaPath(clip.properties.source.path);
  const audio = document.createElement('audio');
  audio.className = 'stagecraft-audio-layer'; audio.dataset.clipId = clip.id;
  audio.preload = 'auto'; audio.controls = false; audio.loop = false;
  audio.muted = options.still === true || clip.properties.muted;
  audio.volume = 0; audio.style.display = 'none'; parent.append(audio);
  const lifetime = new AbortController();
  const events = new AbortController();
  const signal = lifetime.signal;
  let disposed = false, prepared = false, pendingSeek = false, pendingPlay = false;
  let generation = 0;
  let failure: unknown;
  let lastFrame: PlayerFrame | null = null;
  let lastItem: FrameItem | undefined;
  let cycle: number | null = null;
  let lastLocalTimeMs = 0;
  let endedCycle: number | null = null;
  let lastConsumedBreakId: string | undefined;
  let resyncBreakId: string | null = null;
  let exitPlaying = false;
  let bufferTimer: ReturnType<typeof setTimeout> | null = null;
  let context: AudioContext | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let localVolume = options.playbackVolume?.value ?? 1;
  let unsubscribeVolume: (() => void) | undefined;
  const releaseVolume = () => { unsubscribeVolume?.(); unsubscribeVolume = undefined; };
  const selected = () => lastItem?.clip.type === 'audio' ? lastItem.clip : clip;
  const position = (item: FrameItem) => {
    const startMs = selected().properties.sourceRange?.inMs ?? 0;
    const periodMs = mediaDurationMs(selected()) ?? 0;
    const endMs = Math.min(selected().properties.sourceRange?.outMs ?? periodMs, audio.duration * 1000);
    const looping = item.audioLoop === true && periodMs > 0;
    // Break media time is already resolved against the shared holding anchor.
    // Its wrapped source position is independent of the frozen clip envelopes.
    const anchored = item.mediaTimeMs !== undefined;
    const localMs = Math.max(0, item.mediaTimeMs ?? item.localTimeMs);
    const sourceMs = startMs + (!anchored && looping ? localMs % periodMs : localMs);
    return { startMs, endMs, periodMs, looping, sourceMs, cycle: looping ? item.mediaCycle ?? Math.floor(localMs / periodMs) : 0,
      localMs, playable: sourceMs < endMs && periodMs > 0 };
  };
  const clearBuffer = () => { if (bufferTimer !== null) clearTimeout(bufferTimer); bufferTimer = null; };
  const silence = () => { if (gain) gain.gain.value = 0; else audio.volume = 0; };
  const pause = () => { generation += 1; pendingPlay = false; silence(); audio.pause(); };
  const releaseAudioGraph = () => {
    silence(); source?.disconnect(); gain?.disconnect();
    if (context && !options.createAudioContext) void context.close().catch(() => {});
    source = null; gain = null; context = null;
    audio.volume = 0;
  };
  const usable = () => !disposed && !signal.aborted && failure === undefined && prepared && !options.still;
  const expectsPlayback = () => {
    if (!usable() || !lastItem) return false;
    if (lastItem.mediaPlayback !== undefined) {
      return lastFrame?.phase !== 'paused' && lastItem.mediaPlayback !== 'paused'
        && lastItem.mediaPlayback !== 'finished' && position(lastItem).playable
        && endedCycle !== position(lastItem).cycle;
    }
    return lastFrame?.phase === 'playing'
      ? position(lastItem).playable && endedCycle !== position(lastItem).cycle
      : lastFrame?.phase === 'exiting' && exitPlaying;
  };
  const applyVolume = () => {
    audio.muted = options.still === true || selected().properties.muted;
    const envelope = expectsPlayback() && !pendingSeek && lastItem && lastFrame
      ? Math.max(0, Math.min(1, (lastItem.audioGain ?? lastItem.opacity) * lastFrame.opacity)) : 0;
    audio.volume = gain ? selected().properties.volume : selected().properties.volume * envelope * localVolume;
    if (gain) gain.gain.value = envelope * localVolume;
  };
  const fail = (error: unknown) => {
    if (disposed || failure !== undefined || signal.aborted) return;
    failure = error; releaseVolume(); exitPlaying = false; pause(); clearBuffer(); releaseAudioGraph(); options.onError?.(error);
  };
  const abortFromSurface = () => { releaseVolume(); lifetime.abort(); events.abort(); exitPlaying = false; pause(); clearBuffer(); releaseAudioGraph(); };
  if (options.signal.aborted) abortFromSurface();
  else options.signal.addEventListener('abort', abortFromSurface, { once: true });
  const seek = async (seconds: number) => {
    if (signal.aborted) throw abortError();
    pendingSeek = true; silence();
    try {
      audio.currentTime = seconds;
      await waitForMedia(audio, signal, () => !audio.seeking && audio.readyState >= 2, 8000, 'MEDIA_SEEK_FAILED');
    } finally { pendingSeek = false; }
  };
  const guardedPlay = () => {
    const requestGeneration = generation;
    // Calls made during preflight/unlock stay silent; late fulfillment is guarded
    // even after the bounded caller has already timed out or been canceled.
    let playing: Promise<void>;
    try { playing = audio.play(); } catch (error) { return Promise.reject(error); }
    return playing.then(() => {
      if (requestGeneration !== generation || !expectsPlayback() || pendingSeek) { silence(); audio.pause(); }
    });
  };
  const play = () => {
    if (pendingPlay || !audio.paused || !expectsPlayback() || pendingSeek) return;
    pendingPlay = true;
    const requestGeneration = ++generation;
    let playback: Promise<unknown>;
    try {
      const resumed = context?.state === 'suspended' ? context.resume() : Promise.resolve();
      playback = Promise.all([guardedPlay(), resumed]);
    } catch { fail(new MediaPreparationError('MEDIA_AUTOPLAY')); return; }
    bounded(playback, signal, 8000, 'MEDIA_BUFFER_TIMEOUT').then(() => {
      if (requestGeneration === generation) applyVolume();
    }, error => {
      if (requestGeneration === generation && expectsPlayback()) {
        fail(error instanceof MediaPreparationError ? error : new MediaPreparationError('MEDIA_AUTOPLAY'));
      }
    }).finally(() => { if (requestGeneration === generation) pendingPlay = false; });
  };
  const waitBuffer = () => {
    if (!expectsPlayback() || pendingSeek || audio.ended || bufferTimer !== null) return;
    bufferTimer = setTimeout(() => { bufferTimer = null; fail(new MediaPreparationError('MEDIA_BUFFER_TIMEOUT')); }, 8000);
  };
  const reconcile = () => {
    if (!disposed && lastFrame) {
      try { renderer.draw(lastItem, lastFrame); } catch (error) { fail(error); }
    }
  };
  const seekPlayback = (seconds: number) => {
    pause(); clearBuffer(); audio.playbackRate = 1;
    void seek(seconds).then(reconcile, error => {
      if (!signal.aborted) fail(error instanceof MediaPreparationError ? error : new MediaPreparationError('MEDIA_SEEK_FAILED'));
    });
  };
  const sourceEnded = () => {
    if (!prepared || !lastItem || !expectsPlayback() || pendingSeek) return;
    const resolved = position(lastItem);
    if (!audio.ended && audio.currentTime * 1000 < resolved.endMs) return;
    if (lastItem.mediaPlayback === undefined && lastFrame?.phase === 'exiting' && resolved.looping) {
      seekPlayback(resolved.startMs / 1000);
    } else {
      endedCycle = resolved.cycle; exitPlaying = false; pause(); clearBuffer();
    }
  };
  audio.addEventListener('error', () => { if (prepared) fail(new MediaPreparationError('MEDIA_LOAD_FAILED')); }, { signal: events.signal });
  audio.addEventListener('durationchange', () => {
    if (prepared && (!Number.isFinite(audio.duration) || Math.abs(audio.duration * 1000 - (clip.properties.durationMs ?? 0)) > 250
      || (clip.properties.sourceRange?.inMs ?? 0) >= audio.duration * 1000)) fail(new MediaPreparationError('MEDIA_DURATION_CHANGED'));
  }, { signal: events.signal });
  for (const event of ['waiting', 'stalled']) audio.addEventListener(event, waitBuffer, { signal: events.signal });
  for (const event of ['playing', 'canplay', 'seeked']) audio.addEventListener(event, () => {
    if (audio.readyState >= 3 && !audio.seeking) clearBuffer();
  }, { signal: events.signal });
  for (const event of ['timeupdate', 'ended']) audio.addEventListener(event, sourceEnded, { signal: events.signal });
  const renderer: ElementRenderer = {
    node: audio,
    async prepare() {
      if (disposed || signal.aborted) throw abortError();
      if (failure !== undefined) throw failure;
      if (prepared) return;
      try {
        const deadline = performance.now() + 30_000;
        audio.src = clip.properties.source.path; audio.load();
        await waitForMedia(audio, signal, () => audio.readyState >= 1, deadline - performance.now(), 'MEDIA_TIMEOUT');
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new MediaPreparationError('MEDIA_LOAD_FAILED');
        if (Math.abs(audio.duration * 1000 - (clip.properties.durationMs ?? 0)) > 250
          || (clip.properties.sourceRange?.inMs ?? 0) >= audio.duration * 1000) throw new MediaPreparationError('MEDIA_DURATION_CHANGED');
        const start = (clip.properties.sourceRange?.inMs ?? 0) / 1000;
        const end = Math.min(clip.properties.sourceRange?.outMs ?? clip.properties.durationMs ?? 0, audio.duration * 1000) / 1000;
        if (start > 0) await seek(start);
        await waitForMedia(audio, signal, () => {
          if (audio.readyState < 2) return false;
          const target = Math.min(start + 2, end);
          for (let index = 0; index < audio.buffered.length; index += 1) {
            if (audio.buffered.start(index) <= start + 0.05
              && audio.buffered.end(index) >= target - Math.min(0.05, (target - start) * 0.1)) return true;
          }
          return false;
        }, deadline - performance.now(), 'MEDIA_TIMEOUT');
        if (!options.still && !clip.properties.muted && clip.properties.volume > 0) {
          if (typeof AudioContext === 'undefined') throw new MediaPreparationError('MEDIA_AUDIO_UNAVAILABLE');
          try {
            context = options.createAudioContext?.() ?? new AudioContext(); gain = context.createGain(); gain.gain.value = 0;
            source = context.createMediaElementSource(audio); source.connect(gain); gain.connect(context.destination);
            // Retain an unmuted, nonzero-volume element so preflight tests audible
            // permission; the downstream gain alone prevents preflight sound.
            audio.volume = clip.properties.volume;
          } catch { throw new MediaPreparationError('MEDIA_AUDIO_UNAVAILABLE'); }
          let blocked = false;
          try { await bounded(guardedPlay(), signal, 8000, 'MEDIA_TIMEOUT'); }
          catch (error) {
            if (signal.aborted) throw abortError();
            if (error instanceof DOMException && error.name === 'NotAllowedError') blocked = true;
            else throw error instanceof MediaPreparationError ? error : new MediaPreparationError('MEDIA_LOAD_FAILED');
          } finally { pause(); }
          if (blocked || context.state !== 'running') {
            if (!options.requestAudioUnlock) throw new MediaPreparationError('MEDIA_AUTOPLAY');
            const unlock = async () => {
              if (disposed || signal.aborted) throw abortError();
              const resumed = context?.resume() ?? Promise.resolve();
              const played = guardedPlay();
              try { await bounded(Promise.all([resumed, played]), signal, 8000, 'MEDIA_AUTOPLAY'); }
              catch { throw signal.aborted ? abortError() : new MediaPreparationError('MEDIA_AUTOPLAY'); }
              finally { pause(); }
            };
            await bounded(options.requestAudioUnlock(unlock, signal), signal, 10 * 60_000, 'MEDIA_AUTOPLAY');
            if (context.state !== 'running') throw new MediaPreparationError('MEDIA_AUTOPLAY');
          }
        }
        pause();
        if (Math.abs(audio.currentTime - start) > 0.001) await seek(start);
        if (disposed || signal.aborted) throw abortError();
        prepared = true;
      } catch (error) { if (!signal.aborted) failure = error; releaseVolume(); pause(); releaseAudioGraph(); throw error; }
    },
    draw(item, frame) {
      if (disposed) return;
      if (failure !== undefined) { if (!options.onError) throw failure; return; }
      if (frame.phase === 'exiting' && lastFrame?.phase !== 'exiting') exitPlaying = expectsPlayback();
      if (frame.phase !== 'exiting') exitPlaying = false;
      lastFrame = frame; lastItem = item?.clip.type === 'audio' ? item : undefined;
      const consumedBreak = frame.breakHistory?.at(-1);
      if (consumedBreak?.id !== lastConsumedBreakId) {
        lastConsumedBreakId = consumedBreak?.id;
        if (consumedBreak && lastItem && selected().properties.onBreak === 'loop'
          && consumedBreak.positionMs >= selected().startMs) resyncBreakId = consumedBreak.id;
      }
      if (!lastItem || !usable()) { pause(); clearBuffer(); cycle = null; return; }
      if (frame.phase === 'exiting' && lastItem.mediaPlayback === undefined) {
        sourceEnded();
        if (!expectsPlayback()) { pause(); clearBuffer(); }
        else { applyVolume(); play(); }
        return;
      }
      const resolved = position(lastItem);
      if (resyncBreakId !== null || resolved.localMs < lastLocalTimeMs || cycle !== resolved.cycle) endedCycle = null;
      // A decoder can lead the shared clock slightly. Enforce the selected source
      // boundary on every parent frame as well as native media events.
      if (resyncBreakId === null && cycle === resolved.cycle && resolved.localMs >= lastLocalTimeMs) sourceEnded();
      // A native Finish can complete before the next parent frame arrives.
      // Retain its completed decoder until the shared clock reaches that end;
      // stale source targets and later Continue history must never rewind it.
      if (lastItem.mediaTimeMs !== undefined && selected().properties.onBreak === 'finish'
        && endedCycle === resolved.cycle) { pause(); clearBuffer(); return; }
      const playing = expectsPlayback();
      if (!playing) { pause(); clearBuffer(); }
      const sync = videoSync(audio.currentTime, resolved.sourceMs, resolved.endMs / 1000, playing);
      audio.playbackRate = sync.rate;
      const loopSeek = resolved.looping && (cycle !== resolved.cycle || resolved.localMs < lastLocalTimeMs);
      const exactPauseSeek = !playing && resolved.playable && Math.abs(audio.currentTime - sync.targetSeconds) > 0.001;
      // Continue is an explicit timeline resynchronization, even when a small
      // jump would otherwise receive only drift-rate correction. Keep it queued
      // across an older seek and consume it only when the latest target is sent.
      const breakSeek = resyncBreakId !== null;
      if ((sync.seek || loopSeek || exactPauseSeek || breakSeek) && !pendingSeek
        && (breakSeek || loopSeek || !playing || bufferTimer === null || audio.readyState >= 3)) {
        cycle = resolved.cycle; lastLocalTimeMs = resolved.localMs;
        resyncBreakId = null;
        seekPlayback(sync.targetSeconds);
      } else if (!pendingSeek) {
        cycle = resolved.cycle; lastLocalTimeMs = resolved.localMs; applyVolume(); play();
      }
      if (playing && audio.readyState < 3) waitBuffer();
    },
    dispose() {
      if (disposed) return;
      disposed = true; prepared = false; exitPlaying = false; pause(); clearBuffer(); lifetime.abort(); events.abort();
      releaseVolume();
      options.signal.removeEventListener('abort', abortFromSurface);
      releaseAudioGraph();
      releaseMedia(audio); lastFrame = null; lastItem = undefined;
    }
  };
  if (!signal.aborted) unsubscribeVolume = options.playbackVolume?.subscribe(value => {
    localVolume = value;
    if (!disposed && !signal.aborted && failure === undefined) applyVolume();
  });
  return renderer;
}
