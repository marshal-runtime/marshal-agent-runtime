import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRuntimeCodeIntelligenceBundle,
  createRuntimeCodeIntelligenceProviders,
  RUNTIME_CODE_INTELLIGENCE_SERVICE,
  type RuntimeCodeIntelligenceBundle,
} from '@marshal/agent-runtime-code-intelligence/runtime-service';
import {
  createRuntimeKernel,
  INLINE_MODULE_EXECUTOR_CAPABILITY,
  MODULE_EXECUTOR_CAPABILITY,
  requireRuntimeCatalogId,
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityProvider,
  type Disposable,
  type InvocationContext,
  type PermissionBroker,
  type PermissionCheck,
  type PermissionDecision,
  type RuntimeBackgroundJobHandler,
  type RuntimeCatalogProvider,
  type RuntimeCatalogEntry,
  type RuntimeExecRequest,
  type RuntimePrincipal,
  type RuntimeHarnessIdentity,
  type RuntimeSearchRequest as CoreRuntimeSearchRequest,
  createRuntimeEventSubscription,
  restoredInvocationMetadata,
  type RuntimeDurableEventConsumerOptions,
  type RuntimeEventSubscription,
  type RuntimeLifecycleEventMap,
} from '@marshal/agent-runtime-core';
import {
  BackgroundJobManager,
  BoundedFileJobStore,
} from '@marshal/agent-runtime-effects';
import {
  createDefaultDenyPermissionBroker,
  type DefaultDenyPermissionBrokerOptions,
} from '@marshal/agent-runtime-permissions';
import {
  getRuntimeServiceContainer,
  RuntimeCompositionRegistry,
  RUNTIME_EVENT_BUS_SERVICE,
  RUNTIME_EVENT_CHECKPOINT_STORE_SERVICE,
  RUNTIME_EVENT_JOURNAL_SERVICE,
  RUNTIME_EVENT_PUBLISHER,
  RUNTIME_EVENT_PUBLISHER_SERVICE,
  createRuntimeEventBindings,
  type RuntimeCompositionProviderRegistration,
  type RuntimeCompositionRegistrySnapshot,
} from '@marshal/agent-runtime-composer';
import {
  createNodeBuiltinModuleMap,
  RUNTIME_EXTENSION_CATALOG_SERVICE,
  RUNTIME_EXTENSION_CATALOG_SOURCE,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  RUNTIME_EXTENSION_STATUS_SERVICE,
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  JsonFileRuntimeExtensionStateStore,
  LocalRuntimeExtensionPackageLoader,
  RuntimeExtensionCatalog,
  RuntimeExtensionManager,
  RuntimeExtensionUiPublicationRegistry,
  type RuntimeExtensionCatalogEntry,
  type RuntimeExtensionCatalogService,
  type RuntimeExtensionLifecycleService,
} from '@marshal/agent-runtime-extensions';
import { appServicePublicNames } from '@marshal/agent-runtime-typescript';
import {
  TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY,
  TRUSTED_MODULE_EXECUTOR_CAPABILITY,
} from './inlineProvider.js';
import { BoundedFileRuntimeReceiptStore } from './receiptStore.js';
import {
  createRuntimeLifecycleAuthority,
  createRuntimeResourceCatalogProvider,
  createRuntimeHostMaterializer,
  resolveRuntimeExtensionDiscoveryRoot,
  type RuntimeHostExtensionsOptions,
} from './nativeExtensions.js';
import {
  createRuntimeNativeExtensionDiscoveryCatalogSource,
  createRuntimeNativeExtensionDiscoveryService,
  type RuntimeNativeExtensionDiscoveryService,
} from './nativeExtensionDiscovery.js';
import {
  createRuntimeNativeExtensionStatusService,
  type RuntimeNativeExtensionStatusController,
} from './nativeExtensionStatus.js';
import {
  createRuntimeCompositionCatalogProvider,
  createRuntimeCompositionResourcePort,
  toRuntimeCompositionSnapshot,
} from './compositionCatalog.js';
import {
  isContained,
  resolveProtectedLifecycleResultRoot,
  resolveRuntimeState,
  resolveWorktreeRoot,
} from './state.js';
import {
  createRuntimeHostContextService,
  RUNTIME_HOST_CONTEXT_SERVICE,
} from './hostContext.js';
import type {
  AgentRuntimeBindings,
  AgentRuntimeHostOptions,
  JsonObject,
  RuntimeCallContext,
  RuntimeExecutionRequest,
  RuntimeHostFactoryContext,
  RuntimeHostProviderBundle,
  RuntimeExtensionHostBindings,
  RuntimeLifecyclePort,
  RuntimeResourceContent,
  RuntimeResourceDescriptor,
  RuntimeResourcePort,
  RuntimeScopedResourcePort,
  RuntimeSearchRequest,
  RuntimeSessionEndRequest,
  RuntimeSessionStartRequest,
  RuntimeTurnObservation,
  RuntimeHostWorkspaceScope,
} from './types.js';

const MAX_SEARCH_RESULTS = 50;
const JOB_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_PRINCIPAL: RuntimePrincipal = { id: 'agent-runtime', kind: 'agent' };
const BASE_PERMISSIONS: readonly string[] = [];
const BASE_TRUSTED_PERMISSIONS = [
  'runtime.inline_module.execute.trusted',
  'runtime.module.execute.trusted',
] as const;
const BASE_BOUNDED_AGENTIC_PERMISSIONS = [
  'runtime.delegation.spawn',
  'runtime.delegation.continue',
  'runtime.delegation.wait',
  'runtime.delegation.cancel',
] as const;
const BASE_ADAPTIVE_AGENTIC_PERMISSIONS = ['trusted_ui'] as const;
const ACTIVE_PERMISSION_GRANT = Symbol('marshal.runtime.activePermissionGrant');
const ACTIVE_PERMISSION_GRANT_TTL_MS = 60_000;

/** Compose the portable runtime without assuming any particular agent harness. */
export async function createAgentRuntime(
  options: AgentRuntimeHostOptions = {},
): Promise<AgentRuntimeBindings> {
  const serviceContainer = options.serviceContainer ?? getRuntimeServiceContainer();
  const compositionRegistry =
    options.compositionRegistry ?? new RuntimeCompositionRegistry({ container: serviceContainer });
  const state = await resolveRuntimeState(
    options.workspacePath,
    options.stateDirectory,
    options.trustedProjectId,
  );
  const extensions = await resolveHostExtensions(options.extensions);
  const fallbackSessionId = `runtime-${randomUUID()}`;
  const worktreeRoot = await resolveWorktreeRoot(
    state.workspacePath,
    state.workspaceId,
    options.worktreeRoot,
  );
  const protectedLifecycleRoot = await resolveProtectedLifecycleResultRoot(
    state.workspacePath,
    options.protectedLifecycleResultRoot,
  );
  const principal = normalizePrincipal(options.principal);
  const identity = normalizeIdentity(options.identity, principal);
  const permissionProfile = readPermissionProfile(options.permissionProfile);
  const importPolicy = resolveImportPolicy(options.importPolicy, permissionProfile);
  const permissions = createPermissionOptions(
    state.workspaceId,
    principal.id,
    permissionProfile,
    options.permissionPatterns,
    options.trustedPermissionPatterns,
    options.permissionApproval,
    options.resolvePermissionGrants,
  );
  const activePermissionBroker = withActivePermissionGrants(
    options.permissionBroker
      ?? createDefaultDenyPermissionBroker(
        permissions as DefaultDenyPermissionBrokerOptions,
      ),
  );
  let activeKernel: ReturnType<typeof createRuntimeKernel> | undefined;
  const bundles: RuntimeHostProviderBundle[] = [];
  const registrations: Disposable[] = [];
  const eventRegistrations: import('@marshal/agent-runtime-composer').RuntimeServiceBindingHandle[] = [];
  const extensionHandles: import('@marshal/agent-runtime-composer').RuntimeServiceBindingHandle[] = [];
  const durableEventConsumers = new Set<RuntimeEventSubscription>();
  let hostDisposed = false;
  let extensionManager: RuntimeExtensionManager | undefined;
  let extensionDiscovery: RuntimeNativeExtensionDiscoveryService | undefined;
  let extensionStatus: RuntimeNativeExtensionStatusController | undefined;
  let defaultIntelligence: RuntimeCodeIntelligenceBundle | undefined;
  let jobRecoveryTimer: NodeJS.Timeout | undefined;
  let jobRecoveryInFlight: Promise<readonly string[]> | undefined;
  const jobs = new BackgroundJobManager({
    store: new BoundedFileJobStore({ rootDirectory: path.join(protectedLifecycleRoot, 'jobs') }),
  });
  const stagedJobHandlers: RuntimeBackgroundJobHandler[] = [];
  const constructionJobs = createConstructionJobManager(jobs, stagedJobHandlers);
  const factoryContext: RuntimeHostFactoryContext = {
    serviceContainer,
    compositionRegistry,
    workspacePath: state.workspacePath,
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    stateRoot: state.stateRoot,
    worktreeRoot,
    protectedLifecycleResultRoot: protectedLifecycleRoot,
    principal,
    identity,
    permissions,
    importPolicy,
    permissionBroker: {
      decide(check) {
        if (!activePermissionBroker) throw new Error('Runtime permission broker is not ready.');
        return activePermissionBroker.decide(check);
      },
    },
    operationInvoker: {
      async search(request, context) {
        if (!activeKernel) throw new Error('Runtime kernel is not ready.');
        return activeKernel.runtimeSearch(normalizeSearchRequest(request), context);
      },
      async invoke(operation, input, context) {
        if (!activeKernel) throw new Error('Runtime kernel is not ready.');
        const requestId = randomUUID();
        const response = await activeKernel.runtimeExec(
          {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            target: operation,
            input,
            requestId,
            approval: context.approval,
          },
          nestedOperationContext(context, requestId),
        );
        if (response.status !== 'success' || !response.result) {
          const error = Object.assign(
            new Error(response.error?.message ?? `Operation ended with ${response.status}.`),
            { code: response.error?.code ?? response.status },
          );
          if (response.status === 'approval_required' && response.approval) {
            Object.assign(error, { approval: response.approval });
          }
          throw error;
        }
        return response.result.output;
      },
      async execute(request, context) {
        if (!activeKernel) throw new Error('Runtime kernel is not ready.');
        if (!context.executionId) {
          throw new Error('Nested runtime execution requires a parent execution identity.');
        }
        const normalized = normalizeExecutionRequest(request);
        const requestedRequestId = normalized.requestId;
        const requestId = randomUUID();
        const childContext = nestedOperationContext(
          requestedRequestId
            ? {
                ...context,
                metadata: {
                  ...(context.metadata ?? {}),
                  requestedRequestId,
                },
              }
            : context,
          requestId,
        );
        return activeKernel.runtimeExec(
          {
            ...normalized,
            requestId,
            approval:
              request.approval === undefined
                ? context.approval
                : normalized.approval,
          },
          childContext,
        );
      },
    },
    jobManager: constructionJobs.manager,
  };

  try {
    extensionHandles.push(await compositionRegistry.registerProvider({
      provider: {
        id: 'runtime.host.context',
        service: RUNTIME_HOST_CONTEXT_SERVICE,
        contract: RUNTIME_HOST_CONTEXT_SERVICE.contract,
      },
      binding: {
        useValue: createRuntimeHostContextService({
          workspacePath: state.workspacePath,
          workspaceId: state.workspaceId,
          projectId: state.projectId,
          stateRoot: state.stateRoot,
          worktreeRoot,
          protectedLifecycleResultRoot: protectedLifecycleRoot,
          principal,
          identity,
        }),
      },
    }));
    if (options.codeIntelligence !== false) {
      defaultIntelligence = createRuntimeCodeIntelligenceBundle({
        ...(options.codeIntelligence ?? {}),
        runtimePackageRoots: [
          path.dirname(path.dirname(fileURLToPath(import.meta.url))),
        ],
        workspacePath: state.workspacePath,
        workspaceId: state.workspaceId,
        projectId: state.projectId,
        stateRoot: state.stateRoot,
        protectedLifecycleResultRoot: protectedLifecycleRoot,
        principal,
        identity,
        services: serviceContainer,
      });
      extensionHandles.push(await compositionRegistry.registerProvider({
        provider: {
          id: 'runtime.quillstone.default',
          service: RUNTIME_CODE_INTELLIGENCE_SERVICE,
          contract: RUNTIME_CODE_INTELLIGENCE_SERVICE.contract,
        },
        binding: { useValue: defaultIntelligence.service },
      }));
      bundles.push({
        providers: [],
        dispose: () => defaultIntelligence?.dispose(),
      });
    }
    for (const source of options.providerSources ?? []) {
      bundles.push(normalizeBundle(await source(factoryContext)));
    }
    if (defaultIntelligence) {
      const sourceProviderIds = new Set(
        bundles.flatMap((bundle) => [...bundle.providers]).map((provider) => provider.id),
      );
      bundles.unshift({
        providers: createRuntimeCodeIntelligenceProviders({
          services: serviceContainer,
          excludedProviderIds: sourceProviderIds,
        }),
      });
    }
    for (const source of bundles.flatMap((bundle) => [...(bundle.catalogSources ?? [])])) {
      extensionHandles.push(await serviceContainer.bindMany(RUNTIME_EXTENSION_CATALOG_SOURCE, {
        useValue: source,
        ...(source.order === undefined ? {} : { order: source.order }),
      }));
    }
    constructionJobs.closeRegistration();
    const jobHandlers = [
      ...stagedJobHandlers,
      ...(options.jobHandlers ?? []),
      ...bundles.flatMap((bundle) => [...(bundle.jobHandlers ?? [])]),
    ];
    assertUniqueJobHandlerKinds(jobHandlers);
    jobs.registerHandlers(jobHandlers);
    const lifecycleDelegates = bundles
      .map((bundle) => bundle.lifecycle)
      .filter((lifecycle): lifecycle is RuntimeLifecyclePort => lifecycle !== undefined);
    const lifecycle = createRuntimeLifecycleAuthority(
      state.stateRoot,
      lifecycleDelegates,
      protectedLifecycleRoot,
    );
    const recoveredJobContext = (
      record: import('@marshal/agent-runtime-core').RuntimeBackgroundJobRecord,
    ): InvocationContext => ({
      principal: {
        id: record.principalId,
        kind: typeof record.metadata?.principalKind === 'string'
          ? record.metadata.principalKind
          : 'agent',
      },
      identity: {
        harnessId: typeof record.metadata?.harnessId === 'string'
          ? record.metadata.harnessId
          : 'recovered-runtime',
        agentId: record.agentId,
      },
      scope: record.scope,
      metadata: {
        ...restoredInvocationMetadata(record.metadata),
        recoveredJobId: record.handle.jobId,
      },
    });
    const recoverJobs = (kinds?: readonly string[]) => {
      if (kinds) return jobs.recoverAll(recoveredJobContext, kinds);
      if (jobRecoveryInFlight) return jobRecoveryInFlight;
      let tracked!: Promise<readonly string[]>;
      tracked = jobs.recoverAll(recoveredJobContext).finally(() => {
        if (jobRecoveryInFlight === tracked) jobRecoveryInFlight = undefined;
      });
      jobRecoveryInFlight = tracked;
      return tracked;
    };
    const requireActiveExtensionHost = () => {
      if (hostDisposed) throw new Error('Runtime host is disposed.');
    };
    const extensionJobManager: RuntimeExtensionHostBindings['jobManager'] = Object.freeze({
      enqueue: (
        request: Parameters<RuntimeExtensionHostBindings['jobManager']['enqueue']>[0],
        context: Parameters<RuntimeExtensionHostBindings['jobManager']['enqueue']>[1],
      ) => {
        requireActiveExtensionHost();
        return jobs.enqueue(request, context);
      },
      start: (
        request: Parameters<RuntimeExtensionHostBindings['jobManager']['start']>[0],
        context: Parameters<RuntimeExtensionHostBindings['jobManager']['start']>[1],
      ) => {
        requireActiveExtensionHost();
        return jobs.start(request, context);
      },
      reserveHandlers: (
        handlers: Parameters<RuntimeExtensionHostBindings['jobManager']['reserveHandlers']>[0],
      ) => {
        requireActiveExtensionHost();
        return jobs.reserveHandlers(handlers);
      },
    });
    const extensionHost: RuntimeExtensionHostBindings = Object.freeze({
      jobManager: extensionJobManager,
      registerLifecycle: (
        delegate: Parameters<RuntimeExtensionHostBindings['registerLifecycle']>[0],
      ) => {
        requireActiveExtensionHost();
        return lifecycle.register(delegate);
      },
      recoverJobHandlers: (
        kinds: Parameters<RuntimeExtensionHostBindings['recoverJobHandlers']>[0],
      ) => {
        requireActiveExtensionHost();
        return recoverJobs(kinds);
      },
    });

    const receipts = new BoundedFileRuntimeReceiptStore({
      filePath: path.join(state.stateRoot, 'receipts', 'executions.jsonl'),
      maxEntries: options.receiptMaxEntries,
      maxEntryBytes: options.receiptMaxEntryBytes,
    });
    const eventBindings = await createRuntimeEventBindings({
      journalPath: path.join(state.stateRoot, 'events', 'journal.jsonl'),
      checkpointPath: path.join(state.stateRoot, 'events', 'checkpoints.json'),
      streamId: 'runtime.lifecycle',
    });
    const registerDurableEventConsumer = (
      options: RuntimeDurableEventConsumerOptions<RuntimeLifecycleEventMap>,
    ): RuntimeEventSubscription => {
      if (hostDisposed) throw new Error('Runtime host is disposed.');
      const subscription = createRuntimeEventSubscription({
        journal: eventBindings.journal.useValue!,
        checkpoints: eventBindings.checkpointStore.useValue!,
        bus: eventBindings.eventBus.useValue!,
        streamId: 'runtime.lifecycle',
        ...options,
      });
      durableEventConsumers.add(subscription);
      return subscription;
    };
    const registerEventProvider = async <T>(
      registration: RuntimeCompositionProviderRegistration<T>,
    ): Promise<void> => {
      eventRegistrations.push(await compositionRegistry.registerProvider(registration));
    };
    await registerEventProvider({
      provider: {
        id: 'runtime.host.events.publisher',
        service: RUNTIME_EVENT_PUBLISHER_SERVICE,
        contract: RUNTIME_EVENT_PUBLISHER_SERVICE.contract,
      },
      binding: eventBindings.publisher,
    });
    await registerEventProvider({
      provider: {
        id: 'runtime.host.events.journal',
        service: RUNTIME_EVENT_JOURNAL_SERVICE,
        contract: RUNTIME_EVENT_JOURNAL_SERVICE.contract,
      },
      binding: eventBindings.journal,
    });
    await registerEventProvider({
      provider: {
        id: 'runtime.host.events.checkpoint-store',
        service: RUNTIME_EVENT_CHECKPOINT_STORE_SERVICE,
        contract: RUNTIME_EVENT_CHECKPOINT_STORE_SERVICE.contract,
      },
      binding: eventBindings.checkpointStore,
    });
    await registerEventProvider({
      provider: {
        id: 'runtime.host.events.bus',
        service: RUNTIME_EVENT_BUS_SERVICE,
        contract: RUNTIME_EVENT_BUS_SERVICE.contract,
      },
      binding: eventBindings.eventBus,
    });
    const resourcePorts = bundles
      .map((bundle) => bundle.resources)
      .filter((resource): resource is RuntimeScopedResourcePort => resource !== undefined);
    const compositionSource = () => toRuntimeCompositionSnapshot(compositionRegistry.snapshot());
    const liveExtensionResources: RuntimeScopedResourcePort | undefined = extensions
      ? {
          async listResources(context) {
            return await extensionManager?.resources.listResources(context) ?? [];
          },
          async readResource(uri, context) {
            if (!extensionManager) {
              throw new Error(`Runtime extension resource not found: ${uri}`);
            }
            return await extensionManager.resources.readResource(uri, context);
          },
        }
      : undefined;
    const resourcePort = composeScopedResourcePorts([
      ...resourcePorts,
      createRuntimeCompositionResourcePort(compositionSource),
      ...(extensions
        ? [
            createRuntimeExtensionResourcePort(serviceContainer, compositionRegistry),
            liveExtensionResources!,
          ]
        : []),
    ]);
    let extensionCatalog: RuntimeExtensionCatalogService | undefined;
    const deferredExtensionCatalog = createRuntimeExtensionCatalogProvider(
      serviceContainer,
      compositionRegistry,
    );
    const catalogProviders = [
      ...bundles
        .map((bundle) => bundle.catalog)
        .filter((catalog): catalog is NonNullable<RuntimeHostProviderBundle['catalog']> =>
          catalog !== undefined),
      ...(resourcePort ? [createRuntimeResourceCatalogProvider(resourcePort)] : []),
      createRuntimeCompositionCatalogProvider(compositionSource),
      ...(extensions ? [deferredExtensionCatalog] : []),
    ];
    const kernel = createRuntimeKernel({
      permissionBroker: activePermissionBroker,
      receiptSink: receipts,
      catalogProviders,
      lifecycle: {
        publish(event) {
          return serviceContainer.get(RUNTIME_EVENT_PUBLISHER).publish(event);
        },
      },
    });
    activeKernel = kernel;
    if (extensions) {
      const discoveryRoots = extensions.discoveryRoots ?? extensions.allowedRoots;
      extensionDiscovery = await createRuntimeNativeExtensionDiscoveryService({
        roots: discoveryRoots,
      });
      const materializer = await createRuntimeHostMaterializer({
        allowedRoots: await resolveExtensionMaterializerRoots(
          extensions.allowedRoots,
          discoveryRoots,
        ),
        installation: extensions.installation,
      });
      const nativeSource = createRuntimeNativeExtensionDiscoveryCatalogSource(
        extensionDiscovery,
      );
      const publication = serviceContainer.tryGet(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE)
        ?? new RuntimeExtensionUiPublicationRegistry(extensions.uiPlacements ?? []);
      const manager = new RuntimeExtensionManager({
        kernel,
        services: serviceContainer,
        compositionRegistry,
        loader: new LocalRuntimeExtensionPackageLoader({
          allowedRoots: materializer.allowedRoots,
          modules: createNodeBuiltinModuleMap(extensions.modules),
        }),
        stateStore: new JsonFileRuntimeExtensionStateStore(
          path.join(state.stateRoot, 'extensions', 'state.json'),
        ),
        activationContext: fixedInvocationContext(
          {}, state.workspacePath, state.workspaceId, state.projectId,
          fallbackSessionId, principal, identity,
        ),
        uiPlacementDefinitions: extensions.uiPlacements,
        uiPlacementsRequired: extensions.uiPlacementsRequired,
        registerDurableEventConsumer,
        ...extensionHost,
      });
      extensionManager = manager;
      const configuredLifecycle = serviceContainer.tryGet<RuntimeExtensionLifecycleService>(
        RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
      ) ?? manager;
      extensionStatus = await createRuntimeNativeExtensionStatusService({
        discovery: extensionDiscovery,
        lifecycle: configuredLifecycle,
        materializer,
        installation: extensions.installation,
      });
      if (serviceContainer.tryGet(RUNTIME_EXTENSION_STATUS_SERVICE)) {
        throw new Error('Runtime extension status service is already configured.');
      }
      extensionHandles.push(await serviceContainer.bind(
        RUNTIME_EXTENSION_STATUS_SERVICE,
        { useValue: extensionStatus },
      ));
      if (configuredLifecycle === manager) {
        extensionHandles.push(await serviceContainer.bind(
          RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
          { useValue: extensionStatus.lifecycle },
        ));
      } else {
        extensionHandles.push(await serviceContainer.decorate(
          RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
          () => extensionStatus!.lifecycle,
        ));
      }
      const catalogSources = [...serviceContainer.getAll(RUNTIME_EXTENSION_CATALOG_SOURCE), nativeSource];
      extensionCatalog = serviceContainer.tryGet<RuntimeExtensionCatalogService>(RUNTIME_EXTENSION_CATALOG_SERVICE)
        ?? new RuntimeExtensionCatalog({
          services: serviceContainer,
          lifecycle: extensionStatus.lifecycle,
          sources: catalogSources,
          projectInstalledEntry: (entry) => ({
            ...entry,
            ...(entry.appServicesSnippet === undefined
              ? {}
              : { originalAppServicesSnippet: entry.appServicesSnippet }),
            appServicesSnippet: createCurrentExtensionAppServicesSnippet(
              entry,
              compositionRegistry.snapshot(),
            ),
          }),
        });
      if (!serviceContainer.tryGet(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE)) {
        extensionHandles.push(await serviceContainer.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, { useValue: publication }));
      }
      if (!serviceContainer.tryGet<RuntimeExtensionCatalogService>(RUNTIME_EXTENSION_CATALOG_SERVICE)) {
        extensionHandles.push(await serviceContainer.bind(RUNTIME_EXTENSION_CATALOG_SERVICE, { useValue: extensionCatalog }));
      }
      extensionHandles.push(await serviceContainer.bindMany(RUNTIME_EXTENSION_CATALOG_SOURCE, { useValue: nativeSource }));
      if (extensions.restore !== false) {
        await serviceContainer.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE).restore();
      }
    }
    defaultIntelligence?.start();

    const providers = bundles.flatMap((bundle) => [...bundle.providers]);
    for (const provider of providers) registrations.push(kernel.register(provider));
    const startupContext = fixedInvocationContext(
      {},
      state.workspacePath,
      state.workspaceId,
      state.projectId,
      fallbackSessionId,
      principal,
      identity,
    );
    await kernel.list(startupContext);
    if (resourcePort) {
      const startupResources = await resourcePort.listResources(startupContext);
      assertUniqueResourceIdentities(
        startupResources.map((resource) => resource.uri),
        'resource URI',
      );
      const startupTools = await resourcePort.listRenderTools?.(startupContext) ?? [];
      assertUniqueResourceIdentities(
        startupTools.map((tool) => tool.name),
        'render tool name',
      );
    }
    await kernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: '', limit: 0 },
      startupContext,
    );
    await recoverJobs();
    jobRecoveryTimer = setInterval(() => {
      void recoverJobs().catch(() => undefined);
    }, JOB_RECOVERY_INTERVAL_MS);
    jobRecoveryTimer.unref?.();

    const resources = resourcePort
      ? createScopeSafeResources(
          resourcePort,
          state.workspacePath,
          state.workspaceId,
          state.projectId,
          fallbackSessionId,
          principal,
          identity,
          options.resolveWorkspace,
        )
      : undefined;
    const boundKernel = createKernelPort(
      kernel,
      state.workspacePath,
      state.workspaceId,
      state.projectId,
      fallbackSessionId,
      principal,
      identity,
      options.resolveWorkspace,
    );
    const boundLifecycle = options.resolveWorkspace
      ? createWorkspaceScopedLifecycle(lifecycle, options.resolveWorkspace)
      : lifecycle;

    let disposeOperation: Promise<void> | undefined;
    return {
      serviceContainer,
      compositionRegistry,
      kernel: boundKernel,
      lifecycle: boundLifecycle,
      extensionHost,
      ...(extensionDiscovery ? { extensionDiscovery } : {}),
      ...(extensionStatus ? { extensionStatus } : {}),
      ...(resources ? { resources } : {}),
      core: kernel,
      stateRoot: state.stateRoot,
      workspacePath: state.workspacePath,
      workspaceId: state.workspaceId,
      projectId: state.projectId,
      identity,
      receipts,
      worktreeRoot,
      providers,
      registrations,
      registerDurableEventConsumer,
      dispose(options = {}) {
        const drainBackgroundJobs = options.drainBackgroundJobs === true;
        if (disposeOperation) {
          if (!drainBackgroundJobs) void jobs.shutdown();
          return disposeOperation;
        }
        hostDisposed = true;
        disposeOperation = (async () => {
          const failures = await cleanupHostResources({
            jobRecoveryTimer,
            drainBackgroundJobs,
            jobs,
            kernel,
            registrations,
            durableEventConsumers: [...durableEventConsumers],
            eventRegistrations,
            extensionManager,
            extensionDiscovery,
            extensionStatus,
            extensionHandles,
            bundles,
          });
          if (failures.length > 0) throw new AggregateError(failures, 'Runtime host disposal failed.');
        })();
        return disposeOperation;
      },
    };
  } catch (error) {
    const failures = await cleanupHostResources({
      jobRecoveryTimer,
      drainBackgroundJobs: false,
      jobs,
      kernel: activeKernel,
      registrations,
      durableEventConsumers: [...durableEventConsumers],
      eventRegistrations,
      extensionManager,
      extensionDiscovery,
      extensionStatus,
      extensionHandles,
      bundles,
      closeRegistration: () => constructionJobs.closeRegistration(),
    });
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], 'Runtime host startup failed.');
    }
    throw error;
  }
}

async function resolveHostExtensions(
  configured: AgentRuntimeHostOptions['extensions'],
): Promise<false | RuntimeHostExtensionsOptions> {
  if (configured === false) return false;
  if (configured) return configured;
  const root = resolveRuntimeExtensionDiscoveryRoot();
  try {
    let stat;
    try {
      stat = await lstat(root);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      try {
        await mkdir(root);
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      stat = await lstat(root);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Runtime default extension root must be a real directory.');
    }
    return { allowedRoots: [root], discoveryRoots: [root] };
  } catch (error) {
    throw new Error('Runtime default extension root must be available as a real directory.', {
      cause: error,
    });
  }
}

async function resolveExtensionMaterializerRoots(
  allowedRoots: readonly string[],
  discoveryRoots: readonly string[],
): Promise<readonly string[]> {
  const allowed = await createRuntimeHostMaterializer({ allowedRoots });
  const roots = [...allowed.allowedRoots];
  for (const discoveryRoot of discoveryRoots) {
    let stat;
    try {
      stat = await lstat(discoveryRoot);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const resolved = path.resolve(discoveryRoot);
      if (!allowed.allowedRoots.some((root) => isContained(root, resolved))) {
        throw new Error(
          'A missing runtime extension discovery root must be inside an existing allowed root.',
        );
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Runtime native extension roots must be real directories.');
    }
    const discovered = await createRuntimeHostMaterializer({
      allowedRoots: [discoveryRoot],
    });
    roots.push(...discovered.allowedRoots);
  }
  return roots;
}

function isMissingPath(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && Reflect.get(error, 'code') === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && Reflect.get(error, 'code') === 'EEXIST';
}

async function cleanupHostResources(input: {
  readonly jobRecoveryTimer?: NodeJS.Timeout;
  readonly drainBackgroundJobs: boolean;
  readonly jobs: BackgroundJobManager;
  readonly kernel?: ReturnType<typeof createRuntimeKernel>;
  readonly registrations: readonly Disposable[];
  readonly durableEventConsumers: readonly RuntimeEventSubscription[];
  readonly eventRegistrations: readonly import('@marshal/agent-runtime-composer').RuntimeServiceBindingHandle[];
  readonly extensionManager?: RuntimeExtensionManager;
  readonly extensionDiscovery?: RuntimeNativeExtensionDiscoveryService;
  readonly extensionStatus?: RuntimeNativeExtensionStatusController;
  readonly extensionHandles: readonly import('@marshal/agent-runtime-composer').RuntimeServiceBindingHandle[];
  readonly bundles: readonly RuntimeHostProviderBundle[];
  readonly closeRegistration?: () => void;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  const attempts: Array<() => void | Promise<void>> = [
    () => input.closeRegistration?.(),
    () => { if (input.jobRecoveryTimer) clearInterval(input.jobRecoveryTimer); },
    () => input.drainBackgroundJobs ? input.jobs.shutdown({ drain: true }) : undefined,
    ...[...input.registrations].reverse().map((registration) => () => registration.dispose()),
    () => input.extensionStatus?.dispose(),
    () => input.extensionDiscovery?.dispose(),
    () => input.extensionManager?.dispose(),
    () => input.kernel?.drainLifecycleEmissions(),
    ...[...input.durableEventConsumers].reverse().map((subscription) => () => subscription.dispose()),
    ...[...input.eventRegistrations].reverse().map((registration) => () => registration.dispose()),
    ...[...input.extensionHandles].reverse().map((handle) => () => handle.dispose()),
    () => input.drainBackgroundJobs ? undefined : input.jobs.shutdown(),
    ...[...input.bundles].reverse().map((bundle) => () => bundle.dispose?.()),
  ];
  for (const attempt of attempts) {
    try { await attempt(); } catch (error) { failures.push(error); }
  }
  return failures;
}

function createKernelPort(
  kernel: ReturnType<typeof createRuntimeKernel>,
  workspacePath: string,
  workspaceId: string,
  projectId: string,
  fallbackSessionId: string,
  principal: RuntimePrincipal,
  identity: RuntimeHarnessIdentity,
  resolveWorkspace: AgentRuntimeHostOptions['resolveWorkspace'],
): AgentRuntimeBindings['kernel'] {
  const resolveContext = (context: RuntimeCallContext | undefined): Promise<InvocationContext> =>
    resolveInvocationContext(
      context ?? {},
      workspacePath,
      workspaceId,
      projectId,
      fallbackSessionId,
      principal,
      identity,
      resolveWorkspace,
    );
  return {
    async search(request, context) {
      return kernel.runtimeSearch(
        normalizeSearchRequest(request),
        await resolveContext(context),
      );
    },
    async execute(request, context) {
      return kernel.runtimeExec(
        normalizeExecutionRequest(request),
        await resolveContext(context),
      );
    },
  };
}

async function resolveInvocationContext(
  context: RuntimeCallContext,
  workspacePath: string,
  workspaceId: string,
  projectId: string,
  fallbackSessionId: string,
  principal: RuntimePrincipal,
  identity: RuntimeHarnessIdentity,
  resolveWorkspace: AgentRuntimeHostOptions['resolveWorkspace'],
): Promise<InvocationContext> {
  const resolved = resolveWorkspace
    ? validateResolvedWorkspaceScope(await resolveWorkspace({ ...context }))
    : { workspacePath, workspaceId, projectId };
  return fixedInvocationContext(
    context,
    resolved.workspacePath,
    resolved.workspaceId,
    resolved.projectId,
    fallbackSessionId,
    principal,
    identity,
  );
}

function validateResolvedWorkspaceScope(
  value: RuntimeHostWorkspaceScope,
): RuntimeHostWorkspaceScope {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Runtime workspace resolver must return a workspace scope.');
  }
  if (typeof value.workspacePath !== 'string' || !path.isAbsolute(value.workspacePath)) {
    throw new TypeError('Runtime workspace resolver must return an absolute workspacePath.');
  }
  const workspaceId = safeOptionalIdentifier(value.workspaceId);
  const projectId = safeOptionalIdentifier(value.projectId);
  if (!workspaceId || !projectId) {
    throw new TypeError('Runtime workspace resolver must return workspaceId and projectId.');
  }
  return {
    workspacePath: path.resolve(value.workspacePath),
    workspaceId,
    projectId,
  };
}

function createWorkspaceScopedLifecycle(
  lifecycle: RuntimeLifecyclePort,
  resolveWorkspace: NonNullable<AgentRuntimeHostOptions['resolveWorkspace']>,
): RuntimeLifecyclePort {
  const normalize = async <
    T extends RuntimeSessionStartRequest | RuntimeTurnObservation | RuntimeSessionEndRequest,
  >(request: T): Promise<T> => {
    const metadata = { ...(request.metadata ?? {}) };
    delete metadata.workspacePath;
    delete metadata.workspaceId;
    delete metadata.projectId;
    const agentId = Reflect.get(request, 'agentId');
    const resolved = validateResolvedWorkspaceScope(await resolveWorkspace({
      sessionId: request.sessionId,
      ...(typeof agentId === 'string' ? { agentId } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    }));
    const normalized = {
      ...request,
      workspacePath: resolved.workspacePath,
      workspaceId: resolved.workspaceId,
      projectId: resolved.projectId,
      metadata: {
        ...metadata,
        workspaceId: resolved.workspaceId,
        projectId: resolved.projectId,
      },
    };
    return normalized;
  };
  return Object.freeze({
    async startSession(request: RuntimeSessionStartRequest) {
      return lifecycle.startSession(await normalize(request));
    },
    async observeTurn(request: RuntimeTurnObservation) {
      return lifecycle.observeTurn(await normalize(request));
    },
    async endSession(request: RuntimeSessionEndRequest) {
      return lifecycle.endSession(await normalize(request));
    },
  });
}

export function projectRuntimeExtensionCatalogEntry(
 entry: RuntimeExtensionCatalogEntry,
 composition: RuntimeCompositionRegistrySnapshot,
): RuntimeCatalogEntry {
 const publicNames = appServicePublicNames(composition.services.map(({ service }) => ({
   name: service.contract.name,
   token: service.key,
   ...(service.publicName === undefined ? {} : { publicName: service.publicName }),
 })));
 const services = composition.services
   .filter((inspection) =>
     inspection.providers.some(({ provider }) =>
       provider.metadata?.extensionIdentity === entry.identity))
   .map((inspection) => ({
     id: inspection.service.key,
     symbolKey: Symbol.keyFor(inspection.service.token),
     publicName: publicNames.get(inspection.service.key),
     contract: inspection.service.contract,
     selectedProvider: inspection.selectedProviderId,
     alternativeProviders: inspection.providers
       .filter(({ provider }) => provider.id !== inspection.selectedProviderId)
       .map(({ provider }) => provider.id),
     providers: inspection.providers.map(({ provider, status, reason }) => ({
       id: provider.id,
       version: provider.metadata?.version ?? provider.contract.version,
       status,
       reason,
       contract: provider.contract,
     })),
   }));
 const originalExamples = entry.examples;
 const examples = Array.isArray(originalExamples)
   ? originalExamples.map((example) =>
     typeof example === 'string' ? `Original vendor example: ${example}` : example)
   : originalExamples;
 const searchable = services.flatMap((service) => [
   service.id,
   service.symbolKey ?? '',
   publicNames.get(service.id) ?? '',
   publicNames.get(service.id) === undefined
     ? ''
     : `Current AppServices getter: AppServices.get${capitalize(publicNames.get(service.id)!)}();`,
   publicNames.get(service.id) === undefined
     ? ''
     : `Current AppServices interface: I${capitalize(publicNames.get(service.id)!)}`,
   service.contract.name,
   service.contract.declaration ?? '',
   `Read current runtime extension interface: runtime-extension:${entry.id}`,
   'marshal:contracts',
   'marshal:app-services',
   'marshal:type-symbols',
   ...service.contract.methods.flatMap((method) => [
     method.name,
     method.input ?? '',
     method.output ?? '',
     method.version ?? '',
     method.description ?? '',
     ...(method.links ?? []),
     ...(method.examples ?? []),
   ]),
   service.selectedProvider ?? '',
   ...service.providers.map((provider) => provider.id),
   ...service.providers.flatMap((provider) => provider.contract.methods.flatMap((method) => [
     method.name,
     method.input ?? '',
     method.output ?? '',
     method.version ?? '',
     method.description ?? '',
     ...(method.links ?? []),
     ...(method.examples ?? []),
   ])),
 ]);
 const projection = {
   identity: entry.identity,
   version: entry.version,
   origin: entry.origin,
   sourceId: entry.sourceId,
   installation: entry.installation,
   health: entry.health,
   providedServices: entry.providedServices,
   providerSelections: entry.providerSelections,
   docs: entry.docs,
   resources: entry.resources,
   examples,
   ...(entry.examples === undefined ? {} : { originalExamples: entry.examples }),
   appServices: entry.appServices,
   extension: {
     ...entry,
     ...(entry.originalAppServicesSnippet === undefined
       ? {}
       : { originalAppServicesSnippet: entry.originalAppServicesSnippet }),
   },
   contracts: entry.contracts ?? services.map((service) => service.contract),
   liveComposition: {
     services,
     contracts: services.map((service) => service.contract),
     selectedProviders: services
       .map((service) => service.selectedProvider)
       .filter((id): id is string => id !== undefined),
     overrides: composition.overrides,
   },
   appServicesSnippet: createExtensionAppServicesSnippet(services, publicNames),
   ...(entry.originalAppServicesSnippet === undefined
     ? {}
     : { originalAppServicesSnippet: entry.originalAppServicesSnippet }),
 };
 return {
   id: `runtime-extension:${entry.id}`,
   kind: 'resource',
   title: entry.title,
   description: `${entry.description} ${searchable.join(' ')}`.trim(),
   tags: [...(entry.tags ?? []), 'extension', entry.origin, 'service', 'contract'],
   action: { type: 'resource_read', uri: `runtime-extension:${entry.id}` },
   metadata: projection,
 };
}

export function createRuntimeExtensionCatalogProvider(
 services: import('@marshal/agent-runtime-composer').RuntimeServiceAccessor,
 compositionRegistry: RuntimeCompositionRegistry,
): RuntimeCatalogProvider {
 return {
   id: 'runtime.extension-catalog',
   list: async (context) => {
     const catalog = services.tryGet<RuntimeExtensionCatalogService>(
       RUNTIME_EXTENSION_CATALOG_SERVICE,
     );
     if (!catalog) return [];
     return (await catalog.discover(context))
       .filter(isEnabledRuntimeExtensionCatalogEntry)
       .map((entry) =>
       projectRuntimeExtensionCatalogEntry(entry, compositionRegistry.snapshot()),
     );
   },
   get: async (id, context) => {
     const catalog = services.tryGet<RuntimeExtensionCatalogService>(
       RUNTIME_EXTENSION_CATALOG_SERVICE,
     );
     if (!catalog) return undefined;
     const entry = (await catalog.discover(context))
       .filter(isEnabledRuntimeExtensionCatalogEntry)
       .find((candidate) => `runtime-extension:${candidate.id}` === id);
     return entry
       ? projectRuntimeExtensionCatalogEntry(entry, compositionRegistry.snapshot())
       : undefined;
   },
 };
}

export function createRuntimeExtensionResourcePort(
services: import('@marshal/agent-runtime-composer').RuntimeServiceAccessor,
compositionRegistry: import('@marshal/agent-runtime-composer').RuntimeCompositionRegistry,
): RuntimeScopedResourcePort {
 return {
   async listResources(context) {
     const catalog = services.tryGet<RuntimeExtensionCatalogService>(
       RUNTIME_EXTENSION_CATALOG_SERVICE,
     );
     if (!catalog) return [];
     const entries = (await catalog.discover(context))
       .filter(isEnabledRuntimeExtensionCatalogEntry);
     return entries.map((entry): RuntimeResourceDescriptor => ({
       uri: `runtime-extension:${entry.id}`,
       name: entry.title,
       description: `Complete runtime extension interface and contract material for ${entry.identity}.`,
       mimeType: 'application/json',
       catalog: {
         owner: { type: 'catalog_provider', id: 'runtime.extension-catalog' },
         metadata: { identity: entry.identity, version: entry.version },
       },
     }));
   },
   async readResource(uri, context): Promise<RuntimeResourceContent> {
     const catalog = services.tryGet<RuntimeExtensionCatalogService>(
       RUNTIME_EXTENSION_CATALOG_SERVICE,
     );
     if (!catalog) {
       throw new Error('Runtime extension catalog service is not available.');
     }
     const entries = (await catalog.discover(context))
       .filter(isEnabledRuntimeExtensionCatalogEntry);
     const entry = entries.find((candidate) => `runtime-extension:${candidate.id}` === uri);
     if (!entry) throw new Error(`Runtime extension resource not found: ${uri}`);
     const projected = projectRuntimeExtensionCatalogEntry(
       entry,
       compositionRegistry.snapshot(),
     );
     return {
       uri,
       mimeType: 'application/json',
       text: JSON.stringify(projected.metadata, null, 2),
     };
   },
 };
}

function isEnabledRuntimeExtensionCatalogEntry(
 entry: RuntimeExtensionCatalogEntry,
): boolean {
 return entry.installation?.status === 'enabled';
}

function serviceRecord(value: unknown): { id?: string } | undefined {
 return value && typeof value === 'object' && !Array.isArray(value)
   ? value as { id?: string }
   : undefined;
}

function createExtensionAppServicesSnippet(
 services: readonly {
   readonly id: string;
   readonly contract: {
     readonly name: string;
     readonly methods?: readonly {
       readonly name: string;
       readonly input?: string;
       readonly output?: string;
     }[];
   };
 }[],
 publicNames: ReadonlyMap<string, string>,
): string {
 const namedServices = services
   .map((service) => ({ service, publicName: publicNames.get(service.id) }))
   .filter((value): value is { service: (typeof services)[number]; publicName: string } =>
     value.publicName !== undefined);
 return [
   `import { AppServices } from 'marshal:app-services';`,
   ...namedServices.map(({ publicName }) =>
     `import type { I${capitalize(publicName)} } from 'marshal:app-services';`),
   '',
   ...namedServices.map(({ service, publicName }) => {
     const methods = (service.contract.methods ?? [])
       .map((method) => `${method.name}(${method.input ?? 'unknown'}): ${method.output ?? 'unknown'}`)
       .join(', ');
     return [
       `// Current runtime service ${publicName}: I${capitalize(publicName)};`,
       `// Methods: ${methods || 'none published'}.`,
       `AppServices.get${capitalize(publicName)}();`,
     ].join('\n');
   }),
 ].join('\n');
}

function createCurrentExtensionAppServicesSnippet(
 entry: RuntimeExtensionCatalogEntry,
 composition: RuntimeCompositionRegistrySnapshot,
): string {
 const publicNames = appServicePublicNames(composition.services.map(({ service }) => ({
   name: service.contract.name,
   token: service.key,
   ...(service.publicName === undefined ? {} : { publicName: service.publicName }),
 })));
 const services = composition.services
   .filter((inspection) =>
     inspection.providers.some(({ provider }) =>
       provider.metadata?.extensionIdentity === entry.identity))
   .map((inspection) => ({
     id: inspection.service.key,
     contract: inspection.service.contract,
   }));
 return createExtensionAppServicesSnippet(services, publicNames);
}

function capitalize(value: string): string {
 return value.charAt(0).toUpperCase() + value.slice(1);
}

function createScopeSafeResources(
  resourcePort: RuntimeScopedResourcePort,
  workspacePath: string,
  workspaceId: string,
  projectId: string,
  fallbackSessionId: string,
  principal: RuntimePrincipal,
  identity: RuntimeHarnessIdentity,
  resolveWorkspace: AgentRuntimeHostOptions['resolveWorkspace'],
): RuntimeResourcePort {
  const resolveContext = (context: RuntimeCallContext): Promise<InvocationContext> =>
    resolveInvocationContext(
      context,
      workspacePath,
      workspaceId,
      projectId,
      fallbackSessionId,
      principal,
      identity,
      resolveWorkspace,
    );
  const resources: RuntimeResourcePort = {
    async listResources(context) {
      const descriptors = await resourcePort.listResources(
        await resolveContext(context),
      );
      return descriptors.map((descriptor) => ({ ...descriptor }));
    },
    async readResource(uri, context) {
      const content = await resourcePort.readResource(
        uri,
        await resolveContext(context),
      );
      return { ...content };
    },
    ...(resourcePort.toolMetadata
      ? { toolMetadata: () => ({ ...resourcePort.toolMetadata!() }) }
      : {}),
    ...(resourcePort.reactToolMetadata
      ? { reactToolMetadata: () => ({ ...resourcePort.reactToolMetadata!() }) }
      : {}),
  };
  if (resourcePort.listRenderTools) {
    resources.listTools = async (context) =>
      resourcePort.listRenderTools!(await resolveContext(context));
  }
  if (resourcePort.invokeRenderTool) {
    resources.callTool = async (name, input, context) =>
      resourcePort.invokeRenderTool!(
        name,
        input,
        await resolveContext(context),
      );
  }
  return resources;
}

interface ActivePermissionGrant {
  readonly capability: string;
  readonly providerId: string;
  readonly permissions: string;
  readonly principalId: string;
  readonly identity: string;
  readonly scope: string;
  readonly expiresAt: number;
  consumed: boolean;
}

type ActivePermissionApproval = Readonly<Record<string, unknown>> & {
  readonly [ACTIVE_PERMISSION_GRANT]?: ActivePermissionGrant;
};

function withActivePermissionGrants(
  broker: PermissionBroker,
): PermissionBroker {
  return {
    async decide(check): Promise<PermissionDecision> {
      const grant = (check.request.approval as ActivePermissionApproval | undefined)
        ?.[ACTIVE_PERMISSION_GRANT];
      if (!grant) return broker.decide(check);
      if (
        grant.consumed
        || grant.expiresAt <= Date.now()
        || grant.capability !== check.capability.name
        || grant.providerId !== check.capability.provider.id
        || grant.permissions !== permissionRequirementsKey(check)
        || grant.principalId !== check.context.principal.id
        || grant.identity !== permissionIdentityKey(check)
        || grant.scope !== permissionScopeKey(check)
      ) {
        return {
          decision: 'deny',
          reason: 'The active initialization approval is invalid, expired, or already consumed.',
        };
      }
      grant.consumed = true;
      return {
        decision: 'allow',
        reason: 'The active initialization approval authorizes this operation.',
        grants: check.requirements.map(({ permission }) => permission),
      };
    },
  };
}

function createActivePermissionGrant(
  check: PermissionCheck,
): Readonly<Record<string, unknown>> {
  return {
    [ACTIVE_PERMISSION_GRANT]: {
      capability: check.capability.name,
      providerId: check.capability.provider.id,
      permissions: permissionRequirementsKey(check),
      principalId: check.context.principal.id,
      identity: permissionIdentityKey(check),
      scope: permissionScopeKey(check),
      expiresAt: Date.now() + ACTIVE_PERMISSION_GRANT_TTL_MS,
      consumed: false,
    },
  } as ActivePermissionApproval;
}

function permissionRequirementsKey(check: PermissionCheck): string {
  return JSON.stringify(
    check.requirements.map(({ permission }) => permission).sort(),
  );
}

function permissionIdentityKey(check: PermissionCheck): string {
  return JSON.stringify({
    harnessId: check.context.identity?.harnessId ?? '',
    installationId: check.context.identity?.installationId ?? '',
    profileId: check.context.identity?.profileId ?? '',
    userId: check.context.identity?.userId ?? '',
    agentId: check.context.identity?.agentId ?? '',
  });
}

function permissionScopeKey(check: PermissionCheck): string {
  return JSON.stringify({
    workspaceId: check.context.scope?.workspaceId ?? '',
    projectId: check.context.scope?.projectId ?? '',
    workspacePath: normalizePermissionWorkspacePath(check.context.scope?.workspacePath),
    sessionId: check.context.scope?.sessionId ?? '',
    threadId: check.context.scope?.threadId ?? '',
    agentId: check.context.scope?.agentId ?? '',
  });
}

function normalizePermissionWorkspacePath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return '';
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function composeScopedResourcePorts(
  ports: readonly RuntimeScopedResourcePort[],
): RuntimeScopedResourcePort | undefined {
  if (ports.length === 0) return undefined;
  if (ports.length === 1) return ports[0];
  const metadataPorts = ports.filter((port) => port.toolMetadata);
  const reactMetadataPorts = ports.filter((port) => port.reactToolMetadata);
  if (metadataPorts.length > 1) {
    throw new Error('Multiple resource ports declared legacy UI tool metadata.');
  }
  if (reactMetadataPorts.length > 1) {
    throw new Error('Multiple resource ports declared React UI tool metadata.');
  }
  return {
    async listResources(context) {
      const resources = (await Promise.all(ports.map((port) => port.listResources(context)))).flat();
      assertUniqueResourceIdentities(resources.map((resource) => resource.uri), 'resource URI');
      return resources;
    },
    async readResource(uri, context) {
      const owners = await resourceOwners(ports, uri, context);
      if (owners.length === 0) throw new Error(`Runtime resource not found: ${uri}`);
      if (owners.length > 1) throw new Error(`Runtime resource URI is ambiguous: ${uri}`);
      return owners[0]!.readResource(uri, context);
    },
    ...(metadataPorts[0]?.toolMetadata
      ? { toolMetadata: () => ({ ...metadataPorts[0]!.toolMetadata!() }) }
      : {}),
    ...(reactMetadataPorts[0]?.reactToolMetadata
      ? { reactToolMetadata: () => ({ ...reactMetadataPorts[0]!.reactToolMetadata!() }) }
      : {}),
    async listRenderTools(context) {
      const tools = (
        await Promise.all(
          ports.map((port) => port.listRenderTools?.(context) ?? Promise.resolve([])),
        )
      ).flat();
      assertUniqueResourceIdentities(tools.map((tool) => tool.name), 'render tool name');
      return tools;
    },
    async invokeRenderTool(name, input, context) {
      const owners: RuntimeScopedResourcePort[] = [];
      for (const port of ports) {
        if (!port.invokeRenderTool || !port.listRenderTools) continue;
        const tools = await port.listRenderTools(context);
        if (tools.some((tool) => tool.name === name)) owners.push(port);
      }
      if (owners.length > 1) throw new Error(`Runtime render tool is ambiguous: ${name}`);
      return owners[0]?.invokeRenderTool?.(name, input, context);
    },
  };
}

async function resourceOwners(
  ports: readonly RuntimeScopedResourcePort[],
  uri: string,
  context: InvocationContext,
): Promise<readonly RuntimeScopedResourcePort[]> {
  const owners: RuntimeScopedResourcePort[] = [];
  for (const port of ports) {
    if ((await port.listResources(context)).some((resource) => resource.uri === uri)) {
      owners.push(port);
    }
  }
  return owners;
}

function assertUniqueResourceIdentities(values: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate runtime ${kind}: ${value}`);
    seen.add(value);
  }
}

function assertUniqueJobHandlerKinds(handlers: readonly RuntimeBackgroundJobHandler[]): void {
  const seen = new Set<string>();
  for (const handler of handlers) {
    if (!handler.kind.trim()) throw new TypeError('Job handler kind cannot be empty.');
    if (seen.has(handler.kind)) {
      throw new Error(`Duplicate runtime job handler kind: ${handler.kind}`);
    }
    seen.add(handler.kind);
  }
}

function createConstructionJobManager(
  manager: BackgroundJobManager,
  stagedHandlers: RuntimeBackgroundJobHandler[],
): { readonly manager: BackgroundJobManager; closeRegistration(): void } {
  let registrationOpen = true;
  const stagedManager = new Proxy(manager, {
    get(target, property) {
      if (property === 'register') {
        return (handler: RuntimeBackgroundJobHandler): void => {
          if (!registrationOpen) {
            throw new Error('Runtime job handler registration closed.');
          }
          stagedHandlers.push(handler);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    manager: stagedManager,
    closeRegistration() {
      registrationOpen = false;
    },
  };
}

function fixedInvocationContext(
  context: RuntimeCallContext,
  workspacePath: string,
  workspaceId: string,
  projectId: string,
  fallbackSessionId: string,
  principal: RuntimePrincipal,
  identity: RuntimeHarnessIdentity,
): InvocationContext {
  const sessionId = safeIdentifier(context.sessionId, fallbackSessionId);
  return {
    principal,
    identity: {
      ...identity,
      agentId: safeOptionalIdentifier(context.agentId) ?? identity.agentId,
    },
    scope: {
      workspaceId,
      projectId,
      sessionId,
      threadId:
        safeOptionalIdentifier(context.threadId) ??
        safeOptionalIdentifier(context.sessionId) ??
        sessionId,
      workspacePath,
    },
    executionId: safeOptionalIdentifier(context.requestId),
    signal: context.signal,
    ...(context.receiptCorrelationContext
      ? { receiptCorrelationContext: context.receiptCorrelationContext }
      : {}),
    metadata: {
      ...asRecord(context.metadata),
      agentId: safeOptionalIdentifier(context.agentId),
      workspacePath,
    },
  };
}

function normalizeSearchRequest(request: RuntimeSearchRequest): CoreRuntimeSearchRequest {
  const query = typeof request.query === 'string' ? request.query.slice(0, 4_000) : '';
  const requestedLimit = finiteInteger(request.limit, 20);
  const tags = Array.isArray(request.tags)
    ? request.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .slice(0, 20)
        .map((tag) => tag.slice(0, 128))
    : undefined;
  return {
    protocolVersion: request.protocolVersion ?? RUNTIME_PROTOCOL_VERSION,
    query,
    name: safeOptionalIdentifier(request.name),
    catalogId:
      request.catalogId === undefined
        ? undefined
        : requireRuntimeCatalogId(request.catalogId),
    detail: request.detail,
    tags,
    limit: Math.min(MAX_SEARCH_RESULTS, Math.max(1, requestedLimit)),
  };
}

function normalizeExecutionRequest(request: RuntimeExecutionRequest): RuntimeExecRequest {
  if (request.targetType === 'operation') {
    if (typeof request.target !== 'string' || !request.target.trim()) {
      throw new TypeError('Runtime execution target must be a non-empty string.');
    }
    return {
      protocolVersion: request.protocolVersion ?? RUNTIME_PROTOCOL_VERSION,
      target: request.target.slice(0, 512),
      input: request.input,
      requestId: safeOptionalIdentifier(request.requestId),
      approval: asRecord(request.approval),
    };
  }
  if (request.targetType === 'inline_module') {
    return {
      protocolVersion: request.protocolVersion ?? RUNTIME_PROTOCOL_VERSION,
      target:
        request.executionMode === 'trusted_node'
          ? TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY
          : INLINE_MODULE_EXECUTOR_CAPABILITY,
      input: {
        source: request.source,
        input: request.input,
        timeoutMs: request.timeoutMs,
      },
      requestId: safeOptionalIdentifier(request.requestId),
      approval: asRecord(request.approval),
    };
  }
  return {
    protocolVersion: request.protocolVersion ?? RUNTIME_PROTOCOL_VERSION,
    target:
      request.executionMode === 'trusted_node'
        ? TRUSTED_MODULE_EXECUTOR_CAPABILITY
        : MODULE_EXECUTOR_CAPABILITY,
    input: {
      module: request.module,
      input: request.input,
      timeoutMs: request.timeoutMs,
    },
    requestId: safeOptionalIdentifier(request.requestId),
    approval: asRecord(request.approval),
  };
}

function nestedOperationContext(
  context: InvocationContext,
  executionId: string,
): InvocationContext {
  const parentExecutionId = context.executionId;
  if (!parentExecutionId) return { ...context, executionId };
  return {
    ...context,
    executionId,
    lineage: {
      rootExecutionId: context.lineage?.rootExecutionId ?? parentExecutionId,
      parentExecutionId,
      depth: (context.lineage?.depth ?? 0) + 1,
    },
    scope: {
      ...(context.scope ?? {}),
      parentExecutionId,
    },
    metadata: {
      ...(context.metadata ?? {}),
      parentExecutionId,
    },
  };
}

function normalizeBundle(
  value: RuntimeHostProviderBundle | readonly CapabilityProvider[] | CapabilityProvider,
): RuntimeHostProviderBundle {
  if (isCapabilityProvider(value)) return { providers: [value] };
  if (Array.isArray(value)) {
    const providers = value.filter(isCapabilityProvider);
    if (providers.length !== value.length)
      throw new TypeError('Provider array contains invalid values.');
    return { providers };
  }
  if (value && typeof value === 'object' && 'providers' in value) {
    const bundle = value as RuntimeHostProviderBundle;
    if (!Array.isArray(bundle.providers) || !bundle.providers.every(isCapabilityProvider)) {
      throw new TypeError('Provider bundle contains invalid providers.');
    }
    return bundle;
  }
  throw new TypeError('Provider source returned an unsupported value.');
}

function isCapabilityProvider(value: unknown): value is CapabilityProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CapabilityProvider).id === 'string' &&
    typeof (value as CapabilityProvider).list === 'function' &&
    typeof (value as CapabilityProvider).invoke === 'function'
  );
}

function normalizePrincipal(value: RuntimePrincipal | undefined): RuntimePrincipal {
  if (!value) return DEFAULT_PRINCIPAL;
  return {
    id: safeIdentifier(value.id, DEFAULT_PRINCIPAL.id),
    kind: safeIdentifier(value.kind, DEFAULT_PRINCIPAL.kind),
    ...(value.claims ? { claims: { ...value.claims } } : {}),
  };
}

function normalizeIdentity(
  value: RuntimeHarnessIdentity | undefined,
  principal: RuntimePrincipal,
): RuntimeHarnessIdentity {
  return {
    harnessId: safeIdentifier(value?.harnessId, 'marshal-local-host'),
    ...(safeOptionalIdentifier(value?.installationId)
      ? { installationId: safeOptionalIdentifier(value?.installationId) }
      : {}),
    ...(safeOptionalIdentifier(value?.profileId)
      ? { profileId: safeOptionalIdentifier(value?.profileId) }
      : {}),
    ...(safeOptionalIdentifier(value?.userId)
      ? { userId: safeOptionalIdentifier(value?.userId) }
      : {}),
    agentId: safeIdentifier(value?.agentId, principal.id),
  };
}

function safeIdentifier(value: unknown, fallback: string): string {
  return safeOptionalIdentifier(value) ?? fallback;
}

function safeOptionalIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, 512) : undefined;
}

function finiteInteger(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value as number) : fallback;
}

function asRecord(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function readPermissionProfile(
  configured: AgentRuntimeHostOptions['permissionProfile'],
): NonNullable<AgentRuntimeHostOptions['permissionProfile']> {
  if (configured) return configured;
  const profile = process.env.MARSHAL_RUNTIME_PERMISSION_PROFILE;
  if (
    profile === 'trusted-local' ||
    profile === 'bounded-agentic' ||
    profile === 'adaptive-agentic'
  ) return profile;
  return 'default';
}

function resolveImportPolicy(
  configured: AgentRuntimeHostOptions['importPolicy'],
  permissionProfile: NonNullable<AgentRuntimeHostOptions['permissionProfile']>,
): AgentRuntimeHostOptions['importPolicy'] {
  if (configured) return configured;
  if (permissionProfile !== 'trusted-local') return undefined;
  const allowedPackages = parseImportAllowlist(process.env.MARSHAL_RUNTIME_ALLOWED_PACKAGES);
  const allowedBuiltins = parseImportAllowlist(process.env.MARSHAL_RUNTIME_ALLOWED_BUILTINS);
  if (allowedPackages === undefined && allowedBuiltins === undefined) return undefined;
  return {
    ...(allowedPackages === undefined ? {} : { allowedPackages }),
    ...(allowedBuiltins === undefined ? {} : { allowedBuiltins }),
  };
}

function parseImportAllowlist(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.slice(0, 256)),
    ),
  ].slice(0, 256);
}

function createPermissionOptions(
  workspaceId: string,
  principalId: string,
  profile: NonNullable<AgentRuntimeHostOptions['permissionProfile']>,
  additional: readonly string[] | undefined,
  trustedAdditional: readonly string[] | undefined,
  approval: AgentRuntimeHostOptions['permissionApproval'],
  resolveGrants: AgentRuntimeHostOptions['resolvePermissionGrants'],
): Readonly<Record<string, unknown>> {
  const permissionPatterns = [
    ...BASE_PERMISSIONS,
    ...(additional ?? []),
    ...(profile === 'bounded-agentic' || profile === 'adaptive-agentic' || profile === 'trusted-local'
      ? BASE_BOUNDED_AGENTIC_PERMISSIONS
      : []),
    ...(profile === 'adaptive-agentic' ? BASE_ADAPTIVE_AGENTIC_PERMISSIONS : []),
    ...(profile === 'trusted-local'
      ? [...BASE_TRUSTED_PERMISSIONS, ...(trustedAdditional ?? [])]
      : []),
  ];
  return {
    grants: [...new Set(permissionPatterns)].map((permission) => ({
      principalId,
      permission,
      scope: { workspaceId },
    })),
    ...(resolveGrants ? { resolveGrants } : {}),
    ...(approval?.requestApproval ? { requestApproval: approval.requestApproval } : {}),
    ...(approval?.verifyApproval ? { verifyApproval: approval.verifyApproval } : {}),
  };
}
