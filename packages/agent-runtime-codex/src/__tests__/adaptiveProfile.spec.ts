import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexRuntime } from '../runtime.js';

const cleanup: string[] = [];
const originalProfile = process.env.MARSHAL_RUNTIME_PERMISSION_PROFILE;

afterEach(async () => {
  if (originalProfile === undefined) delete process.env.MARSHAL_RUNTIME_PERMISSION_PROFILE;
  else process.env.MARSHAL_RUNTIME_PERMISSION_PROFILE = originalProfile;
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Codex adaptive-agentic permission profile', () => {
  it('honors the environment profile consistently while retaining trusted execution boundaries', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'marshal-adaptive-profile-'));
    cleanup.push(workspacePath);
    await writeFile(
      join(workspacePath, 'App.tsx'),
      'export default function App(){ return <main>Adaptive</main>; }',
      'utf8',
    );
    process.env.MARSHAL_RUNTIME_PERMISSION_PROFILE = 'adaptive-agentic';

    const runtime = await createCodexRuntime({ workspacePath });
    try {
      const compiled = await runtime.kernel.execute({
        targetType: 'operation',
        target: 'ui.compile',
        input: { entryPath: 'App.tsx', title: 'Adaptive profile' },
      }, { sessionId: 'adaptive-profile' }) as {
        status: string;
        receipt?: { permission?: { grants?: string[] } };
        result?: { output?: { component?: { id?: string } } };
      };
      expect(compiled).toMatchObject({
        status: 'success',
        receipt: { permission: { grants: ['trusted_ui'] } },
      });
      expect(compiled.result?.output?.component?.id).toMatch(/^[a-f0-9]{64}$/);

      const trustedNode = await runtime.kernel.execute({
        targetType: 'inline_module',
        executionMode: 'trusted_node',
        source: 'export default () => 42;',
      }, { sessionId: 'adaptive-profile' }) as { status: string };
      expect(trustedNode.status).toBe('denied');
    } finally {
      await runtime.dispose();
    }
  });
});
