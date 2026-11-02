import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SCHEDULE_EFFECT_KINDS,
  createRuntimeKernel,
  type InvocationContext,
  type RuntimeScheduleSnapshot,
} from '@marshal/agent-runtime-core';
import {
  BoundedFileEffectReplayStore,
  EffectDispatcher,
  RUNTIME_SCHEDULE_CANCEL_CAPABILITY,
  RUNTIME_SCHEDULE_CREATE_CAPABILITY,
  RUNTIME_SCHEDULE_GET_CAPABILITY,
  RUNTIME_SCHEDULE_LIST_CAPABILITY,
  RUNTIME_SCHEDULE_PAUSE_CAPABILITY,
  RUNTIME_SCHEDULE_RESUME_CAPABILITY,
  RUNTIME_SCHEDULE_UPDATE_CAPABILITY,
  createRuntimeSchedulingProvider,
} from '../src/index.js';

const cleanup: string[] = [];
const context: InvocationContext = {
  principal: { id: 'schedule-agent', kind: 'agent' },
  scope: { workspaceId: 'workspace-schedules', projectId: 'project-schedules' },
};

afterEach(async () => {
  for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true });
});

describe('portable scheduling provider', () => {
  it('discovers every schedule operation, replays mutations, and keeps reads fresh', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-schedules-'));
    cleanup.push(root);
    const records = new Map<string, RuntimeScheduleSnapshot>();
    const calls: string[] = [];
    const handle = vi.fn(async (request: { kind: string; input?: unknown }) => {
      calls.push(request.kind);
      const input = request.input as Record<string, unknown>;
      if (request.kind === RUNTIME_SCHEDULE_EFFECT_KINDS.create) {
        const snapshot: RuntimeScheduleSnapshot = {
          scheduleId: 'schedule-1',
          state: 'active',
          timing: input.timing as RuntimeScheduleSnapshot['timing'],
          task: input.task as RuntimeScheduleSnapshot['task'],
        };
        records.set(snapshot.scheduleId, snapshot);
        return { status: 'success' as const, output: snapshot };
      }
      if (request.kind === RUNTIME_SCHEDULE_EFFECT_KINDS.get) {
        return { status: 'success' as const, output: records.get(String(input.scheduleId)) };
      }
      if (request.kind === RUNTIME_SCHEDULE_EFFECT_KINDS.list) {
        return { status: 'success' as const, output: { schedules: [...records.values()] } };
      }
      return { status: 'success' as const, output: { scheduleId: input.scheduleId } };
    });
    const effects = new EffectDispatcher({
      replay: new BoundedFileEffectReplayStore({ rootDirectory: path.join(root, 'replay') }),
      handler: {
        id: 'native-scheduler',
        supportedKinds: Object.values(RUNTIME_SCHEDULE_EFFECT_KINDS),
        handle,
      },
    });
    const kernel = createRuntimeKernel({
      permissionBroker: { decide: () => ({ decision: 'allow' }) },
    });
    kernel.register(createRuntimeSchedulingProvider({ effects, createId: () => 'read-id' }));

    const discovered = await kernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: 'schedules automation', limit: 20 },
      context,
    );
    expect(discovered.matches.map((match) => match.capability.name)).toEqual(
      expect.arrayContaining([
        RUNTIME_SCHEDULE_CREATE_CAPABILITY,
        RUNTIME_SCHEDULE_GET_CAPABILITY,
        RUNTIME_SCHEDULE_LIST_CAPABILITY,
        RUNTIME_SCHEDULE_UPDATE_CAPABILITY,
        RUNTIME_SCHEDULE_PAUSE_CAPABILITY,
        RUNTIME_SCHEDULE_RESUME_CAPABILITY,
        RUNTIME_SCHEDULE_CANCEL_CAPABILITY,
      ]),
    );

    const create = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      target: RUNTIME_SCHEDULE_CREATE_CAPABILITY,
      input: {
        timing: { kind: 'interval', everyMs: 60_000 },
        task: { kind: 'project.refresh', input: { project: 'alpha' } },
        idempotencyKey: 'schedule-create-alpha',
      },
    } as const;
    const first = await kernel.runtimeExec(create, context);
    const replayed = await kernel.runtimeExec(create, context);
    expect(first).toMatchObject({
      status: 'success',
      result: { output: { status: 'success', output: { scheduleId: 'schedule-1' } } },
    });
    expect(replayed).toMatchObject({
      status: 'success',
      result: { output: { receipt: { replayed: true } } },
    });
    expect(calls.filter((kind) => kind === RUNTIME_SCHEDULE_EFFECT_KINDS.create)).toHaveLength(1);

    const get = () =>
      kernel.runtimeExec(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          target: RUNTIME_SCHEDULE_GET_CAPABILITY,
          input: { scheduleId: 'schedule-1' },
        },
        context,
      );
    await get();
    records.set('schedule-1', { ...records.get('schedule-1')!, state: 'paused' });
    const refreshed = await get();
    expect(refreshed).toMatchObject({
      result: { output: { output: { scheduleId: 'schedule-1', state: 'paused' } } },
    });
    expect(calls.filter((kind) => kind === RUNTIME_SCHEDULE_EFFECT_KINDS.get)).toHaveLength(2);
  });

  it('returns an explicit unsupported envelope when the adapter has no scheduler', async () => {
    const effects = new EffectDispatcher();
    const kernel = createRuntimeKernel({
      permissionBroker: { decide: () => ({ decision: 'allow' }) },
    });
    kernel.register(createRuntimeSchedulingProvider({ effects }));
    const response = await kernel.runtimeExec(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        target: RUNTIME_SCHEDULE_CREATE_CAPABILITY,
        input: {
          timing: { kind: 'once', at: '2030-01-01T00:00:00.000Z' },
          task: { kind: 'reminder' },
          idempotencyKey: 'unsupported-schedule',
        },
      },
      context,
    );
    expect(response).toMatchObject({
      status: 'success',
      result: {
        output: {
          status: 'unsupported',
          reason: expect.stringContaining(RUNTIME_SCHEDULE_EFFECT_KINDS.create),
        },
      },
    });
  });

  it('validates timing before invoking an adapter', async () => {
    const handle = vi.fn(async () => ({ status: 'success' as const, output: {} }));
    const effects = new EffectDispatcher({
      handler: {
        id: 'scheduler',
        supportedKinds: Object.values(RUNTIME_SCHEDULE_EFFECT_KINDS),
        handle,
      },
    });
    const provider = createRuntimeSchedulingProvider({ effects });
    await expect(
      provider.invoke(
        RUNTIME_SCHEDULE_CREATE_CAPABILITY,
        {
          timing: { kind: 'interval', everyMs: 5 },
          task: { kind: 'too-fast' },
          idempotencyKey: 'invalid',
        },
        context,
      ),
    ).rejects.toThrow('at least 1000');
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects ambiguous or malformed schedule inputs before invoking an adapter', async () => {
    const handle = vi.fn(async () => ({ status: 'success' as const, output: {} }));
    const provider = createRuntimeSchedulingProvider({
      effects: new EffectDispatcher({
        handler: {
          id: 'scheduler',
          supportedKinds: Object.values(RUNTIME_SCHEDULE_EFFECT_KINDS),
          handle,
        },
      }),
    });

    const descriptors = await provider.list(context);
    expect(descriptors).toHaveLength(7);
    expect(
      descriptors.every(
        (descriptor) =>
          (descriptor.outputSchema as { required?: string[] } | undefined)?.required?.includes(
            'receipt',
          ) === true,
      ),
    ).toBe(true);

    const invalid: Array<[string, string, Record<string, unknown>]> = [
      [
        RUNTIME_SCHEDULE_CREATE_CAPABILITY,
        'unknown field',
        {
          timing: {
            kind: 'once',
            at: '2030-01-01T00:00:00Z',
            startsAt: '2030-01-01T00:00:00Z',
          },
          task: { kind: 'test' },
          idempotencyKey: 'unknown-once-field',
        },
      ],
      [
        RUNTIME_SCHEDULE_CREATE_CAPABILITY,
        'ISO date-time',
        {
          timing: { kind: 'once', at: 'January 1, 2030' },
          task: { kind: 'test' },
          idempotencyKey: 'loose-date',
        },
      ],
      [
        RUNTIME_SCHEDULE_CREATE_CAPABILITY,
        'must not be after',
        {
          timing: {
            kind: 'interval',
            everyMs: 60_000,
            startsAt: '2030-01-02T00:00:00Z',
            endsAt: '2030-01-01T00:00:00Z',
          },
          task: { kind: 'test' },
          idempotencyKey: 'reverse-bounds',
        },
      ],
      [
        RUNTIME_SCHEDULE_UPDATE_CAPABILITY,
        'requires timing, task, or metadata',
        { scheduleId: 'schedule-1', idempotencyKey: 'empty-update' },
      ],
      [RUNTIME_SCHEDULE_LIST_CAPABILITY, 'integer from 1 to 100', { limit: 101 }],
    ];

    for (const [capability, message, input] of invalid) {
      await expect(provider.invoke(capability, input, context)).rejects.toThrow(message);
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it('passes the exact principal and scope to adapters while keeping reads uncached', async () => {
    const seen: InvocationContext[] = [];
    const handle = vi.fn(async (_request: unknown, invocationContext: InvocationContext) => {
      seen.push(invocationContext);
      return {
        status: 'success' as const,
        output: { workspaceId: invocationContext.scope?.workspaceId },
      };
    });
    const provider = createRuntimeSchedulingProvider({
      effects: new EffectDispatcher({
        handler: {
          id: 'scoped-scheduler',
          supportedKinds: [RUNTIME_SCHEDULE_EFFECT_KINDS.get],
          handle,
        },
      }),
    });
    const otherContext: InvocationContext = {
      principal: { id: 'other-agent', kind: 'agent' },
      scope: { workspaceId: 'other-workspace', projectId: 'other-project' },
    };

    const first = await provider.invoke(
      RUNTIME_SCHEDULE_GET_CAPABILITY,
      { scheduleId: 'shared-looking-id' },
      context,
    );
    const second = await provider.invoke(
      RUNTIME_SCHEDULE_GET_CAPABILITY,
      { scheduleId: 'shared-looking-id' },
      otherContext,
    );

    expect(first.output).toMatchObject({
      status: 'success',
      output: { workspaceId: 'workspace-schedules' },
    });
    expect(second.output).toMatchObject({
      status: 'success',
      output: { workspaceId: 'other-workspace' },
    });
    expect(seen).toEqual([context, otherContext]);
    expect(handle).toHaveBeenCalledTimes(2);
  });
});
