import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseCodexExtensionInstallerArgs,
} from '../extensionInstaller.js';
import {
  computeRuntimeExtensionIntegrity,
  LocalRuntimeExtensionPackageLoader,
  RuntimeExtensionManager,
  validateRuntimeExtensionManifest,
} from '@marshal/runtime/extensions';
import { createAllowAllPermissionBroker, createRuntimeKernel } from '@marshal/runtime/core';
import {
  materializeRuntimeExtensionPackage,
  publishMaterializedPackage,
} from '../extensionInstaller.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))));
});

describe('generic Codex extension installer materialization', () => {
  it('omits development directories, publishes atomically, and is idempotent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'marshal-extension-cli-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source');
    const destinationRoot = path.join(root, 'installed');
    await mkdir(path.join(source, 'dist'), { recursive: true });
    await mkdir(path.join(source, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: '@test/fixture-extension',
      version: '1.0.0',
      type: 'commonjs',
      main: 'index.cjs',
      files: ['dist'],
    }));
    const manifest = validateRuntimeExtensionManifest({
      schemaVersion: 1,
      identity: '@test/fixture-extension',
      version: '1.0.0',
      entrypoint: 'index.cjs',
      moduleFormat: 'commonjs-bundle-v1',
    });
    await writeFile(path.join(source, 'runtime-extension.json'), JSON.stringify(manifest));
    await writeFile(path.join(source, 'index.cjs'), 'module.exports = { activate() { return {}; } };');
    await writeFile(path.join(source, 'dist', 'extra.cjs'), 'module.exports = 1;');
    await writeFile(path.join(source, 'node_modules', 'ignored', 'index.js'), 'ignored');
    await symlink(path.join(source, 'node_modules', 'ignored'), path.join(source, 'linked-node-modules'));

    const staging = await materializeRuntimeExtensionPackage(source, manifest, destinationRoot);
    const integrity = 'fixture-digest';
    const destination = path.join(destinationRoot, integrity);
    const computeIntegrity = () => ({ value: integrity });
    await publishMaterializedPackage(staging, destination, integrity, computeIntegrity);
    const secondStaging = await materializeRuntimeExtensionPackage(source, manifest, destinationRoot);
    await publishMaterializedPackage(secondStaging, destination, integrity, computeIntegrity);

    expect(await readFile(path.join(destination, 'runtime-extension.json'), 'utf8')).toContain('fixture-extension');
    expect(await readFile(path.join(destination, 'index.cjs'), 'utf8')).toContain('activate');
    expect(await readFile(path.join(destination, 'dist', 'extra.cjs'), 'utf8')).toContain('module.exports');
    expect(await readdir(destination)).not.toContain('node_modules');
    expect(await readdir(destinationRoot)).toEqual([integrity]);
  });

  it('parses object configuration and rejects conflicting configuration inputs', () => {
    expect(parseCodexExtensionInstallerArgs([
      '--directory', '.', '--configuration-json', '{"enabled":true}',
    ]).configurationJson).toBe('{"enabled":true}');
    expect(() => parseCodexExtensionInstallerArgs([
      '--directory', '.', '--configuration-json', '{}', '--configuration-file', 'config.json',
    ])).toThrow(/mutually exclusive/);
  });

  it('passes configuration through the lifecycle manager and persists it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'marshal-extension-config-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'source');
    const destinationRoot = path.join(root, 'installed');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: '@test/config-extension',
      version: '1.0.0',
      type: 'commonjs',
      main: 'index.cjs',
    }));
    const manifest = validateRuntimeExtensionManifest({
      schemaVersion: 1,
      identity: '@test/config-extension',
      version: '1.0.0',
      entrypoint: 'index.cjs',
      moduleFormat: 'commonjs-bundle-v1',
    });
    await writeFile(path.join(source, 'runtime-extension.json'), JSON.stringify(manifest));
    await writeFile(path.join(source, 'index.cjs'), 'module.exports = { activate() { return {}; } };');
    const staging = await materializeRuntimeExtensionPackage(source, manifest, destinationRoot);
    const integrity = computeRuntimeExtensionIntegrity(staging);
    const destination = path.join(destinationRoot, integrity.value);
    await publishMaterializedPackage(staging, destination, integrity.value, computeRuntimeExtensionIntegrity);
    const manager = new RuntimeExtensionManager({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      loader: new LocalRuntimeExtensionPackageLoader({ allowedRoots: [destinationRoot] }),
      activationContext: {
        principal: { id: 'installer-test', kind: 'agent' },
        scope: { workspaceId: 'installer-test' },
      },
    });
    await manager.install(
      { packageRoot: destination, integrity },
      { configuration: { enabled: true } },
    );
    expect(manager.list()[0]?.configuration).toEqual({ enabled: true });
    await manager.dispose();
  });
});
