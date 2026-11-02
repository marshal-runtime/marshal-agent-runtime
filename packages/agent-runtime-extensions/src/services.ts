import { createRuntimeServiceToken } from '@marshal/agent-runtime-composer';
import type { InvocationContext, MaybePromise, RuntimeAbortSignal } from '@marshal/agent-runtime-core';
import type {
  RuntimeExtensionAgentGuidance,
  RuntimeExtensionConfiguration,
  RuntimeExtensionInstallRequest,
  RuntimeExtensionInstallOptions,
  RuntimeExtensionOperationOptions,
  RuntimeExtensionPackageManager,
  RuntimeExtensionPackageDiscovery,
  RuntimeExtensionRecord,
  RuntimeExtensionUiApplication,
  RuntimeExtensionUiPlacement,
} from './contracts.js';

export interface RuntimeExtensionContractBindingChoice {
  readonly canonicalService: string;
  readonly providerIdentity: string;
  readonly effectiveService: string;
  readonly publicName: string;
}

export interface RuntimeExtensionContractConflict {
  readonly canonicalService: string;
  readonly owners: readonly {
    readonly identity: string;
    readonly contract: unknown;
  }[];
  readonly proposedBindings: readonly RuntimeExtensionContractBindingChoice[];
  readonly affectedDependents: readonly string[];
  readonly request: RuntimeExtensionContractRepairRequest;
}

export interface RuntimeExtensionContractRepairRequest {
  readonly canonicalService: string;
  readonly bindings: readonly RuntimeExtensionContractBindingChoice[];
  readonly enable?: readonly string[];
}

export interface RuntimeExtensionContractRepairResult {
  readonly canonicalService: string;
  readonly bindings: readonly RuntimeExtensionContractBindingChoice[];
  readonly conflicts: readonly RuntimeExtensionContractConflict[];
  readonly enabled: readonly string[];
}

export type RuntimeExtensionCatalogOrigin =
  | 'native'
  | 'dsh'
  | 'authored-typescript';

export interface RuntimeExtensionCatalogSourceEntry {
  readonly id: string;
  readonly identity: string;
  readonly version: string;
  readonly origin: RuntimeExtensionCatalogOrigin;
  readonly title: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly publisher?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly order?: number;
  readonly request: RuntimeExtensionInstallRequest;
}

export interface RuntimeExtensionCatalogEntry
  extends RuntimeExtensionCatalogSourceEntry {
  readonly originLabel: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly sourceOrder: number;
  readonly order: number;
  readonly installation?: RuntimeExtensionRecord;
  readonly isCurrentVersion: boolean;
  readonly health?: RuntimeExtensionHealth;
  readonly blockReasons?: readonly RuntimeExtensionBlockReason[];
  readonly dependencies?: readonly unknown[];
  readonly providedServices?: readonly unknown[];
  readonly requiredServices?: readonly unknown[];
  readonly providerSelections?: readonly RuntimeExtensionProviderSelection[];
  readonly contracts?: readonly unknown[];
  readonly configurationSchema?: unknown;
  readonly configurationValues?: RuntimeExtensionConfiguration;
  readonly docs?: unknown;
  readonly resources?: unknown;
  readonly examples?: unknown;
  readonly appServices?: unknown;
  readonly appServicesSnippet?: string;
  readonly originalAppServicesSnippet?: string;
  readonly contractConflicts?: readonly RuntimeExtensionContractConflict[];
}

export type RuntimeExtensionCatalogSearchField =
  | 'id'
  | 'identity'
  | 'origin'
  | 'source'
  | 'title'
  | 'description'
  | 'publisher'
  | 'tags';

export type RuntimeExtensionCatalogInstallationFilter =
  | 'enabled'
  | 'disabled'
  | 'not-installed';

export interface RuntimeExtensionCatalogSearchRequest {
  readonly query?: string;
  readonly origins?: readonly RuntimeExtensionCatalogOrigin[];
  readonly tags?: readonly string[];
  readonly installation?: RuntimeExtensionCatalogInstallationFilter;
  readonly limit?: number;
}

export interface RuntimeExtensionCatalogSearchMatch {
  readonly entry: RuntimeExtensionCatalogEntry;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly matchedFields: readonly RuntimeExtensionCatalogSearchField[];
}

export interface RuntimeExtensionCatalogSearchResponse {
  readonly query: string;
  readonly matches: readonly RuntimeExtensionCatalogSearchMatch[];
}

export interface RuntimeExtensionLifecycleService {
  restore(
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<readonly RuntimeExtensionRecord[]>;
  discover(
    discovery: RuntimeExtensionPackageDiscovery,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<readonly RuntimeExtensionRecord[]>;
  install(
    request: RuntimeExtensionInstallRequest,
    options?: RuntimeExtensionInstallOptions,
  ): Promise<RuntimeExtensionRecord>;
  update(
    identity: string,
    request: RuntimeExtensionInstallRequest,
    options?: RuntimeExtensionInstallOptions,
  ): Promise<RuntimeExtensionRecord>;
  configure(
    identity: string,
    configuration: RuntimeExtensionConfiguration,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<RuntimeExtensionRecord>;
  setProviderOverride(
    identity: string,
    service: string,
    providerIdentity: string,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<RuntimeExtensionRecord>;
  clearProviderOverride(
    identity: string,
    service: string,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<RuntimeExtensionRecord>;
  readonly repairContractConflict?: (
    request: RuntimeExtensionContractRepairRequest,
    options?: RuntimeExtensionOperationOptions,
  ) => MaybePromise<RuntimeExtensionContractRepairResult>;
  enable(
    identity: string,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionRecord>;
  disable(
    identity: string,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionRecord>;
  remove(
    identity: string,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<void>;
  get(identity: string): RuntimeExtensionLifecycleRecord | undefined;
  list(): readonly RuntimeExtensionLifecycleRecord[];
}

export type RuntimeExtensionHealth =
  | 'healthy'
  | 'blocked'
  | 'disabled'
  | 'not-installed';

export interface RuntimeExtensionBlockReason {
  readonly code: string;
  readonly message: string;
  readonly dependency?: string;
  readonly service?: string;
  readonly provider?: string;
}

export interface RuntimeExtensionProviderSelection {
  readonly service: string;
  readonly alternatives: readonly string[];
  readonly selected?: string;
  readonly override?: string;
  readonly collision?: boolean;
}

export interface RuntimeExtensionLifecycleRecord extends RuntimeExtensionRecord {
  readonly request: RuntimeExtensionInstallRequest;
  readonly origin?: RuntimeExtensionCatalogOrigin;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly publisher?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly health: RuntimeExtensionHealth;
  readonly blockReasons: readonly RuntimeExtensionBlockReason[];
  readonly dependencies: readonly unknown[];
  readonly providedServices: readonly unknown[];
  readonly requiredServices: readonly unknown[];
  readonly providerSelections: readonly RuntimeExtensionProviderSelection[];
  readonly contracts?: readonly unknown[];
  readonly configurationSchema?: unknown;
  readonly configurationValues: RuntimeExtensionConfiguration;
  readonly docs?: unknown;
  readonly resources?: unknown;
  readonly examples?: unknown;
  readonly appServices?: unknown;
  readonly appServicesSnippet?: string;
  /** Manifest-declared, bounded prompt guidance for agent system prompts. */
  readonly agentGuidance?: RuntimeExtensionAgentGuidance;
  readonly providerOverrides: Readonly<Record<string, string>>;
  readonly contractConflicts: readonly RuntimeExtensionContractConflict[];
  /** Capability providers currently registered by this extension. */
  readonly capabilityProviderIds: readonly string[];
  /** Manifest-declared capability namespaces this extension may invoke through host services. */
  readonly contributedCapabilityPrefixes?: readonly string[];
}

export interface RuntimeExtensionAutopilotEntry {
  readonly identity: string;
  readonly enabled: boolean;
  readonly capabilityProviderIds: readonly string[];
  readonly contributedCapabilityPrefixes: readonly string[];
}

export interface RuntimeExtensionAutopilotSnapshot {
  readonly globalEnabled: boolean;
  readonly extensions: readonly RuntimeExtensionAutopilotEntry[];
}

/** Host-persisted permission policy surfaced through the shared extensions manager. */
export interface RuntimeExtensionAutopilotService {
  refresh(): MaybePromise<void>;
  snapshot(): RuntimeExtensionAutopilotSnapshot;
  setGlobal(enabled: boolean): MaybePromise<void>;
  setExtension(
    identity: string,
    enabled: boolean,
    capabilityProviderIds?: readonly string[],
    contributedCapabilityPrefixes?: readonly string[],
  ): MaybePromise<void>;
  syncExtensions(records: readonly RuntimeExtensionLifecycleRecord[]): MaybePromise<void>;
}

export const RUNTIME_EXTENSION_LIFECYCLE_SERVICE =
  createRuntimeServiceToken<RuntimeExtensionLifecycleService>(
    '@marshal/agent-runtime-extensions:lifecycle',
  );

export interface RuntimeExtensionCatalogSource {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  list(
    context: InvocationContext,
    signal?: RuntimeAbortSignal,
  ): MaybePromise<readonly RuntimeExtensionCatalogSourceEntry[]>;
}

export const RUNTIME_EXTENSION_CATALOG_SOURCE =
  createRuntimeServiceToken<RuntimeExtensionCatalogSource>(
    '@marshal/agent-runtime-extensions:catalog-source',
  );

export interface RuntimeAuthoredUiPromotionRequest {
  readonly applicationId: string;
  readonly snapshotDigest: string;
  readonly packageIdentity: string;
  readonly packageVersion: string;
  readonly catalogEntryId: string;
}

export interface RuntimeAuthoredUiPromotionResult {
  readonly applicationId: string;
  readonly snapshotDigest: string;
  readonly packageIdentity: string;
  readonly packageVersion: string;
  readonly catalogEntryId: string;
  readonly action: 'installed' | 'updated' | 'unchanged';
}

export interface RuntimeAuthoredUiPromotionService {
  readonly catalogSource: RuntimeExtensionCatalogSource;
  promote(
    request: RuntimeAuthoredUiPromotionRequest,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeAuthoredUiPromotionResult>;
}

export const RUNTIME_AUTHORED_UI_PROMOTION_SERVICE =
  createRuntimeServiceToken<RuntimeAuthoredUiPromotionService>(
    '@marshal/agent-runtime-extensions:authored-ui-promotion',
  );

export interface RuntimeExtensionCatalogService {
  discover(
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<readonly RuntimeExtensionCatalogEntry[]>;
  get(
    id: string,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionCatalogEntry | undefined>;
  search(
    request: RuntimeExtensionCatalogSearchRequest,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionCatalogSearchResponse>;
  install(
    catalogEntryId: string,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionRecord>;
  update(
    identity: string,
    catalogEntryId: string,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionRecord>;
  enable(
    identity: string,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionRecord>;
  disable(
    identity: string,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionRecord>;
  remove(
    identity: string,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<void>;
  listInstalled(context: InvocationContext): readonly RuntimeExtensionRecord[];
  readonly repairContractConflict?: (
    request: RuntimeExtensionContractRepairRequest,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ) => MaybePromise<RuntimeExtensionContractRepairResult>;
}

export const RUNTIME_EXTENSION_CATALOG_SERVICE =
  createRuntimeServiceToken<RuntimeExtensionCatalogService>(
    '@marshal/agent-runtime-extensions:catalog',
  );

export type RuntimeExtensionLiveStatus =
  | 'detected-unbuilt'
  | 'detected-installable'
  | 'installing-building'
  | 'installed-enabled'
  | 'installed-disabled'
  | 'invalid'
  | 'unreadable'
  | 'failed';

export type RuntimeExtensionInstallationPhase =
  | 'validating'
  | 'running-script'
  | 'activating';

export interface RuntimeExtensionInstallCommand {
  readonly packageManager: RuntimeExtensionPackageManager;
  readonly script: string;
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface RuntimeExtensionStatusConfiguration {
  readonly schema?: unknown;
  readonly defaults: RuntimeExtensionConfiguration;
  readonly values?: RuntimeExtensionConfiguration;
}

export interface RuntimeExtensionStatusDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface RuntimeExtensionStatusEntry {
  readonly key: string;
  readonly packageRoot: string;
  readonly identity?: string;
  readonly version?: string;
  readonly entrypoint?: string;
  readonly catalogEntryId?: string;
  readonly status: RuntimeExtensionLiveStatus;
  readonly installationPhase?: RuntimeExtensionInstallationPhase;
  readonly installCommand?: RuntimeExtensionInstallCommand;
  readonly configuration: RuntimeExtensionStatusConfiguration;
  readonly diagnostics: readonly RuntimeExtensionStatusDiagnostic[];
}

export interface RuntimeExtensionStatusSnapshot {
  readonly revision: number;
  readonly status: 'ready' | 'error';
  readonly changedAt: string;
  readonly roots: readonly string[];
  readonly entries: readonly RuntimeExtensionStatusEntry[];
  readonly diagnostics: readonly RuntimeExtensionStatusDiagnostic[];
}

export interface RuntimeExtensionStatusInstallRequest {
  readonly packageRoot: string;
  readonly configuration?: RuntimeExtensionConfiguration;
  readonly enabled?: boolean;
}

export type RuntimeExtensionStatusListener = (
  snapshot: RuntimeExtensionStatusSnapshot,
) => MaybePromise<void>;

export interface RuntimeExtensionStatusSubscription {
  dispose(): MaybePromise<void>;
}

/**
 * Portable host-administration surface for live extension discovery and
 * lifecycle changes. Node-specific package preparation remains host-owned.
 */
export interface RuntimeExtensionStatusService {
  snapshot(): RuntimeExtensionStatusSnapshot;
  subscribe(listener: RuntimeExtensionStatusListener): RuntimeExtensionStatusSubscription;
  refresh(
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionStatusSnapshot>;
  install(
    request: RuntimeExtensionStatusInstallRequest,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionRecord>;
  enable(
    identity: string,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionRecord>;
  disable(
    identity: string,
    options?: RuntimeExtensionOperationOptions,
  ): Promise<RuntimeExtensionRecord>;
  remove(
    identity: string,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<void>;
}

export const RUNTIME_EXTENSION_STATUS_SERVICE =
  createRuntimeServiceToken<RuntimeExtensionStatusService>(
    '@marshal/agent-runtime-extensions:status',
  );

export interface RuntimeExtensionUiPublicationInput {
  readonly applicationId: string;
  readonly input: unknown;
}

export type RuntimeExtensionUiPublishedApplication =
  RuntimeExtensionUiApplication & {
    readonly ownerId: string;
    readonly revisionId: string;
  };

export type RuntimeExtensionUiPublishedPlacement =
  RuntimeExtensionUiPlacement & {
    readonly ownerId: string;
    readonly revisionId: string;
  };

export interface RuntimeExtensionUiPublicationRevision {
  readonly ownerId: string;
  readonly revisionId: string;
  readonly applications: readonly RuntimeExtensionUiApplication[];
  readonly placements: readonly RuntimeExtensionUiPlacement[];
  readonly inputs?: readonly RuntimeExtensionUiPublicationInput[];
}

export interface RuntimeExtensionUiPlacementState {
  readonly placements: readonly RuntimeExtensionUiPlacement[];
}

export interface RuntimeExtensionUiPublicationService {
  preparePublicationRevision(
    ownerId: string,
    revisionId: string,
    revision: RuntimeExtensionUiPublicationRevision,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<RuntimeExtensionUiPublicationRevision>;
  listApplications(
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<readonly RuntimeExtensionUiPublishedApplication[]>;
  listApplications(
    ownerId: string | undefined,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<readonly RuntimeExtensionUiPublishedApplication[]>;
  resolvePlacementState(
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<RuntimeExtensionUiPlacementState>;
  revoke(
    ownerId: string,
    revisionId: string,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<void>;
  rollback(
    ownerId: string,
    revisionId: string,
    context: InvocationContext,
    options?: RuntimeExtensionOperationOptions,
  ): MaybePromise<void>;
}

export const RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE =
  createRuntimeServiceToken<RuntimeExtensionUiPublicationService>(
    '@marshal/agent-runtime-extensions:ui-publication',
  );
