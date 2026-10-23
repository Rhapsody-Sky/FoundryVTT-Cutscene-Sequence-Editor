import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnimatedPattern } from '../src/domain/animated-pattern.js';
import type { SequenceV1, SolidClipV2 } from '../src/domain/sequence.js';
import { compileSequence, evaluate } from '../src/playback/evaluate.js';
import { LocalPlayer, type PlayerFrame, type Runtime, type Surface } from '../src/playback/local-player.js';

const none = { preset: 'none', version: 1 } as const;
function surface(id = 'surface', onBreak: 'loop' | 'pause' = 'loop', startMs = 0): SolidClipV2 {
  return { id, trackId: 'visual', type: 'solid', typeVersion: 2, startMs,
    duration: { kind: 'sequence-end' }, entrance: none, exit: none,
    properties: { color: '#123456', fit: 'contain', box: { x: 0, y: 0, width: 600, height: 300 },
      crop: { x: 0, y: 0, width: 1, height: 1 }, mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }],
      pattern: { ...createAnimatedPattern(), onBreak } } };
}
function sequence(clips: SequenceV1['clips'] = [surface()]): SequenceV1 {
  return { schemaVersion: 3, id: 'patterns', revision: 1, name: 'Pattern clocks',
    composition: { width: 600, height: 300 }, presentation: { surface: 'window', blockInput: false, exitDurationMs: 200 },
    tracks: [{ id: 'visual', name: 'Visual', kind: 'visual', enabled: true, locked: false, order: 0 }],
    breaks: [{ id: 'a', positionMs: 500 }, { id: 'b', positionMs: 1500 }], clips, end: { kind: 'manual', durationMs: 3000 } };
}
const history = [{ id: 'a', positionMs: 500, elapsedMs: 250 }, { id: 'b', positionMs: 1500, elapsedMs: 900 }];

test('timeline, applicable completed holds, and current hold sum once for each clip', () => {
  const plan = compileSequence(sequence([surface(), surface('later', 'loop', 1000), surface('pause', 'pause')]));
  const states = evaluate(plan, 2000, { breakHistory: history });
  assert.deepEqual(states.map(item => [item.clip.id, item.localTimeMs, item.patternTimeMs]),
    [['pause', 2000, 2000], ['surface', 2000, 3150], ['later', 1000, 1900]]);
  const held = evaluate(plan, 3000, { breakHistory: history, holding: { elapsedMs: 400 } });
  assert.equal(held.find(item => item.clip.id === 'surface')!.patternTimeMs, 4550);
  assert.equal(held.find(item => item.clip.id === 'later')!.patternTimeMs, 3300);
  assert.equal(held.find(item => item.clip.id === 'pause')!.patternTimeMs, 3000);
  // Backward seeks ignore history that lies beyond the requested timeline point.
  assert.equal(evaluate(plan, 600, { breakHistory: history }).find(item => item.clip.id === 'surface')!.patternTimeMs, 850);
  assert.equal(evaluate(plan, 400, { breakHistory: history }).find(item => item.clip.id === 'surface')!.patternTimeMs, 400);
});

test('fade advances active patterns without doubling the terminal hold; paused origins stay frozen', () => {
  const plan = compileSequence(sequence([surface(), surface('pause', 'pause')]));
  const regular = evaluate(plan, 2500, { breakHistory: history, exiting: { elapsedMs: 80 } });
  assert.equal(regular.find(item => item.clip.id === 'surface')!.patternTimeMs, 3730);
  assert.equal(regular.find(item => item.clip.id === 'pause')!.patternTimeMs, 2580);
  const terminal = evaluate(plan, 3000, { breakHistory: history, holding: { elapsedMs: 480 }, exiting: { elapsedMs: 80 } });
  assert.equal(terminal.find(item => item.clip.id === 'surface')!.patternTimeMs, 4630);
  assert.equal(terminal.find(item => item.clip.id === 'pause')!.patternTimeMs, 3080);
  const frozen = evaluate(plan, 3000, { breakHistory: history, holding: { elapsedMs: 400, paused: true },
    exiting: { elapsedMs: 80, paused: true } });
  assert.equal(frozen.find(item => item.clip.id === 'surface')!.patternTimeMs, 4550);
  assert.equal(frozen.find(item => item.clip.id === 'pause')!.patternTimeMs, 3000);
});

test('ended fixed clips stay absent at later Breaks and common fade; static surfaces have no pattern clock', () => {
  const ended: SolidClipV2 = { ...surface('ended'), duration: { kind: 'fixed', milliseconds: 800 } };
  const { pattern: _pattern, ...properties } = surface('static').properties;
  const plan = compileSequence({ ...sequence([ended, surface(), { ...surface('static'), properties }]), end: { kind: 'fixed', durationMs: 3000 } });
  assert.equal(evaluate(plan, 800).some(item => item.clip.id === 'ended'), false);
  for (const position of [1500, 3000]) {
    const states = evaluate(plan, position, { breakHistory: history, holding: { elapsedMs: 500 }, exiting: { elapsedMs: 90 } });
    assert.equal(states.some(item => item.clip.id === 'ended'), false);
    assert.equal('patternTimeMs' in states.find(item => item.clip.id === 'static')!, false);
  }
});

test('legacy evaluator produces the same timeline and fade pattern clock', () => {
  const { breaks: _breaks, ...draft } = sequence();
  const plan = compileSequence({ ...draft, schemaVersion: 1, end: { kind: 'fixed', durationMs: 3000 } });
  assert.equal(evaluate(plan, 500)[0]!.patternTimeMs, 500);
  assert.equal(evaluate(plan, 3000, { exiting: { elapsedMs: 100 } })[0]!.patternTimeMs, 3100);
  assert.equal(evaluate(plan, 3000, { exiting: { elapsedMs: 100, paused: true } })[0]!.patternTimeMs, 3000);
});

class Clock implements Runtime {
  time = 0; next = 0; frames = new Map<number, () => void>();
  now() { return this.time; }
  requestFrame(callback: () => void) { const id = ++this.next; this.frames.set(id, callback); return id; }
  cancelFrame(id: number) { this.frames.delete(id); }
  advance(milliseconds: number) { this.time += milliseconds; const frames = [...this.frames.values()]; this.frames.clear(); frames.forEach(callback => callback()); }
}
class RecordingSurface implements Surface {
  frames: PlayerFrame[] = []; disposed = 0;
  async prepare() {}
  render(frame: PlayerFrame) { this.frames.push(frame); }
  dispose() { this.disposed++; }
}

test('player Pause/Resume and Continue preserve exact pattern progress through two Breaks and terminal exit', async () => {
  const clock = new Clock(), output = new RecordingSurface(), player = new LocalPlayer(clock);
  await player.start(sequence([surface(), surface('pause', 'pause')]), output);
  const time = (id = 'surface') => player.getState().items!.find(item => item.clip.id === id)!.patternTimeMs;
  clock.advance(700); assert.equal(time(), 700); assert.equal(time('pause'), 500);
  player.pause(); clock.advance(3000); assert.equal(time(), 700);
  player.resume(); clock.advance(100); assert.equal(time(), 800);
  player.continueFromBreak(); assert.equal(time(), 800);
  clock.advance(1000); assert.equal(time(), 1800); assert.equal(time('pause'), 1500);
  clock.advance(400); assert.equal(time(), 2200);
  player.continueFromBreak(); assert.equal(time(), 2200);
  clock.advance(1500); assert.equal(time(), 3700); assert.equal(time('pause'), 3000);
  clock.advance(100); assert.equal(time(), 3800);
  player.continueFromBreak(); assert.equal(time(), 3800);
  clock.advance(90); assert.equal(time(), 3890); assert.equal(time('pause'), 3090);
  clock.advance(110); assert.equal(output.disposed, 1); assert.equal(player.getState().phase, 'ended');
});
