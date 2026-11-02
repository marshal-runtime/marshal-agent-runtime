import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactUiCompiler } from '../compiler.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('React UI package authority', () => {
  it('rejects a workspace node_modules bridge before reading its transitive package', async () => {
    const workspacePath = await workspace({
      'App.tsx': "import {value} from './node_modules/bridge/index.js'; export default () => <p>{value}</p>;",
      'node_modules/bridge/package.json': manifest('bridge'),
      'node_modules/bridge/index.js': "import {secret} from 'forbidden'; export const value = secret;",
      'node_modules/forbidden/package.json': manifest('forbidden'),
      'node_modules/forbidden/index.js': "export const secret = 'read';",
    });
    await expect(compile(workspacePath)).rejects.toThrow(
      'Authored workspace relative import escapes into an unauthorized package or external path',
    );
  });

  it('rejects absolute authored imports even when they point into a configured adapter root', async () => {
    const workspacePath = await workspace({});
    const adapterRoot = await workspace({
      'package.json': manifest('adapter-ui'),
      'index.js': "export const value = 'adapter';",
    });
    const absolute = join(adapterRoot, 'index.js').replaceAll('\\', '/');
    await writeFile(
      join(workspacePath, 'App.tsx'),
      `import {value} from ${JSON.stringify(absolute)}; export default () => <p>{value}</p>;`,
      'utf8',
    );
    const compiler = new ReactUiCompiler({
      workspacePath,
      trustedPackageRoots: [adapterRoot],
    });
    await expect(compiler.compileWorkspace({ entryPath: 'App.tsx', title: 'App' }, context()))
      .rejects.toThrow('Absolute imports are unavailable');
  });

  it('allows only declared transitive package edges', async () => {
    const declared = await packageWorkspace(true);
    await expect(compile(declared, ['allowed-root'])).resolves.toMatchObject({
      sourceKind: 'workspace_file',
      bundleDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const undeclared = await packageWorkspace(false);
    await expect(compile(undeclared, ['allowed-root']))
      .rejects.toThrow('does not declare UI dependency declared-leaf');
  });

  it('does not let an authorized package escape its root through a relative import', async () => {
    const workspacePath = await workspace({
      'App.tsx': "import {value} from 'allowed-root'; export default () => <p>{value}</p>;",
      'secret.js': "export const secret = 'workspace secret';",
      'node_modules/allowed-root/package.json': manifest('allowed-root'),
      'node_modules/allowed-root/index.js': "import {secret} from '../../secret.js'; export const value = secret;",
    });
    await expect(compile(workspacePath, ['allowed-root']))
      .rejects.toThrow('relative import escapes its authorized package root');
  });

  it('verifies adapter-resolved package identity and exact profile version', async () => {
    const workspacePath = await workspace({
      'App.tsx': "import {value} from 'adapter-ui/subpath'; export default () => <p>{value}</p>;",
    });
    const adapterRoot = await workspace({
      'package.json': manifest('different-package', '9.0.0'),
      'index.js': "export const value = 'wrong';",
    });
    const resolver = () => join(adapterRoot, 'index.js');
    const wrongIdentity = new ReactUiCompiler({
      workspacePath,
      allowedPackages: ['adapter-ui/subpath'],
      packageImportResolver: resolver,
    });
    await expect(wrongIdentity.compileWorkspace({ entryPath: 'App.tsx', title: 'App' }, context()))
      .rejects.toThrow('resolved to unexpected package different-package');

    await writeFile(join(adapterRoot, 'package.json'), manifest('adapter-ui', '9.0.0'), 'utf8');
    const versioned = new ReactUiCompiler({
      workspacePath,
      packageImportResolver: resolver,
      authoringProfiles: [{
        id: 'adapter', version: '1.0.0', portable: false,
        packageImports: ['adapter-ui/subpath'], packageVersions: { 'adapter-ui/subpath': '1.0.0' },
        designTokens: {}, templates: [], authoringGuidance: 'Use adapter UI.',
        accessibilityRequirements: ['Meet WCAG 2.2 AA.'],
        layoutConstraints: ['Keep inline usable.'],
        requiredHostCapabilities: [], optionalHostExtensions: [],
      }],
    });
    await expect(versioned.compileWorkspace({
      entryPath: 'App.tsx', title: 'App', authoringProfile: { id: 'adapter' },
    }, context())).rejects.toThrow('resolved to 9.0.0, expected 1.0.0');
  });

  it('rejects external workspace dependencies reached through a directory symlink', async () => {
    const workspacePath = await workspace({
      'App.tsx': "import {value} from './linked/helper.js'; export default () => <p>{value}</p>;",
    });
    const outside = await workspace({ 'helper.js': "export const value = 'outside';" });
    try {
      await symlink(outside, join(workspacePath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    await expect(compile(workspacePath)).rejects.toThrow(/not within the authored workspace|resolves outside/);
  });
});

async function compile(workspacePath: string, allowedPackages?: readonly string[]) {
  return new ReactUiCompiler({ workspacePath, allowedPackages }).compileWorkspace(
    { entryPath: 'App.tsx', title: 'App' },
    context(),
  );
}

async function packageWorkspace(declared: boolean): Promise<string> {
  return workspace({
    'App.tsx': "import {value} from 'allowed-root'; export default () => <p>{value}</p>;",
    'node_modules/allowed-root/package.json': JSON.stringify({
      name: 'allowed-root', version: '1.0.0', type: 'module', main: 'index.js',
      ...(declared ? { dependencies: { 'declared-leaf': '^1.0.0' } } : {}),
    }),
    'node_modules/allowed-root/index.js': "import {leaf} from 'declared-leaf'; export const value = leaf;",
    'node_modules/declared-leaf/package.json': manifest('declared-leaf'),
    // An undeclared edge must fail in resolution before these bytes reach esbuild.
    'node_modules/declared-leaf/index.js': declared
      ? "export const leaf = 'declared';"
      : 'this is intentionally invalid JavaScript and must never be loaded',
  });
}

function manifest(name: string, version = '1.0.0'): string {
  return JSON.stringify({ name, version, type: 'module', main: 'index.js' });
}

function context(): InvocationContext {
  return {
    principal: { id: 'package-authority-test', kind: 'agent' },
    scope: { workspaceId: 'workspace', projectId: 'project', sessionId: 'session' },
  };
}

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marshal-ui-authority-'));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }
  return root;
}
