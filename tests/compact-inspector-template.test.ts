import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

interface TemplateNode {
  tag: string;
  attrs: Record<string, string>;
  children: TemplateNode[];
  parent: TemplateNode | null;
  text: string;
}

/** Inspect the real template tree without claiming browser layout or native activation coverage. */
function parseTemplate(source: string): TemplateNode[] {
  const sourceWithLabels = source.replace(/{{localize\s+["']([^"']+)["']}}/g, '__$1__');
  const root: TemplateNode = { tag: 'root', attrs: {}, children: [], parent: null, text: '' };
  const stack = [root], nodes: TemplateNode[] = [];
  for (const token of sourceWithLabels.matchAll(/<[^>]+>|[^<]+/g)) {
    const raw = token[0];
    const closing = raw.match(/^<\/([\w-]+)/);
    if (closing) { assert.equal(stack.pop()?.tag, closing[1], 'balanced template tags'); continue; }
    const opening = raw.match(/^<([\w-]+)/);
    if (!opening) { for (const ancestor of stack) ancestor.text += raw; continue; }
    const attrs: Record<string, string> = {};
    for (const attr of raw.slice(opening[0].length, -1).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
      attrs[attr[1]!] = attr[2] ?? attr[3] ?? '';
    }
    const parent = stack.at(-1)!;
    const node: TemplateNode = { tag: opening[1]!, attrs, children: [], parent, text: '' };
    parent.children.push(node); nodes.push(node);
    if (!['input', 'br', 'hr', 'img'].includes(node.tag)) stack.push(node);
  }
  assert.equal(stack.length, 1, 'all template elements close');
  return nodes;
}

function nearest(node: TemplateNode, attr: string): TemplateNode | null {
  for (let current: TemplateNode | null = node; current; current = current.parent) {
    if (attr in current.attrs) return current;
  }
  return null;
}

const namedConstraintAttrs = ['name', 'type', 'min', 'max', 'step', 'required', 'maxlength', 'rows', 'disabled', 'hidden', 'autocomplete'];
function fieldInventory(nodes: TemplateNode[]) {
  return nodes.filter(node => node.attrs.name).map(node => ({
    tag: node.tag,
    attrs: Object.fromEntries(namedConstraintAttrs.filter(key => key in node.attrs).map(key => [key, node.attrs[key]])),
    options: node.children.filter(child => child.tag === 'option').map(option => ({
      attrs: option.attrs, text: option.text.trim().replace(/\s+/g, ' ')
    }))
  })).sort((a, b) => a.attrs.name!.localeCompare(b.attrs.name!));
}

const template = await readFile('templates/editor.hbs', 'utf8');
const nodes = parseTemplate(template);

test('all installed 0.9.2 named fields, constraints, options and visibility hooks survive the compact inspector', async () => {
  const baseline = JSON.parse(await readFile('tests/fixtures/inspector-controls-0.9.2.json', 'utf8')) as {
    fields: ReturnType<typeof fieldInventory>;
    dataAttributes: Record<string, string[]>;
    visibility: { tag: string; attrs: Record<string, string> }[];
  };
  // Preserve every historic control; independently check additive text motion controls.
  const historicNodes = nodes.filter(node => nearest(node, 'data-stagecraft-element-panel')?.attrs['data-stagecraft-element-panel'] !== 'solid'
    && nearest(node, 'data-stagecraft-element-panel')?.attrs['data-stagecraft-element-panel'] !== 'button'
    && !/^motion(?:-|$)/.test(nearest(node, 'data-stagecraft-animation-kind')?.attrs['data-stagecraft-animation-kind'] ?? '')
    && (!nearest(node, 'data-stagecraft-video-animation-param') || node.attrs.name === 'video-entrance')
    && !('data-stagecraft-media-fade-preset' in node.attrs)
    && !('data-stagecraft-video-motion-preset' in node.attrs));
  assert.equal(baseline.fields.length, 143, 'preserve the original historical fixture');
  const historicFields = fieldInventory(historicNodes).map(field => field.attrs.name === 'video-entrance'
    ? { ...field, attrs: { ...field.attrs, min: '0' } } : field);
  assert.deepEqual(historicFields, baseline.fields);
  const videoEntrance = nodes.find(node => node.attrs.name === 'video-entrance')!;
  assert.equal(videoEntrance.attrs.name, 'video-entrance', 'retain the established numeric field name');
  assert.equal(videoEntrance.attrs.min, '0.001', 'timed video animation requires a positive duration');
  assert.equal(nearest(videoEntrance, 'data-stagecraft-video-animation-param')?.text.trim(), '__STAGECRAFT.Editor.AnimationDuration__');
  const names = nodes.filter(node => node.attrs.name).map(node => node.attrs.name);
  assert.equal(new Set(names).size, names.length, 'one live input for every field name');
  for (const [key, values] of Object.entries(baseline.dataAttributes)) {
    assert.deepEqual(historicNodes.filter(node => key in node.attrs).map(node => node.attrs[key]!).sort(), values, key);
  }
  const visibility = historicNodes.filter(node => ('hidden' in node.attrs || 'disabled' in node.attrs)
    && !('data-stagecraft-clip-section-page' in node.attrs)).map(node => ({
    tag: node.tag,
    attrs: Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key.startsWith('data-') || ['name', 'hidden', 'disabled'].includes(key)))
  }));
  const order = (a: object, b: object) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  assert.deepEqual(visibility.sort(order), baseline.visibility.sort(order));
});

test('Sequence inspector does not expose stored audience without auto-trigger settings', () => {
  assert.equal(nodes.some(node => 'data-stagecraft-audience-group' in node.attrs), false);
  assert.deepEqual(nodes.filter(node => node.attrs.name?.startsWith('audience-')), []);
});

test('auto-trigger authoring is foldable inside the Sequence inspector page', () => {
  const group = nodes.find(node => 'data-stagecraft-auto-trigger-group' in node.attrs)!;
  const slot = nodes.find(node => 'data-stagecraft-trigger-settings' in node.attrs)!;
  assert.equal(group.tag, 'details');
  assert.equal(group.children[0]?.tag, 'summary');
  assert.equal(nearest(slot, 'data-stagecraft-auto-trigger-group'), group);
  assert.equal(nearest(slot, 'data-stagecraft-inspector-page')?.attrs['data-stagecraft-inspector-page'], 'sequence');
  assert.equal('open' in group.attrs, false, 'automatic-start controls stay compact until opened');
});

test('fixed Clip categories have unique ARIA targets and one Content/Animation/Timing page inside every type panel', () => {
  const toolbar = nodes.find(node => 'data-stagecraft-clip-section-tabs' in node.attrs)!;
  assert.equal(toolbar.attrs.role, 'tablist');
  assert.equal(nearest(toolbar, 'data-stagecraft-inspector'), null, 'category toolbar stays outside the scrolling fieldset');
  assert.equal(toolbar.parent?.attrs.class, 'stagecraft-inspector-panel');
  const buttons = toolbar.children.filter(node => 'data-stagecraft-clip-section-tab' in node.attrs);
  assert.deepEqual(buttons.map(button => button.attrs['data-stagecraft-clip-section-tab']), ['content', 'animation', 'timing']);
  assert.deepEqual(buttons.map(button => button.attrs['aria-selected']), ['true', 'false', 'false']);
  const ids = nodes.filter(node => node.attrs.id).map(node => node.attrs.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicated DOM IDs');
  for (const button of buttons) assert.ok(ids.includes(button.attrs['aria-controls']));
  for (const type of ['bars', 'text', 'image', 'solid', 'video', 'audio', 'button']) {
    const panel = nodes.find(node => node.attrs['data-stagecraft-element-panel'] === type)!;
    const pages = panel.children.filter(node => 'data-stagecraft-clip-section-page' in node.attrs);
    assert.deepEqual(pages.map(page => page.attrs['data-stagecraft-clip-section-page']), ['content', 'animation', 'timing'], type);
    for (const page of pages) {
      assert.equal(page.attrs.role, 'tabpanel');
      assert.equal(page.attrs['aria-labelledby'], `stagecraft-clip-section-tab-${page.attrs['data-stagecraft-clip-section-page']}`);
    }
    assert.equal('hidden' in pages[0]!.attrs, false);
    assert.equal('hidden' in pages[1]!.attrs, true);
    assert.equal('hidden' in pages[2]!.attrs, true);
  }
});

test('Button exposes Continue and Choice authoring with separate phases and decision visibility', () => {
  const content = nodes.find(node => node.attrs.id === 'stagecraft-clip-button-content')!;
  const animation = nodes.find(node => node.attrs.id === 'stagecraft-clip-button-animation')!;
  const timing = nodes.find(node => node.attrs.id === 'stagecraft-clip-button-timing')!;
  for (const name of ['button-label', 'button-action', 'button-shape', 'button-background', 'button-texture', 'button-font-size', 'button-color',
    'button-blend-mode', 'button-opacity', 'button-x', 'button-y', 'button-width', 'button-height']) {
    assert.ok(nodes.some(node => node.attrs.name === name && nearest(node, 'data-stagecraft-clip-section-page') === content), name);
  }
  const actions = nodes.find(node => node.attrs.name === 'button-action')!;
  assert.deepEqual(actions.children.map(option => option.attrs.value), ['continue', 'choice']);
  const group = nodes.find(node => node.attrs.name === 'button-decision-group')!;
  assert.equal(group.tag, 'select', 'existing question groups are selected from a friendly list');
  assert.equal(nodes.find(node => node.attrs.name === 'button-decision-name')!.attrs.maxlength, '200');
  const message = nodes.find(node => node.attrs.name === 'button-message')!;
  assert.equal(message.tag, 'textarea'); assert.equal(message.attrs.maxlength, '10000');
  assert.equal(nodes.find(node => node.attrs.name === 'button-height')!.attrs['aria-label'], '__STAGECRAFT.Editor.BoxHeight__', 'button geometry uses the size field label');
  assert.deepEqual(nodes.find(node => node.attrs.name === 'button-visibility')!.children.map(option => option.attrs.value), ['gm', 'public']);
  assert.equal(nodes.some(node => node.attrs.name === 'button-option-id'), false, 'option identity stays internal');
  for (const phase of ['entrance', 'exit']) {
    const preset = nodes.find(node => node.attrs.name === `button-${phase}-preset`)!;
    assert.equal(nearest(preset, 'data-stagecraft-clip-section-page'), animation);
    assert.deepEqual(preset.children.map(option => option.attrs.value), ['none', 'fade', 'slide', 'fade-slide', 'zoom', 'fade-zoom']);
  }
  assert.ok(nodes.some(node => node.attrs.name === 'button-start' && nearest(node, 'data-stagecraft-clip-section-page') === timing));
  assert.ok(nodes.some(node => node.attrs.name === 'button-duration-mode' && nearest(node, 'data-stagecraft-clip-section-page') === timing));
});

test('Content exposes title editing first and Outline/Shadow/Glow directly with inline enable controls', () => {
  const content = nodes.find(node => node.attrs.id === 'stagecraft-clip-text-content')!;
  const fields = nodes.filter(node => node.attrs.name && nearest(node, 'data-stagecraft-clip-section-page') === content);
  assert.deepEqual(fields.slice(0, 13).map(node => node.attrs.name), [
    'title-text', 'title-font', 'title-color', 'title-size', 'title-align', 'title-x', 'title-y',
    'title-width', 'title-height', 'title-shrink', 'title-minimum-size', 'text-blend-mode', 'text-opacity'
  ]);
  assert.equal(nearest(fields[0]!, 'open'), null, 'text is outside a collapsed group');
  for (const type of ['text', 'image', 'solid']) {
    const page = nodes.find(node => node.attrs.id === `stagecraft-clip-${type}-content`)!;
    const effects = page.children.filter(node => node.attrs.class === 'stagecraft-effect-fields');
    assert.equal(effects.length, 3, type);
    for (const effect of effects) {
      const summary = effect.children[0]!;
      assert.equal(summary.tag, 'summary');
      const enable = summary.children.find(node => 'data-stagecraft-effect-toggle' in node.attrs)!;
      assert.ok(enable, 'enable belongs beside the section header');
      assert.ok(enable.children.some(node => node.tag === 'input' && node.attrs.type === 'checkbox'));
    }
  }
});

test('Animation/Timing categories preserve trim, loop, held duration, Break and shared track editing scopes', () => {
  for (const node of nodes.filter(node => node.attrs.name && nearest(node, 'data-stagecraft-element-panel'))) {
    const name = node.attrs.name!;
    const category = nearest(node, 'data-stagecraft-clip-section-page')?.attrs['data-stagecraft-clip-section-page'];
    const expected = name === 'solid-pattern-onBreak' || /-(entrance|exit)(-|$)/.test(name) ? 'animation'
      : /-(start|duration|duration-mode|clip-duration|in|out|loop|loop-indefinitely|on-break)$/.test(name) ? 'timing'
      : 'content';
    assert.equal(category, expected, name);
  }
  const track = nodes.find(node => node.attrs.name === 'clip-track')!;
  const trackPage = nearest(track, 'data-stagecraft-clip-section-page')!;
  assert.ok('data-stagecraft-clip-section-shared' in trackPage.attrs);
  assert.equal(trackPage.attrs['data-stagecraft-clip-section-page'], 'timing');
  assert.equal(nearest(trackPage, 'data-stagecraft-element-panel'), null);
  const breakField = nodes.find(node => node.attrs.name === 'break-position')!;
  assert.equal(nearest(breakField, 'data-stagecraft-clip-section-page')?.attrs['data-stagecraft-clip-section-page'], 'timing');
  assert.ok(nearest(breakField, 'data-stagecraft-break-panel'));
  const templateGroups = nodes.filter(node => 'data-stagecraft-template-save-group' in node.attrs);
  assert.equal(templateGroups.length, 1);
  assert.equal('open' in templateGroups[0]!.attrs, false);
  assert.equal(nearest(templateGroups[0]!, 'data-stagecraft-element-panel'), null, 'one shared template footer');
});

test('paired geometry and shadow offsets keep original numeric drag targets and full accessible field names', () => {
  for (const prefix of ['title', 'image', 'solid', 'video', 'image-crop', 'solid-crop', 'shadow-offset', 'image-shadow-offset', 'solid-shadow-offset',
    'image-mask-0', 'image-mask-1', 'image-mask-2', 'image-mask-3', 'solid-mask-0', 'solid-mask-1', 'solid-mask-2', 'solid-mask-3']) {
    const first = nodes.find(node => node.attrs.name === `${prefix}-x`)!;
    const second = nodes.find(node => node.attrs.name === `${prefix}-y`)!;
    assert.ok(first && second, prefix);
    const row = first.parent?.parent?.parent;
    assert.equal(row?.attrs.class, 'stagecraft-coordinate-row', prefix);
    assert.equal(second.parent?.parent?.parent, row, prefix);
    assert.equal(first.attrs.type, 'number'); assert.ok(first.attrs['aria-label']);
    assert.equal(second.attrs.type, 'number'); assert.ok(second.attrs['aria-label']);
    assert.equal(first.parent?.tag, 'label'); assert.equal(second.parent?.tag, 'label');
  }
});

test('new labels exist in both languages and inspector density is independent of whole-editor row flipping', async () => {
  for (const language of ['de', 'en']) {
    const labels = JSON.parse(await readFile(`lang/${language}.json`, 'utf8')) as Record<string, string>;
    for (const match of template.matchAll(/{{localize\s+["']([^"']+)["']}}/g)) assert.ok(labels[match[1]!], `${language}: ${match[1]}`);
  }
  const css = await readFile('styles/editor-elements.css', 'utf8');
  assert.match(css, /container:stagecraft-inspector \/ inline-size/);
  assert.match(css, /\.stagecraft-coordinate-inputs\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /@container\s*\(/, 'avoid whole-editor responsive field-column flips');
  assert.match(css, /height:26px/);
});
