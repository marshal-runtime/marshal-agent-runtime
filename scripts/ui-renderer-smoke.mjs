import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReactUiCapabilities } from '../packages/agent-runtime-ui/dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'marshal-ui-smoke-'));
await writeFile(
  join(root, 'Smoke.tsx'),
  `import {useEffect, useState} from 'react';
export default function Smoke({count = 0, marshal}: {count?: number; marshal: any}) {
  const saved = localStorage.getItem('marshal-smoke-count');
  const [visibleCount] = useState(() => saved === null ? count : Number(saved));
  useEffect(() => {
    if (saved === null) localStorage.setItem('marshal-smoke-count', String(count + 1));
    const report = (marker: string, params: unknown) => window.parent.postMessage({jsonrpc:'2.0',method:'ui/message',params:{role:'user',content:[{type:'text',text:JSON.stringify({marker,params})}]}}, '*');
    const rawBlocked = new Promise<boolean>((resolve) => {
      const id = 'marshal-malicious-raw-tool';
      const receive = (event: MessageEvent) => {
        if (event.source !== window.parent || event.data?.id !== id) return;
        window.removeEventListener('message', receive);
        resolve(Boolean(event.data.error));
      };
      window.addEventListener('message', receive);
      window.parent.postMessage({jsonrpc:'2.0',id,method:'tools/call',params:{name:'smoke.undeclared.raw',arguments:{renderId:'f'.repeat(64)}}}, '*');
    });
    Promise.all([
      marshal.callAction('acknowledge', {value: count}, {scope: 'project', idempotencyKey: 'smoke-action'}).then(value => { report('marshal/smoke-progress',{step:'action'}); return value; }),
      marshal.callHostExtension('openai', 'requestModal', [{template: 'ui://marshal/smoke-modal'}]).then(value => { report('marshal/smoke-progress',{step:'extension'}); return value; }),
      rawBlocked.then(value => { report('marshal/smoke-progress',{step:'raw-blocked'}); return value; }),
    ]).then(([action, extension, maliciousRawBlocked]) => {
      const styleReady = getComputedStyle(document.querySelector('#root > main')!).paddingTop === '24px';
      report('marshal/smoke-ready',{count: visibleCount,styleReady,actionReady:action.output?.acknowledged===true,extensionReady:extension.status==='success'&&extension.result?.opened===true,maliciousRawBlocked});
    }).catch(error => report('marshal/smoke-failed',{message:String(error?.message||error)}));
  }, [count, saved, visibleCount]);
  return <main style={{padding:24,fontFamily:'system-ui'}}><h1>Marshal bridge ready</h1><output data-count={visibleCount}>{visibleCount}</output></main>;
}`,
  'utf8',
);

const context = {
  principal: { id: 'smoke-agent', kind: 'agent' },
  scope: { workspaceId: 'smoke-workspace', projectId: 'smoke-project', sessionId: 'smoke-task' },
};
let actionInvocations = 0;
const runtime = createReactUiCapabilities({
  workspacePath: root,
  stateRoot: join(root, '.state'),
  actionRuntime: {
    authorize: { authorize: () => ({ decision: 'allow', grants: ['smoke.write'] }) },
    executor: {
      async execute(request) {
        actionInvocations += 1;
        const executionId = `smoke-action-${actionInvocations}`;
        const now = new Date().toISOString();
        return {
          protocolVersion: '1.0.0',
          status: 'success',
          result: { output: { acknowledged: true, value: request.input.value } },
          receipt: {
            protocolVersion: '1.0.0', receiptId: `receipt-${executionId}`,
            executionId, target: request.action.target.capability,
            principalId: context.principal.id,
            lineage: { rootExecutionId: executionId, depth: 0 },
            status: 'success', startedAt: now, completedAt: now, durationMs: 0,
          },
        };
      },
    },
  },
});
const compiled = await runtime.provider.invoke(
  'ui.compile',
  { entryPath: 'Smoke.tsx', title: 'Marshal renderer smoke test' },
  context,
);
const componentId = compiled.output.component.id;
const rendered = await runtime.provider.invoke(
  'ui.render',
  {
    componentId,
    props: { count: 42 },
    fallback: { summary: 'Incident INC-42 — expected count: 42; action acknowledgement available.' },
    application: {
      version: '1.0.0',
      presentationModes: ['inline', 'fullscreen', 'pip'],
      actions: [{
        id: 'acknowledge', version: '1.0.0',
        target: { kind: 'capability', capability: 'smoke.acknowledge' },
        inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { acknowledged: { type: 'boolean' }, value: { type: 'number' } }, required: ['acknowledged', 'value'], additionalProperties: false },
        allowedScopes: ['project'], requiredPermissions: ['smoke.write'], risk: 'write', idempotency: 'required',
      }],
      tools: [],
      localState: { scope: 'project', schemaVersion: '1.0.0' },
    },
  },
  context,
);
const renderId = rendered.output.render.id;
const toolResult = await runtime.resources.invokeRenderTool(
  'runtime_render_component',
  { renderId },
  context,
);
if (!toolResult) throw new Error('Stable renderer returned no result');
const payloadToolResult = await runtime.resources.invokeRenderTool(
  'marshal_get_react_payload',
  { renderId },
  context,
);
if (!payloadToolResult) throw new Error('App-only payload lookup returned no result');
const legacyPayloadToolResult = {
  ...payloadToolResult,
  structuredContent: {
    ...payloadToolResult.structuredContent,
    marshal: {
      ...payloadToolResult.structuredContent.marshal,
      componentHtml: payloadToolResult.structuredContent.marshal.componentHtml.replace(
        "style-src 'unsafe-inline'",
        "style-src 'sha256-obsolete-style-policy'",
      ),
    },
  },
};
const publicToolResult = {
  content: toolResult.content,
  structuredContent: toolResult.structuredContent,
};
const bridgeHtml = runtime.resources.templateContent().text;
const extensionBridgeHtml = bridgeHtml.replace(
  '<script>',
  `<script>window.openai={requestModal:async value=>({opened:true,template:value&&value.template})};</script><script>`,
);
const metadataToolResult = {
  ...toolResult,
  _meta: {
    marshal: {
      ...toolResult._meta.marshal,
      componentHtml:
        '<!doctype html><html><body><main>Codex metadata bridge ready</main><script>parent.postMessage({jsonrpc:"2.0",method:"ui/message",params:{content:[{type:"text",text:JSON.stringify({marker:"marshal/smoke-ready",params:{count:43,styleReady:true}})}]}},"*")</script></body></html>',
    },
  },
};
const metadataBridgeHtml = bridgeHtml.replace(
  '<script>',
  `<script>window.openai={toolResponseMetadata:{mcp_tool_result:${safeJson(metadataToolResult)}}};</script><script>`,
);

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Marshal UI smoke</title><style>body{font-family:system-ui;margin:24px}#result{font-weight:700}iframe{width:900px;max-width:100%;border:1px solid #ddd;border-radius:12px}</style></head><body><h1>Marshal UI bridge smoke test</h1><p id="result">WAITING</p><iframe id="bridge" title="Marshal compiled React bridge"></iframe><iframe id="state-bridge" title="Marshal persisted-state bridge"></iframe><iframe id="metadata-bridge" title="Marshal Codex metadata bridge"></iframe><iframe id="error-bridge" title="Marshal renderer terminal error fallback"></iframe><iframe id="hydration-bridge" title="Marshal renderer hydration fallback"></iframe><script>
const bridgeHtml=${safeJson(bridgeHtml)};
const extensionBridgeHtml=${safeJson(extensionBridgeHtml)};
const metadataBridgeHtml=${safeJson(metadataBridgeHtml)};
const renderId=${safeJson(renderId)};
const publicToolResult=${safeJson(publicToolResult)};
const payloadToolResult=${safeJson(payloadToolResult)};
const legacyPayloadToolResult=${safeJson(legacyPayloadToolResult)};
const metadataToolResult=${safeJson(metadataToolResult)};
const frame=document.getElementById('bridge');
const stateFrame=document.getElementById('state-bridge');
const metadataFrame=document.getElementById('metadata-bridge');
const errorFrame=document.getElementById('error-bridge');
const hydrationFrame=document.getElementById('hydration-bridge');
const result=document.getElementById('result');
const passed=new Set();
let hydrationStarted=0;
let directToolLeaks=0;
const progress=new Set();
const messageTrace=[];
function finish(){if(['bridge','state-bridge','metadata-bridge','error-bridge','hydration-bridge'].every(id=>passed.has(id))){result.textContent='PASS: cached-result resurrection, persisted state, Codex metadata, and bounded hydration fallbacks rendered';result.dataset.status='pass';}}
window.addEventListener('message',(event)=>{
  const target=event.source===frame.contentWindow?frame:event.source===stateFrame.contentWindow?stateFrame:event.source===metadataFrame.contentWindow?metadataFrame:event.source===errorFrame.contentWindow?errorFrame:event.source===hydrationFrame.contentWindow?hydrationFrame:null;
  if(!target)return;
  let message=event.data;
  if(!message||message.jsonrpc!=='2.0')return;
  if(message.method==='ui/message'){
    try{
      const payload=JSON.parse(message.params&&message.params.content&&message.params.content[0]&&message.params.content[0].text||'{}');
      if(typeof payload.marker==='string')message={jsonrpc:'2.0',method:payload.marker,params:payload.params};
    }catch{}
  }
  messageTrace.push(String(message.method||'response')+':'+String(message.params&&message.params.name||''));
  if(message.method==='ui/initialize'){
    target.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'smoke-host',version:'1.0.0'},hostCapabilities:{}}},'*');
    return;
  }
  if(message.method==='ui/notifications/initialized'){
    if(target===hydrationFrame)hydrationStarted=performance.now();
    const params=target===frame||target===stateFrame||target===hydrationFrame?publicToolResult:target===metadataFrame?{content:metadataToolResult.content,structuredContent:metadataToolResult.structuredContent}:{isError:true,structuredContent:{error:'Expected terminal render failure'}};
    target.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params},'*');
    return;
  }
  if(message.method==='tools/call'&&(target===frame||target===stateFrame||target===hydrationFrame)){
    if(message.params&&message.params.name==='marshal_get_react_payload'&&message.params.arguments&&message.params.arguments.renderId===renderId){
      legacyPayloadToolResult.structuredContent.marshal.storage=payloadToolResult.structuredContent.marshal.storage;
      const payload=target===hydrationFrame?{structuredContent:{fallback:publicToolResult.structuredContent.fallback}}:target===stateFrame?legacyPayloadToolResult:payloadToolResult;
      target.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result:payload},'*');
    }else if(message.params&&message.params.name==='marshal_update_react_state'&&message.params.arguments&&message.params.arguments.renderId===renderId){
      const args=message.params.arguments;
      const storage=payloadToolResult.structuredContent.marshal.storage;
      if(args.operation==='clear')for(const key of Object.keys(storage))delete storage[key];
      if(args.operation==='remove')delete storage[args.key];
      if(args.operation==='set')storage[args.key]=args.value;
      target.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'stored'}],structuredContent:{stored:true,renderId}}},'*');
      if(target===frame&&!stateFrame.srcdoc)stateFrame.srcdoc=extensionBridgeHtml;
    }else if(message.params&&message.params.name==='marshal_invoke_react_action'){
      fetch('/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message.params)}).then(response=>response.json()).then(payload=>target.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result:payload},'*')).catch(error=>target.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:String(error)}},'*'));
    }else{
      directToolLeaks+=1;
      target.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'Unexpected payload request'}},'*');
    }
    return;
  }
  if(message.method==='marshal/smoke-ready'){
    const count=message.params&&message.params.count;
    const expected=target===metadataFrame||target===stateFrame?43:42;
    if(count!==expected){result.textContent='FAIL: unexpected count '+String(count);result.dataset.status='fail';return;}
    if((target===frame||target===stateFrame)&&message.params.styleReady!==true){result.textContent='FAIL: authored styles were blocked';result.dataset.status='fail';return;}
    if((target===frame||target===stateFrame)&&message.params.actionReady!==true){result.textContent='FAIL: declared action did not complete';result.dataset.status='fail';return;}
    if((target===frame||target===stateFrame)&&message.params.extensionReady!==true){result.textContent='FAIL: feature-detected host extension did not complete';result.dataset.status='fail';return;}
    if((target===frame||target===stateFrame)&&message.params.maliciousRawBlocked!==true){result.textContent='FAIL: malicious raw tool request was not rejected';result.dataset.status='fail';return;}
    if(directToolLeaks!==0){result.textContent='FAIL: renderer forwarded an undeclared raw tool request';result.dataset.status='fail';return;}
    passed.add(target.id);
    finish();
  }
  if(message.method==='marshal/smoke-progress'&&message.params&&typeof message.params.step==='string')progress.add(message.params.step);
  if(message.method==='marshal/smoke-failed'){
    result.textContent='FAIL: component '+String(message.params&&message.params.message||'unknown error');
    result.dataset.status='fail';
  }
});
frame.srcdoc=extensionBridgeHtml;
metadataFrame.srcdoc=metadataBridgeHtml;
errorFrame.srcdoc=bridgeHtml;
hydrationFrame.srcdoc=bridgeHtml;
const fallbackCheck=setInterval(()=>{
  for(const target of [errorFrame,hydrationFrame]){
    if(passed.has(target.id))continue;
    const status=target.contentDocument&&target.contentDocument.getElementById('status');
    if(!status||!status.classList.contains('error'))continue;
    const elapsed=target===hydrationFrame?performance.now()-hydrationStarted:0;
    const expected=target===hydrationFrame?'Incident INC-42':'Expected terminal render failure';
    if(!status.textContent.includes(expected)){clearInterval(fallbackCheck);result.textContent='FAIL: fallback omitted '+expected;result.dataset.status='fail';return;}
    if(target===hydrationFrame&&elapsed>=5000){clearInterval(fallbackCheck);result.textContent='FAIL: hydration fallback exceeded five seconds ('+Math.round(elapsed)+' ms)';result.dataset.status='fail';return;}
    passed.add(target.id);
    finish();
  }
  if(result.dataset.status)clearInterval(fallbackCheck);
},50);
setTimeout(()=>{if(!result.dataset.status){result.textContent='FAIL: renderer timed out; passed='+[...passed].sort().join(',')+'; progress='+[...progress].sort().join(',')+'; directToolLeaks='+directToolLeaks+'; trace='+messageTrace.slice(-20).join('|');result.dataset.status='fail';}},10000);
</script></body></html>`;

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/tool') {
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 1_000_000) throw new Error('Tool request exceeded one megabyte');
      }
      const called = JSON.parse(raw);
      const result = await runtime.resources.invokeRenderTool(called.name, called.arguments, context);
      if (!result) throw new Error('Unknown app tool');
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ isError: true, structuredContent: { error: String(error?.message || error) } }));
    }
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(page);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Smoke server has no TCP address');
console.log(`SMOKE_URL http://127.0.0.1:${address.port}/`);

async function close() {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
process.once('SIGINT', () => void close().then(() => process.exit(0)));
process.once('SIGTERM', () => void close().then(() => process.exit(0)));

function safeJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
