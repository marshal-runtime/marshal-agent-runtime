import { describe, expect, it, vi } from 'vitest';
import { createLifecycleEvent, RuntimeLifecycleBus } from '../src/index.js';

describe('RuntimeLifecycleBus', () => {
  it('delivers typed and wildcard events and supports idempotent disposal', async () => {
    const bus = new RuntimeLifecycleBus();
    const typed = vi.fn();
    const wildcard = vi.fn();
    const subscription = bus.subscribe('runtime.search.completed', typed);
    bus.subscribe('*', wildcard);
    const event = createLifecycleEvent(
      'runtime.search.completed',
      { query: 'memory', resultCount: 2 },
      { id: 'event-1', occurredAt: '2026-01-01T00:00:00.000Z' },
    );

    await bus.publish(event);
    expect(typed).toHaveBeenCalledWith(event);
    expect(wildcard).toHaveBeenCalledWith(event);

    subscription.dispose();
    subscription.dispose();
    await bus.publish(event);
    expect(typed).toHaveBeenCalledTimes(1);
    expect(wildcard).toHaveBeenCalledTimes(2);
  });

  it('preserves the exact invocation context for lifecycle observers', async () => {
    const bus = new RuntimeLifecycleBus();
    const listener = vi.fn();
    const context = {
      principal: { id: 'agent-1', kind: 'agent' },
      scope: { workspaceId: 'workspace-1', projectId: 'project-1' },
      executionId: 'execution-1',
    } as const;
    const event = createLifecycleEvent(
      'runtime.execution.started',
      {
        executionId: 'execution-1',
        target: 'runtime.invoke',
        providerId: 'provider-1',
      },
      {
        id: 'event-context',
        occurredAt: '2026-01-01T00:00:00.000Z',
        context,
      },
    );
    bus.subscribe('runtime.execution.started', listener);

    await bus.publish(event);

    expect(listener).toHaveBeenCalledWith(event);
    expect(listener.mock.calls[0]?.[0].context).toBe(context);
  });

  it('isolates listener and listener-error-handler failures', async () => {
    const errors: unknown[] = [];
    const bus = new RuntimeLifecycleBus({
      onListenerError: (error) => {
        errors.push(error);
        throw new Error('reporting failed');
      },
    });
    const healthy = vi.fn();
    bus.subscribe('*', () => {
      throw new Error('listener failed');
    });
    bus.subscribe('*', healthy);

    await expect(
      bus.publish(
        createLifecycleEvent(
          'runtime.provider.disposed',
          { providerId: 'provider' },
          { id: 'event-2', occurredAt: '2026-01-01T00:00:00.000Z' },
        ),
      ),
    ).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
  });
});
