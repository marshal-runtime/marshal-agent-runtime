import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { assertAdapterConformance, createComposerConformanceFixture } from '@marshal/agent-runtime-conformance';
import { createRuntimeMcpServer, createRuntimeToolAdapter } from '../dist/mcp.js';

const fixture = createComposerConformanceFixture();
const primary = fixture.manifest.primaryContext;
const opened = [];
after(async () => { for (const close of opened.reverse()) await close(); });

test('shared structural conformance through the production dispatcher', async () => {
  await assertAdapterConformance({
    name: 'neutral-runtime-tools', manifest: fixture.manifest,
    async create(caseName) {
      const env = await fixture.create(caseName);
      const dispatches = {};
      const adapters = new Map();
      const adapterFor = (context) => {
        const key = JSON.stringify(context.scope);
        if (!adapters.has(key)) adapters.set(key, createRuntimeToolAdapter({
          context: { sessionId: context.scope.sessionId },
          kernel: {
            search: (request, call) => env.port.search(request, { ...context, signal: call.signal }),
            execute: (request, call) => {
              dispatches.runtime_exec = (dispatches.runtime_exec ?? 0) + 1;
              return env.port.execute(request, { ...context, signal: call.signal });
            },
          },
          lifecycle: {
            startSession: (request) => env.port.lifecycle.start(request, context),
            observeTurn: (request) => env.port.lifecycle.observe(request, context),
            endSession: (request) => env.port.lifecycle.end(request, context),
          },
          resources: {
            listResources: async () => [],
            readResource: async (uri) => ({ uri, text: '' }),
            listTools: async () => [{ name: 'runtime_exec', inputSchema: { type: 'object' } }],
            callTool: (name, input) => env.port.callTool(name, input, context),
          },
        }));
        return adapters.get(key);
      };
      const call = async (name, input, context) => adapterFor(context).callTool(name, input, context.signal);
      return {
        port: {
          search: async (request, context) => (await call('runtime_search', request, context)).structuredContent,
          execute: async (request, context) => (await call('runtime_exec', request, context)).structuredContent,
          callTool: async (name, input, context) => {
            const result = await call(name, input, context);
            return result.structuredContent ?? result;
          },
          lifecycle: {
            start: (request, context) => adapterFor(context).lifecycle.startSession(request),
            observe: (request, context) => adapterFor(context).lifecycle.observeTurn(request),
            end: (request, context) => adapterFor(context).lifecycle.endSession(request),
          },
          createCancellation() { const controller = new AbortController(); return { signal: controller.signal, abort: (reason) => controller.abort(reason) }; },
        },
        inspect: () => ({ ...env.inspect(), runtimeToolFallbacks: { ...dispatches } }),
        dispose: () => env.dispose(),
      };
    },
  });
});

async function connect() {
  const env = await fixture.create('operation-execution');
  const server = createRuntimeMcpServer({
    context: { sessionId: primary.scope.sessionId },
    kernel: {
      search: (request, context) => env.port.search(request, {
        ...primary, scope: { ...primary.scope, sessionId: context.sessionId }, signal: context.signal,
      }),
      execute: (request, context) => env.port.execute(request, {
        ...primary, scope: { ...primary.scope, sessionId: context.sessionId }, signal: context.signal,
      }),
    },
  });
  const client = new Client({ name: 'generic-host-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  opened.push(async () => { await client.close(); await server.close(); await env.dispose(); });
  return { client, env };
}

test('startup inventory and exact discovery preserve canonical schemas', async () => {
  const { client } = await connect();
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['runtime_search', 'runtime_exec']);
  const result = await client.callTool({ name: 'runtime_search', arguments: { name: fixture.manifest.capabilities.echo } });
  assert.equal(result.structuredContent.detail, 'full');
  assert.ok(result.structuredContent.matches[0].capability.inputSchema);
});

for (const [capability, status] of [['echo', 'success'], ['denied', 'denied'], ['approval', 'approval_required']]) {
  test(`real kernel ${status} results retain their envelopes and receipts`, async () => {
    const { client, env } = await connect();
    const result = await client.callTool({ name: 'runtime_exec', arguments: {
      targetType: 'operation', target: fixture.manifest.capabilities[capability], input: { value: 'kept' },
    } });
    assert.equal(result.structuredContent.status, status);
    assert.ok(result.structuredContent.receipt.receiptId);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(Boolean(result.isError), status !== 'success');
    if (status !== 'success') assert.equal(env.inspect().capabilityInvocations[fixture.manifest.capabilities[capability]] ?? 0, 0);
  });
}

test('model cannot replace trusted session or use compatibility aliases', async () => {
  const { client, env } = await connect();
  for (const args of [
    { targetType: 'operation', target: fixture.manifest.capabilities.echo, context: { sessionId: 'forged' } },
    { operation: fixture.manifest.capabilities.echo },
    { target: fixture.manifest.capabilities.echo },
  ]) {
    await assert.rejects(client.callTool({ name: 'runtime_exec', arguments: args }));
  }
  assert.deepEqual(env.inspect().capabilityInvocations, {});
});

test('unknown tools cannot dispatch to the kernel', async () => {
  const { client, env } = await connect();
  await assert.rejects(client.callTool({ name: 'forged_tool', arguments: {} }));
  assert.deepEqual(env.inspect().capabilityInvocations, {});
});

test('client cancellation reaches the in-flight host invocation', async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let observed;
  const aborted = new Promise((resolve) => { observed = resolve; });
  const server = createRuntimeMcpServer({ context: { sessionId: 'cancellation-test' }, kernel: {
    search: async () => { throw new Error('unused'); },
    execute: async (_request, context) => {
      started();
      await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
      observed();
      return { status: 'cancelled' };
    },
  } });
  const client = new Client({ name: 'cancel-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  opened.push(async () => { await client.close(); await server.close(); });
  const controller = new AbortController();
  const call = client.callTool({ name: 'runtime_exec', arguments: { targetType: 'operation', target: 'test.wait' } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(call);
  await ready;
  controller.abort();
  await Promise.all([rejected, aborted]);
});

test('neutral entrypoint executes brokered TypeScript over stdio', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'marshal-neutral-mcp-')));
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [new URL('../dist/mcp-cli.js', import.meta.url).pathname],
    env: { ...process.env, MARSHAL_RUNTIME_MCP_CONFIG: JSON.stringify({
      workspacePath, privateRoot: join(root, 'private'), principalId: 'test-owner',
      harnessId: 'generic-test', sessionId: 'session-a', codeIntelligence: false,
      permissionPatterns: ['runtime.inline_module.execute'],
    }) },
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'runtime_exec', arguments: {
      targetType: 'inline_module', source: 'export default (input) => ({ value: input.value + 1 })', input: { value: 6 },
    } });
    assert.equal(result.structuredContent.status, 'success', JSON.stringify(result.structuredContent));
    assert.ok(result.structuredContent.receipt.receiptId);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a bootstrap module permission approval asks once and runs the approved retry', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'marshal-approval-mcp-')));
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const bootstrapModule = join(root, 'bootstrap.mjs');
  await writeFile(bootstrapModule, `
    let issued;
    let count = 0;
    export function bootstrap() {
      return { permissionApproval: {
        requestApproval(check, missing) {
          count += 1;
          issued = 'approval-' + count;
          return { reason: 'needs a person', approvalId: issued, prompt: 'Approve once', expiresAt: new Date(Date.now() + 60000).toISOString() };
        },
        async verifyApproval(approval, check) {
          const approved = issued !== undefined && approval.approvalId === issued;
          issued = undefined;
          return approved ? { approved: true, permissions: check.requirements.map((item) => item.permission) } : { approved: false, reason: 'unknown approval' };
        },
      } };
    }
  `);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [new URL('../dist/mcp-cli.js', import.meta.url).pathname],
    env: { ...process.env, MARSHAL_RUNTIME_MCP_CONFIG: JSON.stringify({
      workspacePath, privateRoot: join(root, 'private'), principalId: 'test-owner',
      harnessId: 'generic-test', sessionId: 'session-a', codeIntelligence: false,
      permissionPatterns: [], bootstrapModule,
    }) },
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const call = (extra) => client.callTool({ name: 'runtime_exec', arguments: {
    targetType: 'inline_module', source: 'export default (input) => ({ value: input.value + 1 })', input: { value: 6 },
    requestId: 'request-1', ...extra,
  } });
  try {
    await client.connect(transport);
    const asked = await call({});
    assert.equal(asked.structuredContent.status, 'approval_required', JSON.stringify(asked.structuredContent));
    assert.equal(asked.structuredContent.approval.approvalId, 'approval-1');
    const ran = await call({ approval: { approvalId: 'approval-1' } });
    assert.equal(ran.structuredContent.status, 'success', JSON.stringify(ran.structuredContent));
    const replayed = await call({ requestId: 'request-2', approval: { approvalId: 'approval-1' } });
    assert.notEqual(replayed.structuredContent.status, 'success');
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
