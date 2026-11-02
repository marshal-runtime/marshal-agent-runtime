import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  RuntimeExtensionLifecycleService,
  RuntimeExtensionAutopilotService,
  RuntimeExtensionStatusService,
  RuntimeExtensionStatusSnapshot,
} from '@marshal/agent-runtime-extensions';
import { describe, expect, it, vi } from 'vitest';
import { callExtensionManagementTool } from '../extensionManagement.js';
import { createCodexMcpServer } from '../server.js';
import { InMemoryRuntimeKernel } from '../testing/inMemoryRuntime.js';

describe('Codex runtime extension management MCP App', () => {
  it('lists, renders, and performs live lifecycle actions', async () => {
    let snapshot = statusSnapshot('installed-enabled');
    let globalAutopilot = false;
    let extensionAutopilot = false;
    const status = {
      snapshot: vi.fn(() => snapshot), subscribe: vi.fn(), refresh: vi.fn(async () => snapshot),
      install: vi.fn(), enable: vi.fn(),
      disable: vi.fn(async () => {
        snapshot = statusSnapshot('installed-disabled');
        return lifecycle.list()[0]!;
      }),
      remove: vi.fn(),
    };
    const lifecycle = {
      restore: vi.fn(), discover: vi.fn(), install: vi.fn(), update: vi.fn(), configure: vi.fn(),
      setProviderOverride: vi.fn(), clearProviderOverride: vi.fn(), enable: vi.fn(), disable: vi.fn(),
      remove: vi.fn(), get: vi.fn(() => lifecycle.list()[0]),
      list: vi.fn(() => [{
        identity: '@test/live', version: '1.0.0', integrity: { algorithm: 'sha256', value: 'a'.repeat(64) },
        entrypoint: 'dist/index.js', status: snapshot.entries[0]!.status === 'installed-enabled' ? 'enabled' : 'disabled',
        activationOrder: 1, configuration: {}, request: { packageRoot: 'C:/extensions/live' },
        health: 'healthy', blockReasons: [], dependencies: [], providedServices: [], requiredServices: [],
        providerSelections: [], configurationValues: { mode: 'fast' }, providerOverrides: {}, contractConflicts: [],
        capabilityProviderIds: ['@test/live:provider'],
        contributedCapabilityPrefixes: ['test.'],
      }]),
    };
    const autopilot = {
      refresh: vi.fn(),
      snapshot: vi.fn(() => ({
        globalEnabled: globalAutopilot,
        extensions: [{
          identity: '@test/live',
          enabled: extensionAutopilot,
          capabilityProviderIds: ['@test/live:provider'],
        }],
      })),
      setGlobal: vi.fn(async (enabled: boolean) => { globalAutopilot = enabled; }),
      setExtension: vi.fn(async (_identity: string, enabled: boolean) => { extensionAutopilot = enabled; }),
      syncExtensions: vi.fn(),
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCodexMcpServer({
      kernel: new InMemoryRuntimeKernel([]),
      extensionStatus: status as unknown as RuntimeExtensionStatusService,
      extensionLifecycle: lifecycle as unknown as RuntimeExtensionLifecycleService,
      extensionAutopilot: autopilot as unknown as RuntimeExtensionAutopilotService,
    });
    const client = new Client({ name: 'extension-manager-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toContain('runtime_extensions_manage');
      expect(tools.find((tool) => tool.name === 'runtime_extensions_manage')?._meta).toMatchObject({
        ui: { resourceUri: 'ui://marshal-runtime/extensions', visibility: ['model', 'app'] },
        'openai/widgetAccessible': true,
      });
      expect(tools.find((tool) => tool.name === 'runtime_extensions_action')?._meta).toMatchObject({
        ui: { visibility: ['model', 'app'] },
        'openai/widgetAccessible': true,
      });
      expect(tools.find((tool) => tool.name === 'runtime_extensions_action')?._meta).not.toHaveProperty('ui.resourceUri');
      expect(tools.find((tool) => tool.name === 'runtime_extensions_action')?._meta).not.toHaveProperty('ui/resourceUri');
      expect((await client.listResources()).resources.map((resource) => resource.uri)).toContain('ui://marshal-runtime/extensions');
      expect((await client.readResource({ uri: 'ui://marshal-runtime/extensions' })).contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' });
      expect(autopilot.refresh).toHaveBeenCalledOnce();
      const opened = await client.callTool({ name: 'runtime_extensions_manage', arguments: {} });
      expect(opened.structuredContent).toMatchObject({ view: { revision: 1, entries: [{ status: 'installed-enabled' }] } });
      const extensionAuto = await client.callTool({
        name: 'runtime_extensions_action',
        arguments: { action: 'set-extension-autopilot', identity: '@test/live', enabled: true },
      });
      expect(autopilot.setExtension).toHaveBeenCalledWith(
        '@test/live',
        true,
        ['@test/live:provider'],
        ['test.'],
      );
      expect(extensionAuto.structuredContent).toMatchObject({
        view: { entries: [{ autopilot: true }] },
      });
      const globalAuto = await client.callTool({
        name: 'runtime_extensions_action',
        arguments: { action: 'set-global-autopilot', enabled: true },
      });
      expect(globalAuto.structuredContent).toMatchObject({ view: { globalAutopilot: true } });
      const disabled = await client.callTool({ name: 'runtime_extensions_action', arguments: { action: 'disable', identity: '@test/live' } });
      expect(status.disable).toHaveBeenCalledWith('@test/live', expect.objectContaining({}));
      expect(disabled.structuredContent).toMatchObject({ view: { entries: [{ status: 'installed-disabled' }] } });
      expect(disabled._meta).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns a live view without awaiting a slow installation', async () => {
    let finishInstallation: (() => void) | undefined;
    const install = vi.fn(() => new Promise<void>((resolve) => {
      finishInstallation = resolve;
    }));
    const status = {
      snapshot: vi.fn(() => detectedSnapshot()), subscribe: vi.fn(), refresh: vi.fn(async () => detectedSnapshot()),
      install, enable: vi.fn(), disable: vi.fn(), remove: vi.fn(),
    };

    const outcome = await Promise.race([
      callExtensionManagementTool(
        { status: status as unknown as RuntimeExtensionStatusService },
        'runtime_extensions_action',
        { action: 'install', packageRoot: 'C:/extensions/live' },
      ).then((value) => ({ kind: 'returned' as const, value })),
      new Promise<{ kind: 'timed-out' }>((resolve) => setTimeout(() => resolve({ kind: 'timed-out' }), 100)),
    ]);

    expect(outcome.kind).toBe('returned');
    expect(install).toHaveBeenCalledOnce();
    if (outcome.kind === 'returned') {
      expect(outcome.value?.content[0]?.text).toBe('Runtime extension installation started.');
      expect(outcome.value?._meta).toBeUndefined();
    }
    finishInstallation?.();
  });

  it('opens from the live snapshot without blocking first paint on a discovery refresh', async () => {
    const snapshot = detectedSnapshot();
    const status = {
      snapshot: vi.fn(() => snapshot), subscribe: vi.fn(),
      refresh: vi.fn(() => new Promise<RuntimeExtensionStatusSnapshot>(() => undefined)),
      install: vi.fn(), enable: vi.fn(), disable: vi.fn(), remove: vi.fn(),
    };

    const opened = await Promise.race([
      callExtensionManagementTool(
        { status: status as unknown as RuntimeExtensionStatusService },
        'runtime_extensions_manage',
        {},
      ),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('manager open timed out')), 100)),
    ]);

    expect(opened?.structuredContent).toMatchObject({ view: { revision: 1 } });
    expect(status.snapshot).toHaveBeenCalled();
    expect(status.refresh).not.toHaveBeenCalled();
  });
});

function statusSnapshot(status: 'installed-enabled' | 'installed-disabled'): RuntimeExtensionStatusSnapshot {
  return {
    revision: status === 'installed-enabled' ? 1 : 2, status: 'ready', changedAt: '2026-08-29T00:00:00.000Z',
    roots: ['C:/extensions'], diagnostics: [], entries: [{
      key: '@test/live', packageRoot: 'C:/extensions/live', identity: '@test/live', version: '1.0.0',
      status, configuration: { defaults: {}, values: { mode: 'fast' } }, diagnostics: [],
    }],
  };
}

function detectedSnapshot(): RuntimeExtensionStatusSnapshot {
  return {
    revision: 1, status: 'ready', changedAt: '2026-08-29T00:00:00.000Z', roots: ['C:/extensions'], diagnostics: [],
    entries: [{
      key: '@test/live', packageRoot: 'C:/extensions/live', identity: '@test/live', version: '1.0.0',
      status: 'detected-installable', configuration: { defaults: {} }, diagnostics: [],
    }],
  };
}
