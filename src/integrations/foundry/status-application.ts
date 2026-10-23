import { MODULE_ID, type FoundationStatus } from '../../application/foundation-status.js';
import type { FoundationHost, StatusApplicationConstructor } from './host.js';

export function createStatusApplication(host: FoundationHost, readStatus: () => FoundationStatus): StatusApplicationConstructor {
  const Base = host.foundry.applications.api.HandlebarsApplicationMixin(host.foundry.applications.api.ApplicationV2);
  return class FoundationStatusApplication extends Base {
    static override DEFAULT_OPTIONS = {
      id: `${MODULE_ID}-status`,
      classes: ['stagecraft-status'],
      tag: 'section',
      window: { title: 'STAGECRAFT.Status.Title', resizable: true },
      position: { width: 560, height: 'auto' }
    };

    static PARTS = {
      content: { template: `modules/${MODULE_ID}/templates/status.hbs` }
    };

    override async _prepareContext(options: unknown): Promise<Record<string, unknown>> {
      return { ...await super._prepareContext(options), status: readStatus() };
    }
  };
}
