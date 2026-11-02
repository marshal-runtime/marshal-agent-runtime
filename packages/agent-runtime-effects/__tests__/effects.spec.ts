import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
  type RuntimeEffectHandler,
} from '@marshal/agent-runtime-core';
import { BoundedFileEffectReplayStore, EffectDispatcher } from '../src/index.js';
import { sha256, storageKey } from '../src/json.js';

const cleanup: string[] = [];
const context: InvocationContext = {
  principal: { id: 'agent-effects', kind: 'agent' },
  scope: { workspaceId: 'workspace-a', projectId: 'project-a', sessionId: 'session-a' },
};

afterEach(async () => {
  for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true });
});

async function replayStore(options: {
  maxEntries?: number;
  transactionLockTimeoutMs?: number;
  staleTransactionLockMs?: number;
} = {}) {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-effects-'));
  cleanup.push(rootDirectory);
  return new BoundedFileEffectReplayStore({ rootDirectory, ...options });
}

describe('EffectDispatcher adapter conformance', () => {
  it('returns an explicit unsupported envelope when no adapter callback exists', async () => {
    const response = await new EffectDispatcher().execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        kind: 'harness.window.open',
        input: { title: 'Result' },
        idempotencyKey: 'window-open-1',
      },
      context,
    );

    expect(response).toMatchObject({
      status: 'unsupported',
      reason: expect.stringContaining('No adapter handler'),
      receipt: {
        kind: 'harness.window.open',
        idempotencyKey: 'window-open-1',
        principalId: 'agent-effects',
        replayed: false,
        resultDigest: expect.stringMatching(/^sha256:/),
      },
    });
  });

  it('durably replays a completed effect without calling a new adapter', async () => {
    const replay = await replayStore();
    const handle = vi.fn(async () => ({ status: 'success' as const, output: { opened: true } }));
    const handler: RuntimeEffectHandler = { id: 'test-adapter', handle };
    const request = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'harness.window.open',
      input: { title: 'Result' },
      idempotencyKey: 'window-open-durable',
    };
    const first = await new EffectDispatcher({ handler, replay }).execute(request, context);
    const replayed = await new EffectDispatcher({
      replay,
      handler: {
        id: 'replacement-adapter',
        handle: vi.fn(async () => {
          throw new Error('must not execute');
        }),
      },
    }).execute(request, context);

    expect(first).toMatchObject({ status: 'success', output: { opened: true } });
    expect(handle).toHaveBeenCalledOnce();
    expect(replayed).toMatchObject({
      status: 'success',
      output: { opened: true },
      receipt: {
        replayed: true,
        replayOfReceiptId: first.receipt.receiptId,
      },
    });
  });

  it('does not cache approval requirements and succeeds only after an explicit grant', async () => {
    const replay = await replayStore();
    const handle = vi.fn<RuntimeEffectHandler['handle']>(async (request) =>
      request.approval?.approvalId === 'approval-1'
        ? { status: 'success', output: { spawned: true } }
        : {
            status: 'approval_required',
            approval: { approvalId: 'approval-1', reason: 'Spawning requires approval.' },
          },
    );
    const verifyAndConsume = vi.fn(async (verification) => ({
      decision: 'allow' as const,
      approval: verification.approval,
      consumedAt: new Date().toISOString(),
      expiresAt: '2099-01-01T00:00:00.000Z',
    }));
    const dispatcher = new EffectDispatcher({
      handler: { id: 'agent-adapter', handle },
      replay,
      approvalVerifier: { verifyAndConsume },
    });
    const base = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'agent.spawn',
      input: { role: 'reviewer' },
      idempotencyKey: 'spawn-reviewer',
    };
    const approval = await dispatcher.execute(base, context);
    const success = await dispatcher.execute(
      { ...base, approval: { approvalId: 'approval-1', grantedBy: 'user' } },
      context,
    );
    const replayed = await dispatcher.execute(base, context);

    expect(approval.status).toBe('approval_required');
    expect(success).toMatchObject({ status: 'success', output: { spawned: true } });
    expect(replayed.receipt.replayed).toBe(true);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(verifyAndConsume).toHaveBeenCalledWith(expect.objectContaining({
      principalId: 'agent-effects',
      scope: context.scope,
      kind: 'agent.spawn',
      idempotencyKey: 'spawn-reviewer',
      requestDigest: expect.stringMatching(/^sha256:/),
    }));
  });

  it('fails closed when caller approval has no harness-owned verifier', async () => {
    const replay = await replayStore();
    const handle = vi.fn(async () => ({ status: 'success' as const, output: { unsafe: true } }));
    const response = await new EffectDispatcher({
      handler: { id: 'approval-boundary', handle },
      replay,
    }).execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        kind: 'test.mutate',
        idempotencyKey: 'unverified-approval',
        approval: { approvalId: 'caller-controlled' },
      },
      context,
    );

    expect(response).toMatchObject({
      status: 'failed',
      error: { code: 'effect_approval_verifier_unavailable' },
    });
    expect(handle).not.toHaveBeenCalled();

    const retried = await new EffectDispatcher({
      handler: { id: 'approval-boundary', handle },
      replay,
      approvalVerifier: {
        verifyAndConsume: async ({ approval }) => ({
          decision: 'allow',
          approval,
          consumedAt: new Date().toISOString(),
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      },
    }).execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        kind: 'test.mutate',
        idempotencyKey: 'unverified-approval',
        approval: { approvalId: 'caller-controlled' },
      },
      context,
    );
    expect(retried.status).toBe('success');
    expect(handle).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'future consumption',
      consumedAt: '2026-08-01T00:00:01.000Z',
      expiresAt: '2026-08-01T00:01:00.000Z',
    },
    {
      label: 'consumption at expiry',
      consumedAt: '2026-07-31T23:59:59.000Z',
      expiresAt: '2026-07-31T23:59:59.000Z',
    },
  ])('rejects verifier timestamps with $label', async ({ consumedAt, expiresAt }) => {
    const replay = await replayStore();
    const handle = vi.fn(async () => ({ status: 'success' as const, output: { unsafe: true } }));
    const response = await new EffectDispatcher({
      handler: { id: 'timestamp-boundary', handle },
      replay,
      now: () => new Date('2026-08-01T00:00:00.000Z'),
      approvalVerifier: {
        verifyAndConsume: ({ approval }) => ({
          decision: 'allow', approval, consumedAt, expiresAt,
        }),
      },
    }).execute({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'test.mutate',
      idempotencyKey: `bad-time-${consumedAt}`.replace(/[^A-Za-z0-9._:-]/g, '-'),
      approval: { approvalId: 'approval-time' },
    }, context);
    expect(response).toMatchObject({
      status: 'failed',
      error: { code: 'effect_approval_expired' },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different effect payload', async () => {
    const replay = await replayStore();
    const handle = vi.fn(async (request) => ({
      status: 'success' as const,
      output: request.input,
    }));
    const dispatcher = new EffectDispatcher({ handler: { id: 'strict-adapter', handle }, replay });
    const first = await dispatcher.execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        kind: 'test.echo',
        input: { value: 1 },
        idempotencyKey: 'strict-key',
      },
      context,
    );
    const conflicting = await dispatcher.execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        kind: 'test.echo',
        input: { value: 2 },
        idempotencyKey: 'strict-key',
      },
      context,
    );

    expect(first.status).toBe('success');
    expect(conflicting).toMatchObject({
      status: 'failed',
      error: { code: 'idempotency_key_reused' },
    });
    expect(handle).toHaveBeenCalledOnce();
  });

  it('serializes concurrent calls sharing one scoped idempotency key', async () => {
    const replay = await replayStore();
    const handle = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { status: 'success' as const, output: { created: true } };
    });
    const dispatcher = new EffectDispatcher({ handler: { id: 'concurrent', handle }, replay });
    const request = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'test.create',
      input: { value: 1 },
      idempotencyKey: 'concurrent-create',
    };

    const responses = await Promise.all([
      dispatcher.execute(request, context),
      dispatcher.execute(request, context),
    ]);

    expect(handle).toHaveBeenCalledOnce();
    expect(responses.map((response) => response.receipt.replayed).sort()).toEqual([false, true]);
  });

  it('atomically serializes two dispatchers sharing one durable replay root', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-effects-shared-'));
    cleanup.push(rootDirectory);
    const handle = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { status: 'success' as const, output: { created: true } };
    });
    const request = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'test.create',
      input: { value: 1 },
      idempotencyKey: 'cross-dispatcher-create',
    };
    const dispatchers = [
      new EffectDispatcher({
        handler: { id: 'process-a', handle },
        replay: new BoundedFileEffectReplayStore({ rootDirectory }),
      }),
      new EffectDispatcher({
        handler: { id: 'process-b', handle },
        replay: new BoundedFileEffectReplayStore({ rootDirectory }),
      }),
    ];

    const responses = await Promise.all(
      dispatchers.map((dispatcher) => dispatcher.execute(request, context)),
    );

    expect(handle).toHaveBeenCalledOnce();
    expect(responses.map((response) => response.receipt.replayed).sort()).toEqual([false, true]);
  });

  it('keeps a live transaction lock renewed beyond its stale threshold', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-effects-live-lock-'));
    cleanup.push(rootDirectory);
    const first = new BoundedFileEffectReplayStore({
      rootDirectory, transactionLockTimeoutMs: 1_000, staleTransactionLockMs: 30,
    });
    const second = new BoundedFileEffectReplayStore({
      rootDirectory, transactionLockTimeoutMs: 1_000, staleTransactionLockMs: 30,
    });
    const identity = replayIdentity('live-lock');
    const originalGet = first.get.bind(first);
    let entered!: () => void;
    const insideTransaction = new Promise<void>((resolve) => { entered = resolve; });
    first.get = async (requested) => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return originalGet(requested);
    };

    const firstClaim = first.claim(identity, executionClaim('first-live'));
    await insideTransaction;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondClaim = second.claim(identity, executionClaim('second-live'));
    await expect(firstClaim).resolves.toMatchObject({ status: 'acquired' });
    await expect(secondClaim).resolves.toMatchObject({ status: 'busy' });
  });

  it('reclaims a stale transaction lock once and still honors a blocked recovery timeout', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-effects-stale-lock-'));
    cleanup.push(rootDirectory);
    const identity = replayIdentity('stale-lock');
    const key = effectTransactionKey(identity);
    const lock = path.join(rootDirectory, `.${key}.lock`);
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner'), 'abandoned-owner');
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(path.join(lock, 'owner'), old, old);
    const stores = [0, 1].map(() => new BoundedFileEffectReplayStore({
      rootDirectory, transactionLockTimeoutMs: 500, staleTransactionLockMs: 10,
    }));
    const results = await Promise.all([
      stores[0]!.claim(identity, executionClaim('recovery-a')),
      stores[1]!.claim(identity, executionClaim('recovery-b')),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['acquired', 'busy']);

    const blockedIdentity = replayIdentity('blocked-stale-lock');
    const blockedKey = effectTransactionKey(blockedIdentity);
    const blockedLock = path.join(rootDirectory, `.${blockedKey}.lock`);
    const blockedOwner = 'blocked-owner';
    await fs.mkdir(blockedLock);
    await fs.writeFile(path.join(blockedLock, 'owner'), blockedOwner);
    await fs.utimes(path.join(blockedLock, 'owner'), old, old);
    const blockingQuarantine = path.join(
      rootDirectory,
      `.${blockedKey}.stale-${sha256(blockedOwner).slice(7, 39)}`,
    );
    await fs.mkdir(blockingQuarantine);
    await fs.writeFile(path.join(blockingQuarantine, 'occupied'), 'x');
    const outlastsCleanup = new Date(Date.now() + 60_000);
    await fs.utimes(blockingQuarantine, outlastsCleanup, outlastsCleanup);
    const bounded = new BoundedFileEffectReplayStore({
      rootDirectory, transactionLockTimeoutMs: 40, staleTransactionLockMs: 10,
    });
    const started = Date.now();
    await expect(bounded.claim(blockedIdentity, executionClaim('blocked')))
      .rejects.toMatchObject({ code: 'EFFECT_STORAGE_LOCK_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it.runIf(existsSync(fileURLToPath(new URL('../dist/index.js', import.meta.url))))(
    'atomically serializes native execution across separate Node processes',
    async () => {
      const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-effects-process-'));
      cleanup.push(rootDirectory);
      const marker = path.join(rootDirectory, 'native-calls.log');
      const gate = path.join(rootDirectory, 'start.gate');
      const script = path.join(rootDirectory, 'effect-child.mjs');
      const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
      const coreModuleUrl = new URL('../../agent-runtime-core/dist/index.js', import.meta.url).href;
      await fs.writeFile(script, `
import { appendFile, access } from 'node:fs/promises';
import { BoundedFileEffectReplayStore, EffectDispatcher } from ${JSON.stringify(moduleUrl)};
import { RUNTIME_PROTOCOL_VERSION } from ${JSON.stringify(coreModuleUrl)};
const [rootDirectory, marker, gate] = process.argv.slice(2);
while (true) { try { await access(gate); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } }
const context = { principal: { id: 'process-agent', kind: 'agent' }, scope: { workspaceId: 'workspace-a', projectId: 'project-a', sessionId: 'session-a' } };
const response = await new EffectDispatcher({
  replay: new BoundedFileEffectReplayStore({ rootDirectory }),
  handler: { id: 'child', handle: async () => {
    await appendFile(marker, 'called\\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { status: 'success', output: { completed: true } };
  } },
}).execute({ protocolVersion: RUNTIME_PROTOCOL_VERSION, kind: 'test.process', idempotencyKey: 'process-key' }, context);
process.stdout.write(JSON.stringify({ status: response.status, replayed: response.receipt.replayed }));
`);
      const children = [
        runNode(script, [rootDirectory, marker, gate]),
        runNode(script, [rootDirectory, marker, gate]),
      ];
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.writeFile(gate, 'start');
      const responses = (await Promise.all(children)).map((value) => JSON.parse(value));

      expect((await fs.readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
      expect(responses.map((response) => response.replayed).sort()).toEqual([false, true]);
    },
    15_000,
  );

  it('recovers an expired durable execution claim without changing its digest binding', async () => {
    const replay = await replayStore();
    const identity = {
      principalId: context.principal.id,
      scope: context.scope,
      idempotencyKey: 'expired-claim',
      requestDigest: 'sha256:request-a',
    };
    expect(await replay.claim(identity, {
      claimId: 'abandoned',
      claimedAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-01T00:00:01.000Z',
    })).toMatchObject({ status: 'acquired' });
    expect(await replay.claim(identity, {
      claimId: 'recovered',
      claimedAt: '2000-01-01T00:00:02.000Z',
      expiresAt: '2000-01-01T00:00:03.000Z',
    })).toMatchObject({ status: 'acquired', claim: { claimId: 'recovered' } });
    expect(await replay.claim({ ...identity, requestDigest: 'sha256:request-b' }, {
      claimId: 'conflicting',
      claimedAt: '2000-01-01T00:00:04.000Z',
      expiresAt: '2000-01-01T00:00:05.000Z',
    })).toMatchObject({
      status: 'conflict',
      existingRequestDigest: 'sha256:request-a',
    });
  });

  it('enforces bounded replay storage by evicting older results', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-effects-bound-'));
    cleanup.push(rootDirectory);
    const replay = new BoundedFileEffectReplayStore({ rootDirectory, maxEntries: 2 });
    const dispatcher = new EffectDispatcher({
      replay,
      handler: {
        id: 'bounded',
        handle: async (request) => ({ status: 'success', output: request.input }),
      },
    });
    for (let index = 0; index < 3; index += 1) {
      await dispatcher.execute(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          kind: 'test.echo',
          input: { index },
          idempotencyKey: `bounded-${index}`,
        },
        context,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const entries = (await fs.readdir(rootDirectory)).filter((name) => name.endsWith('.json'));
    expect(entries).toHaveLength(2);
  });
});

function runNode(script: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`Effect child exited ${code}: ${stderr}`));
    });
  });
}

function replayIdentity(idempotencyKey: string) {
  return {
    principalId: context.principal.id,
    scope: context.scope,
    idempotencyKey,
    requestDigest: `sha256:${'a'.repeat(64)}`,
  };
}

function executionClaim(claimId: string) {
  const claimedAt = new Date();
  return {
    claimId,
    claimedAt: claimedAt.toISOString(),
    expiresAt: new Date(claimedAt.getTime() + 60_000).toISOString(),
  };
}

function effectTransactionKey(identity: ReturnType<typeof replayIdentity>): string {
  const { requestDigest: _requestDigest, ...partition } = identity;
  return storageKey(partition);
}
