#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST_NAME = 'Marshal Standards MCP Apps Host';
const HOST_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-01-26';
const MAX_BODY_BYTES = 1_000_000;
const CAPABILITY_HEADER = 'x-marshal-host-capability';
const exampleRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(exampleRoot, '..', '..');

export const STANDARDS_HOST_APPLICATION = Object.freeze({
  version: '1.0.0',
  presentationModes: ['inline', 'fullscreen', 'pip'],
  actions: [
    {
      id: 'save-selection',
      version: '1.0.0',
      title: 'Save selected direction',
      target: { kind: 'capability', capability: 'standards-host.selection.save' },
      inputSchema: {
        type: 'object',
        properties: { selection: { type: 'string', minLength: 1, maxLength: 120 } },
        required: ['selection'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          saved: { type: 'boolean' },
          selection: { type: 'string' },
          revision: { type: 'integer', minimum: 1 },
        },
        required: ['saved', 'selection', 'revision'],
        additionalProperties: false,
      },
      allowedScopes: ['project'],
      requiredPermissions: ['standards-host.selection.write'],
      risk: 'write',
      idempotency: 'required',
    },
    {
      id: 'reopen-selection',
      version: '1.0.0',
      title: 'Reopen saved selection',
      target: { kind: 'capability', capability: 'standards-host.selection.reopen' },
      inputSchema: {
        type: 'object',
        properties: { resourceId: { type: 'string', const: 'standards-host-selection' } },
        required: ['resourceId'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          selection: { type: 'string' },
          revision: { type: 'integer', minimum: 0 },
        },
        required: ['found', 'selection', 'revision'],
        additionalProperties: false,
      },
      allowedScopes: ['project'],
      requiredPermissions: ['standards-host.selection.read'],
      risk: 'read',
      idempotency: 'none',
    },
  ],
  tools: [
    {
      id: 'read-selection',
      name: 'standards-host.selection.read',
      inputSchema: {
        type: 'object',
        properties: { resourceId: { type: 'string', const: 'standards-host-selection' } },
        required: ['resourceId'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          selection: { type: 'string' },
          revision: { type: 'integer', minimum: 0 },
        },
        required: ['selection', 'revision'],
        additionalProperties: false,
      },
    },
  ],
  localState: { scope: 'project', schemaVersion: '1.0.0' },
  authoritativeState: {
    capability: 'standards-host.selection.read',
    resourceId: 'standards-host-selection',
    version: '1.0.0',
  },
  authoringProfile: { id: 'marshal-standards', version: '1.0.0' },
});

export const STANDARDS_HOST_FALLBACK = Object.freeze({
  summary: 'The portable review workspace is available as text when an MCP Apps surface cannot render it.',
  details: {
    selectedDirection: 'Direction A until changed by the declared save-selection action.',
    availableActions: ['Save Direction B', 'Reopen saved selection'],
    presentation: 'Inline remains usable; fullscreen is host-controlled; picture-in-picture may be unsupported.',
    recovery: 'Reopen the same render ID to restore authoritative selection state without recompiling.',
  },
});

export async function createStandardsMcpAppsHost(options) {
  const stateRoot = requiredAbsolute(options?.stateRoot, 'stateRoot');
  const port = optionalPort(options?.port);
  const packageRoot = resolvePackageRoot(options?.deployment);
  const uiEntry = join(packageRoot, 'dist', 'index.js');
  const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const { createReactUiCapabilities } = await import(pathToFileURL(uiEntry).href);
  const workspacePath = join(stateRoot, 'workspace');
  const runtimeStateRoot = join(stateRoot, 'runtime');
  const evidenceRoot = join(stateRoot, 'evidence');
  const pointerPath = join(stateRoot, 'render-pointer.json');
  const authoritativePath = join(stateRoot, 'authoritative-selection.json');
  const eventsPath = join(evidenceRoot, 'trace.jsonl');
  const receiptsPath = join(evidenceRoot, 'receipts.jsonl');
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(runtimeStateRoot, { recursive: true }),
    mkdir(evidenceRoot, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(join(exampleRoot, 'StandardsHostApp.tsx'), join(workspacePath, 'StandardsHostApp.tsx')),
    copyFile(join(exampleRoot, 'standards-host.css'), join(workspacePath, 'standards-host.css')),
  ]);

  const sourceDigest = await digestFiles([
    join(workspacePath, 'StandardsHostApp.tsx'),
    join(workspacePath, 'standards-host.css'),
  ]);
  const context = invocationContext();
  let sequence = 0;
  let compileInvocations = 0;
  let renderInvocations = 0;
  let actionInvocations = 0;
  let toolInvocations = 0;
  let runtime;

  runtime = createReactUiCapabilities({
    workspacePath,
    stateRoot: runtimeStateRoot,
    hostCapabilities: { serverTools: true, serverResources: true, logging: true },
    actionRuntime: {
      authorize: {
        authorize(request, invocation) {
          const decision = {
            decision: 'allow',
            grants: [...request.action.requiredPermissions],
            reason: `${HOST_NAME} grants only the immutable application declaration.`,
          };
          void event('permission', {
            renderId: request.renderId,
            actionId: request.action.id,
            principalId: invocation.principal.id,
            scope: request.scope,
            requiredPermissions: request.action.requiredPermissions,
            decision,
          });
          return decision;
        },
      },
      executor: {
        async execute(request, invocation) {
          actionInvocations += 1;
          const input = asRecord(request.input);
          const current = await readAuthoritative(authoritativePath);
          if (request.action.id === 'reopen-selection') {
            if (input.resourceId !== 'standards-host-selection') {
              return failedRuntimeResponse(
                request.action.target.capability,
                invocation,
                ++sequence,
                'unknown_resource',
                'Unknown standards-host selection resource.',
              );
            }
            const execution = runtimeResponse(
              request.action.target.capability,
              { found: current.revision > 0, selection: current.selection, revision: current.revision },
              invocation,
              ++sequence,
            );
            await receipt(execution.receipt, { kind: 'action-target', actionId: request.action.id });
            return execution;
          }
          const next = {
            selection: requiredText(input.selection, 'selection'),
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
          };
          await atomicJson(authoritativePath, next);
          const execution = runtimeResponse(
            request.action.target.capability,
            { saved: true, selection: next.selection, revision: next.revision },
            invocation,
            ++sequence,
          );
          await receipt(execution.receipt, { kind: 'action-target', actionId: request.action.id });
          return execution;
        },
      },
      receiptId: () => `standards-host-action-${++sequence}`,
    },
    toolRuntime: {
      async execute(tool, input, invocation) {
        toolInvocations += 1;
        const request = asRecord(input);
        if (tool.name !== 'standards-host.selection.read'
          || request.resourceId !== 'standards-host-selection') {
          return failedRuntimeResponse(tool.name, invocation, ++sequence, 'unknown_tool', 'Unknown standards-host resource.');
        }
        const current = await readAuthoritative(authoritativePath);
        const execution = runtimeResponse(
          tool.name,
          { selection: current.selection, revision: current.revision },
          invocation,
          ++sequence,
        );
        await receipt(execution.receipt, { kind: 'declared-tool', toolId: tool.id });
        return execution;
      },
    },
  });

  let pointer = await readJson(pointerPath);
  let startup = 'reopened';
  if (!pointer) {
    startup = 'provisioned';
    compileInvocations += 1;
    const compiled = await runtime.provider.invoke('ui.compile', {
      entryPath: 'StandardsHostApp.tsx',
      title: 'Standards-only portable review workspace',
      authoringProfile: { id: 'marshal-standards', version: '1.0.0' },
    }, context);
    const component = asRecord(asRecord(compiled.output).component);
    if (typeof component.id !== 'string') {
      throw new Error(`Standards host compilation failed: ${JSON.stringify(compiled)}`);
    }
    renderInvocations += 1;
    const rendered = await runtime.provider.invoke('ui.render', {
      componentId: requiredText(component.id, 'component.id'),
      props: { title: 'Portable product review', initialSelection: 'Direction A' },
      fallback: STANDARDS_HOST_FALLBACK,
      application: STANDARDS_HOST_APPLICATION,
    }, context);
    const render = asRecord(asRecord(rendered.output).render);
    if (typeof render.id !== 'string') {
      throw new Error(`Standards host render failed: ${JSON.stringify(rendered)}`);
    }
    pointer = {
      schemaVersion: '1.0.0',
      renderId: requiredText(render.id, 'render.id'),
      componentId: requiredText(render.componentId, 'render.componentId'),
      sourceDigest,
      createdAt: new Date().toISOString(),
    };
    await atomicJson(pointerPath, pointer);
  } else if (pointer.sourceDigest !== sourceDigest) {
    throw new Error('Standards host source changed for an existing state root; use a new state root instead of rewriting historical evidence.');
  }

  const toolResult = await runtime.resources.invokeRenderTool(
    'runtime_render_component',
    { renderId: pointer.renderId },
    context,
  );
  if (!toolResult) throw new Error('The stable renderer did not reopen the standards-host render.');
  const publicToolResult = {
    content: toolResult.content,
    structuredContent: toolResult.structuredContent,
  };
  const bridgeHtml = runtime.resources.templateContent().text;
  const capabilityToken = randomBytes(32).toString('base64url');
  const page = hostPage({
    bridgeHtml,
    publicToolResult,
    renderId: pointer.renderId,
    fallback: STANDARDS_HOST_FALLBACK,
    capabilityToken,
  });

  await event('host-started', {
    host: { name: HOST_NAME, version: HOST_VERSION },
    protocolVersion: PROTOCOL_VERSION,
    package: { name: packageManifest.name, version: packageManifest.version, root: packageRoot },
    startup,
    renderId: pointer.renderId,
    sourceDigest,
  });

  let serverOrigin;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/') return html(response, page);
      if (request.method === 'GET' && request.url === '/status') {
        return json(response, await snapshot());
      }
      if (request.method === 'GET' && request.url === '/application') {
        return json(response, STANDARDS_HOST_APPLICATION);
      }
      if (request.method === 'GET' && request.url === '/fallback') {
        return json(response, STANDARDS_HOST_FALLBACK);
      }
      if (request.method === 'POST' && request.url === '/event') {
        assertTrustedMutation(request, serverOrigin, capabilityToken);
        const body = await jsonBody(request);
        await event(requiredText(body.type, 'event.type'), asRecord(body.payload));
        return json(response, { accepted: true });
      }
      if (request.method === 'POST' && request.url === '/tool') {
        assertTrustedMutation(request, serverOrigin, capabilityToken);
        const body = await jsonBody(request);
        const name = requiredText(body.name, 'tool.name');
        const arguments_ = asRecord(body.arguments);
        const result = await runtime.resources.invokeRenderTool(name, arguments_, context);
        if (!result) return json(response, { error: 'Unknown app-visible tool.' }, 404);
        await event('tool-call', {
          name,
          renderId: pointer.renderId,
          status: asRecord(result.structuredContent).status ?? (result.isError ? 'failed' : 'success'),
        });
        const actionReceipt = asRecord(asRecord(result.structuredContent).receipt);
        if (typeof actionReceipt.receiptId === 'string') {
          await receipt(actionReceipt, { kind: 'application-dispatch', toolName: name });
        }
        return json(response, result);
      }
      return json(response, { error: 'Not found.' }, 404);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        await event('host-error', { message: error instanceof Error ? error.message : String(error) });
      }
      return json(response, { error: error instanceof Error ? error.message : String(error) }, error?.statusCode ?? 400);
    }
  });

  await new Promise((fulfill, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', fulfill);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Standards host did not obtain a TCP address.');
  serverOrigin = `http://127.0.0.1:${address.port}`;

  return {
    url: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    renderId: pointer.renderId,
    stateRoot,
    evidenceRoot,
    packageRoot,
    startup,
    async snapshot() {
      return snapshot();
    },
    async close() {
      await event('host-stopped', { renderId: pointer.renderId });
      await new Promise((fulfill) => server.close(fulfill));
    },
  };

  async function snapshot() {
    const authoritative = await readAuthoritative(authoritativePath);
    const events = await lines(eventsPath);
    const receipts = await lines(receiptsPath);
    return {
      schemaVersion: '1.0.0',
      host: { name: HOST_NAME, version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION },
      runtimePackage: { name: packageManifest.name, version: packageManifest.version, root: packageRoot },
      startup,
      renderId: pointer.renderId,
      componentId: pointer.componentId,
      sourceDigest,
      authoritative,
      counters: { compileInvocations, renderInvocations, actionInvocations, toolInvocations },
      eventCount: events.length,
      receiptCount: receipts.length,
      paths: { eventsPath, receiptsPath, pointerPath, authoritativePath },
    };
  }

  async function event(type, payload) {
    const item = {
      schemaVersion: '1.0.0',
      sequence: ++sequence,
      at: new Date().toISOString(),
      type,
      payload,
    };
    await appendFile(eventsPath, `${JSON.stringify(item)}\n`, 'utf8');
    return item;
  }

  async function receipt(value, provenance) {
    await appendFile(receiptsPath, `${JSON.stringify({ ...value, provenance })}\n`, 'utf8');
  }
}

function hostPage({ bridgeHtml, publicToolResult, renderId, fallback, capabilityToken }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${HOST_NAME}</title><style>
  :root{font-family:ui-sans-serif,system-ui,sans-serif;color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:#f3f2f8;color:#17161d}body.dark{background:#14131a;color:#f5f3ff}.host-shell{max-width:1160px;margin:auto;padding:18px}.host-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.host-bar h1{font-size:1rem;margin-right:auto}.host-bar button{border:1px solid #c8c4d7;border-radius:999px;background:white;color:#17161d;padding:8px 12px;cursor:pointer}.frame-shell{margin-top:14px;border:1px solid #c8c4d7;border-radius:18px;overflow:hidden;background:white;min-height:470px;transition:.2s ease}.frame-shell.fullscreen{position:fixed;inset:12px;z-index:10;margin:0;max-width:none;box-shadow:0 24px 80px #0008}.frame-shell.compact{max-width:420px}.frame-shell iframe{width:100%;height:620px;border:0;display:block}.frame-shell.compact iframe{height:560px}.host-meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}.host-meta pre{white-space:pre-wrap;background:#fff;border:1px solid #ddd;border-radius:14px;padding:12px;color:#24212b}.dark .host-meta pre{background:#201e28;color:#faf8ff;border-color:#413d50}#fallback-frame{display:none;width:100%;height:220px;border:1px solid #cc5b5b;border-radius:14px;margin-top:14px}.shown{display:block!important;position:fixed;inset:80px 30px auto;z-index:20;width:calc(100% - 60px)!important;height:240px!important;margin:0!important;background:#fff;box-shadow:0 24px 80px #0009}
  </style></head><body><main class="host-shell"><nav class="host-bar"><h1>${HOST_NAME}</h1><button id="host-theme" type="button">Toggle theme</button><button id="host-resize" type="button">Toggle compact + safe area</button><button id="host-remount" type="button">Remount render</button><button id="host-hydration" type="button">Test hydration fallback</button></nav><section id="frame-shell" class="frame-shell"><iframe id="app-frame" title="Portable MCP App"></iframe></section><iframe id="fallback-frame" title="Hydration fallback proof"></iframe><section class="host-meta"><pre id="host-status">starting</pre><pre id="text-fallback">${escapeHtml(JSON.stringify(fallback, null, 2))}</pre></section></main><script>
  const bridgeHtml=${safeJson(bridgeHtml)};const publicToolResult=${safeJson(publicToolResult)};const renderId=${safeJson(renderId)};const fallback=${safeJson(fallback)};const capabilityToken=${safeJson(capabilityToken)};
  const frameShell=document.getElementById('frame-shell'),status=document.getElementById('host-status');let frame=document.getElementById('app-frame'),fallbackFrame=document.getElementById('fallback-frame');let theme='light',compact=false,mode='inline';const sessions=new Map();
  function context(){return{theme,locale:'en-US',timezone:'UTC',platform:'standards-browser',displayMode:mode,availableDisplayModes:['inline','fullscreen'],containerDimensions:{width:compact?390:1080,height:compact?560:620,maxWidth:1160,maxHeight:900},safeAreaInsets:compact?{top:12,right:8,bottom:20,left:8}:{top:0,right:0,bottom:0,left:0},styles:{variables:{'--color-text-primary':theme==='dark'?'#f5f3ff':'#17161d'}}};}
  function protectedHeaders(){return{'content-type':'application/json',[${safeJson(CAPABILITY_HEADER)}]:capabilityToken};}
  function record(type,payload={}){status.textContent=type+'\\n'+JSON.stringify(payload,null,2);return fetch('/event',{method:'POST',headers:protectedHeaders(),body:JSON.stringify({type,payload})}).catch(()=>{});}
  function send(target,message){target.contentWindow&&target.contentWindow.postMessage(message,'*');}
  function mount(target,kind){sessions.set(target,{kind,initializedAt:0,hydrationStartedAt:0});target.srcdoc=bridgeHtml;record(kind==='app'?'inline-mounted':'hydration-probe-mounted',{renderId});}
  function notifyContext(){const value=context();send(frame,{jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:value});record('host-context-changed',value);}
  window.addEventListener('message',async event=>{const target=[frame,fallbackFrame].find(candidate=>event.source===candidate.contentWindow);if(!target)return;const message=event.data;if(!message||message.jsonrpc!=='2.0')return;const session=sessions.get(target);if(!session)return;
    if(message.method==='ui/initialize'){session.initializedAt=performance.now();send(target,{jsonrpc:'2.0',id:message.id,result:{protocolVersion:${safeJson(PROTOCOL_VERSION)},hostInfo:{name:${safeJson(HOST_NAME)},version:${safeJson(HOST_VERSION)}},hostCapabilities:{serverTools:true,serverResources:true,logging:true},hostContext:context()}});return;}
    if(message.method==='ui/notifications/initialized'){session.hydrationStartedAt=performance.now();send(target,{jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{renderId}});send(target,{jsonrpc:'2.0',method:'ui/notifications/tool-result',params:publicToolResult});record('app-initialized',{kind:session.kind,renderId});return;}
    if(message.method==='tools/call'){
      if(session.kind==='fallback'&&message.params&&message.params.name==='marshal_get_react_payload'){send(target,{jsonrpc:'2.0',id:message.id,result:{structuredContent:{fallback}}});return;}
      try{const response=await fetch('/tool',{method:'POST',headers:protectedHeaders(),body:JSON.stringify(message.params)});const result=await response.json();if(!response.ok)throw new Error(result.error||'tool failed');send(target,{jsonrpc:'2.0',id:message.id,result});record('browser-tool-result',{name:message.params&&message.params.name,status:result.structuredContent&&result.structuredContent.status||'success'});}catch(error){send(target,{jsonrpc:'2.0',id:message.id,error:{code:-32603,message:String(error&&error.message||error)}});}return;
    }
    if(message.method==='ui/request-display-mode'){
      const requested=message.params&&message.params.mode;if(requested==='fullscreen'){mode='fullscreen';compact=false;frameShell.classList.remove('compact');frameShell.classList.add('fullscreen');send(target,{jsonrpc:'2.0',id:message.id,result:{mode}});notifyContext();record('display-mode',{requested,status:'granted',actual:mode});return;}send(target,{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'The standards host does not support '+String(requested)}});record('display-mode',{requested,status:'unsupported',actual:mode});return;
    }
    if(message.method==='ui/notifications/size-changed'){if(target===frame){frameShell.dataset.reportedHeight=String(message.params&&message.params.height||'');frameShell.dataset.reportedWidth=String(message.params&&message.params.width||'');}record('app-size',message.params||{});return;}
    if(message.id!==undefined)send(target,{jsonrpc:'2.0',id:message.id,result:{}});
  });
  document.getElementById('host-theme').addEventListener('click',()=>{theme=theme==='light'?'dark':'light';document.body.classList.toggle('dark',theme==='dark');notifyContext();});
  document.getElementById('host-resize').addEventListener('click',()=>{compact=!compact;frameShell.classList.toggle('compact',compact);notifyContext();});
  document.getElementById('host-remount').addEventListener('click',()=>{const replacement=document.createElement('iframe');replacement.id='app-frame';replacement.title='Portable MCP App';frame.replaceWith(replacement);sessions.delete(frame);frame=replacement;mount(frame,'app');record('render-remounted',{renderId});});
  document.getElementById('host-hydration').addEventListener('click',()=>{fallbackFrame.classList.add('shown');mount(fallbackFrame,'fallback');});
  mount(frame,'app');
  </script></body></html>`;
}

function invocationContext() {
  return {
    principal: { id: 'standards-host-agent', kind: 'agent' },
    identity: {
      harnessId: 'marshal-standards-mcp-apps-host',
      installationId: 'standards-host-installation',
      profileId: 'standards-host-profile',
      agentId: 'standards-host-agent',
    },
    scope: {
      workspaceId: 'standards-host-workspace',
      projectId: 'standards-host-project',
      sessionId: 'standards-host-session',
    },
  };
}

function runtimeResponse(target, output, context, sequence) {
  const now = new Date().toISOString();
  const executionId = `standards-host-execution-${sequence}`;
  return {
    protocolVersion: '1.0.0',
    status: 'success',
    result: { output },
    receipt: {
      protocolVersion: '1.0.0',
      receiptId: `standards-host-target-receipt-${sequence}`,
      executionId,
      target,
      principalId: context.principal.id,
      scope: context.scope,
      lineage: { rootExecutionId: executionId, depth: 0 },
      status: 'success',
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    },
  };
}

function failedRuntimeResponse(target, context, sequence, code, message) {
  const response = runtimeResponse(target, undefined, context, sequence);
  return { ...response, status: 'failed', result: undefined, error: { code, message } };
}

async function readAuthoritative(path) {
  return await readJson(path) ?? { selection: 'Direction A', revision: 0, updatedAt: null };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function lines(path) {
  try {
    return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function digestFiles(paths) {
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const info = await stat(path);
    hash.update(`${path.split(/[\\/]/).pop()}\0${info.size}\0`);
    hash.update(await readFile(path));
  }
  return hash.digest('hex');
}

async function jsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('Request body exceeds one megabyte.');
  }
  return asRecord(JSON.parse(body || '{}'));
}

function assertTrustedMutation(request, expectedOrigin, capabilityToken) {
  if (request.headers.origin !== expectedOrigin) {
    throw new HttpError(403, 'Mutation origin is not the active standards host.');
  }
  if (request.headers['sec-fetch-site'] !== undefined
    && request.headers['sec-fetch-site'] !== 'same-origin') {
    throw new HttpError(403, 'Cross-site mutation requests are forbidden.');
  }
  if (request.headers['content-type']?.toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Mutation requests require Content-Type application/json.');
  }
  const supplied = request.headers[CAPABILITY_HEADER];
  if (typeof supplied !== 'string' || !constantTimeEqual(supplied, capabilityToken)) {
    throw new HttpError(403, 'Mutation capability token is missing or invalid.');
  }
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function html(response, value) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(value);
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(value)}\n`);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required.`);
  return value;
}

function requiredAbsolute(value, field) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${field} must be an absolute path.`);
  return resolve(value);
}

function optionalPort(value) {
  if (value === undefined) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('port must be from 0 through 65535.');
  return port;
}

function resolvePackageRoot(deployment) {
  if (deployment === undefined) return resolve(repositoryRoot, 'packages', 'agent-runtime-ui');
  return requiredAbsolute(deployment, 'deployment');
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument ${argument}.`);
    const key = argument.slice(2);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    result[key] = value;
    index += 1;
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const host = await createStandardsMcpAppsHost({
      stateRoot: args['state-root'],
      ...(args.deployment ? { deployment: args.deployment } : {}),
      ...(args.port ? { port: args.port } : {}),
    });
    process.stdout.write(`STANDARDS_HOST_READY ${JSON.stringify({
      url: host.url,
      port: host.port,
      renderId: host.renderId,
      stateRoot: host.stateRoot,
      evidenceRoot: host.evidenceRoot,
      packageRoot: host.packageRoot,
      startup: host.startup,
    })}\n`);
    const close = async () => {
      await host.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
