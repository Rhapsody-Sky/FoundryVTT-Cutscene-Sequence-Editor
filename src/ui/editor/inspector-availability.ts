import { getPlaybackSchemaVersion } from '../../domain/sequence-audience.js';
import { isTerminalManualClip, manualEndNeedsDuration } from '../../domain/clip-timing.js';
import { textMotionPreset, textMotionControls, type TextMotionId } from '../../domain/text-motion.js';
import { textMotionSegmentCount, type TextMotionLayout } from '../../rendering/text-motion-renderer.js';
import type { AudioClip, SequenceClip, SequenceV1, TimelineBreak } from '../../domain/sequence.js';
import { MAX_AUDIO_DURATION_MS } from './inspector-defaults.js';
import { sameJsonData } from './inspector-values.js';
import { InspectorFields } from './inspector-fields.js';
import type { InspectorForm, FieldElement } from './inspector-form.js';

/** Applies inspector visibility, constraints and disabled state from an explicit snapshot. */
export class InspectorAvailability {
  constructor(private readonly form: InspectorForm) {}

  paint(sequence: SequenceV1 | null, clip: SequenceClip | undefined, marker: TimelineBreak | undefined,
    busy: boolean, canChooseImage: boolean, textMotionLayouts: ReadonlyMap<string, TextMotionLayout>): boolean {
    const root = this.form.root;
    if (!root) return false;
    const breakField = this.form.field('break-position');
    if (breakField) {
      breakField.disabled = busy || !marker || !sequence || getPlaybackSchemaVersion(sequence) !== 3;
      if (document.activeElement !== breakField) this.form.setValue('break-position', marker ? String(marker.positionMs / 1000) : '');
    }
    const removeBreak = root.querySelector<HTMLButtonElement>('[data-stagecraft-action="remove-break"]');
    if (removeBreak) removeBreak.disabled = busy || !marker || !sequence || getPlaybackSchemaVersion(sequence) !== 3;
    const locked=sequence?.tracks.find(t=>t.id===clip?.trackId)?.locked??false;
    for(const panel of root.querySelectorAll<HTMLElement>('[data-stagecraft-element-panel]')) {
      panel.hidden=panel.dataset.stagecraftElementPanel!==clip?.type;
      const empty=panel.querySelector<HTMLElement>('[data-stagecraft-element-empty]'); if(empty)empty.hidden=!!clip;
      for(const field of panel.querySelectorAll<FieldElement>('[name]'))field.disabled=busy||locked||!clip||panel.hidden;
    }
    const patterned = clip?.type === 'solid' && !!clip.properties.pattern;
    const staticColor = root.querySelector<HTMLElement>('[data-stagecraft-static-solid-color]');
    if (staticColor) staticColor.hidden = patterned;
    const staticColorField = this.form.field('solid-color');
    if (staticColorField) staticColorField.disabled = busy || locked || clip?.type !== 'solid' || patterned;
    for (const group of root.querySelectorAll<HTMLElement>('[data-stagecraft-pattern-settings]')) {
      group.hidden = !patterned;
      for (const field of group.querySelectorAll<FieldElement>('[name]')) field.disabled = busy || locked || !patterned;
    }
    for (const label of root.querySelectorAll<HTMLElement>('[data-stagecraft-pattern-legacy]')) {
      label.hidden = clip?.type === 'solid' && clip.properties.pattern?.version === 2;
      for (const field of label.querySelectorAll<FieldElement>('[name]')) field.disabled = busy || locked || !patterned || label.hidden;
    }
    if (sequence) new InspectorFields(this.form).paintButtonDecisionGroups(sequence, clip?.type === 'button' ? clip : undefined);
    const choiceAction = clip?.type === 'button' && this.form.field<HTMLSelectElement>('button-action')?.value === 'choice';
    const choiceGroup = this.form.field<HTMLSelectElement>('button-decision-group')?.value ?? '__new__';
    const newChoiceGroup = choiceGroup === '__new__';
    for (const group of root.querySelectorAll<HTMLElement>('[data-stagecraft-button-choice]')) group.hidden = !choiceAction;
    const decisionGroup = this.form.field<HTMLSelectElement>('button-decision-group');
    if (decisionGroup) decisionGroup.disabled = busy || locked || clip?.type !== 'button' || !choiceAction;
    const decisionName = this.form.field<HTMLInputElement>('button-decision-name');
    if (decisionName) {
      decisionName.disabled = busy || locked || clip?.type !== 'button' || !choiceAction || !newChoiceGroup;
      decisionName.required = !!choiceAction && newChoiceGroup;
    }
    for (const name of ['button-message', 'button-visibility']) {
      const field = this.form.field(name);
      if (field) field.disabled = busy || locked || clip?.type !== 'button' || !choiceAction;
    }
    const message = this.form.field('button-message');
    if (message) message.required = !!choiceAction;
    const customButtonTexture = clip?.type === 'button' && this.form.field<HTMLSelectElement>('button-texture')?.value === 'foundry-file';
    for (const row of root.querySelectorAll<HTMLElement>('[data-stagecraft-button-custom-texture]')) {
      row.hidden = !customButtonTexture;
      for (const field of row.querySelectorAll<FieldElement>('[name]')) {
        field.disabled = busy || locked || clip?.type !== 'button' || !customButtonTexture;
        if (field.name === 'button-texture-path') field.required = !!customButtonTexture;
      }
    }
    const buttonTextureFit = this.form.field('button-texture-fit');
    if (buttonTextureFit) buttonTextureFit.disabled = busy || locked || clip?.type !== 'button' || !customButtonTexture;
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-stagecraft-action="solid-pattern-variant"],[data-stagecraft-action="solid-pattern-palette"],[data-stagecraft-action="solid-add-point"],[data-stagecraft-action="solid-remove-point"]')) {
      button.disabled = busy || locked || clip?.type !== 'solid'
        || button.dataset.stagecraftAction?.startsWith('solid-pattern') === true && !patterned
        || button.dataset.boundDisabled === 'true';
    }
    const alphaPath = this.form.field('solid-alpha-path')?.value ?? '';
    for (const group of root.querySelectorAll<HTMLElement>('[data-stagecraft-solid-alpha-dependent]')) {
      group.hidden = !alphaPath;
      for (const field of group.querySelectorAll<FieldElement>('[name]')) field.disabled = busy || locked || clip?.type !== 'solid' || !alphaPath;
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-stagecraft-action="choose-solid-alpha"],[data-stagecraft-action="clear-solid-alpha"],[data-stagecraft-action="reset-solid-mask"]')) {
      button.disabled = busy || locked || clip?.type !== 'solid'
        || button.dataset.stagecraftAction === 'choose-solid-alpha' && !canChooseImage
        || button.dataset.stagecraftAction === 'clear-solid-alpha' && !alphaPath;
    }
    const keyingEnabled = this.form.field<HTMLInputElement>('video-keying-enabled')?.checked === true;
    const positioned = this.form.field<HTMLInputElement>('video-positioned')?.checked === true;
    const boxFields = root.querySelector<HTMLElement>('[data-stagecraft-video-box]');
    if (boxFields) boxFields.hidden = !positioned;
    for (const name of ['video-x', 'video-y', 'video-width', 'video-height']) {
      const field = this.form.field(name);
      if (field) field.disabled = busy || locked || clip?.type !== 'video' || !positioned;
    }
    for (const name of ['video-keying-color', 'video-keying-tolerance', 'video-keying-softness']) {
      const field = this.form.field(name);
      if (field) field.disabled = busy || locked || clip?.type !== 'video' || !keyingEnabled;
    }
    for(const type of ['bars','text','image','solid','button'] as const) { const duration=this.form.field(type+'-duration'); if(duration)duration.disabled=busy||locked||clip?.type!==type||this.form.field(type+'-duration-mode')?.value==='sequence-end'; }
    const barsHeld = clip?.type === 'bars' && this.form.field('bars-duration-mode')?.value === 'sequence-end';
    for (const direction of ['entrance', 'exit'] as const) {
      const preset = this.form.field('bars-' + direction + '-preset');
      const duration = this.form.field('bars-' + direction);
      const unavailable = busy || locked || clip?.type !== 'bars' || (direction === 'exit' && barsHeld);
      if (preset) preset.disabled = unavailable;
      if (duration) duration.disabled = unavailable || preset?.value === 'none';
      for (const row of root.querySelectorAll<HTMLElement>('[data-stagecraft-bars-animation-duration="' + direction + '"]')) row.hidden = preset?.value === 'none';
      for (const row of root.querySelectorAll<HTMLElement>('[data-stagecraft-bars-animation="' + direction + '"]')) row.title = direction === 'exit' && barsHeld ? this.form.t('BarsOutHeldHint') : '';
    }
    for (const type of ['text', 'image', 'solid', 'video', 'button'] as const) {
      const held = type !== 'video' && clip?.type === type && this.form.field(type + '-duration-mode')?.value === 'sequence-end';
      for (const phase of ['entrance', 'exit'] as const) {
        const prefix = type + '-' + phase;
        const preset = this.form.field(prefix + '-preset');
        const optionMotionId = type === 'text' && preset?.value.startsWith('text-motion:')
          ? preset.value.slice('text-motion:'.length) as TextMotionId : undefined;
        const optionMotion = optionMotionId ? textMotionPreset(optionMotionId) : undefined;
        const isTextMotion = !!optionMotion;
        const layout = clip?.type === 'text' ? textMotionLayouts.get(clip.id) : undefined;
        const measured = clip?.type === 'text' && layout
          && sameJsonData(layout.clip.properties, clip.properties) ? layout : undefined;
        const controls = optionMotion ? textMotionControls(optionMotion.id, {
          segmentCount: measured?.counts[optionMotion.unit]
            ?? textMotionSegmentCount(clip?.type === 'text' ? clip.properties.text : '', optionMotion.unit),
          amount: Number(this.form.field(prefix + '-amount')?.value ?? 1),
          stagger: Number(this.form.field(prefix + '-stagger')?.value ?? 35) / 100
        }) : undefined;
        const unavailable = busy || locked || clip?.type !== type || phase === 'exit' && held;
        if (preset) preset.disabled = unavailable;
        for (const [suffix, visible] of [
          ['', preset?.value !== 'none'], ['-easing', preset?.value !== 'none'],
          ['-direction', preset?.value === 'slide' || preset?.value === 'fade-slide'],
          ['-distance', preset?.value === 'slide' || preset?.value === 'fade-slide'],
          ['-scale', preset?.value === 'zoom' || preset?.value === 'fade-zoom'],
          ['-amount', isTextMotion], ['-stagger', isTextMotion && !!optionMotion?.unit],
          ['-motion-direction', isTextMotion && !!controls?.directions], ['-motion-order', isTextMotion && !!controls?.order]
        ] as const) {
          const field = this.form.field(prefix + suffix);
          if (field) field.disabled = unavailable || !visible;
        }
        for (const row of root.querySelectorAll<HTMLElement>('[data-stagecraft-' + type + '-animation-param="' + phase + '"]')) {
          const kind = row.dataset.stagecraftAnimationKind;
          row.hidden = kind === 'motion' ? !isTextMotion
            : kind === 'motion-direction' ? !isTextMotion || !controls?.directions
            : kind === 'motion-order' ? !isTextMotion || !controls?.order
            : kind === 'slide' ? !['slide', 'fade-slide'].includes(preset?.value ?? '')
            : kind === 'zoom' ? !['zoom', 'fade-zoom'].includes(preset?.value ?? '') : preset?.value === 'none';
        }
        for (const row of root.querySelectorAll<HTMLElement>('[data-stagecraft-' + type + '-animation="' + phase + '"]')) {
          row.title = phase === 'exit' && held ? this.form.t(type === 'image' ? 'ImageOutHeldHint' : type === 'solid' ? 'SolidOutHeldHint' : type === 'button' ? 'ButtonOutHeldHint' : 'TitleOutHeldHint') : '';
        }
      }
    }
    const automatic = sequence?.end.kind === 'fixed' && sequence.end.automatic === true;
    for (const type of ['bars', 'text', 'image', 'solid', 'button'] as const) {
      const mode = this.form.field<HTMLSelectElement>(type + '-duration-mode');
      const held = mode && Array.from(mode.options).find(option => option.value === 'sequence-end');
      if (held) { held.disabled = automatic; held.hidden = automatic; }
    }
    const ending=this.form.field<HTMLSelectElement>('ending'), duration=this.form.field('sequence-duration'), endMedia=this.form.field('end-media'), track=this.form.field('clip-track');
    if(ending)ending.disabled=busy;
    const manualFallback = !!sequence && ending?.value === 'manual' && manualEndNeedsDuration(sequence);
    const durationRow = root.querySelector<HTMLElement>('[data-stagecraft-ending-duration]');
    if (durationRow) durationRow.hidden = ending?.value !== 'fixed' && !manualFallback;
    const durationLabel = root.querySelector<HTMLElement>('[data-stagecraft-duration-label]');
    if (durationLabel) durationLabel.textContent = this.form.t(manualFallback ? 'ManualEndAt' : 'Duration');
    if(duration)duration.disabled=busy||(ending?.value!=='fixed'&&!manualFallback);
    if(endMedia)endMedia.disabled=busy||ending?.value!=='media';
    for (const row of root.querySelectorAll<HTMLElement>('[data-stagecraft-ending-mode]')) {
      row.hidden = row.dataset.stagecraftEndingMode !== ending?.value;
    }
    for (const label of root.querySelectorAll<HTMLElement>('[data-stagecraft-break-behavior]')) {
      const type = label.dataset.stagecraftBreakBehavior;
      if (type !== 'audio' && type !== 'video') continue;
      const behavior = this.form.field<HTMLSelectElement>(type + '-on-break')?.value ?? 'pause';
      const suffix = behavior === 'loop' ? 'Loop' : behavior === 'finish' ? 'Finish' : 'Pause';
      label.title = this.form.t('Break' + suffix + 'Hint');
    }
    if(track)track.disabled=busy||!clip||locked;
    this.updateAudioDurationBounds(sequence, clip?.type === 'audio' ? clip : undefined, busy);
    const indefinite = this.form.field<HTMLInputElement>('audio-loop-indefinitely')?.checked === true;
    const audioLoop = this.form.field<HTMLInputElement>('audio-loop');
    if(audioLoop) audioLoop.disabled=busy||locked||clip?.type!=='audio'||indefinite;
    const indefiniteField = this.form.field<HTMLInputElement>('audio-loop-indefinitely');
    const playbackSchema = sequence ? getPlaybackSchemaVersion(sequence) : null;
    if(indefiniteField) indefiniteField.disabled=busy||locked||clip?.type!=='audio'
      || !(playbackSchema === 2 || playbackSchema === 3 || sequence && clip?.type === 'audio' && isTerminalManualClip(sequence, clip))
      || (!audioLoop?.checked && playbackSchema === 1);
    const audioPath = this.form.field('audio-path')?.value ?? '';
    const audioOut = this.form.field('audio-exit');
    const indefiniteAudio = clip?.type === 'audio' && clip.duration.kind === 'sequence-end';
    if (audioOut) {
      audioOut.disabled = busy || locked || clip?.type !== 'audio' || indefiniteAudio;
      const row = audioOut.closest<HTMLElement>('label');
      if (row) row.title = indefiniteAudio ? this.form.t('AudioOutHeldHint') : '';
    }
    const audioOutPicker = root.querySelector<HTMLElement>('[data-stagecraft-element-animation-picker="audio-exit"]');
    if (audioOutPicker) audioOutPicker.title = indefiniteAudio ? this.form.t('AudioOutHeldHint') : '';
    for(const button of root.querySelectorAll<HTMLButtonElement>('[data-stagecraft-action="choose-audio"],[data-stagecraft-action="inspect-audio"]')) {
      button.disabled=busy||!clip||clip.type!=='audio'||locked||(button.dataset.stagecraftAction==='inspect-audio'&&!audioPath.trim());
    }
    const selectedActions=root.querySelectorAll<HTMLButtonElement>('[data-stagecraft-action="duplicate-clip"],[data-stagecraft-action="remove-clip"]');
    for(const button of selectedActions)button.disabled=busy||!clip||locked;
    for(const button of root.querySelectorAll<HTMLButtonElement>('[data-stagecraft-action="toggle-element"]'))button.disabled=busy;
    return locked;
  }

  private audioSourcePeriodFromForm(clip: AudioClip | undefined): number | undefined {
    if (!clip || clip.properties.durationMs === undefined) return undefined;
    const sourceDurationMs = clip.properties.durationMs;
    const inField = this.form.field('audio-in'), outField = this.form.field('audio-out');
    const inMs = inField ? (inField.value === '' ? Number.NaN : Number(inField.value) * 1_000) : clip.properties.sourceRange?.inMs ?? 0;
    const outMs = outField ? (outField.value === '' ? Number.NaN : Number(outField.value) * 1_000) : clip.properties.sourceRange?.outMs ?? sourceDurationMs;
    if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || inMs < 0 || outMs > sourceDurationMs || inMs >= outMs) return undefined;
    return outMs - inMs;
  }

  /** Keep the nonlooping duration bound in step with source trims and Loop. */
  updateAudioDurationBounds(sequence: SequenceV1 | null, clip: AudioClip | undefined, busy: boolean, clampNonLooping = false): void {
    const loopField = this.form.field<HTMLInputElement>('audio-loop');
    const indefiniteField = this.form.field<HTMLInputElement>('audio-loop-indefinitely');
    const indefinite = indefiniteField?.checked === true;
    if (indefinite && loopField) loopField.checked = true;
    const looping = loopField?.checked === true;
    if (!looping && indefiniteField) indefiniteField.checked = false;
    const sourcePeriodMs = this.audioSourcePeriodFromForm(clip);
    const maximumMs = looping ? MAX_AUDIO_DURATION_MS : sourcePeriodMs ?? MAX_AUDIO_DURATION_MS;
    const duration = this.form.field<HTMLInputElement>('audio-clip-duration');
    if (duration) {
      duration.max = String(maximumMs / 1_000);
      duration.disabled = busy || !clip || indefinite;
      if (clampNonLooping && !looping && sourcePeriodMs !== undefined && duration.value !== '') {
        const entered = Number(duration.value);
        if (Number.isFinite(entered) && entered * 1_000 > sourcePeriodMs) duration.value = String(sourcePeriodMs / 1_000);
      }
    }
    if (indefiniteField) {
      const playbackSchema = sequence ? getPlaybackSchemaVersion(sequence) : null;
      const held = !!sequence && !!clip && (playbackSchema === 2 || playbackSchema === 3 || isTerminalManualClip(sequence, clip));
      const locked = !!clip && !!sequence?.tracks.find(track => track.id === clip.trackId)?.locked;
      indefiniteField.disabled = busy || !clip || locked || !held || (!looping && playbackSchema === 1);
    }
    if (loopField) loopField.disabled = busy || !clip || !!sequence?.tracks.find(track => track.id === clip.trackId)?.locked || indefinite;
    const durationRow = this.form.root?.querySelector<HTMLElement>('[data-stagecraft-audio-duration-mode="fixed"]');
    if (durationRow) durationRow.hidden = indefinite;
  }

}
