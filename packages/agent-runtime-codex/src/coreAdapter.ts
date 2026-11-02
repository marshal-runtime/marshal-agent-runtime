import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  JsonObject,
  RuntimeCallContext,
  RuntimeExecutionRequest,
  RuntimeKernelPort,
  RuntimeSearchRequest,
} from './ports.js';
import {
  resolveCodexHarnessIdentity,
  resolveCodexPrincipal,
  type CodexHarnessIdentity,
} from './identity.js';

/** Structural subset of @marshal/agent-runtime-core.RuntimeKernel. */
export interface AgentRuntimeCoreLike {
  runtimeSearch(request: JsonObject, context: JsonObject): Promise<unknown>;
  runtimeExec(request: JsonObject, context: JsonObject): Promise<unknown>;
}

export interface AgentRuntimeCoreBindingOptions {
  protocolVersion?: string;
  principal?: {
    id: string;
    kind: string;
    claims?: JsonObject;
  };
  /** Capability registered by the host that owns TypeScript module execution. */
  inlineModuleCapability?: string;
  /** Separate high-risk capability used only when Codex explicitly requests trusted Node mode. */
  trustedInlineModuleCapability?: string;
  /** Capability registered by the host for editable file/artifact modules. */
  moduleCapability?: string;
  /** Trusted counterpart for editable file/artifact modules. */
  trustedModuleCapability?: string;
  /** Override how Codex workspace/session fields become portable runtime scope IDs. */
  resolveScope?: (context: RuntimeCallContext) => JsonObject;
  /** Stable installation/profile identity supplied by the Codex plugin boundary. */
  identity?: JsonObject;
  /** Stable repository identity supplied by a trusted host boundary. */
  trustedProjectId?: string;
}

/**
 * Adapts the core package without taking a hard dependency on it. The
 * structural boundary lets independently versioned packages interoperate.
 */
export function bindAgentRuntimeCore(
  core: AgentRuntimeCoreLike,
  options: AgentRuntimeCoreBindingOptions = {},
): RuntimeKernelPort {
  const protocolVersion = options.protocolVersion ?? '1.0.0';
  const identity = resolveCodexHarnessIdentity(options.identity);
  const principal = resolveCodexPrincipal(options.principal, identity);
  const inlineModuleCapability = options.inlineModuleCapability ?? 'runtime.inline_module.execute';
  const trustedInlineModuleCapability =
    options.trustedInlineModuleCapability ?? 'runtime.inline_module.execute.trusted';
  const moduleCapability = options.moduleCapability ?? 'runtime.module.execute';
  const trustedModuleCapability =
    options.trustedModuleCapability ?? 'runtime.module.execute.trusted';

  return {
    async search(request: RuntimeSearchRequest, context: RuntimeCallContext): Promise<unknown> {
      return core.runtimeSearch(
        {
          ...request,
          protocolVersion: request.protocolVersion ?? protocolVersion,
          tags: request.tags ?? request.kinds,
        },
        toCoreContext(context, principal, options.resolveScope, identity, options.trustedProjectId),
      );
    },
    async execute(request: RuntimeExecutionRequest, context: RuntimeCallContext): Promise<unknown> {
      const coreRequest =
        request.targetType === 'operation'
          ? {
              protocolVersion: request.protocolVersion ?? protocolVersion,
              target: request.target,
              input: request.input,
              requestId: context.requestId,
              approval: request.approval,
            }
          : request.targetType === 'inline_module'
            ? {
              protocolVersion: request.protocolVersion ?? protocolVersion,
              target:
                request.executionMode === 'trusted_node'
                  ? trustedInlineModuleCapability
                  : inlineModuleCapability,
              input: {
                source: request.source,
                input: request.input,
                timeoutMs: request.timeoutMs,
                executionMode: request.executionMode,
              },
              requestId: context.requestId,
              approval: request.approval,
            }
            : {
                protocolVersion: request.protocolVersion ?? protocolVersion,
                target:
                  request.executionMode === 'trusted_node'
                    ? trustedModuleCapability
                    : moduleCapability,
                input: {
                  module: request.module,
                  input: request.input,
                  timeoutMs: request.timeoutMs,
                  executionMode: request.executionMode,
                },
                requestId: context.requestId,
                approval: request.approval,
              };
      return core.runtimeExec(
        coreRequest,
        toCoreContext(context, principal, options.resolveScope, identity, options.trustedProjectId),
      );
    },
  };
}

function toCoreContext(
  context: RuntimeCallContext,
  principal: NonNullable<AgentRuntimeCoreBindingOptions['principal']>,
  resolveScope?: AgentRuntimeCoreBindingOptions['resolveScope'],
  configuredIdentity?: CodexHarnessIdentity,
  trustedProjectId?: string,
): JsonObject {
  return {
    principal,
    identity: {
      harnessId: 'codex',
      ...(configuredIdentity ?? {}),
      ...(context.agentId ? { agentId: context.agentId } : {}),
    },
    scope: resolveScope?.(context) ?? defaultScope(context, trustedProjectId),
    executionId: context.requestId,
    signal: context.signal,
    ...(context.receiptCorrelationContext
      ? { receiptCorrelationContext: context.receiptCorrelationContext }
      : {}),
    metadata: {
      ...(context.metadata ?? {}),
      codexAgentId: context.agentId,
    },
  };
}

function defaultScope(context: RuntimeCallContext, trustedProjectId?: string): JsonObject {
  const workspacePath = context.workspacePath ? resolve(context.workspacePath) : undefined;
  const workspaceDigest = workspacePath
    ? createHash('sha256')
        .update(normalizeWorkspaceIdentityPath(workspacePath))
        .digest('hex')
        .slice(0, 24)
    : undefined;
  return {
    workspaceId: workspaceDigest ? `workspace-${workspaceDigest}` : undefined,
    projectId: trustedProjectId?.trim()
      ? `project-${createHash('sha256').update(trustedProjectId.trim()).digest('hex').slice(0, 24)}`
      : undefined,
    sessionId: context.sessionId,
    threadId: context.threadId ?? context.sessionId,
    workspacePath,
  };
}

/** @internal Stable hashing rule: only Windows paths are case-insensitive by contract. */
export function normalizeWorkspaceIdentityPath(
  workspacePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? workspacePath.toLowerCase() : workspacePath;
}
