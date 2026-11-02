import { describe, expect, it, vi } from 'vitest';
import { DelegationManager, InMemoryDelegationStore, createRuntimeDelegationProvider, type DelegationAdapterPort, type DelegationContext, type DelegationRecord } from '../src/index.js';

const context: DelegationContext = { scope: { sessionId: 'owner' } };
const request = { delegationId: 'root', expectedError: { message: 'classified transport failure' }, reason: 'Operator verified the original execution remains live', idempotencyKey: 'recover-1' };
async function fixture(overrides: Partial<DelegationRecord> = {}) {
  const store = new InMemoryDelegationStore();
  await store.create({ delegationId: 'root', state: 'failed', adapterHandle: 'owner', sessionId: 'owner', ownerSessionId: 'owner', error: request.expectedError, ...overrides });
  await store.create({ delegationId: 'child', parentDelegationId: 'root', state: 'running', adapterHandle: 'child-session' });
  const adapter: DelegationAdapterPort = {
    spawn: vi.fn(async () => ({ state: 'running' })),
    continue: vi.fn(async () => ({ state: 'running' })),
    wait: vi.fn(async () => ({ state: 'done' })),
    pause: vi.fn(async () => {}),
    cancel: vi.fn(async () => ({ state: 'failed' })),
    recover: vi.fn(async () => ({ adapterHandle: 'owner', sessionId: 'owner', state: 'running', executionId: 'existing-turn' })),
  };
  return { store, adapter, manager: new DelegationManager({ store, adapter }) };
}

describe('explicit failed delegation recovery', () => {
  it('preserves original identity and child lineage, and retries after store commit without another host read', async () => {
    const { store, adapter, manager } = await fixture();
    expect((await manager.continue({ delegationId: 'root', prompt: 'ordinary follow-up' }, context)).state).toBe('failed');
    expect(adapter.continue).not.toHaveBeenCalled();
    const recovered = await manager.recover(request, context);
    expect(recovered).toMatchObject({ delegationId: 'root', adapterHandle: 'owner', sessionId: 'owner', state: 'running', executionId: 'existing-turn', recovery: { idempotencyKey: 'recover-1', previousError: request.expectedError } });
    expect(recovered.error).toBeUndefined();
    expect(await store.get('child')).toMatchObject({ parentDelegationId: 'root', adapterHandle: 'child-session', state: 'running' });
    const restarted = new DelegationManager({ store, adapter });
    expect(await restarted.recover(request, context)).toEqual(recovered);
    expect(adapter.recover).toHaveBeenCalledTimes(1);
    expect(adapter.spawn).not.toHaveBeenCalled();
    expect(adapter.continue).not.toHaveBeenCalled();
    await expect(restarted.recover({ ...request, reason: 'different' }, context)).rejects.toThrow('different inputs');
  });

  it('accepts an idle host turn as done without task finalization, then allows explicit continuation', async () => {
    const { adapter, manager } = await fixture();
    adapter.recover = vi.fn(async () => ({ state: 'done', adapterHandle: 'owner' }));
    const recovered = await manager.recover(request, context);
    expect(recovered.state).toBe('done');
    expect(recovered.finalized).toBeUndefined();
    expect((await manager.continue({ delegationId: 'root', prompt: 'resume work' }, context)).state).toBe('running');
    expect(adapter.continue).toHaveBeenCalledTimes(1);
  });

  it.each([{ finalized: true }, { state: 'done' as const }, { error: 'different failure' }])('rejects stale or finalized failure %j', async (override) => {
    const { adapter, manager } = await fixture(override);
    await expect(manager.recover(request, context)).rejects.toThrow('matching nonfinalized failed');
    expect(adapter.recover).not.toHaveBeenCalled();
  });

  it('rejects foreign callers and managed agents outside their controller before reading the host', async () => {
    const { adapter, manager } = await fixture();
    await expect(manager.recover(request, { scope: { sessionId: 'foreign' } })).rejects.toThrow('another session');
    const managed: DelegationContext = { scope: context.scope, invocation: {
      principal: { id: 'agent', kind: 'agent' }, scope: context.scope,
      metadata: { runtimeTaskController: 'controller', runtimeExtensionIdentity: 'foreign-controller' },
    } };
    await expect(manager.recover(request, managed)).rejects.toThrow('extension task operations');
    expect(adapter.recover).not.toHaveBeenCalled();
  });

  it.each([{ state: 'failed' as const }, { state: 'running' as const, adapterHandle: 'new-session' }, { state: 'running' as const, sessionId: 'new-session' }])('rejects a nonlive or replacement host execution %j', async (snapshot) => {
    const { store, adapter, manager } = await fixture();
    adapter.recover = vi.fn(async () => snapshot);
    await expect(manager.recover(request, context)).rejects.toThrow('same existing live execution');
    expect((await store.get('root'))?.state).toBe('failed');
  });

  it('does not overwrite a failure that changes while host verification is in progress', async () => {
    const { store, adapter, manager } = await fixture();
    adapter.recover = vi.fn(async () => {
      await store.update({ ...(await store.get('root'))!, error: 'new failure' });
      return { state: 'running' };
    });
    await expect(manager.recover(request, context)).rejects.toThrow('matching nonfinalized failed');
    expect((await store.get('root'))?.error).toBe('new failure');
  });

  it('uses the existing continuation permission with a separate explicit recovery capability', async () => {
    const { manager } = await fixture();
    const provider = createRuntimeDelegationProvider({ manager });
    expect(await provider.get('runtime.delegation.recover')).toMatchObject({ permissions: [{ permission: 'runtime.delegation.continue', risk: 'high' }] });
    expect(await provider.invoke('runtime.delegation.recover', request, { principal: { id: 'agent', kind: 'agent' }, scope: context.scope })).toMatchObject({ output: { state: 'running', delegationId: 'root' } });
  });
});
