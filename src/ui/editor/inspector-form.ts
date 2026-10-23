export type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
export interface InspectorValueFields {
  field<T extends FieldElement = HTMLInputElement>(name: string): T | null;
}

/** DOM-only inspector access. No draft, playback, selection or history state lives here. */
export class InspectorForm implements InspectorValueFields {
  constructor(readonly root: HTMLElement | null, readonly localize: (key: string) => string,
    private readonly lookup: InspectorValueFields['field']) {}

  field<T extends FieldElement = HTMLInputElement>(name: string): T | null { return this.lookup<T>(name); }
  t(key: string): string { return this.localize('STAGECRAFT.Editor.' + key); }
  setValue(name: string, value: string): void {
    const field = this.field(name);
    if (field && field.value !== value) field.value = value;
  }
  setChecked(name: string, value: boolean): void {
    const field = this.field<HTMLInputElement>(name);
    if (field) field.checked = value;
  }
  setOutput(selector: string, value: string): void {
    const output = this.root?.querySelector<HTMLOutputElement>(selector);
    if (output && output.value !== value) output.value = value;
  }
  setFontValue(value: string, name = 'title-font'): void {
    const select = this.field<HTMLSelectElement>(name);
    if (!select) return;
    if (!Array.from(select.options).some(option => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.value = value;
  }
}
