export type MaybePromise<T> = T | Promise<T>;

export type JsonRecord = Readonly<Record<string, unknown>>;

export const ADAPTER_CONFORMANCE_CASES = [
  'protocol-negotiation',
  'exact-lookup',
  'operation-execution',
  'denial',
  'approval',
  'cancellation',
  'lifecycle-idempotency',
  'scope-isolation',
  'resource-fallback',
  'unsupported-native-effects',
  'receipts',
  'legacy-alias-normalization',
] as const;

export type AdapterConformanceCaseName = (typeof ADAPTER_CONFORMANCE_CASES)[number];

export interface AdapterCallContext {
  readonly principalId?: string;
  readonly scope: Readonly<Record<string, string | undefined>>;
  readonly requestId?: string;
  /** Adapter-native cancellation token. The fixture owns its concrete type. */
  readonly signal?: unknown;
  readonly metadata?: JsonRecord;
}

export interface AdapterSearchRequest {
  readonly protocolVersion: string;
  readonly name?: string;
  readonly query?: string;
  readonly tags?: readonly string[];
  readonly providerIds?: readonly string[];
  readonly limit?: number;
  readonly minScore?: number;
}

export interface AdapterOperationExecutionRequest {
  readonly protocolVersion: string;
  readonly targetType: 'operation';
  readonly target: string;
  readonly input?: unknown;
  readonly approval?: JsonRecord;
}

export interface AdapterLegacyOperationExecutionRequest {
  readonly protocolVersion: string;
  readonly operation: string;
  readonly input?: unknown;
  readonly approval?: JsonRecord;
}

export interface AdapterLegacyImplicitTargetExecutionRequest {
  readonly protocolVersion: string;
  readonly target: string;
  readonly input?: unknown;
  readonly approval?: JsonRecord;
}

export type AdapterExecutionRequest =
  | AdapterOperationExecutionRequest
  | AdapterLegacyOperationExecutionRequest
  | AdapterLegacyImplicitTargetExecutionRequest;

export interface AdapterLifecycleStartRequest {
  readonly protocolVersion: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly metadata?: JsonRecord;
}

export interface AdapterLifecycleObserveRequest {
  readonly protocolVersion: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly kind: 'user_message' | 'tool_result' | 'assistant_turn';
  readonly content: unknown;
  readonly metadata?: JsonRecord;
}

export interface AdapterLifecycleEndRequest {
  readonly protocolVersion: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly outcome?: string;
  readonly metadata?: JsonRecord;
}

export interface AdapterLifecyclePort {
  start(request: AdapterLifecycleStartRequest, context: AdapterCallContext): MaybePromise<unknown>;
  observe(request: AdapterLifecycleObserveRequest, context: AdapterCallContext): MaybePromise<unknown>;
  end(request: AdapterLifecycleEndRequest, context: AdapterCallContext): MaybePromise<unknown>;
}

export interface AdapterCancellationHandle {
  readonly signal: unknown;
  abort(reason?: unknown): void;
}

/**
 * Structural adapter surface used only by the test package. A harness fixture
 * can wrap native tools, MCP, hooks, HTTP, or an in-process adapter.
 */
export interface AdapterConformancePort {
  search(request: AdapterSearchRequest, context: AdapterCallContext): MaybePromise<unknown>;
  execute(request: AdapterExecutionRequest, context: AdapterCallContext): MaybePromise<unknown>;
  readonly lifecycle: AdapterLifecyclePort;
  /** Full adapter dispatch, including reserved-core precedence over resource tools. */
  callTool(name: string, input: JsonRecord, context: AdapterCallContext): MaybePromise<unknown>;
  createCancellation(): AdapterCancellationHandle;
}

export interface AdapterConformanceObservations {
  readonly capabilityInvocations: Readonly<Record<string, number>>;
  readonly lifecycleApplications: Readonly<Record<string, number>>;
  readonly resourceToolAttempts: Readonly<Record<string, number>>;
  readonly runtimeToolFallbacks: Readonly<Record<string, number>>;
}

export interface AdapterConformanceCapabilityManifest {
  /** Exact lookup and echo execution capability. */
  readonly echo: string;
  readonly denied: string;
  readonly approval: string;
  readonly cancellable: string;
  readonly scopeWrite: string;
  readonly scopeRead: string;
  readonly nativeEffects: string;
}

export interface AdapterConformanceResourceFallbackManifest {
  readonly toolName: string;
  readonly input: JsonRecord;
  readonly expectedOutput: unknown;
}

export interface AdapterConformanceLegacyAliasManifest {
  readonly operation?: boolean;
  readonly implicitTarget?: boolean;
}

export interface AdapterConformanceManifest {
  readonly supportedProtocolVersion: string;
  readonly unsupportedProtocolVersion: string;
  readonly capabilities: AdapterConformanceCapabilityManifest;
  readonly primaryContext: AdapterCallContext;
  readonly isolatedContext: AdapterCallContext;
  readonly resourceFallback: AdapterConformanceResourceFallbackManifest;
  readonly unsupportedEffectKind: string;
  /** Alias assertions run only for the aliases an adapter explicitly advertises. */
  readonly legacyAliases?: AdapterConformanceLegacyAliasManifest;
}

export interface AdapterConformanceEnvironment {
  readonly port: AdapterConformancePort;
  inspect(): MaybePromise<AdapterConformanceObservations>;
  dispose?(): MaybePromise<void>;
}

export interface AdapterConformanceFixture {
  readonly name: string;
  readonly manifest: AdapterConformanceManifest;
  /** Every case receives a fresh environment to avoid cross-case state leaks. */
  create(caseName: AdapterConformanceCaseName): MaybePromise<AdapterConformanceEnvironment>;
}

export type AdapterConformanceCaseStatus = 'passed' | 'failed' | 'skipped';

export interface AdapterConformanceCaseResult {
  readonly name: AdapterConformanceCaseName;
  readonly status: AdapterConformanceCaseStatus;
  readonly durationMs: number;
  readonly error?: { readonly message: string; readonly details?: unknown };
}

export interface AdapterConformanceReport {
  readonly adapterName: string;
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cases: readonly AdapterConformanceCaseResult[];
}
