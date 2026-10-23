import { getPlaybackSchemaVersion } from '../domain/sequence-audience.js';
import type { SequenceClip, SequenceV1, TimelineBreak } from '../domain/sequence.js';
import type { TemplateEnvelopeV1 } from '../domain/element-template.js';
import { createElementTemplate, instantiateElementTemplate } from '../domain/element-template.js';
import { clipDurationMs } from '../domain/clip-timing.js';
import { upgradeSequenceToBreaks } from '../domain/breaks.js';
import { SEQUENCE_LIMITS, validateSequence } from '../domain/validation.js';
import { applyTimelineCommand, enableAutomaticEnd, TimelineCommandError } from './timeline-commands.js';

export type TimelineClipboardSelection =
  | { readonly kind: 'clip'; readonly id: string }
  | { readonly kind: 'break'; readonly id: string };

export interface TimelineClipboardPlacement {
  readonly positionMs: number;
  /** An explicit lane must be compatible and unlocked; omission chooses an unlocked compatible lane. */
  readonly trackId?: string;
}

export interface TimelineClipboardPaste {
  readonly sequence: SequenceV1;
  readonly selection: TimelineClipboardSelection;
}

type ClipboardContent =
  | { readonly kind: 'clip'; readonly template: TemplateEnvelopeV1; readonly type: SequenceClip['type']; readonly durationMs: number | null | undefined }
  | { readonly kind: 'break'; readonly marker: TimelineBreak };

function fail(code: string, message: string): never {
  throw new TimelineCommandError(code, message);
}

/** Editor-local copies only: this service never writes history, persisted data or live snapshots. */
export class TimelineClipboard {
  private content: ClipboardContent | null = null;

  get hasContent(): boolean { return this.content !== null; }
  get kind(): TimelineClipboardSelection['kind'] | null { return this.content?.kind ?? null; }
  get clipType(): SequenceClip['type'] | null { return this.content?.kind === 'clip' ? this.content.type : null; }

  clear(): void { this.content = null; }

  copy(sequence: SequenceV1, selection: TimelineClipboardSelection): void {
    this.stageCopy(sequence, selection)();
  }

  /** Capture before a cut, then call the returned commit only after removal succeeds. */
  stageCopy(sequence: SequenceV1, selection: TimelineClipboardSelection): () => void {
    const source = validateSequence(sequence);
    let captured: ClipboardContent;
    if (selection.kind === 'break') {
      const marker = source.breaks?.find(item => item.id === selection.id);
      if (!marker) fail('BREAK_NOT_FOUND', `Break marker "${selection.id}" does not exist.`);
      captured = { kind: 'break', marker: structuredClone(marker) };
    } else {
      const clip = source.clips.find(item => item.id === selection.id);
      if (!clip) fail('CLIP_NOT_FOUND', `Clip "${selection.id}" does not exist.`);
      captured = {
        kind: 'clip', type: clip.type,
        template: createElementTemplate('timeline_clipboard', 'Timeline clipboard', clip, source.composition),
        durationMs: clipDurationMs(source, clip),
      };
    }
    return () => { this.content = captured; };
  }

  /** Return one validated draft transaction; overlap always allocates a new lane. */
  paste(sequence: SequenceV1, placement: TimelineClipboardPlacement, makeId: () => string): TimelineClipboardPaste {
    const content = this.content;
    if (!content) fail('CLIPBOARD_EMPTY', 'The editor clipboard is empty.');
    const { positionMs } = placement;
    if (!Number.isSafeInteger(positionMs) || positionMs < 0 || positionMs > SEQUENCE_LIMITS.timelineMs) {
      fail(content.kind === 'break' ? 'BREAK_POSITION_INVALID' : 'INVALID_TIME', 'Paste requires a whole-millisecond position within the supported timeline.');
    }
    const source = validateSequence(sequence);
    if (content.kind === 'break') {
      // Pasting a marker is the same explicit adoption as adding an inner Break.
      const base = getPlaybackSchemaVersion(source) === 1 ? upgradeSequenceToBreaks(source) : source;
      let id = '';
      const added = applyTimelineCommand(base, { kind: 'add-break', positionMs }, () => (id = makeId()));
      const result = validateSequence({
        ...added,
        breaks: added.breaks!.map(marker => marker.id === id
          ? { ...structuredClone(content.marker), id, positionMs } : marker),
      });
      return { sequence: result, selection: { kind: 'break', id } };
    }

    const trackKind = content.type === 'audio' ? 'audio' : 'visual';
    const requestedTrack = placement.trackId === undefined ? undefined : source.tracks.find(track => track.id === placement.trackId);
    if (placement.trackId !== undefined && !requestedTrack) fail('TRACK_NOT_FOUND', `Track "${placement.trackId}" does not exist.`);
    if (requestedTrack?.locked) fail('TRACK_LOCKED', `Track "${requestedTrack.id}" is locked.`);
    if (requestedTrack && requestedTrack.kind !== trackKind) fail('INCOMPATIBLE_TRACK', 'This clip type is incompatible with its track kind.');

    // Use the editor's existing timing-edit opt-in, retaining intentional manual/fixed ends.
    const legacyEnd = source.end.kind === 'media' || source.end.kind === 'fixed' && source.end.automatic === undefined;
    let base = legacyEnd ? enableAutomaticEnd(source) : source;
    let targetTrack = requestedTrack ?? [...base.tracks].sort((a, b) => a.order - b.order)
      .find(track => !track.locked && track.kind === trackKind);
    const addTrack = () => {
      const previous = new Set(base.tracks.map(track => track.id));
      base = applyTimelineCommand(base, { kind: 'add-track', trackKind }, makeId);
      return base.tracks.find(track => !previous.has(track.id))!;
    };
    if (!targetTrack) targetTrack = addTrack();

    let clip = instantiateElementTemplate(content.template,
      { trackId: targetTrack.id, startMs: positionMs, composition: base.composition }, makeId);
    // Like a body move, carry a resolved held visual interval into automatic timing.
    // This also allows Paste at a playhead beyond the previous sequence endpoint.
    if (base.end.kind === 'fixed' && base.end.automatic === true && clip.type !== 'video' && clip.type !== 'audio'
      && clip.duration.kind === 'sequence-end') {
      // Shared conversion also fits transitions that previously ended at a global hold.
      // An unbounded legacy hold uses that conversion's standard finite fallback.
      const frozen = enableAutomaticEnd({
        ...base, clips: [{ ...clip, startMs: 0 }],
        end: typeof content.durationMs === 'number'
          ? { kind: 'fixed', durationMs: content.durationMs }
          : { kind: 'manual' },
      }).clips[0]!;
      clip = { ...frozen, startMs: positionMs } as SequenceClip;
    }
    let result: SequenceV1;
    try {
      result = applyTimelineCommand(base, { kind: 'insert-clip', clip }, makeId);
    } catch (error) {
      if (!(error instanceof TimelineCommandError) || error.code !== 'CLIP_OVERLAP') throw error;
      const track = addTrack();
      clip = { ...clip, trackId: track.id } as SequenceClip;
      result = applyTimelineCommand(base, { kind: 'insert-clip', clip }, makeId);
    }
    return { sequence: result, selection: { kind: 'clip', id: clip.id } };
  }
}
