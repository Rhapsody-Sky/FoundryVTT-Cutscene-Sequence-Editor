import { audioDurationMs, audioLoopSettings, clipDurationMs, manualEndNeedsDuration, sequenceDurationMs } from '../../domain/clip-timing.js';
import { getPlaybackSchemaVersion } from '../../domain/sequence-audience.js';
import { SEQUENCE_LIMITS } from '../../domain/validation.js';
import { roundMaskCoordinate, shiftDecimalText } from '../../domain/spatial-precision.js';
import { getAnimatedPatternSettings, updateAnimatedPatternParameter, type AnimatedPattern } from '../../domain/animated-pattern.js';
import { changePatternPreset, changeSolidPolygon } from '../animated-surface-inspector.js';
import { BUTTON_TEXTURES } from '../../domain/button.js';
import type { AudioClip, BarsClip, BreakBehavior, ButtonClip, ButtonShape, ButtonTexture, ImageClip, ImagePoint, SolidClip, SequenceClip, SequenceV1, TextClip, Transition, TransitionEasing, SlideDirection, VideoClip } from '../../domain/sequence.js';
import { audioValuesForPath, videoValuesForPath, type SimpleAppearanceValues, type SimpleAudioValues, type SimpleBarsValues, type SimpleBlendMode, type SimpleButtonValues, type SimpleDurationMode, type SimpleElementType, type SimpleGlowValues, type SimpleImageValues, type SimpleSolidValues, type SimpleOutlineValues, type SimpleShadowValues, type SimpleTextValues, type SimpleVideoKeying, type SimpleVideoValues } from '../simple-composition.js';
import { textMotionPreset, type TextMotionDirection, type TextMotionId, type TextMotionOrder } from '../../domain/text-motion.js';
import { DEFAULT_TEXT, DEFAULT_BUTTON, DEFAULT_IMAGE, DEFAULT_VIDEO_KEYING, DEFAULT_VIDEO, DEFAULT_AUDIO, DEFAULT_AUDIO_CLIP_DURATION_MS } from './inspector-defaults.js';
import type { InspectorValueFields } from './inspector-form.js';

export type NonMediaEnd = { kind: 'manual'; durationMs?: number } | { kind: 'fixed'; durationMs: number; automatic?: boolean };
type AppearanceHost = { readonly appearance?: SimpleAppearanceValues };
type VideoPropertiesWithKeying = VideoClip['properties'] & { readonly keying?: SimpleVideoKeying };
type TextPropertiesWithEffects = TextClip['properties'] & { readonly outline?: SimpleOutlineValues; readonly shadow?: SimpleShadowValues; readonly glow?: SimpleGlowValues };

export function getButtonDecisionGroups(sequence: SequenceV1): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const clip of sequence.clips) {
    if (clip.type !== 'button' || clip.properties.action.kind !== 'choice') continue;
    const labels = groups.get(clip.properties.action.decisionId) ?? [];
    if (!labels.includes(clip.properties.label)) labels.push(clip.properties.label);
    groups.set(clip.properties.action.decisionId, labels);
  }
  return groups;
}

function buttonDecisionIdFromName(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '').slice(0, SEQUENCE_LIMITS.idLength);
}

export function readElementValues(form: InspectorValueFields, source: SequenceV1, clip: SequenceClip | undefined, lastNonMediaEnd: NonMediaEnd, videoDefaultBox: () => NonNullable<VideoClip['properties']['box']>, editField?: string): {
  name: string; presentation: SequenceV1['presentation']; end: NonMediaEnd;
  bars?: SimpleBarsValues; text?: SimpleTextValues; image?: SimpleImageValues; solid?: SimpleSolidValues; video?: SimpleVideoValues; audio?: SimpleAudioValues; button?: SimpleButtonValues;
} {
  const inspectedClip = (type: SequenceClip['type']) => clip?.type === type ? clip : undefined;
  const seconds = (name: string, fallback: number) => {
    const value = form.field(name)?.value;
    return value === undefined || value === '' ? fallback : Math.round(Number(value) * 1_000);
  };
  const number = (name: string, fallback: number) => {
    const value = form.field(name)?.value;
    return value === undefined || value === '' ? fallback : Number(value);
  };
  const percent = (name: string, fallback: number) => {
    const value = form.field(name)?.value;
    return value === undefined || value === '' ? fallback : Number(shiftDecimalText(value, -2));
  };
  const checked = (name: string, fallback = false) => form.field(name)?.checked ?? fallback;
  const select = (name: string, fallback: string) => form.field<HTMLSelectElement>(name)?.value ?? fallback;
  const text = (name: string, fallback: string) => {
    const field = form.field(name), value = field?.value ?? fallback;
    // Browsers normalize native color values to lowercase. Reading an
    // untouched control must preserve the authored string and its history.
    return field?.type === 'color' && value.toLowerCase() === fallback.toLowerCase() ? fallback : value;
  };
  const titleAnimation = (clip: TextClip | ImageClip | SolidClip | VideoClip | ButtonClip, phase: 'entrance' | 'exit', prefixType: 'text' | 'image' | 'solid' | 'video' | 'button') => {
    const previous = clip[phase].preset !== 'none' ? clip[phase] : undefined;
    const prefix = prefixType + '-' + phase;
    const selectedPreset = select(prefix + '-preset', clip[phase].preset);
    const selectedMotionId = prefixType === 'text' && selectedPreset.startsWith('text-motion:')
      ? selectedPreset.slice('text-motion:'.length) as TextMotionId : undefined;
    const motionPreset = selectedMotionId ? textMotionPreset(selectedMotionId) : undefined;
    const motion = motionPreset ? selectedMotionId : undefined;
    const preset = motion ? 'text-motion' : selectedPreset as Transition['preset'];
    const slide = preset === 'slide' || preset === 'fade-slide';
    const zoom = preset === 'zoom' || preset === 'fade-zoom';
    const direction = select(prefix + '-direction', previous?.direction ?? 'down') as SlideDirection;
    const distance = number(prefix + '-distance', previous?.distance ?? 100);
    const scale = percent(prefix + '-scale', previous?.scale ?? 0.8);
    const oldMotion = previous?.preset === 'text-motion' ? previous : undefined;
    const changedMotion = !!motion && oldMotion?.motion !== motion;
    const motionDirection = select(prefix + '-motion-direction', oldMotion?.motionDirection ?? 'default') as TextMotionDirection;
    const motionOrder = select(prefix + '-motion-order', oldMotion?.motionOrder ?? 'default') as TextMotionOrder;
    return {
      [phase + 'Preset']: preset,
      [phase + 'Easing']: select(prefix + '-easing', previous?.easing ?? 'ease-in-out') as TransitionEasing,
      ...(motion ? {
        [phase + 'Motion']: motion,
        ...(changedMotion || oldMotion?.motionDirection !== undefined || motionDirection !== 'default' ? { [phase + 'MotionDirection']: motionDirection } : {}),
        ...(changedMotion || oldMotion?.motionOrder !== undefined || motionOrder !== 'default' ? { [phase + 'MotionOrder']: motionOrder } : {}),
        [phase + 'Amount']: number(prefix + '-amount', previous?.preset === 'text-motion' ? previous.amount ?? 1 : 1),
        [phase + 'Stagger']: percent(prefix + '-stagger', previous?.preset === 'text-motion' ? previous.stagger ?? 0.35 : 0.35)
      } : {}),
      ...(slide && (previous?.direction !== undefined || direction !== 'down') ? { [phase + 'Direction']: direction } : {}),
      ...(slide && (previous?.distance !== undefined || distance !== 100) ? { [phase + 'Distance']: distance } : {}),
      ...(zoom && (previous?.scale !== undefined || scale !== 0.8) ? { [phase + 'Scale']: scale } : {})
    };
  };
  const appearance = (prefix: SimpleElementType | 'image' | 'solid' | 'button', previous?: SimpleAppearanceValues): SimpleAppearanceValues => ({
    blendMode: select(prefix + '-blend-mode', previous?.blendMode ?? 'normal') as SimpleBlendMode,
    opacity: number(prefix + '-opacity', previous?.opacity ?? 1)
  });
  // Rename is committed separately; hidden or unfinished text cannot enter unrelated edits.
  const currentName = source.name;
  const ending = select('ending', source.end.kind);
  const manualTarget = { ...source, end: { kind: 'manual' as const } };
  const playbackSchema = getPlaybackSchemaVersion(source);
  const manualFallback = ending === 'manual' && (playbackSchema === 2 || playbackSchema === 3) && manualEndNeedsDuration(manualTarget);
  const end: NonMediaEnd = ending === 'manual'
    ? {
        ...(source.end.kind === 'manual' ? source.end : {}), kind: 'manual',
        ...(manualFallback ? { durationMs: seconds('sequence-duration', sequenceDurationMs(source) ?? 5_000) } : {})
      }
    : {
        ...(source.end.kind === 'fixed' ? source.end : {}), kind: 'fixed',
        durationMs: ending === 'automatic' && source.end.kind === 'fixed' ? source.end.durationMs
          : seconds('sequence-duration', sequenceDurationMs(source) ?? (lastNonMediaEnd.kind === 'fixed' ? lastNonMediaEnd.durationMs : 5_000)),
        automatic: ending === 'automatic'
      };
  const presentation: SequenceV1['presentation'] = {
    ...source.presentation,
    surface: select('surface', source.presentation.surface) as 'window' | 'canvas',
    blockInput: checked('block-input', source.presentation.blockInput),
    exitDurationMs: seconds('exit', source.presentation.exitDurationMs)
  };
  const result: {
    name: string; presentation: SequenceV1['presentation']; end: NonMediaEnd;
    bars?: SimpleBarsValues; text?: SimpleTextValues; image?: SimpleImageValues; solid?: SimpleSolidValues; video?: SimpleVideoValues; audio?: SimpleAudioValues; button?: SimpleButtonValues;
  } = { name: currentName, presentation, end };

  const oldBars = inspectedClip('bars') as BarsClip | undefined;
  if (oldBars) {
    const oldAppearance = (oldBars as BarsClip & AppearanceHost).appearance;
    result.bars = {
      startMs: seconds('bars-start', oldBars.startMs),
      entrancePreset: select('bars-entrance-preset', oldBars.entrance.preset) as Transition['preset'],
      entranceMs: seconds('bars-entrance', oldBars.entrance.preset !== 'none' ? oldBars.entrance.durationMs : 0),
      exitPreset: select('bars-exit-preset', oldBars.exit.preset) as Transition['preset'],
      exitMs: seconds('bars-exit', oldBars.exit.preset !== 'none' ? oldBars.exit.durationMs : 0),
      durationMode: select('bars-duration-mode', oldBars.duration.kind === 'fixed' ? 'fixed' : 'sequence-end') as SimpleDurationMode,
      durationMs: seconds('bars-duration', clipDurationMs(source, oldBars) ?? 5_000),
      heightFraction: percent('bars-height', oldBars.properties.heightFraction),
      appearance: appearance('bars', oldAppearance)
    };
  }
  const oldText = inspectedClip('text') as TextClip | undefined;
  if (oldText) {
    const box = oldText.properties.box;
    const properties = oldText.properties as TextPropertiesWithEffects;
    const oldAppearance = (oldText as TextClip & AppearanceHost).appearance;
    const outline = properties.outline ?? DEFAULT_TEXT.outline!;
    const shadow = properties.shadow ?? DEFAULT_TEXT.shadow!;
    const glow = properties.glow ?? DEFAULT_TEXT.glow!;
    result.text = {
      ...titleAnimation(oldText, 'entrance', 'text'), ...titleAnimation(oldText, 'exit', 'text'),
      startMs: seconds('text-start', oldText.startMs),
      entranceMs: seconds('text-entrance', oldText.entrance.preset !== 'none' ? oldText.entrance.durationMs : 0),
      durationMode: select('text-duration-mode', oldText.duration.kind === 'fixed' ? 'fixed' : 'sequence-end') as SimpleDurationMode,
      durationMs: seconds('text-duration', clipDurationMs(source, oldText) ?? 5_000),
      exitMs: seconds('text-exit', oldText.exit.preset !== 'none' ? oldText.exit.durationMs : 0),
      text: text('title-text', oldText.properties.text),
      fontFamily: select('title-font', oldText.properties.fontFamily),
      fontSize: number('title-size', oldText.properties.fontSize),
      minimumFontSize: number('title-minimum-size', oldText.properties.minimumFontSize),
      color: text('title-color', oldText.properties.color),
      align: select('title-align', oldText.properties.align) as 'left' | 'center' | 'right',
      box: {
        x: number('title-x', box.x), y: number('title-y', box.y),
        width: number('title-width', box.width), height: number('title-height', box.height)
      },
      shrinkToFit: checked('title-shrink', oldText.properties.shrinkToFit),
      appearance: appearance('text', oldAppearance),
      outline: {
        enabled: checked('outline-enabled', outline.enabled), color: text('outline-color', outline.color),
        opacity: number('outline-opacity', outline.opacity), width: number('outline-width', outline.width)
      },
      shadow: {
        enabled: checked('shadow-enabled', shadow.enabled), color: text('shadow-color', shadow.color),
        opacity: number('shadow-opacity', shadow.opacity), offsetX: number('shadow-offset-x', shadow.offsetX),
        offsetY: number('shadow-offset-y', shadow.offsetY), blur: number('shadow-blur', shadow.blur)
      },
      glow: {
        enabled: checked('glow-enabled', glow.enabled), color: text('glow-color', glow.color),
        opacity: number('glow-opacity', glow.opacity), radius: number('glow-radius', glow.radius)
      }
    };
  }
  const oldButton = inspectedClip('button') as ButtonClip | undefined;
  if (oldButton) {
    const action = oldButton.properties.action;
    const groupChoice = select('button-decision-group', '__new__');
    const decisionId = groupChoice.startsWith('existing:')
      ? groupChoice.slice('existing:'.length)
      : buttonDecisionIdFromName(text('button-decision-name', '').trim());
    const kind = select('button-action', action.kind);
    let nextAction: ButtonClip['properties']['action'] = { kind: 'continue' };
    if (kind === 'choice') {
      if (groupChoice === '__new__' && !decisionId) throw new Error('BUTTON_DECISION_NAME_REQUIRED');
      if (groupChoice === '__new__' && getButtonDecisionGroups(source).has(decisionId)) throw new Error('BUTTON_DECISION_GROUP_EXISTS');
      nextAction = { kind: 'choice', decisionId, optionId: action.kind === 'choice' ? action.optionId : oldButton.id,
        message: text('button-message', action.kind === 'choice' ? action.message : ''),
        visibility: select('button-visibility', action.kind === 'choice' ? action.visibility : 'gm') as 'public' | 'gm' };
    }
    const textureChoice = select('button-texture', oldButton.properties.texture?.kind === 'builtin'
      ? oldButton.properties.texture.id : oldButton.properties.texture?.kind === 'foundry-file' ? 'foundry-file' : 'none');
    const builtin = BUTTON_TEXTURES.find(item => item.id === textureChoice);
    let texture: ButtonTexture | null = null;
    if (builtin) texture = { kind: 'builtin', id: builtin.id };
    else if (textureChoice === 'foundry-file') {
      const path = text('button-texture-path', oldButton.properties.texture?.kind === 'foundry-file' ? oldButton.properties.texture.path : '').trim();
      if (path) texture = { kind: 'foundry-file', path,
        fit: select('button-texture-fit', oldButton.properties.texture?.kind === 'foundry-file' ? oldButton.properties.texture.fit : 'cover') as 'contain' | 'cover' };
    }
    const outline = oldButton.properties.outline ?? DEFAULT_BUTTON.outline!;
    const shadow = oldButton.properties.shadow ?? DEFAULT_BUTTON.shadow!;
    const glow = oldButton.properties.glow ?? DEFAULT_BUTTON.glow!;
    result.button = {
      ...titleAnimation(oldButton, 'entrance', 'button'), ...titleAnimation(oldButton, 'exit', 'button'),
      startMs: seconds('button-start', oldButton.startMs),
      entranceMs: seconds('button-entrance', oldButton.entrance.preset !== 'none' ? oldButton.entrance.durationMs : 0),
      exitMs: seconds('button-exit', oldButton.exit.preset !== 'none' ? oldButton.exit.durationMs : 0),
      durationMode: select('button-duration-mode', oldButton.duration.kind === 'fixed' ? 'fixed' : 'sequence-end') as SimpleDurationMode,
      durationMs: seconds('button-duration', clipDurationMs(source, oldButton) ?? DEFAULT_BUTTON.durationMs),
      action: nextAction,
      label: text('button-label', oldButton.properties.label),
      fontFamily: select('button-font', oldButton.properties.fontFamily),
      fontSize: number('button-font-size', oldButton.properties.fontSize),
      color: text('button-color', oldButton.properties.color),
      backgroundColor: text('button-background', oldButton.properties.backgroundColor),
      box: { x: number('button-x', oldButton.properties.box.x), y: number('button-y', oldButton.properties.box.y),
        width: number('button-width', oldButton.properties.box.width), height: number('button-height', oldButton.properties.box.height) },
      shape: select('button-shape', oldButton.properties.shape) as ButtonShape,
      texture,
      outline: { enabled: checked('button-outline-enabled', outline.enabled), color: text('button-outline-color', outline.color),
        opacity: number('button-outline-opacity', outline.opacity), width: number('button-outline-width', outline.width) },
      shadow: { enabled: checked('button-shadow-enabled', shadow.enabled), color: text('button-shadow-color', shadow.color),
        opacity: number('button-shadow-opacity', shadow.opacity), offsetX: number('button-shadow-offset-x', shadow.offsetX),
        offsetY: number('button-shadow-offset-y', shadow.offsetY), blur: number('button-shadow-blur', shadow.blur) },
      glow: { enabled: checked('button-glow-enabled', glow.enabled), color: text('button-glow-color', glow.color),
        opacity: number('button-glow-opacity', glow.opacity), radius: number('button-glow-radius', glow.radius) },
      appearance: appearance('button', oldButton.appearance)
    };
  }
  for (const type of ['image', 'solid'] as const) {
    const shape = inspectedClip(type) as ImageClip | SolidClip | undefined;
    if (!shape) continue;
    const properties = shape.properties;
    const oldAppearance = shape.appearance;
    const outline = properties.outline ?? DEFAULT_IMAGE.outline!;
    const shadow = properties.shadow ?? DEFAULT_IMAGE.shadow!;
    const glow = properties.glow ?? DEFAULT_IMAGE.glow!;
    const values: Omit<SimpleImageValues, 'sourcePath' | 'mask'> & { readonly mask: readonly ImagePoint[] } = {
      ...titleAnimation(shape, 'entrance', type), ...titleAnimation(shape, 'exit', type),
      startMs: seconds(type + '-start', shape.startMs),
      entranceMs: seconds(type + '-entrance', shape.entrance.preset !== 'none' ? shape.entrance.durationMs : 0),
      durationMode: select(type + '-duration-mode', shape.duration.kind === 'fixed' ? 'fixed' : 'sequence-end') as SimpleDurationMode,
      durationMs: seconds(type + '-duration', clipDurationMs(source, shape) ?? DEFAULT_IMAGE.durationMs),
      exitMs: seconds(type + '-exit', shape.exit.preset !== 'none' ? shape.exit.durationMs : 0),
      fit: select(type + '-fit', properties.fit) as 'contain' | 'cover',
      box: {
        x: number(type + '-x', properties.box.x), y: number(type + '-y', properties.box.y),
        width: number(type + '-width', properties.box.width), height: number(type + '-height', properties.box.height)
      },
      crop: {
        x: percent(type + '-crop-x', properties.crop.x),
        y: percent(type + '-crop-y', properties.crop.y),
        width: percent(type + '-crop-width', properties.crop.width),
        height: percent(type + '-crop-height', properties.crop.height)
      },
      mask: properties.mask.map((point, index) => {
        const x = percent(`${type}-mask-${index}-x`, point.x), y = percent(`${type}-mask-${index}-y`, point.y);
        return { x: shape.type === 'solid' && x !== point.x ? roundMaskCoordinate(x) : x,
          y: shape.type === 'solid' && y !== point.y ? roundMaskCoordinate(y) : y };
      }),
      appearance: appearance(type, oldAppearance),
      outline: {
        enabled: checked(type + '-outline-enabled', outline.enabled), color: text(type + '-outline-color', outline.color),
        opacity: number(type + '-outline-opacity', outline.opacity), width: number(type + '-outline-width', outline.width)
      },
      shadow: {
        enabled: checked(type + '-shadow-enabled', shadow.enabled), color: text(type + '-shadow-color', shadow.color),
        opacity: number(type + '-shadow-opacity', shadow.opacity), offsetX: number(type + '-shadow-offset-x', shadow.offsetX),
        offsetY: number(type + '-shadow-offset-y', shadow.offsetY), blur: number(type + '-shadow-blur', shadow.blur)
      },
      glow: {
        enabled: checked(type + '-glow-enabled', glow.enabled), color: text(type + '-glow-color', glow.color),
        opacity: number(type + '-glow-opacity', glow.opacity), radius: number(type + '-glow-radius', glow.radius)
      }
    };
    if (shape.type === 'image') result.image = { ...values, mask: values.mask as ImageClip['properties']['mask'], sourcePath: shape.properties.source.path };
    else result.solid = { ...values, color: text('solid-color', shape.properties.color),
      alphaMapPath: text('solid-alpha-path', shape.properties.alphaMap?.path ?? ''),
      ...(editField === 'solid-polygon-preset' ? { mask: changeSolidPolygon(shape, select('solid-polygon-preset', 'rectangle')).properties.mask } : {}),
      ...(shape.properties.pattern ? { pattern: readPatternValues(shape.properties.pattern, number, select, text, checked, editField) } : {}) };
  }
  const oldVideo = inspectedClip('video') as VideoClip | undefined;
  if (oldVideo) {
    const enteredPath = text('video-path', oldVideo.properties.source.path);
    const oldAppearance = (oldVideo as VideoClip & AppearanceHost).appearance;
    const oldKeying = (oldVideo.properties as VideoPropertiesWithKeying).keying;
    const box = oldVideo.properties.box ?? videoDefaultBox();
    const keyingEnabled = checked('video-keying-enabled', oldKeying?.enabled ?? false);
    const keying = oldKeying || keyingEnabled ? {
      enabled: keyingEnabled,
      color: text('video-keying-color', oldKeying?.color ?? DEFAULT_VIDEO_KEYING.color),
      tolerance: number('video-keying-tolerance', (oldKeying?.tolerance ?? DEFAULT_VIDEO_KEYING.tolerance) * 100) / 100,
      softness: number('video-keying-softness', (oldKeying?.softness ?? DEFAULT_VIDEO_KEYING.softness) * 100) / 100
    } : undefined;
    result.video = {
      ...videoValuesForPath(videoValuesFromClip(oldVideo), enteredPath),
      ...titleAnimation(oldVideo, 'entrance', 'video'), ...titleAnimation(oldVideo, 'exit', 'video'),
      startMs: seconds('video-start', oldVideo.startMs),
      entranceMs: seconds('video-entrance', oldVideo.entrance.preset !== 'none' ? oldVideo.entrance.durationMs : 0),
      exitMs: seconds('video-exit', oldVideo.exit.preset !== 'none' ? oldVideo.exit.durationMs : 0),
      fit: select('video-fit', oldVideo.properties.fit) as 'contain' | 'cover',
      ...(form.field('video-positioned') ? { box: checked('video-positioned', !!oldVideo.properties.box) ? {
        x: number('video-x', box.x), y: number('video-y', box.y),
        width: number('video-width', box.width), height: number('video-height', box.height)
      } : null } : {}),
      volume: Number(text('video-volume', String(oldVideo.properties.volume))),
      muted: checked('video-muted', oldVideo.properties.muted),
      ...(oldVideo.properties.loop === undefined && !checked('video-loop') ? {} : { loop: checked('video-loop', oldVideo.properties.loop === true) }),
      ...(editField === 'video-on-break'
        ? { onBreak: select('video-on-break', oldVideo.properties.onBreak ?? 'pause') as BreakBehavior }
        : oldVideo.properties.onBreak === undefined ? {} : { onBreak: oldVideo.properties.onBreak }),
      ...(keying === undefined ? {} : { keying }),
      appearance: appearance('video', oldAppearance)
    };
  }
  const oldAudio = inspectedClip('audio') as AudioClip | undefined;
  if (oldAudio) {
    const enteredPath = text('audio-path', oldAudio.properties.source.path);
    const values = audioValuesForPath(audioValuesFromClip(oldAudio), enteredPath);
    const { sourceRange: _previousRange, ...audioSettings } = values;
    const inMs = seconds('audio-in', oldAudio.properties.sourceRange?.inMs ?? 0);
    const outMs = seconds('audio-out', oldAudio.properties.sourceRange?.outMs ?? values.durationMs ?? 0);
    const loop = checked('audio-loop', values.loop);
    const loopIndefinitely = checked('audio-loop-indefinitely', values.loopIndefinitely);
    let clipDurationMs = loopIndefinitely ? values.clipDurationMs ?? DEFAULT_AUDIO_CLIP_DURATION_MS
      : seconds('audio-clip-duration', values.clipDurationMs ?? DEFAULT_AUDIO_CLIP_DURATION_MS);
    if (!loop && values.durationMs !== undefined && outMs > inMs) clipDurationMs = Math.min(clipDurationMs, outMs - inMs);
    result.audio = {
      ...audioSettings,
      startMs: seconds('audio-start', oldAudio.startMs),
      clipDurationMs,
      entranceMs: seconds('audio-entrance', oldAudio.entrance.preset === 'fade' ? oldAudio.entrance.durationMs : 0),
      exitMs: seconds('audio-exit', oldAudio.exit.preset === 'fade' ? oldAudio.exit.durationMs : 0),
      volume: number('audio-volume', oldAudio.properties.volume),
      muted: checked('audio-muted', oldAudio.properties.muted),
      loop: loop || loopIndefinitely,
      loopIndefinitely: loopIndefinitely,
      ...(editField === 'audio-on-break'
        ? { onBreak: select('audio-on-break', oldAudio.properties.onBreak ?? 'pause') as BreakBehavior }
        : oldAudio.properties.onBreak === undefined ? {} : { onBreak: oldAudio.properties.onBreak }),
      ...(values.durationMs !== undefined && (inMs !== 0 || outMs !== values.durationMs) ? { sourceRange: { inMs, outMs } } : {})
    };
  }
  return result;
}

export function readPatternValues(old: AnimatedPattern, number: (name: string, fallback: number) => number,
  select: (name: string, fallback: string) => string, text: (name: string, fallback: string) => string,
  checked: (name: string, fallback?: boolean) => boolean, editField?: string): AnimatedPattern {
  let pattern = editField === 'solid-pattern-preset' ? changePatternPreset(old, select('solid-pattern-preset', old.preset)) : old;
  // Newly selected recipes use their defaults; controls still describe the previous recipe until repaint.
  if (editField !== 'solid-pattern-preset') for (const setting of getAnimatedPatternSettings(pattern)) {
    pattern = updateAnimatedPatternParameter(pattern, setting.key, number(`solid-pattern-parameter-${setting.key}`, setting.value));
  }
  return { ...pattern,
    colors: [0, 1, 2].map(index => text(`solid-pattern-color-${index}`, old.colors[index]!)) as unknown as AnimatedPattern['colors'],
    speed: number('solid-pattern-speed', old.speed), scale: pattern.version === 1 ? number('solid-pattern-scale', old.scale) : pattern.scale,
    density: pattern.version === 1 ? number('solid-pattern-density', old.density) : pattern.density, direction: number('solid-pattern-direction', old.direction),
    intensity: number('solid-pattern-intensity', old.intensity), reverse: checked('solid-pattern-reverse', old.reverse),
    onBreak: select('solid-pattern-onBreak', old.onBreak) as AnimatedPattern['onBreak'] };
}

export function videoValuesFromClip(clip: VideoClip | undefined): SimpleVideoValues {
  if (!clip) return { ...DEFAULT_VIDEO };
  const keying = (clip.properties as VideoPropertiesWithKeying).keying;
  return {
    startMs: clip.startMs,
    entranceMs: clip.entrance.preset !== 'none' ? clip.entrance.durationMs : 0,
    exitMs: clip.exit.preset !== 'none' ? clip.exit.durationMs : 0,
    sourcePath: clip.properties.source.path,
    ...(clip.properties.box ? { box: clip.properties.box } : {}),
    ...(clip.properties.durationMs === undefined ? {} : { durationMs: clip.properties.durationMs }),
    ...(clip.properties.loop === undefined ? {} : { loop: clip.properties.loop }),
    ...(clip.properties.onBreak === undefined ? {} : { onBreak: clip.properties.onBreak }),
    ...(keying === undefined ? {} : { keying: { enabled: keying.enabled, color: keying.color, tolerance: keying.tolerance, softness: keying.softness } }),
    fit: clip.properties.fit, volume: clip.properties.volume, muted: clip.properties.muted,
    appearance: clip.appearance ?? DEFAULT_VIDEO.appearance!
  };
}

export function audioValuesFromClip(clip: AudioClip | undefined): SimpleAudioValues {
  if (!clip) return { ...DEFAULT_AUDIO };
  const loop = audioLoopSettings(clip);
  return {
    startMs: clip.startMs,
    entranceMs: clip.entrance.preset === 'fade' ? clip.entrance.durationMs : 0,
    exitMs: clip.exit.preset === 'fade' ? clip.exit.durationMs : 0,
    sourcePath: clip.properties.source.path,
    ...(clip.properties.durationMs === undefined ? {} : { durationMs: clip.properties.durationMs }),
    clipDurationMs: audioDurationMs(clip) ?? DEFAULT_AUDIO_CLIP_DURATION_MS,
    ...(clip.properties.sourceRange === undefined ? {} : { sourceRange: { ...clip.properties.sourceRange } }),
    volume: clip.properties.volume,
    muted: clip.properties.muted,
    loop: loop.loop,
    loopIndefinitely: loop.loopIndefinitely,
    ...(clip.properties.onBreak === undefined ? {} : { onBreak: clip.properties.onBreak })
  };
}


export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function sameJsonData(left: unknown, right: unknown): boolean { return stableJson(left) === stableJson(right); }

