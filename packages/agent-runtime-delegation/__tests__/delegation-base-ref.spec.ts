import { describe, expect, it, vi } from 'vitest';
import {
  DelegationManager,
  InMemoryDelegationStore,
  RUNTIME_DELEGATION_SPAWN,
  createRuntimeDelegationProvider,
  type DelegationAdapterPort,
  type DelegationAdapterSpawnRequest,
  type InvocationContext,
} from '../src/index.js';

function recordingAdapter(): {
  readonly adapter: DelegationAdapterPort;
  readonly launches: DelegationAdapterSpawnRequest[];
} {
  const launches: DelegationAdapterSpawnRequest[] = [];
  return {
    launches,
    adapter: {
      spawn: vi.fn(async (request: DelegationAdapterSpawnRequest) => {
        launches.push(request);
        return { adapterHandle: `host-${request.delegationId}`, state: 'running' as const };
      }),
      continue: vi.fn(async (adapterHandle: string) => ({ adapterHandle, state: 'running' as const })),
      wait: vi.fn(async (adapterHandle: string) => ({ adapterHandle, state: 'done' as const })),
      pause: vi.fn(async () => undefined),
      cancel: vi.fn(async (adapterHandle: string) => ({ adapterHandle, state: 'failed' as const })),
    },
  };
}

function invocation(): InvocationContext {
  return { principal: { id: 'test', kind: 'agent' } } as InvocationContext;
}

function spawnSchema(): Record<string, unknown> {
  const provider = createRuntimeDelegationProvider({
    manager: new DelegationManager({
      adapter: recordingAdapter().adapter,
      store: new InMemoryDelegationStore(),
    }),
  });
  const descriptor = provider.get?.(RUNTIME_DELEGATION_SPAWN);
  expect(descriptor).toBeDefined();
  return descriptor!.inputSchema as Record<string, unknown>;
}

describe('delegation baseRef transport', () => {
  it('declares baseRef in the strict spawn input schema', () => {
    const schema = spawnSchema();
    const properties = schema.properties as Record<string, unknown>;

    expect(schema.additionalProperties).toBe(false);
    expect(properties.baseRef).toEqual({ type: 'string', minLength: 1 });
    expect(schema.required).toEqual(['prompt']);
  });

  it('carries baseRef from a capability invocation to the adapter launch', async () => {
    const host = recordingAdapter();
    const provider = createRuntimeDelegationProvider({
      manager: new DelegationManager({
        adapter: host.adapter,
        store: new InMemoryDelegationStore(),
        createId: () => 'child-baseref',
      }),
    });

    const result = await provider.invoke(
      RUNTIME_DELEGATION_SPAWN,
      {
        prompt: 'Implement the port',
        scope: 'repository:marshal',
        workspaceMode: 'isolated',
        baseRef: 'refs/runtime-test/run-1/integration/repository-marshal',
      },
      invocation(),
    );

    expect(result.output).toMatchObject({ delegationId: 'child-baseref', state: 'running' });
    expect(host.launches).toHaveLength(1);
    expect(host.launches[0]).toEqual({
      delegationId: 'child-baseref',
      request: {
        prompt: 'Implement the port',
        scope: 'repository:marshal',
        workspaceMode: 'isolated',
        baseRef: 'refs/runtime-test/run-1/integration/repository-marshal',
      },
    });
  });

  it('omits baseRef entirely when the caller declares none', async () => {
    const host = recordingAdapter();
    const manager = new DelegationManager({
      adapter: host.adapter,
      store: new InMemoryDelegationStore(),
      createId: () => 'child-no-baseref',
    });

    await manager.spawn({ prompt: 'Implement the port' });

    expect(host.launches[0].request).toEqual({ prompt: 'Implement the port' });
    expect('baseRef' in host.launches[0].request).toBe(false);
  });

  it('passes baseRef through the manager without recording it on the delegation', async () => {
    const host = recordingAdapter();
    const store = new InMemoryDelegationStore();
    const manager = new DelegationManager({
      adapter: host.adapter,
      store,
      createId: () => 'child-transport',
    });

    const record = await manager.spawn({
      prompt: 'Implement the port',
      baseRef: 'refs/runtime-test/run-1/integration/repository-runtime',
    });

    expect(host.launches[0].request.baseRef).toBe(
      'refs/runtime-test/run-1/integration/repository-runtime',
    );
    expect(record).not.toHaveProperty('baseRef');
    await expect(store.get('child-transport')).resolves.not.toHaveProperty('baseRef');
  });

  it('rejects a baseRef that is not a non-empty string', async () => {
    const provider = createRuntimeDelegationProvider({
      manager: new DelegationManager({
        adapter: recordingAdapter().adapter,
        store: new InMemoryDelegationStore(),
      }),
    });

    for (const baseRef of ['', '   ', 7, null]) {
      await expect(
        provider.invoke(
          RUNTIME_DELEGATION_SPAWN,
          { prompt: 'Implement the port', baseRef },
          invocation(),
        ),
      ).rejects.toThrow(/baseRef must be a non-empty string/);
    }
  });
});
