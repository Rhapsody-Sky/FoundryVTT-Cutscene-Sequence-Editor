import test from 'node:test';
import assert from 'node:assert/strict';
import type { SequenceV1, VideoClip } from '../src/domain/sequence.js';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import { videoTypeVersion } from '../src/domain/clip-timing.js';
import { videoBoxRect, legacyVideoBox } from '../src/rendering/video-geometry.js';
import { patchInspectedClip } from '../src/ui/clip-inspector.js';
import { applyEditorTimelineCommand } from '../src/application/timeline-commands.js';

const box = { x: 100, y: -20, width: 400, height: 200 };
const clip: VideoClip = {
  id: 'video', trackId: 'track', type: 'video', typeVersion: 6, startMs: 0,
  duration: { kind: 'media' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
  properties: { source: { kind: 'foundry-file', path: 'movie.webm' }, durationMs: 5000, fit: 'contain', muted: true, volume: 1, box }
};
function sequence(schemaVersion: 1 | 2 | 3 = 2): SequenceV1 {
  let id = 0; const seed = createBarsSequence('video box', () => 'seed-' + ++id);
  return { ...seed, schemaVersion, tracks: [{ ...seed.tracks[0]!, id: 'track' }], clips: [clip], end: { kind: 'fixed', durationMs: 5000 } };
}

test('video boxes require version 6 and finite geometry while unboxed legacy payloads remain unchanged', () => {
  for (const schema of [1, 2, 3] as const) assert.deepEqual(validateSequence(sequence(schema)), sequence(schema));
  assert.throws(() => validateSequence({ ...sequence(), clips: [{ ...clip, typeVersion: 5 }] }));
  for (const [field, value] of [['width', 0], ['height', 32769], ['x', NaN], ['y', Infinity]] as const) {
    assert.throws(() => validateSequence({ ...sequence(), clips: [{ ...clip, properties: { ...clip.properties, box: { ...box, [field]: value } } }] }));
  }
  const { box: _box, ...properties } = clip.properties;
  const legacy = { ...sequence(1), clips: [{ ...clip, typeVersion: 1, properties }] };
  assert.deepEqual(validateSequence(legacy), legacy); assert.equal(videoTypeVersion(properties), 1);
  assert.equal(videoTypeVersion(properties, 6), 6); assert.equal(videoTypeVersion(clip.properties), 6);
});

test('version 6 preserves keying, trim and optional Break behavior without relaxing schema requirements', () => {
  const all: VideoClip = { ...clip, properties: { ...clip.properties,
    sourceRange: { inMs: 100, outMs: 4900 }, loop: true, onBreak: 'finish',
    keying: { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.2 } } };
  assert.doesNotThrow(() => validateSequence({ ...sequence(), clips: [all] }));
  assert.throws(() => validateSequence({ ...sequence(1), clips: [all] }));
  const changed = patchInspectedClip(all, { video: { startMs: 0, entranceMs: 0, sourcePath: 'movie.webm',
    durationMs: 5000, fit: 'cover', volume: 0.5, muted: true } }) as VideoClip;
  assert.equal(changed.typeVersion, 6); assert.deepEqual(changed.properties.box, box);
  const trimmed = applyEditorTimelineCommand({ ...sequence(), clips: [all] }, { kind: 'resize-clip', clipId: clip.id, edge: 'end', timeMs: 4700 }, () => 'unused');
  assert.equal(trimmed.clips[0]!.typeVersion, 6);
});

test('projection keeps logical box stable across landscape, portrait and scaled actual surfaces', () => {
  const size = { width: 1920, height: 1080 };
  assert.deepEqual(videoBoxRect(clip, { width: 960, height: 540 }, size), { x: 50, y: -10, width: 200, height: 100 });
  assert.deepEqual(videoBoxRect(clip, { width: 1920, height: 1080 }, size), box);
  const portrait = { width: 540, height: 960 };
  const fallback = legacyVideoBox(portrait, size);
  const boxed = { ...clip, properties: { ...clip.properties, box: fallback } };
  assert.deepEqual(videoBoxRect(boxed, portrait, size), { x: 0, y: 0, width: 540, height: 960 });
  const { box: _box, ...properties } = clip.properties;
  assert.deepEqual(videoBoxRect({ ...clip, properties }, portrait, size), { x: 0, y: 0, width: 540, height: 960 });
});

test('explicitly resetting a video box returns to surface layout and keeps version 6', () => {
  const changed = patchInspectedClip(clip, { video: { startMs: 0, entranceMs: 0, sourcePath: 'movie.webm',
    durationMs: 5000, fit: 'contain', volume: 1, muted: true, box: null } }) as VideoClip;
  assert.equal(changed.typeVersion, 6);
  assert.equal(changed.properties.box, undefined);
  const next = applyEditorTimelineCommand(sequence(), { kind: 'replace-clip', clip: changed }, () => 'unused');
  assert.equal((next.clips[0] as VideoClip).properties.box, undefined);
  assert.deepEqual(videoBoxRect(next.clips[0] as VideoClip, { width: 400, height: 800 }, sequence().composition),
    { x: 0, y: 0, width: 400, height: 800 });
});
