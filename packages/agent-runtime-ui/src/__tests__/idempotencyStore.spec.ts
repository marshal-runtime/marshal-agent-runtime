import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiActionIdempotencyLease, UiActionIdempotencyRecord } from '../applicationTypes.js';
import { ReactUiStore, stateScopeKey } from '../store.js';

const temporaryRoots: string[] = [];
const processWorkers = new Set<IdempotencyProcessWorker>();
const context: InvocationContext = {
  principal: { id: 'agent', kind: 'agent' },
  scope: { workspaceId: 'workspace', projectId: 'project', sessionId: 'session' },
};

afterEach(async () => {
  await Promise.allSettled([...processWorkers].map((worker) => worker.stop()));
  processWorkers.clear();
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('durable UI action transactions', () => {
  it('prevents an expired predecessor from renewing, completing, or releasing its successor', async () => {
    const root = await temporaryRoot();
    const store = new ReactUiStore({ storageRoot: root });
    const key = 'a'.repeat(64);
    const digest = 'b'.repeat(64);
    const predecessor = acquired(await store.claim(key, 'project', digest, 10, context));
    const [leasePath] = await filesNamed(root, `${key}.json`);
    if (!leasePath) throw new Error('Expected persisted predecessor lease');
    const persisted = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    persisted.ownerPid = 2_147_483_647;
    await writeFile(leasePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    await delay(20);
    const successor = acquired(await store.claim(key, 'project', digest, 1_000, context));
    expect(successor.ownerId).not.toBe(predecessor.ownerId);

    await expect(store.renew(key, 'project', predecessor, 1_000, context)).resolves.toBeUndefined();
    await expect(store.complete(key, 'project', predecessor, record(digest), context)).rejects.toThrow('lease was lost');
    await expect(store.release(key, 'project', predecessor, context)).resolves.toBeUndefined();

    const renewed = await store.renew(key, 'project', successor, 1_000, context);
    expect(renewed?.ownerId).toBe(successor.ownerId);
    await expect(store.complete(key, 'project', renewed!, record(digest), context)).resolves.toMatchObject({
      requestDigest: digest,
      result: { status: 'success' },
    });
  });

  it('renews portably and removes orphan leases whenever a completed result wins', async () => {
    const root = await temporaryRoot();
    const first = new ReactUiStore({ storageRoot: root });
    const second = new ReactUiStore({ storageRoot: root });
    const key = 'c'.repeat(64);
    const digest = 'd'.repeat(64);
    let lease = acquired(await first.claim(key, 'project', digest, 1_000, context));
    for (let index = 0; index < 10; index += 1) {
      lease = (await first.renew(key, 'project', lease, 1_000, context))!;
    }

    // Simulate a result persisted immediately before a process died while its
    // lease remained. The next claim must replay and clean that orphan.
    await first.put(key, 'project', record(digest), context);
    await expect(second.claim(key, 'project', digest, 1_000, context)).resolves.toMatchObject({
      status: 'replay',
      record: { requestDigest: digest },
    });
    expect(await filesNamed(root, `${key}.json`)).toHaveLength(1);
    expect(await filesContaining(root, '.write-')).toHaveLength(0);
  });

  it('executes exactly once across separate Node processes', async () => {
    const root = await temporaryRoot();
    const coordinationRoot = join(root, 'coordination');
    const counterPath = join(root, 'executions.txt');
    await mkdir(coordinationRoot, { recursive: true });
    await writeFile(counterPath, '', 'utf8');
    const key = 'e'.repeat(64);
    const digest = 'f'.repeat(64);
    const workers = Array.from({ length: 4 }, (_, index) =>
      launchWorker(root, coordinationRoot, counterPath, key, digest, String(index)),
    );

    try {
      await withTimeout(
        Promise.all(workers.map((worker) => worker.ready)),
        30_000,
        'Idempotency workers did not become ready',
      );
      const ready = (await readdir(coordinationRoot)).filter((entry) => entry.startsWith('ready-'));
      expect(ready).toHaveLength(4);
      await writeFile(join(coordinationRoot, 'start'), '', { flag: 'wx' });
      const outcomes = await withTimeout(
        Promise.all(workers.map((worker) => worker.outcome)),
        20_000,
        'Idempotency workers did not settle',
      );

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
        'acquired', 'replay', 'replay', 'replay',
      ]);
      const executions = (await readFile(counterPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
      expect(executions).toHaveLength(1);
    } finally {
      await Promise.allSettled(workers.map((worker) => worker.stop()));
    }
  }, 60_000);

  it('recovers an atomically published transaction owned by a dead process', async () => {
    const root = await temporaryRoot();
    const key = '1'.repeat(64);
    const digest = '2'.repeat(64);
    const lockDirectory = join(root, 'scopes', stateScopeKey(context, 'project'), 'action-locks');
    const lockPath = join(lockDirectory, `${key}.lock`);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({
      ownerId: '00000000-0000-4000-8000-000000000001',
      pid: 2_147_483_647,
      createdAt: new Date(0).toISOString(),
    })}\n`, { flag: 'wx' });

    const store = new ReactUiStore({
      storageRoot: root,
      actionTransactionTimeoutMs: 5_000,
      actionTransactionStaleMs: 100,
    });
    expect(await store.claim(key, 'project', digest, 1_000, context)).toMatchObject({
      status: 'acquired',
    });
    expect(await filesContaining(root, '.stale-')).toHaveLength(0);
  });

  it('rejects a malformed file lock without replacing it', async () => {
    const root = await temporaryRoot();
    const key = '2'.repeat(64);
    const digest = '3'.repeat(64);
    const lockDirectory = join(root, 'scopes', stateScopeKey(context, 'project'), 'action-locks');
    const lockPath = join(lockDirectory, `${key}.lock`);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(lockPath, 'not a valid lock', 'utf8');
    const store = new ReactUiStore({
      storageRoot: root,
      actionTransactionTimeoutMs: 250,
      actionTransactionStaleMs: 75,
    });

    await expect(store.claim(key, 'project', digest, 1_000, context)).rejects.toThrow();
    await expect(readFile(lockPath, 'utf8')).resolves.toBe('not a valid lock');
  });

  it('replays immediately after completion clears its process-local lease', async () => {
    const root = await temporaryRoot();
    const store = new ReactUiStore({ storageRoot: root });
    const key = '7'.repeat(64);
    const requestDigest = '8'.repeat(64);
    const lease = acquired(await store.claim(key, 'project', requestDigest, 10_000, context));
    await store.begin(key, 'project', {
      receiptId: 'completion-clears-lease',
      executionId: 'completion-clears-lease-execution',
      lineage: { rootExecutionId: 'completion-clears-lease-execution', depth: 0 },
      renderId: '9'.repeat(64),
      actionId: 'test',
      actionVersion: '1.0.0',
      target: { kind: 'capability', capability: 'test.execute' },
      scope: 'project',
      principalId: 'agent',
      requestDigest,
      targetIdempotencyKey: 'a'.repeat(64),
      startedAt: new Date().toISOString(),
      ownerId: lease.ownerId,
      leaseExpiresAt: lease.expiresAt,
      ownerPid: process.pid,
      phase: 'pending',
    }, context);

    await store.complete(key, 'project', lease, record(requestDigest), context);

    await expect(store.claim(key, 'project', requestDigest, 1_000, context)).resolves.toMatchObject({
      status: 'replay',
      record: { requestDigest },
    });
  });

  it('heartbeats a live transaction beyond its stale threshold', async () => {
    const root = await temporaryRoot();
    const first = transactionInternals(new ReactUiStore({
      storageRoot: root,
      actionTransactionTimeoutMs: 200,
      actionTransactionStaleMs: 50,
    }));
    const second = transactionInternals(new ReactUiStore({
      storageRoot: root,
      actionTransactionTimeoutMs: 200,
      actionTransactionStaleMs: 50,
    }));
    const canonicalRoot = await first.root();
    const key = '3'.repeat(64);
    const lock = await first.acquireActionTransaction(canonicalRoot, key, 'project', context);
    await delay(120);
    await expect(
      second.acquireActionTransaction(canonicalRoot, key, 'project', context),
    ).rejects.toMatchObject({ code: 'UI_ACTION_TRANSACTION_TIMEOUT' });
    await expect(lock.assertHealthy()).resolves.toBeUndefined();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('runs an active lease renewal before an already queued contender transaction', async () => {
    const root = await temporaryRoot();
    const store = new ReactUiStore({ storageRoot: root });
    const key = '4'.repeat(64);
    const digest = '5'.repeat(64);
    const lease = acquired(await store.claim(key, 'project', digest, 10_000, context));
    const [leasePath] = await filesNamed(root, `${key}.json`);
    if (!leasePath) throw new Error('Expected persisted ownership lease');
    let releaseBlocker!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    let blockerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { blockerEntered = resolve; });
    const internals = store as unknown as {
      withActionTransaction<T>(
        key: string,
        scope: 'project',
        context: InvocationContext,
        operation: (canonicalRoot: string) => Promise<T>,
      ): Promise<T>;
    };
    const blocker = internals.withActionTransaction(key, 'project', context, async () => {
      blockerEntered();
      await blocked;
    });
    await entered;
    let contenderObservedExpiry = '';
    const contender = internals.withActionTransaction(key, 'project', context, async () => {
      const persisted = JSON.parse(await readFile(leasePath, 'utf8')) as { expiresAt: string };
      contenderObservedExpiry = persisted.expiresAt;
    });
    await Promise.resolve();
    const renewal = store.renew(key, 'project', lease, 10_000, context);
    await Promise.resolve();
    releaseBlocker();

    const renewed = await renewal;
    await Promise.all([blocker, contender]);
    expect(renewed).toBeDefined();
    expect(Date.parse(contenderObservedExpiry)).toBeGreaterThan(Date.parse(lease.expiresAt));
  });

  it('does not let a delayed predecessor release displace its successor lock', async () => {
    const root = await temporaryRoot();
    const store = transactionInternals(new ReactUiStore({
      storageRoot: root,
      actionTransactionTimeoutMs: 500,
      actionTransactionStaleMs: 50,
    }));
    const canonicalRoot = await store.root();
    const key = '5'.repeat(64);
    const lockPath = join(
      canonicalRoot,
      'scopes',
      stateScopeKey(context, 'project'),
      'action-locks',
      `${key}.lock`,
    );
    const predecessor = {
      ownerId: '00000000-0000-4000-8000-000000000005',
      pid: process.pid,
      createdAt: '2000-01-01T00:00:00.000Z',
    };
    await mkdir(lockPath, { recursive: true });
    const predecessorPath = join(lockPath, `owner-${predecessor.ownerId}.json`);
    await writeFile(predecessorPath, `${JSON.stringify(predecessor)}\n`, 'utf8');
    await utimes(predecessorPath, new Date(0), new Date(0));

    const successor = await store.acquireActionTransaction(
      canonicalRoot,
      key,
      'project',
      context,
    );
    await expect(
      store.releaseActionTransaction(canonicalRoot, lockPath, predecessor, 500),
    ).rejects.toThrow('lock was lost');
    await expect(successor.assertHealthy()).resolves.toBeUndefined();
    await expect(successor.release()).resolves.toBeUndefined();
    expect(await filesContaining(root, `${key}.lock`)).toHaveLength(0);
  });

  it('atomically publishes a complete candidate without corrupting a successor', async () => {
    const root = await temporaryRoot();
    const store = transactionInternals(new ReactUiStore({
      storageRoot: root,
      actionTransactionTimeoutMs: 500,
      actionTransactionStaleMs: 50,
    }));
    const canonicalRoot = await store.root();
    const key = '6'.repeat(64);
    const lockDirectory = join(
      canonicalRoot,
      'scopes',
      stateScopeKey(context, 'project'),
      'action-locks',
    );
    const lockPath = join(lockDirectory, `${key}.lock`);
    const predecessor = {
      ownerId: '00000000-0000-4000-8000-000000000006',
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    const candidateKey = createHash('sha256').update(predecessor.ownerId).digest('hex').slice(0, 32);
    const candidatePath = `${lockPath}.candidate-${candidateKey}`;
    await mkdir(candidatePath, { recursive: true });
    await writeFile(
      join(candidatePath, `owner-${predecessor.ownerId}.json`),
      `${JSON.stringify(predecessor)}\n`,
      'utf8',
    );

    const successor = await store.acquireActionTransaction(
      canonicalRoot,
      key,
      'project',
      context,
    );
    await expect(rename(candidatePath, lockPath)).rejects.toMatchObject({
      code: expect.stringMatching(/^(EACCES|EEXIST|ENOTEMPTY|EPERM)$/),
    });
    await rm(candidatePath, { recursive: true, force: true });
    await expect(successor.assertHealthy()).resolves.toBeUndefined();
    await expect(successor.release()).resolves.toBeUndefined();
  });
});

interface TransactionTestOwner {
  ownerId: string;
  pid: number;
  createdAt: string;
}

interface TransactionTestLock {
  assertHealthy(): Promise<void>;
  release(): Promise<void>;
}

interface ReactUiStoreTransactionInternals {
  root(): Promise<string>;
  acquireActionTransaction(
    root: string,
    key: string,
    scope: 'project',
    context: InvocationContext,
  ): Promise<TransactionTestLock>;
  releaseActionTransaction(
    root: string,
    path: string,
    owner: TransactionTestOwner,
    timeoutMs: number,
  ): Promise<void>;
}

function transactionInternals(store: ReactUiStore): ReactUiStoreTransactionInternals {
  return store as unknown as ReactUiStoreTransactionInternals;
}

function acquired(claim: Awaited<ReturnType<ReactUiStore['claim']>>): UiActionIdempotencyLease {
  if (claim.status !== 'acquired') throw new Error(`Expected acquired claim, received ${claim.status}`);
  return claim.lease;
}

function record(requestDigest: string): UiActionIdempotencyRecord {
  const timestamp = new Date().toISOString();
  return {
    requestDigest,
    result: {
      status: 'success',
      output: { ok: true },
      receipt: {
        receiptId: 'receipt',
        renderId: '1'.repeat(64),
        actionId: 'test',
        actionVersion: '1.0.0',
        target: { kind: 'capability', capability: 'test.execute' },
        scope: 'project',
        principalId: 'agent',
        requestDigest,
        permission: { decision: 'allow', grants: ['test.execute'] },
        status: 'success',
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
      },
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marshal-ui-idempotency-'));
  temporaryRoots.push(root);
  return root;
}

async function filesNamed(root: string, name: string): Promise<string[]> {
  return walk(root, (entry) => entry === name);
}

async function filesContaining(root: string, fragment: string): Promise<string[]> {
  return walk(root, (entry, path) => entry.includes(fragment) || path.includes(fragment));
}

async function walk(root: string, matches: (entry: string, path: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (matches(entry.name, path)) found.push(path);
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return found;
}

interface IdempotencyProcessWorker {
  ready: Promise<void>;
  outcome: Promise<{ status: string; workerId: string }>;
  stop(): Promise<void>;
}

function launchWorker(
  storageRoot: string,
  coordinationRoot: string,
  counterPath: string,
  key: string,
  digest: string,
  workerId: string,
): IdempotencyProcessWorker {
  const require = createRequire(import.meta.url);
  const viteNode = require.resolve('vite-node/vite-node.mjs');
  const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-fixtures', 'idempotency-process-worker.ts');
  const child = spawn(process.execPath, [
    viteNode,
    fixture,
    storageRoot,
    coordinationRoot,
    counterPath,
    key,
    digest,
    workerId,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let pendingStdout = '';
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveOutcome!: (value: { status: string; workerId: string }) => void;
  let rejectOutcome!: (error: Error) => void;
  const ready = new Promise<void>((resolveWorker, rejectWorker) => {
    resolveReady = resolveWorker;
    rejectReady = rejectWorker;
  });
  const outcome = new Promise<{ status: string; workerId: string }>((resolveWorker, rejectWorker) => {
    resolveOutcome = resolveWorker;
    rejectOutcome = rejectWorker;
  });
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
    child.once('error', () => resolveExit());
  });
  const failReady = (error: Error) => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(error);
  };
  const observeReady = (line: string) => {
    const message = parseWorkerMessage(line);
    if (message?.status !== 'ready' || message.workerId !== workerId || readySettled) return;
    readySettled = true;
    resolveReady();
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    pendingStdout += chunk;
    for (;;) {
      const newline = pendingStdout.indexOf('\n');
      if (newline < 0) break;
      observeReady(pendingStdout.slice(0, newline).trim());
      pendingStdout = pendingStdout.slice(newline + 1);
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', (error) => {
    failReady(error);
    rejectOutcome(error);
  });
  child.on('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`Idempotency worker ${workerId} exited ${code ?? 'by signal'}: ${stderr || stdout}`);
      failReady(error);
      rejectOutcome(error);
      return;
    }
    if (!readySettled) {
      failReady(new Error(`Idempotency worker ${workerId} exited before readiness`));
    }
    const result = stdout
      .trim()
      .split(/\r?\n/)
      .map(parseWorkerMessage)
      .filter((message): message is { status: string; workerId: string } => Boolean(message))
      .findLast((message) => message.status !== 'ready');
    if (!result) {
      rejectOutcome(new Error(`Idempotency worker ${workerId} returned no result`));
      return;
    }
    resolveOutcome(result);
  });
  const worker: IdempotencyProcessWorker = {
    ready,
    outcome,
    async stop() {
      processWorkers.delete(worker);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.race([exited, delay(5_000)]);
      await Promise.allSettled([ready, outcome]);
    },
  };
  processWorkers.add(worker);
  void ready.catch(() => undefined);
  void outcome.catch(() => undefined);
  return worker;
}

function parseWorkerMessage(line: string): { status: string; workerId: string } | undefined {
  if (!line) return undefined;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.status !== 'string' || typeof value.workerId !== 'string') return undefined;
    return { status: value.status, workerId: value.workerId };
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
