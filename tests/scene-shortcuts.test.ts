import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneShortcuts, type SceneControl } from '../src/integrations/foundry/scene-shortcuts.js';
import { MODULE_ID } from '../src/application/foundation-status.js';

test('GM scene menu opens the playback manager without launching or changing a sequence', async () => {
  const calls: string[] = [];
  const shortcuts = new SceneShortcuts({
    isGM: () => true,
    repository: {
      list: async () => [{ id: 'saved', name: 'Saved sequence', revision: 1 }],
      read: async () => assert.fail('opening playback must not read a sequence'),
      save: async () => assert.fail('opening playback must not save a sequence'),
      delete: async () => assert.fail('opening playback must not delete a sequence')
    },
    openEditor: async () => { calls.push('editor'); },
    openPlayback: () => { calls.push('playback'); },
    prepare: async () => { assert.fail('opening playback must not prepare a run'); },
    localize: key => key, repaint: () => {}, report: error => { throw error; }
  });
  await shortcuts.refresh();
  const controls: Record<string, SceneControl> = {};
  shortcuts.populate(controls);
  const tools = controls[MODULE_ID]!.tools;
  assert.equal(tools.editor!.order, 0);
  assert.equal(tools.playback!.order, 1);
  assert.equal(tools['sequence-0']!.order, 2);
  assert.equal(tools.playback!.title, 'STAGECRAFT.Orchestration.Title');
  tools.playback!.onChange();
  await Promise.resolve();
  assert.deepEqual(calls, ['playback']);
  shortcuts.dispose();
});

test('playback scene shortcut is GM-only and unavailable after disposal', () => {
  let gm = false;
  const shortcuts = new SceneShortcuts({
    isGM: () => gm,
    repository: {} as never,
    openEditor: async () => {}, openPlayback: () => assert.fail('inert shortcut'),
    prepare: async () => {}, localize: key => key, repaint: () => {}, report: () => {}
  });
  const controls: Record<string, SceneControl> = {};
  shortcuts.populate(controls);
  assert.deepEqual(controls, {});
  gm = true;
  shortcuts.populate(controls);
  const playback = controls[MODULE_ID]!.tools.playback!;
  shortcuts.dispose();
  playback.onChange();
  assert.ok(playback);
});
