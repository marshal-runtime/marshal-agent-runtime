import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CodexSubagentProvider } from '../subagents/provider.js';
import type { SubagentBackend, SubagentSnapshot } from '../subagents/types.js';
import type { InvocationContext } from '../coreTypes.js';

const context: InvocationContext = {
  principal: { id: 'parent', kind: 'agent' },
  scope: { sessionId: 'session-1' },
};
const workspaceRoot = resolve('.');
const projectWorkspace = join(workspaceRoot, 'src');
const outsideWorkspace = dirname(workspaceRoot);

describe('Codex subagent provider', () => {
  it('exposes spawn/run/list/send/follow-up/wait/cancel/inspect and forwards to an injected backend', async () => {
    const backend = fakeBackend(projectWorkspace);
    const persistScopeInheritance = vi.fn();
    const provider = new CodexSubagentProvider({
      backend,
      workspaceRoot,
      persistScopeInheritance,
    });
    expect(provider.list().map((entry) => entry.name)).toEqual([
      'codex.subagents.spawn',
      'codex.subagents.run',
      'codex.subagents.list',
      'codex.subagents.send',
      'codex.subagents.follow_up',
      'codex.subagents.wait',
      'codex.subagents.cancel',
      'codex.subagents.inspect',
    ]);
    const spawned = await provider.invoke(
      'codex.subagents.spawn',
      { workspacePath: projectWorkspace, name: 'reviewer', prompt: 'Review it' },
      context,
    );
    expect(spawned.output).toMatchObject({ thread: { id: 'thread-1' }, run: { response: 'done' } });
    expect(backend.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: projectWorkspace, name: 'reviewer' }),
    );
    expect(backend.run).toHaveBeenCalledWith('thread-1', 'Review it', {
      reasoningEffort: undefined,
    });
    expect(persistScopeInheritance).toHaveBeenCalledWith(context, 'thread-1');
    expect(persistScopeInheritance.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(backend.run).mock.invocationCallOrder[0]!);
    const cancelled = await provider.invoke(
      'codex.subagents.cancel',
      { threadId: 'thread-1' },
      context,
    );
    expect(cancelled.output).toEqual({ thread: snapshotFor(projectWorkspace) });
    expect(backend.cancel).toHaveBeenCalledWith('thread-1');
  });

  it('rejects workspace escape and backend snapshots outside configured roots', async () => {
    const backend = fakeBackend(outsideWorkspace);
    const provider = new CodexSubagentProvider({ backend, workspaceRoot });
    await expect(
      provider.invoke(
        'codex.subagents.spawn',
        { workspacePath: join(workspaceRoot, '..', 'escape') },
        context,
      ),
    ).rejects.toThrow('configured root');
    await expect(
      provider.invoke('codex.subagents.inspect', { threadId: 'thread-1' }, context),
    ).rejects.toThrow('outside configured');
    await expect(
      provider.invoke('codex.subagents.cancel', { threadId: 'thread-1' }, context),
    ).rejects.toThrow('outside configured');
    await expect(
      provider.invoke('codex.subagents.cancel', { threadId: '../thread-1' }, context),
    ).rejects.toThrow('unsafe characters');
  });

  it('requires an explicit provisioner for worktree isolation', async () => {
    const provider = new CodexSubagentProvider({
      backend: fakeBackend(workspaceRoot),
      workspaceRoot,
    });
    await expect(
      provider.invoke('codex.subagents.spawn', { worktreeIsolation: true }, context),
    ).rejects.toThrow('WorktreeProvisioner');
  });

  it('cancels a prompted spawn when its invocation signal aborts during the child turn', async () => {
    const backend = fakeBackend(workspaceRoot);
    const childTurn = deferred<never>();
    vi.mocked(backend.run).mockImplementation(() => childTurn.promise);
    const provider = new CodexSubagentProvider({ backend, workspaceRoot });
    const controller = new AbortController();

    const invocation = provider.invoke(
      'codex.subagents.spawn',
      { prompt: 'Work until cancelled' },
      { ...context, signal: controller.signal },
    );
    await vi.waitFor(() => expect(backend.run).toHaveBeenCalledOnce());
    controller.abort(new Error('module timeout'));

    await expect(invocation).rejects.toMatchObject({ code: 'ABORT_ERR', message: 'module timeout' });
    expect(backend.cancel).toHaveBeenCalledOnce();
    expect(backend.cancel).toHaveBeenCalledWith('thread-1');
  });

  it('cancels run and follow-up operations when their invocation signal aborts', async () => {
    for (const scenario of [
      { operation: 'codex.subagents.run', input: { threadId: 'thread-1', prompt: 'Run' } },
      {
        operation: 'codex.subagents.follow_up',
        input: { threadId: 'thread-1', message: 'Continue' },
      },
    ] as const) {
      const backend = fakeBackend(workspaceRoot);
      const childTurn = deferred<never>();
      if (scenario.operation === 'codex.subagents.run') {
        vi.mocked(backend.run).mockImplementation(() => childTurn.promise);
      } else {
        vi.mocked(backend.followUp).mockImplementation(() => childTurn.promise);
      }
      const provider = new CodexSubagentProvider({ backend, workspaceRoot });
      const controller = new AbortController();

      const invocation = provider.invoke(scenario.operation, scenario.input, {
        ...context,
        signal: controller.signal,
      });
      await vi.waitFor(() => {
        const turn =
          scenario.operation === 'codex.subagents.run' ? backend.run : backend.followUp;
        expect(turn).toHaveBeenCalledOnce();
      });
      controller.abort('cancelled');

      await expect(invocation).rejects.toMatchObject({ code: 'ABORT_ERR' });
      expect(backend.cancel).toHaveBeenCalledWith('thread-1');
    }
  });

  it('does not start new work for an already-aborted signal', async () => {
    const backend = fakeBackend(workspaceRoot);
    const provider = new CodexSubagentProvider({ backend, workspaceRoot });
    const spawnController = new AbortController();
    spawnController.abort('cancelled before spawn');

    await expect(
      provider.invoke(
        'codex.subagents.spawn',
        { prompt: 'Must not start' },
        { ...context, signal: spawnController.signal },
      ),
    ).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(backend.spawn).not.toHaveBeenCalled();
    expect(backend.run).not.toHaveBeenCalled();

    const runController = new AbortController();
    runController.abort('cancel active work');
    await expect(
      provider.invoke(
        'codex.subagents.run',
        { threadId: 'thread-1', prompt: 'Must not start' },
        { ...context, signal: runController.signal },
      ),
    ).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(backend.run).not.toHaveBeenCalled();
    expect(backend.cancel).toHaveBeenCalledWith('thread-1');
  });

  it('preserves cancellation when the backend cancellation attempt fails', async () => {
    const backend = fakeBackend(workspaceRoot);
    const childTurn = deferred<never>();
    vi.mocked(backend.run).mockImplementation(() => childTurn.promise);
    vi.mocked(backend.cancel).mockRejectedValue(new Error('interrupt transport failed'));
    const provider = new CodexSubagentProvider({ backend, workspaceRoot });
    const controller = new AbortController();

    const invocation = provider.invoke(
      'codex.subagents.run',
      { threadId: 'thread-1', prompt: 'Run' },
      { ...context, signal: controller.signal },
    );
    await vi.waitFor(() => expect(backend.run).toHaveBeenCalledOnce());
    controller.abort('cancelled');

    await expect(invocation).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(backend.cancel).toHaveBeenCalledWith('thread-1');
  });

  it.skipIf(process.platform === 'win32' || process.platform === 'darwin')(
    'rejects a backend workspace that differs only by POSIX path case',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'codex-subagent-case-'));
      try {
        const requested = join(root, 'Repo');
        const returned = join(root, 'repo');
        await mkdir(requested);
        await mkdir(returned);
        const provider = new CodexSubagentProvider({
          backend: fakeBackend(returned),
          workspaceRoot: root,
        });

        await expect(
          provider.invoke(
            'codex.subagents.spawn',
            { workspacePath: requested },
            context,
          ),
        ).rejects.toThrow(/different workspace path|configured root|unsafe/i);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('rejects junction or symlink workspace escapes in requests and every returned snapshot path', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codex-subagent-symlink-'));
    try {
      const root = join(base, 'root');
      const outside = join(base, 'outside');
      const escape = join(root, 'escape');
      await mkdir(root);
      await mkdir(outside);
      await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');

      const requestProvider = new CodexSubagentProvider({
        backend: fakeBackend(root),
        workspaceRoot: root,
      });
      await expect(
        requestProvider.invoke(
          'codex.subagents.spawn',
          { workspacePath: escape },
          context,
        ),
      ).rejects.toThrow(/symbolic link|junction|unsafe/i);

      const returnedPathProvider = new CodexSubagentProvider({
        backend: fakeBackend(escape),
        workspaceRoot: root,
      });
      for (const [operation, input] of [
        ['codex.subagents.spawn', { workspacePath: root }],
        ['codex.subagents.run', { threadId: 'thread-1', prompt: 'run' }],
        ['codex.subagents.list', {}],
        ['codex.subagents.send', { threadId: 'thread-1', message: 'steer' }],
        ['codex.subagents.follow_up', { threadId: 'thread-1', message: 'continue' }],
        ['codex.subagents.wait', { threadId: 'thread-1' }],
        ['codex.subagents.cancel', { threadId: 'thread-1' }],
        ['codex.subagents.inspect', { threadId: 'thread-1' }],
      ] as const) {
        await expect(
          returnedPathProvider.invoke(operation, input, context),
        ).rejects.toThrow(/outside configured|unsafe|symbolic link|junction/i);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects a backend snapshot whose workspace path is missing or empty', async () => {
    const provider = new CodexSubagentProvider({
      backend: fakeBackend(''),
      workspaceRoot,
    });
    await expect(
      provider.invoke('codex.subagents.inspect', { threadId: 'thread-1' }, context),
    ).rejects.toThrow(/outside configured|unsafe|non-empty/i);
  });
});

function fakeBackend(
  workspacePath: string,
): SubagentBackend & Record<string, ReturnType<typeof vi.fn>> {
  const snapshot: SubagentSnapshot = { id: 'thread-1', status: 'idle', workspacePath };
  return {
    spawn: vi.fn(async () => snapshot),
    run: vi.fn(async () => ({ thread: snapshot, response: 'done', status: 'completed' as const })),
    list: vi.fn(async () => [snapshot]),
    steer: vi.fn(async () => snapshot),
    followUp: vi.fn(async () => ({
      thread: snapshot,
      response: 'followed',
      status: 'completed' as const,
    })),
    wait: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => snapshot),
    inspect: vi.fn(async () => snapshot),
  };
}

function snapshotFor(workspacePath: string): SubagentSnapshot {
  return { id: 'thread-1', status: 'idle', workspacePath };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
