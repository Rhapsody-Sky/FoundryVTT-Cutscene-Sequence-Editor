export type ClipInspectorSection = "content" | "animation" | "timing";
type ClipSection = ClipInspectorSection;
export type ClipInspectorSelectionType = "bars" | "text" | "image" | "solid" | "video" | "audio" | "button" | "break" | null;
export type ClipInspectorSectionBeforeChange = (from: ClipSection | null, to: ClipSection | null) => void;

const SECTIONS = ["content", "animation", "timing"] as const satisfies readonly ClipSection[];

/** Switches the selected clip's inspector pages without changing any form state. */
export class ClipInspectorSections {
  private readonly controller = new AbortController();
  private readonly tabs = new Map<ClipSection, HTMLButtonElement>();
  private readonly pages: HTMLElement[];
  private readonly toolbar: HTMLElement | null;
  private readonly scrollContainer: HTMLElement | null;
  private readonly beforeChange: ClipInspectorSectionBeforeChange | undefined;
  private readonly scrollPositions = new Map<ClipSection, number>();
  private selectedType: ClipInspectorSelectionType = null;
  private identity: string | undefined;
  private activeSection: ClipSection | null = null;
  private visible = true;
  private resetScrollOnShow = false;

  constructor(private readonly root: HTMLElement, beforeChange?: ClipInspectorSectionBeforeChange) {
    this.beforeChange = beforeChange;
    for (const tab of root.querySelectorAll<HTMLButtonElement>("[data-stagecraft-clip-section-tab]")) {
      const section = tab.dataset.stagecraftClipSectionTab;
      if (isSection(section)) this.tabs.set(section, tab);
    }
    this.toolbar = root.querySelector<HTMLElement>("[data-stagecraft-clip-section-tabs]");
    this.scrollContainer = root.querySelector<HTMLElement>("[data-stagecraft-inspector]");
    const clipPage = root.querySelector<HTMLElement>('[data-stagecraft-inspector-page="clip"]');
    this.pages = [...root.querySelectorAll<HTMLElement>("[data-stagecraft-clip-section-page]")]
      .filter(page => !clipPage || clipPage.contains(page));

    for (const [section, tab] of this.tabs) {
      tab.addEventListener("click", () => this.activate(section), { signal: this.controller.signal });
    }
    this.toolbar?.addEventListener("keydown", event => this.onKeyDown(event as KeyboardEvent), { signal: this.controller.signal });
    this.render();
  }

  dispose(): void {
    this.controller.abort();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.resetScrollOnShow) {
      if (this.scrollContainer && this.activeSection) {
        this.scrollContainer.scrollTop = this.scrollPositions.get(this.activeSection) ?? 0;
      }
      this.resetScrollOnShow = false;
    }
    this.renderToolbar();
    const focused = this.root.ownerDocument?.activeElement as HTMLElement | null | undefined;
    if (!visible && focused && this.toolbar?.contains(focused)) {
      focused.blur();
    }
  }

  setSelection(type: ClipInspectorSelectionType, identity?: string): void {
    const changedIdentity = type !== this.selectedType || identity !== this.identity;
    const focused = this.root.ownerDocument?.activeElement as HTMLElement | null | undefined;
    const previousPages = this.activePages();
    const previousSection = this.activeSection;

    this.selectedType = type;
    this.identity = identity;
    if (changedIdentity) this.scrollPositions.clear();

    const available = this.availableSections();
    if (type === null || available.length === 0) {
      this.activeSection = null;
    } else if (changedIdentity || !this.activeSection || !available.includes(this.activeSection)) {
      this.activeSection = available.includes("content") ? "content" : available[0] ?? null;
    }

    const categoryChanged = this.activeSection !== previousSection;
    this.render();
    if (changedIdentity || categoryChanged) {
      if (this.visible) {
        if (this.scrollContainer && this.activeSection) this.scrollContainer.scrollTop = this.scrollPositions.get(this.activeSection) ?? 0;
        this.resetScrollOnShow = false;
      } else {
        // The outer Sequence page shares this scroller; reset after its tab switch restores the Clip page.
        this.resetScrollOnShow = true;
      }
    }
    const nextPages = this.activePages();
    if (focused && this.root.ownerDocument?.activeElement === focused
      && previousPages.some(page => page.contains(focused)) && !nextPages.some(page => page.contains(focused))) {
      if (this.visible && this.activeSection) this.tabs.get(this.activeSection)?.focus();
      else focused.blur();
    }
  }

  private availableSections(): ClipSection[] {
    if (this.selectedType === null) return [];
    return SECTIONS.filter(section => this.pagesFor(section).length > 0);
  }

  private pagesFor(section: ClipSection): HTMLElement[] {
    if (this.selectedType === null) return [];

    if (this.selectedType === "break") {
      if (section !== "timing") return [];
      return this.pages.filter(page => page.dataset.stagecraftClipSectionPage === section
        && page.closest("[data-stagecraft-break-panel]") !== null);
    }

    const typedPages = this.pages.filter(page => page.dataset.stagecraftClipSectionPage === section
      && page.closest("[data-stagecraft-break-panel]") === null
      && page.closest<HTMLElement>("[data-stagecraft-element-panel]")?.dataset.stagecraftElementPanel === this.selectedType);

    if (section !== "timing") return typedPages;
    const sharedPage = this.pages.find(page => page.dataset.stagecraftClipSectionPage === section
      && page.dataset.stagecraftClipSectionShared !== undefined
      && page.closest("[data-stagecraft-break-panel]") === null
      && page.closest("[data-stagecraft-element-panel]") === null);
    return sharedPage && !typedPages.includes(sharedPage) ? [...typedPages, sharedPage] : typedPages;
  }

  private activePages(): HTMLElement[] {
    return this.activeSection ? this.pagesFor(this.activeSection) : [];
  }

  private activate(section: ClipSection): void {
    if (!this.visible) return;
    if (!this.availableSections().includes(section)) return;
    if (this.activeSection === section) return;

    const focused = this.root.ownerDocument?.activeElement as HTMLElement | null | undefined;
    const previousPages = this.activePages();
    if (this.activeSection && this.scrollContainer) {
      this.scrollPositions.set(this.activeSection, this.scrollContainer.scrollTop);
    }
    const selectedType = this.selectedType;
    const identity = this.identity;
    this.beforeChange?.(this.activeSection, section);
    if (this.selectedType !== selectedType || this.identity !== identity || !this.availableSections().includes(section)) return;
    this.activeSection = section;
    this.render();
    if (this.scrollContainer) this.scrollContainer.scrollTop = this.scrollPositions.get(section) ?? 0;
    const nextPages = this.activePages();
    if (focused && this.root.ownerDocument?.activeElement === focused
      && previousPages.some(page => page.contains(focused)) && !nextPages.some(page => page.contains(focused))) {
      this.tabs.get(section)?.focus();
    }
  }

  private render(): void {
    const activePages = this.activePages();
    for (const page of this.pages) page.hidden = !activePages.includes(page);

    for (const [section, tab] of this.tabs) {
      const pages = this.pagesFor(section);
      const available = pages.length > 0;
      const active = available && section === this.activeSection;
      tab.hidden = !available;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const pageIds = pages.map(page => page.id).filter(Boolean);
      if (pageIds.length) tab.setAttribute("aria-controls", pageIds.join(" "));
      else tab.removeAttribute("aria-controls");
    }

    this.renderToolbar();
  }

  private renderToolbar(): void {
    if (this.toolbar) this.toolbar.hidden = !this.visible || this.selectedType === null || this.activeSection === null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    const current = [...this.tabs.entries()].find(([, tab]) => tab === event.target)?.[0];
    if (!current || !this.availableSections().includes(current)) return;

    const available = this.availableSections();
    if (!available.length) return;

    let next: ClipSection | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = this.adjacent(current, 1, available);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = this.adjacent(current, -1, available);
    else if (event.key === "Home") next = available[0];
    else if (event.key === "End") next = available.at(-1);
    if (!next) return;

    event.preventDefault();
    event.stopPropagation();
    this.tabs.get(next)?.focus();
    this.activate(next);
  }

  private adjacent(current: ClipSection, direction: 1 | -1, available: readonly ClipSection[]): ClipSection | undefined {
    if (available.length < 2) return undefined;
    const index = available.indexOf(current);
    return available[(index + direction + available.length) % available.length];
  }
}

function isSection(value: string | undefined): value is ClipSection {
  return value === "content" || value === "animation" || value === "timing";
}
