export interface ColorPreviewSession {
  preview(value: string): void;
  commit(value: string): void;
}

export interface ColorPreviewRuntime {
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}

/** Native color dialogs emit many input events per paint. Keep only their latest
 * value; change and editor boundaries always commit synchronously. */
export class ColorInputPreview {
  private active: { input: HTMLInputElement; value: string; session: ColorPreviewSession } | undefined;
  private frame: number | undefined;

  constructor(private readonly begin: (input: HTMLInputElement) => ColorPreviewSession | undefined,
    private readonly runtime: ColorPreviewRuntime) {}

  input(input: HTMLInputElement): void {
    if (this.active?.input !== input) {
      this.finish();
      const session = this.begin(input);
      if (!session) return;
      this.active = { input, value: input.value, session };
    } else this.active.value = input.value;
    if (this.frame === undefined) this.frame = this.runtime.requestFrame(() => {
      this.frame = undefined;
      const active = this.active;
      if (active) active.session.preview(active.value);
    });
  }

  change(input: HTMLInputElement): void {
    this.input(input);
    this.finish();
  }

  finish(): void {
    const active = this.active;
    this.cancel();
    if (active) active.session.commit(active.value);
  }

  cancel(): void {
    if (this.frame !== undefined) this.runtime.cancelFrame(this.frame);
    this.frame = undefined;
    this.active = undefined;
  }
}
