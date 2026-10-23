import test from 'node:test';
import assert from 'node:assert/strict';
import type { BarsClip } from '../src/domain/sequence.js';
import { createBarsSequence } from '../src/domain/validation.js';
import { barsRenderer } from '../src/rendering/bars-renderer.js';

class FakeElement {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  append(node: FakeElement) { node.remove(); this.children.push(node); node.parent = this; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
}

test('bars reveal opposes each bar direction and deterministically resets across scrubs', t => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new FakeElement() }
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  let id = 0;
  const clip: BarsClip = { ...createBarsSequence('Bars', () => `bars_${++id}`).clips[0]! as BarsClip,
    appearance: { blendMode: 'screen' as const, opacity: 0.5 } };
  const parent = new FakeElement();
  const renderer = barsRenderer(clip, parent as unknown as HTMLElement);
  const layer = renderer.node as unknown as FakeElement;
  const [top, bottom] = layer.children as [FakeElement, FakeElement];
  const draw = (barsReveal?: number, opacity = 0.8) => renderer.draw(
    { clip, opacity, localTimeMs: 0, ...(barsReveal === undefined ? {} : { barsReveal }) },
    { phase: 'playing', positionMs: 0, opacity: 1, items: [] }
  );

  draw(0);
  assert.equal(top.style.transform, 'translateY(-100%)');
  assert.equal(bottom.style.transform, 'translateY(100%)');
  assert.equal(layer.style.opacity, '0.4');
  assert.equal(layer.style.mixBlendMode, 'screen');

  draw(0.5, 0.6);
  assert.equal(top.style.transform, 'translateY(-50%)');
  assert.equal(bottom.style.transform, 'translateY(50%)');
  assert.equal(layer.style.opacity, '0.3', 'appearance opacity is still composited independently of motion');
  assert.equal(top.style.opacity, undefined);
  assert.equal(bottom.style.opacity, undefined);

  draw(0.25);
  assert.equal(top.style.transform, 'translateY(-75%)', 'backward seeks recompute from the requested frame');
  assert.equal(bottom.style.transform, 'translateY(75%)');

  draw();
  assert.equal(top.style.transform, '');
  assert.equal(bottom.style.transform, '');
  assert.equal(layer.style.opacity, '0.4', 'legacy items keep the prior fully visible bar position');

  renderer.draw(undefined, { phase: 'playing', positionMs: 0, opacity: 1, items: [] });
  assert.equal(layer.style.opacity, '0');
  assert.equal(top.style.transform, '');
  assert.equal(bottom.style.transform, '');
  const resized: BarsClip = { ...clip, properties: { heightFraction: .25, color: '#ffffff' } };
  renderer.draw({ clip: resized, opacity: 1, localTimeMs: 0 }, { phase: 'playing', positionMs: 0, opacity: 1, items: [] });
  assert.equal(layer.children[0], top, 'live numeric edits retain both prepared bars');
  assert.equal(top.style.height, '25%');
  assert.equal(bottom.style.height, '25%');
  assert.equal(top.style.backgroundColor, '#ffffff');
  renderer.dispose();
  assert.equal(parent.children.length, 0);
  renderer.dispose();
  assert.equal(parent.children.length, 0, 'disposal remains safe when repeated');
});
