import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnimatedPattern, type AnimatedPattern } from '../src/domain/animated-pattern.js';
import { animatedPatternRenderer, MAX_ANIMATED_PATTERN_NODES, MAX_ANIMATED_PATTERN_PATH_COMMANDS } from '../src/rendering/animated-pattern-renderer.js';
// Frozen standalone designs keep the visual parity oracle independent of providers.
import { halftoneDesign } from './fixtures/approved-patterns/halftone.js';
import { energyDesign } from './fixtures/approved-patterns/energy.js';
import { defaults } from './fixtures/approved-patterns/contracts.js';

class Node {
  readonly attrs = new Map<string, string>();
  readonly children: Node[] = [];
  parent: Node | null = null;
  constructor(readonly tagName: string) {}
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  removeAttribute(key: string) { this.attrs.delete(key); }
}
const cast = (value: unknown) => value as Node;
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const shape = (node: Node): unknown => [node.tagName,
  [...node.attrs].filter(([key, value]) => !(node.tagName === 'g' && key === 'opacity' && value === '1')), node.children.map(shape)];
function documentFor(t: { after(fn: () => void): void }) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElementNS(_namespace: string, tag: string) { return new Node(tag); }
  } });
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else Reflect.deleteProperty(globalThis, 'document'); });
}
const designs = [halftoneDesign, energyDesign] as const;

test('v2 providers reproduce the approved standalone geometry, palette, direction and absolute clock', t => {
  documentFor(t);
  for (const design of designs) {
    const initial = createAnimatedPattern(design.id);
    assert.equal(initial.version, 2);
    for (const [width, height] of [[1200, 600], [400, 1600]] as const) {
      for (const direction of [0, 45, 147]) {
        const settings = { ...initial, direction, colors: design.colors };
        const renderer = animatedPatternRenderer('parity', settings, width, height);
        const reference = design.create('parity', { ...defaults(design), direction }, width, height);
        for (const time of [0, 1750, 90000, Number.MAX_SAFE_INTEGER]) {
          renderer.draw(time); reference.draw(time);
          assert.deepEqual(shape(cast(renderer.node).children[0]!), shape(cast(reference.node)), `${design.id}, ${width}x${height}, direction ${direction}, t=${time}`);
        }
        renderer.dispose(); reference.dispose();
      }
    }
  }
});

test('every exposed numeric control changes prepared artwork without allocating nodes', t => {
  documentFor(t);
  for (const design of designs) {
    const settings = createAnimatedPattern(design.id);
    assert.equal(settings.version, 2);
    if (settings.version !== 2) throw new Error('Expected version 2');
    const renderer = animatedPatternRenderer('controls', settings, 1200, 600), node = cast(renderer.node), nodes = all(node);
    renderer.draw(1750);
    const original = shape(node);
    for (const control of design.controls) {
      renderer.update({ ...settings, parameters: { ...settings.parameters, [control.key]: control.min } }, 1200, 600);
      assert.notDeepEqual(shape(node), original, `${design.id}.${control.key}`);
      assert.deepEqual(all(node), nodes);
      renderer.update(settings, 1200, 600);
      assert.deepEqual(shape(node), original);
    }
    renderer.dispose();
  }
});

test('v2 artwork obeys shared speed, reverse, invalid time, seed, resize, palette and disposal', t => {
  documentFor(t);
  for (const design of designs) {
    const settings = createAnimatedPattern(design.id), renderer = animatedPatternRenderer('edits', settings, 1200, 600);
    const node = cast(renderer.node), nodes = all(node);
    renderer.draw(2100); const forward = shape(node);
    renderer.update({ ...settings, speed: 3 }, 1200, 600); renderer.draw(700);
    assert.deepEqual(shape(node), forward);
    renderer.update({ ...settings, reverse: true }, 1200, 600); renderer.draw(2100);
    assert.notDeepEqual(shape(node), forward);
    renderer.update({ ...settings, speed: 0 }, 1200, 600); const stopped = shape(node);
    renderer.draw(9000); assert.deepEqual(shape(node), stopped);
    renderer.update(settings, 1200, 600); renderer.draw(2100); assert.deepEqual(shape(node), forward);
    renderer.draw(10); renderer.draw(2100); assert.deepEqual(shape(node), forward);
    renderer.update({ ...settings, seed: settings.seed + 1 }, 1200, 600); assert.notDeepEqual(shape(node), forward);
    renderer.update({ ...settings, colors: ['#010203', '#102030', '#A0B0C0'], direction: 147, intensity: 0.3 }, 400, 1600);
    assert.deepEqual(all(node), nodes);
    assert.ok(all(node).some(child => child.getAttribute('fill') === '#010203'));
    assert.ok(all(node).some(child => child.getAttribute('opacity') === '0.3'));
    for (const time of [Infinity, NaN, -2000]) {
      renderer.draw(time);
      assert.ok(all(node).every(child => [...child.attrs.values()].every(value => !/NaN|Infinity|undefined/.test(value))));
    }
    renderer.dispose(); const before = shape(node); renderer.draw(100); renderer.update(settings, 2, 2);
    assert.deepEqual(shape(node), before, 'disposed providers stop every mutation');
  }
});

test('switching versions and presets retains the paint server and removes obsolete local definitions', t => {
  documentFor(t);
  const renderer = animatedPatternRenderer('lifecycle', createAnimatedPattern('aurora'), 1200, 600);
  const node = cast(renderer.node), parent = new Node('defs'); parent.append(node);
  const recipes: AnimatedPattern[] = [
    createAnimatedPattern('halftone'), createAnimatedPattern('energy-trails'),
    { ...createAnimatedPattern('halftone'), version: 1 }, createAnimatedPattern('energy-trails'),
    createAnimatedPattern('iridescent-field'), createAnimatedPattern('halftone'),
  ];
  for (const recipe of recipes) {
    const oldDefinitions = all(node).filter(child => child.getAttribute('id') && child !== node);
    renderer.update(recipe, 400, 1600); renderer.draw(1750);
    assert.equal(renderer.node as unknown, node); assert.equal(node.parent, parent);
    const tree = all(node), ids = tree.map(child => child.getAttribute('id')).filter(Boolean);
    assert.ok(oldDefinitions.every(child => !tree.includes(child)));
    assert.equal(new Set(ids).size, ids.length);
    for (const child of tree) for (const value of child.attrs.values()) {
      for (const reference of value.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(reference[1]!));
    }
  }
  renderer.dispose(); assert.equal(node.parent, null);
});

test('v2 complete SVG trees and path work stay bounded across control extremes and rotated extreme boxes', t => {
  documentFor(t);
  for (const design of designs) {
    const settings = createAnimatedPattern(design.id);
    if (settings.version !== 2) throw new Error('Expected v2');
    let maxNodes = 0, maxCommands = 0;
    const renderer = animatedPatternRenderer('bounds', settings, 1200, 600), node = cast(renderer.node), nodes = all(node);
    for (const [width, height] of [[32768, 1], [1, 32768], [32768, 32768], [1200, 600]] as const) {
      for (const direction of [0, 45, 90, 147]) for (const limit of ['min', 'max'] as const) {
        const parameters = Object.fromEntries(design.controls.map(control => [control.key, control[limit]]));
        renderer.update({ ...settings, direction, parameters }, width, height);
        for (const time of [0, 1750, 90000, Number.MAX_SAFE_INTEGER]) {
          renderer.draw(time);
          const tree = all(node), paths = tree.map(child => child.getAttribute('d') ?? '');
          const commands = paths.reduce((count, path) => count + (path.match(/[MmLlHhVvCcSsQqTtAaZz]/g)?.length ?? 0), 0);
          maxNodes = Math.max(maxNodes, tree.length); maxCommands = Math.max(maxCommands, commands);
          assert.deepEqual(tree, nodes);
          assert.ok(tree.length <= MAX_ANIMATED_PATTERN_NODES); assert.ok(commands <= MAX_ANIMATED_PATTERN_PATH_COMMANDS);
          assert.ok(paths.join('').length < 250000);
          assert.ok(tree.every(child => [...child.attrs.values()].every(value => !/NaN|Infinity|undefined/.test(value))));
        }
      }
    }
    t.diagnostic(`${design.id}: ${maxNodes} nodes including paint server, ${maxCommands} path commands`);
    renderer.dispose();
  }
});
