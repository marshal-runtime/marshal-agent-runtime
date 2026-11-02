import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRuntimeBuiltinsSource,
  createAgentRuntime,
  createRuntimeHostMaterializer,
  createRuntimeNativeExtensionCatalogSource,
  type AgentRuntimeHostOptions,
  type RuntimeHostProviderBundle,
} from '../src/index.js';
import { createRuntimeServiceContainer } from '@marshal/agent-runtime-composer';
import { createAllowAllPermissionBroker, RUNTIME_PROTOCOL_VERSION } from '@marshal/agent-runtime-core';
import {
  computeRuntimeExtensionIntegrity,
  RUNTIME_EXTENSION_CATALOG_SERVICE,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
} from '@marshal/agent-runtime-extensions';
import {
  RUNTIME_AUTHORED_UI_STATE_SERVICE,
  type RuntimeAuthoredUiStateService,
} from '@marshal/agent-runtime-ui';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; workspacePath: string; extensionsRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-host-composition-'));
  const workspacePath = path.join(root, 'workspace');
  const extensionsRoot = path.join(root, 'extensions');
  await fs.mkdir(workspacePath);
  await fs.mkdir(extensionsRoot);
  cleanup.push(root);
  return { root, workspacePath, extensionsRoot };
}

async function materializedPackage(
  root: string,
  identity: string,
  body = 'module.exports = { activate() { return {}; } };',
): Promise<string> {
  const packageRoot = path.join(root, identity.replace(/^@/, '').replace('/', '-'));
  await fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: identity,
    version: '1.0.0',
    type: 'commonjs',
    main: 'dist/index.cjs',
  }));
  await fs.writeFile(path.join(packageRoot, 'runtime-extension.json'), JSON.stringify({
    schemaVersion: 1,
    identity,
    version: '1.0.0',
    entrypoint: 'dist/index.cjs',
    moduleFormat: 'commonjs-bundle-v1',
  }));
  await fs.writeFile(path.join(packageRoot, 'dist', 'index.cjs'), body);
  return packageRoot;
}

async function declaredWorkspacePackage(
  root: string,
  relativeRoot: string,
  identity: string,
  built: boolean,
): Promise<string> {
  const packageRoot = path.join(root, ...relativeRoot.split('/'));
  await fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: identity,
    version: '1.0.0',
    type: 'commonjs',
    main: 'dist/index.cjs',
  }));
  await fs.writeFile(path.join(packageRoot, 'runtime-extension.json'), JSON.stringify({
    schemaVersion: 1,
    identity,
    version: '1.0.0',
    entrypoint: 'dist/index.cjs',
    moduleFormat: 'commonjs-bundle-v1',
  }));
  if (built) {
    await fs.writeFile(
      path.join(packageRoot, 'dist', 'index.cjs'),
      'module.exports = { activate() { return {}; } };',
    );
  }
  return packageRoot;
}

function hostOptions(
  location: Awaited<ReturnType<typeof workspace>>,
  overrides: Partial<AgentRuntimeHostOptions> = {},
): AgentRuntimeHostOptions {
  return {
    workspacePath: location.workspacePath,
    protectedLifecycleResultRoot: path.join(location.root, 'private'),
    permissionBroker: createAllowAllPermissionBroker(),
    loadDefaultProviders: false,
    ...overrides,
  } as AgentRuntimeHostOptions;
}

function authoredStateService(
  list: RuntimeAuthoredUiStateService['list'],
): RuntimeAuthoredUiStateService {
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected authored state operation.');
  };
  return {
    create: unavailable,
    migrate: unavailable,
    read: async () => undefined,
    list,
    update: unavailable,
    changeState: unavailable,
    readSnapshot: async () => undefined,
    remove: async () => false,
  };
}

describe('focused host composition regressions', () => {
  it('uses one injected container for provider sources and extension services', async () => {
    const location = await workspace();
    const serviceContainer = createRuntimeServiceContainer();
    let observed: unknown;
    const runtime = await createAgentRuntime({
      ...hostOptions(location),
      serviceContainer,
      providerSources: [
        (context) => {
          observed = context.serviceContainer;
          return [];
        },
      ],
      extensions: { allowedRoots: [location.extensionsRoot], restore: false },
    });

    expect(runtime.serviceContainer).toBe(serviceContainer);
    expect(observed).toBe(serviceContainer);
    expect(serviceContainer.getAll).toBeDefined();
    await runtime.dispose();
  });

  // TODO(#11): Wait for the debounced discovery refresh.
  it.skip('keeps the default extension root available for later clones unless explicitly disabled', async () => {
    const location = await workspace();
    await fs.rm(location.extensionsRoot, { recursive: true });
    const serviceContainer = createRuntimeServiceContainer();
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(location.root);
    const runtime = await createAgentRuntime({
      ...hostOptions(location),
      serviceContainer,
    });
    cwd.mockRestore();

    expect((await fs.stat(location.extensionsRoot)).isDirectory()).toBe(true);
    await materializedPackage(location.extensionsRoot, '@example/default');
    const catalog = serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE);
    await expect(catalog.discover({
      principal: { id: 'default-root-test', kind: 'agent' },
      scope: { workspaceId: 'workspace' },
    })).resolves.toMatchObject([{ id: '@example/default@1.0.0' }]);
    await runtime.dispose();

    const disabledContainer = createRuntimeServiceContainer();
    const disabled = await createAgentRuntime({
      ...hostOptions(location),
      serviceContainer: disabledContainer,
      extensions: false,
    });
    expect(disabledContainer.tryGet(RUNTIME_EXTENSION_CATALOG_SERVICE)).toBeUndefined();
    await disabled.dispose();
  });

  it('resolves authored UI state from the exact container at call time', async () => {
    const location = await workspace();
    const serviceContainer = createRuntimeServiceContainer();
    const firstList = vi.fn(async () => []);
    const secondList = vi.fn(async () => []);
    const initialBinding = await serviceContainer.bind(RUNTIME_AUTHORED_UI_STATE_SERVICE, {
      useValue: authoredStateService(firstList),
    });
    const runtime = await createAgentRuntime({
      ...hostOptions(location),
      serviceContainer,
      providerSources: [createRuntimeBuiltinsSource({ reactUi: {} })],
    });
    const request = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation' as const,
      target: 'ui.authored.list',
      input: {},
    };

    await expect(runtime.kernel.execute(request, { sessionId: 'authored-state-replacement' }))
      .resolves.toMatchObject({ status: 'success', result: { output: { applications: [] } } });
    expect(firstList).toHaveBeenCalledOnce();

    const replacement = await serviceContainer.replace(RUNTIME_AUTHORED_UI_STATE_SERVICE, {
      useValue: authoredStateService(secondList),
    });
    await expect(runtime.kernel.execute(request, { sessionId: 'authored-state-replacement' }))
      .resolves.toMatchObject({ status: 'success', result: { output: { applications: [] } } });
    expect(firstList).toHaveBeenCalledOnce();
    expect(secondList).toHaveBeenCalledOnce();

    await runtime.dispose();
    await replacement.dispose();
    await initialBinding.dispose();
    await serviceContainer.shutdown();
  });

  it('binds provider-source catalog entries before deferred native catalog activation', async () => {
    const location = await workspace();
    const packageRoot = await materializedPackage(location.extensionsRoot, '@example/native');
    let listed = false;
    const source = {
      id: 'test-authored',
      label: 'Test authored',
      order: -10,
      list: async () => {
        listed = true;
        return [{
          id: 'dsh-entry',
          identity: '@example/dsh',
          version: '1.0.0',
          origin: 'dsh' as const,
          title: 'DSH',
          description: 'Explicit DSH source',
          request: { packageRoot, integrity: computeRuntimeExtensionIntegrity(packageRoot) },
        }];
      },
    };
    const runtime = await createAgentRuntime({
      ...hostOptions(location),
      providerSources: [async () => ({ providers: [], catalogSources: [source] })],
      extensions: { allowedRoots: [location.extensionsRoot], restore: false },
    });

    await runtime.kernel.search({ query: '' }, { sessionId: 'composition' });
    expect(listed).toBe(true);
    await runtime.dispose();
  });

  it('keeps administration discovery separate from enabled-only runtime projections', async () => {
    const location = await workspace();
    const packageRoot = await materializedPackage(
      location.extensionsRoot,
      '@example/projection',
    );
    const serviceContainer = createRuntimeServiceContainer();
    const runtime = await createAgentRuntime({
      ...hostOptions(location),
      serviceContainer,
      codeIntelligence: false,
      extensions: { allowedRoots: [location.extensionsRoot], restore: false },
    });
    const context = {
      principal: { id: 'projection-test', kind: 'agent' as const },
      scope: { workspaceId: runtime.workspaceId },
    };
    const catalog = runtime.serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE);
    const lifecycle = runtime.serviceContainer.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE);
    const projectedIds = async () =>
      (await runtime.kernel.search(
        { query: '@example/projection' },
        { sessionId: 'projection-test' },
      )).discoveries?.map((entry) => entry.entry.id) ?? [];
    const extensionResources = async () =>
      (await runtime.resources!.listResources({ sessionId: 'projection-test' }))
        .filter((resource) => resource.uri.startsWith('runtime-extension:'));

    const discovered = await catalog.discover(context);
    expect(discovered).toMatchObject([{ id: '@example/projection@1.0.0' }]);
    expect(discovered[0]?.installation).toBeUndefined();
    await expect(projectedIds()).resolves.toEqual([]);
    await expect(extensionResources()).resolves.toEqual([]);

    await lifecycle.install({
      packageRoot,
      integrity: computeRuntimeExtensionIntegrity(packageRoot),
    }, { enabled: false });
    await expect(catalog.discover(context)).resolves.toMatchObject([{
      installation: { status: 'disabled' },
    }]);
    await expect(projectedIds()).resolves.toEqual([]);
    await expect(extensionResources()).resolves.toEqual([]);

    await lifecycle.enable('@example/projection');
    await expect(projectedIds()).resolves.toContain(
      'runtime-extension:@example/projection@1.0.0',
    );
    await expect(extensionResources()).resolves.toMatchObject([{
      uri: 'runtime-extension:@example/projection@1.0.0',
    }]);

    await lifecycle.disable('@example/projection');
    await expect(projectedIds()).resolves.toEqual([]);
    await expect(extensionResources()).resolves.toEqual([]);
    await expect(runtime.resources!.readResource(
      'runtime-extension:@example/projection@1.0.0',
      { sessionId: 'projection-test' },
    )).rejects.toThrow('not found');

    await lifecycle.remove('@example/projection');
    const afterRemoval = await catalog.discover(context);
    expect(afterRemoval).toMatchObject([{ id: '@example/projection@1.0.0' }]);
    expect(afterRemoval[0]?.installation).toBeUndefined();
    await expect(projectedIds()).resolves.toEqual([]);
    await runtime.dispose();
  });

  it('supplies reviewed Node builtins to native extensions and preserves host overrides', async () => {
    const location = await workspace();
    const packageRoot = await materializedPackage(
      location.extensionsRoot,
      '@example/node-builtins',
      `
const path = require('node:path');
const crypto = require('node:crypto');
if (path.basename('one/two') !== 'two' || crypto.source !== 'host-override') {
  throw new Error('Native extension module wiring is invalid.');
}
module.exports = { activate() { return {}; } };`,
    );
    const runtime = await createAgentRuntime({
      ...hostOptions(location),
      extensions: {
        allowedRoots: [location.extensionsRoot],
        restore: false,
        modules: { 'node:crypto': { source: 'host-override' } },
      },
    });

    await expect(runtime.serviceContainer.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE).install({
      packageRoot,
      integrity: computeRuntimeExtensionIntegrity(packageRoot),
    })).resolves.toMatchObject({
      identity: '@example/node-builtins',
      status: 'enabled',
    });
    await runtime.dispose();
  });

  it('rejects promotion without React UI and rolls back already-created bundles on failure', async () => {
    const location = await workspace();
    const disposed = vi.fn();
    const bundle: RuntimeHostProviderBundle = { providers: [], dispose: disposed };
    await expect(createAgentRuntime({
      ...hostOptions(location),
      providerSources: [
        async () => bundle,
        async () => {
          throw new Error('later factory failure');
        },
      ],
    })).rejects.toThrow('later factory failure');
    expect(disposed).toHaveBeenCalledOnce();

    await expect(createAgentRuntime({
      ...hostOptions(location),
      providerSources: [createRuntimeBuiltinsSource({ authoredUiPromotion: true })],
    })).rejects.toThrow('Authored UI promotion requires React UI capabilities.');
  });

  it('cancels native discovery before and during bounded enumeration', async () => {
    const location = await workspace();
    await materializedPackage(location.extensionsRoot, '@example/cancel');
    const source = createRuntimeNativeExtensionCatalogSource([location.extensionsRoot]);
    const controller = new AbortController();
    controller.abort();
    await expect(source.list({ principal: { id: 'a', kind: 'agent' }, scope: {} }, controller.signal))
      .rejects.toThrow('cancelled');
  });

  it('rejects native roots that exceed the direct-child enumeration bound', async () => {
    const location = await workspace();
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      fs.mkdir(path.join(location.extensionsRoot, `child-${index.toString().padStart(3, '0')}`))));
    const source = createRuntimeNativeExtensionCatalogSource([location.extensionsRoot]);

    await expect(source.list({ principal: { id: 'a', kind: 'agent' }, scope: {} }))
      .rejects.toThrow('more than 256 direct child directories');
  });

  it('discovers only built extension packages declared by a repository workspace', async () => {
    const location = await workspace();
    const repositoryRoot = path.join(location.extensionsRoot, 'agentic-browser');
    await fs.mkdir(repositoryRoot);
    await fs.writeFile(path.join(repositoryRoot, 'package.json'), JSON.stringify({
      name: 'agentic-browser',
      private: true,
      workspaces: [
        'packages/runtime-extension',
        'packages/unbuilt-extension',
      ],
    }));
    const builtRoot = await declaredWorkspacePackage(
      repositoryRoot,
      'packages/runtime-extension',
      '@example/browser-runtime',
      true,
    );
    await declaredWorkspacePackage(
      repositoryRoot,
      'packages/unbuilt-extension',
      '@example/unbuilt-runtime',
      false,
    );
    await declaredWorkspacePackage(
      repositoryRoot,
      'packages/undeclared-extension',
      '@example/undeclared-runtime',
      true,
    );

    const source = createRuntimeNativeExtensionCatalogSource([location.extensionsRoot]);
    const entries = await source.list({ principal: { id: 'a', kind: 'agent' }, scope: {} });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: '@example/browser-runtime@1.0.0',
      request: { packageRoot: await fs.realpath(builtRoot) },
    });
  });

  it('sorts validated native entries globally and deduplicates only identical integrity', async () => {
    const location = await workspace();
    await materializedPackage(location.extensionsRoot, '@example/zulu');
    await materializedPackage(location.extensionsRoot, '@example/alpha');
    const source = createRuntimeNativeExtensionCatalogSource([
      location.extensionsRoot,
      location.extensionsRoot,
    ]);
    const entries = await source.list({ principal: { id: 'a', kind: 'agent' }, scope: {} });
    expect(entries.map((entry) => entry.id)).toEqual([
      '@example/alpha@1.0.0',
      '@example/zulu@1.0.0',
    ]);
  });

  it('deduplicates overlapping canonical roots and ignores an absent optional root', async () => {
    const location = await workspace();
    const materializer = await createRuntimeHostMaterializer({
      allowedRoots: [location.extensionsRoot, location.extensionsRoot],
    });
    expect(materializer.allowedRoots).toEqual([await fs.realpath(location.extensionsRoot)]);

    const source = createRuntimeNativeExtensionCatalogSource([
      path.join(location.root, 'missing-extensions'),
    ]);
    await expect(source.list({ principal: { id: 'a', kind: 'agent' }, scope: {} }))
      .resolves.toEqual([]);
  });

  it('retains distinct integrity candidates for the same identity and version', async () => {
    const location = await workspace();
    const secondRoot = path.join(location.root, 'extensions-2');
    await fs.mkdir(secondRoot);
    await materializedPackage(location.extensionsRoot, '@example/conflict', 'module.exports = { activate() { return { one: 1 }; } };');
    await materializedPackage(secondRoot, '@example/conflict', 'module.exports = { activate() { return { two: 2 }; } };');
    const source = createRuntimeNativeExtensionCatalogSource([
      location.extensionsRoot,
      secondRoot,
    ]);
    const entries = await source.list({ principal: { id: 'a', kind: 'agent' }, scope: {} });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual([
      '@example/conflict@1.0.0',
      expect.stringMatching(/^@example\/conflict@1\.0\.0#[0-9a-f]{64}$/),
    ]);
  });
});
