import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentRuntime,
  createRuntimeNativeExtensionDiscoveryService,
  type RuntimeNativeExtensionDiscoveryService,
  type RuntimeNativeExtensionDiscoverySnapshot,
} from '../src/index.js';
import { createAllowAllPermissionBroker } from '@marshal/agent-runtime-core';
import {
  RUNTIME_EXTENSION_CATALOG_SERVICE,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
} from '@marshal/agent-runtime-extensions';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

async function location(): Promise<{
  root: string;
  workspacePath: string;
  extensionsRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-native-live-'));
  const workspacePath = path.join(root, 'workspace');
  const extensionsRoot = path.join(root, 'extensions');
  await Promise.all([
    fs.mkdir(workspacePath),
    fs.mkdir(extensionsRoot),
  ]);
  cleanup.push(root);
  return { root, workspacePath, extensionsRoot };
}

async function writeExtension(
  packageRoot: string,
  identity: string,
  options: {
    readonly built?: boolean;
    readonly manifest?: string;
    readonly body?: string;
    readonly installation?: {
      readonly script: string;
      readonly packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
    };
  } = {},
): Promise<void> {
  await fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: identity,
    version: '1.0.0',
    type: 'commonjs',
    main: 'dist/index.cjs',
  }));
  await fs.writeFile(
    path.join(packageRoot, 'runtime-extension.json'),
    options.manifest ?? JSON.stringify({
      schemaVersion: 1,
      identity,
      version: '1.0.0',
      entrypoint: 'dist/index.cjs',
      moduleFormat: 'commonjs-bundle-v1',
      ...(options.installation ? { installation: options.installation } : {}),
    }),
  );
  if (options.built !== false) {
    await fs.writeFile(
      path.join(packageRoot, 'dist', 'index.cjs'),
      options.body ?? 'module.exports = { activate() { return {}; } };',
    );
  }
}

async function publishExtension(
  root: string,
  identity: string,
  options: { readonly built?: boolean; readonly manifest?: string } = {},
): Promise<string> {
  const name = identity.replace(/^@/, '').replace('/', '-');
  const staging = path.join(path.dirname(root), `staging-${name}-${Date.now()}`);
  const target = path.join(root, name);
  await writeExtension(staging, identity, options);
  await fs.rename(staging, target);
  return target;
}

function waitForSnapshot(
  service: RuntimeNativeExtensionDiscoveryService,
  predicate: (snapshot: RuntimeNativeExtensionDiscoverySnapshot) => boolean,
  timeoutMs = 5_000,
): Promise<RuntimeNativeExtensionDiscoverySnapshot> {
  const current = service.snapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(
        `Timed out waiting for native extension discovery snapshot: ${
          JSON.stringify(service.snapshot())
        }`,
      ));
    }, timeoutMs);
    const subscription = service.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timeout);
      subscription.dispose();
      resolve(snapshot);
    });
  });
}

describe('runtime native extension live discovery', () => {
  it('projects the manifest displayName as the human catalog title', async () => {
    const test = await location();
    await writeExtension(path.join(test.extensionsRoot, 'code-review'), '@marshal/code-review', {
      manifest: JSON.stringify({
        schemaVersion: 1,
        identity: '@marshal/code-review',
        displayName: 'Pull Requests',
        version: '1.0.0',
        entrypoint: 'dist/index.cjs',
        moduleFormat: 'commonjs-bundle-v1',
      }),
    });
    const service = await createRuntimeNativeExtensionDiscoveryService({ roots: [test.extensionsRoot], watch: false });
    expect(service.snapshot().entries[0]).toMatchObject({ title: 'Pull Requests' });
  });

  it('publishes an immutable initial scan with installable and unbuilt candidates', async () => {
    const test = await location();
    await writeExtension(
      path.join(test.extensionsRoot, 'valid'),
      '@example/valid',
    );
    await writeExtension(
      path.join(test.extensionsRoot, 'unbuilt'),
      '@example/unbuilt',
      { built: false },
    );
    const service = await createRuntimeNativeExtensionDiscoveryService({
      roots: [test.extensionsRoot],
      watch: false,
    });

    const initial = service.snapshot();
    expect(initial).toMatchObject({
      revision: 1,
      status: 'ready',
      entries: [{ id: '@example/valid@1.0.0' }],
    });
    expect(initial.candidates.map(({ status, identity }) => ({ status, identity }))).toEqual([
      { status: 'unbuilt', identity: '@example/unbuilt' },
      { status: 'installable', identity: '@example/valid' },
    ]);
    expect(initial.candidates[0]?.diagnostics).toMatchObject([
      { code: 'entrypoint_missing' },
      { code: 'installation_missing' },
    ]);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.candidates)).toBe(true);
    expect(Object.isFrozen(initial.entries[0]?.request.integrity)).toBe(true);

    const revisions: number[] = [];
    const subscription = service.subscribe((snapshot) => revisions.push(snapshot.revision));
    await expect(service.refresh()).resolves.toMatchObject({ revision: 2, status: 'ready' });
    expect(revisions).toEqual([2]);
    subscription.dispose();
    await service.dispose();
  });

  it('exposes a validated installation declaration for an unbuilt candidate', async () => {
    const test = await location();
    await writeExtension(
      path.join(test.extensionsRoot, 'unbuilt'),
      '@example/unbuilt-installable',
      {
        built: false,
        installation: {
          script: 'marshal:install',
          packageManager: 'pnpm',
        },
      },
    );
    const service = await createRuntimeNativeExtensionDiscoveryService({
      roots: [test.extensionsRoot],
      watch: false,
    });

    expect(service.snapshot().entries).toEqual([]);
    expect(service.snapshot().candidates).toMatchObject([{
      status: 'unbuilt',
      identity: '@example/unbuilt-installable',
      version: '1.0.0',
      installation: {
        script: 'marshal:install',
        packageManager: 'pnpm',
      },
      diagnostics: [{ code: 'entrypoint_missing' }],
    }]);
    await service.dispose();
  });

  it('diagnoses an unbuilt candidate without a declared installation script', async () => {
    const test = await location();
    await writeExtension(
      path.join(test.extensionsRoot, 'unbuilt'),
      '@example/unbuilt-prebuilt-only',
      { built: false },
    );
    const service = await createRuntimeNativeExtensionDiscoveryService({
      roots: [test.extensionsRoot],
      watch: false,
    });

    expect(service.snapshot().candidates).toMatchObject([{
      status: 'unbuilt',
      identity: '@example/unbuilt-prebuilt-only',
      diagnostics: [
        { code: 'entrypoint_missing' },
        { code: 'installation_missing' },
      ],
    }]);
    expect(service.snapshot().candidates[0]).not.toHaveProperty('installation');
    await service.dispose();
  });

  it('rescans when a valid folder is created after startup', async () => {
    const test = await location();
    const service = await createRuntimeNativeExtensionDiscoveryService({
      roots: [test.extensionsRoot],
      debounceMs: 30,
    });

    await publishExtension(test.extensionsRoot, '@example/created');
    const snapshot = await waitForSnapshot(
      service,
      (candidate) => candidate.entries.some((entry) => entry.id === '@example/created@1.0.0'),
    );

    expect(snapshot.revision).toBeGreaterThan(1);
    expect(snapshot.candidates).toMatchObject([{
      status: 'installable',
      identity: '@example/created',
    }]);
    await service.dispose();
  });

  it('detects a configured root created after host startup without reacting to siblings', async () => {
    const test = await location();
    const approvedRoot = path.join(test.root, 'approved');
    const lateRoot = path.join(approvedRoot, 'extensions');
    await fs.mkdir(approvedRoot);
    const runtime = await createAgentRuntime({
      workspacePath: test.workspacePath,
      protectedLifecycleResultRoot: path.join(test.root, 'private'),
      permissionBroker: createAllowAllPermissionBroker(),
      codeIntelligence: false,
      providerSources: [],
      extensions: {
        allowedRoots: [approvedRoot],
        discoveryRoots: [lateRoot],
        restore: false,
      },
    });
    const discovery = runtime.extensionDiscovery!;
    expect(discovery.snapshot()).toMatchObject({ roots: [], entries: [] });
    const initialRevision = discovery.snapshot().revision;

    await fs.mkdir(path.join(approvedRoot, 'unrelated'));
    await fs.writeFile(path.join(approvedRoot, 'unrelated', 'noise.txt'), 'noise');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(discovery.snapshot().revision).toBe(initialRevision);

    const staging = path.join(approvedRoot, 'staging');
    await fs.mkdir(staging);
    await writeExtension(path.join(staging, 'late'), '@example/late-root');
    await fs.rename(staging, lateRoot);
    const snapshot = await waitForSnapshot(
      discovery,
      (candidate) =>
        candidate.entries.some((entry) => entry.id === '@example/late-root@1.0.0'),
    );

    expect(snapshot.roots).toEqual([await fs.realpath(lateRoot)]);
    const catalog = runtime.serviceContainer.get(
      RUNTIME_EXTENSION_CATALOG_SERVICE,
    );
    await expect(catalog.discover({
      principal: { id: 'late-root-test', kind: 'agent' },
      scope: { workspaceId: 'workspace' },
    })).resolves.toMatchObject([{ id: '@example/late-root@1.0.0' }]);
    await runtime.dispose();
  });

  it('makes an invalid manifest visible without adding an installable entry', async () => {
    const test = await location();
    await writeExtension(
      path.join(test.extensionsRoot, 'invalid'),
      '@example/invalid',
      { manifest: '{"schemaVersion":1,' },
    );
    const service = await createRuntimeNativeExtensionDiscoveryService({
      roots: [test.extensionsRoot],
      watch: false,
    });

    expect(service.snapshot().entries).toEqual([]);
    expect(service.snapshot().candidates).toMatchObject([{
      status: 'invalid',
      diagnostics: [{ code: 'manifest_invalid' }],
    }]);
    await service.dispose();
  });

  // TODO(#11): Flaky uncaught ENOTDIR from the Node recursive watcher.
  it.skip('recovers when a watched root is replaced and later repaired', async () => {
    const test = await location();
    const service = await createRuntimeNativeExtensionDiscoveryService({
      roots: [test.extensionsRoot],
      debounceMs: 30,
    });

    await fs.rm(test.extensionsRoot, { recursive: true });
    await fs.writeFile(test.extensionsRoot, 'not a directory');
    await waitForSnapshot(service, (snapshot) => snapshot.status === 'error');

    const replacement = path.join(test.root, 'replacement');
    await fs.mkdir(replacement);
    await writeExtension(
      path.join(replacement, 'recovered'),
      '@example/recovered',
    );
    await fs.rm(test.extensionsRoot);
    await fs.rename(replacement, test.extensionsRoot);
    const recovered = await waitForSnapshot(
      service,
      (snapshot) =>
        snapshot.status === 'ready'
        && snapshot.entries.some((entry) => entry.id === '@example/recovered@1.0.0'),
    );

    expect(recovered.revision).toBeGreaterThan(2);
    await service.dispose();
  });

  it('uses one stable catalog ID for duplicate package integrity candidates', async () => {
    const test = await location();
    await writeExtension(
      path.join(test.extensionsRoot, 'first'),
      '@example/duplicate',
      { body: 'module.exports = { activate() { return { variant: 1 }; } };' },
    );
    await writeExtension(
      path.join(test.extensionsRoot, 'second'),
      '@example/duplicate',
      { body: 'module.exports = { activate() { return { variant: 2 }; } };' },
    );
    await writeExtension(
      path.join(test.extensionsRoot, 'third'),
      '@example/duplicate',
      { body: 'module.exports = { activate() { return { variant: 2 }; } };' },
    );
    const service = await createRuntimeNativeExtensionDiscoveryService({
      roots: [test.extensionsRoot],
      watch: false,
    });

    const installable = service.snapshot().candidates
      .filter((candidate) => candidate.status === 'installable');
    expect(service.snapshot().entries).toHaveLength(2);
    expect(installable).toHaveLength(3);
    expect(installable[1]?.catalogEntry.id).toMatch(
      /^@example\/duplicate@1\.0\.0#[0-9a-f]{64}$/,
    );
    expect(installable[2]?.catalogEntry.id).toBe(installable[1]?.catalogEntry.id);
    expect(installable[2]?.catalogEntry.request.integrity).toEqual(
      installable[1]?.catalogEntry.request.integrity,
    );
    await service.dispose();
  });

  it('debounces filesystem event storms into one rescan', async () => {
    const test = await location();
    const service = await createRuntimeNativeExtensionDiscoveryService({
      roots: [test.extensionsRoot],
      debounceMs: 150,
    });
    const stormRoot = path.join(test.extensionsRoot, 'storm');
    await fs.mkdir(stormRoot);
    await Promise.all(Array.from({ length: 32 }, (_, index) =>
      fs.writeFile(path.join(stormRoot, `event-${index}.txt`), `${index}`)));

    await waitForSnapshot(service, (snapshot) => snapshot.revision >= 2);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(service.snapshot().revision).toBe(2);
    await service.dispose();
  });

  it('stops watching and rejects refresh after disposal', async () => {
    const test = await location();
    const service = await createRuntimeNativeExtensionDiscoveryService({
      roots: [test.extensionsRoot],
      debounceMs: 30,
    });
    const listener = vi.fn();
    service.subscribe(listener);
    const before = service.snapshot();
    await service.dispose();

    await publishExtension(test.extensionsRoot, '@example/after-dispose');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.snapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    await expect(service.refresh()).rejects.toThrow('disposed');
  });

  it('exposes host live status without installing, enabling, updating, or executing extensions', async () => {
    const test = await location();
    const runtime = await createAgentRuntime({
      workspacePath: test.workspacePath,
      protectedLifecycleResultRoot: path.join(test.root, 'private'),
      permissionBroker: createAllowAllPermissionBroker(),
      codeIntelligence: false,
      providerSources: [],
      extensions: {
        allowedRoots: [test.extensionsRoot],
        discoveryRoots: [test.extensionsRoot],
        restore: false,
      },
    });
    const discovery = runtime.extensionDiscovery;
    expect(discovery).toBeDefined();
    const lifecycle = runtime.serviceContainer.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE);
    const install = vi.spyOn(lifecycle, 'install');
    const update = vi.spyOn(lifecycle, 'update');
    const configure = vi.spyOn(lifecycle, 'configure');
    const enable = vi.spyOn(lifecycle, 'enable');
    const disable = vi.spyOn(lifecycle, 'disable');
    const remove = vi.spyOn(lifecycle, 'remove');

    await publishExtension(test.extensionsRoot, '@example/status-only');
    await waitForSnapshot(
      discovery!,
      (snapshot) => snapshot.entries.some((entry) => entry.id === '@example/status-only@1.0.0'),
    );

    expect(lifecycle.list()).toEqual([]);
    expect(install).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await runtime.dispose();
    await expect(discovery!.refresh()).rejects.toThrow('disposed');
  });
});
