import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mediaFadeChoiceDurations } from '../src/ui/media-fade-choice.js';

test('element animation choices keep native fallbacks and the supported catalogs', async () => {
  const template = await readFile('templates/editor.hbs', 'utf8');
  const counts = { bars: 4, image: 6, solid: 6, video: 6, audio: 2, button: 6 };
  let hosts = 0;
  for (const [kind, count] of Object.entries(counts)) {
    for (const phase of ['entrance', 'exit']) {
      const host = `data-stagecraft-element-animation-picker="${kind}-${phase}"`;
      assert.equal(template.split(host).length - 1, 1, host);
      const select = new RegExp(`<select name="${kind}-${phase}-preset"[^>]*>([\\s\\S]*?)<\\/select>`).exec(template);
      assert.ok(select, `${kind} ${phase} keeps a native fallback`);
      assert.equal((select[1]!.match(/<option\b/g) ?? []).length, count);
      assert.equal(/\bhidden\b/.test(select[0]!.split('>')[0]!), false);
      hosts++;
    }
  }
  assert.equal((template.match(/data-stagecraft-element-animation-picker=/g) ?? []).length, hosts);
});

test('choosing a media fade preserves an authored duration and disabling it preserves the opposite edge', () => {
  assert.deepEqual(mediaFadeChoiceDurations('fade', 375, 100, 1000), { durationMs: 375, oppositeMs: 100 });
  assert.deepEqual(mediaFadeChoiceDurations('none', 375, 100, 1000), { durationMs: 0, oppositeMs: 100 });
});

test('a newly enabled media fade fits short clips including a fully occupied opposite fade', () => {
  assert.deepEqual(mediaFadeChoiceDurations('fade', 0, 100, 400), { durationMs: 300, oppositeMs: 100 });
  assert.deepEqual(mediaFadeChoiceDurations('fade', 0, 400, 400), { durationMs: 1, oppositeMs: 399 });
  assert.deepEqual(mediaFadeChoiceDurations('fade', 0, 0, null), { durationMs: 800, oppositeMs: 0 });
  assert.throws(() => mediaFadeChoiceDurations('slide', 0, 0, 1000), RangeError);
});
