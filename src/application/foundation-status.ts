export { MODULE_ID } from '../module-identity.js';

export interface FoundationStatus {
  readonly moduleVersion: string;
  readonly foundryVersion: string;
  readonly supportedGeneration: boolean;
  readonly ready: boolean;
  readonly playbackAvailable: boolean;
  readonly persistenceAvailable: boolean;
  readonly transportAvailable: false;
}

export function foundationStatus(moduleVersion: string, foundryVersion: string, ready: boolean, localFeatures = false): FoundationStatus {
  return Object.freeze({
    moduleVersion,
    foundryVersion,
    supportedGeneration: /^14\.\d+(?:\.\d+)?$/.test(foundryVersion),
    ready,
    playbackAvailable: ready && localFeatures,
    persistenceAvailable: ready && localFeatures,
    transportAvailable: false
  });
}
