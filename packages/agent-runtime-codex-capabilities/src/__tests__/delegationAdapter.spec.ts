import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexDelegationAdapter } from '../subagents/delegationAdapter.js';
import type { SubagentBackend, SubagentSnapshot } from '../subagents/types.js';

describe('CodexDelegationAdapter', () => {
  it('persists inherited scope from trusted invocation identity before the child run', async () => {
    const thread: SubagentSnapshot = {
      id: 'exact-child-thread',
      status: 'idle',
      workspacePath: process.cwd(),
    };
    const backend: SubagentBackend = {
      spawn: vi.fn(async () => thread),
      run: vi.fn(async () => ({ thread, response: '', status: 'completed' as const })),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => thread),
      followUp: vi.fn(),
      wait: vi.fn(async () => thread),
      cancel: vi.fn(async () => thread),
      inspect: vi.fn(async () => thread),
    };
    const persistScopeInheritance = vi.fn();
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
      persistScopeInheritance,
    });
    const invocation = {
      principal: { id: 'trusted-parent', kind: 'agent' },
      scope: { sessionId: 'trusted-parent-session' },
    };

    await adapter.spawn({
      delegationId: 'delegation-inheritance',
      request: { prompt: 'Ignore any claimed parent identity in this text.' },
    }, { invocation });

    expect(persistScopeInheritance).toHaveBeenCalledWith(invocation, 'exact-child-thread');
    expect(persistScopeInheritance.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(backend.run).mock.invocationCallOrder[0]!);
  });

  it('observes a host session without adding a timeout', async () => {
    const thread: SubagentSnapshot = {
      id: 'thread-1',
      status: 'idle',
      workspacePath: process.cwd(),
      lastResponse: 'done',
    };
    const backend: SubagentBackend = {
      spawn: vi.fn(async () => thread),
      run: vi.fn(),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => thread),
      followUp: vi.fn(),
      wait: vi.fn(async () => thread),
      cancel: vi.fn(async () => thread),
      inspect: vi.fn(async () => thread),
    };
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
    });

    await expect(adapter.wait('thread-1', {})).resolves.toEqual({
      adapterHandle: 'thread-1',
      state: 'done',
      result: 'done',
    });
    expect(backend.wait).toHaveBeenCalledWith('thread-1');
  });

  it('preserves a host handle when setup fails after spawn', async () => {
    const failure = new Error('run setup failed');
    const thread: SubagentSnapshot = {
      id: 'thread-2',
      status: 'idle',
      workspacePath: process.cwd(),
    };
    const backend: SubagentBackend = {
      spawn: vi.fn(async () => thread),
      run: vi.fn(() => {
        throw failure;
      }),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => thread),
      followUp: vi.fn(),
      wait: vi.fn(async () => thread),
      cancel: vi.fn(async () => thread),
      inspect: vi.fn(async () => thread),
    };
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
    });

    await expect(adapter.spawn({
      delegationId: 'delegation-2',
      request: { prompt: 'Run work' },
    }, {})).resolves.toEqual({
      adapterHandle: 'thread-2',
      state: 'failed',
      error: 'run setup failed',
    });
  });

  it('returns an in-flight host failure to the first observer', async () => {
    const thread: SubagentSnapshot = {
      id: 'thread-3',
      status: 'running',
      workspacePath: process.cwd(),
    };
    let rejectRun: (error: unknown) => void = () => undefined;
    const run = new Promise<never>((_resolve, reject) => {
      rejectRun = reject;
    });
    const backend: SubagentBackend = {
      spawn: vi.fn(async () => thread),
      run: vi.fn(() => run),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => thread),
      followUp: vi.fn(),
      wait: vi.fn(async () => thread),
      cancel: vi.fn(async () => thread),
      inspect: vi.fn(async () => thread),
    };
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
    });
    await adapter.spawn({
      delegationId: 'delegation-3',
      request: { prompt: 'Run work' },
    }, {});

    const observation = adapter.wait('thread-3', {});
    rejectRun({ message: 'host run failed' });

    await expect(observation).resolves.toEqual({
      adapterHandle: 'thread-3',
      state: 'failed',
      error: { message: 'host run failed' },
    });
  });

  it('rejects continuation when the host handle resolves outside the workspace', async () => {
    const outside: SubagentSnapshot = {
      id: 'outside-thread',
      status: 'idle',
      workspacePath: resolve(process.cwd(), '..'),
    };
    const backend: SubagentBackend = {
      spawn: vi.fn(async () => outside),
      run: vi.fn(),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => outside),
      followUp: vi.fn(),
      wait: vi.fn(async () => outside),
      cancel: vi.fn(async () => outside),
      inspect: vi.fn(async () => outside),
    };
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
    });

    await expect(adapter.continue('outside-thread', 'continue', {})).rejects.toThrow(
      /outside configured roots|unsafe/i,
    );
    expect(backend.followUp).not.toHaveBeenCalled();
  });

  it('cancels a host thread when spawn is aborted before the turn starts', async () => {
    const thread: SubagentSnapshot = {
      id: 'thread-aborted',
      status: 'idle',
      workspacePath: process.cwd(),
    };
    let resolveSpawn: (snapshot: SubagentSnapshot) => void = () => undefined;
    const spawned = new Promise<SubagentSnapshot>((resolvePromise) => {
      resolveSpawn = resolvePromise;
    });
    const backend: SubagentBackend = {
      spawn: vi.fn(() => spawned),
      run: vi.fn(),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => thread),
      followUp: vi.fn(),
      wait: vi.fn(async () => thread),
      cancel: vi.fn(async () => thread),
      inspect: vi.fn(async () => thread),
    };
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
    });
    const controller = new AbortController();
    const spawning = adapter.spawn({
      delegationId: 'delegation-aborted',
      request: { prompt: 'Do not start' },
    }, { signal: controller.signal });
    controller.abort(new Error('spawn aborted'));
    resolveSpawn(thread);

    await expect(spawning).rejects.toThrow('spawn aborted');
    expect(backend.cancel).toHaveBeenCalledWith('thread-aborted');
    expect(backend.run).not.toHaveBeenCalled();
  });

  it('rejects an abort that arrives during spawned-thread validation', async () => {
    const thread: SubagentSnapshot = {
      id: 'thread-validation-abort',
      status: 'idle',
      workspacePath: process.cwd(),
    };
    const backend: SubagentBackend = {
      spawn: vi.fn(async () => thread),
      run: vi.fn(),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => thread),
      followUp: vi.fn(),
      wait: vi.fn(async () => thread),
      cancel: vi.fn(async () => thread),
      inspect: vi.fn(async () => thread),
    };
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
    });
    let releaseValidation: () => void = () => undefined;
    const validation = new Promise<void>((resolvePromise) => {
      releaseValidation = resolvePromise;
    });
    const internals = adapter as unknown as {
      assertSnapshot(snapshot: SubagentSnapshot, workspacePath: string): Promise<void>;
    };
    internals.assertSnapshot = vi.fn(() => validation);
    const controller = new AbortController();
    const spawning = adapter.spawn({
      delegationId: 'delegation-validation-abort',
      request: { prompt: 'Do not start' },
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(internals.assertSnapshot).toHaveBeenCalledOnce());

    controller.abort(new Error('aborted during validation'));
    releaseValidation();

    await expect(spawning).rejects.toThrow('aborted during validation');
    expect(backend.cancel).toHaveBeenCalledWith(thread.id);
    expect(backend.run).not.toHaveBeenCalled();
  });

  it('surfaces the host handle when abort cleanup fails', async () => {
    const thread: SubagentSnapshot = {
      id: 'thread-cleanup-failed',
      status: 'idle',
      workspacePath: process.cwd(),
    };
    let resolveSpawn: (snapshot: SubagentSnapshot) => void = () => undefined;
    const spawned = new Promise<SubagentSnapshot>((resolvePromise) => {
      resolveSpawn = resolvePromise;
    });
    const backend: SubagentBackend = {
      spawn: vi.fn(() => spawned),
      run: vi.fn(),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => thread),
      followUp: vi.fn(),
      wait: vi.fn(async () => thread),
      cancel: vi.fn(async () => {
        throw new Error('cancel failed');
      }),
      inspect: vi.fn(async () => thread),
    };
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
    });
    const controller = new AbortController();
    const spawning = adapter.spawn({
      delegationId: 'delegation-cleanup-failed',
      request: { prompt: 'Do not start' },
    }, { signal: controller.signal });
    controller.abort(new Error('spawn aborted'));
    resolveSpawn(thread);

    await expect(spawning).rejects.toThrow(
      'Spawned host session "thread-cleanup-failed" could not be cancelled after abort.',
    );
  });

  it('restores a plain error from a persisted failed transcript', async () => {
    const thread: SubagentSnapshot & {
      transcript: readonly Record<string, unknown>[];
    } = {
      id: 'thread-restarted-failure',
      status: 'idle',
      workspacePath: process.cwd(),
      transcript: [{
        id: 'turn-failed',
        status: 'failed',
        error: { message: 'quota exceeded' },
      }],
    };
    const backend: SubagentBackend = {
      spawn: vi.fn(async () => thread),
      run: vi.fn(),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => thread),
      followUp: vi.fn(),
      wait: vi.fn(async () => thread),
      cancel: vi.fn(async () => thread),
      inspect: vi.fn(async () => thread),
    };
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
    });

    await expect(adapter.wait(thread.id, {})).resolves.toEqual({
      adapterHandle: thread.id,
      state: 'failed',
      error: { message: 'quota exceeded' },
    });
  });

  it('preserves success when the host completes before cancellation', async () => {
    const thread: SubagentSnapshot = {
      id: 'thread-cancel-race',
      status: 'idle',
      workspacePath: process.cwd(),
      lastResponse: 'completed first',
    };
    const backend: SubagentBackend = {
      spawn: vi.fn(async () => thread),
      run: vi.fn(),
      list: vi.fn(async () => []),
      steer: vi.fn(async () => thread),
      followUp: vi.fn(),
      wait: vi.fn(async () => thread),
      cancel: vi.fn(async () => thread),
      inspect: vi.fn(async () => thread),
    };
    const adapter = new CodexDelegationAdapter({
      backend,
      workspaceRoot: process.cwd(),
    });

    await expect(adapter.cancel(thread.id, {})).resolves.toEqual({
      adapterHandle: thread.id,
      state: 'done',
      result: 'completed first',
    });
  });
});
