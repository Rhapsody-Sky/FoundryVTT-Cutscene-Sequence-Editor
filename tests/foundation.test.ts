import test from 'node:test';
import assert from 'node:assert/strict';
import { foundationStatus, MODULE_ID } from '../src/application/foundation-status.js';
import { registerFoundation } from '../src/integrations/foundry/register-foundation.js';
import type { FoundationHost } from '../src/integrations/foundry/host.js';

function fixture(version = '14.369') {
  const callbacks = new Map<string, () => void>();
  const registrations: string[] = [];
  const menus: unknown[] = [];
  const module: { api?: unknown } = {};
  class ApplicationStub {
    static DEFAULT_OPTIONS = {};
    async render() { return undefined; }
    async _prepareContext() { return {}; }
  }
  const host: FoundationHost = {
    Hooks: { once: (event, callback) => { registrations.push(event); callbacks.set(event, callback); } },
    game: {
      version,
      modules: { get: id => id === MODULE_ID ? module : undefined },
      settings: { registerMenu: (...args) => { menus.push(args); } }
    },
    foundry: { applications: { api: {
      ApplicationV2: ApplicationStub,
      HandlebarsApplicationMixin: base => base
    } } }
  };
  return { host, callbacks, registrations, menus, module };
}

test('bootstrap waits for hooks, installs once, and exposes read-only diagnostics only', () => {
  const f = fixture();
  registerFoundation(f.host, '0.0.1');
  registerFoundation(f.host, '0.0.1');
  assert.equal(f.menus.length, 0);
  assert.equal(f.module.api, undefined);
  assert.equal(f.callbacks.size, 2);
  assert.deepEqual(f.registrations, ['init', 'ready']);
  f.callbacks.get('init')!();
  assert.equal(f.menus.length, 1);
  const menu = f.menus[0] as [string, string, { restricted: boolean }];
  assert.equal(menu[2].restricted, true);
  f.callbacks.get('ready')!();
  const readApi = (): unknown => f.module.api;
  const api = readApi() as { getStatus(): ReturnType<typeof foundationStatus> };
  assert.deepEqual(Object.keys(api), ['getStatus']);
  assert.ok(Object.isFrozen(api));
  assert.ok(Object.isFrozen(api.getStatus()));
  assert.deepEqual(api.getStatus(), {
    moduleVersion: '0.0.1', foundryVersion: '14.369', supportedGeneration: true,
    ready: true, playbackAvailable: false, persistenceAvailable: false, transportAvailable: false
  });
});

test('unsupported Foundry generation does not register an application', () => {
  const f = fixture('13.351');
  registerFoundation(f.host, '0.0.1');
  f.callbacks.get('init')!();
  assert.equal(f.menus.length, 0);
});

test('module evaluation does not require an initialized game object', () => {
  const f = fixture();
  const callbacks = f.callbacks;
  Object.defineProperty(f.host, 'game', { get() { throw new Error('game not created yet'); } });
  assert.doesNotThrow(() => registerFoundation(f.host, '0.0.1'));
  assert.equal(callbacks.size, 2);
});
