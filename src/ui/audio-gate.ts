interface AudioUnlockRequest {
  readonly unlock: () => Promise<void>;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
  running: boolean;
}

interface AudioGatePanel {
  readonly node: HTMLElement;
  readonly enable: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly error: HTMLElement;
}

/** One local gesture gate; never changes group state or starts the shared timeline. */
export class AudioGate {
  private readonly pending = new Set<AudioUnlockRequest>();
  private panel: AudioGatePanel | null = null;
  private disposed = false;

  constructor(private readonly localize: (key: string) => string) {}

  request(unlock: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.disposed) return Promise.reject(new Error('MEDIA_CANCELLED'));
    return new Promise<void>((resolve, reject) => {
      const request: AudioUnlockRequest = {
        unlock, signal, resolve, reject, running: false,
        abort: () => this.finish(request, new Error('MEDIA_CANCELLED'))
      };
      this.pending.add(request);
      signal.addEventListener('abort', request.abort, { once: true });
      this.showPanel();
      this.refreshButton();
      if (signal.aborted) request.abort();
    });
  }

  private showPanel(): void {
    if (this.panel) return;
    const node = document.createElement('section');
    node.className = 'stagecraft-audio-gate'; node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', this.localize('STAGECRAFT.Audio.Enable'));
    const label = document.createElement('p'); label.textContent = this.localize('STAGECRAFT.Audio.Required');
    const error = document.createElement('p'); error.setAttribute('role', 'status');
    const enable = document.createElement('button'); enable.type = 'button'; enable.textContent = this.localize('STAGECRAFT.Audio.Enable');
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = this.localize('STAGECRAFT.Audio.Cancel');
    node.append(label, enable, cancel, error); document.body.append(node);
    this.panel = { node, enable, cancel, error };
    enable.addEventListener('click', this.enablePending);
    cancel.addEventListener('click', this.cancelPending);
    window.addEventListener('keydown', this.escape, true);
  }

  private refreshButton(): void {
    if (this.panel) this.panel.enable.disabled = ![...this.pending].some(request => !request.running);
  }

  private readonly enablePending = (): void => {
    const panel = this.panel;
    if (!panel || this.disposed) return;
    panel.error.textContent = '';
    const requests = [...this.pending].filter(request => !request.running);
    // Every gesture-sensitive call runs in this click's synchronous stack,
    // before handling any promise. Mark the batch first to prevent duplicates.
    for (const request of requests) request.running = true;
    this.refreshButton();
    for (const request of requests) {
      if (!this.pending.has(request)) continue;
      let result: Promise<void>;
      try { result = request.unlock(); }
      catch { this.failed(request, panel); continue; }
      void Promise.resolve(result).then(() => this.finish(request), () => this.failed(request, panel));
    }
  };

  private failed(request: AudioUnlockRequest, panel: AudioGatePanel): void {
    if (!this.pending.has(request)) return;
    request.running = false;
    if (this.panel === panel) panel.error.textContent = this.localize('STAGECRAFT.Error.MEDIA_AUTOPLAY');
    this.refreshButton();
  }

  private finish(request: AudioUnlockRequest, error?: Error): void {
    if (!this.pending.delete(request)) return;
    request.signal.removeEventListener('abort', request.abort);
    if (error) request.reject(error); else request.resolve();
    if (!this.pending.size) this.removePanel(); else this.refreshButton();
  }

  private readonly cancelPending = (): void => {
    for (const request of [...this.pending]) this.finish(request, new Error('MEDIA_CANCELLED'));
  };

  private readonly escape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); this.cancelPending(); }
  };

  private removePanel(): void {
    if (!this.panel) return;
    this.panel.enable.removeEventListener('click', this.enablePending);
    this.panel.cancel.removeEventListener('click', this.cancelPending);
    window.removeEventListener('keydown', this.escape, true);
    this.panel.node.remove(); this.panel = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending(); this.removePanel();
  }
}
