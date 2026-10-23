import test from 'node:test';
import assert from 'node:assert/strict';
import { ANIMATED_PATTERN_PRESET_IDS, createAnimatedPattern as createCurrentPattern, type AnimatedPatternPresetId } from '../src/domain/animated-pattern.js';
import type { SolidClipV2 } from '../src/domain/sequence.js';
import { animatedPatternRenderer, MAX_ANIMATED_PATTERN_NODES, MAX_ANIMATED_PATTERN_PATH_COMMANDS } from '../src/rendering/animated-pattern-renderer.js';
import { solidRenderer } from '../src/rendering/solid-renderer.js';

// These assertions describe retained v1 artwork. New authored defaults have
// their own provider and standalone-parity coverage below in the v2 suite.
const createAnimatedPattern = (preset: AnimatedPatternPresetId = 'diagonal-flow') => ({ ...createCurrentPattern(preset), version: 1 as const });

class Node extends EventTarget {
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attrs = new Map<string, string>();
  readonly children: Node[] = [];
  parent: Node | null = null;
  removed = false;
  className = '';
  clientWidth = 1200; clientHeight = 600;
  complete = true; naturalWidth = 1200; naturalHeight = 600;
  decoding = ''; src = '';
  constructor(readonly tagName: string) { super(); }
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { this.removed = true; if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  removeAttribute(key: string) { this.attrs.delete(key); if (key === 'src') this.src = ''; }
  async decode() {}
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
// Paint IDs differ between renderer instances; compare their referenced roles.
const shape = (node: Node, prefix = node.getAttribute('id') ?? ''): unknown => [node.tagName, [...node.attrs].filter(([key]) => key !== 'id')
  .map(([key, value]) => [key, prefix ? value.replaceAll(`url(#${prefix}`, 'url(#pattern') : value]), node.children.map(child => shape(child, prefix))];
function documentFor(t: { after(fn: () => void): void }) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const images: Node[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag: string) { const node = new Node(tag); if (tag === 'img') images.push(node); return node; },
    createElementNS(_namespace: string, tag: string) { return new Node(tag); }
  } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else Reflect.deleteProperty(globalThis, 'document'); });
  return images;
}
const cast = (node: unknown) => node as Node;
const frame = { phase: 'playing' as const, positionMs: 100, opacity: 0.6, items: [] };
function clip(): SolidClipV2 {
  return { id: 'surface', trackId: 'visual', type: 'solid', typeVersion: 2, startMs: 0,
    duration: { kind: 'sequence-end' }, entrance: { preset: 'none', version: 1 }, exit: { preset: 'none', version: 1 },
    appearance: { blendMode: 'screen', opacity: 0.8 }, properties: {
      color: '#123456', pattern: createCurrentPattern('halftone'), fit: 'contain',
      box: { x: 100, y: 50, width: 600, height: 300 }, crop: { x: 0, y: 0, width: 1, height: 1 },
      mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.8, y: 0.5 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0.2, y: 0.5 }],
      outline: { enabled: true, color: '#ABCDEF', opacity: 0.7, width: 3 },
      glow: { enabled: true, color: '#FCEACA', opacity: 0.5, radius: 8 },
      shadow: { enabled: true, color: '#000000', opacity: 0.5, offsetX: 4, offsetY: 5, blur: 7 }
    } };
}

test('all vector structures are distinct, deterministic, moving and bounded independent of density/size', t => {
  documentFor(t);
  const signatures = new Set<string>();
  for (const preset of ANIMATED_PATTERN_PRESET_IDS) {
    const settings = createAnimatedPattern(preset);
    const renderer = animatedPatternRenderer('first', settings, 600, 300);
    const other = animatedPatternRenderer('second', settings, 600, 300);
    const node = cast(renderer.node), children = all(node);
    assert.ok(children.length <= MAX_ANIMATED_PATTERN_NODES, preset);
    assert.equal(node.tagName, 'pattern');
    assert.equal(node.getAttribute('patternUnits'), 'userSpaceOnUse');
    signatures.add(JSON.stringify(shape(node)));
    const original = shape(node);
    renderer.draw(1750); other.draw(1750);
    assert.notDeepEqual(shape(node), original, `${preset} must change with time`);
    assert.deepEqual(shape(node), shape(cast(other.node)), `${preset} must match another renderer`);
    renderer.draw(100); renderer.draw(1750);
    assert.deepEqual(shape(node), shape(cast(other.node)), `${preset} backward seek must reproduce exact state`);
    assert.deepEqual(all(node), children, `${preset} motion must reuse nodes`);
    for (const density of [0.2, 3]) {
      renderer.update({ ...settings, density, scale: density === 3 ? 0.25 : 4 }, 16000, 9000);
      renderer.draw(Number.MAX_SAFE_INTEGER);
      assert.equal(all(node).length, children.length);
      for (const child of all(node)) for (const value of child.attrs.values()) assert.doesNotMatch(value, /NaN|Infinity|undefined/);
    }
    renderer.update({ ...settings, seed: settings.seed + 1 }, 600, 300); renderer.draw(1750);
    assert.notDeepEqual(shape(node), shape(cast(other.node)), `${preset} seed must create a distinct variant`);
    renderer.dispose(); other.dispose();
    assert.equal(node.removed, true);
  }
  assert.equal(signatures.size, ANIMATED_PATTERN_PRESET_IDS.length);
});

test('palette, intensity, dimensions and timing reuse prepared nodes; preset changes replace only prepared artwork', t => {
  documentFor(t);
  const settings = createAnimatedPattern('diagonal-flow'), renderer = animatedPatternRenderer('reuse', settings, 600, 300);
  const node = cast(renderer.node), children = all(node), group = node.children[1]!;
  renderer.draw(2000);
  const colors = ['#112233', '#445566', '#778899'] as const;
  renderer.update({ ...settings, colors, intensity: 0.2, direction: 90, density: 3, scale: 2, speed: 4, reverse: true }, 800, 400);
  assert.deepEqual(all(node), children);
  assert.equal(node.children[0]!.getAttribute('fill'), colors[0]);
  assert.equal(group.getAttribute('opacity'), '0.2');
  assert.ok(group.children.every(child => colors.slice(1).includes(child.getAttribute('fill') as '#445566' | '#778899')));
  assert.equal(node.getAttribute('patternTransform'), null);
  assert.equal(node.getAttribute('width'), '800');
  assert.equal(node.getAttribute('height'), '400');
  assert.equal(node.getAttribute('viewBox'), '0 0 1200 600');
  assert.equal(group.getAttribute('transform'), 'translate(600 300) rotate(90)');
  const oldShapes = [...group.children];
  renderer.update(createAnimatedPattern('orbit-rings'), 800, 400);
  assert.equal(cast(renderer.node), node); assert.equal(node.children[1], group);
  assert.ok(oldShapes.every(child => child.removed));
  assert.equal(group.getAttribute('transform'), 'translate(600 300) rotate(0)', 'new preset owns its direction');
  assert.equal(group.children.filter(child => child.tagName === 'circle').length, 16);
  renderer.dispose();
});

test('all presets paint the whole box once with isotropic coordinates and only outer-box clipping', t => {
  documentFor(t);
  for (const preset of ANIMATED_PATTERN_PRESET_IDS) {
    const settings = createAnimatedPattern(preset), renderer = animatedPatternRenderer('field', settings, 1600, 400);
    const node = cast(renderer.node), prepared = all(node);
    for (const [width, height] of [[1600, 400], [400, 1600], [1200, 600]] as const) {
      for (const direction of [0, 33, 90, 147]) {
        renderer.update({ ...settings, direction, density: 3, scale: 0.25 }, width, height); renderer.draw(1700);
        assert.equal(node.getAttribute('width'), String(width), preset);
        assert.equal(node.getAttribute('height'), String(height), preset);
        assert.equal(node.getAttribute('x'), '0'); assert.equal(node.getAttribute('y'), '0');
        assert.equal(node.getAttribute('patternTransform'), null);
        const [, , fieldWidth, fieldHeight] = node.getAttribute('viewBox')!.split(' ').map(Number);
        assert.equal(fieldWidth! / fieldHeight!, width / height, `${preset}: circular motifs keep their aspect`);
        const backdrop = node.children[0]!;
        assert.equal(Number(backdrop.getAttribute('width')), fieldWidth);
        assert.equal(Number(backdrop.getAttribute('height')), fieldHeight);
        assert.deepEqual(all(node), prepared, `${preset}: aspect/direction/frequency reuse prepared nodes`);
        assert.equal(all(node).filter(child => child.tagName === 'pattern').length, 1);
        assert.ok(all(node).every(child => child.tagName !== 'clipPath' && child.tagName !== 'mask' && child.tagName !== 'filter'));
      }
    }
    renderer.dispose();
  }
});

test('flowing lines and ribbons extend through rotated field edges; radial motifs share the actual box centre', t => {
  documentFor(t);
  for (const preset of ['diagonal-flow', 'wave-ribbons', 'glitch-bands', 'neon-grid'] as const) {
    const renderer = animatedPatternRenderer('edge', { ...createAnimatedPattern(preset), direction: 45 }, 1600, 400);
    const node = cast(renderer.node), group = node.children[1]!;
    const extent = (2400 * Math.SQRT1_2 + 600 * Math.SQRT1_2) / 2;
    const coordinates = group.children.flatMap(child => (child.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []);
    assert.ok(coordinates.some(value => value < -extent), `${preset}: geometry crosses the first outer edge`);
    assert.ok(coordinates.some(value => value > extent), `${preset}: geometry crosses the opposite outer edge`);
    renderer.dispose();
  }
  for (const preset of ['radial-burst', 'orbit-rings', 'rotating-shards'] as const) {
    const renderer = animatedPatternRenderer('centre', createAnimatedPattern(preset), 1600, 400), node = cast(renderer.node);
    assert.equal(node.children[1]!.getAttribute('transform'), 'translate(1200 300) rotate(0)');
    assert.equal(node.getAttribute('width'), '1600'); assert.equal(node.getAttribute('height'), '400');
    renderer.dispose();
  }
});

test('speed zero freezes artwork, reverse reverses motion, invalid time remains finite and disposal stops updates', t => {
  documentFor(t);
  const settings = createAnimatedPattern('confetti'), renderer = animatedPatternRenderer('speed', { ...settings, speed: 0 }, 600, 300);
  const node = cast(renderer.node), frozen = shape(node);
  renderer.draw(5000); assert.deepEqual(shape(node), frozen);
  renderer.update(settings, 600, 300); renderer.draw(1000); const forward = shape(node);
  renderer.update({ ...settings, reverse: true }, 600, 300); renderer.draw(1000);
  assert.notDeepEqual(shape(node), forward);
  renderer.draw(Infinity);
  assert.ok(all(node).flatMap(child => [...child.attrs.values()]).every(value => !/NaN|Infinity/.test(value)));
  const before = shape(node); renderer.dispose(); renderer.draw(9000); renderer.update(settings, 800, 600);
  assert.deepEqual(shape(node), before);
});

test('actual path complexity stays bounded at the largest valid aspect ratios and rotations', t => {
  documentFor(t);
  for (const preset of ANIMATED_PATTERN_PRESET_IDS) {
    const settings = createAnimatedPattern(preset), renderer = animatedPatternRenderer('complexity', settings, 600, 300);
    const node = cast(renderer.node), prepared = all(node);
    for (const [width, height] of [[32768, 1], [1, 32768], [32768, 32768]] as const) {
      for (const direction of [0, 45, 90, 147]) {
        for (const [scale, density] of [[0.25, 3], [4, 0.2]] as const) {
          renderer.update({ ...settings, direction, scale, density }, width, height);
          for (const time of [0, 1700, 90000]) {
            renderer.draw(time);
            const paths = all(node).map(child => child.getAttribute('d') ?? '');
            const commands = paths.reduce((total, path) => total + (path.match(/[MmLlHhVvCcSsQqTtAaZz]/g)?.length ?? 0), 0);
            assert.ok(commands <= MAX_ANIMATED_PATTERN_PATH_COMMANDS,
              `${preset} ${width}x${height}, angle=${direction}, scale=${scale}: ${commands} SVG commands`);
            // Also bound serialization work, independently of SVG-node count.
            assert.ok(paths.join('').length < 250000, `${preset}: path serialization remains bounded`);
            assert.deepEqual(all(node), prepared, `${preset}: geometry limits preserve prepared nodes`);
            for (const value of all(node).flatMap(child => [...child.attrs.values()])) assert.doesNotMatch(value, /NaN|Infinity|undefined/);
          }
        }
      }
    }
    renderer.dispose();
  }
});

test('bounded scanline spacing spans both outer field edges at extreme rotated aspects', t => {
  documentFor(t);
  for (const [width, height] of [[32768, 1], [1, 32768]] as const) {
    for (const direction of [0, 45, 90]) {
      const renderer = animatedPatternRenderer('scans', { ...createAnimatedPattern('glitch-bands'), direction, scale: 0.25, density: 3 }, width, height);
      const node = cast(renderer.node), scan = node.children[1]!.children[0]!;
      const viewBox = node.getAttribute('viewBox')!.split(' ').map(Number), angle = direction * Math.PI / 180;
      const ex = (viewBox[2]! * Math.abs(Math.cos(angle)) + viewBox[3]! * Math.abs(Math.sin(angle))) / 2;
      const ey = (viewBox[2]! * Math.abs(Math.sin(angle)) + viewBox[3]! * Math.abs(Math.cos(angle))) / 2;
      for (const time of [0, 1750, 8000]) {
        renderer.draw(time);
        const lines = [...scan.getAttribute('d')!.matchAll(/M (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) H (-?\d+(?:\.\d+)?)/g)];
        assert.ok(lines.length <= 220);
        assert.ok(Number(lines[0]![2]) <= -ey, 'first scanline overscans the top edge');
        assert.ok(Number(lines.at(-1)![2]) >= ey, 'last scanline overscans the bottom edge');
        assert.ok(lines.every(line => Number(line[1]) < -ex && Number(line[3]) > ex), 'every scanline crosses the entire field');
      }
      renderer.dispose();
    }
  }
});

test('new trace and terrain families retain their own visual grammar and palette when animated or edited', t => {
  documentFor(t);
  for (const preset of ['circuit-traces', 'contour-lines', 'energy-trails'] as const) {
    const settings = createAnimatedPattern(preset), renderer = animatedPatternRenderer('new-family', settings, 1200, 600);
    const node = cast(renderer.node), prepared = all(node), group = node.children[1]!;
    const paths = group.children.map(child => child.getAttribute('d')!);
    assert.ok(paths.every(path => path.startsWith('M ')));
    if (preset === 'circuit-traces') {
      assert.ok(paths.some(path => /H .* L .* H /.test(path)), 'routed traces contain flat runs and diagonal bends');
      assert.ok(paths.some(path => /V .* A .* A /.test(path)), 'branches terminate in plated junction rings');
      assert.ok(group.children.some(child => child.getAttribute('pathLength') === '100'), 'normalized travelling pulses follow the traces');
    } else if (preset === 'contour-lines') {
      assert.ok(paths.every(path => path.includes(' C ') && path.endsWith(' Z')), 'terrain uses smooth closed contour loops');
      assert.equal(group.children.filter(child => child.getAttribute('pathLength')).length, 0);
    } else {
      assert.ok(paths.every(path => path.includes(' C ') && !path.includes(' Z')), 'energy remains open smooth strokes');
      assert.equal(group.children.filter(child => child.getAttribute('pathLength') === '100').length, 12);
      assert.ok(group.children.some(child => Number(child.getAttribute('stroke-width')) >= 10), 'broad low-opacity energy underlay');
    }
    renderer.draw(1700); const moving = shape(node);
    renderer.update({ ...settings, speed: 2 }, 1200, 600); renderer.draw(850);
    assert.deepEqual(shape(node), moving, `${preset}: speed multiplies the shared playback time`);
    renderer.update({ ...settings, reverse: true }, 1200, 600); renderer.draw(1700);
    assert.notDeepEqual(shape(node), moving, `${preset}: reversing the shared clock changes travel`);
    renderer.update(settings, 1200, 600); renderer.draw(1700);
    assert.deepEqual(shape(node), moving, `${preset}: restoring forward playback reproduces the frame`);
    renderer.update({ ...settings, speed: 0 }, 1200, 600); const frozen = shape(node);
    renderer.draw(9800); assert.deepEqual(shape(node), frozen, `${preset}: speed zero freezes all artwork`);
    const colors = ['#010203', '#102030', '#F0E0D0'] as const;
    renderer.update({ ...settings, colors, direction: 71, scale: 2, density: 0.2, intensity: 0.31 }, 400, 1600);
    assert.deepEqual(all(node), prepared, `${preset}: all edited parameters reuse the complete prepared tree`);
    assert.equal(group.getAttribute('opacity'), '0.31');
    assert.ok(group.children.every(child => colors.slice(1).includes(child.getAttribute('stroke') as '#102030' | '#F0E0D0')));
    assert.ok(group.children.some(child => child.getAttribute('stroke') === colors[2]), `${preset}: accent survives palette updates`);
    renderer.dispose();
  }
});

test('circuit pulses and energy charges travel in opposite directions when reversed', t => {
  documentFor(t);
  for (const preset of ['circuit-traces', 'energy-trails'] as const) {
    const settings = createAnimatedPattern(preset), renderer = animatedPatternRenderer('pulse-direction', settings, 1200, 600);
    const pulse = cast(renderer.node).children[1]!.children.find(child => child.getAttribute('pathLength') === '100')!;
    const offset = () => Number(pulse.getAttribute('stroke-dashoffset'));
    const difference = (next: number, previous: number) => ((next - previous + 150) % 100) - 50;
    renderer.draw(0); const origin = offset();
    renderer.draw(100); const forward = difference(offset(), origin);
    renderer.update({ ...settings, reverse: true }, 1200, 600); renderer.draw(100);
    const reverse = difference(offset(), origin);
    assert.ok(forward < 0 && reverse > 0, `${preset}: dash travel reverses along the same carrier`);
    assert.ok(Math.abs(forward + reverse) < 0.0002, `${preset}: forward and reverse travel equally far`);
    renderer.dispose();
  }
});

test('new full-field strokes and contour loops overscan the rotated box at extreme aspect ratios', t => {
  documentFor(t);
  for (const preset of ['circuit-traces', 'contour-lines', 'energy-trails'] as const) {
    for (const [width, height] of [[1600, 400], [32768, 1], [1, 32768]] as const) {
      for (const direction of [0, 45, 90, 147]) {
        for (const [scale, density] of [[0.25, 3], [4, 0.2]] as const) {
          const renderer = animatedPatternRenderer('new-coverage', { ...createAnimatedPattern(preset), direction, scale, density }, width, height);
          const node = cast(renderer.node), group = node.children[1]!;
          const viewBox = node.getAttribute('viewBox')!.split(' ').map(Number), angle = direction * Math.PI / 180;
          const ex = (viewBox[2]! * Math.abs(Math.cos(angle)) + viewBox[3]! * Math.abs(Math.sin(angle))) / 2;
          const ey = (viewBox[2]! * Math.abs(Math.sin(angle)) + viewBox[3]! * Math.abs(Math.cos(angle))) / 2;
          for (const time of [0, 1750, 90000]) {
            renderer.draw(time);
            const visible = group.children.filter(child => Number(child.getAttribute('opacity')) > 0);
            assert.ok(visible.length > 0);
            if (preset === 'contour-lines') {
              // Each C ends on a curve knot: inspect those points, rather than
              // control handles which can overstate actual shape coverage.
              const outer = visible.at(-1)!.getAttribute('d')!;
              const knots = [...outer.matchAll(/C -?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+ (-?[\d.]+) (-?[\d.]+)/g)];
              assert.ok(knots.some(knot => Number(knot[1]) < -ex));
              assert.ok(knots.some(knot => Number(knot[1]) > ex));
              assert.ok(knots.some(knot => Number(knot[2]) < -ey));
              assert.ok(knots.some(knot => Number(knot[2]) > ey));
            } else {
              const stride = 3, carriers = visible.filter((_child, index) => index % stride === 0);
              const starts = carriers.map(child => child.getAttribute('d')!.match(/^M (-?[\d.]+) (-?[\d.]+)/)!);
              assert.ok(starts.every(start => Number(start[1]) < -ex), `${preset}: all carriers overscan the left edge`);
              assert.ok(Number(starts[0]![2]) < -ey, `${preset}: first carrier overscans the top edge`);
              assert.ok(Number(starts.at(-1)![2]) > ey, `${preset}: last carrier overscans the bottom edge`);
              for (const carrier of carriers) {
                const path = carrier.getAttribute('d')!, end = path.match(/(-?[\d.]+)(?: (-?[\d.]+))?$/)!;
                assert.ok(Number(end[1]) > ex, `${preset}: every carrier overscans the right edge`);
              }
            }
          }
          renderer.dispose();
        }
      }
    }
  }
});

const MATERIAL_PRESETS = ['aurora', 'silk-flow', 'iridescent-field'] as const;

test('curtains, satin folds and spectral fields retain distinct broad material structures', t => {
  documentFor(t);
  for (const preset of MATERIAL_PRESETS) {
    const renderer = animatedPatternRenderer('material-structure', createAnimatedPattern(preset), 1200, 600);
    const node = cast(renderer.node), group = node.children[1]!, defs = node.children[2]!;
    const custom = defs.children.slice(2), paths = group.children.filter(child => child.tagName === 'path');
    assert.ok(custom.length > 0);
    assert.ok(all(node).every(child => !['filter', 'clipPath', 'mask', 'image', 'animate'].includes(child.tagName)));
    if (preset === 'aurora') {
      assert.equal(paths.length, 72);
      assert.equal(group.children.filter(child => child.tagName === 'ellipse').length, 1);
      assert.equal(custom.filter(child => child.tagName === 'linearGradient').length, 2);
      assert.ok(paths.every(path => (path.getAttribute('d')!.match(/ C /g)?.length ?? 0) === 24
        && path.getAttribute('d')!.endsWith(' Z') && !path.getAttribute('stroke')),
      'curtains are broad closed sheets with two curved edges, rather than open line carriers');
      assert.ok(custom.every(paint => paint.children.length === 4), 'palette blending runs across the feathered sheets');
      assert.ok(paths.filter((_path, index) => index % 24 === 0).every(path => Number(path.getAttribute('opacity')) < 1 / 255),
        'the outermost curved carrier contributes less than one alpha step');
    } else if (preset === 'silk-flow') {
      assert.equal(custom.length, 7);
      assert.ok(custom.every(paint => paint.tagName === 'linearGradient' && paint.children.length === 7));
      assert.equal(paths.filter(path => path.getAttribute('d')!.endsWith(' Z')).length, 7);
      const highlights = paths.filter(path => path.getAttribute('fill') === 'none');
      assert.equal(highlights.length, 7);
      assert.ok(highlights.every(path => Number(path.getAttribute('stroke-width')) < 4));
      assert.ok(custom.every(paint => paint.children[0]!.getAttribute('stop-color') === createAnimatedPattern(preset).colors[0]
        && Number(paint.children[3]!.getAttribute('stop-opacity')) > 0.9), 'fold gradients pair a dark side with a narrow luminous crest');
    } else {
      assert.equal(paths.length, 7);
      assert.ok(custom.every(paint => paint.tagName === 'radialGradient' && paint.children.length === 6));
      assert.ok(paths.every(path => (path.getAttribute('d')!.match(/ C /g)?.length ?? 0) === 8
        && path.getAttribute('d')!.endsWith(' Z') && !path.getAttribute('stroke')));
      assert.ok(paths.every(path => /translate\(.+\) scale\(.+\) rotate\(.+\)/.test(path.getAttribute('transform')!)));
      assert.ok(custom.every(paint => paint.children.at(-1)!.getAttribute('stop-opacity') === '0'), 'overlapping fields soften completely before their geometric edge');
    }
    renderer.dispose();
  }
});

test('material gradients follow the shared clock and retain every node through palette and parameter edits', t => {
  documentFor(t);
  for (const preset of MATERIAL_PRESETS) {
    const settings = createAnimatedPattern(preset), renderer = animatedPatternRenderer('material-edits', settings, 1200, 600);
    const node = cast(renderer.node), prepared = all(node), group = node.children[1]!;
    renderer.draw(2100); const forward = shape(node);
    renderer.update({ ...settings, speed: 3 }, 1200, 600); renderer.draw(700);
    assert.deepEqual(shape(node), forward, `${preset}: all geometry and paint movement consumes shared time`);
    renderer.update({ ...settings, reverse: true }, 1200, 600); renderer.draw(2100);
    assert.notDeepEqual(shape(node), forward);
    renderer.update(settings, 1200, 600); renderer.draw(0); renderer.draw(2100);
    assert.deepEqual(shape(node), forward);
    renderer.update({ ...settings, speed: 0 }, 1200, 600); const frozen = shape(node);
    renderer.draw(9000); assert.deepEqual(shape(node), frozen);
    renderer.update(settings, 1200, 600); renderer.draw(2100);
    renderer.update({ ...settings, scale: 4, density: 0.2 }, 1200, 600);
    assert.notDeepEqual(shape(node), forward, `${preset}: scale/density change the material`);
    const colors = ['#010203', '#A0B0C0', '#F1E2D3'] as const;
    renderer.update({ ...settings, colors, direction: 147, intensity: 0.37 }, 400, 1600);
    assert.deepEqual(all(node), prepared, `${preset}: palette, resize and parameters preserve gradients and stops`);
    assert.equal(group.getAttribute('opacity'), '0.37');
    assert.equal(group.getAttribute('transform'), 'translate(300 1200) rotate(147)');
    const stops = all(node).filter(child => child.tagName === 'stop');
    assert.ok(stops.every(stop => colors.includes(stop.getAttribute('stop-color') as typeof colors[number])));
    assert.ok(stops.some(stop => stop.getAttribute('stop-color') === colors[1]));
    assert.ok(stops.some(stop => stop.getAttribute('stop-color') === colors[2]));
    renderer.dispose();
  }
});

test('material definition lifecycle removes obsolete paint servers and keeps all references local', t => {
  documentFor(t);
  const renderer = animatedPatternRenderer('material-cleanup', createAnimatedPattern('aurora'), 1200, 600);
  const node = cast(renderer.node), defs = node.children[2]!, shared = [...defs.children];
  shared.splice(2);
  for (const preset of [...MATERIAL_PRESETS, 'wave-ribbons', ...MATERIAL_PRESETS, 'confetti', ...MATERIAL_PRESETS] as const) {
    for (const seed of [12, 87]) {
      const old = defs.children.slice(2), previous = node.children[1]!.children.slice();
      renderer.update({ ...createAnimatedPattern(preset), seed }, 400, 1600); renderer.draw(1750);
      assert.ok(old.every(child => child.removed && child.parent === null));
      assert.ok(previous.every(child => child.removed));
      assert.deepEqual(defs.children.slice(0, 2), shared);
      const tree = all(node), ids = new Set(tree.map(child => child.getAttribute('id')).filter(Boolean));
      assert.equal(ids.size, tree.filter(child => child.getAttribute('id')).length, 'paint IDs remain unique after rebuilds');
      for (const child of tree) for (const value of child.attrs.values()) {
        for (const reference of value.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.has(reference[1]!), `unresolved paint reference ${reference[1]}`);
      }
      assert.ok(tree.length <= MAX_ANIMATED_PATTERN_NODES, 'the budget counts gradient definitions and every stop');
      if (preset === 'wave-ribbons' || preset === 'confetti') assert.equal(defs.children.length, 2);
    }
  }
  const remaining = defs.children.slice(2); renderer.dispose();
  assert.ok(remaining.every(child => child.removed && child.parent === null));
  assert.deepEqual(defs.children, shared);
});

test('spectral zero-alpha circles remain inside every moving Bézier carrier and contain their moving focus', t => {
  documentFor(t);
  for (const seed of [0, 1, 87, 0x5eed2026, 0xffffffff]) {
    const settings = { ...createAnimatedPattern('iridescent-field'), seed };
    const renderer = animatedPatternRenderer('spectral-edge', settings, 1200, 600), node = cast(renderer.node);
    const carriers = node.children[1]!.children.filter(child => child.tagName === 'path');
    const paints = node.children[2]!.children.slice(2);
    for (const time of [0, 1700, 90000, Number.MAX_SAFE_INTEGER]) {
      renderer.draw(time);
      carriers.forEach((carrier, index) => {
        const paint = paints[index]!;
        assert.equal(paint.getAttribute('gradientUnits'), 'userSpaceOnUse');
        assert.equal(paint.getAttribute('cx'), '0'); assert.equal(paint.getAttribute('cy'), '0');
        assert.equal(paint.children.at(-1)!.getAttribute('offset'), '1');
        assert.equal(paint.children.at(-1)!.getAttribute('stop-opacity'), '0');
        const radius = Number(paint.getAttribute('r'));
        assert.ok(Math.hypot(Number(paint.getAttribute('fx')), Number(paint.getAttribute('fy'))) < radius - 0.5,
          'moving focus remains safely within the zero-alpha circle');
        const path = carrier.getAttribute('d')!, start = path.match(/^M (-?[\d.]+) (-?[\d.]+)/)!;
        let from = [Number(start[1]), Number(start[2])];
        const segments = [...path.matchAll(/C (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g)];
        assert.equal(segments.length, 8);
        segments.forEach((segment, k) => {
          const controls = [from, [Number(segment[1]), Number(segment[2])],
            [Number(segment[3]), Number(segment[4])], [Number(segment[5]), Number(segment[6])]];
          const normal = (k + 0.5) * Math.PI / 4;
          // A cubic lies inside its control hull. Separating the entire hull
          // from the circle proves that the continuous curve cannot clip it;
          // inspecting only knots or the final gradient stop would miss this.
          const clearance = Math.min(...controls.map(([x, y]) => x! * Math.cos(normal) + y! * Math.sin(normal)));
          assert.ok(clearance > radius + 0.06, `seed=${seed}, time=${time}, field=${index}, segment=${k}: ${clearance}`);
          from = controls[3]!;
        });
      });
    }
    renderer.dispose();
  }
});

test('Aurora feather layers follow and soften both curved edges throughout motion', t => {
  documentFor(t);
  for (const seed of [0, 87, 0xffffffff]) {
    const settings = { ...createAnimatedPattern('aurora'), seed };
    const renderer = animatedPatternRenderer('curtain-edge', settings, 1200, 600), node = cast(renderer.node);
    const curtains = node.children[1]!.children.filter(child => child.tagName === 'path');
    for (const [scale, density] of [[1, 1], [0.25, 3], [4, 0.2]] as const) {
      renderer.update({ ...settings, scale, density }, 1200, 600);
      for (const time of [0, 1700, 90000, Number.MAX_SAFE_INTEGER]) {
        renderer.draw(time);
        for (let curtain = 0; curtain < 3; curtain++) {
          const layers = curtains.slice(curtain * 24, (curtain + 1) * 24);
          assert.ok(Number(layers[0]!.getAttribute('opacity')) < 1 / 255,
            'outermost boundary contributes less than one 8-bit alpha step even at maximum intensity');
          let previous: number[][] | undefined;
          for (const layer of layers) {
            assert.ok(Number(layer.getAttribute('opacity')) <= 0.054, 'feather steps bound individual edge contrast');
            const controls = [...layer.getAttribute('d')!.matchAll(/C (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g)]
              .map(segment => [Number(segment[2]), Number(segment[4]), Number(segment[6])]);
            if (previous) controls.forEach((ys, k) => ys.forEach((y, j) => {
              assert.ok(k < 12 ? y > previous![k]![j]! : y < previous![k]![j]!,
                'each continuous inner edge lies inside the previous feather layer along every cubic control hull');
            }));
            previous = controls;
          }
        }
      }
    }
    renderer.dispose();
  }
});

test('material fields overscan rotated extreme boxes with bounded complete SVG trees and path work', t => {
  documentFor(t);
  for (const preset of MATERIAL_PRESETS) {
    let maxNodes = 0, maxCommands = 0;
    for (const [width, height] of [[1200, 600], [32768, 1], [1, 32768]] as const) {
      for (const direction of [0, 45, 90, 147]) {
        for (const [scale, density] of [[1, 1], [0.25, 3], [4, 0.2]] as const) {
          const renderer = animatedPatternRenderer('material-extreme', { ...createAnimatedPattern(preset), direction, scale, density }, width, height);
          const node = cast(renderer.node), prepared = all(node), group = node.children[1]!;
          const viewBox = node.getAttribute('viewBox')!.split(' ').map(Number), angle = direction * Math.PI / 180;
          const ex = (viewBox[2]! * Math.abs(Math.cos(angle)) + viewBox[3]! * Math.abs(Math.sin(angle))) / 2;
          const ey = (viewBox[2]! * Math.abs(Math.sin(angle)) + viewBox[3]! * Math.abs(Math.cos(angle))) / 2;
          for (const time of [0, 1750, 90000, Number.MAX_SAFE_INTEGER]) {
            renderer.draw(time);
            const tree = all(node), paths = tree.map(child => child.getAttribute('d') ?? '');
            maxNodes = Math.max(maxNodes, tree.length);
            maxCommands = Math.max(maxCommands, paths.reduce((n, path) => n + (path.match(/[MmLlHhVvCcSsQqTtAaZz]/g)?.length ?? 0), 0));
            assert.deepEqual(tree, prepared);
            assert.ok(tree.every(child => [...child.attrs.values()].every(value => !/NaN|Infinity|undefined/.test(value))));
            assert.ok(paths.join('').length < 250000);
            if (preset === 'aurora') {
              for (const curtain of group.children.filter(child => child.tagName === 'path')) {
                const start = curtain.getAttribute('d')!.match(/^M (-?[\d.]+) (-?[\d.]+)/)!;
                assert.ok(Number(start[1]) < -ex);
                const turn = curtain.getAttribute('d')!.match(/ L (-?[\d.]+) (-?[\d.]+)/)!;
                assert.ok(Number(turn[1]) > ex, 'every soft curtain crosses the entire rotated box');
              }
              const glow = group.children[0]!;
              assert.ok(Number(glow.getAttribute('rx')) > ex && Number(glow.getAttribute('ry')) > ey);
            } else {
              const underlay = group.children[0]!;
              assert.ok(Number(underlay.getAttribute('x')) < -ex && Number(underlay.getAttribute('y')) < -ey);
              assert.ok(Number(underlay.getAttribute('x')) + Number(underlay.getAttribute('width')) > ex);
              assert.ok(Number(underlay.getAttribute('y')) + Number(underlay.getAttribute('height')) > ey);
              if (preset === 'silk-flow') {
                const visible = group.children.filter(child => child.tagName === 'path' && child.getAttribute('fill') !== 'none' && Number(child.getAttribute('opacity')) > 0);
                const left = visible[0]!.getAttribute('d')!.match(/^M (-?[\d.]+) (-?[\d.]+)/)!;
                const right = visible.at(-1)!.getAttribute('d')!.match(/ L (-?[\d.]+) (-?[\d.]+)/)!;
                assert.ok(Number(left[1]) < -ex && Number(right[1]) > ex);
                assert.ok(Number(left[2]) < -ey && Number(right[2]) > ey);
              }
            }
          }
          renderer.dispose();
        }
      }
    }
    assert.ok(maxNodes <= MAX_ANIMATED_PATTERN_NODES);
    assert.ok(maxCommands <= MAX_ANIMATED_PATTERN_PATH_COMMANDS);
    t.diagnostic(`${preset}: ${maxNodes} total SVG nodes including definitions/stops, ${maxCommands} path commands`);
  }
});

test('solid integration keeps polygon, luminance alphaMap, effects and global opacity ownership', async t => {
  const images = documentFor(t);
  const source = clip(), authored: SolidClipV2 = { ...source, properties: { ...source.properties,
    alphaMap: { kind: 'foundry-file', path: 'worlds/test/mask.png' } } };
  const renderer = solidRenderer(authored, new Node('root') as unknown as HTMLElement, { width: 1200, height: 600 },
    { signal: new AbortController().signal });
  await renderer.prepare();
  const node = cast(renderer.node), elements = all(node), pattern = elements.find(child => child.tagName === 'pattern')!;
  const paths = elements.filter(child => child.tagName === 'path'), fill = paths.find(child => child.getAttribute('fill-rule') === 'evenodd')!;
  const outline = paths.find(child => child.getAttribute('stroke-linejoin') === 'round')!;
  assert.equal(images.length, 1);
  assert.equal(fill.getAttribute('d'), 'M 0 0 L 600 0 L 480 150 L 600 300 L 0 300 L 120 150 Z');
  assert.equal(outline.getAttribute('d'), fill.getAttribute('d'));
  assert.equal(outline.getAttribute('mask'), null);
  assert.match(fill.getAttribute('fill')!, /^url\(#stagecraft-solid-\d+-pattern\)$/);
  assert.match(fill.getAttribute('mask')!, /^url\(#stagecraft-solid-\d+-alpha\)$/);
  assert.equal(elements.find(child => child.tagName === 'mask')!.getAttribute('mask-type'), 'luminance');
  assert.equal(elements.find(child => child.tagName === 'mask')!.getAttribute('color-interpolation'), 'sRGB');
  assert.equal(elements.find(child => child.tagName === 'image')!.getAttribute('href'), 'worlds/test/mask.png');
  assert.ok(elements.some(child => child.tagName === 'feGaussianBlur' && child.getAttribute('in') === 'SourceAlpha'));
  const preparedNodes = all(pattern);
  renderer.draw({ clip: authored, opacity: 0.5, localTimeMs: 500, patternTimeMs: 1750 }, frame);
  const expected = animatedPatternRenderer('reference', authored.properties.pattern!, 600, 300); expected.draw(1750);
  assert.deepEqual(shape(pattern), shape(cast(expected.node)), 'draw consumes evaluated pattern clock');
  assert.equal(node.style.opacity, '0.4'); assert.equal(node.style.mixBlendMode, 'screen');
  assert.deepEqual(all(pattern), preparedNodes);
  const footprint = renderer.backdropFootprints!({ clip: authored, opacity: 1, localTimeMs: 0 }, { width: 1200, height: 600 })[0]!;
  assert.equal(footprint.points.length, 6);
  const larger: SolidClipV2 = { ...authored, properties: { ...authored.properties, box: { ...authored.properties.box, width: 800 } } };
  renderer.updateAppearance!(larger);
  assert.deepEqual(all(pattern), preparedNodes);
  assert.match(fill.getAttribute('d')!, /L 800 0/);
  const { pattern: _pattern, ...plain } = larger.properties;
  renderer.updateAppearance!({ ...larger, properties: plain });
  assert.equal(pattern.removed, true); assert.equal(fill.getAttribute('fill'), authored.properties.color);
  assert.ok(fill.getAttribute('mask'));
  renderer.dispose(); expected.dispose();
  assert.equal(node.removed, true); assert.equal(images[0]!.src, '');
});

test('resize changes composition projection without rebuilding artwork; abort disconnects and removes pattern', async t => {
  documentFor(t);
  const before = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  let callback: ResizeObserverCallback | undefined, disconnected = false;
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(next: ResizeObserverCallback) { callback = next; }
    observe() {}
    disconnect() { disconnected = true; }
  } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'ResizeObserver', before); else Reflect.deleteProperty(globalThis, 'ResizeObserver'); });
  const root = new Node('root'), controller = new AbortController(), authored = clip();
  const renderer = solidRenderer(authored, root as unknown as HTMLElement, { width: 1200, height: 600 }, { signal: controller.signal });
  await renderer.prepare();
  const node = cast(renderer.node), stage = node.children[0]!, pattern = all(node).find(child => child.tagName === 'pattern')!, prepared = all(pattern);
  assert.equal(stage.style.transform, 'scale(1)');
  callback!([{ target: root, contentRect: { width: 600, height: 600 } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  assert.equal(stage.style.transform, 'scale(0.5)'); assert.equal(stage.style.top, '150px');
  assert.deepEqual(all(pattern), prepared);
  controller.abort(); assert.equal(disconnected, true); assert.equal(pattern.removed, true); assert.equal(node.removed, true);
  renderer.draw({ clip: authored, opacity: 1, localTimeMs: 2000 }, frame);
  await assert.rejects(solidRenderer(authored, root as unknown as HTMLElement, { width: 1200, height: 600 }, { signal: controller.signal }).prepare(), { name: 'AbortError' });
});
