import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionCheck } from '@marshal/agent-runtime-core';
import { describe, expect, it } from 'vitest';
import { CodexExtensionAutopilotPolicy } from '../extensionAutopilot.js';

describe('Codex runtime extension autopilot policy', () => {
  it('persists runtime-wide global grants and scoped per-extension grants', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-extension-autopilot-'));
    const statePath = path.join(root, 'autopilot.json');
    try {
      const policy = await CodexExtensionAutopilotPolicy.open(statePath);
      await policy.setExtension(
        '@marshal/brain',
        true,
        ['marshal.memory-v2-brain-compat'],
        ['memory.', 'knowledge.'],
      );

      expect(await policy.resolveGrants(check('marshal.memory-v2-brain-compat', 'memory.brain.remember')))
        .toEqual([expect.objectContaining({ permission: '*', capability: 'memory.brain.remember' })]);
      expect(await policy.resolveGrants(check('marshal.runtime.builtins', 'runtime.exec'))).toEqual([]);

      await policy.setExtension('@marshal/brain', false);
      await policy.setGlobal(true);
      const reloaded = await CodexExtensionAutopilotPolicy.open(statePath);
      expect(reloaded.snapshot()).toMatchObject({
        globalEnabled: true,
        extensions: [{ identity: '@marshal/brain', enabled: false }],
      });
      expect(await reloaded.resolveGrants(check('marshal.memory-v2-brain-compat', 'memory.brain.recall')))
        .toHaveLength(1);
      expect(await reloaded.resolveGrants(check('unregistered-provider', 'memory.brain.recall')))
        .toHaveLength(1);

      await reloaded.syncExtensions([]);
      expect(reloaded.snapshot().extensions).toEqual([]);
      expect(await reloaded.resolveGrants(check('marshal.memory-v2-brain-compat', 'memory.brain.recall')))
        .toEqual([]);
      await reloaded.setGlobal(false);
      expect(await reloaded.resolveGrants(check('marshal.memory-v2-brain-compat', 'memory.brain.recall')))
        .toEqual([]);
      await reloaded.setExtension('@marshal/reused-provider', false, ['marshal.memory-v2-brain-compat']);
      expect(await reloaded.resolveGrants(check('marshal.memory-v2-brain-compat', 'memory.brain.recall')))
        .toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not activate grants when persistence fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-extension-autopilot-failure-'));
    const statePath = path.join(root, 'autopilot.json');
    try {
      const policy = await CodexExtensionAutopilotPolicy.open(statePath);
      await fs.mkdir(statePath);

      await expect(policy.setGlobal(true)).rejects.toThrow();
      expect(policy.snapshot().globalEnabled).toBe(false);
      await expect(policy.resolveGrants(check('provider', 'memory.write'))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reloads concurrent changes and grants manifest-contributed nested capabilities', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-extension-autopilot-shared-'));
    const statePath = path.join(root, 'autopilot.json');
    try {
      const writer = await CodexExtensionAutopilotPolicy.open(statePath);
      const authorizer = await CodexExtensionAutopilotPolicy.open(statePath);
      await Promise.all([
        writer.setGlobal(true),
        authorizer.setExtension(
          '@marshal/brain',
          true,
          ['marshal.holographic-memory'],
          ['memory.', 'knowledge.'],
        ),
      ]);

      await authorizer.refresh();
      expect(authorizer.snapshot()).toMatchObject({
        globalEnabled: true,
        extensions: [{ identity: '@marshal/brain', enabled: true }],
      });
      expect(await authorizer.resolveGrants(check(
        'marshal.holographic-memory',
        'memory.brain.recall',
        { executionId: 'brain-root', lineage: { rootExecutionId: 'brain-root', depth: 0 } },
      ))).toHaveLength(1);
      expect(await authorizer.resolveGrants(check(
        'marshal.workspace-knowledge',
        'knowledge.workspace.ensure',
        {
          executionId: 'brain-root',
          lineage: { rootExecutionId: 'brain-root', depth: 0 },
        },
      ))).toHaveLength(1);
      expect(await authorizer.resolveGrants(check(
        'marshal.workspace-knowledge',
        'knowledge.workspace.ensure',
        { executionId: 'direct-root', lineage: { rootExecutionId: 'direct-root', depth: 0 } },
      ))).toHaveLength(1);

      await authorizer.setGlobal(false);
      expect(await authorizer.resolveGrants(check(
        'marshal.holographic-memory',
        'memory.brain.recall',
      ))).toHaveLength(1);
      expect(await authorizer.resolveGrants(check(
        'marshal.workspace-knowledge',
        'knowledge.workspace.ensure',
        { executionId: 'brain-root', lineage: { rootExecutionId: 'brain-root', depth: 0 } },
      ))).toHaveLength(1);
      expect(await authorizer.resolveGrants(check(
        'marshal.runtime.builtins',
        'runtime.exec',
        { executionId: 'brain-root', lineage: { rootExecutionId: 'brain-root', depth: 0 } },
      ))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function check(
  providerId: string,
  name: string,
  execution: Pick<PermissionCheck['context'], 'executionId' | 'lineage'> = {},
): PermissionCheck {
  return {
    capability: {
      protocolVersion: '1.0.0',
      name,
      version: '1.0.0',
      description: name,
      outputSchema: {},
      provider: { id: providerId },
    },
    request: { protocolVersion: '1.0.0', target: name },
    context: { principal: { id: 'codex', kind: 'agent' }, ...execution },
    requirements: [{ permission: 'memory.write' }],
  };
}
