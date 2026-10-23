import { MODULE_ID } from '../../application/foundation-status.js';
import type { SequenceRepository, SequenceSummary } from '../../application/ports.js';
import type { SequenceV1 } from '../../domain/sequence.js';
import { validateSequence } from '../../domain/validation.js';

interface Tool {
  name: string; order: number; title: string; icon: string; button: true;
  onChange(): void;
}
export interface SceneControl {
  name: string; order: number; title: string; icon: string;
  tools: Record<string, Tool>;
  onChange(event: Event, active: boolean): void;
}
interface ShortcutServices {
  isGM(): boolean;
  repository: SequenceRepository;
  openEditor(): Promise<unknown>;
  openPlayback(): void;
  prepare(sequence: SequenceV1): Promise<void>;
  localize(key: string): string;
  repaint(): void;
  report(error: unknown): void;
}

/** A read-only launcher over the existing repository and group preparation path. */
export class SceneShortcuts {
  private items: readonly SequenceSummary[] = [];
  private refreshing = false;
  private refreshAgain = false;
  private busy = false;
  private disposed = false;
  constructor(private readonly services: ShortcutServices) {}

  populate(controls: Record<string, SceneControl>): void {
    if (!this.services.isGM() || this.disposed) return;
    const tools: Record<string, Tool> = {
      editor: {name:'editor', order:0, title:'STAGECRAFT.Editor.Open', icon:'fa-solid fa-pen-to-square', button:true,
        onChange:()=>{ void this.act(()=>this.services.openEditor()); }},
      playback: {name:'playback', order:1, title:'STAGECRAFT.Orchestration.Title', icon:'fa-solid fa-sliders', button:true,
        onChange:()=>{ void this.act(async()=>this.services.openPlayback()); }}
    };
    this.items.forEach((item, index) => {
      const name = `sequence-${index}`;
      tools[name] = {name, order:index+2, title:item.name,
        icon:item.issue ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-play', button:true,
        onChange:()=>{ void this.act(async()=>{
          // Re-read on every click: never launch a cached revision or an editor's unsaved draft.
          const sequence = validateSequence(await this.services.repository.read(item.id));
          if (!this.services.isGM() || this.disposed) return;
          await this.services.prepare(sequence);
        }); }};
    });
    controls[MODULE_ID] = {
      name:MODULE_ID, order:Math.max(0,...Object.values(controls).map(control=>control.order))+1,
      title:'STAGECRAFT.Controls.Title', icon:'fa-solid fa-clapperboard', tools,
      onChange:(_event,active)=>{if(active) void this.refresh();}
    };
  }

  async refresh(): Promise<void> {
    if (!this.services.isGM() || this.disposed) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const items = [...await this.services.repository.list()]
          .sort((a,b)=>a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        if (this.disposed || !this.services.isGM()) return;
        if (JSON.stringify(items) !== JSON.stringify(this.items)) {
          this.items = items;
          this.services.repaint();
        }
      } while(this.refreshAgain);
    } catch(error) { if(!this.disposed) this.services.report(error); }
    finally { this.refreshing = false; }
  }

  decorate(element: HTMLElement, active: boolean): void {
    const menu = element.querySelector<HTMLElement>('#scene-controls-tools');
    if (!menu) return;
    menu.classList.toggle('stagecraft-scene-shortcuts', active);
    if (!active) return;
    for(const button of menu.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
      const index = Number(button.dataset.tool?.replace('sequence-',''));
      const item = this.items[index];
      // textContent keeps user-authored names literal, including strings resembling markup/i18n keys.
      const title = button.dataset.tool === 'editor' ? this.services.localize('STAGECRAFT.Editor.Open')
        : button.dataset.tool === 'playback' ? this.services.localize('STAGECRAFT.Orchestration.Title') : item?.name;
      if(title === undefined) continue;
      button.setAttribute('aria-label',title);
      let label = button.querySelector<HTMLElement>('.stagecraft-shortcut-label');
      if(!label) {label=document.createElement('span');label.className='stagecraft-shortcut-label';button.append(label);}
      label.textContent = title;
      button.disabled = this.busy || !!item?.issue;
    }
  }

  dispose(): void { this.disposed = true; }
  private async act(work:()=>Promise<unknown>): Promise<void> {
    if (this.busy || this.disposed || !this.services.isGM()) return;
    this.busy=true;
    this.services.repaint();
    try {await work();}
    catch(error) {if(!this.disposed) this.services.report(error);}
    finally {this.busy=false;if(!this.disposed) this.services.repaint();}
  }
}
