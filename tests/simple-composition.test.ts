import test from 'node:test';
import assert from 'node:assert/strict';
import { createBarsSequence, createBreaksSequence, duplicateSequence, isSimpleSequence, validateSequence } from '../src/domain/validation.js';
import { withSequenceAudience, withSequenceAutomation } from '../src/domain/sequence-audience.js';
import type { SequenceV1 } from '../src/domain/sequence.js';
import { buildSimpleSequence, type SimpleCompositionEdit, videoValuesForPath } from '../src/ui/simple-composition.js';

function idFactory(prefix: string) {
  let next = 0;
  return () => `${prefix}_${++next}`;
}

function blankComposition(): SequenceV1 {
  const base = createBarsSequence('Blank', idFactory('base'));
  return validateSequence({
    ...base,
    clips: [],
    end: { kind: 'manual' },
    tracks: base.tracks.map(track => ({ ...track, futureTrackField: 'keep' })),
    futureSequenceField: { marker: 'keep' }
  });
}

function editFor(sequence: SequenceV1): SimpleCompositionEdit {
  return {
    name: 'Combined scene',
    presentation: sequence.presentation,
    end: { kind: 'fixed', durationMs: 6_000 },
    video: {
      startMs: 0, entranceMs: 200, sourcePath: 'worlds/demo/scene.webm',
      durationMs: 6_000, fit: 'contain', volume: 0.7, muted: false
    },
    bars: { startMs: 0, entranceMs: 300, durationMode: 'sequence-end', durationMs: 6_000, heightFraction: 0.12 },
    text: {
      startMs: 400, entranceMs: 300, durationMode: 'sequence-end', durationMs: 6_000, exitMs: 500,
      text: 'Ready', fontFamily: 'Signika', fontSize: 96, minimumFontSize: 36,
      color: '#ffffff', align: 'center',
      box: { x: 192, y: 378, width: 1536, height: 324 }, shrinkToFit: true
    }
  };
}

test('building multiple elements from an empty composition allocates separate tracks', () => {
  const blank = blankComposition();
  const combined = buildSimpleSequence(blank, idFactory('new'), editFor(blank));

  assert.equal(combined.tracks.length, 3);
  assert.equal(new Set(combined.tracks.map(track => track.id)).size, 3);
  assert.equal(new Set(combined.clips.map(clip => clip.trackId)).size, 3);
  assert.deepEqual(combined.tracks.map(track => track.order), [0, 1, 2]);
  assert.equal(isSimpleSequence(combined), true);
  assert.deepEqual((combined as unknown as { futureSequenceField: unknown }).futureSequenceField, { marker: 'keep' });
  assert.equal((combined.tracks[0] as unknown as { futureTrackField: string }).futureTrackField, 'keep');
});

test('video duration metadata is discarded when the source path changes', () => {
  const values = editFor(blankComposition()).video!;
  assert.equal(videoValuesForPath(values, values.sourcePath).durationMs, 6_000);
  assert.equal(videoValuesForPath(values, 'worlds/demo/other.webm').durationMs, undefined);
  assert.equal(videoValuesForPath(values, 'worlds/demo/other.webm').sourcePath, 'worlds/demo/other.webm');
});

test('simple composition creates schema-2 video with an explicit default break policy', () => {
  const base = createBreaksSequence('New composition', idFactory('breaks'));
  const blank = validateSequence({ ...base, clips: [], end: { kind: 'manual' } });
  const created = buildSimpleSequence(blank, idFactory('created'), editFor(blank));
  const video = created.clips.find(clip => clip.type === 'video');
  if (!video || video.type !== 'video') throw new Error('Expected the new video clip');
  assert.equal(video.typeVersion, 5);
  assert.equal(video.properties.onBreak, 'pause');
  assert.equal(created.schemaVersion, 2);
});

test('simple composition promotes video slide and zoom transitions to type version 7', () => {
  const base = createBreaksSequence('Video movement', idFactory('video-motion'));
  const blank = validateSequence({ ...base, clips: [], end: { kind: 'manual' } });
  const edit = editFor(blank);
  const sequence = buildSimpleSequence(blank, idFactory('video-motion-built'), {
    ...edit,
    video: { ...edit.video!, entrancePreset: 'slide', entranceEasing: 'linear', entranceDirection: 'left', entranceDistance: 180,
      exitPreset: 'fade-zoom', exitMs: 450, exitEasing: 'back-in', exitScale: 1.35 }
  });
  const video = sequence.clips.find(clip => clip.type === 'video');
  assert.ok(video?.type === 'video');
  assert.equal(video.typeVersion, 7);
  assert.deepEqual(video.entrance, { preset: 'slide', version: 1, durationMs: 200, easing: 'linear', direction: 'left', distance: 180 });
  assert.deepEqual(video.exit, { preset: 'fade-zoom', version: 1, durationMs: 450, easing: 'back-in', scale: 1.35 });
});

test('simple composition rebuilds retain authored auto-trigger settings without adopting new playback semantics', () => {
  const blank = createBreaksSequence('Authored triggers', idFactory('trigger'));
  const authored = withSequenceAutomation(withSequenceAudience(blank, {
    mode: 'selected', userIds: ['player-one', 'offline-player'], includeGM: false
  }), { version: 1, enabled: true, rules: [
    { id: 'turn-end-rule', enabled: true, event: 'turn-end', actorId: 'actor-one' }
  ] });
  const rebuilt = buildSimpleSequence(authored, idFactory('rebuilt'), editFor(authored));

  assert.equal(rebuilt.schemaVersion, 4);
  assert.equal(rebuilt.playbackSchemaVersion, authored.playbackSchemaVersion);
  assert.deepEqual(rebuilt.launch, authored.launch);
});

test('an explicit manual ending survives rebuilding a composition with video', () => {
  const blank = blankComposition();
  const manual = buildSimpleSequence(blank, idFactory('manual'), {
    ...editFor(blank), end: { kind: 'manual' }
  });
  assert.deepEqual(manual.end, { kind: 'manual' });
  const rebuilt = buildSimpleSequence(manual, idFactory('unused'), {
    ...editFor(manual), end: { kind: 'manual' },
    text: { ...editFor(manual).text!, text: 'Still held' }
  });
  assert.deepEqual(rebuilt.end, { kind: 'manual' });
  assert.deepEqual(rebuilt.clips.map(clip => clip.id), manual.clips.map(clip => clip.id));
});

test('editing simple elements retains clip IDs and unknown JSON extension fields', () => {
  const blank = blankComposition();
  const initial = buildSimpleSequence(blank, idFactory('new'), editFor(blank));
  const extended = validateSequence({
    ...initial,
    futureEndField: { marker: 'end' },
    tracks: initial.tracks.map(track => ({ ...track, futureTrackField: 'track' })),
    clips: initial.clips.map(clip => ({
      ...clip,
      futureClipField: 'clip',
      entrance: { ...clip.entrance, futureTransitionField: 'transition' },
      duration: { ...clip.duration, futureDurationField: 'duration' },
      properties: { ...clip.properties, futurePropertiesField: 'properties' }
    }))
  });
  const updated = buildSimpleSequence(extended, idFactory('unused'), {
    ...editFor(extended), name: 'Edited scene',
    text: { ...editFor(extended).text!, text: 'Updated' }
  });

  assert.deepEqual(updated.clips.map(clip => clip.id), initial.clips.map(clip => clip.id));
  assert.equal((updated as unknown as { futureSequenceField: unknown }).futureSequenceField !== undefined, true);
  assert.equal((updated as unknown as { futureEndField: unknown }).futureEndField !== undefined, true);
  assert.equal((updated.tracks[0] as unknown as { futureTrackField: string }).futureTrackField, 'track');
  for (const clip of updated.clips as Array<SequenceV1['clips'][number] & {
    futureClipField: string;
    futureTransitionField: string;
    futureDurationField: string;
    properties: Record<string, unknown>;
  }>) {
    assert.equal(clip.futureClipField, 'clip');
    assert.equal((clip.entrance as unknown as { futureTransitionField: string }).futureTransitionField, 'transition');
    assert.equal((clip.duration as unknown as { futureDurationField: string }).futureDurationField, 'duration');
    assert.equal(clip.properties.futurePropertiesField, 'properties');
  }
  assert.equal(isSimpleSequence(updated), true);
});

test('appearance and disabled text-effect settings survive edits, validation, and duplication', () => {
  const blank = blankComposition();
  const base = editFor(blank);
  const initial = buildSimpleSequence(blank, idFactory('styled'), {
    ...base,
    bars: { ...base.bars!, appearance: { blendMode: 'multiply', opacity: 0.4 } },
    video: { ...base.video!, appearance: { blendMode: 'screen', opacity: 0.8 } },
    text: {
      ...base.text!, appearance: { blendMode: 'plus-lighter', opacity: 0.65 },
      outline: { enabled: true, color: '#12ab34', opacity: 0.45, width: 11 },
      shadow: { enabled: true, color: '#102030', opacity: 0.6, offsetX: -24, offsetY: 18, blur: 32 },
      glow: { enabled: false, color: '#abcdef', opacity: 0.25, radius: 48 }
    }
  });
  const extended = validateSequence({
    ...initial,
    clips: initial.clips.map(clip => clip.type === 'text' ? {
      ...clip,
      appearance: { ...clip.appearance!, futureAppearanceField: 'keep' },
      properties: {
        ...clip.properties,
        outline: { ...clip.properties.outline!, futureEffectField: 'keep' }
      }
    } : clip)
  });
  const baseEdit = editFor(extended);
  const updated = buildSimpleSequence(extended, idFactory('edit'), {
    ...baseEdit,
    bars: { ...baseEdit.bars!, appearance: { blendMode: 'difference', opacity: 0.3 } },
    video: { ...baseEdit.video!, appearance: { blendMode: 'overlay', opacity: 0.75 } },
    text: {
      ...baseEdit.text!, text: 'Styled update', appearance: { blendMode: 'normal', opacity: 0.9 },
      outline: { enabled: false, color: '#12ab34', opacity: 0.45, width: 11 }
    }
  });

  const bars = updated.clips.find(clip => clip.type === 'bars')!;
  const video = updated.clips.find(clip => clip.type === 'video')!;
  const text = updated.clips.find(clip => clip.type === 'text')!;
  assert.deepEqual(bars.appearance, { blendMode: 'difference', opacity: 0.3 });
  assert.deepEqual(video.appearance, { blendMode: 'overlay', opacity: 0.75 });
  assert.deepEqual(text.appearance, {
    blendMode: 'normal', opacity: 0.9, futureAppearanceField: 'keep'
  });
  assert.deepEqual(text.properties.outline, {
    enabled: false, color: '#12ab34', opacity: 0.45, width: 11, futureEffectField: 'keep'
  });
  assert.deepEqual(text.properties.shadow, {
    enabled: true, color: '#102030', opacity: 0.6, offsetX: -24, offsetY: 18, blur: 32
  });
  assert.deepEqual(text.properties.glow, {
    enabled: false, color: '#abcdef', opacity: 0.25, radius: 48
  });

  const roundTrip = validateSequence(JSON.parse(JSON.stringify(updated)) as unknown);
  const duplicate = duplicateSequence(roundTrip, 'Styled copy', idFactory('copy'));
  const copiedText = duplicate.clips.find(clip => clip.type === 'text')!;
  assert.notEqual(copiedText.id, text.id);
  assert.deepEqual(copiedText.appearance, text.appearance);
  assert.deepEqual(copiedText.properties.outline, text.properties.outline);
  assert.deepEqual(copiedText.properties.shadow, text.properties.shadow);
  assert.deepEqual(copiedText.properties.glow, text.properties.glow);
});
