#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  computeRuntimeExtensionIntegrity,
  validateRuntimeExtensionManifest,
  type RuntimeExtensionLifecycleService,
} from '@marshal/runtime';
import { createCodexRuntime } from './runtime.js';
import { isDirectEntrypoint } from './entrypoint.js';
import { codexRuntimeExtensionRoot } from './runtimePaths.js';
import {
  materializeRuntimeExtensionPackage,
  parseCodexExtensionInstallerArgs,
  publishMaterializedPackage,
} from './extensionInstaller.js';
export { parseCodexExtensionInstallerArgs } from './extensionInstaller.js';

export async function runCodexExtensionInstaller(
  argv = process.argv.slice(2),
): Promise<void> {
  const options = parseCodexExtensionInstallerArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const source = await resolvePackageRoot(options.source);
  const manifest = validateRuntimeExtensionManifest(JSON.parse(
    await fs.readFile(path.join(source, 'runtime-extension.json'), 'utf8'),
  ));
  const destinationRoot = path.resolve(
    options.destinationRoot ?? codexRuntimeExtensionRoot(),
  );
  const configuration = await resolveConfiguration(options);
  await fs.mkdir(destinationRoot, { recursive: true });
  const staging = await materializeRuntimeExtensionPackage(source, manifest, destinationRoot);
  try {
    const integrity = computeRuntimeExtensionIntegrity(staging);
    const destination = path.join(destinationRoot, integrity.value);
    await publishMaterializedPackage(staging, destination, integrity.value, computeRuntimeExtensionIntegrity);

    const runtime = await createCodexRuntime({
      workspacePath: options.workspacePath,
      extensions: { allowedRoots: [destinationRoot] },
    });
    try {
    const lifecycle = runtime.serviceContainer.get<RuntimeExtensionLifecycleService>(
      RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
    );
      const installed = lifecycle.list().find((entry) => entry.identity === manifest.identity);
      const record = installed
        ? await lifecycle.update(manifest.identity, { packageRoot: destination, integrity }, {
            configuration,
          })
        : await lifecycle.install({ packageRoot: destination, integrity }, {
            configuration,
          });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      identity: manifest.identity,
      version: manifest.version,
      integrity,
      packageRoot: destination,
      status: record.status,
    }, null, 2)}\n`);
    } finally {
      await runtime.dispose();
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function resolveConfiguration(options: {
  readonly configurationJson?: string;
  readonly configurationFile?: string;
}): Promise<Readonly<Record<string, unknown>> | undefined> {
  const raw = options.configurationJson === undefined
    ? options.configurationFile === undefined
      ? undefined
      : await fs.readFile(path.resolve(options.configurationFile), 'utf8')
    : options.configurationJson;
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Extension configuration must be a JSON object.');
  }
  return value as Readonly<Record<string, unknown>>;
}


async function resolvePackageRoot(input: string): Promise<string> {
  const resolved = path.resolve(input);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error('Extension package source must not be a symlink.');
  return stat.isDirectory() ? resolved : path.dirname(resolved);
}

function usage(): string {
  return `agent-runtime-codex-install-extension

Usage:
  agent-runtime-codex-install-extension --directory <path> [--workspace <path>] [--destination-root <path>]
    [--configuration-json <object-json> | --configuration-file <path>]
  agent-runtime-codex-install-extension --manifest <path> [--workspace <path>] [--destination-root <path>]
    [--configuration-json <object-json> | --configuration-file <path>]
`;
}

if (isDirectEntrypoint(import.meta.url)) {
  runCodexExtensionInstaller().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
