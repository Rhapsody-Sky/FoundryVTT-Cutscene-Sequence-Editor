import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualPlaybackLauncher } from '../src/application/manual-playback-launcher.js';
import type { PlaybackSchemaVersion, SequenceAudience, SequenceV1 } from '../src/domain/sequence.js';
import { getPlaybackSchemaVersion, getSequenceAudience, withSequenceAudience } from '../src/domain/sequence-audience.js';
import { createBarsSequence, SequenceValidationError, validateSequence } from '../src/domain/validation.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';

const all: SequenceAudience = { mode: 'all', userIds: [], includeGM: true };
const selected: SequenceAudience = { mode: 'selected', userIds: ['manual-player'], includeGM: false };

function sequence(version: PlaybackSchemaVersion = 3): SequenceV1 {
  let id = 0;
  const base = createBarsSequence('Manual sequence', () => `manual-${++id}`, version);
  return validateSequence({ ...base, revision: 8, extension: { values: ['keep', 1] },
    clips: base.clips.map(clip => ({ ...clip, startMs: 400, futureClip: { retained: true } })),
    ...(version === 3 ? { breaks: [{ id: 'break', positionMs: 1_000, futureMarker: 'keep' }] } : {}) });
}

function authoredSequence(version: PlaybackSchemaVersion = 3): SequenceV1 {
  const wrapped = withSequenceAudience(sequence(version), { mode: 'selected', userIds: ['saved-player'], includeGM: true });
  return validateSequence({ ...wrapped, launch: { ...wrapped.launch, futureLaunch: { retained: true },
    audience: { ...wrapped.launch!.audience, futureAudience: ['keep'] } } });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('canceling a manual audience dialog has no prepare side effects and permits a fresh choice', async () => {
  const source = authoredSequence(), before = structuredClone(source);
  const names: string[] = [], prepared: SequenceV1[] = [];
  const launcher = new ManualPlaybackLauncher({
    async chooseAudience(name) { names.push(name); return null; },
    async prepare(snapshot) { prepared.push(snapshot); },
  });
  assert.equal(await launcher.prepare(source), false);
  assert.equal(await launcher.prepare(source), false);
  assert.deepEqual(names, ['Manual sequence', 'Manual sequence']);
  assert.deepEqual(prepared, []);
  assert.deepEqual(source, before);
});

for (const version of [1, 2, 3] as const) {
  test(`manual choice overrides the run audience while preserving authored schema${version} timing and extensions`, async () => {
    const source = authoredSequence(version), before = structuredClone(source);
    const prepared: SequenceV1[] = [];
    const names: string[] = [];
    const launcher = new ManualPlaybackLauncher({
      async chooseAudience(name) { names.push(name); return selected; },
      async prepare(snapshot) { prepared.push(snapshot); },
    });
    await launcher.prepare(source);
    const run = prepared[0]!;
    assert.equal(prepared.length, 1);
    assert.deepEqual(names, ['Manual sequence']);
    assert.deepEqual(run, withSequenceAudience(before, selected));
    assert.deepEqual(getSequenceAudience(run), { ...selected, futureAudience: ['keep'] });
    assert.deepEqual(source, before);
    assert.notEqual(run, source);
    assert.notEqual(run.clips, source.clips);
    assert.notEqual(run.clips[0]!.properties, source.clips[0]!.properties);
    assert.equal(getPlaybackSchemaVersion(run), version);
    const originalPlayback = compileSequence(before), runPlayback = compileSequence(run);
    for (const time of [0, 400, 800, 1_000, 2_000, 5_000, 8_000]) {
      assert.deepEqual(evaluate(runPlayback, time), evaluate(originalPlayback, time));
    }
  });
}

test('legacy manual launches wrap playback without authoring launch settings into the source', async () => {
  for (const version of [1, 2, 3] as const) {
    const source = sequence(version), before = structuredClone(source);
    const prepared: SequenceV1[] = [];
    const launcher = new ManualPlaybackLauncher({
      async chooseAudience() { return all; },
      async prepare(snapshot) { prepared.push(snapshot); },
    });
    await launcher.prepare(source);
    assert.deepEqual(prepared, [withSequenceAudience(before, all)]);
    assert.deepEqual(source, before);
    assert.equal(source.launch, undefined);
  }
});

test('manual launch captures the sequence before the dialog waits for its answer', async () => {
  const source = authoredSequence(), before = structuredClone(source);
  const choice = deferred<SequenceAudience | null>();
  const prepared: SequenceV1[] = [], names: string[] = [];
  const launcher = new ManualPlaybackLauncher({
    chooseAudience(name) { names.push(name); return choice.promise; },
    async prepare(snapshot) { prepared.push(snapshot); },
  });
  const pending = launcher.prepare(source);
  assert.deepEqual(names, ['Manual sequence']);
  // Model editor changes while the dialog is open, after the launcher has captured its input.
  Object.assign(source, { name: 'Edited while choosing', revision: 9 });
  Object.assign(source.clips[0]!, { startMs: 900 });
  Object.assign(source.clips[0]!.properties, { color: '#ff0000' });
  const edited = structuredClone(source);
  choice.resolve(selected);
  await pending;
  assert.deepEqual(prepared, [withSequenceAudience(before, selected)]);
  assert.deepEqual(source, edited);
});

test('each manual prepare chooses independently from both saved settings and the prior manual run', async () => {
  const source = authoredSequence(), before = structuredClone(source);
  const choices = [selected, all];
  const prepared: SequenceV1[] = [];
  let chooserCalls = 0;
  const launcher = new ManualPlaybackLauncher({
    async chooseAudience() { return choices[chooserCalls++]!; },
    async prepare(snapshot) { prepared.push(snapshot); },
  });
  await launcher.prepare(source);
  await launcher.prepare(source);
  assert.equal(chooserCalls, 2);
  assert.deepEqual(prepared, choices.map(choice => withSequenceAudience(before, choice)));
  assert.deepEqual(source, before);
});

test('an explicitly empty manual audience is rejected before prepare and the next request can recover', async () => {
  const source = authoredSequence(), before = structuredClone(source);
  const prepared: SequenceV1[] = [];
  let choice: SequenceAudience = { mode: 'selected', userIds: [], includeGM: false };
  const launcher = new ManualPlaybackLauncher({
    async chooseAudience() { return choice; },
    async prepare(snapshot) { prepared.push(snapshot); },
  });
  await assert.rejects(launcher.prepare(source), (error: unknown) =>
    error instanceof SequenceValidationError && error.code === 'EMPTY_AUDIENCE');
  assert.deepEqual(prepared, []);
  assert.deepEqual(source, before);
  choice = { ...choice, includeGM: true };
  await launcher.prepare(source);
  assert.deepEqual(prepared, [withSequenceAudience(before, choice)]);
});

test('invalid chooser output rejects without preparing or broadening the requested audience', async () => {
  const prepared: SequenceV1[] = [];
  const launcher = new ManualPlaybackLauncher({
    async chooseAudience() { return { ...selected, userIds: ['bad/user'] }; },
    async prepare(snapshot) { prepared.push(snapshot); },
  });
  await assert.rejects(launcher.prepare(sequence()), SequenceValidationError);
  assert.deepEqual(prepared, []);
});

test('concurrent calls are ignored while either the chooser or prepare is pending', async () => {
  const choice = deferred<SequenceAudience | null>(), preparation = deferred<void>();
  let chooserCalls = 0, prepareCalls = 0;
  const launcher = new ManualPlaybackLauncher({
    chooseAudience() { chooserCalls++; return choice.promise; },
    prepare() { prepareCalls++; return preparation.promise; },
  });
  const first = launcher.prepare(sequence());
  await launcher.prepare(sequence());
  assert.equal(chooserCalls, 1);
  assert.equal(prepareCalls, 0);
  choice.resolve(selected);
  await Promise.resolve();
  assert.equal(prepareCalls, 1);
  await launcher.prepare(sequence());
  assert.equal(chooserCalls, 1);
  assert.equal(prepareCalls, 1);
  preparation.resolve(undefined);
  await first;
  await launcher.prepare(sequence());
  assert.equal(chooserCalls, 2);
  assert.equal(prepareCalls, 2);
});

for (const failingPort of ['chooser', 'prepare'] as const) {
  test(`a ${failingPort} failure propagates and resets the manual launch guard`, async () => {
    const failure = new Error(`${failingPort} failed`);
    let chooserCalls = 0, prepareCalls = 0, failNext = true;
    const launcher = new ManualPlaybackLauncher({
      async chooseAudience() {
        chooserCalls++;
        if (failingPort === 'chooser' && failNext) { failNext = false; throw failure; }
        return selected;
      },
      async prepare() {
        prepareCalls++;
        if (failingPort === 'prepare' && failNext) { failNext = false; throw failure; }
      },
    });
    await assert.rejects(launcher.prepare(sequence()), error => error === failure);
    await launcher.prepare(sequence());
    assert.equal(chooserCalls, 2);
    assert.equal(prepareCalls, failingPort === 'chooser' ? 1 : 2);
  });
}

test('invalid sequences never open the chooser and do not leave the launch guard held', async () => {
  let chooserCalls = 0, prepareCalls = 0;
  const launcher = new ManualPlaybackLauncher({
    async chooseAudience() { chooserCalls++; return all; },
    async prepare() { prepareCalls++; },
  });
  await assert.rejects(launcher.prepare({ ...sequence(), schemaVersion: 99 } as unknown as SequenceV1), SequenceValidationError);
  assert.equal(chooserCalls, 0);
  assert.equal(prepareCalls, 0);
  await launcher.prepare(sequence());
  assert.equal(chooserCalls, 1);
  assert.equal(prepareCalls, 1);
});
