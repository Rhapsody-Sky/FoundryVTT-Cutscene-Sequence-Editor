import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageClip, SequenceV1, TextClip, Transition } from '../src/domain/sequence.js';
import { duplicateSequence, isSimpleSequence, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { clipDurationMs, sequenceDurationMs } from '../src/domain/clip-timing.js';
import { applyEditorTimelineCommand, applyTimelineCommand, enableAutomaticEnd, TimelineCommandError } from '../src/application/timeline-commands.js';
import { DraftService } from '../src/application/draft-service.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';

const none: Transition = { preset: 'none', version: 1 };
const fade: Transition = { preset: 'fade', version: 1, durationMs: 800, easing: 'ease-in-out' };
function ids() { let index = 0; return () => `image_${++index}`; }
function image(properties: Partial<ImageClip['properties']> = {}): ImageClip {
  return {
    id: 'picture', trackId: 'visual', type: 'image', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: none, exit: none,
    properties: {
      source: { kind: 'foundry-file', path: 'worlds/test/picture.webp' }, fit: 'cover',
      box: { x: 0, y: 0, width: 1280, height: 720 }, crop: { x: 0, y: 0, width: 1, height: 1 },
      mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], ...properties
    }
  };
}
function sequence(clip: ImageClip = image()): SequenceV1 {
  return {
    schemaVersion: 3, id: 'images', revision: 7, name: 'Images',
    composition: { width: 1280, height: 720 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 500 },
    tracks: [{ id: 'visual', name: 'Images', kind: 'visual', order: 0, enabled: true, locked: false }],
    clips: [clip], end: { kind: 'fixed', durationMs: 5_000, automatic: false }
  };
}
function rejects(clip: unknown, path: string, code = 'INVALID_VALUE') {
  assert.throws(() => validateSequence({ ...sequence(), clips: [clip] }),
    error => error instanceof SequenceValidationError && error.code === code && error.path === `sequence.clips[0]${path ? `.${path}` : ''}`);
}

test('image validation preserves persisted data on every supported schema without adding defaults', () => {
  for (const schemaVersion of [1, 2, 3] as const) {
    const source = { ...sequence(), schemaVersion };
    const loaded = validateSequence(JSON.parse(JSON.stringify(source)));
    assert.deepEqual(loaded, source);
    assert.notEqual(loaded.clips[0]!.properties, source.clips[0]!.properties);
    assert.equal(isSimpleSequence(loaded), false);
    assert.equal(clipDurationMs(loaded, loaded.clips[0]!), 5_000);
    assert.equal(Object.hasOwn(loaded.clips[0]!.properties, 'outline'), false);
  }
  rejects({ ...image(), typeVersion: 2 }, 'typeVersion', 'UNSUPPORTED_VERSION');
  rejects({ ...image(), duration: { kind: 'media' } }, 'duration.kind');
  rejects({ ...image(), duration: { kind: 'fixed', milliseconds: 1_000 }, entrance: fade, exit: fade }, '', 'INVALID_TIMING');
});

test('image source paths enforce the existing Foundry media path policy', () => {
  for (const path of ['', ' ', ' worlds/test/a.png', 'worlds/test/a.png ', '../a.png', 'worlds/./a.png',
    'worlds/%2e%2e/a.png', 'https://example.com/a.png', '%68ttps%3A/a.png', '//example/a.png',
    'C:\\a.png', 'worlds/a.png?x=1', 'worlds/a.png#x', 'worlds/%00a.png', 'worlds/%5ca.png', '%bad']) {
    rejects(image({ source: { kind: 'foundry-file', path } }), 'properties.source.path');
  }
  for (const path of ['worlds/test/image one.png', 'modules/pictures/%C3%84.png', '/worlds/test/picture.webp']) {
    assert.equal((validateSequence(sequence(image({ source: { kind: 'foundry-file', path } }))).clips[0] as ImageClip).properties.source.path, path);
  }
  rejects(image({ source: { kind: 'remote', path: 'a.png' } as unknown as ImageClip['properties']['source'] }), 'properties.source.kind', 'UNSUPPORTED_TYPE');
});

test('crop and mask bounds reject invalid geometry while allowing concave crossed and collapsed masks', () => {
  for (const [field, value] of [['x', -0.1], ['y', 1.1], ['width', 0], ['height', 0], ['width', 1.1]] as const) {
    rejects(image({ crop: { ...image().properties.crop, [field]: value } }), `properties.crop.${field}`);
  }
  rejects(image({ crop: { x: 0.5, y: 0, width: 0.6, height: 1 } }), 'properties.crop.width');
  rejects(image({ crop: { x: 0, y: 0.5, width: 1, height: 0.6 } }), 'properties.crop.height');
  rejects(image({ mask: [] as unknown as ImageClip['properties']['mask'] }), 'properties.mask', 'INVALID_SHAPE');
  rejects(image({ mask: [{ x: 0, y: 0 }, { x: 1.01, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }), 'properties.mask[1].x');
  rejects(image({ crop: { x: 0, y: 0, width: Number.NaN, height: 1 } }), 'properties.crop.width', 'INVALID_JSON_VALUE');
  rejects(image({ mask: [{ x: Number.POSITIVE_INFINITY, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }), 'properties.mask[0].x', 'INVALID_JSON_VALUE');
  rejects(image({ box: { x: 0, y: 0, width: 0, height: 720 } }), 'properties.box.width');
  for (const mask of [
    [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.2, y: 0.2 }, { x: 0, y: 1 }],
    [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }]
  ] as const) assert.doesNotThrow(() => validateSequence(sequence(image({ mask }))));
});

test('images share appearance and effect validation including disabled settings', () => {
  const source = { ...image(), appearance: { blendMode: 'screen' as const, opacity: 0.4 }, properties: {
    ...image().properties,
    outline: { enabled: true, color: '#FF0000', opacity: 0.5, width: 2 },
    shadow: { enabled: false, color: '#000000', opacity: 1, offsetX: -5, offsetY: 8, blur: 12 },
    glow: { enabled: true, color: '#ffffff', opacity: 0.8, radius: 20 }
  } };
  assert.deepEqual(validateSequence(sequence(source)).clips[0], source);
  rejects({ ...source, appearance: { blendMode: 'invalid', opacity: 1 } }, 'appearance.blendMode', 'UNSUPPORTED_TYPE');
  rejects({ ...source, appearance: { blendMode: 'normal', opacity: 1.1 } }, 'appearance.opacity');
  rejects({ ...source, properties: { ...source.properties, outline: { ...source.properties.outline, width: 33 } } }, 'properties.outline.width');
  rejects({ ...source, properties: { ...source.properties, shadow: { ...source.properties.shadow, blur: -1 } } }, 'properties.shadow.blur');
  rejects({ ...source, properties: { ...source.properties, glow: { ...source.properties.glow, color: '#fff' } } }, 'properties.glow.color');
});

test('add-image uses composition geometry and needs a source but no media metadata', () => {
  const empty = { ...sequence(), clips: [] };
  const added = applyTimelineCommand(empty, { kind: 'add-clip', type: 'image', trackId: 'visual', startMs: 0, sourcePath: 'worlds/test/new.png' }, ids());
  const clip = added.clips[0] as ImageClip;
  assert.deepEqual(clip, { ...image(), id: 'image_1', entrance: fade, exit: fade,
    properties: { ...image().properties, source: { kind: 'foundry-file', path: 'worlds/test/new.png' } } });
  assert.deepEqual(empty, { ...sequence(), clips: [] });
  assert.throws(() => applyTimelineCommand(empty, { kind: 'add-clip', type: 'image', trackId: 'visual', startMs: 0 }, ids()),
    error => error instanceof TimelineCommandError && error.code === 'IMAGE_SOURCE_REQUIRED');
  const audioTrack = { ...empty, tracks: [{ ...empty.tracks[0]!, kind: 'audio' as const }] };
  assert.throws(() => applyTimelineCommand(audioTrack, { kind: 'add-clip', type: 'image', trackId: 'visual', startMs: 0, sourcePath: 'a.png' }, ids()),
    error => error instanceof TimelineCommandError && error.code === 'INCOMPATIBLE_TRACK');
});

test('image timeline edits update automatic endpoints and retain source geometry', () => {
  const source = enableAutomaticEnd(sequence());
  const moved = applyTimelineCommand(source, { kind: 'move-clip', clipId: 'picture', trackId: 'visual', startMs: 1_000 }, ids());
  assert.equal(sequenceDurationMs(moved), 6_000);
  assert.deepEqual(moved.clips[0]!.properties, image().properties);
  const trimmed = applyTimelineCommand(moved, { kind: 'resize-clip', clipId: 'picture', edge: 'end', timeMs: 3_000 }, ids());
  assert.equal(sequenceDurationMs(trimmed), 3_000);
  assert.deepEqual(trimmed.clips[0]!.duration, { kind: 'fixed', milliseconds: 2_000 });
  const copied = applyTimelineCommand(trimmed, { kind: 'duplicate-clip', clipId: 'picture' }, ids());
  assert.equal(sequenceDurationMs(copied), 5_000);
  assert.equal(copied.clips[1]!.startMs, 3_000);
  assert.deepEqual(copied.clips[1]!.properties, image().properties);
  const removed = applyTimelineCommand(copied, { kind: 'remove-clip', clipId: copied.clips[1]!.id }, ids());
  assert.deepEqual(removed, trimmed);
  assert.deepEqual(source.clips[0], image());
});

test('held images resolve to fixed intervals only on explicit automatic-end timing edits', () => {
  const clip = { ...image(), startMs: 1_000, duration: { kind: 'sequence-end' as const }, entrance: fade, exit: fade };
  const source = sequence(clip);
  assert.deepEqual(validateSequence(source), source);
  const automatic = enableAutomaticEnd(source);
  assert.deepEqual(automatic.clips[0]!.duration, { kind: 'fixed', milliseconds: 4_000 });
  assert.equal(sequenceDurationMs(automatic), 5_000);
  const legacy = { ...source, end: { kind: 'fixed' as const, durationMs: 5_000 } };
  const geometryOnly = applyEditorTimelineCommand(legacy, { kind: 'replace-clip', clip: { ...clip, properties: { ...clip.properties, fit: 'contain' } } }, ids());
  assert.deepEqual(geometryOnly.end, legacy.end);
  assert.deepEqual(geometryOnly.clips[0]!.duration, clip.duration);
  const moved = applyEditorTimelineCommand(legacy, { kind: 'move-clip', clipId: 'picture', trackId: 'visual', startMs: 2_000 }, ids());
  assert.equal(sequenceDurationMs(moved), 6_000);
  assert.deepEqual(moved.clips[0]!.duration, { kind: 'fixed', milliseconds: 4_000 });
});

test('image frames freeze at Breaks and sequence-end holds without media clocks', () => {
  const clip = { ...image(), duration: { kind: 'sequence-end' as const }, entrance: fade, exit: fade };
  const source = { ...sequence(clip), end: { kind: 'manual' as const, durationMs: 5_000 }, breaks: [{ id: 'beat', positionMs: 400 }] };
  const plan = compileSequence(source);
  const before = evaluate(plan, 400);
  for (const context of [{ holding: { elapsedMs: 30_000 } }, { holding: { elapsedMs: 30_000, paused: true } }, { exiting: { elapsedMs: 200 } }]) {
    assert.deepEqual(evaluate(plan, 400, context), before);
  }
  assert.equal(before[0]!.opacity, 0.5);
  const end = evaluate(plan, 5_000, { holding: { elapsedMs: 30_000 } })[0]!;
  assert.equal(end.opacity, 1);
  assert.equal(end.localTimeMs, 5_000);
  for (const key of ['mediaTimeMs', 'mediaPlayback', 'mediaCycle', 'videoLoop', 'audioLoop']) assert.equal(Object.hasOwn(end, key), false);
  const fixedPlan = compileSequence({ ...sequence(), end: { kind: 'manual' } });
  assert.equal(evaluate(fixedPlan, 5_000, { holding: { elapsedMs: 1_000 } })[0]!.opacity, 1);
  const disabled = compileSequence({ ...sequence(), tracks: [{ ...sequence().tracks[0]!, enabled: false }] });
  assert.deepEqual(evaluate(disabled, 2_000), []);
});

test('images share separate opacity position and zoom envelopes with existing text motion', () => {
  const entrance: Transition = { preset: 'fade-slide', version: 1, durationMs: 1_000, easing: 'linear', direction: 'left', distance: 120 };
  const exit: Transition = { preset: 'zoom', version: 1, durationMs: 1_000, easing: 'linear', scale: 0.5 };
  const clip = { ...image(), entrance, exit };
  const imagePlan = compileSequence(sequence(clip));
  const item = evaluate(imagePlan, 500)[0]!;
  assert.equal(item.opacity, 0.5);
  assert.deepEqual(item.textTransform, { x: -60, y: 0, scale: 1 });
  const out = evaluate(imagePlan, 4_500)[0]!;
  assert.equal(out.opacity, 1);
  assert.deepEqual(out.textTransform, { x: 0, y: 0, scale: 0.75 });
  const text: TextClip = { ...clip, type: 'text', properties: {
    text: 'Title', fontFamily: 'Arial', fontSize: 48, minimumFontSize: 12, color: '#ffffff', align: 'center',
    box: image().properties.box, shrinkToFit: true
  } };
  const textPlan = compileSequence({ ...sequence(), clips: [text] });
  for (const time of [0, 500, 1_000, 4_000, 4_500, 5_000]) {
    assert.deepEqual(evaluate(imagePlan, time).map(({ clip: _clip, ...frame }) => frame),
      evaluate(textPlan, time).map(({ clip: _clip, ...frame }) => frame));
  }
  rejects({ ...clip, entrance: { ...entrance, direction: 'diagonal' } }, 'entrance.direction');
  rejects({ ...clip, exit: { ...exit, scale: 0 } }, 'exit.scale');
});

test('replacement copies and compiled snapshots preserve nested image extensions and explicit effect removal', () => {
  const base = image();
  const extended = { ...base, future: 'clip', properties: {
    ...base.properties, future: ['properties'], source: { ...base.properties.source, future: 'source' },
    box: { ...base.properties.box, future: 'box' }, crop: { ...base.properties.crop, future: 'crop' },
    mask: base.properties.mask.map((point, index) => ({ ...point, future: { index } })),
    outline: { enabled: true, color: '#ffffff', opacity: 1, width: 2, future: 'outline' },
    shadow: { enabled: true, color: '#000000', opacity: 1, offsetX: 1, offsetY: 2, blur: 3, future: 'shadow' },
    glow: { enabled: true, color: '#ffffff', opacity: 1, radius: 4, future: 'glow' }
  }, appearance: { blendMode: 'normal', opacity: 1, future: 'appearance' },
  entrance: { ...none, future: 'entrance' }, exit: { ...none, future: 'exit' },
  duration: { kind: 'fixed', milliseconds: 5_000, future: 'duration' } } as unknown as ImageClip;
  const source = sequence(extended);
  const snapshot = compileSequence(source).snapshot;
  assert.deepEqual(snapshot, source);
  assert.ok(Object.isFrozen((snapshot.clips[0] as ImageClip).properties.mask[0]));
  const replacement = { ...base, appearance: { blendMode: 'screen' as const, opacity: 0.7 }, properties: {
    ...base.properties, box: { ...base.properties.box, x: 20 },
    outline: { enabled: false, color: '#ffffff', opacity: 1, width: 3 },
    shadow: { enabled: false, color: '#000000', opacity: 1, offsetX: 1, offsetY: 2, blur: 3 },
    glow: { enabled: false, color: '#ffffff', opacity: 1, radius: 4 }
  } };
  const changed = applyTimelineCommand(source, { kind: 'replace-clip', clip: replacement }, ids());
  const expected = { ...extended, appearance: { ...extended.appearance, ...replacement.appearance }, properties: {
    ...extended.properties, box: { ...extended.properties.box, x: 20 }, outline: { ...extended.properties.outline, enabled: false, width: 3 },
    shadow: { ...extended.properties.shadow, enabled: false }, glow: { ...extended.properties.glow, enabled: false }
  } };
  assert.deepEqual(changed.clips[0], expected);
  for (const copy of [duplicateSequence(changed, 'Copy', ids()), applyTimelineCommand(changed, { kind: 'duplicate-clip', clipId: 'picture' }, ids())]) {
    assert.deepEqual(copy.clips.at(-1)!.properties, expected.properties);
    assert.notEqual(copy.clips.at(-1)!.properties, changed.clips[0]!.properties);
  }
  const removed = applyTimelineCommand(changed, { kind: 'replace-clip', clip: base }, ids());
  for (const effect of ['outline', 'shadow', 'glow']) assert.equal(Object.hasOwn(removed.clips[0]!.properties, effect), false);
  assert.deepEqual(source, snapshot);
});

test('draft undo and redo restore complete image command snapshots', async () => {
  const baseline = { ...sequence(), clips: [] };
  const service = new DraftService({ async list() { return []; }, async delete() {}, async read() { return baseline; },
    async save(value) { return value; } }, ids());
  await service.load(baseline.id);
  const added = applyEditorTimelineCommand(service.draft!, { kind: 'add-clip', type: 'image', trackId: 'visual', startMs: 0, sourcePath: 'worlds/test/picture.webp' }, ids());
  service.replace(added);
  const clip = added.clips[0] as ImageClip;
  const cropped = applyEditorTimelineCommand(service.draft!, { kind: 'replace-clip', clip: { ...clip, properties: {
    ...clip.properties, crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.8 }, mask: [{ x: 0.1, y: 0 }, { x: 1, y: 0.2 }, { x: 0.8, y: 1 }, { x: 0, y: 0.8 }]
  } } }, ids());
  service.replace(cropped);
  assert.deepEqual(service.undo(), added);
  assert.deepEqual(service.undo(), baseline);
  assert.equal(service.dirty, false);
  assert.deepEqual(service.redo(), added);
  assert.deepEqual(service.redo(), cropped);
  assert.deepEqual(compileSequence(service.draft!).snapshot, cropped);
});
