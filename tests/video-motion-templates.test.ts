import test from 'node:test';
import assert from 'node:assert/strict';
import type { SequenceV1, Transition, VideoClip } from '../src/domain/sequence.js';
import { applyAnimationTemplate, createAnimationTemplate, createElementTemplate, scaleElementTemplateToComposition } from '../src/domain/element-template.js';
import { upgradeSequenceToBreaks } from '../src/domain/breaks.js';

const none = { preset: 'none', version: 1 } as const;
const composition = { width: 1920, height: 1080 };
function video(): VideoClip {
  return { id: 'video', trackId: 'visual', type: 'video', typeVersion: 6, startMs: 0,
    duration: { kind: 'media' }, entrance: none, exit: none,
    appearance: { blendMode: 'screen', opacity: 0.7 },
    properties: { source: { kind: 'foundry-file', path: 'worlds/test/video.webm' },
      fit: 'contain', volume: 0.4, muted: false, durationMs: 8000,
      box: { x: 100, y: 80, width: 600, height: 400 },
      sourceRange: { inMs: 1000, outMs: 7000 }, keying: { enabled: true, color: '#000000', tolerance: 0.2, softness: 0.1 } } };
}
const slide: Transition = { preset: 'fade-slide', version: 1, durationMs: 600,
  easing: 'back-out', direction: 'right', distance: 180 };

for (const sourceType of ['image', 'video'] as const) {
  for (const phase of ['entrance', 'exit'] as const) {
    test(`${sourceType} movement template applies to video ${phase}, promotes capability and preserves media`, () => {
      const original = video();
      const copy = structuredClone(original);
      const template = createAnimationTemplate('motion', 'Motion', slide, composition, sourceType);
      const applied = applyAnimationTemplate(template, original, phase, { width: 960, height: 540 });
      assert.equal(applied.typeVersion, 7);
      assert.deepEqual(applied[phase], { ...slide, distance: 90 });
      assert.deepEqual(applied[phase === 'entrance' ? 'exit' : 'entrance'], none);
      assert.deepEqual(applied.properties, original.properties);
      assert.deepEqual(applied.appearance, original.appearance);
      assert.deepEqual(original, copy);
    });
  }
}

test('video movement element template scales box and both slide distances without changing source or zoom', () => {
  const original: VideoClip = { ...video(), typeVersion: 7, entrance: slide,
    exit: { preset: 'fade-zoom', version: 1, durationMs: 400, easing: 'linear', scale: 1.4 } };
  const template = createElementTemplate('element', 'Video motion', original, composition);
  const scaled = scaleElementTemplateToComposition(template, { width: 960, height: 540 });
  assert.equal(scaled.type, 'video');
  if (scaled.type !== 'video') throw new Error('Expected video.');
  assert.equal(scaled.typeVersion, 7);
  assert.deepEqual(scaled.entrance, { ...slide, distance: 90 });
  assert.deepEqual(scaled.exit, original.exit);
  assert.deepEqual(scaled.properties.box, { x: 50, y: 40, width: 300, height: 200 });
  assert.deepEqual(scaled.properties.sourceRange, original.properties.sourceRange);
  assert.deepEqual(scaled.properties.keying, original.properties.keying);
});

test('video zoom animation templates validate and retain phase-independent scale', () => {
  const zoom: Transition = { preset: 'zoom', version: 1, durationMs: 500, easing: 'ease-out', scale: 0.6 };
  const template = createAnimationTemplate('zoom', 'Zoom', zoom, composition, 'video');
  const applied = applyAnimationTemplate(template, video(), 'exit', composition);
  assert.equal(applied.typeVersion, 7);
  assert.deepEqual(applied.exit, zoom);
});

test('explicit Break adoption retains video geometry and motion capabilities', () => {
  for (const typeVersion of [6, 7] as const) {
    const clip: VideoClip = { ...video(), typeVersion, entrance: typeVersion === 7 ? slide : none };
    const sequence: SequenceV1 = { schemaVersion: 1, id: 'sequence', revision: 0, name: 'Legacy sequence',
      composition, presentation: { surface: 'window', blockInput: false, exitDurationMs: 300 },
      tracks: [{ id: 'visual', name: 'Visual', kind: 'visual', order: 0, enabled: true, locked: false }],
      clips: [clip], end: { kind: 'manual' } };
    const adopted = upgradeSequenceToBreaks(sequence);
    const result = adopted.clips[0]!;
    assert.equal(result.typeVersion, typeVersion);
    assert.deepEqual(result.entrance, clip.entrance);
    assert.deepEqual(result.properties, { ...clip.properties, onBreak: 'pause' });
    assert.deepEqual(sequence.clips[0], clip);
  }
});
