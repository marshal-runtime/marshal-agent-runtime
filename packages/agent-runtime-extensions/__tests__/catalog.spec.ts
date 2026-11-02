import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import {
  RuntimeExtensionCatalog,
  RuntimeExtensionCatalogError,
  type RuntimeExtensionCatalogSourceEntry,
  type RuntimeExtensionLifecycleService,
} from '../src/index.js';

const FILESYSTEM_ROOT = path.parse(process.cwd()).root;

const context: InvocationContext = {
  principal: { id: 'catalog-test', kind: 'agent' },
  scope: { workspaceId: 'workspace' },
};

function candidate(id: string, origin: RuntimeExtensionCatalogSourceEntry['origin']): RuntimeExtensionCatalogSourceEntry {
  return {
    id,
    identity: `@example/${id}`,
    version: '1.0.0',
    origin,
    title: id,
    description: 'catalog entry',
    request: {
      packageRoot: path.join(FILESYSTEM_ROOT, 'extensions', id),
      integrity: {
        algorithm: 'sha256',
        domain: 'marshal-runtime-extension-package-v1',
        value: 'a'.repeat(64),
      },
    },
  };
}

function lifecycle(): RuntimeExtensionLifecycleService & { installed: ReturnType<RuntimeExtensionLifecycleService['list']> } {
  const service = {
    installed: [] as ReturnType<RuntimeExtensionLifecycleService['list']>,
    restore: () => [],
    discover: () => [],
    install: async (request: RuntimeExtensionCatalogSourceEntry['request']) => ({
      identity: '@example/native', version: '1.0.0', integrity: request.integrity,
      entrypoint: 'dist/index.cjs', status: 'enabled' as const,
    }),
    update: async (_identity: string, request: RuntimeExtensionCatalogSourceEntry['request']) => ({
      identity: '@example/native', version: '1.0.0', integrity: request.integrity,
      entrypoint: 'dist/index.cjs', status: 'enabled' as const,
    }),
    configure: async () => { throw new Error('unused'); },
    enable: async () => { throw new Error('unused'); },
    disable: async () => { throw new Error('unused'); },
    remove: async () => {},
    get: () => undefined,
    list: () => service.installed,
  };
  return service;
}

describe('RuntimeExtensionCatalog', () => {
  it('isolates source listing by context and orders all supported origins', async () => {
    const seen: InvocationContext[] = [];
    const catalog = new RuntimeExtensionCatalog({
      lifecycle: lifecycle(),
      sources: [{
        id: 'host',
        label: 'Host',
        list: (received) => {
          seen.push(received);
          return [
            candidate('typescript', 'authored-typescript'),
            candidate('dsh', 'dsh'),
            candidate('native', 'native'),
          ];
        },
      }],
    });
    const result = await catalog.discover(context);
    expect(seen).toEqual([context]);
    expect(result.map((entry) => entry.origin)).toEqual(['dsh', 'native', 'authored-typescript']);
  });

  it('rejects a stale candidate before lifecycle mutation', async () => {
    let calls = 0;
    const service = lifecycle();
    const catalog = new RuntimeExtensionCatalog({
      lifecycle: service,
      sources: [{
        id: 'changing',
        label: 'Changing',
        list: () => [candidate(`entry-${++calls}`, 'native')],
      }],
    });
    await expect(catalog.install('entry-1', context)).rejects.toMatchObject({ code: 'INVALID_ENTRY' });
    expect(calls).toBe(2);
  });

  it('collapses identical entries and honors cancellation', async () => {
    const item = candidate('same', 'native');
    const catalog = new RuntimeExtensionCatalog({
      lifecycle: lifecycle(),
      sources: [{ id: 'one', label: 'One', list: () => [item] }, { id: 'two', label: 'Two', list: () => [item] }],
    });
    await expect(catalog.discover(context)).resolves.toHaveLength(1);
    const signal = { aborted: true } as InvocationContext['signal'];
    await expect(catalog.discover(context, { signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects conflicting duplicates even when their IDs match', async () => {
    const first = candidate('same', 'native');
    const second = { ...first, request: { ...first.request, packageRoot: path.join(FILESYSTEM_ROOT, 'extensions', 'other') } };
    const catalog = new RuntimeExtensionCatalog({
      lifecycle: lifecycle(),
      sources: [{ id: 'one', label: 'One', list: () => [first] }, { id: 'two', label: 'Two', list: () => [second] }],
    });
    await expect(catalog.discover(context)).rejects.toMatchObject({ code: 'DUPLICATE_ENTRY' });
  });

});
