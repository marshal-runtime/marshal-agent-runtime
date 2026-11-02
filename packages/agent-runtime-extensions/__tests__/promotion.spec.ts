import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAllowAllPermissionBroker,
  createRuntimeKernel,
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import {
  createRuntimeServiceContainer,
  type RuntimeResourceContent,
} from '@marshal/agent-runtime-composer';
import {
  ReactUiAuthoredStateStore,
  RUNTIME_AUTHORED_UI_STATE_SERVICE,
  stateScopeKey,
  type RuntimeAuthoredUiStateService,
  type UiApplicationSnapshot,
  type UiApplicationSourceProvenance,
} from '@marshal/agent-runtime-ui';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeRuntimeExtensionIntegrity,
  JsonFileRuntimeExtensionStateStore,
  LocalRuntimeExtensionPackageLoader,
  RuntimeAuthoredUiPromotionManager,
  RuntimeExtensionManager,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  createRuntimeAuthoredUiPromotionBundle,
  type RuntimeAuthoredUiPromotionRequest,
  type RuntimeAuthoredUiPromotionResult,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionLifecycleService,
  type RuntimeExtensionRecord,
} from '../src/index.js';

const context: InvocationContext = {
  principal: { id: 'promotion-agent', kind: 'agent' },
  scope: {
    workspaceId: 'promotion-workspace',
    projectId: 'promotion-project',
    sessionId: 'promotion-session',
  },
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('authored UI promotion', { timeout: 15_000 }, () => {
  it('invokes the bundle capability, promotion manager, real loader, and lifecycle manager', async () => {
    const fixture = await realFixture();
    const registration = fixture.kernel.register(fixture.bundle.provider);
    const request = promotionRequest(fixture.snapshot);

    const execution = await fixture.kernel.execute<RuntimeAuthoredUiPromotionResult>({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation',
      target: 'ui.authored.promote',
      input: request,
    }, context);

    expect(execution.status).toBe('success');
    expect(execution.result?.output).toMatchObject({ action: 'installed' });
    expect(fixture.bundle.service).toBeInstanceOf(RuntimeAuthoredUiPromotionManager);
    expect(fixture.manager.get(request.packageIdentity)).toMatchObject({
      version: request.packageVersion,
      status: 'enabled',
    });
    await expect(fixture.manager.resources.readResource(
      `ui://promotion/${fixture.snapshot.identity.id}`,
      context,
    )).resolves.toMatchObject({
      text: '<main>Promoted application</main>',
    });

    const packageRoot = await onlyPublishedPackage(fixture.promotionRoot);
    expect((await readdir(packageRoot)).sort()).toEqual([
      'dist',
      'package.json',
      'runtime-authored-ui.json',
      'runtime-extension.json',
    ]);
    expect(await readdir(join(packageRoot, 'dist'))).toEqual(['index.cjs']);
    expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')))
      .toMatchObject({
        name: request.packageIdentity,
        version: request.packageVersion,
        type: 'commonjs',
        main: 'dist/index.cjs',
        description: 'Promoted application',
      });

    const updatedSnapshot = await fixture.state.update(
      fixture.snapshot.identity.id,
      {
        expectedVersion: fixture.snapshot.version,
        application: fixture.snapshot.application,
        props: { revision: 2 },
        provenance: provenance('1'),
      },
      context,
    );
    const directManager = new RuntimeAuthoredUiPromotionManager({
      services: fixture.services,
      root: fixture.promotionRoot,
      resourceReader: fixture.resourceReader,
    });
    const updatedRequest = promotionRequest(updatedSnapshot, {
      packageVersion: '1.1.0',
    });
    await expect(directManager.promote(updatedRequest, context))
      .resolves.toMatchObject({ action: 'updated' });
    await expect(fixture.bundle.service.promote(updatedRequest, context))
      .resolves.toMatchObject({ action: 'unchanged' });
    expect(fixture.manager.get(request.packageIdentity)?.version).toBe('1.1.0');

    registration.dispose();
    await fixture.manager.dispose();
    await fixture.services.shutdown();
  });

  it('discovers restart-safe promotions only in the exact effective scope', async () => {
    const fixture = await realFixture({ persistent: true });
    const request = promotionRequest(fixture.snapshot);
    await fixture.bundle.service.promote(request, context);
    await fixture.manager.dispose();
    await fixture.services.shutdown();

    const services = createRuntimeServiceContainer();
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = new RuntimeExtensionManager({
      kernel,
      services,
      loader: new LocalRuntimeExtensionPackageLoader({
        allowedRoots: [fixture.promotionRoot],
      }),
      activationContext: context,
      stateStore: new JsonFileRuntimeExtensionStateStore(fixture.extensionStatePath),
    });
    await services.bind(RUNTIME_AUTHORED_UI_STATE_SERVICE, {
      useValue: fixture.state,
    });
    await services.bind(RUNTIME_EXTENSION_LIFECYCLE_SERVICE, {
      useValue: manager,
    });
    await manager.restore();
    const restarted = createRuntimeAuthoredUiPromotionBundle({
      services,
      root: fixture.promotionRoot,
      resourceReader: fixture.resourceReader,
    });

    const sameProject = {
      ...context,
      scope: { ...context.scope, sessionId: 'another-session' },
    };
    await expect(restarted.catalogSource.list(sameProject)).resolves.toEqual([
      expect.objectContaining({
        id: request.catalogEntryId,
        identity: request.packageIdentity,
        version: request.packageVersion,
        origin: 'native',
      }),
    ]);
    await expect(restarted.catalogSource.list({
      ...context,
      scope: { ...context.scope, projectId: 'another-project' },
    })).resolves.toEqual([]);
    await expect(restarted.catalogSource.list({
      ...context,
      principal: { ...context.principal, id: 'another-principal' },
    })).resolves.toEqual([]);
    await expect(restarted.catalogSource.list(context, { aborted: true }))
      .rejects.toThrow('cancelled');

    await manager.dispose();
    await services.shutdown();
  });

  it('detaches mutable authority and request state and rejects unsafe ownership or resources', async () => {
    const fixture = await realFixture();
    const gate = deferred<void>();
    const state = withSnapshotReader(fixture.state, async () => {
      await gate.promise;
      return fixture.snapshot;
    });
    await fixture.services.replace(RUNTIME_AUTHORED_UI_STATE_SERVICE, {
      useValue: state,
    });
    let readerCalls = 0;
    const resource: {
      uri: string;
      mimeType: string;
      text: string;
    } = {
      uri: `ui://promotion/${fixture.snapshot.identity.id}`,
      mimeType: 'text/html',
      text: '<main>immutable</main>',
    };
    const bundle = createRuntimeAuthoredUiPromotionBundle({
      services: fixture.services,
      root: fixture.promotionRoot,
      resourceReader: {
        read: async (snapshot, captured) => {
          readerCalls += 1;
          expect(Object.isFrozen(snapshot)).toBe(true);
          expect(Object.isFrozen(snapshot.application)).toBe(true);
          expect(Object.isFrozen(captured)).toBe(true);
          expect(Object.isFrozen(captured.principal)).toBe(true);
          expect(Object.isFrozen(captured.scope)).toBe(true);
          return resource;
        },
      },
    });
    const mutableContext = structuredClone(context);
    const request = {
      ...promotionRequest(fixture.snapshot),
      packageIdentity: '@example/immutable',
      catalogEntryId: 'immutable-entry',
    };
    const pending = bundle.service.promote(request, mutableContext);
    request.packageIdentity = '@example/mutated';
    request.packageVersion = '9.9.9';
    mutableContext.principal.id = 'mutated-principal';
    mutableContext.scope!.projectId = 'mutated-project';
    gate.resolve();

    await expect(pending).resolves.toMatchObject({
      action: 'installed',
      packageIdentity: '@example/immutable',
      packageVersion: '1.0.0',
    });
    resource.text = '<main>mutated later</main>';
    await expect(fixture.manager.resources.readResource(
      resource.uri,
      context,
    )).resolves.toMatchObject({ text: '<main>immutable</main>' });

    const beforeWrongScope = readerCalls;
    await expect(bundle.service.promote({
      ...promotionRequest(fixture.snapshot),
      packageIdentity: '@example/wrong-scope',
    }, {
      ...context,
      scope: { ...context.scope, projectId: 'another-project' },
    })).rejects.toThrow('outside the invocation scope');
    expect(readerCalls).toBe(beforeWrongScope);

    const ordinary = await ordinaryPackage(
      fixture.promotionRoot,
      '@example/ordinary',
    );
    await fixture.manager.install(ordinary);
    await expect(bundle.service.promote({
      ...promotionRequest(fixture.snapshot),
      packageIdentity: '@example/ordinary',
    }, context)).rejects.toThrow('not owned');
    expect(readerCalls).toBe(beforeWrongScope);

    const accessorResource = Object.create(null) as RuntimeResourceContent;
    Object.defineProperties(accessorResource, {
      uri: { enumerable: true, get: () => 'ui://promotion/accessor' },
      text: { enumerable: true, value: '<main />' },
    });
    const unsafeBundle = createRuntimeAuthoredUiPromotionBundle({
      services: fixture.services,
      root: fixture.promotionRoot,
      resourceReader: { read: async () => accessorResource },
    });
    await expect(unsafeBundle.service.promote({
      ...promotionRequest(fixture.snapshot),
      packageIdentity: '@example/accessor',
    }, context)).rejects.toThrow('resource content');

    await fixture.manager.dispose();
    await fixture.services.shutdown();
  });

  it('retains reused packages across lifecycle races and cleans only owned failures', async () => {
    const baseRoot = await temporaryRoot();
    const promotionRoot = join(baseRoot, 'promotion');
    await mkdir(promotionRoot);
    const state = new ReactUiAuthoredStateStore({
      storageRoot: join(baseRoot, 'authored-state'),
    });
    const snapshot = await state.create(authoredApplication(), context);
    const firstInstall = deferred<void>();
    const releaseFailure = deferred<void>();
    let installCalls = 0;
    let failFollowingInstalls = false;
    let current: RuntimeExtensionRecord | undefined;
    const lifecycle = lifecycleStub({
      get: () => current,
      list: () => current ? [current] : [],
      install: async (request) => {
        installCalls += 1;
        if (failFollowingInstalls) throw new Error('owned lifecycle failure');
        if (installCalls === 1) {
          firstInstall.resolve();
          await releaseFailure.promise;
          throw new Error('racing lifecycle failure');
        }
        current = recordFor(request, '@example/race', '1.0.0');
        return current;
      },
    });
    const services = createRuntimeServiceContainer();
    await services.bind(RUNTIME_AUTHORED_UI_STATE_SERVICE, { useValue: state });
    await services.bind(RUNTIME_EXTENSION_LIFECYCLE_SERVICE, {
      useValue: lifecycle,
    });
    const bundle = createRuntimeAuthoredUiPromotionBundle({
      services,
      root: promotionRoot,
      resourceReader: {
        read: async () => ({
          uri: 'ui://promotion/race',
          mimeType: 'text/html',
          text: '<main>race</main>',
        }),
      },
    });
    const request = promotionRequest(snapshot, {
      packageIdentity: '@example/race',
      catalogEntryId: 'race-entry',
    });

    const first = bundle.service.promote(request, context);
    await firstInstall.promise;
    const second = bundle.service.promote(request, context);
    await expect(second).resolves.toMatchObject({ action: 'installed' });
    releaseFailure.resolve();
    await expect(first).rejects.toThrow('racing lifecycle failure');
    expect(await publishedPackages(promotionRoot)).toHaveLength(1);

    current = undefined;
    failFollowingInstalls = true;
    await expect(bundle.service.promote(request, context))
      .rejects.toThrow('owned lifecycle failure');
    expect(await publishedPackages(promotionRoot)).toHaveLength(1);

    await expect(bundle.service.promote({
      ...request,
      packageIdentity: '@example/owned-failure',
      catalogEntryId: 'owned-failure-entry',
    }, context)).rejects.toThrow('owned lifecycle failure');
    expect(await publishedPackages(promotionRoot)).toHaveLength(1);

    await services.shutdown();
  }, 15_000);

  it('publishes strict promotion input and output schemas', async () => {
    const fixture = await realFixture();
    const descriptor = fixture.bundle.provider.get('ui.authored.promote', context);
    const properties = {
      applicationId: { type: 'string', minLength: 1, maxLength: 256 },
      snapshotDigest: {
        type: 'string',
        minLength: 64,
        maxLength: 64,
        pattern: '^[a-f0-9]{64}$',
      },
      packageIdentity: { type: 'string', minLength: 1, maxLength: 214 },
      packageVersion: { type: 'string', minLength: 1, maxLength: 96 },
      catalogEntryId: { type: 'string', minLength: 1, maxLength: 512 },
    };
    expect(descriptor?.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: [
        'applicationId',
        'snapshotDigest',
        'packageIdentity',
        'packageVersion',
        'catalogEntryId',
      ],
      properties,
    });
    expect(descriptor?.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: [
        'applicationId',
        'snapshotDigest',
        'packageIdentity',
        'packageVersion',
        'catalogEntryId',
        'action',
      ],
      properties: {
        ...properties,
        action: {
          type: 'string',
          enum: ['installed', 'updated', 'unchanged'],
        },
      },
    });

    const accessorRequest = Object.create(null) as RuntimeAuthoredUiPromotionRequest;
    Object.defineProperties(accessorRequest, {
      applicationId: { enumerable: true, get: () => fixture.snapshot.identity.id },
      snapshotDigest: { enumerable: true, value: fixture.snapshot.snapshotDigest },
      packageIdentity: { enumerable: true, value: '@example/accessor-request' },
      packageVersion: { enumerable: true, value: '1.0.0' },
      catalogEntryId: { enumerable: true, value: 'accessor-request' },
    });
    await expect(fixture.bundle.provider.invoke(
      'ui.authored.promote',
      accessorRequest,
      context,
    )).rejects.toThrow('request');

    await fixture.manager.dispose();
    await fixture.services.shutdown();
  });

  it('rejects a canonical-root violation and observes live cancellation', async () => {
    const realRoot = await mkdtemp(join(tmpdir(), 'promotion-'));
    roots.push(realRoot);
    const authoredState = new ReactUiAuthoredStateStore({
      storageRoot: join(realRoot, 'authored-state'),
    });
    const snapshot = await authoredState.create(authoredApplication(), context);
    const linkedRoot = `${realRoot}-link`;
    await symlink(realRoot, linkedRoot, 'junction');
    roots.push(linkedRoot);
    const signal = { aborted: false };
    const state = { readSnapshot: async () => structuredClone(snapshot) };
    const services: RuntimeServiceAccessor = {
      get: (token) => token === RUNTIME_AUTHORED_UI_STATE_SERVICE ? state : {
        get: () => undefined, install: async () => undefined, update: async () => undefined,
      },
      tryGet: () => undefined, getAll: () => [],
    } as RuntimeServiceAccessor;
    const linkedBundle = createRuntimeAuthoredUiPromotionBundle({
      services, root: linkedRoot, resourceReader: { read: async () => ({ uri: 'ui://cancel', text: '<main />' }) },
    });
    await expect(linkedBundle.service.promote({
      applicationId: snapshot.identity.id, snapshotDigest: snapshot.snapshotDigest,
      packageIdentity: '@example/linked', packageVersion: '1.0.0', catalogEntryId: 'linked',
    }, context)).rejects.toThrow('canonical');
    const bundle = createRuntimeAuthoredUiPromotionBundle({
      services, root: realRoot,
      resourceReader: {
        read: async () => { signal.aborted = true; return { uri: 'ui://cancel', text: '<main />' }; },
      },
    });
    await expect(bundle.service.promote({
      applicationId: snapshot.identity.id, snapshotDigest: snapshot.snapshotDigest,
      packageIdentity: '@example/cancel', packageVersion: '1.0.0', catalogEntryId: 'cancel',
    }, context, { signal })).rejects.toThrow('cancelled');
  });

  it('rejects links nested below restored and reused promotion trees', async () => {
    const fixture = await realFixture({ persistent: true });
    const request = promotionRequest(fixture.snapshot);
    await fixture.bundle.service.promote(request, context);
    const packageRoot = await onlyPublishedPackage(fixture.promotionRoot);
    const outside = join(fixture.promotionRoot, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(packageRoot, 'dist', 'nested-link'));

    await expect(fixture.bundle.catalogSource.list(context)).resolves.toEqual([]);
    await expect(fixture.bundle.service.promote(request, context))
      .rejects.toThrow('link or reparse point');
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside');

    await fixture.manager.dispose();
    await fixture.services.shutdown();
  });
});

interface RealFixture {
  readonly promotionRoot: string;
  readonly extensionStatePath: string;
  readonly state: ReactUiAuthoredStateStore;
  readonly snapshot: UiApplicationSnapshot;
  readonly services: ReturnType<typeof createRuntimeServiceContainer>;
  readonly kernel: ReturnType<typeof createRuntimeKernel>;
  readonly manager: RuntimeExtensionManager;
  readonly resourceReader: {
    read(snapshot: UiApplicationSnapshot): Promise<RuntimeResourceContent>;
  };
  readonly bundle: ReturnType<typeof createRuntimeAuthoredUiPromotionBundle>;
}

async function realFixture(
  options: { readonly persistent?: boolean } = {},
): Promise<RealFixture> {
  const baseRoot = await temporaryRoot();
  const promotionRoot = join(baseRoot, 'promotion');
  const extensionStatePath = join(baseRoot, 'extension-state', 'state.json');
  await mkdir(promotionRoot);
  const state = new ReactUiAuthoredStateStore({
    storageRoot: join(baseRoot, 'authored-state'),
  });
  const snapshot = await state.create(authoredApplication(), context);
  const services = createRuntimeServiceContainer();
  const kernel = createRuntimeKernel({
    permissionBroker: createAllowAllPermissionBroker(),
  });
  const manager = new RuntimeExtensionManager({
    kernel,
    services,
    loader: new LocalRuntimeExtensionPackageLoader({
      allowedRoots: [promotionRoot],
    }),
    activationContext: context,
    ...(options.persistent
      ? { stateStore: new JsonFileRuntimeExtensionStateStore(extensionStatePath) }
      : {}),
  });
  await services.bind(RUNTIME_AUTHORED_UI_STATE_SERVICE, { useValue: state });
  await services.bind(RUNTIME_EXTENSION_LIFECYCLE_SERVICE, {
    useValue: manager,
  });
  const resourceReader = {
    read: async (current: UiApplicationSnapshot) => ({
      uri: `ui://promotion/${current.identity.id}`,
      mimeType: 'text/html',
      text: `<main>${current.title}</main>`,
    }),
  };
  const bundle = createRuntimeAuthoredUiPromotionBundle({
    services,
    root: promotionRoot,
    resourceReader,
  });
  return {
    promotionRoot,
    extensionStatePath,
    state,
    snapshot,
    services,
    kernel,
    manager,
    resourceReader,
    bundle,
  };
}

function authoredApplication() {
  return {
    identity: { id: 'authored-app' },
    title: 'Promoted application',
    description: 'Promoted application',
    application: {
      version: '1.0.0',
      presentationModes: ['inline'] as const,
      actions: [],
      tools: [],
      localState: { scope: 'project' as const, schemaVersion: '1.0.0' },
    },
    props: {},
    provenance: provenance('a'),
    initialState: {},
  };
}

function promotionRequest(
  snapshot: UiApplicationSnapshot,
  overrides: Partial<RuntimeAuthoredUiPromotionRequest> = {},
): RuntimeAuthoredUiPromotionRequest {
  return {
    applicationId: snapshot.identity.id,
    snapshotDigest: snapshot.snapshotDigest,
    packageIdentity: '@example/promoted-ui',
    packageVersion: '1.0.0',
    catalogEntryId: 'promotion-entry',
    ...overrides,
  };
}

function provenance(seed: string): UiApplicationSourceProvenance {
  return {
    kind: 'snapshot',
    sourceDigest: seed.repeat(64),
    componentId: 'b'.repeat(64),
    renderId: 'c'.repeat(64),
    componentDigest: 'd'.repeat(64),
    renderDigest: 'e'.repeat(64),
  };
}

function withSnapshotReader(
  store: RuntimeAuthoredUiStateService,
  readSnapshot: RuntimeAuthoredUiStateService['readSnapshot'],
): RuntimeAuthoredUiStateService {
  return {
    create: (...args) => store.create(...args),
    read: (...args) => store.read(...args),
    list: (...args) => store.list(...args),
    update: (...args) => store.update(...args),
    changeState: (...args) => store.changeState(...args),
    readSnapshot,
    remove: (...args) => store.remove(...args),
    migrate: (...args) => store.migrate(...args),
  };
}

function lifecycleStub(
  overrides: Partial<RuntimeExtensionLifecycleService>,
): RuntimeExtensionLifecycleService {
  const unsupported = async (): Promise<never> => {
    throw new Error('Unexpected lifecycle operation.');
  };
  return {
    restore: async () => [],
    discover: async () => [],
    install: unsupported,
    update: unsupported,
    configure: unsupported,
    enable: unsupported,
    disable: unsupported,
    remove: unsupported,
    get: () => undefined,
    list: () => [],
    ...overrides,
  };
}

function recordFor(
  request: RuntimeExtensionInstallRequest,
  identity: string,
  version: string,
): RuntimeExtensionRecord {
  return {
    identity,
    version,
    integrity: request.integrity,
    entrypoint: 'dist/index.cjs',
    status: 'enabled',
    activationOrder: 0,
    configuration: {},
  };
}

async function ordinaryPackage(
  root: string,
  identity: string,
): Promise<RuntimeExtensionInstallRequest> {
  const packageRoot = await mkdtemp(join(root, 'ordinary-'));
  await mkdir(join(packageRoot, 'dist'));
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: identity,
    version: '1.0.0',
    type: 'commonjs',
    main: 'dist/index.cjs',
  }));
  await writeFile(join(packageRoot, 'runtime-extension.json'), JSON.stringify({
    schemaVersion: 1,
    identity,
    version: '1.0.0',
    entrypoint: 'dist/index.cjs',
    moduleFormat: 'commonjs-bundle-v1',
  }));
  await writeFile(
    join(packageRoot, 'dist/index.cjs'),
    'module.exports={activate(){return {}}};',
  );
  return {
    packageRoot,
    integrity: computeRuntimeExtensionIntegrity(packageRoot),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'promotion-'));
  roots.push(root);
  return root;
}

async function publishedPackages(root: string): Promise<string[]> {
  return (await readdir(root))
    .filter((name) => /^[a-f0-9]{64}$/.test(name))
    .sort();
}

async function onlyPublishedPackage(root: string): Promise<string> {
  const packages = await publishedPackages(root);
  expect(packages).toHaveLength(1);
  return join(root, packages[0]!);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
