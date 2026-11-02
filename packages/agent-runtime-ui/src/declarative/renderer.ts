import { createHash } from 'node:crypto';
import type {
  DeclarativeUiDocument,
  McpAppsResourceContent,
  McpAppsResourceDescriptor,
  UiArtifact,
  UiNode,
  UiScalar,
} from './types.js';

const MIME_TYPE = 'text/html;profile=mcp-app' as const;
export const DECLARATIVE_UI_TEMPLATE_URI = 'ui://marshal-declarative/runtime-renderer';
const STYLE = `:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif)}*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--color-background-primary,#fff);color:var(--color-text-primary,#171717)}.stack{display:flex}.vertical{flex-direction:column}.horizontal{flex-direction:row;flex-wrap:wrap}.gap-none{gap:0}.gap-small{gap:6px}.gap-medium{gap:12px}.gap-large{gap:20px}.card{border:1px solid var(--color-border-primary,#d5d5d5);border-radius:12px;padding:14px;background:var(--color-background-secondary,#fafafa)}h1,h2,h3,p{margin:0}.muted{color:var(--color-text-secondary,#666)}.success{color:#087a3e}.warning{color:#8a5700}.danger{color:#b42318}.info{color:#175cd3}.badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:2px 8px;width:max-content}button,input,select{font:inherit;border-radius:8px;border:1px solid var(--color-border-primary,#aaa);padding:8px 10px}button{cursor:pointer}.primary{background:var(--color-accent-background,#175cd3);color:#fff}.danger-button{background:#b42318;color:#fff}label{display:flex;flex-direction:column;gap:4px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px;border-bottom:1px solid var(--color-border-primary,#ddd)}progress{width:100%}.action-status{font-size:12px;color:var(--color-text-secondary,#666)}.action-status[data-status=failed],.action-status[data-status=denied],.action-status[data-status=cancelled]{color:#b42318}.action-status[data-status=approval_required]{color:#8a5700}.confirmation{display:flex;flex-direction:column;gap:8px;border:1px solid var(--color-border-primary,#aaa);border-radius:10px;padding:10px;background:var(--color-background-secondary,#fafafa)}.confirmation-actions{display:flex;gap:8px;flex-wrap:wrap}`;
const INTERACTION_RUNTIME = `
function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}
function element(tag,text){const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);return node;}
function scalarText(value){return value==null?'':String(value);}
function send(method,params){const id=next++;parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});setTimeout(()=>{if(pending.delete(id))reject(new Error('Host request timed out'));},30000);});}
function resolveResponse(data){const waiter=pending.get(data.id);if(!waiter)return;pending.delete(data.id);if(data.error)waiter.reject(new Error(data.error.message||'Host request failed'));else waiter.resolve(data.result);}
function selectedOption(field){const options=field.options,index=field.selectedIndex;if(options&&Number.isInteger(index)&&index>=0&&index<options.length){const indexed=options[index]||(typeof options.item==='function'?options.item(index):null);if(indexed)return indexed;}const selected=field.selectedOptions;if(selected){const fallback=selected[0]||(typeof selected.item==='function'?selected.item(0):null);if(fallback)return fallback;}if(options){for(let offset=0;offset<options.length;offset++){const candidate=options[offset]||(typeof options.item==='function'?options.item(offset):null);if(candidate&&candidate.selected)return candidate;}}return null;}
function scalarOptionValue(option,fallback){if(!option)return fallback;const encoded=option.dataset&&option.dataset.scalar!==undefined?option.dataset.scalar:typeof option.getAttribute==='function'?option.getAttribute('data-scalar'):null;if(encoded===null||encoded===undefined)return fallback;try{return JSON.parse(encoded);}catch{return encoded;}}
function fieldValue(field){if(field.tagName==='SELECT')return scalarOptionValue(selectedOption(field),field.value);return field.type==='number'&&field.value!==''?Number(field.value):field.value;}
function values(){const result={};document.querySelectorAll('[data-field]').forEach(field=>{result[field.dataset.field]=fieldValue(field);});return result;}
function detail(record,fallback){if(!record)return fallback;const error=object(record.error);if(error&&typeof error.message==='string')return error.message;if(typeof record.error==='string')return record.error;const approval=object(record.approval);if(approval&&typeof approval.reason==='string')return approval.reason;const confirmation=object(record.confirmation);if(confirmation&&typeof confirmation.message==='string')return confirmation.message;if(typeof record.message==='string')return record.message;return fallback;}
function unwrapMcp(payload){const mcp=object(payload)||{};const structured=object(mcp.structuredContent)||mcp;if(mcp.isError===true)return{status:'failed',message:detail(structured,'Host tool call failed.'),value:structured};const status=typeof structured.status==='string'?structured.status:'';if(['success','not_found','denied','approval_required','failed','cancelled'].includes(status)){if(status!=='success')return{status:status==='not_found'?'failed':status,message:detail(structured,'Runtime execution ended with '+status+'.'),value:structured};const result=object(structured.result);return{status:'success',value:result&&Object.prototype.hasOwnProperty.call(result,'output')?result.output:structured};}return{status:'success',value:structured};}
function actionOutcome(payload){const outer=unwrapMcp(payload);if(outer.status!=='success')return outer;let value=outer.value;const wrapper=object(value);if(wrapper&&typeof wrapper.status!=='string'&&Object.prototype.hasOwnProperty.call(wrapper,'output'))value=wrapper.output;const record=object(value);const status=record&&typeof record.status==='string'?record.status:'completed';if(status==='completed'||status==='success')return{status:'completed',message:'Action completed.',value};if(status==='confirmation_required')return{status,message:detail(record,'Confirmation is required.'),confirmation:object(record.confirmation)};if(['denied','cancelled','approval_required','failed'].includes(status))return{status,message:detail(record,'Action ended with '+status+'.'),value};return{status:'failed',message:'Action returned unsupported status '+String(status)+'.',value};}
function notifySize(){const rootElement=document.documentElement,body=document.body,width=Math.ceil(Math.max(rootElement&&rootElement.scrollWidth||0,body&&body.scrollWidth||0)),height=Math.ceil(Math.max(rootElement&&rootElement.scrollHeight||0,body&&body.scrollHeight||0,72));parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width,height}},'*');}
function installSizeObserver(){if(typeof globalThis.ResizeObserver==='function')new globalThis.ResizeObserver(()=>notifySize()).observe(document.body);}
function operationKey(button){if(button.dataset.operationKey)return button.dataset.operationKey;const api=globalThis.crypto;const key=api&&typeof api.randomUUID==='function'?api.randomUUID():'ui-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);button.dataset.operationKey=key;return key;}
function statusNode(button,actionId){const parentElement=button.parentElement||document.body;let node=parentElement.querySelector('[data-action-status="'+actionId+'"]');if(!node){node=element('span');node.className='action-status';node.dataset.actionStatus=actionId;node.setAttribute('role','status');parentElement.append(node);}return node;}
function setActionStatus(button,actionId,status,message){button.dataset.status=status;const node=statusNode(button,actionId);node.dataset.status=status;node.textContent=status+(message?': '+message:'');button.title=message||status;}
function clearConfirmation(button,actionId){const parentElement=button.parentElement;const current=parentElement&&parentElement.querySelector('[data-confirmation-action="'+actionId+'"]');if(current)current.remove();}
function showConfirmation(button,actionId,confirmation){clearConfirmation(button,actionId);const panel=element('div');panel.className='confirmation';panel.dataset.confirmationAction=actionId;panel.setAttribute('role','alertdialog');panel.setAttribute('aria-modal','false');const title=element('strong',confirmation&&confirmation.title||'Confirm action');const message=element('p',confirmation&&confirmation.message||'Run this action?');const controls=element('div');controls.className='confirmation-actions';const confirmButton=element('button','Confirm');confirmButton.type='button';confirmButton.className='primary';const cancelButton=element('button','Cancel');cancelButton.type='button';confirmButton.addEventListener('click',()=>{panel.remove();void invokeAction(button,actionId,true);});cancelButton.addEventListener('click',()=>{panel.remove();button.disabled=false;setActionStatus(button,actionId,'cancelled','Confirmation was cancelled.');notifySize();});controls.append(confirmButton,cancelButton);panel.append(title,message,controls);button.parentElement.append(panel);button.disabled=true;setActionStatus(button,actionId,'confirmation_required',message.textContent);notifySize();}
async function invokeAction(button,actionId,confirmed){button.disabled=true;let awaitingConfirmation=false;setActionStatus(button,actionId,'running','Running action.');try{const input={artifactId:artifactRef.artifactId,revision:artifactRef.revision,documentDigest:artifactRef.documentDigest,actionId,event:values(),idempotencyKey:operationKey(button)};if(confirmed)input.confirmed=true;const payload=await send('tools/call',{name:'runtime_exec',arguments:{targetType:'operation',target:'ui.actions.invoke',input}});const outcome=actionOutcome(payload);if(outcome.status==='confirmation_required'){awaitingConfirmation=true;showConfirmation(button,actionId,outcome.confirmation);return;}setActionStatus(button,actionId,outcome.status,outcome.message);if(outcome.status==='completed')delete button.dataset.operationKey;}catch(error){setActionStatus(button,actionId,'failed',String(error&&error.message||error));}finally{if(!awaitingConfirmation)button.disabled=false;notifySize();}}
function bindActions(scope){scope.querySelectorAll('[data-action]').forEach(button=>{if(button.dataset.actionBound==='true')return;button.dataset.actionBound='true';button.addEventListener('click',()=>void invokeAction(button,button.dataset.action,false));});}
`;
const SCRIPT = `(function(){let next=1;const pending=new Map();const artifactRef={artifactId:document.body.dataset.artifact,revision:Number(document.body.dataset.revision),documentDigest:document.body.dataset.documentDigest};${INTERACTION_RUNTIME}addEventListener('message',event=>{if(event.source!==parent)return;const data=event.data;if(!data||data.jsonrpc!=='2.0'||data.id===undefined)return;resolveResponse(data);});bindActions(document);installSizeObserver();send('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'marshal-declarative-ui',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}}).then(()=>{parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');notifySize();}).catch(()=>notifySize());})();`;
const TEMPLATE_SCRIPT = `(function(){
let next=1,artifactId='',settled=false;
const pending=new Map(),root=document.getElementById('app'),artifactRef={artifactId:'',revision:0,documentDigest:''};
${INTERACTION_RUNTIME}
function fail(reason){settled=true;const message=element('p',reason||'The declarative interface could not be displayed.');message.className='danger';root.replaceChildren(message);notifySize();}
function render(node){let out;if(node.type==='stack'||node.type==='card'){out=element('section');out.className=node.type==='card'?'card stack vertical gap-medium':'stack '+(node.direction==='horizontal'?'horizontal':'vertical')+' gap-'+(node.gap||'medium');if(node.type==='card'&&node.title)out.append(element('h3',node.title));(node.children||[]).forEach(child=>out.append(render(child)));}else if(node.type==='heading'){out=element('h'+(node.level||2),node.text);}else if(node.type==='text'){out=element('p',node.text);out.className=node.tone||'default';}else if(node.type==='badge'){out=element('span',node.text);out.className='badge '+(node.tone||'default');}else if(node.type==='button'){out=element('button',node.label);out.type='button';out.dataset.action=node.actionId;out.className=node.variant==='primary'?'primary':node.variant==='danger'?'danger-button':'';}else if(node.type==='input'){out=element('label',node.label);const input=element('input');input.type=node.inputType||'text';input.value=scalarText(node.value);input.placeholder=node.placeholder||'';input.dataset.field=node.name;out.append(input);}else if(node.type==='select'){out=element('label',node.label);const select=element('select');select.dataset.field=node.name;(node.options||[]).forEach(option=>{const item=element('option',option.label);item.value=scalarText(option.value);item.dataset.scalar=JSON.stringify(option.value);item.selected=option.value===node.value;select.append(item);});out.append(select);}else if(node.type==='progress'){out=element('label',node.label||'');const progress=element('progress');progress.max=100;progress.value=node.value;out.append(progress);}else if(node.type==='divider'){out=element('hr');}else if(node.type==='table'){out=element('table');const head=element('thead'),headRow=element('tr'),body=element('tbody');(node.columns||[]).forEach(column=>headRow.append(element('th',column.label)));head.append(headRow);(node.rows||[]).forEach(row=>{const tr=element('tr');node.columns.forEach(column=>tr.append(element('td',scalarText(row[column.key]))));body.append(tr);});out.append(head,body);}else{out=element('p','Unsupported declarative node');}out.id=node.id||'';return out;}
function show(payload){const decoded=unwrapMcp(payload);if(decoded.status!=='success'){fail(decoded.message||'The declarative render request failed.');return;}let output=decoded.value;const wrapper=object(output);if(wrapper&&!wrapper.artifact&&object(wrapper.output))output=wrapper.output;const record=object(output),artifact=record&&object(record.artifact);if(!artifact||!object(artifact.document)||typeof artifact.id!=='string'||!Number.isSafeInteger(artifact.revision)||artifact.revision<1||typeof artifact.documentDigest!=='string'||!/^[a-f0-9]{64}$/.test(artifact.documentDigest)){fail('The render result did not contain a validated declarative artifact revision.');return;}settled=true;artifactId=artifact.id;artifactRef.artifactId=artifact.id;artifactRef.revision=artifact.revision;artifactRef.documentDigest=artifact.documentDigest;root.replaceChildren(render(artifact.document.root));bindActions(root);document.title=artifact.document.title||'Declarative UI';notifySize();}
addEventListener('message',event=>{if(event.source!==parent)return;const data=event.data;if(!data||data.jsonrpc!=='2.0')return;if(data.id!==undefined){resolveResponse(data);return;}if(data.method==='ui/notifications/tool-result')show(data.params);if(data.method==='ui/notifications/tool-cancelled')fail('The render request was cancelled.');});
installSizeObserver();
send('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'marshal-declarative-ui',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}}).then(()=>parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*')).catch(error=>fail(String(error&&error.message||error)));
setTimeout(()=>{if(!settled)fail('The declarative interface did not arrive from the render tool.')},15000);
})();`;

export function renderMcpAppsHtml(artifact: UiArtifact): string {
  const csp = [
    "default-src 'none'",
    `script-src '${sha256(SCRIPT)}'`,
    `style-src '${sha256(STYLE)}'`,
    "connect-src 'none'",
    'img-src data:',
    "font-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><title>${escapeHtml(artifact.document.title)}</title><style>${STYLE}</style></head><body data-artifact="${escapeAttribute(artifact.id)}" data-revision="${artifact.revision}" data-document-digest="${artifact.documentDigest}"><main class="stack vertical gap-medium">${renderNode(artifact.document.root)}</main><script>${SCRIPT}</script></body></html>`;
}

export function mcpAppsDescriptor(artifact: UiArtifact): McpAppsResourceDescriptor {
  return {
    uri: artifact.resourceUri,
    name: artifact.document.title,
    description: artifact.document.description,
    mimeType: MIME_TYPE,
    _meta: resourceMeta(artifact.resourceUri),
  };
}

export function mcpAppsContent(artifact: UiArtifact): McpAppsResourceContent {
  return {
    uri: artifact.resourceUri,
    mimeType: MIME_TYPE,
    text: renderMcpAppsHtml(artifact),
    _meta: resourceMeta(artifact.resourceUri),
  };
}

export function mcpAppsTemplateDescriptor(): McpAppsResourceDescriptor {
  return {
    uri: DECLARATIVE_UI_TEMPLATE_URI,
    name: 'Marshal declarative UI renderer',
    description:
      'Static, network-denied MCP Apps renderer for validated declarative UI artifact data.',
    mimeType: MIME_TYPE,
    _meta: resourceMeta(DECLARATIVE_UI_TEMPLATE_URI),
  };
}

export function mcpAppsTemplateContent(): McpAppsResourceContent {
  const csp = [
    "default-src 'none'",
    `script-src '${sha256(TEMPLATE_SCRIPT)}'`,
    `style-src '${sha256(STYLE)}'`,
    "connect-src 'none'",
    'img-src data:',
    "font-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    uri: DECLARATIVE_UI_TEMPLATE_URI,
    mimeType: MIME_TYPE,
    text: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><title>Declarative UI</title><style>${STYLE}</style></head><body><main id="app" class="stack vertical gap-medium"><p class="muted">Loading declarative interface…</p></main><script>${TEMPLATE_SCRIPT}</script></body></html>`,
    _meta: resourceMeta(DECLARATIVE_UI_TEMPLATE_URI),
  };
}

export function mcpAppsToolMetadata(resourceUri = DECLARATIVE_UI_TEMPLATE_URI): {
  ui: { resourceUri: string; visibility: ['model', 'app'] };
  'ui/resourceUri': string;
} {
  return { ui: { resourceUri, visibility: ['model', 'app'] }, 'ui/resourceUri': resourceUri };
}

function resourceMeta(resourceUri: string): McpAppsResourceDescriptor['_meta'] {
  return {
    ui: {
      resourceUri,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
    },
  };
}

function renderNode(node: UiNode): string {
  switch (node.type) {
    case 'stack':
      return `<section id="${id(node.id)}" class="stack ${node.direction === 'horizontal' ? 'horizontal' : 'vertical'} gap-${node.gap ?? 'medium'}">${node.children.map(renderNode).join('')}</section>`;
    case 'card':
      return `<section id="${id(node.id)}" class="card stack vertical gap-medium">${node.title ? `<h3>${escapeHtml(node.title)}</h3>` : ''}${node.children.map(renderNode).join('')}</section>`;
    case 'heading': {
      const level = node.level ?? 2;
      return `<h${level} id="${id(node.id)}">${escapeHtml(node.text)}</h${level}>`;
    }
    case 'text':
      return `<p id="${id(node.id)}" class="${tone(node.tone)}">${escapeHtml(node.text)}</p>`;
    case 'badge':
      return `<span id="${id(node.id)}" class="badge ${tone(node.tone)}">${escapeHtml(node.text)}</span>`;
    case 'button':
      return `<button id="${id(node.id)}" type="button" data-action="${escapeAttribute(node.actionId)}" class="${node.variant === 'primary' ? 'primary' : node.variant === 'danger' ? 'danger-button' : ''}">${escapeHtml(node.label)}</button>`;
    case 'input':
      return `<label for="${id(node.id)}">${escapeHtml(node.label)}<input id="${id(node.id)}" data-field="${escapeAttribute(node.name)}" type="${node.inputType ?? 'text'}" value="${escapeAttribute(scalar(node.value))}" placeholder="${escapeAttribute(node.placeholder ?? '')}"></label>`;
    case 'select':
      return `<label for="${id(node.id)}">${escapeHtml(node.label)}<select id="${id(node.id)}" data-field="${escapeAttribute(node.name)}">${node.options.map((option) => `<option value="${escapeAttribute(scalar(option.value))}" data-scalar="${escapeAttribute(JSON.stringify(option.value))}"${option.value === node.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></label>`;
    case 'progress':
      return `<label for="${id(node.id)}">${escapeHtml(node.label ?? '')}<progress id="${id(node.id)}" max="100" value="${node.value}">${node.value}%</progress></label>`;
    case 'divider':
      return `<hr id="${id(node.id)}">`;
    case 'table':
      return `<table id="${id(node.id)}"><thead><tr>${node.columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr></thead><tbody>${node.rows.map((row) => `<tr>${node.columns.map((column) => `<td>${escapeHtml(scalar(row[column.key]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
}

function sha256(value: string): string {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

function tone(value: string | undefined): string {
  return value ?? 'default';
}

function scalar(value: UiScalar | undefined): string {
  return value === undefined || value === null ? '' : String(value);
}

function id(value: string): string {
  return escapeAttribute(value);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/[\r\n]/g, ' ');
}
