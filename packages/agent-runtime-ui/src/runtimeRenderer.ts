import type {
  McpAppsResourceContent,
  McpAppsResourceDescriptor,
  UiRenderToolDescriptor,
} from './types.js';
import {
  UI_ACTION_TOOL_NAME,
  UI_CHROME_ACTION_BINDING_METHOD,
  UI_CHROME_ACTION_CANCEL_METHOD,
  UI_CHROME_ACTION_REQUEST_METHOD,
  UI_CHROME_ACTION_RESULT_METHOD,
  UI_CHROME_ACTION_TIMEOUT_MS,
  UI_DECLARED_TOOL_NAME,
  type UiApplicationManifest,
  type UiDisplayMode,
  type UiHostContext,
} from './applicationTypes.js';

export const REACT_UI_RENDERER_VERSION = '1.4.0' as const;
export const REACT_UI_TEMPLATE_URI = `ui://marshal-react/runtime-renderer/${REACT_UI_RENDERER_VERSION}/index.html`;
/** Maximum time before the renderer replaces incomplete hydration with a visible fallback. */
export const REACT_UI_HYDRATION_FALLBACK_TIMEOUT_MS = 4_000 as const;
/** Read-only compatibility identifier for messages created before renderer versioning. */
export const LEGACY_REACT_UI_TEMPLATE_URI = 'ui://marshal-react/runtime-renderer';
/** Explicitly retained renderer identifiers referenced by historical chat messages. */
export const HISTORICAL_REACT_UI_TEMPLATE_URIS = Object.freeze([
  'ui://marshal-react/runtime-renderer/1.2.0/index.html',
] as const);
export const REACT_UI_PAYLOAD_TOOL_NAME = 'marshal_get_react_payload';
export const REACT_UI_STATE_TOOL_NAME = 'marshal_update_react_state';
const MIME_TYPE = 'text/html;profile=mcp-app' as const;
const STYLE = `:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif)}*{box-sizing:border-box}body{margin:0;overflow:visible;background:transparent;color:var(--color-text-primary,#171717);-webkit-font-smoothing:antialiased}body[data-display-mode=fullscreen]{height:100dvh;overflow:hidden;display:flex;flex-direction:column}body[data-display-mode=fullscreen] #chrome{flex:0 0 auto}body[data-display-mode=fullscreen] #mount{display:flex;flex:1 1 auto;min-height:0}body[data-display-mode=fullscreen] iframe{height:100%!important;min-height:0;flex:1 1 auto}#status{padding:14px;color:var(--color-text-secondary,#666)}.skeleton{display:grid;gap:10px}.skeleton i{display:block;height:12px;border-radius:6px;background:color-mix(in srgb,currentColor 12%,transparent);animation:marshal-pulse 1.4s ease-in-out infinite}.skeleton i:nth-child(1){width:40%}.skeleton i:nth-child(2){width:85%}.skeleton i:nth-child(3){width:65%}@keyframes marshal-pulse{50%{opacity:.45}}@media (prefers-reduced-motion:reduce){.skeleton i{animation:none}}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}#status.error{color:var(--color-text-danger,#b42318)}#chrome{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:8px;background:var(--color-background-primary,Canvas);box-shadow:0 1px 0 color-mix(in srgb,currentColor 12%,transparent);position:relative;z-index:2}#chrome[hidden]{display:none}.chrome-group{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;flex-wrap:wrap}.chrome-button{min-width:40px;min-height:40px;padding:8px 12px;border:0;border-radius:10px;background:var(--color-background-secondary,#f2f2f2);color:inherit;box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 12%,transparent);font:600 13px/1.2 inherit;cursor:pointer;transition:transform 120ms cubic-bezier(.2,0,0,1),opacity 120ms cubic-bezier(.2,0,0,1)}.chrome-button:active:not(:disabled){transform:scale(.96)}.chrome-button:focus-visible{outline:2px solid var(--color-ring,#2563eb);outline-offset:2px}.chrome-button:disabled,.chrome-button[aria-disabled=true]{cursor:not-allowed;opacity:.55}.chrome-state{font:500 12px/1.35 inherit;color:var(--color-text-secondary,#666);padding:4px 2px;max-width:34rem;text-wrap:pretty;flex:1 1 100%}iframe{display:block;width:100%;min-height:240px;border:0;background:transparent}`;

export interface ReactUiChromeControlModel {
  modes: ReadonlyArray<{ mode: Exclude<UiDisplayMode, 'inline'>; label: string; available: boolean }>;
  actions: ReadonlyArray<{ id: string; label: string }>;
}

export interface ReactUiChromeDisplayModeOutcome {
  requested: Exclude<UiDisplayMode, 'inline'>;
  actual: UiDisplayMode;
  status: 'granted' | 'denied' | 'fallback' | 'timed_out';
  message: string;
}

/** Derive mandatory renderer chrome exclusively from portable manifest/host data. */
export function buildReactUiChromeModel(
  application: Pick<UiApplicationManifest, 'presentationModes' | 'actions' | 'localState' | 'authoritativeState'>,
  hostContext: Pick<UiHostContext, 'availableDisplayModes' | 'displayMode'> | undefined,
): ReactUiChromeControlModel {
  const available = new Set(hostContext?.availableDisplayModes ?? ['inline']);
  const current = hostContext?.displayMode;
  const modes = application.presentationModes
    .filter((mode): mode is Exclude<UiDisplayMode, 'inline'> => mode === 'fullscreen' || mode === 'pip')
    // The control for the mode we are already in is a no-op — offer only transitions.
    .filter((mode) => mode !== current)
    .map((mode) => ({
      mode,
      label: mode === 'pip' ? 'Picture in picture' : 'Fullscreen',
      available: available.has(mode),
    }));
  const persistent = Boolean(application.localState || application.authoritativeState);
  const actions = persistent
    ? application.actions.map((action) => ({
        id: action.id,
        label: action.title?.trim() || action.id.split(/[-_]+/g).filter(Boolean)
          .map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' '),
      }))
    : [];
  return { modes, actions };
}

/** Normalize a host response without manufacturing a grant the host did not return. */
export function resolveReactUiChromeDisplayMode(
  requested: Exclude<UiDisplayMode, 'inline'>,
  current: UiDisplayMode,
  result: { mode?: unknown; displayMode?: unknown } | undefined,
  errorMessage?: string,
  timedOut = false,
): ReactUiChromeDisplayModeOutcome {
  if (timedOut) {
    return {
      requested,
      actual: current,
      status: 'timed_out',
      message: `timed_out: ${requested === 'pip' ? 'Picture in picture' : 'Fullscreen'} request timed out; kept ${current}.`,
    };
  }
  if (errorMessage) {
    return { requested, actual: current, status: 'denied', message: `denied: ${errorMessage}; kept ${current}.` };
  }
  const candidate = result?.mode ?? result?.displayMode;
  const actual = candidate === 'inline' || candidate === 'fullscreen' || candidate === 'pip' ? candidate : current;
  return actual === requested
    ? { requested, actual, status: 'granted', message: `granted: opened ${requested === 'pip' ? 'Picture in picture' : 'Fullscreen'}.` }
    : { requested, actual, status: 'fallback', message: `fallback: host kept ${actual}.` };
}
const SCRIPT = `(function(){
const status=document.getElementById('status'),mount=document.getElementById('mount'),chrome=document.getElementById('chrome'),chromeModes=document.getElementById('chrome-modes'),chromeActions=document.getElementById('chrome-actions'),chromeStatus=document.getElementById('chrome-status'),initializeId='marshal-react-renderer-init';
const payloadTool=${JSON.stringify(REACT_UI_PAYLOAD_TOOL_NAME)},stateTool=${JSON.stringify(REACT_UI_STATE_TOOL_NAME)},actionTool=${JSON.stringify(UI_ACTION_TOOL_NAME)},declaredTool=${JSON.stringify(UI_DECLARED_TOOL_NAME)},chromeBindingMethod=${JSON.stringify(UI_CHROME_ACTION_BINDING_METHOD)},chromeActionRequestMethod=${JSON.stringify(UI_CHROME_ACTION_REQUEST_METHOD)},chromeActionCancelMethod=${JSON.stringify(UI_CHROME_ACTION_CANCEL_METHOD)},chromeActionResultMethod=${JSON.stringify(UI_CHROME_ACTION_RESULT_METHOD)},chromeActionTimeoutMs=${UI_CHROME_ACTION_TIMEOUT_MS};
const buildChromeModel=${buildReactUiChromeModel.toString()},resolveChromeMode=${resolveReactUiChromeDisplayMode.toString()};
let child=null,lastInput=null,lastResult=null,pendingResult=null,metadataTimer=null,loaded=false,requestSequence=0,currentRenderId=null,currentComponentId=null,currentApplication=null,hostInitialization=null,lastChildDimensions={height:240},lastReportedHeight=0,workspaceTimer=null,workspacePollMs=0;
const payloadRequests=new Map(),stateRequests=new Set(),chromeRequests=new Map(),expiredChromeRequests=new Set(),pendingChromeModes=new Set(),boundChromeActions=new Set(),pendingChromeActions=new Set(),pendingChromeActionRequests=new Map(),forwardedChildRequests=new Set(),escapeRequests=new Set();
const openaiExtensionMethods=['uploadFile','selectFiles','getFileDownloadUrl','requestModal','requestClose','openExternal','setOpenInAppUrl'];
function message(value){return value&&value.jsonrpc==='2.0'?value:null;}
function fallbackSummary(){for(const value of [pendingResult,lastResult]){const current=object(value),structured=object(current&&current.structuredContent),fallback=object(structured&&structured.fallback)||object(current&&current.fallback);if(fallback&&typeof fallback.summary==='string'&&fallback.summary)return fallback.summary;}return '';}
function fail(reason){loaded=true;if(child){child.remove();child=null;}status.hidden=false;status.className='error';const summary=fallbackSummary(),detail=reason||'The compiled interface could not be displayed.';status.textContent=summary?summary+' '+detail:detail;queueMicrotask(reportTotalHeight);}
function forward(value){if(child&&child.contentWindow)child.contentWindow.postMessage(value,'*');}
function hydrate(){if(!child||!child.contentWindow)return;if(lastInput)forward({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:lastInput});if(lastResult)forward({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:lastResult});}
function object(value){return value&&typeof value==='object'?value:null;}
function availableOpenAiExtensions(){const api=object(window.openai);return api?openaiExtensionMethods.filter(name=>typeof api[name]==='function'):[];}
function enrichedInitialization(value){const base=object(value)||{protocolVersion:'2026-01-26',hostInfo:{name:'unknown-host',version:'0'},hostCapabilities:{},hostContext:{displayMode:'inline',availableDisplayModes:['inline']}};const capabilities={...(object(base.hostCapabilities)||{})};const extensions={...(object(capabilities.extensions)||{})};const methods=availableOpenAiExtensions();if(methods.length)extensions.openai={methods};return {...base,hostCapabilities:{...capabilities,extensions}};}
let chromeMessage='';
function currentHostContext(){return object(hostInitialization&&hostInitialization.hostContext)||{displayMode:'inline',availableDisplayModes:['inline']};}
function isFullscreen(){return currentHostContext().displayMode==='fullscreen';}
function fullscreenHeight(){const dimensions=object(currentHostContext().containerDimensions),declared=Number(dimensions&&dimensions.height)||0,viewport=Number(window.innerHeight)||0;return Math.max(240,Math.ceil(declared),Math.ceil(viewport));}
function syncLayoutMode(){const mode=isFullscreen()?'fullscreen':'inline';document.body.dataset.displayMode=mode;if(!child)return;child.style.height=mode==='fullscreen'?'':Math.max(240,Math.min(2000,Math.ceil(Number(lastChildDimensions.height)||240)))+'px';}
function reportTotalHeight(){syncLayoutMode();const chromeHeight=chrome.hidden?0:Math.ceil(chrome.getBoundingClientRect().height),height=isFullscreen()?fullscreenHeight():Math.max(240,Math.ceil(Number(lastChildDimensions.height)||240)+chromeHeight);if(height===lastReportedHeight)return;lastReportedHeight=height;const params={...lastChildDimensions,height};parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params},'*');}
function chromeButton(group,label,kind,key){let button=[...group.children].find(candidate=>candidate.dataset&&candidate.dataset.chromeKind===kind&&candidate.dataset.chromeKey===key);if(!button){button=document.createElement('button');button.type='button';button.className='chrome-button';button.dataset.chromeKind=kind;button.dataset.chromeKey=key;}button.textContent=label;button.setAttribute('aria-label',label);return button;}
function reconcileChrome(group,controls,kind,update){const retained=new Set();let position=group.firstElementChild;for(const control of controls){const key=kind==='display-mode'?control.mode:control.id,button=chromeButton(group,control.label,kind,key);retained.add(button);update(button,control);if(button!==position)group.insertBefore(button,position);position=button.nextElementSibling;}for(const button of [...group.children])if(!retained.has(button))button.remove();}
function renderChrome(){
  if(!currentApplication){chrome.hidden=true;return;}
  const model=buildChromeModel(currentApplication,currentHostContext());
  reconcileChrome(chromeModes,model.modes,'display-mode',(button,control)=>{const pending=pendingChromeModes.has(control.mode);button.textContent=control.label;button.setAttribute('aria-label',control.label);button.disabled=!control.available;button.setAttribute('aria-disabled',pending?'true':'false');button.title=control.available?'Open '+control.label:control.label+' is not supported by this host; the app remains inline.';button.onclick=()=>{if(!pendingChromeModes.has(control.mode))requestChromeMode(control);};});
  reconcileChrome(chromeActions,model.actions,'action',(button,control)=>{const bound=boundChromeActions.has(control.id),pending=pendingChromeActions.has(control.id);button.textContent=pending?'Cancel '+control.label:control.label;button.setAttribute('aria-label',pending?'Cancel '+control.label:control.label);button.disabled=!bound;button.removeAttribute('aria-disabled');button.title=pending?'Cancel '+control.label:bound?'Run '+control.label:control.label+' is visible but the application has not bound its stateful handler.';button.onclick=()=>pendingChromeActions.has(control.id)?cancelChromeAction(control,'cancelled'):requestChromeAction(control);});
  if(!chromeMessage){
    const unavailable=model.modes.filter(control=>!control.available).map(control=>control.label);
    const unbound=model.actions.filter(control=>!boundChromeActions.has(control.id)).map(control=>control.label);
    chromeMessage=unavailable.length?'unsupported: '+unavailable.join(', ')+' unavailable; the complete app remains inline.':unbound.length?'unavailable: '+unbound.join(', ')+' needs an application action binding; use the inline control.':'';
  }
  chrome.hidden=model.modes.length===0&&model.actions.length===0&&!chromeMessage;
  chromeStatus.textContent=chromeMessage;
  chromeStatus.hidden=!chromeMessage;
  queueMicrotask(reportTotalHeight);
}
function requestChromeMode(control){
  if(!control.available){chromeMessage='unsupported: '+control.label+' is unavailable; the complete app remains inline.';renderChrome();return;}
  const requestId='marshal-react-chrome-mode-'+(++requestSequence);
  pendingChromeModes.add(control.mode);
  const timer=setTimeout(()=>{if(!chromeRequests.has(requestId))return;chromeRequests.delete(requestId);expiredChromeRequests.add(requestId);if(expiredChromeRequests.size>512)expiredChromeRequests.delete(expiredChromeRequests.values().next().value);parent.postMessage({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId}},'*');const context=currentHostContext(),current=typeof context.displayMode==='string'?context.displayMode:'inline';applyChromeModeOutcome(resolveChromeMode(control.mode,current,undefined,undefined,true),control,false);},chromeActionTimeoutMs);
  chromeRequests.set(requestId,{control,timer});chromeMessage='requesting: '+control.label+'.';renderChrome();
  parent.postMessage({jsonrpc:'2.0',id:requestId,method:'ui/request-display-mode',params:{mode:control.mode}},'*');
}
function requestChromeAction(control){
  if(!child||!child.contentWindow||!boundChromeActions.has(control.id)){chromeMessage='unavailable: '+control.label+' is not bound; use the inline control.';renderChrome();return;}
  const requestId='marshal-react-chrome-action-'+(++requestSequence);
  const activatedAt=new Date().toISOString(),timer=setTimeout(()=>cancelChromeAction(control,'timed_out'),chromeActionTimeoutMs);
  pendingChromeActions.add(control.id);pendingChromeActionRequests.set(requestId,{actionId:control.id,activatedAt,dispatched:false,timer});chromeMessage='running: '+control.label+'.';renderChrome();
  child.contentWindow.postMessage({jsonrpc:'2.0',method:chromeActionRequestMethod,params:{requestId,actionId:control.id,activatedAt}},'*');
}
function cancelChromeAction(control,statusValue){const pending=[...pendingChromeActionRequests.entries()].find(([,value])=>value.actionId===control.id);if(!pending)return;const [requestId,value]=pending;clearTimeout(value.timer);pendingChromeActionRequests.delete(requestId);pendingChromeActions.delete(control.id);if(child&&child.contentWindow)child.contentWindow.postMessage({jsonrpc:'2.0',method:chromeActionCancelMethod,params:{requestId,actionId:control.id}},'*');chromeMessage=statusValue+': '+control.label+(statusValue==='timed_out'?' timed out.':' was cancelled.');renderChrome();}
function applyChromeModeOutcome(outcome,control,notifyChild){
  const context=currentHostContext();
  pendingChromeModes.delete(control.mode);
  hostInitialization={...(object(hostInitialization)||{}),hostContext:{...context,displayMode:outcome.actual}};
  chromeMessage=outcome.message;renderChrome();if(notifyChild)forward({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:hostInitialization.hostContext});
}
function finishChromeMode(data,control){
  const result=object(data.result)||{},context=currentHostContext(),current=typeof context.displayMode==='string'?context.displayMode:'inline';
  const outcome=resolveChromeMode(control.mode,current,result,data.error?String(data.error.message||control.label+' was denied'):undefined);
  applyChromeModeOutcome(outcome,control,true);
}
async function invokeHostExtension(params){const current=object(params)||{};const namespace=current.namespace,method=current.method,args=Array.isArray(current.args)?current.args:[];if(namespace!=='openai'||typeof method!=='string'||!availableOpenAiExtensions().includes(method))return{namespace:String(namespace||''),method:String(method||''),status:'unsupported'};try{return{namespace,method,status:'success',result:await window.openai[method](...args)}}catch(error){return{namespace,method,status:'failed',error:{message:error&&error.message?String(error.message):'Host extension failed.'}}}}
function parsed(value){if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return null;}}
function findMarshalMeta(value,depth,seen){value=parsed(value);const current=object(value);if(!current||depth>6||seen.has(current))return null;seen.add(current);const direct=object(current._meta)&&object(current._meta.marshal);if(direct)return direct;const structured=object(current.structuredContent)&&object(current.structuredContent.marshal);if(structured)return structured;if(current.kind==='compiled_react_ui'&&typeof current.componentHtml==='string')return current;for(const key of ['mcp_tool_result','call_tool_result','tool_result','toolResult','result','output','response']){const found=findMarshalMeta(current[key],depth+1,seen);if(found)return found;}return null;}
function marshalMeta(result){const direct=findMarshalMeta(result,0,new Set());if(direct)return direct;const host=window.openai&&window.openai.toolResponseMetadata;return findMarshalMeta(host,0,new Set());}
function encodedJson(value){const bytes=new TextEncoder().encode(JSON.stringify(value));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);}
function allowAuthoredStyles(html){const marker="style-src 'sha256-";const start=html.indexOf(marker);if(start<0)return html;const end=html.indexOf("'",start+marker.length);if(end<0)return html;return html.slice(0,start)+"style-src 'unsafe-inline'"+html.slice(end+1);}
function bootstrapHtml(html,props,values,application,renderIdValue){const clean={};const current=object(values);if(current)for(const [key,value] of Object.entries(current))if(typeof value==='string')clean[key]=value;const safeProps=object(props)||{};const runtime={application:object(application)||{version:'1.0.0',presentationModes:['inline'],actions:[],tools:[]},renderId:renderIdValue};return allowAuthoredStyles(html).replace('name="marshal-props" content=""','name="marshal-props" content="'+encodedJson(safeProps)+'"').replace('name="marshal-storage" content=""','name="marshal-storage" content="'+encodedJson(clean)+'"').replace('name="marshal-runtime" content=""','name="marshal-runtime" content="'+encodedJson(runtime)+'"');}
function scheduleWorkspace(workspace){const current=object(workspace);if(workspaceTimer){clearTimeout(workspaceTimer);workspaceTimer=null;}if(!current||current.live!==true||!currentRenderId)return;workspacePollMs=Math.max(1000,Math.min(60000,Number(current.pollIntervalMs)||1500));workspaceTimer=setTimeout(()=>{workspaceTimer=null;requestPayload({renderId:currentRenderId},true);},workspacePollMs);}
function mountComponent(result,meta){pendingResult=null;if(metadataTimer){clearTimeout(metadataTimer);metadataTimer=null;}const structured=object(result.structuredContent)||{},marshal=object(structured.marshal)||{},workspace=object(structured.workspace)||object(marshal.workspace)||object(meta.workspace);currentRenderId=currentRenderId||renderId(result,0);scheduleWorkspace(workspace);if(workspace&&workspace.status==='compile_failed')chromeMessage='compile_failed: '+String(workspace.diagnostic||'The edit did not compile.')+' Showing the last good revision.';else if(workspace)chromeMessage='';renderChrome();const nextComponentId=typeof meta.componentId==='string'?meta.componentId:null;if(child&&nextComponentId&&nextComponentId===currentComponentId)return;if(!meta.componentHtml){requestPayload({renderId:currentRenderId});return;}if(child){child.remove();child=null;boundChromeActions.clear();pendingChromeActions.clear();for(const pending of pendingChromeActionRequests.values())clearTimeout(pending.timer);pendingChromeActionRequests.clear();}status.hidden=true;child=document.createElement('iframe');currentComponentId=nextComponentId;child.title=String(result.structuredContent&&result.structuredContent.render&&result.structuredContent.render.title||lastResult&&lastResult.structuredContent&&lastResult.structuredContent.render&&lastResult.structuredContent.render.title||'Compiled React interface');child.setAttribute('sandbox','allow-scripts');currentApplication=object(structured.application)||object(marshal.application)||object(meta.application)||{version:'1.0.0',presentationModes:['inline'],actions:[],tools:[]};lastChildDimensions={height:240};lastReportedHeight=0;child.srcdoc=bootstrapHtml(meta.componentHtml,structured.props,meta.storage,currentApplication,currentRenderId);child.addEventListener('load',()=>{loaded=true;hydrate();reportTotalHeight();},{once:true});mount.replaceChildren(child);renderChrome();}
function retryPending(){if(!pendingResult)return;const meta=marshalMeta(pendingResult);if(meta&&meta.kind==='compiled_react_ui'&&typeof meta.componentHtml==='string')mountComponent(pendingResult,meta);}
function render(result){if(result&&result.isError){const detail=result.structuredContent&&result.structuredContent.error;if(child){chromeMessage='refresh_failed: '+(typeof detail==='string'?detail:'The workspace refresh failed.')+' Showing the last good revision.';renderChrome();scheduleWorkspace({live:true,pollIntervalMs:workspacePollMs||1500});return;}fail(typeof detail==='string'?detail:'The render request failed.');return;}const meta=marshalMeta(result);if(!meta||meta.kind!=='compiled_react_ui'||typeof meta.componentHtml!=='string'){if(child){chromeMessage='refresh_failed: The payload was invalid. Showing the last good revision.';renderChrome();scheduleWorkspace({live:true,pollIntervalMs:workspacePollMs||1500});return;}pendingResult=result;if(metadataTimer)clearTimeout(metadataTimer);metadataTimer=setTimeout(()=>{retryPending();if(pendingResult&&!child)fail('The render result did not contain a validated compiled interface.');},${REACT_UI_HYDRATION_FALLBACK_TIMEOUT_MS});return;}mountComponent(result,meta);}
function renderId(value,depth){const current=object(value);if(!current||depth>6)return null;if(typeof current.renderId==='string'&&/^[a-f0-9]{64}$/.test(current.renderId))return current.renderId;const render=object(current.render);if(render&&typeof render.id==='string'&&/^[a-f0-9]{64}$/.test(render.id))return render.id;for(const key of ['arguments','input','params','structuredContent','mcp_tool_result','call_tool_result','tool_result','toolResult','result','output','response']){const found=renderId(current[key],depth+1);if(found)return found;}return null;}
function toolArguments(renderIdValue){const args={renderId:renderIdValue};const current=object(lastInput);if(current&&object(current.context))args.context=current.context;return args;}
function requestPayload(input,isPoll=false){const id=renderId(input,0);if(!id||isPoll&&[...payloadRequests.values()].includes(true))return;currentRenderId=id;const requestId='marshal-react-payload-'+(++requestSequence);payloadRequests.set(requestId,isPoll);const args=toolArguments(id);if(isPoll&&child&&currentComponentId)args.knownComponentId=currentComponentId;parent.postMessage({jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:payloadTool,arguments:args}},'*');}
function requestState(params){const current=object(params);if(!currentRenderId||!current)return;const operation=current.operation;if(!['set','remove','clear'].includes(operation))return;const args={...toolArguments(currentRenderId),operation};if(operation!=='clear'){if(typeof current.key!=='string')return;args.key=current.key;}if(operation==='set'){if(typeof current.value!=='string')return;args.value=current.value;}const requestId='marshal-react-state-'+(++requestSequence);stateRequests.add(requestId);parent.postMessage({jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:stateTool,arguments:args}},'*');}
function childError(data,message){if(data.id===undefined||!child||!child.contentWindow)return;child.contentWindow.postMessage({jsonrpc:'2.0',id:data.id,error:{code:-32601,message}},'*');}
function rememberForwardedRequest(data){if(data.id!==undefined)forwardedChildRequests.add(String(data.id));}
function dispatchBoundTool(data){const params=object(data.params),args=object(params&&params.arguments);if(!currentRenderId||!params||!args){childError(data,'Render-bound tool request is invalid.');return;}if(params.name===actionTool){const bound={renderId:currentRenderId,actionId:args.actionId,input:args.input,scope:args.scope};if(typeof args.idempotencyKey==='string')bound.idempotencyKey=args.idempotencyKey;if(object(args.approval))bound.approval=args.approval;const activationRequestId=typeof args.activationRequestId==='string'?args.activationRequestId:'',activation=pendingChromeActionRequests.get(activationRequestId);if(activation&&activation.actionId===args.actionId&&!activation.dispatched){activation.dispatched=true;bound.activation={requestId:activationRequestId,surface:'outer-renderer-chrome',method:chromeActionRequestMethod,activatedAt:activation.activatedAt,dispatchedAt:new Date().toISOString()};}rememberForwardedRequest(data);parent.postMessage({...data,params:{name:actionTool,arguments:bound}},'*');return;}if(params.name===declaredTool){rememberForwardedRequest(data);parent.postMessage({...data,params:{name:declaredTool,arguments:{renderId:currentRenderId,toolId:args.toolId,input:args.input}}},'*');return;}childError(data,'Only render-declared actions and tools may be invoked.');}
function forwardAllowedHostRequest(data){if(data.method==='tools/call'){dispatchBoundTool(data);return;}if(['ui/message','ui/update-model-context','ui/open-link'].includes(data.method)){rememberForwardedRequest(data);parent.postMessage(data,'*');return;}if(data.method==='ui/request-display-mode'){const mode=object(data.params)&&data.params.mode,modes=currentApplication&&Array.isArray(currentApplication.presentationModes)?currentApplication.presentationModes:[];if(!modes.includes(mode)){childError(data,'Display mode is not declared by this render.');return;}rememberForwardedRequest(data);parent.postMessage(data,'*');return;}if(data.method==='notifications/cancelled'){const requestId=object(data.params)&&data.params.requestId;if(requestId!==undefined&&forwardedChildRequests.delete(String(requestId)))parent.postMessage(data,'*');return;}childError(data,'UI bridge method is not allowed.');}
addEventListener('message',event=>{const data=message(event.data);if(!data)return;if(event.source===parent){const responseId=data.id===undefined?'':String(data.id);if(responseId&&expiredChromeRequests.delete(responseId))return;if(responseId&&escapeRequests.delete(responseId)){const result=object(data.result)||{},mode=result.mode!==undefined?result.mode:result.displayMode;if(mode==='inline'||mode==='fullscreen'||mode==='pip'){hostInitialization={...(object(hostInitialization)||{}),hostContext:{...currentHostContext(),displayMode:mode}};chromeMessage='';renderChrome();}return;}if(chromeRequests.has(data.id)){const pending=chromeRequests.get(data.id);chromeRequests.delete(data.id);clearTimeout(pending.timer);finishChromeMode(data,pending.control);return;}if(data.id===initializeId){if(data.error){fail(data.error.message||'The host rejected the UI bridge.');return;}hostInitialization=enrichedInitialization(data.result);renderChrome();parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');return;}if(payloadRequests.has(data.id)){const wasPoll=payloadRequests.get(data.id);payloadRequests.delete(data.id);if(data.error){if(wasPoll&&child){chromeMessage='refresh_failed: '+String(data.error.message||'Workspace refresh failed.')+' Showing the last good revision.';renderChrome();scheduleWorkspace({live:true,pollIntervalMs:workspacePollMs||1500});return;}fail(data.error.message||'The compiled interface payload could not be restored.');return;}render(data.result);return;}if(stateRequests.has(data.id)){stateRequests.delete(data.id);return;}if(data.method==='ui/notifications/tool-input'){lastInput=data.params;requestPayload(data.params);forward(data);return;}if(data.method==='ui/notifications/tool-result'){lastResult=data.params;if(child){forward(data);return;}const meta=marshalMeta(data.params);if(meta){render(data.params);return;}const id=renderId(data.params,0);if(id){requestPayload(data.params);return;}render(data.params);return;}if(data.method==='ui/notifications/host-context-changed'){const init=object(hostInitialization)||{},context=currentHostContext();hostInitialization={...init,hostContext:{...context,...(object(data.params)||{})}};chromeMessage='';renderChrome();forward(data);return;}if(data.method==='ui/notifications/tool-cancelled'){forward(data);if(!child)fail('The render request was cancelled.');return;}if(data.method==='ui/notifications/teardown'){forward(data);if(workspaceTimer){clearTimeout(workspaceTimer);workspaceTimer=null;}if(child){child.remove();child=null;currentComponentId=null;currentApplication=null;}for(const pending of chromeRequests.values())clearTimeout(pending.timer);for(const pending of pendingChromeActionRequests.values())clearTimeout(pending.timer);chromeRequests.clear();payloadRequests.clear();expiredChromeRequests.clear();pendingChromeModes.clear();boundChromeActions.clear();pendingChromeActions.clear();pendingChromeActionRequests.clear();forwardedChildRequests.clear();chromeMessage='';renderChrome();return;}if(data.id!==undefined&&!data.method)forwardedChildRequests.delete(String(data.id));forward(data);return;}if(!child||event.source!==child.contentWindow)return;if(data.method==='ui/initialize'&&data.id!==undefined){child.contentWindow.postMessage({jsonrpc:'2.0',id:data.id,result:hostInitialization||enrichedInitialization({protocolVersion:'2026-01-26',hostInfo:{name:'marshal-react-renderer',version:${JSON.stringify(REACT_UI_RENDERER_VERSION)}},hostCapabilities:{},hostContext:{displayMode:'inline',availableDisplayModes:['inline']}})},'*');return;}if(data.method==='marshal/extensions/call'&&data.id!==undefined){invokeHostExtension(data.params).then(result=>child&&child.contentWindow&&child.contentWindow.postMessage({jsonrpc:'2.0',id:data.id,result},'*'));return;}if(data.method===chromeBindingMethod){const params=object(data.params)||{},actionId=typeof params.actionId==='string'?params.actionId:'';if(actionId){if(params.bound===true)boundChromeActions.add(actionId);else boundChromeActions.delete(actionId);chromeMessage='';renderChrome();}return;}if(data.method===chromeActionResultMethod){const params=object(data.params)||{},actionId=typeof params.actionId==='string'?params.actionId:'',requestId=typeof params.requestId==='string'?params.requestId:'',pending=pendingChromeActionRequests.get(requestId);if(!requestId||!pending||pending.actionId!==actionId)return;clearTimeout(pending.timer);pendingChromeActionRequests.delete(requestId);pendingChromeActions.delete(actionId);const allowed=['success','not_found','unavailable','denied','approval_required','failed','cancelled','timed_out'];chromeMessage=allowed.includes(params.status)&&typeof params.message==='string'?params.status+': '+params.message:'failed: Application action did not return a typed result.';renderChrome();return;}if(data.method==='ui/notifications/initialized'){hydrate();return;}if(data.method==='ui/notifications/size-changed'||data.method==='marshal/ui-size'){const params=object(data.params)||{},height=Number(params.height),width=Number(params.width);if(Number.isFinite(height)){lastChildDimensions={...lastChildDimensions,height:Math.max(240,Math.min(2000,Math.ceil(height)))};child.style.height=lastChildDimensions.height+'px';}if(Number.isFinite(width))lastChildDimensions={...lastChildDimensions,width:Math.max(0,Math.ceil(width))};reportTotalHeight();return;}if(data.method==='marshal/storage'){requestState(data.params);return;}forwardAllowedHostRequest(data);},{passive:true});
if(typeof ResizeObserver==='function')new ResizeObserver(reportTotalHeight).observe(chrome);
addEventListener('resize',reportTotalHeight,{passive:true});
addEventListener('keydown',event=>{if(event.key!=='Escape'||!isFullscreen())return;const requestId='marshal-react-escape-'+(++requestSequence);escapeRequests.add(requestId);if(escapeRequests.size>64)escapeRequests.delete(escapeRequests.values().next().value);parent.postMessage({jsonrpc:'2.0',id:requestId,method:'ui/request-display-mode',params:{mode:'inline'}},'*');},{passive:true});
addEventListener('openai:set_globals',retryPending,{passive:true});
parent.postMessage({jsonrpc:'2.0',id:initializeId,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'marshal-react-renderer',version:${JSON.stringify(REACT_UI_RENDERER_VERSION)}},appCapabilities:{availableDisplayModes:['inline','fullscreen','pip']}}},'*');
setTimeout(()=>{if(!loaded)fail('The compiled interface did not arrive from the render tool.')},${REACT_UI_HYDRATION_FALLBACK_TIMEOUT_MS});
})();`;

export function reactUiTemplateDescriptor(): McpAppsResourceDescriptor {
  return {
    uri: REACT_UI_TEMPLATE_URI,
    name: 'Marshal compiled React renderer',
    description: 'Static, network-denied bridge for scoped, content-addressed React UI renders.',
    mimeType: MIME_TYPE,
    _meta: resourceMeta(),
  };
}

export function reactUiTemplateContent(uri = REACT_UI_TEMPLATE_URI): McpAppsResourceContent {
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    'img-src data: blob:',
    "font-src 'none'",
    "media-src 'none'",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    uri,
    mimeType: MIME_TYPE,
    text: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><title>Compiled React interface</title><style>${STYLE}</style></head><body><p id="status" role="status"><span class="skeleton" aria-hidden="true"><i></i><i></i><i></i></span><span class="visually-hidden">Loading compiled interface…</span></p><section id="chrome" aria-label="Application controls" hidden><div id="chrome-modes" class="chrome-group" aria-label="Display modes"></div><div id="chrome-actions" class="chrome-group" aria-label="Application actions"></div><p id="chrome-status" class="chrome-state" role="status" aria-live="polite"></p></section><main id="mount"></main><script>${SCRIPT}</script></body></html>`,
    _meta: resourceMeta(uri),
  };
}

export function reactUiToolMetadata(): UiRenderToolDescriptor['_meta'] {
  return {
    ui: { resourceUri: REACT_UI_TEMPLATE_URI, visibility: ['model', 'app'] },
    'ui/resourceUri': REACT_UI_TEMPLATE_URI,
  };
}

function resourceMeta(resourceUri = REACT_UI_TEMPLATE_URI): McpAppsResourceDescriptor['_meta'] {
  return {
    ui: {
      resourceUri,
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
      prefersBorder: true,
    },
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
}
