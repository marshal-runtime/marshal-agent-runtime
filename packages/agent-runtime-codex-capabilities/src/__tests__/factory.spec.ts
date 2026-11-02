import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { REACT_UI_TEMPLATE_URI } from '@marshal/agent-runtime-ui';
import { createCodexCapabilityProviders } from '../createCodexCapabilityProviders.js';
import type { SubagentBackend, SubagentSnapshot } from '../subagents/types.js';

describe('Codex capability provider bundle', () => {
  it('can disable both portable UI planes for a headless adapter composition', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'codex-headless-factory-'));
    try {
      const bundle = createCodexCapabilityProviders({
        workspacePath,
        stateRoot: join(workspacePath, '.state'),
        delegation: { enabled: false },
        declarativeUi: { enabled: false },
        reactUi: { enabled: false },
      });
      expect(bundle.providers).toEqual([]);
      expect(bundle.ui).toBeUndefined();
      expect(bundle.reactUi).toBeUndefined();
      expect(bundle.mcpAppsResources).toBeUndefined();
      expect(bundle.catalog).toBeUndefined();
      await bundle.dispose();
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('projects React-only UI metadata through the React render slot', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'codex-react-only-factory-'));
    try {
      const bundle = createCodexCapabilityProviders({
        workspacePath,
        stateRoot: join(workspacePath, '.state'),
        delegation: { enabled: false },
        declarativeUi: { enabled: false },
      });
      expect(bundle.ui).toBeUndefined();
      expect(bundle.reactUi).toBeDefined();
      expect(bundle.mcpAppsResources?.toolMetadata).toBeUndefined();
      expect(bundle.mcpAppsResources?.reactToolMetadata?.().ui.resourceUri).toBe(
        REACT_UI_TEMPLATE_URI,
      );
      await bundle.dispose();
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('returns core-compatible providers plus a host-consumable MCP Apps resource port', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'codex-capability-factory-'));
    const snapshot: SubagentSnapshot = {
      id: 'thread-1',
      status: 'idle',
      workspacePath: process.cwd(),
    };
    const backend: SubagentBackend = {
      spawn: vi.fn(async () => snapshot),
      run: vi.fn(async () => ({ thread: snapshot, response: '', status: 'completed' as const })),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => snapshot),
      followUp: vi.fn(async () => ({
        thread: snapshot,
        response: '',
        status: 'completed' as const,
      })),
      wait: vi.fn(async () => snapshot),
      cancel: vi.fn(async () => snapshot),
      inspect: vi.fn(async () => snapshot),
    };
    try {
      const bundle = createCodexCapabilityProviders({
        workspacePath: process.cwd(),
        stateRoot,
        subagentBackend: backend,
      });
      expect(bundle.reactUi).toBeDefined();
      expect(bundle.providers).toEqual([
        bundle.delegation?.provider,
        bundle.uiProvider,
        bundle.reactUi?.provider,
      ]);
      expect(bundle.delegation?.adapter).toBeDefined();
      expect(bundle.delegation?.provider.list({ principal: { id: 'test', kind: 'agent' } }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'runtime.delegation.spawn' }),
          expect.objectContaining({ name: 'runtime.delegation.wait' }),
          expect.objectContaining({ name: 'runtime.delegation.cancel' }),
        ]));
      expect(bundle.mcpAppsResources).not.toBe(bundle.ui);
      expect(bundle.mcpAppsResources!.templateUri).toBe('ui://marshal-declarative/runtime-renderer');
      expect(bundle.mcpAppsResources!.toolMetadata().ui.resourceUri).toBe(
        bundle.mcpAppsResources!.templateUri,
      );
      expect('reactToolMetadata' in bundle.mcpAppsResources!).toBe(true);
      if ('reactToolMetadata' in bundle.mcpAppsResources!) {
        expect(bundle.mcpAppsResources!.reactToolMetadata().ui.resourceUri).toBe(
          REACT_UI_TEMPLATE_URI,
        );
      }
      await bundle.dispose();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
