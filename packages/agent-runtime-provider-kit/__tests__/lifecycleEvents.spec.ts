import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableLifecycleEventCoordinator } from '../src/lifecycleEvents.js';
import { purgeLifecycleResults } from '../src/lifecycleResults.js';

const FILLER_FILE_COUNT = 10_000;
const FILLER_BATCH_SIZE = 200;
const TEMP_DIRECTORY = realpathSync.native(os.tmpdir());
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

describe('DurableLifecycleEventCoordinator', () => {
  it('does not start background filesystem initialization for an invalid request', async () => {
    const parent = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-invalid-'));
    cleanup.push(parent);
    const journalRoot = path.join(parent, 'journal');
    const resultRoot = path.join(parent, 'results');
    const coordinator = new DurableLifecycleEventCoordinator(journalRoot, {
      resultDirectory: resultRoot,
    });

    await expect(coordinator.apply(
      'user_message',
      { protocolVersion: '2.0.0', eventId: 'invalid-version', sessionId: 'invalid-session' },
      async () => 'must not run',
    )).rejects.toThrow(/Unsupported runtime protocol version/);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(fs.lstat(journalRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(resultRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps private callback bodies out of the lifecycle journal while preserving restart replay', async () => {
    const journalRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-journal-'));
    const resultRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-private-'));
    cleanup.push(journalRoot, resultRoot);
    const secret = 'private recalled context: violet-release-token';
    const request = { eventId: 'private-turn', sessionId: 'private-session' };
    const coordinator = new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot });
    await coordinator.apply('user_message', request, async () => ({ additionalContext: secret }));

    const journalFiles = await fs.readdir(journalRoot, { recursive: true });
    const journalText = (await Promise.all(journalFiles
      .filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFile(path.join(journalRoot, name), 'utf8')))).join('\n');
    expect(journalText).not.toContain(secret);
    expect(journalText).toContain('resultRef');

    const replayCallback = vi.fn(async () => ({ additionalContext: 'must not run' }));
    await expect(new DurableLifecycleEventCoordinator(journalRoot, {
      resultDirectory: resultRoot,
    }).apply('user_message', request, replayCallback)).resolves.toMatchObject({
      result: { additionalContext: secret },
      receipt: { replayed: true },
    });
    expect(replayCallback).not.toHaveBeenCalled();
  });

  it('claims an event atomically and persists the completed result for restarted callers', async () => {
    const stateRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-'));
    cleanup.push(stateRoot);
    const request = {
      protocolVersion: '1.0.0',
      eventId: 'concurrent-turn',
      sessionId: 'session-a',
    };
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback = vi.fn(async () => {
      await paused;
      return { injectedContext: 'applied once' };
    });
    const coordinator = new DurableLifecycleEventCoordinator(stateRoot);
    const first = coordinator.apply('user_message', request, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());

    const concurrentCallback = vi.fn(async () => ({ injectedContext: 'must not run' }));
    const concurrent = coordinator.apply('user_message', request, concurrentCallback);
    let concurrentSettled = false;
    void concurrent.finally(() => {
      concurrentSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(concurrentSettled).toBe(false);
    expect(concurrentCallback).not.toHaveBeenCalled();

    release();
    await expect(first).resolves.toMatchObject({
      result: { injectedContext: 'applied once' },
      receipt: { status: 'applied', replayed: false },
    });
    await expect(concurrent).resolves.toMatchObject({
      result: { injectedContext: 'applied once' },
      receipt: { status: 'applied', replayed: true, eventId: 'concurrent-turn' },
    });

    const restarted = new DurableLifecycleEventCoordinator(stateRoot);
    const restartedCallback = vi.fn(async () => ({ injectedContext: 'must not run' }));
    await expect(restarted.apply('user_message', request, restartedCallback)).resolves.toMatchObject({
      result: { injectedContext: 'applied once' },
      receipt: { status: 'applied', replayed: true },
    });
    expect(restartedCallback).not.toHaveBeenCalled();

    const collisionCallback = vi.fn(async () => ({ injectedContext: 'must not run' }));
    await expect(
      restarted.apply(
        'user_message',
        { ...request, payload: 'different request under a reused ID' },
        collisionCallback,
      ),
    ).rejects.toMatchObject({ code: 'LIFECYCLE_EVENT_IDENTITY_COLLISION' });
    expect(collisionCallback).not.toHaveBeenCalled();
  });

  it('rethrows a durable failed result while persisting only a redacted failure', async () => {
    const stateRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-'));
    cleanup.push(stateRoot);
    const request = { eventId: 'failed-turn', sessionId: 'session-failed' };
    const coordinator = new DurableLifecycleEventCoordinator(stateRoot);

    await expect(
      coordinator.apply('user_message', request, async () => {
        throw Object.assign(new Error('persistent callback failure secret-violet-991'), {
          code: 'secret-violet-991',
        });
      }),
    ).rejects.toMatchObject({
      code: 'secret-violet-991',
      lifecycleReceipt: {
        status: 'failed',
        replayed: false,
        error: { code: 'LIFECYCLE_EVENT_FAILED', message: 'Lifecycle event callback failed.' },
      },
    });

    const persisted = (await Promise.all((await fs.readdir(stateRoot, { recursive: true }))
      .filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFile(path.join(stateRoot, name), 'utf8')))).join('\n');
    expect(persisted).not.toContain('secret-violet-991');
    expect(persisted).not.toContain('persistent callback failure');

    const replayCallback = vi.fn(async () => 'must not run');
    await expect(
      new DurableLifecycleEventCoordinator(stateRoot).apply(
        'user_message',
        request,
        replayCallback,
      ),
    ).rejects.toMatchObject({
      code: 'LIFECYCLE_EVENT_FAILED',
      message: 'Lifecycle event callback failed.',
      lifecycleReceipt: { status: 'failed', replayed: true },
    });
    expect(replayCallback).not.toHaveBeenCalled();
  });

  it('bounds how long a duplicate caller waits for a live owner', async () => {
    const stateRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-'));
    cleanup.push(stateRoot);
    const request = { eventId: 'busy-turn', sessionId: 'session-busy' };
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => { markOwnerStarted = resolve; });
    const owner = new DurableLifecycleEventCoordinator(stateRoot).apply(
      'user_message',
      request,
      async () => {
        markOwnerStarted();
        await paused;
        return 'finished';
      },
    );
    await ownerStarted;

    await expect(
      new DurableLifecycleEventCoordinator(stateRoot, {
        waitTimeoutMs: 50,
        pollIntervalMs: 10,
      }).apply('user_message', request, async () => 'must not run'),
    ).rejects.toMatchObject({
      code: 'LIFECYCLE_EVENT_BUSY',
      lifecycleReceipt: { status: 'applying', replayed: true },
    });
    release();
    await expect(owner).resolves.toMatchObject({ result: 'finished' });
  });

  it('rejects a pre-existing session symlink or junction', async () => {
    const stateRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-'));
    const outside = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-outside-'));
    cleanup.push(stateRoot, outside);
    const sessionId = 'unsafe-session';
    const sessionDirectory = path.join(stateRoot, sha256(sessionId));
    await fs.symlink(outside, sessionDirectory, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      new DurableLifecycleEventCoordinator(stateRoot).apply(
        'user_message',
        { sessionId, eventId: 'unsafe-event' },
        async () => 'must not run',
      ),
    ).rejects.toMatchObject({ code: 'LIFECYCLE_SESSION_PATH_UNSAFE' });
  });

  it('reclaims a real cross-process claim after its owner is killed', async () => {
    const stateRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-'));
    cleanup.push(stateRoot);
    const marker = path.join(stateRoot, 'callbacks.log');
    const child = spawnLifecycleChild(stateRoot, marker, 'hold');
    await waitForOutput(child, 'READY');
    expect(await fs.readFile(marker, 'utf8')).toBe('callback\n');

    child.kill('SIGKILL');
    await waitForExit(child);
    const recovered = await new DurableLifecycleEventCoordinator(stateRoot, {
      leaseDurationMs: 100,
      waitTimeoutMs: 5_000,
      pollIntervalMs: 10,
    }).apply(
      'user_message',
      { sessionId: 'cross-process-session', eventId: 'cross-process-event' },
      async () => {
        await fs.appendFile(marker, 'callback\n');
        return { recovered: true };
      },
    );

    expect(recovered).toMatchObject({
      result: { recovered: true },
      receipt: { status: 'applied', replayed: false },
    });
    expect((await fs.readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(2);
  }, 15_000);

  it('lets an expired lease supersede a live but hung owner without stale completion overwrite', async () => {
    const stateRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-'));
    cleanup.push(stateRoot);
    const marker = path.join(stateRoot, 'callbacks.log');
    const staleOwner = spawnLifecycleChild(stateRoot, marker, 'hang');
    await waitForOutput(staleOwner, 'READY');
    const staleOutput = collectSuccessfulOutput(staleOwner);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const recovered = await new DurableLifecycleEventCoordinator(stateRoot, {
      leaseDurationMs: 100,
      waitTimeoutMs: 5_000,
      pollIntervalMs: 10,
    }).apply(
      'user_message',
      { sessionId: 'cross-process-session', eventId: 'cross-process-event' },
      async () => {
        await fs.appendFile(marker, 'replacement\n');
        await new Promise((resolve) => setTimeout(resolve, 600));
        return { replacement: true };
      },
    );

    expect(recovered).toMatchObject({
      result: { replacement: true },
      receipt: { status: 'applied', replayed: false },
    });
    expect(await staleOutput).toContain('ERROR:LIFECYCLE_EVENT_LEASE_LOST');
    expect((await fs.readFile(marker, 'utf8')).trim().split('\n')).toEqual([
      'callback',
      'replacement',
    ]);
  }, 15_000);

  it('runs a callback exactly once across concurrent processes', async () => {
    const stateRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-'));
    cleanup.push(stateRoot);
    const marker = path.join(stateRoot, 'callbacks.log');
    const children = Array.from({ length: 4 }, () =>
      spawnLifecycleChild(stateRoot, marker, 'apply'),
    );
    const outputs = await Promise.all(children.map((child) => collectSuccessfulOutput(child)));

    expect(outputs).toHaveLength(4);
    expect(outputs.every((output) => output.includes('"status":"applied"'))).toBe(true);
    expect((await fs.readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
  }, 15_000);

  it('purges result bodies that contain given text and replays those events without reapplying', async () => {
    const journalRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-journal-'));
    const resultRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-private-'));
    cleanup.push(journalRoot, resultRoot);
    const forgotten = 'forgotten "quoted"\nfact: amber-lantern';
    const coordinator = new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot });
    const purgedRequest = { eventId: 'recall-1', sessionId: 'session-forget' };
    const keptRequest = { eventId: 'recall-2', sessionId: 'session-forget' };
    await coordinator.apply('session_start', purgedRequest, async () => ({
      preload: { memories: [{ id: 'mem-1', content: forgotten }] },
    }));
    await coordinator.apply('session_start', keptRequest, async () => ({ additionalContext: 'kept' }));
    const staleTemporary = path.join(resultRoot, `.${'a'.repeat(64)}.result.json.${randomTmpId()}.tmp`);
    await fs.writeFile(staleTemporary, forgotten);
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(staleTemporary, stale, stale);

    await expect(coordinator.purgeResults({ containing: ['amber-lantern'] })).resolves.toEqual({
      scanned: 2,
      removed: 1,
      removedUnreadable: 0,
      removedTemporary: 1,
      truncated: false,
    });
    const remaining = (await fs.readdir(resultRoot)).filter((name) => name !== 'purge-epoch.json');
    const remainingText = (await Promise.all(remaining.map((name) => fs.readFile(path.join(resultRoot, name), 'utf8')))).join('\n');
    expect(remaining).toHaveLength(1);
    expect(remainingText).not.toContain('amber-lantern');

    const restarted = new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot });
    const replayCallback = vi.fn(async () => ({ additionalContext: 'must not run' }));
    const replayed = await restarted.apply('session_start', purgedRequest, replayCallback);
    expect(replayed.result).toBeUndefined();
    expect(replayed.receipt).toMatchObject({ status: 'applied', replayed: true, resultUnavailable: true });
    await expect(restarted.apply('session_start', keptRequest, replayCallback)).resolves.toMatchObject({
      result: { additionalContext: 'kept' },
      receipt: { replayed: true },
    });
    expect(replayCallback).not.toHaveBeenCalled();
    await expect(restarted.purgeResults({})).rejects.toThrow(/needs containing, olderThanMs, or all/);
  });

  it('sweeps result bodies older than the configured retention after an apply', async () => {
    const journalRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-journal-'));
    const resultRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-private-'));
    cleanup.push(journalRoot, resultRoot);
    const writer = new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot });
    await writer.apply('session_start', { eventId: 'old', sessionId: 'retention' }, async () => ({ context: 'old secret' }));
    const [oldName] = await fs.readdir(resultRoot);
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(path.join(resultRoot, oldName!), past, past);

    const retaining = new DurableLifecycleEventCoordinator(journalRoot, {
      resultDirectory: resultRoot,
      resultRetentionMs: 60 * 60 * 1000,
    });
    await retaining.apply('session_start', { eventId: 'new', sessionId: 'retention' }, async () => ({ context: 'new' }));
    const names = await fs.readdir(resultRoot);
    expect(names).toHaveLength(1);
    expect(names).not.toContain(oldName);
    await expect(retaining.apply('session_start', { eventId: 'old', sessionId: 'retention' }, async () => {
      throw new Error('must not run');
    })).resolves.toMatchObject({ receipt: { replayed: true, resultUnavailable: true } });
  });
});

describe('purgeLifecycleResults', () => {
  it('keeps a young temporary file, which may be a write in progress, and removes an aged one', async () => {
    const resultRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-private-'));
    cleanup.push(resultRoot);
    const young = path.join(resultRoot, `.${'b'.repeat(64)}.result.json.${randomTmpId()}.tmp`);
    const aged = path.join(resultRoot, `.${'c'.repeat(64)}.result.json.${randomTmpId()}.tmp`);
    await fs.writeFile(young, 'in flight');
    await fs.writeFile(aged, 'abandoned');
    const past = new Date(Date.now() - 6 * 60 * 1000);
    await fs.utimes(aged, past, past);
    await expect(purgeLifecycleResults(resultRoot, { all: true })).resolves.toMatchObject({ removedTemporary: 1 });
    expect((await fs.readdir(resultRoot)).filter((name) => name !== 'purge-epoch.json')).toEqual([path.basename(young)]);
  });

  it('never fails a concurrent apply while purges run', async () => {
    const journalRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-journal-'));
    const resultRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-private-'));
    cleanup.push(journalRoot, resultRoot);
    const coordinator = new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot });
    let purging = true;
    const purges = (async () => {
      while (purging) await coordinator.purgeResults({ all: true });
    })();
    try {
      const applied = await Promise.all(Array.from({ length: 40 }, (_, index) =>
        coordinator.apply('turn', { eventId: `e-${index}`, sessionId: 'concurrent-purge' }, async () => ({ index }))));
      expect(applied.every(({ receipt }) => receipt.status === 'applied')).toBe(true);
    } finally {
      purging = false;
      await purges;
    }
  });

  it('drops the body of an apply whose callback was in flight when a purge ran', async () => {
    const journalRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-journal-'));
    const resultRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-private-'));
    cleanup.push(journalRoot, resultRoot);
    const coordinator = new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot });
    const request = { eventId: 'recall-in-flight', sessionId: 'purge-race' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
    const inFlight = coordinator.apply('session_start', request, async () => {
      started();
      await gate;
      return { preload: 'raced-secret-lark' };
    });
    await callbackStarted;
    // A purge from another coordinator instance on the same directory, as a second process would.
    await new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot })
      .purgeResults({ containing: ['raced-secret-lark'] });
    release();

    const applied = await inFlight;
    expect(applied.result).toEqual({ preload: 'raced-secret-lark' });
    expect(applied.receipt).toMatchObject({ status: 'applied', replayed: false, resultUnavailable: true });
    const bodies = (await fs.readdir(resultRoot)).filter((name) => name.endsWith('.result.json'));
    expect(bodies).toEqual([]);
    const persisted = (await Promise.all((await fs.readdir(resultRoot)).concat()
      .map((name) => fs.readFile(path.join(resultRoot, name), 'utf8')))).join('\n');
    expect(persisted).not.toContain('raced-secret-lark');

    const replayCallback = vi.fn(async () => ({ preload: 'must not run' }));
    const replayed = await new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot })
      .apply('session_start', request, replayCallback);
    expect(replayed.result).toBeUndefined();
    expect(replayed.receipt).toMatchObject({ status: 'applied', replayed: true, resultUnavailable: true });
    expect(replayCallback).not.toHaveBeenCalled();

    await coordinator.apply('session_start', { eventId: 'after-purge', sessionId: 'purge-race' }, async () => ({ kept: 'yes' }));
    await expect(new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot })
      .apply('session_start', { eventId: 'after-purge', sessionId: 'purge-race' }, replayCallback))
      .resolves.toMatchObject({ result: { kept: 'yes' }, receipt: { replayed: true } });
  });

  it('keeps in-flight bodies across a retention sweep, which does not advance the purge epoch', async () => {
    const journalRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-journal-'));
    const resultRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-private-'));
    cleanup.push(journalRoot, resultRoot);
    const coordinator = new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
    const inFlight = coordinator.apply('turn', { eventId: 'slow', sessionId: 'sweep' }, async () => {
      started();
      await gate;
      return { body: 'kept' };
    });
    await callbackStarted;
    await purgeLifecycleResults(resultRoot, { olderThanMs: 60_000 }, { advanceEpoch: false });
    release();
    const applied = await inFlight;
    expect(applied.receipt.resultUnavailable).toBeUndefined();
    expect((await fs.readdir(resultRoot)).filter((name) => name.endsWith('.result.json'))).toHaveLength(1);
  });

  it('visits every entry of a directory larger than one scan page', async () => {
    const journalRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-journal-'));
    const resultRoot = await fs.mkdtemp(path.join(TEMP_DIRECTORY, 'provider-lifecycle-private-'));
    cleanup.push(journalRoot, resultRoot);
    // '0-…' sorts before every hex-named body, so these fill the whole first page.
    await Array.from({ length: FILLER_FILE_COUNT / FILLER_BATCH_SIZE }).reduce<Promise<void>>(
      (previous, _, batch) => previous.then(async () => {
        await Promise.all(Array.from({ length: FILLER_BATCH_SIZE }, (__, offset) =>
          fs.writeFile(path.join(resultRoot, `0-filler-${String(batch * FILLER_BATCH_SIZE + offset).padStart(5, '0')}`), '')));
      }),
      Promise.resolve(),
    );
    const coordinator = new DurableLifecycleEventCoordinator(journalRoot, { resultDirectory: resultRoot });
    await coordinator.apply('turn', { eventId: 'late', sessionId: 'paging' }, async () => ({ text: 'page-two-secret' }));
    await expect(coordinator.purgeResults({ containing: ['page-two-secret'] })).resolves.toMatchObject({
      scanned: 1,
      removed: 1,
      truncated: false,
    });
  }, 30_000);
});

function randomTmpId(): string {
  return '0123abcd-4567-89ef-0123-456789abcdef';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function spawnLifecycleChild(
  root: string,
  marker: string,
  mode: 'hold' | 'hang' | 'apply',
): ChildProcess {
  const moduleUrl = new URL('../dist/lifecycleEvents.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs/promises';
    const { DurableLifecycleEventCoordinator } = await import(process.argv[1]);
    const [root, marker, mode] = process.argv.slice(2);
    const coordinator = new DurableLifecycleEventCoordinator(root, {
      leaseDurationMs: mode === 'apply' ? 2000 : 100,
      waitTimeoutMs: 5000,
      pollIntervalMs: 10,
    });
    try {
      const applied = await coordinator.apply(
        'user_message',
        { sessionId: 'cross-process-session', eventId: 'cross-process-event' },
        async () => {
          await fs.appendFile(marker, 'callback\\n');
          if (mode === 'hold') {
            process.stdout.write('READY\\n');
            await new Promise(() => undefined);
          }
          if (mode === 'hang') {
            process.stdout.write('READY\\n');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
          }
          await new Promise((resolve) => setTimeout(resolve, 75));
          return { ownerPid: process.pid };
        },
      );
      process.stdout.write(JSON.stringify(applied.receipt) + '\\n');
    } catch (error) {
      process.stdout.write('ERROR:' + String(error?.code ?? 'UNKNOWN') + '\\n');
    }
  `;
  return spawn(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, root, marker, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}.`)), 5_000);
    child.stdout?.on('data', (chunk) => {
      if (!String(chunk).includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code === null || code === 0) return;
      clearTimeout(timeout);
      reject(new Error(`Lifecycle child exited before readiness with code ${code}.`));
    });
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function collectSuccessfulOutput(child: ChildProcess): Promise<string> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  if (code !== 0) throw new Error(`Lifecycle child exited with ${code}: ${stderr}`);
  return stdout;
}
