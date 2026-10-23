import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { KEYING_FRAGMENT_SHADER, keyAlpha, keyRGB } from '../src/rendering/video-keying.js';

test('key alpha has exact normalized color distance and smooth, bounded edge alpha', () => {
  const green = keyRGB('#00FF00');
  assert.deepEqual(green, [0, 1, 0]);
  assert.equal(keyAlpha(green, green, 0, 0), 0);
  assert.equal(keyAlpha([1, 0, 0], green, 0.1, 0.1), 1);
  assert.equal(keyAlpha([0.5, 0.5, 0.5], [0, 0, 0], 0.3, 0.4), 0.5);
  assert.equal(keyAlpha([1, 1, 1], [0, 0, 0], 1, 0), 0);
  assert.equal(keyAlpha([0.25, 0.25, 0.25], [0, 0, 0], 0.25, 0), 0);
  assert.equal(keyAlpha([0.26, 0.26, 0.26], [0, 0, 0], 0.25, 0), 1);
  let previous = 0;
  for (let step = 0; step <= 100; step += 1) {
    const distance = step / 100;
    const alpha = keyAlpha([distance, distance, distance], [0, 0, 0], 0.2, 0.3);
    assert.ok(alpha >= previous && alpha >= 0 && alpha <= 1); previous = alpha;
  }
});

test('retained browser pipeline fixture uses the actual bounded pool and direct filters', async () => {
  await mkdir('.test-build', { recursive: true });
  await writeFile('.test-build/video-keying-render-pipeline.html', await readFile('tests/fixtures/video-keying-render-pipeline.html', 'utf8'), 'utf8');
  const client = await readFile('tests/fixtures/video-keying-render-pipeline.ts', 'utf8');
  assert.match(client, /from '..\/..\/src\/rendering\/video-keying\.js'/);
  assert.match(client, /new VideoKeyingFilter\(pool\)/);
});

test('retained browser fixture injects the production GLSL for actual GPU pixel verification', async () => {
  const template = await readFile('tests/fixtures/video-keying-render-pixels.html', 'utf8');
  assert.equal(template.split('__KEYING_FRAGMENT_SHADER__').length, 2);
  const fixture = template.replace('__KEYING_FRAGMENT_SHADER__', JSON.stringify(KEYING_FRAGMENT_SHADER));
  await mkdir('.test-build', { recursive: true });
  await writeFile('.test-build/video-keying-render-pixels.html', fixture, 'utf8');
  assert.ok(fixture.includes(JSON.stringify(KEYING_FRAGMENT_SHADER)));
});
