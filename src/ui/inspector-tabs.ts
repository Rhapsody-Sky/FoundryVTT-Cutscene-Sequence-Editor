type InspectorTab = "clip" | "sequence";

/** Keeps the clip and sequence settings reachable in separate inspector pages. */
export class InspectorTabs {
  private readonly controller = new AbortController();
  private readonly tabs = new Map<InspectorTab, HTMLButtonElement>();
  private readonly pages = new Map<InspectorTab, HTMLElement>();
  private readonly scrollPositions = new Map<InspectorTab, number>();
  private readonly scrollContainer: HTMLElement | null;
  private readonly onChange: ((tab: InspectorTab) => void) | undefined;
  private activeTab: InspectorTab = "clip";

  constructor(root: HTMLElement, onChange?: (tab: InspectorTab) => void) {
    this.onChange = onChange;
    for (const tab of root.querySelectorAll<HTMLButtonElement>("[data-stagecraft-inspector-tab]")) {
      const name = tab.dataset.stagecraftInspectorTab;
      if (name === "clip" || name === "sequence") this.tabs.set(name, tab);
    }
    for (const page of root.querySelectorAll<HTMLElement>("[data-stagecraft-inspector-page]")) {
      const name = page.dataset.stagecraftInspectorPage;
      if (name === "clip" || name === "sequence") this.pages.set(name, page);
    }
    this.scrollContainer = root.querySelector<HTMLElement>("[data-stagecraft-inspector]");

    for (const [name, tab] of this.tabs) {
      tab.addEventListener("click", () => this.activate(name), { signal: this.controller.signal });
    }
    root.querySelector<HTMLElement>(".stagecraft-inspector-tabs")?.addEventListener("keydown", (event) => {
      const keyEvent = event as KeyboardEvent;
      const current = keyEvent.target instanceof HTMLElement
        ? [...this.tabs.entries()].find(([, tab]) => tab === keyEvent.target)?.[0]
        : undefined;
      if (!current) return;

      let next: InspectorTab | undefined;
      if (keyEvent.key === "ArrowRight" || keyEvent.key === "ArrowDown") next = this.adjacent(current, 1);
      else if (keyEvent.key === "ArrowLeft" || keyEvent.key === "ArrowUp") next = this.adjacent(current, -1);
      else if (keyEvent.key === "Home") next = this.availableTabs()[0];
      else if (keyEvent.key === "End") next = this.availableTabs().at(-1);
      if (!next) return;

      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      this.tabs.get(next)?.focus();
      this.activate(next);
    }, { signal: this.controller.signal });

    this.activate("clip");
  }

  dispose(): void {
    this.controller.abort();
  }

  showClip(): void {
    this.activate("clip");
  }

  setSelectionLabel(label: string): void {
    const tab = this.tabs.get("clip");
    if (tab) tab.textContent = label;
  }

  private availableTabs(): InspectorTab[] {
    return (["clip", "sequence"] as const).filter((name) => this.tabs.has(name) && this.pages.has(name));
  }

  private adjacent(current: InspectorTab, direction: 1 | -1): InspectorTab | undefined {
    const tabs = this.availableTabs();
    if (tabs.length < 2) return undefined;
    const index = tabs.indexOf(current);
    return tabs[(index + direction + tabs.length) % tabs.length];
  }

  private activate(name: InspectorTab): void {
    if (!this.tabs.has(name) || !this.pages.has(name)) return;
    const changed = this.activeTab !== name;
    if (changed) {
      if (this.scrollContainer) this.scrollPositions.set(this.activeTab, this.scrollContainer.scrollTop);
      this.activeTab = name;
    }

    for (const tabName of ["clip", "sequence"] as const) {
      const active = tabName === name;
      const tab = this.tabs.get(tabName);
      const page = this.pages.get(tabName);
      if (tab) {
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      }
      if (page) page.hidden = !active;
    }
    if (changed && this.scrollContainer) this.scrollContainer.scrollTop = this.scrollPositions.get(name) ?? 0;
    this.onChange?.(name);
  }
}
