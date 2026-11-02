import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createAllowAllPermissionBroker,
  createRuntimeKernel,
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityProvider,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import {
  createRuntimeServiceContainer,
  createRuntimeServiceToken,
} from '@marshal/agent-runtime-composer';
import {
  RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  RuntimeExtensionManager,
  RuntimeExtensionUiPublicationRegistry,
  replaceRuntimeExtensionService,
  subscribeRuntimeExtensionEvent,
  type LoadedRuntimeExtensionPackage,
  type RuntimeExtensionActivationContext,
  type RuntimeExtensionConfiguration,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionPackageLoader,
  type RuntimeExtensionStateStore,
  type RuntimeExtensionStoredRecord,
} from '../src/index.js';

const context: InvocationContext = {
  principal: { id: 'native-extension-test', kind: 'agent' },
  scope: { workspaceId: 'workspace-1' },
};

const TEST_SERVICE = createRuntimeServiceToken<{ readonly value: string }>(
  '@example/native-extension-test:value',
);

describe('native extension lifecycle integration', () => {
  it('marks an enabled extension blocked when a declared UI application is not published', async () => {
    const extension = runtimePackage({
      identity: '@example/missing-ui',
      version: '1.0.0',
      contributesUi: ['codereview.prs'],
      activate: () => ({ capabilityProviders: [] }),
    });
    const manager = new RuntimeExtensionManager({
      kernel: createRuntimeKernel(),
      loader: new MapRuntimeExtensionLoader([extension]),
      activationContext: context,
      services: createRuntimeServiceContainer(),
    });

    await manager.install(extension.request);
    expect(manager.get('@example/missing-ui')).toMatchObject({
      health: 'blocked',
      blockReasons: [expect.objectContaining({ code: 'MISSING_PUBLISHED_UI_RESOURCE' })],
    });
  });

  it('marks an enabled extension blocked when a declared UI application publishes an empty (unreadable) resource', async () => {
    const extension = runtimePackage({
      identity: '@example/empty-ui-resource',
      version: '1.0.0',
      contributesUi: ['codereview.prs'],
      activate: () => ({
        capabilityProviders: [],
        uiApplications: [{
          id: 'codereview.prs',
          title: 'Pull Requests',
          description: 'Declared UI whose published resource has no content.',
          renderId: 'codereview.prs',
          // Passes activation-time shape validation (text IS a string), but a
          // reader gets zero bytes — the host must not report this healthy.
          resource: { uri: 'ui://example/codereview.prs.html', mimeType: 'text/html', text: '' },
          application: { version: '1.0.0', presentationModes: ['inline'], actions: [], tools: [] },
        }],
        uiPlacements: [{ placementId: 'nav.primary', applicationId: 'codereview.prs', action: 'augment' as const }],
      }),
    });
    const manager = new RuntimeExtensionManager({
      kernel: createRuntimeKernel(),
      loader: new MapRuntimeExtensionLoader([extension]),
      activationContext: context,
      services: createRuntimeServiceContainer(),
      uiPlacementDefinitions: [{
        placementId: 'nav.primary',
        metadata: { title: 'Primary navigation', hasHostContent: true, supportedActions: ['augment'] },
      }],
    });

    await manager.install(extension.request);
    expect(manager.get('@example/empty-ui-resource')).toMatchObject({
      health: 'blocked',
      blockReasons: [expect.objectContaining({ code: 'UNREADABLE_UI_RESOURCE' })],
    });
  });

  it.each([true, false])('requires native placement only when the host requests it (%s)', async (uiPlacementsRequired) => {
    const extension = runtimePackage({
      identity: '@example/unplaced-ui',
      version: '1.0.0',
      contributesUi: ['codereview.prs'],
      activate: () => ({
        capabilityProviders: [],
        uiApplications: [{
          id: 'codereview.prs',
          title: 'Pull Requests',
          description: 'Declared UI with a readable resource but no placement contribution.',
          renderId: 'codereview.prs',
          resource: { uri: 'ui://example/codereview.prs.html', mimeType: 'text/html', text: '<!doctype html><main>real</main>' },
          application: { version: '1.0.0', presentationModes: ['inline'], actions: [], tools: [] },
        }],
        // No uiPlacements: the application is registered but can never appear
        // in navigation — the exact healthy-but-unreachable Wave 1 gap.
      }),
    });
    const manager = new RuntimeExtensionManager({
      kernel: createRuntimeKernel(),
      loader: new MapRuntimeExtensionLoader([extension]),
      activationContext: context,
      services: createRuntimeServiceContainer(),
      uiPlacementsRequired,
    });

    await manager.install(extension.request);
    expect(manager.get('@example/unplaced-ui')).toMatchObject({
      health: uiPlacementsRequired ? 'blocked' : 'healthy',
      blockReasons: uiPlacementsRequired ? [expect.objectContaining({ code: 'MISSING_UI_PLACEMENT' })] : [],
    });
  });

  it('keeps an enabled extension healthy when its declared UI publishes a readable resource with a placement', async () => {
    const extension = runtimePackage({
      identity: '@example/complete-ui',
      version: '1.0.0',
      contributesUi: ['codereview.prs'],
      activate: () => ({
        capabilityProviders: [],
        uiApplications: [{
          id: 'codereview.prs',
          title: 'Pull Requests',
          description: 'Fully published declared UI.',
          renderId: 'codereview.prs',
          resource: { uri: 'ui://example/codereview.prs.html', mimeType: 'text/html', text: '<!doctype html><main>real</main>' },
          application: { version: '1.0.0', presentationModes: ['inline'], actions: [], tools: [] },
        }],
        uiPlacements: [{ placementId: 'nav.primary', applicationId: 'codereview.prs', action: 'augment' as const }],
      }),
    });
    const manager = new RuntimeExtensionManager({
      kernel: createRuntimeKernel(),
      loader: new MapRuntimeExtensionLoader([extension]),
      activationContext: context,
      services: createRuntimeServiceContainer(),
      uiPlacementDefinitions: [{
        placementId: 'nav.primary',
        metadata: { title: 'Primary navigation', hasHostContent: true, supportedActions: ['augment'] },
      }],
    });

    await manager.install(extension.request);
    expect(manager.get('@example/complete-ui')).toMatchObject({ health: 'healthy', blockReasons: [] });
  });

  it('keeps resource reads consistent while an enabled extension is reconfigured', async () => {
    const services = createRuntimeServiceContainer();
    let registrationCount = 0;
    let releaseReplacement!: () => void;
    let replacementStarted!: () => void;
    const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const replacementReady = new Promise<void>((resolve) => { replacementStarted = resolve; });
    const extension = runtimePackage({
      identity: '@example/reconfigure',
      version: '1.0.0',
      activate: () => ({
        resourceProviders: [{
          listResources: async () => [],
          readResource: async () => { throw new Error('not found'); },
        }],
        lifecycle: {
          startSession: async () => undefined,
          observeTurn: async () => undefined,
          endSession: async () => undefined,
        },
      }),
    });
    const manager = new RuntimeExtensionManager({
      kernel: createRuntimeKernel(),
      loader: new MapRuntimeExtensionLoader([extension]),
      activationContext: context,
      services,
      registerLifecycle: async () => {
        registrationCount += 1;
        if (registrationCount === 2) {
          replacementStarted();
          await replacementGate;
        }
        return { dispose: () => undefined };
      },
    });

    await manager.install(extension.request);
    const configuring = manager.configure('@example/reconfigure', { updated: true });
    await replacementReady;
    await expect(manager.resources.listResources(context)).resolves.toEqual([]);
    releaseReplacement();
    await expect(configuring).resolves.toMatchObject({
      status: 'enabled',
      configuration: { updated: true },
    });

    await manager.dispose();
    await services.shutdown();
  });

  it('restores disabled configuration without activating until enable', async () => {
    const services = createRuntimeServiceContainer();
    const state = new MemoryStateStore();
    let activationCount = 0;
    let observedConfiguration: RuntimeExtensionConfiguration | undefined;
    const extension = runtimePackage({
      identity: '@example/configured',
      version: '1.0.0',
      defaults: { fromManifest: true },
      activate: (activationContext) => {
        activationCount += 1;
        observedConfiguration = activationContext.configuration;
        return {};
      },
    });
    const loader = new MapRuntimeExtensionLoader([extension]);
    const first = new RuntimeExtensionManager({
      kernel: createRuntimeKernel(),
      loader,
      activationContext: context,
      services,
      stateStore: state,
    });

    await expect(first.install(extension.request, {
      enabled: false,
      configuration: { fromCaller: 'kept' },
    })).resolves.toMatchObject({
      status: 'disabled',
      configuration: {
        fromManifest: true,
        fromCaller: 'kept',
      },
    });
    expect(activationCount).toBe(0);
    await first.dispose();

    const restored = new RuntimeExtensionManager({
      kernel: createRuntimeKernel(),
      loader,
      activationContext: context,
      services,
      stateStore: state,
    });
    await expect(restored.restore()).resolves.toEqual([
      expect.objectContaining({
        identity: '@example/configured',
        status: 'disabled',
      }),
    ]);
    expect(activationCount).toBe(0);

    await restored.enable('@example/configured');
    expect(activationCount).toBe(1);
    expect(observedConfiguration).toEqual({
      fromManifest: true,
      fromCaller: 'kept',
    });

    await restored.dispose();
    await services.shutdown();
  });

  it('rolls back services, capabilities, and published UI when persistence fails', async () => {
    const services = createRuntimeServiceContainer();
    const baseBinding = await services.bind(TEST_SERVICE, {
      useValue: { value: 'base' },
    });
    const publication = new RuntimeExtensionUiPublicationRegistry([]);
    const publicationBinding = await services.bind(
      RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
      { useValue: publication },
    );
    const state = new MemoryStateStore(2);
    let disposedV2 = 0;
    const first = runtimePackage({
      identity: '@example/atomic',
      version: '1.0.0',
      activate: () => activation('one'),
    });
    const second = runtimePackage({
      identity: '@example/atomic',
      version: '2.0.0',
      activate: () => activation('two', () => {
        disposedV2 += 1;
      }),
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = new RuntimeExtensionManager({
      kernel,
      loader: new MapRuntimeExtensionLoader([first, second]),
      activationContext: context,
      services,
      stateStore: state,
    });

    await manager.install(first.request);
    await expect(manager.update('@example/atomic', second.request))
      .rejects.toMatchObject({ code: 'STATE_FAILED' });

    expect(manager.get('@example/atomic')).toMatchObject({
      version: '1.0.0',
      status: 'enabled',
    });
    expect(services.get(TEST_SERVICE)).toEqual({ value: 'one' });
    await expect(invokeValue(kernel)).resolves.toBe('one');
    await expect(publication.listApplications(context)).resolves.toEqual([
      expect.objectContaining({
        ownerId: '@example/atomic',
        title: 'one application',
      }),
    ]);
    expect(disposedV2).toBe(1);

    await manager.dispose();
    await publicationBinding.dispose();
    await baseBinding.dispose();
    await services.shutdown();
  });

  it('revokes live contributions before asynchronous activation disposal completes', async () => {
    const services = createRuntimeServiceContainer();
    const baseBinding = await services.bind(TEST_SERVICE, {
      useValue: { value: 'base' },
    });
    const publication = new RuntimeExtensionUiPublicationRegistry([]);
    const publicationBinding = await services.bind(
      RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
      { useValue: publication },
    );
    let releaseDisposal!: () => void;
    let markDisposalStarted!: () => void;
    const disposalGate = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    const disposalStarted = new Promise<void>((resolve) => {
      markDisposalStarted = resolve;
    });
    let observedEvents = 0;
    const extension = runtimePackage({
      identity: '@example/revoke',
      version: '1.0.0',
      activate: () => ({
        ...activation('live', async () => {
          markDisposalStarted();
          await disposalGate;
        }),
        eventSubscriptions: [
          subscribeRuntimeExtensionEvent('runtime.provider.registered', () => {
            observedEvents += 1;
          }),
        ],
      }),
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = new RuntimeExtensionManager({
      kernel,
      loader: new MapRuntimeExtensionLoader([extension]),
      activationContext: context,
      services,
    });
    await manager.install(extension.request);
    const eventsBeforeDisable = observedEvents;

    let settled = false;
    const disabling = manager.disable('@example/revoke').finally(() => {
      settled = true;
    });
    await disposalStarted;

    expect(settled).toBe(false);
    expect(services.get(TEST_SERVICE)).toEqual({ value: 'base' });
    expect(await kernel.get('example.native.echo', context)).toBeUndefined();
    await expect(publication.listApplications(context)).resolves.toEqual([]);
    await kernel.events.publish({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      id: 'event-after-disable',
      type: 'runtime.provider.registered',
      occurredAt: new Date().toISOString(),
      context,
      payload: {
        providerId: 'external.provider',
        providerVersion: '1.0.0',
      },
    });
    expect(observedEvents).toBe(eventsBeforeDisable);

    releaseDisposal();
    await disabling;
    await manager.dispose();
    await publicationBinding.dispose();
    await baseBinding.dispose();
    await services.shutdown();
  });

  it('rolls back contributions when cancellation arrives during provider registration', async () => {
    const signal = { aborted: false };
    let disposed = 0;
    const extension = runtimePackage({
      identity: '@example/cancel-registration',
      version: '1.0.0',
      activate: () => ({
        capabilityProviders: [{
          id: 'example.cancel-registration',
          list: () => {
            signal.aborted = true;
            return [];
          },
          invoke: () => ({ output: {} }),
        }],
        dispose: () => {
          disposed += 1;
        },
      }),
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = new RuntimeExtensionManager({
      kernel,
      loader: new MapRuntimeExtensionLoader([extension]),
      activationContext: context,
    });

    await expect(manager.install(extension.request, { signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(manager.get('@example/cancel-registration')).toBeUndefined();
    expect(disposed).toBe(1);
    await expect(kernel.get('example.cancel-registration', context)).resolves.toBeUndefined();
    await manager.dispose();
  });

  it('keeps disabled and removed state coherent when cleanup partially fails', async () => {
    let disposeCount = 0;
    const extension = runtimePackage({
      identity: '@example/partial-cleanup',
      version: '1.0.0',
      activate: () => ({
        capabilityProviders: [capabilityProvider('partial-cleanup')],
        dispose: () => {
          disposeCount += 1;
          throw new Error('injected cleanup failure');
        },
      }),
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = new RuntimeExtensionManager({
      kernel,
      loader: new MapRuntimeExtensionLoader([extension]),
      activationContext: context,
    });

    await manager.install(extension.request);
    await expect(manager.disable('@example/partial-cleanup')).rejects.toMatchObject({
      code: 'DISPOSAL_FAILED',
    });
    expect(manager.get('@example/partial-cleanup')).toMatchObject({ status: 'disabled' });
    expect(await kernel.get('example.native.echo', context)).toBeUndefined();
    await expect(manager.remove('@example/partial-cleanup')).resolves.toBeUndefined();
    expect(manager.get('@example/partial-cleanup')).toBeUndefined();
    expect(disposeCount).toBe(1);
    await manager.dispose();
  });

  it('reactivates the prior version when replacement cleanup fails', async () => {
    let priorCleanupAttempts = 0;
    const first = runtimePackage({
      identity: '@example/cleanup-update',
      version: '1.0.0',
      activate: () => ({
        capabilityProviders: [namedCapabilityProvider('cleanup-update.old')],
        dispose: () => {
          priorCleanupAttempts += 1;
          if (priorCleanupAttempts === 1) throw new Error('prior cleanup failure');
        },
      }),
    });
    const second = runtimePackage({
      identity: '@example/cleanup-update',
      version: '2.0.0',
      activate: () => ({
        capabilityProviders: [namedCapabilityProvider('cleanup-update.new')],
      }),
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = new RuntimeExtensionManager({
      kernel,
      loader: new MapRuntimeExtensionLoader([first, second]),
      activationContext: context,
    });

    await manager.install(first.request);
    await expect(manager.update('@example/cleanup-update', second.request))
      .rejects.toMatchObject({ code: 'DISPOSAL_FAILED' });
    expect(manager.get('@example/cleanup-update')).toMatchObject({
      version: '1.0.0',
      status: 'enabled',
    });
    await expect(kernel.get('cleanup-update.old', context)).resolves.toBeDefined();
    await expect(kernel.get('cleanup-update.new', context)).resolves.toBeUndefined();
    await manager.dispose();
  });
});

class MapRuntimeExtensionLoader implements RuntimeExtensionPackageLoader {
  readonly #packages: ReadonlyMap<string, LoadedRuntimeExtensionPackage>;

  constructor(packages: readonly RuntimePackageFixture[]) {
    this.#packages = new Map(
      packages.map((fixture) => [fixture.request.packageRoot, fixture.loaded]),
    );
  }

  load(request: RuntimeExtensionInstallRequest): LoadedRuntimeExtensionPackage {
    const loaded = this.#packages.get(request.packageRoot);
    if (!loaded) throw new Error(`Unknown test extension ${request.packageRoot}.`);
    return loaded;
  }
}

class MemoryStateStore implements RuntimeExtensionStateStore {
  #records: readonly RuntimeExtensionStoredRecord[] = [];
  #saveCount = 0;

  constructor(private readonly failAtSave?: number) {}

  load(): readonly RuntimeExtensionStoredRecord[] {
    return this.#records;
  }

  save(records: readonly RuntimeExtensionStoredRecord[]): void {
    this.#saveCount += 1;
    if (this.#saveCount === this.failAtSave) {
      throw new Error('Injected extension state failure.');
    }
    this.#records = Object.freeze(records.map((record) => Object.freeze({
      ...record,
      request: Object.freeze({
        ...record.request,
        integrity: Object.freeze({ ...record.request.integrity }),
      }),
      configuration: Object.freeze({ ...record.configuration }),
    })));
  }
}

interface RuntimePackageFixture {
  readonly request: RuntimeExtensionInstallRequest;
  readonly loaded: LoadedRuntimeExtensionPackage;
}

function runtimePackage(options: {
  readonly identity: string;
  readonly version: string;
  readonly defaults?: RuntimeExtensionConfiguration;
  readonly contributesUi?: readonly string[];
  readonly activate: (
    context: RuntimeExtensionActivationContext,
  ) => ReturnType<LoadedRuntimeExtensionPackage['module']['activate']>;
}): RuntimePackageFixture {
  const packageRoot = `test://${options.identity}/${options.version}`;
  const integrity = {
    algorithm: 'sha256' as const,
    domain: RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
    value: createHash('sha256').update(packageRoot, 'utf8').digest('hex'),
  };
  const manifest = {
    schemaVersion: 1 as const,
    identity: options.identity,
    version: options.version,
    entrypoint: 'dist/index.cjs',
    moduleFormat: 'commonjs-bundle-v1' as const,
    ...(options.defaults
      ? { configuration: { defaults: options.defaults } }
      : {}),
    ...(options.contributesUi ? { contributes: { ui: options.contributesUi } } : {}),
  };
  return {
    request: { packageRoot, integrity },
    loaded: {
      metadata: {
        manifest,
        integrity,
        canonicalRoot: packageRoot,
        fileCount: 2,
        totalBytes: 1,
      },
      module: {
        activate: options.activate,
      },
    },
  };
}

function activation(
  value: string,
  dispose?: () => void | Promise<void>,
) {
  return {
    serviceContributions: [
      replaceRuntimeExtensionService(TEST_SERVICE, {
        useValue: { value },
      }),
    ],
    capabilityProviders: [capabilityProvider(value)],
    uiApplications: [{
      id: 'application',
      title: `${value} application`,
      description: 'Native extension lifecycle test application.',
      renderId: `render-${value}`,
      resource: {
        uri: `ui://example/${value}`,
        mimeType: 'text/html',
        text: `<main>${value}</main>`,
      },
      application: {
        version: '1.0.0',
        presentationModes: ['inline'],
        actions: [],
        tools: [],
      },
    }],
    ...(dispose ? { dispose } : {}),
  };
}

function capabilityProvider(value: string): CapabilityProvider {
  return {
    id: 'example.native.provider',
    list: () => [{
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name: 'example.native.echo',
      version: '1.0.0',
      description: 'Native extension lifecycle test capability.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
        additionalProperties: false,
      },
    }],
    invoke: () => ({ output: { value } }),
  };
}

function namedCapabilityProvider(name: string): CapabilityProvider {
  return {
    id: `${name}.provider`,
    list: () => [{
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name,
      version: '1.0.0',
      description: 'Named native extension lifecycle test capability.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    }],
    invoke: () => ({ output: {} }),
  };
}

async function invokeValue(
  kernel: ReturnType<typeof createRuntimeKernel>,
): Promise<string | undefined> {
  const result = await kernel.execute({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    targetType: 'operation',
    target: 'example.native.echo',
    input: {},
  }, context);
  return result.status === 'success'
    ? (result.result?.output as { readonly value?: string } | undefined)?.value
    : undefined;
}
