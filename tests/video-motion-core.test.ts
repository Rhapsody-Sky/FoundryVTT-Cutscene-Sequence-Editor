import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageClip, SequenceV1, Transition, VideoClip } from '../src/domain/sequence.js';
import { TRANSITION_EASINGS } from '../src/domain/sequence.js';
import { videoTypeVersion } from '../src/domain/clip-timing.js';
import { validateSequence } from '../src/domain/validation.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';

const none: Transition = { preset: 'none', version: 1 };
const video: VideoClip = { id: 'movie', trackId: 'track', type: 'video', typeVersion: 7, startMs: 0,
  duration: { kind: 'media' }, entrance: none, exit: none,
  properties: { source: { kind: 'foundry-file', path: 'movie.webm' }, durationMs: 5000, fit: 'contain', volume: 0.7, muted: false } };
function sequence(clip: VideoClip | ImageClip = video): SequenceV1 {
  return { schemaVersion: 2, id: 'motion', revision: 0, name: 'motion', composition: { width: 1920, height: 1080 },
    presentation: { surface: 'window', blockInput: false, exitDurationMs: 500 },
    tracks: [{ id: 'track', name: 'track', kind: 'visual', order: 0, enabled: true, locked: false }], clips: [clip],
    end: { kind: 'fixed', durationMs: 6000 } };
}
const timed = (preset: Exclude<Transition['preset'], 'none' | 'text-motion'>, easing: typeof TRANSITION_EASINGS[number] = 'linear'): Transition =>
  ({ preset, version: 1, durationMs: 1000, easing, direction: 'left', distance: 360, scale: 0.4 });

test('video entrance/exit motion and opacity match image for every preset and easing', () => {
  for (const preset of ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom'] as const) {
    for (const easing of TRANSITION_EASINGS) {
      const transition = preset === 'none' ? none : timed(preset, easing);
      const clip: VideoClip = { ...video, entrance: transition, exit: transition };
      const image: ImageClip = { ...clip, type: 'image', typeVersion: 1, duration: { kind: 'fixed', milliseconds: 5000 },
        properties: { source: { kind: 'foundry-file', path: 'image.png' }, fit: 'contain', box: { x: 0, y: 0, width: 1920, height: 1080 },
          crop: { x: 0, y: 0, width: 1, height: 1 }, mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } };
      const videoPlan = compileSequence(sequence(clip)), imagePlan = compileSequence(sequence(image));
      for (const position of [0, 100, 250, 500, 1000, 3000, 4000, 4250, 4500, 4999]) {
        const actual = evaluate(videoPlan, position)[0]!, expected = evaluate(imagePlan, position)[0]!;
        assert.deepEqual(actual.textTransform, expected.textTransform, `${preset}/${easing}/${position}`);
        assert.equal(actual.opacity, expected.opacity, `${preset}/${easing}/${position}`);
        assert.equal(actual.mediaTimeMs, position);
      }
    }
  }
});

test('video motion direction, defaults, and overshoot use the shared geometry envelope', () => {
  for (const [direction, expected] of [['left', [-180, 0]], ['right', [180, 0]], ['up', [0, -180]], ['down', [0, 180]]] as const) {
    const clip = { ...video, entrance: { ...timed('slide'), direction } };
    assert.deepEqual(evaluate(compileSequence(sequence(clip)), 500)[0]!.textTransform, { x: expected[0], y: expected[1], scale: 1 });
  }
  const entrance: Transition = { preset: 'fade-slide', version: 1, easing: 'linear', durationMs: 1000 };
  assert.deepEqual(evaluate(compileSequence(sequence({ ...video, entrance })), 500)[0]!.textTransform, { x: 0, y: 50, scale: 1 });
  const zoom: Transition = { preset: 'zoom', version: 1, easing: 'back-in', durationMs: 1000, scale: 4 };
  const overshoot = evaluate(compileSequence(sequence({ ...video, entrance: zoom })), 100)[0]!.textTransform!;
  assert.ok(overshoot.scale > 4);
});

test('version 7 capability is explicit and roundtrips unknown extension data', () => {
  for (const preset of ['slide', 'fade-slide', 'zoom', 'fade-zoom'] as const) {
    const entrance = timed(preset);
    assert.equal(videoTypeVersion({}, 1, { entrance }), 7);
    assert.equal(videoTypeVersion({}, 6, { exit: entrance }), 7);
    for (const typeVersion of [1, 2, 3, 4, 5, 6]) assert.throws(() => validateSequence(sequence({ ...video, typeVersion, entrance } as VideoClip)));
  }
  assert.equal(videoTypeVersion({}, 7, { entrance: none, exit: none }), 7);
  assert.equal(videoTypeVersion({}, 1, { entrance: timed('fade') }), 1);
  const clip = { ...video, entrance: { ...timed('fade-slide'), custom: { label: 'retained' } }, extra: [1, 2],
    properties: { ...video.properties, custom: { source: 'extension' }, box: { x: 100, y: 100, width: 800, height: 600 },
      loop: true, sourceRange: { inMs: 100, outMs: 4900 }, onBreak: 'finish' as const,
      keying: { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.2 } } };
  assert.deepEqual(validateSequence(sequence(clip)), sequence(clip));
  assert.throws(() => validateSequence({ ...sequence(clip), schemaVersion: 1 }));
  for (const entrance of [{ ...timed('slide'), distance: -1 }, { ...timed('slide'), direction: 'diagonal' }, { ...timed('zoom'), scale: 0 },
    { ...timed('zoom'), scale: 5 }, { preset: 'text-motion', version: 1, durationMs: 1000, easing: 'linear', motion: 'rise' }]) {
    assert.throws(() => validateSequence(sequence({ ...video, entrance } as VideoClip)));
  }
});

test('versions 1 through 6 retain their exact frame data and fade behavior', () => {
  for (const typeVersion of [1, 2, 3, 4, 5, 6] as const) {
    const clip: VideoClip = { ...video, typeVersion, entrance: timed('fade'), exit: timed('fade'), properties: { ...video.properties,
      ...(typeVersion === 2 ? { sourceRange: { inMs: 0, outMs: 5000 } } : {}),
      ...(typeVersion === 3 ? { loop: true } : {}), ...(typeVersion === 4 ? { keying: { enabled: true, color: '#00ff00', tolerance: 0.1, softness: 0.1 } } : {}),
      ...(typeVersion === 5 ? { onBreak: 'pause' as const } : {}) } };
    const plan = compileSequence(sequence(clip));
    for (const [position, opacity] of [[0, 0], [500, 0.5], [1000, 1], [4500, 0.5], [4999, 0.0010000000000000009]] as const) {
      assert.deepEqual(evaluate(plan, position), [{ clip: plan.clips[0], localTimeMs: position, opacity, mediaTimeMs: position,
        mediaPlayback: typeVersion === 3 ? 'looping' : 'playing', ...(typeVersion === 3 ? { mediaCycle: 0, videoLoop: true } : {}) }]);
    }
  }
});

test('legacy manual hold and common exit suppress video Out motion', () => {
  const clip = { ...video, entrance: timed('slide'), exit: timed('zoom') };
  const legacy = { ...sequence(clip), schemaVersion: 1 as const, end: { kind: 'manual' as const } };
  const plan = compileSequence(legacy);
  for (const position of [4000, 4500, 5000, 60000]) assert.deepEqual(evaluate(plan, position)[0]!.textTransform, { x: 0, y: 0, scale: 1 });
  const fixed = compileSequence({ ...legacy, end: { kind: 'fixed', durationMs: 5000 } });
  assert.deepEqual(evaluate(fixed, 4500)[0]!.textTransform, { x: 0, y: 0, scale: 1 });
  const looped = compileSequence({ ...legacy, clips: [{ ...clip, properties: { ...clip.properties, loop: true } }] });
  assert.equal(evaluate(looped, 60000)[0]!.videoLoop, true);
  assert.deepEqual(evaluate(looped, 60000)[0]!.textTransform, { x: 0, y: 0, scale: 1 });
});

test('Break and global fade freeze motion on composition time while media continues independently', () => {
  for (const onBreak of ['pause', 'loop', 'finish'] as const) {
    const clip = { ...video, entrance: timed('fade-slide'), exit: timed('fade-zoom'), properties: { ...video.properties, onBreak } };
    const plan = compileSequence({ ...sequence(clip), schemaVersion: 3, breaks: [{ id: 'hold', positionMs: 500 }] });
    const held = evaluate(plan, 500, { holding: { elapsedMs: 2000 } })[0]!;
    assert.deepEqual(held.textTransform, { x: -180, y: 0, scale: 1 }); assert.equal(held.opacity, 0.5);
    assert.equal(held.mediaTimeMs, onBreak === 'pause' ? 500 : 2500);
    const exiting = evaluate(plan, 500, { exiting: { elapsedMs: 2000 } })[0]!;
    assert.deepEqual(exiting.textTransform, held.textTransform); assert.equal(exiting.opacity, held.opacity);
    assert.equal(exiting.mediaTimeMs, 2500);
    const resumed = evaluate(plan, 750, { breakHistory: [{ id: 'hold', positionMs: 500, elapsedMs: 2000 }] })[0]!;
    assert.deepEqual(resumed.textTransform, { x: -90, y: 0, scale: 1 });
    assert.equal(resumed.mediaTimeMs, onBreak === 'finish' ? 2750 : 750);
  }
});
