import type { AudioClip, BarsClip, ButtonClip, ImageClip, ImagePoint, SequenceClip, SequenceV1, SolidClip, TextClip, Transition, VideoClip } from '../domain/sequence.js';
import { audioDurationMs, audioLoopSettings, videoTypeVersion } from '../domain/clip-timing.js';
import { audioFade, barsExit, barsTransition, buttonTransition, imageTransition, textTransition, videoTransition, type SimpleAudioValues, type SimpleBarsValues, type SimpleButtonValues, type SimpleImageValues, type SimpleSolidValues, type SimpleTextValues, type SimpleVideoKeying, type SimpleVideoValues } from './simple-composition.js';

function transition(old: Transition, durationMs: number): Transition {
  const extra = Object.fromEntries(Object.entries(old).filter(([key]) => !['preset', 'version', 'durationMs', 'easing'].includes(key)));
  return durationMs > 0 ? { ...extra, preset: 'fade', version: 1, durationMs, easing: old.preset === 'fade' ? old.easing : 'ease-in-out' } : { ...extra, preset: 'none', version: 1 };
}
/** Patch one selected clip while retaining IDs, unknown JSON fields and sibling clips. */
export function patchInspectedClip(clip: SequenceClip, values: { bars?: SimpleBarsValues; text?: SimpleTextValues; image?: SimpleImageValues; solid?: SimpleSolidValues; video?: SimpleVideoValues; audio?: SimpleAudioValues; button?: SimpleButtonValues }): SequenceClip {
  if (clip.type === 'audio') {
    const v = values.audio!;
    if (!v) return clip;
    const legacyLoop = audioLoopSettings(clip);
    const sameRange = JSON.stringify(v.sourceRange ?? undefined) === JSON.stringify(clip.properties.sourceRange ?? undefined);
    const retainLegacyMediaDuration = clip.typeVersion === 1 && v.onBreak === undefined
      && v.loop === legacyLoop.loop && v.loopIndefinitely === legacyLoop.loopIndefinitely
      && v.sourcePath === clip.properties.source.path && sameRange
      && v.clipDurationMs === audioDurationMs(clip);
    const properties = { ...clip.properties, source: { ...clip.properties.source, path: v.sourcePath }, volume: v.volume, muted: v.muted } as Record<string, unknown>;
    if (v.sourcePath !== clip.properties.source.path) { delete properties.durationMs; delete properties.sourceRange; }
    if (v.durationMs !== undefined) properties.durationMs = v.durationMs;
    const rangeExtensions = Object.fromEntries(Object.entries(clip.properties.sourceRange ?? {}).filter(([key]) => key !== 'inMs' && key !== 'outMs'));
    if (v.sourceRange && v.durationMs !== undefined && (v.sourceRange.inMs !== 0 || v.sourceRange.outMs !== v.durationMs || Object.keys(rangeExtensions).length > 0)) {
      properties.sourceRange = { ...rangeExtensions, ...v.sourceRange };
    } else delete properties.sourceRange;
    if (retainLegacyMediaDuration) {
      if (clip.properties.loop === undefined) delete properties.loop;
      else properties.loop = clip.properties.loop;
      return {
        ...clip, startMs: v.startMs,
        entrance: audioFade(clip.entrance, v.entranceMs), exit: audioFade(clip.exit, v.exitMs),
        properties: properties as AudioClip['properties']
      } as AudioClip;
    }
    const indefinite = v.loopIndefinitely;
    properties.loop = v.loop || indefinite;
    if (indefinite) properties.loopIndefinitely = true;
    else if (clip.properties.loopIndefinitely === true || clip.typeVersion === 1) delete properties.loopIndefinitely;
    if (v.onBreak !== undefined) properties.onBreak = v.onBreak;
    const durationExtensions = Object.fromEntries(Object.entries(clip.duration).filter(([key]) => key !== 'kind' && key !== 'milliseconds'));
    return {
      ...clip, startMs: v.startMs, typeVersion: indefinite || v.onBreak !== undefined ? 3 : 2,
      duration: indefinite
        ? { ...durationExtensions, kind: 'sequence-end' }
        : { ...durationExtensions, kind: 'fixed', milliseconds: v.clipDurationMs ?? 5_000 },
      entrance: audioFade(clip.entrance, v.entranceMs), exit: audioFade(clip.exit, v.exitMs),
      properties: properties as AudioClip['properties']
    } as AudioClip;
  }
  if (clip.type === 'button') {
    const value = values.button;
    if (!value) return clip;
    const duration = { ...clip.duration, kind: value.durationMode,
      ...(value.durationMode === 'fixed' ? { milliseconds: value.durationMs } : {}) };
    if (duration.kind !== 'fixed' && 'milliseconds' in duration) delete duration.milliseconds;
    const oldAction = clip.properties.action;
    const action = value.action.kind === 'choice'
      ? { ...(oldAction.kind === 'choice' ? oldAction : {}), ...value.action,
        optionId: oldAction.kind === 'choice' ? oldAction.optionId : clip.id }
      : { ...(oldAction.kind === 'continue' ? oldAction : {}), kind: 'continue' as const };
    const properties: Record<string, unknown> = {
      ...clip.properties,
      action,
      label: value.label,
      fontFamily: value.fontFamily,
      fontSize: value.fontSize,
      color: value.color,
      backgroundColor: value.backgroundColor,
      box: { ...clip.properties.box, ...value.box },
      shape: value.shape
    };
    if (value.texture === null) delete properties.texture;
    else if (value.texture !== undefined) properties.texture = {
      ...(clip.properties.texture?.kind === value.texture.kind ? clip.properties.texture : {}), ...value.texture
    };
    const outline = clip.properties.outline || value.outline?.enabled ? { ...clip.properties.outline, ...value.outline } : undefined;
    const shadow = clip.properties.shadow || value.shadow?.enabled ? { ...clip.properties.shadow, ...value.shadow } : undefined;
    const glow = clip.properties.glow || value.glow?.enabled ? { ...clip.properties.glow, ...value.glow } : undefined;
    const appearance = value.appearance ? { ...clip.appearance, ...value.appearance } : clip.appearance;
    if (outline) properties.outline = outline; else delete properties.outline;
    if (shadow) properties.shadow = shadow; else delete properties.shadow;
    if (glow) properties.glow = glow; else delete properties.glow;
    return {
      ...clip,
      startMs: value.startMs,
      duration,
      entrance: buttonTransition(clip.entrance, value, 'entrance'),
      exit: buttonTransition(clip.exit, value, 'exit'),
      properties: properties as unknown as ButtonClip['properties'],
      ...(appearance ? { appearance } : {})
    } as ButtonClip;
  }
  const value = values[clip.type] as SimpleBarsValues | SimpleTextValues | SimpleImageValues | SimpleSolidValues | SimpleVideoValues | undefined;
  if (!value) return clip;
  const appearance=clip.appearance || (value.appearance && (value.appearance.blendMode!=='normal' || value.appearance.opacity!==1)) ? { ...clip.appearance,...value.appearance } : undefined;
  const base = { ...clip, startMs: value.startMs, entrance: transition(clip.entrance, value.entranceMs), ...(appearance?{appearance}:{}) };
  if (clip.type === 'solid') {
    const solid = values.solid;
    if (!solid) return clip;
    const duration = { ...clip.duration, kind: solid.durationMode, ...(solid.durationMode === 'fixed' ? { milliseconds: solid.durationMs } : {}) };
    if (duration.kind !== 'fixed' && 'milliseconds' in duration) delete duration.milliseconds;
    const oldMask = clip.properties.mask as unknown as readonly (ImagePoint & Record<string, unknown>)[];
    const mask = solid.mask.map((point, index) => ({ ...(oldMask[index] ?? {}), ...point })) as unknown as SolidClip['properties']['mask'];
    const outline = clip.properties.outline || solid.outline?.enabled ? { ...clip.properties.outline, ...solid.outline } : undefined;
    const shadow = clip.properties.shadow || solid.shadow?.enabled ? { ...clip.properties.shadow, ...solid.shadow } : undefined;
    const glow = clip.properties.glow || solid.glow?.enabled ? { ...clip.properties.glow, ...solid.glow } : undefined;
    const properties = {
      ...clip.properties, color: solid.color, fit: solid.fit,
      box: { ...clip.properties.box, ...solid.box }, crop: { ...clip.properties.crop, ...solid.crop }, mask,
      ...(outline ? { outline } : {}), ...(shadow ? { shadow } : {}), ...(glow ? { glow } : {}),
      ...(solid.alphaMapPath ? { alphaMap: { ...(clip.properties.alphaMap ?? {}), kind: 'foundry-file' as const, path: solid.alphaMapPath } } : {})
    } as Record<string, unknown>;
    if (!solid.alphaMapPath) delete properties.alphaMap;
    if (solid.pattern) properties.pattern = { ...clip.properties.pattern, ...solid.pattern };
    return {
      ...base, duration, typeVersion: clip.typeVersion === 2 || solid.pattern || mask.length !== 4 ? 2 : 1,
      entrance: imageTransition(clip.entrance, solid, 'entrance'),
      exit: imageTransition(clip.exit, solid, 'exit'),
      properties: properties as unknown as SolidClip['properties']
    } as SolidClip;
  }
  if (clip.type === 'image') {
    const image = values.image;
    if (!image) return clip;
    const duration = { ...clip.duration, kind: image.durationMode, ...(image.durationMode === 'fixed' ? { milliseconds: image.durationMs } : {}) };
    if (duration.kind !== 'fixed' && 'milliseconds' in duration) delete duration.milliseconds;
    const oldMask = clip.properties.mask as unknown as readonly (ImagePoint & Record<string, unknown>)[];
    const mask = image.mask.map((point, index) => ({ ...(oldMask[index] ?? {}), ...point })) as unknown as ImageClip['properties']['mask'];
    const outline = clip.properties.outline || image.outline?.enabled ? { ...clip.properties.outline, ...image.outline } : undefined;
    const shadow = clip.properties.shadow || image.shadow?.enabled ? { ...clip.properties.shadow, ...image.shadow } : undefined;
    const glow = clip.properties.glow || image.glow?.enabled ? { ...clip.properties.glow, ...image.glow } : undefined;
    return {
      ...base, duration,
      entrance: imageTransition(clip.entrance, image, 'entrance'),
      exit: imageTransition(clip.exit, image, 'exit'),
      properties: {
        ...clip.properties,
        source: { ...clip.properties.source, path: image.sourcePath }, fit: image.fit,
        box: { ...clip.properties.box, ...image.box }, crop: { ...clip.properties.crop, ...image.crop }, mask,
        ...(outline ? { outline } : {}), ...(shadow ? { shadow } : {}), ...(glow ? { glow } : {})
      }
    } as ImageClip;
  }
  if (clip.type === 'video') {
    const v = values.video!;
    const oldKeying = (clip.properties as VideoClip['properties'] & { readonly keying?: SimpleVideoKeying & Record<string, unknown> }).keying;
    const properties = {
      ...clip.properties, source: { ...clip.properties.source, path: v.sourcePath }, fit: v.fit, volume: v.volume, muted: v.muted,
      ...(v.box == null ? {} : { box: { ...clip.properties.box, ...v.box } }),
      ...(v.keying === undefined ? {} : { keying: { ...(oldKeying ?? {}), ...v.keying } })
    };
    if (v.box === null) delete properties.box;
    if (v.onBreak !== undefined) Object.assign(properties, { onBreak: v.onBreak });
    if (v.sourcePath !== clip.properties.source.path) { delete properties.durationMs; delete properties.sourceRange; }
    if (v.durationMs !== undefined) properties.durationMs = v.durationMs;
    if (v.loop === true) properties.loop = true;
    else if (v.loop === false && clip.properties.loop === true) delete properties.loop;
    const entrance = videoTransition(clip.entrance, v, 'entrance');
    const exit = videoTransition(clip.exit, v, 'exit');
    return { ...base, entrance, exit, typeVersion: videoTypeVersion(properties, clip.typeVersion, { entrance, exit }), properties } as VideoClip;
  }
  const v = values[clip.type]! as SimpleBarsValues | SimpleTextValues;
  const duration = { ...clip.duration, kind: v.durationMode, ...(v.durationMode === 'fixed' ? { milliseconds: v.durationMs } : {}) };
  if (duration.kind !== 'fixed' && 'milliseconds' in duration) delete duration.milliseconds;
  if (clip.type === 'bars') return { ...base, duration,
    entrance: barsTransition(clip.entrance, values.bars!.entranceMs, values.bars!.entrancePreset),
    exit: barsExit(clip.exit, values.bars!),
    properties: { ...clip.properties, heightFraction: values.bars!.heightFraction } } as BarsClip;
  const text = values.text!;
  return { ...base, duration, entrance: textTransition(clip.entrance, text, 'entrance'), exit: textTransition(clip.exit, text, 'exit'), properties: {
    ...clip.properties, text: text.text, fontFamily: text.fontFamily, fontSize: text.fontSize, minimumFontSize: text.minimumFontSize,
    color: text.color, align: text.align, box: { ...clip.properties.box, ...text.box }, shrinkToFit: text.shrinkToFit,
    ...(clip.properties.outline || text.outline?.enabled ? {outline:{...clip.properties.outline,...text.outline}}:{}),
    ...(clip.properties.shadow || text.shadow?.enabled ? {shadow:{...clip.properties.shadow,...text.shadow}}:{}),
    ...(clip.properties.glow || text.glow?.enabled ? {glow:{...clip.properties.glow,...text.glow}}:{})
  } } as TextClip;
}
export function selectedClip(sequence: SequenceV1, id: string | null): SequenceClip | undefined { return sequence.clips.find(clip => clip.id === id); }
