import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TEXT_MOTION_PRESETS } from '../src/domain/text-motion.js';

type Locale = Record<string, string>;

const root = fileURLToPath(new URL('../', import.meta.url));
const en = JSON.parse(readFileSync(`${root}/lang/en.json`, 'utf8')) as Locale;
const de = JSON.parse(readFileSync(`${root}/lang/de.json`, 'utf8')) as Locale;

const basicPickerLabels = [
  'STAGECRAFT.Editor.AnimationNone',
  'STAGECRAFT.Editor.AnimationFade',
  'STAGECRAFT.Editor.AnimationSlide',
  'STAGECRAFT.Editor.AnimationFadeSlide',
  'STAGECRAFT.Editor.AnimationZoomPreset',
  'STAGECRAFT.Editor.AnimationFadeZoom'
] as const;

test('all text motion picker labels are localized, nonempty, and distinct', () => {
  assert.equal(TEXT_MOTION_PRESETS.length, 28);

  for (const [localeName, locale, languageTag] of [
    ['English', en, 'en-US'],
    ['German', de, 'de-DE']
  ] as const) {
    const motionKeys = TEXT_MOTION_PRESETS.map(preset => `STAGECRAFT.Editor.TextMotion.${preset.id}`);
    const pickerKeys = [...basicPickerLabels, ...motionKeys];
    const labels = pickerKeys.map(key => locale[key]);

    assert.equal(pickerKeys.length, 34, `${localeName} picker label count`);
    assert.ok(labels.every(label => typeof label === 'string' && label.trim().length > 0),
      `${localeName} labels are nonempty`);
    assert.equal(new Set(labels.map(label => label!.trim().toLocaleLowerCase(languageTag))).size, 34,
      `${localeName} picker labels are distinct`);
  }

  assert.equal(en['STAGECRAFT.Editor.AnimationNone'], 'None');
  assert.equal(en['STAGECRAFT.Editor.AnimationFade'], 'Fade');
  assert.equal(de['STAGECRAFT.Editor.AnimationNone'], 'Keine');
  assert.equal(de['STAGECRAFT.Editor.AnimationFade'], 'Fade');

  assert.equal(en['STAGECRAFT.Editor.TextMotion.gravity-out'], 'Gravity');
  assert.equal(de['STAGECRAFT.Editor.TextMotion.gravity-out'], 'Schwerkraft');
  assert.equal(en['STAGECRAFT.Editor.TextMotion.scatter-assemble'], 'Scatter and assemble');
  assert.equal(en['STAGECRAFT.Editor.TextMotion.scatter-out'], 'Random scatter');
  assert.equal(de['STAGECRAFT.Editor.TextMotion.scatter-assemble'], 'Zerstreuen und zusammensetzen');
  assert.equal(de['STAGECRAFT.Editor.TextMotion.scatter-out'], 'Zufällige Streuung');
});
