import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexRuntime, declaredWorkspaceUiPackages } from '../runtime.js';

const roots: string[] = [];
const originalUiStateRoot = process.env.MARSHAL_RUNTIME_UI_STATE_ROOT;
const originalUiAuthKey = process.env.MARSHAL_RUNTIME_UI_AUTH_KEY;

afterEach(async () => {
  if (originalUiStateRoot === undefined) delete process.env.MARSHAL_RUNTIME_UI_STATE_ROOT;
  else process.env.MARSHAL_RUNTIME_UI_STATE_ROOT = originalUiStateRoot;
  if (originalUiAuthKey === undefined) delete process.env.MARSHAL_RUNTIME_UI_AUTH_KEY;
  else process.env.MARSHAL_RUNTIME_UI_AUTH_KEY = originalUiAuthKey;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex trusted-local UI package authority', () => {
  it('derives concrete package names from the workspace manifest without wildcard authority', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'marshal-codex-ui-authority-'));
    roots.push(workspacePath);
    await writeFile(join(workspacePath, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0', '@acme/ui': '1.2.3' },
      devDependencies: { 'chart-kit': '^4.0.0' },
      optionalDependencies: { 'optional-ui': '1.0.0' },
    }));

    expect(declaredWorkspaceUiPackages(workspacePath)).toEqual([
      '@acme/ui',
      'chart-kit',
      'optional-ui',
      'react',
    ]);
    expect(declaredWorkspaceUiPackages(workspacePath)).not.toContain('*');
  });

  it('compiles a manifest-declared package in trusted-local without wildcard authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marshal-codex-ui-full-access-'));
    roots.push(root);
    const workspacePath = join(root, 'workspace');
    const packageRoot = join(workspacePath, 'node_modules', 'declared-ui');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(workspacePath, 'package.json'), JSON.stringify({
      dependencies: { 'declared-ui': '1.0.0' },
    }));
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'declared-ui', version: '1.0.0', type: 'module', main: 'index.js',
    }));
    await writeFile(join(packageRoot, 'index.js'), "export const label = 'declared';");
    await writeFile(
      join(workspacePath, 'App.tsx'),
      "import {label} from 'declared-ui'; export default () => <main>{label}</main>;",
    );
    process.env.MARSHAL_RUNTIME_UI_STATE_ROOT = join(root, 'host-ui-state');
    process.env.MARSHAL_RUNTIME_UI_AUTH_KEY = join(root, 'host-keys', 'ui.key');

    const runtime = await createCodexRuntime({ workspacePath, permissionProfile: 'trusted-local' });
    try {
      const result = await runtime.kernel.execute({
        targetType: 'operation',
        target: 'ui.compile',
        input: {
          entryPath: 'App.tsx',
          title: 'Declared package',
          authoringProfile: { id: 'marshal-standards', version: '1.0.0' },
        },
      }, { sessionId: 'trusted-local-ui' }) as { status: string; error?: { message?: string } };
      expect(result, result.error?.message).toMatchObject({ status: 'success' });
    } finally {
      await runtime.dispose();
    }
  });
});
