/** The orchestration view depends on this narrow UI-facing shape, which keeps DOM tests independent of the coordinator implementation. */
export type OrchestrationPhase = 'idle' | 'preparing' | 'ready' | 'scheduled' | 'playing' | 'holding' | 'paused' | 'exiting' | 'exited' | 'failed' | 'missing';

export interface OrchestrationRun {
  readonly runId: string;
  readonly snapshot: { readonly name: string };
  readonly recipients: readonly { readonly userId: string }[];
  readonly phase: 'preparing' | 'playing' | 'holding' | 'paused' | 'exiting';
  readonly pausedFrom?: 'holding';
}

export interface OrchestrationParticipant {
  readonly userId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly status: OrchestrationPhase;
  readonly error?: string;
  readonly positionMs?: number;
  readonly breakId?: string;
  readonly revision?: number;
  readonly terminal?: boolean;
}

export interface OrchestrationLaunch {
  readonly launchId: string;
  readonly snapshot: { readonly name: string };
  readonly userIds: readonly string[];
  readonly status: 'waiting' | 'preparing' | 'active' | 'failed';
  readonly runId?: string;
  readonly error?: string;
  readonly order: number;
  readonly mode: 'manual' | 'automatic';
}

export interface OrchestrationState {
  readonly rootId: string;
  readonly head: number;
  readonly owner: { readonly userId: string; readonly sessionId: string; readonly generation?: string } | null;
  readonly version: 1 | 2 | 3 | 4;
  readonly runs: readonly OrchestrationRun[];
  readonly launches: readonly OrchestrationLaunch[];
  readonly closedRuns: readonly string[];
  readonly closedLaunches: readonly string[];
}

export interface OrchestrationCoordinatorStatus {
  readonly phase: OrchestrationPhase;
  /** Run being presented in this browser tab; it may differ from the GM selection. */
  readonly runId: string | null;
  readonly isOwner: boolean;
  readonly canExit: boolean;
  readonly error: string | null;
}

export interface OrchestrationCoordinator {
  readonly state: OrchestrationState | null;
  readonly status: OrchestrationCoordinatorStatus;
  readonly lastError: unknown;
  readonly runs: readonly {
    readonly run: OrchestrationRun;
    readonly phase: OrchestrationPhase;
    readonly participants: readonly OrchestrationParticipant[];
  }[];
  readonly queue: readonly OrchestrationLaunch[];
  startReady(runId: string): Promise<unknown>;
  pause(runId: string): Promise<unknown>;
  resume(runId: string): Promise<unknown>;
  continueFromBreak(runId: string): Promise<unknown>;
  fade(runId: string): Promise<unknown>;
  stopGlobal(runId: string): Promise<unknown>;
  cancel(launchId: string): Promise<unknown>;
  retry(launchId: string): Promise<unknown>;
  stopAll(): Promise<unknown>;
  release(): Promise<unknown>;
  revoke(): Promise<unknown>;
  exitLocal(): void;
}

type Selection = { readonly kind: 'run' | 'launch'; readonly id: string } | null;
type FocusTarget = { readonly action: string; readonly targetId: string } | { readonly selection: Selection } | null;

/** Compact run/queue controls for GMs, with a separate persistent local-viewer exit. */
export class OrchestrationView {
  readonly element = document.createElement('section');
  private opened = false;
  private opener: HTMLElement | null = null;
  private dismissed = false;
  private busy = false;
  private actionError: unknown = null;
  private lastPaint = '';
  private selection: Selection = null;

  private readonly onClick = (event: Event): void => {
    const source = event.target instanceof Element ? event.target : null;
    if (!source || !this.element.contains(source)) return;
    const action = source.closest<HTMLButtonElement>('[data-orchestration-action]');
    if (action?.dataset.orchestrationAction) {
      void this.act(action.dataset.orchestrationAction, action.dataset.targetId ?? '');
      return;
    }
    const selected = source.closest<HTMLButtonElement>('[data-orchestration-select]');
    if (selected?.dataset.orchestrationSelect && selected.dataset.orchestrationId) {
      const kind = selected.dataset.orchestrationSelect;
      if (kind === 'run' || kind === 'launch') {
        this.selection = { kind, id: selected.dataset.orchestrationId };
        this.update();
      }
    }
  };

  constructor(private readonly coordinator: OrchestrationCoordinator, private readonly options: {
    isGM: boolean;
    localize(key: string): string;
    userName(id: string): string;
    confirmRevoke(): Promise<boolean>;
    focusLauncher?(): void;
  }) {
    this.element.className = 'stagecraft-playback-controls stagecraft-session-panel stagecraft-orchestration-panel';
    this.element.dataset.stagecraftOrchestration = '';
    this.element.setAttribute('aria-label', this.t('Title'));
    this.element.addEventListener('click', this.onClick);
    document.body.append(this.element);
    this.update();
  }

  private t(key: string): string { return this.options.localize(`STAGECRAFT.Orchestration.${key}`); }

  open(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !this.element.contains(active)) this.opener = active;
    this.dismissed = false;
    this.opened = true;
    this.update();
    this.element.querySelectorAll<HTMLButtonElement>('[data-orchestration-action]')
      .forEach(button => { if (button.dataset.orchestrationAction === 'close') button.focus({ preventScroll: true }); });
  }

  openAutomatically(): void {
    if (!this.options.isGM || this.dismissed) return;
    this.opened = true;
    this.update();
  }

  close(): void {
    if (!this.options.isGM) return;
    this.opened = false;
    this.dismissed = true;
    this.update();
    if (!this.coordinator.status.canExit) {
      this.focusLauncher();
    }
  }

  private focusLauncher(): void {
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    else this.options.focusLauncher?.();
  }

  update(): void {
    const { status, state, runs, queue } = this.coordinator;
    const localRun = status.runId ? runs.find(item => item.run.runId === status.runId) : undefined;
    const controllerLost = this.isControllerLost();
    const managerVisible = this.options.isGM && (this.opened || (!this.dismissed && (
      status.canExit || status.isOwner || !!state?.owner || runs.length > 0 || queue.length > 0
    )));
    const visible = managerVisible || status.canExit;
    const focus = this.captureFocus();
    this.element.hidden = !visible;
    this.element.dataset.orchestrationClosed = this.options.isGM && this.dismissed && !managerVisible ? 'true' : 'false';
    this.reconcileSelection(runs, queue);
    const signature = JSON.stringify({
      visible, managerVisible, opened: this.opened, dismissed: this.dismissed, busy: this.busy, selection: this.selection,
      owner: state?.owner ? [state.owner.userId, state.owner.sessionId, state.owner.generation ?? null] : null,
      local: [status.runId, status.phase, status.canExit, status.isOwner, localRun?.phase ?? null],
      runs: runs.map(item => [item.run.runId, item.run.snapshot.name, item.run.phase, item.run.pausedFrom,
        state?.launches.find(launch => launch.runId === item.run.runId)?.mode,
        item.phase, item.run.recipients.map(recipient => recipient.userId),
        item.participants.map(participant => [participant.userId, participant.sessionId, participant.name, participant.status,
          participant.error ?? null, participant.positionMs, participant.breakId, participant.revision, participant.terminal])]),
      queue: queue.map(item => [item.launchId, item.snapshot.name, item.userIds, item.status, item.runId ?? null, item.error ?? null, item.order]),
      error: this.errorFingerprint(this.actionError ?? this.coordinator.lastError), controllerLost
    });
    if (signature === this.lastPaint) return;
    this.lastPaint = signature;
    this.element.replaceChildren();

    if (!this.options.isGM) {
      this.renderLocalViewer(localRun, status);
      this.restoreFocus(focus);
      return;
    }

    if (!managerVisible) {
      if (status.canExit) this.renderLocalViewer(localRun, status);
      if (!visible && focus) this.focusLauncher();
      else this.restoreFocus(focus);
      return;
    }

    const header = document.createElement('div');
    header.className = 'stagecraft-orchestration__header';
    const heading = document.createElement('strong');
    heading.className = 'stagecraft-orchestration__title';
    heading.textContent = this.t('Title');
    const close = this.button('close', 'Close', false);
    close.textContent = '×';
    close.setAttribute('aria-label', this.t('Close'));
    close.title = this.t('Close');
    close.className = 'stagecraft-orchestration__close';
    header.append(heading, close);
    this.element.append(header);

    if (status.canExit) this.renderLocalViewer(localRun, status);
    this.renderManager(runs, queue, state, status.isOwner, controllerLost);
    this.renderError();
    this.restoreFocus(focus);
  }

  private reconcileSelection(
    runs: OrchestrationCoordinator['runs'],
    queue: OrchestrationCoordinator['queue']
  ): void {
    if (!this.options.isGM) { this.selection = null; return; }
    if (this.selection?.kind === 'run' && runs.some(item => item.run.runId === this.selection!.id)) return;
    if (this.selection?.kind === 'launch' && queue.some(item => item.launchId === this.selection!.id)) return;
    this.selection = runs[0] ? { kind: 'run', id: runs[0].run.runId }
      : queue[0] ? { kind: 'launch', id: queue[0].launchId } : null;
  }

  private renderLocalViewer(
    localRun: OrchestrationCoordinator['runs'][number] | undefined,
    status: OrchestrationCoordinatorStatus
  ): void {
    if (!status.canExit || !status.runId) return;
    const region = document.createElement('section');
    region.className = 'stagecraft-orchestration__local';
    region.setAttribute('aria-label', this.t('LocalPlayback'));
    const name = document.createElement('strong');
    name.className = 'stagecraft-orchestration__local-name';
    name.textContent = localRun?.run.snapshot.name ?? this.t('LocalPlayback');
    const phase = document.createElement('span');
    phase.className = 'stagecraft-orchestration__local-phase';
    phase.setAttribute('role', 'status');
    phase.textContent = this.stateLabel(localRun?.phase ?? status.phase);
    const exit = this.button('exit', 'Exit', false, 'stagecraft-stop');
    region.append(name, phase, exit);
    this.element.append(region);
  }

  private renderManager(
    runs: OrchestrationCoordinator['runs'],
    queue: OrchestrationCoordinator['queue'],
    state: OrchestrationState | null,
    isOwner: boolean,
    controllerLost: boolean
  ): void {
    const layout = document.createElement('div');
    layout.className = 'stagecraft-orchestration__layout';
    const lists = document.createElement('div');
    lists.className = 'stagecraft-orchestration__lists';
    const runList = document.createElement('section');
    runList.className = 'stagecraft-orchestration__list-section';
    runList.setAttribute('aria-label', this.t('ActiveRuns'));
    runList.append(this.heading('ActiveRuns'));
    if (!runs.length) runList.append(this.empty('NoActiveRuns'));
    else {
      const list = document.createElement('ul');
      list.className = 'stagecraft-orchestration__list';
      for (const item of runs) {
        const audience = this.audience(item.run.recipients.map(recipient => recipient.userId));
        list.append(this.row('run', item.run.runId, item.run.snapshot.name, audience, item.phase,
          this.selection?.kind === 'run' && this.selection.id === item.run.runId));
      }
      runList.append(list);
    }
    const queueList = document.createElement('section');
    queueList.className = 'stagecraft-orchestration__list-section';
    queueList.setAttribute('aria-label', this.t('Queue'));
    queueList.append(this.heading('Queue'));
    if (!queue.length) queueList.append(this.empty('NoQueuedLaunches'));
    else {
      const list = document.createElement('ul');
      list.className = 'stagecraft-orchestration__list';
      for (const item of queue) {
        list.append(this.row('launch', item.launchId, item.snapshot.name, this.audience(item.userIds), item.status,
          this.selection?.kind === 'launch' && this.selection.id === item.launchId));
      }
      queueList.append(list);
    }
    lists.append(runList, queueList);

    const details = document.createElement('section');
    details.className = 'stagecraft-orchestration__details';
    details.setAttribute('aria-label', this.t('SelectedItem'));
    const selectedRun = this.selection?.kind === 'run' ? runs.find(item => item.run.runId === this.selection!.id) : undefined;
    const selectedLaunch = this.selection?.kind === 'launch' ? queue.find(item => item.launchId === this.selection!.id) : undefined;
    if (selectedRun) this.renderRunDetails(details, selectedRun, isOwner && !controllerLost);
    else if (selectedLaunch) this.renderLaunchDetails(details, selectedLaunch, isOwner && !controllerLost);
    else details.append(this.empty('SelectAnItem'));

    layout.append(lists, details);
    this.element.append(layout);

    if (isOwner && controllerLost && state?.owner) {
      const owner = document.createElement('small');
      owner.className = 'stagecraft-orchestration__owner';
      owner.textContent = `${this.t('Controller')}: ${this.options.userName(state.owner.userId)}`;
      this.element.append(owner);
      const recover = document.createElement('div');
      recover.className = 'stagecraft-orchestration__global-actions';
      const revoke = this.button('revoke', 'Revoke', this.busy, 'stagecraft-stop');
      revoke.setAttribute('aria-label', this.t('Revoke'));
      recover.append(revoke);
      this.element.append(recover);
    } else if (isOwner && !controllerLost && (runs.length > 0 || queue.length > 1)) {
      const globalActions = document.createElement('div');
      globalActions.className = 'stagecraft-orchestration__global-actions';
      const stopAllKey = runs.length > 0 ? 'StopAll' : 'CancelAllStarts';
      const stopAll = this.button('stop-all', stopAllKey, this.busy, 'stagecraft-stop');
      stopAll.setAttribute('aria-label', this.t(stopAllKey));
      globalActions.append(stopAll);
      this.element.append(globalActions);
    } else if (isOwner && !controllerLost && runs.length === 0 && queue.length === 0) {
      const release = document.createElement('div');
      release.className = 'stagecraft-orchestration__global-actions';
      release.append(this.button('release', 'Release', this.busy));
      this.element.append(release);
    } else if (!isOwner && state?.owner) {
      const owner = document.createElement('small');
      owner.className = 'stagecraft-orchestration__owner';
      owner.textContent = `${this.t('Controller')}: ${this.options.userName(state.owner.userId)}`;
      this.element.append(owner);
      const revoke = document.createElement('div');
      revoke.className = 'stagecraft-orchestration__global-actions';
      revoke.append(this.button('revoke', 'Revoke', this.busy, 'stagecraft-stop'));
      this.element.append(revoke);
    }
  }

  private renderRunDetails(
    details: HTMLElement,
    item: OrchestrationCoordinator['runs'][number],
    isOwner: boolean
  ): void {
    const name = document.createElement('h3');
    name.textContent = item.run.snapshot.name;
    const phase = document.createElement('p');
    phase.className = 'stagecraft-orchestration__phase';
    phase.textContent = `${this.t('CurrentPhase')}: ${this.stateLabel(item.phase)}`;
    const audience = document.createElement('p');
    audience.className = 'stagecraft-orchestration__audience';
    audience.textContent = `${this.t('Audience')}: ${this.audience(item.run.recipients.map(recipient => recipient.userId))}`;
    const label = document.createElement('h4');
    label.textContent = this.t('Participants');
    const participants = document.createElement('ul');
    participants.className = 'stagecraft-orchestration__participants';
    for (const participant of item.participants) {
      const row = document.createElement('li');
      const person = document.createElement('span'); person.textContent = participant.name;
      const participantState = document.createElement('span');
      participantState.textContent = this.stateLabel(participant.status);
      if (participant.positionMs !== undefined) participantState.textContent += ` · ${(participant.positionMs / 1000).toFixed(1)}s`;
      if (participant.error) participantState.textContent += `: ${this.errorText(participant.error)}`;
      row.append(person, participantState);
      participants.append(row);
    }
    details.append(name, phase, audience, label, participants);
    if (isOwner) {
      const actions = document.createElement('div');
      actions.className = 'stagecraft-orchestration__actions';
      const ready = item.phase === 'preparing' || item.phase === 'ready';
      const automatic = this.coordinator.state?.launches.some(launch =>
        launch.runId === item.run.runId && launch.mode === 'automatic');
      if (ready && !automatic) {
        const allReady = item.participants.length > 0 && item.participants.every(participant => participant.status === 'ready');
        actions.append(this.button('start', 'StartReady', this.busy || !allReady, '', item.run.runId));
      }
      if (item.phase === 'playing' || item.phase === 'holding') {
        actions.append(this.button('pause', 'Pause', this.busy, '', item.run.runId));
      }
      if (item.phase === 'paused') actions.append(this.button('resume', 'Resume', this.busy, '', item.run.runId));
      if (item.phase === 'holding' || (item.phase === 'paused' && item.run.pausedFrom === 'holding')
        || item.participants.some(participant=>participant.status==='holding')) {
        actions.append(this.button('continue', 'Continue', this.busy, '', item.run.runId));
      }
      if (item.phase === 'playing' || item.phase === 'paused' || item.phase === 'holding') {
        actions.append(this.button('fade', 'Fade', this.busy, '', item.run.runId));
      }
      actions.append(this.button('stop', 'Stop', this.busy, 'stagecraft-stop', item.run.runId));
      details.append(actions);
    }
  }

  private renderLaunchDetails(details: HTMLElement, launch: OrchestrationLaunch, isOwner: boolean): void {
    const name = document.createElement('h3'); name.textContent = launch.snapshot.name;
    const state = document.createElement('p'); state.className = 'stagecraft-orchestration__phase';
    state.textContent = `${this.t('CurrentPhase')}: ${this.launchStateLabel(launch.status)}`;
    const audience = document.createElement('p'); audience.className = 'stagecraft-orchestration__audience';
    audience.textContent = `${this.t('Audience')}: ${this.audience(launch.userIds)}`;
    details.append(name, state, audience);
    if (launch.error) {
      const error = document.createElement('p'); error.className = 'stagecraft-orchestration__launch-error';
      error.textContent = this.errorText(launch.error); details.append(error);
    }
    if (isOwner) {
      const actions = document.createElement('div'); actions.className = 'stagecraft-orchestration__actions';
      if (launch.status === 'failed') actions.append(this.button('retry', 'Retry', this.busy, '', launch.launchId));
      actions.append(this.button('cancel', 'Cancel', this.busy, 'stagecraft-stop', launch.launchId));
      details.append(actions);
    }
  }

  private row(kind: 'run' | 'launch', id: string, name: string, audience: string, phase: string, selected: boolean): HTMLElement {
    const item = document.createElement('li');
    item.className = 'stagecraft-orchestration__item';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.orchestrationSelect = kind;
    button.dataset.orchestrationId = id;
    button.dataset.focusKey = `select:${kind}:${id}`;
    button.className = selected ? 'stagecraft-orchestration__select is-selected' : 'stagecraft-orchestration__select';
    button.setAttribute('aria-pressed', String(selected));
    const title = document.createElement('span'); title.className = 'stagecraft-orchestration__item-name'; title.textContent = name;
    const target = document.createElement('small'); target.className = 'stagecraft-orchestration__item-audience'; target.textContent = audience;
    const state = document.createElement('span'); state.className = 'stagecraft-orchestration__item-state';
    state.textContent = kind === 'run' ? this.stateLabel(phase) : this.launchStateLabel(phase as OrchestrationLaunch['status']);
    button.append(title, target, state);
    item.append(button);
    return item;
  }

  private heading(key: string): HTMLElement {
    const heading = document.createElement('h3'); heading.textContent = this.t(key); return heading;
  }

  private empty(key: string): HTMLElement {
    const empty = document.createElement('p'); empty.className = 'stagecraft-orchestration__empty'; empty.textContent = this.t(key); return empty;
  }

  private button(action: string, label: string, disabled: boolean, className = '', targetId = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.orchestrationAction = action;
    button.dataset.targetId = targetId;
    button.dataset.focusKey = `action:${action}:${targetId}`;
    button.textContent = this.t(label);
    button.disabled = disabled || (this.busy && !['exit', 'close'].includes(action));
    if (className) button.className = className;
    return button;
  }

  private audience(userIds: readonly string[]): string {
    return userIds.length ? userIds.map(id => this.options.userName(id)).join(', ') : this.t('NoAudience');
  }

  private stateLabel(phase: OrchestrationPhase | string): string {
    const key = `STAGECRAFT.Session.State.${phase}`;
    const translated = this.options.localize(key);
    return translated === key ? phase : translated;
  }

  private launchStateLabel(phase: OrchestrationLaunch['status'] | string): string {
    const key = `STAGECRAFT.Orchestration.State.${phase}`;
    const translated = this.options.localize(key);
    return translated === key ? phase : translated;
  }

  private renderError(): void {
    const error = this.actionError ?? this.coordinator.lastError;
    if (!error) return;
    const node = document.createElement('p');
    node.className = 'stagecraft-error stagecraft-orchestration__error';
    node.setAttribute('role', 'alert');
    node.textContent = this.errorText(error);
    this.element.append(node);
  }

  private errorText(error: unknown): string {
    const code = typeof error === 'string' ? error
      : typeof error === 'object' && error !== null && 'code' in error ? String(error.code)
        : error instanceof Error ? error.message : '';
    if (code) {
      const key = `STAGECRAFT.Error.${code}`;
      const translated = this.options.localize(key);
      if (translated !== key) return translated;
    }
    return this.t('Failed');
  }

  private errorFingerprint(error: unknown): string {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && 'code' in error) return String(error.code);
    return error instanceof Error ? error.message : 'error';
  }

  private isControllerLost(): boolean {
    const hasCode = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error
      && String(error.code) === 'SESSION_CONTROLLER_LOST';
    return hasCode(this.actionError) || hasCode(this.coordinator.lastError);
  }

  private captureFocus(): FocusTarget {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !this.element.contains(active)) return null;
    if (active.dataset.orchestrationAction) {
      return { action: active.dataset.orchestrationAction, targetId: active.dataset.targetId ?? '' };
    }
    if (active.dataset.orchestrationSelect) {
      return { selection: { kind: active.dataset.orchestrationSelect as 'run' | 'launch', id: active.dataset.orchestrationId ?? '' } };
    }
    return null;
  }

  private restoreFocus(focus: FocusTarget): void {
    if (!focus) return;
    const actions = Array.from(this.element.querySelectorAll<HTMLButtonElement>('button[data-orchestration-action]'));
    const selections = Array.from(this.element.querySelectorAll<HTMLButtonElement>('button[data-orchestration-select]'));
    if ('action' in focus) {
      const same = actions.find(button => button.dataset.orchestrationAction === focus.action
        && (button.dataset.targetId ?? '') === focus.targetId && !button.disabled);
      const counterpartName = focus.action === 'pause' ? 'resume' : focus.action === 'resume' ? 'pause'
        : '';
      const counterpart = counterpartName ? actions.find(button => button.dataset.orchestrationAction === counterpartName
        && (button.dataset.targetId ?? '') === focus.targetId && !button.disabled) : undefined;
      (same ?? counterpart ?? actions.find(button => button.dataset.orchestrationAction === 'exit' && !button.disabled)
        ?? actions.find(button => !button.disabled))?.focus({ preventScroll: true });
      return;
    }
    if (focus.selection) {
      const same = selections.find(button => button.dataset.orchestrationSelect === focus.selection?.kind
        && button.dataset.orchestrationId === focus.selection?.id);
      (same ?? selections[0])?.focus({ preventScroll: true });
    }
  }

  private async act(action: string, targetId: string): Promise<void> {
    if (action === 'close') { this.close(); return; }
    if (action === 'exit') {
      this.coordinator.exitLocal();
      this.actionError = null;
      this.update();
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.actionError = null;
    this.update();
    try {
      if (action === 'start') await this.coordinator.startReady(targetId);
      else if (action === 'pause') await this.coordinator.pause(targetId);
      else if (action === 'resume') await this.coordinator.resume(targetId);
      else if (action === 'continue') await this.coordinator.continueFromBreak(targetId);
      else if (action === 'fade') await this.coordinator.fade(targetId);
      else if (action === 'stop') await this.coordinator.stopGlobal(targetId);
      else if (action === 'stop-all') await this.coordinator.stopAll();
      else if (action === 'cancel') await this.coordinator.cancel(targetId);
      else if (action === 'retry') await this.coordinator.retry(targetId);
      else if (action === 'release' && this.coordinator.runs.length === 0 && this.coordinator.queue.length === 0) {
        await this.coordinator.release();
      } else if (action === 'revoke') {
        const displayedOwner = this.coordinator.state?.owner;
        if (displayedOwner && await this.options.confirmRevoke()) {
          if (this.sameOwner(displayedOwner, this.coordinator.state?.owner ?? null)) await this.coordinator.revoke();
          else this.actionError = Object.assign(new Error('Controller ownership changed during confirmation.'), { code: 'SESSION_CONFLICT' });
        }
      }
    } catch (error) {
      this.actionError = error;
    } finally {
      this.busy = false;
      this.update();
    }
  }

  private sameOwner(
    left: NonNullable<OrchestrationState['owner']>,
    right: OrchestrationState['owner']
  ): boolean {
    return !!right && left.userId === right.userId && left.sessionId === right.sessionId
      && (left.generation ?? null) === (right.generation ?? null);
  }

  dispose(): void {
    this.element.removeEventListener('click', this.onClick);
    this.element.remove();
  }
}
