import { getPlaybackSchemaVersion } from '../domain/sequence-audience.js';
import type { SequenceClip, SequenceV1 } from '../domain/sequence.js';
import { clipDurationMs, effectiveClipFades, sequenceDurationMs } from '../domain/clip-timing.js';
import { applyEditorTimelineCommand, TimelineCommandError, type TimelineCommand } from '../application/timeline-commands.js';
import { SEQUENCE_LIMITS } from '../domain/validation.js';
import { TimelineContextMenu, type TimelineContextMenuItem } from './timeline-context-menu.js';

export type TimelineContextTarget =
  | { readonly kind: 'clip'; readonly id: string; readonly trackId: string }
  | { readonly kind: 'break'; readonly id: string }
  | { readonly kind: 'space'; readonly positionMs: number; readonly trackId?: string };

export interface TimelineCallbacks {
  select(id: string): void;
  selectBreak?(id: string | null): void;
  breakPosition?(id: string, positionMs: number): void;
  scrub(timeMs: number): void;
  command(command: TimelineCommand): void;
  error(error: unknown): void;
  beforeEdit(): void;
  contextItems?(target: TimelineContextTarget): readonly TimelineContextMenuItem[];
  contextAction?(action: string, target: TimelineContextTarget): void;
}
interface Gesture { pointerId: number; clip: SequenceClip; source: SequenceV1; x: number; y: number; scrollLeft: number; edge: 'start' | 'end' | undefined; candidate: TimelineCommand | null; invalidError: unknown | null; originalStyle: string; node: HTMLElement; parent: HTMLElement; }
interface BreakGesture { pointerId: number; breakId: string; source: SequenceV1; x: number; scrollLeft: number; candidate: TimelineCommand | null; invalidError: unknown | null; originalStyle: string; node: HTMLElement; }
interface ScrubGesture { pointerId: number; }
export interface TimelineFrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}
export interface TimelinePlaybackState {
  readonly phase: 'idle' | 'preparing' | 'playing' | 'paused' | 'holding' | 'exiting' | 'ended';
  readonly positionMs: number;
  readonly holdElapsedMs?: number;
  readonly breakId?: string;
  readonly items?: readonly { readonly clip: SequenceClip; readonly mediaPlayback?: 'playing' | 'paused' | 'looping' | 'finishing' | 'finished' }[];
}
const browserFrames: TimelineFrameScheduler = {
  request: callback => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : 0,
  cancel: id => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); }
};
const MAX_TIME_MS = SEQUENCE_LIMITS.timelineMs;
const TRACK_GUTTER_PX = 180;
/** Owns timeline DOM and pointer gestures. Draft state changes only once at pointerup. */
export class TimelineView {
  private sequence: SequenceV1 | null = null;
  private selected: string | null = null;
  private positionMs = 0;
  private playback: TimelinePlaybackState = { phase: 'idle', positionMs: 0 };
  private zoom = 80;
  private snapping = true;
  private pixelsPerSecond = 80;
  private gesture: Gesture | null = null;
  private breakGesture: BreakGesture | null = null;
  private scrubGesture: ScrubGesture | null = null;
  private selectedBreakId: string | null = null;
  private selectAddedBreak = false;
  private focusRemovedBreakId: string | null = null;
  private workspaceMs = 12000;
  private edgeFrame: number | null = null;
  private edgeFrameTime: number | null = null;
  private pointer = { x: 0, y: 0 };
  private abort = new AbortController();
  private readonly contextMenu: TimelineContextMenu;
  constructor(private readonly root: HTMLElement, private readonly t: (key: string) => string, private readonly callbacks: TimelineCallbacks, private readonly frames: TimelineFrameScheduler = browserFrames) {
    this.contextMenu = new TimelineContextMenu(root);
    root.addEventListener('contextmenu', event => this.openContextMenu(event), { signal: this.abort.signal });
    root.addEventListener('click', e => this.click(e), { signal: this.abort.signal });
    root.addEventListener('input', e => { const field=e.target; if(field instanceof HTMLInputElement && 'timelineScrub' in field.dataset)this.scrub(Number(field.value)); }, { signal: this.abort.signal });
    root.addEventListener('change', e => this.change(e), { signal: this.abort.signal });
    root.addEventListener('pointerdown', e => this.down(e), { signal: this.abort.signal });
    root.addEventListener('pointermove', e => this.move(e), { signal: this.abort.signal });
    root.addEventListener('pointerup', e => this.up(e), { signal: this.abort.signal });
    root.addEventListener('pointercancel', event => { if(this.gesture?.pointerId===event.pointerId || this.breakGesture?.pointerId===event.pointerId || this.scrubGesture?.pointerId===event.pointerId)this.cancel(); }, { signal: this.abort.signal });
    root.addEventListener('lostpointercapture', event => { if(this.gesture?.pointerId===event.pointerId || this.breakGesture?.pointerId===event.pointerId || this.scrubGesture?.pointerId===event.pointerId)this.cancel(); }, { signal: this.abort.signal });
    root.addEventListener('dblclick', e => this.doubleClickBreakLane(e), { signal: this.abort.signal });
    root.addEventListener('keydown', e => this.keydown(e), { signal: this.abort.signal });
  }
  dispose(): void { this.contextMenu.dispose(); this.cancel(); this.abort.abort(); }
  closeContextMenu(): void { this.contextMenu.close(false); }
  cancel(): void {
    this.stopEdgeScroll();
    const scrub = this.scrubGesture;
    if (scrub) { this.scrubGesture = null; this.releaseCapture(scrub.pointerId); }
    const breakGesture = this.breakGesture;
    if (breakGesture) {
      this.breakGesture = null; this.releaseCapture(breakGesture.pointerId);
      breakGesture.node.style.cssText = breakGesture.originalStyle;
      if (this.sequence) this.render(this.sequence, this.selected);
      const marker = this.sequence?.breaks?.find(item => item.id === breakGesture.breakId);
      if (marker) this.callbacks.breakPosition?.(marker.id, marker.positionMs);
      return;
    }
    const gesture = this.gesture; if (!gesture) return;
    this.gesture = null; this.releaseCapture(gesture.pointerId);
    gesture.node.style.cssText = gesture.originalStyle; gesture.node.classList.remove('stagecraft-invalid-gesture'); gesture.parent.append(gesture.node);
    if (this.sequence) this.render(this.sequence, this.selected);
  }
  private releaseCapture(pointerId: number): void {
    if (this.root.hasPointerCapture(pointerId)) this.root.releasePointerCapture(pointerId);
  }
  render(sequence: SequenceV1, selected: string | null, positionMs = this.positionMs, selectedBreakId?: string | null): void {
    this.closeContextMenu();
    if (selectedBreakId !== undefined) this.selectedBreakId = selectedBreakId;
    else if (selected && selected !== this.selected) this.selectedBreakId = null;
    this.selected=selected;
    if (this.gesture || this.breakGesture || this.scrubGesture) return;
    if (this.sequence && this.sequence.id !== sequence.id) {
      this.playback = { phase: 'idle', positionMs };
      this.selectedBreakId = null;
      this.selectAddedBreak = false;
      this.focusRemovedBreakId = null;
    }
    const oldBreakIds = new Set(this.sequence?.breaks?.map(marker => marker.id) ?? []);
    let preferredBreakFocus: string | null = null;
    let preferredActionFocus: string | null = null;
    if (this.selectAddedBreak) {
      const added = sequence.breaks?.find(marker => !oldBreakIds.has(marker.id));
      this.selectedBreakId = added?.id ?? this.selectedBreakId;
      preferredBreakFocus = added?.id ?? null;
      this.selectAddedBreak = false;
    }
    if (this.focusRemovedBreakId) {
      const removedId = this.focusRemovedBreakId;
      const removed = this.sequence?.breaks?.find(marker => marker.id === removedId);
      if (removed && !sequence.breaks?.some(marker => marker.id === removedId)) {
        const nearest = [...(sequence.breaks ?? [])].sort((left, right) =>
          Math.abs(left.positionMs - removed.positionMs) - Math.abs(right.positionMs - removed.positionMs))[0];
        this.selectedBreakId = nearest?.id ?? null;
        preferredBreakFocus = nearest?.id ?? null;
        if (!nearest) preferredActionFocus = 'snap';
      }
      this.focusRemovedBreakId = null;
    }
    if (this.selectedBreakId && !sequence.breaks?.some(marker => marker.id === this.selectedBreakId)) this.selectedBreakId = null;
    const focused=document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)?document.activeElement:null;
    const focusClip=focused?.dataset.timelineClip, focusTrack=focused?.dataset.trackName;
    const focusAction=preferredBreakFocus || preferredActionFocus ? undefined : focused?.dataset.timelineAction;
    const focusTrackAdd=focused && 'timelineTrackAdd' in focused.dataset;
    const focusElement=focused?.dataset.elementType, focusScrub=focused && 'timelineScrub' in focused.dataset, focusZoom=focused && 'timelineZoom' in focused.dataset, focusPlayhead=focused && 'timelinePlayhead' in focused.dataset;
    const focusBreak=preferredActionFocus ? undefined : preferredBreakFocus ?? focused?.dataset.timelineBreak;
    this.sequence = sequence; this.selected = selected; this.positionMs = positionMs;
    this.workspaceMs = this.extent(sequence);
    this.pixelsPerSecond=Math.min(80,28000/(this.extent(sequence)/1000))*(this.zoom/80);
    const previousScroller = this.root.querySelector<HTMLElement>('.stagecraft-timeline-scroll');
    const previousBreakScroller = this.root.querySelector<HTMLElement>('.stagecraft-break-lane-scroll');
    const previousScroll = previousScroller?.scrollLeft ?? 0, previousBreakScroll = previousBreakScroller?.scrollLeft ?? previousScroll, previousTop = previousScroller?.scrollTop ?? 0;
    this.root.replaceChildren();
    const toolbar = document.createElement('header'); toolbar.className = 'stagecraft-timeline-toolbar';
    const title = document.createElement('strong'); title.textContent = this.t('Timeline'); toolbar.append(title);
    const addTrack = document.createElement('select'); addTrack.dataset.timelineTrackAdd = '';
    addTrack.setAttribute('aria-label', this.t('AddTrack'));
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = this.t('AddTrack'); placeholder.disabled = true; placeholder.selected = true; addTrack.append(placeholder);
    for (const [kind, label] of [['visual', 'VisualTrack'], ['audio', 'AddAudioTrack']] as const) {
      const option = document.createElement('option'); option.value = kind; option.textContent = this.t(label); addTrack.append(option);
    }
    addTrack.value = ''; toolbar.append(addTrack);
    const markers = sequence.breaks ?? [];
    const snap = this.button(this.snapping ? 'SnapOn' : 'SnapOff', 'snap'); snap.setAttribute('aria-pressed', String(this.snapping)); toolbar.append(snap);
    const zoom = document.createElement('input'); zoom.type = 'range'; zoom.min = '20'; zoom.max = '240'; zoom.value = String(this.zoom); zoom.dataset.timelineZoom = ''; zoom.setAttribute('aria-label', this.t('Zoom')); toolbar.append(zoom);
    const scrub = document.createElement('input'); scrub.type = 'range'; scrub.min = '0'; scrub.max = String(this.extent(sequence)); scrub.step = '1'; scrub.value = String(positionMs); scrub.dataset.timelineScrub = ''; scrub.setAttribute('aria-label', this.t('Playhead')); toolbar.append(scrub);
    this.root.append(toolbar);
    const scroll = document.createElement('div'); scroll.className = 'stagecraft-timeline-scroll';
    const content = document.createElement('div'); content.className = 'stagecraft-timeline-content'; content.style.width = `${TRACK_GUTTER_PX + this.extent(sequence) / 1000 * this.pixelsPerSecond}px`;
    const ruler = document.createElement('div'); ruler.className = 'stagecraft-time-ruler'; ruler.dataset.timelineRuler = '';
    const corner = document.createElement('div'); corner.className = 'stagecraft-time-ruler-corner'; corner.dataset.timelineRulerCorner = ''; corner.textContent = this.t('Track'); corner.setAttribute('aria-hidden', 'true'); ruler.append(corner);
    this.paintRulerTicks(ruler);
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'stagecraft-playhead-handle'; handle.dataset.timelinePlayhead = ''; handle.style.left = `${180 + positionMs / 1000 * this.pixelsPerSecond}px`; handle.setAttribute('role', 'slider'); handle.setAttribute('aria-label', this.t('Playhead')); handle.setAttribute('aria-valuemin', '0'); handle.setAttribute('aria-valuemax', String(this.extent(sequence))); handle.setAttribute('aria-valuenow', String(positionMs)); handle.setAttribute('aria-valuetext', `${(positionMs / 1000).toFixed(2)} s`); ruler.append(handle);
    const endBreak = this.endBreakPosition(sequence);
    if (endBreak !== null) {
      const flag = document.createElement('span'); flag.className = 'stagecraft-end-break-flag'; flag.dataset.endBreakFlag = '';
      flag.style.left = `${TRACK_GUTTER_PX + endBreak / 1000 * this.pixelsPerSecond}px`;
      flag.title = this.t('EndBreak'); flag.setAttribute('aria-label', this.t('EndBreak')); flag.setAttribute('role', 'img');
      ruler.append(flag);
    }
    content.append(ruler);
    for (const track of [...sequence.tracks].sort((a,b) => b.order - a.order)) {
      const row = document.createElement('div'); row.className = `stagecraft-track-row${track.kind === 'audio' ? ' stagecraft-track-audio' : ''}`; row.dataset.timelineTrack = track.id; row.dataset.trackKind = track.kind; row.classList.toggle('stagecraft-track-disabled', !track.enabled);
      const heading = document.createElement('div'); heading.className = 'stagecraft-track-heading';
      if (track.kind === 'audio') { const icon = document.createElement('i'); icon.className = 'fa-solid fa-volume-high stagecraft-track-kind-icon'; icon.setAttribute('aria-hidden', 'true'); heading.append(icon); }
      const name = document.createElement('input'); name.type = 'text'; name.value = track.name; name.dataset.trackName = track.id; name.setAttribute('aria-label', this.t('TrackName')); heading.append(name);
      for (const [action,label,symbol] of [['enabled','TrackVisible','◉'],['locked','TrackLocked','🔒'],['up','TrackFront','↑'],['down','TrackBack','↓'],['remove-track','RemoveTrack','×']] as const) {
        const button = this.button(label, action); button.dataset.trackId = track.id; button.textContent = symbol;
        if (action === 'enabled' || action === 'locked') button.setAttribute('aria-pressed', String(track[action]));
        if (action === 'remove-track') button.disabled = sequence.tracks.length === 1 || sequence.clips.some(c => c.trackId === track.id);
        heading.append(button);
      }
      row.append(heading);
      const lane = document.createElement('div'); lane.className = `stagecraft-track-lane${track.kind === 'audio' ? ' stagecraft-audio-lane' : ''}`; lane.dataset.laneTrack = track.id; lane.dataset.trackKind = track.kind;
      for (const clip of sequence.clips.filter(c => c.trackId === track.id)) {
        const node = document.createElement('button'); node.type = 'button'; node.className = `stagecraft-timeline-clip stagecraft-clip-${clip.type}`; node.dataset.timelineClip = clip.id;
        if (clip.type === 'image') { node.style.backgroundColor = '#365b70'; node.style.borderColor = '#80b8cf'; }
        if (clip.type === 'button') { node.style.backgroundColor = '#633d51'; node.style.borderColor = '#e7a3c7'; }
        if (clip.type === 'solid') { node.style.backgroundColor = '#63513a'; node.style.borderColor = '#d3b67a'; }
        node.style.left = `${clip.startMs / 1000 * this.pixelsPerSecond}px`; node.style.width = `${Math.max(22, (clipDurationMs(sequence, clip) ?? 5000) / 1000 * this.pixelsPerSecond)}px`;
        node.classList.toggle('active', clip.id === selected); node.setAttribute('aria-pressed', String(clip.id === selected)); node.setAttribute('aria-label', `${this.label(clip)} (${(clip.startMs / 1000).toFixed(2)}s)`);
        if (track.locked) node.dataset.locked = 'true';
        this.paintClipMediaMarkers(node, sequence, clip);
        if (!(clip.type === 'audio' && clip.duration.kind === 'sequence-end')) {
          for (const edge of ['start','end'] as const) { const handle = document.createElement('span'); handle.className = 'stagecraft-clip-handle'; handle.dataset.clipEdge = edge; handle.title = this.t(edge === 'start' ? 'TrimStart' : 'TrimEnd'); node.append(handle); }
        }
        const label = document.createElement('span'); label.className = 'stagecraft-clip-label'; label.textContent = this.label(clip); node.append(label); lane.append(node);
      }
      row.append(lane); content.append(row);
    }
    if (endBreak !== null) {
      const marker = document.createElement('div'); marker.className = 'stagecraft-end-break-line'; marker.dataset.endBreakLine = '';
      marker.style.left = `${TRACK_GUTTER_PX + endBreak / 1000 * this.pixelsPerSecond}px`;
      content.append(marker);
    }
    const endpoint = sequenceDurationMs(sequence);
    for (const marker of markers) {
      const guide = document.createElement('div'); guide.className = 'stagecraft-inner-break-guide';
      guide.dataset.timelineBreakGuide = marker.id;
      guide.style.left = `${TRACK_GUTTER_PX + marker.positionMs / 1000 * this.pixelsPerSecond}px`;
      const inactive = typeof endpoint !== 'number' || marker.positionMs >= endpoint;
      guide.classList.toggle('inactive', inactive);
      content.append(guide);
    }
    const playhead = document.createElement('div'); playhead.className = 'stagecraft-playhead'; playhead.style.left = `${180 + positionMs / 1000 * this.pixelsPerSecond}px`; playhead.setAttribute('aria-hidden','true'); content.append(playhead);
    scroll.append(content); this.root.append(scroll);
    const breakScroll = document.createElement('div'); breakScroll.className = 'stagecraft-break-lane-scroll'; breakScroll.dataset.breakLaneScroll = '';
    const breakContent = document.createElement('div'); breakContent.className = 'stagecraft-break-lane-content'; breakContent.style.width = `${TRACK_GUTTER_PX + this.extent(sequence) / 1000 * this.pixelsPerSecond}px`;
    const breakHeading = document.createElement('div'); breakHeading.className = 'stagecraft-break-lane-heading'; breakHeading.textContent = this.t('BreakLane');
    breakContent.append(breakHeading);
    const markerArea = document.createElement('div'); markerArea.className = 'stagecraft-break-marker-area'; markerArea.dataset.innerBreakLane = '';
    for (const marker of markers) {
      const node = document.createElement('button'); node.type = 'button'; node.className = 'stagecraft-inner-break-marker';
      node.dataset.timelineBreak = marker.id;
      node.style.left = `${marker.positionMs / 1000 * this.pixelsPerSecond}px`;
      const inactive = typeof endpoint !== 'number' || marker.positionMs >= endpoint;
      node.classList.toggle('inactive', inactive); node.classList.toggle('selected', marker.id === this.selectedBreakId);
      node.setAttribute('aria-pressed', String(marker.id === this.selectedBreakId));
      const positionText = `${(marker.positionMs / 1000).toFixed(3)} s`;
      const tooltip = inactive ? `${this.t('InnerBreak')} · ${positionText} · ${this.t('InnerBreakInactive')}` : `${this.t('InnerBreak')} · ${positionText}`;
      node.title = tooltip; node.setAttribute('aria-label', tooltip);
      markerArea.append(node);
    }
    breakContent.append(markerArea); breakScroll.append(breakContent); this.root.append(breakScroll);
    scroll.addEventListener('scroll', () => { if (breakScroll.scrollLeft !== scroll.scrollLeft) breakScroll.scrollLeft = scroll.scrollLeft; }, { signal: this.abort.signal });
    breakScroll.addEventListener('scroll', () => { if (scroll.scrollLeft !== breakScroll.scrollLeft) scroll.scrollLeft = breakScroll.scrollLeft; }, { signal: this.abort.signal });
    scroll.scrollLeft = previousScroll; breakScroll.scrollLeft = previousBreakScroll; scroll.scrollTop = previousTop;
    if(focused || preferredActionFocus || preferredBreakFocus) { const focusActionTarget=preferredActionFocus ?? focusAction; const selector=focusBreak?'[data-timeline-break="'+focusBreak+'"]':focusActionTarget?'[data-timeline-action="'+focusActionTarget+'"]':focusTrackAdd?'[data-timeline-track-add]':focusClip?'[data-timeline-clip="'+focusClip+'"]':focusTrack?'[data-track-name="'+focusTrack+'"]':focusElement?'[data-element-type="'+focusElement+'"]':focusScrub?'[data-timeline-scrub]':focusZoom?'[data-timeline-zoom]':focusPlayhead?'[data-timeline-playhead]':null;
      const replacement=(selector?this.root.querySelector<HTMLElement>(selector):null) ?? this.root.querySelector<HTMLElement>('[data-timeline-track-add]'); replacement?.focus({preventScroll:true}); }
    this.applyPlaybackState(this.playback);
  }
  private paintRulerTicks(ruler: HTMLElement): void {
    for (const tick of [...ruler.children]) if (tick instanceof HTMLElement && 'timelineTick' in tick.dataset) ruler.removeChild(tick);
    const minStep = Math.max(1, 70 / this.pixelsPerSecond, this.workspaceMs / 1000 / 400);
    const magnitude = 10 ** Math.floor(Math.log10(minStep));
    const step = [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= minStep)!;
    for (let sec = 0; sec <= this.workspaceMs / 1000; sec += step) {
      const tick = document.createElement('span'); tick.dataset.timelineTick = ''; tick.style.left = `${TRACK_GUTTER_PX + sec * this.pixelsPerSecond}px`; tick.textContent = `${sec}s`; ruler.append(tick);
    }
  }
  private endBreakPosition(sequence: SequenceV1): number | null {
    if ((getPlaybackSchemaVersion(sequence) !== 2 && getPlaybackSchemaVersion(sequence) !== 3) || sequence.end.kind !== 'manual') return null;
    const end = sequenceDurationMs(sequence);
    return typeof end === 'number' && Number.isFinite(end) ? end : null;
  }
  private paintClipMediaMarkers(node: HTMLElement, sequence: SequenceV1, clip: SequenceClip): void {
    this.paintClipFades(node, sequence, clip);
    if (clip.type !== 'audio' && clip.type !== 'video') return;
    if (getPlaybackSchemaVersion(sequence) === 2 || getPlaybackSchemaVersion(sequence) === 3) {
      node.classList.add('stagecraft-breaks-enabled');
      const behavior = clip.properties.onBreak ?? 'pause';
      const icon = behavior === 'pause' ? 'Ⅱ' : behavior === 'loop' ? '↻' : '⇢';
      const badge = document.createElement('span'); badge.className = 'stagecraft-break-policy'; badge.dataset.breakPolicy = behavior;
      badge.textContent = icon; badge.title = this.t('Break' + (behavior === 'pause' ? 'Pause' : behavior === 'loop' ? 'Loop' : 'Finish') + 'Badge');
      badge.setAttribute('aria-label', badge.title); badge.setAttribute('role', 'img'); node.append(badge);
    }
    if (clip.type === 'audio' && clip.duration.kind === 'sequence-end') {
      const badge = document.createElement('span'); badge.className = 'stagecraft-indefinite-badge'; badge.dataset.indefiniteBadge = '';
      badge.textContent = '∞'; badge.title = this.t('IndefiniteBadge'); badge.setAttribute('aria-label', badge.title); badge.setAttribute('role', 'img'); node.append(badge);
    }
  }
  private paintClipFades(node: HTMLElement, sequence: SequenceV1, clip: SequenceClip): void {
    for (const old of node.querySelectorAll<HTMLElement>('.stagecraft-clip-fade')) old.parentElement?.removeChild(old);
    const fades = effectiveClipFades(sequence, clip);
    // Keep timed clips proportional to their actual interval; use the displayed
    // span only for held clips whose manual endpoint is unresolved.
    const renderedWidth = Number.parseFloat(node.style.width || '');
    const span = Number.isFinite(renderedWidth) && renderedWidth > 0 ? renderedWidth : 0;
    const width = typeof fades.durationMs === 'number' ? Math.min(span, Math.max(0, fades.durationMs / 1000 * this.pixelsPerSecond)) : span;
    const inMs = fades.entranceMs;
    const outMs = fades.exitMs;
    const add = (kind: 'in' | 'out', milliseconds: number) => {
      if (milliseconds <= 0 || width <= 0) return;
      const area = document.createElement('span'); area.className = `stagecraft-clip-fade stagecraft-clip-fade-${kind}`;
      area.style.width = `${Math.min(width, milliseconds / 1000 * this.pixelsPerSecond)}px`;
      area.dataset.fadeMilliseconds = String(milliseconds); area.setAttribute('aria-hidden', 'true'); node.append(area);
    };
    add('in', inMs); add('out', outMs);
  }
  setPlaybackState(state: TimelinePlaybackState): void {
    this.playback = state;
    this.applyPlaybackState(state);
  }
  private applyPlaybackState(state: TimelinePlaybackState): void {
    if (!this.sequence) return;
    const holding = state.phase === 'holding' || state.phase === 'paused' && state.holdElapsedMs !== undefined;
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-timeline-clip]')) {
      const clip = this.sequence.clips.find(item => item.id === node.dataset.timelineClip);
      if (!clip || (clip.type !== 'audio' && clip.type !== 'video')) continue;
      const badge = node.querySelector<HTMLElement>('[data-break-policy]');
      if (!badge) continue;
      const behavior = clip.properties.onBreak ?? 'pause';
      const policyName = behavior === 'pause' ? 'Pause' : behavior === 'loop' ? 'Loop' : 'Finish';
      const policyIcon = behavior === 'pause' ? 'Ⅱ' : behavior === 'loop' ? '↻' : '⇢';
      const mediaState = holding ? state.items?.find(item => item.clip.id === clip.id)?.mediaPlayback : undefined;
      badge.textContent = mediaState === undefined ? policyIcon
        : mediaState === 'paused' ? 'Ⅱ' : mediaState === 'looping' ? '↻' : mediaState === 'finishing' ? '▶' : '✓';
      badge.title = mediaState === undefined ? this.t('Break' + policyName + 'Badge')
        : `${this.t('MediaState.' + mediaState)} · ${this.t('Break' + policyName + 'Badge')}`;
      badge.setAttribute('aria-label', badge.title);
      if (mediaState === undefined) delete badge.dataset.mediaPlayback;
      else badge.dataset.mediaPlayback = mediaState;
      for (const status of ['paused', 'looping', 'finishing', 'finished'] as const) node.classList.toggle('stagecraft-media-state-' + status, mediaState === status);
      if (mediaState === undefined) delete node.dataset.mediaPlayback;
      else node.dataset.mediaPlayback = mediaState;
    }
    const endpoint = this.endBreakPosition(this.sequence);
    const active = holding && endpoint !== null && Math.abs(state.positionMs - endpoint) <= 1;
    for (const selector of ['[data-end-break-flag]', '[data-end-break-line]']) {
      for (const marker of this.root.querySelectorAll<HTMLElement>(selector)) marker.classList.toggle('active', active);
    }
    for (const marker of this.root.querySelectorAll<HTMLElement>('[data-timeline-break]')) {
      const activeMarker = holding && state.breakId === marker.dataset.timelineBreak;
      marker.classList.toggle('active', activeMarker);
      this.root.querySelector<HTMLElement>('[data-timeline-break-guide="' + marker.dataset.timelineBreak + '"]')?.classList.toggle('active', activeMarker);
    }
  }
  /** Grow only the workspace during a drag: the source draft, scale and captured DOM stay stable. */
  private growWorkspace(timeMs: number): void {
    const extent = Math.min(MAX_TIME_MS, Math.ceil(timeMs));
    if (extent <= this.workspaceMs) return;
    this.workspaceMs = extent;
    const content = this.root.querySelector<HTMLElement>('.stagecraft-timeline-content');
    if (content) content.style.width = `${TRACK_GUTTER_PX + extent / 1000 * this.pixelsPerSecond}px`;
    const breakContent = this.root.querySelector<HTMLElement>('.stagecraft-break-lane-content');
    if (breakContent) breakContent.style.width = `${TRACK_GUTTER_PX + extent / 1000 * this.pixelsPerSecond}px`;
    const ruler = this.root.querySelector<HTMLElement>('[data-timeline-ruler]'); if (ruler) this.paintRulerTicks(ruler);
    const scrub = this.root.querySelector<HTMLInputElement>('[data-timeline-scrub]'); if (scrub) scrub.max = String(extent);
    this.root.querySelector<HTMLElement>('[data-timeline-playhead]')?.setAttribute('aria-valuemax', String(extent));
  }
  private stopEdgeScroll(): void {
    if (this.edgeFrame !== null) this.frames.cancel(this.edgeFrame);
    this.edgeFrame = null; this.edgeFrameTime = null;
  }
  private edgeVelocity(scroll: HTMLElement): number {
    const box = scroll.getBoundingClientRect(), width = scroll.clientWidth || box.width;
    const left = box.left + TRACK_GUTTER_PX, right = box.left + width;
    const inClipArea = this.pointer.y >= box.top && this.pointer.y <= box.bottom;
    const breakBox = this.breakGesture ? this.root.querySelector<HTMLElement>('.stagecraft-break-lane-scroll')?.getBoundingClientRect() : null;
    const inBreakArea = !!breakBox && this.pointer.y >= breakBox.top && this.pointer.y <= breakBox.bottom;
    if (right <= left || (!inClipArea && !inBreakArea)) return 0;
    const edge = Math.min(48, (right - left) / 2);
    if (this.pointer.x < left + edge) return -720 * Math.min(1, (left + edge - this.pointer.x) / edge);
    if (this.pointer.x > right - edge) return 720 * Math.min(1, (this.pointer.x - right + edge) / edge);
    return 0;
  }
  private queueEdgeScroll(): void {
    const scroll = this.root.querySelector<HTMLElement>('.stagecraft-timeline-scroll');
    if ((!this.gesture && !this.breakGesture) || !scroll || !this.edgeVelocity(scroll)) { this.stopEdgeScroll(); return; }
    if (this.edgeFrame !== null) return;
    this.edgeFrame = this.frames.request(time => this.edgeScroll(time));
  }
  private edgeScroll(time: number): void {
    this.edgeFrame = null;
    const scroll = this.root.querySelector<HTMLElement>('.stagecraft-timeline-scroll');
    if ((!this.gesture && !this.breakGesture) || !scroll) { this.stopEdgeScroll(); return; }
    const velocity = this.edgeVelocity(scroll);
    // Clamp elapsed time so resuming a backgrounded window cannot jump the clip.
    const elapsed = this.edgeFrameTime === null ? 1000 / 60 : Math.max(0, Math.min(50, time - this.edgeFrameTime));
    this.edgeFrameTime = time;
    const width = scroll.clientWidth || scroll.getBoundingClientRect().width;
    const maxScroll = Math.max(0, TRACK_GUTTER_PX + MAX_TIME_MS / 1000 * this.pixelsPerSecond - width);
    const next = Math.max(0, Math.min(maxScroll, scroll.scrollLeft + velocity * elapsed / 1000));
    if (!velocity || next === scroll.scrollLeft) { this.stopEdgeScroll(); return; }
    if (velocity > 0) this.growWorkspace((next + width - TRACK_GUTTER_PX) / this.pixelsPerSecond * 1000);
    scroll.scrollLeft = next;
    const breakScroll = this.root.querySelector<HTMLElement>('.stagecraft-break-lane-scroll');
    if (breakScroll && breakScroll.scrollLeft !== next) breakScroll.scrollLeft = next;
    if (this.gesture) this.previewGesture(this.pointer.x, this.pointer.y);
    else this.previewBreakGesture(this.pointer.x);
    this.queueEdgeScroll();
  }
  setPlayhead(timeMs: number): void {
    this.positionMs = timeMs;
    const node = this.root.querySelector<HTMLElement>('.stagecraft-playhead'); if (node) node.style.left = `${180 + timeMs / 1000 * this.pixelsPerSecond}px`;
    const handle = this.root.querySelector<HTMLElement>('[data-timeline-playhead]'); if (handle) { handle.style.left = `${180 + timeMs / 1000 * this.pixelsPerSecond}px`; handle.setAttribute('aria-valuenow', String(timeMs)); handle.setAttribute('aria-valuetext', `${(timeMs / 1000).toFixed(2)} s`); }
    const range = this.root.querySelector<HTMLInputElement>('[data-timeline-scrub]'); if (range) range.value = String(timeMs);
  }
  private extent(seq: SequenceV1): number { return Math.min(MAX_TIME_MS, Math.max(10000, (sequenceDurationMs(seq) ?? 0), ...seq.clips.map(c => c.startMs + (clipDurationMs(seq,c) ?? 5000)), ...(seq.breaks ?? []).map(marker => marker.positionMs)) + 2000); }
  private label(clip: SequenceClip): string {
    if (clip.type === 'solid') return `${this.t(clip.properties.pattern ? 'AnimatedSurface' : 'ColorSurface')} ${clip.properties.color.toUpperCase()}`;
    return clip.type === 'button' ? clip.properties.label.slice(0,80)
      : clip.type === 'text' ? clip.properties.text.slice(0,80) : clip.type === 'video' || clip.type === 'audio' || clip.type === 'image' ? clip.properties.source.path.split('/').at(-1) ?? this.t(clip.type === 'audio' ? 'Audio' : clip.type === 'image' ? 'Image' : 'Video') : this.t('Bars');
  }
  private button(label: string, action: string): HTMLButtonElement { const b = document.createElement('button'); b.type='button'; b.textContent=this.t(label); b.title=this.t(label); b.setAttribute('aria-label',this.t(label)); b.dataset.timelineAction=action; return b; }
  private contextTarget(element: Element, clientX: number): TimelineContextTarget | null {
    if (!this.sequence) return null;
    const clipId = element.closest<HTMLElement>('[data-timeline-clip]')?.dataset.timelineClip;
    const clip = this.sequence.clips.find(item => item.id === clipId);
    if (clip) return { kind: 'clip', id: clip.id, trackId: clip.trackId };
    const breakId = element.closest<HTMLElement>('[data-timeline-break]')?.dataset.timelineBreak;
    if (this.sequence.breaks?.some(marker => marker.id === breakId)) return { kind: 'break', id: breakId! };
    const lane = element.closest<HTMLElement>('[data-lane-track]');
    const ruler = element.closest<HTMLElement>('[data-timeline-ruler]');
    const breakLane = element.closest<HTMLElement>('[data-inner-break-lane]');
    const area = lane ?? breakLane ?? ruler;
    if (!area || element.closest('[data-timeline-ruler-corner]')) return null;
    const offset = ruler && area === ruler ? TRACK_GUTTER_PX : 0;
    const positionMs = Math.max(0, Math.min(MAX_TIME_MS,
      Math.round((clientX - area.getBoundingClientRect().left - offset) / this.pixelsPerSecond * 1000)));
    return { kind: 'space', positionMs, ...(lane?.dataset.laneTrack ? { trackId: lane.dataset.laneTrack } : {}) };
  }
  private openContextMenu(event: MouseEvent, keyboard = false): void {
    if (!this.callbacks.contextItems || !this.callbacks.contextAction || this.root.inert || !(event.target instanceof Element)
      || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement
      || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
    const original = event.target.closest<HTMLElement>('[data-timeline-clip],[data-timeline-break]') ?? event.target as HTMLElement;
    const bounds = original.getBoundingClientRect();
    const x = keyboard ? bounds.left + Math.min(30, bounds.width / 2) : event.clientX;
    const y = keyboard ? bounds.bottom : event.clientY;
    const target = this.contextTarget(event.target, x);
    if (!target) return;
    event.preventDefault(); event.stopPropagation(); this.cancel();
    if (target.kind === 'clip') this.callbacks.select(target.id);
    else if (target.kind === 'break') this.callbacks.selectBreak?.(target.id);
    const items = this.callbacks.contextItems(target);
    if (!items.length) return;
    const sequenceId = this.sequence?.id;
    const anchor = target.kind === 'clip' ? this.root.querySelector<HTMLElement>('[data-timeline-clip="' + target.id + '"]')
      : target.kind === 'break' ? this.root.querySelector<HTMLElement>('[data-timeline-break="' + target.id + '"]') : original;
    this.contextMenu.open({ x, y, items, ...(anchor ? { anchor } : {}), onSelect: action => {
      if (this.sequence?.id !== sequenceId || this.root.inert) return;
      this.callbacks.contextAction?.(action, target);
      // Editing rebuilds the lane DOM. Keep keyboard editing inside the timeline
      // when the menu's old anchor no longer exists after Paste/Delete/Duplicate.
      this.focusSelection();
    } });
  }
  focusSelection(): void {
    const selected = this.selectedBreakId ? this.root.querySelector<HTMLElement>('[data-timeline-break="' + this.selectedBreakId + '"]')
      : this.selected ? this.root.querySelector<HTMLElement>('[data-timeline-clip="' + this.selected + '"]') : null;
    (selected ?? this.root.querySelector<HTMLElement>('[data-timeline-playhead]'))?.focus({ preventScroll: true });
  }
  private click(event: MouseEvent): void {
    if (!(event.target instanceof Element) || !this.sequence) return;
    const breakNode = event.target.closest<HTMLElement>('[data-timeline-break]');
    if (breakNode?.dataset.timelineBreak) { this.selectBreak(breakNode.dataset.timelineBreak); return; }
    const clip = event.target.closest<HTMLElement>('[data-timeline-clip]'); if (clip) { this.callbacks.select(clip.dataset.timelineClip!); return; }
    const b = event.target.closest<HTMLElement>('[data-timeline-action]'); if (!b) return;
    const action = b.dataset.timelineAction!, trackId = b.dataset.trackId!;
    if (action === 'snap') { this.snapping = !this.snapping; this.render(this.sequence,this.selected); return; }
    const command: TimelineCommand | undefined = action === 'remove-track' ? {kind:'remove-track',trackId} : action === 'up' || action === 'down' ? {kind:'move-track',trackId,direction:action} : action === 'enabled' || action === 'locked' ? {kind:'toggle-track',trackId,property:action} : undefined;
    if (command) this.callbacks.command(command);
  }
  private change(event: Event): void {
    const field = event.target; if (!this.sequence) return;
    if (field instanceof HTMLSelectElement && 'timelineTrackAdd' in field.dataset) {
      event.stopPropagation();
      const trackKind = field.value;
      field.value = '';
      if (trackKind !== 'visual' && trackKind !== 'audio') return;
      try { this.callbacks.command({ kind: 'add-track', trackKind }); }
      catch (error) { this.callbacks.error(error); }
      return;
    }
    if (!(field instanceof HTMLInputElement)) return;
    if (field.dataset.trackName) this.callbacks.command({kind:'rename-track',trackId:field.dataset.trackName,name:field.value});
    if ('timelineZoom' in field.dataset) { this.zoom = Number(field.value); this.render(this.sequence,this.selected); }
    if ('timelineScrub' in field.dataset) this.scrub(Number(field.value));
  }
  private scrub(timeMs: number): void {
    if (!this.sequence || !Number.isFinite(timeMs)) return;
    const time = Math.max(0, Math.min(this.workspaceMs, Math.round(timeMs)));
    this.setPlayhead(time); this.callbacks.scrub(time);
  }
  private scrubAt(event: PointerEvent): void {
    const scroll = this.root.querySelector<HTMLElement>('.stagecraft-timeline-scroll'); if (!scroll) return;
    this.scrub((event.clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft - 180) / this.pixelsPerSecond * 1000);
  }
  private keydown(event: KeyboardEvent): void {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      this.openContextMenu(event as unknown as MouseEvent, true); return;
    }
    if (event.key === 'Escape') { this.cancel(); event.preventDefault(); return; }
    if (!(event.target instanceof Element) || !this.sequence) return;
    const marker = event.target.closest<HTMLElement>('[data-timeline-break]');
    if (marker?.dataset.timelineBreak) {
      const current = this.sequence.breaks?.find(item => item.id === marker.dataset.timelineBreak);
      if (!current) return;
      if (this.selectedBreakId !== current.id) this.selectBreak(current.id);
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); event.stopPropagation();
        this.removeBreak(current.id); return;
      }
      const step = event.shiftKey ? 1000 : 100;
      const requested = event.key === 'Home' ? 0 : event.key === 'End' ? this.extent(this.sequence)
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? current.positionMs - step
          : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? current.positionMs + step : undefined;
      if (requested !== undefined) {
        event.preventDefault(); event.stopPropagation();
        const positionMs = this.keyboardBreakPosition(current.positionMs, requested, step, event.key === 'Home' ? 1 : event.key === 'End' ? -1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1, this.sequence, current.id);
        this.callbacks.command({ kind: 'move-break', breakId: current.id, positionMs });
      }
      return;
    }
    if (event.target.closest('[data-timeline-action="snap"]') && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (!event.target.closest('[data-timeline-playhead]')) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); return; }
    const step = event.shiftKey ? 1000 : 100;
    const time = event.key === 'Home' ? 0 : event.key === 'End' ? this.extent(this.sequence) : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? this.positionMs - step : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? this.positionMs + step : undefined;
    if (time !== undefined) { event.preventDefault(); event.stopPropagation(); this.scrub(time); }
  }
  private down(event: PointerEvent): void {
    this.closeContextMenu();
    if (this.gesture || this.breakGesture || this.scrubGesture || event.button !== 0 || !(event.target instanceof Element) || !this.sequence) return;
    const markerNode = event.target.closest<HTMLElement>('[data-timeline-break]');
    const markerId = markerNode?.dataset.timelineBreak;
    const marker = markerId ? this.sequence.breaks?.find(item => item.id === markerId) : undefined;
    if (markerNode && marker) {
      this.selectBreak(marker.id);
      if (getPlaybackSchemaVersion(this.sequence) !== 3) return;
      this.callbacks.beforeEdit(); event.preventDefault();
      this.root.setPointerCapture(event.pointerId);
      this.pointer = { x: event.clientX, y: event.clientY };
      this.breakGesture = { pointerId: event.pointerId, breakId: marker.id, source: this.sequence, x: event.clientX,
        scrollLeft: this.root.querySelector<HTMLElement>('.stagecraft-break-lane-scroll')?.scrollLeft ?? 0, candidate: null,
        invalidError: null, originalStyle: markerNode.style.cssText, node: markerNode };
      markerNode.focus({ preventScroll: true });
      return;
    }
    const node = event.target.closest<HTMLElement>('[data-timeline-clip]');
    if (!node) {
      const ruler=event.target.closest<HTMLElement>('[data-timeline-ruler]');
      if (ruler && !event.target.closest('[data-timeline-ruler-corner]')) {
        event.preventDefault(); this.root.setPointerCapture(event.pointerId); this.scrubGesture = {pointerId:event.pointerId}; this.root.querySelector<HTMLElement>('[data-timeline-playhead]')?.focus({preventScroll:true}); this.scrubAt(event);
      }
      return;
    }
    const clip = this.sequence.clips.find(c=>c.id===node.dataset.timelineClip); if (!clip) return;
    if (node.dataset.locked === 'true') { this.callbacks.select(clip.id); return; }
    this.callbacks.beforeEdit(); event.preventDefault();
    // The root stays in the DOM when the visual clip moves to another track.
    this.root.setPointerCapture(event.pointerId);
    this.pointer = { x: event.clientX, y: event.clientY };
    this.gesture = {pointerId:event.pointerId,clip,source:this.sequence,x:event.clientX,y:event.clientY,scrollLeft:this.root.querySelector<HTMLElement>('.stagecraft-timeline-scroll')?.scrollLeft??0,edge:(event.target as HTMLElement).dataset.clipEdge as 'start'|'end'|undefined,candidate:null,invalidError:null,node,originalStyle:node.style.cssText,parent:node.parentElement!};
    this.callbacks.select(clip.id); for(const old of this.root.querySelectorAll<HTMLElement>('.stagecraft-timeline-clip.active'))old.classList.remove('active'); node.classList.add('active'); node.focus({preventScroll:true});
  }
  private snap(time: number, gesture: Gesture): number {
    if (!this.snapping) return Math.max(0,Math.round(time));
    const grid = Math.round(time/100)*100;
    const edges = gesture.source.clips.filter(c=>c.id!==gesture.clip.id).flatMap(c=>[c.startMs,c.startMs+(clipDurationMs(gesture.source,c)??0)]);
    const closest = [grid,...edges].sort((a,b)=>Math.abs(a-time)-Math.abs(b-time))[0]!;
    return Math.max(0,Math.round(Math.abs(closest-time)/1000*this.pixelsPerSecond<=8?closest:time));
  }
  private selectBreak(breakId: string): void {
    if (!this.sequence?.breaks?.some(marker => marker.id === breakId)) return;
    this.setSelectedBreak(breakId);
    this.callbacks.selectBreak?.(breakId);
  }
  setSelectedBreak(breakId: string | null): void {
    this.selectedBreakId = breakId;
    if (breakId) this.selected = null;
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-timeline-break]')) {
      const selected = node.dataset.timelineBreak === breakId;
      node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected));
    }
    if (breakId) {
      for (const node of this.root.querySelectorAll<HTMLElement>('[data-timeline-clip]')) {
        node.classList.remove('active'); node.setAttribute('aria-pressed', 'false');
      }
    }
  }
  addBreakAtPlayhead(): void {
    this.addBreakAt(this.positionMs);
  }
  private addBreakAt(positionMs: number): void {
    const sequence = this.sequence;
    if (!sequence) return;
    const position = Math.max(0, Math.min(MAX_TIME_MS, Math.round(positionMs)));
    const existing = sequence.breaks?.find(marker => marker.positionMs === position);
    if (existing) { this.selectBreak(existing.id); return; }
    if ((sequence.breaks?.length ?? 0) >= SEQUENCE_LIMITS.breaks) {
      this.callbacks.error(new TimelineCommandError('BREAK_LIMIT', `A sequence cannot contain more than ${SEQUENCE_LIMITS.breaks} inner Break markers.`));
      return;
    }
    this.selectAddedBreak = true;
    this.callbacks.command({ kind: 'add-break', positionMs: position });
    const added = this.sequence?.breaks?.find(marker => marker.positionMs === position);
    if (added) this.selectBreak(added.id);
  }
  removeBreak(breakId: string): void {
    this.focusRemovedBreakId = breakId;
    this.callbacks.command({ kind: 'remove-break', breakId });
    this.callbacks.selectBreak?.(this.selectedBreakId);
  }
  private doubleClickBreakLane(event: MouseEvent): void {
    if (!(event.target instanceof Element) || !this.sequence
      || !event.target.closest('[data-inner-break-lane]') || event.target.closest('[data-timeline-break]')) return;
    const scroll = this.root.querySelector<HTMLElement>('.stagecraft-break-lane-scroll');
    if (!scroll) return;
    event.preventDefault();
    const requested = (event.clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft - TRACK_GUTTER_PX) / this.pixelsPerSecond * 1000;
    const position = this.snapBreakPosition(requested, this.sequence);
    const existing = this.sequence.breaks?.find(marker => marker.positionMs === position);
    if (existing) { this.selectBreak(existing.id); return; }
    this.addBreakAt(position);
  }
  private snapBreakPosition(timeMs: number, sequence: SequenceV1, exceptId?: string): number {
    const time = Math.max(0, Math.min(MAX_TIME_MS, Math.round(timeMs)));
    if (!this.snapping) return time;
    const grid = Math.round(time / 100) * 100;
    const clipEdges = sequence.clips.flatMap(clip => {
      const duration = clipDurationMs(sequence, clip) ?? 0;
      return [clip.startMs, clip.startMs + duration];
    });
    const candidates = [grid, this.positionMs, ...clipEdges, ...(sequence.breaks ?? []).filter(marker => marker.id !== exceptId).map(marker => marker.positionMs)];
    const closest = candidates.sort((left, right) => Math.abs(left - time) - Math.abs(right - time))[0]!;
    return Math.max(0, Math.min(MAX_TIME_MS, Math.round(Math.abs(closest - time) / 1000 * this.pixelsPerSecond <= 8 ? closest : time)));
  }
  private keyboardBreakPosition(currentMs: number, requestedMs: number, stepMs: number, direction: number, sequence: SequenceV1, exceptId: string): number {
    const occupied = new Set((sequence.breaks ?? []).filter(marker => marker.id !== exceptId).map(marker => marker.positionMs));
    let requested = requestedMs;
    // Keyboard motion is discrete: when a marker occupies the destination, keep
    // stepping in the requested direction instead of inventing a 1 ms offset.
    for (let attempt = 0; attempt <= occupied.size; attempt += 1) {
      const position = this.snapBreakPosition(requested, sequence, exceptId);
      if (!occupied.has(position)) return position;
      requested = position + direction * stepMs;
      if (requested < 0 || requested > MAX_TIME_MS) return currentMs;
    }
    return currentMs;
  }
  private updateBreakMarkerPosition(breakId: string, positionMs: number, sequence: SequenceV1): void {
    const markerLeft = `${positionMs / 1000 * this.pixelsPerSecond}px`;
    const guideLeft = `${TRACK_GUTTER_PX + positionMs / 1000 * this.pixelsPerSecond}px`;
    const endpoint = sequenceDurationMs(sequence);
    const inactive = typeof endpoint !== 'number' || positionMs >= endpoint;
    const node = this.root.querySelector<HTMLElement>('[data-timeline-break="' + breakId + '"]');
    if (node) {
      node.style.left = markerLeft; node.classList.toggle('inactive', inactive);
      const positionText = `${(positionMs / 1000).toFixed(3)} s`;
      const tooltip = inactive ? `${this.t('InnerBreak')} · ${positionText} · ${this.t('InnerBreakInactive')}` : `${this.t('InnerBreak')} · ${positionText}`;
      node.title = tooltip; node.setAttribute('aria-label', tooltip);
    }
    const guide = this.root.querySelector<HTMLElement>('[data-timeline-break-guide="' + breakId + '"]');
    if (guide) { guide.style.left = guideLeft; guide.classList.toggle('inactive', inactive); }
    if (this.selectedBreakId === breakId) this.callbacks.breakPosition?.(breakId, positionMs);
  }
  private previewBreakGesture(clientX: number): void {
    const gesture = this.breakGesture;
    const scroll = this.root.querySelector<HTMLElement>('.stagecraft-break-lane-scroll');
    const marker = gesture?.source.breaks?.find(item => item.id === gesture.breakId);
    if (!gesture || !scroll || !marker) return;
    const delta = (clientX - gesture.x + scroll.scrollLeft - gesture.scrollLeft) / this.pixelsPerSecond * 1000;
    const requested = Math.max(0, Math.min(MAX_TIME_MS, marker.positionMs + delta));
    const positionMs = this.snapBreakPosition(requested, gesture.source, marker.id);
    const collision = gesture.source.breaks?.some(item => item.id !== marker.id && item.positionMs === positionMs) ?? false;
    gesture.candidate = !collision && positionMs !== marker.positionMs ? { kind: 'move-break', breakId: marker.id, positionMs } : null;
    gesture.invalidError = collision ? new TimelineCommandError('BREAK_POSITION_TAKEN', 'A Break marker already exists at this position.') : null;
    gesture.node.classList.toggle('stagecraft-invalid-gesture', collision);
    this.root.querySelector<HTMLElement>('[data-timeline-break-guide="' + marker.id + '"]')?.classList.toggle('invalid', collision);
    this.updateBreakMarkerPosition(marker.id, positionMs, gesture.source);
    this.growWorkspace(positionMs + 2000);
  }
  private moveSnap(time: number, g: Gesture): number {
    const start=this.snap(time,g), duration=clipDurationMs(g.source,g.clip);
    if(!this.snapping || duration===null || duration===undefined)return start;
    const end=this.snap(time+duration,g)-duration;
    return Math.max(0,Math.round(end>=0 && Math.abs(end-time)<Math.abs(start-time)?end:start));
  }
  private move(event: PointerEvent): void {
    if (this.scrubGesture?.pointerId === event.pointerId) { this.scrubAt(event); return; }
    if (this.breakGesture?.pointerId === event.pointerId) {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.previewBreakGesture(event.clientX); this.queueEdgeScroll(); return;
    }
    const g=this.gesture; if (!g || event.pointerId!==g.pointerId) return;
    this.pointer = { x: event.clientX, y: event.clientY };
    this.previewGesture(event.clientX, event.clientY);
    this.queueEdgeScroll();
  }
  private previewGesture(clientX: number, clientY: number): void {
    const g = this.gesture; if (!g) return;
    const scrollLeft = this.root.querySelector<HTMLElement>('.stagecraft-timeline-scroll')?.scrollLeft ?? 0;
    const delta=(clientX-g.x+scrollLeft-g.scrollLeft)/this.pixelsPerSecond*1000;
    const end=g.clip.startMs+(clipDurationMs(g.source,g.clip)??5000);
    // Track rows are stable while the clip ghost is reparented; do not hit-test the ghost.
    const target=[...this.root.querySelectorAll<HTMLElement>('[data-lane-track]')].find(lane=>{
      const track = g.source.tracks.find(item => item.id === lane.dataset.laneTrack);
      if (!track || track.kind !== (g.clip.type === 'audio' ? 'audio' : 'visual')) return false;
      const box=lane.getBoundingClientRect(); return clientX>=box.left && clientX<box.right && clientY>=box.top && clientY<box.bottom;
    });
    const duration = clipDurationMs(g.source, g.clip) ?? 5000;
    const command: TimelineCommand=g.edge?{kind:'resize-clip',clipId:g.clip.id,edge:g.edge,timeMs:Math.min(MAX_TIME_MS, this.snap((g.edge==='start'?g.clip.startMs:end)+delta,g))}:{kind:'move-clip',clipId:g.clip.id,trackId:target?.dataset.laneTrack??g.clip.trackId,startMs:Math.min(MAX_TIME_MS-duration, this.moveSnap(g.clip.startMs+delta,g))};
    try {
      const next=applyEditorTimelineCommand(g.source,command,()=> 'unused-gesture-id'); const clip=next.clips.find(c=>c.id===g.clip.id)!;
      g.invalidError = null;
      g.candidate=JSON.stringify(next)===JSON.stringify(g.source)?null:command; const lane=this.previewLane(next, clip); if(lane && g.node.parentElement!==lane)lane.append(g.node); g.node.style.left=`${clip.startMs/1000*this.pixelsPerSecond}px`; g.node.style.width=`${Math.max(22,(clipDurationMs(next,clip)??5000)/1000*this.pixelsPerSecond)}px`; this.paintClipFades(g.node,next,clip); g.node.classList.remove('stagecraft-invalid-gesture');
      this.removePreviewTracks(clip.trackId);
      this.growWorkspace(clip.startMs + (clipDurationMs(next, clip) ?? 5000) + 2000);
    } catch (error) { g.candidate=null; g.invalidError=error; g.node.classList.add('stagecraft-invalid-gesture'); }
  }
  private previewLane(sequence: SequenceV1, clip: SequenceClip): HTMLElement | null {
    const existing = this.root.querySelector<HTMLElement>('[data-lane-track="' + clip.trackId + '"]'); if (existing) return existing;
    const track = sequence.tracks.find(item => item.id === clip.trackId), content = this.root.querySelector<HTMLElement>('.stagecraft-timeline-content');
    if (!track || !content) return null;
    const row = document.createElement('div'); row.className = `stagecraft-track-row${track.kind === 'audio' ? ' stagecraft-track-audio' : ''}`; row.dataset.timelineTrack = track.id; row.dataset.trackKind = track.kind; row.dataset.timelinePreviewTrack = track.id;
    const heading = document.createElement('div'); heading.className = 'stagecraft-track-heading'; heading.textContent = track.name; row.append(heading);
    const lane = document.createElement('div'); lane.className = `stagecraft-track-lane${track.kind === 'audio' ? ' stagecraft-audio-lane' : ''}`; lane.dataset.laneTrack = track.id; lane.dataset.trackKind = track.kind; row.append(lane);
    // Append temporary tracks below stable source rows so a stationary pointer keeps the same destination.
    content.insertBefore(row, content.querySelector<HTMLElement>('.stagecraft-playhead'));
    return lane;
  }
  private removePreviewTracks(keepTrackId?: string): void {
    for (const row of this.root.querySelectorAll<HTMLElement>('[data-timeline-preview-track]')) {
      if (row.dataset.timelinePreviewTrack !== keepTrackId) row.parentElement?.removeChild(row);
    }
  }
  private up(event: PointerEvent): void {
    if (this.scrubGesture?.pointerId === event.pointerId) { this.scrubAt(event); this.scrubGesture = null; this.releaseCapture(event.pointerId); return; }
    const breakGesture = this.breakGesture;
    if (breakGesture?.pointerId === event.pointerId) {
      const scrollLeft = this.root.querySelector<HTMLElement>('.stagecraft-break-lane-scroll')?.scrollLeft ?? 0;
      if (breakGesture.candidate || breakGesture.invalidError !== null || event.clientX !== breakGesture.x || scrollLeft !== breakGesture.scrollLeft) this.move(event);
      this.stopEdgeScroll(); this.breakGesture = null; this.releaseCapture(breakGesture.pointerId);
      breakGesture.node.style.cssText = breakGesture.originalStyle;
      if (breakGesture.candidate) this.callbacks.command(breakGesture.candidate);
      else {
        breakGesture.node.classList.remove('stagecraft-invalid-gesture');
        if (this.sequence) this.render(this.sequence, this.selected);
        const marker = this.sequence?.breaks?.find(item => item.id === breakGesture.breakId);
        if (marker) this.callbacks.breakPosition?.(marker.id, marker.positionMs);
        if (breakGesture.invalidError !== null) this.callbacks.error(breakGesture.invalidError);
      }
      return;
    }
    const gesture = this.gesture; if (!gesture || event.pointerId !== gesture.pointerId) return;
    const scrollLeft=this.root.querySelector<HTMLElement>('.stagecraft-timeline-scroll')?.scrollLeft??0;
    // The final event can carry a position that had no preceding pointermove.
    if (gesture.candidate || event.clientX!==gesture.x || event.clientY!==gesture.y || scrollLeft!==gesture.scrollLeft) this.move(event);
    this.stopEdgeScroll();
    this.gesture = null; this.releaseCapture(gesture.pointerId);
    gesture.node.classList.remove('stagecraft-invalid-gesture'); gesture.node.style.cssText=gesture.originalStyle; gesture.parent.append(gesture.node);
    this.removePreviewTracks();
    if (gesture.candidate) this.callbacks.command(gesture.candidate);
    else if (this.sequence) this.render(this.sequence,this.selected);
    if (gesture.invalidError !== null) this.callbacks.error(gesture.invalidError);
  }
}
