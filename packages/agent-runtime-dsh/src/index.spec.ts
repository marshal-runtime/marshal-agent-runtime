import { describe, expect, it } from 'vitest';
import { createDshCatalogSource, createDshRuntimeExtension, DSH_PLUGIN_BRIDGE_COMMIT } from './index.js';

describe('DSH compatibility adapter', () => {
  it('projects deterministic commands and cleans them up on disposal', async () => {
    const result = createDshRuntimeExtension({
      apply: (ctx) => {
        ctx.commands.command('bridge').action((input) => ({ input }));
      },
    });
    const activation = await result.module.activate({
      manifest: {
        schemaVersion: 1,
        identity: '@marshal/agent-runtime-dsh',
        version: '0.1.0',
        entrypoint: 'index.js',
        moduleFormat: 'commonjs-bundle-v1',
      },
      search: () => Promise.reject(new Error('unused')),
      execute: () => Promise.reject(new Error('unused')),
    });
    expect(result.commands.list()).toHaveLength(1);
    expect(activation.capabilityProviders?.[0]?.id).toBe('dsh.commands');
    await activation.dispose?.();
    expect(result.commands.list()).toHaveLength(0);
  });

  it('publishes an offline, pinned dsh catalog entry', async () => {
    const source = createDshCatalogSource({
      packageRoot: 'C:\\materialized\\dsh',
      integrity: { algorithm: 'sha256', domain: 'marshal-runtime-extension-package-v1', value: 'a'.repeat(64) },
    });
    expect((await source.list({
      principal: { id: 'catalog-test', kind: 'agent' },
    }))[0]).toMatchObject({ origin: 'dsh', version: '0.3.0' });
    expect(DSH_PLUGIN_BRIDGE_COMMIT).toHaveLength(40);
  });
});
