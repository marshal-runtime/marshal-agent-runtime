import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  RuntimeCallContext,
  RuntimeExecutionRequest,
  RuntimeKernelPort,
  RuntimeSearchRequest,
  RuntimeResourcePort,
  RuntimeLifecyclePort,
} from '@marshal/agent-runtime-host';

/** Host authority is fixed outside the model-visible tool arguments. */
export interface RuntimeMcpOptions {
  readonly kernel: RuntimeKernelPort;
  readonly context: Readonly<RuntimeCallContext> & { readonly sessionId: string };
  readonly name?: string;
  readonly version?: string;
  readonly resources?: RuntimeResourcePort;
  readonly lifecycle?: RuntimeLifecyclePort;
}

const string = { type: 'string', minLength: 1 } as const;
const moduleSchema = {
  type: 'object',
  properties: {
    kind: { enum: ['inline', 'workspace_file', 'artifact'] },
    source: string,
    path: string,
    scope: { enum: ['workspace', 'project', 'session'] },
    export: string,
  },
  required: ['kind'],
  oneOf: [
    { properties: { kind: { const: 'inline' } }, required: ['source'] },
    { properties: { kind: { const: 'workspace_file' } }, required: ['path'] },
    { properties: { kind: { const: 'artifact' } }, required: ['path'] },
  ],
  additionalProperties: false,
} as const;

/** Canonical portable requests only: no caller-supplied identity or legacy aliases. */
export const RUNTIME_MCP_TOOLS: readonly Tool[] = [
  {
    name: 'runtime_search',
    description: 'Discover Runtime capabilities. Search by query, then resolve the selected exact name for full schemas before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        protocolVersion: string,
        query: string,
        name: string,
        catalogId: string,
        detail: { enum: ['summary', 'full'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        tags: { type: 'array', items: string },
      },
      anyOf: [{ required: ['query'] }, { required: ['name'] }, { required: ['catalogId'] }],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  },
  {
    name: 'runtime_exec',
    description: 'Execute a discovered capability or brokered TypeScript. Use targetType=operation with target/input, inline_module with source/input, or module with module/input. Preserve the returned receipts and diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        protocolVersion: string,
        targetType: { enum: ['operation', 'inline_module', 'module'] },
        target: string,
        source: string,
        module: moduleSchema,
        input: {},
        timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 },
        executionMode: { enum: ['brokered', 'trusted_node'] },
        requestId: string,
        approval: { type: 'object', additionalProperties: true },
      },
      required: ['targetType'],
      oneOf: [
        { properties: { targetType: { const: 'operation' } }, required: ['target'] },
        { properties: { targetType: { const: 'inline_module' } }, required: ['source'] },
        { properties: { targetType: { const: 'module' } }, required: ['module'] },
      ],
      additionalProperties: false,
    },
  },
];

const SEARCH_TRACER_SLOT = Symbol.for('quillstone.searchTracer');
const TRACED_OPERATIONS: ReadonlySet<string> = new Set(['knowledge.search']);

type StageTimer = <Value>(stage: string, work: () => Promise<Value> | Value) => Promise<Value>;

interface TracedRequest {
  readonly targetType?: string;
  readonly target?: string;
  readonly input?: Record<string, unknown>;
}

interface SearchTracer {
  traceSearch<Value>(label: string, query: string, run: () => Promise<Value>): Promise<Value>;
  timed<Value>(stage: string, work: () => Promise<Value> | Value): Promise<Value>;
  stageClock(): number;
  endStage(stage: string, startedAt: number | undefined): void;
}

const untimed: StageTimer = async (_stage, work) => work();

/** Times a runtime_exec of a search operation as one search when QUILLSTONE_SEARCH_TIMING=1, with the tracer the Quillstone search module publishes; everything else runs as it is. */
function traceRuntimeExec<Value>(
  name: string,
  request: TracedRequest,
  run: (stage: StageTimer) => Promise<Value>,
): Promise<Value> {
  const tracer = (globalThis as Record<symbol, SearchTracer | undefined>)[SEARCH_TRACER_SLOT];
  if (
    tracer === undefined ||
    name !== 'runtime_exec' ||
    request.targetType !== 'operation' ||
    !TRACED_OPERATIONS.has(request.target ?? '')
  ) {
    return run(untimed);
  }
  const query = typeof request.input?.query === 'string' ? request.input.query : '';
  return tracer.traceSearch('runtime.exec', query, async () => {
    const since = performance.now();
    try {
      return await run((stage, work) => tracer.timed(stage, work));
    } finally {
      const lag = maxLoopLagSince(since);
      if (lag > 0) tracer.endStage('eventLoopLagMax', tracer.stageClock() - lag);
    }
  });
}

const LOOP_LAG_RESOLUTION_MS = 20;
const LOOP_LAG_MIN_MS = 5;
const LOOP_LAG_SAMPLES = 4096;
const loopLags: [number, number][] = [];
let loopLagLast = performance.now();
setInterval(() => {
  const now = performance.now();
  const lag = now - loopLagLast - LOOP_LAG_RESOLUTION_MS;
  loopLagLast = now;
  if (lag < LOOP_LAG_MIN_MS) return;
  loopLags.push([now, lag]);
  if (loopLags.length > LOOP_LAG_SAMPLES) loopLags.shift();
}, LOOP_LAG_RESOLUTION_MS).unref();

/** The longest stall of the event loop since the performance.now() reading given, in milliseconds; 0 when it never stalled by 5 ms. */
function maxLoopLagSince(since: number): number {
  let longest = 0;
  for (const [at, lag] of loopLags) if (at >= since && lag > longest) longest = lag;
  return longest;
}

/** The same transport edge works with any host composition and any MCP client. */
export function createRuntimeToolAdapter(options: RuntimeMcpOptions) {
  if (!options.context.sessionId.trim()) throw new Error('A trusted sessionId is required.');
  const context = Object.freeze({ ...options.context });
  const validator = new AjvJsonSchemaValidator();
  const validators = new Map(RUNTIME_MCP_TOOLS.map((tool) => [
    tool.name, validator.getValidator(tool.inputSchema),
  ]));
  const callContext = (signal?: AbortSignal): RuntimeCallContext => ({
    ...context, requestId: randomUUID(), signal,
  });
  const sessionRequest = <T extends { sessionId: string }>(request: T): T => {
    if (request.sessionId !== context.sessionId) throw new Error('Lifecycle event belongs to another session.');
    return request;
  };
  return {
    async listTools(): Promise<Tool[]> {
      const nativeTools = await options.resources?.listTools?.(callContext()) ?? [];
      return [...RUNTIME_MCP_TOOLS, ...nativeTools.filter((tool) => !validators.has(tool.name))] as Tool[];
    },
    async callTool(name: string, input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
      const validate = validators.get(name);
      if (!validate) {
        const native = await options.resources?.callTool?.(name, (input ?? {}) as Record<string, unknown>, callContext(signal));
        if (native) return { ...native };
        throw new McpError(ErrorCode.InvalidParams, 'Unknown Runtime tool.');
      }
      const checked = validate(input ?? {});
      if (!checked.valid) throw new McpError(ErrorCode.InvalidParams, checked.errorMessage);
      return traceRuntimeExec(name, checked.data as unknown as TracedRequest, async (stage) => {
        const result = await stage('execute', async () => name === 'runtime_search'
          ? await options.kernel.search(checked.data as RuntimeSearchRequest, callContext(signal))
          : await options.kernel.execute(checked.data as RuntimeExecutionRequest, callContext(signal)));
        return stage('serialize', () => {
          const serialized = JSON.stringify(result);
          return {
            content: [{ type: 'text' as const, text: serialized }],
            structuredContent: JSON.parse(serialized) as Record<string, unknown>,
            ...('status' in result && result.status !== 'success' ? { isError: true } : {}),
          };
        });
      });
    },
    async listResources() { return { resources: [...await options.resources?.listResources(callContext()) ?? []] }; },
    async readResource(uri: string) {
      if (!options.resources) throw new McpError(ErrorCode.InvalidParams, 'Resources are unsupported.');
      return { contents: [await options.resources.readResource(uri, callContext())] };
    },
    ...(options.lifecycle ? { lifecycle: {
      startSession: (request: Parameters<RuntimeLifecyclePort['startSession']>[0]) =>
        options.lifecycle!.startSession(sessionRequest(request)),
      observeTurn: (request: Parameters<RuntimeLifecyclePort['observeTurn']>[0]) =>
        options.lifecycle!.observeTurn(sessionRequest(request)),
      endSession: (request: Parameters<RuntimeLifecyclePort['endSession']>[0]) =>
        options.lifecycle!.endSession(sessionRequest(request)),
    } } : {}),
  };
}

export function createRuntimeMcpServer(options: RuntimeMcpOptions): Server {
  const adapter = createRuntimeToolAdapter(options);
  const server = new Server(
    { name: options.name ?? 'marshal-runtime', version: options.version ?? '0.1.0' },
    {
      capabilities: { tools: {}, ...(options.resources ? { resources: {} } : {}) },
      instructions: 'Use runtime_search to discover capabilities and resolve exact schemas; invoke them with runtime_exec. Identity, workspace and permissions belong to the host. Native UI, hooks and other host features are supplied by the harness separately.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await adapter.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    return adapter.callTool(request.params.name, request.params.arguments, extra.signal);
  });
  if (options.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, () => adapter.listResources());
    server.setRequestHandler(ReadResourceRequestSchema, (request) => adapter.readResource(request.params.uri));
  }
  return server;
}
