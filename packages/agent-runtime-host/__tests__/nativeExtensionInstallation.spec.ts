import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeNativeExtensionInstallationError,
  runRuntimeNativeExtensionInstallation,
} from '../src/nativeExtensionInstallation.js';
import { createRuntimeHostMaterializer } from '../src/nativeExtensions.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('trusted native extension installation scripts', () => {
  it('runs the declared package script before package materialization', async () => {
    const fixture = await createFixture();
    const events: string[] = [];
    const result = await runRuntimeNativeExtensionInstallation(fixture.packageRoot, {
      commands: { npm: { executable: process.execPath, prefixArguments: [fixture.manager] } },
      onEvent: (event) => events.push(event.phase),
    });

    expect(result).toMatchObject({
      packageManager: 'npm',
      script: 'marshal:install',
      outputTruncated: false,
    });
    expect(result.stdout).toContain('fixture built');
    expect(events).toEqual(['validating', 'running-script', 'completed']);
    expect(await readFile(path.join(fixture.packageRoot, 'dist', 'extension.cjs'), 'utf8'))
      .toContain('fixture extension');
  });

  it('runs preparation before unpinned materialization and skips it for pinned packages', async () => {
    const fixture = await createFixture();
    const materializer = await createRuntimeHostMaterializer({
      allowedRoots: [fixture.packageRoot],
      installation: {
        commands: {
          npm: { executable: process.execPath, prefixArguments: [fixture.manager] },
        },
      },
    });
    const prepared = await materializer.materialize({ packageRoot: fixture.packageRoot });
    expect(prepared.installation).toMatchObject({ script: 'marshal:install' });
    expect(await readFile(path.join(fixture.packageRoot, '.install-count'), 'utf8')).toBe('1');

    const pinned = await materializer.materialize({
      packageRoot: fixture.packageRoot,
      integrity: prepared.integrity,
    });
    expect(pinned.installation).toBeUndefined();
    expect(await readFile(path.join(fixture.packageRoot, '.install-count'), 'utf8')).toBe('1');
  });

  it('returns bounded output and a typed failure without reporting completion', async () => {
    const fixture = await createFixture({ fail: true });
    const events: string[] = [];
    const error = await runRuntimeNativeExtensionInstallation(fixture.packageRoot, {
      commands: { npm: { executable: process.execPath, prefixArguments: [fixture.manager] } },
      maxCapturedOutputBytes: 8,
      onEvent: (event) => events.push(event.phase),
    }).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(RuntimeNativeExtensionInstallationError);
    expect(error).toMatchObject({
      code: 'INSTALLATION_FAILED',
      result: { outputTruncated: true },
    });
    expect(events).toEqual(['validating', 'running-script']);
  });

  it('does not invent an installation command for a prebuilt-only manifest', async () => {
    const fixture = await createFixture({ installation: false });
    await expect(runRuntimeNativeExtensionInstallation(fixture.packageRoot)).rejects.toMatchObject({
      code: 'INSTALLATION_NOT_DECLARED',
    });
  });

  it('cancels an active package script', async () => {
    const fixture = await createFixture({ wait: true });
    const controller = new AbortController();
    const installing = runRuntimeNativeExtensionInstallation(fixture.packageRoot, {
      signal: controller.signal,
      commands: { npm: { executable: process.execPath, prefixArguments: [fixture.manager] } },
    });
    setTimeout(() => controller.abort(), 40);
    await expect(installing).rejects.toMatchObject({ code: 'INSTALLATION_CANCELLED' });
  });
});

async function createFixture(options: {
  readonly fail?: boolean;
  readonly wait?: boolean;
  readonly installation?: boolean;
} = {}): Promise<{ readonly packageRoot: string; readonly manager: string }> {
  const packageRoot = await mkdtemp(path.join(tmpdir(), 'runtime-extension-installation-'));
  roots.push(packageRoot);
  const manager = path.join(packageRoot, 'fixture-manager.mjs');
  await Promise.all([
    writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/installation',
      version: '1.0.0',
      packageManager: 'npm@11.0.0',
      scripts: { 'marshal:install': 'fixture-manager' },
    })),
    writeFile(path.join(packageRoot, 'runtime-extension.json'), JSON.stringify({
      schemaVersion: 1,
      identity: '@fixture/installation',
      version: '1.0.0',
      entrypoint: 'dist/extension.cjs',
      moduleFormat: 'commonjs-bundle-v1',
      ...(options.installation === false
        ? {}
        : { installation: { script: 'marshal:install', packageManager: 'npm' } }),
    })),
    writeFile(manager, [
      "import { mkdir, writeFile } from 'node:fs/promises';",
      "import { readFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "if (process.argv[2] !== 'run' || process.argv[3] !== 'marshal:install') process.exit(23);",
      ...(options.wait ? ["await new Promise((resolve) => setTimeout(resolve, 10_000));"] : []),
      "await mkdir(path.join(process.cwd(), 'dist'), { recursive: true });",
      "await writeFile(path.join(process.cwd(), 'dist', 'extension.cjs'), 'module.exports = \\\"fixture extension\\\";');",
      "const countPath = path.join(process.cwd(), '.install-count');",
      "const count = Number(await readFile(countPath, 'utf8').catch(() => '0')) + 1;",
      "await writeFile(countPath, String(count));",
      "process.stdout.write('fixture built with enough output to test truncation');",
      ...(options.fail ? ["process.stderr.write('fixture failed');", 'process.exit(7);'] : []),
    ].join('\n')),
  ]);
  if (options.installation === false) {
    await mkdir(path.join(packageRoot, 'dist'));
    await writeFile(path.join(packageRoot, 'dist', 'extension.cjs'), 'module.exports = {};');
  }
  return { packageRoot, manager };
}
