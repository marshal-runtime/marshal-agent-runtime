import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DelegationManager,
  type DelegationAdapterPort,
  type DelegationContext,
} from '@marshal/agent-runtime-delegation';
import { FileDelegationStore } from '../src/delegationStore.js';

// Swarm preallocates one portable path segment per execution and writes it into
// its own run journal before dispatch; every child then names that exact id as
// its parent. A runtime that mints its own id instead strands the lineage: the
// parent record lands under an unrelated name and no child can ever resolve it.
const PREALLOCATED = `swarm-${'9f3c'.repeat(16)}`;
const context: DelegationContext = { scope: { sessionId: 'owner-session' } };

describe('durable delegation lineage across a preallocated identity', () => {
  let root: string;
  let store: FileDelegationStore;
  let adapter: DelegationAdapterPort;
  let manager: DelegationManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'delegation-lineage-'));
    store = new FileDelegationStore({ rootDirectory: root });
    adapter = {
      spawn: vi.fn(async ({ delegationId }) => ({
        adapterHandle: `host-session-for-${delegationId}`,
        state: 'running' as const,
      })),
      continue: vi.fn(async () => ({ state: 'running' as const })),
      wait: vi.fn(async () => ({ state: 'done' as const })),
      pause: vi.fn(async () => {}),
      cancel: vi.fn(async () => ({ state: 'failed' as const })),
    };
    manager = new DelegationManager({ store, adapter });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists the caller-preallocated id on disk so a child spawn resolves its parent', async () => {
    const parent = await manager.spawn(
      { prompt: 'root planner task', delegationId: PREALLOCATED, role: 'planner' },
      context,
    );

    expect(parent.delegationId).toBe(PREALLOCATED);
    expect(await readdir(root)).toEqual([`${PREALLOCATED}.json`]);
    expect(await store.get(PREALLOCATED)).toMatchObject({
      delegationId: PREALLOCATED,
      adapterHandle: `host-session-for-${PREALLOCATED}`,
    });

    const child = await manager.spawn(
      { prompt: 'worker task', parentDelegationId: PREALLOCATED, role: 'worker' },
      context,
    );

    expect(child.parentDelegationId).toBe(PREALLOCATED);
    expect(await store.get(child.delegationId)).toMatchObject({
      parentDelegationId: PREALLOCATED,
    });
  });

  it('registers the record before dispatch so the adapter can read its own lineage', async () => {
    adapter.spawn = vi.fn(async ({ delegationId }) => {
      // MarshalDelegationAdapter resolves the parent's integration ref here; the
      // record must already be durable at this point, not only after spawn returns.
      expect(await store.get(delegationId)).toMatchObject({ delegationId });
      return { adapterHandle: 'host-session', state: 'running' as const };
    });

    await manager.spawn({ prompt: 'root', delegationId: PREALLOCATED }, context);
    expect(adapter.spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects a child whose parent was never registered', async () => {
    await expect(
      manager.spawn({ prompt: 'orphan worker', parentDelegationId: PREALLOCATED }, context),
    ).rejects.toThrow(`Delegation "${PREALLOCATED}" was not found.`);
  });
});
