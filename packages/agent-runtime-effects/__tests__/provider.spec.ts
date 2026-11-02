import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SCHEDULE_EFFECT_KINDS,
  createRuntimeKernel,
  type InvocationContext,
  type RuntimeBackgroundJobHandler,
} from '@marshal/agent-runtime-core';
import {
  BackgroundJobManager,
  BoundedFileEffectReplayStore,
  BoundedFileJobStore,
  EffectDispatcher,
  RUNTIME_EFFECT_EXECUTE_CAPABILITY,
  RUNTIME_JOB_CANCEL_CAPABILITY,
  RUNTIME_JOB_RESUME_CAPABILITY,
  RUNTIME_JOB_START_CAPABILITY,
  RUNTIME_JOB_STATUS_CAPABILITY,
  createRuntimeEffectsProvider,
} from '../src/index.js';

const cleanup: string[] = [];
const context: InvocationContext = {
  principal: { id: 'kernel-agent', kind: 'agent' },
  scope: { workspaceId: 'workspace-provider', sessionId: 'session-provider' },
};

afterEach(async () => {
  for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true });
});

describe('RuntimeKernel effects/jobs provider conformance', () => {
  it('exposes effect and job operations through normal search and execution', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-effects-provider-'));
    cleanup.push(root);
    const jobHandler: RuntimeBackgroundJobHandler = {
      kind: 'test.background',
      start: async (request) => ({ status: 'succeeded', result: request.input }),
    };
    const jobs = new BackgroundJobManager({
      store: new BoundedFileJobStore({ rootDirectory: path.join(root, 'jobs') }),
      handlers: [jobHandler],
    });
    const effects = new EffectDispatcher({
      replay: new BoundedFileEffectReplayStore({ rootDirectory: path.join(root, 'effects') }),
      handler: {
        id: 'native-test-adapter',
        supportedKinds: ['test.native', RUNTIME_SCHEDULE_EFFECT_KINDS.create],
        handle: async (request) => ({ status: 'success', output: { native: request.input } }),
      },
    });
    const kernel = createRuntimeKernel({
      permissionBroker: { decide: () => ({ decision: 'allow' }) },
    });
    kernel.register(createRuntimeEffectsProvider({ effects, jobs }));

    const discovered = await kernel.runtimeSearch(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        query: 'runtime durable effects jobs',
        limit: 20,
      },
      context,
    );
    expect(discovered.matches.map((match) => match.capability.name)).toEqual(
      expect.arrayContaining([
        RUNTIME_EFFECT_EXECUTE_CAPABILITY,
        RUNTIME_JOB_START_CAPABILITY,
        RUNTIME_JOB_STATUS_CAPABILITY,
        RUNTIME_JOB_CANCEL_CAPABILITY,
        RUNTIME_JOB_RESUME_CAPABILITY,
      ]),
    );

    const effect = await kernel.runtimeExec(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        target: RUNTIME_EFFECT_EXECUTE_CAPABILITY,
        input: { kind: 'test.native', input: { value: 42 }, idempotencyKey: 'native-provider' },
      },
      context,
    );
    expect(effect).toMatchObject({
      status: 'success',
      result: {
        output: {
          status: 'success',
          output: { native: { value: 42 } },
          receipt: { handler: { id: 'native-test-adapter' } },
        },
      },
    });

    const reservedScheduleEffect = await kernel.runtimeExec(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        target: RUNTIME_EFFECT_EXECUTE_CAPABILITY,
        input: {
          kind: RUNTIME_SCHEDULE_EFFECT_KINDS.create,
          input: { task: { kind: 'test' } },
          idempotencyKey: 'schedule-permission-bypass',
        },
      },
      context,
    );
    expect(reservedScheduleEffect).toMatchObject({
      status: 'failed',
      error: { code: 'RESERVED_EFFECT_KIND' },
    });

    const started = await kernel.runtimeExec(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        target: RUNTIME_JOB_START_CAPABILITY,
        input: {
          kind: 'test.background',
          input: { value: 42 },
          idempotencyKey: 'background-provider',
        },
      },
      context,
    );
    const handle = (started.result?.output as { handle: { jobId: string } }).handle;
    await jobs.wait(handle.jobId);
    const status = await kernel.runtimeExec(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        target: RUNTIME_JOB_STATUS_CAPABILITY,
        input: { jobId: handle.jobId },
      },
      context,
    );
    expect(status).toMatchObject({
      status: 'success',
      result: { output: { status: 'success', job: { state: 'succeeded', result: { value: 42 } } } },
    });
  });
});
