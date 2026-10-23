export interface TimelineContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface TimelineContextMenuOptions {
  x: number;
  y: number;
  items: readonly TimelineContextMenuItem[];
  onSelect: (id: string) => void;
  anchor?: HTMLElement;
}

type DismissListener = {
  target: EventTarget;
  type: string;
  listener: EventListener;
  capture?: boolean;
};

/** A small document-level menu that stays clear of the timeline's clipping layers. */
export class TimelineContextMenu {
  private readonly root: HTMLElement;
  private menu: HTMLDivElement | null = null;
  private anchor: HTMLElement | undefined;
  private document: Document | undefined;
  private dismissListeners: DismissListener[] = [];
  private disposed = false;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  get isOpen(): boolean {
    return this.menu !== null;
  }

  open(options: TimelineContextMenuOptions): void {
    if (this.disposed) return;
    this.close();

    const document = this.root.ownerDocument ?? (typeof globalThis.document !== 'undefined' ? globalThis.document : undefined);
    if (!document?.createElement) return;

    const menu = document.createElement('div');
    menu.className = 'stagecraft-timeline-context-menu';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;

    const buttons: HTMLButtonElement[] = [];
    for (const item of options.items) {
      if (item.separatorBefore && menu.childElementCount > 0) {
        const separator = document.createElement('div');
        separator.className = 'stagecraft-timeline-context-menu__separator';
        separator.setAttribute('role', 'separator');
        separator.setAttribute('aria-orientation', 'horizontal');
        menu.append(separator);
      }

      const button = document.createElement('button');
      button.className = 'stagecraft-timeline-context-menu__item';
      button.type = 'button';
      button.tabIndex = -1;
      button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-disabled', String(item.disabled === true));
      button.disabled = item.disabled === true;

      if (item.icon) {
        const icon = document.createElement('i');
        const classes = item.icon.trim().split(/\s+/).filter(name => /^[a-zA-Z0-9_-]+$/.test(name));
        if (classes.length) icon.className = classes.join(' ');
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);
      }

      const label = document.createElement('span');
      label.className = 'stagecraft-timeline-context-menu__label';
      label.textContent = item.label;
      button.append(label);

      if (item.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'stagecraft-timeline-context-menu__shortcut';
        shortcut.textContent = item.shortcut;
        shortcut.setAttribute('aria-hidden', 'true');
        button.append(shortcut);
      }

      button.addEventListener('click', () => {
        if (item.disabled === true || this.menu !== menu) return;
        const onSelect = options.onSelect;
        const anchor = this.anchor;
        const document = this.document;
        this.close();
        try {
          onSelect(item.id);
        } finally {
          this.restoreFocus(anchor, document);
        }
      });
      menu.append(button);
      buttons.push(button);
    }

    menu.addEventListener('keydown', event => this.onKeyDown(event, menu, buttons));
    menu.style.left = '0px';
    menu.style.top = '0px';
    (document.body ?? this.root).append(menu);

    this.menu = menu;
    this.anchor = options.anchor;
    this.document = document;
    this.position(menu, document, options.x, options.y);
    this.listenForDismissal(document, menu);

    (buttons.find(button => !button.disabled) ?? menu).focus({ preventScroll: true });
  }

  close(restoreFocus = false): void {
    const anchor = this.anchor;
    const document = this.document;
    this.clearDismissListeners();
    this.menu?.remove();
    this.menu = null;
    this.anchor = undefined;
    this.document = undefined;
    if (restoreFocus) this.restoreFocus(anchor, document);
  }

  dispose(): void {
    this.close();
    this.disposed = true;
  }

  private onKeyDown(event: KeyboardEvent, menu: HTMLDivElement, buttons: readonly HTMLButtonElement[]): void {
    if (this.menu !== menu) return;
    event.stopPropagation();
    const enabled = buttons.filter(button => !button.disabled);
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close(true);
      return;
    }
    if (enabled.length === 0) return;

    const activeIndex = enabled.indexOf(this.document?.activeElement as HTMLButtonElement);
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % enabled.length;
    else if (event.key === 'ArrowUp') nextIndex = activeIndex < 0 ? enabled.length - 1 : (activeIndex - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = enabled.length - 1;

    if (nextIndex !== undefined) {
      event.preventDefault();
      enabled[nextIndex]!.focus();
    } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      // Keep native button activation intact; only stop the editor's global shortcuts.
    } else if (event.target === menu && event.key === 'Tab') {
      // Tab is allowed to leave the menu and follows the browser's normal focus order.
    }
  }

  private position(menu: HTMLDivElement, document: Document, requestedX: number, requestedY: number): void {
    const window = document.defaultView;
    const rect = menu.getBoundingClientRect();
    const menuWidth = rect.width || menu.offsetWidth;
    const menuHeight = rect.height || menu.offsetHeight;
    const viewportWidth = window?.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight = window?.innerHeight || document.documentElement?.clientHeight || 0;
    const x = Number.isFinite(requestedX) ? requestedX : 0;
    const y = Number.isFinite(requestedY) ? requestedY : 0;
    const left = Math.max(0, Math.min(x, viewportWidth - menuWidth));
    const top = Math.max(0, Math.min(y, viewportHeight - menuHeight));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  private listenForDismissal(document: Document, menu: HTMLDivElement): void {
    // Selecting a clip rebuilds the timeline before opening this portal. Restoring
    // the new scrollers queues native scroll events which arrive after open().
    // Only actual movement since opening invalidates the menu's position.
    const scrollOffsets = new Map<Element, { left: number; top: number }>();
    const remember = (element: Element) => {
      scrollOffsets.set(element, { left: element.scrollLeft, top: element.scrollTop });
    };
    for (const element of this.root.querySelectorAll('*')) remember(element);
    for (let element: Element | null = this.root; element; element = element.parentElement) remember(element);
    if (document.scrollingElement) remember(document.scrollingElement);
    const outside = (event: Event) => {
      const target = event.target;
      if (target && menu.contains(target as Node)) return;
      this.close();
    };
    const closeOnChange = () => this.close();
    this.addDismissListener(document, 'pointerdown', outside, true);
    this.addDismissListener(document, 'contextmenu', outside, true);
    this.addDismissListener(document, 'scroll', event => {
      if (event.target && menu.contains(event.target as Node)) return;
      const scroller = event.target === document ? document.scrollingElement : event.target as Element | null;
      const initial = scroller ? scrollOffsets.get(scroller) : undefined;
      if (initial && scroller && (scroller.scrollLeft !== initial.left || scroller.scrollTop !== initial.top)) closeOnChange();
    }, true);
    if (document.defaultView) this.addDismissListener(document.defaultView, 'resize', closeOnChange);
  }

  private addDismissListener(target: EventTarget, type: string, listener: EventListener, capture = false): void {
    target.addEventListener(type, listener, capture);
    this.dismissListeners.push({ target, type, listener, capture });
  }

  private clearDismissListeners(): void {
    for (const { target, type, listener, capture } of this.dismissListeners) {
      target.removeEventListener(type, listener, capture);
    }
    this.dismissListeners = [];
  }

  private restoreFocus(anchor: HTMLElement | undefined, document: Document | undefined): void {
    if (!anchor || !document) return;
    const connected = typeof anchor.isConnected === 'boolean'
      ? anchor.isConnected
      : Boolean(document.documentElement?.contains(anchor) || document.body?.contains(anchor));
    if (!connected) return;
    try {
      anchor.focus({ preventScroll: true });
    } catch {
      try { anchor.focus(); } catch { /* The anchor may have been detached during the action. */ }
    }
  }
}
