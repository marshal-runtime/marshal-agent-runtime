import { createHash } from 'node:crypto';
import type {
  InvocationContext,
  RuntimeAbortSignal,
  RuntimeLifecycleListener,
  RuntimeCatalogEntry,
  RuntimeCatalogProvider,
  RuntimeKernelContributionRegistration,
  RuntimeKernelContributionSet,
} from '@marshal/agent-runtime-core';
import {
  RUNTIME_RESOURCE_URI_MAX_LENGTH,
  type RuntimeKernel,
} from '@marshal/agent-runtime-core';
import {
  getRuntimeServiceContainer,
  RuntimeCompositionRegistry,
  createRuntimeCompositionServiceDescriptor,
  runtimeCompositionContractDifference,
  type RuntimeCompositionContractDescriptor,
  type RuntimeResourceContent,
  type RuntimeResourceDescriptor,
  type RuntimeScopedResourcePort,
  type RuntimeServiceBindingHandle,
  type RuntimeServiceBinding,
  type RuntimeServiceContainer,
  type RuntimeServiceAccessor,
} from '@marshal/agent-runtime-composer';
import { validateUiApplicationManifest } from '@marshal/agent-runtime-ui';
import {
  type LoadedRuntimeExtensionPackage,
  type RuntimeExtensionActivation,
  type RuntimeExtensionJobEnqueuer,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionManagerOptions,
  type RuntimeExtensionOperationOptions,
  type RuntimeExtensionPackageLoader,
  type RuntimeExtensionRecord,
  type RuntimeExtensionStateStore,
  type RuntimeExtensionUiApplication,
  type RuntimeExtensionUiPlacement,
} from './contracts.js';
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionLifecycleService,
  type RuntimeExtensionUiPublicationService,
  type RuntimeExtensionLifecycleRecord,
  type RuntimeExtensionBlockReason,
  type RuntimeExtensionProviderSelection,
  type RuntimeExtensionContractConflict,
  type RuntimeExtensionContractRepairRequest,
  type RuntimeExtensionContractRepairResult,
} from './services.js';
import {
  resolveRuntimeExtensionConfiguration,
  validateRuntimeExtensionConfiguration,
} from './configuration.js';
import {
  RuntimeExtensionPackageError,
} from './loader.js';
import { requireRuntimeExtensionIdentity } from './manifest.js';
import {
  RuntimeExtensionUiPlacementRegistry,
  type ResolvedRuntimeExtensionUiPlacement,
  type RuntimeExtensionUiHostPlacement,
  type RuntimeExtensionUiPlacementDiagnostic,
  type RuntimeExtensionUiPlacementRegistration,
  type RuntimeExtensionUiPlacementRegistryResolution,
} from './uiPlacement.js';

export type RuntimeExtensionErrorCode =
  | 'ALREADY_INSTALLED'
  | 'NOT_INSTALLED'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_CONTRIBUTIONS'
  | 'ACTIVATION_FAILED'
  | 'REGISTRATION_FAILED'
  | 'DISPOSAL_FAILED'
  | 'CANCELLED'
  | 'MANAGER_DISPOSED'
  | 'RESOURCE_NOT_FOUND'
  | 'DUPLICATE_RESOURCE'
  | 'UI_PLACEMENT_REGISTRATION_FAILED'
  | 'STATE_FAILED'
  | 'RESTORE_FAILED';

const ERROR_MESSAGES: Readonly<Record<RuntimeExtensionErrorCode, string>> = {
  ALREADY_INSTALLED: 'The runtime extension is already installed.',
  NOT_INSTALLED: 'The runtime extension is not installed.',
  IDENTITY_MISMATCH: 'The update package identity does not match the installed extension.',
  INVALID_CONTRIBUTIONS: 'The runtime extension returned invalid contributions.',
  ACTIVATION_FAILED: 'The runtime extension failed to activate.',
  REGISTRATION_FAILED: 'The runtime extension contributions could not be registered.',
  DISPOSAL_FAILED: 'The runtime extension cleanup failed.',
  CANCELLED: 'The runtime extension operation was cancelled.',
  MANAGER_DISPOSED: 'The runtime extension manager is disposed.',
  RESOURCE_NOT_FOUND: 'The runtime extension resource was not found.',
  DUPLICATE_RESOURCE: 'Multiple runtime extensions own the same resource URI.',
  UI_PLACEMENT_REGISTRATION_FAILED:
    'The runtime extension UI placements could not be registered.',
  STATE_FAILED: 'Runtime extension state could not be persisted.',
  RESTORE_FAILED: 'Persisted runtime extension state could not be restored.',
};

export class RuntimeExtensionError extends Error {
  constructor(readonly code: RuntimeExtensionErrorCode, cause?: unknown) {
    super(
      `${ERROR_MESSAGES[code]}${formatErrorCause(cause)}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'RuntimeExtensionError';
  }
}

export class RuntimeExtensionUiPlacementRegistrationError extends Error {
  readonly code = 'RUNTIME_EXTENSION_UI_PLACEMENT_REGISTRATION_REJECTED' as const;

  constructor(readonly diagnostics: readonly RuntimeExtensionUiPlacementDiagnostic[]) {
    super(diagnostics.map(({ message }) => message).join(' '));
    this.name = 'RuntimeExtensionUiPlacementRegistrationError';
  }
}

export interface RuntimeExtensionUiPlacements {
  listPlacements(): readonly RuntimeExtensionUiHostPlacement[];
  listContributions(
    extensionId?: string,
  ): readonly RuntimeExtensionUiPlacementRegistration[];
  resolve(placementId: string): ResolvedRuntimeExtensionUiPlacement | undefined;
  resolveAll(): RuntimeExtensionUiPlacementRegistryResolution;
}

interface PreparedActivation {
  readonly loaded: LoadedRuntimeExtensionPackage;
  readonly activation: RuntimeExtensionActivation;
  readonly configuration: import('./contracts.js').RuntimeExtensionConfiguration;
  readonly kernelContributions: RuntimeKernelContributionSet;
  readonly resourceProviders: readonly RuntimeScopedResourcePort[];
  readonly uiPlacementRegistrations: readonly RuntimeExtensionUiPlacementRegistration[];
  readonly serviceContributions: readonly import('./contracts.js').RuntimeExtensionServiceContribution[];
  readonly eventSubscriptions: readonly import('./contracts.js').RuntimeExtensionEventSubscriptionContribution[];
  readonly lifecycle?: import('./contracts.js').RuntimeExtensionLifecyclePort;
  readonly jobHandlers: readonly import('@marshal/agent-runtime-core').RuntimeBackgroundJobHandler[];
  cleaned: boolean;
}

interface ActiveExtension {
  readonly prepared: PreparedActivation;
  registration: RuntimeKernelContributionRegistration;
  readonly serviceBindings: readonly RuntimeServiceBindingHandle[];
  readonly compositionBindings: readonly RuntimeServiceBindingHandle[];
  readonly subscriptions: readonly { dispose(): void }[];
  readonly lifecycleRegistration?: import('./contracts.js').RuntimeExtensionOwnedRegistration;
  readonly jobRegistration?: import('./contracts.js').RuntimeExtensionOwnedRegistration;
  readonly publication?: {
    readonly service: RuntimeExtensionUiPublicationService;
    readonly ownerId: string;
    readonly revisionId: string;
    readonly context: InvocationContext;
  };
}

interface InstalledExtension {
  request: RuntimeExtensionInstallRequest;
  identity: string;
  version: string;
  integrity: import('./contracts.js').RuntimeExtensionIntegrity;
  entrypoint: string;
  activationOrder: number;
  loaded?: LoadedRuntimeExtensionPackage;
  status: 'enabled' | 'disabled';
  desiredEnabled: boolean;
  configuration: import('./contracts.js').RuntimeExtensionConfiguration;
  explicitConfiguration?: import('./contracts.js').RuntimeExtensionConfiguration;
  providerOverrides: Record<string, string>;
  contractBindings: Record<string, string>;
  active?: ActiveExtension;
  activationFailure?: RuntimeExtensionBlockReason;
}

/**
 * Owns live extension registrations while leaving RuntimeKernel construction and
 * lifetime under host control.
 */
export class RuntimeExtensionManager implements RuntimeExtensionLifecycleService {
  readonly resources: RuntimeScopedResourcePort;
  readonly uiPlacements: RuntimeExtensionUiPlacements;
  private readonly kernel: RuntimeKernel;
  readonly services: RuntimeServiceContainer;
  private readonly compositionRegistry: RuntimeCompositionRegistry;
  private readonly loader: RuntimeExtensionPackageLoader;
  private readonly activationContext: InvocationContext;
  private readonly uiPlacementsRequired: boolean;
  private readonly uiPlacementRegistry: RuntimeExtensionUiPlacementRegistry;
  private readonly stateStore?: RuntimeExtensionStateStore;
  private readonly registerDurableEventConsumer?: RuntimeExtensionManagerOptions['registerDurableEventConsumer'];
  private readonly jobManager?: RuntimeExtensionManagerOptions['jobManager'];
  private readonly jobEnqueuer?: RuntimeExtensionJobEnqueuer;
  private readonly registerLifecycle?: RuntimeExtensionManagerOptions['registerLifecycle'];
  private readonly recoverJobHandlers?: RuntimeExtensionManagerOptions['recoverJobHandlers'];
  private restored = false;
  private uiRevisionSequence = 0;
  private readonly installed = new Map<string, InstalledExtension>();
  private operationQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: RuntimeExtensionManagerOptions) {
    this.kernel = options.kernel;
    this.services = options.services ?? getRuntimeServiceContainer();
    this.compositionRegistry =
      options.compositionRegistry ?? new RuntimeCompositionRegistry({ container: this.services });
    this.registerDurableEventConsumer = options.registerDurableEventConsumer;
    this.jobManager = options.jobManager;
    const jobEnqueuer: RuntimeExtensionJobEnqueuer | undefined = options.jobManager
      ? Object.freeze({
          enqueue: (
            request: Parameters<RuntimeExtensionJobEnqueuer['enqueue']>[0],
            context: Parameters<RuntimeExtensionJobEnqueuer['enqueue']>[1],
          ) => options.jobManager!.enqueue(request, context),
          start: (
            request: Parameters<RuntimeExtensionJobEnqueuer['start']>[0],
            context: Parameters<RuntimeExtensionJobEnqueuer['start']>[1],
          ) => options.jobManager!.start(request, context),
        })
      : undefined;
    this.jobEnqueuer = jobEnqueuer;
    this.registerLifecycle = options.registerLifecycle;
    this.recoverJobHandlers = options.recoverJobHandlers;
    this.loader = options.loader;
    this.activationContext = options.activationContext;
    this.stateStore = options.stateStore;
    this.uiPlacementsRequired = options.uiPlacementsRequired !== false;
    this.uiPlacementRegistry = new RuntimeExtensionUiPlacementRegistry(
      options.uiPlacementDefinitions ?? [],
    );
    this.uiPlacements = Object.freeze({
      listPlacements: () => this.uiPlacementRegistry.listHostPlacements(),
      listContributions: (extensionId?: string) =>
        this.listUiPlacementContributions(extensionId),
      resolve: (placementId: string) =>
        this.resolveUiPlacements().placements.find(
          (placement) => placement.placementId === placementId,
        ),
      resolveAll: () => this.resolveUiPlacements(),
    });
    this.resources = Object.freeze({
      listResources: (context: InvocationContext) => this.listResources(context),
      readResource: (uri: string, context: InvocationContext) =>
        this.readResource(uri, context),
    });
  }

  async restore(options: RuntimeExtensionOperationOptions = {}): Promise<readonly RuntimeExtensionRecord[]> {
    return this.exclusive(async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      if (this.restored) return this.list();
      if (!this.stateStore) {
        this.restored = true;
        return this.list();
      }
      let records: readonly import('./contracts.js').RuntimeExtensionStoredRecord[];
      try {
        records = await this.stateStore.load();
      } catch (error) {
        throw new RuntimeExtensionError('STATE_FAILED', error);
      }
      const restoredEntries: InstalledExtension[] = [];
      try {
        const loadedRecords: Array<{
          readonly stored: import('./contracts.js').RuntimeExtensionStoredRecord;
          readonly loaded: LoadedRuntimeExtensionPackage;
        }> = [];
        for (const stored of records) {
          assertNotCancelled(options.signal);
          try {
            const loaded = await this.load(stored.request, options.signal);
            if (
              loaded.metadata.manifest.identity !== stored.identity
              || loaded.metadata.manifest.version !== stored.version
            ) {
              throw new Error(
                `Persisted runtime extension ${stored.identity}@${stored.version} does not match its package.`,
              );
            }
            loadedRecords.push({ stored, loaded });
          } catch (error) {
            if (error instanceof RuntimeExtensionError && error.code === 'CANCELLED') {
              throw error;
            }
            const entry = unavailableEntry(stored, error);
            this.installed.set(stored.identity, entry);
            restoredEntries.push(entry);
          }
        }
        loadedRecords.sort((left, right) =>
          (left.loaded.metadata.manifest.activationOrder ?? 0)
            - (right.loaded.metadata.manifest.activationOrder ?? 0)
          || left.stored.identity.localeCompare(right.stored.identity));
        const pending: InstalledExtension[] = [];
        for (const { stored, loaded } of loadedRecords) {
          const configuration = resolveRuntimeExtensionConfiguration(
            loaded.metadata.manifest.configuration?.defaults,
            stored.configuration,
          );
          const entry: InstalledExtension = {
            request: freezeRequest(stored.request),
            identity: stored.identity,
            version: loaded.metadata.manifest.version,
            integrity: loaded.metadata.integrity,
            entrypoint: loaded.metadata.manifest.entrypoint,
            activationOrder: loaded.metadata.manifest.activationOrder ?? 0,
            loaded,
            configuration,
            status: 'disabled',
            desiredEnabled: stored.status === 'enabled',
            providerOverrides: normalizeProviderOverrides((stored as StoredLifecycleRecord).providerOverrides),
            contractBindings: normalizeProviderOverrides((stored as StoredLifecycleRecord).contractBindings),
            ...(stored.configuration ? { explicitConfiguration: stored.configuration } : {}),
          };
          this.installed.set(stored.identity, entry);
          restoredEntries.push(entry);
          if (stored.status === 'enabled') pending.push(entry);
        }
        while (pending.length > 0) {
          assertNotCancelled(options.signal);
          const remaining: InstalledExtension[] = [];
          let progressed = false;
          for (const entry of pending) {
            const loaded = entry.loaded!;
            if (this.restoreDependencyBlockReason(loaded)) {
              remaining.push(entry);
              continue;
            }
            progressed = true;
            try {
              const prepared = await this.prepareActivation(
                loaded,
                entry.identity,
                options.signal,
                entry.configuration,
              );
              entry.active = await this.activatePrepared(prepared, options.signal);
              entry.status = 'enabled';
              entry.desiredEnabled = true;
              entry.activationFailure = undefined;
            } catch (error) {
              if (error instanceof RuntimeExtensionError && error.code === 'CANCELLED') {
                throw error;
              }
              entry.status = 'disabled';
              entry.activationFailure = this.activationFailureReason(loaded, error);
            }
          }
          if (!progressed) {
            for (const entry of remaining) {
              entry.status = 'disabled';
              entry.activationFailure = this.restoreDependencyBlockReason(entry.loaded!)
                ?? {
                  code: 'ACTIVATION_FAILED',
                  message: 'Extension could not be restored because its dependencies are unresolved.',
                };
            }
            break;
          }
          pending.splice(0, pending.length, ...remaining);
        }
        this.restored = true;
        return this.list();
      } catch (error) {
        const failures: unknown[] = [error];
        for (const entry of restoredEntries.reverse()) {
          this.installed.delete(entry.identity);
          if (!entry.active) continue;
          try {
            await this.cleanupActive(entry.active);
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        }
        this.restored = false;
        if (error instanceof RuntimeExtensionError && error.code === 'CANCELLED') {
          throw error;
        }
        throw new RuntimeExtensionError(
          'RESTORE_FAILED',
          failures.length === 1
            ? error
            : new AggregateError(failures, 'Runtime extension restore rollback failed.'),
        );
      }
    });
  }

  discover(
    discovery: import('./contracts.js').RuntimeExtensionPackageDiscovery,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<readonly RuntimeExtensionRecord[]> {
    return (async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      for (const candidate of discovery.candidates) {
        const identity = (await this.loader.load(candidate.request, options.signal)).metadata.manifest.identity;
        if (this.installed.has(identity)) continue;
        await this.install(candidate.request, {
          signal: options.signal,
          configuration: candidate.configuration,
          enabled: candidate.enabled,
        });
      }
      return this.list();
    })();
  }

  configure(
    identity: string,
    configuration: import('./contracts.js').RuntimeExtensionConfiguration,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionRecord> {
    return this.exclusive(async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      const entry = this.requireInstalled(requireRuntimeExtensionIdentity(identity));
      if (entry.status === 'enabled') {
        const loaded = await this.load(entry.request, options.signal);
        if (loaded.metadata.manifest.identity !== entry.identity) {
          throw new RuntimeExtensionError('IDENTITY_MISMATCH');
        }

        return this.replaceEnabledEntry(
          entry,
          entry.request,
          loaded,
          configuration,
          options.signal,
        );
      }
      const previous = entry.configuration;
      const previousExplicit = entry.explicitConfiguration;
      const resolvedConfiguration = resolveRuntimeExtensionConfiguration(
        entry.loaded?.metadata.manifest.configuration?.defaults,
        configuration,
      );
      validateRuntimeExtensionConfiguration(
        resolvedConfiguration,
        entry.loaded?.metadata.manifest.configuration?.schema,
      );
      entry.configuration = resolvedConfiguration;
      entry.explicitConfiguration = configuration;
      try {
        await this.persist();
        await this.reconcileDependents();
        return this.projectRecord(entry);
      } catch (error) {
        entry.configuration = previous;
        entry.explicitConfiguration = previousExplicit;
        throw error;
      }
    });
  }

  setProviderOverride(
    identity: string,
    service: string,
    providerIdentity: string,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionRecord> {
    return this.exclusive(async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      const entry = this.requireInstalled(requireRuntimeExtensionIdentity(identity));
      const normalizedService = service;
      const normalizedProvider = providerIdentity;
      const inspection = this.compositionRegistry.list().find(
        ({ service: descriptor }) => descriptor.key === normalizedService,
      );
      if (!inspection || !inspection.providers.some(({ provider }) => provider.id === normalizedProvider)) {
        throw new RuntimeExtensionError(
          'INVALID_CONTRIBUTIONS',
          new Error(`Provider "${normalizedProvider}" is not registered for service "${normalizedService}".`),
        );
      }
      const previousRegistryOverride =
        this.compositionRegistry.snapshot().overrides[normalizedService];
      const previous = new Map<string, string | undefined>();
      for (const candidate of this.installed.values()) {
        previous.set(candidate.identity, candidate.providerOverrides[normalizedService]);
        delete candidate.providerOverrides[normalizedService];
      }
      entry.providerOverrides[normalizedService] = normalizedProvider;
      try {
        await this.compositionRegistry.setProviderOverride(inspection.service, normalizedProvider);
        await this.persist();
        await this.reconcileDependents();
        return record(entry);
      } catch (error) {
        for (const candidate of this.installed.values()) {
          const prior = previous.get(candidate.identity);
          if (prior === undefined) delete candidate.providerOverrides[normalizedService];
          else candidate.providerOverrides[normalizedService] = prior;
        }
        try {
          if (previousRegistryOverride === undefined) {
            await this.compositionRegistry.clearProviderOverride(inspection.service);
          } else {
            await this.compositionRegistry.setProviderOverride(
              inspection.service,
              previousRegistryOverride,
            );
          }
        } catch {
          // Preserve the operation failure if registry rollback also fails.
        }
        throw error;
      }
    });
  }

  clearProviderOverride(
    identity: string,
    service: string,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionRecord> {
    return this.exclusive(async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      const entry = this.requireInstalled(requireRuntimeExtensionIdentity(identity));
      const normalizedService = service;
      const inspection = this.compositionRegistry.list().find(
        ({ service: descriptor }) => descriptor.key === normalizedService,
      );
      if (!inspection) {
        throw new RuntimeExtensionError(
          'INVALID_CONTRIBUTIONS',
          new Error(`Service "${normalizedService}" is not registered.`),
        );
      }
      const previousRegistryOverride =
        this.compositionRegistry.snapshot().overrides[normalizedService];
      const previous = new Map<string, string | undefined>();
      for (const candidate of this.installed.values()) {
        previous.set(candidate.identity, candidate.providerOverrides[normalizedService]);
        delete candidate.providerOverrides[normalizedService];
      }
      try {
        await this.compositionRegistry.clearProviderOverride(inspection.service);
        await this.persist();
        await this.reconcileDependents();
        return record(entry);
      } catch (error) {
        for (const candidate of this.installed.values()) {
          const prior = previous.get(candidate.identity);
          if (prior !== undefined) candidate.providerOverrides[normalizedService] = prior;
        }
        try {
          if (previousRegistryOverride === undefined) {
            await this.compositionRegistry.clearProviderOverride(inspection.service);
          } else {
            await this.compositionRegistry.setProviderOverride(
              inspection.service,
              previousRegistryOverride,
            );
          }
        } catch {
          // Preserve the operation failure if registry rollback also fails.
        }
        throw error;
      }
    });
  }

  install(
    request: RuntimeExtensionInstallRequest,
    options: import('./contracts.js').RuntimeExtensionInstallOptions = {},
  ): Promise<RuntimeExtensionRecord> {
    return this.exclusive(async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      const loaded = await this.load(request, options.signal);
      const identity = loaded.metadata.manifest.identity;
      if (this.installed.has(identity)) {
        throw new RuntimeExtensionError('ALREADY_INSTALLED');
      }
      let configuration: import('./contracts.js').RuntimeExtensionConfiguration;
      try {
        configuration = resolveRuntimeExtensionConfiguration(
          loaded.metadata.manifest.configuration?.defaults,
          options.configuration,
        );
        validateRuntimeExtensionConfiguration(
          configuration,
          loaded.metadata.manifest.configuration?.schema,
        );
      } catch (error) {
        if (options.enabled === false) throw error;
        const failure: RuntimeExtensionBlockReason = {
          code: 'INVALID_CONFIGURATION',
          message: `Extension configuration is invalid: ${
            error instanceof Error ? error.message : 'configuration could not be resolved.'
          }`,
        };
        const entry: InstalledExtension = {
          request: freezeRequest(request),
          identity,
          version: loaded.metadata.manifest.version,
          integrity: loaded.metadata.integrity,
          entrypoint: loaded.metadata.manifest.entrypoint,
          activationOrder: loaded.metadata.manifest.activationOrder ?? 0,
          loaded,
          configuration: loaded.metadata.manifest.configuration?.defaults ?? {},
          ...(options.configuration ? { explicitConfiguration: options.configuration } : {}),
          status: 'disabled',
          desiredEnabled: true,
          providerOverrides: {},
          contractBindings: {},
          activationFailure: failure,
        };
        this.installed.set(identity, entry);
        try {
          await this.persist();
          return this.projectRecord(entry);
        } catch (persistError) {
          this.installed.delete(identity);
          throw persistError;
        }
      }
      const blocked = this.activationBlockReason(loaded, identity);
      if (blocked && options.enabled !== false) {
        const entry: InstalledExtension = {
          request: freezeRequest(request),
          identity,
          version: loaded.metadata.manifest.version,
          integrity: loaded.metadata.integrity,
          entrypoint: loaded.metadata.manifest.entrypoint,
          activationOrder: loaded.metadata.manifest.activationOrder ?? 0,
          loaded,
          configuration,
          ...(options.configuration ? { explicitConfiguration: options.configuration } : {}),
          status: 'disabled',
          desiredEnabled: true,
          providerOverrides: {},
          contractBindings: {},
          activationFailure: blocked,
        };
        this.installed.set(identity, entry);
        try {
          await this.persist();
          return this.projectRecord(entry);
        } catch (error) {
          this.installed.delete(identity);
          throw error;
        }
      }
      if (options.enabled === false) {
        const entry: InstalledExtension = {
          request: freezeRequest(request),
          identity,
          version: loaded.metadata.manifest.version,
          integrity: loaded.metadata.integrity,
          entrypoint: loaded.metadata.manifest.entrypoint,
          activationOrder: loaded.metadata.manifest.activationOrder ?? 0,
          loaded,
          configuration,
          ...(options.configuration ? { explicitConfiguration: options.configuration } : {}),
          status: 'disabled',
          desiredEnabled: false,
          providerOverrides: {},
          contractBindings: {},
        };
        this.installed.set(identity, entry);
        try {
          await this.persist();
          return record(entry);
        } catch (error) {
          this.installed.delete(identity);
          throw error;
        }
      }

      let prepared: PreparedActivation;
      try {
        prepared = await this.prepareActivation(
          loaded,
          identity,
          options.signal,
          configuration,
        );
      } catch (error) {
        if (error instanceof RuntimeExtensionError && error.code === 'CANCELLED') throw error;
        const failure = this.activationFailureReason(loaded, error);
        const entry: InstalledExtension = {
          request: freezeRequest(request),
          identity,
          version: loaded.metadata.manifest.version,
          integrity: loaded.metadata.integrity,
          entrypoint: loaded.metadata.manifest.entrypoint,
          activationOrder: loaded.metadata.manifest.activationOrder ?? 0,
          loaded,
          configuration,
          ...(options.configuration ? { explicitConfiguration: options.configuration } : {}),
          status: 'disabled',
          desiredEnabled: true,
          providerOverrides: {},
          contractBindings: {},
          activationFailure: failure,
        };
        this.installed.set(identity, entry);
        try {
          await this.persist();
          return this.projectRecord(entry);
        } catch (persistError) {
          this.installed.delete(identity);
          throw persistError;
        }
      }
      let active: ActiveExtension;
      try {
        active = await this.activatePrepared(prepared, options.signal);
        const entry: InstalledExtension = {
          request: freezeRequest(request),
          identity,
          version: loaded.metadata.manifest.version,
          integrity: loaded.metadata.integrity,
          entrypoint: loaded.metadata.manifest.entrypoint,
          activationOrder: loaded.metadata.manifest.activationOrder ?? 0,
          loaded,
          configuration: prepared.configuration,
          ...(options.configuration ? { explicitConfiguration: options.configuration } : {}),
          status: 'enabled',
          desiredEnabled: true,
          providerOverrides: {},
          contractBindings: {},
          active,
        };
        this.installed.set(identity, entry);
        try {
          await this.persist();
          await this.reconcileDependents();
          return record(entry);
        } catch (error) {
          this.installed.delete(identity);
          return this.cleanupAfterStateFailure(error, active);
        }
      } catch (error) {
        if (!prepared.cleaned) await this.cleanupPrepared(prepared);
        throw error;
      }
    });
  }

  update(
    identity: string,
    request: RuntimeExtensionInstallRequest,
    options: import('./contracts.js').RuntimeExtensionInstallOptions = {},
  ): Promise<RuntimeExtensionRecord> {
    return this.exclusive(async () => {
      this.assertUsable();
      const normalizedIdentity = requireRuntimeExtensionIdentity(identity);
      const current = this.requireInstalled(normalizedIdentity);
      assertNotCancelled(options.signal);
      const loaded = await this.load(request, options.signal);
      if (loaded.metadata.manifest.identity !== normalizedIdentity) {
        throw new RuntimeExtensionError('IDENTITY_MISMATCH');
      }
      const configured = options.configuration ?? current.explicitConfiguration;
      if (current.status === 'disabled') {
        const previous = {
          request: current.request,
          loaded: current.loaded,
          configuration: current.configuration,
          explicitConfiguration: current.explicitConfiguration,
          activationFailure: current.activationFailure,
        };
        const nextConfiguration = resolveRuntimeExtensionConfiguration(
          loaded.metadata.manifest.configuration?.defaults,
          configured,
        );
        validateRuntimeExtensionConfiguration(
          nextConfiguration,
          loaded.metadata.manifest.configuration?.schema,
        );
        current.request = freezeRequest(request);
        current.loaded = loaded;
        current.identity = loaded.metadata.manifest.identity;
        current.version = loaded.metadata.manifest.version;
        current.integrity = loaded.metadata.integrity;
        current.entrypoint = loaded.metadata.manifest.entrypoint;
        current.activationOrder = loaded.metadata.manifest.activationOrder ?? 0;
        current.configuration = nextConfiguration;
        current.explicitConfiguration = configured;
        current.activationFailure = undefined;
        try {
          await this.persist();
          await this.reconcileDependents();
          return record(current);
        } catch (error) {
          current.request = previous.request;
          current.loaded = previous.loaded;
          current.identity = normalizedIdentity;
          current.version = previous.loaded?.metadata.manifest.version ?? current.version;
          current.integrity = previous.loaded?.metadata.integrity ?? current.integrity;
          current.entrypoint = previous.loaded?.metadata.manifest.entrypoint ?? current.entrypoint;
          current.activationOrder = previous.loaded?.metadata.manifest.activationOrder ?? current.activationOrder;
          current.configuration = previous.configuration;
          current.explicitConfiguration = previous.explicitConfiguration;
          current.activationFailure = previous.activationFailure;
          throw error;
        }
      }
      return this.replaceEnabledEntry(
        current,
        request,
        loaded,
        configured,
        options.signal,
      );
    });
  }

  disable(
    identity: string,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionRecord> {
    return this.exclusive(async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      const entry = this.requireInstalled(requireRuntimeExtensionIdentity(identity));
      const previousDesiredEnabled = entry.desiredEnabled;
      const previousActivationFailure = entry.activationFailure;
      entry.desiredEnabled = false;
      entry.activationFailure = undefined;
      if (entry.status === 'disabled') {
        try {
          await this.persist();
        } catch (error) {
          entry.desiredEnabled = previousDesiredEnabled;
          entry.activationFailure = previousActivationFailure;
          throw error;
        }
        return record(entry);
      }
      const previousRecords = this.storedRecords();
      const nextRecords = previousRecords.map((stored) =>
          stored.identity === entry.identity
            ? Object.freeze({ ...stored, status: 'disabled' as const })
            : stored);
      try {
        await this.persist(nextRecords);
      } catch (error) {
        entry.desiredEnabled = previousDesiredEnabled;
        entry.activationFailure = previousActivationFailure;
        throw error;
      }
      try {
        assertNotCancelled(options.signal);
        await this.disableEntry(entry);
        await this.reconcileDependents();
      } catch (error) {
        throw error;
      }
      return record(entry);
    });
  }

  enable(
    identity: string,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionRecord> {
    return this.exclusive(async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      const normalizedIdentity = requireRuntimeExtensionIdentity(identity);
      const entry = this.requireInstalled(normalizedIdentity);
      if (entry.status === 'enabled') return record(entry);
      const previousLoaded = entry.loaded;
      const previousConfiguration = entry.configuration;
      const previousExplicitConfiguration = entry.explicitConfiguration;
      const previousDesiredEnabled = entry.desiredEnabled;
      const previousActivationFailure = entry.activationFailure;
      const loaded = await this.load(entry.request, options.signal);
      if (loaded.metadata.manifest.identity !== normalizedIdentity) {
        throw new RuntimeExtensionError('IDENTITY_MISMATCH');
      }
      const prepared = await this.prepareActivation(
        loaded,
        normalizedIdentity,
        options.signal,
        entry.configuration,
      );
      try {
        const active = await this.activatePrepared(prepared, options.signal);
        entry.loaded = loaded;
        entry.identity = loaded.metadata.manifest.identity;
        entry.version = loaded.metadata.manifest.version;
        entry.integrity = loaded.metadata.integrity;
        entry.entrypoint = loaded.metadata.manifest.entrypoint;
        entry.activationOrder = loaded.metadata.manifest.activationOrder ?? 0;
        entry.status = 'enabled';
        entry.desiredEnabled = true;
        entry.configuration = prepared.configuration;
        entry.explicitConfiguration = previousExplicitConfiguration;
        entry.active = active;
        entry.activationFailure = undefined;
        try {
          await this.persist();
          await this.reconcileDependents();
          return record(entry);
        } catch (error) {
          entry.loaded = previousLoaded;
          entry.identity = normalizedIdentity;
          entry.version = previousLoaded?.metadata.manifest.version ?? entry.version;
          entry.integrity = previousLoaded?.metadata.integrity ?? entry.integrity;
          entry.entrypoint = previousLoaded?.metadata.manifest.entrypoint ?? entry.entrypoint;
          entry.activationOrder = previousLoaded?.metadata.manifest.activationOrder ?? entry.activationOrder;
          entry.status = 'disabled';
          entry.desiredEnabled = previousDesiredEnabled;
          entry.configuration = previousConfiguration;
          entry.explicitConfiguration = previousExplicitConfiguration;
          entry.active = undefined;
          entry.activationFailure = previousActivationFailure;
          return this.cleanupAfterStateFailure(error, active);
        }
      } catch (error) {
        if (!prepared.cleaned) await this.cleanupPrepared(prepared);
        throw error;
      }
    });
  }

  remove(
    identity: string,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<void> {
    return this.exclusive(async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      const normalizedIdentity = requireRuntimeExtensionIdentity(identity);
      const entry = this.requireInstalled(normalizedIdentity);
      const previousRecords = this.storedRecords();
      const nextRecords = previousRecords.filter((stored) => stored.identity !== normalizedIdentity);
      await this.persist(nextRecords);
      let disposalError: unknown;
      try {
        assertNotCancelled(options.signal);
        await this.disableEntry(entry);
      } catch (error) {
        disposalError = error;
      }
      if (disposalError) {
        this.installed.delete(normalizedIdentity);
        throw disposalError;
      }
      this.installed.delete(normalizedIdentity);
      await this.reconcileDependents();
    });
  }

  get(identity: string): RuntimeExtensionLifecycleRecord | undefined {
    const normalizedIdentity = requireRuntimeExtensionIdentity(identity);
    const entry = this.installed.get(normalizedIdentity);
    return entry ? this.projectRecord(entry) : undefined;
  }

  list(): readonly RuntimeExtensionLifecycleRecord[] {
    return Object.freeze(
      [...this.installed.values()]
        .map((entry) => this.projectRecord(entry))
        .sort((left, right) => left.identity.localeCompare(right.identity)),
    );
  }

  repairContractConflict(
    request: RuntimeExtensionContractRepairRequest,
    options: RuntimeExtensionOperationOptions = {},
  ): Promise<RuntimeExtensionContractRepairResult> {
    return this.exclusive(async () => {
      this.assertUsable();
      assertNotCancelled(options.signal);
      const normalized = validateRepairRequest(request);
      const conflict = this.contractConflictsForService(normalized.canonicalService)[0];
      if (!conflict) {
        throw new RuntimeExtensionError(
          'INVALID_CONTRIBUTIONS',
          new Error(`Service "${normalized.canonicalService}" has no contract conflict.`),
        );
      }
      const previousRecords = this.storedRecords();
      const choices = new Map(normalized.bindings.map((choice) => [choice.providerIdentity, choice]));
      if (choices.size !== conflict.owners.length) {
        throw new RuntimeExtensionError(
          'INVALID_CONTRIBUTIONS',
          new Error(`Repair must specify exactly the owners of service "${normalized.canonicalService}".`),
        );
      }
      for (const owner of conflict.owners) {
        const choice = choices.get(owner.identity);
        if (!choice) {
          throw new RuntimeExtensionError('INVALID_CONTRIBUTIONS',
            new Error(`Repair is missing a binding for provider "${owner.identity}".`));
        }
      }
      const previous = new Map<string, {
        readonly bindings: Record<string, string>;
        readonly status: InstalledExtension['status'];
        readonly desiredEnabled: boolean;
        readonly activationFailure?: RuntimeExtensionBlockReason;
        readonly active?: ActiveExtension;
      }>();
      const affected = new Set(conflict.owners.map(({ identity }) => identity));
      for (const identity of normalized.enable ?? []) affected.add(requireRuntimeExtensionIdentity(identity));
      for (const identity of conflict.affectedDependents) affected.add(identity);
      for (const identity of affected) {
        const entry = this.requireInstalled(identity);
        previous.set(identity, {
          bindings: { ...entry.contractBindings },
          status: entry.status,
          desiredEnabled: entry.desiredEnabled,
          activationFailure: entry.activationFailure,
          active: entry.active,
        });
      }
      const expected = conflict.request;
      if (normalized.bindings.length !== expected.bindings.length
        || normalized.bindings.some((choice, index) => {
          const candidate = expected.bindings[index];
          return !candidate
            || choice.providerIdentity !== candidate.providerIdentity
            || choice.effectiveService !== candidate.effectiveService
            || choice.publicName !== candidate.publicName;
        })
        || JSON.stringify(normalized.enable ?? []) !== JSON.stringify(expected.enable ?? [])) {
        throw new RuntimeExtensionError(
          'INVALID_CONTRIBUTIONS',
          new Error('Contract repair request does not match the current owner-to-binding proposal.'),
        );
      }
      for (const choice of normalized.bindings) {
        const entry = this.requireInstalled(choice.providerIdentity);
        entry.contractBindings[choice.canonicalService] = choice.effectiveService;
      }
      try {
        await this.reactivateBoundOwners(normalized.canonicalService, options.signal);
        for (const identity of normalized.enable ?? []) {
          const entry = this.requireInstalled(requireRuntimeExtensionIdentity(identity));
          if (entry.status === 'disabled' && entry.loaded) {
            const prepared = await this.prepareActivation(entry.loaded, entry.identity, options.signal, entry.configuration);
            entry.active = await this.activatePrepared(prepared, options.signal);
            entry.status = 'enabled';
            entry.desiredEnabled = true;
            entry.activationFailure = undefined;
          }
        }
        await this.persist();
        await this.reconcileDependents();
        return {
          canonicalService: normalized.canonicalService,
          bindings: Object.freeze([...normalized.bindings]),
          conflicts: Object.freeze(this.contractConflictsForService(normalized.canonicalService)),
          enabled: Object.freeze([...(normalized.enable ?? [])]),
        };
      } catch (error) {
        for (const [identity, snapshot] of previous) {
          const entry = this.installed.get(identity);
          if (!entry) continue;
          if (entry.status === 'enabled' && entry.active && entry.active !== snapshot.active) {
            await this.disableEntry(entry);
          }
          entry.contractBindings = snapshot.bindings;
          entry.status = snapshot.status;
          entry.desiredEnabled = snapshot.desiredEnabled;
          entry.activationFailure = snapshot.activationFailure;
          if (entry.active !== snapshot.active && snapshot.status === 'enabled' && snapshot.active && entry.loaded) {
            const prepared = await this.prepareActivation(
              entry.loaded,
              entry.identity,
              undefined,
              entry.configuration,
            );
            entry.active = await this.activatePrepared(prepared, undefined);
          }
        }
        try {
          await this.persist(previousRecords);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Contract repair rollback failed.',
          );
        }
        throw error;
      }
    });
  }

  private async reactivateBoundOwners(service: string, signal: RuntimeAbortSignal | undefined): Promise<void> {
    for (const entry of this.installed.values()) {
      if (!entry.loaded?.metadata.manifest.provides?.services?.some((provider) => provider.id === service)
        || entry.status !== 'enabled' || !entry.active) continue;
      await this.disableEntry(entry);
      const prepared = await this.prepareActivation(entry.loaded, entry.identity, signal, entry.configuration);
      entry.active = await this.activatePrepared(prepared, signal);
      entry.status = 'enabled';
    }
    await this.reconcileDependents();
  }

  private contractConflicts(entry: InstalledExtension): readonly RuntimeExtensionContractConflict[] {
    return this.contractConflictsForEntry(entry.identity);
  }

  private contractConflictsForEntry(identity: string): readonly RuntimeExtensionContractConflict[] {
    const services = new Set<string>();
    for (const entry of this.installed.values()) {
      for (const provider of entry.loaded?.metadata.manifest.provides?.services ?? []) services.add(provider.id);
    }
    return [...services].flatMap((service) => this.contractConflictsForService(service)
      .filter((conflict) => conflict.owners.some((owner) => owner.identity === identity)));
  }

  private contractConflictsForService(service: string): readonly RuntimeExtensionContractConflict[] {
    const owners = [...this.installed.values()].flatMap((entry) =>
      (entry.loaded?.metadata.manifest.provides?.services ?? [])
        .filter((provider) => provider.id === service)
        .map((provider) => ({ identity: entry.identity, contract: provider })));
    if (owners.length < 2) return [];
    const groups: Array<typeof owners> = [];
    for (const owner of owners) {
      const group = groups.find((candidate) =>
        !runtimeCompositionContractDifference(
          toCompositionContract(candidate[0]!.contract),
          toCompositionContract(owner.contract),
        ));
      if (group) group.push(owner);
      else groups.push([owner]);
    }
    if (groups.length < 2) return [];
    const bindings = groups.flatMap((group, groupIndex) => {
      const groupOwner = group[0]!.identity;
      const effectiveService = groupIndex === 0
        ? service
        : namespacedServiceId(groupOwner, service);
      const publicName = groupIndex === 0
        ? publicServiceName(service)
        : namespacedPublicName(groupOwner, service);
      return group.map((owner) => ({
        canonicalService: service,
        providerIdentity: owner.identity,
        effectiveService,
        publicName,
      }));
    });
    const enable = owners
      .map(({ identity }) => this.installed.get(identity))
      .filter((entry): entry is InstalledExtension => Boolean(entry?.desiredEnabled && entry.status !== 'enabled'))
      .map(({ identity }) => identity)
      .sort();
    const request: RuntimeExtensionContractRepairRequest = {
      canonicalService: service,
      bindings,
      ...(enable.length > 0 ? { enable: Object.freeze(enable) } : {}),
    };
    return [{
      canonicalService: service,
      owners: Object.freeze(owners),
      proposedBindings: Object.freeze(bindings),
      affectedDependents: Object.freeze(this.installedListDependents(service)),
      request,
    }];
  }

  private installedListDependents(service: string): string[] {
    return [...this.installed.values()].filter((entry) =>
      entry.loaded?.metadata.manifest.dependencies?.services?.some((dependency) => serviceIdentity(dependency) === service))
      .map((entry) => entry.identity).sort();
  }

  private projectRecord(entry: InstalledExtension): RuntimeExtensionLifecycleRecord {
    const manifest = entry.loaded?.metadata.manifest;
    const rawManifest = manifest as Record<string, unknown> | undefined;
    const dependencies = manifest?.dependencies
      ? arrayField(manifest.dependencies as unknown as Record<string, unknown>, 'extensions')
      : [];
    const serviceDependencies = manifest?.dependencies
      ? arrayField(manifest.dependencies as unknown as Record<string, unknown>, 'services')
      : [];
    const providedServices = manifest?.provides?.services ?? [];
    const requiredServices = serviceDependencies;
    const reasons: RuntimeExtensionBlockReason[] = entry.status === 'disabled'
      ? [{ code: 'DISABLED', message: 'Extension is disabled.' }]
      : [];
    // A manifest that declares UI must have a matching activated application
    // with an inline published resource. Without this gate an extension whose
    // package omitted its HTML can still report healthy while its nav entry
    // points at a resource that cannot be opened (HOST-UX-2). Three distinct
    // failure modes, each with its own reason so diagnostics say exactly what
    // is wrong:
    //  - the declared application was never activated (MISSING_PUBLISHED_UI_RESOURCE);
    //  - it was activated but its published resource carries no readable
    //    content, e.g. an empty HTML payload (UNREADABLE_UI_RESOURCE);
    //  - it published fine but registered no host placement, so it can never
    //    appear in navigation (MISSING_UI_PLACEMENT).
    const declaredUi = manifest?.contributes?.ui ?? [];
    const activatedUi = new Map(
      (entry.active?.prepared.activation.uiApplications ?? []).map((application) => [application.id, application]),
    );
    const placedApplicationIds = new Set(
      (entry.active?.prepared.uiPlacementRegistrations ?? []).map((registration) => registration.applicationId),
    );
    for (const applicationId of declaredUi) {
      const application = activatedUi.get(applicationId);
      if (!application) {
        reasons.push({
          code: 'MISSING_PUBLISHED_UI_RESOURCE',
          message: `Declared UI application "${applicationId}" did not publish a readable resource.`,
        });
        continue;
      }
      const resource = application.resource as { uri?: unknown; text?: unknown; blob?: unknown } | undefined;
      const text = typeof resource?.text === 'string' ? resource.text : undefined;
      const blob = typeof resource?.blob === 'string' ? resource.blob : undefined;
      if (
        !resource
        || typeof resource.uri !== 'string'
        || !resource.uri.trim()
        || ((text === undefined || text.length === 0) && (blob === undefined || blob.length === 0))
      ) {
        reasons.push({
          code: 'UNREADABLE_UI_RESOURCE',
          message: `Declared UI application "${applicationId}" published a resource with no readable content.`,
        });
      }
      if (this.uiPlacementsRequired && !placedApplicationIds.has(applicationId)) {
        reasons.push({
          code: 'MISSING_UI_PLACEMENT',
          message: `Declared UI application "${applicationId}" registered no host placement; it can never appear in navigation.`,
        });
      }
    }
    if (entry.activationFailure) reasons.push(entry.activationFailure);
    for (const dependency of dependencies) {
      const id = dependencyIdentity(dependency);
      if (!id) continue;
      const target = this.installed.get(id);
      if (!target) reasons.push({ code: 'MISSING_DEPENDENCY', message: `Dependency "${id}" is not installed.`, dependency: id });
      else if (target.status !== 'enabled') reasons.push({ code: 'DISABLED_DEPENDENCY', message: `Dependency "${id}" is disabled.`, dependency: id });
      else if (!target.loaded
        || !matchesVersion(target.loaded.metadata.manifest.version, dependencyVersion(dependency))) {
        reasons.push({ code: 'VERSION_MISMATCH', message: `Dependency "${id}" has an incompatible version.`, dependency: id });
      }
    }
    const serviceIds = [...new Set(
      [...requiredServices, ...providedServices]
        .map(serviceIdentity)
        .filter((service): service is string => Boolean(service)),
    )];
    const selections = serviceSelections(
      this.installed,
      serviceIds,
      entry,
      entry.providerOverrides,
      this.compositionRegistry,
      serviceDependencies,
    );
    for (const dependency of serviceDependencies) {
      const service = serviceIdentity(dependency);
      if (!service) continue;
      const declaredProviders = this.declaredProviders(service, entry.identity);
      const explicitProvider = dependencyProvider(dependency);
      if (explicitProvider && !declaredProviders.includes(explicitProvider)) {
        reasons.push({
          code: 'MISSING_SERVICE_DEPENDENCY',
          message: `Service "${service}" specifies an undeclared provider "${explicitProvider}".`,
          service,
          provider: explicitProvider,
        });
        continue;
      }
      if (!explicitProvider && declaredProviders.length > 1) {
        reasons.push({
          code: 'AMBIGUOUS_SERVICE_DEPENDENCY',
          message: `Service "${service}" has multiple declared providers; specify provider explicitly.`,
          service,
        });
        continue;
      }
      const providerIdentity = explicitProvider ?? declaredProviders[0];
      const effectiveService = providerIdentity
        ? this.installed.get(providerIdentity)?.contractBindings[service] ?? service
        : service;
      const provider = this.compositionRegistry.list()
        .find(({ service: descriptor }) => descriptor.key === effectiveService)
        ?.providers.find(({ status }) => status === 'active' || status === 'overridden');
      if (!provider) {
        reasons.push({ code: 'MISSING_SERVICE_DEPENDENCY', message: `Service "${effectiveService}" is not available.`, dependency: effectiveService });
      } else if (!matchesVersion(
        typeof provider.provider.metadata?.version === 'string'
          ? provider.provider.metadata.version
          : provider.provider.contract.version,
        dependencyVersion(dependency),
      )) {
        reasons.push({ code: 'VERSION_MISMATCH', message: `Service "${effectiveService}" has an incompatible version.`, service: effectiveService });
      }
    }
    return Object.freeze({
      ...record(entry),
      request: entry.request,
      origin: 'native',
      title: entry.identity,
      description: entry.identity,
      health: entry.status === 'disabled' ? 'disabled' : reasons.length ? 'blocked' : 'healthy',
      blockReasons: Object.freeze(reasons),
      dependencies: Object.freeze(dependencies),
      providedServices: Object.freeze(providedServices),
      requiredServices: Object.freeze(requiredServices),
      providerSelections: Object.freeze(selections),
      contracts: manifest?.contracts,
      configurationValues: entry.configuration,
      providerOverrides: Object.freeze({ ...entry.providerOverrides }),
      contractConflicts: Object.freeze(this.contractConflicts(entry)),
      configurationSchema: objectField(rawManifest?.configuration, 'schema'),
      docs: manifest?.docs,
      resources: manifest?.resources,
      examples: manifest?.examples,
      appServices: manifest?.appServices,
      appServicesSnippet: typeof manifest?.appServicesSnippet === 'string' ? manifest.appServicesSnippet : undefined,
      agentGuidance: manifest?.agentGuidance,
      capabilityProviderIds: Object.freeze([
        ...new Set(
          (entry.active?.prepared.activation.capabilityProviders ?? [])
            .map((provider) => provider.id),
        ),
      ].sort()),
      contributedCapabilityPrefixes: Object.freeze([
        ...new Set(manifest?.contributes?.capabilities ?? []),
      ].sort()),
    });
  }

  dispose(): Promise<void> {
    return this.exclusive(async () => {
      if (this.disposed) return;
      this.disposed = true;
      const failures: unknown[] = [];
      for (const entry of this.installed.values()) {
        try {
          await this.disableEntry(entry);
        } catch (error) {
          failures.push(error);
        }
      }
      this.installed.clear();
      if (failures.length > 0) {
        throw new RuntimeExtensionError(
          'DISPOSAL_FAILED',
          new AggregateError(failures, 'One or more runtime extensions failed to dispose.'),
        );
      }
    });
  }

  private async load(
    request: RuntimeExtensionInstallRequest,
    signal: RuntimeAbortSignal | undefined,
  ): Promise<LoadedRuntimeExtensionPackage> {
    try {
      const loaded = await this.loader.load(request, signal);
      assertNotCancelled(signal);
      return loaded;
    } catch (error) {
      if (
        signal?.aborted
        || (error instanceof RuntimeExtensionPackageError && error.code === 'CANCELLED')
      ) {
        throw new RuntimeExtensionError('CANCELLED', error);
      }
      throw error;
    }
  }

  private async prepareActivation(
    loaded: LoadedRuntimeExtensionPackage,
    replacingIdentity: string,
    signal: RuntimeAbortSignal | undefined,
    configured: import('./contracts.js').RuntimeExtensionConfiguration | undefined,
  ): Promise<PreparedActivation> {
    const block = this.activationBlockReason(loaded, replacingIdentity);
    if (block) throw new RuntimeExtensionError('ACTIVATION_FAILED', new Error(block.message));
    let activation: RuntimeExtensionActivation;
    const configuration = resolveRuntimeExtensionConfiguration(
      loaded.metadata.manifest.configuration?.defaults,
      configured,
    );
    validateRuntimeExtensionConfiguration(
      configuration,
      loaded.metadata.manifest.configuration?.schema,
    );
    try {
      activation = await loaded.module.activate({
        manifest: loaded.metadata.manifest,
        configuration,
        services: this.serviceAccessorFor(
          loaded.metadata.manifest,
          loaded.metadata.manifest.identity,
        ),
        events: {
          subscribe: (type, listener) =>
            type === '*'
              ? this.kernel.events.subscribe('*', listener)
              : this.kernel.events.subscribe(type, listener),
          subscribeDurable: (options) => {
            if (!this.registerDurableEventConsumer) {
              throw new Error('Durable runtime event consumers are not available.');
            }
            return this.registerDurableEventConsumer({
              ...options,
              consumerId: `${loaded.metadata.manifest.identity}:${options.consumerId}`,
            });
          },
        },
        ...(this.jobEnqueuer ? { jobManager: this.jobEnqueuer } : {}),
        signal,
        search: (request, context = this.context(signal)) =>
          this.kernel.search(request, context),
        execute: (request, context = this.context(signal)) =>
          this.kernel.execute(request, {
            ...context,
            metadata: {
              ...context.metadata,
              // Set by the activated extension closure, never by capability input.
              runtimeExtensionIdentity: loaded.metadata.manifest.identity,
            },
          }),
      });
    } catch (error) {
      if (signal?.aborted) throw new RuntimeExtensionError('CANCELLED', error);
      throw new RuntimeExtensionError('ACTIVATION_FAILED', error);
    }

    let prepared: PreparedActivation | undefined;
    try {
      assertNotCancelled(signal);
      const normalized = normalizeActivation(
        activation,
        loaded.metadata.manifest.identity,
      );
      prepared = {
        loaded,
        activation: normalized.activation,
        configuration,
        kernelContributions: normalized.kernelContributions,
        resourceProviders: normalized.resourceProviders,
        uiPlacementRegistrations: normalized.uiPlacementRegistrations,
        serviceContributions: normalized.serviceContributions,
        eventSubscriptions: normalized.eventSubscriptions,
        lifecycle: normalized.lifecycle,
        jobHandlers: normalized.jobHandlers,
        cleaned: false,
      };
      await this.validateResources(
        replacingIdentity,
        prepared.resourceProviders,
        this.context(signal),
      );
      this.validateUiPlacements(
        replacingIdentity,
        prepared.uiPlacementRegistrations,
      );
      assertNotCancelled(signal);
      return prepared;
    } catch (error) {
      if (prepared) {
        await this.cleanupPrepared(prepared);
      } else if (activation && typeof activation.dispose === 'function') {
        await cleanupActivation(activation);
      }
      if (error instanceof RuntimeExtensionError) throw error;
      if (signal?.aborted) throw new RuntimeExtensionError('CANCELLED', error);
      throw new RuntimeExtensionError('INVALID_CONTRIBUTIONS', error);
    }
  }

  private activationBlockReason(
    loaded: LoadedRuntimeExtensionPackage,
    replacingIdentity: string,
  ): RuntimeExtensionBlockReason | undefined {
    const manifest = loaded.metadata.manifest as unknown as Record<string, unknown>;
    const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object'
      ? arrayField(manifest.dependencies as Record<string, unknown>, 'extensions')
      : [];
    for (const dependency of dependencies) {
      const id = dependencyIdentity(dependency);
      if (!id || id === replacingIdentity) continue;
      const target = this.installed.get(id);
      if (!target) return { code: 'MISSING_DEPENDENCY', message: `Dependency "${id}" is not installed.`, dependency: id };
      if (target.status !== 'enabled') return { code: 'DISABLED_DEPENDENCY', message: `Dependency "${id}" is disabled.`, dependency: id };
      if (!target.loaded
        || !matchesVersion(target.loaded.metadata.manifest.version, dependencyVersion(dependency))) {
        return { code: 'VERSION_MISMATCH', message: `Dependency "${id}" has an incompatible version.`, dependency: id };
      }
    }
    const services = loaded.metadata.manifest.dependencies?.services ?? [];
    for (const dependency of services) {
      const service = serviceIdentity(dependency);
      if (!service) continue;
      const declaredProviders = this.declaredProviders(
        service,
        loaded.metadata.manifest.identity,
        loaded.metadata.manifest,
      );
      const explicitProvider = dependencyProvider(dependency);
      if (explicitProvider && !declaredProviders.includes(explicitProvider)) {
        return {
          code: 'MISSING_SERVICE_DEPENDENCY',
          message: `Service "${service}" specifies an undeclared provider "${explicitProvider}".`,
          service,
          provider: explicitProvider,
        };
      }
      if (!explicitProvider && declaredProviders.length > 1) {
        return {
          code: 'AMBIGUOUS_SERVICE_DEPENDENCY',
          message: `Service "${service}" has multiple declared providers; specify provider explicitly.`,
          service,
        };
      }
      const providerIdentity = explicitProvider ?? declaredProviders[0];
      const effectiveService = providerIdentity
        ? this.installed.get(providerIdentity)?.contractBindings[service] ?? service
        : service;
      const inspection = this.compositionRegistry.list()
        .find(({ service: descriptor }) => descriptor.key === effectiveService);
      const selected = inspection?.providers.find(({ status }) => status === 'active' || status === 'overridden');
      if (!selected) {
        return { code: 'MISSING_SERVICE_DEPENDENCY', message: `Service "${effectiveService}" is not available.`, service: effectiveService };
      }
      if (!matchesVersion(
        typeof selected.provider.metadata?.version === 'string'
          ? selected.provider.metadata.version
          : selected.provider.contract.version,
        dependencyVersion(dependency),
      )) {
        return { code: 'VERSION_MISMATCH', message: `Service "${effectiveService}" has an incompatible version.`, service: effectiveService };
      }
    }
    for (const provider of loaded.metadata.manifest.provides?.services ?? []) {
      const selectedBinding = this.installed.get(loaded.metadata.manifest.identity)?.contractBindings[provider.id];
      if (selectedBinding && selectedBinding !== provider.id) continue;
      const inspection = this.compositionRegistry.list()
        .find(({ service }) => service.key === provider.id);
      if (!inspection) continue;
      const candidateContract = toCompositionContract(provider);
      const conflict = inspection.providers
        .filter(({ provider: candidate }) => candidate.id !== replacingIdentity)
        .map(({ provider: candidate }) =>
          runtimeCompositionContractDifference(candidateContract, candidate.contract))
        .find((difference): difference is string => difference !== undefined);
      if (conflict) {
        const owners = [
          ...inspection.providers.map(({ provider: candidate }) => candidate.id),
          loaded.metadata.manifest.identity,
        ];
        return {
          code: 'INCOMPATIBLE_CONTRACT',
          message: incompatibleContractMessage(provider.id, owners, conflict),
          service: provider.id,
          provider: loaded.metadata.manifest.identity,
        };
      }
    }
    return undefined;
  }

  private declaredProviders(
    service: string,
    requester: string,
    manifest?: LoadedRuntimeExtensionPackage['metadata']['manifest'],
  ): string[] {
    const requesterManifest = manifest ?? this.installed.get(requester)?.loaded?.metadata.manifest;
    const declared = new Set(
      requesterManifest?.dependencies?.extensions?.map((dependency) => dependencyIdentity(dependency))
        .filter((identity): identity is string => Boolean(identity)),
    );
    return [...this.installed.values()]
      .filter((entry) => entry.identity !== requester
        && declared.has(entry.identity)
        && entry.loaded?.metadata.manifest.provides?.services?.some((provider) => provider.id === service))
      .map((entry) => entry.identity);
  }

  private serviceAccessorFor(
    manifest: LoadedRuntimeExtensionPackage['metadata']['manifest'],
    identity: string,
    base: RuntimeServiceAccessor = this.services,
  ): RuntimeServiceAccessor {
    const entry = this.installed.get(identity);
    const mapToken = <T>(token: import('@marshal/agent-runtime-composer').RuntimeServiceToken<T>) => {
      const key = Symbol.keyFor(token);
      if (!key) return token;
      const dependency = manifest.dependencies?.services
        ?.find((candidate) => serviceIdentity(candidate) === key);
      const provider = dependencyProvider(dependency)
        ?? (dependency ? this.uniqueDeclaredProviderForManifest(key, identity, manifest) : undefined);
      const effective = provider
        ? privateProviderServiceId(provider, key)
        : entry?.contractBindings[key];
      return effective ? Symbol.for(effective) as import('@marshal/agent-runtime-composer').RuntimeServiceToken<T> : token;
    };
    const accessor: RuntimeServiceAccessor = {
      get: <T>(token: import('@marshal/agent-runtime-composer').RuntimeServiceToken<T>) => base.get(mapToken(token)),
      tryGet: <T>(token: import('@marshal/agent-runtime-composer').RuntimeServiceToken<T>) => base.tryGet(mapToken(token)),
      getAll: <T>(token: import('@marshal/agent-runtime-composer').RuntimeServiceToken<T>) => base.getAll(mapToken(token)),
    };
    return accessor;
  }

  private uniqueDeclaredProviderForManifest(
    service: string,
    requester: string,
    manifest: LoadedRuntimeExtensionPackage['metadata']['manifest'],
  ): string | undefined {
    const owners = this.declaredProviders(service, requester, manifest);
    return owners.length === 1 ? owners[0] : undefined;
  }

  private async validateResources(
    replacingIdentity: string,
    next: readonly RuntimeScopedResourcePort[],
    context: InvocationContext,
  ): Promise<void> {
    const owners = new Map<string, string[]>();
    for (const [identity, entry] of this.installed) {
      if (identity === replacingIdentity || entry.status !== 'enabled') continue;
      for (const provider of entry.active!.prepared.resourceProviders) {
        await collect(provider, identity);
      }

    }
    for (const provider of next) await collect(provider, replacingIdentity);
    for (const [uri, identities] of owners) {
      if (identities.length > 1) {
        throw new RuntimeExtensionError(
          'DUPLICATE_RESOURCE',
          new Error(`Runtime resource "${uri}" has multiple owners: ${identities.join(', ')}.`),
        );
      }
    }


    async function collect(provider: RuntimeScopedResourcePort, identity: string) {
      for (const descriptor of await provider.listResources(context)) {
        validateResourceDescriptor(descriptor);
        const identities = owners.get(descriptor.uri) ?? [];
        identities.push(identity);
        owners.set(descriptor.uri, identities);
      }
    }
  }

  private async registerPrepared(
    prepared: PreparedActivation,
    signal: RuntimeAbortSignal | undefined,
    replacement?: ActiveExtension,
  ): Promise<ActiveExtension> {
    const serviceBindings: RuntimeServiceBindingHandle[] = [];
    const compositionBindings: RuntimeServiceBindingHandle[] = [];
    const subscriptions: { dispose(): void }[] = [];
    let lifecycleRegistration: import('./contracts.js').RuntimeExtensionOwnedRegistration | undefined;
    let jobRegistration: import('./contracts.js').RuntimeExtensionJobHandlerReservation | undefined;
    let registration: RuntimeKernelContributionRegistration | undefined;
    try {
      if (prepared.jobHandlers.length > 0) {
        if (!this.jobManager) {
          throw new Error('Runtime extension background jobs are not available.');
        }
        jobRegistration = this.jobManager.reserveHandlers(prepared.jobHandlers);
      }
      for (const contribution of prepared.serviceContributions) {
        assertNotCancelled(signal);
        const candidateManifest = prepared.loaded.metadata.manifest;
        const candidateIdentity = candidateManifest.identity;
        const accessorForScope = (scope: RuntimeServiceAccessor) =>
          this.serviceAccessorFor(candidateManifest, candidateIdentity, scope);
        const mappedBinding = mapBinding(contribution.binding, accessorForScope);
        const composition = compositionRegistration(
          candidateManifest,
          candidateIdentity,
          contribution,
          this.installed.get(candidateIdentity)?.contractBindings,
        );
        if (composition) {
          const privateProviderToken = Symbol.for(privateProviderServiceId(
            candidateIdentity,
            composition.provider.contract.name,
          )) as import('@marshal/agent-runtime-composer').RuntimeServiceToken<unknown>;
          serviceBindings.push(await this.services.bind(
            privateProviderToken,
            mappedBinding,
          ));
          compositionBindings.push(await this.compositionRegistry.registerProvider(composition));
        } else {
          const handle = contribution.mode === 'replace'
            ? await this.services.replace(
              contribution.token,
              mappedBinding,
            )
            : contribution.mode === 'many'
              ? await this.services.bindMany(
                contribution.token,
                mappedBinding,
              )
              : await this.services.bind(
                contribution.token,
                mappedBinding,
              );
          serviceBindings.push(handle);
        }
      }
      for (const entry of this.installed.values()) {
        if (entry.status !== 'enabled') continue;
        for (const [service, provider] of Object.entries(entry.providerOverrides)) {
          const inspection = this.compositionRegistry.list()
            .find(({ service: descriptor }) => descriptor.key === service);
          if (!inspection || !inspection.providers.some(({ provider: candidate }) => candidate.id === provider)) {
            continue;
          }
          await this.compositionRegistry.setProviderOverride(inspection.service, provider);
        }
      }
      for (const contribution of prepared.eventSubscriptions) {
        assertNotCancelled(signal);
        subscriptions.push(this.kernel.events.subscribe(contribution.type, contribution.listener));
      }
      assertNotCancelled(signal);
      registration = replacement
        ? await replacement.registration.replace(
          prepared.kernelContributions,
          this.context(signal),
        )
        : await this.kernel.registerContributions(prepared.kernelContributions, this.context(signal));
      let publication: ActiveExtension['publication'];
      const applications = prepared.activation.uiApplications ?? [];
      const placements = prepared.activation.uiPlacements ?? [];
      const publicationService = applications.length > 0 || placements.length > 0
        ? this.services.tryGet(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE)
        : undefined;
      if (publicationService) {
        const ownerId = prepared.loaded.metadata.manifest.identity;
        const revisionId = this.nextUiRevisionId(prepared);
        const context = this.publicationContext(ownerId, signal);
        await publicationService.preparePublicationRevision(
          ownerId,
          revisionId,
          {
            ownerId,
            revisionId,
            applications,
            placements,
          },
          context,
          { signal },
        );
        assertNotCancelled(signal);
        publication = {
          service: publicationService,
          ownerId,
          revisionId,
          context,
        };
      }
      assertNotCancelled(signal);
      if (prepared.lifecycle) {
        if (!this.registerLifecycle) {
          throw new Error('Runtime extension lifecycle contributions are not available.');
        }
        lifecycleRegistration = await this.registerLifecycle(prepared.lifecycle);
      }
      jobRegistration?.publish();
      if (prepared.jobHandlers.length > 0) {
        void Promise.resolve()
          .then(() => this.recoverJobHandlers?.(prepared.jobHandlers.map(({ kind }) => kind)))
          .catch(() => undefined);
      }
      return {
        prepared,
        registration,
        serviceBindings,
        compositionBindings,
        subscriptions,
        ...(lifecycleRegistration ? { lifecycleRegistration } : {}),
        ...(jobRegistration ? { jobRegistration } : {}),
        ...(publication ? { publication } : {}),
      };
    } catch (error) {
      const failures: unknown[] = [error];
      if (lifecycleRegistration) {
        try {
          await lifecycleRegistration.dispose();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (jobRegistration) {
        try {
          await jobRegistration.dispose();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (registration) {
        try {
          if (replacement) {
            replacement.registration = await registration.replace(
              replacement.prepared.kernelContributions,
              this.rollbackContext(),
            );
          } else {
            registration.dispose();
          }
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      for (const subscription of subscriptions.reverse()) {
        try {
          subscription.dispose();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      for (const binding of serviceBindings.reverse()) {
        try {
          await binding.dispose();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      for (const binding of compositionBindings.reverse()) {
        try {
          await binding.dispose();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length === 1) throw error;
      throw new AggregateError(
        failures,
        'Runtime extension contribution registration rollback failed.',
      );
    }
  }

  private async activatePrepared(
    prepared: PreparedActivation,
    signal: RuntimeAbortSignal | undefined,
    replacement?: ActiveExtension,
  ): Promise<ActiveExtension> {
    try {
      return await this.registerPrepared(prepared, signal, replacement);
    } catch (error) {
      try {
        await this.cleanupPrepared(prepared);
      } catch (cleanupError) {
        throw mapRegistrationError(
          new AggregateError(
            [error, cleanupError],
            'Runtime extension activation cleanup failed after registration failure.',
          ),
          signal,
        );
      }
      throw mapRegistrationError(error, signal);
    }
  }

  private async replaceEnabledEntry(
    entry: InstalledExtension,
    request: RuntimeExtensionInstallRequest,
    loaded: LoadedRuntimeExtensionPackage,
    configured: import('./contracts.js').RuntimeExtensionConfiguration | undefined,
    signal: RuntimeAbortSignal | undefined,
  ): Promise<RuntimeExtensionRecord> {
    const currentLoaded = entry.loaded;
    if (!currentLoaded) throw new RuntimeExtensionError('NOT_INSTALLED');
    const identity = currentLoaded.metadata.manifest.identity;
    const previous = {
      request: entry.request,
      loaded: currentLoaded,
      configuration: entry.configuration,
      explicitConfiguration: entry.explicitConfiguration,
      active: entry.active!,
    };
    const prepared = await this.prepareActivation(
      loaded,
      identity,
      signal,
      configured,
    );

    let priorCleanupStarted = false;
    entry.status = 'disabled';
    try {
      await this.clearCompositionOverrides(identity);
      priorCleanupStarted = true;
      await this.cleanupActive(previous.active);
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await this.cleanupPrepared(prepared);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (!priorCleanupStarted) {
        entry.status = 'enabled';
        throw new RuntimeExtensionError(
          'DISPOSAL_FAILED',
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, 'Runtime extension update preparation cleanup failed.'),
        );
      }
      try {
        const restoredPrepared = await this.prepareActivation(
          previous.loaded,
          identity,
          undefined,
          previous.configuration,
        );
        entry.request = previous.request;
        entry.loaded = previous.loaded;
        entry.identity = previous.loaded.metadata.manifest.identity;
        entry.version = previous.loaded.metadata.manifest.version;
        entry.integrity = previous.loaded.metadata.integrity;
        entry.entrypoint = previous.loaded.metadata.manifest.entrypoint;
        entry.activationOrder = previous.loaded.metadata.manifest.activationOrder ?? 0;
        entry.configuration = previous.configuration;
        entry.explicitConfiguration = previous.explicitConfiguration;
        entry.activationFailure = undefined;
        entry.active = await this.activatePrepared(restoredPrepared, undefined);
        entry.status = 'enabled';
      } catch (rollbackError) {
        failures.push(rollbackError);
        entry.status = 'disabled';
        entry.active = undefined;
        entry.activationFailure = {
          code: 'DISPOSAL_FAILED',
          message: `The previous extension version could not be cleaned up or restored: ${
            rollbackError instanceof Error ? rollbackError.message : 'restoration failed.'
          }`,
        };
        try {
          await this.persist();
        } catch (stateError) {
          failures.push(stateError);
        }
      }
      throw new RuntimeExtensionError(
        'DISPOSAL_FAILED',
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Runtime extension update cleanup rollback failed.'),
      );
    }

    entry.active = undefined;
    let active: ActiveExtension;
    try {
      active = await this.activatePrepared(prepared, signal);
    } catch (activationError) {
      try {
        const restoredPrepared = await this.prepareActivation(
          previous.loaded,
          identity,
          undefined,
          previous.configuration,
        );
        const restoredActive = await this.activatePrepared(restoredPrepared, undefined);
        entry.request = previous.request;
        entry.loaded = previous.loaded;
        entry.configuration = previous.configuration;
        entry.explicitConfiguration = previous.explicitConfiguration;
        entry.activationFailure = undefined;
        entry.active = restoredActive;
        entry.status = 'enabled';
        await this.persist();
      } catch (rollbackError) {
        entry.status = 'disabled';
        entry.active = undefined;
        entry.activationFailure = {
          code: 'ACTIVATION_FAILED',
          message: `The update failed and the previous version could not be restored: ${
            rollbackError instanceof Error ? rollbackError.message : 'restoration failed.'
          }`,
        };
        await this.persist();
        throw new RuntimeExtensionError(
          'ACTIVATION_FAILED',
          new AggregateError([activationError, rollbackError]),
        );
      }
      throw activationError;
    }

    entry.request = freezeRequest(request);
    entry.loaded = loaded;
    entry.identity = loaded.metadata.manifest.identity;
    entry.version = loaded.metadata.manifest.version;
    entry.integrity = loaded.metadata.integrity;
    entry.entrypoint = loaded.metadata.manifest.entrypoint;
    entry.activationOrder = loaded.metadata.manifest.activationOrder ?? 0;
    entry.configuration = prepared.configuration;
    entry.explicitConfiguration = configured;
    entry.activationFailure = undefined;
    entry.active = active;
    entry.status = 'enabled';
    try {
      await this.persist();
    } catch (error) {
      entry.status = 'disabled';
      entry.request = previous.request;
      entry.loaded = previous.loaded;
      entry.identity = previous.loaded.metadata.manifest.identity;
      entry.version = previous.loaded.metadata.manifest.version;
      entry.integrity = previous.loaded.metadata.integrity;
      entry.entrypoint = previous.loaded.metadata.manifest.entrypoint;
      entry.activationOrder = previous.loaded.metadata.manifest.activationOrder ?? 0;
      entry.configuration = previous.configuration;
      entry.explicitConfiguration = previous.explicitConfiguration;
      entry.active = active;
      try {
        await this.cleanupActive(active, 'rollback');
        entry.active = undefined;
        const restoredPrepared = await this.prepareActivation(
          previous.loaded,
          identity,
          undefined,
          previous.configuration,
        );
        entry.active = await this.activatePrepared(restoredPrepared, undefined);
        entry.status = 'enabled';
        await this.persist();
      } catch (rollbackError) {
        entry.status = 'disabled';
        entry.active = undefined;
        entry.activationFailure = {
          code: 'STATE_FAILED',
          message: `The update state could not be persisted and the previous version could not be restored: ${
            rollbackError instanceof Error ? rollbackError.message : 'restoration failed.'
          }`,
        };
        await this.persist();
      }
      throw error;
    }
    await this.reconcileDependents();
    return record(entry);
  }

  private async listResources(
    context: InvocationContext,
  ): Promise<readonly RuntimeResourceDescriptor[]> {
    this.assertUsable();
    const resources: RuntimeResourceDescriptor[] = [];
    const owners = new Map<string, number>();
    for (const entry of this.installed.values()) {
      if (entry.status !== 'enabled') continue;
      for (const provider of entry.active!.prepared.resourceProviders) {
        for (const descriptor of await provider.listResources(context)) {
          validateResourceDescriptor(descriptor);
          resources.push(descriptor);
          owners.set(descriptor.uri, (owners.get(descriptor.uri) ?? 0) + 1);
        }
      }
    }
    if ([...owners.values()].some((count) => count > 1)) {
      throw new RuntimeExtensionError('DUPLICATE_RESOURCE');
    }
    return Object.freeze(resources.sort((left, right) => left.uri.localeCompare(right.uri)));
  }

  private async readResource(
    uri: string,
    context: InvocationContext,
  ): Promise<RuntimeResourceContent> {
    this.assertUsable();
    const matches: RuntimeScopedResourcePort[] = [];
    for (const entry of this.installed.values()) {
      if (entry.status !== 'enabled') continue;
      for (const provider of entry.active!.prepared.resourceProviders) {
        if ((await provider.listResources(context)).some((item) => item.uri === uri)) {
          matches.push(provider);
        }
      }
    }
    if (matches.length === 0) throw new RuntimeExtensionError('RESOURCE_NOT_FOUND');
    if (matches.length > 1) throw new RuntimeExtensionError('DUPLICATE_RESOURCE');
    const content = await matches[0]!.readResource(uri, context);
    if (content.uri !== uri) {
      throw new RuntimeExtensionError(
        'INVALID_CONTRIBUTIONS',
        new Error('Runtime resource provider returned content for a different URI.'),
      );
    }
    return content;
  }

  private listUiPlacementContributions(
    extensionId?: string,
  ): readonly RuntimeExtensionUiPlacementRegistration[] {
    this.assertUsable();
    const normalizedIdentity = extensionId === undefined
      ? undefined
      : requireRuntimeExtensionIdentity(extensionId);
    return Object.freeze(
      this.activeUiPlacementRegistrations()
        .filter((registration) =>
          normalizedIdentity === undefined || registration.extensionId === normalizedIdentity)
        .sort(compareUiPlacementRegistrations),
    );
  }

  private resolveUiPlacements(): RuntimeExtensionUiPlacementRegistryResolution {
    this.assertUsable();
    return this.uiPlacementRegistry.resolve(this.activeUiPlacementRegistrations());
  }

  private validateUiPlacements(
    replacingIdentity: string,
    next: readonly RuntimeExtensionUiPlacementRegistration[],
  ): void {
    const resolution = this.uiPlacementRegistry.resolve([
      ...this.activeUiPlacementRegistrations(replacingIdentity),
      ...next,
    ]);
    if (resolution.diagnostics.length > 0) {
      throw new RuntimeExtensionError(
        'UI_PLACEMENT_REGISTRATION_FAILED',
        new RuntimeExtensionUiPlacementRegistrationError(resolution.diagnostics),
      );
    }
  }

  private activeUiPlacementRegistrations(
    excludedIdentity?: string,
  ): RuntimeExtensionUiPlacementRegistration[] {
    const registrations: RuntimeExtensionUiPlacementRegistration[] = [];
    for (const [identity, entry] of this.installed) {
      if (
        identity === excludedIdentity
        || entry.status !== 'enabled'
      ) {
        continue;
      }
      registrations.push(...entry.active!.prepared.uiPlacementRegistrations);
    }
    return registrations;
  }

  private async disableEntry(entry: InstalledExtension): Promise<void> {
    if (entry.status === 'disabled' && !entry.active) return;
    await this.clearCompositionOverrides(entry.identity);
    const active = entry.active!;
    try {
      await this.cleanupActive(active);
    } finally {
      entry.status = 'disabled';
      entry.active = undefined;
    }
  }

  private async reconcileDependents(): Promise<void> {
    let changed = false;
    do {
      changed = false;
      const affected: InstalledExtension[] = [];
      for (const entry of this.installed.values()) {
        if (entry.status !== 'enabled' || !entry.active) continue;
        if (entry.loaded
          && this.activationBlockReason(entry.loaded, entry.loaded.metadata.manifest.identity)) {
          affected.push(entry);
        }
      }
      for (const entry of affected) {
        entry.activationFailure = this.activationBlockReason(
          entry.loaded!,
          entry.loaded!.metadata.manifest.identity,
        );
        await this.disableEntry(entry);
        changed = true;
      }
      if (changed) await this.persist();
      for (const entry of this.installed.values()) {
        if (!entry.desiredEnabled || entry.status !== 'disabled' || !entry.loaded || !entry.activationFailure
          || !isDependencyBlockReason(entry.activationFailure)) continue;
        const block = this.activationBlockReason(
          entry.loaded,
          entry.loaded.metadata.manifest.identity,
        );
        if (block) {
          entry.activationFailure = block;
          continue;
        }
        try {
          const prepared = await this.prepareActivation(
            entry.loaded,
            entry.identity,
            undefined,
            entry.configuration,
          );
          entry.active = await this.activatePrepared(prepared, undefined);
          entry.status = 'enabled';
          entry.activationFailure = undefined;
          await this.persist();
          changed = true;
        } catch (error) {
          entry.activationFailure = this.activationFailureReason(entry.loaded, error);
        }
      }
    } while (changed);
  }

  private restoreDependencyBlockReason(
    loaded: LoadedRuntimeExtensionPackage,
  ): RuntimeExtensionBlockReason | undefined {
    const dependencies = loaded.metadata.manifest.dependencies?.extensions ?? [];
    for (const dependency of dependencies) {
      const id = dependencyIdentity(dependency);
      if (!id) continue;
      const target = this.installed.get(id);
      if (!target) {
        return { code: 'MISSING_DEPENDENCY', message: `Dependency "${id}" is not installed.`, dependency: id };
      }
      if (target.status !== 'enabled' || !target.active) {
        return { code: 'DISABLED_DEPENDENCY', message: `Dependency "${id}" is disabled.`, dependency: id };
      }
      if (!target.loaded
        || !matchesVersion(target.loaded.metadata.manifest.version, dependencyVersion(dependency))) {
        return { code: 'VERSION_MISMATCH', message: `Dependency "${id}" has an incompatible version.`, dependency: id };
      }
    }
    for (const dependency of loaded.metadata.manifest.dependencies?.services ?? []) {
      const service = serviceIdentity(dependency);
      if (!service) continue;
      const declaredProviders = this.declaredProviders(
        service,
        loaded.metadata.manifest.identity,
        loaded.metadata.manifest,
      );
      const explicitProvider = dependencyProvider(dependency);
      if (explicitProvider && !declaredProviders.includes(explicitProvider)) {
        return {
          code: 'MISSING_SERVICE_DEPENDENCY',
          message: `Service "${service}" specifies an undeclared provider "${explicitProvider}".`,
          service,
          provider: explicitProvider,
        };
      }
      const providerIdentity = explicitProvider
        ?? (declaredProviders.length === 1 ? declaredProviders[0] : undefined);
      if (!providerIdentity && declaredProviders.length > 1) {
        return {
          code: 'AMBIGUOUS_SERVICE_DEPENDENCY',
          message: `Service "${service}" has multiple declared providers; specify provider explicitly.`,
          service,
        };
      }
      const effectiveService = providerIdentity
        ? this.installed.get(providerIdentity)?.contractBindings[service] ?? service
        : service;
      const selected = this.compositionRegistry.list()
        .find(({ service: descriptor }) => descriptor.key === effectiveService)
        ?.providers.find(({ status }) => status === 'active' || status === 'overridden');
      if (!selected) {
        return { code: 'MISSING_SERVICE_DEPENDENCY', message: `Service "${effectiveService}" is not available.`, service: effectiveService };
      }
      if (!matchesVersion(
        typeof selected.provider.metadata?.version === 'string'
          ? selected.provider.metadata.version
          : selected.provider.contract.version,
        dependencyVersion(dependency),
      )) {
        return { code: 'VERSION_MISMATCH', message: `Service "${effectiveService}" has an incompatible version.`, service: effectiveService };
      }
    }
    return undefined;
  }

  private activationFailureReason(
    loaded: LoadedRuntimeExtensionPackage,
    error: unknown,
  ): RuntimeExtensionBlockReason {
    const block = this.activationBlockReason(
      loaded,
      loaded.metadata.manifest.identity,
    );
    if (block) return block;
    const message = underlyingErrorMessage(error)
      ?? 'The extension failed during activation.';
    if (/configuration/i.test(message)) {
      return {
        code: 'INVALID_CONFIGURATION',
        message: `Extension configuration is invalid: ${message}`,
      };
    }
    if (/incompatible contract/i.test(message)) {
      const provider = loaded.metadata.manifest.provides?.services?.[0];
      const service = provider?.id ?? 'unknown';
      const owners = this.compositionRegistry.list()
        .find(({ service: descriptor }) => descriptor.key === service)
        ?.providers.map(({ provider: candidate }) => candidate.id) ?? [];
      return {
        code: 'INCOMPATIBLE_CONTRACT',
        message: incompatibleContractMessage(
          service,
          [...owners, loaded.metadata.manifest.identity],
          message,
        ),
        service,
        provider: loaded.metadata.manifest.identity,
      };
    }
    return {
      code: 'ACTIVATION_FAILED',
      message: `Extension activation failed: ${message}`,
    };
  }

  private async clearCompositionOverrides(identity: string): Promise<void> {
      for (const inspection of this.compositionRegistry.list()) {
        if (inspection.selectedProviderId !== identity
          && !inspection.providers.some(({ provider }) => provider.id === identity
            && this.compositionRegistry.snapshot().overrides[inspection.service.key] === identity)) {
          continue;
        }
        if (this.compositionRegistry.snapshot().overrides[inspection.service.key] === identity) {
          await this.compositionRegistry.clearProviderOverride(inspection.service);
        }
      }
  }

  private storedRecords(): readonly import('./contracts.js').RuntimeExtensionStoredRecord[] {
    return [...this.installed.values()].map((entry) => ({
      identity: entry.identity,
      version: entry.version,
      request: entry.request,
      ...(entry.explicitConfiguration ? { configuration: entry.explicitConfiguration } : {}),
      status: entry.desiredEnabled ? 'enabled' : 'disabled',
      providerOverrides: Object.freeze({ ...entry.providerOverrides }),
      ...(Object.keys(entry.contractBindings).length > 0
        ? { contractBindings: Object.freeze({ ...entry.contractBindings }) }
        : {}),
    }));
  }

  private async persist(
    records: readonly import('./contracts.js').RuntimeExtensionStoredRecord[] = this.storedRecords(),
  ): Promise<void> {
    if (!this.stateStore) return;
    try {
      await this.stateStore.save(records);
    } catch (error) {
      throw new RuntimeExtensionError('STATE_FAILED', error);
    }
  }

  private async cleanupAfterStateFailure(
    error: unknown,
    active: ActiveExtension,
  ): Promise<never> {
    try {
      await this.cleanupActive(active);
    } catch (cleanupError) {
      throw new RuntimeExtensionError(
        'STATE_FAILED',
        new AggregateError(
          [error, cleanupError],
          'Runtime extension state failure cleanup failed.',
        ),
      );
    }
    throw error;
  }

  private async cleanupPrepared(prepared: PreparedActivation): Promise<void> {
    if (prepared.cleaned) return;
    prepared.cleaned = true;
    try {
      await cleanupActivation(prepared.activation);
    } catch (error) {
      throw new RuntimeExtensionError('DISPOSAL_FAILED', error);
    }

  }

  private async cleanupActive(
    active: ActiveExtension,
    publicationAction: 'revoke' | 'rollback' = 'revoke',
  ): Promise<void> {
    const failures: unknown[] = [];
    let publicationCleanup: Promise<void> | undefined;
    if (active.publication) {
      try {
        publicationCleanup = Promise.resolve(
          publicationAction === 'rollback'
            ? active.publication.service.rollback(
              active.publication.ownerId,
              active.publication.revisionId,
              active.publication.context,
            )
            : active.publication.service.revoke(
              active.publication.ownerId,
              active.publication.revisionId,
              active.publication.context,
            ),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (active.lifecycleRegistration) {
      try {
        await active.lifecycleRegistration.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (active.jobRegistration) {
      try {
        await active.jobRegistration.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const subscription of [...active.subscriptions].reverse()) {
      try {
        subscription.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      active.registration.dispose();
    } catch (error) {
      failures.push(error);
    }
    const bindingCleanup = [...active.serviceBindings].reverse().map((binding) => {
      try {
        return binding.dispose();
      } catch (error) {
        failures.push(error);
        return Promise.resolve();
      }
    });
    if (publicationCleanup) {
      try {
        await publicationCleanup;
      } catch (error) {
        failures.push(error);
      }
    }
    for (const cleanup of bindingCleanup) {
      try {
        await cleanup;
      } catch (error) {
        failures.push(error);
      }
    }
    for (const binding of [...active.compositionBindings].reverse()) {
      try {
        await binding.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.cleanupPrepared(active.prepared);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new RuntimeExtensionError(
        'DISPOSAL_FAILED',
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Runtime extension contribution cleanup failed.'),
      );
    }
  }

  private context(signal: RuntimeAbortSignal | undefined): InvocationContext {
    return {
      ...this.activationContext,
      signal: signal ?? this.activationContext.signal,
    };
  }

  private publicationContext(
    ownerId: string,
    signal: RuntimeAbortSignal | undefined,
  ): InvocationContext {
    return {
      ...this.context(signal),
      principal: {
        id: ownerId,
        kind: 'service',
      },
    };
  }

  private rollbackContext(): InvocationContext {
    return {
      ...this.activationContext,
      signal: undefined,
    };
  }

  private nextUiRevisionId(prepared: PreparedActivation): string {
    this.uiRevisionSequence += 1;
    return createHash('sha256')
      .update(prepared.loaded.metadata.manifest.identity, 'utf8')
      .update('\0', 'utf8')
      .update(prepared.loaded.metadata.integrity.value, 'utf8')
      .update('\0', 'utf8')
      .update(String(this.uiRevisionSequence), 'utf8')
      .digest('hex');
  }

  private requireInstalled(identity: string): InstalledExtension {
    const entry = this.installed.get(identity);
    if (!entry) throw new RuntimeExtensionError('NOT_INSTALLED');
    return entry;
  }

  private assertUsable(): void {
    if (this.disposed) throw new RuntimeExtensionError('MANAGER_DISPOSED');
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function compositionRegistration(
  manifest: LoadedRuntimeExtensionPackage['metadata']['manifest'],
  identity: string,
  contribution: import('./contracts.js').RuntimeExtensionServiceContribution,
  contractBindings: Readonly<Record<string, string>> | undefined,
): import('@marshal/agent-runtime-composer').RuntimeCompositionProviderRegistration<unknown> | undefined {
  const tokenKey = Symbol.keyFor(contribution.token);
  const provider = manifest.provides?.services?.find((candidate) =>
    tokenKey === candidate.id || tokenKey?.endsWith(`:${candidate.id}`));
  if (!provider) return undefined;
  const effectiveService = contractBindings?.[provider.id] ?? provider.id;
  const contract: RuntimeCompositionContractDescriptor = {
    name: provider.id,
    version: provider.version,
    ...(provider.declaration === undefined ? {} : { declaration: provider.declaration }),
    methods: provider.publicMethods.map((method) => ({
      name: method.name,
      ...(method.input === undefined ? {} : { input: method.input }),
      ...(method.output === undefined ? {} : { output: method.output }),
    })),
  };
  const explicitBinding = contractBindings !== undefined
    && Object.prototype.hasOwnProperty.call(contractBindings, provider.id);
  const publicName = explicitBinding
    ? effectiveService === provider.id
      ? publicServiceName(provider.id)
      : namespacedPublicName(identity, provider.id)
    : undefined;
  const service = createRuntimeCompositionServiceDescriptor<unknown>(
    effectiveService,
    contract,
    publicName,
  );
  return {
    provider: {
      id: identity,
      service,
      contract,
      metadata: { extensionIdentity: identity, version: provider.version },
    },
    binding: forwardingBinding(
      Symbol.for(privateProviderServiceId(identity, provider.id)),
    ),
  };
}

function mapBinding<T>(
  binding: RuntimeServiceBinding<T>,
  accessorForScope: (scope: RuntimeServiceAccessor) => RuntimeServiceAccessor,
): RuntimeServiceBinding<T> {
  if (!('useFactory' in binding) || typeof binding.useFactory !== 'function') return binding;
  return {
    ...binding,
    useFactory: (scope: RuntimeServiceAccessor) => binding.useFactory(accessorForScope(scope)),
  };
}

function forwardingBinding<T>(
  token: import('@marshal/agent-runtime-composer').RuntimeServiceToken<T>,
): RuntimeServiceBinding<T> {
  return {
    useFactory: (scope) => scope.get(token),
    lifetime: 'transient',
  };
}

function privateProviderServiceId(providerIdentity: string, canonicalService: string): string {
  return `@marshal/runtime-extension-provider-${encodeURIComponent(providerIdentity)}:${encodeURIComponent(canonicalService)}`;
}

function toCompositionContract(provider: {
  readonly id: string;
  readonly version: string;
  readonly declaration?: string;
  readonly publicMethods: readonly { readonly name: string; readonly input?: string; readonly output?: string }[];
}): RuntimeCompositionContractDescriptor {
  return {
    name: provider.id,
    version: provider.version,
    ...(provider.declaration === undefined ? {} : { declaration: provider.declaration }),
    methods: provider.publicMethods.map((method) => ({
      name: method.name,
      ...(method.input === undefined ? {} : { input: method.input }),
      ...(method.output === undefined ? {} : { output: method.output }),
    })),
  };
}

function namespacedServiceId(providerIdentity: string, canonicalService: string): string {
  return `@marshal/runtime-extension-${encodeURIComponent(providerIdentity)}:${encodeURIComponent(canonicalService)}`;
}

function namespacedPublicName(providerIdentity: string, canonicalService: string): string {
  return `${publicServiceName(canonicalService)}_${normalizeIdentifierWords(providerIdentity)}`;
}

function publicServiceName(service: string): string {
  const segment = service.slice(Math.max(service.lastIndexOf('/'), service.lastIndexOf(':')) + 1);
  const withoutInterfacePrefix = /^I[A-Z]/.test(segment) ? segment.slice(1) : segment;
  return normalizeIdentifierWords(withoutInterfacePrefix);
}

function normalizeIdentifierWords(value: string): string {
  const words = value.match(/[A-Za-z0-9]+/g) ?? [];
  const normalized = words.length === 0
    ? 'service'
    : words[0]!.toLowerCase() + words.slice(1).map((word) =>
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('');
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `service${normalized}`;
}

function validateRepairRequest(request: RuntimeExtensionContractRepairRequest): RuntimeExtensionContractRepairRequest {
  if (!request || typeof request !== 'object' || typeof request.canonicalService !== 'string'
    || !request.canonicalService.trim() || !Array.isArray(request.bindings) || request.bindings.length === 0) {
    throw new RuntimeExtensionError('INVALID_CONTRIBUTIONS', new Error('Contract repair request is invalid.'));
  }
  const bindings = request.bindings.map((choice) => {
    if (!choice || typeof choice !== 'object'
      || typeof choice.providerIdentity !== 'string'
      || typeof choice.effectiveService !== 'string'
      || typeof choice.publicName !== 'string'
      || choice.canonicalService !== request.canonicalService) {
      throw new RuntimeExtensionError('INVALID_CONTRIBUTIONS', new Error('Contract repair binding choice is invalid.'));
    }
    return Object.freeze({ ...choice });
  });
  if (new Set(bindings.map((choice) => choice.providerIdentity)).size !== bindings.length) {
    throw new RuntimeExtensionError('INVALID_CONTRIBUTIONS', new Error('Contract repair bindings must be unique.'));
  }
  const publicNames = new Map<string, string>();
  for (const choice of bindings) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(choice.publicName)) {
      throw new RuntimeExtensionError(
        'INVALID_CONTRIBUTIONS',
        new Error(`Contract repair public name "${choice.publicName}" is not a valid identifier.`),
      );
    }
    const previousEffective = publicNames.get(choice.publicName);
    if (previousEffective !== undefined && previousEffective !== choice.effectiveService) {
      throw new RuntimeExtensionError(
        'INVALID_CONTRIBUTIONS',
        new Error(`Contract repair public name "${choice.publicName}" is ambiguous.`),
      );
    }
    publicNames.set(choice.publicName, choice.effectiveService);
  }
  if (request.enable !== undefined && (!Array.isArray(request.enable)
    || request.enable.some((identity) => typeof identity !== 'string'))) {
    throw new RuntimeExtensionError('INVALID_CONTRIBUTIONS', new Error('Contract repair enable list is invalid.'));
  }
  if (request.enable !== undefined
    && new Set(request.enable).size !== request.enable.length) {
    throw new RuntimeExtensionError(
      'INVALID_CONTRIBUTIONS',
      new Error('Contract repair enable targets must be unique.'),
    );
  }
  return Object.freeze({
    canonicalService: request.canonicalService,
    bindings: Object.freeze(bindings),
    ...(request.enable ? { enable: Object.freeze([...request.enable]) } : {}),
  });
}

function normalizeActivation(
  value: RuntimeExtensionActivation,
  identity: string,
): {
  readonly activation: RuntimeExtensionActivation;
  readonly kernelContributions: RuntimeKernelContributionSet;
  readonly resourceProviders: readonly RuntimeScopedResourcePort[];
  readonly uiPlacementRegistrations: readonly RuntimeExtensionUiPlacementRegistration[];
  readonly serviceContributions: readonly import('./contracts.js').RuntimeExtensionServiceContribution[];
  readonly eventSubscriptions: readonly import('./contracts.js').RuntimeExtensionEventSubscriptionContribution[];
  readonly lifecycle?: import('./contracts.js').RuntimeExtensionLifecyclePort;
  readonly jobHandlers: readonly import('@marshal/agent-runtime-core').RuntimeBackgroundJobHandler[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Runtime extension activation must be an object.');
  }

  const capabilityProviders = boundedArray(value.capabilityProviders, 'capabilityProviders');
  const serviceContributions = boundedArray(value.serviceContributions, 'serviceContributions');
  const eventSubscriptions = boundedArray(value.eventSubscriptions, 'eventSubscriptions');
  const jobHandlers = boundedArray(value.jobHandlers, 'jobHandlers');
  const catalogProviders = boundedArray(value.catalogProviders, 'catalogProviders');
  const resourceProviders = boundedArray(value.resourceProviders, 'resourceProviders');
  const uiApplications = boundedArray(value.uiApplications, 'uiApplications')
    .map(validateUiApplication);
  assertUniqueIds(uiApplications, 'UI application');
  const uiPlacements = boundedArray(value.uiPlacements, 'uiPlacements')
    .map((placement) => validateUiPlacement(placement, uiApplications));
  const lifecycle = value.lifecycle;
  for (const provider of capabilityProviders) {
    if (!provider || typeof provider !== 'object' || typeof provider.list !== 'function'
      || typeof provider.invoke !== 'function') {
      throw new TypeError('Runtime extension capability provider is invalid.');
    }
  }
  for (const provider of catalogProviders) {
    if (!provider || typeof provider !== 'object' || typeof provider.list !== 'function') {
      throw new TypeError('Runtime extension catalog provider is invalid.');
    }
  }
  for (const provider of resourceProviders) {
    if (!provider || typeof provider !== 'object'
      || typeof provider.listResources !== 'function'
      || typeof provider.readResource !== 'function') {
      throw new TypeError('Runtime extension resource provider is invalid.');
    }
  }
  if (
    lifecycle !== undefined
    && (
      !lifecycle
      || typeof lifecycle !== 'object'
      || typeof lifecycle.startSession !== 'function'
      || typeof lifecycle.observeTurn !== 'function'
      || typeof lifecycle.endSession !== 'function'
    )
  ) {
    throw new TypeError('Runtime extension lifecycle contribution is invalid.');
  }
  for (const handler of jobHandlers) {
    if (
      !handler
      || typeof handler !== 'object'
      || typeof handler.kind !== 'string'
      || typeof handler.start !== 'function'
    ) {
      throw new TypeError('Runtime extension job handler is invalid.');
    }
  }
  if (value.dispose !== undefined && typeof value.dispose !== 'function') {
    throw new TypeError('Runtime extension dispose must be a function.');
  }

  const token = extensionToken(identity);
  const uiResources = uiApplications.length > 0
    ? [createUiResourceProvider(uiApplications)]
    : [];
  const allResources = [...resourceProviders, ...uiResources];
  const resourceCatalogs = allResources.map((provider, index) =>
    createResourceCatalogProvider(provider, token, index));
  const uiCatalogs = uiApplications.length > 0
    ? [createUiCatalogProvider(uiApplications, token)]
    : [];
  return {
    activation: Object.freeze({
      capabilityProviders: Object.freeze([...capabilityProviders]),
      catalogProviders: Object.freeze([...catalogProviders]),
      resourceProviders: Object.freeze([...resourceProviders]),
      uiApplications: Object.freeze([...uiApplications]),
      uiPlacements: Object.freeze([...uiPlacements]),
      ...(lifecycle ? { lifecycle } : {}),
      jobHandlers: Object.freeze([...jobHandlers]),
      ...(value.dispose ? { dispose: value.dispose } : {}),
    }),
    kernelContributions: {
      providers: Object.freeze([...capabilityProviders]),
      catalogProviders: Object.freeze([
        ...catalogProviders,
        ...resourceCatalogs,
        ...uiCatalogs,
      ]),
    },
    resourceProviders: Object.freeze(allResources),
    uiPlacementRegistrations: Object.freeze(
      uiPlacements.map((placement) => toUiPlacementRegistration(identity, placement)),
    ),
    serviceContributions: Object.freeze([...serviceContributions]),
    eventSubscriptions: Object.freeze([...eventSubscriptions]),
    ...(lifecycle ? { lifecycle } : {}),
    jobHandlers: Object.freeze([...jobHandlers]),
  };
}

function createResourceCatalogProvider(
  resources: RuntimeScopedResourcePort,
  token: string,
  index: number,
): RuntimeCatalogProvider {
  const id = `runtime.extension.resource.${token}.${index}`;
  return {
    id,
    async list(context) {
      return (await resources.listResources(context)).map((descriptor) =>
        resourceCatalogEntry(id, descriptor));
    },
    async get(catalogId, context) {
      const found = (await resources.listResources(context))
        .find((descriptor) => resourceCatalogId(id, descriptor.uri) === catalogId);
      return found ? resourceCatalogEntry(id, found) : undefined;
    },
  };
}

function resourceCatalogEntry(
  providerId: string,
  descriptor: RuntimeResourceDescriptor,
): RuntimeCatalogEntry {
  validateResourceDescriptor(descriptor);
  return {
    id: resourceCatalogId(providerId, descriptor.uri),
    kind: 'resource',
    title: descriptor.name,
    description: descriptor.description ?? `Read runtime resource "${descriptor.name}".`,
    tags: ['resource', ...(descriptor.mimeType ? [descriptor.mimeType] : [])],
    action: { type: 'resource_read', uri: descriptor.uri },
    metadata: {
      owner: { type: 'extension', id: providerId },
      resourceUri: descriptor.uri,
    },
  };
}

function resourceCatalogId(providerId: string, uri: string): string {
  return `catalog://${providerId}/${encodeURIComponent(uri)}`;
}

function createUiCatalogProvider(
  applications: readonly RuntimeExtensionUiApplication[],
  token: string,
): RuntimeCatalogProvider {
  const entries = applications.map((application) => ({
    id: `ui://runtime-extension/${token}/${encodeURIComponent(application.id)}`,
    kind: 'ui_application' as const,
    title: application.title,
    description: application.description,
    tags: ['ui', 'application', ...(application.tags ?? [])],
    action: {
      type: 'ui_render' as const,
      renderId: application.renderId,
      resourceUri: application.resource.uri,
    },
    metadata: {
      ...(application.metadata ?? {}),
      application: application.application,
      extensionApplicationId: application.id,
    },
  }));
  return {
    id: `runtime.extension.ui.${token}`,
    list: () => entries,
    get: (id) => entries.find((entry) => entry.id === id),
  };
}

function createUiResourceProvider(
  applications: readonly RuntimeExtensionUiApplication[],
): RuntimeScopedResourcePort {
  return {
    listResources: () => applications.map((application) => ({
      uri: application.resource.uri,
      name: application.title,
      description: application.description,
      mimeType: application.resource.mimeType,
    })),
    readResource: (uri) => {
      const application = applications.find((candidate) => candidate.resource.uri === uri);
      if (!application) throw new RuntimeExtensionError('RESOURCE_NOT_FOUND');
      return application.resource;
    },
  };
}

function validateUiApplication(
  value: RuntimeExtensionUiApplication,
): RuntimeExtensionUiApplication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Runtime extension UI application must be an object.');
  }
  for (const [label, field] of [
    ['id', value.id],
    ['title', value.title],
    ['description', value.description],
    ['renderId', value.renderId],
  ] as const) {
    if (typeof field !== 'string' || !field.trim() || field.length > 1_024) {
      throw new TypeError(`Runtime extension UI application ${label} is invalid.`);
    }
  }
  validateResourceContent(value.resource);
  return Object.freeze({
    ...value,
    tags: value.tags ? Object.freeze([...value.tags]) : undefined,
    application: validateUiApplicationManifest(value.application),
    resource: Object.freeze({ ...value.resource }),
  });
}

function validateUiPlacement(
  value: RuntimeExtensionUiPlacement,
  applications: readonly RuntimeExtensionUiApplication[],
): RuntimeExtensionUiPlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Runtime extension UI placement must be an object.');
  }
  for (const [label, field] of [
    ['placementId', value.placementId],
    ['applicationId', value.applicationId],
  ] as const) {
    if (typeof field !== 'string' || !field.trim() || field.length > 1_024) {
      throw new TypeError(`Runtime extension UI placement ${label} is invalid.`);
    }
  }
  if (!applications.some(({ id }) => id === value.applicationId)) {
    throw new TypeError(
      `Runtime extension UI placement references unknown application ${value.applicationId}.`,
    );
  }
  if (value.action === 'replace') {
    if (
      value.replacement !== undefined
      && value.replacement !== 'placement'
      && value.replacement !== 'full'
    ) {
      throw new TypeError('Runtime extension UI placement replacement scope is invalid.');
    }
    return Object.freeze({
      placementId: value.placementId,
      action: value.action,
      applicationId: value.applicationId,
      ...(value.replacement ? { replacement: value.replacement } : {}),
    });
  }
  if (value.action !== 'augment' && value.action !== 'fallback') {
    throw new TypeError('Runtime extension UI placement action is invalid.');
  }
  if ('replacement' in value && value.replacement !== undefined) {
    throw new TypeError('Only replacement UI placements may specify replacement scope.');
  }
  return Object.freeze({
    placementId: value.placementId,
    action: value.action,
    applicationId: value.applicationId,
  });
}

function toUiPlacementRegistration(
  identity: string,
  placement: RuntimeExtensionUiPlacement,
): RuntimeExtensionUiPlacementRegistration {
  if (placement.action === 'replace') {
    return Object.freeze({
      extensionId: identity,
      placementId: placement.placementId,
      action: placement.action,
      applicationId: placement.applicationId,
      ...(placement.replacement ? { replacement: placement.replacement } : {}),
    });
  }
  return Object.freeze({
    extensionId: identity,
    placementId: placement.placementId,
    action: placement.action,
    applicationId: placement.applicationId,
  });
}

function assertUniqueIds(
  values: readonly { readonly id: string }[],
  label: string,
): void {
  if (new Set(values.map(({ id }) => id)).size !== values.length) {
    throw new TypeError(`Runtime extension ${label} IDs must be unique.`);
  }
}

function validateResourceDescriptor(descriptor: RuntimeResourceDescriptor): void {
  if (
    !descriptor
    || typeof descriptor.uri !== 'string'
    || !descriptor.uri.trim()
    || descriptor.uri.length > RUNTIME_RESOURCE_URI_MAX_LENGTH
    || typeof descriptor.name !== 'string'
    || !descriptor.name.trim()
  ) {
    throw new TypeError('Runtime extension resource descriptor is invalid.');
  }
}

function validateResourceContent(content: RuntimeResourceContent): void {
  if (
    !content
    || typeof content !== 'object'
    || typeof content.uri !== 'string'
    || !content.uri.trim()
    || content.uri.length > RUNTIME_RESOURCE_URI_MAX_LENGTH
    || (content.text === undefined && content.blob === undefined)
    || (content.text !== undefined && typeof content.text !== 'string')
    || (content.blob !== undefined && typeof content.blob !== 'string')
  ) {
    throw new TypeError('Runtime extension resource content is invalid.');
  }
}

function boundedArray<T>(value: readonly T[] | undefined, label: string): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new TypeError(`Runtime extension ${label} must contain at most 128 items.`);
  }
  return value;
}

function extensionToken(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 24);
}

function record(entry: InstalledExtension): RuntimeExtensionLifecycleRecord {
  const manifest = entry.loaded?.metadata.manifest;
  return Object.freeze({
    identity: entry.identity,
    version: entry.version,
    integrity: entry.integrity,
    entrypoint: entry.entrypoint,
    request: entry.request,
    origin: 'native',
    title: entry.identity,
    description: entry.identity,
    status: entry.status,
    activationOrder: entry.activationOrder,
    configuration: entry.configuration,
    health: entry.status === 'enabled' ? 'healthy' : 'disabled',
    blockReasons: Object.freeze([]),
    dependencies: Object.freeze([]),
    providedServices: Object.freeze([]),
    requiredServices: Object.freeze([]),
    providerSelections: Object.freeze([]),
    contracts: manifest?.contracts,
    configurationValues: entry.configuration,
    providerOverrides: Object.freeze({ ...entry.providerOverrides }),
    contractConflicts: Object.freeze([]),
    docs: manifest?.docs,
    resources: manifest?.resources,
    examples: manifest?.examples,
    appServices: manifest?.appServices,
    appServicesSnippet: manifest?.appServicesSnippet,
    agentGuidance: manifest?.agentGuidance,
    capabilityProviderIds: Object.freeze([
      ...new Set(
        (entry.active?.prepared.activation.capabilityProviders ?? [])
          .map((provider) => provider.id),
      ),
    ].sort()),
    contributedCapabilityPrefixes: Object.freeze([
      ...new Set(manifest?.contributes?.capabilities ?? []),
    ].sort()),
  });
}

function unavailableEntry(
  stored: import('./contracts.js').RuntimeExtensionStoredRecord,
  error: unknown,
): InstalledExtension {
  const message = error instanceof Error && error.message
    ? error.message
    : 'The extension package could not be restored.';
  const code = error instanceof RuntimeExtensionPackageError
    ? error.code
    : 'PACKAGE_UNAVAILABLE';
  return {
    request: freezeRequest(stored.request),
    identity: stored.identity,
    version: stored.version,
    integrity: stored.request.integrity,
    entrypoint: '',
    activationOrder: 0,
    status: 'disabled',
    desiredEnabled: stored.status === 'enabled',
    configuration: stored.configuration ?? {},
    ...(stored.configuration ? { explicitConfiguration: stored.configuration } : {}),
    providerOverrides: normalizeProviderOverrides(stored.providerOverrides),
    contractBindings: normalizeProviderOverrides(stored.contractBindings),
    activationFailure: {
      code,
      message: `Extension package is unavailable: ${message}`,
    },
  };
}

type StoredLifecycleRecord = import('./contracts.js').RuntimeExtensionStoredRecord & {
  readonly providerOverrides?: Readonly<Record<string, string>>;
};

function normalizeProviderOverrides(value: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([service, provider]) =>
      Boolean(service) && typeof provider === 'string'),
  );
}

function arrayField(manifest: Record<string, unknown>, ...keys: string[]): readonly unknown[] {
  for (const key of keys) {
    const value = manifest[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      for (const nested of keys.includes('dependencies') ? ['extensions', 'items'] : ['services', 'items']) {
        if (Array.isArray(object[nested])) return object[nested] as readonly unknown[];
      }
    }
  }
  return [];
}

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] : undefined;
}

function dependencyIdentity(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.identity === 'string' ? item.identity : typeof item.id === 'string' ? item.id : undefined;
}

function serviceIdentity(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.service === 'string' ? item.service
    : typeof item.id === 'string' ? item.id
    : typeof item.contract === 'string' ? item.contract : undefined;
}

function dependencyProvider(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const provider = (value as Record<string, unknown>).provider;
  return typeof provider === 'string' && provider ? provider : undefined;
}

function serviceSelections(
  installed: ReadonlyMap<string, InstalledExtension>,
  services: readonly string[],
  owner: InstalledExtension,
  overrides: Readonly<Record<string, string>>,
  registry: RuntimeCompositionRegistry,
  requirements: readonly unknown[],
): RuntimeExtensionProviderSelection[] {
  const registryOverrides = registry.snapshot().overrides;
  return services.flatMap((service) => {
    const requirement = requirements.find((candidate) => serviceIdentity(candidate) === service);
    const explicitProvider = dependencyProvider(requirement);
    const selectedProviderBinding = explicitProvider
      ? installed.get(explicitProvider)?.contractBindings[service]
      : owner.contractBindings[service];
    const effectiveService = selectedProviderBinding ?? service;
    const inspection = registry.list().find(({ service: descriptor }) => descriptor.key === effectiveService);
    const alternatives = inspection
      ? inspection.providers
        .filter(({ status }) => status !== 'incompatible' && status !== 'collision')
        .map(({ provider }) => provider.id)
      : [...installed.entries()]
      .filter(([, entry]) => entry.status === 'enabled' && entry.loaded !== undefined
        && arrayField(entry.loaded?.metadata.manifest as unknown as Record<string, unknown>, 'providedServices', 'provides')
          .some((provided) => serviceIdentity(provided) === service))
      .map(([identity]) => identity)
      .sort();
    const override = registryOverrides[effectiveService] ?? overrides[effectiveService];
    const selected = explicitProvider && alternatives.includes(explicitProvider)
      ? explicitProvider
      : override && alternatives.includes(override)
        ? override
        : inspection?.selectedProviderId && alternatives.includes(inspection.selectedProviderId)
          ? inspection.selectedProviderId
          : alternatives.length ? alternatives[alternatives.length - 1] : undefined;
    return [{
      service: effectiveService,
      alternatives: Object.freeze(alternatives),
      ...(override ? { override } : {}),
      ...(selected ? { selected } : {}),
      ...(alternatives.length > 1 ? { collision: true } : {}),
    }];
  });
}

function incompatibleContractMessage(
  service: string,
  owners: readonly string[],
  difference: string,
): string {
  const ownerText = owners.length > 0 ? owners.join(', ') : 'the existing provider';
  return `Service "${service}" has an incompatible contract (${difference}). `
    + `Conflicting owners: ${ownerText}. Do not rewrite third-party sources; use an explicitly `
    + `namespaced service id and rebind editable sources to that id.`;
}

function dependencyVersion(value: unknown): string | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).version as string | undefined
    : undefined;
}

function matchesVersion(actual: string, expected: string | undefined): boolean {
  return expected === undefined || actual === expected;
}

function freezeRequest(request: RuntimeExtensionInstallRequest): RuntimeExtensionInstallRequest {
  return Object.freeze({
    packageRoot: request.packageRoot,
    integrity: Object.freeze({ ...request.integrity }),
  });
}

async function cleanupActivation(activation: RuntimeExtensionActivation): Promise<void> {
  await activation.dispose?.();
}

function assertNotCancelled(signal: RuntimeAbortSignal | undefined): void {
  if (signal?.aborted) throw new RuntimeExtensionError('CANCELLED');
}

function mapRegistrationError(
  error: unknown,
  signal: RuntimeAbortSignal | undefined,
): RuntimeExtensionError {
  return signal?.aborted
    ? new RuntimeExtensionError('CANCELLED', error)
    : new RuntimeExtensionError('REGISTRATION_FAILED', error);
}

function isDependencyBlockReason(reason: RuntimeExtensionBlockReason): boolean {
  return reason.code === 'MISSING_DEPENDENCY'
    || reason.code === 'DISABLED_DEPENDENCY'
    || reason.code === 'MISSING_SERVICE_DEPENDENCY'
    || reason.code === 'VERSION_MISMATCH';
}

function formatErrorCause(cause: unknown): string {
  const message = errorCauseMessage(cause);
  return message ? ` Cause: ${message}` : '';
}

function errorCauseMessage(cause: unknown, seen = new Set<unknown>()): string | undefined {
  if (!(cause instanceof Error) || seen.has(cause)) return undefined;
  seen.add(cause);
  if (cause instanceof AggregateError) {
    const messages = cause.errors
      .map((error) => errorCauseMessage(error, seen))
      .filter((message): message is string => Boolean(message));
    if (messages.length > 0) return messages.join(' | ').slice(0, 1_000);
  }
  if (cause.cause !== undefined) {
    const nested = errorCauseMessage(cause.cause, seen);
    if (nested) return nested.slice(0, 1_000);
  }
  return cause.message ? cause.message.slice(0, 1_000) : undefined;
}

function underlyingErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.cause instanceof Error && error.cause.message) {
    return underlyingErrorMessage(error.cause) ?? error.cause.message;
  }
  return error.message || undefined;
}

function compareUiPlacementRegistrations(
  left: RuntimeExtensionUiPlacementRegistration,
  right: RuntimeExtensionUiPlacementRegistration,
): number {
  return left.placementId.localeCompare(right.placementId)
    || left.extensionId.localeCompare(right.extensionId)
    || left.applicationId.localeCompare(right.applicationId);
}

const runtimeExtensionLifecycleAssignable: RuntimeExtensionLifecycleService =
  null as unknown as RuntimeExtensionManager;
void runtimeExtensionLifecycleAssignable;
