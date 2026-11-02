import { describe, expect, it, vi } from 'vitest';
import {
  DelegationManager, InMemoryDelegationStore,
  type DelegationAdapterPort, type DelegationContext,
} from '../src/index.js';

const owner: DelegationContext = { scope: { sessionId: 'owner', workspaceId: 'workspace' } };

function fixture() {
  const store = new InMemoryDelegationStore();
  const adapter: DelegationAdapterPort = {
    spawn: vi.fn(async ({ delegationId }) => ({
      state: 'running', adapterHandle: delegationId, sessionId: 'child',
      executionId: 'turn-1', transcriptRef: '/sessions/child/transcript.jsonl',
      model: 'resolved-model', reasoningEffort: 'high',
    })),
    continue: vi.fn(async () => ({ state: 'running' })),
    wait: vi.fn(async () => ({
      state: 'done', result: 'Conversational response',
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
    })),
    complete: vi.fn(async () => ({ state: 'done', changeRefs: ['commit-1'] })),
    pause: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ state: 'failed', error: 'Cancelled' })),
  };
  return { store, adapter, manager: new DelegationManager({ store, adapter }) };
}

describe('explicit delegation lifecycle', () => {
  it('returns continuation delivery acknowledgement without persisting it on execution records', async () => {
    const { store, adapter, manager } = fixture();
    const launched = await manager.spawn({ prompt: 'work' }, owner);
    adapter.continue = vi.fn(async () => ({ state: 'running', continuationDelivery: 'held' }));
    const held = await manager.continue({ delegationId: launched.delegationId, prompt: 'Exact pending resolution' }, owner);
    expect(held.continuationDelivery).toBe('held');
    expect(await store.get(launched.delegationId)).not.toHaveProperty('continuationDelivery');
    expect(await manager.wait(launched, owner)).not.toHaveProperty('continuationDelivery');
    adapter.continue = vi.fn(async () => ({ state: 'running', continuationDelivery: 'accepted' }));
    expect((await manager.continue({ delegationId: launched.delegationId, prompt: 'Exact pending resolution' }, owner)).continuationDelivery).toBe('accepted');
    expect(await store.get(launched.delegationId)).not.toHaveProperty('continuationDelivery');
  });

  it('registers before dispatch and deduplicates concurrent/recovered launches', async () => {
    const { store, adapter, manager } = fixture();
    const spawn = adapter.spawn;
    adapter.spawn = vi.fn(async (request, context) => {
      expect(await store.get(request.delegationId)).toMatchObject({ state: 'pending' });
      return spawn(request, context);
    });
    const request = { prompt: 'work', delegationId: 'registered-task', idempotencyKey: 'launch-1' };
    const records = await Promise.all([manager.spawn(request, owner), manager.spawn(request, owner)]);
    expect(records[0].delegationId).toBe(records[1].delegationId);
    const recovered = new DelegationManager({ store, adapter });
    expect((await recovered.spawn(request, owner)).delegationId).toBe('registered-task');
    expect(adapter.spawn).toHaveBeenCalledTimes(1);
    await expect(recovered.spawn({ ...request, prompt: 'different' }, owner)).rejects.toThrow('different launch inputs');
  });

  it('isolates retry keys by caller and rejects preallocated identity theft', async () => {
    const { manager } = fixture();
    const request = { prompt: 'work', idempotencyKey: 'same' };
    const first = await manager.spawn(request, owner);
    const other: DelegationContext = { scope: { sessionId: 'other', workspaceId: 'workspace' } };
    const second = await manager.spawn(request, other);
    expect(first.delegationId).not.toBe(second.delegationId);
    await expect(manager.spawn({ ...request, delegationId: first.delegationId }, other)).rejects.toThrow('another session');
    await expect(manager.complete(first, other)).rejects.toThrow('another session');
  });

  it('separates turn completion from explicit finalization and preserves execution references', async () => {
    const { manager, adapter } = fixture();
    const launched = await manager.spawn({ prompt: 'work' }, owner);
    const settled = await manager.wait(launched, owner);
    expect(settled.finalized).toBeUndefined();
    expect(adapter.complete).not.toHaveBeenCalled();
    expect(settled).toMatchObject({
      transcriptRef: '/sessions/child/transcript.jsonl', model: 'resolved-model',
      reasoningEffort: 'high', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
    });
    const final = await manager.complete(launched, { scope: { sessionId: 'child' } });
    expect(final).toMatchObject({ finalized: true, changeRefs: ['commit-1'] });
    expect(final.usage?.costUsd).toBeUndefined();
    await manager.complete(launched, owner);
    const later = await manager.continue({ ...launched, prompt: 'Unrelated question' }, owner);
    expect(later).toEqual(final);
    expect(adapter.continue).not.toHaveBeenCalled();
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it('resumes an interrupted pending dispatch with the same registered identity', async () => {
    const { manager, store, adapter } = fixture();
    const request = { prompt: 'work', idempotencyKey: 'launch' };
    const record = await manager.spawn(request, owner);
    await store.update({ ...record, state: 'pending', adapterHandle: undefined });
    const recovered = new DelegationManager({ store, adapter });
    const resumed = await recovered.spawn(request, owner);
    expect(resumed.delegationId).toBe(record.delegationId);
    expect(adapter.spawn).toHaveBeenCalledTimes(2);
  });

  it('passes the authorized target identity when separate runs share an adapter handle', async () => {
    const { manager, adapter } = fixture();
    adapter.spawn = vi.fn(async () => ({ state: 'running', adapterHandle: 'owner', sessionId: 'owner' }));
    const first = await manager.spawn({ prompt: 'First run' }, owner);
    const second = await manager.spawn({ prompt: 'Second run' }, owner);
    await manager.complete(second, owner);
    expect(adapter.complete).toHaveBeenCalledWith('owner', owner, second.delegationId);
    expect(first.delegationId).not.toBe(second.delegationId);
    await expect(manager.complete(first, { scope: { sessionId: 'outsider' } })).rejects.toThrow('another session');
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it('does not silently finalize when the host lacks the operation', async () => {
    const { store, adapter } = fixture();
    adapter.complete = undefined;
    const manager = new DelegationManager({ store, adapter });
    const launched = await manager.spawn({ prompt: 'work' }, owner);
    await expect(manager.complete(launched, owner)).rejects.toThrow('does not support');
    expect((await store.get(launched.delegationId))?.finalized).toBeUndefined();
  });

  it('accepts final measurements for the completed turn without adopting another conversation', async () => {
    const { manager, adapter, store } = fixture();
    let release!: () => void;
    adapter.wait = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { state: 'done', executionId: 'turn-1', usage: { inputTokens: 200, outputTokens: 40, cachedInputTokens: 150 } };
    };
    const launched = await manager.spawn({ prompt: 'work' }, owner);
    const waiting = manager.wait(launched, owner);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await manager.complete(launched, owner);
    release();
    expect(await waiting).toMatchObject({ finalized: true, state: 'done', usage: { inputTokens: 200, outputTokens: 40 } });
    expect((await store.get(launched.delegationId))?.executionId).toBe('turn-1');
  });

  it('requires the controlling extension for managed mutations, preserving ordinary delegation', async () => {
    const { manager, adapter } = fixture();
    const principal = { id: 'principal', kind: 'agent' as const };
    const controlled: DelegationContext = { scope: owner.scope, invocation: {
      principal, scope: owner.scope,
      metadata: { delegationId: 'controlled', runtimeTaskController: 'example.controller' },
    } };
    await expect(manager.spawn({ prompt: 'Bypass task tree' }, controlled)).rejects.toThrow('extension task operations');
    const authorized = { ...controlled, invocation: { ...controlled.invocation!, metadata: {
      ...controlled.invocation!.metadata, runtimeExtensionIdentity: 'example.controller',
    } } };
    const registered = await manager.spawn({ prompt: 'Registered by controller' }, authorized);
    await expect(manager.complete(registered, controlled)).rejects.toThrow('extension task operations');
    await expect(manager.complete(registered, authorized)).resolves.toMatchObject({ finalized: true });
    await expect(manager.spawn({ prompt: 'Ordinary independent delegation' }, owner)).resolves.toMatchObject({ state: 'running' });
    expect(adapter.spawn).toHaveBeenCalledTimes(2);
  });
});
