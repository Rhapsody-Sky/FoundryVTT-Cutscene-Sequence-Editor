import { clipDurationMs } from '../../domain/clip-timing.js';
import { getPlaybackSchemaVersion } from '../../domain/sequence-audience.js';
import { shiftDecimalText } from '../../domain/spatial-precision.js';
import { paintAnimatedSurfaceInspector } from '../animated-surface-inspector.js';
import { BUTTON_DESIGNS, buttonDesignId } from '../effect-presets.js';
import { mediaFadeChoiceDurations } from '../media-fade-choice.js';
import { textMotionPreset, type TextMotionId } from '../../domain/text-motion.js';
import type { AudioClip, BarsClip, ButtonClip, ImageClip, SolidClip, SequenceClip, SequenceV1, TextClip, VideoClip } from '../../domain/sequence.js';
import type { SimpleImageValues, SimpleOutlineValues, SimpleShadowValues, SimpleGlowValues, SimpleTextValues } from '../simple-composition.js';
import { DEFAULT_BARS, DEFAULT_TEXT, DEFAULT_IMAGE, DEFAULT_BUTTON, DEFAULT_BUTTON_PROPERTIES, DEFAULT_VIDEO_KEYING, DEFAULT_AUDIO_CLIP_DURATION_MS } from './inspector-defaults.js';
import { audioValuesFromClip, videoValuesFromClip, getButtonDecisionGroups } from './inspector-values.js';
import type { InspectorForm } from './inspector-form.js';

type TextPropertiesWithEffects = TextClip['properties'] & { readonly outline?: SimpleOutlineValues; readonly shadow?: SimpleShadowValues; readonly glow?: SimpleGlowValues };

/** Projects selected clip values into controls without changing editor or playback state. */
export class InspectorFields {
  constructor(private readonly form: InspectorForm) {}

  paintClipFields(value: SequenceV1, clip: SequenceClip | undefined, videoDefaultBox: () => NonNullable<VideoClip['properties']['box']>): void {
    const inspectedClip = (type: SequenceClip['type']) => clip?.type === type ? clip : undefined;
    const bars = inspectedClip('bars') as BarsClip | undefined;
    const barsAppearance = bars?.appearance ?? DEFAULT_BARS.appearance!;
    this.form.setValue('bars-height', shiftDecimalText(bars?.properties.heightFraction ?? DEFAULT_BARS.heightFraction, 2));
    this.form.setValue('bars-start', String((bars?.startMs ?? DEFAULT_BARS.startMs) / 1000));
    this.paintBarsAnimations(bars);
    this.form.setValue('bars-duration-mode', bars?.duration.kind === 'fixed' ? 'fixed' : 'sequence-end');
    this.form.setValue('bars-duration', String((bars ? clipDurationMs(value, bars) ?? DEFAULT_BARS.durationMs : DEFAULT_BARS.durationMs) / 1000));
    this.form.setValue('bars-blend-mode', barsAppearance.blendMode);
    this.form.setValue('bars-opacity', String(barsAppearance.opacity));

    const title = inspectedClip('text') as TextClip | undefined;
    const titleProperties = title?.properties as TextPropertiesWithEffects | undefined;
    const titleValues: SimpleTextValues = title ? {
      startMs: title.startMs, entranceMs: title.entrance.preset !== 'none' ? title.entrance.durationMs : 0,
      durationMode: title.duration.kind === 'fixed' ? 'fixed' : 'sequence-end',
      durationMs: clipDurationMs(value, title) ?? DEFAULT_TEXT.durationMs,
      exitMs: title.exit.preset !== 'none' ? title.exit.durationMs : 0,
      text: title.properties.text, fontFamily: title.properties.fontFamily, fontSize: title.properties.fontSize,
      minimumFontSize: title.properties.minimumFontSize, color: title.properties.color, align: title.properties.align,
      box: title.properties.box, shrinkToFit: title.properties.shrinkToFit,
      appearance: title.appearance ?? DEFAULT_TEXT.appearance!,
      outline: titleProperties?.outline ?? DEFAULT_TEXT.outline!,
      shadow: titleProperties?.shadow ?? DEFAULT_TEXT.shadow!,
      glow: titleProperties?.glow ?? DEFAULT_TEXT.glow!
    } : DEFAULT_TEXT;
    this.form.setValue('text-start', String(titleValues.startMs / 1000));
    this.paintTextAnimations(title);
    this.form.setValue('text-duration-mode', titleValues.durationMode);
    this.form.setValue('text-duration', String(titleValues.durationMs / 1000));
    this.form.setValue('title-text', titleValues.text);
    this.form.setFontValue(titleValues.fontFamily);
    this.form.setValue('title-size', String(titleValues.fontSize));
    this.form.setValue('title-minimum-size', String(titleValues.minimumFontSize));
    this.form.setValue('title-color', titleValues.color);
    this.form.setValue('title-align', titleValues.align);
    this.form.setValue('title-x', String(titleValues.box.x));
    this.form.setValue('title-y', String(titleValues.box.y));
    this.form.setValue('title-width', String(titleValues.box.width));
    this.form.setValue('title-height', String(titleValues.box.height));
    this.form.setChecked('title-shrink', titleValues.shrinkToFit);
    const titleAppearance = titleValues.appearance ?? DEFAULT_TEXT.appearance!;
    const outline = titleValues.outline ?? DEFAULT_TEXT.outline!;
    const shadow = titleValues.shadow ?? DEFAULT_TEXT.shadow!;
    const glow = titleValues.glow ?? DEFAULT_TEXT.glow!;
    this.form.setValue('text-blend-mode', titleAppearance.blendMode);
    this.form.setValue('text-opacity', String(titleAppearance.opacity));
    this.form.setChecked('outline-enabled', outline.enabled);
    this.form.setValue('outline-color', outline.color);
    this.form.setValue('outline-opacity', String(outline.opacity));
    this.form.setValue('outline-width', String(outline.width));
    this.form.setChecked('shadow-enabled', shadow.enabled);
    this.form.setValue('shadow-color', shadow.color);
    this.form.setValue('shadow-opacity', String(shadow.opacity));
    this.form.setValue('shadow-offset-x', String(shadow.offsetX));
    this.form.setValue('shadow-offset-y', String(shadow.offsetY));
    this.form.setValue('shadow-blur', String(shadow.blur));
    this.form.setChecked('glow-enabled', glow.enabled);
    this.form.setValue('glow-color', glow.color);
    this.form.setValue('glow-opacity', String(glow.opacity));
    this.form.setValue('glow-radius', String(glow.radius));

    const image = inspectedClip('image') as ImageClip | undefined;
    const imageProperties = image?.properties as (ImageClip['properties'] & { readonly outline?: SimpleOutlineValues; readonly shadow?: SimpleShadowValues; readonly glow?: SimpleGlowValues }) | undefined;
    const imageValues: SimpleImageValues = image ? {
      startMs: image.startMs, entranceMs: image.entrance.preset !== 'none' ? image.entrance.durationMs : 0,
      durationMode: image.duration.kind === 'fixed' ? 'fixed' : 'sequence-end',
      durationMs: clipDurationMs(value, image) ?? DEFAULT_IMAGE.durationMs,
      exitMs: image.exit.preset !== 'none' ? image.exit.durationMs : 0,
      sourcePath: image.properties.source.path, fit: image.properties.fit,
      box: image.properties.box, crop: image.properties.crop, mask: image.properties.mask,
      appearance: image.appearance ?? DEFAULT_IMAGE.appearance!,
      outline: imageProperties?.outline ?? DEFAULT_IMAGE.outline!, shadow: imageProperties?.shadow ?? DEFAULT_IMAGE.shadow!,
      glow: imageProperties?.glow ?? DEFAULT_IMAGE.glow!
    } : DEFAULT_IMAGE;
    this.form.setValue('image-path', imageValues.sourcePath);
    this.form.setValue('image-start', String(imageValues.startMs / 1000));
    this.paintImageAnimations(image);
    this.form.setValue('image-duration-mode', imageValues.durationMode);
    this.form.setValue('image-duration', String(imageValues.durationMs / 1000));
    const imageDuration = image && clipDurationMs(value, image);
    this.form.setOutput('[data-stagecraft-image-end]', image ? typeof imageDuration === 'number'
      ? ((image.startMs + imageDuration) / 1000).toFixed(2) + ' s' : this.form.t('ImageEndAtSequence') : '');
    this.form.setValue('image-fit', imageValues.fit);
    this.form.setValue('image-x', String(imageValues.box.x));
    this.form.setValue('image-y', String(imageValues.box.y));
    this.form.setValue('image-width', String(imageValues.box.width));
    this.form.setValue('image-height', String(imageValues.box.height));
    this.form.setValue('image-crop-x', shiftDecimalText(imageValues.crop.x, 2));
    this.form.setValue('image-crop-y', shiftDecimalText(imageValues.crop.y, 2));
    this.form.setValue('image-crop-width', shiftDecimalText(imageValues.crop.width, 2));
    this.form.setValue('image-crop-height', shiftDecimalText(imageValues.crop.height, 2));
    imageValues.mask.forEach((point, index) => {
      this.form.setValue(`image-mask-${index}-x`, shiftDecimalText(point.x, 2));
      this.form.setValue(`image-mask-${index}-y`, shiftDecimalText(point.y, 2));
    });
    const imageAppearance = imageValues.appearance ?? DEFAULT_IMAGE.appearance!;
    this.form.setValue('image-blend-mode', imageAppearance.blendMode);
    this.form.setValue('image-opacity', String(imageAppearance.opacity));
    const imageOutline = imageValues.outline ?? DEFAULT_IMAGE.outline!;
    const imageShadow = imageValues.shadow ?? DEFAULT_IMAGE.shadow!;
    const imageGlow = imageValues.glow ?? DEFAULT_IMAGE.glow!;
    this.form.setChecked('image-outline-enabled', imageOutline.enabled);
    this.form.setValue('image-outline-color', imageOutline.color);
    this.form.setValue('image-outline-opacity', String(imageOutline.opacity));
    this.form.setValue('image-outline-width', String(imageOutline.width));
    this.form.setChecked('image-shadow-enabled', imageShadow.enabled);
    this.form.setValue('image-shadow-color', imageShadow.color);
    this.form.setValue('image-shadow-opacity', String(imageShadow.opacity));
    this.form.setValue('image-shadow-offset-x', String(imageShadow.offsetX));
    this.form.setValue('image-shadow-offset-y', String(imageShadow.offsetY));
    this.form.setValue('image-shadow-blur', String(imageShadow.blur));
    this.form.setChecked('image-glow-enabled', imageGlow.enabled);
    this.form.setValue('image-glow-color', imageGlow.color);
    this.form.setValue('image-glow-opacity', String(imageGlow.opacity));
    this.form.setValue('image-glow-radius', String(imageGlow.radius));
    this.paintSolidFields(value, inspectedClip('solid') as SolidClip | undefined);

    const video = inspectedClip('video') as VideoClip | undefined;
    const videoValues = videoValuesFromClip(video);
    this.form.setValue('video-in',String((video?.properties.sourceRange?.inMs??0)/1000));
    this.form.setValue('video-out',String((video?.properties.sourceRange?.outMs??video?.properties.durationMs??0)/1000));
    this.form.setValue('video-start', String(videoValues.startMs / 1000));
    this.paintVideoAnimations(video);
    this.form.setValue('video-path', videoValues.sourcePath);
    this.form.setValue('video-fit', videoValues.fit);
    this.form.setChecked('video-positioned', !!video?.properties.box);
    const videoBox = video?.properties.box ?? videoDefaultBox();
    for (const dimension of ['x', 'y', 'width', 'height'] as const) this.form.setValue('video-' + dimension, String(videoBox[dimension]));
    this.form.setValue('video-volume', String(videoValues.volume));
    this.form.setChecked('video-muted', videoValues.muted);
    this.form.setChecked('video-loop', videoValues.loop === true);
    const videoLoopLabel = this.form.field('video-loop')?.closest<HTMLLabelElement>('label');
    if (videoLoopLabel) {
      const label = videoLoopLabel.querySelector('span');
      const playbackSchema = getPlaybackSchemaVersion(value);
      const breaks = playbackSchema === 2 || playbackSchema === 3;
      if (label) label.textContent = this.form.t(breaks ? 'AudioLoop' : 'LoopWhileHeld');
      videoLoopLabel.title = this.form.t(breaks ? 'AudioLoopHint' : 'LoopWhileHeldHint');
    }
    this.form.setValue('video-on-break', videoValues.onBreak ?? 'pause');
    const keying = videoValues.keying ?? DEFAULT_VIDEO_KEYING;
    this.form.setChecked('video-keying-enabled', keying.enabled);
    this.form.setValue('video-keying-color', keying.color);
    this.form.setValue('video-keying-tolerance', String(Number((keying.tolerance * 100).toFixed(6))));
    this.form.setValue('video-keying-softness', String(Number((keying.softness * 100).toFixed(6))));
    this.form.setValue('video-blend-mode', videoValues.appearance!.blendMode);
    this.form.setValue('video-opacity', String(videoValues.appearance!.opacity));
    this.form.setOutput('[data-stagecraft-video-duration]', video?.properties.durationMs === undefined
      ? this.form.t('MetadataMissing') : (video.properties.durationMs / 1000).toFixed(2) + ' s');

    const audio = inspectedClip('audio') as AudioClip | undefined;
    const audioValues = audioValuesFromClip(audio);
    this.form.setValue('audio-in', String((audio?.properties.sourceRange?.inMs ?? 0) / 1000));
    this.form.setValue('audio-out', String((audio?.properties.sourceRange?.outMs ?? audio?.properties.durationMs ?? 0) / 1000));
    this.form.setValue('audio-start', String(audioValues.startMs / 1000));
    this.form.setValue('audio-clip-duration', String((audioValues.clipDurationMs ?? DEFAULT_AUDIO_CLIP_DURATION_MS) / 1000));
    this.form.setValue('audio-entrance', String(audioValues.entranceMs / 1000));
    this.form.setValue('audio-exit', String(audioValues.exitMs / 1000));
    this.form.setValue('audio-entrance-preset', audioValues.entranceMs > 0 ? 'fade' : 'none');
    this.form.setValue('audio-exit-preset', audioValues.exitMs > 0 ? 'fade' : 'none');
    this.form.setValue('audio-path', audioValues.sourcePath);
    this.form.setValue('audio-volume', String(audioValues.volume));
    this.form.setChecked('audio-muted', audioValues.muted);
    this.form.setChecked('audio-loop', audioValues.loop === true);
    this.form.setChecked('audio-loop-indefinitely', audioValues.loopIndefinitely === true);
    this.form.setValue('audio-on-break', audioValues.onBreak ?? 'pause');
    this.form.setOutput('[data-stagecraft-audio-duration]', audio?.properties.durationMs === undefined
      ? this.form.t('MetadataMissing') : (audio.properties.durationMs / 1000).toFixed(2) + ' s');

    const button = inspectedClip('button') as ButtonClip | undefined;
    this.paintButtonFields(value, button);

  }

  prepareMediaFadePreset(sequence: SequenceV1, clip: SequenceClip | undefined, editField?: string): void {
    const match = /^audio-(entrance|exit)-preset$/.exec(editField ?? '');
    if (!match) return;
    if (!clip || clip.type !== 'audio') return;
    const phase = match[1] as 'entrance' | 'exit';
    const field = this.form.field(`${clip.type}-${phase}`);
    const preset = this.form.field(`${clip.type}-${phase}-preset`);
    if (!field || !preset || preset.disabled) return;
    const opposite = phase === 'entrance' ? 'exit' : 'entrance';
    const currentMs = Math.round(Number(field.value) * 1000);
    const other = clip[opposite];
    const otherField = this.form.field(`${clip.type}-${opposite}`);
    const oppositeMs = otherField ? Math.round(Number(otherField.value) * 1000) : other.preset === 'none' ? 0 : other.durationMs;
    if (!Number.isFinite(currentMs) || !Number.isFinite(oppositeMs)) return;
    const values = mediaFadeChoiceDurations(preset.value, currentMs, oppositeMs, clipDurationMs(sequence, clip) ?? null);
    this.form.setValue(`${clip.type}-${phase}`, String(values.durationMs / 1000));
    if (otherField) this.form.setValue(`${clip.type}-${opposite}`, String(values.oppositeMs / 1000));
  }

  /** Seed a newly enabled animation within the available clip time. */
  prepareAnimationPreset(sequence: SequenceV1, clip: SequenceClip | undefined, editField?: string): void {
    if (!clip || clip.type === 'audio') return;
    const prefix = clip.type + '-';
    const direction = editField === prefix + 'entrance-preset' ? 'entrance' : editField === prefix + 'exit-preset' ? 'exit' : null;
    if (!direction || (direction === 'exit' && clip.type !== 'video' && clip.duration.kind !== 'fixed')) return;
    const preset = this.form.field(prefix + direction + '-preset')?.value;
    const duration = this.form.field(prefix + direction);
    if (!duration || !preset || preset === 'none') return;
    const motionId = preset.startsWith('text-motion:') ? preset.slice('text-motion:'.length) as TextMotionId : undefined;
    const motionPreset = motionId ? textMotionPreset(motionId) : undefined;
    const selectedMotion = clip.type === 'text' && motionPreset ? motionId : undefined;
    if (selectedMotion) {
      const sameMotion = clip[direction].preset === 'text-motion' && clip[direction].motion === selectedMotion;
      if (!sameMotion) {
        this.form.setValue(prefix + direction + '-easing', direction === 'entrance' ? 'ease-out' : 'ease-in');
        this.form.setValue(prefix + direction + '-amount', '1');
        this.form.setValue(prefix + direction + '-stagger', '35');
        this.form.setValue(prefix + direction + '-motion-direction', 'default');
        this.form.setValue(prefix + direction + '-motion-order', 'default');
      }
      if (clip[direction].preset !== 'none') {
        return;
      }
    } else if (clip[direction].preset !== 'none') return;
    const opposite = direction === 'entrance' ? 'exit' : 'entrance';
    const other = clip[opposite];
    const otherMs = other.preset === 'none' || (opposite === 'exit' && clip.duration.kind === 'sequence-end') ? 0 : other.durationMs;
    const length = clipDurationMs(sequence, clip);
    let nextMs = selectedMotion && motionPreset ? motionPreset.durationMs : Number(duration.value) * 1000 || 800;
    if (typeof length === 'number') {
      nextMs = Math.max(1, Math.min(nextMs, length - otherMs > 0 ? length - otherMs : Math.ceil(length / 2)));
      if (clip.duration.kind === 'fixed' && nextMs + otherMs > length) {
        this.form.setValue(prefix + opposite, String((length - nextMs) / 1000));
        if (length === nextMs) this.form.setValue(prefix + opposite + '-preset', 'none');
      }
    }
    this.form.setValue(prefix + direction, String(nextMs / 1000));
  }

  paintBarsAnimations(clip?: BarsClip, editField?: string): void {
    for (const direction of ['entrance', 'exit'] as const) {
      const transition = clip?.[direction];
      const preset = transition?.preset ?? (direction === 'entrance' ? 'fade' : 'none');
      const milliseconds = transition && transition.preset !== 'none' ? transition.durationMs : 0;
      this.form.setValue('bars-' + direction + '-preset', preset);
      const name = 'bars-' + direction;
      if (editField !== name || Math.round(Number(this.form.field(name)?.value) * 1000) !== milliseconds) {
        this.form.setValue(name, String(milliseconds / 1000));
      }
    }
  }

  paintTextAnimations(clip?: TextClip, editField?: string): void {
    this.paintMotionAnimations('text', clip, editField);
  }

  paintImageAnimations(clip?: ImageClip, editField?: string): void {
    this.paintMotionAnimations('image', clip, editField);
  }

  paintVideoAnimations(clip?: VideoClip, editField?: string): void {
    this.paintMotionAnimations('video', clip, editField);
  }

  paintSolidFields(sequence: SequenceV1, clip: SolidClip | undefined): void {
    if (this.form.root) paintAnimatedSurfaceInspector(this.form.root, clip, key => key.startsWith('STAGECRAFT.') ? this.form.localize(key) : this.form.t(key), (name, value) => this.form.setValue(name, value));
    const p = clip?.properties;
    this.form.setValue('solid-color', p?.color ?? '#ffffff');
    this.form.setValue('solid-alpha-path', p?.alphaMap?.path ?? '');
    this.form.setValue('solid-start', String((clip?.startMs ?? 0) / 1000));
    this.form.setValue('solid-duration-mode', clip?.duration.kind ?? 'fixed');
    const duration = clip && clipDurationMs(sequence, clip);
    this.form.setValue('solid-duration', String((duration ?? DEFAULT_IMAGE.durationMs) / 1000));
    this.form.setOutput('[data-stagecraft-solid-end]', clip ? typeof duration === 'number'
      ? ((clip.startMs + duration) / 1000).toFixed(2) + ' s' : this.form.t('ImageEndAtSequence') : '');
    this.paintMotionAnimations('solid', clip);
    this.form.setValue('solid-fit', p?.fit ?? 'cover');
    const box = p?.box ?? DEFAULT_IMAGE.box;
    for (const axis of ['x', 'y', 'width', 'height'] as const) this.form.setValue('solid-' + axis, String(box[axis]));
    const crop = p?.crop ?? DEFAULT_IMAGE.crop;
    for (const axis of ['x', 'y', 'width', 'height'] as const) this.form.setValue('solid-crop-' + axis, shiftDecimalText(crop[axis], 2));
    (p?.mask ?? DEFAULT_IMAGE.mask).forEach((point, index) => {
      this.form.setValue(`solid-mask-${index}-x`, shiftDecimalText(point.x, 2));
      this.form.setValue(`solid-mask-${index}-y`, shiftDecimalText(point.y, 2));
    });
    const appearance = clip?.appearance ?? DEFAULT_IMAGE.appearance!;
    this.form.setValue('solid-blend-mode', appearance.blendMode);
    this.form.setValue('solid-opacity', String(appearance.opacity));
    const outline = p?.outline ?? DEFAULT_IMAGE.outline!, shadow = p?.shadow ?? DEFAULT_IMAGE.shadow!, glow = p?.glow ?? DEFAULT_IMAGE.glow!;
    this.form.setChecked('solid-outline-enabled', outline.enabled);
    this.form.setValue('solid-outline-color', outline.color); this.form.setValue('solid-outline-opacity', String(outline.opacity));
    this.form.setValue('solid-outline-width', String(outline.width));
    this.form.setChecked('solid-shadow-enabled', shadow.enabled);
    this.form.setValue('solid-shadow-color', shadow.color); this.form.setValue('solid-shadow-opacity', String(shadow.opacity));
    this.form.setValue('solid-shadow-offset-x', String(shadow.offsetX)); this.form.setValue('solid-shadow-offset-y', String(shadow.offsetY));
    this.form.setValue('solid-shadow-blur', String(shadow.blur));
    this.form.setChecked('solid-glow-enabled', glow.enabled);
    this.form.setValue('solid-glow-color', glow.color); this.form.setValue('solid-glow-opacity', String(glow.opacity));
    this.form.setValue('solid-glow-radius', String(glow.radius));
  }

  paintMotionAnimations(type: 'text' | 'image' | 'solid' | 'video' | 'button', clip?: TextClip | ImageClip | SolidClip | VideoClip | ButtonClip, editField?: string): void {
    for (const phase of ['entrance', 'exit'] as const) {
      const transition = clip?.[phase];
      const timed = transition?.preset !== 'none' ? transition : undefined;
      const prefix = type + '-' + phase;
      const motionId = type === 'text' && timed?.preset === 'text-motion' ? timed.motion : undefined;
      const motionPreset = motionId ? textMotionPreset(motionId) : undefined;
      const validMotion = motionPreset ? motionId : undefined;
      this.form.setValue(prefix + '-preset', validMotion ? 'text-motion:' + validMotion : transition?.preset ?? 'fade');
      const milliseconds = timed?.durationMs ?? (clip || type === 'video' ? 0 : 800);
      if (editField !== prefix || Math.round(Number(this.form.field(prefix)?.value) * 1000) !== milliseconds) this.form.setValue(prefix, String(milliseconds / 1000));
      this.form.setValue(prefix + '-easing', timed?.easing ?? 'ease-in-out');
      this.form.setValue(prefix + '-direction', timed?.direction ?? 'down');
      this.form.setValue(prefix + '-distance', String(timed?.distance ?? 100));
      this.form.setValue(prefix + '-scale', shiftDecimalText(timed?.scale ?? 0.8, 2));
      if (type === 'text') {
        this.form.setValue(prefix + '-motion-direction', timed?.preset === 'text-motion' ? timed.motionDirection ?? 'default' : 'default');
        this.form.setValue(prefix + '-motion-order', timed?.preset === 'text-motion' ? timed.motionOrder ?? 'default' : 'default');
        this.form.setValue(prefix + '-amount', String(validMotion && timed?.preset === 'text-motion' ? timed.amount ?? 1 : 1));
        this.form.setValue(prefix + '-stagger', String(shiftDecimalText(validMotion && timed?.preset === 'text-motion' ? timed.stagger ?? 0.35 : 0.35, 2)));
      }
    }
  }

  paintButtonFields(sequence: SequenceV1, clip?: ButtonClip): void {
    const properties = clip?.properties ?? DEFAULT_BUTTON_PROPERTIES;
    const action = properties.action;
    const outline = properties.outline ?? DEFAULT_BUTTON.outline!;
    const shadow = properties.shadow ?? DEFAULT_BUTTON.shadow!;
    const glow = properties.glow ?? DEFAULT_BUTTON.glow!;
    const appearance = clip?.appearance ?? { blendMode: 'normal', opacity: 1 };
    const designPicker = this.form.field<HTMLSelectElement>('button-design');
    if (designPicker && !designPicker.options.length) {
      for (const design of [{ id: 'custom', label: 'ButtonDesignCustom' }, ...BUTTON_DESIGNS]) {
        const option = document.createElement('option'); option.value = design.id; option.textContent = this.form.t(design.label);
        designPicker.append(option);
      }
    }
    this.form.setValue('button-design', clip ? buttonDesignId(properties) : 'custom');
    this.form.setValue('button-label', properties.label);
    this.form.setValue('button-action', action.kind);
    this.form.setValue('button-decision-name', '');
    this.form.setValue('button-decision-group', action.kind === 'choice' ? `existing:${action.decisionId}` : '__new__');
    this.paintButtonDecisionGroups(sequence, clip);
    this.form.setValue('button-message', action.kind === 'choice' ? action.message : '');
    this.form.setValue('button-visibility', action.kind === 'choice' ? action.visibility : 'gm');
    this.form.setValue('button-start', String((clip?.startMs ?? DEFAULT_BUTTON.startMs) / 1000));
    this.paintMotionAnimations('button', clip);
    this.form.setValue('button-duration-mode', clip?.duration.kind === 'fixed' ? 'fixed' : clip?.duration.kind === 'sequence-end' ? 'sequence-end' : DEFAULT_BUTTON.durationMode);
    this.form.setValue('button-duration', String((clip ? clipDurationMs(sequence, clip) ?? DEFAULT_BUTTON.durationMs : DEFAULT_BUTTON.durationMs) / 1000));
    this.form.setFontValue(properties.fontFamily, 'button-font');
    this.form.setValue('button-font-size', String(properties.fontSize));
    this.form.setValue('button-color', properties.color);
    this.form.setValue('button-background', properties.backgroundColor);
    this.form.setValue('button-blend-mode', appearance.blendMode);
    this.form.setValue('button-opacity', String(appearance.opacity));
    this.form.setValue('button-shape', properties.shape);
    this.form.setValue('button-texture', properties.texture?.kind === 'builtin' ? properties.texture.id : properties.texture?.kind === 'foundry-file' ? 'foundry-file' : 'none');
    this.form.setValue('button-texture-path', properties.texture?.kind === 'foundry-file' ? properties.texture.path : '');
    this.form.setValue('button-texture-fit', properties.texture?.kind === 'foundry-file' ? properties.texture.fit : 'cover');
    this.form.setValue('button-x', String(properties.box.x)); this.form.setValue('button-y', String(properties.box.y));
    this.form.setValue('button-width', String(properties.box.width)); this.form.setValue('button-height', String(properties.box.height));
    this.form.setChecked('button-outline-enabled', outline.enabled);
    this.form.setValue('button-outline-color', outline.color); this.form.setValue('button-outline-opacity', String(outline.opacity)); this.form.setValue('button-outline-width', String(outline.width));
    this.form.setChecked('button-shadow-enabled', shadow.enabled);
    this.form.setValue('button-shadow-color', shadow.color); this.form.setValue('button-shadow-opacity', String(shadow.opacity));
    this.form.setValue('button-shadow-offset-x', String(shadow.offsetX)); this.form.setValue('button-shadow-offset-y', String(shadow.offsetY)); this.form.setValue('button-shadow-blur', String(shadow.blur));
    this.form.setChecked('button-glow-enabled', glow.enabled);
    this.form.setValue('button-glow-color', glow.color); this.form.setValue('button-glow-opacity', String(glow.opacity)); this.form.setValue('button-glow-radius', String(glow.radius));
  }

  paintButtonDecisionGroups(sequence: SequenceV1, clip?: ButtonClip): void {
    const select = this.form.field<HTMLSelectElement>('button-decision-group');
    if (!select) return;
    const groups = getButtonDecisionGroups(sequence);
    const preferred = select.value === '__new__' ? '__new__'
      : select.value.startsWith('existing:') && groups.has(select.value.slice('existing:'.length)) ? select.value
      : clip?.properties.action.kind === 'choice' && groups.has(clip.properties.action.decisionId)
        ? `existing:${clip.properties.action.decisionId}` : '__new__';
    select.replaceChildren();
    const newOption = document.createElement('option'); newOption.value = '__new__'; newOption.textContent = this.form.t('ButtonNewDecisionGroup'); select.append(newOption);
    for (const [decisionId, labels] of groups) {
      const option = document.createElement('option'); option.value = `existing:${decisionId}`;
      option.textContent = labels.length ? labels.join(' / ') : this.form.t('ButtonDecisionUnnamed');
      select.append(option);
    }
    select.value = preferred;
  }

}
