import test from 'node:test';
import assert from 'node:assert/strict';
import type { ButtonClip } from '../src/domain/sequence.js';
import { defaultButtonProperties } from '../src/domain/button.js';
import { patchInspectedClip } from '../src/ui/clip-inspector.js';
import { BUTTON_DESIGNS, EFFECT_PRESETS, buttonDesignId } from '../src/ui/effect-presets.js';
import type { SimpleButtonValues } from '../src/ui/simple-composition.js';

function button(): ButtonClip {
  const properties = defaultButtonProperties({ width: 1280, height: 720 });
  return {
    id: 'button-clip', trackId: 'visual-track', type: 'button', typeVersion: 1, startMs: 250,
    duration: { kind: 'fixed', milliseconds: 2500, extension: true },
    entrance: { preset: 'fade', version: 1, durationMs: 300, easing: 'ease-out', extension: 'in' },
    exit: { preset: 'slide', version: 1, durationMs: 450, easing: 'back-in', direction: 'right', distance: 24, extension: 'out' },
    appearance: { blendMode: 'screen', opacity: 0.8, extension: 'appearance' },
    extension: 'clip',
    properties: {
      ...properties,
      action: { kind: 'choice', decisionId: 'secret-door', optionId: 'template-option', message: 'The door opens.', visibility: 'gm' },
      label: 'Open the door', texture: { kind: 'foundry-file', path: 'buttons/stone.png', fit: 'contain' },
      outline: { enabled: true, color: '#fff0cc', opacity: 0.9, width: 3, extension: 'outline' }
    }
  } as ButtonClip;
}

function edit(overrides: Partial<SimpleButtonValues> = {}): SimpleButtonValues {
  return {
    startMs: 800, entranceMs: 625, exitMs: 275, entrancePreset: 'zoom', entranceScale: 0.65,
    entranceEasing: 'ease-in', exitPreset: 'fade-slide', exitDirection: 'left', exitDistance: 72,
    exitEasing: 'back-out', durationMode: 'fixed', durationMs: 3500,
    action: { kind: 'choice', decisionId: 'another-question', optionId: 'ignored', message: 'A quiet click.', visibility: 'public' },
    label: 'Unlock', fontFamily: 'Arial', fontSize: 36, color: '#ffffff', backgroundColor: '#162638',
    box: { x: 50, y: 420, width: 360, height: 88 }, shape: 'bevel',
    texture: { kind: 'builtin', id: 'diagonal' },
    appearance: { blendMode: 'multiply', opacity: 0.55 },
    outline: { enabled: true, color: '#e4c78d', opacity: 0.75, width: 5 },
    shadow: { enabled: true, color: '#000000', opacity: 0.6, offsetX: 3, offsetY: 8, blur: 14 },
    glow: { enabled: false, color: '#ffffff', opacity: 0.5, radius: 20 },
    ...overrides
  };
}

test('Button inspector round-trips choice and appearance fields while retaining option identity and extensions', () => {
  const original = button();
  const result = patchInspectedClip(original, { button: edit() }) as ButtonClip;
  assert.equal(result.id, original.id);
  assert.equal(result.trackId, original.trackId);
  assert.equal((result as unknown as Record<string, unknown>).extension, 'clip');
  assert.equal((result.duration as unknown as Record<string, unknown>).extension, true);
  assert.equal(result.properties.action.kind, 'choice');
  if (result.properties.action.kind !== 'choice') assert.fail('choice stays selected');
  assert.equal(result.properties.action.decisionId, 'another-question');
  assert.equal(result.properties.action.optionId, 'template-option', 'editing a copied choice retains its independently authored option ID');
  assert.equal(result.properties.action.message, 'A quiet click.');
  assert.equal(result.properties.action.visibility, 'public');
  assert.equal(result.properties.label, 'Unlock');
  assert.equal(result.properties.shape, 'bevel');
  assert.deepEqual(result.properties.texture, { kind: 'builtin', id: 'diagonal' });
  assert.deepEqual(result.properties.box, { ...original.properties.box, x: 50, y: 420, width: 360, height: 88 });
  assert.deepEqual(result.appearance, { blendMode: 'multiply', opacity: 0.55, extension: 'appearance' });
  assert.equal((result.properties.outline as unknown as Record<string, unknown> | undefined)?.extension, 'outline');
  assert.deepEqual(result.properties.shadow, { enabled: true, color: '#000000', opacity: 0.6, offsetX: 3, offsetY: 8, blur: 14 });
  assert.deepEqual(result.entrance, { preset: 'zoom', version: 1, durationMs: 625, easing: 'ease-in', scale: 0.65, extension: 'in' });
  assert.deepEqual(result.exit, { preset: 'fade-slide', version: 1, durationMs: 275, easing: 'back-out', direction: 'left', distance: 72, extension: 'out' });
});

test('Button entrance and exit edits stay independent, and clearing a custom image removes its file reference', () => {
  const original = button();
  const entranceOnly = patchInspectedClip(original, { button: edit({ entrancePreset: 'fade', entranceMs: 1_050,
    exitPreset: 'slide', exitMs: 450, exitEasing: 'back-in', exitDirection: 'right', exitDistance: 24 }) }) as ButtonClip;
  assert.equal(entranceOnly.entrance.preset, 'fade');
  if (entranceOnly.entrance.preset !== 'fade') assert.fail('entrance preset remains fade');
  assert.equal(entranceOnly.entrance.durationMs, 1_050);
  assert.deepEqual(entranceOnly.exit, original.exit);
  const cleared = patchInspectedClip(original, { button: edit({ texture: null }) }) as ButtonClip;
  assert.equal(cleared.properties.texture, undefined);
});

test('Button library has one element and its inspector design catalog defines visual styles only', () => {
  const buttons = EFFECT_PRESETS.filter(preset => preset.type === 'button');
  assert.deepEqual(buttons.map(preset => preset.id), ['button']);
  assert.deepEqual(BUTTON_DESIGNS.map(design => design.id), ['solid', 'diagonal', 'honeycomb', 'facets']);
  assert.deepEqual(BUTTON_DESIGNS.map(design => design.shape), ['rounded', 'bevel', 'pill', 'hexagon']);
  assert.deepEqual(BUTTON_DESIGNS.map(design => design.texture?.kind === 'builtin' ? design.texture.id : null),
    [null, 'diagonal', 'honeycomb', 'facets']);
  assert.ok(BUTTON_DESIGNS.every(design => !('action' in design)), 'visual recipes do not select button actions');
  assert.equal(buttonDesignId(defaultButtonProperties()), 'solid');
  assert.equal(buttonDesignId({ ...defaultButtonProperties(), backgroundColor: '#112233' }), 'custom');
});
