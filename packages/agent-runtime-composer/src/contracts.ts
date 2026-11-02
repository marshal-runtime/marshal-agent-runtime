import type {
  InvocationContext,
  MaybePromise,
  RuntimeAbortSignal,
  RuntimeExecuteRequest,
  RuntimeHarnessIdentity,
  RuntimeExecResponse,
  RuntimeKernel,
  RuntimePrincipal,
  RuntimeSearchRequest,
  RuntimeSearchResponse,
} from '@marshal/agent-runtime-core';
import type {
  RuntimeAuthoritySource,
  RuntimeOptionalIdentitySource,
  RuntimePrincipalSource,
} from './identity.js';

export type JsonObject = Readonly<Record<string, unknown>>;

/** Workspace/project identity established by the embedding harness. */
export interface TrustedRuntimeAuthority {
  readonly workspaceId: string;
  readonly projectId: string;
}

/** Per-call data that cannot replace the composer's fixed principal or authority. */
export interface RuntimeBindingContext {
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly parentExecutionId?: string;
  readonly requestId?: string;
  readonly signal?: RuntimeAbortSignal;
  readonly metadata?: JsonObject;
}

export type RuntimeBindingSearchRequest = Omit<RuntimeSearchRequest, 'protocolVersion'> & {
  readonly protocolVersion?: string;
};

type WithOptionalProtocol<T> = T extends { readonly protocolVersion: string }
  ? Omit<T, 'protocolVersion'> & { readonly protocolVersion?: string }
  : never;

export type RuntimeBindingExecuteRequest = WithOptionalProtocol<RuntimeExecuteRequest>;

export interface RuntimeKernelBindings {
  search(
    request: RuntimeBindingSearchRequest,
    context?: RuntimeBindingContext,
  ): Promise<RuntimeSearchResponse>;
  execute<TOutput = unknown>(
    request: RuntimeBindingExecuteRequest,
    context?: RuntimeBindingContext,
  ): Promise<RuntimeExecResponse<TOutput>>;
}

export interface RuntimeSessionStartRequest {
  readonly protocolVersion?: string;
  readonly eventId?: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly metadata?: JsonObject;
}

export interface RuntimeTurnObservation {
  readonly protocolVersion?: string;
  readonly eventId?: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly kind: 'user_message' | 'tool_result' | 'assistant_turn';
  readonly content: unknown;
  readonly toolName?: string;
  readonly metadata?: JsonObject;
}

export interface RuntimeSessionEndRequest {
  readonly protocolVersion?: string;
  readonly eventId?: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly outcome?: string;
  readonly metadata?: JsonObject;
}

export interface RuntimeScopedLifecyclePort {
  startSession(
    request: RuntimeSessionStartRequest & { readonly protocolVersion: string },
    context: InvocationContext,
  ): MaybePromise<unknown>;
  observeTurn(
    request: RuntimeTurnObservation & { readonly protocolVersion: string },
    context: InvocationContext,
  ): MaybePromise<unknown>;
  endSession(
    request: RuntimeSessionEndRequest & { readonly protocolVersion: string },
    context: InvocationContext,
  ): MaybePromise<unknown>;
}

export interface RuntimeLifecycleBindings {
  startSession(
    request: RuntimeSessionStartRequest,
    context?: RuntimeBindingContext,
  ): Promise<unknown>;
  observeTurn(
    request: RuntimeTurnObservation,
    context?: RuntimeBindingContext,
  ): Promise<unknown>;
  endSession(
    request: RuntimeSessionEndRequest,
    context?: RuntimeBindingContext,
  ): Promise<unknown>;
}

export interface RuntimeResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface RuntimeResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface RuntimeResourceToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly metadata?: JsonObject;
}

export interface RuntimeResourceToolResult {
  readonly content: readonly unknown[];
  readonly structuredContent?: JsonObject;
  readonly isError?: boolean;
}

export interface RuntimeScopedResourcePort {
  listResources(context: InvocationContext): MaybePromise<readonly RuntimeResourceDescriptor[]>;
  readResource(uri: string, context: InvocationContext): MaybePromise<RuntimeResourceContent>;
  listTools?(
    context: InvocationContext,
  ): MaybePromise<readonly RuntimeResourceToolDescriptor[]>;
  callTool?(
    name: string,
    input: JsonObject,
    context: InvocationContext,
  ): MaybePromise<RuntimeResourceToolResult | undefined>;
}

export interface RuntimeResourceBindings {
  listResources(context?: RuntimeBindingContext): Promise<readonly RuntimeResourceDescriptor[]>;
  readResource(uri: string, context?: RuntimeBindingContext): Promise<RuntimeResourceContent>;
  listTools?(
    context?: RuntimeBindingContext,
  ): Promise<readonly RuntimeResourceToolDescriptor[]>;
  callTool?(
    name: string,
    input: JsonObject,
    context?: RuntimeBindingContext,
  ): Promise<RuntimeResourceToolResult | undefined>;
}

export type ComposeAgentRuntimeOptions = RuntimePrincipalSource &
  RuntimeAuthoritySource &
  RuntimeOptionalIdentitySource & {
  readonly kernel: RuntimeKernel;
  readonly lifecycle?: RuntimeScopedLifecyclePort;
  readonly resources?: RuntimeScopedResourcePort;
};

export interface RuntimeComposerBindings {
  readonly kernel: RuntimeKernelBindings;
  readonly lifecycle?: RuntimeLifecycleBindings;
  readonly resources?: RuntimeResourceBindings;
  readonly principal: RuntimePrincipal;
  readonly identity?: RuntimeHarnessIdentity;
  readonly authority: TrustedRuntimeAuthority;
  readonly core: RuntimeKernel;
}
