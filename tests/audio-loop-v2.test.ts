import assert from 'node:assert/strict';
import test from 'node:test';
import type { AudioClipV2, SequenceV1 } from '../src/domain/sequence.js';
import { audioDurationMs, audioLoopSettings, clipDurationMs, mediaDurationMs, sequenceDurationMs } from '../src/domain/clip-timing.js';
import { duplicateSequence, SEQUENCE_LIMITS, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { applyEditorTimelineCommand, applyTimelineCommand, TimelineCommandError, timelineConflicts } from '../src/application/timeline-commands.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';

const audio: AudioClipV2 = {
  id: 'audio', trackId: 'audio_track', type: 'audio', typeVersion: 2, startMs: 0,
  duration: { kind: 'fixed', milliseconds: 7_000 },
  entrance: { preset: 'fade', version: 1, durationMs: 500, easing: 'linear' },
  exit: { preset: 'fade', version: 1, durationMs: 500, easing: 'linear' },
  properties: { source: { kind: 'foundry-file', path: 'music.ogg' }, volume: 1, muted: false,
    durationMs: 5_000, sourceRange: { inMs: 1_000, outMs: 4_000 }, loop: true }
};

function sequence(clip: AudioClipV2 = audio, end: SequenceV1['end'] = { kind: 'manual' }): SequenceV1 {
  return validateSequence({
    schemaVersion: 1, id: 'sequence', revision: 0, name: 'Audio loop', composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 800 }, end,
    tracks: [
      { id: 'audio_track', name: 'Audio', kind: 'audio', order: 0, enabled: true, locked: false },
      { id: 'bars_track', name: 'Bars', kind: 'visual', order: 1, enabled: true, locked: false }
    ],
    clips: [clip, { id: 'bars', trackId: 'bars_track', type: 'bars', typeVersion: 1, startMs: 0,
      duration: { kind: 'fixed', milliseconds: 10_000 }, entrance: { preset: 'none', version: 1 },
      exit: { preset: 'none', version: 1 }, properties: { heightFraction: 0.1, color: '#000000' } }]
  });
}

function soundAt(source: SequenceV1, position: number) {
  return evaluate(compileSequence(source), position).find(item => item.clip.type === 'audio');
}

function ids() { let next = 0; return () => `copy_${++next}`; }
function invalid(code: string) { return (error: unknown) => error instanceof SequenceValidationError && error.code === code; }

test('regular audio loop repeats a 3s source for 7s with one entrance and final Out, even on manual hold', () => {
  const source = sequence();
  assert.equal(mediaDurationMs(audio), 3_000);
  assert.equal(audioDurationMs(audio), 7_000);
  assert.equal(clipDurationMs(source, audio), 7_000);
  assert.deepEqual(audioLoopSettings(audio), { loop: true, loopIndefinitely: false });
  assert.equal(soundAt(source, 250)!.audioGain, 0.5);
  for (const position of [2_999, 3_000, 5_999, 6_000]) {
    assert.equal(soundAt(source, position)!.audioLoop, true);
    assert.equal(soundAt(source, position)!.audioGain, 1);
    assert.equal(soundAt(source, position)!.localTimeMs, position);
  }
  assert.equal(soundAt(source, 6_750)!.audioGain, 0.5);
  assert.equal(soundAt(source, 7_000), undefined);
  assert.equal(soundAt(source, 10_000), undefined);
});

test('indefinite looping extends terminal manual audio, while finite and nonterminal audio obey authored Out', () => {
  const indefinite = { ...audio, properties: { ...audio.properties, loopIndefinitely: true } };
  const source = sequence(indefinite);
  assert.equal(soundAt(source, 250)!.audioGain, 0.5);
  assert.equal(soundAt(source, 6_750)!.audioGain, 1);
  assert.equal(soundAt(source, 50_000)!.audioLoop, true);
  assert.equal(soundAt(source, 50_000)!.localTimeMs, 50_000);
  const finite = sequence(indefinite, { kind: 'fixed', durationMs: 10_000 });
  assert.equal(soundAt(finite, 6_750)!.audioGain, 0.5);
  assert.equal(soundAt(finite, 7_000), undefined);
  const later = { ...audio, id: 'later', startMs: 7_000, duration: { kind: 'fixed' as const, milliseconds: 2_000 },
    properties: { ...audio.properties, loop: false } };
  const nonterminal = validateSequence({ ...source, clips: [...source.clips, later] });
  assert.equal(soundAt(nonterminal, 6_750)!.audioGain, 0.5);
  assert.equal(soundAt(nonterminal, 7_000)!.clip.id, 'later');
  assert.equal(soundAt(nonterminal, 10_000), undefined);
});

test('audio v2 validates authored limits, versioned flags, source bounds and transition overlap', () => {
  const source = sequence();
  for (const changed of [
    { ...audio, typeVersion: 3 },
    { ...audio, duration: { kind: 'media' } },
    { ...audio, duration: { kind: 'fixed', milliseconds: 0 } },
    { ...audio, duration: { kind: 'fixed', milliseconds: SEQUENCE_LIMITS.timelineMs + 1 } },
    { ...audio, startMs: SEQUENCE_LIMITS.timelineMs - 6_999 },
    { ...audio, properties: { ...audio.properties, loop: false } },
    { ...audio, properties: { ...audio.properties, loop: false, loopIndefinitely: true } },
    { ...audio, properties: { ...audio.properties, loopIndefinitely: 1 } },
    { ...audio, duration: { kind: 'fixed', milliseconds: 999 } }
  ]) assert.throws(() => validateSequence({ ...source, clips: [changed] }), SequenceValidationError);
  const plain = { ...audio, duration: { kind: 'fixed' as const, milliseconds: 3_000 }, properties: { ...audio.properties, loop: false } };
  assert.equal(audioDurationMs(sequence(plain).clips[0] as AudioClipV2), 3_000);
  const legacy = { ...audio, typeVersion: 1, duration: { kind: 'media' }, properties: { ...audio.properties, loopIndefinitely: false } };
  assert.throws(() => validateSequence({ ...source, clips: [legacy] }), invalid('UNSUPPORTED_VERSION'));
});

test('audio v2 determines referenced/automatic ends, duplicate position and overlap using authored duration', () => {
  const source = sequence();
  const reference = validateSequence({ ...source, clips: [audio], end: { kind: 'media', clipId: audio.id } });
  assert.equal(sequenceDurationMs(reference), 7_000);
  assert.equal(compileSequence(reference).durationMs, 7_000);
  const automatic = applyTimelineCommand(source, { kind: 'set-end', end: { kind: 'fixed', durationMs: 10_000, automatic: true } }, ids());
  assert.equal(sequenceDurationMs(automatic), 10_000);
  const copied = applyTimelineCommand(automatic, { kind: 'duplicate-clip', clipId: audio.id }, ids());
  assert.equal(copied.clips.at(-1)!.startMs, 7_000);
  assert.equal(sequenceDurationMs(copied), 14_000);
  assert.deepEqual(timelineConflicts(copied), []);
  const overlap = validateSequence({ ...source, clips: [audio, { ...audio, id: 'overlap', startMs: 3_000 }] });
  assert.ok(timelineConflicts(overlap).some(conflict => conflict.code === 'CLIP_OVERLAP'));
  const removed = applyTimelineCommand(automatic, { kind: 'remove-clip', clipId: 'bars' }, ids());
  assert.equal(sequenceDurationMs(removed), 7_000);
});

test('looped audio resizing changes authored interval, preserves source/extension fields and fits final fades', () => {
  const source = validateSequence({ ...sequence(), clips: [{ ...audio,
    duration: { ...audio.duration, durationExtension: true },
    properties: { ...audio.properties, extension: { keep: true }, sourceRange: { ...audio.properties.sourceRange!, rangeExtension: 9 } }
  }] });
  const before = structuredClone(source);
  const grown = applyTimelineCommand(source, { kind: 'resize-clip', clipId: audio.id, edge: 'end', timeMs: 12_000 }, ids());
  assert.equal(clipDurationMs(grown, grown.clips[0]!), 12_000);
  assert.deepEqual(grown.clips[0]!.properties, source.clips[0]!.properties);
  const cropped = applyTimelineCommand(source, { kind: 'resize-clip', clipId: audio.id, edge: 'start', timeMs: 6_800 }, ids());
  assert.equal(clipDurationMs(cropped, cropped.clips[0]!), 200);
  assert.equal(cropped.clips[0]!.startMs, 6_800);
  assert.deepEqual(cropped.clips[0]!.properties, source.clips[0]!.properties);
  assert.equal((cropped.clips[0]!.entrance as { durationMs: number }).durationMs, 100);
  assert.equal((cropped.clips[0]!.exit as { durationMs: number }).durationMs, 100);
  assert.equal((cropped.clips[0]!.duration as unknown as Record<string, unknown>).durationExtension, true);
  const replaced = applyTimelineCommand(source, { kind: 'replace-clip', clip: { ...audio, properties: { ...audio.properties, loopIndefinitely: true } } }, ids());
  assert.deepEqual((replaced.clips[0]!.properties as Record<string, unknown>).extension, { keep: true });
  assert.equal((replaced.clips[0]!.properties as { sourceRange: Record<string, unknown> }).sourceRange.rangeExtension, 9);
  const plan = compileSequence(replaced);
  assert.equal(Object.isFrozen(plan.snapshot.clips[0]!.duration), true);
  assert.deepEqual(plan.snapshot, replaced);
  assert.deepEqual(source, before);
  const copy = duplicateSequence(source, 'Copy', ids());
  assert.deepEqual(copy.clips[0]!.duration, source.clips[0]!.duration);
});

test('nonloop audio end resize stays in selected source and start crop aligns source time', () => {
  const plain = { ...audio, startMs: 1_000, duration: { kind: 'fixed' as const, milliseconds: 2_000 },
    properties: { ...audio.properties, loop: false } };
  const source = sequence(plain);
  const grown = applyTimelineCommand(source, { kind: 'resize-clip', clipId: audio.id, edge: 'end', timeMs: 4_000 }, ids());
  assert.equal(clipDurationMs(grown, grown.clips[0]!), 3_000);
  assert.deepEqual(grown.clips[0]!.properties, plain.properties);
  assert.throws(() => applyTimelineCommand(source, { kind: 'resize-clip', clipId: audio.id, edge: 'end', timeMs: 4_001 }, ids()),
    (error: unknown) => error instanceof TimelineCommandError && error.code === 'INVALID_SOURCE_RANGE');
  const cropped = applyTimelineCommand(source, { kind: 'resize-clip', clipId: audio.id, edge: 'start', timeMs: 1_500 }, ids());
  assert.equal(clipDurationMs(cropped, cropped.clips[0]!), 1_500);
  assert.deepEqual((cropped.clips[0] as AudioClipV2).properties.sourceRange, { inMs: 1_500, outMs: 4_000 });
  const short = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: { ...plain,
    duration: { kind: 'fixed', milliseconds: 200 } } }, ids());
  assert.equal((short.clips[0]!.exit as { durationMs: number }).durationMs, 100);
});

test('legacy loop settings and compiled frame envelopes retain the v1 manual/finite semantics', () => {
  const legacy = { ...audio, typeVersion: 1 as const, duration: { kind: 'media' as const } };
  assert.deepEqual(audioLoopSettings(legacy), { loop: true, loopIndefinitely: true });
  const source = validateSequence({ ...sequence(), clips: [legacy] });
  assert.deepEqual(source.clips[0], legacy);
  const plan = compileSequence(source);
  for (const position of [250, 2_750, 3_000, 7_000]) {
    const frame = evaluate(plan, position)[0]!;
    assert.equal(frame.audioLoop, true);
    assert.equal(frame.localTimeMs, position);
    assert.equal(frame.audioGain, position === 250 ? 0.5 : 1);
  }
  const finite = compileSequence(validateSequence({ ...source, end: { kind: 'fixed', durationMs: 10_000 } }));
  assert.equal(evaluate(finite, 2_750)[0]!.audioLoop, undefined);
  assert.equal(evaluate(finite, 2_750)[0]!.audioGain, 0.5);
  assert.deepEqual(evaluate(finite, 3_000), []);
});

test('volume and mute edits upgrading legacy audio preserve referenced and nonautomatic end policies', () => {
  const legacy = { ...audio, typeVersion: 1 as const, duration: { kind: 'media' as const } };
  const upgraded: AudioClipV2 = { ...audio, duration: { kind: 'fixed', milliseconds: 3_000 },
    properties: { ...audio.properties, loopIndefinitely: true } };
  for (const end of [
    { kind: 'media', clipId: audio.id, retained: { policy: 'reference' } },
    { kind: 'fixed', durationMs: 12_000, retained: { policy: 'legacy-fixed' } },
    { kind: 'fixed', durationMs: 12_000, automatic: false, retained: { policy: 'explicit-fixed' } }
  ] as (SequenceV1['end'] & { retained: { policy: string } })[]) {
    const source = validateSequence({ ...sequence(), clips: [legacy], end });
    const before = structuredClone(source);
    for (const properties of [
      { ...upgraded.properties, volume: 0.25 },
      { ...upgraded.properties, muted: true }
    ]) {
      const result = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: { ...upgraded, properties } }, ids());
      assert.deepEqual(result.end, source.end);
      assert.equal(audioDurationMs(result.clips[0] as AudioClipV2), 3_000);
      assert.equal(result.clips[0]!.typeVersion, 2);
      assert.deepEqual(source, before);
    }
  }
});

test('v2 source range and source metadata edits preserve end policy when authored length stays unchanged', () => {
  for (const end of [
    { kind: 'media', clipId: audio.id },
    { kind: 'fixed', durationMs: 12_000 }
  ] as SequenceV1['end'][]) {
    const source = validateSequence({ ...sequence(), clips: [audio], end });
    for (const properties of [
      { ...audio.properties, sourceRange: { inMs: 2_000, outMs: 3_000 } },
      { ...audio.properties, durationMs: 6_000 },
      { ...audio.properties, source: { kind: 'foundry-file' as const, path: 'replacement.ogg' }, durationMs: 2_000,
        sourceRange: { inMs: 0, outMs: 2_000 } }
    ]) {
      const result = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: { ...audio, properties } }, ids());
      assert.deepEqual(result.end, source.end);
      assert.equal(audioDurationMs(result.clips[0] as AudioClipV2), 7_000);
    }
    const changed = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: {
      ...audio, duration: { kind: 'fixed', milliseconds: 15_000 }
    } }, ids());
    assert.deepEqual(changed.end, { kind: 'fixed', durationMs: 15_000, automatic: true });
  }
});

test('real legacy-audio source duration and clip start edits still opt legacy endpoints into automatic length', () => {
  const legacy = { ...audio, typeVersion: 1 as const, duration: { kind: 'media' as const } };
  const source = validateSequence({ ...sequence(), clips: [legacy], end: { kind: 'media', clipId: audio.id } });
  const trimmed = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: { ...legacy,
    properties: { ...legacy.properties, sourceRange: { inMs: 2_000, outMs: 4_000 } }
  } }, ids());
  assert.deepEqual(trimmed.end, { kind: 'fixed', durationMs: 2_000, automatic: true });
  const moved = applyEditorTimelineCommand(source, { kind: 'replace-clip', clip: { ...legacy, startMs: 1_000 } }, ids());
  assert.deepEqual(moved.end, { kind: 'fixed', durationMs: 4_000, automatic: true });
});
