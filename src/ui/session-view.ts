import type { SessionCoordinator } from '../application/session-coordinator.js';

/** Persistent transport controls also travel into the fullscreen surface's top layer. */
export class SessionView {
  readonly element = document.createElement('section');
  private opened = false;
  private busy = false;
  private actionError: unknown = null;
  private lastPaint = '';
  constructor(private readonly coordinator: SessionCoordinator, private readonly options: {
    isGM: boolean;
    localize(key: string): string;
    userName(id: string): string;
    confirmRevoke(): Promise<boolean>;
  }) {
    this.element.className = 'stagecraft-playback-controls stagecraft-session-panel';
    this.element.dataset.stagecraftSession = '';
    this.element.setAttribute('aria-label', this.t('Title'));
    this.element.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-session-action]') : null;
      if (button) void this.act(button.dataset.sessionAction!);
    });
    document.body.append(this.element);
    this.update();
  }
  private t(key: string): string { return this.options.localize(`STAGECRAFT.Session.${key}`); }
  open(): void { this.opened = true; this.update(); }
  update(): void {
    const { status, state, participants } = this.coordinator;
    const runPhase = this.coordinator.runPhase;
    const visible = this.opened || status.canExit || (this.options.isGM && (!!state?.run || !!status.error));
    this.element.hidden = !visible;
    const signature = JSON.stringify([status,state?.owner,runPhase,state?.run?.snapshot.name,participants,this.busy,String(this.actionError),visible]);
    if (signature === this.lastPaint) return;
    this.lastPaint = signature;
    const focused = this.element.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.sessionAction : undefined;
    this.element.replaceChildren();
    const heading = document.createElement('strong'); heading.textContent = state?.run?.snapshot.name ?? this.t('Title');
    const phase = document.createElement('span');
    const shownPhase = status.isOwner && runPhase && (!status.canExit || runPhase === 'holding') ? runPhase : status.phase;
    phase.textContent = this.t(`State.${shownPhase}`);
    phase.setAttribute('role','status');
    const header = document.createElement('div'); header.className = 'stagecraft-session-heading'; header.append(heading,phase); this.element.append(header);
    if (this.options.isGM && state?.owner) {
      const owner = document.createElement('small'); owner.textContent = `${this.t('Controller')}: ${this.options.userName(state.owner.userId)}`;
      this.element.append(owner);
    }
    if (status.isOwner && participants.length) {
      const list = document.createElement('ul'); list.className = 'stagecraft-participants';
      for (const participant of participants) {
        const row = document.createElement('li');
        const name = document.createElement('span'); name.textContent = participant.name;
        const readiness = document.createElement('span'); readiness.textContent = this.t(`State.${participant.status}`);
        if(participant.error) {
          const key=`STAGECRAFT.Error.${participant.error}`;const detail=this.options.localize(key);
          if(detail!==key) readiness.textContent+=`: ${detail}`;
        }
        row.append(name,readiness); list.append(row);
      }
      this.element.append(list);
    }
    const actions = document.createElement('div'); actions.className = 'stagecraft-session-actions'; this.element.append(actions);
    const button = (action:string,key:string,disabled=false) => {
      const b=document.createElement('button'); b.type='button'; b.dataset.sessionAction=action; b.textContent=this.t(key);
      b.disabled=disabled || (this.busy && action!=='exit' && action!=='close'); actions.append(b); return b;
    };
    if (status.isOwner) {
      if (state?.run?.phase === 'preparing') button('start','StartReady',!participants.some(p=>p.status==='ready'));
      if (state?.run && runPhase && ['playing','holding'].includes(runPhase)) button('pause','Pause');
      if (state?.run?.phase === 'paused') button('resume','Resume');
      if (state?.run && (runPhase === 'holding'
        || (state.run.phase === 'paused' && state.run.pausedFrom === 'holding'))) button('continue','Continue');
      if (state?.run && runPhase && ['playing','paused','holding'].includes(runPhase)) button('fade','Fade');
      if (state?.run) button('stop','Stop').classList.add('stagecraft-stop');
      else button('release','Release');
    } else if (this.options.isGM && state?.owner) button('revoke','Revoke');
    if (status.canExit) button('exit','Exit').classList.add('stagecraft-stop');
    if (!status.canExit && !state?.run) button('close','Close');
    const error = this.actionError ?? this.coordinator.lastError;
    if (error) {
      const code=typeof error==='object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
      const key=`STAGECRAFT.Error.${code}`; const translated=this.options.localize(key);
      const node=document.createElement('p');node.className='stagecraft-error';node.setAttribute('role','alert');node.textContent=translated===key ? this.t('Failed') : translated;
      this.element.append(node);
    }
    if (focused) {
      const action = focused === 'pause' ? 'resume' : focused === 'resume' ? 'pause' : focused;
      const enabled = (name: string) => this.element.querySelector<HTMLButtonElement>(`[data-session-action="${name}"]:not(:disabled)`);
      const replacement = enabled(focused) ?? enabled(action) ?? enabled('exit')
        ?? this.element.querySelector<HTMLButtonElement>('button[data-session-action]:not(:disabled)');
      replacement?.focus({preventScroll:true});
    }
  }
  private async act(action: string): Promise<void> {
    if (action==='exit') { this.coordinator.exitLocal(); this.update(); return; }
    if (action==='close') { this.opened=false; this.update(); return; }
    if (this.busy) return;
    this.busy=true;this.actionError=null;this.update();
    try {
      if (action==='start') await this.coordinator.startReady();
      else if (action==='pause') await this.coordinator.pause();
      else if (action==='resume') await this.coordinator.resume();
      else if (action==='continue') await this.coordinator.continueFromBreak();
      else if (action==='fade') await this.coordinator.fade();
      else if (action==='stop') await this.coordinator.stopGlobal();
      else if (action==='release') await this.coordinator.release();
      else if (action==='revoke' && await this.options.confirmRevoke()) await this.coordinator.revoke();
    } catch(error) { this.actionError=error; }
    finally { this.busy=false; this.update(); }
  }
  dispose(): void { this.element.remove(); }
}
