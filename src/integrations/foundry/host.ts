/** Small, locally owned adapter surface. This is NOT a copy of the Foundry type library. */
export interface StatusApplicationInstance {
  render(options?: { force?: boolean }): Promise<unknown>;
  _prepareContext(options: unknown): Promise<Record<string, unknown>>;
}

export interface StatusApplicationConstructor {
  new (options?: unknown): StatusApplicationInstance;
  DEFAULT_OPTIONS: Record<string, unknown>;
}

export interface FoundationHost {
  readonly Hooks: { once(event: 'init' | 'ready', callback: () => void): unknown };
  readonly game: {
    readonly version: string;
    readonly user?: { readonly isGM: boolean };
    readonly modules: { get(id: string): { api?: unknown } | undefined };
    readonly settings: {
      registerMenu(namespace: string, key: string, config: {
        name: string;
        label: string;
        hint?: string;
        icon: string;
        type: StatusApplicationConstructor;
        restricted: boolean;
      }): void;
    };
  };
  readonly foundry: {
    readonly applications: {
      readonly api: {
        readonly ApplicationV2: StatusApplicationConstructor;
        readonly HandlebarsApplicationMixin: (base: StatusApplicationConstructor) => StatusApplicationConstructor;
      };
    };
  };
}

/** Foundry creates game during startup; access its members inside hooks, not at module evaluation. */
export function readHost(): FoundationHost {
  return globalThis as unknown as FoundationHost;
}
