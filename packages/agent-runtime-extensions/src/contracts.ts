import type {
  CapabilityProvider,
  InvocationContext,
  MaybePromise,
  RuntimeAbortSignal,
  RuntimeBackgroundJobHandler,
  RuntimeBackgroundJobResponse,
  RuntimeBackgroundJobStartRequest,
  RuntimeCatalogProvider,
  RuntimeExecuteRequest,
  RuntimeExecResponse,
  RuntimeSearchRequest,
  RuntimeSearchResponse,
  RuntimeDurableEventConsumerOptions,
  RuntimeEventSubscription,
  RuntimeLifecycleEventMap,
} from '@marshal/agent-runtime-core';
import type {
  RuntimeResourceContent,
  RuntimeScopedResourcePort,
} from '@marshal/agent-runtime-composer';
import type {
  RuntimeServiceAccessor,
  RuntimeServiceBinding,
  RuntimeServiceToken,
} from '@marshal/agent-runtime-composer';
import type {
  RuntimeLifecycleEventType,
  RuntimeLifecycleListener,
} from '@marshal/agent-runtime-core';
import type { UiApplicationManifest } from '@marshal/agent-runtime-ui';
import type {
  RuntimeExtensionUiHostPlacement,
  RuntimeExtensionUiPlacementAction,
  RuntimeExtensionUiReplacementScope,
} from './uiPlacement.js';

export const RUNTIME_EXTENSION_MANIFEST_FILENAME = 'runtime-extension.json' as const;
export const RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RUNTIME_EXTENSION_MODULE_FORMAT = 'commonjs-bundle-v1' as const;
export const RUNTIME_EXTENSION_INTEGRITY_DOMAIN =
  'marshal-runtime-extension-package-v1' as const;
export const RUNTIME_EXTENSION_STATE_SCHEMA_VERSION = 1 as const;

export type RuntimeExtensionJsonPrimitive = string | number | boolean | null;
export type RuntimeExtensionJsonValue =
  | RuntimeExtensionJsonPrimitive
  | { readonly [key: string]: RuntimeExtensionJsonValue }
  | readonly RuntimeExtensionJsonValue[];

export type RuntimeExtensionContractShape = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export interface RuntimeExtensionContract {
  readonly id: string;
  readonly shape: RuntimeExtensionContractShape;
  readonly version: string;
  readonly type: string;
  readonly docs: string;
  readonly example?: RuntimeExtensionJsonValue;
  readonly resource?: string;
}
export interface RuntimeExtensionRpcMethod {
  readonly name: string;
  readonly input?: string;
  readonly output?: string;
}
export interface RuntimeExtensionServiceProvider {
  readonly id: string;
  readonly version: string;
  /** Optional TypeScript declaration text for the provided service contract. */
  readonly declaration?: string;
  readonly publicMethods: readonly RuntimeExtensionRpcMethod[];
}
export interface RuntimeExtensionDependency {
  readonly id: string;
  readonly version?: string;
}
export interface RuntimeExtensionServiceDependency extends RuntimeExtensionDependency {
  /** Explicit provider identity for a live runtime service dependency. */
  readonly provider?: string;
}
export interface RuntimeExtensionReplacement {
  readonly id: string;
  readonly target: string;
  readonly version?: string;
}
export interface RuntimeExtensionConfigurationSchema {
  readonly type: 'object';
  readonly properties?: Readonly<Record<string, RuntimeExtensionJsonValue>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export type RuntimeExtensionPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Trusted repository preparation invoked explicitly by a Node host before
 * package integrity is calculated. The package script owns dependency
 * installation, generation, and building.
 */
export interface RuntimeExtensionInstallation {
  readonly script: string;
  readonly packageManager?: RuntimeExtensionPackageManager;
}

/**
 * Optional, bounded prompt guidance an extension supplies for agent system
 * prompts. Hosts render one small block per installed+enabled extension from
 * this field, falling back to catalog title/description when absent. Bounds
 * (enforced at manifest validation): purpose/when/boundaries <= 300 chars,
 * recipe <= 700, total serialized <= 1500. Newlines, carriage returns, and
 * tabs are allowed; other control characters are rejected.
 */
export interface RuntimeExtensionAgentGuidance {
  readonly purpose?: string;
  readonly when?: string;
  readonly recipe?: string;
  readonly boundaries?: string;
}

export interface RuntimeExtensionManifest {
  readonly schemaVersion: typeof RUNTIME_EXTENSION_MANIFEST_SCHEMA_VERSION;
  readonly identity: string;
  /** Human label shown in host navigation and diagnostics. */
  readonly displayName?: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly moduleFormat: typeof RUNTIME_EXTENSION_MODULE_FORMAT;
  readonly installation?: RuntimeExtensionInstallation;
  readonly activationOrder?: number;
  readonly contracts?: readonly RuntimeExtensionContract[];
  readonly provides?: { readonly services?: readonly RuntimeExtensionServiceProvider[] };
  readonly dependencies?: {
    readonly extensions?: readonly RuntimeExtensionDependency[];
    readonly services?: readonly RuntimeExtensionServiceDependency[];
  };
  readonly replacements?: readonly RuntimeExtensionReplacement[];
  readonly configuration?: {
    readonly schema?: RuntimeExtensionConfigurationSchema;
    readonly defaults?: RuntimeExtensionConfiguration;
  };
  readonly docs?: RuntimeExtensionJsonValue;
  readonly resources?: RuntimeExtensionJsonValue;
  readonly examples?: RuntimeExtensionJsonValue;
  readonly appServices?: RuntimeExtensionJsonValue;
  readonly appServicesSnippet?: string;
  readonly agentGuidance?: RuntimeExtensionAgentGuidance;
  readonly contributes?: {
    readonly services?: readonly string[];
    readonly capabilities?: readonly string[];
    readonly events?: readonly string[];
    readonly ui?: readonly string[];
    readonly catalog?: readonly string[];
  };
}

export interface RuntimeExtensionIntegrity {
  readonly algorithm: 'sha256';
  readonly domain: typeof RUNTIME_EXTENSION_INTEGRITY_DOMAIN;
  readonly value: string;
}

export interface RuntimeExtensionInstallRequest {
  /** Materialized local package directory selected by the host. */
  readonly packageRoot: string;
  /** Host-authoritative digest; the loader never fetches or resolves packages. */
  readonly integrity: RuntimeExtensionIntegrity;
}

export type RuntimeExtensionConfiguration = Readonly<Record<string, unknown>>;

export interface RuntimeExtensionInstallOptions
  extends RuntimeExtensionOperationOptions {
  readonly configuration?: RuntimeExtensionConfiguration;
  readonly enabled?: boolean;
}

export interface RuntimeExtensionDiscoveryCandidate {
  readonly request: RuntimeExtensionInstallRequest;
  readonly enabled?: boolean;
  readonly configuration?: RuntimeExtensionConfiguration;
}

export interface RuntimeExtensionPackageDiscovery {
  readonly candidates: readonly RuntimeExtensionDiscoveryCandidate[];
}

export interface RuntimeExtensionPackageMetadata {
  readonly manifest: RuntimeExtensionManifest;
  readonly integrity: RuntimeExtensionIntegrity;
  readonly canonicalRoot: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface RuntimeExtensionUiApplication {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly renderId: string;
  readonly resource: RuntimeResourceContent;
  readonly application: UiApplicationManifest;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type RuntimeExtensionUiPlacement =
  | {
    readonly placementId: string;
    readonly action: 'replace';
    readonly applicationId: string;
    readonly replacement?: RuntimeExtensionUiReplacementScope;
  }
  | {
    readonly placementId: string;
    readonly action: Exclude<RuntimeExtensionUiPlacementAction, 'replace'>;
    readonly applicationId: string;
  };

export interface RuntimeExtensionActivation {
  readonly serviceContributions?: readonly RuntimeExtensionServiceContribution[];
  readonly capabilityProviders?: readonly CapabilityProvider[];
  readonly eventSubscriptions?: readonly RuntimeExtensionEventSubscriptionContribution[];
  readonly catalogProviders?: readonly RuntimeCatalogProvider[];
  readonly resourceProviders?: readonly RuntimeScopedResourcePort[];
  readonly uiApplications?: readonly RuntimeExtensionUiApplication[];
  readonly uiPlacements?: readonly RuntimeExtensionUiPlacement[];
  readonly lifecycle?: RuntimeExtensionLifecyclePort;
  readonly jobHandlers?: readonly RuntimeBackgroundJobHandler[];
  readonly dispose?: () => MaybePromise<void>;
}

export interface RuntimeExtensionSessionStartRequest {
  readonly protocolVersion?: string;
  readonly eventId?: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly agentId?: string;
  readonly workspacePath?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeExtensionTurnObservation {
  readonly protocolVersion?: string;
  readonly eventId?: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly kind: 'user_message' | 'tool_result' | 'assistant_turn';
  readonly content: unknown;
  readonly toolName?: string;
  readonly agentId?: string;
  readonly workspacePath?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeExtensionSessionEndRequest {
  readonly protocolVersion?: string;
  readonly eventId?: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly outcome?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeExtensionLifecyclePort {
  startSession(request: RuntimeExtensionSessionStartRequest): Promise<unknown>;
  observeTurn(request: RuntimeExtensionTurnObservation): Promise<unknown>;
  endSession(request: RuntimeExtensionSessionEndRequest): Promise<unknown>;
}

export interface RuntimeExtensionJobEnqueuer {
  enqueue(
    request: RuntimeBackgroundJobStartRequest,
    context: InvocationContext,
  ): Promise<RuntimeBackgroundJobResponse>;
  start(
    request: RuntimeBackgroundJobStartRequest,
    context: InvocationContext,
  ): Promise<RuntimeBackgroundJobResponse>;
}

export interface RuntimeExtensionOwnedRegistration {
  dispose(): MaybePromise<void>;
}

export interface RuntimeExtensionJobHandlerReservation extends RuntimeExtensionOwnedRegistration {
  publish(): void;
}

export interface RuntimeExtensionJobManager extends RuntimeExtensionJobEnqueuer {
  reserveHandlers(
    handlers: readonly RuntimeBackgroundJobHandler[],
  ): RuntimeExtensionJobHandlerReservation;
}

export interface RuntimeExtensionActivationContext<
  TConfiguration extends RuntimeExtensionConfiguration = RuntimeExtensionConfiguration,
> {
  readonly manifest: RuntimeExtensionManifest;
  readonly configuration: Readonly<TConfiguration>;
  readonly services: RuntimeServiceAccessor;
  readonly events?: RuntimeExtensionEventBus;
  readonly jobManager?: RuntimeExtensionJobEnqueuer;
  readonly signal?: RuntimeAbortSignal;
  search(
    request: RuntimeSearchRequest,
    context?: InvocationContext,
  ): Promise<RuntimeSearchResponse>;
  execute<TOutput = unknown>(
    request: RuntimeExecuteRequest,
    context?: InvocationContext,
  ): Promise<RuntimeExecResponse<TOutput>>;
}

export interface RuntimeExtensionModule<
  TConfiguration extends RuntimeExtensionConfiguration = RuntimeExtensionConfiguration,
> {
  activate(
    context: RuntimeExtensionActivationContext<TConfiguration>,
  ): MaybePromise<RuntimeExtensionActivation>;
}

export interface LoadedRuntimeExtensionPackage {
  readonly metadata: RuntimeExtensionPackageMetadata;
  readonly module: RuntimeExtensionModule;
}

export interface RuntimeExtensionPackageLoader {
  load(
    request: RuntimeExtensionInstallRequest,
    signal?: RuntimeAbortSignal,
  ): MaybePromise<LoadedRuntimeExtensionPackage>;
}

export type RuntimeExtensionStatus = 'enabled' | 'disabled';

export interface RuntimeExtensionRecord {
  readonly identity: string;
  readonly version: string;
  readonly integrity: RuntimeExtensionIntegrity;
  readonly entrypoint: string;
  readonly status: RuntimeExtensionStatus;
  readonly activationOrder: number;
  readonly configuration: RuntimeExtensionConfiguration;
}

export interface RuntimeExtensionOperationOptions {
  readonly signal?: RuntimeAbortSignal;
}

export interface RuntimeExtensionManagerOptions {
  readonly kernel: import('@marshal/agent-runtime-core').RuntimeKernel;
  readonly loader: RuntimeExtensionPackageLoader;
  readonly activationContext: InvocationContext;
  /** Host-owned Marshal placements that installed extensions may target. */
  readonly uiPlacementDefinitions?: readonly RuntimeExtensionUiHostPlacement[];
  /** Native hosts require navigation; resource-only hosts may expose UI resources without placements. */
  readonly uiPlacementsRequired?: boolean;
  /** Canonical host-owned service container; never cloned by the manager. */
  readonly services?: import('@marshal/agent-runtime-composer').RuntimeServiceContainer;
  readonly compositionRegistry?: import('@marshal/agent-runtime-composer').RuntimeCompositionRegistry;
  readonly stateStore?: RuntimeExtensionStateStore;
  readonly registerDurableEventConsumer?: (
    options: RuntimeDurableEventConsumerOptions<RuntimeLifecycleEventMap>,
  ) => RuntimeEventSubscription;
  readonly jobManager?: RuntimeExtensionJobManager;
  readonly registerLifecycle?: (
    lifecycle: RuntimeExtensionLifecyclePort,
  ) => MaybePromise<RuntimeExtensionOwnedRegistration>;
  readonly recoverJobHandlers?: (
    kinds: readonly string[],
  ) => MaybePromise<unknown>;
}

export interface RuntimeExtensionServiceContribution {
  readonly token: RuntimeServiceToken<any>;
  readonly binding: RuntimeServiceBinding<any>;
  readonly mode?: 'bind' | 'replace' | 'many';
}

export interface RuntimeExtensionEventSubscriptionContribution {
  readonly type: RuntimeLifecycleEventType | '*';
  readonly listener: RuntimeLifecycleListener<any>;
}

export interface RuntimeExtensionEventBus {
  subscribe(
    type: RuntimeLifecycleEventType | '*',
    listener: RuntimeLifecycleListener,
  ): { dispose(): void };
  subscribeDurable(
    options: RuntimeDurableEventConsumerOptions<RuntimeLifecycleEventMap>,
  ): RuntimeEventSubscription;
}

export interface RuntimeExtensionStoredRecord {
  readonly identity: string;
  readonly version: string;
  readonly request: RuntimeExtensionInstallRequest;
  readonly configuration?: RuntimeExtensionConfiguration;
  readonly providerOverrides?: Readonly<Record<string, string>>;
  /** Explicit canonical-to-effective service bindings selected during repair. */
  readonly contractBindings?: Readonly<Record<string, string>>;
  readonly status: RuntimeExtensionStatus;
}

export interface RuntimeExtensionStateStore {
  load(): MaybePromise<readonly RuntimeExtensionStoredRecord[]>;
  save(records: readonly RuntimeExtensionStoredRecord[]): MaybePromise<void>;
}
