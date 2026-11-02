import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  buildRuntimeReceiptForest,
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityProvider,
} from '@marshal/agent-runtime-core';
import { createAgentRuntime } from '@marshal/agent-runtime-host';
import { MARSHAL_SELECTION_PREAMBLE } from '@marshal/agent-runtime-manifest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rewriteMarshalPreToolUse } from '../hooks.js';
import { CODEX_MCP_INSTRUCTIONS, createCodexMcpServer } from '../server.js';
import type {
  RuntimeCallContext,
  RuntimeKernelPort,
  RuntimeSearchRequest,
} from '../ports.js';
import {
  InMemoryLifecycle,
  InMemoryRuntimeKernel,
  type InMemoryRuntimeProvider,
} from '../testing/inMemoryRuntime.js';

describe('Codex runtime MCP adapter', () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it('begins server instructions with the portable natural-routing contract', () => {
    expect(CODEX_MCP_INSTRUCTIONS.startsWith(MARSHAL_SELECTION_PREAMBLE)).toBe(true);
    expect(CODEX_MCP_INSTRUCTIONS.slice(0, 512)).toContain(
      'Marshal—not generic visualization—owns',
    );
    expect(CODEX_MCP_INSTRUCTIONS.slice(0, 512)).toContain(
      'stable preferences',
    );
    expect(CODEX_MCP_INSTRUCTIONS.slice(0, 512)).toContain('even without “remember”');
    expect(CODEX_MCP_INSTRUCTIONS).toContain('additive `discoveries`');
    expect(CODEX_MCP_INSTRUCTIONS).toContain('exact `catalogId`');
    expect(CODEX_MCP_INSTRUCTIONS).not.toMatch(/capability[- ]only/i);
  });

  it('exposes the stable command and lifecycle tool surface', async () => {
    const { client } = await connectTestRuntime();
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'runtime_search',
      'runtime_exec',
      'runtime_session_start',
      'runtime_observe_turn',
      'runtime_session_end',
    ]);
    const exec = tools.tools.find((tool) => tool.name === 'runtime_exec');
    expect(exec?.description).toContain('workspace file');
    expect(exec?.description).toContain('targetType:"module"');
    expect(exec?.description).toContain('Deprecated compatibility forms');
    expect(JSON.stringify(exec?.inputSchema)).toContain('workspace_file');
    expect(JSON.stringify(exec?.inputSchema)).not.toMatch(/workflow|stage|lambda/);
    expect(exec?.inputSchema).toMatchObject({
      additionalProperties: false,
      oneOf: [
        { required: ['targetType', 'target'] },
        { required: ['targetType', 'source'] },
        { required: ['targetType', 'module'] },
        { required: ['operation'], deprecated: true },
        { required: ['target'], deprecated: true },
      ],
    });
    expect(exec?.inputSchema?.properties).not.toHaveProperty('timeoutMs');
    const execProperties = objectProperty(exec?.inputSchema, 'properties');
    const contextSchema = objectProperty(execProperties, 'context');
    expect(objectProperty(contextSchema, 'properties')).not.toHaveProperty('requestId');
    const search = tools.tools.find((tool) => tool.name === 'runtime_search');
    expect(search?.title).toBe('Discover Marshal capabilities and catalog entries');
    expect(search?.description).toContain('matches remain capability results');
    expect(search?.description).toContain('discoveries may contain skill, resource, host_tool, or ui_application');
    expect(search?.description).toContain('exact catalogId');
    expect(search?.description).toContain('resource_read, host_tool, and ui_render');
    expect(search?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(search?.inputSchema).toMatchObject({
      properties: {
        protocolVersion: expect.any(Object),
        name: expect.any(Object),
        catalogId: expect.any(Object),
        detail: expect.objectContaining({ enum: ['summary', 'full', 'compact'] }),
        tags: expect.any(Object),
        kinds: expect.objectContaining({ description: expect.stringContaining('Deprecated') }),
      },
    });
  });

  it('publishes a schema that validates canonical and deprecated execution forms', async () => {
    const { client } = await connectTestRuntime();
    const tools = await client.listTools();
    const exec = tools.tools.find((tool) => tool.name === 'runtime_exec');
    if (!exec) throw new Error('runtime_exec tool is required');
    const validate = new AjvJsonSchemaValidator()
      .getValidator<Record<string, unknown>>(exec.inputSchema);

    for (const input of [
      { targetType: 'operation', target: 'memory.search' },
      { targetType: 'inline_module', source: 'export default () => 1' },
      { targetType: 'module', module: { kind: 'workspace_file', path: 'task.ts' } },
      { operation: 'memory.search' },
      { target: 'memory.search' },
      { operation: 'memory.search', target: 'ignored-legacy-target' },
    ]) {
      expect(validate(input), JSON.stringify(input)).toMatchObject({ valid: true });
    }

    for (const input of [
      {},
      { targetType: 'operation', operation: 'memory.search' },
      { operation: 'memory.search', requestId: 'caller-owned' },
    ]) {
      expect(validate(input), JSON.stringify(input)).toMatchObject({ valid: false });
    }
  });

  it('hides model-facing lifecycle tools when native host hooks own them', async () => {
    const lifecycle = new InMemoryLifecycle();
    const { client } = await connectTestRuntime({ lifecycle, exposeLifecycleTools: false });
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'runtime_search',
      'runtime_exec',
    ]);

    // Compatibility callers can still send lifecycle events even when they are not advertised.
    const started = await client.callTool({
      name: 'runtime_session_start',
      arguments: { sessionId: 'native-hook-session' },
    });
    expect(started.isError).not.toBe(true);
    expect(lifecycle.starts).toHaveLength(1);
  });

  it('forwards search and operation calls through a provider-backed in-memory kernel', async () => {
    const invoke = vi.fn(async (_name: string, input: unknown) => ({ echoed: input }));
    const provider: InMemoryRuntimeProvider = {
      list: () => [
        {
          name: 'memory.search',
          description: 'Search durable memory',
          inputSchema: { type: 'object' },
        },
      ],
      invoke,
    };
    const kernel = new InMemoryRuntimeKernel([provider]);
    const { client } = await connectTestRuntime({ kernel });

    const search = await client.callTool({
      name: 'runtime_search',
      arguments: {
        query: 'durable memory',
        context: { sessionId: 'session-explicit', threadId: 'thread-explicit' },
      },
      _meta: codexRequestMeta('session-explicit', 'thread-explicit', 'turn-explicit'),
    });
    expect(search.structuredContent).toEqual({
      result: [
        expect.objectContaining({
          name: 'memory.search',
        }),
      ],
    });
    expect(kernel.searchCalls[0]).toEqual({
      request: { protocolVersion: '1.0.0', query: 'durable memory' },
      context: expect.objectContaining({
        sessionId: 'session-explicit',
        threadId: 'thread-explicit',
        workspacePath: 'C:/workspace',
        requestId: expect.any(String),
      }),
    });
    expect(kernel.searchCalls[0]?.context.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(kernel.searchCalls[0]?.context.metadata?.mcpRequestId).toMatchObject({
      type: 'number',
      value: expect.any(Number),
    });

    const execution = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'memory.search',
        input: { query: 'adapter' },
      },
    });
    expect(execution.structuredContent).toEqual({ echoed: { query: 'adapter' } });
    expect(invoke).toHaveBeenCalledWith(
      'memory.search',
      { query: 'adapter' },
      expect.objectContaining({ workspacePath: 'C:/workspace' }),
    );

    await client.callTool({
      name: 'runtime_search',
      arguments: {
        protocolVersion: '1.2.3',
        name: 'memory.search',
        detail: 'summary',
        kinds: ['memory'],
      },
    });
    expect(kernel.searchCalls[1]?.request).toEqual({
      protocolVersion: '1.2.3',
      name: 'memory.search',
      detail: 'summary',
      tags: ['memory'],
    });

    await client.callTool({
      name: 'runtime_search',
      arguments: { query: 'durable memory', detail: 'full' },
    });
    expect(kernel.searchCalls[2]?.request).toEqual({
      protocolVersion: '1.0.0',
      query: 'durable memory',
      detail: 'full',
    });

    await client.callTool({
      name: 'runtime_search',
      arguments: { query: 'durable memory', detail: 'compact' },
    });
    expect(kernel.searchCalls[3]?.request).toEqual({
      protocolVersion: '1.0.0',
      query: 'durable memory',
      detail: 'summary',
    });

    for (const legacy of [{ operation: 'memory.search' }, { target: 'memory.search' }]) {
      const result = await client.callTool({
        name: 'runtime_exec',
        arguments: { ...legacy, input: { query: 'legacy' } },
      });
      expect(result.isError).not.toBe(true);
    }
    expect(kernel.executeCalls.slice(-2).map((call) => call.request)).toEqual([
      expect.objectContaining({
        protocolVersion: '1.0.0',
        targetType: 'operation',
        target: 'memory.search',
      }),
      expect.objectContaining({
        protocolVersion: '1.0.0',
        targetType: 'operation',
        target: 'memory.search',
      }),
    ]);
  });

  it('summarizes discovery-only search results and forwards exact catalog ids', async () => {
    const catalogId = 'catalog://marshal.runtime-resource-catalog/resource/runtime-guide';
    const requests: RuntimeSearchRequest[] = [];
    const response = (query: string) => ({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query,
      detail: 'summary',
      matches: [],
      discoveries: [
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          entry: {
            id: catalogId,
            kind: 'resource',
            title: 'Runtime guide',
            description: 'Read the runtime guide.',
            action: { type: 'resource_read', uri: 'resource://runtime-guide' },
          },
          score: 1_000,
          matchedTerms: ['runtime'],
          matchedFields: ['title'],
        },
      ],
    });
    const kernel: RuntimeKernelPort = {
      async search(request) {
        requests.push(request);
        return response(request.query ?? '');
      },
      async execute() {
        throw new Error('Execution is not used by this fixture.');
      },
    };
    const { client } = await connectTestRuntime({ kernel });

    const broad = await client.callTool({
      name: 'runtime_search',
      arguments: { query: 'runtime guide' },
    });
    const broadText = (broad.content as Array<{ type: string; text?: string }>)
      .map((content) => content.text ?? '')
      .join('');
    expect(broadText).toContain('0 capability matches and 1 discovery');
    expect(broadText).toContain('Discoveries: resource:Runtime guide');
    expect(broadText).toContain('discovery actions');
    expect(broad.structuredContent).toEqual(response('runtime guide'));

    const exact = await client.callTool({
      name: 'runtime_search',
      arguments: { catalogId },
    });
    const exactText = (exact.content as Array<{ type: string; text?: string }>)
      .map((content) => content.text ?? '')
      .join('');
    expect(exactText).toContain('0 capability matches and 1 discovery');
    expect(exactText).toContain('Discoveries: resource:Runtime guide');
    expect(exact.structuredContent).toEqual(response(''));
    expect(requests).toEqual([
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: 'runtime guide' },
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, catalogId },
    ]);
  });

  it('binds nested code-mode calls to Codex request metadata without explicit context', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({ kernel });

    await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'missing.capability',
      },
      _meta: codexRequestMeta('session-nested', 'thread-nested', 'turn-nested'),
    });

    expect(kernel.executeCalls).toHaveLength(1);
    expect(kernel.executeCalls[0]?.context).toMatchObject({
      sessionId: 'session-nested',
      threadId: 'thread-nested',
      workspacePath: 'C:/workspace',
      requestId: expect.any(String),
      metadata: expect.objectContaining({
        codexSessionId: 'session-nested',
        codexThreadId: 'thread-nested',
        codexTurnId: 'turn-nested',
        codexIdentitySource: 'mcp-request-meta',
        mcpRequestId: {
          type: 'number',
          value: expect.any(Number),
        },
      }),
    });
    expect(kernel.executeCalls[0]?.context.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('rejects explicit context that conflicts with authoritative Codex request metadata', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({ kernel });

    const result = await client.callTool({
      name: 'runtime_search',
      arguments: {
        query: 'memory',
        context: {
          sessionId: 'forged-session',
          threadId: 'forged-thread',
        },
      },
      _meta: codexRequestMeta('actual-session', 'actual-thread', 'actual-turn'),
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: expect.stringContaining('cannot override the adapter-owned task identity'),
      },
    });
    expect(kernel.searchCalls).toHaveLength(0);
  });

  it('rejects inconsistent Codex transport and turn-metadata thread identities', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({ kernel });

    const result = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'missing.capability',
      },
      _meta: {
        threadId: 'transport-thread',
        'x-codex-turn-metadata': {
          session_id: 'session',
          thread_id: 'different-thread',
          turn_id: 'turn',
        },
      },
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: expect.stringContaining('conflicting thread identities'),
      },
    });
    expect(kernel.executeCalls).toHaveLength(0);
  });

  it('isolates concurrent nested calls by their per-request Codex identity', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({ kernel });

    await Promise.all([
      client.callTool({
        name: 'runtime_exec',
        arguments: { targetType: 'operation', target: 'missing.first' },
        _meta: codexRequestMeta('session-first', 'thread-first', 'turn-first'),
      }),
      client.callTool({
        name: 'runtime_exec',
        arguments: { targetType: 'operation', target: 'missing.second' },
        _meta: codexRequestMeta('session-second', 'thread-second', 'turn-second'),
      }),
    ]);

    expect(kernel.executeCalls).toHaveLength(2);
    const contexts = new Map(
      kernel.executeCalls.map((call) => [call.request.target, call.context]),
    );
    expect(contexts.get('missing.first')).toMatchObject({
      sessionId: 'session-first',
      threadId: 'thread-first',
      metadata: expect.objectContaining({ codexTurnId: 'turn-first' }),
    });
    expect(contexts.get('missing.second')).toMatchObject({
      sessionId: 'session-second',
      threadId: 'thread-second',
      metadata: expect.objectContaining({ codexTurnId: 'turn-second' }),
    });
  });

  it('keeps sequential nested calls on one task exact while assigning fresh invocation ids', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({ kernel });
    const meta = codexRequestMeta('session-stable', 'thread-stable', 'turn-stable');

    await client.callTool({
      name: 'runtime_exec',
      arguments: { targetType: 'operation', target: 'missing.first' },
      _meta: meta,
    });
    await client.callTool({
      name: 'runtime_exec',
      arguments: { targetType: 'operation', target: 'missing.second' },
      _meta: meta,
    });

    expect(kernel.executeCalls.map((call) => call.context)).toEqual([
      expect.objectContaining({ sessionId: 'session-stable', threadId: 'thread-stable' }),
      expect.objectContaining({ sessionId: 'session-stable', threadId: 'thread-stable' }),
    ]);
    for (const context of kernel.executeCalls.map((call) => call.context)) {
      expect(context.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(kernel.executeCalls[0]?.context.requestId).not.toBe(
      kernel.executeCalls[1]?.context.requestId,
    );
  });

  it('strips forged top-level request ids before kernel dispatch', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({ kernel });

    await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'missing.capability',
        requestId: 'forged-execution-id',
      },
    });

    expect(kernel.executeCalls).toHaveLength(1);
    expect(kernel.executeCalls[0]?.request).not.toHaveProperty('requestId');
    expect(kernel.executeCalls[0]?.context).toMatchObject({
      requestId: expect.any(String),
      metadata: {
        mcpRequestId: {
          type: 'number',
          value: expect.any(Number),
        },
      },
    });
    expect(kernel.executeCalls[0]?.context.requestId).not.toBe('forged-execution-id');
  });

  it('does not let an alternate MCP caller self-assert task or principal identity', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({ kernel });

    const result = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'missing.capability',
        context: {
          sessionId: 'spoofed-session',
          threadId: 'spoofed-thread',
          agentId: 'spoofed-principal',
          workspacePath: 'C:/workspace',
          requestId: 'spoofed-request-id',
          metadata: {
            source: 'codex-pretool',
            codexSessionId: 'spoofed-session',
            codexThreadId: 'spoofed-thread',
            codexToolUseId: 'spoofed-tool-use',
          },
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(kernel.executeCalls).toHaveLength(1);
    expect(kernel.executeCalls[0]?.context).toMatchObject({
      sessionId: undefined,
      threadId: undefined,
      agentId: undefined,
      workspacePath: 'C:/workspace',
      requestId: expect.any(String),
      metadata: expect.objectContaining({
        callerRequestId: { type: 'string', value: 'spoofed-request-id' },
        callerRequestIdAuthority: 'untrusted-correlation',
        codexToolUseId: { type: 'string', value: 'spoofed-tool-use' },
        codexToolUseIdAuthority: 'untrusted-correlation',
      }),
    });
    expect(kernel.executeCalls[0]?.context.metadata).not.toMatchObject({
      source: 'codex-pretool',
      codexSessionId: 'spoofed-session',
      codexThreadId: 'spoofed-thread',
    });

    const workspaceSpoof = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'missing.capability',
        context: {
          workspacePath: 'C:/forged-workspace',
        },
      },
    });
    expect(workspaceSpoof).toMatchObject({
      isError: true,
      structuredContent: {
        error: expect.stringContaining('cannot override the adapter-owned workspace'),
      },
    });
    expect(kernel.executeCalls).toHaveLength(1);
  });

  it('retains hook tool-use ids only as untrusted correlation metadata', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({
      kernel,
      exposeLifecycleTools: false,
    });
    const rewritten = rewriteMarshalPreToolUse({
      hook_event_name: 'PreToolUse',
      session_id: 'hook-session',
      thread_id: 'hook-thread',
      turn_id: 'hook-turn',
      tool_use_id: 'hook-tool-use',
      cwd: 'C:/workspace',
      tool_name: 'mcp__marshal_runtime__runtime_exec',
      tool_input: {
        targetType: 'operation',
        target: 'missing.capability',
      },
    });
    if (!('updatedInput' in rewritten)) throw new Error('Expected rewritten Codex tool input');

    await client.callTool({
      name: 'runtime_exec',
      arguments: rewritten.updatedInput,
      _meta: codexRequestMeta('hook-session', 'hook-thread', 'hook-turn'),
    });

    expect(kernel.executeCalls).toHaveLength(1);
    expect(kernel.executeCalls[0]?.request).not.toHaveProperty('requestId');
    expect(kernel.executeCalls[0]?.context).toMatchObject({
      sessionId: 'hook-session',
      threadId: 'hook-thread',
      requestId: expect.any(String),
      metadata: expect.objectContaining({
        codexToolUseId: { type: 'string', value: 'hook-tool-use' },
        codexToolUseIdAuthority: 'untrusted-correlation',
        mcpRequestId: {
          type: 'number',
          value: expect.any(Number),
        },
      }),
    });
    expect(kernel.executeCalls[0]?.context.requestId).not.toBe('hook-tool-use');
  });

  it('domain-separates long transport and hook correlations without prefix collisions', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const prefix = 'shared-prefix-'.padEnd(513, 'x');
    const longIds = [`${prefix}a`, `${prefix}b`];

    for (const requestId of longIds) {
      const { client, close } = await connectTestRuntime({ kernel }, requestId);
      await client.callTool({
        name: 'runtime_exec',
        arguments: { targetType: 'operation', target: 'missing.capability' },
      });
      await close();
    }

    const { client } = await connectTestRuntime({
      kernel,
      exposeLifecycleTools: false,
    });
    for (const toolUseId of longIds) {
      const rewritten = rewriteMarshalPreToolUse({
        hook_event_name: 'PreToolUse',
        session_id: 'long-id-session',
        thread_id: 'long-id-thread',
        turn_id: 'long-id-turn',
        tool_use_id: toolUseId,
        cwd: 'C:/workspace',
        tool_name: 'mcp__marshal_runtime__runtime_exec',
        tool_input: { targetType: 'operation', target: 'missing.capability' },
      });
      if (!('updatedInput' in rewritten)) throw new Error('Expected rewritten Codex tool input');
      await client.callTool({
        name: 'runtime_exec',
        arguments: rewritten.updatedInput,
        _meta: codexRequestMeta('long-id-session', 'long-id-thread', 'long-id-turn'),
      });
    }

    const transportDigests = kernel.executeCalls
      .slice(0, 2)
      .map((call) => call.context.metadata?.mcpRequestId)
      .map(correlationDigest);
    const hookDigests = kernel.executeCalls
      .slice(2, 4)
      .map((call) => call.context.metadata?.codexToolUseId)
      .map(correlationDigest);
    expect(transportDigests).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(hookDigests).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(new Set(transportDigests).size).toBe(2);
    expect(new Set(hookDigests).size).toBe(2);
    expect(transportDigests).not.toEqual(hookDigests);
  });

  it('keeps receipt forests valid across reconnects and repeated transport or hook ids', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-codex-request-id-'));
    const workspacePath = path.join(root, 'workspace');
    await fs.mkdir(workspacePath);
    const provider: CapabilityProvider = {
      id: 'test.request-id-provider',
      list: () => [{
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'test.request-id',
        version: '1.0.0',
        description: 'Echo input for request identity tests.',
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
        permissions: [{ permission: 'test.request-id', risk: 'low' }],
      }],
      invoke: async (_name, input) => ({ output: input }),
    };
    const runtime = await createAgentRuntime({
      workspacePath,
      stateDirectory: '.marshal-request-id',
      protectedLifecycleResultRoot: path.join(root, 'private-lifecycle'),
      providerSources: [() => provider],
      permissionBroker: { decide: () => ({ decision: 'allow' as const }) },
    });
    try {
      const observedContexts: RuntimeCallContext[] = [];
      const recordingKernel: RuntimeKernelPort = {
        search: (request, context) => runtime.kernel.search(request, context),
        execute: (request, context) => {
          observedContexts.push(context);
          return runtime.kernel.execute(request, context);
        },
      };
      let value = 0;
      for (const requestId of [7, 7, 'reused-request', 'reused-request'] satisfies RequestId[]) {
        const { client, close } = await connectTestRuntime({ kernel: recordingKernel }, requestId);
        const result = await client.callTool({
          name: 'runtime_exec',
          arguments: {
            targetType: 'operation',
            target: 'test.request-id',
            input: { value: ++value },
            requestId: 'repeated-forged-id',
          },
        });
        expect(result.isError).not.toBe(true);
        await close();
      }

      const repeatedHook = rewriteMarshalPreToolUse({
        hook_event_name: 'PreToolUse',
        session_id: 'receipt-session',
        thread_id: 'receipt-thread',
        turn_id: 'receipt-turn',
        tool_use_id: 'repeated-hook-id',
        cwd: workspacePath,
        tool_name: 'mcp__marshal_runtime__runtime_exec',
        tool_input: {
          targetType: 'operation',
          target: 'test.request-id',
          input: { value: ++value },
        },
      });
      if (!('updatedInput' in repeatedHook)) throw new Error('Expected rewritten hook input');
      for (const requestId of ['hook-rpc-id', 'hook-rpc-id']) {
        const { client, close } = await connectTestRuntime(
          { kernel: recordingKernel, defaultContext: { workspacePath } },
          requestId,
        );
        const result = await client.callTool({
          name: 'runtime_exec',
          arguments: repeatedHook.updatedInput,
          _meta: codexRequestMeta('receipt-session', 'receipt-thread', 'receipt-turn'),
        });
        expect(result.isError).not.toBe(true);
        await close();
      }

      const fallbackInputValue = ++value;
      const fallbackHook = () => rewriteMarshalPreToolUse({
        hook_event_name: 'PreToolUse',
        session_id: 'receipt-session',
        thread_id: 'receipt-thread',
        turn_id: 'receipt-turn',
        cwd: workspacePath,
        tool_name: 'mcp__marshal_runtime__runtime_exec',
        tool_input: {
          targetType: 'operation',
          target: 'test.request-id',
          input: { value: fallbackInputValue },
        },
      });
      const firstFallback = fallbackHook();
      const secondFallback = fallbackHook();
      if (!('updatedInput' in firstFallback) || !('updatedInput' in secondFallback)) {
        throw new Error('Expected fallback hook inputs');
      }
      expect(firstFallback.updatedInput).toEqual(secondFallback.updatedInput);
      for (const updatedInput of [
        firstFallback.updatedInput,
        secondFallback.updatedInput,
      ]) {
        const { client, close } = await connectTestRuntime(
          { kernel: recordingKernel, defaultContext: { workspacePath } },
          'fallback-rpc-id',
        );
        const result = await client.callTool({
          name: 'runtime_exec',
          arguments: updatedInput,
          _meta: codexRequestMeta('receipt-session', 'receipt-thread', 'receipt-turn'),
        });
        expect(result.isError).not.toBe(true);
        await close();
      }

      const { client: spoofClient, close: closeSpoof } = await connectTestRuntime({
        kernel: recordingKernel,
        defaultContext: { workspacePath },
      });
      const spoofed = await spoofClient.callTool({
        name: 'runtime_exec',
        arguments: {
          targetType: 'operation',
          target: 'test.request-id',
          input: { value: ++value },
          context: {
            requestId: 'spoofed-receipt-id',
            metadata: {
              codexToolUseId: 'spoofed-tool-use',
              arbitrarySecret: 'must-not-persist',
            },
          },
        },
      });
      expect(spoofed.isError).not.toBe(true);
      await closeSpoof();

      const longTransportId = `${'shared-prefix-'.padEnd(513, 'x')}receipt`;
      const { client: longClient, close: closeLong } = await connectTestRuntime(
        { kernel: recordingKernel },
        longTransportId,
      );
      const longResult = await longClient.callTool({
        name: 'runtime_exec',
        arguments: {
          targetType: 'operation',
          target: 'test.request-id',
          input: { value: ++value },
        },
      });
      expect(longResult.isError).not.toBe(true);
      await closeLong();

      const receipts = (await runtime.receipts.list())
        .filter((receipt) => receipt.target === 'test.request-id');
      expect(receipts).toHaveLength(10);
      expect(new Set(receipts.map((receipt) => receipt.executionId)).size).toBe(10);
      for (const receipt of receipts) {
        expect(receipt.executionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
      expect(receipts.map((receipt) => receipt.executionId)).not.toContain('repeated-forged-id');
      expect(receipts.every((receipt) => receipt.requestId === undefined)).toBe(true);
      expect(buildRuntimeReceiptForest(receipts).roots).toHaveLength(10);
      expect(receipts.slice(0, 4).map((receipt) => receipt.correlations)).toEqual([
        [{ name: 'mcpRequestId', authority: 'transport-correlation', type: 'number', value: 7 }],
        [{ name: 'mcpRequestId', authority: 'transport-correlation', type: 'number', value: 7 }],
        [{
          name: 'mcpRequestId',
          authority: 'transport-correlation',
          type: 'string',
          value: 'reused-request',
        }],
        [{
          name: 'mcpRequestId',
          authority: 'transport-correlation',
          type: 'string',
          value: 'reused-request',
        }],
      ]);
      expect(receipts[8]?.correlations).toEqual([
        expect.objectContaining({
          name: 'mcpRequestId',
          authority: 'transport-correlation',
        }),
        {
          name: 'callerRequestId',
          authority: 'untrusted-correlation',
          type: 'string',
          value: 'spoofed-receipt-id',
        },
        {
          name: 'codexToolUseId',
          authority: 'untrusted-correlation',
          type: 'string',
          value: 'spoofed-tool-use',
        },
      ]);
      expect(receipts[8]).not.toHaveProperty('metadata');
      expect(receipts[9]?.correlations).toEqual([
        expect.objectContaining({
          name: 'mcpRequestId',
          authority: 'transport-correlation',
          type: 'sha256',
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          length: longTransportId.length,
        }),
      ]);
      expect(observedContexts.slice(0, 4).map((context) => context.metadata?.mcpRequestId)).toEqual([
        { type: 'number', value: 7 },
        { type: 'number', value: 7 },
        { type: 'string', value: 'reused-request' },
        { type: 'string', value: 'reused-request' },
      ]);
    } finally {
      await runtime.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('binds later resource requests to the exact task context from a rewritten tool call', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const listResources = vi.fn(async (_context: RuntimeCallContext) => [{
      uri: 'runtime://bound/task',
      name: 'Bound task resource',
    }]);
    const readResource = vi.fn(async (uri: string, _context: RuntimeCallContext) => ({
      uri,
      text: 'bound',
    }));
    const { client } = await connectTestRuntime({
      kernel,
      exposeLifecycleTools: false,
      resources: {
        listResources,
        readResource,
      },
    });

    const rewritten = rewriteMarshalPreToolUse({
      hook_event_name: 'PreToolUse',
      session_id: 'codex-session-bound',
      thread_id: 'codex-thread-bound',
      turn_id: 'codex-turn-bound',
      tool_use_id: 'codex-tool-use-bound',
      cwd: 'C:/workspace',
      tool_name: 'mcp__marshal_runtime__runtime_search',
      tool_input: { query: 'bind task' },
    });
    if (!('updatedInput' in rewritten)) throw new Error('Expected rewritten Codex tool input');
    await client.callTool({
      name: 'runtime_search',
      arguments: rewritten.updatedInput,
      _meta: codexRequestMeta(
        'codex-session-bound',
        'codex-thread-bound',
        'codex-turn-bound',
      ),
    });
    expect(kernel.searchCalls[0]?.context.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(kernel.searchCalls[0]?.context.metadata).toMatchObject({
      codexToolUseId: { type: 'string', value: 'codex-tool-use-bound' },
      codexToolUseIdAuthority: 'untrusted-correlation',
    });
    await client.listResources();
    await client.readResource({ uri: 'runtime://bound/task' });

    for (const context of [
      listResources.mock.calls.at(-1)?.[0],
      readResource.mock.calls.at(-1)?.[1],
    ]) {
      expect(context).toBeDefined();
      if (!context) throw new Error('Expected resource context');
      expect(context).toMatchObject({
        sessionId: 'codex-session-bound',
        threadId: 'codex-thread-bound',
        workspacePath: 'C:/workspace',
        metadata: expect.objectContaining({
          source: 'bound-mcp-call-context',
          codexSessionId: 'codex-session-bound',
          codexThreadId: 'codex-thread-bound',
          mcpRequestId: {
            type: 'number',
            value: expect.any(Number),
          },
        }),
      });
      expect(context.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('keeps model-facing result text bounded without duplicating structured schemas or output', async () => {
    const largeMarker = `FULL_STRUCTURED_PAYLOAD_${'x'.repeat(64_000)}`;
    const provider: InMemoryRuntimeProvider = {
      list: () => [{
        name: 'memory.large-schema',
        description: 'Large schema payload',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: largeMarker },
          },
        },
      }],
      invoke: async () => ({ status: 'success', output: { payload: largeMarker } }),
    };
    const { client } = await connectTestRuntime({
      kernel: new InMemoryRuntimeKernel([provider]),
    });

    const searched = await client.callTool({
      name: 'runtime_search',
      arguments: { name: 'memory.large-schema', detail: 'full' },
    });
    const searchText = (searched.content as Array<{ type: string; text?: string }>)
      .filter((content) => content.type === 'text')
      .map((content) => content.text ?? '')
      .join('');
    expect(JSON.stringify(searched.structuredContent)).toContain(largeMarker);
    expect(searchText).not.toContain(largeMarker);
    expect(Buffer.byteLength(searchText, 'utf8')).toBeLessThanOrEqual(2_048);

    const executed = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'operation',
        target: 'memory.large-schema',
        input: {},
      },
    });
    const executionText = (executed.content as Array<{ type: string; text?: string }>)
      .filter((content) => content.type === 'text')
      .map((content) => content.text ?? '')
      .join('');
    expect(JSON.stringify(executed.structuredContent)).toContain(largeMarker);
    expect(executionText).not.toContain(largeMarker);
    expect(Buffer.byteLength(executionText, 'utf8')).toBeLessThanOrEqual(2_048);
  });

  it('defaults protocol versions and rejects unsupported majors before kernel calls', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const lifecycle = new InMemoryLifecycle();
    const { client } = await connectTestRuntime({ kernel, lifecycle });

    const unsupportedSearch = await client.callTool({
      name: 'runtime_search',
      arguments: { protocolVersion: '2.0.0', query: 'memory' },
    });
    const unsupportedExecution = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        protocolVersion: '9.1.0',
        targetType: 'operation',
        target: 'memory.search',
      },
    });
    const unsupportedLifecycle = await client.callTool({
      name: 'runtime_session_start',
      arguments: { protocolVersion: '3.0.0', sessionId: 'unsupported-session' },
    });
    expect(unsupportedSearch).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'unsupported_protocol_version',
        error: expect.stringContaining('Unsupported runtime protocol'),
      },
    });
    expect(unsupportedExecution).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'unsupported_protocol_version',
        error: expect.stringContaining('Unsupported runtime protocol'),
      },
    });
    expect(unsupportedLifecycle).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'unsupported_protocol_version',
        error: expect.stringContaining('Unsupported runtime protocol'),
      },
    });
    expect(kernel.searchCalls).toHaveLength(0);
    expect(kernel.executeCalls).toHaveLength(0);
    expect(lifecycle.starts).toHaveLength(0);
  });

  it('propagates MCP cancellation to the kernel invocation context', async () => {
    let finish!: (value: unknown) => void;
    const completed = new Promise<unknown>((resolve) => (finish = resolve));
    const execute = vi.fn(
      async (_request: unknown, context: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          const cancelled = {
            status: 'cancelled',
            receipt: { status: 'cancelled', completedAt: new Date().toISOString() },
          };
          context.signal?.addEventListener(
            'abort',
            () => {
              finish(cancelled);
              resolve(cancelled);
            },
            { once: true },
          );
        }),
    );
    const kernel = {
      search: vi.fn(async () => ({ matches: [] })),
      execute,
    };
    const { client } = await connectTestRuntime({ kernel });
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: 'runtime_exec',
        arguments: { targetType: 'operation', target: 'test.cancellable' },
      },
      undefined,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect(completed).resolves.toMatchObject({
      status: 'cancelled',
      receipt: { status: 'cancelled' },
    });
    expect(execute.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('runs inline and editable file modules through the kernel and rejects removed target types', async () => {
    const inlineExecutor = vi.fn(async (request) => ({ source: request.source, answer: 42 }));
    const moduleExecutor = vi.fn(async (request) => ({ module: request.module, revision: 2 }));
    const kernel = new InMemoryRuntimeKernel([], inlineExecutor, moduleExecutor);
    const { client } = await connectTestRuntime({ kernel });

    const execution = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'inline_module',
        source: 'export default async () => 42;',
        input: { question: 'life' },
      },
    });
    expect(execution.isError).not.toBe(true);
    expect(execution.structuredContent).toEqual({
      source: 'export default async () => 42;',
      answer: 42,
    });
    expect(inlineExecutor).toHaveBeenCalledOnce();

    const moduleExecution = await client.callTool({
      name: 'runtime_exec',
      arguments: {
        targetType: 'module',
        module: { kind: 'workspace_file', path: '.agent/execution/editable.ts' },
        input: { revision: 2 },
        timeoutMs: 120_000,
      },
    });
    expect(moduleExecution.isError).not.toBe(true);
    expect(moduleExecution.structuredContent).toEqual({
      module: { kind: 'workspace_file', path: '.agent/execution/editable.ts' },
      revision: 2,
    });
    expect(moduleExecutor).toHaveBeenCalledOnce();
    expect(moduleExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 120_000 }),
      expect.any(Object),
    );

    for (const targetType of ['workflow', 'stage', 'lambda']) {
      const rejected = await client.callTool({
        name: 'runtime_exec',
        arguments: { targetType, target: 'legacy' },
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toEqual({
        code: 'runtime_adapter_error',
        error: expect.stringContaining('intentionally unsupported'),
      });
    }
    expect(kernel.executeCalls).toHaveLength(2);
  });

  it('threads explicit lifecycle observations and active session context into runtime calls', async () => {
    const lifecycle = new InMemoryLifecycle({
      startSession: () => ({ memoryContext: ['remember adapters'] }),
      observeTurn: () => ({ stored: true }),
      endSession: () => ({ flushed: true }),
    });
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({ kernel, lifecycle });

    const forgedParent = await client.callTool({
      name: 'runtime_session_start',
      arguments: {
        sessionId: 'codex-task-1',
        parentSessionId: 'forged-parent',
      },
    });
    expect(forgedParent.isError).not.toBe(true);
    expect(lifecycle.starts).toHaveLength(1);
    expect(lifecycle.starts[0]).not.toHaveProperty('parentSessionId');
    lifecycle.starts.length = 0;

    const started = await client.callTool({
      name: 'runtime_session_start',
      arguments: {
        sessionId: 'codex-task-1',
        agentId: 'main',
        metadata: {
          source: 'codex',
          parentSessionId: 'forged-parent',
          verifiedParentSessionId: 'forged-parent',
        },
      },
    });
    expect(started.structuredContent).toEqual({
      sessionId: 'codex-task-1',
      observed: true,
      lifecycleResult: { memoryContext: ['remember adapters'] },
    });
    expect(lifecycle.starts[0]).toEqual(
      expect.objectContaining({
        protocolVersion: '1.0.0',
        eventId: expect.stringMatching(/^mcp-[a-f0-9]{64}$/),
        metadata: { source: 'codex' },
      }),
    );

    const observed = await client.callTool({
      name: 'runtime_observe_turn',
      arguments: {
        kind: 'user_message',
        content: 'Build the adapter',
      },
    });
    expect(observed.isError).not.toBe(true);
    expect(lifecycle.observations[0]).toEqual(
      expect.objectContaining({
        protocolVersion: '1.0.0',
        eventId: expect.stringMatching(/^mcp-[a-f0-9]{64}$/),
        sessionId: 'codex-task-1',
        kind: 'user_message',
        content: 'Build the adapter',
        agentId: 'main',
        workspacePath: 'C:/workspace',
      }),
    );

    await client.callTool({
      name: 'runtime_search',
      arguments: { query: 'missing' },
    });
    expect(kernel.searchCalls[0].context).toEqual(
      expect.objectContaining({
        sessionId: 'codex-task-1',
        agentId: 'main',
        workspacePath: 'C:/workspace',
      }),
    );

    const ended = await client.callTool({
      name: 'runtime_session_end',
      arguments: { outcome: 'complete' },
    });
    expect(ended.structuredContent).toEqual({
      sessionId: 'codex-task-1',
      observed: true,
      lifecycleResult: { flushed: true },
    });
    expect(lifecycle.ends[0]).toEqual(
      expect.objectContaining({
        protocolVersion: '1.0.0',
        eventId: expect.stringMatching(/^mcp-[a-f0-9]{64}$/),
        sessionId: 'codex-task-1',
        outcome: 'complete',
      }),
    );
  });

  it('invalidates ended task bindings across tool, resource, list, and read paths', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const listTools = vi.fn(async (context: RuntimeCallContext) => [{
      name: 'test_resource_tool',
      description: 'Test resource context binding.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      _context: context,
    }]);
    const listResources = vi.fn(async (context: RuntimeCallContext) => [{
      uri: 'runtime://task-bound',
      name: 'Task-bound resource',
      _context: context,
    }]);
    const readResource = vi.fn(async (uri: string, context: RuntimeCallContext) => ({
      uri,
      text: 'task-bound',
      _context: context,
    }));
    const callTool = vi.fn(async (
      name: string,
      _input: Record<string, unknown>,
      context: RuntimeCallContext,
    ) => name === 'test_resource_tool'
      ? {
          content: [{ type: 'text' as const, text: 'resource-tool' }],
          structuredContent: { sessionId: context.sessionId },
        }
      : undefined);
    const { client } = await connectTestRuntime({
      kernel,
      resources: { listTools, listResources, readResource, callTool },
    });

    await client.callTool({
      name: 'runtime_session_start',
      arguments: {
        sessionId: 'task-a',
        threadId: 'thread-a',
        agentId: 'agent-a',
      },
    });
    await client.callTool({
      name: 'runtime_search',
      arguments: { query: 'bind-a', context: { sessionId: 'task-a' } },
    });
    await client.callTool({
      name: 'test_resource_tool',
      arguments: { context: { sessionId: 'task-a' } },
    });
    const endedCorrelationContext =
      kernel.searchCalls.at(-1)?.context.receiptCorrelationContext;
    expect(endedCorrelationContext).toBeDefined();

    await client.callTool({
      name: 'runtime_session_end',
      arguments: { sessionId: 'task-a', outcome: 'complete' },
    });
    await client.callTool({
      name: 'runtime_session_start',
      arguments: {
        sessionId: 'task-b',
        threadId: 'thread-b',
        agentId: 'agent-b',
      },
    });

    await client.callTool({
      name: 'runtime_search',
      arguments: { query: 'bind-b' },
    });
    await client.listTools();
    await client.listResources();
    await client.readResource({ uri: 'runtime://task-bound' });
    const resourceToolResult = await client.callTool({
      name: 'test_resource_tool',
      arguments: {},
    });
    expect(resourceToolResult.structuredContent).toEqual({ sessionId: 'task-b' });

    const postEndContexts = [
      kernel.searchCalls.at(-1)?.context,
      listTools.mock.calls.at(-1)?.[0],
      listResources.mock.calls.at(-1)?.[0],
      readResource.mock.calls.at(-1)?.[1],
      callTool.mock.calls.at(-1)?.[2],
    ];
    for (const context of postEndContexts) {
      expect(context).toMatchObject({
        sessionId: 'task-b',
        threadId: 'thread-b',
        agentId: 'agent-b',
        workspacePath: 'C:/workspace',
      });
      expect(context?.receiptCorrelationContext).toBeDefined();
      expect(context?.receiptCorrelationContext).not.toBe(endedCorrelationContext);
    }
  });

  it('cleans only the ended context when concurrent sessions remain active', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const listResources = vi.fn(async (context: RuntimeCallContext) => [{
      uri: 'runtime://concurrent',
      name: context.sessionId ?? 'unbound',
    }]);
    const callTool = vi.fn(async (
      name: string,
      _input: Record<string, unknown>,
      context: RuntimeCallContext,
    ) => name === 'test_concurrent_tool'
      ? {
          content: [{ type: 'text' as const, text: 'concurrent' }],
          structuredContent: { sessionId: context.sessionId },
        }
      : undefined);
    const { client } = await connectTestRuntime({
      kernel,
      resources: {
        listResources,
        readResource: async (uri) => ({ uri, text: '' }),
        listTools: async () => [{
          name: 'test_concurrent_tool',
          description: 'Concurrent context probe.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
        callTool,
      },
    });

    for (const sessionId of ['task-a', 'task-b']) {
      await client.callTool({
        name: 'runtime_session_start',
        arguments: {
          sessionId,
          threadId: `thread-${sessionId.at(-1)}`,
          agentId: `agent-${sessionId.at(-1)}`,
        },
      });
      await client.callTool({
        name: 'runtime_search',
        arguments: { query: sessionId, context: { sessionId } },
      });
    }

    await expect(client.listResources()).rejects.toThrow(/Multiple runtime sessions/);
    await client.callTool({
      name: 'runtime_session_end',
      arguments: { sessionId: 'task-a' },
    });

    await expect(client.listResources()).resolves.toMatchObject({
      resources: [expect.objectContaining({ name: 'task-b' })],
    });
    expect(listResources.mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 'task-b',
      threadId: 'thread-b',
      agentId: 'agent-b',
    });
    const repeatedEnd = await client.callTool({
      name: 'runtime_session_end',
      arguments: { sessionId: 'task-a' },
    });
    expect(repeatedEnd).toMatchObject({
      isError: true,
      structuredContent: {
        error: expect.stringContaining('does not identify an active task'),
      },
    });
    await expect(client.listResources()).resolves.toMatchObject({
      resources: [expect.objectContaining({ name: 'task-b' })],
    });
    const resourceToolResult = await client.callTool({
      name: 'test_concurrent_tool',
      arguments: {},
    });
    expect(resourceToolResult.structuredContent).toEqual({ sessionId: 'task-b' });
  });

  it('clears task bindings when the MCP server connection is disposed', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const listResources = vi.fn(async (context: RuntimeCallContext) => [{
      uri: 'runtime://disposed',
      name: context.sessionId ?? 'unbound',
    }]);
    const server = createCodexMcpServer({
      kernel,
      defaultContext: { workspacePath: 'C:/workspace' },
      resources: {
        listResources,
        readResource: async (uri) => ({ uri, text: '' }),
      },
    });

    const first = await connectClientToServer(server);
    await first.callTool({
      name: 'runtime_session_start',
      arguments: {
        sessionId: 'task-a',
        threadId: 'thread-a',
        agentId: 'agent-a',
      },
    });
    await first.callTool({
      name: 'runtime_search',
      arguments: { query: 'bind-a', context: { sessionId: 'task-a' } },
    });
    await first.close();

    const second = await connectClientToServer(server);
    try {
      await second.callTool({
        name: 'runtime_session_start',
        arguments: {
          sessionId: 'task-b',
          threadId: 'thread-b',
          agentId: 'agent-b',
        },
      });
      await expect(second.listResources()).resolves.toMatchObject({
        resources: [expect.objectContaining({ name: 'task-b' })],
      });
      expect(listResources.mock.calls.at(-1)?.[0]).toMatchObject({
        sessionId: 'task-b',
        threadId: 'thread-b',
        agentId: 'agent-b',
      });
    } finally {
      await second.close();
      await server.close();
    }
  });

  it('bounds retained task contexts and frees capacity when a session ends', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const { client } = await connectTestRuntime({ kernel });

    for (let index = 0; index < 256; index += 1) {
      const sessionId = `bounded-${index}`;
      await client.callTool({
        name: 'runtime_session_start',
        arguments: { sessionId, threadId: `thread-${index}` },
      });
      const bound = await client.callTool({
        name: 'runtime_search',
        arguments: { query: sessionId, context: { sessionId } },
      });
      expect(bound.isError).not.toBe(true);
    }

    await client.callTool({
      name: 'runtime_session_start',
      arguments: { sessionId: 'bounded-overflow', threadId: 'thread-overflow' },
    });
    const overflow = await client.callTool({
      name: 'runtime_search',
      arguments: {
        query: 'overflow',
        context: { sessionId: 'bounded-overflow' },
      },
    });
    expect(overflow).toMatchObject({
      isError: true,
      structuredContent: {
        error: expect.stringContaining('maximum is 256'),
      },
    });

    await client.callTool({
      name: 'runtime_session_end',
      arguments: { sessionId: 'bounded-0' },
    });
    const retried = await client.callTool({
      name: 'runtime_search',
      arguments: {
        query: 'overflow',
        context: { sessionId: 'bounded-overflow' },
      },
    });
    expect(retried.isError).not.toBe(true);
  });

  it('binds call context to active task identity and rejects ambiguous session inference', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const lifecycle = new InMemoryLifecycle();
    const { client } = await connectTestRuntime({ kernel, lifecycle });

    await client.callTool({
      name: 'runtime_session_start',
      arguments: { sessionId: 'task-a', agentId: 'agent-a' },
    });
    for (const context of [
      { sessionId: 'task-b' },
      { sessionId: 'task-a', agentId: 'agent-b' },
      { sessionId: 'task-a', workspacePath: 'C:/other-workspace' },
    ]) {
      const rejected = await client.callTool({
        name: 'runtime_search',
        arguments: { query: 'memory', context },
      });
      expect(rejected.isError).toBe(true);
    }

    await client.callTool({
      name: 'runtime_session_start',
      arguments: { sessionId: 'task-b', agentId: 'agent-b' },
    });
    const ambiguous = await client.callTool({
      name: 'runtime_search',
      arguments: { query: 'memory' },
    });
    expect(ambiguous).toMatchObject({
      isError: true,
      structuredContent: { error: expect.stringContaining('Multiple runtime sessions') },
    });

    const selected = await client.callTool({
      name: 'runtime_search',
      arguments: { query: 'memory', context: { sessionId: 'task-a' } },
    });
    expect(selected.isError).not.toBe(true);
    expect(kernel.searchCalls.at(-1)?.context).toMatchObject({
      sessionId: 'task-a',
      agentId: 'agent-a',
      workspacePath: 'C:/workspace',
    });
  });

  it('prevents resource tools from shadowing reserved runtime tools', async () => {
    const kernel = new InMemoryRuntimeKernel([]);
    const resourceCall = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'shadowed' }],
    }));
    const resources = {
      listResources: vi.fn(async () => []),
      readResource: vi.fn(async (uri: string) => ({ uri, text: '' })),
      listTools: vi.fn(async () => [
        {
          name: 'runtime_search',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: resourceCall,
    };
    const { client } = await connectTestRuntime({ kernel, resources });

    const searched = await client.callTool({
      name: 'runtime_search',
      arguments: { query: 'memory' },
    });
    expect(searched.isError).not.toBe(true);
    expect(kernel.searchCalls).toHaveLength(1);
    expect(resourceCall).not.toHaveBeenCalled();
    await expect(client.listTools()).rejects.toThrow(/reserved or duplicated/i);
  });

  it('advertises MCP App resources and renders a scoped declarative UI artifact', async () => {
    const artifact = {
      id: 'ui-1',
      revision: 3,
      documentDigest: 'd'.repeat(64),
      document: {
        title: 'Runtime status',
        root: { id: 'root', type: 'text', text: 'Healthy' },
      },
    };
    const kernel = {
      search: vi.fn(async () => []),
      execute: vi.fn(async () => ({
        status: 'success',
        result: { output: { artifact, resource: { uri: 'ui://marshal/runtime' } } },
        receipt: { receiptId: 'receipt-ui-1' },
      })),
    };
    const resources = {
      listResources: vi.fn(async () => [
        {
          uri: 'ui://marshal/runtime',
          name: 'Marshal renderer',
          mimeType: 'text/html;profile=mcp-app',
        },
      ]),
      readResource: vi.fn(async (uri: string) => ({
        uri,
        mimeType: 'text/html;profile=mcp-app',
        text: '<!doctype html><title>Marshal renderer</title>',
      })),
      toolMetadata: vi.fn(() => ({
        ui: { resourceUri: 'ui://marshal/runtime', visibility: ['model', 'app'] },
        'ui/resourceUri': 'ui://marshal/runtime',
      })),
    };
    const { client } = await connectTestRuntime({ kernel, resources });

    const tools = await client.listTools();
    const renderTool = tools.tools.find((tool) => tool.name === 'runtime_render_ui');
    expect(renderTool?._meta).toEqual(resources.toolMetadata());
    expect(renderTool?.inputSchema.required).toEqual([
      'artifactId',
      'revision',
      'documentDigest',
    ]);

    const listed = await client.listResources();
    expect(listed.resources).toEqual([
      expect.objectContaining({ uri: 'ui://marshal/runtime' }),
    ]);
    const read = await client.readResource({ uri: 'ui://marshal/runtime' });
    expect(read.contents[0]).toEqual(
      expect.objectContaining({ mimeType: 'text/html;profile=mcp-app' }),
    );

    const rendered = await client.callTool({
      name: 'runtime_render_ui',
      arguments: {
        artifactId: 'ui-1',
        revision: 3,
        documentDigest: 'd'.repeat(64),
      },
    });
    expect(rendered.structuredContent).toEqual({
      artifact,
      resource: { uri: 'ui://marshal/runtime' },
      receipt: { receiptId: 'receipt-ui-1' },
    });
    expect(kernel.execute).toHaveBeenCalledWith(
      {
        targetType: 'operation',
        target: 'ui.artifacts.get',
        input: {
          artifactId: 'ui-1',
          revision: 3,
          documentDigest: 'd'.repeat(64),
        },
      },
      expect.objectContaining({ workspacePath: 'C:/workspace' }),
    );
  });

  it('adapts portable dynamic render tools to standard MCP Apps tool/resource metadata', async () => {
    const resourceUri = `ui://marshal-react/${'a'.repeat(64)}/index.html`;
    const renderToolName = `marshal_render_react_${'b'.repeat(64)}`;
    const resources = {
      listResources: vi.fn(async () => [
        {
          uri: resourceUri,
          name: 'Impact graph',
          mimeType: 'text/html;profile=mcp-app',
        },
      ]),
      readResource: vi.fn(async (uri: string) => ({
        uri,
        mimeType: 'text/html;profile=mcp-app',
        text: '<!doctype html><div id="root"></div>',
      })),
      listTools: vi.fn(async () => [
        {
          name: renderToolName,
          title: 'Render impact graph',
          description: 'Render a prepared immutable React UI.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          _meta: {
            ui: { resourceUri, visibility: ['model', 'app'] },
            'ui/resourceUri': resourceUri,
          },
        },
      ]),
      callTool: vi.fn(async (name: string) =>
        name === renderToolName
          ? {
              content: [{ type: 'text' as const, text: '18 affected symbols' }],
              structuredContent: {
                props: { affected: 18 },
                fallback: { summary: '18 affected symbols' },
              },
            }
          : undefined,
      ),
    };
    const { client } = await connectTestRuntime({ resources });

    const tools = await client.listTools();
    const renderTool = tools.tools.find((tool) => tool.name === renderToolName);
    expect(renderTool?._meta).toEqual(
      expect.objectContaining({ ui: expect.objectContaining({ resourceUri }) }),
    );

    const rendered = await client.callTool({ name: renderToolName, arguments: {} });
    expect(rendered.content).toEqual([{ type: 'text', text: '18 affected symbols' }]);
    expect(rendered.structuredContent).toEqual({
      props: { affected: 18 },
      fallback: { summary: '18 affected symbols' },
    });
    expect(resources.callTool).toHaveBeenCalledWith(
      renderToolName,
      {},
      expect.objectContaining({ workspacePath: 'C:/workspace' }),
    );
  });

  it('advertises a stable compiled React renderer before renders exist and reuses render ids', async () => {
    const templateUri = 'ui://marshal-react/runtime-renderer';
    const renderId = 'c'.repeat(64);
    const result = {
      content: [{ type: 'text' as const, text: 'Reusable compiled interface' }],
      structuredContent: {
        props: { count: 42 },
        fallback: { summary: 'Reusable compiled interface' },
        render: { id: renderId, title: 'Counter' },
      },
      _meta: {
        marshal: { kind: 'compiled_react_ui', componentHtml: '<!doctype html><main id="root">' },
      },
    };
    const resources = {
      listResources: vi.fn(async () => []),
      readResource: vi.fn(),
      reactToolMetadata: vi.fn(() => ({
        ui: { resourceUri: templateUri, visibility: ['model', 'app'] },
        'ui/resourceUri': templateUri,
      })),
      callTool: vi.fn(async (name: string, input: Record<string, unknown>) =>
        name === 'runtime_render_component' && input.renderId === renderId
          ? result
          : undefined,
      ),
    };
    const { client } = await connectTestRuntime({ resources });

    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === 'runtime_render_component')).toEqual(
      expect.objectContaining({
        _meta: expect.objectContaining({ ui: expect.objectContaining({ resourceUri: templateUri }) }),
      }),
    );

    const first = await client.callTool({
      name: 'runtime_render_component',
      arguments: { renderId },
    });
    const second = await client.callTool({
      name: 'runtime_render_component',
      arguments: { renderId },
    });
    expect(first.content).toEqual(result.content);
    expect(first.structuredContent).toEqual(result.structuredContent);
    expect(second.structuredContent).toEqual(result.structuredContent);
    expect(resources.callTool).toHaveBeenCalledTimes(2);
  });

  it('keeps compiled bytes app-only while preserving bounded render metadata and fallback', async () => {
    const templateUri = 'ui://marshal-react/runtime-renderer/1.0.0/index.html';
    const renderId = 'd'.repeat(64);
    const componentId = 'e'.repeat(64);
    const componentHtml = `<!doctype html><main>${'compiled-javascript'.repeat(65_536)}</main>`;
    const publicResult = {
      content: [{ type: 'text' as const, text: 'Complete structured fallback' }],
      structuredContent: {
        props: { count: 42 },
        fallback: {
          summary: 'Complete structured fallback',
          details: { count: 42, actions: ['increment', 'reset'] },
        },
        render: {
          id: renderId,
          componentId,
          resourceUri: `ui://marshal-react/${componentId}/index.html`,
          title: 'Counter',
        },
        application: { version: '1.0.0', presentationModes: ['inline'], actions: [], tools: [] },
      },
      _meta: {
        marshal: {
          kind: 'compiled_react_ui',
          componentHtml,
          componentId,
          bundleDigest: 'f'.repeat(64),
        },
      },
    };
    const payloadResult = {
      content: [{ type: 'text' as const, text: 'Compiled React payload ready.' }],
      structuredContent: {
        ...publicResult.structuredContent,
        marshal: {
          ...publicResult._meta.marshal,
          storage: {},
          state: { local: { values: {} } },
        },
      },
    };
    const resources = {
      listResources: vi.fn(async () => []),
      readResource: vi.fn(),
      listTools: vi.fn(async () => [{
        name: 'marshal_get_react_payload',
        description: 'App-only compiled React hydration payload.',
        inputSchema: {
          type: 'object',
          properties: { renderId: { type: 'string' } },
          required: ['renderId'],
          additionalProperties: false,
        },
        _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
      }]),
      reactToolMetadata: vi.fn(() => ({
        ui: { resourceUri: templateUri, visibility: ['model', 'app'] },
        'ui/resourceUri': templateUri,
      })),
      callTool: vi.fn(async (name: string, input: Record<string, unknown>) => {
        if (input.renderId !== renderId) return undefined;
        if (name === 'runtime_render_component') return publicResult;
        if (name === 'marshal_get_react_payload') return payloadResult;
        return undefined;
      }),
    };
    const { client } = await connectTestRuntime({ resources });

    const displayed = await client.callTool({
      name: 'runtime_render_component',
      arguments: { renderId },
    });
    expect(displayed.content).toEqual(publicResult.content);
    expect(displayed.structuredContent).toEqual(publicResult.structuredContent);
    expect(displayed._meta).toBeUndefined();
    expect(JSON.stringify(displayed)).not.toContain('compiled-javascript');
    expect(Buffer.byteLength(JSON.stringify(displayed), 'utf8')).toBeLessThan(4_096);

    const hydrated = await client.callTool({
      name: 'marshal_get_react_payload',
      arguments: { renderId },
    });
    expect(hydrated.structuredContent).toEqual(payloadResult.structuredContent);
    expect(JSON.stringify(hydrated.structuredContent)).toContain(componentHtml);
    expect(Buffer.byteLength(JSON.stringify(hydrated), 'utf8')).toBeGreaterThan(1_000_000);
  });

  async function connectTestRuntime(
    overrides: Partial<Parameters<typeof createCodexMcpServer>[0]> = {},
    toolCallRequestId?: RequestId,
  ): Promise<{ client: Client; close: () => Promise<void> }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    if (toolCallRequestId !== undefined) {
      forceToolCallRequestId(clientTransport, serverTransport, toolCallRequestId);
    }
    const server = createCodexMcpServer({
      kernel: new InMemoryRuntimeKernel([]),
      defaultContext: { workspacePath: 'C:/workspace' },
      ...overrides,
    });
    const client = new Client({ name: 'adapter-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await client.close();
      await server.close();
    };
    closeCallbacks.push(close);
    return { client, close };
  }

  async function connectClientToServer(server: ReturnType<typeof createCodexMcpServer>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'adapter-reconnect-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  function forceToolCallRequestId(
    clientTransport: InMemoryTransport,
    serverTransport: InMemoryTransport,
    forcedRequestId: RequestId,
  ): void {
    const clientSend = clientTransport.send.bind(clientTransport);
    const serverSend = serverTransport.send.bind(serverTransport);
    const originalIds: RequestId[] = [];

    clientTransport.send = async (message, options) => {
      if ('method' in message && message.method === 'tools/call' && 'id' in message) {
        originalIds.push(message.id);
        await clientSend({ ...message, id: forcedRequestId }, options);
        return;
      }
      await clientSend(message, options);
    };
    serverTransport.send = async (message, options) => {
      if (
        !('method' in message) &&
        'id' in message &&
        message.id === forcedRequestId &&
        originalIds.length > 0
      ) {
        const originalId = originalIds.shift();
        if (originalId === undefined) throw new Error('Missing original JSON-RPC request id');
        await serverSend({ ...message, id: originalId }, options);
        return;
      }
      await serverSend(message, options);
    };
  }

  function correlationDigest(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected correlation metadata object');
    }
    if (!('digest' in value)) throw new Error('Expected correlation digest');
    const digest = value.digest;
    if (typeof digest !== 'string') throw new Error('Expected correlation digest');
    return digest;
  }

  function objectProperty(
    value: unknown,
    key: string,
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    const property = value[key];
    return isRecord(property) ? property : undefined;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function codexRequestMeta(sessionId: string, threadId: string, turnId: string) {
    return {
      threadId,
      'x-codex-turn-metadata': {
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
      },
    };
  }
});
