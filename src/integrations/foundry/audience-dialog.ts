import type { AudienceUser } from '../../application/audience-resolver.js';
import type { SequenceAudience } from '../../domain/sequence.js';
import { AudiencePicker } from '../../ui/audience-picker.js';

export interface AudienceDialog {
  readonly element: HTMLElement;
}

export interface AudienceDialogConfig {
  window: { title: string };
  position: { width: number };
  classes: string[];
  content: HTMLElement;
  modal: boolean;
  rejectClose: boolean;
  buttons: { action: string; label: string; default?: boolean; callback(): SequenceAudience | false }[];
  render(event: Event, dialog: AudienceDialog): void;
}

export interface AudienceDialogHost {
  users(): readonly AudienceUser[];
  localize(key: string): string;
  wait(config: AudienceDialogConfig): Promise<unknown>;
}

function activeHTMLElement(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || typeof active.focus !== 'function') return null;
  return active;
}

function canRestoreFocus(target: HTMLElement): boolean {
  return target.isConnected
    && !target.hidden
    && typeof target.focus === 'function'
    && !(typeof target.matches === 'function' && target.matches(':disabled'))
    && !(typeof target.closest === 'function' && target.closest('[hidden], [inert]'));
}

function waitForDialogRemoval(dialog: HTMLElement | null): Promise<void> {
  if (!dialog?.isConnected) return Promise.resolve();
  if (typeof MutationObserver === 'undefined' || !document.documentElement) {
    return new Promise(resolve => {
      const check = () => {
        if (!dialog.isConnected) resolve();
        else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(check);
        else setTimeout(check, 16);
      };
      check();
    });
  }
  return new Promise(resolve => {
    const observer = new MutationObserver(() => {
      if (!dialog.isConnected) { observer.disconnect(); resolve(); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (!dialog.isConnected) { observer.disconnect(); resolve(); }
  });
}

function restoreFocusAfterDismissal(target: HTMLElement | null, dialog: HTMLElement | null): void {
  if (!target) return;
  const restore = () => {
    if (dialog?.isConnected) return;
    if (!canRestoreFocus(target)) return;
    const active = document.activeElement;
    const focusWasLeftInDialog = !!dialog && !!active && dialog.contains(active);
    if (active === document.body || focusWasLeftInDialog || !active?.isConnected) target.focus({ preventScroll: true });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
  else setTimeout(restore, 0);
}

/** The dialog captures only this launch's audience; it has no repository or editor access. */
export async function chooseManualAudience(host: AudienceDialogHost, sequenceName: string): Promise<SequenceAudience | null> {
  const returnFocusTo = activeHTMLElement();
  const picker = new AudiencePicker(host.users(), host.localize);
  const content = document.createElement('div');
  const heading = document.createElement('strong');
  heading.className = 'stagecraft-audience-sequence-name';
  heading.textContent = sequenceName;
  content.append(heading, picker.element);
  let chosen: SequenceAudience | null = null;
  let dialogDismissed = false;
  let primary: HTMLButtonElement | null = null;
  let dialogElement: HTMLElement | null = null;
  let mounted = false;
  const refresh = () => { if (primary) primary.disabled = !mounted || !picker.valid; };
  picker.element.addEventListener('change', refresh);
  try {
    await host.wait({
      window: { title: host.localize('STAGECRAFT.Audience.Title') },
      position: { width: 380 }, classes: ['stagecraft-audience-dialog'],
      content, modal: true, rejectClose: false,
      buttons: [
        { action: 'prepare', label: host.localize('STAGECRAFT.Audience.Prepare'), default: true,
          callback: () => { chosen = mounted ? picker.read() : null; return chosen ?? false; } },
        { action: 'cancel', label: host.localize('STAGECRAFT.Audience.Cancel'),
          callback: () => { chosen = null; return false; } }
      ],
      render(_event, dialog) {
        // DialogV2 stringifies content. Reattach the live nodes to retain current values and listeners.
        dialogElement = dialog.element;
        const panel = dialog.element.querySelector<HTMLElement>('.dialog-content');
        mounted = !!panel;
        panel?.replaceChildren(content);
        primary = dialog.element.querySelector<HTMLButtonElement>('button[data-action="prepare"]');
        refresh();
      }
    });
    dialogDismissed = true;
    return chosen;
  } finally {
    picker.element.removeEventListener('change', refresh);
    if (dialogDismissed && chosen === null) {
      await waitForDialogRemoval(dialogElement);
      restoreFocusAfterDismissal(returnFocusTo, dialogElement);
    }
  }
}
