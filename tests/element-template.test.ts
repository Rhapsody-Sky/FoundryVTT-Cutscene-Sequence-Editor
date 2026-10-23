import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageClip, TextClip, Transition, VideoClip } from '../src/domain/sequence.js';
import {
  applyAnimationTemplate, createAnimationTemplate, createElementTemplate, instantiateElementTemplate,
  scaleElementTemplateToComposition, TemplateValidationError, validateTemplate,
} from '../src/domain/element-template.js';

const NO_TRANSITION: Transition = { preset: 'none', version: 1 };

function textClip(): TextClip {
  return {
    id: 'source-clip', trackId: 'source-track', type: 'text', typeVersion: 1, startMs: 3_250,
    duration: { kind: 'fixed', milliseconds: 5_000 },
    entrance: { preset: 'slide', version: 1, durationMs: 700, easing: 'ease-out', direction: 'left', distance: 180 },
    exit: { preset: 'fade', version: 1, durationMs: 300, easing: 'linear' },
    appearance: { blendMode: 'screen', opacity: 0.85 },
    properties: {
      text: 'Chapter 4', fontFamily: 'Signika', fontSize: 96, minimumFontSize: 32,
      color: '#fefefe', align: 'center', box: { x: 192, y: 378, width: 1536, height: 324 },
      shrinkToFit: true,
      outline: { enabled: true, color: '#000000', opacity: 0.8, width: 3 },
      shadow: { enabled: true, color: '#000000', opacity: 0.7, offsetX: 8, offsetY: 12, blur: 18 },
      glow: { enabled: false, color: '#ffff00', opacity: 0.5, radius: 22 },
    },
  };
}

function videoClip(): VideoClip {
  return {
    id: 'video-source', trackId: 'visual-track', type: 'video', typeVersion: 5, startMs: 0,
    duration: { kind: 'media' }, entrance: NO_TRANSITION, exit: NO_TRANSITION,
    properties: {
      source: { kind: 'foundry-file', path: 'worlds/test/media/clip.webm' }, fit: 'contain', volume: 1, muted: false,
      onBreak: 'pause',
      durationMs: 4_000,
    },
  };
}

test('element template captures every non-placement field and creates a fresh fitted instance', () => {
  const template = createElementTemplate('title-card', 'Chapter title', textClip(), { width: 1920, height: 1080 });
  assert.equal(template.content.kind, 'element');
  if (template.content.kind !== 'element') throw new Error('Expected an element template.');
  assert.equal('id' in template.content.clip, false);
  assert.equal('trackId' in template.content.clip, false);
  assert.equal('startMs' in template.content.clip, false);
  assert.equal(template.content.clip.type, 'text');
  if (template.content.clip.type !== 'text') throw new Error('Expected text.');
  assert.equal(template.content.clip.properties.text, 'Chapter 4');
  assert.equal(template.content.clip.entrance.preset, 'slide');
  assert.equal(template.content.clip.exit.preset, 'fade');
  assert.deepEqual(template.content.clip.appearance, { blendMode: 'screen', opacity: 0.85 });

  const fitted = scaleElementTemplateToComposition(template, { width: 1280, height: 1080 });
  assert.equal(fitted.type, 'text');
  if (fitted.type !== 'text') throw new Error('Expected text.');
  assert.deepEqual(fitted.properties.box, { x: 128, y: 432, width: 1024, height: 216 });
  assert.equal(fitted.properties.fontSize, 64);
  assert.equal(fitted.properties.minimumFontSize, 21.33);
  assert.equal(fitted.entrance.preset === 'none' ? undefined : fitted.entrance.distance, 120);
  assert.equal(fitted.properties.shadow?.offsetY, 8);

  let count = 0;
  const instance = instantiateElementTemplate(template, {
    trackId: 'destination-track', startMs: 9_000, composition: { width: 1280, height: 1080 },
  }, () => `new-clip-${++count}`);
  assert.equal(instance.id, 'new-clip-1');
  assert.equal(instance.trackId, 'destination-track');
  assert.equal(instance.startMs, 9_000);
  assert.equal(instance.type, 'text');
  if (instance.type !== 'text') throw new Error('Expected text.');
  assert.equal(instance.properties.text, 'Chapter 4');
  assert.notEqual(instance.id, 'source-clip');
});

test('image box/effects scale without changing source crop or normalized mask', () => {
  const image: ImageClip = {
    id: 'img', trackId: 'v', type: 'image', typeVersion: 1, startMs: 0,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: NO_TRANSITION, exit: NO_TRANSITION,
    properties: {
      source: { kind: 'foundry-file', path: 'worlds/test/media/image.png' }, fit: 'cover',
      box: { x: 100, y: 50, width: 800, height: 600 }, crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 },
      mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      outline: { enabled: true, color: '#ffffff', opacity: 1, width: 4, blur: 77 } as NonNullable<ImageClip['properties']['outline']>,
    },
  };
  const template = createElementTemplate('image-card', 'Picture', image, { width: 1000, height: 1000 });
  const scaled = scaleElementTemplateToComposition(template, { width: 500, height: 500 });
  assert.equal(scaled.type, 'image');
  if (scaled.type !== 'image') throw new Error('Expected image.');
  assert.deepEqual(scaled.properties.box, { x: 50, y: 25, width: 400, height: 300 });
  assert.equal(scaled.properties.outline?.width, 2);
  assert.equal((scaled.properties.outline as unknown as Record<string, unknown>).blur, 77);
  assert.deepEqual(scaled.properties.crop, image.properties.crop);
  assert.deepEqual(scaled.properties.mask, image.properties.mask);
});

test('composition extension fields survive validation and animation durations use the schema limit', () => {
  const extendedComposition = { width: 1920, height: 1080, coordinateSpace: 'logical-v1' };
  const element = createElementTemplate('extended-comp', 'Extended composition', textClip(), extendedComposition);
  assert.deepEqual(element.content.kind === 'element' ? element.content.sourceComposition : undefined, extendedComposition);
  const longFade = createAnimationTemplate('long-fade', 'Long fade', {
    preset: 'fade', version: 1, durationMs: 6_000, easing: 'linear',
  }, extendedComposition, 'text');
  if (longFade.content.kind !== 'animation') throw new Error('Expected an animation template.');
  assert.equal(longFade.content.transition.preset === 'none' ? undefined : longFade.content.transition.durationMs, 6_000);
  assert.deepEqual(longFade.content.sourceComposition, extendedComposition);
});

test('video v6 geometry scales with composition while preserving media fields', () => {
  const boxedVideo: VideoClip = {
    id: 'boxed-video', trackId: 'visual-track', type: 'video', typeVersion: 6, startMs: 0,
    duration: { kind: 'media' }, entrance: NO_TRANSITION, exit: NO_TRANSITION,
    properties: {
      source: { kind: 'foundry-file', path: 'worlds/test/media/boxed.webm' }, fit: 'contain',
      box: { x: 100, y: 80, width: 600, height: 400 }, volume: 1, muted: false, onBreak: 'pause', durationMs: 2_000,
    },
  };
  const template = createElementTemplate('boxed-video-template', 'Boxed video', boxedVideo, { width: 1920, height: 1080 });
  const scaled = scaleElementTemplateToComposition(template, { width: 960, height: 540 });
  assert.equal(scaled.type, 'video');
  if (scaled.type !== 'video') throw new Error('Expected a video clip.');
  assert.deepEqual(scaled.properties.box, { x: 50, y: 40, width: 300, height: 200 });
  assert.equal(scaled.properties.source.path, boxedVideo.properties.source.path);
  assert.equal(scaled.properties.durationMs, 2_000);
});

test('template reuse preserves legacy fractional fields at the same size and rounds scaled spatial fields to hundredths', () => {
  const original = textClip();
  const clip: TextClip = { ...original, properties: {
    ...original.properties,
    fontSize: 80.123456789, minimumFontSize: 20.123456789,
    box: { x: 100.123456789, y: 50.987654321, width: 800.123456789, height: 600.987654321 },
    outline: { ...original.properties.outline!, width: 3.333333333 },
    shadow: { ...original.properties.shadow!, offsetX: -4.123456789, offsetY: 8.345678912, blur: 16.987654321 },
    glow: { ...original.properties.glow!, radius: 24.7654321 }
  } };
  const template = createElementTemplate('fractional-title', 'Fractional title', clip, { width: 1000, height: 800 });
  const same = scaleElementTemplateToComposition(template, { width: 1000, height: 800 });
  assert.deepEqual(same.properties, clip.properties, 'same-size template reuse must not quantize legacy values');
  const scaled = scaleElementTemplateToComposition(template, { width: 500, height: 800 });
  assert.equal(scaled.type, 'text');
  if (scaled.type !== 'text') throw new Error('Expected a text template.');
  assert.deepEqual(scaled.properties.box, { x: 50.06, y: 225.49, width: 400.06, height: 300.49 });
  assert.equal(scaled.properties.fontSize, 40.06);
  assert.equal(scaled.properties.minimumFontSize, 10.06);
  assert.equal(scaled.properties.outline!.width, 1.67);
  assert.equal(scaled.properties.shadow!.offsetX, -2.06);
  assert.equal(scaled.properties.shadow!.offsetY, 4.17);
  assert.equal(scaled.properties.shadow!.blur, 8.49);
  assert.equal(scaled.properties.glow!.radius, 12.38);
});

test('animation template carries one transition for either side and scales logical slide distance', () => {
  const transition: Transition = { preset: 'slide', version: 1, durationMs: 500, easing: 'ease-in', direction: 'up', distance: 200 };
  const template = createAnimationTemplate('slide-in', 'Slide', transition, { width: 1920, height: 1080 }, 'text');
  const source = textClip();
  const entrance = applyAnimationTemplate(template, source, 'entrance', { width: 960, height: 1080 });
  assert.equal(entrance.id, source.id);
  assert.equal(entrance.trackId, source.trackId);
  assert.equal(entrance.startMs, source.startMs);
  assert.equal(entrance.entrance.preset, 'slide');
  assert.equal('distance' in entrance.entrance ? entrance.entrance.distance : undefined, 100);
  const exit = applyAnimationTemplate(template, source, 'exit', { width: 960, height: 1080 });
  assert.equal(exit.exit.preset, 'slide');
  const defaultDistance = createAnimationTemplate('default-slide', 'Default slide', {
    preset: 'slide', version: 1, durationMs: 400, easing: 'linear', direction: 'left',
  }, { width: 1920, height: 1080 }, 'text');
  const defaultApplied = applyAnimationTemplate(defaultDistance, source, 'entrance', { width: 960, height: 540 });
  assert.equal((defaultApplied.entrance as Exclude<Transition, { preset: 'none' }>).distance, 50);
});

test('animation application validates compatibility against the target clip type', () => {
  const template = createAnimationTemplate('zoom', 'Zoom', {
    preset: 'zoom', version: 1, durationMs: 500, easing: 'ease-out', scale: 0.8,
  }, { width: 1920, height: 1080 }, 'text');
  const animatedVideo = applyAnimationTemplate(template, videoClip(), 'entrance', { width: 1920, height: 1080 });
  assert.equal(animatedVideo.typeVersion, 7);
  assert.deepEqual(animatedVideo.entrance, {
    preset: 'zoom', version: 1, durationMs: 500, easing: 'ease-out', scale: 0.8,
  });
  assert.throws(() => createAnimationTemplate('bars-zoom', 'Zoom', {
    preset: 'zoom', version: 1, durationMs: 500, easing: 'ease-out', scale: 0.8,
  }, { width: 1920, height: 1080 }, 'bars'),
  (error: unknown) => error instanceof TemplateValidationError && error.code === 'UNSUPPORTED_TYPE');
  const fadeTemplate = createAnimationTemplate('fade', 'Fade', { preset: 'fade', version: 1, durationMs: 300, easing: 'linear' }, { width: 1920, height: 1080 }, 'text');
  assert.equal(applyAnimationTemplate(fadeTemplate, videoClip(), 'exit', { width: 1920, height: 1080 }).exit.preset, 'fade');
});

test('bars reveal slides stay bars-specific while logical text/image slides are compatible', () => {
  const slide: Transition = { preset: 'slide', version: 1, durationMs: 500, easing: 'ease-in', direction: 'up', distance: 200 };
  const barsTemplate = createAnimationTemplate('bars-slide', 'Bars reveal', slide, { width: 1920, height: 1080 }, 'bars');
  assert.throws(() => applyAnimationTemplate(barsTemplate, textClip(), 'entrance', { width: 1920, height: 1080 }),
    (error: unknown) => error instanceof TemplateValidationError && error.code === 'ANIMATION_INCOMPATIBLE');
  assert.throws(() => createAnimationTemplate('invalid-bars-zoom', 'Invalid bars zoom', {
    preset: 'zoom', version: 1, durationMs: 300, easing: 'linear',
  }, { width: 1920, height: 1080 }, 'bars'),
  (error: unknown) => error instanceof TemplateValidationError && error.code === 'UNSUPPORTED_TYPE');
  const bars: Extract<import('../src/domain/sequence.js').SequenceClip, { type: 'bars' }> = {
    id: 'bars-target', trackId: 'visual-track', type: 'bars', typeVersion: 1, startMs: 500,
    duration: { kind: 'fixed', milliseconds: 5_000 }, entrance: NO_TRANSITION, exit: NO_TRANSITION,
    properties: { heightFraction: 0.1, color: '#000000' },
  };
  const barsSlide = applyAnimationTemplate(barsTemplate, bars, 'entrance', { width: 960, height: 1080 });
  assert.equal(barsSlide.id, bars.id);
  assert.equal(barsSlide.trackId, bars.trackId);
  assert.equal(barsSlide.startMs, bars.startMs);
  assert.equal(barsSlide.entrance.preset, 'slide');
  assert.equal((barsSlide.entrance as Exclude<Transition, { preset: 'none' }>).distance, 200);
});

test('template validation rejects saved placement and unknown envelope versions', () => {
  const template = createElementTemplate('element', 'Title', textClip(), { width: 1920, height: 1080 });
  assert.throws(() => validateTemplate({ ...template, schemaVersion: 2 }),
    (error: unknown) => error instanceof TemplateValidationError && error.code === 'UNSUPPORTED_TEMPLATE_VERSION');
  const content = template.content;
  if (content.kind !== 'element') throw new Error('Expected an element template.');
  assert.throws(() => validateTemplate({
    ...template,
    content: { ...content, clip: { ...content.clip, startMs: 10 } },
  }), (error: unknown) => error instanceof TemplateValidationError && error.code === 'PLACEMENT_INCLUDED');
});
