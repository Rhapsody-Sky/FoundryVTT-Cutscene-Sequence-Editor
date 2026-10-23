import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { TextClip, Transition } from '../src/domain/sequence.js';
import { TEXT_MOTION_PRESETS, evaluateTextMotion } from '../src/domain/text-motion.js';
import { createTextMotionRenderer, textMotionSegmentCount, textNoiseMask } from '../src/rendering/text-motion-renderer.js';
import type { TextMotionLayout } from '../src/rendering/text-motion-renderer.js';
import { textRenderer } from '../src/rendering/text-renderer.js';

class Node {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Node[] = []; parent: Node | undefined;
  className = ''; value = ''; isConnected = true;
  clientWidth = 600; clientHeight = 200; scrollWidth = 600; scrollHeight = 200;
  static reads = 0;
  set textContent(value: string) { this.value = value; for (const child of this.children) child.parent = undefined; this.children = []; }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join(''); }
  append(child: Node) { child.remove(); this.children.push(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  getBoundingClientRect() {
    Node.reads++;
    const left = this.textContent === 'B' ? 10 : this.textContent === 'D' ? 40 : this.textContent === 'C' ? 30 : 0;
    return { top: /^[CD]/u.test(this.textContent) ? 20 : /^[EF]/u.test(this.textContent) ? 40 : 0, left, right: left + 10, width: 10, height: 20 };
  }
}
class Observer {
  static latest: Observer | undefined;
  constructor(readonly callback: () => void) { Observer.latest = this; }
  observe() {} disconnect() {}
}
function dom(t: TestContext) {
  for (const [name, value] of Object.entries({
    document: { createElement: () => new Node(), createTextNode: (value: string) => { const node = new Node(); node.textContent = value; return node; } },
    ResizeObserver: Observer
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  Node.reads = 0;
}
const element = (node: Node) => node as unknown as HTMLElement;
const units = (node: Node): Node[] => node.children.flatMap(child => [
  ...(child.className === 'stagecraft-text-motion-unit' ? [child] : []), ...units(child)
]);
function motion(phase: 'entrance' | 'exit', unit?: 'character' | 'word' | 'line'): Transition {
  const preset = TEXT_MOTION_PRESETS.find(value => value.phase === phase && (!unit || value.unit === unit));
  assert.ok(preset, `missing ${phase} ${unit ?? ''} descriptor`);
  return { preset: 'text-motion', version: 1, motion: preset.id, durationMs: 1000, easing: 'ease-out' };
}
function title(entrance = motion('entrance', 'character'), exit: Transition = { preset: 'none', version: 1 }, value = 'AB CD'): TextClip {
  return { id: 'segmented-title', type: 'text', typeVersion: 1, trackId: 'track', startMs: 0, duration: { kind: 'fixed', milliseconds: 3000 },
    entrance, exit, properties: { text: value, fontFamily: 'serif', fontSize: 80, minimumFontSize: 20,
      color: '#ffffff', align: 'center', box: { x: 0, y: 0, width: 600, height: 200 }, shrinkToFit: false } };
}

test('grapheme spans preserve source, word boundaries, stable DOM and seekable eased poses', t => {
  dom(t); const root = new Node(); const transition = motion('entrance', 'character');
  assert.equal(transition.preset, 'text-motion'); if (transition.preset !== 'text-motion') return;
  const clip = title(transition, undefined, 'A👩🏽‍🚀 e\u0301');
  const renderer = createTextMotionRenderer(element(root)); renderer.configure(clip); renderer.layout();
  const children = units(root); assert.equal(children.length, 3);
  assert.equal(root.textContent, clip.properties.text);
  assert.equal(root.attributes['aria-label'], clip.properties.text);
  assert.equal(children[0]!.parent!.style.width, 'max-content');
  renderer.draw({ entrance: { transition, progress: 0.25 } });
  const forward = children.map(child => ({ ...child.children[0]!.style }));
  const expected = evaluateTextMotion(transition.motion!, 0.25, 0, 3, undefined, undefined, transition.easing);
  assert.equal(children[0]!.children[0]!.style.opacity, String(expected.opacity));
  renderer.draw({ entrance: { transition, progress: 0.9 } });
  renderer.draw({ entrance: { transition, progress: 0.25 } });
  assert.deepEqual(children.map(child => ({ ...child.children[0]!.style })), forward);
  assert.deepEqual(units(root), children);
  assert.equal(Node.reads, 0, 'character animation never reads layout on frames');
  renderer.draw(undefined);
  assert.equal(children[0]!.children[0]!.style.transform, '');
  assert.equal(children[0]!.children[0]!.style.opacity, '');
  renderer.dispose(); assert.equal(root.textContent, clip.properties.text);
  assert.equal(root.attributes['aria-label'], undefined);
});

test('line motion measures actual wrapped rows once and respects explicit newlines', t => {
  dom(t); const root = new Node(); const transition = motion('entrance', 'line');
  const renderer = createTextMotionRenderer(element(root)); renderer.configure(title(transition, undefined, 'AB CD\nEF'));
  renderer.layout(); const children = units(root);
  assert.deepEqual(children.map(child => child.textContent), ['AB ', 'CD', 'EF']);
  assert.ok(Node.reads > 0); const reads = Node.reads;
  renderer.draw({ entrance: { transition, progress: 0.3 } });
  renderer.draw({ entrance: { transition, progress: 0.8 } });
  renderer.draw({ entrance: { transition, progress: 0.3 } });
  assert.equal(Node.reads, reads); assert.deepEqual(units(root), children);
  const pose = children[0]!.children[0]!.style.transform;
  renderer.prepareLayout(); renderer.layout();
  assert.ok(Node.reads > reads);
  assert.equal(units(root)[0]!.children[0]!.style.transform, pose, 'paused pose restored after resize/font layout');
});

test('word motion keeps whitespace and explicit line breaks outside atomic animated units', t => {
  dom(t); const root = new Node(); const transition = motion('entrance', 'word');
  const renderer = createTextMotionRenderer(element(root)); renderer.configure(title(transition, undefined, 'Hello,  world!\nAgain.'));
  renderer.layout();
  assert.equal(root.textContent, 'Hello,  world!\nAgain.');
  assert.deepEqual(units(root).map(part => part.textContent), ['Hello,', 'world!', 'Again.']);
  assert.deepEqual(root.children.filter(part => !part.className).map(part => part.textContent), ['  ', '\n']);
});

test('center collapse uses cached measured letter positions instead of a fixed small nudge', t => {
  dom(t); const root = new Node(); root.style.fontSize = '80px';
  const exit: Transition = { preset: 'text-motion', version: 1, motion: 'collapse-center', durationMs: 1000, easing: 'linear', stagger: 0 };
  const renderer = createTextMotionRenderer(element(root)); renderer.configure(title({ preset: 'none', version: 1 }, exit, 'AB'));
  renderer.layout(); const reads = Node.reads;
  renderer.draw({ exit: { transition: exit, progress: 0.5 } });
  const parts = units(root);
  assert.match(parts[0]!.children[0]!.style.transform!, /translate\(1\.875em/);
  assert.match(parts[1]!.children[0]!.style.transform!, /translate\(-1\.875em/);
  renderer.draw({ exit: { transition: exit, progress: 0.7 } });
  assert.equal(Node.reads, reads, 'geometry is cached for the entire phase');
});

test('spread starts outside the measured row while tracking starts inside it', t => {
  dom(t);
  for (const [motion, sign] of [['converge-spread', -1], ['tracking-expand', 1]] as const) {
    const root = new Node(); root.style.fontSize = '80px';
    const entrance: Transition = { preset: 'text-motion', version: 1, motion, durationMs: 1000, easing: 'linear', stagger: 0 };
    const renderer = createTextMotionRenderer(element(root)); renderer.configure(title(entrance, undefined, 'AB'));
    renderer.layout(); renderer.draw({ entrance: { transition: entrance, progress: 0.5 } });
    const values = units(root).map(part => Number(part.children[0]!.style.transform!.match(/translate\(([-.\d]+)em/)![1]));
    assert.equal(Math.sign(values[0]!), sign);
    assert.equal(Math.sign(values[1]!), -sign);
    renderer.dispose();
  }
});

test('different entrance and exit units switch once and exit ends hidden', t => {
  dom(t); const root = new Node(); const entrance = motion('entrance', 'character');
  const descriptor = TEXT_MOTION_PRESETS.find(value => value.phase === 'exit' && value.unit !== 'character');
  assert.ok(descriptor);
  const exit: Transition = { preset: 'text-motion', version: 1, motion: descriptor.id, durationMs: 1000, easing: 'linear' };
  const renderer = createTextMotionRenderer(element(root)); renderer.configure(title(entrance, exit)); renderer.layout();
  renderer.draw({ entrance: { transition: entrance, progress: 1 }, exit: { transition: exit, progress: 0 } });
  const before = units(root);
  renderer.draw({ entrance: { transition: entrance, progress: 1 }, exit: { transition: exit, progress: 0.3 } });
  const after = units(root); assert.notEqual(after[0], before[0]);
  renderer.draw({ exit: { transition: exit, progress: 1 } });
  assert.deepEqual(units(root), after);
  for (const child of after) assert.equal(child.children[0]!.style.opacity, '0');
  renderer.draw({ entrance: { transition: entrance, progress: 0.2 }, exit: { transition: exit, progress: 0 } });
  assert.equal(units(root).length, 4, 'backward seek restores entrance segmentation');
});

test('unfold hinges at the top and changing preset resets the origin', t => {
  dom(t); const root = new Node();
  const entrance: Transition = { preset: 'text-motion', version: 1, motion: 'vertical-unfold', durationMs: 1000, easing: 'linear' };
  const renderer = createTextMotionRenderer(element(root)); renderer.configure(title(entrance)); renderer.layout();
  renderer.draw({ entrance: { transition: entrance, progress: 0.4 } });
  assert.equal(units(root)[0]!.children[0]!.style.transformOrigin, 'center top');
  renderer.draw(undefined);
  assert.equal(units(root)[0]!.children[0]!.style.transformOrigin, 'center center');
});

test('opposite-phase presets reverse through the renderer including masks and segment order', t => {
  dom(t);
  for (const descriptor of TEXT_MOTION_PRESETS) {
    const native = descriptor.phase, opposite = native === 'entrance' ? 'exit' : 'entrance';
    const transition: Transition = { preset: 'text-motion', version: 1, motion: descriptor.id, durationMs: 1000, easing: 'back-out', stagger: 0.5 };
    const root = new Node(), renderer = createTextMotionRenderer(element(root));
    renderer.configure(title(transition, transition, 'AB CD'));
    renderer.layout();
    renderer.draw({ [native]: { transition, progress: 0.25 } });
    const expected = units(root).map(part => ({ outer: { ...part.style }, inner: { ...part.children[0]!.style } }));
    const reads = Node.reads;
    renderer.draw({ [opposite]: { transition, progress: 0.75 } });
    assert.deepEqual(units(root).map(part => ({ outer: { ...part.style }, inner: { ...part.children[0]!.style } })), expected, descriptor.id);
    assert.equal(Node.reads, reads, descriptor.id + ' must not read layout on phase reversal');
    renderer.dispose();
  }
});

test('directional unfold changes hinge and stretch axis and seeking resets masks', t => {
  dom(t); const root = new Node();
  const transition: Transition = { preset: 'text-motion', version: 1, motion: 'vertical-unfold', durationMs: 1000, easing: 'linear', motionDirection: 'left' };
  const renderer = createTextMotionRenderer(element(root)); renderer.configure(title(transition)); renderer.layout();
  renderer.draw({ entrance: { transition, progress: 0.3 } });
  assert.equal(units(root)[0]!.children[0]!.style.transformOrigin, 'left center');
  const transform = units(root)[0]!.children[0]!.style.transform!;
  assert.match(transform, /scale\([^,]+, 1\)/, 'horizontal unfolding leaves glyph height unchanged');
  const masked: Transition = { ...transition, motion: 'line-reveal' };
  renderer.draw({ entrance: { transition: masked, progress: 0.3 } });
  assert.match(units(root)[0]!.style.clipPath!, /^inset\(/);
  assert.notEqual(units(root)[0]!.style.clipPath, 'inset(0 0 70% 0)');
  renderer.draw(undefined);
  assert.equal(units(root)[0]!.style.clipPath, '');
});

test('unfold starts and finishes at the requested edge for either phase, while default keeps the existing top hinge', t => {
  dom(t);
  for (const [direction, hinge] of [['default', 'center top'], ['up', 'center top'], ['down', 'center bottom'], ['left', 'left center'], ['right', 'right center']] as const) {
    const root = new Node(), renderer = createTextMotionRenderer(element(root));
    const transition: Transition = { preset: 'text-motion', version: 1, motion: 'vertical-unfold', durationMs: 1000, easing: 'linear', motionDirection: direction };
    renderer.configure(title(transition, transition, 'AB')); renderer.layout();
    for (const phase of ['entrance', 'exit'] as const) {
      renderer.draw({ [phase]: { transition, progress: 0.5 } });
      assert.equal(units(root)[0]!.children[0]!.style.transformOrigin, hinge, phase + ' ' + direction);
    }
    renderer.dispose();
  }
});

test('sand dissolve uses deterministic transparent holes and clears the mask when inactive', t => {
  dom(t); const root = new Node(); const descriptor = TEXT_MOTION_PRESETS.find(value => /noise/i.test(value.id));
  assert.ok(descriptor);
  const transition: Transition = { preset: 'text-motion', version: 1, motion: descriptor.id, durationMs: 1000, easing: 'linear' };
  const renderer = createTextMotionRenderer(element(root)); renderer.configure(title(transition)); renderer.layout();
  renderer.draw({ exit: { transition, progress: 0.5 } });
  const part = units(root)[0]!; assert.match(part.style.maskImage!, /data:image\/svg\+xml/);
  const svg = decodeURIComponent(textNoiseMask(0.5));
  assert.match(svg, /<mask id="sand">/); assert.equal((svg.match(/<circle/g) ?? []).length, 36);
  assert.equal(textNoiseMask(0.5), textNoiseMask(0.5));
  assert.notEqual(textNoiseMask(0.2), textNoiseMask(0.8));
  renderer.draw(undefined); assert.equal(part.style.maskImage, ''); assert.equal(part.style.maskSize, '');
});

test('huge titles bound animation nodes while retaining the complete accessible source', t => {
  dom(t); const root = new Node(); const source = 'title '.repeat(3000);
  const renderer = createTextMotionRenderer(element(root)); renderer.configure(title(undefined, undefined, source)); renderer.layout();
  assert.equal(units(root).length, 1); assert.equal(root.textContent, source); assert.equal(root.attributes['aria-label'], source);
});

test('visible segment counts match actual grapheme and word wrappers including bounded-title fallback', t => {
  dom(t);
  for (const source of ['A👩🏽‍🚀 e\u0301', 'Hello,  world!\nAgain.', '你好，世界！', '  \n\t ', '',
    'title '.repeat(50), 'title '.repeat(3000), ' '.repeat(300)]) {
    for (const unit of ['character', 'word'] as const) {
      const root = new Node(), renderer = createTextMotionRenderer(element(root));
      renderer.configure(title(motion('entrance', unit), undefined, source)); renderer.layout();
      assert.equal(textMotionSegmentCount(source, unit), units(root).filter(part => /\S/u.test(part.textContent)).length,
        `${unit}: ${JSON.stringify(source.slice(0, 30))}`);
      renderer.dispose();
    }
  }
  assert.equal(textMotionSegmentCount('A👩🏽‍🚀 e\u0301', 'character'), 3);
  assert.equal(textMotionSegmentCount('A\n \nB', 'line'), 3, 'blank line slots still affect visible line timing');
  assert.equal(textMotionSegmentCount('title '.repeat(50), 'character'), 50, 'oversized character titles fall back to words');
});

test('layout reports all visible counts before switching units and never repeats measurements or reports on frames', t => {
  dom(t); const root = new Node(); const entrance = motion('entrance', 'character'), exit = motion('entrance', 'line');
  const clip = title(entrance, exit, 'AB CD\n\n  \nEF');
  const reports: TextMotionLayout[] = [];
  const renderer = createTextMotionRenderer(element(root), report => reports.push(report));
  renderer.configure(clip); renderer.layout();
  assert.equal(reports.length, 1); assert.equal(reports[0]!.clip, clip);
  assert.equal(reports[0]!.clipId, clip.id); assert.equal(reports[0]!.text, clip.properties.text);
  assert.deepEqual(reports[0]!.counts, { character: 6, word: 3, line: 5 });
  assert.equal(units(root).length, 6, 'reporting restores the authored entrance segmentation');
  const reads = Node.reads;
  renderer.draw({ entrance: { transition: entrance, progress: 0.4 } });
  renderer.draw({ exit: { transition: exit, progress: 0.4 } });
  assert.equal(Node.reads, reads, 'the exit uses already measured wrapped rows');
  assert.equal(reports.length, 1);
  assert.equal(units(root).length, 5, 'empty rows still retain their animation stagger slots');
  renderer.prepareLayout(); renderer.layout();
  assert.equal(reports.length, 2); assert.ok(Node.reads > reads);
});

test('layout reports only one visible unit for whole-title fallback and zero for whitespace', t => {
  dom(t);
  for (const [source, expected] of [['title '.repeat(3000), 1], [' '.repeat(300), 0], ['', 0]] as const) {
    const root = new Node(); const reports: TextMotionLayout[] = [];
    const renderer = createTextMotionRenderer(element(root), report => reports.push(report));
    renderer.configure(title(undefined, undefined, source)); renderer.layout();
    assert.deepEqual(reports[0]!.counts, { character: expected, word: expected, line: expected });
    assert.equal(reports.length, 1); renderer.dispose();
  }
});

test('blank rows preserve existing rank timing and therefore keep order meaningful', t => {
  dom(t); const root = new Node(); const reports: TextMotionLayout[] = [];
  const base = motion('entrance', 'line');
  if (base.preset === 'none') throw new Error('Line motion required');
  const transition = { ...base, stagger: 0.6, motionOrder: 'forward' as const };
  const renderer = createTextMotionRenderer(element(root), report => reports.push(report));
  renderer.configure(title(transition, undefined, 'One\n')); renderer.layout();
  assert.equal(reports[0]!.counts.line, 2);
  renderer.draw({ entrance: { transition, progress: 0.4 } });
  const forward = units(root)[0]!.children[0]!.style.opacity;
  renderer.draw({ entrance: { transition: { ...transition, motionOrder: 'reverse' }, progress: 0.4 } });
  assert.notEqual(units(root)[0]!.children[0]!.style.opacity, forward, 'the blank rank changes visible line timing');
  renderer.dispose();
});

test('text renderer retains effects/stage fit and clears segmented state when changing to legacy', t => {
  dom(t); const root = new Node(); root.clientWidth = 960; root.clientHeight = 540;
  const reports: TextMotionLayout[] = [];
  const clip = title(); const renderer = textRenderer(clip, element(root), { width: 1920, height: 1080 }, {
    signal: new AbortController().signal, onTextMotionLayout: report => reports.push(report)
  });
  const draw = (value: TextClip, progress: number) => {
    const item = { clip: value, opacity: 1, localTimeMs: 0, textMotion: { entrance: { transition: value.entrance, progress } } };
    renderer.draw(item, { phase: 'paused', positionMs: 0, opacity: 1, items: [item] });
  };
  draw(clip, 0.4); const stage = root.children[0]!.children[0]!; const content = stage.children[0]!;
  assert.equal(reports.length, 1); assert.deepEqual(reports[0]!.counts, { character: 4, word: 2, line: 2 });
  assert.equal(stage.style.transform, 'scale(0.5)'); assert.ok(units(content).length > 0);
  const pose = units(content)[0]!.children[0]!.style.transform;
  Observer.latest!.callback(); assert.equal(units(content)[0]!.children[0]!.style.transform, pose);
  const legacy = title({ preset: 'none', version: 1 }); draw(legacy, 1);
  assert.equal(units(content).length, 0); assert.equal(content.textContent, legacy.properties.text);
  assert.equal(content.attributes['aria-label'], undefined); renderer.dispose();
});
