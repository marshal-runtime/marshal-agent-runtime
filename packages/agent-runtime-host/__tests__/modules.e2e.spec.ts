import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeKernel,
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import { createArtifactProvider } from '@marshal/agent-runtime-provider-artifacts';
import { createTypeScriptModuleProvider } from '../src/index.js';

const cleanup: string[] = [];

afterEach(async () => {
  for (const target of cleanup.splice(0)) {
    await fs.rm(target, { recursive: true, force: true });
  }
});

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-host-module-'));
  cleanup.push(parent);
  const workspacePath = path.join(parent, 'workspace');
  await fs.mkdir(workspacePath);
  const kernel = createRuntimeKernel({
    permissionBroker: { decide: () => ({ decision: 'allow' }) },
  });
  kernel.register(createArtifactProvider({ rootDirectory: path.join(parent, 'artifacts') }));
  kernel.register(createTypeScriptModuleProvider({ kernel, workspacePath }));
  const context: InvocationContext = {
    principal: { id: 'portable-agent', kind: 'agent' },
    scope: {
      workspaceId: 'workspace-test',
      projectId: 'project-test',
      sessionId: 'session-test',
    },
  };
  return { kernel, workspacePath, context };
}

describe('portable file-backed module host', () => {
  it('reruns an edited workspace file and emits content-addressed receipts', async () => {
    const { kernel, workspacePath, context } = await fixture();
    const blocks = path.join(workspacePath, '.agent', 'execution');
    await fs.mkdir(blocks, { recursive: true });
    const modulePath = path.join(blocks, 'editable.ts');
    await fs.writeFile(modulePath, 'export default () => ({ revision: 1 });\n');

    const request = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'module' as const,
      module: { kind: 'workspace_file' as const, path: '.agent/execution/editable.ts' },
    };
    const first = await kernel.execute(request, context);
    await fs.writeFile(modulePath, 'export default () => ({ revision: 2 });\n');
    const second = await kernel.execute(request, context);

    expect(first).toMatchObject({
      status: 'success',
      result: {
        output: { ok: true, value: { revision: 1 } },
        provenance: [
          expect.objectContaining({
            source: 'marshal.module-source.workspace_file',
            contentDigest: expect.stringMatching(/^sha256:/),
          }),
        ],
      },
      receipt: {
        providerReceipt: {
          source: { identifier: '.agent/execution/editable.ts' },
          environment: { fingerprint: expect.stringMatching(/^sha256:/) },
        },
      },
    });
    expect(second.result?.output).toMatchObject({ ok: true, value: { revision: 2 } });
    const firstDigest = (first.result?.output as { source: { contentDigest: string } }).source
      .contentDigest;
    const secondDigest = (second.result?.output as { source: { contentDigest: string } }).source
      .contentDigest;
    expect(secondDigest).not.toBe(firstDigest);
  });

  it('loads a scoped runtime artifact through the capability broker and preserves provenance', async () => {
    const { kernel, context } = await fixture();
    const written = await kernel.runtimeExec(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        target: 'artifacts.write',
        input: {
          path: 'blocks/artifact.ts',
          scope: 'project',
          content: 'export const run = (input: { n: number }) => input.n * 3;\n',
        },
      },
      context,
    );
    expect(written.status).toBe('success');

    const executed = await kernel.execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        targetType: 'module',
        module: {
          kind: 'artifact',
          path: 'blocks/artifact.ts',
          scope: 'project',
          export: 'run',
        },
        input: { n: 14 },
      },
      context,
    );

    expect(executed).toMatchObject({
      status: 'success',
      result: {
        output: {
          ok: true,
          value: 42,
          source: {
            kind: 'artifact',
            identifier: 'project:blocks/artifact.ts',
            contentDigest: expect.stringMatching(/^sha256:/),
          },
        },
        provenance: expect.arrayContaining([
          expect.objectContaining({ source: 'marshal.module-source.artifact' }),
          expect.objectContaining({ source: 'marshal.artifacts' }),
        ]),
      },
    });
  });
});
