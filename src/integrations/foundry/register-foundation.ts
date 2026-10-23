import { foundationStatus, MODULE_ID, type FoundationStatus } from '../../application/foundation-status.js';
import type { FoundationHost } from './host.js';
import { createStatusApplication } from './status-application.js';

const installedHosts = new WeakSet<object>();

/** Package 0 registers diagnostics only. No persistent settings, sockets or world writes. */
export function registerFoundation(host: FoundationHost, moduleVersion: string, localFeatures = false): void {
  if (installedHosts.has(host)) return;
  installedHosts.add(host);
  let ready = false;
  const status = (): FoundationStatus => foundationStatus(moduleVersion, host.game.version, ready, localFeatures);

  host.Hooks.once('init', () => {
    if (!status().supportedGeneration) return;
    host.game.settings.registerMenu(MODULE_ID, 'status', {
      name: 'STAGECRAFT.Status.Title',
      label: 'STAGECRAFT.Status.Open',
      icon: 'fas fa-film',
      type: createStatusApplication(host, status),
      restricted: true
    });
  });

  host.Hooks.once('ready', () => {
    ready = true;
    const module = host.game.modules.get(MODULE_ID);
    if (module) module.api = Object.freeze({ getStatus: status });
  });
}
