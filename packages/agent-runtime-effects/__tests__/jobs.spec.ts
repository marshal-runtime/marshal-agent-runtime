import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
  type RuntimeBackgroundJobHandler,
  type RuntimeBackgroundJobRecord,
} from '@marshal/agent-runtime-core';
import {
  BackgroundJobManager,
  BoundedFileJobStore,
  JobStoreRevisionConflictError,
} from '../src/index.js';

const PARTIAL_OWNER_DURATION_MS = 350;
const LIVE_OWNER_DURATION_MS = 40;
const LOCK_OWNER_WRITER_SCRIPT = `
import { rmSync, writeFileSync } from 'node:fs';
const [ownerPath, lockPath, pid] = process.argv.slice(1);
await new Promise((resolve) => setTimeout(resolve, ${PARTIAL_OWNER_DURATION_MS}));
writeFileSync(ownerPath, JSON.stringify({ token: 'live-owner', pid: Number(pid), createdAt: new Date().toISOString() }));
await new Promise((resolve) => setTimeout(resolve, ${LIVE_OWNER_DURATION_MS}));
rmSync(lockPath, { recursive: true, force: true });
`;
const cleanup: string[] = [];
const context: InvocationContext = {
  principal: { id: 'job-agent', kind: 'agent' },
  scope: { workspaceId: 'workspace-jobs', projectId: 'project-jobs', sessionId: 'session-a' },
};

afterEach(async () => {
  for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true });
});

async function store(options: { maxJobs?: number; maxRecordBytes?: number } = {}) {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-jobs-'));
  cleanup.push(rootDirectory);
  return new BoundedFileJobStore({ rootDirectory, ...options });
}

function request(idempotencyKey: string, input: unknown = { value: 21 }) {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: 'test.calculate',
    input,
    idempotencyKey,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class WindowsReplacementFallbackStore extends BoundedFileJobStore {
  private armed = false;
  replacementAttempts = 0;

  arm(): void {
    this.armed = true;
  }

  protected override renameFile(source: string, target: string): void {
    if (this.armed && (this.replacementAttempts += 1) === 1) {
      throw Object.assign(new Error('forced Windows replacement fallback'), { code: 'EPERM' });
    }
    super.renameFile(source, target);
  }
}

class PausedHeartbeatReadStore extends BoundedFileJobStore {
  private armed = false;
  private paused = false;
  private expectHeartbeatUpdate = false;
  readonly heartbeatRead = deferred();
  readonly continueHeartbeat = deferred();
  readonly heartbeatFinished = deferred();

  arm(): void {
    this.armed = true;
  }

  override async get(jobId: string): Promise<RuntimeBackgroundJobRecord | undefined> {
    const record = await super.get(jobId);
    if (!this.armed || this.paused) return record;
    this.paused = true;
    this.heartbeatRead.resolve();
    await this.continueHeartbeat.promise;
    this.expectHeartbeatUpdate = true;
    return record;
  }

  override async update(record: RuntimeBackgroundJobRecord, expectedRevision: number): Promise<void> {
    const heartbeat = this.expectHeartbeatUpdate;
    this.expectHeartbeatUpdate = false;
    try {
      await super.update(record, expectedRevision);
    } finally {
      if (heartbeat) this.heartbeatFinished.resolve();
    }
  }
}

function durableRecord(jobId: string): RuntimeBackgroundJobRecord {
  const createdAt = '2026-08-01T00:00:00.000Z';
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    handle: {
      jobId,
      kind: 'test.calculate',
      idempotencyKey: `idempotency-${jobId}`,
      createdAt,
    },
    principalId: context.principal.id,
    agentId: context.principal.id,
    scope: context.scope,
    state: 'queued',
    attempt: 0,
    requestDigest: `digest-${jobId}`,
    createdAt,
    updatedAt: createdAt,
    revision: 0,
  };
}

describe('BackgroundJobManager conformance', () => {
  it('lets a handler-free producer enqueue durable work for a later scoped worker', async () => {
    const durableStore = await store();
    const producer = new BackgroundJobManager({ store: durableStore });
    const accepted = await producer.enqueue(request('hook-evidence'), context);
    expect(accepted).toMatchObject({
      status: 'accepted',
      job: { state: 'queued', attempt: 0 },
      receipt: { operation: 'start' },
    });

    const start = vi.fn(async (job) => ({
      status: 'succeeded' as const,
      result: { observed: job.input },
    }));
    const worker = new BackgroundJobManager({
      store: durableStore,
      handlers: [{ kind: 'test.calculate', start }],
    });
    const claimed = await worker.recover(context, ['test.calculate']);
    expect(claimed).toEqual([accepted.handle!.jobId]);
    await worker.wait(accepted.handle!.jobId);
    await expect(worker.status(accepted.handle!.jobId, context)).resolves.toMatchObject({
      job: { state: 'succeeded', attempt: 1, result: { observed: { value: 21 } } },
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it('does not claim queued work from another principal or scope', async () => {
    const durableStore = await store();
    const producer = new BackgroundJobManager({ store: durableStore });
    const accepted = await producer.enqueue(request('isolated-hook-evidence'), context);
    const start = vi.fn(async () => ({ status: 'succeeded' as const, result: true }));
    const worker = new BackgroundJobManager({
      store: durableStore,
      handlers: [{ kind: 'test.calculate', start }],
    });
    const claimed = await worker.recover({
      ...context,
      principal: { id: 'other-agent', kind: 'agent' },
    });
    expect(claimed).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    await expect(worker.status(accepted.handle!.jobId, context)).resolves.toMatchObject({
      job: { state: 'queued', attempt: 0 },
    });
  });

  it('includes canonical agent identity in authorization and idempotency ownership', async () => {
    const durableStore = await store();
    const manager = new BackgroundJobManager({ store: durableStore });
    const firstContext: InvocationContext = {
      ...context,
      identity: { harnessId: 'test', agentId: 'child-a' },
    };
    const secondContext: InvocationContext = {
      ...context,
      identity: { harnessId: 'test', agentId: 'child-b' },
    };
    const first = await manager.enqueue(request('agent-isolated-key'), firstContext);
    await expect(manager.status(first.handle!.jobId, secondContext)).resolves.toMatchObject({
      status: 'not_found',
    });
    const second = await manager.enqueue(request('agent-isolated-key'), secondContext);
    expect(second.status).toBe('accepted');
    expect(second.handle?.jobId).not.toBe(first.handle?.jobId);
    await expect(manager.status(first.handle!.jobId, firstContext)).resolves.toMatchObject({
      status: 'success',
      job: { agentId: 'child-a' },
    });
    const start = vi.fn(async () => ({ status: 'succeeded' as const, result: true }));
    manager.register({ kind: 'test.calculate', start });
    await expect(manager.recover(firstContext)).resolves.toEqual([first.handle!.jobId]);
    await manager.wait(first.handle!.jobId);
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ identity: { harnessId: 'test', agentId: 'child-a' } }),
      expect.anything(),
    );
  });

  it('atomically reserves one idempotency key across manager instances', async () => {
    const durableStore = await store();
    const first = new BackgroundJobManager({ store: durableStore });
    const second = new BackgroundJobManager({ store: durableStore });
    const [left, right] = await Promise.all([
      first.enqueue(request('cross-manager-key'), context),
      second.enqueue(request('cross-manager-key'), context),
    ]);
    expect(left.handle?.jobId).toBe(right.handle?.jobId);
    expect([left.receipt.replayed, right.receipt.replayed].filter(Boolean)).toHaveLength(1);
    expect((await durableStore.list()).filter((job) => job.handle.idempotencyKey === 'cross-manager-key')).toHaveLength(1);

    const conflict = await second.enqueue(request('cross-manager-key', { value: 99 }), context);
    expect(conflict).toMatchObject({ status: 'conflict', error: { code: 'idempotency_key_reused' } });
  });

  it('atomically reserves idempotency and transfers an expired lease across real processes', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-jobs-process-'));
    cleanup.push(rootDirectory);
    const startLog = path.join(rootDirectory, 'semantic-starts.log');
    const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
    const coreUrl = new URL('../../agent-runtime-core/dist/index.js', import.meta.url).href;
    const common = [moduleUrl, coreUrl, rootDirectory, startLog];

    const [first, second] = await Promise.all([
      runJobWorker([...common, 'start', 'shared-process-key', '21', 'worker-a']),
      runJobWorker([...common, 'start', 'shared-process-key', '21', 'worker-b']),
    ]);
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    expect(first.jobId).toBe(second.jobId);
    expect((await fs.readFile(startLog, 'utf8')).trim().split(/\r?\n/)).toHaveLength(1);

    const conflict = await runJobWorker([...common, 'start', 'shared-process-key', '99', 'worker-c']);
    expect(conflict).toMatchObject({ status: 'conflict', errorCode: 'idempotency_key_reused' });

    const hanging = spawnJobWorker([...common, 'hang', 'lease-process-key', '7', 'lease-owner']);
    const hangingExit = new Promise<void>((resolve) => hanging.once('exit', () => resolve()));
    try {
      await waitForFileLine(startLog, 'lease-owner:hang');
      const whileLive = await runJobWorker([...common, 'recover', 'lease-process-key', '7', 'lease-contender']);
      expect(whileLive).toMatchObject({ claimed: [] });
    } finally {
      if (hanging.exitCode === null && hanging.signalCode === null) hanging.kill('SIGKILL');
      await hangingExit;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    const recovered = await runJobWorker([...common, 'recover', 'lease-process-key', '7', 'lease-successor']);
    expect(recovered.claimed).toHaveLength(1);
    expect((await fs.readFile(startLog, 'utf8'))).toContain('lease-successor:resume');
  });

  it('keeps a live lease heartbeating so another worker cannot duplicate an active job', async () => {
    const durableStore = await store();
    const gate = deferred();
    const start = vi.fn(async () => {
      await gate.promise;
      return { status: 'succeeded' as const, result: 'once' };
    });
    const first = new BackgroundJobManager({
      store: durableStore,
      handlers: [{ kind: 'test.calculate', start, resume: start }],
      workerId: 'worker-a',
      leaseMs: 1_000,
      heartbeatMs: 50,
    });
    const second = new BackgroundJobManager({
      store: durableStore,
      handlers: [{ kind: 'test.calculate', start, resume: start }],
      workerId: 'worker-b',
      leaseMs: 1_000,
      heartbeatMs: 50,
    });
    try {
      const accepted = await first.start(request('leased-job'), context);
      const initial = await durableStore.get(accepted.handle!.jobId);
      const initialExpiry = initial?.lease?.expiresAt;
      expect(initialExpiry).toBeDefined();
      const renewalDeadline = Date.now() + 2_000;
      while (Date.now() < renewalDeadline) {
        const renewed = await durableStore.get(accepted.handle!.jobId);
        if (
          renewed?.lease?.token === initial?.lease?.token &&
          Date.parse(renewed.lease.expiresAt) > Date.parse(initialExpiry!)
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const renewed = await durableStore.get(accepted.handle!.jobId);
      expect(Date.parse(renewed!.lease!.expiresAt)).toBeGreaterThan(Date.parse(initialExpiry!));
      await expect(second.recoverAll((record) => ({ ...context, scope: record.scope }))).resolves.toEqual([]);
      expect(start).toHaveBeenCalledOnce();
      gate.resolve();
      await first.wait(accepted.handle!.jobId);
      await expect(first.status(accepted.handle!.jobId, context)).resolves.toMatchObject({
        job: { state: 'succeeded', result: 'once' },
      });
    } finally {
      gate.resolve();
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
  });

  it('drains an in-flight lease renewal before shutdown resolves', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-jobs-heartbeat-'));
    cleanup.push(rootDirectory);
    const durableStore = new PausedHeartbeatReadStore({ rootDirectory });
    const handlerGate = deferred();
    const manager = new BackgroundJobManager({
      store: durableStore,
      handlers: [{
        kind: 'test.calculate',
        start: async () => {
          await handlerGate.promise;
          return { status: 'succeeded' as const, result: 'done' };
        },
      }],
      workerId: 'shutdown-worker',
      leaseMs: 1_000,
      heartbeatMs: 10,
    });
    const started = await manager.start(request('shutdown-heartbeat'), context);
    durableStore.arm();
    await durableStore.heartbeatRead.promise;

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    let shutdownSettled = false;
    const shutdown = manager.shutdown();
    const concurrentShutdown = manager.shutdown();
    expect(concurrentShutdown).toBe(shutdown);
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(shutdownSettled).toBe(false);
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      durableStore.continueHeartbeat.resolve();
      handlerGate.resolve();
      await durableStore.heartbeatFinished.promise;
      await shutdown;
      clearIntervalSpy.mockRestore();
    }
    await manager.wait(started.handle!.jobId);
  });

  it('hides the Windows replacement fallback and serializes revisions across store instances', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-jobs-shared-'));
    cleanup.push(rootDirectory);
    const writer = new WindowsReplacementFallbackStore({ rootDirectory });
    const reader = new BoundedFileJobStore({ rootDirectory });
    const competingWriter = new BoundedFileJobStore({ rootDirectory });
    const original = durableRecord('shared-job');
    await writer.create(original);

    writer.arm();
    await writer.update({ ...original, state: 'running' as const, revision: 1 }, 0);

    expect(writer.replacementAttempts).toBe(2);
    await expect(reader.get(original.handle.jobId)).resolves.toMatchObject({
      state: 'running',
      revision: 1,
    });
    await expect(competingWriter.update(
      { ...original, state: 'cancel_requested', revision: 1 },
      0,
    )).rejects.toBeInstanceOf(JobStoreRevisionConflictError);
  });

  it('rereads a temporarily partial lock owner but rejects persistent corruption', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-jobs-lock-race-'));
    cleanup.push(rootDirectory);
    const lockPath = path.join(rootDirectory, '.job-store.lock');
    const ownerPath = path.join(lockPath, 'owner.json');
    await fs.mkdir(lockPath);
    await fs.writeFile(ownerPath, '{', 'utf8');

    const writer = spawn(process.execPath, [
      '--input-type=module', '-e', LOCK_OWNER_WRITER_SCRIPT, ownerPath, lockPath, String(process.pid),
    ], { stdio: 'ignore' });
    const writerExit = new Promise<void>((resolve) => writer.once('exit', () => resolve()));
    const listing = new BoundedFileJobStore({ rootDirectory }).list();
    await writerExit;
    await expect(listing).resolves.toEqual([]);

    await fs.mkdir(lockPath);
    await fs.writeFile(ownerPath, '{', 'utf8');
    const stale = new Date(Date.now() - 2_000);
    await fs.utimes(lockPath, stale, stale);
    await expect(new BoundedFileJobStore({ rootDirectory }).list()).rejects.toThrow(
      'Job store lock owner is invalid.',
    );
  });

  it('returns a durable handle and idempotently reuses it across manager instances', async () => {
    const durableStore = await store();
    const start = vi.fn(async (job) => ({
      status: 'succeeded' as const,
      result: { answer: (job.input as { value: number }).value * 2 },
    }));
    const handler: RuntimeBackgroundJobHandler = { kind: 'test.calculate', start };
    const firstManager = new BackgroundJobManager({ store: durableStore, handlers: [handler] });
    const started = await firstManager.start(request('durable-job'), context);
    await firstManager.wait(started.handle!.jobId);
    const duplicate = await firstManager.start(request('durable-job'), context);

    const secondManager = new BackgroundJobManager({ store: durableStore, handlers: [handler] });
    const persisted = await secondManager.status(started.handle!.jobId, context);
    expect(start).toHaveBeenCalledOnce();
    expect(duplicate).toMatchObject({
      status: 'accepted',
      handle: { jobId: started.handle!.jobId },
      receipt: { replayed: true },
    });
    expect(persisted).toMatchObject({
      status: 'success',
      job: { state: 'succeeded', result: { answer: 42 }, attempt: 1 },
    });
  });

  it('resumes only through an explicit registered callback and durable data checkpoint', async () => {
    const durableStore = await store();
    const firstHandler: RuntimeBackgroundJobHandler = {
      kind: 'test.calculate',
      start: async () => ({ status: 'paused', checkpoint: { cursor: 7 } }),
      resume: async () => ({ status: 'succeeded', result: { ignored: true } }),
    };
    const firstManager = new BackgroundJobManager({
      store: durableStore,
      handlers: [firstHandler],
    });
    const started = await firstManager.start(request('resume-job'), context);
    await firstManager.wait(started.handle!.jobId);

    const resume = vi.fn(async (job) => ({
      status: 'succeeded' as const,
      result: { resumedFrom: (job.checkpoint as { cursor: number }).cursor },
    }));
    const secondManager = new BackgroundJobManager({
      store: durableStore,
      handlers: [{ kind: 'test.calculate', start: firstHandler.start, resume }],
    });
    const accepted = await secondManager.resume(started.handle!.jobId, context);
    await secondManager.wait(started.handle!.jobId);
    const completed = await secondManager.status(started.handle!.jobId, context);

    expect(accepted.status).toBe('accepted');
    expect(resume).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({
      job: { state: 'succeeded', result: { resumedFrom: 7 }, attempt: 2 },
    });
  });

  it('cancels an active callback through a signal and persists cancellation', async () => {
    const durableStore = await store();
    const handler: RuntimeBackgroundJobHandler = {
      kind: 'test.calculate',
      start: async (_request, _context, control) => {
        while (!control.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('cancelled');
      },
    };
    const manager = new BackgroundJobManager({ store: durableStore, handlers: [handler] });
    const started = await manager.start(request('cancel-job'), context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancellation = await manager.cancel(started.handle!.jobId, context);
    await manager.wait(started.handle!.jobId);
    const status = await manager.status(started.handle!.jobId, context);

    expect(cancellation.status).toBe('accepted');
    expect(status).toMatchObject({ job: { state: 'cancelled' } });
  });

  it('isolates handles by principal and full runtime scope', async () => {
    const durableStore = await store();
    const handler: RuntimeBackgroundJobHandler = {
      kind: 'test.calculate',
      start: async () => ({ status: 'succeeded', result: 1 }),
    };
    const manager = new BackgroundJobManager({ store: durableStore, handlers: [handler] });
    const started = await manager.start(request('scoped-job'), context);
    await manager.wait(started.handle!.jobId);
    const otherScope = await manager.status(started.handle!.jobId, {
      ...context,
      scope: { ...context.scope, sessionId: 'session-b' },
    });
    expect(otherScope).toMatchObject({ status: 'not_found', error: { code: 'job_not_found' } });
  });

  it('bounds durable storage and evicts only terminal records', async () => {
    const durableStore = await store({ maxJobs: 2 });
    const handler: RuntimeBackgroundJobHandler = {
      kind: 'test.calculate',
      start: async (job) => ({ status: 'succeeded', result: job.input }),
    };
    const manager = new BackgroundJobManager({ store: durableStore, handlers: [handler] });
    for (let index = 0; index < 3; index += 1) {
      const started = await manager.start(request(`bounded-job-${index}`, { index }), context);
      await manager.wait(started.handle!.jobId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const records = await durableStore.list();
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.state === 'succeeded')).toBe(true);
  });
});

const JOB_WORKER_SOURCE = String.raw`
import fs from 'node:fs/promises';
const [effectsUrl, coreUrl, root, log, mode, key, rawValue, workerId] = process.argv.slice(1);
const { BackgroundJobManager, BoundedFileJobStore } = await import(effectsUrl);
const { RUNTIME_PROTOCOL_VERSION } = await import(coreUrl);
const context = {
  principal: { id: 'job-agent', kind: 'agent' },
  scope: { workspaceId: 'workspace-jobs', projectId: 'project-jobs', sessionId: 'session-a' },
};
const record = async (label) => fs.appendFile(log, label + '\n');
const start = async (_request, _context, control) => {
  if (mode === 'hang') {
    await record(workerId + ':hang');
    while (!control.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error('aborted');
  }
  await record(workerId + ':start');
  await new Promise((resolve) => setTimeout(resolve, 120));
  return { status: 'succeeded', result: Number(rawValue) * 2 };
};
const resume = async () => {
  await record(workerId + ':resume');
  return { status: 'succeeded', result: Number(rawValue) * 2 };
};
const manager = new BackgroundJobManager({
  store: new BoundedFileJobStore({ rootDirectory: root }),
  handlers: [{ kind: 'test.calculate', start, resume }],
  workerId,
  leaseMs: 5_000,
  heartbeatMs: 100,
});
const request = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  kind: 'test.calculate',
  input: { value: Number(rawValue) },
  idempotencyKey: key,
};
if (mode === 'start' || mode === 'hang') {
  const response = await manager.start(request, context);
  if (mode === 'start' && response.handle) await manager.wait(response.handle.jobId);
  process.stdout.write(JSON.stringify({
    status: response.status,
    jobId: response.handle?.jobId,
    errorCode: response.error?.code,
  }));
  if (mode === 'hang') await new Promise(() => undefined);
} else {
  const claimed = await manager.recover(context, ['test.calculate']);
  for (const jobId of claimed) await manager.wait(jobId);
  process.stdout.write(JSON.stringify({ claimed }));
}
`;

function spawnJobWorker(args: readonly string[]) {
  return spawn(process.execPath, ['--input-type=module', '-e', JOB_WORKER_SOURCE, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function runJobWorker(args: readonly string[]): Promise<Record<string, unknown>> {
  const child = spawnJobWorker(args);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  if (code !== 0) throw new Error(`Job worker exited ${code}: ${stderr}`);
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function waitForFileLine(filePath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const content = await fs.readFile(filePath, 'utf8').catch(() => '');
    if (content.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected}.`);
}
