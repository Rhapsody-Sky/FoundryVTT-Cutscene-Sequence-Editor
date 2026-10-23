import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createBarsSequence, createBreaksSequence, SEQUENCE_LIMITS, validateSequence } from '../src/domain/validation.js';
import type { AudioClipV2, AudioClipV3, SequenceV1, TextClip, Transition, VideoClip } from '../src/domain/sequence.js';
import { patchInspectedClip, selectedClip } from '../src/ui/clip-inspector.js';
import { TimelineView, type TimelineFrameScheduler } from '../src/ui/timeline-view.js';
import { applyEditorTimelineCommand, applyTimelineCommand, type TimelineCommand } from '../src/application/timeline-commands.js';
import { DraftService } from '../src/application/draft-service.js';
import { upgradeSequenceToTimelineBreaks } from '../src/domain/breaks.js';
import { EditorView, type EditorServices } from '../src/ui/editor-view.js';
import { LocalPlayer } from '../src/playback/local-player.js';
import { createAnimatedPattern } from '../src/domain/animated-pattern.js';

function ids(prefix = 'ui') { let next=0; return ()=>`${prefix}-${++next}`; }
test('inspector selection uses clip ID and keeps sibling clips and extension data',()=>{
  const makeId=ids(); let sequence=createBarsSequence('Rich timeline',makeId);
  sequence=applyTimelineCommand(sequence,{kind:'add-track'},makeId);
  sequence=applyTimelineCommand(sequence,{kind:'add-clip',type:'text',trackId:sequence.tracks[1]!.id,startMs:0},makeId);
  sequence=applyTimelineCommand(sequence,{kind:'duplicate-clip',clipId:sequence.clips[1]!.id},makeId);
  const first=sequence.clips[1] as TextClip;
  const selected=sequence.clips[2] as TextClip;
  const rich={...selected,customClip:{keep:true},properties:{...selected.properties,customProperties:{keep:true},box:{...selected.properties.box,customBox:42},outline:{enabled:true,color:'#fff000',opacity:0.5,width:2,customEffect:'keep'}}};
  const patched=patchInspectedClip(rich,{text:{startMs:rich.startMs,entranceMs:800,durationMode:'fixed',durationMs:5000,exitMs:800,text:'Second title',fontFamily:rich.properties.fontFamily,fontSize:96,minimumFontSize:36,color:'#ffffff',align:'center',box:rich.properties.box,shrinkToFit:true,outline:{enabled:true,color:'#112233',opacity:0.7,width:4}}}) as TextClip & {customClip:{keep:boolean}};
  const result={...sequence,clips:sequence.clips.map(c=>c.id===selected.id?patched:c)};
  assert.equal(selectedClip(result,selected.id)?.id,selected.id);
  assert.deepEqual(result.clips[1],first);
  assert.equal(patched.customClip.keep,true);
  assert.equal((patched.properties as unknown as {customProperties:{keep:boolean}}).customProperties.keep,true);
  assert.equal((patched.properties.outline as unknown as {customEffect:string}).customEffect,'keep');
  assert.equal(patched.properties.text,'Second title');
});
test('inspector keeps version 2 video source ranges and media reference extensions',()=>{
  const sequence=createBarsSequence('Video',ids());
  const clip:VideoClip={...sequence.clips[0]!,type:'video',typeVersion:2,duration:{kind:'media'},properties:{source:{kind:'foundry-file',path:'scene.webm',assetId:'keep'} as VideoClip['properties']['source'],durationMs:10000,sourceRange:{inMs:1000,outMs:6000},fit:'cover',volume:0.5,muted:true}};
  const result=patchInspectedClip(clip,{video:{startMs:0,entranceMs:800,sourcePath:'scene.webm',durationMs:10000,fit:'contain',volume:0.3,muted:true}}) as VideoClip;
  assert.equal(result.typeVersion,2);assert.deepEqual(result.properties.sourceRange,clip.properties.sourceRange);
  assert.equal((result.properties.source as unknown as {assetId:string}).assetId,'keep');
});

function dom(t:TestContext) {
  let active:FakeElement|null=null, hit:FakeElement|null=null;
  class FakeElement extends EventTarget {
    parentElement:FakeElement|null=null;children:FakeElement[]=[];dataset:Record<string,string>={};style:Record<string,string>={};className='';textContent='';hidden=false;disabled=false;inert=false;type='';name='';value='';min='';max='';step='';title='';scrollLeft=0;scrollTop=0;clientWidth=1000;attributes:Record<string,string>={};tabIndex=0;
    get options() { return this.children; }
    get childElementCount() { return this.children.length; }
    classList={add:(...names:string[])=>{this.className+=' '+names.join(' ');},remove:(name:string)=>{this.className=this.className.split(' ').filter(n=>n!==name).join(' ');},toggle:(name:string,force?:boolean)=>{if(force)this.classList.add(name);else this.classList.remove(name);}};
    constructor(readonly tag='div'){super();}
    append(...nodes:FakeElement[]) {for(const node of nodes){node.parentElement?.removeChild(node);node.parentElement=this;this.children.push(node);}}
    insertBefore(node:FakeElement,before:FakeElement|null) {node.parentElement?.removeChild(node);node.parentElement=this;const index=before?this.children.indexOf(before):-1;if(index<0)this.children.push(node);else this.children.splice(index,0,node);return node;}
    removeChild(node:FakeElement){this.children=this.children.filter(c=>c!==node);node.parentElement=null;node.captured.clear();}
    remove(){this.parentElement?.removeChild(this);}
    replaceChildren(){for(const c of [...this.children])this.removeChild(c);}
    contains(node:unknown):boolean{return node===this||this.children.some(c=>c.contains(node));}
    captured=new Set<number>();
    setAttribute(name:string,value:string){this.attributes[name]=value;} getAttribute(name:string){return this.attributes[name]??null;} focus(){active=this;} select(){} checkValidity(){return true;} setPointerCapture(id:number){this.captured.add(id);}
    hasPointerCapture(id:number){return this.captured.has(id);}
    releasePointerCapture(id:number){this.captured.delete(id);}
    getBoundingClientRect(){return {left:180,top:0,right:1180,bottom:56,width:1000,height:56};}
    matches(selector:string):boolean {
      if (selector === '*') return true;
      if (selector.includes(',')) return selector.split(',').some(part => this.matches(part));
      if (selector.startsWith('button[')) return this.tag === 'button' && this.matches(selector.slice(6));
      if(selector==='[name]')return !!this.name;
      const name=selector.match(/^\[name="([^"]+)"\]$/);if(name)return this.name===name[1];
      if(selector.startsWith('.'))return selector.slice(1).split('.').every(c=>this.className.split(' ').includes(c));
      const match=selector.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/);if(!match)return false;
      const key=match[1]!.replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase());return key in this.dataset&&(match[2]===undefined||this.dataset[key]===match[2]);
    }
    closest<T>(selector:string):T|null{return this.matches(selector)?this as unknown as T:this.parentElement?.closest<T>(selector)??null;}
    querySelectorAll<T>(selector:string):T[]{const all:T[]=[];for(const child of this.children){if(child.matches(selector))all.push(child as unknown as T);all.push(...child.querySelectorAll<T>(selector));}return all;}
    querySelector<T>(selector:string):T|null{return this.querySelectorAll<T>(selector)[0]??null;}
  }
  const globals:Record<string,unknown>={Element:FakeElement,HTMLElement:FakeElement,HTMLInputElement:FakeElement,HTMLSelectElement:FakeElement,HTMLTextAreaElement:FakeElement,document:{createElement:(tag:string)=>new FakeElement(tag),get activeElement(){return active;},elementFromPoint:()=>hit}};
  const originals=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,value});
  t.after(()=>{for(const[key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
  return {FakeElement,setHit:(node:FakeElement)=>{hit=node;},dispatch:(root:FakeElement,type:string,target:FakeElement,props:Record<string,unknown>={})=>{const event=new Event(type,{cancelable:true});Object.defineProperties(event,Object.fromEntries(Object.entries({target,...props}).map(([key,value])=>[key,{value}])));root.dispatchEvent(event);return event;}};
}

function frames() {
  let id = 0, time = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const scheduler: TimelineFrameScheduler = { request: callback => { pending.set(++id, callback); return id; }, cancel: key => { pending.delete(key); } };
  return { scheduler, get pending() { return pending.size; }, step(elapsed = 16) { time += elapsed; const batch = [...pending.values()]; pending.clear(); for (const callback of batch) callback(time); } };
}

function sequenceWithBreaks(markers: readonly { id: string; positionMs: number }[] = []): SequenceV1 {
  const base = upgradeSequenceToTimelineBreaks(createBreaksSequence('Inner Breaks', ids('break-sequence')));
  return validateSequence({ ...base, end: { kind: 'fixed', durationMs: 5_000 }, breaks: markers });
}

async function breakEditor(t: TestContext, original = sequenceWithBreaks([{ id: 'inspected-break', positionMs: 1_000 }, { id: 'other-break', positionMs: 4_000 }])) {
  const ui = dom(t), root = new ui.FakeElement();
  let persisted = structuredClone(original);
  const saves: SequenceV1[] = [];
  const library = new ui.FakeElement(); library.dataset.stagecraftLibrary = ''; root.append(library);
  const inspector = new ui.FakeElement(); inspector.dataset.stagecraftInspector = ''; root.append(inspector);
  const tabs = new ui.FakeElement(); tabs.className = 'stagecraft-inspector-tabs'; root.append(tabs);
  const pages = new Map<string, InstanceType<typeof ui.FakeElement>>(), tabButtons = new Map<string, InstanceType<typeof ui.FakeElement>>();
  for (const name of ['clip', 'sequence']) {
    const tab = new ui.FakeElement('button'); tab.dataset.stagecraftInspectorTab = name; tabs.append(tab); tabButtons.set(name, tab);
    const page = new ui.FakeElement(); page.dataset.stagecraftInspectorPage = name; inspector.append(page); pages.set(name, page);
  }
  const clipSection = new ui.FakeElement(); clipSection.className = 'stagecraft-selected-clip-section'; pages.get('clip')!.append(clipSection);
  const panel = new ui.FakeElement(); panel.dataset.stagecraftElementPanel = 'bars'; clipSection.append(panel);
  const breakPanel = new ui.FakeElement(); breakPanel.dataset.stagecraftBreakPanel = ''; pages.get('clip')!.append(breakPanel);
  const fields = new Map<string, InstanceType<typeof ui.FakeElement>>();
  const field = (name: string, parent: InstanceType<typeof ui.FakeElement>, options?: string[]) => {
    const input = new ui.FakeElement(options ? 'select' : 'input'); input.name = name;
    for (const value of options ?? []) { const option = new ui.FakeElement('option'); option.value = value; input.append(option); }
    fields.set(name, input); parent.append(input); return input;
  };
  const position = field('break-position', breakPanel); position.type = 'number';
  position.checkValidity = () => position.value.trim() !== '' && Number.isFinite(Number(position.value)) && Number(position.value) >= 0 && Number(position.value) <= 604_800;
  field('clip-track', clipSection);
  field('bars-start', panel); field('bars-height', panel); field('bars-entrance', panel);
  field('bars-duration-mode', panel, ['fixed', 'sequence-end']); field('bars-duration', panel);
  const sequencePage = pages.get('sequence')!;
  field('ending', sequencePage, ['automatic', 'fixed', 'manual', 'media']); field('sequence-duration', sequencePage); field('end-media', sequencePage);
  const remove = new ui.FakeElement('button'); remove.dataset.stagecraftAction = 'remove-break'; breakPanel.append(remove);
  for (const action of ['duplicate-clip', 'remove-clip']) { const button = new ui.FakeElement('button'); button.dataset.stagecraftAction = action; clipSection.append(button); }
  const timeline = new ui.FakeElement(); timeline.dataset.stagecraftTimeline = ''; root.append(timeline);
  const message = new ui.FakeElement(); message.dataset.stagecraftMessage = ''; root.append(message);
  const services: EditorServices = {
    makeId: ids('editor'), repository: {
      list: async () => [persisted], read: async () => structuredClone(persisted),
      save: async value => { saves.push(structuredClone(value)); persisted = { ...structuredClone(value), revision: value.revision + 1 }; return persisted; },
      delete: async () => {}
    },
    localPlayer: new LocalPlayer({ now: () => 0, requestFrame: () => 0, cancelFrame: () => {} }),
    localize: key => key === 'STAGECRAFT.Error.BREAK_POSITION_TAKEN' ? 'Break position occupied' : key.startsWith('STAGECRAFT.Error.') ? key.slice('STAGECRAFT.Error.'.length) : key,
    confirmDiscard: async () => true, confirmDeleteSequence: async () => false, observeLocal: () => () => {}, prepareGroup: async () => {},
    openSession() {}, groupActive: () => false, chooseVideo: async () => null, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services); await view.mount(root as unknown as HTMLElement); t.after(() => view.detach());
  const driver = view as unknown as { act(action: string, id?: string): Promise<void>; selectClip(id: string): void; scrub(ms: number): void };
  const selectMarker = (id = 'inspected-break') => ui.dispatch(timeline, 'click', timeline.querySelector<InstanceType<typeof ui.FakeElement>>('[data-timeline-break="' + id + '"]')!);
  const edit = (value: string, focus = true) => {
    if (focus) { position.focus(); ui.dispatch(root, 'focusin', position); }
    position.value = value; ui.dispatch(root, 'input', position);
  };
  return { ...ui, root, view, driver, timeline, fields, position, library, clipSection, breakPanel, remove, message, pages, tabButtons, selectMarker, edit, original, saves, get persisted() { return structuredClone(persisted); } };
}

test('Break library entry and marker selection show the Break inspector and exclude clip actions', async t => {
  const f = await breakEditor(t), clip = f.original.clips[0]!;
  const libraryBreak = f.library.querySelector<InstanceType<typeof f.FakeElement>>('[data-preset-id="break"]')!;
  assert.ok(libraryBreak); assert.equal(libraryBreak.disabled, false);
  f.dispatch(f.tabButtons.get('sequence')!, 'click', f.tabButtons.get('sequence')!);
  f.selectMarker();
  assert.equal(f.pages.get('clip')!.hidden, false); assert.equal(f.pages.get('sequence')!.hidden, true);
  assert.equal(f.tabButtons.get('clip')!.textContent, 'STAGECRAFT.Editor.InnerBreak');
  assert.equal(f.breakPanel.hidden, false); assert.equal(f.clipSection.hidden, true);
  assert.equal(f.position.value, '1'); assert.equal(f.position.disabled, false);
  assert.equal(f.fields.get('bars-start')!.disabled, true);
  assert.equal(f.root.querySelector<InstanceType<typeof f.FakeElement>>('[data-stagecraft-action="remove-clip"]')!.disabled, true);
  assert.equal(f.timeline.querySelector<InstanceType<typeof f.FakeElement>>('[data-timeline-clip="' + clip.id + '"]')!.getAttribute('aria-pressed'), 'false');
  const before = structuredClone(f.view.draft.draft!.clips);
  f.fields.get('bars-start')!.value = '123'; f.dispatch(f.root, 'input', f.fields.get('bars-start')!);
  assert.deepEqual(f.view.draft.draft!.clips, before, 'events from inactive clip forms do not edit clips');
  f.driver.selectClip(clip.id);
  assert.equal(f.breakPanel.hidden, true); assert.equal(f.position.disabled, true); assert.equal(f.clipSection.hidden, false);
  assert.equal(f.tabButtons.get('clip')!.textContent, 'STAGECRAFT.Editor.InspectorTabClip');
  assert.equal(f.timeline.querySelector<InstanceType<typeof f.FakeElement>>('[data-timeline-break="inspected-break"]')!.getAttribute('aria-pressed'), 'false');
  const previous = structuredClone(f.view.draft.draft!);
  f.position.value = '7'; f.dispatch(f.root, 'input', f.position);
  assert.deepEqual(f.view.draft.draft, previous, 'the inactive Break field cannot move markers');
});

test('Break position typing retains focus and text, validates collisions and limits, and groups undo history', async t => {
  const f = await breakEditor(t); f.selectMarker();
  const clips = structuredClone(f.view.draft.draft!.clips);
  f.edit('1.20'); f.edit('1.250', false);
  assert.equal(document.activeElement, f.position); assert.equal(f.position.value, '1.250');
  assert.equal(f.view.draft.draft!.breaks![0]!.positionMs, 1_250);
  assert.deepEqual(f.view.draft.draft!.clips, clips);
  const enter = f.dispatch(f.root, 'keydown', f.position, { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true); assert.equal(f.position.value, '1.25');
  f.dispatch(f.root, 'change', f.position); f.dispatch(f.root, 'focusout', f.position);
  await f.driver.act('undo');
  assert.equal(f.view.draft.draft!.breaks![0]!.positionMs, 1_000); assert.equal(f.view.draft.canUndo, false, 'one focus session creates one undo step, including Enter and blur');
  await f.driver.act('redo'); assert.equal(f.view.draft.draft!.breaks![0]!.positionMs, 1_250);
  for (const value of ['', '-1', '604800.001', '4']) {
    f.edit(value); assert.equal(f.view.draft.draft!.breaks![0]!.positionMs, 1_250, `invalid ${value} keeps the last valid position`);
  }
  assert.equal(f.message.textContent, 'Break position occupied');
  f.edit('2.500'); assert.equal(f.view.draft.draft!.breaks![0]!.positionMs, 2_500);
  f.dispatch(f.root, 'focusout', f.position); assert.equal(f.position.value, '2.5');
  const save = new f.FakeElement('button'); save.dataset.stagecraftAction = 'save'; f.root.append(save);
  const preview = new f.FakeElement('button'); preview.dataset.stagecraftAction = 'preview'; f.root.append(preview);
  f.edit('4');
  assert.equal(save.disabled, false, 'Save remains available to explain and recover from an invalid Break position');
  assert.equal(preview.disabled, true, 'invalid Break edits cannot start preview');
  f.driver.selectClip(f.original.clips[0]!.id);
  assert.equal(save.disabled, false);
  assert.equal(preview.disabled, false, 'switching to a clip removes validation from the inactive Break form');
});

test('selecting a Break after an invalid clip edit refreshes actions while preserving the captured marker', async t => {
  const f = await breakEditor(t);
  const actions = ['save', 'preview'].map(action => { const button = new f.FakeElement('button'); button.dataset.stagecraftAction = action; f.root.append(button); return button; });
  const clipField = f.fields.get('bars-start')!;
  clipField.checkValidity = () => false; clipField.focus();
  clipField.value = '-1'; f.dispatch(f.root, 'input', clipField);
  assert.equal(actions[0]!.disabled, false, 'Save remains reachable for field-specific validation feedback');
  assert.equal(actions[1]!.disabled, true, 'preview remains blocked by the invalid clip edit');
  const before = structuredClone(f.view.draft.draft!);
  const marker = f.timeline.querySelector<InstanceType<typeof f.FakeElement>>('[data-timeline-break="inspected-break"]')!;
  f.dispatch(f.timeline, 'pointerdown', marker, { button: 0, pointerId: 401, clientX: 260, clientY: 44 });
  assert.equal(actions.every(button => !button.disabled), true, 'hidden invalid clip fields cannot keep the selected Break actions disabled');
  assert.equal(f.timeline.querySelector('[data-timeline-break="inspected-break"]'), marker, 'selection does not replace the node being captured');
  assert.equal(f.timeline.hasPointerCapture(401), true);
  f.dispatch(f.timeline, 'pointermove', marker, { pointerId: 401, clientX: 340, clientY: 44 });
  assert.equal(f.position.value, '2', 'the inspector follows the marker drag preview');
  f.dispatch(f.timeline, 'pointercancel', f.timeline, { pointerId: 401 });
  assert.equal(f.position.value, '1', 'cancellation restores the authored inspector position');
  assert.deepEqual(f.view.draft.draft, before); assert.equal(f.view.draft.canUndo, false);
});

test('adding, deleting, undoing and loading reconcile Break selection with inspector visibility', async t => {
  const f = await breakEditor(t); f.driver.scrub(2_500);
  await f.driver.act('add-preset', 'break');
  const added = f.view.draft.draft!.breaks!.find(marker => marker.positionMs === 2_500)!;
  assert.equal(f.breakPanel.hidden, false); assert.equal(f.position.value, '2.5');
  await f.driver.act('add-preset', 'break'); assert.equal(f.view.draft.draft!.breaks!.length, 3);
  assert.equal(f.timeline.querySelector<InstanceType<typeof f.FakeElement>>('[data-timeline-break="' + added.id + '"]')!.getAttribute('aria-pressed'), 'true');
  await f.driver.act('remove-clip'); assert.equal(f.view.draft.draft!.clips.length, f.original.clips.length);
  await f.driver.act('remove-break'); assert.equal(f.view.draft.draft!.breaks!.length, 2);
  assert.equal(f.breakPanel.hidden, false); assert.equal(f.position.value, '1', 'deleting selects the nearest remaining marker');
  await f.driver.act('undo'); assert.equal(f.view.draft.draft!.breaks!.length, 3);
  await f.driver.act('undo'); assert.equal(f.view.draft.draft!.breaks!.length, 2);
  f.selectMarker();
  await f.driver.act('new');
  assert.equal(f.breakPanel.hidden, true); assert.equal(f.position.disabled, true);
  await f.driver.act('load', f.original.id);
  assert.equal(f.breakPanel.hidden, true); assert.equal(f.clipSection.hidden, false);
  f.selectMarker('other-break'); assert.equal(f.position.value, '4');
  await f.driver.act('remove-break'); await f.driver.act('remove-break');
  assert.equal(f.view.draft.draft!.breaks!.length, 0); assert.equal(f.breakPanel.hidden, true);
  assert.equal(f.position.disabled, true); assert.equal(f.clipSection.hidden, false);
});

function legacyBreakSequence(): SequenceV1 {
  const base = createBarsSequence('Legacy inspector', ids('legacy-editor'));
  return validateSequence({ ...base, futureSequence: { keep: true }, end: { kind: 'manual', durationMs: 5_000, futureEnd: 'keep' },
    tracks: [...base.tracks,
      { id: 'legacy-video-track', name: 'Video', kind: 'visual', order: 1, enabled: true, locked: false },
      { id: 'legacy-audio-track', name: 'Audio', kind: 'audio', order: 2, enabled: true, locked: false }],
    clips: [...base.clips,
      { ...base.clips[0]!, id: 'legacy-video', trackId: 'legacy-video-track', type: 'video', typeVersion: 3, duration: { kind: 'media' },
        properties: { source: { kind: 'foundry-file', path: 'video.webm', futureSource: 'keep' }, durationMs: 5_000, fit: 'contain', volume: 1, muted: false, loop: true } },
      { ...base.clips[0]!, id: 'legacy-audio', trackId: 'legacy-audio-track', type: 'audio', typeVersion: 1, duration: { kind: 'media', futureDuration: 'keep' },
        properties: { source: { kind: 'foundry-file', path: 'sound.ogg' }, durationMs: 5_000, volume: 1, muted: false, futureProperty: 'keep' } }]
  });
}

for (const path of ['library', 'double-click'] as const) test(`legacy ${path} Break insertion adopts semantics in one draft edit and only Save persists it`, async t => {
  const legacy = legacyBreakSequence(), original = structuredClone(legacy), f = await breakEditor(t, legacy);
  const button = f.library.querySelector<InstanceType<typeof f.FakeElement>>('[data-preset-id="break"]')!;
  assert.equal(button.disabled, false); assert.equal(button.title, 'STAGECRAFT.Editor.AddBreakHint');
  assert.deepEqual(f.view.draft.draft, original); assert.equal(f.view.draft.dirty, false);
  assert.equal(f.root.querySelector('[data-stagecraft-action="upgrade-breaks"]'), null);
  f.driver.scrub(2_500);
  if (path === 'library') f.dispatch(f.root, 'click', button);
  else {
    const lane = f.timeline.querySelector<InstanceType<typeof f.FakeElement>>('[data-inner-break-lane]')!;
    const scroll = f.timeline.querySelector<InstanceType<typeof f.FakeElement>>('.stagecraft-break-lane-scroll')!;
    f.dispatch(f.timeline, 'dblclick', lane, { clientX: scroll.getBoundingClientRect().left + 180 + 200 });
  }
  const adopted = f.view.draft.draft!;
  assert.equal(adopted.schemaVersion, 3); assert.equal(adopted.breaks!.length, 1);
  assert.equal(adopted.breaks![0]!.positionMs, 2_500);
  assert.deepEqual(adopted.end, original.end);
  const expected = { ...original, schemaVersion: 3, breaks: adopted.breaks, clips: original.clips.map(clip => {
    if (clip.type === 'video') return { ...clip, typeVersion: 5, properties: { ...clip.properties, onBreak: 'loop' } };
    if (clip.type === 'audio') return { ...clip, typeVersion: 3, duration: { ...clip.duration, kind: 'fixed', milliseconds: 5_000 },
      properties: { ...clip.properties, loop: false, loopIndefinitely: false, onBreak: 'pause' } };
    return clip;
  }) };
  assert.deepEqual(adopted, expected, 'adoption keeps the entire payload except the explicitly adopted media semantics and added marker');
  assert.equal(f.breakPanel.hidden, false); assert.equal(f.position.value, '2.5');
  assert.deepEqual(legacy, original); assert.deepEqual(f.persisted, original); assert.equal(f.saves.length, 0);
  await f.driver.act('undo');
  assert.deepEqual(f.view.draft.draft, original); assert.equal(f.view.draft.dirty, false); assert.equal(f.view.draft.canUndo, false);
  assert.equal(f.breakPanel.hidden, true); assert.equal(f.position.disabled, true);
  await f.driver.act('redo'); assert.deepEqual(f.view.draft.draft, adopted);
  assert.equal(f.breakPanel.hidden, true, 'restored data does not retain a stale marker selection');
  assert.deepEqual(f.persisted, original); assert.equal(f.saves.length, 0);
  // Saving probes media again; supply metadata without involving real files or playback.
  const createElement = document.createElement.bind(document);
  document.createElement = ((tag: string) => tag === 'video' || tag === 'audio'
    ? Object.assign(new f.FakeElement(tag), { readyState: 1, duration: 5, load() {}, pause() {}, removeAttribute() {}, remove() {} })
    : createElement(tag)) as typeof document.createElement;
  await f.driver.act('save');
  assert.equal(f.saves.length, 1, f.message.textContent); assert.equal(f.persisted.schemaVersion, 3);
  assert.deepEqual(f.persisted.breaks, adopted.breaks); assert.deepEqual(legacy, original);
});

for (const failure of ['adoption', 'command'] as const) test(`legacy Break ${failure} failure leaves payload, history and repository untouched`, async t => {
  const base = legacyBreakSequence();
  const legacy = validateSequence({ ...base, clips: failure === 'adoption'
    ? base.clips.map(clip => { if (clip.type !== 'audio') return clip; const { durationMs: _durationMs, ...properties } = clip.properties; return { ...clip, properties }; })
    : [...base.clips, { ...base.clips[0]!, id: 'overlapping-bars' }] });
  const original = structuredClone(legacy), f = await breakEditor(t, legacy);
  f.driver.scrub(2_500); await f.driver.act('add-preset', 'break');
  assert.deepEqual(f.view.draft.draft, original); assert.deepEqual(legacy, original); assert.deepEqual(f.persisted, original);
  assert.equal(f.saves.length, 0); assert.equal(f.view.draft.dirty, false);
  assert.equal(f.view.draft.canUndo, false); assert.equal(f.view.draft.canRedo, false);
  assert.equal(f.breakPanel.hidden, true);
  assert.equal(f.message.textContent, failure === 'adoption' ? 'MEDIA_METADATA_REQUIRED' : 'CLIP_OVERLAP');
});

test('Snap exposes its localized on/off state and keeps aria-pressed in sync', t => {
  const ui = dom(t), root = new ui.FakeElement(), view = new TimelineView(root as unknown as HTMLElement, key => ({ SnapOn: 'Snap: On', SnapOff: 'Snap: Off' })[key as 'SnapOn' | 'SnapOff'] ?? key, {
    select() {}, scrub() {}, command() {}, error() {}, beforeEdit() {}
  });
  view.render(sequenceWithBreaks(), null);
  const button = () => root.querySelector<InstanceType<typeof ui.FakeElement>>('[data-timeline-action="snap"]')!;
  assert.equal(button().textContent, 'Snap: On'); assert.equal(button().getAttribute('aria-pressed'), 'true');
  ui.dispatch(root, 'click', button());
  assert.equal(button().textContent, 'Snap: Off'); assert.equal(button().getAttribute('aria-pressed'), 'false');
  ui.dispatch(root, 'click', button());
  assert.equal(button().textContent, 'Snap: On'); assert.equal(button().getAttribute('aria-pressed'), 'true');
  view.dispose();
});

test('inner Break lane stays aligned through scroll and zoom, and shows inactive and held markers clearly', t => {
  const fixture = dom(t), root = new fixture.FakeElement();
  const sequence = sequenceWithBreaks([
    { id: 'active-marker', positionMs: 4_000 },
    { id: 'endpoint-marker', positionMs: 5_000 },
    { id: 'late-marker', positionMs: 6_000 }
  ]);
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, command: () => {}, error: error => { throw error; }, beforeEdit: () => {}
  });
  view.render(sequence, null, 2_000);
  const active = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="active-marker"]')!;
  const endpoint = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="endpoint-marker"]')!;
  const late = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="late-marker"]')!;
  assert.equal(active.style.left, '320px', 'marker positions share the clip ruler scale after the fixed gutter');
  assert.equal(endpoint.className.includes('inactive'), true, 'a marker at the endpoint is inactive');
  assert.equal(late.className.includes('inactive'), true, 'a marker beyond the endpoint stays visible and inactive');
  assert.match(late.title, /InnerBreakInactive/, 'the inactive reason is available as a tooltip');
  assert.equal(active.getAttribute('aria-label')?.includes('InnerBreak'), true, 'the symbol has an accessible Break label');

  const timelineScroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!;
  const breakScroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-break-lane-scroll')!;
  timelineScroll.scrollLeft = 180; timelineScroll.dispatchEvent(new Event('scroll'));
  assert.equal(breakScroll.scrollLeft, 180, 'the always-visible lower lane follows timeline horizontal scrolling');
  breakScroll.scrollLeft = 260; breakScroll.dispatchEvent(new Event('scroll'));
  assert.equal(timelineScroll.scrollLeft, 260, 'scrolling the lower lane keeps the clip viewport aligned');

  const zoom = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-zoom]')!;
  zoom.value = '160'; fixture.dispatch(root, 'change', zoom);
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="active-marker"]')!.style.left, '640px');
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break-guide="active-marker"]')!.style.left, '820px');
  view.setPlaybackState({ phase: 'paused', positionMs: 4_000, breakId: 'active-marker', holdElapsedMs: 200 });
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="active-marker"]')!.className.includes('active'), true);
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break-guide="active-marker"]')!.className.includes('active'), true);
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="endpoint-marker"]')!.className.split(/\s+/).includes('active'), false);
  view.dispose();
});

test('Break lane insertion reports the marker limit and still selects existing markers', t => {
  const fixture = dom(t), root = new fixture.FakeElement();
  const sequence = sequenceWithBreaks(Array.from({ length: 128 }, (_, index) => ({ id: `limit-${index}`, positionMs: index * 10 })));
  const errors: unknown[] = [], selected: (string | null)[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: () => {}, selectBreak: id => selected.push(id), scrub: () => {},
    command: () => assert.fail('a full marker list cannot be changed'), error: error => errors.push(error), beforeEdit: () => {}
  });
  view.render(sequence, null, 2_500);
  const lane = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-inner-break-lane]')!;
  const scroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-break-lane-scroll')!;
  fixture.dispatch(root, 'dblclick', lane, { clientX: scroll.getBoundingClientRect().left + 180 + 200 });
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as { code: string }).code, 'BREAK_LIMIT');
  view.setPlayhead(0);
  view.addBreakAtPlayhead();
  assert.deepEqual(selected, ['limit-0'], 'selecting an existing marker does not require a free slot');
  assert.equal(errors.length, 1);
  assert.equal(root.querySelectorAll('[data-timeline-break]').length, 128);
  view.dispose();
});

test('library Break insertion uses the playhead, selects the new marker, and forwards schema 1 gestures to the editor', t => {
  const fixture = dom(t), root = new fixture.FakeElement(), makeId = ids('edit');
  let sequence = createBreaksSequence('Schema 2', ids('schema2'));
  const commands: TimelineCommand[] = [], selectedClips: string[] = [], selectedBreaks: (string | null)[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: id => selectedClips.push(id), selectBreak: id => selectedBreaks.push(id), scrub: () => {},
    command: command => { commands.push(command); sequence = applyEditorTimelineCommand(sequence, command, makeId); view.render(sequence, null, 2_500); },
    error: error => { throw error; }, beforeEdit: () => {}
  });
  view.render(sequence, null, 2_500);
  assert.equal(root.querySelector('[data-timeline-action="add-break"]'), null);
  assert.equal(root.querySelector('[data-break-position]'), null);
  assert.equal(root.querySelector('[data-timeline-action="remove-break"]'), null);
  view.addBreakAtPlayhead();
  assert.deepEqual(commands[0], { kind: 'add-break', positionMs: 2_500 });
  assert.equal(sequence.schemaVersion, 3, 'the first marker edit upgrades schema 2 once');
  assert.equal(sequence.breaks?.[0]?.positionMs, 2_500);
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break]')!.className.includes('selected'), true);
  assert.deepEqual(selectedClips, [], 'Break selection uses its own inspector callback');
  assert.deepEqual(selectedBreaks, [sequence.breaks![0]!.id]);
  view.addBreakAtPlayhead();
  assert.equal(commands.length, 1, 'inserting at an occupied playhead selects the existing marker');

  view.render(sequence, null, 3_500);
  const lane = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-inner-break-lane]')!;
  const breakScroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-break-lane-scroll')!;
  fixture.dispatch(root, 'dblclick', lane, { clientX: breakScroll.getBoundingClientRect().left + 180 + 280 + 2 });
  assert.deepEqual(commands[1], { kind: 'add-break', positionMs: 3_500 }, 'double-click snaps to the playhead without scrubbing it');
  assert.equal(sequence.breaks?.length, 2);
  const existingId = sequence.breaks?.find(marker => marker.positionMs === 3_500)?.id;
  assert.equal(document.activeElement, root.querySelector('[data-timeline-break="' + existingId + '"]'), 'double-clicking the lane focuses the newly added marker');
  fixture.dispatch(root, 'dblclick', lane, { clientX: breakScroll.getBoundingClientRect().left + 180 + 280 + 2 });
  assert.equal(commands.length, 2, 'double-clicking near an existing marker selects it instead of creating an overlapping marker');
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="' + existingId + '"]')?.className.includes('selected'), true);
  view.dispose();

  const legacyRoot = new fixture.FakeElement(), legacy = createBarsSequence('Legacy', ids('legacy'));
  const legacyCommands: TimelineCommand[] = [];
  const legacyView = new TimelineView(legacyRoot as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, command: command => legacyCommands.push(command), error: () => {}, beforeEdit: () => {}
  });
  legacyView.render(legacy, null);
  legacyView.addBreakAtPlayhead();
  assert.deepEqual(legacyCommands, [{ kind: 'add-break', positionMs: 0 }]);
  assert.equal(legacy.schemaVersion, 1);
  legacyView.dispose();
});

function contextDom(t: TestContext) {
  const ui = dom(t), originalDocument = document;
  const body = new ui.FakeElement();
  const menuDocument = Object.assign(new EventTarget(), {
    createElement: originalDocument.createElement.bind(originalDocument), body, documentElement: body,
    defaultView: Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800 })
  });
  Object.defineProperty(menuDocument, 'activeElement', { get: () => originalDocument.activeElement });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: menuDocument });
  for (const [name, tag] of [['HTMLInputElement', 'input'], ['HTMLSelectElement', 'select'], ['HTMLTextAreaElement', 'textarea']] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: class {
      static [Symbol.hasInstance](node: unknown) { return node instanceof ui.FakeElement && node.tag === tag; }
    } });
  }
  return { ...ui, body, menuDocument };
}

test('timeline right-click selects the clip before opening its menu; keyboard and empty-lane context positions are routed', t => {
  const ui = contextDom(t), root = new ui.FakeElement(); ui.body.append(root);
  const sequence = sequenceWithBreaks([{ id: 'context-break', positionMs: 2000 }]);
  const clip = sequence.clips[0]!;
  const actions: { action: string; target: import('../src/ui/timeline-view.js').TimelineContextTarget }[] = [];
  const selections: string[] = [];
  let commands = 0;
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: id => { selections.push(id); view.render(sequence, id); },
    selectBreak: id => { if (id) selections.push(id); view.render(sequence, null, 0, id); },
    scrub() {}, command: () => { commands++; }, error: error => { throw error; }, beforeEdit() {},
    contextItems: target => [{ id: target.kind === 'space' ? 'paste-here' : 'copy', label: target.kind === 'space' ? 'Paste here' : 'Copy' }],
    contextAction: (action, target) => actions.push({ action, target })
  });
  t.after(() => view.dispose()); view.render(sequence, null);
  const firstNode = root.querySelector<InstanceType<typeof ui.FakeElement>>('[data-timeline-clip="' + clip.id + '"]')!;
  const event = ui.dispatch(root, 'contextmenu', firstNode, { clientX: 260, clientY: 30 });
  assert.equal(event.defaultPrevented, true); assert.deepEqual(selections, [clip.id]);
  let popup = ui.body.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu')!;
  assert.ok(popup, 'the menu survives selection-triggered timeline repaint');
  assert.equal(popup.getAttribute('role'), 'menu');
  popup.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu__item')!.dispatchEvent(new Event('click'));
  assert.deepEqual(actions, [{ action: 'copy', target: { kind: 'clip', id: clip.id, trackId: clip.trackId } }]);
  assert.equal(ui.body.querySelector('.stagecraft-timeline-context-menu'), null);
  const selectedNode = root.querySelector<InstanceType<typeof ui.FakeElement>>('[data-timeline-clip="' + clip.id + '"]')!;
  assert.equal(ui.dispatch(root, 'keydown', selectedNode, { key: 'F10', shiftKey: true }).defaultPrevented, true);
  assert.ok(ui.body.querySelector('.stagecraft-timeline-context-menu')); view.closeContextMenu();
  const lane = root.querySelector<InstanceType<typeof ui.FakeElement>>('[data-lane-track="' + clip.trackId + '"]')!;
  lane.getBoundingClientRect = () => ({ left: -220, top: 0, right: 780, bottom: 56, width: 1000, height: 56 });
  ui.dispatch(root, 'contextmenu', lane, { clientX: 420, clientY: 30 });
  popup = ui.body.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu')!;
  popup.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu__item')!.dispatchEvent(new Event('click'));
  assert.deepEqual(actions.at(-1), { action: 'paste-here', target: { kind: 'space', positionMs: 8000, trackId: clip.trackId } }, 'scroll-translated lane bounds determine Paste here time');
  const marker = root.querySelector<InstanceType<typeof ui.FakeElement>>('[data-timeline-break="context-break"]')!;
  ui.dispatch(root, 'contextmenu', marker, { clientX: 350, clientY: 300 });
  popup = ui.body.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu')!;
  popup.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu__item')!.dispatchEvent(new Event('click'));
  assert.deepEqual(actions.at(-1), { action: 'copy', target: { kind: 'break', id: 'context-break' } });
  assert.equal(commands, 0, 'opening and copying context menus must not issue timeline edits');
});

test('timeline context menu retains native text menus, respects inert state and closes on repaint or disposal', t => {
  const ui = contextDom(t), root = new ui.FakeElement(); ui.body.append(root);
  const sequence = sequenceWithBreaks(); let actions = 0;
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select() {}, scrub() {}, command() {}, error: error => { throw error; }, beforeEdit() {},
    contextItems: () => [{ id: 'copy', label: 'Copy' }], contextAction: () => { actions++; }
  });
  t.after(() => view.dispose()); view.render(sequence, null);
  const name = root.querySelector<InstanceType<typeof ui.FakeElement>>('[data-track-name]')!;
  assert.equal(ui.dispatch(root, 'contextmenu', name, { clientX: 20, clientY: 10 }).defaultPrevented, false);
  const clip = root.querySelector<InstanceType<typeof ui.FakeElement>>('[data-timeline-clip]')!;
  root.inert = true;
  assert.equal(ui.dispatch(root, 'contextmenu', clip, { clientX: 200, clientY: 10 }).defaultPrevented, false);
  root.inert = false; ui.dispatch(root, 'contextmenu', clip, { clientX: 200, clientY: 10 });
  const oldButton = ui.body.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu__item')!;
  assert.ok(oldButton); view.render(sequence, null);
  assert.equal(ui.body.querySelector('.stagecraft-timeline-context-menu'), null);
  oldButton.dispatchEvent(new Event('click')); assert.equal(actions, 0, 'stale popup buttons cannot issue actions');
  const current = root.querySelector<InstanceType<typeof ui.FakeElement>>('[data-timeline-clip]')!;
  ui.dispatch(root, 'contextmenu', current, { clientX: 200, clientY: 10 }); view.dispose();
  assert.equal(ui.body.querySelector('.stagecraft-timeline-context-menu'), null);
});

test('secondary-button context on an animated surface survives queued selection scroll and pointer release', t => {
  const ui = contextDom(t), root = new ui.FakeElement(); ui.body.append(root);
  const base = sequenceWithBreaks();
  const added = applyTimelineCommand({ ...base, clips: [] }, { kind: 'add-clip', type: 'solid', trackId: base.tracks[0]!.id, startMs: 0 }, ids('animated-context'));
  const solid = added.clips[0]!;
  assert.equal(solid.type, 'solid');
  const sequence = validateSequence({ ...added, clips: [{ ...solid, typeVersion: 2, properties: { ...solid.properties, pattern: createAnimatedPattern() } }] });
  const clip = sequence.clips[0]!;
  const selected: string[] = [], actions: string[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: id => { selected.push(id); view.render(sequence, id); },
    scrub() {}, command: () => assert.fail('right-click must not edit'), error: error => { throw error; }, beforeEdit: () => assert.fail('right-click must not begin a drag'),
    contextItems: target => {
      assert.equal(selected.at(-1), clip.id);
      assert.deepEqual(target, { kind: 'clip', id: clip.id, trackId: clip.trackId });
      return [{ id: 'copy', label: 'Copy' }];
    },
    contextAction: action => actions.push(action)
  });
  t.after(() => view.dispose()); view.render(sequence, null);
  const scroller = root.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-scroll')!;
  scroller.scrollLeft = 400; scroller.scrollTop = 20;
  const clipNode = root.querySelector<InstanceType<typeof ui.FakeElement>>('[data-timeline-clip]')!;
  // Chromium fires contextmenu while the secondary button is held, followed
  // by pointerup. These details are absent from the older context fixtures.
  ui.dispatch(root, 'pointerdown', clipNode, { button: 2, buttons: 2, pointerId: 88, pointerType: 'mouse', clientX: 260, clientY: 30 });
  const event = ui.dispatch(root, 'contextmenu', clipNode, { button: 2, buttons: 2, pointerId: 88, pointerType: 'mouse', clientX: 260, clientY: 30, detail: 0 });
  assert.equal(event.defaultPrevented, true);
  ui.dispatch(root, 'pointerup', root, { button: 2, buttons: 0, pointerId: 88, pointerType: 'mouse', clientX: 260, clientY: 30 });
  const restoredScroll = root.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-scroll')!;
  const restoredBreakScroll = root.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-break-lane-scroll')!;
  assert.notEqual(restoredScroll, scroller);
  assert.equal(restoredScroll.scrollLeft, 400); assert.equal(restoredScroll.scrollTop, 20);
  ui.dispatch(ui.menuDocument as unknown as InstanceType<typeof ui.FakeElement>, 'scroll', restoredScroll);
  ui.dispatch(ui.menuDocument as unknown as InstanceType<typeof ui.FakeElement>, 'scroll', restoredBreakScroll);
  const inspector = new ui.FakeElement(); ui.body.append(inspector);
  inspector.scrollTop = 300;
  ui.dispatch(ui.menuDocument as unknown as InstanceType<typeof ui.FakeElement>, 'scroll', inspector);
  const popup = ui.body.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu')!;
  assert.ok(popup, 'queued timeline restoration and inspector-tab scroll events must not dismiss the just-opened menu');
  popup.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu__item')!.dispatchEvent(new Event('click'));
  assert.deepEqual(actions, ['copy']); assert.deepEqual(selected, [clip.id]);
});

test('mutating context actions restore focus to the new selection or playhead after lane repaint', t => {
  const ui = contextDom(t), root = new ui.FakeElement(); ui.body.append(root);
  const makeId = ids('context-focus');
  let sequence = sequenceWithBreaks([{ id: 'focus-break', positionMs: 2000 }]);
  let selected: string | null = sequence.clips[0]!.id;
  let selectedBreak: string | null = null;
  const paint = () => view.render(sequence, selected, 1000, selectedBreak);
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: id => { selected = id; selectedBreak = null; paint(); },
    selectBreak: id => { selectedBreak = id; selected = null; paint(); },
    scrub() {}, command() {}, error: error => { throw error; }, beforeEdit() {},
    contextItems: () => [{ id: 'duplicate', label: 'Duplicate' }, { id: 'delete', label: 'Delete' }],
    contextAction: (action, target) => {
      if (target.kind === 'clip') {
        sequence = applyTimelineCommand(sequence, { kind: action === 'duplicate' ? 'duplicate-clip' : 'remove-clip', clipId: target.id }, makeId);
        selected = action === 'duplicate' ? sequence.clips.at(-1)!.id : null;
      } else if (target.kind === 'break') {
        sequence = applyTimelineCommand(sequence, { kind: 'add-break', positionMs: 3000 }, makeId);
        selectedBreak = sequence.breaks!.find(marker => marker.positionMs === 3000)!.id;
      }
      paint();
    }
  });
  t.after(() => view.dispose()); paint();
  const activate = (selector: string, index = 0) => {
    const oldAnchor = root.querySelector<InstanceType<typeof ui.FakeElement>>(selector)!;
    ui.dispatch(root, 'contextmenu', oldAnchor, { clientX: 250, clientY: 40 });
    const popup = ui.body.querySelector<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu')!;
    const button = popup.querySelectorAll<InstanceType<typeof ui.FakeElement>>('.stagecraft-timeline-context-menu__item')[index]!;
    button.focus(); button.dispatchEvent(new Event('click'));
    assert.equal(ui.body.contains(oldAnchor), false, 'the mutation must replace the original anchor');
    assert.equal(root.contains(document.activeElement), true, 'keyboard shortcuts need focus inside the timeline');
  };
  activate('[data-timeline-clip="' + selected + '"]');
  assert.equal((document.activeElement as unknown as InstanceType<typeof ui.FakeElement>).dataset.timelineClip, selected);
  activate('[data-timeline-clip="' + selected + '"]', 1);
  assert.equal(document.activeElement, root.querySelector('[data-timeline-playhead]'), 'deletion falls back to the stable playhead control');
  activate('[data-timeline-break="focus-break"]');
  assert.equal((document.activeElement as unknown as InstanceType<typeof ui.FakeElement>).dataset.timelineBreak, selectedBreak);
});

test('Break drag snaps immediately, commits one undo step, auto-scrolls, and cancellation restores the draft', async t => {
  const fixture = dom(t), clock = frames(), root = new fixture.FakeElement(), makeId = ids('edit');
  const original = sequenceWithBreaks([{ id: 'first-marker', positionMs: 1_000 }, { id: 'snap-marker', positionMs: 4_000 }]);
  const repository = {
    async list() { return []; }, async read() { return original; }, async save(sequence: SequenceV1) { return { ...sequence, revision: sequence.revision + 1 }; }, async delete() {}
  };
  const draft = new DraftService(repository, ids('draft'));
  await draft.load(original.id);
  let sequence = draft.draft!;
  const commands: TimelineCommand[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, command: command => {
      commands.push(command); sequence = applyEditorTimelineCommand(sequence, command, makeId); draft.replace(sequence); sequence = draft.draft!; view.render(sequence, null, 1_000);
    }, error: error => { throw error; }, beforeEdit: () => {}
  }, clock.scheduler);
  view.render(sequence, null, 1_000);
  let timelineScroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!;
  let breakScroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-break-lane-scroll')!;
  timelineScroll.scrollLeft = 80; timelineScroll.dispatchEvent(new Event('scroll'));
  assert.equal(breakScroll.scrollLeft, 80);
  const zoom = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-zoom]')!;
  zoom.value = '160'; fixture.dispatch(root, 'change', zoom);
  const first = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="first-marker"]')!;
  fixture.dispatch(root, 'pointerdown', first, { button: 0, pointerId: 301, clientX: 260, clientY: 44 });
  fixture.dispatch(root, 'pointermove', first, { pointerId: 301, clientX: 660, clientY: 44 });
  assert.ok(Math.abs(Number.parseFloat(first.style.left!) - 560) < 1, 'the marker ghost follows the pointer with no easing and stays aligned to the snap target');
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-scrub]')!.value, '1000', 'marker movement does not scrub the playhead');
  fixture.dispatch(root, 'pointerup', root, { pointerId: 301, clientX: 660, clientY: 44 });
  assert.equal(commands.length, 1, 'one drag creates one command and one history entry');
  assert.deepEqual(sequence.breaks?.find(marker => marker.id === 'first-marker'), { id: 'first-marker', positionMs: 3_500 }, 'the marker commits the snapped destination');
  assert.equal(draft.canUndo, true);
  assert.equal(draft.undo()?.breaks?.find(marker => marker.id === 'first-marker')?.positionMs, 1_000);
  assert.equal(draft.redo()?.breaks?.find(marker => marker.id === 'first-marker')?.positionMs, 3_500);
  sequence = draft.draft!; view.render(sequence, null, 1_000);

  const snapMarker = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="snap-marker"]')!;
  fixture.dispatch(root, 'pointerdown', snapMarker, { button: 0, pointerId: 302, clientX: 740, clientY: 44 });
  fixture.dispatch(root, 'pointermove', snapMarker, { pointerId: 302, clientX: 900, clientY: 44 });
  fixture.dispatch(root, 'pointercancel', root, { pointerId: 302 });
  assert.equal(commands.length, 1, 'cancelled gestures do not create edits or history entries');
  assert.equal(draft.draft?.breaks?.find(marker => marker.id === 'snap-marker')?.positionMs, 4_000);

  view.render(sequence, null, 1_000);
  timelineScroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!;
  breakScroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-break-lane-scroll')!;
  const marker = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="first-marker"]')!;
  fixture.dispatch(root, 'pointerdown', marker, { button: 0, pointerId: 303, clientX: 660, clientY: 44 });
  fixture.dispatch(root, 'pointermove', marker, { pointerId: 303, clientX: 1176, clientY: 44 });
  const ghostBeforeScroll = Number.parseFloat(marker.style.left!);
  clock.step();
  assert.ok(timelineScroll.scrollLeft > 80, 'dragging near the lane edge autoscrolls the timeline');
  assert.equal(breakScroll.scrollLeft, timelineScroll.scrollLeft, 'the marker lane remains horizontally aligned during autoscroll');
  assert.ok(Number.parseFloat(marker.style.left!) > ghostBeforeScroll, 'autoscroll continues advancing the ghost under a stationary pointer');
  view.cancel();
  assert.equal(commands.length, 1);
  view.dispose();
});

test('dragging a Break onto an occupied snap position stays visibly invalid and commits no marker', t => {
  const fixture = dom(t), root = new fixture.FakeElement(), makeId = ids('edit');
  let sequence = sequenceWithBreaks([{ id: 'moving-marker', positionMs: 1_000 }, { id: 'occupied-marker', positionMs: 4_000 }]);
  const commands: TimelineCommand[] = [], errors: unknown[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, beforeEdit: () => {},
    command: command => { commands.push(command); sequence = applyEditorTimelineCommand(sequence, command, makeId); view.render(sequence, null); },
    error: error => errors.push(error)
  });
  view.render(sequence, null);
  const marker = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="moving-marker"]')!;
  fixture.dispatch(root, 'pointerdown', marker, { button: 0, pointerId: 320, clientX: 260, clientY: 44 });
  fixture.dispatch(root, 'pointermove', marker, { pointerId: 320, clientX: 500, clientY: 44 });
  assert.equal(marker.style.left, '320px', 'the ghost shows the collided marker position');
  assert.equal(marker.className.includes('stagecraft-invalid-gesture'), true, 'the invalid duplicate has a clear visual error state');
  assert.equal(errors.length, 0, 'an in-progress collision does not repeatedly report errors');
  fixture.dispatch(root, 'pointerup', root, { pointerId: 320, clientX: 500, clientY: 44 });
  assert.equal(commands.length, 0);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as { code?: string }).code, 'BREAK_POSITION_TAKEN');
  assert.deepEqual(sequence.breaks, [{ id: 'moving-marker', positionMs: 1_000 }, { id: 'occupied-marker', positionMs: 4_000 }]);
  view.dispose();
});

test('selected Breaks skip occupied keyboard steps and remove without selecting a clip', t => {
  const fixture = dom(t), root = new fixture.FakeElement(), makeId = ids('edit');
  let sequence = sequenceWithBreaks([{ id: 'keyboard-marker', positionMs: 1_000 }, { id: 'keyboard-occupied', positionMs: 1_100 }]);
  const commands: TimelineCommand[] = [], selectedClips: string[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: id => selectedClips.push(id), scrub: () => {}, command: command => { commands.push(command); sequence = applyEditorTimelineCommand(sequence, command, makeId); view.render(sequence, null, 0); },
    error: error => { throw error; }, beforeEdit: () => {}
  });
  view.render(sequence, null, 0);
  let marker = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="keyboard-marker"]')!;
  fixture.dispatch(root, 'click', marker);
  fixture.dispatch(root, 'keydown', marker, { key: 'ArrowRight' });
  assert.deepEqual(commands[0], { kind: 'move-break', breakId: 'keyboard-marker', positionMs: 1_200 }, 'an occupied arrow destination advances by the same keyboard step');
  marker = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="keyboard-marker"]')!;
  fixture.dispatch(root, 'keydown', marker, { key: 'Delete' });
  assert.deepEqual(commands[1], { kind: 'remove-break', breakId: 'keyboard-marker' });
  assert.deepEqual(sequence.breaks, [{ id: 'keyboard-occupied', positionMs: 1_100 }], 'removing the selected marker preserves the other marker');
  assert.deepEqual(selectedClips, []);
  view.dispose();
});

test('Break End key moves to the visible timeline extent instead of the seven-day limit', t => {
  const fixture = dom(t), root = new fixture.FakeElement(), makeId = ids('edit');
  let sequence = sequenceWithBreaks([{ id: 'end-marker', positionMs: 1_000 }]);
  const commands: TimelineCommand[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, beforeEdit: () => {}, error: () => {},
    command: command => { commands.push(command); sequence = applyEditorTimelineCommand(sequence, command, makeId); view.render(sequence, null); }
  });
  view.render(sequence, null);
  const marker = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="end-marker"]')!;
  fixture.dispatch(root, 'keydown', marker, { key: 'End' });
  assert.deepEqual(commands[0], { kind: 'move-break', breakId: 'end-marker', positionMs: 12_000 });
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="end-marker"]')!.style.left, '960px', 'the marker stays within the visible short-sequence scale');
  view.dispose();
});

test('DraftService saves, reloads and duplicates inner Breaks with remapped marker IDs', async () => {
  const original = sequenceWithBreaks([{ id: 'saved-marker', positionMs: 1_500 }]);
  let stored = structuredClone(original);
  const repository = {
    async list() { return []; },
    async read(id: string) { return id === stored.id ? structuredClone(stored) : null; },
    async save(sequence: SequenceV1) { stored = { ...structuredClone(sequence), revision: sequence.revision + 1 }; return structuredClone(stored); },
    async delete() {}
  };
  const draft = new DraftService(repository, ids('draft'));
  await draft.load(original.id);
  const moved = applyEditorTimelineCommand(draft.draft!, { kind: 'move-break', breakId: 'saved-marker', positionMs: 2_500 }, ids('edit'));
  draft.replace(moved);
  const saved = await draft.save();
  assert.deepEqual(saved.breaks, [{ id: 'saved-marker', positionMs: 2_500 }]);
  const loaded = await draft.load(saved.id);
  assert.deepEqual(loaded.breaks, saved.breaks, 'loading preserves saved marker data');
  const duplicate = draft.duplicate('Copy');
  assert.deepEqual(duplicate.breaks?.map(marker => marker.positionMs), [2_500], 'duplicate retains marker positions');
  assert.notEqual(duplicate.breaks?.[0]?.id, loaded.breaks?.[0]?.id, 'duplicate markers receive stable IDs unique to the new sequence');
});

test('Break timeline renders effective fades, an indefinite audio span and active held state', t => {
  const fixture = dom(t), makeId = ids(), root = new fixture.FakeElement();
  let sequence = createBreaksSequence('Break markers', makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track', trackKind: 'audio' }, makeId);
  const audioTrack = sequence.tracks.find(track => track.kind === 'audio')!;
  sequence = applyTimelineCommand(sequence, {
    kind: 'add-clip', type: 'audio', trackId: audioTrack.id, startMs: 2_000,
    sourcePath: 'loop.ogg', sourceDurationMs: 5_000
  }, makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track' }, makeId);
  const visualTrack = sequence.tracks.find(track => track.id !== sequence.tracks[0]!.id && track.kind === 'visual')!;
  sequence = applyTimelineCommand(sequence, {
    kind: 'add-clip', type: 'video', trackId: visualTrack.id, startMs: 1_000,
    sourcePath: 'scene.webm', sourceDurationMs: 7_000
  }, makeId);
  const audio = sequence.clips.find((clip): clip is AudioClipV3 => clip.type === 'audio' && clip.typeVersion === 3)!;
  const video = sequence.clips.find((clip): clip is VideoClip => clip.type === 'video')!;
  const indefinite: AudioClipV3 = {
    ...audio,
    duration: { kind: 'sequence-end' },
    entrance: { preset: 'fade', version: 1, durationMs: 800, easing: 'ease-in-out' },
    exit: { preset: 'fade', version: 1, durationMs: 1_200, easing: 'ease-in-out' },
    properties: { ...audio.properties, loop: true, loopIndefinitely: true, onBreak: 'loop' }
  };
  const fadedVideo: VideoClip = {
    ...video,
    entrance: { preset: 'fade', version: 1, durationMs: 500, easing: 'ease-in-out' },
    exit: { preset: 'fade', version: 1, durationMs: 1_000, easing: 'ease-in-out' },
    properties: { ...video.properties, onBreak: 'finish' }
  };
  sequence = validateSequence({ ...sequence, end: { kind: 'manual' }, clips: sequence.clips.map(clip =>
    clip.id === audio.id ? indefinite : clip.id === video.id ? fadedVideo : clip) });

  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, command: () => {}, error: error => { throw error; }, beforeEdit: () => {}
  });
  view.render(sequence, null);
  const audioNode = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + audio.id + '"]')!;
  const videoNode = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + video.id + '"]')!;
  const audioEntrance = audioNode.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-clip-fade-in');
  assert.equal(audioNode.style.width, '480px', 'indefinite sound spans from its start to the calculated sequence end');
  assert.equal(audioEntrance?.style.width, '64px', 'fade width follows the effective 800 ms entrance at 80 px/s');
  assert.equal(audioNode.querySelectorAll('.stagecraft-clip-fade-out').length, 0, 'an indefinite sound has no inapplicable local exit fade');
  assert.equal(audioNode.querySelectorAll('.stagecraft-clip-handle').length, 0, 'indefinite sound has no trim handles');
  assert.equal(audioNode.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-indefinite-badge]')?.textContent, '∞');
  assert.equal(audioNode.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-break-policy]')?.title, 'BreakLoopBadge');
  assert.equal(videoNode.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-clip-fade-in')?.style.width, '40px');
  assert.equal(videoNode.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-clip-fade-out')?.style.width, '80px');
  assert.equal(videoNode.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-break-policy]')?.title, 'BreakFinishBadge');

  const flag = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-end-break-flag]')!;
  const line = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-end-break-line]')!;
  assert.equal(flag.style.left, '820px', 'the end break lands on the ruler at the finite 8 second endpoint');
  view.setPlaybackState({ phase: 'holding', positionMs: 8_000, items: [
    { clip: indefinite, mediaPlayback: 'looping' }, { clip: fadedVideo, mediaPlayback: 'finishing' }
  ] });
  assert.ok(flag.className.split(' ').includes('active')); assert.ok(line.className.split(' ').includes('active'));
  assert.equal(audioNode.dataset.mediaPlayback, 'looping');
  assert.equal(videoNode.dataset.mediaPlayback, 'finishing');
  assert.match(audioNode.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-break-policy]')?.title ?? '', /MediaState\.looping/);
  view.setPlaybackState({ phase: 'paused', positionMs: 8_000, holdElapsedMs: 120, items: [
    { clip: indefinite, mediaPlayback: 'paused' }, { clip: fadedVideo, mediaPlayback: 'paused' }
  ] });
  assert.ok(flag.className.split(' ').includes('active'), 'pausing a held break keeps the end marker active');
  assert.equal(audioNode.dataset.mediaPlayback, 'paused');
  assert.match(audioNode.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-break-policy]')?.title ?? '', /MediaState\.paused/);
  view.setPlaybackState({ phase: 'idle', positionMs: 0 });
  assert.equal(flag.className.split(' ').includes('active'), false);
  assert.equal(audioNode.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-break-policy]')?.dataset.mediaPlayback, undefined);
  assert.throws(() => applyTimelineCommand(sequence, {
    kind: 'resize-clip', clipId: indefinite.id, edge: 'end', timeMs: 6_000
  }, makeId), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'INDEFINITE_AUDIO_NOT_RESIZABLE');
  view.dispose();
});

test('stationary edge drag grows the workspace every frame at a stable scale, then commits one undo step', t => {
  const fixture = dom(t), makeId = ids(), root = new fixture.FakeElement(), clock = frames();
  const draft = new DraftService({ list: async () => [], read: async () => null, save: async sequence => sequence, delete: async () => {} }, makeId);
  const source = draft.create('Free drag'), commands: TimelineCommand[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: id => view.render(draft.draft!, id), scrub: () => {}, beforeEdit: () => {}, error: error => { throw error; },
    command: command => { commands.push(command); draft.replace(applyTimelineCommand(draft.draft!, command, makeId)); view.render(draft.draft!, source.clips[0]!.id); }
  }, clock.scheduler);
  view.render(source, null);
  const node = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + source.clips[0]!.id + '"]')!;
  const scroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!;
  const content = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-content')!;
  const range = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-scrub]')!;
  const ruler = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-ruler]')!;
  const playhead = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-playhead]')!;
  const width = node.style.width;
  fixture.dispatch(root, 'pointerdown', node, { button: 0, pointerId: 70, clientX: 400, clientY: 40 });
  fixture.dispatch(root, 'pointermove', node, { pointerId: 70, clientX: 1176, clientY: 40 });
  let previousScroll = 0, previousLeft = Number.parseFloat(node.style.left!);
  for (let frame = 0; frame < 180; frame++) {
    clock.step();
    assert.ok(scroll.scrollLeft > previousScroll, 'the stationary pointer continues scrolling');
    assert.ok(Number.parseFloat(node.style.left!) >= previousLeft, 'the ghost advances without more pointer events');
    assert.equal(node.style.width, width, '80 pixels per second stays unchanged as the extent grows');
    assert.equal(root.contains(node), true); assert.equal(root.hasPointerCapture(70), true);
    assert.equal(root.querySelector('[data-timeline-playhead]'), playhead, 'workspace growth retains the playhead and captured ghost');
    assert.ok(Number.parseFloat(content.style.width!) >= scroll.scrollLeft + scroll.clientWidth);
    assert.ok(ruler.children.length < 405, 'ruler tick count remains bounded');
    previousScroll = scroll.scrollLeft; previousLeft = Number.parseFloat(node.style.left!);
  }
  assert.ok(Number(range.max) > 30000, 'one gesture reaches beyond the original 12 second workspace');
  assert.equal(playhead.getAttribute('aria-valuemax'), range.max);
  assert.deepEqual(draft.draft, source); assert.equal(draft.canUndo, false); assert.equal(commands.length, 0);
  const expected = Math.round((1176 + 24 - 400 + scroll.scrollLeft) / 80 * 10) * 100;
  fixture.dispatch(root, 'pointerup', root, { pointerId: 70, clientX: 1200, clientY: 40 });
  assert.equal(commands.length, 1); assert.equal(draft.draft!.clips[0]!.startMs, expected, 'release coordinates override the last frame');
  assert.equal(clock.pending, 0); assert.equal(root.hasPointerCapture(70), false);
  assert.deepEqual(draft.undo(), source); assert.equal(draft.canUndo, false, 'all frames produce just one undo step');
  view.dispose();
});

test('left edge scrolling accounts for the sticky gutter, stops at zero and bounds delayed frames', t => {
  const fixture = dom(t), root = new fixture.FakeElement(), clock = frames(), source = createBarsSequence('Scroll back', ids());
  const view = new TimelineView(root as unknown as HTMLElement, key => key, { select: () => {}, scrub: () => {}, command: () => assert.fail('cancelled'), error: () => {}, beforeEdit: () => {} }, clock.scheduler);
  view.render(source, null);
  const node = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + source.clips[0]!.id + '"]')!;
  const scroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!; scroll.scrollLeft = 80;
  fixture.dispatch(root, 'pointerdown', node, { button: 0, pointerId: 71, clientX: 450, clientY: 40 });
  fixture.dispatch(root, 'pointermove', node, { pointerId: 71, clientX: 410, clientY: 40 });
  assert.equal(clock.pending, 0, 'pointer beyond the 48 pixel gutter edge zone does not scroll');
  fixture.dispatch(root, 'pointermove', node, { pointerId: 71, clientX: 360, clientY: 40 });
  clock.step(); const beforePause = scroll.scrollLeft;
  clock.step(10000); assert.ok(beforePause - scroll.scrollLeft <= 36, 'a delayed frame moves at most 50 ms of scroll');
  for (let frame = 0; frame < 30; frame++) clock.step();
  assert.equal(scroll.scrollLeft, 0); assert.equal(clock.pending, 0, 'zero is a hard left boundary');
  fixture.dispatch(root, 'keydown', root, { key: 'Escape' }); assert.equal(source.clips[0]!.startMs, 0); view.dispose();
});

test('edge scrolling stops and discards expanded workspace on every cancellation route', t => {
  const fixture = dom(t), source = createBarsSequence('Cancel edge scroll', ids()), snapshot = JSON.stringify(source);
  for (const finish of ['pointercancel', 'lostpointercapture', 'Escape', 'cancel', 'dispose'] as const) {
    const root = new fixture.FakeElement(), clock = frames();
    const view = new TimelineView(root as unknown as HTMLElement, key => key, { select: () => {}, scrub: () => {}, command: () => assert.fail('cancelled gesture cannot commit'), error: () => {}, beforeEdit: () => {} }, clock.scheduler);
    view.render(source, null);
    const node = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + source.clips[0]!.id + '"]')!;
    fixture.dispatch(root, 'pointerdown', node, { button: 0, pointerId: 72, clientX: 400, clientY: 40 });
    fixture.dispatch(root, 'pointermove', node, { pointerId: 72, clientX: 1176, clientY: 40 }); clock.step();
    assert.equal(clock.pending, 1); assert.ok(Number(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-scrub]')!.max) > 12000);
    if (finish === 'cancel') view.cancel(); else if (finish === 'dispose') view.dispose(); else if (finish === 'Escape') fixture.dispatch(root, 'keydown', root, { key: 'Escape' }); else fixture.dispatch(root, finish, root, { pointerId: 72 });
    assert.equal(clock.pending, 0); assert.equal(root.hasPointerCapture(72), false); clock.step();
    fixture.dispatch(root, 'pointerup', root, { pointerId: 72, clientX: 1180, clientY: 40 });
    assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-scrub]')!.max, '12000');
    assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + source.clips[0]!.id + '"]')!.style.left, '0px');
    assert.equal(JSON.stringify(source), snapshot); view.dispose();
  }
});

test('end trim extends with edge scrolling while video trims remain limited by source media', t => {
  const fixture = dom(t), makeId = ids();
  for (const type of ['bars', 'video'] as const) {
    let source = createBarsSequence('Edge trim ' + type, makeId);
    if (type === 'video') {
      source = applyTimelineCommand(source, { kind: 'add-track' }, makeId);
      source = applyTimelineCommand(source, { kind: 'add-clip', type: 'video', trackId: source.tracks[1]!.id, startMs: 0, sourcePath: 'clip.webm', sourceDurationMs: 5000 }, makeId);
    }
    const clip = source.clips.at(-1)!, root = new fixture.FakeElement(), clock = frames(), commands: TimelineCommand[] = [];
    const view = new TimelineView(root as unknown as HTMLElement, key => key, { select: () => {}, scrub: () => {}, command: command => commands.push(command), error: () => {}, beforeEdit: () => {} }, clock.scheduler);
    view.render(source, null);
    const node = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + clip.id + '"]')!;
    const handle = node.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-clip-edge="end"]')!;
    fixture.dispatch(root, 'pointerdown', handle, { button: 0, pointerId: 73, clientX: 760, clientY: 40 });
    fixture.dispatch(root, 'pointermove', handle, { pointerId: 73, clientX: 1176, clientY: 40 });
    for (let frame = 0; frame < 120; frame++) clock.step();
    fixture.dispatch(root, 'pointerup', root, { pointerId: 73, clientX: 1176, clientY: 40 });
    if (type === 'bars') {
      assert.equal(commands.length, 1); assert.ok(Number.parseFloat(node.style.width!) >= 400);
      const committed = applyTimelineCommand(source, commands[0]!, makeId);
      assert.equal(committed.clips[0]!.duration.kind, 'fixed'); assert.ok(committed.end.kind === 'fixed' && committed.end.durationMs > 20000);
    } else {
      assert.equal(commands.length, 0, 'out-of-source trim cannot create a command');
      assert.equal((source.clips.at(-1) as VideoClip).properties.durationMs, 5000); assert.equal(node.style.width, '400px');
    }
    assert.equal(clock.pending, 0); view.dispose();
  }
});

test('seven-day workspace clamps drag and scroll with a bounded ruler at unchanged scale', t => {
  const fixture = dom(t), makeId = ids(), root = new fixture.FakeElement(), clock = frames(), max = 604800000;
  const source: SequenceV1 = { ...createBarsSequence('Long boundary', makeId), end: { kind: 'fixed', durationMs: max } };
  const commands: TimelineCommand[] = [], view = new TimelineView(root as unknown as HTMLElement, key => key, { select: () => {}, scrub: () => {}, command: command => commands.push(command), error: () => {}, beforeEdit: () => {} }, clock.scheduler);
  view.render(source, null);
  const node = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + source.clips[0]!.id + '"]')!;
  const handle = node.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-clip-edge="end"]')!;
  const content = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-content')!, scroll = root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!;
  const width = content.style.width; scroll.scrollLeft = Number.parseFloat(width!) - scroll.clientWidth;
  fixture.dispatch(root, 'pointerdown', handle, { button: 0, pointerId: 74, clientX: 1176, clientY: 40 });
  fixture.dispatch(root, 'pointermove', handle, { pointerId: 74, clientX: 1180, clientY: 40 }); clock.step();
  assert.equal(content.style.width, width); assert.equal(clock.pending, 0); assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-scrub]')!.max, String(max));
  assert.ok(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-ruler]')!.children.length < 405);
  assert.ok(Number.parseFloat(width!) < 29000); fixture.dispatch(root, 'pointerup', root, { pointerId: 74, clientX: 99999999, clientY: 40 });
  assert.equal(commands.length, 1); assert.ok(commands[0]?.kind === 'resize-clip' && commands[0].timeMs === max, 'trimming past the limit clamps to seven days');
  const committed = applyTimelineCommand(source, commands[0]!, makeId); assert.deepEqual(committed.end, { kind: 'fixed', durationMs: max }); view.dispose();
});

test('only a final invalid release reports the domain error; selection, cancellation and a recovered trim stay quiet', t => {
  const fixture = dom(t), makeId = ids(), root = new fixture.FakeElement(), clock = frames();
  let source = createBarsSequence('Trim error feedback', makeId);
  source = applyTimelineCommand(source, { kind: 'add-track' }, makeId);
  source = applyTimelineCommand(source, { kind: 'add-clip', type: 'video', trackId: source.tracks[1]!.id, startMs: 0, sourcePath: 'clip.webm', sourceDurationMs: 5000 }, makeId);
  const errors: unknown[] = [], commands: TimelineCommand[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, { select: () => {}, scrub: () => {}, beforeEdit: () => {}, command: command => commands.push(command), error: error => errors.push(error) }, clock.scheduler);
  const start = (id: number) => {
    view.render(source, null);
    const handle = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + source.clips[1]!.id + '"]')!.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-clip-edge="end"]')!;
    fixture.dispatch(root, 'pointerdown', handle, { button: 0, pointerId: id, clientX: 760, clientY: 40 }); return handle;
  };
  start(80); fixture.dispatch(root, 'pointerup', root, { pointerId: 80, clientX: 760, clientY: 40 }); assert.equal(errors.length, 0);
  const cancelled = start(81); fixture.dispatch(root, 'pointermove', cancelled, { pointerId: 81, clientX: 920, clientY: 40 });
  assert.equal(errors.length, 0, 'the invalid ghost does not emit errors during pointer movement'); view.cancel(); assert.equal(errors.length, 0);
  start(82); fixture.dispatch(root, 'pointerup', root, { pointerId: 82, clientX: 920, clientY: 40 }); assert.equal(errors.length, 1); assert.equal(commands.length, 0); assert.equal(clock.pending, 0);
  const recovered = start(83); fixture.dispatch(root, 'pointermove', recovered, { pointerId: 83, clientX: 920, clientY: 40 });
  fixture.dispatch(root, 'pointerup', root, { pointerId: 83, clientX: 680, clientY: 40 }); assert.equal(errors.length, 1); assert.equal(commands.length, 1, 'valid final coordinates clear the earlier error'); view.dispose();
});

test('overlap previews a temporary free track without replacing source rows, and cancellation removes it', t => {
  const fixture = dom(t), makeId = ids(), root = new fixture.FakeElement(), clock = frames();
  let source = createBarsSequence('Free track preview', makeId);
  source = applyTimelineCommand(source, { kind: 'resize-clip', clipId: source.clips[0]!.id, edge: 'end', timeMs: 5000 }, makeId);
  source = applyTimelineCommand(source, { kind: 'add-clip', type: 'text', trackId: source.tracks[0]!.id, startMs: 5000 }, makeId);
  const snapshot = structuredClone(source), commands: TimelineCommand[] = [], errors: unknown[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, { select: () => {}, scrub: () => {}, beforeEdit: () => {}, error: error => errors.push(error), command: command => { commands.push(command); source = applyEditorTimelineCommand(source, command, makeId); view.render(source, source.clips[0]!.id); } }, clock.scheduler);
  view.render(source, null);
  const selector = '[data-timeline-clip="' + source.clips[0]!.id + '"]';
  let node = root.querySelector<InstanceType<typeof fixture.FakeElement>>(selector)!;
  const sourceRow = root.querySelector('[data-timeline-track="' + source.tracks[0]!.id + '"]');
  fixture.dispatch(root, 'pointerdown', node, { button: 0, pointerId: 90, clientX: 400, clientY: 40 });
  fixture.dispatch(root, 'pointermove', node, { pointerId: 90, clientX: 480, clientY: 40 });
  const row = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-preview-track]')!;
  assert.ok(row); assert.equal(row.children[0]!.textContent, 'Visual 2'); assert.equal(node.parentElement, row.children[1]);
  assert.equal(root.querySelector('[data-timeline-track="' + source.tracks[0]!.id + '"]'), sourceRow); assert.equal(root.hasPointerCapture(90), true);
  fixture.dispatch(root, 'pointermove', root, { pointerId: 90, clientX: 520, clientY: 40 });
  assert.equal(root.querySelector('[data-timeline-preview-track]'), row, 'subsequent previews reuse the temporary row'); assert.equal(root.contains(node), true); assert.deepEqual(source, snapshot);
  fixture.dispatch(root, 'keydown', root, { key: 'Escape' }); assert.equal(root.querySelector('[data-timeline-preview-track]'), null); assert.equal(root.querySelectorAll('[data-timeline-track]').length, 1); assert.equal(commands.length, 0);
  node = root.querySelector<InstanceType<typeof fixture.FakeElement>>(selector)!;
  fixture.dispatch(root, 'pointerdown', node, { button: 0, pointerId: 91, clientX: 400, clientY: 40 });
  fixture.dispatch(root, 'pointermove', node, { pointerId: 91, clientX: 480, clientY: 40 });
  fixture.dispatch(root, 'pointerup', root, { pointerId: 91, clientX: 480, clientY: 40 });
  assert.equal(commands.length, 1); assert.equal(errors.length, 0); assert.equal(source.tracks.length, 2); assert.notEqual(source.clips[0]!.trackId, snapshot.clips[0]!.trackId);
  assert.equal(root.querySelector('[data-timeline-preview-track]'), null, 'committed track uses normal rendered controls'); assert.equal(root.querySelectorAll('[data-timeline-track]').length, 2); view.dispose();
});

test('pointer gestures survive selection repaint, commit once, and cancel across tracks without edits',t=>{
  const fixture=dom(t),makeId=ids();let sequence=createBarsSequence('Gesture',makeId);
  sequence=applyTimelineCommand(sequence,{kind:'add-track'},makeId);
  const root=new fixture.FakeElement(),commands:TimelineCommand[]=[];let selection:string|null=null;
  const view=new TimelineView(root as unknown as HTMLElement,key=>key,{select:id=>{selection=id;view.render(sequence,id);},scrub:()=>{},beforeEdit:()=>{},error:()=>{},command:command=>{commands.push(command);sequence=applyTimelineCommand(sequence,command,makeId);view.render(sequence,selection);}});
  view.render(sequence,null);
  let node=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="'+sequence.clips[0]!.id+'"]')!;
  const lane=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-lane-track="'+sequence.tracks[1]!.id+'"]')!;fixture.setHit(lane);
  fixture.dispatch(root,'pointerdown',node,{button:0,pointerId:1,clientX:200,clientY:50});
  assert.equal(root.contains(node),true,'selection callback cannot replace captured DOM');
  fixture.dispatch(root,'pointermove',node,{pointerId:1,clientX:280,clientY:50});
  assert.equal(commands.length,0);assert.equal(node.parentElement,lane);
  assert.equal(root.hasPointerCapture(1),true,'stable root keeps capture after clip is reparented');
  fixture.dispatch(root,'pointercancel',node,{pointerId:1});
  assert.equal(commands.length,0);assert.equal(sequence.clips[0]!.startMs,0);assert.equal(root.hasPointerCapture(1),false);
  node=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="'+sequence.clips[0]!.id+'"]')!;
  fixture.setHit(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-lane-track="'+sequence.tracks[1]!.id+'"]')!);
  fixture.dispatch(root,'pointerdown',node,{button:0,pointerId:2,clientX:200,clientY:50});
  fixture.dispatch(root,'pointermove',node,{pointerId:2,clientX:280,clientY:50});
  fixture.dispatch(root,'pointerup',node,{pointerId:2,clientX:280,clientY:50});
  assert.equal(commands.length,1);assert.equal(sequence.clips[0]!.startMs,1000);assert.equal(sequence.clips[0]!.trackId,sequence.tracks[1]!.id);view.dispose();
});

test('default bars body drag preserves ghost and committed width while the end handle trims',t=>{
  const fixture=dom(t),makeId=ids();let sequence=createBarsSequence('Bars body drag',makeId);
  const root=new fixture.FakeElement(),commands:TimelineCommand[]=[];
  const view=new TimelineView(root as unknown as HTMLElement,key=>key,{select:id=>view.render(sequence,id),scrub:()=>{},beforeEdit:()=>{},error:()=>{},command:command=>{commands.push(command);sequence=applyTimelineCommand(sequence,command,makeId);view.render(sequence,sequence.clips[0]!.id);}});
  view.render(sequence,null);
  const selector='[data-timeline-clip="'+sequence.clips[0]!.id+'"]';
  let node=root.querySelector<InstanceType<typeof fixture.FakeElement>>(selector)!;
  const width=node.style.width;
  assert.equal(width,'400px');assert.deepEqual(sequence.clips[0]!.duration,{kind:'sequence-end'});
  fixture.dispatch(root,'pointerdown',node,{button:0,pointerId:20,clientX:200,clientY:50});
  fixture.dispatch(root,'pointermove',node,{pointerId:20,clientX:280,clientY:50});
  assert.equal(node.style.width,width);assert.equal(node.style.left,'80px');assert.equal(commands.length,0);
  assert.equal(sequence.clips[0]!.startMs,0,'ghost does not mutate the draft');
  fixture.dispatch(root,'pointerup',node,{pointerId:20,clientX:280,clientY:50});
  node=root.querySelector<InstanceType<typeof fixture.FakeElement>>(selector)!;
  assert.equal(node.style.width,width);assert.equal(node.style.left,'80px');
  assert.deepEqual(commands,[{kind:'move-clip',clipId:sequence.clips[0]!.id,trackId:sequence.tracks[0]!.id,startMs:1000}]);
  assert.deepEqual(sequence.clips[0]!.duration,{kind:'fixed',milliseconds:5000});
  assert.deepEqual(sequence.end,{kind:'fixed',durationMs:6000});
  const handle=node.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-clip-edge="end"]')!;
  fixture.dispatch(root,'pointerdown',handle,{button:0,pointerId:21,clientX:680,clientY:50});
  fixture.dispatch(root,'pointermove',handle,{pointerId:21,clientX:600,clientY:50});
  assert.equal(node.style.width,'320px');assert.equal(commands.length,1);
  fixture.dispatch(root,'pointerup',handle,{pointerId:21,clientX:600,clientY:50});
  assert.equal(commands.length,2);assert.deepEqual(commands[1],{kind:'resize-clip',clipId:sequence.clips[0]!.id,edge:'end',timeMs:5000});
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>(selector)!.style.width,'320px');
  assert.equal(sequence.clips[0]!.startMs,1000);assert.deepEqual(sequence.clips[0]!.duration,{kind:'fixed',milliseconds:4000});
  view.dispose();
});

test('timeline loop resize follows authored audio length past the selected source range', t => {
  const fixture = dom(t), makeId = ids();
  let sequence = createBarsSequence('Loop resize', makeId);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track', trackKind: 'audio' }, makeId);
  const track = sequence.tracks.find(item => item.kind === 'audio')!;
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'audio', trackId: track.id, startMs: 0, sourcePath: 'music.ogg', sourceDurationMs: 5_000 }, makeId);
  const created = sequence.clips.find((clip): clip is AudioClipV2 => clip.type === 'audio')!;
  const looped: AudioClipV2 = { ...created, duration: { kind: 'fixed', milliseconds: 7_000 }, properties: {
    ...created.properties, sourceRange: { inMs: 1_000, outMs: 4_000 }, loop: true
  } };
  sequence = validateSequence({ ...sequence, end: { kind: 'manual' }, clips: sequence.clips.map(clip => clip.id === looped.id ? looped : clip) });
  const commands: TimelineCommand[] = [], root = new fixture.FakeElement();
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, beforeEdit: () => {}, error: () => {},
    command: command => { commands.push(command); sequence = applyEditorTimelineCommand(sequence, command, makeId); view.render(sequence, looped.id); }
  });
  view.render(sequence, looped.id);
  const node = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + looped.id + '"]')!;
  const handle = node.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-clip-edge="end"]')!;
  fixture.dispatch(root, 'pointerdown', handle, { button: 0, pointerId: 40, clientX: 300, clientY: 50 });
  fixture.dispatch(root, 'pointermove', handle, { pointerId: 40, clientX: 700, clientY: 50 });
  fixture.dispatch(root, 'pointerup', handle, { pointerId: 40, clientX: 700, clientY: 50 });

  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], { kind: 'resize-clip', clipId: looped.id, edge: 'end', timeMs: 12_000 });
  const resized = sequence.clips.find((clip): clip is AudioClipV2 => clip.type === 'audio')!;
  assert.equal(resized.duration.milliseconds, 12_000);
  assert.deepEqual(resized.properties.sourceRange, looped.properties.sourceRange);
  view.dispose();
});

test('supported seven-day sequences keep timeline DOM and rendered width bounded',t=>{
  const fixture=dom(t),root=new fixture.FakeElement();const sequence:SequenceV1={...createBarsSequence('Long',ids()),end:{kind:'fixed',durationMs:604800000}};
  const view=new TimelineView(root as unknown as HTMLElement,key=>key,{select:()=>{},scrub:()=>{},command:()=>{},error:()=>{},beforeEdit:()=>{}});view.render(sequence,null);
  const ruler=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-ruler]')!;
  assert.ok(ruler.children.length<500);assert.ok(Number.parseFloat(root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-content')!.style.width!)<29000);view.dispose();
});

async function editorFixture(t: TestContext, withTimeline = false) {
  const fixture = dom(t), makeId = ids(), root = new fixture.FakeElement();
  const picker = new fixture.FakeElement('select'); picker.dataset.stagecraftSequencePicker = '';
  const name = new fixture.FakeElement('input'); name.name = 'sequence-name';
  const library = new fixture.FakeElement(); library.dataset.stagecraftLibrary = '';
  const inspector = new fixture.FakeElement('fieldset'); inspector.dataset.stagecraftInspector = '';
  root.append(picker, name, library, inspector);
  const timelineRoot = new fixture.FakeElement(); timelineRoot.dataset.stagecraftTimeline = '';
  if (withTimeline) root.append(timelineRoot);
  const first = createBarsSequence('First', makeId), second = createBarsSequence('Second', makeId);
  const state = { discard: false, confirms: 0, reads: 0, picks: 0 };
  const runtime = { now: () => 0, requestFrame: () => 0, cancelFrame: () => {} };
  const services: EditorServices = {
    makeId, repository: {
      list: async () => [first, second, { id: 'broken', revision: 0, name: 'Broken', issue: 'INVALID_VALUE' }],
      read: async id => { state.reads++; return id === first.id ? first : second; },
      save: async sequence => sequence, delete: async () => {}
    }, localPlayer: new LocalPlayer(runtime), localize: key => key,
    confirmDiscard: async () => { state.confirms++; return state.discard; }, confirmDeleteSequence: async () => false, observeLocal: () => () => {},
    prepareGroup: async () => {}, openSession: () => {}, groupActive: () => false,
    chooseVideo: async () => { state.picks++; return null; }, requestAudioUnlock: async () => {}
  };
  const view = new EditorView(services);
  await view.mount(root as unknown as HTMLElement);
  t.after(() => view.detach());
  const action = async (name: string) => {
    const button = new fixture.FakeElement('button'); button.dataset.stagecraftAction = name; root.append(button);
    fixture.dispatch(root, 'click', button);
    await settle();
  };
  return { ...fixture, root, picker, name, library, inspector, timelineRoot, view, services, state, first, second, action };
}

test('one track selector adds visual and audio tracks repeatedly, keeps focus, and records one history step per choice', async t => {
  const f = await breakEditor(t, sequenceWithBreaks());
  const addTrack = () => f.timeline.querySelector<InstanceType<typeof f.FakeElement>>('[data-timeline-track-add]')!;
  let selector = addTrack();
  assert.equal(f.timeline.querySelectorAll('[data-timeline-track-add]').length, 1);
  assert.equal(f.timeline.querySelectorAll('[data-timeline-action="add-track"]').length, 0);
  assert.deepEqual(selector.children.map(option => [option.value, option.textContent]), [
    ['', 'STAGECRAFT.Editor.AddTrack'], ['visual', 'STAGECRAFT.Editor.VisualTrack'], ['audio', 'STAGECRAFT.Editor.AddAudioTrack']
  ]);
  assert.equal(selector.getAttribute('aria-label'), 'STAGECRAFT.Editor.AddTrack');
  assert.equal(f.timeline.querySelector('[data-timeline-action="duplicate-clip"]'), null);
  assert.equal(f.timeline.querySelector('[data-timeline-action="remove-clip"]'), null);
  assert.equal(f.clipSection.querySelectorAll('[data-stagecraft-action="duplicate-clip"]').length, 1, 'the Inspector keeps its duplicate action');
  assert.equal(f.clipSection.querySelectorAll('[data-stagecraft-action="remove-clip"]').length, 1, 'the Inspector keeps its remove action');

  const chooseTrack = (kind: 'visual' | 'audio') => {
    selector = addTrack(); selector.focus(); selector.value = kind;
    // The fixture uses EventTarget, so model DOM bubbling to the editor explicitly.
    let propagationStopped = false;
    f.dispatch(f.timeline, 'change', selector, { stopPropagation: () => { propagationStopped = true; } });
    if (!propagationStopped) f.dispatch(f.root, 'change', selector);
    selector = addTrack();
    assert.equal(selector.value, '', 'the control returns to its Add track placeholder after dispatch');
    assert.equal(document.activeElement, selector, 'the control keeps keyboard focus after repaint');
  };
  chooseTrack('visual');
  assert.equal(f.view.draft.draft!.tracks.at(-1)?.kind, 'visual');
  chooseTrack('audio');
  chooseTrack('audio');
  assert.equal(f.view.draft.draft!.tracks.filter(track => track.kind === 'audio').length, 2, 'the same choice can be made repeatedly');
  assert.equal(f.view.draft.draft!.tracks.length, 4);

  await f.driver.act('undo');
  assert.equal(f.view.draft.draft!.tracks.length, 3, 'one undo removes only the latest audio track');
  await f.driver.act('undo');
  assert.equal(f.view.draft.draft!.tracks.length, 2, 'the previous audio-track command remains a separate history step');
  await f.driver.act('redo');
  await f.driver.act('redo');
  assert.equal(f.view.draft.draft!.tracks.length, 4);

  let full = f.view.draft.draft!;
  const makeId = ids('track-limit');
  while (full.tracks.length < SEQUENCE_LIMITS.tracks) full = applyTimelineCommand(full, { kind: 'add-track', trackKind: 'visual' }, makeId);
  f.view.draft.replace(full);
  (f.view as unknown as { paint(): void }).paint();
  chooseTrack('audio');
  assert.equal(f.view.draft.draft!.tracks.length, SEQUENCE_LIMITS.tracks, 'a rejected command leaves the selector ready for another choice');
  assert.equal(f.message.textContent, 'TRACK_LIMIT', 'the editor form handler must not overwrite the rejected command error');
});
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve: (value: T) => resolve(value) };
}

test('Add and remove Breaks restore safe keyboard focus instead of invoking the stale clip-delete shortcut', async t => {
  const f = await breakEditor(t, sequenceWithBreaks());
  const add = f.library.querySelector<InstanceType<typeof f.FakeElement>>('[data-preset-id="break"]')!;
  add.focus(); await f.driver.act('add-preset', 'break');
  const marker = f.timeline.querySelector<InstanceType<typeof f.FakeElement>>('[data-timeline-break]')!;
  assert.equal(document.activeElement, marker, 'adding a Break transfers focus from the library to the selected marker');
  const removeWithKey = f.dispatch(f.timeline, 'keydown', marker, { key: 'Delete' });
  assert.equal(removeWithKey.defaultPrevented, true, 'the marker consumes Delete before the editor clip shortcut');
  assert.equal(f.view.draft.draft!.breaks?.length, 0);
  assert.equal(f.view.draft.draft!.clips.length, 1, 'Delete removes the Break, never the selected clip');
  const safe = f.timeline.querySelector<InstanceType<typeof f.FakeElement>>('[data-timeline-action="snap"]')!;
  assert.equal(document.activeElement, safe, 'removing the last marker moves focus to a live timeline control');
  const ignored = f.dispatch(f.timeline, 'keydown', safe, { key: 'Delete' });
  assert.equal(ignored.defaultPrevented, true, 'Delete on the safe control cannot fall through to a clip action');
  await f.driver.act('add-preset', 'break');
  f.remove.focus(); await f.driver.act('remove-break');
  assert.equal(f.view.draft.draft!.clips.length, 1);
  assert.equal(f.remove.disabled, true); assert.equal(f.breakPanel.hidden, true);
});

test('pending sequence deletion locks the inspector and ignores input and change events until completion', async t => {
  const f = await editorFixture(t);
  const writeStarted = deferred<void>();
  const finishWrite = deferred<void>();
  const finished = deferred<void>();
  const exit = new f.FakeElement('input'); exit.name = 'exit'; exit.type = 'number'; exit.value = '5';
  const blockInput = new f.FakeElement('input') as InstanceType<typeof f.FakeElement> & { checked: boolean };
  blockInput.name = 'block-input'; blockInput.type = 'checkbox'; blockInput.checked = false;
  f.inspector.append(exit, blockInput);
  f.services.confirmDeleteSequence = async () => true;
  f.services.repository.list = async () => [f.second];
  f.services.repository.delete = async () => { writeStarted.resolve(); await finishWrite.promise; };
  f.services.refreshSequenceShortcuts = async () => { finished.resolve(); };
  const before = structuredClone(f.view.draft.draft);

  const dispatch = f.action('delete-sequence');
  await writeStarted.promise;
  assert.equal(f.inspector.disabled, true, 'the full inspector fieldset stays disabled during the repository write');

  exit.value = '1';
  f.dispatch(f.root, 'input', exit);
  blockInput.checked = true;
  f.dispatch(f.root, 'change', blockInput);
  assert.deepEqual(f.view.draft.draft, before, 'synthetic or late field events cannot alter the draft while busy');

  finishWrite.resolve();
  await dispatch;
  await finished.promise;
  await settle();
  assert.equal(f.view.draft.draft?.id, f.second.id);
  assert.equal(f.inspector.disabled, false, 'the inspector unlocks after deletion and refresh finish');
});

test('pending media work cancels timeline gestures and holds an inert timeline until picker or probe settles', async t => {
  const f = await editorFixture(t, true);
  class MetadataVideo extends EventTarget {
    duration = 8; readyState = 0; error: { code: number } | null = null;
    src = ''; muted = true; preload = ''; playsInline = true;
    load() {} pause() {} remove() {} removeAttribute() {} getAttribute(name: string) { return name === 'src' ? this.src : null; }
  }
  const originalCreate = document.createElement;
  let metadata = new MetadataVideo();
  document.createElement = ((tag: string) => tag === 'video' ? metadata : originalCreate(tag)) as typeof document.createElement;
  for (const outcome of ['picker-cancel', 'picker-reject', 'probe-success', 'probe-reject', 'probe-cancel']) {
    metadata = new MetadataVideo();
    let resolvePicker!: (value: string | null) => void, rejectPicker!: (error: Error) => void;
    f.services.chooseVideo = () => new Promise((resolve, reject) => { resolvePicker = resolve; rejectPicker = reject; });
    const before = f.view.draft.draft!;
    const clip = f.timelineRoot.querySelector<InstanceType<typeof f.FakeElement>>('[data-timeline-clip="' + before.clips[0]!.id + '"]')!;
    f.dispatch(f.timelineRoot, 'pointerdown', clip, { button: 0, pointerId: 77, clientX: 200, clientY: 20 });
    f.dispatch(f.timelineRoot, 'pointermove', clip, { pointerId: 77, clientX: 240, clientY: 20 });
    assert.equal(f.timelineRoot.hasPointerCapture(77), true);
    f.dispatch(f.root, 'click', f.library.children.find(button => button.dataset.presetId === 'video')!); await settle();
    assert.equal(f.timelineRoot.hasPointerCapture(77), false, 'busy operation cancels pending gesture');
    assert.equal(f.timelineRoot.inert, true); assert.equal(f.timelineRoot.getAttribute('aria-busy'), 'true');
    assert.deepEqual(f.view.draft.draft, before, 'cancelled gesture cannot become an apparent dropped edit');
    if (outcome === 'picker-cancel') resolvePicker(null);
    else if (outcome === 'picker-reject') rejectPicker(new Error('picker failed'));
    else {
      resolvePicker('scene.webm'); await settle();
      assert.equal(f.timelineRoot.inert, true, 'metadata probe keeps the timeline locked');
      if (outcome === 'probe-success') { metadata.readyState = 1; metadata.dispatchEvent(new Event('loadedmetadata')); }
      else if (outcome === 'probe-reject') { metadata.error = { code: 4 }; metadata.dispatchEvent(new Event('error')); }
      else (f.view as unknown as { cancelMediaWork(): void }).cancelMediaWork();
    }
    await settle();
    assert.equal(f.timelineRoot.inert, false, outcome); assert.equal(f.timelineRoot.getAttribute('aria-busy'), 'false', outcome);
    assert.equal(f.view.draft.draft!.clips.length, before.clips.length + (outcome === 'probe-success' ? 1 : 0));
  }
});

test('sequence rename commits once on Enter, cancels on Escape and rejects invalid values without editing data', async t => {
  const f = await editorFixture(t);
  await f.action('rename');
  assert.equal(f.name.hidden, false); assert.equal(f.picker.hidden, true);
  f.name.value = 'A new name'; f.dispatch(f.root, 'input', f.name);
  assert.equal(f.view.draft.draft!.name, 'First'); assert.equal(f.view.draft.canUndo, false);
  f.dispatch(f.root, 'keydown', f.name, { key: 'Enter' });
  assert.equal(f.view.draft.draft!.name, 'A new name'); assert.equal(f.name.hidden, true);
  assert.equal(f.view.draft.undo()!.name, 'First'); assert.equal(f.view.draft.canUndo, false);
  await f.action('rename'); f.name.value = 'Cancelled';
  f.dispatch(f.root, 'keydown', f.name, { key: 'Escape' });
  assert.equal(f.view.draft.draft!.name, 'First'); assert.equal(f.view.draft.canUndo, false);
  for (const invalid of ['', '   ', 'x'.repeat(201)]) {
    await f.action('rename'); f.name.value = invalid; f.dispatch(f.root, 'focusout', f.name);
    assert.equal(f.view.draft.draft!.name, 'First'); assert.equal(f.name.value, 'First');
    assert.equal(f.view.draft.canUndo, false); assert.equal(f.picker.hidden, false);
  }
});

test('unfinished and hidden rename text cannot enter unrelated form edits', async t => {
  const f = await editorFixture(t);
  await f.action('rename'); f.name.value = 'Uncommitted';
  const exit = new f.FakeElement('input'); exit.name = 'exit'; exit.value = '0.3'; f.root.append(exit);
  f.dispatch(f.root, 'input', exit);
  assert.equal(f.view.draft.draft!.name, 'First'); assert.equal(f.view.draft.draft!.presentation.exitDurationMs, 300);
  f.dispatch(f.root, 'keydown', f.name, { key: 'Escape' }); f.name.value = 'Stale hidden text';
  exit.value = '0.4'; f.dispatch(f.root, 'input', exit);
  assert.equal(f.view.draft.draft!.name, 'First'); assert.equal(f.view.draft.draft!.presentation.exitDurationMs, 400);
});

test('sequence selector restores choice after cancelled dirty switch and lists unsaved drafts and unreadable entries', async t => {
  const f = await editorFixture(t);
  assert.equal(f.picker.children.find(option => option.value === 'broken')!.disabled, true);
  await f.action('rename'); f.name.value = 'Edited'; f.dispatch(f.root, 'focusout', f.name);
  f.picker.value = f.second.id; f.dispatch(f.root, 'change', f.picker); await settle();
  assert.equal(f.state.confirms, 1); assert.equal(f.state.reads, 1);
  assert.equal(f.picker.value, f.first.id); assert.equal(f.view.draft.draft!.name, 'Edited');
  f.state.discard = true;
  f.picker.value = f.second.id; f.dispatch(f.root, 'change', f.picker); await settle();
  assert.equal(f.view.draft.draft!.id, f.second.id); assert.equal(f.picker.value, f.second.id);
  await f.action('new');
  assert.ok(f.picker.children.some(option => option.value === f.view.draft.draft!.id));
  assert.equal(f.picker.value, f.view.draft.draft!.id);
  await f.action('duplicate');
  assert.ok(f.picker.children.some(option => option.value === f.view.draft.draft!.id));
  assert.equal(f.picker.value, f.view.draft.draft!.id);
});

test('effect palette dispatches existing defaults at the playhead and video uses its media picker', async t => {
  const f = await editorFixture(t);
  const driver = f.view as unknown as { playheadMs: number }; driver.playheadMs = 1250;
  assert.deepEqual(f.library.children.map(button => button.dataset.presetId), ['cinematic-bars', 'title', 'image', 'color-surface', 'animated-surface', 'video', 'audio', 'button', 'break']);
  assert.ok(f.library.children.every(button => button.dataset.stagecraftAction === 'add-preset'));
  f.dispatch(f.root, 'click', f.library.children[1]!); await settle();
  const text = f.view.draft.draft!.clips.find(clip => clip.type === 'text')!;
  assert.equal(text.startMs, 1250); assert.equal(text.type, 'text');
  assert.equal(f.view.draft.undo()!.clips.length, 1); assert.equal(f.view.draft.canUndo, false);
  f.dispatch(f.root, 'click', f.library.children.find(button => button.dataset.presetId === 'video')!); await settle();
  assert.equal(f.state.picks, 1); assert.equal(f.view.draft.draft!.clips.length, 1);
});

test('late video picker edits the originally chosen clip after selection changes',async t=>{
  class MetadataVideo extends EventTarget { duration=8;readyState=1;error=null;src='';muted=true;preload='';playsInline=true;load(){}pause(){}remove(){}removeAttribute(){} }
  const original=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>new MetadataVideo()}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');});
  const makeId=ids();let finishPicker:((path:string)=>void)|undefined;
  const runtime={now:()=>0,requestFrame:()=>0,cancelFrame:()=>{}};
  const services:EditorServices={makeId,repository:{list:async()=>[],read:async()=>null,save:async sequence=>sequence,delete:async()=>{}},localPlayer:new LocalPlayer(runtime),localize:key=>key,confirmDiscard:async()=>true,confirmDeleteSequence:async()=>false,observeLocal:()=>()=>{},prepareGroup:async()=>{},openSession:()=>{},groupActive:()=>false,chooseVideo:()=>new Promise(resolve=>{finishPicker=resolve;}),requestAudioUnlock:async()=>{}};
  const view=new EditorView(services);view.draft.create('Two videos');
  let sequence=view.draft.draft!;sequence=applyTimelineCommand(sequence,{kind:'add-track'},makeId);
  sequence=applyTimelineCommand(sequence,{kind:'add-clip',type:'video',trackId:sequence.tracks[1]!.id,startMs:0,sourcePath:'first.webm',sourceDurationMs:5000},makeId);
  sequence=applyTimelineCommand(sequence,{kind:'add-track'},makeId);
  sequence=applyTimelineCommand(sequence,{kind:'add-clip',type:'video',trackId:sequence.tracks[2]!.id,startMs:0,sourcePath:'second.webm',sourceDurationMs:5000},makeId);
  view.draft.replace(sequence);const first=sequence.clips[1] as VideoClip,second=sequence.clips[2] as VideoClip;
  const driver=view as unknown as {mounted:boolean;selectedId:string;chooseVideo():Promise<void>};driver.mounted=true;driver.selectedId=first.id;
  const pending=driver.chooseVideo();driver.selectedId=second.id;assert.ok(finishPicker);finishPicker('replacement.webm');await pending;
  const edited=view.draft.draft!;assert.equal((edited.clips.find(c=>c.id===first.id) as VideoClip).properties.source.path,'replacement.webm');
  assert.deepEqual(edited.clips.find(c=>c.id===second.id),second);view.detach();
});


test('selecting a title disables empty video fields and all other hidden inspector fields',t=>{
  const fixture=dom(t),makeId=ids(),root=new fixture.FakeElement();
  const runtime={now:()=>0,requestFrame:()=>0,cancelFrame:()=>{}};
  const services:EditorServices={makeId,repository:{list:async()=>[],read:async()=>null,save:async sequence=>sequence,delete:async()=>{}},localPlayer:new LocalPlayer(runtime),localize:key=>key,confirmDiscard:async()=>true,confirmDeleteSequence:async()=>false,observeLocal:()=>()=>{},prepareGroup:async()=>{},openSession:()=>{},groupActive:()=>false,chooseVideo:async()=>null,requestAudioUnlock:async()=>{}};
  const view=new EditorView(services);view.draft.create('Inspector');let sequence=view.draft.draft!;
  sequence=applyTimelineCommand(sequence,{kind:'add-track'},makeId);sequence=applyTimelineCommand(sequence,{kind:'add-clip',trackId:sequence.tracks[1]!.id,type:'text',startMs:0},makeId);view.draft.replace(sequence);
  const fields=new Map<string,InstanceType<typeof fixture.FakeElement>>();
  for(const type of ['bars','text','video']) {const panel=new fixture.FakeElement();panel.dataset.stagecraftElementPanel=type;for(const suffix of type==='video'?['path','out']:['start']){const input=new fixture.FakeElement('input');input.name=type+'-'+suffix;fields.set(input.name,input);panel.append(input);}root.append(panel);}
  const driver=view as unknown as {root:HTMLElement;selectedId:string;paintInspector():void};driver.root=root as unknown as HTMLElement;driver.selectedId=sequence.clips[1]!.id;driver.paintInspector();
  assert.equal(fields.get('video-path')!.disabled,true);assert.equal(fields.get('video-out')!.disabled,true);assert.equal(fields.get('bars-start')!.disabled,true);assert.equal(fields.get('text-start')!.disabled,false);view.detach();
});


test('pointerup uses final coordinates and scrolling adjusts time without extra history commands',t=>{
  const fixture=dom(t),makeId=ids();let sequence=createBarsSequence('Final pointer position',makeId);
  const root=new fixture.FakeElement(),commands:TimelineCommand[]=[];
  const view=new TimelineView(root as unknown as HTMLElement,key=>key,{select:()=>{},scrub:()=>{},beforeEdit:()=>{},error:()=>{},command:command=>{commands.push(command);sequence=applyTimelineCommand(sequence,command,makeId);view.render(sequence,sequence.clips[0]!.id);}});
  view.render(sequence,null);
  let node=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="'+sequence.clips[0]!.id+'"]')!;
  fixture.dispatch(root,'pointerdown',node,{button:0,pointerId:10,clientX:200,clientY:50});
  fixture.dispatch(root,'pointermove',node,{pointerId:10,clientX:240,clientY:50});
  fixture.dispatch(root,'pointerup',node,{pointerId:10,clientX:280,clientY:50});
  assert.equal(commands.length,1);assert.equal(sequence.clips[0]!.startMs,1000,'release position supersedes earlier move');assert.equal(root.hasPointerCapture(10),false);
  node=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="'+sequence.clips[0]!.id+'"]')!;
  fixture.dispatch(root,'pointerdown',node,{button:0,pointerId:11,clientX:280,clientY:50});
  root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!.scrollLeft=80;
  fixture.dispatch(root,'pointerup',node,{pointerId:11,clientX:280,clientY:50});
  assert.equal(commands.length,2);assert.equal(sequence.clips[0]!.startMs,2000,'timeline content scroll contributes to clip time');
  node=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="'+sequence.clips[0]!.id+'"]')!;
  fixture.dispatch(root,'pointerdown',node,{button:0,pointerId:12,clientX:280,clientY:50});
  fixture.dispatch(root,'pointerup',node,{pointerId:12,clientX:280,clientY:50});
  assert.equal(commands.length,2,'a selection click produces no timeline command');assert.equal(root.hasPointerCapture(12),false);
  node=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="'+sequence.clips[0]!.id+'"]')!;
  fixture.dispatch(root,'pointerdown',node,{button:0,pointerId:13,clientX:280,clientY:50});
  fixture.dispatch(root,'pointermove',node,{pointerId:13,clientX:360,clientY:50});root.releasePointerCapture(13);
  fixture.dispatch(root,'lostpointercapture',node,{pointerId:13});
  assert.equal(commands.length,2,'lost capture cancels an incomplete gesture');assert.equal(sequence.clips[0]!.startMs,2000);view.dispose();
});

test('timeline keeps track editing and preserves both scroll positions and focused controls on repaint',t=>{
  const fixture=dom(t),root=new fixture.FakeElement(),sequence=createBarsSequence('Toolbar',ids());
  const view=new TimelineView(root as unknown as HTMLElement,key=>key,{select:()=>{},scrub:()=>{},command:()=>{},error:()=>{},beforeEdit:()=>{}});
  view.render(sequence,null);
  const buttons=root.querySelectorAll<InstanceType<typeof fixture.FakeElement>>('[data-stagecraft-action="toggle-element"]');
  assert.equal(buttons.length,0,'effects are added from the palette');
  assert.equal(root.querySelectorAll('[data-timeline-track-add]').length, 1);
  const scroll=root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!;scroll.scrollLeft=160;scroll.scrollTop=120;
  const range=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-scrub]')!;range.focus();
  view.render(sequence,sequence.clips[0]!.id,2500);
  const replacement=root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!;
  assert.equal(replacement.scrollLeft,160);assert.equal(replacement.scrollTop,120);
  assert.equal(document.activeElement,root.querySelector('[data-timeline-scrub]'));
  assert.ok(root.querySelector('[data-timeline-ruler-corner]'),'ruler has a corner that covers horizontally scrolled ticks');view.dispose();
});

test('ruler and playhead drag scrub continuously with viewport, gutter, scroll and final position accounted for',t=>{
  const fixture=dom(t),root=new fixture.FakeElement(),sequence=createBarsSequence('Scrub',ids()),initial=JSON.stringify(sequence),times:number[]=[],commands:TimelineCommand[]=[];let edits=0;
  const view=new TimelineView(root as unknown as HTMLElement,key=>key,{select:()=>{},scrub:time=>{times.push(time);view.render(sequence,null,time);},command:command=>commands.push(command),error:()=>{},beforeEdit:()=>{edits++;}});
  view.render(sequence,null);
  const ruler=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-ruler]')!,handle=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-playhead]')!,scroll=root.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-timeline-scroll')!;
  // Viewport begins at 180px in this fixture; the track gutter occupies another 180px.
  scroll.scrollLeft=160;
  fixture.dispatch(root,'pointerdown',ruler,{button:0,pointerId:40,clientX:360,clientY:10});
  assert.deepEqual(times,[2000]);assert.equal(root.hasPointerCapture(40),true);assert.equal(root.contains(ruler),true,'preview repaint keeps the captured ruler stable');
  fixture.dispatch(root,'pointermove',root,{pointerId:99,clientX:440,clientY:10});assert.equal(times.length,1,'another pointer cannot scrub');
  fixture.dispatch(root,'pointermove',root,{pointerId:40,clientX:440,clientY:10});
  scroll.scrollLeft=240;
  fixture.dispatch(root,'pointerup',root,{pointerId:40,clientX:520,clientY:10});
  assert.deepEqual(times,[2000,3000,5000]);assert.equal(handle.style.left,'580px');assert.equal(root.hasPointerCapture(40),false);
  fixture.dispatch(root,'pointerdown',handle,{button:0,pointerId:41,clientX:520,clientY:5});
  fixture.dispatch(root,'pointermove',root,{pointerId:41,clientX:-1000,clientY:500});
  fixture.dispatch(root,'pointerup',root,{pointerId:41,clientX:999999,clientY:500});
  assert.deepEqual(times.slice(-3),[5000,0,12000]);assert.equal(handle.getAttribute('aria-valuenow'),'12000');
  assert.deepEqual(commands,[]);assert.equal(edits,0);assert.equal(JSON.stringify(sequence),initial,'scrubbing leaves draft and history untouched');view.dispose();
});

test('scrub capture ends cleanly on cancel, lost capture, Escape and disposal',t=>{
  const fixture=dom(t),root=new fixture.FakeElement(),sequence=createBarsSequence('Cancel scrub',ids()),times:number[]=[];
  const view=new TimelineView(root as unknown as HTMLElement,key=>key,{select:()=>{},scrub:time=>times.push(time),command:()=>assert.fail('scrub cannot commit a command'),error:()=>{},beforeEdit:()=>assert.fail('scrub cannot begin an edit')});view.render(sequence,null);
  const ruler=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-ruler]')!;
  const corner=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-ruler-corner]')!;
  fixture.dispatch(root,'pointerdown',corner,{button:0,pointerId:49,clientX:200,clientY:10});assert.equal(times.length,0,'sticky track gutter does not scrub');
  for(const [id,finish] of [[50,'pointercancel'],[51,'lostpointercapture'],[52,'keydown'],[53,'dispose']] as const){
    fixture.dispatch(root,'pointerdown',ruler,{button:0,pointerId:id,clientX:440,clientY:10});assert.equal(root.hasPointerCapture(id),true);
    if(finish==='dispose')view.dispose();else if(finish==='keydown')fixture.dispatch(root,finish,root,{key:'Escape'});else fixture.dispatch(root,finish,root,{pointerId:id});
    assert.equal(root.hasPointerCapture(id),false);const count:number=times.length;
    fixture.dispatch(root,'pointermove',root,{pointerId:id,clientX:520,clientY:10});fixture.dispatch(root,'pointerup',root,{pointerId:id,clientX:600,clientY:10});assert.equal(times.length,count,'ended scrub ignores later pointer events');
  }
});

test('playhead keyboard and native range inputs retain accessible silent scrubbing',t=>{
  const fixture=dom(t),root=new fixture.FakeElement(),sequence=createBarsSequence('Accessible scrub',ids()),times:number[]=[];
  const view=new TimelineView(root as unknown as HTMLElement,key=>key,{select:()=>{},scrub:time=>times.push(time),command:()=>assert.fail('scrub cannot commit a command'),error:()=>{},beforeEdit:()=>assert.fail('scrub cannot begin an edit')});view.render(sequence,null);
  const handle=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-playhead]')!,range=root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-scrub]')!;
  assert.equal(handle.getAttribute('role'),'slider');assert.equal(handle.getAttribute('aria-label'),'Playhead');
  fixture.dispatch(root,'keydown',handle,{key:'ArrowRight'});fixture.dispatch(root,'keydown',handle,{key:'ArrowRight',shiftKey:true});fixture.dispatch(root,'keydown',handle,{key:'Home'});fixture.dispatch(root,'keydown',handle,{key:'End'});
  range.value='3500';fixture.dispatch(root,'input',range);range.value='4500';fixture.dispatch(root,'change',range);
  assert.deepEqual(times,[100,1100,0,12000,3500,4500]);assert.equal(handle.getAttribute('aria-valuenow'),'4500');assert.equal(handle.getAttribute('aria-valuetext'),'4.50 s');
  handle.focus();view.render(sequence,null);assert.equal(document.activeElement,root.querySelector('[data-timeline-playhead]'));view.dispose();
});

function animationTransition(preset: Exclude<Transition['preset'], 'none'>, durationMs: number): Transition {
  return {
    preset, version: 1, durationMs, easing: 'linear',
    ...(preset === 'slide' || preset === 'fade-slide' ? { direction: 'left' as const } : {})
  };
}

function sequenceWithAnimatedClipTypes() {
  const makeId = ids('animation');
  let sequence = sequenceWithBreaks([{ id: 'overlapping-break', positionMs: 2_500 }]);
  const addTrack = (trackKind: 'visual' | 'audio') => {
    sequence = applyTimelineCommand(sequence, { kind: 'add-track', trackKind }, makeId);
    return sequence.tracks.at(-1)!.id;
  };
  const textTrack = addTrack('visual');
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'text', trackId: textTrack, startMs: 0 }, makeId);
  const textId = sequence.clips.find(clip => clip.type === 'text')!.id;
  const imageTrack = addTrack('visual');
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'image', trackId: imageTrack, startMs: 0, sourcePath: 'still.png' }, makeId);
  const imageId = sequence.clips.find(clip => clip.type === 'image')!.id;
  const videoTrack = addTrack('visual');
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'video', trackId: videoTrack, startMs: 0, sourcePath: 'scene.webm', sourceDurationMs: 5_000 }, makeId);
  const videoId = sequence.clips.find(clip => clip.type === 'video')!.id;
  const buttonTrack = addTrack('visual');
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'button', trackId: buttonTrack, startMs: 0 }, makeId);
  const buttonId = sequence.clips.find(clip => clip.type === 'button')!.id;
  const audioTrack = addTrack('audio');
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'audio', trackId: audioTrack, startMs: 0, sourcePath: 'score.ogg', sourceDurationMs: 5_000 }, makeId);
  const audioId = sequence.clips.find(clip => clip.type === 'audio')!.id;
  const barsId = sequence.clips.find(clip => clip.type === 'bars')!.id;
  const none: Transition = { preset: 'none', version: 1 };
  sequence = validateSequence({
    ...sequence,
    clips: sequence.clips.map(clip => {
      if (clip.type === 'bars') return { ...clip, entrance: animationTransition('fade', 300), exit: animationTransition('fade', 400) };
      if (clip.type === 'text') return { ...clip, entrance: animationTransition('slide', 800), exit: animationTransition('zoom', 1_000) };
      if (clip.type === 'image') return { ...clip, duration: { kind: 'fixed' as const, milliseconds: 200 },
        entrance: animationTransition('fade-slide', 80), exit: animationTransition('fade-zoom', 100) };
      if (clip.type === 'video') return { ...clip, entrance: none, exit: animationTransition('fade', 500) };
      return { ...clip, entrance: animationTransition('fade', 300), exit: animationTransition('fade', 400) };
    })
  });
  return { sequence, ids: { barsId, textId, imageId, videoId, buttonId, audioId } };
}

test('Button timeline clips use a color distinct from the other element palettes', t => {
  const { sequence, ids: clipIds } = sequenceWithAnimatedClipTypes();
  const { FakeElement } = dom(t), root = new FakeElement();
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, command: () => {}, error: error => { throw error; }, beforeEdit: () => {}
  });
  view.render(sequence, null);
  const button = root.querySelector<InstanceType<typeof FakeElement>>('[data-timeline-clip="' + clipIds.buttonId + '"]')!;
  assert.equal(button.style.backgroundColor, '#633d51');
  assert.equal(button.style.borderColor, '#e7a3c7');
  for (const clip of sequence.clips.filter(clip => clip.id !== clipIds.buttonId)) {
    const node = root.querySelector<InstanceType<typeof FakeElement>>('[data-timeline-clip="' + clip.id + '"]')!;
    assert.notEqual(button.style.backgroundColor, node.style.backgroundColor, `${clip.type} background remains distinct`);
  }
  assert.ok(!['#3a5867', '#525464', '#456957', '#593f68', '#365b70', '#63513a'].includes(button.style.backgroundColor),
    'button color stays separate from the default, bars, text, audio, image, and surface palettes');
});

test('timeline shows effective In and Out timing for every clip type and preserves clip controls during zoom and drag preview', t => {
  const fixture = dom(t), root = new fixture.FakeElement(), { sequence, ids: clipIds } = sequenceWithAnimatedClipTypes();
  const selected: string[] = [];
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: id => selected.push(id), scrub: () => {}, command: () => {}, error: error => { throw error; }, beforeEdit: () => {}
  });
  view.render(sequence, null);
  const node = (id: string) => root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + id + '"]')!;
  const area = (id: string, kind: 'in' | 'out') => node(id).querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-clip-fade-' + kind);
  for (const id of Object.values(clipIds)) {
    assert.ok(node(id).querySelector('.stagecraft-clip-label'), 'each element keeps its label above the timing regions');
  }
  assert.equal(area(clipIds.barsId, 'in')?.style.width, '24px');
  assert.equal(area(clipIds.barsId, 'out'), null, 'a sequence-end clip does not show an unused local Out transition');
  assert.equal(area(clipIds.textId, 'in')?.dataset.fadeMilliseconds, '800', 'slide uses the shared transition interval');
  assert.equal(area(clipIds.textId, 'out')?.dataset.fadeMilliseconds, '1000', 'zoom keeps its full authored interval');
  assert.equal(area(clipIds.imageId, 'in')?.style.width, '6.4px');
  assert.equal(area(clipIds.imageId, 'out')?.style.width, '8px');
  assert.equal(node(clipIds.imageId).style.width, '22px', 'short clips keep the existing minimum clip width');
  assert.equal(area(clipIds.videoId, 'in'), null, 'none does not create an In region');
  assert.equal(area(clipIds.videoId, 'out')?.style.width, '40px');
  assert.equal(area(clipIds.audioId, 'in')?.style.width, '24px');
  assert.equal(area(clipIds.audioId, 'out')?.style.width, '32px');
  for (const id of Object.values(clipIds)) {
    for (const marker of node(id).querySelectorAll<InstanceType<typeof fixture.FakeElement>>('.stagecraft-clip-fade')) {
      assert.equal(marker.getAttribute('aria-hidden'), 'true');
    }
  }
  const titleIn = area(clipIds.textId, 'in')!;
  fixture.dispatch(root, 'click', titleIn);
  assert.deepEqual(selected, [clipIds.textId], 'the In region does not block clip selection');

  const zoom = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-zoom]')!;
  zoom.value = '160'; fixture.dispatch(root, 'change', zoom);
  assert.equal(area(clipIds.textId, 'in')?.style.width, '128px', 'timing regions follow timeline zoom');
  assert.equal(area(clipIds.imageId, 'in')?.style.width, '12.8px');
  assert.equal(area(clipIds.imageId, 'out')?.style.width, '16px');
  assert.equal(node(clipIds.imageId).style.width, '32px');

  const title = node(clipIds.textId);
  fixture.dispatch(root, 'pointerdown', title, { button: 0, pointerId: 820, clientX: 400, clientY: 40 });
  fixture.dispatch(root, 'pointermove', title, { pointerId: 820, clientX: 560, clientY: 40 });
  assert.equal(title.style.left, '160px', 'the drag preview moves the clip at the zoomed timeline scale');
  assert.equal(title.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-clip-fade-in')?.style.width, '128px', 'the preview retains the In region');
  assert.equal(title.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-clip-fade-out')?.style.width, '160px', 'the preview retains the Out region');
  view.cancel(); view.dispose();
});

test('manual Break timing resolves sequence-end regions and unresolved legacy holds use their displayed span', t => {
  const fixture = dom(t), root = new fixture.FakeElement(), makeId = ids('manual-fade');
  let sequence = sequenceWithBreaks([{ id: 'manual-inner-break', positionMs: 2_000 }]);
  sequence = applyTimelineCommand(sequence, { kind: 'add-track', trackKind: 'visual' }, makeId);
  const titleTrack = sequence.tracks.at(-1)!.id;
  sequence = applyTimelineCommand(sequence, { kind: 'add-clip', type: 'text', trackId: titleTrack, startMs: 0 }, makeId);
  const bars = sequence.clips.find((clip): clip is Extract<typeof clip, { type: 'bars' }> => clip.type === 'bars')!;
  const title = sequence.clips.find(clip => clip.type === 'text')!;
  sequence = validateSequence({
    ...sequence,
    end: { kind: 'manual' },
    clips: sequence.clips.map(clip => clip.id === bars.id
      ? { ...clip, entrance: animationTransition('fade', 800), exit: animationTransition('fade', 800) }
      : clip.id === title.id ? { ...clip, duration: { kind: 'fixed' as const, milliseconds: 4_000 } } : clip)
  });
  const view = new TimelineView(root as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, command: () => {}, error: error => { throw error; }, beforeEdit: () => {}
  });
  view.render(sequence, null);
  const barNode = root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + bars.id + '"]')!;
  assert.equal(barNode.style.width, '320px', 'a sequence-end clip follows the derived manual endpoint');
  assert.equal(barNode.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-clip-fade-in')?.style.width, '64px');
  assert.equal(barNode.querySelectorAll('.stagecraft-clip-fade-out').length, 0, 'manual Break endpoints suppress per-clip Out transitions');
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-end-break-flag]')?.style.left, '500px');
  assert.equal(root.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-break="manual-inner-break"]')?.style.left, '160px');
  view.dispose();

  const legacyRoot = new fixture.FakeElement();
  const legacyBase = createBarsSequence('Legacy manual hold', ids('legacy-hold'), 1);
  const legacyBars = legacyBase.clips[0]!;
  const legacy = validateSequence({ ...legacyBase, end: { kind: 'manual' }, clips: [{ ...legacyBars,
    entrance: animationTransition('fade', 800), exit: animationTransition('fade', 800) }] });
  const legacyView = new TimelineView(legacyRoot as unknown as HTMLElement, key => key, {
    select: () => {}, scrub: () => {}, command: () => {}, error: error => { throw error; }, beforeEdit: () => {}
  });
  legacyView.render(legacy, null);
  const legacyNode = legacyRoot.querySelector<InstanceType<typeof fixture.FakeElement>>('[data-timeline-clip="' + legacyBars.id + '"]')!;
  assert.equal(legacyNode.style.width, '400px', 'legacy unknown-duration holds keep the existing fallback span');
  assert.equal(legacyNode.querySelector<InstanceType<typeof fixture.FakeElement>>('.stagecraft-clip-fade-in')?.style.width, '64px');
  assert.equal(legacyNode.querySelectorAll('.stagecraft-clip-fade-out').length, 0, 'the terminal manual hold has no local Out transition');
  legacyView.dispose();
});
