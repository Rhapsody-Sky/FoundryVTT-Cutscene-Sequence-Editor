export type ValidatedField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

let nextErrorId = 0;

/** Hidden tab pages retain their form values and constraints. Conditional rows do not. */
export function isValidationCandidate(field: ValidatedField): boolean {
  if (field.isConnected === false || field.disabled || field.matches(':disabled') || field.type === 'hidden' || field.willValidate === false) return false;
  for (let node: HTMLElement | null = field; node; node = node.parentElement) {
    if (node.hidden && node.dataset.stagecraftInspectorPage === undefined && node.dataset.stagecraftClipSectionPage === undefined) return false;
  }
  return true;
}

/** Owns only its inline errors and description tokens; native constraints own the rules. */
export class FormValidation {
  private readonly errors = new Map<ValidatedField, HTMLElement>();
  private readonly previousInvalid = new WeakMap<ValidatedField, string | null>();

  check(fields: readonly ValidatedField[], show: true | readonly ValidatedField[] = []): ValidatedField[] {
    const invalid = fields.filter(field => isValidationCandidate(field) && !(field.validity?.valid ?? field.checkValidity()));
    for (const field of this.errors.keys()) if (!invalid.includes(field)) this.clear(field);
    for (const field of invalid) {
      if (show === true || show.includes(field) || this.errors.has(field)) this.show(field);
    }
    return invalid;
  }

  clearAll(): void { for (const field of this.errors.keys()) this.clear(field); }

  /** Paint/busy-state updates need only recover errors that are already visible. */
  refresh(): void { this.check([...this.errors.keys()]); }

  private show(field: ValidatedField): void {
    // validationMessage is translated by the browser and covers required, bounds,
    // steps, patterns and future native constraints without a parallel catalogue.
    const message = field.validationMessage;
    if (!message) return;
    let error = this.errors.get(field);
    if (!error) {
      error = field.ownerDocument.createElement('span');
      error.id = `stagecraft-field-error-${++nextErrorId}`;
      error.className = 'stagecraft-field-error';
      // The message sits in a wrapping label for layout. Exclude it from the
      // label's name; its direct aria-describedby reference still exposes the
      // text as the field's description, including when aria-hidden is true.
      error.setAttribute('aria-hidden', 'true');
      // File pickers share a flex row with Browse. Put the message after that
      // row so it wraps normally instead of separating its controls.
      const anchor = field.closest<HTMLElement>('.stagecraft-file-field') ?? field;
      anchor.parentElement?.insertBefore(error, anchor.nextSibling);
      this.errors.set(field, error);
      this.previousInvalid.set(field, field.getAttribute('aria-invalid'));
      const descriptions = field.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
      field.setAttribute('aria-describedby', [...descriptions, error.id].join(' '));
    }
    if (error.textContent !== message) error.textContent = message;
    if (field.getAttribute('aria-invalid') !== 'true') field.setAttribute('aria-invalid', 'true');
  }

  private clear(field: ValidatedField): void {
    const error = this.errors.get(field);
    if (!error) return;
    const descriptions = (field.getAttribute('aria-describedby')?.split(/\s+/) ?? []).filter(id => id && id !== error.id);
    if (descriptions.length) field.setAttribute('aria-describedby', descriptions.join(' '));
    else field.removeAttribute('aria-describedby');
    const previousInvalid = this.previousInvalid.get(field);
    if (previousInvalid !== null && previousInvalid !== undefined) field.setAttribute('aria-invalid', previousInvalid);
    else field.removeAttribute('aria-invalid');
    this.previousInvalid.delete(field);
    error.remove();
    this.errors.delete(field);
  }
}
