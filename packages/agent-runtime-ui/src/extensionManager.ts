import { createHash } from 'node:crypto';
export type RuntimeExtensionManagerStatus =
  | 'detected-unbuilt' | 'detected-installable' | 'installing-building'
  | 'installed-enabled' | 'installed-disabled' | 'invalid' | 'unreadable' | 'failed';
export interface RuntimeExtensionManagerDiagnostic {
  readonly code: string; readonly message: string; readonly path?: string;
}
export interface RuntimeExtensionManagerStatusEntry {
  readonly key: string; readonly packageRoot: string; readonly identity?: string; readonly version?: string;
  readonly status: RuntimeExtensionManagerStatus; readonly installationPhase?: string;
  readonly installCommand?: { readonly packageManager: string; readonly script: string };
  readonly configuration: { readonly schema?: unknown; readonly defaults: Readonly<Record<string, unknown>>; readonly values?: Readonly<Record<string, unknown>> };
  readonly diagnostics: readonly RuntimeExtensionManagerDiagnostic[];
}
export interface RuntimeExtensionManagerStatusSnapshot {
  readonly revision: number; readonly status: 'ready' | 'error'; readonly changedAt: string;
  readonly roots: readonly string[]; readonly entries: readonly RuntimeExtensionManagerStatusEntry[];
  readonly diagnostics: readonly RuntimeExtensionManagerDiagnostic[];
}
export interface RuntimeExtensionManagerInstalledRecord {
  readonly identity: string; readonly health: string;
  readonly blockReasons: readonly { readonly message: string }[];
  readonly configurationValues: Readonly<Record<string, unknown>>;
  readonly capabilityProviderIds: readonly string[];
}
export interface RuntimeExtensionManagerAutopilotSnapshot {
  readonly globalEnabled: boolean;
  readonly extensions: readonly { readonly identity: string; readonly enabled: boolean }[];
}

export const RUNTIME_EXTENSION_MANAGER_URI = 'ui://marshal-runtime/extensions';
export const RUNTIME_EXTENSION_MANAGER_TOOL = 'runtime_extensions_manage';
export const RUNTIME_EXTENSION_ACTION_TOOL = 'runtime_extensions_action';

export interface RuntimeExtensionManagerEntryView {
  readonly key: string;
  readonly identity: string;
  readonly version?: string;
  readonly packageRoot: string;
  readonly status: RuntimeExtensionManagerStatus;
  readonly statusLabel: string;
  readonly installationPhase?: string;
  readonly health?: string;
  readonly blocked: boolean;
  readonly blockReasons: readonly string[];
  readonly diagnostics: readonly RuntimeExtensionManagerDiagnostic[];
  readonly packageManager?: string;
  readonly installCommand?: string;
  readonly configurationSchema?: unknown;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly autopilot: boolean;
  readonly actions: readonly ('install' | 'enable' | 'disable' | 'remove' | 'configure')[];
}

export interface RuntimeExtensionManagerView {
  readonly revision: number;
  readonly changedAt: string;
  readonly status: RuntimeExtensionManagerStatusSnapshot['status'];
  readonly roots: readonly string[];
  readonly diagnostics: readonly RuntimeExtensionManagerDiagnostic[];
  readonly globalAutopilot: boolean;
  readonly entries: readonly RuntimeExtensionManagerEntryView[];
}

export function createRuntimeExtensionManagerView(
  snapshot: RuntimeExtensionManagerStatusSnapshot,
  installed: readonly RuntimeExtensionManagerInstalledRecord[] = [],
  autopilot: RuntimeExtensionManagerAutopilotSnapshot = { globalEnabled: false, extensions: [] },
): RuntimeExtensionManagerView {
  const installedByIdentity = new Map(installed.map((record) => [record.identity, record]));
  const autopilotByIdentity = new Map(autopilot.extensions.map((entry) => [entry.identity, entry.enabled]));
  return Object.freeze({
    revision: snapshot.revision,
    changedAt: snapshot.changedAt,
    status: snapshot.status,
    roots: [...snapshot.roots],
    diagnostics: [...snapshot.diagnostics],
    globalAutopilot: autopilot.globalEnabled,
    entries: snapshot.entries
      .filter(isVisibleManagerEntry)
      .map((entry) => extensionView(
        entry,
        installedByIdentity.get(entry.identity ?? ''),
        autopilotByIdentity.get(entry.identity ?? '') ?? false,
      )),
  });
}

function isVisibleManagerEntry(entry: RuntimeExtensionManagerStatusEntry): boolean {
  return !(
    entry.status === 'invalid'
    && entry.diagnostics.length > 0
    && entry.diagnostics.every((diagnostic) => diagnostic.code === 'manifest_missing')
  );
}

export function runtimeExtensionManagerDescriptor() {
  return {
    uri: RUNTIME_EXTENSION_MANAGER_URI,
    name: 'Marshal Runtime Extensions',
    description: 'Live discovery, installation, lifecycle, diagnostics, and configuration for Marshal runtime extensions.',
    mimeType: 'text/html;profile=mcp-app' as const,
    _meta: resourceMeta(),
  };
}

export function runtimeExtensionManagerToolMetadata() {
  return {
    ui: { resourceUri: RUNTIME_EXTENSION_MANAGER_URI, visibility: ['model', 'app'] as ['model', 'app'] },
    'ui/resourceUri': RUNTIME_EXTENSION_MANAGER_URI,
    'openai/widgetAccessible': true,
  };
}

export function runtimeExtensionActionToolMetadata() {
  return {
    ui: { visibility: ['model', 'app'] as ['model', 'app'] },
    'openai/widgetAccessible': true,
  };
}

export function renderRuntimeExtensionManagerHtml(view: RuntimeExtensionManagerView): string {
  const script = extensionManagerScript();
  const autopilotScript = extensionAutopilotControlsScriptV2();
  const style = `:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif)}*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--color-background-primary,#fff);color:var(--color-text-primary,#171717)}header,.row,.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}header{justify-content:space-between;margin-bottom:12px}.grid{display:grid;gap:12px}.card{border:1px solid var(--color-border-primary,#d5d5d5);border-radius:12px;padding:14px;background:var(--color-background-secondary,#fafafa)}h1,h3,p{margin:0}.title{display:grid;gap:3px}.muted{color:var(--color-text-secondary,#666);font-size:12px}.badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:2px 8px;font-size:12px}.success{color:#087a3e}.warning{color:#8a5700}.danger{color:#b42318}.info{color:#175cd3}.details{display:grid;gap:5px;margin:10px 0;font-size:12px}.diagnostic{margin-top:8px;padding:8px;border-radius:8px;background:rgba(180,35,24,.09);color:#b42318;white-space:pre-wrap}button,textarea{font:inherit;border-radius:8px;border:1px solid var(--color-border-primary,#aaa);padding:8px 10px}button{cursor:pointer}.primary{background:var(--color-accent-background,#175cd3);color:#fff}button.danger{background:#b42318;color:#fff}button.autopilot-on{background:#8a5700;color:#fff}textarea{display:block;width:100%;min-height:88px;margin:8px 0;font-family:ui-monospace,monospace}.status{font-size:12px;margin-top:8px}`;
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${createHash('sha256').update(script).digest('base64')}' 'sha256-${createHash('sha256').update(autopilotScript).digest('base64')}'`,
    `style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'`,
    "connect-src 'none'", "img-src data:", "font-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  const encoded = JSON.stringify(view).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><title>Marshal Runtime Extensions</title><style>${style}</style></head><body><main id="app"></main><script id="initial" type="application/json">${encoded}</script><script>${script}</script><script>${autopilotScript}</script></body></html>`;
}

export function runtimeExtensionManagerContent(view: RuntimeExtensionManagerView) {
  return {
    uri: RUNTIME_EXTENSION_MANAGER_URI,
    mimeType: 'text/html;profile=mcp-app' as const,
    text: renderRuntimeExtensionManagerHtml(view),
    _meta: resourceMeta(),
  };
}

function extensionView(
  entry: RuntimeExtensionManagerStatusEntry,
  installed: RuntimeExtensionManagerInstalledRecord | undefined,
  autopilot: boolean,
): RuntimeExtensionManagerEntryView {
  const blocked = installed?.health === 'blocked' || (installed?.blockReasons.length ?? 0) > 0;
  const actions: RuntimeExtensionManagerEntryView['actions'] =
    entry.status === 'detected-installable' || entry.status === 'detected-unbuilt'
      ? ['install']
      : entry.status === 'installed-enabled'
        ? ['disable', 'remove', 'configure']
        : entry.status === 'installed-disabled'
          ? ['enable', 'remove', 'configure']
          : [];
  return Object.freeze({
    key: entry.key,
    identity: entry.identity ?? entry.packageRoot,
    ...(entry.version ? { version: entry.version } : {}),
    packageRoot: entry.packageRoot,
    status: entry.status,
    statusLabel: statusLabel(entry.status),
    ...(entry.installationPhase ? { installationPhase: entry.installationPhase } : {}),
    ...(installed?.health ? { health: installed.health } : {}),
    blocked,
    blockReasons: installed?.blockReasons.map((reason) => reason.message) ?? [],
    diagnostics: [...entry.diagnostics],
    ...(entry.installCommand ? {
      packageManager: entry.installCommand.packageManager,
      installCommand: `${entry.installCommand.packageManager} run ${entry.installCommand.script}`,
    } : {}),
    ...(entry.configuration.schema === undefined ? {} : { configurationSchema: entry.configuration.schema }),
    configuration: entry.configuration.values ?? installed?.configurationValues ?? entry.configuration.defaults,
    autopilot,
    actions: blocked ? actions.filter((action) => action === 'remove' || action === 'configure') : actions,
  });
}

function statusLabel(status: RuntimeExtensionManagerStatus): string {
  switch (status) {
    case 'detected-unbuilt': return 'Build required';
    case 'detected-installable': return 'Detected';
    case 'installing-building': return 'Installing / building';
    case 'installed-enabled': return 'Installed and enabled';
    case 'installed-disabled': return 'Installed and disabled';
    case 'invalid': return 'Invalid';
    case 'unreadable': return 'Unreadable';
    case 'failed': return 'Failed';
  }
}

function resourceMeta() {
  return {
    ui: {
      resourceUri: RUNTIME_EXTENSION_MANAGER_URI,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
    },
  };
}

function extensionAutopilotControlsScript(): string {
  return `(function(){let next=1,view=JSON.parse(document.getElementById('initial').textContent),installQueued=false;const pending=new Map(),app=document.getElementById('app');function send(args){const id='autopilot-'+next++;parent.postMessage({jsonrpc:'2.0',id,method:'tools/call',params:{name:'runtime_extensions_action',arguments:args}},'*');return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});setTimeout(()=>{if(pending.delete(id))reject(new Error('Host request timed out'))},30000)})}function button(label,on){const node=document.createElement('button');node.textContent=label;node.className=on?'autopilot-on':'';return node}function queueInstall(){if(installQueued)return;installQueued=true;queueMicrotask(()=>{installQueued=false;install()})}function install(){const header=app.querySelector('header');if(header&&!header.querySelector('[data-autopilot-global]')){const node=button('Global autopilot: '+(view.globalAutopilot?'On':'Off'),view.globalAutopilot);node.dataset.autopilotGlobal='true';node.title='Automatically grant requested permissions to all installed runtime extensions.';node.onclick=()=>toggle(node,{action:'set-global-autopilot',enabled:!view.globalAutopilot});header.insertBefore(node,header.lastElementChild)}for(const card of app.querySelectorAll('.card')){const identity=card.querySelector('h3')?.textContent||'',entry=(view.entries||[]).find(candidate=>candidate.identity===identity),actions=card.querySelector('.actions');if(!entry||!actions||!['installed-enabled','installed-disabled'].includes(entry.status)||actions.querySelector('[data-autopilot-extension]'))continue;const node=button('Autopilot: '+(entry.autopilot?'On':'Off'),entry.autopilot);node.dataset.autopilotExtension=identity;node.title='Automatically grant requested permissions only to this extension.';node.onclick=()=>toggle(node,{action:'set-extension-autopilot',identity,enabled:!entry.autopilot});actions.prepend(node)}}async function toggle(node,args){node.disabled=true;try{const result=await send(args),structured=result&&result.structuredContent||result;if(result&&result.isError)throw new Error((result.content&&result.content[0]&&result.content[0].text)||'Action failed');if(!structured||!structured.view)throw new Error('Action returned no live view');view=structured.view;app.querySelector('[data-autopilot-global]')?.remove();for(const current of app.querySelectorAll('[data-autopilot-extension]'))current.remove();queueInstall()}catch(error){node.title='Autopilot update failed: '+String(error&&error.message||error)}finally{node.disabled=false}}addEventListener('message',event=>{if(event.source!==parent||!event.data||event.data.id===undefined)return;const waiter=pending.get(String(event.data.id));if(!waiter)return;pending.delete(String(event.data.id));event.data.error?waiter.reject(new Error(event.data.error.message||'Host request failed')):waiter.resolve(event.data.result)});new MutationObserver(queueInstall).observe(app,{childList:true,subtree:true});install()})();`;
}

function extensionAutopilotControlsScriptV2(): string {
  return `(function(){
    let next=1,view=JSON.parse(document.getElementById('initial').textContent),installQueued=false;
    const pending=new Map(),app=document.getElementById('app');
    function send(args){const id='autopilot-'+next++;parent.postMessage({jsonrpc:'2.0',id,method:'tools/call',params:{name:'runtime_extensions_action',arguments:args}},'*');return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});setTimeout(()=>{if(pending.delete(id))reject(new Error('Host request timed out'))},30000)})}
    function button(label,on){const node=document.createElement('button');node.textContent=label;node.className=on?'autopilot-on':'';return node}
    function queueInstall(){if(installQueued)return;installQueued=true;queueMicrotask(()=>{installQueued=false;install()})}
    function install(){
      const header=app.querySelector('header');
      if(header&&!header.querySelector('[data-autopilot-global]')){const node=button('Global autopilot: '+(view.globalAutopilot?'On':'Off'),view.globalAutopilot);node.dataset.autopilotGlobal='true';node.title='Automatically grant requested permissions to all installed runtime extensions.';node.onclick=()=>toggle(node,{action:'set-global-autopilot',enabled:!view.globalAutopilot});header.insertBefore(node,header.lastElementChild)}
      for(const card of app.querySelectorAll('.card')){
        const identity=card.querySelector('h3')?.textContent||'',entry=(view.entries||[]).find(candidate=>candidate.identity===identity),actions=card.querySelector('.actions');
        const installed=['installed-enabled','installed-disabled'].includes(entry?.status)||[...(actions?.querySelectorAll('button')||[])].some(node=>node.textContent==='Enable'||node.textContent==='Disable');
        if(!actions||!installed||actions.querySelector('[data-autopilot-extension]'))continue;
        const enabled=entry?.autopilot===true,node=button('Autopilot: '+(enabled?'On':'Off'),enabled);node.dataset.autopilotExtension=identity;node.title='Automatically grant requested permissions only to this extension.';node.onclick=()=>toggle(node,{action:'set-extension-autopilot',identity,enabled:!enabled});actions.prepend(node)
      }
    }
    async function toggle(node,args){node.disabled=true;try{const result=await send(args),structured=result&&result.structuredContent||result;if(result&&result.isError)throw new Error((result.content&&result.content[0]&&result.content[0].text)||'Action failed');if(!structured||!structured.view)throw new Error('Action returned no live view');view=structured.view;app.querySelector('[data-autopilot-global]')?.remove();for(const current of app.querySelectorAll('[data-autopilot-extension]'))current.remove();queueInstall()}catch(error){node.title='Autopilot update failed: '+String(error&&error.message||error)}finally{node.disabled=false}}
    addEventListener('message',event=>{if(event.source!==parent||!event.data||event.data.id===undefined)return;const waiter=pending.get(String(event.data.id));if(!waiter)return;pending.delete(String(event.data.id));event.data.error?waiter.reject(new Error(event.data.error.message||'Host request failed')):waiter.resolve(event.data.result)});
    new MutationObserver(queueInstall).observe(app,{childList:true,subtree:true});install()
  })();`;
}

function extensionManagerScript(): string {
  return `(function(){let next=1,currentView,pollTimer,hostContext={displayMode:'inline',availableDisplayModes:['inline']};const pending=new Map(),app=document.getElementById('app');function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n}function send(method,params){const id=next++;parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});setTimeout(()=>{if(pending.delete(id))reject(new Error('Host request timed out'))},30000)})}function tone(e){if(e.blocked||['invalid','unreadable','failed'].includes(e.status))return'danger';if(e.status==='installed-enabled')return'success';if(e.status==='installing-building'||e.status==='detected-unbuilt')return'warning';return'info'}function detail(card,label,value){if(value===undefined||value===null||value==='')return;const p=el('p');p.append(el('strong',label+': '),document.createTextNode(String(value)));card.append(p)}function render(view){currentView=view;if(pollTimer){clearTimeout(pollTimer);pollTimer=undefined}app.replaceChildren();const header=el('header'),title=el('div',undefined,'title');title.append(el('h1','Runtime Extensions'),el('p','Live runtime state · revision '+view.revision,'muted'));const expand=el('button','Open fullscreen');expand.disabled=!(hostContext.availableDisplayModes||[]).includes('fullscreen');expand.title=expand.disabled?'Fullscreen is unavailable in this host.':'Open the extension manager as a fullscreen workspace.';expand.onclick=()=>requestMode(expand,'fullscreen');const refresh=el('button','Refresh');refresh.onclick=()=>act(refresh,{action:'refresh'});header.append(title,expand,refresh);app.append(header);if(view.diagnostics&&view.diagnostics.length){const d=el('div',view.diagnostics.map(x=>x.message).join('\\n'),'diagnostic');app.append(d)}const grid=el('div',undefined,'grid');(view.entries||[]).forEach(e=>{const card=el('section',undefined,'card'),row=el('div',undefined,'row'),heading=el('div',undefined,'title');heading.append(el('h3',e.identity),el('p',e.version?'v'+e.version:'','muted'));row.append(heading,el('span',e.blocked?'Blocked':e.statusLabel,'badge '+tone(e)));card.append(row);const details=el('div',undefined,'details');detail(details,'Package root',e.packageRoot);detail(details,'Package manager',e.packageManager);detail(details,'Install command',e.installCommand);detail(details,'Phase',e.installationPhase);detail(details,'Health',e.health);card.append(details);if(e.blockReasons&&e.blockReasons.length)card.append(el('div',e.blockReasons.join('\\n'),'diagnostic'));if(e.diagnostics&&e.diagnostics.length)card.append(el('div',e.diagnostics.map(x=>x.code+': '+x.message+(x.path?' · '+x.path:'')).join('\\n'),'diagnostic'));let config;if(e.actions.includes('configure')){config=el('textarea');config.value=JSON.stringify(e.configuration||{},null,2);config.setAttribute('aria-label','Configuration for '+e.identity);card.append(el('p','Configuration','muted'),config)}const actions=el('div',undefined,'actions');e.actions.forEach(name=>{const b=el('button',name==='install'&&e.status==='detected-unbuilt'?'Install and build':name[0].toUpperCase()+name.slice(1),name==='install'?'primary':name==='remove'?'danger':'');b.onclick=()=>{let configuration;if(name==='configure'){try{configuration=JSON.parse(config.value)}catch(error){setStatus(card,'failed: '+error.message);return}}void act(b,{action:name,identity:e.identity,packageRoot:e.packageRoot,...(configuration===undefined?{}:{configuration})},card)};actions.append(b)});card.append(actions);grid.append(card)});app.append(grid);if((view.entries||[]).some(e=>e.status==='installing-building'))pollTimer=setTimeout(()=>void act(undefined,{action:'refresh'}),1000);size()}function setStatus(card,text){let node=card.querySelector('.status');if(!node){node=el('p',undefined,'status');card.append(node)}node.textContent=text}async function requestMode(button,mode){button.disabled=true;try{const result=await send('ui/request-display-mode',{mode});hostContext={...hostContext,displayMode:result&&result.mode||result&&result.displayMode||mode};document.body.dataset.displayMode=hostContext.displayMode}catch(error){button.title='Fullscreen request failed: '+String(error&&error.message||error)}finally{button.disabled=false;size()}}async function act(button,args,card){if(button)button.disabled=true;if(card)setStatus(card,'running…');try{const result=await send('tools/call',{name:'runtime_extensions_action',arguments:args});const structured=result&&result.structuredContent||result;if(result&&result.isError)throw new Error((result.content&&result.content[0]&&result.content[0].text)||'Action failed');if(!structured||!structured.view)throw new Error('Action returned no live view');render(structured.view);if(args.action==='install'&&!pollTimer)pollTimer=setTimeout(()=>void act(undefined,{action:'refresh'}),1000)}catch(error){if(card)setStatus(card,'failed: '+String(error&&error.message||error))}finally{if(button)button.disabled=false;size()}}function size(){parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width:document.documentElement.scrollWidth,height:Math.max(document.documentElement.scrollHeight,72)}},'*')}addEventListener('message',event=>{if(event.source!==parent)return;const data=event.data;if(!data||data.jsonrpc!=='2.0')return;if(data.method==='ui/notifications/host-context-changed'){hostContext={...hostContext,...data.params};document.body.dataset.displayMode=hostContext.displayMode||'inline';if(currentView)render(currentView);return}if(data.id===undefined)return;const waiter=pending.get(data.id);if(!waiter)return;pending.delete(data.id);data.error?waiter.reject(new Error(data.error.message||'Host request failed')):waiter.resolve(data.result)});render(JSON.parse(document.getElementById('initial').textContent));send('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'marshal-runtime-extensions',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline','fullscreen']}}).then(result=>{hostContext=result&&result.hostContext||hostContext;document.body.dataset.displayMode=hostContext.displayMode||'inline';render(currentView);parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');if(!pollTimer)pollTimer=setTimeout(()=>void act(undefined,{action:'refresh'}),0)}).catch(()=>{});})();`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
}
