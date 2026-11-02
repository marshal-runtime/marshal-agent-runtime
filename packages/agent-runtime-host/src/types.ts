import type {
  CapabilityProvider,
  Disposable,
  InvocationContext,
  PermissionBroker,
  RuntimeKernel,
  RuntimeBackgroundJobHandler,
  RuntimeCatalogProvider,
  RuntimeEffectHandler,
  RuntimePrincipal,
  RuntimeHarnessIdentity,
  RuntimeReceiptForest,
  RuntimeReceiptCorrelationContext,
  RuntimeReceiptStore,
  RuntimeDurableEventConsumerOptions,
  RuntimeEventSubscription,
  RuntimeLifecycleEventMap,
  RuntimeExecResponse,
  RuntimeSearchResponse,
} from '@marshal/agent-runtime-core';
import type {
  RuntimeCompositionRegistry,
  RuntimeServiceContainer,
} from '@marshal/agent-runtime-composer';
import type {
  RuntimeExtensionCatalogSource,
  RuntimeExtensionManagerOptions,
  RuntimeExtensionStatusService,
} from '@marshal/agent-runtime-extensions';
import type { RuntimeHostExtensionsOptions } from './nativeExtensions.js';
import type { RuntimeNativeExtensionDiscoveryService } from './nativeExtensionDiscovery.js';
import type {
  BackgroundJobManager,
  RuntimeEffectApprovalVerifier,
} from '@marshal/agent-runtime-effects';
import type {
  DefaultDenyPermissionBrokerOptions,
} from '@marshal/agent-runtime-permissions';
import type {
  RuntimeCodeIntelligenceSourceOptions,
} from '@marshal/agent-runtime-code-intelligence/runtime-service';

export type JsonObject = Record<string, unknown>;

export type RuntimePermissionProfile =
  | 'default'
  | 'bounded-agentic'
  | 'adaptive-agentic'
  | 'trusted-local';

export type RuntimeLifecyclePhase =
  | 'session.start'
  | 'prompt.submit'
  | 'tool.invoke'
  | 'tool.result'
  | 'assistant.complete'
  | 'session.end'
  | 'subagent.start'
  | 'subagent.end';

export interface RuntimeSkillReferenceAsset {
  readonly path: string;
  readonly content: string;
}

export interface RuntimeSkillAsset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly references?: readonly RuntimeSkillReferenceAsset[];
}

export interface RuntimePromptFragment {
  readonly id: string;
  readonly phase: RuntimeLifecyclePhase;
  readonly content: string;
  readonly required?: boolean;
  readonly priority?: number;
}

export interface RuntimePackageDeclaration {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly capabilityPrefixes: readonly string[];
  readonly skills?: readonly RuntimeSkillAsset[];
  readonly promptFragments?: readonly RuntimePromptFragment[];
  readonly lifecyclePhases?: readonly RuntimeLifecyclePhase[];
}

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

export interface RuntimeHostWorkspaceScope {
  readonly workspacePath: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

export type RuntimeHostWorkspaceResolver = (
  context: Readonly<RuntimeCallContext>,
) => RuntimeHostWorkspaceScope | Promise<RuntimeHostWorkspaceScope>;

export interface RuntimeSearchRequest {
  protocolVersion?: string;
  query?: string;
  name?: string;
  catalogId?: string;
  detail?: 'summary' | 'full';
  limit?: number;
  tags?: readonly string[];
}

export type RuntimeExecutionRequest =
  | {
      protocolVersion?: string;
      targetType: 'operation';
      target: string;
      input?: unknown;
      requestId?: string;
      approval?: Readonly<Record<string, unknown>>;
    }
  | {
      protocolVersion?: string;
      targetType: 'inline_module';
      source: string;
      input?: unknown;
      timeoutMs?: number;
      executionMode?: 'brokered' | 'trusted_node';
      requestId?: string;
      approval?: Readonly<Record<string, unknown>>;
    }
  | {
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
      requestId?: string;
      approval?: Readonly<Record<string, unknown>>;
    };

export interface RuntimeKernelPort {
  search(
    request: RuntimeSearchRequest,
    context: RuntimeCallContext,
  ): Promise<RuntimeSearchResponse>;
  execute(
    request: RuntimeExecutionRequest,
    context: RuntimeCallContext,
  ): Promise<RuntimeExecResponse>;
}

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
  kind: 'user_message' | 'tool_result' | 'assistant_turn';
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

export interface RuntimeLifecyclePort {
  startSession(request: RuntimeSessionStartRequest): Promise<unknown>;
  observeTurn(request: RuntimeTurnObservation): Promise<unknown>;
  endSession(request: RuntimeSessionEndRequest): Promise<unknown>;
}

export interface RuntimeResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  catalog?: {
    readonly owner: {
      readonly type: 'package' | 'provider' | 'adapter' | 'catalog_provider';
      readonly id: string;
    };
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

export interface RuntimeResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

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
  _meta?: JsonObject;
}

/** Harness-facing resource plane. */
export interface RuntimeResourcePort {
  listResources(context: RuntimeCallContext): Promise<readonly RuntimeResourceDescriptor[]>;
  readResource(uri: string, context: RuntimeCallContext): Promise<RuntimeResourceContent>;
  toolMetadata?(): JsonObject;
  reactToolMetadata?(): JsonObject;
  listTools?(context: RuntimeCallContext): Promise<readonly RuntimeResourceToolDescriptor[]>;
  callTool?(
    name: string,
    input: JsonObject,
    context: RuntimeCallContext,
  ): Promise<RuntimeResourceToolResult | undefined>;
}

/** Provider-facing resource plane using core invocation context. */
export interface RuntimeScopedResourcePort {
  listResources(context: InvocationContext): Promise<readonly RuntimeResourceDescriptor[]>;
  readResource(uri: string, context: InvocationContext): Promise<RuntimeResourceContent>;
  toolMetadata?(): JsonObject;
  reactToolMetadata?(): JsonObject;
  listRenderTools?(
    context: InvocationContext,
  ): Promise<readonly RuntimeResourceToolDescriptor[]>;
  invokeRenderTool?(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<RuntimeResourceToolResult | undefined>;
}

export interface RuntimeHostFactoryContext {
  readonly serviceContainer: RuntimeServiceContainer;
  readonly compositionRegistry: RuntimeCompositionRegistry;
  readonly workspacePath: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly stateRoot: string;
  readonly worktreeRoot: string;
  readonly protectedLifecycleResultRoot: string;
  readonly principal: RuntimePrincipal;
  readonly identity: RuntimeHarnessIdentity;
  readonly permissions?: Readonly<Record<string, unknown>>;
  readonly permissionBroker: PermissionBroker;
  readonly importPolicy?: RuntimeHostImportPolicy;
  readonly operationInvoker: {
    search(
      request: RuntimeSearchRequest,
      context: InvocationContext,
    ): Promise<RuntimeSearchResponse>;
    invoke(operation: string, input: unknown, context: InvocationContext): Promise<unknown>;
    execute(request: RuntimeExecutionRequest, context: InvocationContext): Promise<RuntimeExecResponse>;
  };
  /** Source-time registrations are staged until aggregate handler validation succeeds. */
  readonly jobManager: BackgroundJobManager;
}

export interface RuntimeHostProviderBundle {
  readonly providers: readonly CapabilityProvider[];
  readonly lifecycle?: RuntimeLifecyclePort;
  readonly resources?: RuntimeScopedResourcePort;
  readonly catalog?: RuntimeCatalogProvider;
  readonly catalogSources?: readonly RuntimeExtensionCatalogSource[];
  readonly jobHandlers?: readonly RuntimeBackgroundJobHandler[];
  readonly dispose?: () => void | Promise<void>;
}

export type RuntimeHostProviderSource = (
  context: RuntimeHostFactoryContext,
) =>
  | RuntimeHostProviderBundle
  | readonly CapabilityProvider[]
  | CapabilityProvider
  | Promise<RuntimeHostProviderBundle | readonly CapabilityProvider[] | CapabilityProvider>;

export interface RuntimeHostImportPolicy {
  readonly allowedPackages?: readonly string[];
  readonly allowedBuiltins?: readonly string[];
}

export interface AgentRuntimeHostOptions {
  /** Shared Runtime service container. Omitted uses Runtime's canonical process container. */
  readonly serviceContainer?: RuntimeServiceContainer;
  /** Runtime-owned composition registry shared with provider construction and extensions. */
  readonly compositionRegistry?: RuntimeCompositionRegistry;
  /** Omitted creates and discovers `extensions` below the process root. */
  readonly extensions?: false | RuntimeHostExtensionsOptions;
  readonly workspacePath?: string;
  /** Trusted registry identity used for stable project scope; workspaceId remains path-derived. */
  readonly trustedProjectId?: string;
  /** Relative to workspacePath. Defaults to .marshal/runtime. */
  readonly stateDirectory?: string;
  /** Required absolute harness-private root outside workspacePath for lifecycle results and jobs. */
  readonly protectedLifecycleResultRoot?: string;
  /** Absolute directory outside workspacePath for isolated worktree providers. */
  readonly worktreeRoot?: string;
  /** Optional adapter authority for hosts serving more than one workspace. */
  readonly resolveWorkspace?: RuntimeHostWorkspaceResolver;
  /** Runtime-owned Quillstone service. Omit for defaults; false disables it explicitly. */
  readonly codeIntelligence?: false | RuntimeCodeIntelligenceSourceOptions;
  readonly providerSources?: readonly RuntimeHostProviderSource[];
  readonly permissionBroker?: PermissionBroker;
  readonly principal?: RuntimePrincipal;
  /** Stable harness/profile identity. Adapters should provide this explicitly. */
  readonly identity?: RuntimeHarnessIdentity;
  /** Additional permissions granted to the configured principal. */
  readonly permissionPatterns?: readonly string[];
  /** Additional grants enabled only by the explicitly trusted local profile. */
  readonly trustedPermissionPatterns?: readonly string[];
  /** Approval is enabled only when requests can later be cryptographically or externally verified. */
  readonly permissionApproval?: Readonly<
    Pick<DefaultDenyPermissionBrokerOptions, 'requestApproval' | 'verifyApproval'>
  >;
  /** Additional dynamic grants supplied by a harness-owned persisted policy. */
  readonly resolvePermissionGrants?: DefaultDenyPermissionBrokerOptions['resolveGrants'];
  /**
   * `bounded-agentic` preauthorizes only the native-agent control plane.
   * `adaptive-agentic` adds agent-authored UI compilation without enabling
   * trusted Node execution or wildcard imports.
   */
  readonly permissionProfile?: RuntimePermissionProfile;
  readonly importPolicy?: RuntimeHostImportPolicy;
  readonly inlineMaxOutputBytes?: number;
  readonly inlineMaxSourceCharacters?: number;
  readonly moduleMaxSourceBytes?: number;
  /** Aggregate nested capability-call bound for each TypeScript module execution. */
  readonly moduleMaxBrokerInvocations?: number;
  /** Concurrency bound for nested capability calls made by one TypeScript module. */
  readonly moduleMaxConcurrentBrokerInvocations?: number;
  readonly receiptMaxEntries?: number;
  readonly receiptMaxEntryBytes?: number;
  /** Optional harness-adapter callback for native effects. Unsupported kinds remain explicit. */
  readonly effectHandler?: RuntimeEffectHandler;
  /** Harness-owned, atomic verifier for effect-specific approval grants. */
  readonly effectApprovalVerifier?: RuntimeEffectApprovalVerifier;
  /** Optional harness-adapter callbacks for durable job kinds. */
  readonly jobHandlers?: readonly RuntimeBackgroundJobHandler[];
}

export interface RuntimeExtensionHostBindings {
  readonly jobManager: NonNullable<RuntimeExtensionManagerOptions['jobManager']>;
  readonly registerLifecycle: NonNullable<RuntimeExtensionManagerOptions['registerLifecycle']>;
  readonly recoverJobHandlers: NonNullable<RuntimeExtensionManagerOptions['recoverJobHandlers']>;
}

export interface AgentRuntimeBindings {
  /** The exact service container used to compose this runtime. */
  readonly serviceContainer: RuntimeServiceContainer;
  /** The exact composition registry used to compose this runtime. */
  readonly compositionRegistry: RuntimeCompositionRegistry;
  readonly kernel: RuntimeKernelPort;
  readonly lifecycle: RuntimeLifecyclePort;
  /** Existing host-owned hooks for a separately constructed extension manager. */
  readonly extensionHost?: RuntimeExtensionHostBindings;
  /** Host-owned live status for approved native extension discovery roots. */
  readonly extensionDiscovery?: RuntimeNativeExtensionDiscoveryService;
  /** Portable live extension administration surface for host UIs. */
  readonly extensionStatus?: RuntimeExtensionStatusService;
  readonly resources?: RuntimeResourcePort;
  readonly core: RuntimeKernel;
  readonly stateRoot: string;
  readonly workspacePath: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly identity: RuntimeHarnessIdentity;
  readonly receipts: RuntimeReceiptStore & {
    tree(rootExecutionId: string): Promise<RuntimeReceiptForest>;
  };
  readonly worktreeRoot: string;
  readonly providers: readonly CapabilityProvider[];
  readonly registrations: readonly Disposable[];
  registerDurableEventConsumer(
    options: RuntimeDurableEventConsumerOptions<RuntimeLifecycleEventMap>,
  ): RuntimeEventSubscription;
  dispose(options?: { readonly drainBackgroundJobs?: boolean }): Promise<void>;
}
