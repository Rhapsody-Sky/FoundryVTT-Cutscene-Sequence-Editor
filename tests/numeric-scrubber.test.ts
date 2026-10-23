import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NumericScrubbers } from '../src/ui/numeric-scrubber.js';

class TestElement extends EventTarget {
  ownerDocument = new EventTarget();
  readonly children: TestElement[] = [];
  parentElement: TestElement | null = null;
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  className = '';
  hidden = false;
  disabled = false;
  readOnly = false;
  type = '';
  name = '';
  value = '';
  min = '';
  max = '';
  step = '1';
  textContent: string | null = '';
  title = '';
  focused = false;
  private captures = new Set<number>();
  classList = {
    add: (name: string) => { if (!this.className.split(' ').includes(name)) this.className += ' ' + name; },
    remove: (name: string) => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); }
  };

  constructor(readonly tagName = 'div') { super(); }
  override dispatchEvent(event: Event): boolean {
    if (!Object.hasOwn(event, 'target')) Object.defineProperty(event, 'target', { value: this });
    const accepted = super.dispatchEvent(event);
    if (!event.cancelBubble) {
      if (this.parentElement) this.parentElement.dispatchEvent(event);
      else this.ownerDocument.dispatchEvent(event);
    }
    return accepted;
  }
  append(...nodes: TestElement[]): void { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  after(node: TestElement): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children, index = siblings.indexOf(this);
    node.parentElement = this.parentElement; siblings.splice(index + 1, 0, node);
  }
  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  querySelector(selector: string): TestElement | null {
    if (selector === 'span') return this.children.find(child => child.tagName === 'span') ?? null;
    return this.children.map(child => child.querySelector(selector)).find(Boolean) ?? null;
  }
  querySelectorAll<T extends Element = Element>(selector: string): NodeListOf<T> {
    const found: TestElement[] = [];
    const visit = (node: TestElement) => {
      if (selector === '[data-stagecraft-inspector] input[type="number"]' && node instanceof TestInput) found.push(node);
      if (selector === 'span' && node.tagName === 'span') found.push(node);
      node.children.forEach(visit);
    };
    visit(this);
    return found as unknown as NodeListOf<T>;
  }
  closest(selector: string): TestElement | null {
    if (selector === 'label' && this.tagName === 'label') return this;
    if (selector === '[hidden]' && this.hidden) return this;
    if (selector === '[data-numeric-scrubber]' && 'numericScrubber' in this.dataset) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  matches(selector: string): boolean {
    if (selector !== ':disabled') return false;
    for (let node: TestElement | null = this; node; node = node.parentElement) {
      if (node.disabled || node.tagName === 'fieldset' && node.disabled) return true;
    }
    return false;
  }
  contains(node: TestElement): boolean { return node === this || this.children.some(child => child.contains(node)); }
  focus(): void { this.focused = true; }
  setPointerCapture(id: number): void { this.captures.add(id); }
  hasPointerCapture(id: number): boolean { return this.captures.has(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); }
}

class TestInput extends TestElement {
  defaultValue = '';
  validityChecks = 0;
  constructor(name: string, value: string, options: { min?: string; max?: string; step?: string } = {}) {
    super('input'); this.type = 'number'; this.name = name; this.value = value; this.defaultValue = value;
    this.min = options.min ?? ''; this.max = options.max ?? ''; this.step = options.step ?? '1';
  }
  checkValidity(): boolean {
    this.validityChecks++;
    if (this.value.trim() === '') return false;
    const value = Number(this.value), min = this.min === '' ? Number.NEGATIVE_INFINITY : Number(this.min), max = this.max === '' ? Number.POSITIVE_INFINITY : Number(this.max);
    if (!Number.isFinite(value) || value < min || value > max) return false;
    if (this.step === 'any') return true;
    const step = Number(this.step), base = Number.isFinite(min) ? min : 0;
    return Math.abs((value - base) / step - Math.round((value - base) / step)) < 1e-7;
  }
}

function fixture(t: TestContext, options: { name?: string; value?: string; min?: string; max?: string; step?: string } = {}) {
  const root = new TestElement('fieldset'), label = new TestElement('label'), caption = new TestElement('span');
  const input = new TestInput(options.name ?? 'height', options.value ?? '5', options);
  caption.textContent = 'Height'; label.append(caption, input); root.append(label);
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ Element: TestElement, HTMLElement: TestElement, HTMLInputElement: TestInput,
    document: { createElement: (tag: string) => new TestElement(tag) } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

  let editable = true, identity = 'sequence|selection|1';
  const previews: number[] = [], commits: number[] = [];
  let cancellations = 0, preparations = 0;
  const controller = new NumericScrubbers(root as unknown as HTMLElement, key => ({ NumericScrubber: 'Adjust by dragging horizontally', NumericScrubberHelp: 'Shift coarse, Alt fine' } as Record<string, string>)[key] ?? key, {
    read: () => ({ editable, identity }), before: () => { preparations++; return editable; },
    preview: (_input, value) => { previews.push(value); return true; },
    commit: (_input, value) => { commits.push(value); return true; },
    cancel: () => { cancellations++; }
  });
  t.after(() => controller.dispose());
  const dispatch = (type: string, target: TestElement, properties: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ target, button: 0, pointerId: 1, clientX: 0, detail: 1,
      clientY: 0, shiftKey: false, altKey: false, key: '', ctrlKey: false, metaKey: false, ...properties })
      .map(([key, value]) => [key, { value }])));
    target.dispatchEvent(event);
    return event;
  };
  return {
    root, input, controller, previews, commits, dispatch,
    get cancellations() { return cancellations; },
    get preparations() { return preparations; },
    set editable(value: boolean) { editable = value; },
    set identity(value: string) { identity = value; }
  };
}

test('horizontal drag uses input steps, modifiers, bounds, and one commit per gesture', t => {
  const f = fixture(t, { value: '5', min: '0', max: '10', step: '0.5' });
  assert.equal(f.input.type, 'number');
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: 8 });
  assert.equal(f.input.value, '6');
  assert.equal(f.commits.length, 0);
  f.dispatch('pointerup', f.input, { clientX: 8 });
  assert.deepEqual(f.commits, [6]);

  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: 4, shiftKey: true });
  f.dispatch('pointerup', f.input, { clientX: 4, shiftKey: true });
  assert.deepEqual(f.commits, [6, 10]);
  assert.equal(f.input.checkValidity(), true);
});

test('dynamic polygon inputs register and detached active controls cancel and release capture', t => {
  const f = fixture(t, { name: 'solid-mask-0-x', value: '12.3456', step: 'any', min: '0', max: '100' });
  f.dispatch('pointerdown', f.input); f.dispatch('pointermove', f.input, { clientX: 8 });
  assert.equal(f.input.hasPointerCapture(1), true);
  f.input.remove();
  const replacement = new TestInput('solid-mask-6-x', '25', { step: 'any', min: '0', max: '100' });
  replacement.title = 'Point 7'; f.root.append(replacement); f.controller.update();
  assert.equal(f.cancellations, 1); assert.equal(f.input.hasPointerCapture(1), false);
  assert.equal(f.input.value, '12.3456'); assert.equal(f.input.title, '');
  assert.equal(replacement.title, 'Point 7 Shift coarse, Alt fine');
  f.dispatch('pointerdown', replacement); f.dispatch('pointermove', replacement, { clientX: 8 }); f.dispatch('pointerup', replacement, { clientX: 8 });
  assert.deepEqual(f.commits, [25.2]);
  f.controller.update(); assert.equal(replacement.title, 'Point 7 Shift coarse, Alt fine');
  f.controller.dispose(); assert.equal(replacement.title, 'Point 7');
});

test('Alt gives fine decimal steps for step=any while keeping the value inside min and max', t => {
  const f = fixture(t, { name: 'bars-duration', value: '1.2', min: '0.1', max: '1.25', step: 'any' });
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: 40, altKey: true });
  assert.equal(f.input.value, '1.22');
  f.dispatch('pointerup', f.input, { clientX: 40, altKey: true });
  assert.equal(f.commits[0], 1.22);
  assert.equal(f.input.checkValidity(), true);
});

test('future video geometry fields use composition-pixel steps when their HTML step is any', t => {
  const f = fixture(t, { name: 'video-width', value: '320', min: '1', max: '1920', step: 'any' });
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: 4 });
  f.dispatch('pointerup', f.input, { clientX: 4 });
  assert.deepEqual(f.commits, [321]);
});

test('image and title geometry fields use logical-pixel steps when their HTML step is any', t => {
  for (const name of ['image-x', 'title-minimum-size']) {
    const f = fixture(t, { name, value: '100', step: 'any' });
    f.dispatch('pointerdown', f.input);
    f.dispatch('pointermove', f.input, { clientX: 4 });
    f.dispatch('pointerup', f.input, { clientX: 4 });
    assert.deepEqual(f.commits, [101], name);
  }
});

test('fractional legacy values use stable unit steps, preserve precision, and a scrubber click stays inert', t => {
  for (const name of ['title-size', 'outline-width', 'shadow-blur', 'glow-radius']) {
    const f = fixture(t, { name, value: '35.03283197342218', step: 'any' });
    f.dispatch('pointerdown', f.input);
    f.dispatch('pointerup', f.input, { clientX: 0 });
    assert.equal(f.input.value, '35.03283197342218', `${name} click must not truncate an existing decimal`);
    assert.deepEqual(f.commits, [], `${name} click must not commit a precision-only change`);
    f.dispatch('pointerdown', f.input);
    f.dispatch('pointermove', f.input, { clientX: 4 });
    f.dispatch('pointerup', f.input, { clientX: 4 });
    assert.deepEqual(f.commits, [36.03283197342218], `${name} uses a whole-unit drag step`);
    assert.equal(f.input.value, '36.03283197342218');
  }
});

test('Alt keeps a fine unit step from fractional title and effect values', t => {
  for (const name of ['title-minimum-size', 'image-shadow-offset-x']) {
    const f = fixture(t, { name, value: '35.03283197342218', step: 'any' });
    f.dispatch('pointerdown', f.input);
    f.dispatch('pointermove', f.input, { clientX: 20, altKey: true });
    f.dispatch('pointerup', f.input, { clientX: 20, altKey: true });
    assert.deepEqual(f.commits, [35.13283197342218], name);
    assert.equal(f.input.value, '35.13283197342218');
  }
});

test('Escape, capture loss, stale selection, and disposal cancel without committing', t => {
  const f = fixture(t);
  const drag = () => { f.dispatch('pointerdown', f.input); f.dispatch('pointermove', f.input, { clientX: 8 }); };
  drag(); f.dispatch('keydown', f.input, { key: 'Escape' });
  assert.equal(f.input.value, '5');
  drag(); f.dispatch('lostpointercapture', f.input);
  assert.equal(f.input.value, '5');
  drag(); f.identity = 'another-selection'; f.controller.update();
  assert.equal(f.input.value, '5');
  drag(); f.controller.dispose();
  assert.equal(f.input.value, '5');
  assert.equal(f.commits.length, 0);
  assert.equal(f.cancellations, 4);
});

test('disabled, readonly, and wheel input do not start or alter a drag', t => {
  const f = fixture(t);
  f.input.disabled = true; f.controller.update(); assert.equal(f.input.className.includes('stagecraft-numeric-scrubbable'), false);
  f.dispatch('pointerdown', f.input); f.dispatch('pointermove', f.input, { clientX: 40 });
  f.input.disabled = false; f.input.readOnly = true; f.controller.update();
  f.dispatch('pointerdown', f.input); f.dispatch('pointermove', f.input, { clientX: 40 });
  f.input.readOnly = false; f.controller.update();
  f.dispatch('wheel', f.input, { deltaY: -100 });
  assert.equal(f.input.value, '5'); assert.equal(f.commits.length, 0);
});

test('native keyboard editing and arrow navigation reach the input without scrubber callbacks', t => {
  const f = fixture(t, { value: '2', step: '0.25' });
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', '2', 'Tab']) {
    assert.equal(f.dispatch('keydown', f.input, { key }).defaultPrevented, false, key);
  }
  let editorInputs = 0;
  f.root.addEventListener('input', () => editorInputs++);
  assert.equal(f.dispatch('beforeinput', f.input).defaultPrevented, false);
  f.input.value = '3.25'; // The browser's native keyboard/default action.
  assert.equal(f.dispatch('input', f.input).defaultPrevented, false);
  assert.equal(editorInputs, 1);
  assert.deepEqual(f.commits, []);
  assert.equal(f.preparations, 0);
});

test('keyboard increments cannot commit during an active pointer gesture; Escape still cancels it', t => {
  const f = fixture(t);
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: 8 });
  assert.equal(f.input.value, '7');
  f.dispatch('keydown', f.input, { key: 'ArrowRight' });
  assert.deepEqual(f.commits, []);
  assert.equal(f.input.value, '7');
  f.dispatch('keydown', f.input, { key: 'Escape' });
  assert.equal(f.input.value, '5');
  assert.deepEqual(f.commits, []);
  assert.equal(f.cancellations, 1);
});

test('direct number inputs add no button and leave click, small movement, focus, and doubleclick selection native', t => {
  const f = fixture(t, { value: '35.03283197342218', step: 'any' });
  assert.equal(f.root.children[0]!.children.length, 2);
  assert.equal(f.root.children[0]!.children.some(child => child.tagName === 'button'), false);
  assert.equal(f.input.title, 'Shift coarse, Alt fine');
  assert.equal(f.dispatch('pointerdown', f.input).defaultPrevented, false);
  assert.equal(f.input.hasPointerCapture(1), false);
  f.input.focus(); // Native focusing remains possible; the scrubber does not take it over.
  assert.equal(f.dispatch('pointermove', f.input, { clientX: 3 }).defaultPrevented, false);
  assert.equal(f.dispatch('pointerup', f.input, { clientX: 3 }).defaultPrevented, false);
  assert.equal(f.dispatch('dblclick', f.input, { detail: 2 }).defaultPrevented, false);
  f.dispatch('pointerdown', f.input, { detail: 0 });
  assert.equal(f.dispatch('mousedown', f.input, { detail: 2 }).defaultPrevented, false);
  assert.equal(f.dispatch('pointermove', f.input, { clientX: 40 }).defaultPrevented, false);
  f.dispatch('pointerup', f.input, { clientX: 40 });
  assert.equal(f.input.focused, true);
  assert.equal(f.input.value, '35.03283197342218');
  assert.equal(f.preparations, 0);
  assert.equal(f.cancellations, 0);
  assert.deepEqual(f.previews, []);
  assert.deepEqual(f.commits, []);
});

test('clicking an incomplete number does not trigger native validity checking or an edit transaction', t => {
  const f = fixture(t, { value: '' });
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointerup', f.input);
  assert.equal(f.input.validityChecks, 0);
  assert.equal(f.preparations, 0);
  assert.equal(f.cancellations, 0);
});

test('native input, change, and focus events cannot commit a transient drag value', t => {
  const f = fixture(t);
  const forwarded: string[] = [];
  for (const type of ['beforeinput', 'input', 'change', 'blur', 'focusout']) {
    f.root.addEventListener(type, () => forwarded.push(type));
  }
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: 8 });
  assert.equal(f.input.hasPointerCapture(1), true);
  for (const type of ['beforeinput', 'input', 'change', 'blur', 'focusout']) {
    f.input.value = '99';
    assert.equal(f.dispatch(type, f.input).defaultPrevented, true, type);
    assert.equal(f.input.value, '7', type);
  }
  assert.deepEqual(forwarded, []);
  assert.deepEqual(f.commits, []);
  f.dispatch('pointerup', f.input, { clientX: 8 });
  f.dispatch('pointerup', f.input, { clientX: 8 });
  assert.deepEqual(f.commits, [7]);
  assert.equal(f.input.hasPointerCapture(1), false);
  assert.equal(f.preparations, 1);
});

test('pending gestures cancel silently on release elsewhere, native value edits, Escape, and vertical movement', t => {
  const f = fixture(t);
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointerup', f.root, { clientX: 30 });
  f.dispatch('pointermove', f.input, { clientX: 30 });
  f.dispatch('pointerdown', f.input);
  f.input.value = '6'; // Native spinner or editing while the pointer is still down.
  f.dispatch('input', f.input);
  f.dispatch('pointermove', f.input, { clientX: 30 });
  f.dispatch('pointerdown', f.input);
  f.dispatch('keydown', f.input, { key: 'Escape' });
  f.dispatch('pointermove', f.input, { clientX: 30 });
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientY: 10 });
  f.dispatch('pointermove', f.input, { clientX: 30 });
  assert.equal(f.preparations, 0);
  assert.equal(f.cancellations, 0);
  assert.deepEqual(f.commits, []);
  assert.equal(f.input.value, '6');
});

test('disabled fieldset, hidden field, locked context, and invalid input cannot prepare a drag', t => {
  const f = fixture(t);
  const attempt = () => {
    f.controller.update();
    f.dispatch('pointerdown', f.input);
    f.dispatch('pointermove', f.input, { clientX: 40 });
    f.dispatch('pointerup', f.input, { clientX: 40 });
  };
  f.root.disabled = true; attempt();
  f.root.disabled = false; f.input.hidden = true; attempt();
  f.input.hidden = false; f.editable = false; attempt();
  f.editable = true; f.input.value = ''; attempt();
  assert.equal(f.preparations, 0);
  assert.deepEqual(f.previews, []);
  assert.deepEqual(f.commits, []);
});

test('pointercancel and returning to the exact starting value restore the gesture without a commit', t => {
  const f = fixture(t, { value: '5.000', step: 'any' });
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: 8 });
  f.dispatch('pointercancel', f.input);
  assert.equal(f.input.value, '5.000');
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: 8 });
  f.dispatch('pointermove', f.input, { clientX: 0 });
  f.dispatch('pointerup', f.input, { clientX: 0 });
  assert.equal(f.input.value, '5.000');
  assert.deepEqual(f.commits, []);
  assert.equal(f.cancellations, 2);
  f.controller.dispose();
  assert.equal(f.input.title, '');
  assert.equal(f.input.className.trim(), '');
});

test('Alt keeps explicit step grids and drag bounds valid, including a nonzero step base', t => {
  const f = fixture(t, { value: '1.25', min: '0.25', max: '2.1', step: '0.5' });
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: 40, altKey: true });
  assert.equal(f.input.value, '1.75');
  f.dispatch('pointerup', f.input, { clientX: 40, altKey: true });
  assert.equal(f.input.checkValidity(), true);
  assert.deepEqual(f.commits, [1.75]);
  f.dispatch('pointerdown', f.input);
  f.dispatch('pointermove', f.input, { clientX: -1000, shiftKey: true });
  f.dispatch('pointerup', f.input, { clientX: -1000, shiftKey: true });
  assert.deepEqual(f.commits, [1.75, 0.25]);
});

test('an empty inspector remains inert while retaining delegated listeners for later fields', () => {
  const root = { querySelectorAll: () => [], addEventListener: () => {}, ownerDocument: new EventTarget() };
  const unexpected = () => { assert.fail('empty inspector has no callbacks'); };
  const controller = new NumericScrubbers(root as unknown as HTMLElement, key => key, {
    read: () => { unexpected(); return { editable: false, identity: '' }; },
    before: () => { unexpected(); return false; },
    preview: () => { unexpected(); return false; },
    commit: () => { unexpected(); return false; },
    cancel: unexpected
  });
  controller.update();
  controller.cancel();
  controller.dispose();
});
