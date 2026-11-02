import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAllowAllPermissionBroker,
  createRuntimeKernel,
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import {
  computeRuntimeExtensionIntegrity,
  createNodeBuiltinModuleMap,
  LocalRuntimeExtensionPackageLoader,
  RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
  RUNTIME_EXTENSION_MANIFEST_FILENAME,
  RuntimeExtensionManager,
  RuntimeExtensionPackageError,
  type RuntimeExtensionInstallRequest,
} from '../src/index.js';

const context: InvocationContext = {
  principal: { id: 'extension-test', kind: 'agent' },
  scope: { workspaceId: 'workspace-1' },
};
const tempRoots: string[] = [];

afterEach(() => {
  for (const key of [
    '__runtimeExtensionDisposedOne',
    '__runtimeExtensionDisposedTwo',
    '__runtimeExtensionRollbackDisposed',
    '__runtimeExtensionUpdatedDisposed',
    '__runtimeExtensionCancelledDisposed',
  ]) {
    Reflect.deleteProperty(globalThis, key);
  }
  for (const root of tempRoots.splice(0).reverse()) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('RuntimeExtensionManager', () => {
  it('installs into a live kernel and exposes search and invocation immediately', async () => {
    const fixture = packageFixture({
      identity: '@example/live',
      version: '1.0.0',
      providerId: 'example.live',
      capability: 'example.live.echo',
      value: 'live-v1',
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    kernel.register(providerSource('baseline.provider', 'baseline.echo', 'baseline'));
    const manager = managerFor(kernel, fixture.allowedRoot);

    await manager.install(fixture.request);

    expect((await kernel.get('example.live.echo', context))?.provider.id).toBe(
      'example.live',
    );
    expect((await kernel.get('baseline.echo', context))?.provider.id).toBe(
      'baseline.provider',
    );
    await expect(kernel.execute({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation',
      target: 'example.live.echo',
      input: {},
    }, context)).resolves.toMatchObject({
      status: 'success',
      result: { output: { value: 'live-v1' } },
    });
  });

  it('keeps the previous active version after activation or registration failure', async () => {
    const first = packageFixture({
      identity: '@example/rollback',
      version: '1.0.0',
      providerId: 'example.rollback',
      capability: 'example.rollback.echo',
      value: 'old',
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    kernel.register(providerSource('reserved.provider', 'reserved.echo', 'reserved'));
    const manager = managerFor(kernel, first.allowedRoot);
    await manager.install(first.request);

    const activationFailure = packageFixture({
      allowedRoot: first.allowedRoot,
      identity: '@example/rollback',
      version: '2.0.0',
      source: `module.exports = { activate() { throw new Error('activation failed'); } };`,
    });
    await expect(manager.update('@example/rollback', activationFailure.request))
      .rejects.toMatchObject({ code: 'ACTIVATION_FAILED' });
    expect(await invokeValue(kernel, 'example.rollback.echo')).toBe('old');

    const registrationFailure = packageFixture({
      allowedRoot: first.allowedRoot,
      identity: '@example/rollback',
      version: '2.1.0',
      providerId: 'example.rollback.next',
      capability: 'reserved.echo',
      value: 'conflict',
      disposeGlobal: '__runtimeExtensionRollbackDisposed',
    });
    await expect(manager.update('@example/rollback', registrationFailure.request))
      .rejects.toMatchObject({ code: 'REGISTRATION_FAILED' });
    expect(await invokeValue(kernel, 'example.rollback.echo')).toBe('old');
    expect(Reflect.get(globalThis, '__runtimeExtensionRollbackDisposed')).toBe(1);
    expect(manager.get('@example/rollback')?.version).toBe('1.0.0');
  });

  it('updates without stale registrations and disposes the previous activation', async () => {
    const first = packageFixture({
      identity: '@example/update',
      version: '1.0.0',
      providerId: 'example.update',
      capability: 'example.update.old',
      value: 'old',
      disposeGlobal: '__runtimeExtensionUpdatedDisposed',
    });
    const second = packageFixture({
      allowedRoot: first.allowedRoot,
      identity: '@example/update',
      version: '2.0.0',
      providerId: 'example.update',
      capability: 'example.update.new',
      value: 'new',
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = managerFor(kernel, first.allowedRoot);
    await manager.install(first.request);

    await manager.update('@example/update', second.request);

    expect(await kernel.get('example.update.old', context)).toBeUndefined();
    expect(await invokeValue(kernel, 'example.update.new')).toBe('new');
    expect(Reflect.get(globalThis, '__runtimeExtensionUpdatedDisposed')).toBe(1);
    expect(manager.get('@example/update')).toMatchObject({
      version: '2.0.0',
      status: 'enabled',
    });
  });

  it('disables and removes only owned registrations and cleanup', async () => {
    const one = packageFixture({
      identity: '@example/one',
      version: '1.0.0',
      providerId: 'example.one',
      capability: 'example.one.echo',
      value: 'one',
      disposeGlobal: '__runtimeExtensionDisposedOne',
    });
    const two = packageFixture({
      allowedRoot: one.allowedRoot,
      identity: '@example/two',
      version: '1.0.0',
      providerId: 'example.two',
      capability: 'example.two.echo',
      value: 'two',
      disposeGlobal: '__runtimeExtensionDisposedTwo',
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = managerFor(kernel, one.allowedRoot);
    await manager.install(one.request);
    await manager.install(two.request);

    await manager.disable('@example/one');
    expect(await kernel.get('example.one.echo', context)).toBeUndefined();
    expect(await invokeValue(kernel, 'example.two.echo')).toBe('two');
    expect(Reflect.get(globalThis, '__runtimeExtensionDisposedOne')).toBe(1);

    await manager.remove('@example/one');
    expect(manager.get('@example/one')).toBeUndefined();
    expect(Reflect.get(globalThis, '__runtimeExtensionDisposedOne')).toBe(1);
    await manager.remove('@example/two');
    expect(await kernel.list(context)).toEqual([]);
    expect(Reflect.get(globalThis, '__runtimeExtensionDisposedTwo')).toBe(1);
  });

  it('registers live resources and validated UI applications without stale search', async () => {
    const fixture = packageFixture({
      identity: '@example/ui',
      version: '1.0.0',
      source: String.raw`
module.exports = {
  activate() {
    const guide = {
      listResources() {
        return [{
          uri: 'resource://example/guide',
          name: 'Example extension guide',
          description: 'Live extension resource guide.',
          mimeType: 'text/markdown'
        }];
      },
      readResource(uri) {
        return { uri, mimeType: 'text/markdown', text: '# Extension guide' };
      }
    };
    return {
      resourceProviders: [guide],
      uiApplications: [{
        id: 'dashboard',
        title: 'Example dashboard',
        description: 'Live extension dashboard.',
        renderId: 'example-dashboard',
        resource: {
          uri: 'ui://example/dashboard/index.html',
          mimeType: 'text/html',
          text: '<main>dashboard</main>'
        },
        application: {
          version: '1.0.0',
          presentationModes: ['inline'],
          actions: [],
          tools: []
        }
      }]
    };
  }
};`,
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = managerFor(kernel, fixture.allowedRoot);
    await manager.install(fixture.request);

    const search = await kernel.search({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: 'extension dashboard guide',
      limit: 10,
    }, context);
    expect(search.discoveries?.map(({ entry }) => entry.kind).sort()).toEqual([
      'resource',
      'resource',
      'ui_application',
    ]);
    expect((await manager.resources.listResources(context)).map(({ uri }) => uri)).toEqual([
      'resource://example/guide',
      'ui://example/dashboard/index.html',
    ]);
    await expect(manager.resources.readResource(
      'ui://example/dashboard/index.html',
      context,
    )).resolves.toMatchObject({ text: '<main>dashboard</main>' });

    await manager.disable('@example/ui');
    expect(await manager.resources.listResources(context)).toEqual([]);
    const afterDisable = await kernel.search({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: 'extension dashboard guide',
    }, context);
    expect(afterDisable.discoveries).toBeUndefined();
  });

  it('wires UI placement contributions to existing applications for the active lifecycle', async () => {
    const fixture = packageFixture({
      identity: '@example/placed-ui',
      version: '1.0.0',
      source: placedUiModule('sidebar', 'fallback'),
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = new RuntimeExtensionManager({
      kernel,
      loader: new LocalRuntimeExtensionPackageLoader({
        allowedRoots: [fixture.allowedRoot],
      }),
      activationContext: context,
      uiPlacementDefinitions: [{
        placementId: 'marshal.shell.sidebar',
        metadata: {
          title: 'Sidebar',
          hasHostContent: false,
          supportedActions: ['replace', 'augment', 'fallback'],
        },
      }],
    });

    await manager.install(fixture.request);

    expect(manager.uiPlacements.resolve('marshal.shell.sidebar')).toMatchObject({
      mode: 'fallback',
      registrations: [{
        extensionId: '@example/placed-ui',
        applicationId: 'sidebar',
        action: 'fallback',
      }],
    });
    expect(manager.uiPlacements.listContributions('@example/placed-ui')).toHaveLength(1);

    await manager.disable('@example/placed-ui');
    expect(manager.uiPlacements.resolve('marshal.shell.sidebar')).toMatchObject({
      mode: 'empty',
      registrations: [],
    });
  });

  it('records a placement collision as a disabled extension without publishing it', async () => {
    const first = packageFixture({
      identity: '@example/placed-one',
      version: '1.0.0',
      source: placedUiModule('first', 'replace'),
    });
    const second = packageFixture({
      allowedRoot: first.allowedRoot,
      identity: '@example/placed-two',
      version: '1.0.0',
      source: placedUiModule('second', 'replace'),
    });
    const kernel = createRuntimeKernel({
      permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = new RuntimeExtensionManager({
      kernel,
      loader: new LocalRuntimeExtensionPackageLoader({
        allowedRoots: [first.allowedRoot],
      }),
      activationContext: context,
      uiPlacementDefinitions: [{
        placementId: 'marshal.shell',
        metadata: {
          title: 'Marshal shell',
          supportedActions: ['replace'],
        },
      }],
    });
    await manager.install(first.request);

    await expect(manager.install(second.request)).resolves.toMatchObject({
      identity: '@example/placed-two',
      status: 'disabled',
      blockReasons: [
        { code: 'DISABLED' },
        { code: 'ACTIVATION_FAILED', message: expect.stringContaining('marshal.shell') },
      ],
    });
    expect(manager.list().map(({ identity, status }) => [identity, status])).toEqual([
      ['@example/placed-one', 'enabled'],
      ['@example/placed-two', 'disabled'],
    ]);

    expect(manager.uiPlacements.resolve('marshal.shell')).toMatchObject({
      mode: 'replace',
      registrations: [{ extensionId: '@example/placed-one' }],
    });
  });

  it('cancels activation without publishing contributions', async () => {
    const fixture = packageFixture({
      identity: '@example/cancelled',
      version: '1.0.0',
      source: String.raw`
module.exports = {
  activate(context) {
    context.signal.aborted = true;
    return {
      capabilityProviders: [{
        id: 'example.cancelled',
        list() { return []; },
        invoke() { return { output: {} }; }
      }],
      dispose() {
        globalThis.__runtimeExtensionCancelledDisposed =
          (globalThis.__runtimeExtensionCancelledDisposed || 0) + 1;
      }
    };
  }
};`,
   });
   const retry = packageFixture({
     allowedRoot: fixture.allowedRoot,
     identity: '@example/cancelled',
     version: '1.0.0',
     providerId: 'example.cancelled.retry',
     capability: 'example.cancelled.retry',
   });
   const signal = { aborted: false, reason: undefined };
   const kernel = createRuntimeKernel({
     permissionBroker: createAllowAllPermissionBroker(),
    });
    const manager = managerFor(kernel, fixture.allowedRoot);

    await expect(manager.install(fixture.request, { signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await kernel.list(context)).toEqual([]);
    expect(manager.list()).toEqual([]);
    expect(Reflect.get(globalThis, '__runtimeExtensionCancelledDisposed')).toBe(1);

    await expect(manager.install(retry.request)).resolves.toMatchObject({
      identity: '@example/cancelled',
      status: 'enabled',
    });
    expect((await kernel.get('example.cancelled.retry', context))?.provider.id)
      .toBe('example.cancelled.retry');
  });
});

describe('LocalRuntimeExtensionPackageLoader', () => {
  it('hashes package content while excluding clone and installed dependency trees', () => {
    const fixture = packageFixture({
      identity: '@example/cloned',
      version: '1.0.0',
    });
    const original = fixture.request.integrity;
    fs.mkdirSync(path.join(fixture.packageRoot, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(fixture.packageRoot, '.git', 'objects', 'development'), 'ignored');
    fs.mkdirSync(path.join(fixture.packageRoot, 'node_modules', 'dependency'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fixture.packageRoot, 'node_modules', 'dependency', 'index.js'),
      'module.exports = "ignored";',
    );

    expect(computeRuntimeExtensionIntegrity(fixture.packageRoot)).toEqual(original);

    fs.appendFileSync(path.join(fixture.packageRoot, 'dist', 'index.cjs'), '\n// changed');
    expect(computeRuntimeExtensionIntegrity(fixture.packageRoot).value).not.toBe(original.value);
    expectPackageCode(
      () => new LocalRuntimeExtensionPackageLoader({
        allowedRoots: [fixture.allowedRoot],
      }).load(fixture.request),
      'INTEGRITY_MISMATCH',
    );

    const excludedEntrypoint = packageFixture({
      identity: '@example/excluded-entrypoint',
      version: '1.0.0',
      entrypoint: 'node_modules/extension/index.cjs',
    });
    expectPackageCode(
      () => new LocalRuntimeExtensionPackageLoader({
        allowedRoots: [excludedEntrypoint.allowedRoot],
      }).load(excludedEntrypoint.request),
      'INVALID_ENTRYPOINT',
    );
  });

  it('rejects roots, integrity, manifests, paths, and symlink escapes precisely', () => {
    const allowedRoot = temporaryDirectory('runtime-extension-allowed-');
    const outside = packageFixture({
      identity: '@example/outside',
      version: '1.0.0',
    });
    const loader = new LocalRuntimeExtensionPackageLoader({ allowedRoots: [allowedRoot] });
    expectPackageCode(() => loader.load(outside.request), 'ROOT_NOT_ALLOWED');

    const valid = packageFixture({
      allowedRoot,
      identity: '@example/valid',
      version: '1.0.0',
    });
    expectPackageCode(() => loader.load({
      ...valid.request,
      integrity: {
        algorithm: 'sha256',
        domain: RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
        value: '0'.repeat(64),
      },
    }), 'INTEGRITY_MISMATCH');

    const invalidManifest = packageFixture({
      allowedRoot,
      identity: '@example/invalid',
      version: '1.0.0',
      manifest: { identity: '@Example/Invalid' },
    });
    expectPackageCode(() => loader.load(invalidManifest.request), 'INVALID_MANIFEST');

    const traversal = packageFixture({
      allowedRoot,
      identity: '@example/traversal',
      version: '1.0.0',
      entrypoint: '../outside.cjs',
    });
    expectPackageCode(() => loader.load(traversal.request), 'INVALID_MANIFEST');

    const linked = packageFixture({
      allowedRoot,
      identity: '@example/linked',
      version: '1.0.0',
    });
    const outsideFile = path.join(temporaryDirectory('runtime-extension-link-target-'), 'secret.cjs');
    fs.writeFileSync(outsideFile, 'module.exports = {};');
    const linkPath = path.join(linked.packageRoot, 'linked.cjs');
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch (error) {
      if (isLinkUnavailable(error)) return;
      throw error;
    }
    expectPackageCode(() => loader.load({
      packageRoot: linked.packageRoot,
      integrity: {
        algorithm: 'sha256',
        domain: RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
        value: '0'.repeat(64),
      },
    }), 'UNSAFE_PACKAGE_TREE');
  });

  it('allows only explicitly injected entrypoint dependencies', () => {
    const fixture = packageFixture({
      identity: '@example/dependency',
      version: '1.0.0',
      source: `
const dependency = require('@example/runtime-api');
module.exports = { activate() { return dependency.activation; } };`,
    });
    const denied = new LocalRuntimeExtensionPackageLoader({
      allowedRoots: [fixture.allowedRoot],
    });
    expectPackageCode(
      () => denied.load(fixture.request),
      'UNSUPPORTED_MODULE_DEPENDENCY',
    );

    const activation = { capabilityProviders: [] };
    const allowed = new LocalRuntimeExtensionPackageLoader({
      allowedRoots: [fixture.allowedRoot],
      modules: { '@example/runtime-api': { activation } },
    });
    expect(allowed.load(fixture.request).module.activate({
      manifest: allowed.load(fixture.request).metadata.manifest,
      search: async () => {
        throw new Error('not used');
      },
      execute: async () => {
        throw new Error('not used');
      },
    })).toBe(activation);

    const relative = packageFixture({
      identity: '@example/relative-dependency',
      version: '1.0.0',
      source: `
require('./sibling.cjs');
module.exports = { activate() { return {}; } };`,
    });
    fs.writeFileSync(path.join(relative.packageRoot, 'dist', 'sibling.cjs'), 'module.exports = {};');
    const relativeRequest = {
      ...relative.request,
      integrity: computeRuntimeExtensionIntegrity(relative.packageRoot),
    };
    expectPackageCode(
      () => new LocalRuntimeExtensionPackageLoader({
        allowedRoots: [relative.allowedRoot],
      }).load(relativeRequest),
      'UNSUPPORTED_MODULE_DEPENDENCY',
    );
  });

  it('loads the reviewed Node builtins from an explicit lazy host module map', () => {
    const fixture = packageFixture({
      identity: '@example/node-builtins',
      version: '1.0.0',
      source: `
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const sqlite = require('node:sqlite');
const hooks = require('node:async_hooks');
const override = require('@example/override');
module.exports = {
  activate() {
    return {
      fs: typeof fs.readFileSync,
      path: path.basename('one/two'),
      crypto: typeof crypto.createHash,
      sqlite: typeof sqlite.DatabaseSync,
      asyncLocalStorage: typeof hooks.AsyncLocalStorage,
      override: override.value
    };
  }
};`,
    });
    const modules = createNodeBuiltinModuleMap({
      '@example/override': { value: 'host' },
    });
    expect(Object.keys(modules).sort()).toEqual([
      '@example/override',
      'buffer',
      'events',
      'fs',
      'http',
      'https',
      'node:async_hooks',
      'node:child_process',
      'node:crypto',
      'node:fs/promises',
      'node:os',
      'node:path',
      'node:sqlite',
      'node:url',
      'node:util',
      'os',
      'path',
      'stream',
      'tty',
      'url',
      'util',
      'zlib',
    ].sort());
    const loaded = new LocalRuntimeExtensionPackageLoader({
      allowedRoots: [fixture.allowedRoot],
      modules,
    }).load(fixture.request);

    expect(loaded.module.activate({
      manifest: loaded.metadata.manifest,
      search: async () => {
        throw new Error('not used');
      },
      execute: async () => {
        throw new Error('not used');
      },
    })).toEqual({
      fs: 'function',
      path: 'two',
      crypto: 'function',
      sqlite: 'function',
      asyncLocalStorage: 'function',
      override: 'host',
    });
  });
});

interface PackageFixtureOptions {
  readonly allowedRoot?: string;
  readonly identity: string;
  readonly version: string;
  readonly providerId?: string;
  readonly capability?: string;
  readonly value?: string;
  readonly disposeGlobal?: string;
  readonly source?: string;
  readonly entrypoint?: string;
  readonly manifest?: Readonly<Record<string, unknown>>;
}

function packageFixture(options: PackageFixtureOptions): {
  readonly allowedRoot: string;
  readonly packageRoot: string;
  readonly request: RuntimeExtensionInstallRequest;
} {
  const allowedRoot = options.allowedRoot ?? temporaryDirectory('runtime-extension-root-');
  const packageRoot = fs.mkdtempSync(path.join(allowedRoot, 'package-'));
  const entrypoint = options.entrypoint ?? 'dist/index.cjs';
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    identity: options.identity,
    version: options.version,
    entrypoint,
    moduleFormat: 'commonjs-bundle-v1',
    ...(options.manifest ?? {}),
  };
  fs.writeFileSync(
    path.join(packageRoot, RUNTIME_EXTENSION_MANIFEST_FILENAME),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: options.identity,
    version: options.version,
    type: 'commonjs',
    main: entrypoint,
  }));
  if (!entrypoint.startsWith('../')) {
    const entrypointPath = path.join(packageRoot, ...entrypoint.split('/'));
    fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
    fs.writeFileSync(entrypointPath, options.source ?? providerModule(options));
  }
  return {
    allowedRoot,
    packageRoot,
    request: {
      packageRoot,
      integrity: computeRuntimeExtensionIntegrity(packageRoot),
    },
  };
}

function providerModule(options: PackageFixtureOptions): string {
  const dispose = options.disposeGlobal
    ? `dispose() { globalThis[${JSON.stringify(options.disposeGlobal)}] = (globalThis[${JSON.stringify(options.disposeGlobal)}] || 0) + 1; }`
    : '';
  return `
module.exports = {
  activate(context) {
    return {
      capabilityProviders: [{
        id: ${JSON.stringify(options.providerId ?? 'example.default')},
        version: context.manifest.version,
        list() {
          return [{
            protocolVersion: '1.0.0',
            name: ${JSON.stringify(options.capability ?? 'example.default.echo')},
            version: context.manifest.version,
            description: 'Extension test capability.',
            tags: ['extension', 'test'],
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            outputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false
            }
          }];
        },
        invoke() { return { output: { value: ${JSON.stringify(options.value ?? 'ok')} } }; }
      }],
      ${dispose}
    };
  }
};`;
}

function placedUiModule(
  applicationId: string,
  action: 'replace' | 'augment' | 'fallback',
): string {
  return String.raw`
module.exports = {
  activate() {
    return {
      uiApplications: [{
        id: ${JSON.stringify(applicationId)},
        title: 'Placed UI',
        description: 'Placed extension UI.',
        renderId: ${JSON.stringify(`render-${applicationId}`)},
        resource: {
          uri: ${JSON.stringify(`ui://example/${applicationId}/index.html`)},
          mimeType: 'text/html',
          text: '<main>placed</main>'
        },
        application: {
          version: '1.0.0',
          presentationModes: ['inline'],
          actions: [],
          tools: []
        }
      }],
      uiPlacements: [{
        placementId: ${JSON.stringify(
          action === 'fallback' ? 'marshal.shell.sidebar' : 'marshal.shell',
        )},
        action: ${JSON.stringify(action)},
        applicationId: ${JSON.stringify(applicationId)}
      }]
    };
  }
};`;
}

function managerFor(
  kernel: ReturnType<typeof createRuntimeKernel>,
  allowedRoot: string,
): RuntimeExtensionManager {
  return new RuntimeExtensionManager({
    kernel,
    loader: new LocalRuntimeExtensionPackageLoader({ allowedRoots: [allowedRoot] }),
    activationContext: context,
  });
}

function providerSource(id: string, capability: string, value: string) {
  return {
    id,
    list: () => [{
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name: capability,
      version: '1.0.0',
      description: 'Baseline provider.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    }],
    invoke: async () => ({ output: { value } }),
  };
}

async function invokeValue(
  kernel: ReturnType<typeof createRuntimeKernel>,
  capability: string,
): Promise<string | undefined> {
  const response = await kernel.execute<{ value: string }>({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    targetType: 'operation',
    target: capability,
    input: {},
  }, context);
  return response.result?.output.value;
}

function expectPackageCode(
  action: () => unknown,
  code: RuntimeExtensionPackageError['code'],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeExtensionPackageError);
    expect((error as RuntimeExtensionPackageError).code).toBe(code);
    return;
  }
  throw new Error(`Expected RuntimeExtensionPackageError(${code}).`);
}

function temporaryDirectory(prefix: string): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function isLinkUnavailable(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))
  );
}
