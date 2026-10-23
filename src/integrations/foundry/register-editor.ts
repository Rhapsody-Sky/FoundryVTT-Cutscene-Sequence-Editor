import { MODULE_ID } from '../../application/foundation-status.js';
import { LocalPlayer, type PlayerState } from '../../playback/local-player.js';
import { EditorView, browserRuntime, type EditorServices } from '../../ui/editor-view.js';
import { createFoundryRepository, type RepositoryHost, type RepositoryPermissionLevel } from './sequence-repository.js';
import { createOrchestrationStore } from './orchestration-store.js';
import { OrchestrationCoordinator } from '../../application/orchestration-coordinator.js';
import { OrchestrationView } from '../../ui/orchestration-view.js';
import { DomSurface } from '../../rendering/dom-surface.js';
import { SceneShortcuts, type SceneControl } from './scene-shortcuts.js';
import { AudioGate } from '../../ui/audio-gate.js';
import { createFoundryTemplateRepository } from './template-repository.js';
import { createFoundryBoardBackdrop, type BoardBackdropHost } from './board-backdrop.js';
import { ManualPlaybackLauncher } from '../../application/manual-playback-launcher.js';
import { chooseManualAudience, type AudienceDialogConfig } from './audience-dialog.js';
import { LocalPlaybackVolume, playbackVolumeKey, type PlaybackVolumeStorage } from '../../application/playback-volume.js';
import { SavedTriggerLauncher } from '../../application/saved-trigger-launcher.js';
import { CombatTriggerBinding, type NativeTriggerCombat } from './combat-trigger-binding.js';
import { createButtonChoiceChat } from './button-choice-chat.js';

interface User { id: string; name:string; role: number; isGM: boolean; active:boolean; can(permission: string): boolean; query(name:string,data:unknown,options:{timeout:number}):Promise<unknown> }
interface App {
  readonly element: HTMLElement;
  render(options?: { force?: boolean }): Promise<unknown>;
  close(options?: unknown): Promise<unknown>;
  _prepareContext(options: unknown): Promise<Record<string, unknown>>;
  _onRender(context: unknown, options: unknown): Promise<void>;
  _onClose(options: unknown): void;
}
interface AppClass { new(options?: unknown): App; DEFAULT_OPTIONS: Record<string, unknown> }
interface EditorHost extends BoardBackdropHost {
  CONFIG:{queries:Record<string,(data:unknown,context:{user:User;timeout:number})=>Promise<unknown>>};
  ChatMessage: { create(data: Record<string, unknown>, options: { keepId: boolean }): Promise<unknown> };
  Hooks: {
    once(event: 'init'|'ready', callback: () => void): unknown;
    on(event:'getSceneControlButtons',callback:(controls:Record<string,SceneControl>)=>void):unknown;
    on(event:'renderSceneControls',callback:(app:unknown,element:HTMLElement)=>void):unknown;
    on(event:string,callback:(...args:unknown[])=>void):unknown;
    off(event:string,callback:(...args:unknown[])=>void):unknown;
  };
  ui: {
    controls: {control: {name:string}|null; render(options:{reset?:boolean;force?:boolean}):Promise<unknown>};
    notifications:{error(message:string):unknown;warn(message:string):unknown};
  };
  game: {
    version: string; world: { id: string }; user: User;
    time:{serverTime:number};
    users: { contents: User[]; get(id: string): User | undefined };
    actors: { contents: readonly {id:string;name:string}[] };
    combats: { contents: readonly NativeTriggerCombat[]; readonly active?: NativeTriggerCombat | null };
    packs: { get(collection: string): { documentName: string; getUserLevel(user: User): number } | undefined };
    settings: { registerMenu(namespace:string,key:string,config:Record<string,unknown>):void };
    modules: { get(id:string): {api?:Record<string,unknown>} | undefined };
    i18n: { localize(key:string):string };
    socket: {
      emit(event:string,request:unknown,callback:(response:unknown)=>void):void;
      on(event:string,listener:(response:unknown)=>void):void;
      off(event:string,listener:(response:unknown)=>void):void;
    };
  };
  foundry: {
    applications: { apps:{FilePicker:new(options:Record<string,unknown>)=>{
      render(options:{force:boolean}):Promise<unknown>;
      addEventListener(event:string,callback:()=>void,options:{once:boolean}):void;
    }};api: {
      ApplicationV2: AppClass;
      HandlebarsApplicationMixin(base:AppClass):AppClass;
      DialogV2: {
        confirm(config:Record<string,unknown>):Promise<boolean>;
        wait(config:AudienceDialogConfig):Promise<unknown>;
      };
    } };
    documents: { collections: { CompendiumCollection: { createCompendium(metadata:unknown):Promise<unknown> } } };
  };
}
export function readEditorHost(): EditorHost { return globalThis as unknown as EditorHost; }

// getRandomValues also works on ordinary HTTP LAN origins used by Foundry hosts.
function makeBrowserId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2,'0')).join('');
}

function storageHost(host:EditorHost):RepositoryHost {
  return {
    get worldId() { return host.game.world.id; },
    get currentUser() { return host.game.user; },
    get users() { return host.game.users.contents; },
    findPack(collection) {
      const pack = host.game.packs.get(collection); if (!pack) return undefined;
      return {
        documentName:pack.documentName,
        permissionLevel(userId) {
          const user = host.game.users.get(userId); if (!user) return undefined;
          const levels:Record<number,RepositoryPermissionLevel> = {0:'NONE',1:'LIMITED',2:'OBSERVER',3:'OWNER'};
          return levels[pack.getUserLevel(user)];
        }
      };
    },
    canModifySettings(userId) { return host.game.users.get(userId)?.can('SETTINGS_MODIFY') ?? false; },
    async createPack(metadata) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          host.foundry.documents.collections.CompendiumCollection.createCompendium(metadata),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('STORAGE_FAILURE')), 10000); })
        ]);
      } finally { clearTimeout(timer); }
    },
    rpc(event,request) {
      // Bounded native document RPC: an ambiguous write is reconciled by request ID in the repository.
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error('STORAGE_FAILURE')),10000);
        host.game.socket.emit(event,request,response => {clearTimeout(timer);resolve(response);});
      });
    },
    makeId: makeBrowserId
  };
}

export function registerEditor(host:EditorHost):void {
  let services:EditorServices | null = null;
  let application:App | null = null;
  let Editor:AppClass | null = null;
  let shortcuts:SceneShortcuts | null=null;
  const localize = (key:string) => host.game.i18n.localize(key);
  function requireServices():EditorServices {
    if (!host.game.user?.isGM || !services) throw new Error('GM_ONLY');
    return services;
  }
  const openEditor=()=>{requireServices();return (application ?? new Editor!()).render({force:true});};
  const repaintControls=()=>{void host.ui.controls.render({reset:true}).catch(()=>{});};
  host.Hooks.on('getSceneControlButtons',controls=>shortcuts?.populate(controls));
  host.Hooks.on('renderSceneControls',(_app,element)=>shortcuts?.decorate(element,host.ui.controls.control?.name===MODULE_ID));
  host.Hooks.once('init', () => {
    if (!/^14\./.test(host.game.version)) return;
    const Base = host.foundry.applications.api.HandlebarsApplicationMixin(host.foundry.applications.api.ApplicationV2);
    Editor = class TitleEditor extends Base {
      private view:EditorView | null = null;
      constructor(options?:unknown) {
        super(options);
        if (application) return application as TitleEditor;
        application = this;
      }
      static override DEFAULT_OPTIONS = {
        id:`${MODULE_ID}-editor`, classes:['stagecraft-editor'], tag:'section',
        window:{title:'STAGECRAFT.Editor.Title',icon:'fa-solid fa-film',resizable:true,controls:[]},
        position:{width:1280,height:840}
      };
      static PARTS = {content:{template:`modules/${MODULE_ID}/templates/editor.hbs`}};
      override async _prepareContext(options:unknown):Promise<Record<string,unknown>> {
        requireServices();
        return super._prepareContext(options);
      }
      override async _onRender(context:unknown,options:unknown):Promise<void> {
        await super._onRender(context,options);
        this.view ??= new EditorView(requireServices());
        await this.view.mount(this.element);
      }
      override async close(options?:unknown):Promise<unknown> {
        if (this.view && !await this.view.mayClose()) return this;
        return super.close(options);
      }
      override _onClose(options:unknown):void {
        this.view?.detach(); this.view = null;
        application = null;
        super._onClose(options);
      }
    };
    host.game.settings.registerMenu(MODULE_ID,'editor',{
      name:'STAGECRAFT.Editor.Title',label:'STAGECRAFT.Editor.Open',icon:'fas fa-film',type:Editor,restricted:true
    });
  });
  host.Hooks.once('ready', () => {
    if (!/^14\./.test(host.game.version) || !host.game.user) return;
    const subscribers = new Set<(state:Readonly<PlayerState>)=>void>();
    const localPlayer = new LocalPlayer(browserRuntime,state => {for(const subscriber of subscribers) subscriber(state);});
    const now=()=>Math.round(host.game.time.serverTime);
    let volumeStorage: PlaybackVolumeStorage | undefined;
    try { volumeStorage = window.localStorage; } catch { /* Keep playback usable with browser storage disabled. */ }
    const playbackVolume = new LocalPlaybackVolume(volumeStorage ? {
      storage: volumeStorage, key: playbackVolumeKey(host.game.world.id, host.game.user.id)
    } : undefined);
    const audioGate=new AudioGate(localize);
    const requestAudioUnlock=(unlock:()=>Promise<void>,signal:AbortSignal)=>audioGate.request(unlock,signal);
    let coordinator:OrchestrationCoordinator;
    let groupPreparation=0;
    const groupPlayer=new LocalPlayer({...browserRuntime,now},state=>{
      const generation=groupPreparation;
      if(state.error) queueMicrotask(()=>{if(generation===groupPreparation) coordinator.playbackFailed(new Error(state.error));});
      else if(state.phase==='ended') queueMicrotask(()=>{if(generation===groupPreparation) coordinator.playbackStateChanged(state);});
    });
    let sessionView:OrchestrationView | null=null;
    let automaticLauncher:SavedTriggerLauncher | null=null;
    let combatTriggerBinding:CombatTriggerBinding | null=null;
    let notifiedFailure='';
    coordinator=new OrchestrationCoordinator({
      userId:host.game.user.id, sessionId:makeBrowserId(), isGM:host.game.user.isGM,
      users:()=>host.game.users.contents.map(user=>({id:user.id,name:user.name,role:user.role,active:user.active})),
      store:createOrchestrationStore(storageHost(host)), now, monotonicNow:()=>performance.now(), makeId:makeBrowserId,
      ensureButtonChoiceCard:createButtonChoiceChat({
        get currentUser() { return host.game.user; },
        get users() { return host.game.users.contents; },
        async readMessage(id) {
          const response=await storageHost(host).rpc('modifyDocument',{type:'ChatMessage',action:'get',operation:{query:{_id:id}}});
          if(!response || typeof response!=='object' || ('error' in response && response.error != null) || !('result' in response)
            || !Array.isArray(response.result) || !response.result.every(record=>record && typeof record==='object')) throw new Error('STORAGE_FAILURE');
          return response.result as Record<string,unknown>[];
        },
        async createMessage(data) {
          let timer:ReturnType<typeof setTimeout>|undefined;
          try { return await Promise.race([
            host.ChatMessage.create(data,{keepId:true}),
            new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('STORAGE_FAILURE')),10000);})
          ]); } finally {clearTimeout(timer);}
        }
      }),
      query:async(userId,data,timeoutMs)=>{
        const user=host.game.users.get(userId); if(!user?.active) throw new Error('SESSION_RECIPIENT_UNAVAILABLE');
        let timer:ReturnType<typeof setTimeout>|undefined;
        try { return await Promise.race([
          user.query(`${MODULE_ID}.session`,data,{timeout:timeoutMs}),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SESSION_RECIPIENT_UNAVAILABLE')),timeoutMs+100);})
        ]); } finally {clearTimeout(timer);}
      },
      schedule:(callback,delayMs)=>setTimeout(callback,delayMs), cancel:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>),
      playback:{
        validateTarget(sequence) {
          if(sequence.presentation.surface==='canvas') {
            const board=document.querySelector<HTMLElement>('#board');
            if(!board?.isConnected || !board.getBoundingClientRect().height) throw new Error('CANVAS_UNAVAILABLE');
          } else if(typeof HTMLElement.prototype.showPopover!=='function') throw new Error('POPOVER_UNAVAILABLE');
        },
        async prepare(sequence,signal) {
          const generation=++groupPreparation;
          localPlayer.stop();
          const board=document.querySelector<HTMLElement>('#board');
          signal.addEventListener('abort',()=>{if(generation===groupPreparation) groupPlayer.stop();},{once:true});
          await groupPlayer.prepare(sequence,new DomSurface({
            target:sequence.presentation.surface,...(board?{board}:{}),
            boardBackdrop:createFoundryBoardBackdrop(host,sequence.presentation.surface),
            requestAudioUnlock,onError:error=>{if(generation===groupPreparation) groupPlayer.fail(error);},
            onButtonActivate:intent=>coordinator.activateButton(intent.clipId,intent.breakId),
            onInteractionError:()=>host.ui.notifications.warn(localize('STAGECRAFT.Error.BUTTON_ACTION_FAILED')),
            playbackVolume, volumeLabel: localize('STAGECRAFT.Playback.Volume'),
            onWarning:code=>host.ui.notifications.warn(localize(`STAGECRAFT.Error.${code}`)),
            controls:{stop:()=>coordinator.exitLocal(),panel:sessionView!.element,
              labels:{stop:localize('STAGECRAFT.Session.Exit'),fade:'',pause:'',resume:'',playback:localize('STAGECRAFT.Session.Title')}}
          }));
          if(signal.aborted || generation!==groupPreparation) return;
          const error=groupPlayer.getState().error;if(error) throw new Error(error);
        },
        async start(_sequence,anchor) {groupPlayer.play(anchor);},
        applyAnchor:anchor=>groupPlayer.applyAnchor(anchor), stop:()=>{groupPreparation++;groupPlayer.stop();}
      },
      onChange:()=>{
        sessionView?.update();
        const status=coordinator?.status;
        if(!host.game.user.isGM && status?.phase==='failed' && status.error) {
          const identity=`${status.runId}:${status.error}`;
          if(identity!==notifiedFailure) {
            notifiedFailure=identity;const key=`STAGECRAFT.Error.${status.error}`;const message=localize(key);
            host.ui.notifications.error(message===key ? localize('STAGECRAFT.Session.Failed') : message);
          }
        }
      }
    });
    sessionView=new OrchestrationView(coordinator,{
      isGM:host.game.user.isGM,localize,userName:id=>host.game.users.get(id)?.name ?? id,
      focusLauncher:()=>document.querySelector<HTMLButtonElement>('#scene-controls-tools button[data-tool="playback"]')?.focus({preventScroll:true}),
      confirmRevoke:()=>host.foundry.applications.api.DialogV2.confirm({
        window:{title:localize('STAGECRAFT.Session.Revoke')},content:`<p>${localize('STAGECRAFT.Session.RevokeQuestion')}</p>`,rejectClose:false,defaultYes:false
      })
    });
    const queryTimers=new Map<ReturnType<typeof setTimeout>,()=>void>();
    host.CONFIG.queries[`${MODULE_ID}.session`]=async(data,context)=>{
      const result=await coordinator.handleQuery(data,context.user.id);
      // Foundry broadcasts a query to every tab of a user and accepts the first acknowledgement.
      // A different tab must not race the specifically addressed participant's response.
      if(result && typeof result==='object' && 'kind' in result && result.kind==='session-mismatch') {
        await new Promise<void>(resolve=>{const timer=setTimeout(()=>{queryTimers.delete(timer);resolve();},Math.min(10000,Math.max(0,context.timeout))+100);queryTimers.set(timer,resolve);});
      }
      return result;
    };
    const documentChanged=(response:unknown)=>{
      if(!response || typeof response!=='object') return;
      const event=response as {type?:unknown;operation?:{pack?:unknown}};
      if(event.operation?.pack!=='world.stagecraft-sequences' || !['JournalEntry','JournalEntryPage'].includes(String(event.type))) return;
      // A broadcast is only a read hint. The freshly read, validated ledger alone changes playback.
      void coordinator.refresh().catch(()=>{});
      void shortcuts?.refresh();
    };
    host.game.socket.on('modifyDocument',documentChanged);
    void coordinator.initialize().catch(()=>sessionView?.update());
    let audienceDialogOpen = false;
    const manualLauncher = new ManualPlaybackLauncher({
      async chooseAudience(sequenceName) {
        audienceDialogOpen = true;
        try {
          return await chooseManualAudience({
            users: () => host.game.users.contents.map(user => ({ id:user.id, name:user.name, role:user.role, active:user.active })),
            localize, wait: config => host.foundry.applications.api.DialogV2.wait(config)
          }, sequenceName);
        } finally { audienceDialogOpen = false; }
      },
      async prepare(snapshot) { sessionView!.open(); await coordinator.prepare(snapshot); }
    });
    services = {
      makeId:makeBrowserId,
      listTriggerActors:()=>host.game.actors.contents.map(actor=>({id:actor.id,name:actor.name})),
      listTriggerUsers:()=>host.game.users.contents.map(user=>({id:user.id,name:user.name,role:user.role,active:user.active})),
      requestAudioUnlock,
      createBoardBackdrop:target=>createFoundryBoardBackdrop(host,target),
      chooseVideo(currentPath) {
        requireServices();
        return new Promise((resolve,reject)=>{
          const picker=new host.foundry.applications.apps.FilePicker({type:'video',current:currentPath,callback:(path:string)=>resolve(path)});
          picker.addEventListener('close',()=>resolve(null),{once:true});
          void picker.render({force:true}).catch(reject);
        });
      },
      chooseImage(currentPath) {
        requireServices();
        return new Promise((resolve,reject)=>{
          const picker=new host.foundry.applications.apps.FilePicker({type:'image',current:currentPath,callback:(path:string)=>resolve(path)});
          picker.addEventListener('close',()=>resolve(null),{once:true});
          void picker.render({force:true}).catch(reject);
        });
      },
      chooseAudio(currentPath) {
        requireServices();
        return new Promise((resolve,reject)=>{
          const picker=new host.foundry.applications.apps.FilePicker({type:'audio',current:currentPath,callback:(path:string)=>resolve(path)});
          picker.addEventListener('close',()=>resolve(null),{once:true});
          void picker.render({force:true}).catch(reject);
        });
      },
      repository:createFoundryRepository(storageHost(host)),localPlayer,localize,
      templateRepository:createFoundryTemplateRepository(storageHost(host)),
      async confirmDeleteTemplate(name) {
        const content = document.createElement('p');
        content.textContent = localize('STAGECRAFT.Editor.TemplateDeleteQuestion') + ' ' + name;
        return host.foundry.applications.api.DialogV2.confirm({
          window:{title:localize('STAGECRAFT.Editor.TemplateDelete')}, content:content.outerHTML,
          rejectClose:false,defaultYes:false,modal:true
        });
      },
      prepareGroup: sequence => { requireServices(); return manualLauncher.prepare(sequence); },
      openSession:()=>sessionView!.open(), groupActive:()=>coordinator.status.canExit,
      observeLocal(listener) {subscribers.add(listener);listener(localPlayer.getState());return () => {subscribers.delete(listener);};},
      async confirmDiscard() {
        return host.foundry.applications.api.DialogV2.confirm({
          window:{title:localize('STAGECRAFT.Editor.Unsaved')}, content:`<p>${localize('STAGECRAFT.Editor.DiscardQuestion')}</p>`,
          yes:{label:localize('STAGECRAFT.Editor.Discard')}, no:{label:localize('STAGECRAFT.Editor.KeepEditing')}, rejectClose:false,defaultYes:false,modal:true
        });
      },
      async confirmDeleteSequence(name, hasUnsavedChanges) {
        const content = document.createElement('div');
        const question = document.createElement('p');
        const emphasizedName = document.createElement('strong');
        emphasizedName.textContent = name;
        question.append(
          document.createTextNode(localize('STAGECRAFT.Editor.DeleteQuestionPrefix')),
          emphasizedName,
          document.createTextNode(localize('STAGECRAFT.Editor.DeleteQuestionSuffix'))
        );
        content.append(question);
        if (hasUnsavedChanges) {
          const warning = document.createElement('p');
          warning.textContent = localize('STAGECRAFT.Editor.DeleteUnsavedWarning');
          content.append(warning);
        }
        return host.foundry.applications.api.DialogV2.confirm({
          window:{title:localize('STAGECRAFT.Editor.DeleteSequence')}, content,
          yes:{label:localize('STAGECRAFT.Editor.Delete')}, no:{label:localize('STAGECRAFT.Editor.Cancel')},
          rejectClose:false, defaultYes:false, modal:true
        });
      },
      async refreshSequenceShortcuts() {
        // A trigger-cache error is reported by its observer; the completed Save remains successful.
        await Promise.all([shortcuts?.refresh(),automaticLauncher?.refresh().catch(()=>{})]);
      }
    };
    const onEscape=(event:KeyboardEvent)=>{
      if (audienceDialogOpen) return;
      if(event.key==='Escape' && coordinator.status.canExit) {event.preventDefault();coordinator.exitLocal();}
      if(event.key==='Escape' && localPlayer.getState().phase==='preparing') localPlayer.stop();
    };
    window.addEventListener('keydown',onEscape,{capture:true});
    if(host.game.user.isGM) {
      automaticLauncher=new SavedTriggerLauncher({
        repository:requireServices().repository,coordinator,
        controllerUserId:host.game.user.id,
        users:()=>host.game.users.contents.map(user=>({id:user.id,name:user.name,role:user.role,active:user.active})),
        onAccepted:()=>sessionView!.openAutomatically(),
        report:error=>{
          const key=`STAGECRAFT.Error.${'code' in error ? String(error.code) : ''}`;
          const message=localize(key);
          host.ui.notifications.error(message===key ? localize('STAGECRAFT.Editor.OperationFailed') : message);
        }
      });
      combatTriggerBinding=new CombatTriggerBinding({
        hooks:host.Hooks,combats:()=>host.game.combats.contents,
        activeCombatId:()=>host.game.combats.active?.id ?? null,
        events:events=>{void automaticLauncher?.dispatch(events).catch(()=>{});}
      });
      const triggerLibraryChanged=(...args:unknown[])=>{
        const document=args[0] as {pack?:unknown;flags?:Record<string,unknown>} | undefined;
        const flags=document?.flags?.[MODULE_ID] as {role?:unknown} | undefined;
        if(document?.pack==='world.stagecraft-sequences' && ['sequence','revision','sequence-creation-claim'].includes(String(flags?.role))) {
          void automaticLauncher?.refresh().catch(()=>{});
        }
      };
      const libraryHooks=['createJournalEntry','updateJournalEntry','deleteJournalEntry',
        'createJournalEntryPage','updateJournalEntryPage','deleteJournalEntryPage'];
      for(const hook of libraryHooks) host.Hooks.on(hook,triggerLibraryChanged);
      window.addEventListener('pagehide',()=>{
        for(const hook of libraryHooks) host.Hooks.off(hook,triggerLibraryChanged);
        combatTriggerBinding?.dispose();automaticLauncher?.dispose();
      },{once:true});
      void automaticLauncher.refresh().catch(()=>{});
      shortcuts=new SceneShortcuts({
        isGM:()=>host.game.user.isGM, repository:requireServices().repository, openEditor,
        openPlayback:()=>sessionView!.open(),
        prepare:async sequence=>{ await requireServices().prepareGroup(sequence); },localize,
        repaint:repaintControls,
        report(error) {
          const code=error && typeof error==='object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
          const key=`STAGECRAFT.Error.${code}`;const message=localize(key);
          host.ui.notifications.error(message===key ? localize('STAGECRAFT.Editor.OperationFailed') : message);
        }
      });
      repaintControls();
      void shortcuts.refresh();
    }
    const module = host.game.modules.get(MODULE_ID);
    if (module) module.api = Object.freeze({
      ...module.api,
      openEditor,
      stopLocal: () => {localPlayer.stop();coordinator.exitLocal();},
      openSession:()=>{requireServices();sessionView!.open();}
    });
    window.addEventListener('pagehide', () => {
      coordinator.dispose();localPlayer.stop();groupPlayer.stop();sessionView?.dispose();
      shortcuts?.dispose();
      audioGate.dispose();window.removeEventListener('keydown',onEscape,true);
      for(const [timer,resolve] of queryTimers){clearTimeout(timer);resolve();}queryTimers.clear();
      delete host.CONFIG.queries[`${MODULE_ID}.session`];
      host.game.socket.off('modifyDocument',documentChanged);
    }, {once:true});
  });
}
