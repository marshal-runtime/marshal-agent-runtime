/** The transport contract version implemented by this package. */
export const RUNTIME_PROTOCOL_VERSION = '1.0.0' as const;

export type RuntimeProtocolVersion = typeof RUNTIME_PROTOCOL_VERSION;

export type MaybePromise<T> = T | Promise<T>;

export interface Disposable {
  dispose(): void;
}

export interface RuntimeAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export interface RuntimePrincipal {
  readonly id: string;
  readonly kind: 'agent' | 'user' | 'service' | string;
  readonly claims?: Readonly<Record<string, unknown>>;
}

/** Stable harness-owned identity projected into the portable runtime. */
export interface RuntimeHarnessIdentity {
  /** Harness family, for example `codex` or `mcp-apps`. */
  readonly harnessId: string;
  /** Stable installation boundary. It must not change between tasks. */
  readonly installationId?: string;
  /** Stable signed-in profile boundary when the harness exposes one. */
  readonly profileId?: string;
  /** Stable end-user boundary when it differs from the profile. */
  readonly userId?: string;
  /** Harness-native agent identity for this invocation. */
  readonly agentId?: string;
}

export interface RuntimeScope {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly parentExecutionId?: string;
  readonly [key: string]: string | undefined;
}

declare const runtimeReceiptCorrelationContextBrand: unique symbol;

/** Opaque carrier created by a trusted harness adapter for receipt-only correlations. */
export interface RuntimeReceiptCorrelationContext {
  readonly [runtimeReceiptCorrelationContextBrand]: true;
}

export type RuntimeExecutionCorrelationName =
  | 'mcpRequestId'
  | 'codexToolUseId'
  | 'callerRequestId';

export type RuntimeExecutionCorrelationAuthority =
  | 'transport-correlation'
  | 'untrusted-correlation';

interface RuntimeExecutionCorrelationBase {
  readonly name: RuntimeExecutionCorrelationName;
  readonly authority: RuntimeExecutionCorrelationAuthority;
}

export type RuntimeExecutionCorrelation =
  | (RuntimeExecutionCorrelationBase & {
      readonly type: 'number';
      readonly value: number;
    })
  | (RuntimeExecutionCorrelationBase & {
      readonly type: 'string';
      readonly value: string;
    })
  | (RuntimeExecutionCorrelationBase & {
      readonly type: 'sha256';
      readonly algorithm: 'sha256';
      readonly digest: string;
      readonly originalType: 'string';
      readonly length: number;
    });

/** Context supplied by a harness for every discovery or execution operation. */
export interface InvocationContext {
  readonly principal: RuntimePrincipal;
  readonly identity?: RuntimeHarnessIdentity;
  readonly scope?: RuntimeScope;
  readonly executionId?: string;
  readonly lineage?: RuntimeExecutionLineage;
  readonly signal?: RuntimeAbortSignal;
  /** Kernel-supplied approval evidence for a provider that must broker a nested operation. */
  readonly approval?: Readonly<Record<string, unknown>>;
  /** Trusted opaque carrier; arbitrary metadata is never projected into receipts. */
  readonly receiptCorrelationContext?: RuntimeReceiptCorrelationContext;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Explicit execution ancestry; adapters and brokers must not infer it from prose. */
export interface RuntimeExecutionLineage {
  readonly rootExecutionId: string;
  readonly parentExecutionId?: string;
  readonly depth: number;
}

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface CapabilityPermissionRequirement {
  readonly permission: string;
  readonly reason?: string;
  readonly scope?: string;
  readonly risk?: 'low' | 'medium' | 'high' | 'critical';
}

/** Provider-authored, versioned description of one callable capability. */
export interface CapabilityDescriptor {
  readonly protocolVersion: string;
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly inputSchema?: JsonSchema;
  /** Strict schema for the provider's semantic `result.output` value. */
  readonly outputSchema: JsonSchema;
  readonly permissions?: readonly CapabilityPermissionRequirement[];
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface RuntimeProviderIdentity {
  readonly id: string;
  readonly version?: string;
}

/** Descriptor resolved by the kernel, including the provider that owns it. */
export interface RuntimeCapabilityDescriptor extends CapabilityDescriptor {
  readonly provider: RuntimeProviderIdentity;
}

/** Schema-light capability projection returned by broad summary searches. */
export type RuntimeCapabilitySummary = Omit<
  RuntimeCapabilityDescriptor,
  'inputSchema' | 'outputSchema' | 'annotations'
> & {
  readonly inputSchema?: undefined;
  readonly outputSchema?: undefined;
  readonly annotations?: undefined;
};

export interface ProvenanceRecord {
  readonly source: string;
  readonly uri?: string;
  readonly retrievedAt?: string;
  readonly contentDigest?: string;
  readonly trust?: 'unverified' | 'low' | 'medium' | 'high' | 'authoritative';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeDiagnostic {
  readonly level: 'debug' | 'info' | 'warning' | 'error';
  readonly code?: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: unknown;
}

export interface RuntimeArtifactReference {
  readonly id: string;
  readonly kind: string;
  readonly uri?: string;
  readonly mediaType?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Provider output. The envelope is preserved intact by runtimeExec. */
export interface CapabilityInvocationResult<TOutput = unknown> {
  readonly output: TOutput;
  readonly provenance?: readonly ProvenanceRecord[];
  readonly diagnostics?: readonly RuntimeDiagnostic[];
  readonly artifacts?: readonly RuntimeArtifactReference[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly receipt?: unknown;
}

export interface CapabilityProvider {
  readonly id: string;
  readonly version?: string;
  /**
   * A fallback provider answers a capability name only while no other provider declares it. When a
   * non-fallback provider (for example an extension) declares the same name, the fallback's descriptor
   * is ignored instead of raising DuplicateCapabilityError. Two fallbacks for one name still collide.
   */
  readonly fallback?: boolean;
  list(context: InvocationContext): MaybePromise<readonly CapabilityDescriptor[]>;
  get?(name: string, context: InvocationContext): MaybePromise<CapabilityDescriptor | undefined>;
  invoke(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): MaybePromise<CapabilityInvocationResult>;
}

export type RuntimeSearchDetail = 'summary' | 'full';

export const RUNTIME_RESOURCE_URI_MAX_LENGTH = 8_192;
/**
 * Percent-encoding one valid UTF-16 resource URI code unit can require at most
 * nine characters. The prefix allowance covers provider-qualified catalog IDs.
 */
export const RUNTIME_CATALOG_ID_MAX_LENGTH =
  RUNTIME_RESOURCE_URI_MAX_LENGTH * 9 + 256;

export function requireRuntimeCatalogId(
  value: unknown,
  label = 'Runtime catalog id',
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (value.length > RUNTIME_CATALOG_ID_MAX_LENGTH) {
    throw new TypeError(
      `${label} must be at most ${RUNTIME_CATALOG_ID_MAX_LENGTH} characters.`,
    );
  }
  return value;
}

export interface RuntimeSearchRequest {
  readonly protocolVersion: string;
  /** Exact capability name lookup. Avoids relying on semantic ranking. */
  readonly name?: string;
  /** Exact non-capability catalog lookup. */
  readonly catalogId?: string;
  readonly query?: string;
  /**
   * Descriptor detail for broad discovery. Broad searches default to
   * `summary`; an exact `name` lookup always returns `full` detail.
   */
  readonly detail?: RuntimeSearchDetail;
  /** Every supplied tag must be present on a result. */
  readonly tags?: readonly string[];
  readonly providerIds?: readonly string[];
  readonly limit?: number;
  readonly minScore?: number;
}

export interface RuntimeSearchMatch<
  TCapability extends RuntimeCapabilityDescriptor | RuntimeCapabilitySummary =
    RuntimeCapabilityDescriptor | RuntimeCapabilitySummary,
> {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly capability: TCapability;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly matchedFields: readonly ('name' | 'title' | 'description' | 'tags')[];
}

export type RuntimeCatalogEntryKind = 'skill' | 'resource' | 'host_tool' | 'ui_application';

export type RuntimeCatalogAction =
  | { readonly type: 'resource_read'; readonly uri: string }
  | { readonly type: 'host_tool'; readonly toolId: string }
  | {
      readonly type: 'ui_render';
      readonly renderId: string;
      readonly resourceUri: string;
    };

/** Non-capability item discoverable through runtime_search. */
export interface RuntimeCatalogEntry {
  readonly id: string;
  readonly kind: RuntimeCatalogEntryKind;
  readonly title: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly action: RuntimeCatalogAction;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeCatalogProvider {
  readonly id: string;
  list(context: InvocationContext): MaybePromise<readonly RuntimeCatalogEntry[]>;
  get?(
    id: string,
    context: InvocationContext,
  ): MaybePromise<RuntimeCatalogEntry | undefined>;
}

export interface RuntimeCatalogSearchMatch {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly entry: RuntimeCatalogEntry;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly matchedFields: readonly ('id' | 'title' | 'description' | 'tags')[];
}

export interface RuntimeSearchResponse {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly query: string;
  /** Effective detail after applying the exact-name/full-detail invariant. */
  readonly detail: RuntimeSearchDetail;
  readonly matches: readonly RuntimeSearchMatch[];
  /** Additive non-capability discoveries; existing capability callers may ignore this field. */
  readonly discoveries?: readonly RuntimeCatalogSearchMatch[];
}

export interface RuntimeExecRequest {
  readonly protocolVersion: string;
  readonly target: string;
  readonly input?: unknown;
  readonly requestId?: string;
  readonly approval?: Readonly<Record<string, unknown>>;
}

/** Adapter-friendly request for a named provider operation. */
export interface RuntimeOperationExecuteRequest extends RuntimeExecRequest {
  readonly targetType: 'operation';
  readonly target: string;
}

/**
 * Adapter-friendly request for source execution. A dedicated provider owns the
 * actual compilation and isolation policy; the core only brokers the call.
 */
export interface RuntimeInlineModuleExecuteRequest {
  readonly protocolVersion: string;
  readonly targetType: 'inline_module';
  readonly source: string;
  /** Override the source-executor capability when a harness provides several. */
  readonly target?: string;
  readonly input?: unknown;
  readonly executionMode?: 'brokered' | 'trusted_node';
  readonly requestId?: string;
  readonly approval?: Readonly<Record<string, unknown>>;
}

export interface RuntimeInlineModuleSourceReference {
  readonly kind: 'inline';
  readonly source: string;
  readonly filename?: string;
  readonly export?: string;
}

export interface RuntimeWorkspaceModuleSourceReference {
  readonly kind: 'workspace_file';
  /** Workspace-relative path. Absolute paths and symbolic links are rejected. */
  readonly path: string;
  readonly export?: string;
}

export interface RuntimeArtifactModuleSourceReference {
  readonly kind: 'artifact';
  /** Logical artifact path resolved by the runtime artifact capability. */
  readonly path: string;
  readonly scope?: 'workspace' | 'project' | 'session';
  readonly export?: string;
}

/** Portable source identity. Resolution remains a host/provider responsibility. */
export type RuntimeModuleSourceReference =
  | RuntimeInlineModuleSourceReference
  | RuntimeWorkspaceModuleSourceReference
  | RuntimeArtifactModuleSourceReference;

/** Editable file/artifact execution without introducing a workflow abstraction. */
export interface RuntimeModuleExecuteRequest {
  readonly protocolVersion: string;
  readonly targetType: 'module';
  readonly module: RuntimeModuleSourceReference;
  /** Override the source-executor capability when a harness provides several. */
  readonly target?: string;
  readonly input?: unknown;
  readonly executionMode?: 'brokered' | 'trusted_node';
  readonly requestId?: string;
  readonly approval?: Readonly<Record<string, unknown>>;
}

export type RuntimeExecuteRequest =
  RuntimeOperationExecuteRequest | RuntimeInlineModuleExecuteRequest | RuntimeModuleExecuteRequest;

export interface PermissionCheck {
  readonly capability: RuntimeCapabilityDescriptor;
  readonly request: RuntimeExecRequest;
  readonly context: InvocationContext;
  readonly requirements: readonly CapabilityPermissionRequirement[];
}

export interface PermissionAllowDecision {
  readonly decision: 'allow';
  readonly reason?: string;
  readonly grants?: readonly string[];
}

export interface PermissionDenyDecision {
  readonly decision: 'deny';
  readonly reason: string;
  readonly code?: string;
}

export interface PermissionApprovalDecision {
  readonly decision: 'approval';
  readonly reason: string;
  readonly approvalId?: string;
  readonly prompt?: string;
  readonly expiresAt?: string;
}

export type PermissionDecision =
  PermissionAllowDecision | PermissionDenyDecision | PermissionApprovalDecision;

export interface PermissionBroker {
  decide(check: PermissionCheck): MaybePromise<PermissionDecision>;
}

export type RuntimeExecutionStatus =
  'success' | 'not_found' | 'denied' | 'approval_required' | 'failed' | 'cancelled';

export interface RuntimeError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface RuntimeExecutionReceipt {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly receiptId: string;
  readonly executionId: string;
  readonly requestId?: string;
  readonly target: string;
  readonly provider?: RuntimeProviderIdentity;
  readonly capabilityVersion?: string;
  readonly principalId: string;
  readonly identity?: RuntimeHarnessIdentity;
  readonly scope?: RuntimeScope;
  readonly lineage: RuntimeExecutionLineage;
  /** Optional bounded adapter-sanitized audit correlations. */
  readonly correlations?: readonly RuntimeExecutionCorrelation[];
  readonly status: RuntimeExecutionStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly permission?: PermissionDecision;
  readonly provenance?: readonly ProvenanceRecord[];
  readonly diagnostics?: readonly RuntimeDiagnostic[];
  readonly artifacts?: readonly RuntimeArtifactReference[];
  readonly providerReceipt?: unknown;
}

export interface RuntimeReceiptQuery {
  readonly rootExecutionId?: string;
  readonly parentExecutionId?: string;
  readonly principalId?: string;
  readonly limit?: number;
}

/** Append-only receipt boundary. Durable implementations may live in a host package. */
export interface RuntimeReceiptSink {
  record(receipt: RuntimeExecutionReceipt): MaybePromise<void>;
}

export interface RuntimeReceiptStore extends RuntimeReceiptSink {
  list(query?: RuntimeReceiptQuery): MaybePromise<readonly RuntimeExecutionReceipt[]>;
}

export interface RuntimeExecResponse<TOutput = unknown> {
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly status: RuntimeExecutionStatus;
  readonly result?: CapabilityInvocationResult<TOutput>;
  readonly error?: RuntimeError;
  readonly approval?: PermissionApprovalDecision;
  readonly receipt: RuntimeExecutionReceipt;
}

export class UnsupportedProtocolVersionError extends Error {
  readonly code = 'unsupported_protocol_version';

  constructor(readonly receivedVersion: string) {
    super(`Unsupported runtime protocol version "${receivedVersion}"; expected major version 1.`);
    this.name = 'UnsupportedProtocolVersionError';
  }
}

export class DuplicateCapabilityError extends Error {
  readonly code = 'duplicate_capability';

  constructor(
    readonly capabilityName: string,
    readonly providerIds: readonly string[],
  ) {
    super(
      `Capability "${capabilityName}" is declared by multiple providers: ${providerIds.join(', ')}.`,
    );
    this.name = 'DuplicateCapabilityError';
  }
}

export class DuplicateProviderError extends Error {
  readonly code = 'duplicate_provider';

  constructor(readonly providerId: string) {
    super(`Provider "${providerId}" is already registered.`);
    this.name = 'DuplicateProviderError';
  }
}

export class InvalidCapabilityDescriptorError extends Error {
  readonly code = 'invalid_capability_descriptor';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidCapabilityDescriptorError';
  }
}

export function isSupportedProtocolVersion(version: string): boolean {
  const major = /^(\d+)\./.exec(version)?.[1];
  return major === '1';
}

export function assertSupportedProtocolVersion(version: string): void {
  if (!isSupportedProtocolVersion(version)) {
    throw new UnsupportedProtocolVersionError(version);
  }
}
