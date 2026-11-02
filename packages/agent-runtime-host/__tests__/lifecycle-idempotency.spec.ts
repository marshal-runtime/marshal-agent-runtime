import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ComposedRuntimeLifecycle,
  scopeFileName,
  type RuntimeLifecyclePort,
} from '../src/index.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

describe('durable host lifecycle events', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a preplanted journal symlink without modifying its canary target',
    async () => {
      const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-'));
      const protectedResultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-private-'));
      const canaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-canary-'));
      cleanup.push(stateRoot, protectedResultRoot, canaryRoot);
      const canary = path.join(canaryRoot, 'canary.jsonl');
      await fs.writeFile(canary, 'CANARY-UNCHANGED\n');
      const journalDirectory = path.join(stateRoot, 'lifecycle');
      await fs.mkdir(journalDirectory);
      const sessionId = 'preplanted-link-session';
      await fs.symlink(canary, path.join(journalDirectory, scopeFileName('session', sessionId)));
      const lifecycle = new ComposedRuntimeLifecycle(stateRoot, [], protectedResultRoot);

      await expect(lifecycle.startSession({ sessionId })).rejects.toThrow();
      expect(await fs.readFile(canary, 'utf8')).toBe('CANARY-UNCHANGED\n');
    },
  );

  it('does not reapply duplicate observations or endings after a process restart', async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-'));
    const protectedResultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-private-'));
    cleanup.push(stateRoot, protectedResultRoot);
    const secret = 'private recalled context violet-token-731';
    const observeTurn = vi.fn(async () => ({ additionalContext: secret }));
    const endSession = vi.fn(async () => ({}));
    const delegate: RuntimeLifecyclePort = {
      startSession: async () => ({}),
      observeTurn,
      endSession,
    };
    const observation = {
      protocolVersion: '1.0.0',
      eventId: 'turn-7',
      sessionId: 'session-a',
      kind: 'user_message' as const,
      content: 'Remember this once.',
    };
    const ending = {
      protocolVersion: '1.0.0',
      eventId: 'end-7',
      sessionId: 'session-a',
      outcome: 'complete',
    };

    const firstProcess = new ComposedRuntimeLifecycle(stateRoot, [delegate], protectedResultRoot);
    const firstObservation = (await firstProcess.observeTurn(observation)) as LifecycleOutput;
    const firstEnding = (await firstProcess.endSession(ending)) as LifecycleOutput;

    const restartedProcess = new ComposedRuntimeLifecycle(stateRoot, [delegate], protectedResultRoot);
    const replayedObservation = (await restartedProcess.observeTurn(observation)) as LifecycleOutput;
    const replayedEnding = (await restartedProcess.endSession(ending)) as LifecycleOutput;

    expect(firstObservation).toMatchObject({
      additionalContext: secret,
      lifecycleReceipt: { status: 'applied', replayed: false, eventId: 'turn-7' },
    });
    expect(replayedObservation).toMatchObject({
      additionalContext: secret,
      lifecycleReceipt: { status: 'applied', replayed: true, eventId: 'turn-7' },
    });
    expect(firstEnding.lifecycleReceipt).toMatchObject({
      status: 'applied',
      replayed: false,
      eventId: 'end-7',
    });
    expect(replayedEnding.lifecycleReceipt).toMatchObject({
      status: 'applied',
      replayed: true,
      eventId: 'end-7',
    });
    expect(observeTurn).toHaveBeenCalledOnce();
    expect(endSession).toHaveBeenCalledOnce();

    const journalDirectory = path.join(stateRoot, 'lifecycle');
    const journalName = (await fs.readdir(journalDirectory)).find((name) => name.endsWith('.jsonl'));
    expect(journalName).toBeDefined();
    const journal = await fs.readFile(path.join(journalDirectory, journalName!), 'utf8');
    expect(journal.trim().split('\n')).toHaveLength(2);
    const workspaceFiles = await fs.readdir(stateRoot, { recursive: true });
    const workspaceText = (await Promise.all(workspaceFiles
      .filter((name) => name.endsWith('.json') || name.endsWith('.jsonl'))
      .map((name) => fs.readFile(path.join(stateRoot, name), 'utf8')))).join('\n');
    expect(workspaceText).not.toContain(secret);
  });

  it('rejects an unsupported lifecycle protocol before invoking delegates', async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-'));
    cleanup.push(stateRoot);
    const observeTurn = vi.fn(async () => ({}));
    const lifecycle = new ComposedRuntimeLifecycle(stateRoot, [
      {
        startSession: async () => ({}),
        observeTurn,
        endSession: async () => ({}),
      },
    ]);

    await expect(
      lifecycle.observeTurn({
        protocolVersion: '2.0.0',
        eventId: 'unsupported-turn',
        sessionId: 'session-a',
        kind: 'user_message',
        content: 'should not be applied',
      }),
    ).rejects.toThrow(/Unsupported runtime protocol version/);
    expect(observeTurn).not.toHaveBeenCalled();
  });
});

interface LifecycleOutput {
  readonly additionalContext?: string;
  readonly lifecycleReceipt: Readonly<{
    status: string;
    replayed: boolean;
    eventId: string;
  }>;
}
