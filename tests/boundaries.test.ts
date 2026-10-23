import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

test('domain and playback contracts do not depend on Foundry or UI implementations', async () => {
  for (const directory of ['src/domain', 'src/playback', 'src/application']) {
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.ts')) continue;
      const text = await readFile(path.join(directory, file), 'utf8');
      assert.doesNotMatch(text, /(?:game|canvas|Hooks|ui)\s*\./, `${directory}/${file}`);
      assert.doesNotMatch(text, /from\s+['"][^'"]*(?:integrations|\/ui\/|bootstrap)[^'"]*['"]/, file);
    }
  }
});

test('manifest identity, assets and language keys agree with the native-tested Foundry version', async () => {
  const manifest = JSON.parse(await readFile('module.json', 'utf8')) as Record<string, unknown>;
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.id, pkg.name);
  assert.equal(manifest.version, pkg.version);
  // Native editor QA was performed on this installed Foundry build.
  assert.equal((manifest.compatibility as Record<string, unknown>).verified, '14.367');
  const de = JSON.parse(await readFile('lang/de.json', 'utf8')) as Record<string, string>;
  const en = JSON.parse(await readFile('lang/en.json', 'utf8')) as Record<string, string>;
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  const template = (await Promise.all(['templates/status.hbs','templates/editor.hbs'].map(file => readFile(file, 'utf8')))).join('\n');
  for (const [, key] of template.matchAll(/\{\{localize "([^"]+)"\}\}/g)) {
    assert.ok(key && de[key] && en[key], `Missing translation: ${key}`);
  }
});
