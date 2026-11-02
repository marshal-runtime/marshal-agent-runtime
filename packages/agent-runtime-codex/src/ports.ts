import type { RuntimeReceiptCorrelationContext } from '@marshal/agent-runtime-core';
import type {
  RuntimeExtensionAutopilotService,
  RuntimeExtensionLifecycleService,
  RuntimeExtensionStatusService,
} from '@marshal/agent-runtime-extensions';

export type JsonObject = Record<string, unknown>;

export interface RuntimeCallContext {
  sessionId?: string;
  threadId?: string;
  agentId?: string;
  workspacePath?: string;
  requestId?: string;
  receiptCorrelationContext?: RuntimeReceiptCorrelationContext;
  metadata?: JsonObject;
  signal?: AbortSignal;
}

export interface RuntimeSearchRequest extends JsonObject {
  protocolVersion?: string;
  query?: string;
  name?: string;
  detail?: 'summary' | 'full';
  limit?: number;
  tags?: string[];
  /** @deprecated Use tags. Retained only at this adapter boundary. */
  kinds?: string[];
}

export interface RuntimeOperationExecutionRequest extends JsonObject {
  protocolVersion?: string;
  targetType: 'operation';
  target: string;
  input?: unknown;
  timeoutMs?: number;
  approval?: JsonObject;
}

export interface RuntimeInlineModuleExecutionRequest extends JsonObject {
  protocolVersion?: string;
  targetType: 'inline_module';
  source: string;
  input?: unknown;
  timeoutMs?: number;
  executionMode?: 'brokered' | 'trusted_node';
  approval?: JsonObject;
}

export interface RuntimeModuleExecutionRequest extends JsonObject {
  protocolVersion?: string;
  targetType: 'module';
  module: {
    kind: 'inline' | 'workspace_file' | 'artifact';
    source?: string;
    path?: string;
    scope?: 'workspace' | 'project' | 'session';
    export?: string;
  };
  input?: unknown;
  timeoutMs?: number;
  executionMode?: 'brokered' | 'trusted_node';
  approval?: JsonObject;
}

export type RuntimeExecutionRequest =
  | RuntimeOperationExecutionRequest
  | RuntimeInlineModuleExecutionRequest
  | RuntimeModuleExecutionRequest;

/**
 * The only kernel surface required by the MCP adapter. A future core package
 * can implement this port directly or provide a two-method binding wrapper.
 */
export interface RuntimeKernelPort {
  search(request: RuntimeSearchRequest, context: RuntimeCallContext): Promise<unknown>;
  execute(request: RuntimeExecutionRequest, context: RuntimeCallContext): Promise<unknown>;
}

export type RuntimeObservationKind = 'user_message' | 'tool_result' | 'assistant_turn';

export interface RuntimeSessionStartRequest extends JsonObject {
  protocolVersion?: string;
  eventId?: string;
  sessionId: string;
  parentSessionId?: string;
  agentId?: string;
  workspacePath?: string;
  metadata?: JsonObject;
}

export interface RuntimeTurnObservation extends JsonObject {
  protocolVersion?: string;
  eventId?: string;
  sessionId: string;
  parentSessionId?: string;
  kind: RuntimeObservationKind;
  content: unknown;
  toolName?: string;
  agentId?: string;
  workspacePath?: string;
  metadata?: JsonObject;
}

export interface RuntimeSessionEndRequest extends JsonObject {
  protocolVersion?: string;
  eventId?: string;
  sessionId: string;
  parentSessionId?: string;
  outcome?: string;
  metadata?: JsonObject;
}

/** Lifecycle callbacks are deliberately independent from the command kernel. */
export interface RuntimeLifecyclePort {
  startSession(request: RuntimeSessionStartRequest): Promise<unknown>;
  observeTurn(request: RuntimeTurnObservation): Promise<unknown>;
  endSession(request: RuntimeSessionEndRequest): Promise<unknown>;
}

export interface RuntimeResourceDescriptor extends JsonObject {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  _meta?: JsonObject;
}

export interface RuntimeResourceContent extends JsonObject {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: JsonObject;
}

/** Optional MCP Apps render tool supplied by a portable UI resource plane. */
export interface RuntimeResourceToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  _meta?: JsonObject;
}

export interface RuntimeResourceToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
  /** Private MCP Apps hydration data; hosts must not expose this to the model. */
  _meta?: JsonObject;
}

/** Optional MCP Apps/resource plane exposed by a harness-specific provider bundle. */
export interface RuntimeResourcePort {
  listResources(context: RuntimeCallContext): Promise<readonly RuntimeResourceDescriptor[]>;
  readResource(uri: string, context: RuntimeCallContext): Promise<RuntimeResourceContent>;
  /** Static metadata for the legacy declarative runtime_render_ui tool definition. */
  toolMetadata?(): JsonObject;
  /** Static metadata for the compiled React runtime_render_component tool. */
  reactToolMetadata?(): JsonObject;
  /** Dynamically enumerated render tools bind immutable MCP App resource URIs. */
  listTools?(context: RuntimeCallContext): Promise<readonly RuntimeResourceToolDescriptor[]>;
  /** Returns undefined when this resource plane does not own the requested tool. */
  callTool?(
    name: string,
    input: JsonObject,
    context: RuntimeCallContext,
  ): Promise<RuntimeResourceToolResult | undefined>;
}

export interface RuntimeAdapterBindings {
  kernel: RuntimeKernelPort;
  lifecycle?: RuntimeLifecyclePort;
  resources?: RuntimeResourcePort;
  extensionStatus?: RuntimeExtensionStatusService;
  extensionLifecycle?: RuntimeExtensionLifecycleService;
  extensionAutopilot?: RuntimeExtensionAutopilotService;
  dispose?: (options?: { readonly drainBackgroundJobs?: boolean }) => void | Promise<void>;
}

export interface RuntimeBindingFactoryOptions {
  workspacePath?: string;
}

export type RuntimeBindingFactory = (
  options: RuntimeBindingFactoryOptions,
) =>
  RuntimeAdapterBindings | RuntimeKernelPort | Promise<RuntimeAdapterBindings | RuntimeKernelPort>;
