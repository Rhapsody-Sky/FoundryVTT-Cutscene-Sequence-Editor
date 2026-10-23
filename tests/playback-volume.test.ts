import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPlaybackVolume, playbackVolumeKey } from '../src/application/playback-volume.js';

test('personal volume defaults to one, clamps finite values, and ignores invalid input without sudden unmuting', () => {
  const volume = new LocalPlaybackVolume();
  const values: number[] = []; const unsubscribe = volume.subscribe(value => values.push(value));
  assert.equal(volume.value, 1);
  volume.set(0.35); volume.set(0.35); volume.set(-2); volume.set(NaN); volume.set(Infinity);
  assert.equal(volume.value, 0); assert.deepEqual(values, [1, 0.35, 0]);
  unsubscribe(); volume.set(2); assert.equal(volume.value, 1); assert.deepEqual(values, [1, 0.35, 0]);
});

test('persisted volume is independent for different worlds and users and survives a new local controller', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); } };
  const key = playbackVolumeKey('world', 'player-a');
  const a = new LocalPlaybackVolume({ storage, key }); a.set(0);
  assert.equal(new LocalPlaybackVolume({ storage, key }).value, 0);
  assert.equal(new LocalPlaybackVolume({ storage, key: playbackVolumeKey('world', 'player-b') }).value, 1);
  assert.equal(new LocalPlaybackVolume({ storage, key: playbackVolumeKey('other-world', 'player-a') }).value, 1);
  assert.notEqual(playbackVolumeKey('a.b', 'c'), playbackVolumeKey('a', 'b.c'));
});

test('corrupt or unavailable persistence does not block volume control and observer failures do not stop updates', () => {
  for (const stored of ['', ' ', 'NaN', 'Infinity', '-1', '2', 'broken']) {
    const volume = new LocalPlaybackVolume({ storage: { getItem: () => stored, setItem() {} }, key: 'volume' });
    assert.equal(volume.value, 1);
  }
  const volume = new LocalPlaybackVolume({ storage: { getItem() { throw new Error('Denied'); },
    setItem() { throw new Error('Full'); } }, key: 'volume' });
  const values: number[] = []; volume.subscribe(() => { throw new Error('Observer'); }); volume.subscribe(value => values.push(value));
  volume.set(0.2); assert.equal(volume.value, 0.2); assert.deepEqual(values, [1, 0.2]);
});
