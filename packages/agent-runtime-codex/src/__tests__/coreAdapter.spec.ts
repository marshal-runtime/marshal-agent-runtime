import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeExecutionCorrelation,
  createRuntimeReceiptCorrelationContext,
} from '@marshal/agent-runtime-core';
import { bindAgentRuntimeCore, normalizeWorkspaceIdentityPath } from '../coreAdapter.js';

describe('agent runtime core bridge', () => {
  it('preserves case-sensitive workspace identity while normalizing Windows paths', () => {
    expect(normalizeWorkspaceIdentityPath('/Repo', 'linux')).not.toBe(
      normalizeWorkspaceIdentityPath('/repo', 'linux'),
    );
    expect(normalizeWorkspaceIdentityPath('C:\\Repo', 'win32')).toBe(
      normalizeWorkspaceIdentityPath('c:\\repo', 'win32'),
    );
  });

  it('maps search requests and Codex context to the core protocol', async () => {
    const core = {
      runtimeSearch: vi.fn(async () => ({ matches: [] })),
      runtimeExec: vi.fn(async () => ({ status: 'success' })),
    };
    const kernel = bindAgentRuntimeCore(core, {
      principal: { id: 'codex-main', kind: 'agent' },
    });

    await kernel.search(
      { protocolVersion: '1.1.0', name: 'memory.search', query: 'durable memory', tags: ['memory'] },
      {
        sessionId: 'session-1',
        threadId: 'thread-1',
        workspacePath: 'C:/workspace',
        metadata: { task: 'adapter' },
      },
    );

    expect(core.runtimeSearch).toHaveBeenCalledWith(
      {
        query: 'durable memory',
        name: 'memory.search',
        tags: ['memory'],
        protocolVersion: '1.1.0',
      },
      {
        principal: { id: 'codex-main', kind: 'agent' },
        identity: {
          harnessId: 'codex',
          installationId: expect.stringMatching(/^codex-installation-[a-f0-9]{24}$/),
        },
        scope: expect.objectContaining({
          sessionId: 'session-1',
          threadId: 'thread-1',
          workspaceId: expect.stringMatching(/^workspace-[a-f0-9]{24}$/),
          workspacePath: expect.stringMatching(/workspace$/),
        }),
        executionId: undefined,
        signal: undefined,
        metadata: { task: 'adapter', codexAgentId: undefined },
      },
    );
  });

  it('uses only a trusted host project identity instead of aliasing the workspace', async () => {
    const core = {
      runtimeSearch: vi.fn(async () => ({ matches: [] })),
      runtimeExec: vi.fn(async () => ({ status: 'success' })),
    };
    const kernel = bindAgentRuntimeCore(core, { trustedProjectId: 'repository-alpha' });
    await kernel.search({}, { workspacePath: 'C:/workspace' });
    expect(core.runtimeSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: expect.objectContaining({
          workspaceId: expect.stringMatching(/^workspace-[a-f0-9]{24}$/),
          projectId: expect.stringMatching(/^project-[a-f0-9]{24}$/),
        }),
      }),
    );
  });

  it('projects configured installation identity while retaining the native agent id', async () => {
    const core = {
      runtimeSearch: vi.fn(async () => ({ matches: [] })),
      runtimeExec: vi.fn(async () => ({ status: 'success' })),
    };
    const kernel = bindAgentRuntimeCore(core, {
      identity: { installationId: 'install-1', profileId: 'profile-1' },
    });
    await kernel.search({}, { agentId: 'codex-child' });
    expect(core.runtimeSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        identity: {
          harnessId: 'codex',
          installationId: 'install-1',
          profileId: 'profile-1',
          agentId: 'codex-child',
        },
      }),
    );
  });

  it('maps inline modules to the registered core execution capability', async () => {
    const core = {
      runtimeSearch: vi.fn(async () => ({ matches: [] })),
      runtimeExec: vi.fn(async () => ({ status: 'success' })),
    };
    const kernel = bindAgentRuntimeCore(core, {
      inlineModuleCapability: 'execution.typescript.run',
      trustedInlineModuleCapability: 'execution.typescript.run.trusted',
    });
    const receiptCorrelationContext = createRuntimeReceiptCorrelationContext([
      createRuntimeExecutionCorrelation('mcpRequestId', 7),
    ]);

    await kernel.execute(
      {
        targetType: 'inline_module',
        source: 'export default async () => 42;',
        input: { value: 1 },
        executionMode: 'trusted_node',
        timeoutMs: 5_000,
        requestId: 'forged-request-id',
      },
      {
        requestId: 'request-1',
        sessionId: 'session-1',
        receiptCorrelationContext,
      },
    );

    expect(core.runtimeExec).toHaveBeenCalledWith(
      {
        protocolVersion: '1.0.0',
        target: 'execution.typescript.run.trusted',
        input: {
          source: 'export default async () => 42;',
          input: { value: 1 },
          timeoutMs: 5_000,
          executionMode: 'trusted_node',
        },
        requestId: 'request-1',
        approval: undefined,
      },
      expect.objectContaining({
        principal: expect.objectContaining({
          id: expect.stringMatching(/^codex-installation-local-[a-f0-9]{24}$/),
          kind: 'agent',
          claims: expect.objectContaining({
            ownershipBoundary: 'installation-local-single-user',
            multiProfileIsolation: false,
          }),
        }),
        scope: expect.objectContaining({ sessionId: 'session-1' }),
        executionId: 'request-1',
        receiptCorrelationContext,
      }),
    );
  });

  it('maps workspace and artifact modules to the editable module capability', async () => {
    const core = {
      runtimeSearch: vi.fn(async () => ({ matches: [] })),
      runtimeExec: vi.fn(async () => ({ status: 'success' })),
    };
    const kernel = bindAgentRuntimeCore(core, {
      moduleCapability: 'execution.module.run',
      trustedModuleCapability: 'execution.module.run.trusted',
    });

    await kernel.execute(
      {
        targetType: 'module',
        module: { kind: 'artifact', path: 'blocks/editable.ts', scope: 'project' },
        input: { value: 7 },
        executionMode: 'trusted_node',
      },
      { requestId: 'request-module', sessionId: 'session-1' },
    );

    expect(core.runtimeExec).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'execution.module.run.trusted',
        input: expect.objectContaining({
          module: { kind: 'artifact', path: 'blocks/editable.ts', scope: 'project' },
          input: { value: 7 },
        }),
      }),
      expect.objectContaining({ executionId: 'request-module' }),
    );
  });
});
