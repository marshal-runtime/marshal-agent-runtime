import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  createRuntimeKernel,
  type InvocationContext,
  type RuntimeKernel,
} from '@marshal/agent-runtime-core';
import {
  AGENT_WAKE_TASK_KIND,
  BoundedFileEffectReplayStore,
  EffectDispatcher,
  FileScheduleStore,
  RUNTIME_SCHEDULE_CANCEL_CAPABILITY,
  RUNTIME_SCHEDULE_CREATE_CAPABILITY,
  RUNTIME_SCHEDULE_GET_CAPABILITY,
  RUNTIME_SCHEDULE_LIST_CAPABILITY,
  RUNTIME_SCHEDULE_PAUSE_CAPABILITY,
  RUNTIME_SCHEDULE_RESUME_CAPABILITY,
  RUNTIME_SCHEDULE_UPDATE_CAPABILITY,
  RuntimeScheduleService,
  composeEffectHandlers,
  createAgentWakeRunner,
  createRuntimeSchedulingProvider,
  type RuntimeScheduleFire,
  type RuntimeScheduleServiceOptions,
  type RuntimeScheduleTaskRunner,
} from '../src/index.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const START = new Date('2026-10-26T10:00:00.000Z');
const WAKE_KIND = AGENT_WAKE_TASK_KIND;
const REFRESH_KIND = 'project.refresh';
const AGENT: InvocationContext = {
  principal: { id: 'agent-a', kind: 'agent' },
  scope: { workspaceId: 'workspace-a' },
};
const OTHER_AGENT: InvocationContext = {
  principal: { id: 'agent-b', kind: 'agent' },
  scope: { workspaceId: 'workspace-a' },
};
const WAKE_TASK = {
  kind: WAKE_KIND,
  input: { target: { sessionId: 'session-1' }, message: 'check the deploy' },
};

const READ_TARGETS = new Set([RUNTIME_SCHEDULE_GET_CAPABILITY, RUNTIME_SCHEDULE_LIST_CAPABILITY]);
const cleanup: string[] = [];
let root: string;
let keyCounter = 0;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-scheduler-'));
  cleanup.push(root);
  keyCounter = 0;
});

afterEach(async () => {
  for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true });
});

const iso = (millis: number) => new Date(millis).toISOString();

function clock(initial: Date = START) {
  let current = initial.getTime();
  return {
    now: () => new Date(current),
    set: (millis: number) => {
      current = millis;
    },
    advance: (millis: number) => {
      current += millis;
    },
    read: () => current,
  };
}

function createService(
  options: Partial<RuntimeScheduleServiceOptions> & { storeRoot?: string } = {},
) {
  const { storeRoot, ...rest } = options;
  return new RuntimeScheduleService({
    store: new FileScheduleStore({ rootDirectory: storeRoot ?? path.join(root, 'schedules') }),
    retryBackoffMs: 1_000,
    ...rest,
  });
}

function createKernel(service: RuntimeScheduleService): RuntimeKernel {
  const effects = new EffectDispatcher({
    handler: service,
    replay: new BoundedFileEffectReplayStore({ rootDirectory: path.join(root, 'replay') }),
  });
  const kernel = createRuntimeKernel({
    permissionBroker: { decide: () => ({ decision: 'allow' }) },
  });
  kernel.register(createRuntimeSchedulingProvider({ effects }));
  return kernel;
}

async function call(
  kernel: RuntimeKernel,
  target: string,
  input: Record<string, unknown>,
  context: InvocationContext = AGENT,
) {
  const response = await kernel.runtimeExec(
    {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      target,
      input: READ_TARGETS.has(target) ? input : { idempotencyKey: `key-${(keyCounter += 1)}`, ...input },
    },
    context,
  );
  const envelope = (response as { result?: { output?: Record<string, unknown> } }).result?.output;
  return envelope as { status: string; output?: any; error?: { code: string; message: string } };
}

const create = async (
  kernel: RuntimeKernel,
  timing: Record<string, unknown>,
  task: Record<string, unknown> = WAKE_TASK,
  context: InvocationContext = AGENT,
) => call(kernel, RUNTIME_SCHEDULE_CREATE_CAPABILITY, { timing, task }, context);

describe('RuntimeScheduleService', () => {
  describe('sanity', () => {
    it('fires a one-off schedule an agent created, once, and then completes it', async () => {
      const time = clock();
      const fires: RuntimeScheduleFire[] = [];
      const service = createService({ now: time.now, runners: { [WAKE_KIND]: (fire) => void fires.push(fire) } });
      const kernel = createKernel(service);

      const created = await create(kernel, { kind: 'once', at: iso(START.getTime() + 5 * MINUTE_MS) });
      expect(created).toMatchObject({ status: 'success', output: { state: 'active' } });
      const scheduleId = created.output.scheduleId as string;
      expect(created.output.nextRunAt).toBe(iso(START.getTime() + 5 * MINUTE_MS));

      time.advance(4 * MINUTE_MS);
      expect(await service.tick()).toEqual({ fired: 0, failed: 0 });
      time.advance(MINUTE_MS);
      expect(await service.tick()).toEqual({ fired: 1, failed: 0 });
      expect(await service.tick()).toEqual({ fired: 0, failed: 0 });

      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({
        scheduleId,
        attempt: 1,
        principalId: 'agent-a',
        scope: { workspaceId: 'workspace-a' },
        task: WAKE_TASK,
      });
      const after = await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId });
      expect(after.output).toMatchObject({ state: 'completed', metadata: { fireCount: 1 } });
      expect(after.output.nextRunAt).toBeUndefined();
    });

    it('hands an agent.wake fire to the host wake port', async () => {
      const time = clock();
      const wake = vi.fn();
      const service = createService({
        now: time.now,
        runners: { [WAKE_KIND]: createAgentWakeRunner({ wake }) },
      });
      const kernel = createKernel(service);
      await create(kernel, { kind: 'once', at: iso(START.getTime() + MINUTE_MS) });
      time.advance(MINUTE_MS);
      await service.tick();
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake.mock.calls[0]![0]).toMatchObject({
        target: { sessionId: 'session-1' },
        message: 'check the deploy',
        fire: { principalId: 'agent-a' },
      });
    });

    it('fires a cron schedule on each slot and runs again at the next one', async () => {
      const time = clock();
      const fires: string[] = [];
      const service = createService({ now: time.now, runners: { [WAKE_KIND]: (fire) => void fires.push(fire.scheduledFor) } });
      const kernel = createKernel(service);
      const created = await create(kernel, { kind: 'cron', expression: '*/30 * * * *', timezone: 'UTC' });
      expect(created.output.nextRunAt).toBe('2026-10-26T10:30:00.000Z');

      time.set(Date.parse('2026-10-26T10:30:00Z'));
      await service.tick();
      time.set(Date.parse('2026-10-26T11:00:00Z'));
      await service.tick();
      expect(fires).toEqual(['2026-10-26T10:30:00.000Z', '2026-10-26T11:00:00.000Z']);
      const state = await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: created.output.scheduleId });
      expect(state.output).toMatchObject({ state: 'active', nextRunAt: '2026-10-26T11:30:00.000Z' });
    });

    it('keeps schedules across a restart of the host', async () => {
      const time = clock();
      const first = createService({ now: time.now, runners: { [WAKE_KIND]: () => undefined } });
      const created = await create(createKernel(first), { kind: 'once', at: iso(START.getTime() + MINUTE_MS) });

      const fires: string[] = [];
      const second = createService({ now: time.now, runners: { [WAKE_KIND]: (fire) => void fires.push(fire.scheduleId) } });
      time.advance(MINUTE_MS);
      await second.tick();
      expect(fires).toEqual([created.output.scheduleId]);
    });

    it('fires from the running loop with real timers', async () => {
      const fired = new Promise<RuntimeScheduleFire>((resolve) => {
        const service = createService({
          tickMs: 20,
          runners: { [WAKE_KIND]: (fire) => resolve(fire) },
        });
        void create(createKernel(service), { kind: 'once', at: iso(Date.now() + 150) }).then(() => service.start());
        cleanupStops.push(() => service.stop());
      });
      expect((await fired).task.kind).toBe(WAKE_KIND);
    });
  });

  describe('missed and recurring fires', () => {
    it('fires an overdue one-off schedule when the host starts, and coalesces missed recurring slots', async () => {
      const time = clock();
      const fires: string[] = [];
      const runner: RuntimeScheduleTaskRunner = (fire) => void fires.push(`${fire.scheduleId}@${fire.scheduledFor}`);
      const writer = createService({ now: time.now, acceptedTaskKinds: [WAKE_KIND] });
      const kernel = createKernel(writer);
      const once = await create(kernel, { kind: 'once', at: iso(START.getTime() + 10 * MINUTE_MS) });
      const hourly = await create(kernel, { kind: 'cron', expression: '0 * * * *' });

      time.advance(5 * HOUR_MS + 3 * MINUTE_MS);
      const runnerHost = createService({ now: time.now, runners: { [WAKE_KIND]: runner } });
      expect(await runnerHost.tick()).toEqual({ fired: 2, failed: 0 });

      expect(fires.filter((entry) => entry.startsWith(once.output.scheduleId))).toHaveLength(1);
      expect(fires.filter((entry) => entry.startsWith(hourly.output.scheduleId))).toEqual([
        `${hourly.output.scheduleId}@2026-10-26T11:00:00.000Z`,
      ]);
      const next = await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: hourly.output.scheduleId });
      expect(next.output.nextRunAt).toBe('2026-10-26T16:00:00.000Z');
    });

    it('aligns an interval to its start and stops at its end', async () => {
      const time = clock();
      const fires: string[] = [];
      const service = createService({ now: time.now, runners: { [WAKE_KIND]: (fire) => void fires.push(fire.scheduledFor) } });
      const kernel = createKernel(service);
      const startsAt = iso(START.getTime() + 10 * MINUTE_MS);
      const endsAt = iso(START.getTime() + 25 * MINUTE_MS);
      const created = await create(kernel, { kind: 'interval', everyMs: 10 * MINUTE_MS, startsAt, endsAt });
      expect(created.output.nextRunAt).toBe(startsAt);

      time.set(START.getTime() + 10 * MINUTE_MS);
      await service.tick();
      time.set(START.getTime() + 20 * MINUTE_MS);
      await service.tick();
      time.set(START.getTime() + 40 * MINUTE_MS);
      await service.tick();
      expect(fires).toEqual([startsAt, iso(START.getTime() + 20 * MINUTE_MS)]);
      const done = await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: created.output.scheduleId });
      expect(done.output.state).toBe('completed');
    });
  });

  describe('error handling', () => {
    it('retries a failed fire with backoff, then succeeds', async () => {
      const time = clock();
      const attempts: number[] = [];
      const service = createService({
        now: time.now,
        runners: {
          [WAKE_KIND]: (fire) => {
            attempts.push(fire.attempt);
            if (fire.attempt < 3) throw new Error('target busy');
          },
        },
      });
      const kernel = createKernel(service);
      const created = await create(kernel, { kind: 'once', at: iso(START.getTime() + MINUTE_MS) });
      time.advance(MINUTE_MS);
      expect(await service.tick()).toEqual({ fired: 0, failed: 1 });
      expect(await service.tick()).toEqual({ fired: 0, failed: 0 });
      time.advance(1_000);
      expect(await service.tick()).toEqual({ fired: 0, failed: 1 });
      time.advance(2_000);
      expect(await service.tick()).toEqual({ fired: 1, failed: 0 });
      expect(attempts).toEqual([1, 2, 3]);
      const done = await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: created.output.scheduleId });
      expect(done.output.state).toBe('completed');
    });

    it('marks a one-off schedule failed after its attempts, but keeps a recurring one alive', async () => {
      const time = clock();
      const events: string[] = [];
      const service = createService({
        now: time.now,
        maxAttempts: 2,
        runners: { [WAKE_KIND]: () => { throw new Error('boom'); } },
        onEvent: (event) => events.push(event.type),
      });
      const kernel = createKernel(service);
      const once = await create(kernel, { kind: 'once', at: iso(START.getTime() + MINUTE_MS) });
      const recurring = await create(kernel, { kind: 'cron', expression: '*/10 * * * *' });
      time.set(START.getTime() + 10 * MINUTE_MS);
      await service.tick();
      time.advance(1_000);
      await service.tick();
      const failedOnce = await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: once.output.scheduleId });
      const stillActive = await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: recurring.output.scheduleId });
      expect(failedOnce.output).toMatchObject({ state: 'failed', metadata: { lastError: 'boom' } });
      expect(stillActive.output).toMatchObject({ state: 'active', nextRunAt: '2026-10-26T10:20:00.000Z' });
      expect(events.filter((type) => type === 'failed')).toHaveLength(2);
    });

    it('fails a fire whose task kind has no runner on this host', async () => {
      const time = clock();
      const writer = createService({ now: time.now, acceptedTaskKinds: [REFRESH_KIND] });
      const created = await create(createKernel(writer), { kind: 'once', at: iso(START.getTime() + MINUTE_MS) }, { kind: REFRESH_KIND });
      const other = createService({ now: time.now, maxAttempts: 1, runners: { [WAKE_KIND]: () => undefined } });
      time.advance(MINUTE_MS);
      await other.tick();
      const state = await call(createKernel(writer), RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: created.output.scheduleId });
      expect(state.output).toMatchObject({ state: 'failed' });
      expect(state.output.metadata.lastError).toContain('No runner');
    });

    it('stops a runner that exceeds the timeout', async () => {
      const time = clock();
      const service = createService({
        now: time.now,
        runnerTimeoutMs: 20,
        claimLeaseMs: 1_000,
        maxAttempts: 1,
        runners: { [WAKE_KIND]: () => new Promise(() => undefined) },
      });
      const kernel = createKernel(service);
      const created = await create(kernel, { kind: 'once', at: iso(START.getTime() + MINUTE_MS) });
      time.advance(MINUTE_MS);
      expect(await service.tick()).toEqual({ fired: 0, failed: 1 });
      const state = await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: created.output.scheduleId });
      expect(state.output.metadata.lastError).toContain('exceeded');
    });

    it.each([
      ['an unknown task kind', { kind: 'once', at: iso(START.getTime() + MINUTE_MS) }, { kind: 'nope' }, 'not available'],
      ['a wake without a target', { kind: 'once', at: iso(START.getTime() + MINUTE_MS) }, { kind: WAKE_KIND, input: { message: 'hi' } }, 'target'],
      ['a time in the past', { kind: 'once', at: iso(START.getTime() - HOUR_MS) }, WAKE_TASK, 'past'],
      ['a time over a year away', { kind: 'once', at: iso(START.getTime() + 400 * 24 * HOUR_MS) }, WAKE_TASK, 'far'],
      ['an interval below the minimum', { kind: 'interval', everyMs: 5_000 }, WAKE_TASK, 'at least'],
      ['an unknown time zone', { kind: 'cron', expression: '* * * * *', timezone: 'Mars/Base' }, WAKE_TASK, 'IANA'],
      ['a bad cron expression', { kind: 'cron', expression: '99 * * * *' }, WAKE_TASK, 'outside'],
      ['an end already past', { kind: 'interval', everyMs: MINUTE_MS, endsAt: iso(START.getTime() - MINUTE_MS) }, WAKE_TASK, 'endsAt'],
    ])('refuses %s', async (_label, timing, task, message) => {
      const service = createService({ now: clock().now, runners: { [WAKE_KIND]: () => undefined } });
      const response = await create(createKernel(service), timing, task);
      expect(response.status).toBe('failed');
      expect(response.error?.message).toContain(message);
    });

    it('limits the live schedules of one principal and scope', async () => {
      const service = createService({ now: clock().now, maxLivePerOwner: 2, runners: { [WAKE_KIND]: () => undefined } });
      const kernel = createKernel(service);
      const timing = { kind: 'once', at: iso(START.getTime() + HOUR_MS) };
      await create(kernel, timing);
      await create(kernel, timing);
      expect((await create(kernel, timing)).error?.code).toBe('SCHEDULE_LIMIT_REACHED');
      expect((await create(kernel, timing, WAKE_TASK, OTHER_AGENT)).status).toBe('success');
    });
  });

  describe('ownership and lifecycle', () => {
    it('hides a schedule from another principal and refuses its changes', async () => {
      const service = createService({ now: clock().now, runners: { [WAKE_KIND]: () => undefined } });
      const kernel = createKernel(service);
      const created = await create(kernel, { kind: 'once', at: iso(START.getTime() + HOUR_MS) });
      const scheduleId = created.output.scheduleId;
      expect((await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId }, OTHER_AGENT)).error?.code).toBe('SCHEDULE_NOT_FOUND');
      expect((await call(kernel, RUNTIME_SCHEDULE_CANCEL_CAPABILITY, { scheduleId }, OTHER_AGENT)).error?.code).toBe('SCHEDULE_NOT_FOUND');
      expect((await call(kernel, RUNTIME_SCHEDULE_LIST_CAPABILITY, {}, OTHER_AGENT)).output.schedules).toEqual([]);
      expect((await call(kernel, RUNTIME_SCHEDULE_LIST_CAPABILITY, {})).output.schedules).toHaveLength(1);
    });

    it('pauses, resumes, updates and cancels', async () => {
      const time = clock();
      const fires: string[] = [];
      const service = createService({ now: time.now, runners: { [WAKE_KIND]: (fire) => void fires.push(fire.scheduledFor) } });
      const kernel = createKernel(service);
      const created = await create(kernel, { kind: 'cron', expression: '0 * * * *' });
      const scheduleId = created.output.scheduleId;

      expect((await call(kernel, RUNTIME_SCHEDULE_PAUSE_CAPABILITY, { scheduleId })).output.state).toBe('paused');
      time.set(Date.parse('2026-10-26T12:30:00Z'));
      expect(await service.tick()).toEqual({ fired: 0, failed: 0 });

      const resumed = await call(kernel, RUNTIME_SCHEDULE_RESUME_CAPABILITY, { scheduleId });
      expect(resumed.output).toMatchObject({ state: 'active', nextRunAt: '2026-10-26T13:00:00.000Z' });

      const updated = await call(kernel, RUNTIME_SCHEDULE_UPDATE_CAPABILITY, {
        scheduleId,
        timing: { kind: 'cron', expression: '15 * * * *' },
      });
      expect(updated.output.nextRunAt).toBe('2026-10-26T13:15:00.000Z');

      const cancelled = await call(kernel, RUNTIME_SCHEDULE_CANCEL_CAPABILITY, { scheduleId });
      expect(cancelled.output).toMatchObject({ state: 'cancelled' });
      time.set(Date.parse('2026-10-26T13:30:00Z'));
      expect(await service.tick()).toEqual({ fired: 0, failed: 0 });
      expect(fires).toEqual([]);
      const again = await call(kernel, RUNTIME_SCHEDULE_UPDATE_CAPABILITY, { scheduleId, metadata: { a: 1 } });
      expect(again.error?.message).toContain('cancelled');
    });

    it('drops old terminal records and pages the list', async () => {
      const time = clock();
      const service = createService({ now: time.now, retentionMs: HOUR_MS, runners: { [WAKE_KIND]: () => undefined } });
      const kernel = createKernel(service);
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        ids.push((await create(kernel, { kind: 'once', at: iso(START.getTime() + (index + 1) * HOUR_MS * 24) })).output.scheduleId);
      }
      const page = await call(kernel, RUNTIME_SCHEDULE_LIST_CAPABILITY, { limit: 2 });
      expect(page.output.schedules).toHaveLength(2);
      const rest = await call(kernel, RUNTIME_SCHEDULE_LIST_CAPABILITY, { limit: 2, cursor: page.output.nextCursor });
      expect(rest.output.schedules).toHaveLength(1);
      expect(rest.output.nextCursor).toBeUndefined();

      await call(kernel, RUNTIME_SCHEDULE_CANCEL_CAPABILITY, { scheduleId: ids[0] });
      time.advance(2 * HOUR_MS);
      await service.tick();
      expect((await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: ids[0] })).error?.code).toBe('SCHEDULE_NOT_FOUND');
      expect((await call(kernel, RUNTIME_SCHEDULE_GET_CAPABILITY, { scheduleId: ids[1] })).status).toBe('success');
    });
  });

  describe('edge cases', () => {
    it('fires each of several schedules exactly once when two hosts tick one store together', async () => {
      const time = clock();
      const fired = new Map<string, string[]>();
      const record = (owner: string): RuntimeScheduleTaskRunner => async (fire) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        fired.set(fire.scheduleId, [...(fired.get(fire.scheduleId) ?? []), owner]);
      };
      const storeRoot = path.join(root, 'shared');
      const hostA = createService({ storeRoot, now: time.now, ownerId: 'host-a', runners: { [WAKE_KIND]: record('a') } });
      const hostB = createService({ storeRoot, now: time.now, ownerId: 'host-b', runners: { [WAKE_KIND]: record('b') } });
      const kernel = createKernel(hostA);
      const ids = await Promise.all(
        [1, 2, 3].map(async (minutes) =>
          (await create(kernel, { kind: 'once', at: iso(START.getTime() + minutes * MINUTE_MS) })).output.scheduleId as string,
        ),
      );
      time.advance(5 * MINUTE_MS);
      await Promise.all([hostA.tick(), hostB.tick(), hostA.tick(), hostB.tick()]);
      expect(ids.map((id) => fired.get(id)?.length)).toEqual([1, 1, 1]);
    });

    it('re-fires a schedule whose claim expired because the host died mid-fire', async () => {
      const time = clock();
      const storeRoot = path.join(root, 'crash');
      let release!: () => void;
      const stuck = createService({
        storeRoot,
        now: time.now,
        runnerTimeoutMs: 10_000,
        claimLeaseMs: 60_000,
        runners: { [WAKE_KIND]: () => new Promise<void>((resolve) => { release = resolve; }) },
      });
      const created = await create(createKernel(stuck), { kind: 'once', at: iso(START.getTime() + MINUTE_MS) });
      time.advance(MINUTE_MS);
      const pending = stuck.tick();
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));

      const fires: string[] = [];
      const survivor = createService({ storeRoot, now: time.now, runners: { [WAKE_KIND]: (fire) => void fires.push(fire.scheduleId) } });
      expect(await survivor.tick()).toEqual({ fired: 0, failed: 0 });
      time.advance(2 * MINUTE_MS);
      expect(await survivor.tick()).toEqual({ fired: 1, failed: 0 });
      expect(fires).toEqual([created.output.scheduleId]);
      release();
      await pending;
    });

    it('refuses to start a service whose claim lease is not longer than the runner timeout', () => {
      expect(() => createService({ runnerTimeoutMs: 5_000, claimLeaseMs: 5_000 })).toThrow('claimLeaseMs');
    });
  });
});

const cleanupStops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanupStops.splice(0).map((stop) => stop()));
});

describe('composeEffectHandlers', () => {
  const ctx = AGENT;
  const handler = (id: string, kinds: readonly string[] | undefined, output: string) => ({
    id,
    supportedKinds: kinds,
    handle: async () => ({ status: 'success' as const, output }),
  });
  const request = (kind: string) => ({ protocolVersion: RUNTIME_PROTOCOL_VERSION, kind, idempotencyKey: 'k' });

  it('routes each kind to the handler that supports it and reports others unsupported', async () => {
    const composed = composeEffectHandlers([
      handler('schedules', ['runtime.schedule.create'], 'schedule'),
      handler('harness', ['ui.open'], 'harness'),
    ])!;
    expect(composed.supportedKinds).toEqual(['runtime.schedule.create', 'ui.open']);
    expect(await composed.handle(request('runtime.schedule.create'), ctx)).toMatchObject({ output: 'schedule' });
    expect(await composed.handle(request('ui.open'), ctx)).toMatchObject({ output: 'harness' });
    expect(await composed.handle(request('nope'), ctx)).toMatchObject({ status: 'unsupported' });
  });

  it('returns the only handler unchanged and nothing for an empty list', () => {
    const only = handler('only', undefined, 'x');
    expect(composeEffectHandlers([only])).toBe(only);
    expect(composeEffectHandlers([])).toBeUndefined();
  });

  it('leaves the kind list open when any handler accepts every kind', () => {
    expect(composeEffectHandlers([handler('a', undefined, 'a'), handler('b', ['x'], 'b')])!.supportedKinds).toBeUndefined();
  });
});
