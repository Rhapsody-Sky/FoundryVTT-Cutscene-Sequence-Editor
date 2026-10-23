import test from 'node:test';
import assert from 'node:assert/strict';
import { createBarsSequence, validateSequence } from '../src/domain/validation.js';
import type { SequenceV1, TextClip } from '../src/domain/sequence.js';
import { patchInspectedClip } from '../src/ui/clip-inspector.js';
import { InspectorForm, type FieldElement } from '../src/ui/editor/inspector-form.js';
import { InspectorFields } from '../src/ui/editor/inspector-fields.js';
import { readElementValues } from '../src/ui/editor/inspector-values.js';

function sequence(): SequenceV1 {
  let next = 0;
  const base = createBarsSequence('Saved sequence name', () => `inspector-${++next}`);
  const track = base.tracks[0]!;
  return validateSequence({ ...base, end: { kind: 'fixed', durationMs: 5000 },
    tracks: [track, { ...track, id: 'second-track', order: 1 }],
    clips: [0, 1].map(index => ({ ...base.clips[0]!, id: `title-${index}`, type: 'text',
      trackId: index ? 'second-track' : track.id, duration: { kind: 'fixed', milliseconds: 1000 },
      entrance: { preset: 'none', version: 1, entranceExtension: 'retained' },
      exit: { preset: 'fade', version: 1, durationMs: 900, easing: 'ease-in', exitExtension: 'retained' },
      properties: { text: index ? 'Second title' : 'First title', fontFamily: 'Custom Serif', fontSize: index ? 42 : 72,
        minimumFontSize: 24, color: '#AABBCC', align: 'center', shrinkToFit: true,
        box: { x: 0.125, y: 100, width: 1920, height: 800, boxExtension: 'retained' }, propertiesExtension: 'retained' },
      clipExtension: 'retained' })) });
}

function controls(initial: Record<string, { value: string; type?: string }>) {
  const fields = new Map(Object.entries(initial).map(([name, values]) => [name, { ...values, name, checked: false, disabled: false }]));
  const form = new InspectorForm(null, key => key,
    <T extends FieldElement>(name: string) => (fields.get(name) ?? null) as unknown as T | null);
  return { fields, form, projection: new InspectorFields(form) };
}

test('inspector decoding targets the explicit selection and preserves missing fields, authored colors and extensions', () => {
  const source = sequence(), original = structuredClone(source);
  const selected = source.clips[1]! as TextClip;
  const { form } = controls({ 'sequence-name': { value: 'Uncommitted rename' },
    'title-color': { value: '#aabbcc', type: 'color' }, 'title-size': { value: '88' } });
  const values = readElementValues(form, source, selected, { kind: 'fixed', durationMs: 5000 },
    () => { throw new Error('Text decoding must not request video geometry'); });
  assert.equal(values.name, source.name);
  assert.equal(values.text?.text, 'Second title');
  assert.equal(values.text?.color, '#AABBCC');
  assert.equal(values.text?.fontSize, 88);
  assert.equal(values.bars, undefined);
  assert.equal(values.video, undefined);
  const patched = patchInspectedClip(selected, values) as TextClip;
  assert.deepEqual(patched, { ...selected, properties: { ...selected.properties, fontSize: 88 } });
  assert.deepEqual(source, original);

  const none = readElementValues(form, source, undefined, { kind: 'fixed', durationMs: 5000 },
    () => { throw new Error('An empty selection must not request video geometry'); });
  assert.equal(none.text, undefined, 'empty selection must not fall back to the first title');
});

test('one inspector projection follows explicit selection changes and clears stale clip values without editor state', () => {
  const source = sequence(), original = structuredClone(source);
  const { fields, projection } = controls({ 'title-text': { value: '' }, 'title-size': { value: '' },
    'bars-height': { value: '' }, 'text-start': { value: '' } });
  const box = () => ({ x: 0, y: 0, width: 1920, height: 1080 });
  projection.paintClipFields(source, source.clips[0], box);
  assert.equal(fields.get('title-text')!.value, 'First title');
  assert.equal(fields.get('title-size')!.value, '72');
  projection.paintClipFields(source, source.clips[1], box);
  assert.equal(fields.get('title-text')!.value, 'Second title');
  assert.equal(fields.get('title-size')!.value, '42');
  projection.paintClipFields(source, undefined, box);
  assert.equal(fields.get('title-text')!.value, 'Title');
  assert.equal(fields.get('title-size')!.value, '96');
  assert.equal(fields.get('bars-height')!.value, '12');
  assert.deepEqual(source, original);
});

test('animation preparation uses the supplied clip interval and painting preserves equivalent active numeric text', () => {
  const source = sequence(), selected = source.clips[1]! as TextClip;
  const original = structuredClone(source);
  const { fields, projection } = controls({ 'text-entrance-preset': { value: 'fade' },
    'text-entrance': { value: '2' }, 'text-exit': { value: '0.9' } });
  projection.prepareAnimationPreset(source, selected, 'text-entrance-preset');
  assert.equal(fields.get('text-entrance')!.value, '0.1', 'entrance fits the remaining 100ms');
  fields.get('text-entrance')!.value = '0.100';
  projection.paintMotionAnimations('text', { ...selected,
    entrance: { preset: 'fade', version: 1, durationMs: 100, easing: 'ease-out' } }, 'text-entrance');
  assert.equal(fields.get('text-entrance')!.value, '0.100');
  assert.deepEqual(source, original);
});
