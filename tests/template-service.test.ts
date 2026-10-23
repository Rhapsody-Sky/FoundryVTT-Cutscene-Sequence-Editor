import test from 'node:test';
import assert from 'node:assert/strict';
import { TemplateService, TemplateServiceError } from '../src/application/template-service.js';
import type { TemplateRepository, TemplateSummary } from '../src/application/template-ports.js';
import { createElementTemplate, type TemplateEnvelopeV1 } from '../src/domain/element-template.js';
import type { SequenceV1, VideoClip } from '../src/domain/sequence.js';
import { createBarsSequence } from '../src/domain/validation.js';

const video: VideoClip = {
  id: 'source-video', trackId: 'visual', type: 'video', typeVersion: 5, startMs: 0,
  duration: { kind: 'media' },
  entrance: { preset: 'fade', version: 1, durationMs: 300, easing: 'ease-in-out' },
  exit: { preset: 'none', version: 1 },
  properties: {
    source: { kind: 'foundry-file', path: 'worlds/example/clips/stinger.webm' }, fit: 'cover', volume: 1, muted: false,
    onBreak: 'pause',
    // This value is deliberately stale; insertion must use the probe result.
    durationMs: 2_000,
    sourceRange: { inMs: 0, outMs: 5_000 },
  },
};

function sequence(): SequenceV1 {
  return createBarsSequence('Test', (() => { let id = 0; return () => `sequence-${++id}`; })(), 3);
}

function repositoryWith(template: TemplateEnvelopeV1): TemplateRepository {
  return {
    async list(): Promise<readonly TemplateSummary[]> {
      return [{ id: template.id, revision: template.revision, name: template.name, kind: template.content.kind }];
    },
    async read() { return structuredClone(template); },
    async save(value) { return structuredClone(value); },
    async delete() {},
  };
}

test('element template insertion uses a fresh media probe rather than its saved duration', async () => {
  const template = createElementTemplate('stinger', 'Stinger', video, { width: 1920, height: 1080 });
  const seenMedia: Array<{ path: string; type: 'audio' | 'video' }> = [];
  const service = new TemplateService(repositoryWith(template), () => 'inserted-video', async (path, type) => {
    seenMedia.push({ path, type });
    return 6_500;
  });
  const inserted = await service.instantiateElement(template, sequence(), 'audio-visual-track', 4_250);
  assert.deepEqual(seenMedia, [{ path: 'worlds/example/clips/stinger.webm', type: 'video' }]);
  assert.equal(inserted.id, 'inserted-video');
  assert.equal(inserted.trackId, 'audio-visual-track');
  assert.equal(inserted.startMs, 4_250);
  assert.equal(inserted.type, 'video');
  if (inserted.type !== 'video') throw new Error('Expected a video clip.');
  assert.equal(inserted.properties.durationMs, 6_500);
  assert.deepEqual(inserted.properties.sourceRange, { inMs: 0, outMs: 5_000 });
});

test('element template insertion rejects a source range that no longer fits the file', async () => {
  const template = createElementTemplate('stinger-short', 'Stinger', video, { width: 1920, height: 1080 });
  const service = new TemplateService(repositoryWith(template), () => 'inserted-video', async () => 4_000);
  await assert.rejects(
    service.instantiateElement(template, sequence(), 'visual-track', 0),
    (error: unknown) => error instanceof TemplateServiceError && error.code === 'SOURCE_RANGE_OUTSIDE_MEDIA',
  );
});

test('animation template application returns a replacement for the editor undoable command path', async () => {
  const bars = sequence().clips[0]!;
  const template = createElementTemplate('unused', 'Bars', bars, { width: 1920, height: 1080 });
  const repository = repositoryWith(template);
  const service = new TemplateService(repository, () => 'fresh');
  const animation = {
    format: 'stagecraft-template', schemaVersion: 1, id: 'fade', revision: 1, name: 'Fade',
    content: { kind: 'animation', sourceType: 'bars', sourceComposition: { width: 1920, height: 1080 },
      transition: { preset: 'fade', version: 1, durationMs: 400, easing: 'ease-out' } },
  } as const;
  const fixedBars = { ...bars, duration: { kind: 'fixed', milliseconds: 5000 } as const } as typeof bars;
  const updated = service.applyAnimation(animation, fixedBars, 'exit', sequence());
  assert.equal(updated.id, bars.id);
  assert.equal(updated.exit.preset, 'fade');
});
