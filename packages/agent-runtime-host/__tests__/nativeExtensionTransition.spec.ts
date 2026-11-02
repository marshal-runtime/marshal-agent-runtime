import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeServiceContainer } from '@marshal/agent-runtime-composer';
import { createAllowAllPermissionBroker } from '@marshal/agent-runtime-core';
import {
  RUNTIME_EXTENSION_CATALOG_SERVICE,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
} from '@marshal/agent-runtime-extensions';
import {
  createAgentRuntime,
  createRuntimeHostMaterializer,
} from '../src/index.js';

const cleanup: string[] = [];
const identity = '@fixture/native-transition';
const catalogEntryId = `${identity}@1.0.0`;
const capabilityName = 'fixture.native.transition';
const contributionCatalogId = 'skill://fixture/native-transition';
const projectionMarker = 'native-transition-projection';

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

describe('native extension unbuilt-to-enabled transition', () => {
  it('materializes, discovers, enables, projects, and disables one detected package', async () => {
    const fixture = await createFixture();
    const serviceContainer = createRuntimeServiceContainer();
    const runtime = await createAgentRuntime({
      serviceContainer,
      workspacePath: fixture.workspacePath,
      protectedLifecycleResultRoot: path.join(fixture.root, 'private'),
      permissionBroker: createAllowAllPermissionBroker(),
      codeIntelligence: false,
      providerSources: [],
      extensions: {
        allowedRoots: [fixture.extensionsRoot],
        discoveryRoots: [fixture.extensionsRoot],
        restore: false,
      },
    });

    try {
      const discovery = runtime.extensionDiscovery!;
      expect(discovery.snapshot()).toMatchObject({
        status: 'ready',
        entries: [],
        candidates: [{
          status: 'unbuilt',
          packageRoot: fixture.packageRoot,
          identity,
          version: '1.0.0',
          installation: {
            script: 'marshal:install',
            packageManager: 'npm',
          },
          diagnostics: [{ code: 'entrypoint_missing' }],
        }],
      });

      const materializer = await createRuntimeHostMaterializer({
        allowedRoots: [fixture.extensionsRoot],
        installation: {
          commands: {
            npm: {
              executable: process.execPath,
              prefixArguments: [fixture.managerPath],
            },
          },
        },
      });
      const materialized = await materializer.materialize({
        packageRoot: fixture.packageRoot,
      });

      expect(materialized).toMatchObject({
        packageRoot: fixture.packageRoot,
        canonicalRoot: fixture.packageRoot,
        integrity: {
          algorithm: 'sha256',
          domain: 'marshal-runtime-extension-package-v1',
        },
        installation: {
          packageManager: 'npm',
          script: 'marshal:install',
          stdout: 'fixture native extension materialized',
          outputTruncated: false,
        },
      });
      expect(await fs.readFile(path.join(fixture.packageRoot, '.install-count'), 'utf8')).toBe('1');
      expect(await fs.readFile(path.join(fixture.packageRoot, 'dist', 'index.cjs'), 'utf8'))
        .toContain(capabilityName);

      const refreshed = await discovery.refresh();
      const discoveredCandidate = refreshed.candidates[0];
      expect(refreshed.revision).toBeGreaterThan(1);
      expect(refreshed).toMatchObject({
        status: 'ready',
        candidates: [{
          status: 'installable',
          packageRoot: fixture.packageRoot,
          identity,
          version: '1.0.0',
          diagnostics: [],
          catalogEntry: {
            id: catalogEntryId,
            request: {
              packageRoot: fixture.packageRoot,
              integrity: materialized.integrity,
            },
          },
        }],
        entries: [{
          id: catalogEntryId,
          request: {
            packageRoot: fixture.packageRoot,
            integrity: materialized.integrity,
          },
        }],
      });
      expect(discoveredCandidate?.status).toBe('installable');

      const lifecycle = serviceContainer.get(RUNTIME_EXTENSION_LIFECYCLE_SERVICE);
      const catalog = serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE);
      const context = {
        principal: { id: 'native-transition-test', kind: 'agent' as const },
        scope: { workspaceId: runtime.workspaceId },
      };
      const search = () => runtime.kernel.search(
        { query: projectionMarker },
        { sessionId: 'native-transition-test' },
      );
      const projections = async () => {
        const result = await search();
        return {
          capabilities: result.matches.map((match) => match.capability.name),
          catalog: (result.discoveries ?? []).map((match) => match.entry.id),
        };
      };

      const installableCatalog = await catalog.discover(context);
      expect(installableCatalog).toMatchObject([{
        id: catalogEntryId,
        request: {
          packageRoot: materialized.packageRoot,
          integrity: materialized.integrity,
        },
      }]);
      expect(installableCatalog[0]?.installation).toBeUndefined();
      await expect(projections()).resolves.toEqual({ capabilities: [], catalog: [] });

      await expect(lifecycle.install({
        packageRoot: materialized.packageRoot,
        integrity: materialized.integrity,
      })).resolves.toMatchObject({
        identity,
        version: '1.0.0',
        status: 'enabled',
        integrity: materialized.integrity,
      });
      await expect(projections()).resolves.toEqual({
        capabilities: [capabilityName],
        catalog: [contributionCatalogId],
      });
      await expect(catalog.discover(context)).resolves.toMatchObject([{
        id: catalogEntryId,
        installation: {
          identity,
          status: 'enabled',
          integrity: materialized.integrity,
        },
      }]);

      await expect(lifecycle.disable(identity)).resolves.toMatchObject({
        identity,
        status: 'disabled',
      });
      await expect(projections()).resolves.toEqual({ capabilities: [], catalog: [] });
      await expect(catalog.discover(context)).resolves.toMatchObject([{
        id: catalogEntryId,
        installation: {
          identity,
          status: 'disabled',
          integrity: materialized.integrity,
        },
      }]);

      const disabledRefresh = await discovery.refresh();
      expect(disabledRefresh.candidates).toMatchObject([{
        status: 'installable',
        identity,
        catalogEntry: {
          id: catalogEntryId,
          request: {
            packageRoot: materialized.packageRoot,
            integrity: materialized.integrity,
          },
        },
      }]);
      expect(disabledRefresh.entries).toMatchObject([{
        id: catalogEntryId,
        request: {
          packageRoot: materialized.packageRoot,
          integrity: materialized.integrity,
        },
      }]);
      expect(await fs.readFile(path.join(fixture.packageRoot, '.install-count'), 'utf8')).toBe('1');
    } finally {
      await runtime.dispose();
    }
  });
});

async function createFixture(): Promise<{
  readonly root: string;
  readonly workspacePath: string;
  readonly extensionsRoot: string;
  readonly packageRoot: string;
  readonly managerPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-native-transition-'));
  cleanup.push(root);
  const workspacePath = path.join(root, 'workspace');
  const extensionsRoot = path.join(root, 'extensions');
  const packageRoot = path.join(extensionsRoot, 'native-transition');
  const managerPath = path.join(packageRoot, 'fixture-manager.mjs');
  await Promise.all([
    fs.mkdir(workspacePath),
    fs.mkdir(packageRoot, { recursive: true }),
  ]);

  const extensionSource = `
const capability = {
  protocolVersion: '1.0.0',
  name: '${capabilityName}',
  version: '1.0.0',
  title: 'Native transition projection',
  description: 'Capability contributed by the materialized native transition fixture.',
  tags: ['${projectionMarker}'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: { source: { type: 'string' } },
    required: ['source'],
    additionalProperties: false
  }
};
const catalogEntry = {
  id: '${contributionCatalogId}',
  kind: 'skill',
  title: 'Native transition projection',
  description: 'Catalog entry contributed by the materialized native transition fixture.',
  tags: ['${projectionMarker}'],
  action: { type: 'resource_read', uri: '${contributionCatalogId}' }
};
module.exports = {
  activate() {
    return {
      capabilityProviders: [{
        id: 'fixture.native.transition-provider',
        version: '1.0.0',
        list() { return [capability]; },
        get(name) { return name === capability.name ? capability : undefined; },
        invoke() { return { output: { source: 'materialized-native-extension' } }; }
      }],
      catalogProviders: [{
        id: 'fixture.native.transition-catalog',
        list() { return [catalogEntry]; },
        get(id) { return id === catalogEntry.id ? catalogEntry : undefined; }
      }]
    };
  }
};
`.trim();
  const managerSource = [
    "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    "if (process.argv[2] !== 'run' || process.argv[3] !== 'marshal:install') process.exit(23);",
    "const countPath = path.join(process.cwd(), '.install-count');",
    "const count = Number(await readFile(countPath, 'utf8').catch(() => '0')) + 1;",
    "await mkdir(path.join(process.cwd(), 'dist'), { recursive: true });",
    `await writeFile(path.join(process.cwd(), 'dist', 'index.cjs'), ${JSON.stringify(extensionSource)});`,
    "await writeFile(countPath, String(count));",
    "process.stdout.write('fixture native extension materialized');",
  ].join('\n');

  await Promise.all([
    fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: identity,
      version: '1.0.0',
      type: 'commonjs',
      main: 'dist/index.cjs',
      packageManager: 'npm@11.0.0',
      scripts: { 'marshal:install': 'fixture-manager' },
    })),
    fs.writeFile(path.join(packageRoot, 'runtime-extension.json'), JSON.stringify({
      schemaVersion: 1,
      identity,
      version: '1.0.0',
      entrypoint: 'dist/index.cjs',
      moduleFormat: 'commonjs-bundle-v1',
      installation: {
        script: 'marshal:install',
        packageManager: 'npm',
      },
      contributes: {
        capabilities: [capabilityName],
        catalog: [contributionCatalogId],
      },
    })),
    fs.writeFile(managerPath, managerSource),
  ]);

  return {
    root,
    workspacePath,
    extensionsRoot,
    packageRoot: await fs.realpath(packageRoot),
    managerPath,
  };
}