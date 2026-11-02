import { describe, expect, it } from 'vitest';
import {
  createRuntimeServiceContainer,
  createRuntimeServiceToken,
  getRuntimeServiceContainer,
} from '../src/index.js';
import type { RuntimeServiceAccessor } from '../src/services.js';

describe('runtime service container', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };

  it('resolves primary, ordered contributions, and self', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<number>('@test/container:values');
    await container.bind(token, { useValue: 1 });
    await container.bindMany(token, { useValue: 3, order: 2 });
    await container.bindMany(token, { useValue: 2, order: 1 });
    expect(container.get(token)).toBe(1);
    expect(container.getAll(token)).toEqual([1, 2, 3]);
    const self = container.get(createRuntimeServiceToken<typeof container>('@marshal/runtime/services:container'));
    expect(self).toBe(container);
  });

  it('restores replaced primaries and decorators in registration order', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<string>('@test/container:chain');
    await container.bind(token, { useValue: 'base' });
    const replacement = await container.replace(token, { useValue: 'replacement' });
    const decorator = await container.decorate(token, (value) => `[${value}]`);
    expect(container.get(token)).toBe('[replacement]');
    await decorator.dispose();
    expect(container.get(token)).toBe('replacement');
    await replacement.dispose();
    expect(container.get(token)).toBe('base');
  });

  it('restores the remaining replacement chain after out-of-order disposal', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<string>('@test/container:replacements');
    await container.bind(token, { useValue: 'base' });
    const first = await container.replace(token, { useValue: 'first' });
    const second = await container.replace(token, { useValue: 'second' });

    await first.dispose();
    expect(container.get(token)).toBe('second');
    await second.dispose();
    expect(container.get(token)).toBe('base');
  });

  it('applies decorators to the primary returned by getAll', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<number>('@test/container:decorated-all');
    await container.bind(token, { useValue: 1 });
    await container.bindMany(token, { useValue: 2 });
    await container.decorate(token, (value) => value + 10);

    expect(container.getAll(token)).toEqual([11, 2]);
  });

  it('caches singleton and scoped values but not transient values', async () => {
    const container = createRuntimeServiceContainer();
    const singleton = createRuntimeServiceToken<object>('@test/container:singleton');
    const scoped = createRuntimeServiceToken<object>('@test/container:scoped');
    const transient = createRuntimeServiceToken<object>('@test/container:transient');
    await container.bind(singleton, { useFactory: () => ({}), lifetime: 'singleton' });
    await container.bind(scoped, { useFactory: () => ({}), lifetime: 'scoped' });
    await container.bind(transient, { useFactory: () => ({}), lifetime: 'transient' });
    const scope = await container.createScope();
    expect(container.get(singleton)).toBe(container.get(singleton));
    expect(scope.get(scoped)).toBe(scope.get(scoped));
    expect(scope.get(transient)).not.toBe(scope.get(transient));
  });

  it('starts and shuts down lifecycle services in order', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<{ id: string }>('@test/container:lifecycle');
    const events: string[] = [];
    await container.bind(token, {
      useFactory: () => ({ id: 'one' }),
      lifetime: 'singleton',
      start: (value) => { events.push(`start:${value.id}`); },
      shutdown: (value) => { events.push(`stop:${value.id}`); },
    });
    await container.start();
    await container.shutdown();
    await container.shutdown();
    expect(events).toEqual(['start:one', 'stop:one']);
  });

  it('starts dependencies and contributions before reversing shutdown order', async () => {
    const container = createRuntimeServiceContainer();
    const dependency = createRuntimeServiceToken<{ id: string }>('@test/container:dependency');
    const service = createRuntimeServiceToken<{ id: string }>('@test/container:ordered-lifecycle');
    const events: string[] = [];
    await container.bind(dependency, {
      useFactory: () => ({ id: 'dependency' }),
      lifetime: 'singleton',
      start: (value) => { events.push(`start:${value.id}`); },
      shutdown: (value) => { events.push(`stop:${value.id}`); },
    });
    await container.bind(service, {
      useFactory: (services) => {
        services.get(dependency);
        return { id: 'primary' };
      },
      lifetime: 'singleton',
      start: (value) => { events.push(`start:${value.id}`); },
      shutdown: (value) => { events.push(`stop:${value.id}`); },
    });
    await container.bindMany(service, {
      useFactory: () => ({ id: 'contribution' }),
      lifetime: 'singleton',
      start: (value) => { events.push(`start:${value.id}`); },
      shutdown: (value) => { events.push(`stop:${value.id}`); },
    });

    await container.start();
    await container.shutdown();

    expect(events).toEqual([
      'start:dependency',
      'start:primary',
      'start:contribution',
      'stop:contribution',
      'stop:primary',
      'stop:dependency',
    ]);
  });

  it('starts scoped lifecycle bindings for each ready scope', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<{ id: number }>('@test/container:scoped-lifecycle');
    const events: string[] = [];
    let nextId = 0;
    await container.bind(token, {
      useFactory: () => ({ id: ++nextId }),
      lifetime: 'scoped',
      start: (value) => { events.push(`start:${value.id}`); },
      shutdown: (value) => { events.push(`stop:${value.id}`); },
    });

    await container.start();
    const scope = await container.createScope();
    await scope.shutdown();
    await container.shutdown();

    expect(events).toEqual(['start:1', 'start:2', 'stop:2', 'stop:1']);
  });

  it('starts lifecycle bindings in scopes created before container startup', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<{ id: number }>('@test/container:prestart-scope');
    const events: string[] = [];
    let nextId = 0;
    await container.bind(token, {
      useFactory: () => ({ id: ++nextId }),
      lifetime: 'scoped',
      start: (value) => { events.push(`start:${value.id}`); },
      shutdown: (value) => { events.push(`stop:${value.id}`); },
    });
    const scope = await container.createScope();

    await container.start();
    await scope.shutdown();
    await container.shutdown();

    expect(events).toEqual(['start:1', 'start:2', 'stop:2', 'stop:1']);
  });

  it('disposes realized shutdown-only bindings and rejects scoped capture', async () => {
    const container = createRuntimeServiceContainer();
    const shutdownOnly = createRuntimeServiceToken<object>('@test/container:shutdown-only');
    const scoped = createRuntimeServiceToken<object>('@test/container:captured-scoped');
    const singleton = createRuntimeServiceToken<object>('@test/container:capturing-singleton');
    const events: string[] = [];
    const handle = await container.bind(shutdownOnly, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      shutdown: () => { events.push('shutdown'); },
    });
    container.get(shutdownOnly);
    await handle.dispose();
    expect(events).toEqual(['shutdown']);

    await container.bind(scoped, {
      useFactory: () => ({}),
      lifetime: 'scoped',
    });
    await container.bind(singleton, {
      useFactory: (services) => services.get(scoped),
      lifetime: 'singleton',
    });
    expect(() => container.get(singleton)).toThrow(/cannot capture scoped/i);
  });

  it('provides one process singleton', () => {
    expect(getRuntimeServiceContainer()).toBe(getRuntimeServiceContainer());
  });

  it('caches decorated singleton and scoped values, then invalidates chain changes', async () => {
    const container = createRuntimeServiceContainer();
    const singleton = createRuntimeServiceToken<number>('@test/container:decorated-singleton-cache');
    const scoped = createRuntimeServiceToken<number>('@test/container:decorated-scoped-cache');
    await container.bind(singleton, { useFactory: () => 1, lifetime: 'singleton' });
    await container.bind(scoped, { useFactory: () => 1, lifetime: 'scoped' });
    let calls = 0;
    const decorator = await container.decorate(singleton, (value) => (calls++, value + 1));
    expect(container.get(singleton)).toBe(2);
    expect(container.get(singleton)).toBe(2);
    expect(calls).toBe(1);
    await decorator.dispose();
    expect(container.get(singleton)).toBe(1);

    const scope = await container.createScope();
    let scopedCalls = 0;
    await container.decorate(scoped, (value) => (scopedCalls++, value + 1));
    expect(scope.get(scoped)).toBe(2);
    expect(scope.get(scoped)).toBe(2);
    expect(scopedCalls).toBe(1);
    const replacement = await container.replace(singleton, { useValue: 3 });
    expect(container.get(singleton)).toBe(3);
    await replacement.dispose();
    expect(container.get(singleton)).toBe(1);
  });

  it('rejects scoped capture from decorators and lifecycle start hooks', async () => {
    const container = createRuntimeServiceContainer();
    const scoped = createRuntimeServiceToken<object>('@test/container:decorator-scoped');
    const decorated = createRuntimeServiceToken<object>('@test/container:decorator-singleton');
    const started = createRuntimeServiceToken<object>('@test/container:start-singleton');
    await container.bind(scoped, { useFactory: () => ({}), lifetime: 'scoped' });
    await container.bind(decorated, { useValue: {} });
    await container.decorate(decorated, (_value, services) => services.get(scoped));
    expect(() => container.get(decorated)).toThrow(/cannot capture scoped/i);
    await container.bind(started, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: (_value, services) => { services.get(scoped); },
    });
    await expect(container.start()).rejects.toThrow(/cannot capture scoped/i);
  });

  it('waits for in-flight startup before shutdown and stops the started instance', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:serialized-start-shutdown');
    const gate = deferred<void>();
    const events: string[] = [];
    await container.bind(token, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: async () => { events.push('start'); await gate.promise; },
      shutdown: () => { events.push('stop'); },
    });
    const starting = container.start();
    const stopping = container.shutdown();
    expect(events).toEqual(['start']);
    gate.resolve();
    await starting;
    await stopping;
    expect(events).toEqual(['start', 'stop']);
  });

  it('retains start-hook reentrancy protection until settlement and then stays idempotent', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:async-start-guard');
    const gate = deferred<void>();
    await container.bind(token, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: async () => gate.promise,
    });

    const starting = container.start();
    expect(() => container.start()).toThrow(/cannot start from a start hook/i);
    gate.resolve();
    await starting;
    await expect(container.start()).resolves.toBeUndefined();
    await container.shutdown();
  });

  it('memoizes scope shutdown and root waits for an already-running scope shutdown', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:scope-shutdown');
    const gate = deferred<void>();
    await container.bind(token, {
      useFactory: () => ({}),
      lifetime: 'scoped',
      shutdown: async () => gate.promise,
    });
    await container.start();
    const scope = await container.createScope();
    scope.get(token);
    const first = scope.shutdown();
    const second = scope.shutdown();
    expect(second).toBe(first);
    const root = container.shutdown();
    let settled = false;
    void root.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await root;
  });

  it('restores a replacement when its cleanup fails and aggregates the failure', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:failed-replacement-cleanup');
    const events: string[] = [];
    await container.bind(token, {
      useFactory: () => ({ id: 'base' }),
      lifetime: 'singleton',
      shutdown: () => { events.push('base-stop'); },
    });
    await container.start();
    const replacement = await container.replace(token, {
      useFactory: () => ({ id: 'replacement' }),
      lifetime: 'singleton',
      shutdown: () => { events.push('replacement-stop'); throw new Error('cleanup failed'); },
    });
    await expect(replacement.dispose()).rejects.toThrow('cleanup failed');
    expect(container.get(token)).toEqual({ id: 'base' });
    expect(events).toContain('replacement-stop');
  });

  it('runs shutdown for a realized binding disposed before container start', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:prestart-disposal');
    const events: string[] = [];
    const handle = await container.bind(token, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: () => { events.push('start'); },
      shutdown: () => { events.push('stop'); },
    });
    container.get(token);
    await handle.dispose();
    expect(events).toEqual(['stop']);
  });

  it('waits for a late registration startup before root shutdown snapshots instances', async () => {
    const container = createRuntimeServiceContainer();
    const initial = createRuntimeServiceToken<object>('@test/container:late-initial');
    const late = createRuntimeServiceToken<object>('@test/container:late');
    const initialGate = deferred<void>();
    const lateGate = deferred<void>();
    const events: string[] = [];
    await container.bind(initial, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: async () => { await initialGate.promise; },
    });
    const starting = container.start();
    await Promise.resolve();
    const registration = container.bind(late, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: async () => { events.push('late-start'); await lateGate.promise; },
      shutdown: () => { events.push('late-stop'); },
    });
    const stopping = container.shutdown();
    lateGate.resolve();
    initialGate.resolve();
    await registration;
    await starting;
    await stopping;
    expect(events).toEqual(['late-start', 'late-stop']);
  });

  it('rejects scope operations after shutdown begins', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:closing-scope');
    const gate = deferred<void>();
    await container.bind(token, {
      useFactory: () => ({}),
      lifetime: 'scoped',
      shutdown: async () => gate.promise,
    });
    await container.start();
    const scope = await container.createScope();
    scope.get(token);
    const stopping = scope.shutdown();
    expect(() => scope.get(token)).toThrow(/shut down/i);
    gate.resolve();
    await stopping;
  });

  it('rejects awaited re-entrant startup from lifecycle hooks', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:reentrant-start');
    await container.bind(token, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: async () => { await container.start(); },
    });
    await expect(container.start()).rejects.toThrow(/cannot start from a start hook/i);
  });

  it('keeps the startup guard active while an asynchronous hook is pending', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:async-start-guard');
    const gate = deferred<void>();
    await container.bind(token, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: async () => gate.promise,
    });
    const starting = container.start();
    await Promise.resolve();
    expect(() => container.start()).toThrow(/cannot start from a start hook/i);
    gate.resolve();
    await starting;
    await container.shutdown();
  });

  it('runs shutdown for an instance whose startup hook failed', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:failed-start-cleanup');
    const events: string[] = [];
    await container.bind(token, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: () => { events.push('start'); throw new Error('start failed'); },
      shutdown: () => { events.push('stop'); },
    });
    await expect(container.start()).rejects.toThrow('start failed');
    await expect(container.shutdown()).rejects.toThrow('start failed');
    expect(events).toEqual(['start', 'stop']);
  });

  it('tears down realized lifecycle instances skipped after startup failure', async () => {
    const container = createRuntimeServiceContainer();
    const failed = createRuntimeServiceToken<object>('@test/container:startup-failure');
    const skipped = createRuntimeServiceToken<object>('@test/container:startup-skipped');
    const events: string[] = [];
    await container.bind(failed, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      start: () => { events.push('failed-start'); throw new Error('boom'); },
      shutdown: () => { events.push('failed-stop'); },
    });
    await container.bind(skipped, {
      useFactory: (services) => { services.get(failed); return {}; },
      lifetime: 'singleton',
      start: () => { events.push('skipped-start'); },
      shutdown: () => { events.push('skipped-stop'); },
    });
    container.get(skipped);
    await expect(container.start()).rejects.toThrow('boom');
    await expect(container.shutdown()).rejects.toThrow('boom');
    expect(events).toEqual(['failed-start', 'skipped-stop', 'failed-stop']);
  });

  it('aggregates independent root shutdown failures', async () => {
    const container = createRuntimeServiceContainer();
    const first = createRuntimeServiceToken<object>('@test/container:shutdown-failure-first');
    const second = createRuntimeServiceToken<object>('@test/container:shutdown-failure-second');
    await container.bind(first, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      shutdown: () => { throw new Error('first shutdown failed'); },
    });
    await container.bind(second, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      shutdown: () => { throw new Error('second shutdown failed'); },
    });
    container.get(first);
    container.get(second);

    const failure = await container.shutdown().catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError ? failure.errors : []).toHaveLength(2);
    await expect(container.shutdown()).rejects.toBe(failure);
  });

  it('rejects scoped capture from singleton shutdown hooks', async () => {
    const container = createRuntimeServiceContainer();
    const scoped = createRuntimeServiceToken<object>('@test/container:shutdown-scoped');
    const singleton = createRuntimeServiceToken<object>('@test/container:shutdown-singleton');
    await container.bind(scoped, {
      useFactory: () => ({}),
      lifetime: 'scoped',
    });
    await container.bind(singleton, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      shutdown: (_value, services) => { services.get(scoped); },
    });
    container.get(singleton);
    await expect(container.shutdown()).rejects.toThrow(/cannot capture scoped/i);
  });

  it('preserves singleton lifetime for retained factory and decorator accessors', async () => {
    const container = createRuntimeServiceContainer();
    const scoped = createRuntimeServiceToken<object>('@test/container:retained-scoped');
    const singleton = createRuntimeServiceToken<{ read(): object }>('@test/container:retained-singleton');
    const decorated = createRuntimeServiceToken<object>('@test/container:retained-decorated');
    let factoryAccessor!: RuntimeServiceAccessor;
    let decoratorAccessor!: RuntimeServiceAccessor;
    await container.bind(scoped, { useFactory: () => ({}), lifetime: 'scoped' });
    await container.bind(singleton, {
      useFactory: (services) => {
        factoryAccessor = services;
        return { read: () => factoryAccessor.get(scoped) };
      },
      lifetime: 'singleton',
    });
    await container.bind(decorated, { useValue: {} });
    await container.decorate(decorated, (_value, services) => {
      decoratorAccessor = services;
      return _value;
    });
    container.get(singleton);
    container.get(decorated);
    expect(() => factoryAccessor.get(scoped)).toThrow(/cannot capture scoped/i);
    expect(() => decoratorAccessor.get(scoped)).toThrow(/cannot capture scoped/i);
  });

  it('runs one shutdown hook when disposal races container shutdown', async () => {
    const container = createRuntimeServiceContainer();
    const token = createRuntimeServiceToken<object>('@test/container:atomic-stop');
    const gate = deferred<void>();
    let stops = 0;
    const handle = await container.bind(token, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      shutdown: async () => { stops++; await gate.promise; },
    });
    container.get(token);
    const disposing = handle.dispose();
    const shuttingDown = container.shutdown();
    gate.resolve();
    await Promise.all([disposing, shuttingDown]);
    expect(stops).toBe(1);
  });

  it('rejects late scoped realization after scope shutdown starts', async () => {
    const container = createRuntimeServiceContainer();
    const existing = createRuntimeServiceToken<object>('@test/container:scope-existing');
    const late = createRuntimeServiceToken<object>('@test/container:scope-late');
    const gate = deferred<void>();
    let starts = 0;
    await container.bind(existing, {
      useFactory: () => ({}),
      lifetime: 'scoped',
      shutdown: async () => gate.promise,
    });
    await container.start();
    const scope = await container.createScope();
    const stopping = scope.shutdown();
    const registration = container.bind(late, {
      useFactory: () => ({}),
      lifetime: 'scoped',
      start: () => { starts++; },
    });
    gate.resolve();
    await stopping;
    await expect(registration).rejects.toThrow(/scope is shut down/i);
    expect(starts).toBe(1);
    await container.shutdown();
  });

  it('rejects realizing new lifecycle services from shutdown accessors', async () => {
    const container = createRuntimeServiceContainer();
    const first = createRuntimeServiceToken<object>('@test/container:teardown-first');
    const second = createRuntimeServiceToken<object>('@test/container:teardown-second');
    let realized = 0;
    await container.bind(second, {
      useFactory: () => { realized++; return {}; },
      lifetime: 'singleton',
      shutdown: () => undefined,
    });
    await container.bind(first, {
      useFactory: () => ({}),
      lifetime: 'singleton',
      shutdown: (_value, services) => { services.get(second); },
    });
    container.get(first);
    await expect(container.shutdown()).rejects.toThrow(/during shutdown/i);
    expect(realized).toBe(0);
  });
});
