import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectTypeScriptExecutor, resolveTypeScriptModuleSource } from '../src/index.js';

const cleanup: string[] = [];

afterEach(async () => {
  for (const target of cleanup.splice(0)) {
    await fs.rm(target, { recursive: true, force: true });
  }
});

async function tempWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-ts-source-'));
  cleanup.push(directory);
  return directory;
}

describe('resolveTypeScriptModuleSource', () => {
  it('resolves a contained workspace file and preserves an editable source identity', async () => {
    const workspaceRoot = await tempWorkspace();
    await fs.mkdir(path.join(workspaceRoot, '.agent', 'execution'), { recursive: true });
    const modulePath = path.join(workspaceRoot, '.agent', 'execution', 'answer.ts');
    await fs.writeFile(modulePath, 'export default () => 42;\n');

    const resolved = await resolveTypeScriptModuleSource(
      { kind: 'workspace_file', path: '.agent/execution/answer.ts' },
      { workspaceRoot },
    );

    expect(resolved).toMatchObject({
      source: 'export default () => 42;\n',
      filename: await fs.realpath(modulePath),
      identity: {
        kind: 'workspace_file',
        identifier: '.agent/execution/answer.ts',
      },
      receipt: {
        kind: 'workspace_file',
        identifier: '.agent/execution/answer.ts',
        sizeBytes: 25,
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
  });

  it('resolves an artifact through a host-supplied reader rather than filesystem knowledge', async () => {
    const workspaceRoot = await tempWorkspace();
    const resolved = await resolveTypeScriptModuleSource(
      { kind: 'artifact', path: 'blocks/report.ts', scope: 'project', export: 'run' },
      {
        workspaceRoot,
        readArtifact: async (reference) => ({
          content: 'export const run = () => 7;',
          uri: `artifact://${reference.scope}/${reference.path}`,
          provenance: [{ source: 'test-artifacts', trust: 'authoritative' }],
        }),
      },
    );

    expect(resolved).toMatchObject({
      filename: 'artifact://project/blocks/report.ts',
      entrypoint: 'run',
      identity: {
        kind: 'artifact',
        identifier: 'project:blocks/report.ts',
        uri: 'artifact://project/blocks/report.ts',
      },
    });
  });

  it('rejects workspace traversal and symbolic-link escapes', async () => {
    const parent = await tempWorkspace();
    const workspaceRoot = path.join(parent, 'workspace');
    const outside = path.join(parent, 'outside');
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.ts'), 'export default () => 1;');

    await expect(
      resolveTypeScriptModuleSource(
        { kind: 'workspace_file', path: '../outside/secret.ts' },
        { workspaceRoot },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE_PATH' });

    const linked = path.join(workspaceRoot, 'linked');
    await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      resolveTypeScriptModuleSource(
        { kind: 'workspace_file', path: 'linked/secret.ts' },
        { workspaceRoot },
      ),
    ).rejects.toMatchObject({ code: 'SYMLINK_SOURCE_DENIED' });
  });

  it('executes a workspace module with contained relative imports and fingerprints every file', async () => {
    const workspaceRoot = await tempWorkspace();
    await fs.writeFile(
      path.join(workspaceRoot, 'math.ts'),
      'export const double = (n: number) => n * 2;',
    );
    await fs.writeFile(
      path.join(workspaceRoot, 'main.ts'),
      "import { double } from './math'; export default (input: { value: number }) => double(input.value);",
    );
    const resolved = await resolveTypeScriptModuleSource(
      { kind: 'workspace_file', path: 'main.ts' },
      { workspaceRoot },
    );
    const execution = await new DirectTypeScriptExecutor({
      workingDirectory: workspaceRoot,
    }).execute({
      source: resolved.source,
      filename: resolved.filename,
      sourceIdentity: resolved.identity,
      input: { value: 21 },
    });

    expect(execution).toMatchObject({
      ok: true,
      value: 42,
      source: {
        kind: 'workspace_file',
        identifier: 'main.ts',
        contentDigest: expect.stringMatching(/^sha256:/),
      },
      environment: {
        sourceFiles: expect.arrayContaining([
          expect.objectContaining({ identifier: 'main.ts' }),
          expect.objectContaining({ identifier: 'math.ts' }),
        ]),
        moduleDigest: expect.stringMatching(/^sha256:/),
        fingerprint: expect.stringMatching(/^sha256:/),
      },
    });
  });

  it('reuses a digest-keyed compiler context and never serves stale imported code after an edit', async () => {
    const workspaceRoot = await tempWorkspace();
    const dependencyPath = path.join(workspaceRoot, 'math.ts');
    await fs.writeFile(dependencyPath, 'export const transform = (n: number) => n * 2;');
    await fs.writeFile(
      path.join(workspaceRoot, 'main.ts'),
      "import { transform } from './math'; export default (input: { value: number }) => transform(input.value);",
    );
    const resolved = await resolveTypeScriptModuleSource(
      { kind: 'workspace_file', path: 'main.ts' },
      { workspaceRoot },
    );
    const executor = new DirectTypeScriptExecutor({ workingDirectory: workspaceRoot });
    const request = {
      source: resolved.source,
      filename: resolved.filename,
      sourceIdentity: resolved.identity,
      input: { value: 7 },
    };

    const cold = await executor.execute(request);
    const unchanged = await executor.execute(request);
    await fs.writeFile(dependencyPath, 'export const transform = (n: number) => n * 3;');
    const edited = await executor.execute(request);

    expect(cold).toMatchObject({
      ok: true,
      value: 14,
      compilation: { cacheStatus: 'miss', dependencyGraphValidated: true },
    });
    expect(unchanged).toMatchObject({
      ok: true,
      value: 14,
      compilation: { cacheStatus: 'hit', dependencyGraphValidated: true },
    });
    expect(edited).toMatchObject({
      ok: true,
      value: 21,
      compilation: { cacheStatus: 'hit', dependencyGraphValidated: true },
    });
    expect(unchanged.compilation?.cacheKey).toBe(cold.compilation?.cacheKey);
    expect(edited.environment?.moduleDigest).not.toBe(unchanged.environment?.moduleDigest);
  });
});
