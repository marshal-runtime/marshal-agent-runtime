import { describe, expect, it, vi } from 'vitest';
import {
  DelegationManager,
  InMemoryDelegationStore,
  type DelegationAdapterPort,
} from '../src/index.js';

function adapter(overrides: Partial<DelegationAdapterPort> = {}): DelegationAdapterPort {
  return {
    spawn: vi.fn(async ({ delegationId }) => ({
      adapterHandle: `host-${delegationId}`,
      state: 'running',
    })),
    continue: vi.fn(async (adapterHandle) => ({
      adapterHandle,
      state: 'running',
    })),
    wait: vi.fn(async (adapterHandle) => ({
      adapterHandle,
      state: 'done',
      result: 'done',
    })),
    cancel: vi.fn(async (adapterHandle) => ({
      adapterHandle,
      state: 'failed',
    })),
    ...overrides,
  };
}

describe('DelegationManager', () => {
  it('continues a host session and persists its plain result and change refs', async () => {
    const store = new InMemoryDelegationStore();
    const host = adapter({
      continue: vi.fn(async (adapterHandle, prompt) => ({
        adapterHandle,
        state: 'done',
        result: { prompt, summary: 'continued' },
        changeRefs: ['commit:abc123'],
      })),
    });
    const manager = new DelegationManager({
      adapter: host,
      store,
      createId: () => 'child-1',
    });

    await manager.spawn(
      { prompt: 'Start work' },
      { scope: { workspaceId: 'workspace-1' } },
    );
    const result = await manager.continue(
      { delegationId: 'child-1', prompt: 'Add focused tests' },
    );

    expect(host.continue).toHaveBeenCalledWith(
      'host-child-1',
      'Add focused tests',
      {},
    );
    expect(result).toMatchObject({
      delegationId: 'child-1',
      state: 'done',
      result: { prompt: 'Add focused tests', summary: 'continued' },
      changeRefs: ['commit:abc123'],
    });
    expect(result.scope).toBeUndefined();
    expect(result.request).toBeUndefined();
  });

  it('persists a failed dispatch so its registered task remains inspectable', async () => {
    const failure = new Error('host unavailable');
    const store = new InMemoryDelegationStore();
    const manager = new DelegationManager({
      adapter: adapter({
        spawn: vi.fn(async () => {
          throw failure;
        }),
      }),
      store,
      createId: () => 'child-failed',
    });

    await expect(manager.spawn({ prompt: 'Start work' })).resolves.toMatchObject({
      delegationId: 'child-failed', state: 'failed', error: failure.message,
    });
    expect(await store.list()).toHaveLength(1);
  });

  it('cancels a running host session when its state cannot be published', async () => {
    const failure = new Error('delegation state unavailable');
    const store = new InMemoryDelegationStore();
    vi.spyOn(store, 'update').mockRejectedValue(failure);
    const host = adapter();
    const manager = new DelegationManager({
      adapter: host,
      store,
      createId: () => 'child-unpublished',
    });

    await expect(manager.spawn({ prompt: 'Start work' })).rejects.toBe(failure);
    expect(host.cancel).toHaveBeenCalledWith('host-child-unpublished', {});
  });

  it('does not impose an arbitrary delegation record limit', async () => {
    const store = new InMemoryDelegationStore();
    let nextId = 0;
    const manager = new DelegationManager({
      adapter: adapter(),
      store,
      createId: () => `child-${nextId++}`,
    });

    for (let index = 0; index < 150; index += 1) {
      await manager.spawn({ prompt: `Work ${index}` });
    }

    await expect(store.list()).resolves.toHaveLength(150);
  });
});
