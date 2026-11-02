import { createHash, randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  createRuntimeExecutionCorrelation,
  createRuntimeReceiptCorrelationContext,
  type RuntimeExecutionCorrelation,
  type RuntimeExecutionCorrelationName,
} from '@marshal/agent-runtime-core';
import { projectMcpServerInstructions } from '@marshal/agent-runtime-manifest';
import type {
  JsonObject,
  RuntimeAdapterBindings,
  RuntimeCallContext,
  RuntimeExecutionRequest,
  RuntimeObservationKind,
  RuntimeSearchRequest,
  RuntimeSessionEndRequest,
  RuntimeSessionStartRequest,
  RuntimeTurnObservation,
} from './ports.js';
import {
  createRuntimeRenderComponentTool,
  createRuntimeRenderUiTool,
  RUNTIME_TOOLS,
} from './protocol.js';
import {
  callExtensionManagementTool,
  extensionManagementResource,
  extensionManagementTools,
  isExtensionManagementResource,
  readExtensionManagementResource,
  type CodexExtensionManagementBindings,
} from './extensionManagement.js';

export const CODEX_ADAPTER_NAME = 'agent-runtime-codex';
export const CODEX_ADAPTER_VERSION = '0.1.0';
export const CODEX_MCP_INSTRUCTIONS = projectMcpServerInstructions({
  discovery: 'runtime_search',
  execution: 'runtime_exec',
  renderComponent: 'runtime_render_component',
  extensionManager: 'runtime_extensions_manage',
});
const DEFAULT_RUNTIME_PROTOCOL_VERSION = '1.0.0';
const MAX_CONTEXT_IDENTIFIER_LENGTH = 512;
const MAX_CONTEXT_PATH_LENGTH = 4_096;
const MAX_BOUND_CALL_CONTEXTS = 256;
const RESERVED_CALLER_METADATA_KEYS = new Set([
  'source',
  'mcpRequestId',
  'mcpRequestIdAuthority',
  'mcpTransportSessionId',
  'codexSessionId',
  'codexThreadId',
  'codexTurnId',
  'codexIdentitySource',
  'codexToolUseId',
  'codexToolUseIdAuthority',
  'codexPreToolClaim',
  'callerRequestId',
  'callerRequestIdAuthority',
]);

export interface CreateCodexMcpServerOptions extends RuntimeAdapterBindings {
  serverName?: string;
  serverVersion?: string;
  defaultContext?: RuntimeCallContext;
  /** Hide lifecycle tools from model discovery when native host hooks own those events. */
  exposeLifecycleTools?: boolean;
}

interface ActiveSession {
  sessionId: string;
  threadId?: string;
  agentId?: string;
  workspacePath?: string;
}

interface McpHandlerExtra {
  signal?: AbortSignal;
  requestId?: unknown;
  sessionId?: string;
  _meta?: Record<string, unknown>;
}

interface CodexMcpInvocationIdentity {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
}

const CODEX_TURN_METADATA_KEY = 'x-codex-turn-metadata';

export function createCodexMcpServer(options: CreateCodexMcpServerOptions): Server {
  const server = new Server(
    {
      name: options.serverName ?? CODEX_ADAPTER_NAME,
      version: options.serverVersion ?? CODEX_ADAPTER_VERSION,
    },
    {
      capabilities: {
        tools: options.resources?.listTools || options.extensionStatus ? { listChanged: true } : {},
        ...(options.resources || options.extensionStatus ? { resources: { listChanged: true } } : {}),
      },
      instructions: CODEX_MCP_INSTRUCTIONS,
    },
  );
  const activeSessions = new Map<string, ActiveSession>();
  const boundCallContexts = new Map<string, RuntimeCallContext>();
  const extensionManagement: CodexExtensionManagementBindings | undefined = options.extensionStatus
    ? {
        status: options.extensionStatus,
        ...(options.extensionLifecycle ? { lifecycle: options.extensionLifecycle } : {}),
        ...(options.extensionAutopilot ? { autopilot: options.extensionAutopilot } : {}),
      }
    : undefined;
  server.onclose = () => {
    activeSessions.clear();
    boundCallContexts.clear();
  };
  const splitToolCallContext = (
    args: JsonObject,
    extra: McpHandlerExtra,
  ): { request: JsonObject; context: RuntimeCallContext } => {
    const resolved = splitCallContext(
      args,
      options.defaultContext,
      activeSessions,
      extra,
    );
    if (resolved.context.sessionId) {
      rememberBoundCallContext(boundCallContexts, resolved.context);
    }
    return resolved;
  };
  const passiveCallContext = (extra: McpHandlerExtra): RuntimeCallContext => {
    const bound = boundCallContexts.size === 1
      ? boundCallContexts.values().next().value
      : undefined;
    return splitCallContext(
      {},
      bound ?? options.defaultContext,
      activeSessions,
      extra,
    ).context;
  };
  const modelFacingRuntimeTools = options.exposeLifecycleTools === false
    ? RUNTIME_TOOLS.filter((tool) => !isLifecycleTool(tool.name))
    : RUNTIME_TOOLS;
  const tools = [
    ...modelFacingRuntimeTools,
    ...(extensionManagement ? extensionManagementTools() : []),
    ...(options.resources?.toolMetadata
      ? [createRuntimeRenderUiTool(options.resources.toolMetadata())]
      : []),
    ...(options.resources?.reactToolMetadata
      ? [createRuntimeRenderComponentTool(options.resources.reactToolMetadata())]
      : []),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const context = passiveCallContext(extra);
    const resourceTools = options.resources?.listTools
      ? await options.resources.listTools(context)
      : [];
    assertUniqueResourceTools(tools, resourceTools);
    return { tools: [...tools, ...resourceTools] };
  });
  if (options.resources || extensionManagement) {
    server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
      const context = passiveCallContext(extra);
      return {
        resources: [
          ...(options.resources ? await options.resources.listResources(context) : []),
          ...(extensionManagement ? [extensionManagementResource()] : []),
        ],
      };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const context = passiveCallContext(extra);
      const content = extensionManagement && isExtensionManagementResource(request.params.uri)
        ? await readExtensionManagementResource(extensionManagement)
        : options.resources
          ? await options.resources.readResource(request.params.uri, context)
          : (() => { throw new Error(`Runtime resource not found: ${request.params.uri}`); })();
      return { contents: [content] };
    });
  }
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = asObject(request.params.arguments);

    try {
      switch (name) {
        case 'runtime_search': {
          const query = optionalNonEmptyString(args.query, 'runtime_search.query');
          const exactName = optionalNonEmptyString(args.name, 'runtime_search.name');
          const catalogId = optionalNonEmptyString(args.catalogId, 'runtime_search.catalogId');
          const detail = optionalSearchDetail(args.detail);
          if (!query && !exactName && !catalogId) {
            throw new Error('runtime_search requires query, name, or catalogId');
          }
          const { context, request: searchRequest } = splitToolCallContext(
            {
              ...args,
              protocolVersion: normalizeProtocolVersion(args.protocolVersion),
              ...(query ? { query } : {}),
              ...(exactName ? { name: exactName } : {}),
              ...(catalogId ? { catalogId } : {}),
              ...(detail ? { detail } : {}),
              ...(args.tags !== undefined || args.kinds !== undefined
                ? { tags: args.tags ?? args.kinds }
                : {}),
            },
            extra,
          );
          delete searchRequest.kinds;
          return successResult(
            await options.kernel.search(searchRequest as RuntimeSearchRequest, context),
          );
        }
        case 'runtime_exec': {
          const { context, request: executionRequest } = splitToolCallContext(
            args,
            extra,
          );
          const normalizedExecutionRequest = normalizeExecutionRequest(executionRequest);
          const result = await options.kernel.execute(normalizedExecutionRequest, context);
          if (options.resources) {
            if (
              normalizedExecutionRequest.targetType === 'operation' &&
              normalizedExecutionRequest.target === 'ui.compile'
            ) {
              await server.sendResourceListChanged();
            }
            if (
              options.resources.listTools &&
              normalizedExecutionRequest.targetType === 'operation' &&
              normalizedExecutionRequest.target === 'ui.render'
            ) {
              await server.sendToolListChanged();
            }
          }
          return successResult(result);
        }
        case 'runtime_render_ui': {
          if (!options.resources) throw new Error('Runtime UI resources are not configured');
          const artifactId = requireNonEmptyString(
            args.artifactId,
            'runtime_render_ui.artifactId',
          );
          if (!Number.isSafeInteger(args.revision) || (args.revision as number) < 1) {
            throw new Error('runtime_render_ui.revision must be a positive integer');
          }
          const revision = args.revision as number;
          const documentDigest = requireNonEmptyString(
            args.documentDigest,
            'runtime_render_ui.documentDigest',
          );
          if (!/^[a-f0-9]{64}$/.test(documentDigest)) {
            throw new Error('runtime_render_ui.documentDigest must be a SHA-256 digest');
          }
          const { context } = splitToolCallContext(
            args,
            extra,
          );
          const execution = await options.kernel.execute(
            {
              targetType: 'operation',
              target: 'ui.artifacts.get',
              input: { artifactId, revision, documentDigest },
            },
            context,
          );
          return uiResult(execution);
        }
        case 'runtime_render_component': {
          if (!options.resources?.callTool) {
            throw new Error('Compiled React UI resources are not configured');
          }
          const renderId = requireNonEmptyString(
            args.renderId,
            'runtime_render_component.renderId',
          );
          if (!/^[a-f0-9]{64}$/.test(renderId)) {
            throw new Error('runtime_render_component.renderId must be a SHA-256 identifier');
          }
          const { context } = splitToolCallContext(
            args,
            extra,
          );
          const rendered = await options.resources.callTool(
            name,
            { renderId },
            context,
          );
          if (!rendered) throw new Error(`Compiled React UI render ${renderId} was not found`);
          return modelSafeResourceToolResult(rendered as CallToolResult);
        }
        case 'runtime_extensions_manage':
        case 'runtime_extensions_action': {
          if (!extensionManagement) throw new Error('Runtime extension management is not configured');
          const managed = await callExtensionManagementTool(
            extensionManagement,
            name,
            args,
            extra.signal,
          );
          if (!managed) throw new Error(`Unknown runtime extension management tool: ${name}`);
          return modelSafeResourceToolResult(managed as CallToolResult);
        }
        case 'runtime_session_start': {
          const sessionId = bindIdentifier(
            optionalNonEmptyString(args.sessionId, 'runtime_session_start.sessionId') ??
              randomUUID(),
            options.defaultContext?.sessionId,
            'runtime_session_start.sessionId',
          )!;
          const existing = activeSessions.get(sessionId);
          const threadId = bindIdentifier(
            optionalString(args.threadId),
            existing?.threadId ?? options.defaultContext?.threadId,
            'runtime_session_start.threadId',
          );
          const agentId = bindIdentifier(
            optionalString(args.agentId),
            existing?.agentId ?? options.defaultContext?.agentId,
            'runtime_session_start.agentId',
          );
          const workspacePath = bindWorkspacePath(
            optionalString(args.workspacePath),
            existing?.workspacePath ?? options.defaultContext?.workspacePath,
            'runtime_session_start.workspacePath',
          );
          const startRequest: RuntimeSessionStartRequest = {
            protocolVersion: normalizeProtocolVersion(args.protocolVersion),
            eventId: lifecycleEventId(args, 'session_start', sessionId),
            sessionId,
            ...(threadId ? { threadId } : {}),
            ...(agentId ? { agentId } : {}),
            ...(workspacePath ? { workspacePath } : {}),
            ...(modelSafeLifecycleMetadata(args.metadata) === undefined
              ? {}
              : { metadata: modelSafeLifecycleMetadata(args.metadata) }),
          };
          const lifecycleResult = options.lifecycle
            ? await options.lifecycle.startSession(startRequest)
            : undefined;
          activeSessions.set(sessionId, {
            sessionId,
            threadId,
            agentId: startRequest.agentId,
            workspacePath: startRequest.workspacePath,
          });
          return successResult({
            sessionId,
            observed: Boolean(options.lifecycle),
            lifecycleResult,
          });
        }
        case 'runtime_observe_turn': {
          const sessionId = resolveSessionId(
            args.sessionId,
            activeSessions,
            options.defaultContext?.sessionId,
          );
          const activeSession = activeSessions.get(sessionId);
          const kind = assertObservationKind(args.kind);
          if (!('content' in args)) {
            throw new Error('runtime_observe_turn.content is required');
          }
          const observation: RuntimeTurnObservation = {
            ...args,
            protocolVersion: normalizeProtocolVersion(args.protocolVersion),
            eventId: lifecycleEventId(args, kind, sessionId),
            sessionId,
            kind,
            content: args.content,
            toolName: optionalString(args.toolName),
            agentId: bindIdentifier(
              optionalString(args.agentId),
              activeSession?.agentId ?? options.defaultContext?.agentId,
              'runtime_observe_turn.agentId',
            ),
            workspacePath: bindWorkspacePath(
              optionalString(args.workspacePath),
              activeSession?.workspacePath ?? options.defaultContext?.workspacePath,
              'runtime_observe_turn.workspacePath',
            ),
            metadata: optionalObject(args.metadata),
          };
          const lifecycleResult = options.lifecycle
            ? await options.lifecycle.observeTurn(observation)
            : undefined;
          return successResult({
            sessionId,
            observed: Boolean(options.lifecycle),
            lifecycleResult,
          });
        }
        case 'runtime_session_end': {
          const sessionId = resolveSessionId(
            args.sessionId,
            activeSessions,
            options.defaultContext?.sessionId,
          );
          const endRequest: RuntimeSessionEndRequest = {
            ...args,
            protocolVersion: normalizeProtocolVersion(args.protocolVersion),
            eventId: lifecycleEventId(args, 'session_end', sessionId),
            sessionId,
            outcome: optionalString(args.outcome),
            metadata: optionalObject(args.metadata),
          };
          const endedSession = activeSessions.get(sessionId) ?? { sessionId };
          let lifecycleResult: unknown;
          try {
            lifecycleResult = options.lifecycle
              ? await options.lifecycle.endSession(endRequest)
              : undefined;
          } finally {
            activeSessions.delete(sessionId);
            invalidateBoundCallContexts(
              boundCallContexts,
              activeSessions,
              endedSession,
            );
          }
          return successResult({
            sessionId,
            observed: Boolean(options.lifecycle),
            lifecycleResult,
          });
        }
        default:
          if (name.startsWith('runtime_')) {
            throw new Error(`Reserved runtime MCP tool is not registered: ${name}`);
          }
          if (options.resources?.callTool) {
            const { context, request: resourceToolInput } = splitToolCallContext(
              args,
              extra,
            );
            const resourceToolResult = await options.resources.callTool(
              name,
              resourceToolInput,
              context,
            );
            if (resourceToolResult) {
              return modelSafeResourceToolResult(resourceToolResult as CallToolResult);
            }
          }
          throw new Error(`Unknown runtime MCP tool: ${name}`);
      }
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}

function rememberBoundCallContext(
  boundCallContexts: Map<string, RuntimeCallContext>,
  context: RuntimeCallContext,
): void {
  const sessionId = context.sessionId;
  if (!sessionId) return;
  if (
    !boundCallContexts.has(sessionId) &&
    boundCallContexts.size >= MAX_BOUND_CALL_CONTEXTS
  ) {
    throw new Error(
      `Too many bound runtime call contexts; maximum is ${MAX_BOUND_CALL_CONTEXTS}.`,
    );
  }
  boundCallContexts.set(sessionId, {
    sessionId,
    threadId: context.threadId,
    agentId: context.agentId,
    workspacePath: context.workspacePath,
    metadata: {
      source: 'bound-mcp-call-context',
      codexSessionId: sessionId,
      codexThreadId: context.threadId,
    },
  });
}

function invalidateBoundCallContexts(
  boundCallContexts: Map<string, RuntimeCallContext>,
  activeSessions: ReadonlyMap<string, ActiveSession>,
  endedSession: ActiveSession,
): void {
  for (const [key, context] of boundCallContexts) {
    const sameSession =
      key === endedSession.sessionId ||
      context.sessionId === endedSession.sessionId;
    const staleThreadAlias =
      Boolean(endedSession.threadId) &&
      context.threadId === endedSession.threadId &&
      !activeSessions.has(key);
    if (sameSession || staleThreadAlias) boundCallContexts.delete(key);
  }
}

function isLifecycleTool(name: string): boolean {
  return name === 'runtime_session_start' ||
    name === 'runtime_observe_turn' ||
    name === 'runtime_session_end';
}

export async function connectCodexMcpServer(
  options: CreateCodexMcpServerOptions,
  transport: Transport,
): Promise<Server> {
  const server = createCodexMcpServer(options);
  await server.connect(transport);
  return server;
}

function splitCallContext(
  args: JsonObject,
  defaults: RuntimeCallContext | undefined,
  activeSessions: ReadonlyMap<string, ActiveSession>,
  extra: McpHandlerExtra = {},
): { request: JsonObject; context: RuntimeCallContext } {
  const { context: rawContext, ...request } = args;
  const explicit = optionalObject(rawContext);
  const explicitMetadata = optionalObject(explicit?.metadata);
  const codexIdentity = codexMcpInvocationIdentity(extra._meta);
  const claimedSessionId = optionalBoundedString(
    explicit?.sessionId,
    'context.sessionId',
    MAX_CONTEXT_IDENTIFIER_LENGTH,
  );
  const authoritativeSessionId = selectSessionId(
    claimedSessionId && activeSessions.has(claimedSessionId)
      ? claimedSessionId
      : undefined,
    activeSessions,
    codexIdentity.sessionId ?? defaults?.sessionId,
    false,
  );
  const sessionId = bindClaimedIdentifier(
    claimedSessionId,
    authoritativeSessionId,
    'context.sessionId',
  );
  const activeSession = sessionId ? activeSessions.get(sessionId) : undefined;
  const mcpRequestId = auditCorrelationId(
    extra.requestId,
    'mcpRequestId',
    'MCP request id',
  );
  const callerRequestId = auditCorrelationId(
    explicit?.requestId,
    'callerRequestId',
    'context.requestId',
  );
  const codexToolUseId = auditCorrelationId(
    claimedCodexToolUseId(explicitMetadata),
    'codexToolUseId',
    'Codex tool-use id',
  );
  const correlations = [mcpRequestId, callerRequestId, codexToolUseId]
    .filter((correlation): correlation is RuntimeExecutionCorrelation => Boolean(correlation));
  const receiptCorrelationContext = createRuntimeReceiptCorrelationContext(correlations);
  return {
    request,
    context: {
      ...defaults,
      sessionId,
      threadId: bindClaimedIdentifier(
        optionalBoundedString(
          explicit?.threadId,
          'context.threadId',
          MAX_CONTEXT_IDENTIFIER_LENGTH,
        ),
        codexIdentity.threadId ?? activeSession?.threadId ?? defaults?.threadId,
        'context.threadId',
      ),
      agentId: bindClaimedIdentifier(
        optionalBoundedString(
          explicit?.agentId,
          'context.agentId',
          MAX_CONTEXT_IDENTIFIER_LENGTH,
        ),
        activeSession?.agentId ?? defaults?.agentId,
        'context.agentId',
      ),
      workspacePath: bindClaimedWorkspacePath(
        optionalBoundedString(
          explicit?.workspacePath,
          'context.workspacePath',
          MAX_CONTEXT_PATH_LENGTH,
        ),
        activeSession?.workspacePath ?? defaults?.workspacePath,
        'context.workspacePath',
      ),
      requestId: randomUUID(),
      signal: extra.signal ?? defaults?.signal,
      ...(receiptCorrelationContext ? { receiptCorrelationContext } : {}),
      metadata: {
        ...(defaults?.metadata ?? {}),
        ...sanitizeCallerMetadata(explicitMetadata),
        ...(mcpRequestId
          ? {
              mcpRequestId: correlationMetadata(mcpRequestId),
              mcpRequestIdAuthority: 'transport-correlation',
            }
          : {}),
        ...(callerRequestId
          ? {
              callerRequestId: correlationMetadata(callerRequestId),
              callerRequestIdAuthority: 'untrusted-correlation',
            }
          : {}),
        ...(codexToolUseId
          ? {
              codexToolUseId: correlationMetadata(codexToolUseId),
              codexToolUseIdAuthority: 'untrusted-correlation',
            }
          : {}),
        ...(extra.sessionId
          ? {
              mcpTransportSessionId: optionalBoundedString(
                extra.sessionId,
                'MCP transport session id',
                MAX_CONTEXT_IDENTIFIER_LENGTH,
              ),
            }
          : {}),
        ...(codexIdentity.sessionId
          ? { codexSessionId: codexIdentity.sessionId }
          : {}),
        ...(codexIdentity.threadId
          ? { codexThreadId: codexIdentity.threadId }
          : {}),
        ...(codexIdentity.turnId
          ? { codexTurnId: codexIdentity.turnId }
          : {}),
        ...(codexIdentity.sessionId || codexIdentity.threadId
          ? { codexIdentitySource: 'mcp-request-meta' }
          : {}),
      },
    },
  };
}

function codexMcpInvocationIdentity(
  rawMeta: Record<string, unknown> | undefined,
): CodexMcpInvocationIdentity {
  if (!rawMeta) return {};

  const transportThreadId = optionalCodexMetadataId(
    rawMeta.threadId,
    '_meta.threadId',
  );
  const rawTurnMetadata = rawMeta[CODEX_TURN_METADATA_KEY];
  if (rawTurnMetadata !== undefined && !isObject(rawTurnMetadata)) {
    throw new Error(`_meta.${CODEX_TURN_METADATA_KEY} must be an object`);
  }
  const turnMetadata = optionalObject(rawTurnMetadata);
  const metadataSessionId = optionalCodexMetadataId(
    turnMetadata?.session_id,
    `_meta.${CODEX_TURN_METADATA_KEY}.session_id`,
  );
  const metadataThreadId = optionalCodexMetadataId(
    turnMetadata?.thread_id,
    `_meta.${CODEX_TURN_METADATA_KEY}.thread_id`,
  );
  const turnId = optionalCodexMetadataId(
    turnMetadata?.turn_id,
    `_meta.${CODEX_TURN_METADATA_KEY}.turn_id`,
  );

  if (
    transportThreadId &&
    metadataThreadId &&
    transportThreadId !== metadataThreadId
  ) {
    throw new Error('Codex MCP request metadata contains conflicting thread identities.');
  }
  const threadId = metadataThreadId ?? transportThreadId;
  return {
    sessionId: metadataSessionId ?? threadId,
    threadId,
    turnId,
  };
}

function optionalCodexMetadataId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const result = requireNonEmptyString(value, field);
  if (result.length > MAX_CONTEXT_IDENTIFIER_LENGTH) {
    throw new Error(`${field} must be at most ${MAX_CONTEXT_IDENTIFIER_LENGTH} characters`);
  }
  return result;
}

function auditCorrelationId(
  value: unknown,
  name: RuntimeExecutionCorrelationName,
  label: string,
): RuntimeExecutionCorrelation | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
    return createRuntimeExecutionCorrelation(name, value);
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string or safe integer`);
  }
  return createRuntimeExecutionCorrelation(name, value);
}

function correlationMetadata(correlation: RuntimeExecutionCorrelation): JsonObject {
  if (correlation.type === 'number' || correlation.type === 'string') {
    return { type: correlation.type, value: correlation.value };
  }
  return {
    type: correlation.type,
    algorithm: correlation.algorithm,
    digest: correlation.digest,
    originalType: correlation.originalType,
    length: correlation.length,
  };
}

function claimedCodexToolUseId(metadata: JsonObject | undefined): unknown {
  const claim = optionalObject(metadata?.codexPreToolClaim);
  return claim?.toolUseId ?? metadata?.codexToolUseId;
}

function sanitizeCallerMetadata(metadata: JsonObject | undefined): JsonObject {
  if (!metadata) return {};
  const sanitized: JsonObject = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!RESERVED_CALLER_METADATA_KEYS.has(key)) sanitized[key] = value;
  }
  return sanitized;
}

function assertUniqueResourceTools(
  coreTools: readonly { name: string }[],
  resourceTools: readonly { name: string }[],
): void {
  const names = new Set(coreTools.map((tool) => tool.name));
  for (const tool of resourceTools) {
    if (tool.name.startsWith('runtime_') || names.has(tool.name)) {
      throw new Error(`Resource tool name is reserved or duplicated: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

function normalizeExecutionRequest(request: JsonObject): RuntimeExecutionRequest {
  const normalizedRequest = { ...request };
  delete normalizedRequest.requestId;
  const protocolVersion = normalizeProtocolVersion(normalizedRequest.protocolVersion);
  if (normalizedRequest.targetType === undefined) {
    const target = requireNonEmptyString(
      normalizedRequest.operation ?? normalizedRequest.target,
      'runtime_exec.operation',
    );
    return { ...normalizedRequest, protocolVersion, targetType: 'operation', target };
  }
  const targetType = requireNonEmptyString(
    normalizedRequest.targetType,
    'runtime_exec.targetType',
  );
  if (['workflow', 'stage', 'lambda'].includes(targetType)) {
    throw new Error(
      `runtime_exec targetType '${targetType}' is intentionally unsupported; use 'operation', 'inline_module', or 'module'`,
    );
  }
  if (targetType === 'operation') {
    requireNonEmptyString(normalizedRequest.target, 'runtime_exec.target');
    return { ...normalizedRequest, protocolVersion } as unknown as RuntimeExecutionRequest;
  }
  if (targetType === 'inline_module') {
    requireNonEmptyString(normalizedRequest.source, 'runtime_exec.source');
    return { ...normalizedRequest, protocolVersion } as unknown as RuntimeExecutionRequest;
  }
  if (targetType === 'module') {
    const module = optionalObject(normalizedRequest.module);
    if (!module) throw new Error('runtime_exec.module must be an object');
    const kind = requireNonEmptyString(module.kind, 'runtime_exec.module.kind');
    if (kind === 'inline') {
      requireNonEmptyString(module.source, 'runtime_exec.module.source');
      return { ...normalizedRequest, protocolVersion } as unknown as RuntimeExecutionRequest;
    }
    if (kind === 'workspace_file' || kind === 'artifact') {
      requireNonEmptyString(module.path, 'runtime_exec.module.path');
      return { ...normalizedRequest, protocolVersion } as unknown as RuntimeExecutionRequest;
    }
    throw new Error(
      "runtime_exec.module.kind must be 'inline', 'workspace_file', or 'artifact'",
    );
  }
  throw new Error(
    "runtime_exec.targetType must be 'operation', 'inline_module', or 'module'",
  );
}

function normalizeProtocolVersion(value: unknown): string {
  if (value === undefined) return DEFAULT_RUNTIME_PROTOCOL_VERSION;
  const version = requireNonEmptyString(value, 'protocolVersion');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw Object.assign(new Error(`Invalid runtime protocol version: ${version}`), {
      code: 'invalid_protocol_version',
    });
  }
  if (Number(match[1]) !== 1) {
    throw Object.assign(new Error(`Unsupported runtime protocol major version: ${version}`), {
      code: 'unsupported_protocol_version',
    });
  }
  return version;
}

function lifecycleEventId(args: JsonObject, kind: string, sessionId: string): string {
  const configured = optionalNonEmptyString(args.eventId, 'eventId');
  if (configured) {
    if (configured.length > 512) throw new Error('eventId must be at most 512 characters');
    return configured;
  }
  const digest = createHash('sha256')
    .update(stableJson({ kind, sessionId, args }))
    .digest('hex');
  return `mcp-${digest}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function assertObservationKind(value: unknown): RuntimeObservationKind {
  if (value === 'user_message' || value === 'tool_result' || value === 'assistant_turn') {
    return value;
  }
  throw new Error(
    "runtime_observe_turn.kind must be 'user_message', 'tool_result', or 'assistant_turn'",
  );
}

function resolveSessionId(
  value: unknown,
  activeSessions: ReadonlyMap<string, ActiveSession>,
  defaultSessionId: string | undefined,
): string {
  return (
    selectSessionId(
      optionalNonEmptyString(value, 'sessionId'),
      activeSessions,
      defaultSessionId,
      true,
    ) ?? failNoActiveSession()
  );
}

function selectSessionId(
  explicit: string | undefined,
  activeSessions: ReadonlyMap<string, ActiveSession>,
  configured: string | undefined,
  required: boolean,
): string | undefined {
  if (explicit) {
    const bound = bindIdentifier(explicit, configured, 'context.sessionId');
    if (activeSessions.size > 0 && !activeSessions.has(bound!)) {
      throw new Error(`context.sessionId does not identify an active task: ${bound}`);
    }
    return bound;
  }
  if (configured) return configured;
  if (activeSessions.size === 1) return activeSessions.values().next().value?.sessionId;
  if (activeSessions.size > 1) {
    throw new Error('Multiple runtime sessions are active; provide an explicit context.sessionId.');
  }
  return required ? failNoActiveSession() : undefined;
}

function bindIdentifier(
  explicit: string | undefined,
  authoritative: string | undefined,
  label: string,
): string | undefined {
  if (explicit && authoritative && explicit !== authoritative) {
    throw new Error(`${label} cannot override the configured task identity.`);
  }
  return authoritative ?? explicit;
}

function bindClaimedIdentifier(
  explicit: string | undefined,
  authoritative: string | undefined,
  label: string,
): string | undefined {
  if (explicit && authoritative && explicit !== authoritative) {
    throw new Error(`${label} cannot override the adapter-owned task identity.`);
  }
  return authoritative;
}

function bindWorkspacePath(
  explicit: string | undefined,
  authoritative: string | undefined,
  label: string,
): string | undefined {
  if (
    explicit &&
    authoritative &&
    normalizeWorkspacePath(explicit) !== normalizeWorkspacePath(authoritative)
  ) {
    throw new Error(`${label} cannot override the configured workspace.`);
  }
  return authoritative ?? explicit;
}

function bindClaimedWorkspacePath(
  explicit: string | undefined,
  authoritative: string | undefined,
  label: string,
): string | undefined {
  if (
    explicit &&
    authoritative &&
    normalizeWorkspacePath(explicit) !== normalizeWorkspacePath(authoritative)
  ) {
    throw new Error(`${label} cannot override the adapter-owned workspace.`);
  }
  return authoritative;
}

function normalizeWorkspacePath(value: string): string {
  const normalized = resolvePath(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function failNoActiveSession(): never {
  throw new Error('No active runtime session; call runtime_session_start or provide sessionId');
}

function successResult(value: unknown): CallToolResult {
  const normalized = value === undefined ? null : value;
  const structuredContent = isObject(normalized) ? normalized : { result: normalized };
  return {
    content: [{ type: 'text', text: summarizeStructuredResult(structuredContent) }],
    structuredContent,
  };
}

function summarizeStructuredResult(value: JsonObject): string {
  const query = typeof value.query === 'string' ? value.query : undefined;
  const capabilityMatches = Array.isArray(value.matches)
    ? value.matches
    : Array.isArray(value.result)
      ? value.result
      : undefined;
  const discoveries = Array.isArray(value.discoveries) ? value.discoveries : undefined;
  if (capabilityMatches || discoveries) {
    const matches = capabilityMatches ?? [];
    const catalogEntries = discoveries ?? [];
    const capabilityNames = matches
      .map((entry) => {
        const current = optionalObject(entry);
        const capability = optionalObject(current?.capability);
        return optionalString(capability?.name) ?? optionalString(current?.name);
      })
      .filter((name): name is string => Boolean(name))
      .slice(0, 8);
    const discoveryNames = catalogEntries
      .map((match) => {
        const current = optionalObject(match);
        const entry = optionalObject(current?.entry);
        const kind = optionalString(entry?.kind);
        const title = optionalString(entry?.title) ?? optionalString(entry?.id);
        if (!kind) return title;
        return title ? `${kind}:${title}` : kind;
      })
      .filter((name): name is string => Boolean(name))
      .slice(0, 8);
    const subject = query ? ` for ${JSON.stringify(query.slice(0, 160))}` : '';
    const namedCapabilities =
      capabilityNames.length > 0 ? ` Capabilities: ${capabilityNames.join(', ')}.` : '';
    const namedDiscoveries =
      discoveryNames.length > 0 ? ` Discoveries: ${discoveryNames.join(', ')}.` : '';
    return boundedModelText(
      `Runtime search returned ${matches.length} capability match${
        matches.length === 1 ? '' : 'es'
      } and ${catalogEntries.length} ${catalogEntries.length === 1 ? 'discovery' : 'discoveries'}${
        subject
      }.${namedCapabilities}${namedDiscoveries} Full typed capability schemas, discovery actions, and metadata are in structuredContent.`,
    );
  }

  const status = optionalString(value.status);
  const receipt = optionalObject(value.receipt);
  const target = optionalString(receipt?.target);
  if (status) {
    return boundedModelText(
      `Runtime execution ${status}${target ? ` for ${target}` : ''}. Full output, provenance, and receipt are in structuredContent.`,
    );
  }

  const keys = Object.keys(value).slice(0, 12);
  return boundedModelText(
    `Runtime result is available in structuredContent${keys.length > 0 ? ` (${keys.join(', ')})` : ''}.`,
  );
}

function boundedModelText(value: string, maxBytes = 2_048): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}...`, 'utf8') > maxBytes) break;
    result += character;
  }
  return `${result}...`;
}

function modelSafeResourceToolResult(result: CallToolResult): CallToolResult {
  const metadata = optionalObject(result._meta);
  const marshal = optionalObject(metadata?.marshal);
  if (marshal?.kind !== 'compiled_react_ui' || typeof marshal.componentHtml !== 'string') {
    return result;
  }

  const { marshal: _compiledPayload, ...safeMetadata } = metadata!;
  const { _meta: _unsafeMetadata, ...safeResult } = result;
  return Object.keys(safeMetadata).length > 0
    ? { ...safeResult, _meta: safeMetadata }
    : safeResult;
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    isObject(error) && typeof error.code === 'string'
      ? error.code
      : 'runtime_adapter_error';
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message, code }, null, 2) }],
    structuredContent: { error: message, code },
  };
}

function uiResult(execution: unknown): CallToolResult {
  const response = asObject(execution);
  if (response.status !== 'success') {
    const error = optionalObject(response.error);
    throw new Error(
      typeof error?.message === 'string'
        ? error.message
        : `UI artifact lookup ended with ${String(response.status ?? 'unknown')}`,
    );
  }
  const result = optionalObject(response.result);
  const output = optionalObject(result?.output);
  const artifact = optionalObject(output?.artifact);
  if (!artifact) throw new Error('UI artifact lookup returned no artifact');
  const structuredContent: JsonObject = {
    artifact,
    resource: output?.resource,
    receipt: response.receipt,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function asObject(value: unknown): JsonObject {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    throw new Error('Tool arguments must be an object');
  }
  return value;
}

function optionalObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function modelSafeLifecycleMetadata(value: unknown): JsonObject | undefined {
  const metadata = optionalObject(value);
  if (!metadata) return undefined;
  return Object.fromEntries(Object.entries(metadata).filter(([key]) =>
    key !== 'parentSessionId' && key !== 'verifiedParentSessionId'));
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const result = requireNonEmptyString(value, field);
  if (result.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return result;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, field);
}

function optionalSearchDetail(value: unknown): 'summary' | 'full' | undefined {
  if (value === undefined) return undefined;
  if (value === 'compact') return 'summary';
  if (value !== 'summary' && value !== 'full') {
    throw new Error('runtime_search.detail must be "summary", "compact", or "full"');
  }
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}
