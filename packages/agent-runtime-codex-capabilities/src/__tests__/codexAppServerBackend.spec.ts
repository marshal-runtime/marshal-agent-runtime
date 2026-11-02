import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../subagents/codexAppServerBackend.js';

const workspaceRoot = resolve('.');

describe('Codex app-server backend', () => {
  it('returns streamed agent output when an ephemeral turn has no persisted items', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const internals = backend as unknown as {
      listeners: Set<(message: {
        method: string;
        params: Record<string, unknown>;
      }) => void>;
    };
    Object.defineProperty(backend, 'start', { value: vi.fn(async () => undefined) });
    Object.defineProperty(backend, 'request', {
      value: vi.fn(async (method: string) => {
        if (method === 'turn/start') {
          setTimeout(() => {
            for (const listener of internals.listeners) {
              listener({
                method: 'item/completed',
                params: {
                  threadId: 'ephemeral-1',
                  turnId: 'turn-1',
                  item: { id: 'item-1', type: 'agentMessage', text: 'SUBAGENT_RUNTIME_OK' },
                },
              });
              listener({
                method: 'turn/completed',
                params: {
                  threadId: 'ephemeral-1',
                  turn: { id: 'turn-1', status: 'completed', items: [] },
                },
              });
            }
          }, 0);
          return { turn: { id: 'turn-1' } };
        }
        return { thread: { id: 'ephemeral-1', status: 'idle', cwd: workspaceRoot } };
      }),
    });
    await backend.spawn({ workspacePath: workspaceRoot, ephemeral: true });

    const result = await backend.run('ephemeral-1', 'Return the token');

    expect(result.response).toBe('SUBAGENT_RUNTIME_OK');
    expect(result.items).toEqual([
      expect.objectContaining({ type: 'agentMessage', text: 'SUBAGENT_RUNTIME_OK' }),
    ]);
  });

  it('omits includeTurns when inspecting an ephemeral thread', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        thread: { id: 'ephemeral-1', status: 'idle', cwd: workspaceRoot },
      })
      .mockResolvedValueOnce({
        thread: { id: 'ephemeral-1', status: 'idle', cwd: workspaceRoot },
      });
    Object.defineProperty(backend, 'request', { value: request });

    await backend.spawn({ workspacePath: workspaceRoot, ephemeral: true });
    await backend.inspect('ephemeral-1');

    expect(request).toHaveBeenNthCalledWith(2, 'thread/read', { threadId: 'ephemeral-1' });
  });

  it('requests full turns for durable threads', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ thread: { id: 'durable-1', status: 'idle', cwd: workspaceRoot } })
      .mockResolvedValueOnce({ thread: { id: 'durable-1', status: 'idle', cwd: workspaceRoot } });
    Object.defineProperty(backend, 'request', { value: request });

    await backend.spawn({ workspacePath: workspaceRoot });
    await backend.inspect('durable-1');

    expect(request).toHaveBeenNthCalledWith(2, 'thread/read', {
      threadId: 'durable-1',
      includeTurns: true,
    });
  });

  it('retains more than 100 transcript turns, items, and full response text', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const responseText = 'x'.repeat(100_001);
    const turns = Array.from({ length: 150 }, (_, index) => ({
      id: `turn-${index}`,
      status: 'completed',
      items: index === 149
        ? Array.from({ length: 225 }, (_item, itemIndex) => ({
            id: `item-${itemIndex}`,
            type: itemIndex === 224 ? 'agentMessage' : 'commandExecution',
            text: itemIndex === 224 ? responseText : undefined,
          }))
        : [],
    }));
    Object.defineProperty(backend, 'request', {
      value: vi.fn(async () => ({
        thread: { id: 'durable-history', status: 'idle', cwd: workspaceRoot, turns },
      })),
    });

    const inspected = await backend.inspect('durable-history');

    expect(inspected.transcript).toHaveLength(150);
    expect(inspected.transcript?.at(-1)?.items).toHaveLength(225);
    expect(inspected.lastResponse).toBe(responseText);
  });

  it('passes an explicitly requested list size above 100 to the host', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const request = vi.fn(async () => ({ data: [] }));
    Object.defineProperty(backend, 'request', { value: request });

    await expect(backend.list({ limit: 150 })).resolves.toEqual([]);

    expect(request).toHaveBeenCalledWith('thread/list', {
      limit: 150,
      cwd: workspaceRoot,
      parentThreadId: undefined,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
  });

  it('rejects active notification observers when disposed', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const internals = backend as unknown as {
      startPromise: Promise<void> | undefined;
      waitForNotification(
        method: string,
        predicate: (params: Record<string, unknown>) => boolean,
      ): Promise<Record<string, unknown>>;
    };
    internals.startPromise = Promise.resolve();
    const observation = internals.waitForNotification('turn/completed', () => true);

    await backend.dispose();

    await expect(observation).rejects.toThrow('Codex app-server backend disposed');
  });

  it('interrupts the active turn and returns the refreshed contained thread', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        thread: {
          id: 'thread-1',
          status: 'active',
          cwd: workspaceRoot,
          turns: [{ id: 'turn-1', status: 'inProgress', items: [] }],
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        thread: { id: 'thread-1', status: 'idle', cwd: workspaceRoot, turns: [] },
      });
    Object.defineProperty(backend, 'request', { value: request });

    await expect(backend.cancel('thread-1')).resolves.toMatchObject({
      id: 'thread-1',
      status: 'idle',
      activeTurnId: undefined,
    });
    expect(request).toHaveBeenNthCalledWith(1, 'thread/read', {
      threadId: 'thread-1',
      includeTurns: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, 'turn/interrupt', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(request).toHaveBeenNthCalledWith(3, 'thread/read', {
      threadId: 'thread-1',
      includeTurns: true,
    });
  });

  it('carries cancellation through a turn that is still starting and waits for settlement', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const internals = backend as unknown as {
      listeners: Set<(message: {
        method: string;
        params: Record<string, unknown>;
      }) => void>;
    };
    const turnStart = deferred<{ turn: { id: string } }>();
    let interrupted = false;
    Object.defineProperty(backend, 'start', { value: vi.fn(async () => undefined) });
    const request = vi.fn(async (method: string) => {
      if (method === 'turn/start') return turnStart.promise;
      if (method === 'turn/interrupt') {
        interrupted = true;
        queueMicrotask(() => {
          for (const listener of internals.listeners) {
            listener({
              method: 'turn/completed',
              params: {
                threadId: 'thread-starting',
                turn: { id: 'turn-starting', status: 'interrupted', items: [] },
              },
            });
          }
        });
        return {};
      }
      return {
        thread: interrupted
          ? {
              id: 'thread-starting',
              status: 'idle',
              cwd: workspaceRoot,
              turns: [{ id: 'turn-starting', status: 'interrupted', items: [] }],
            }
          : {
              id: 'thread-starting',
              status: 'idle',
              cwd: workspaceRoot,
              turns: [],
            },
      };
    });
    Object.defineProperty(backend, 'request', { value: request });

    const running = backend.run('thread-starting', 'Keep working until cancelled.');
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(true),
    );
    const cancelling = backend.cancel('thread-starting');
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === 'thread/read')).toBe(true),
    );
    turnStart.resolve({ turn: { id: 'turn-starting' } });

    await expect(running).resolves.toMatchObject({ status: 'interrupted' });
    await expect(cancelling).resolves.toMatchObject({
      id: 'thread-starting',
      status: 'idle',
      activeTurnId: undefined,
    });
    expect(request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-starting',
      turnId: 'turn-starting',
    });
  });

  it('retries only an empty-rollout metadata read while a native turn is pending', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const internals = backend as unknown as {
      pendingRunThreadIds: Set<string>;
      activeTurnIds: Map<string, string>;
    };
    internals.pendingRunThreadIds.add('thread-empty-rollout');
    internals.activeTurnIds.set('thread-empty-rollout', 'turn-empty-rollout');
    let reads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/read') {
        reads += 1;
        if (reads === 1) {
          throw new Error(
            `failed to read thread: thread-store internal error: failed to read session metadata ${workspaceRoot}\\rollout.jsonl: rollout at ${workspaceRoot}\\rollout.jsonl is empty`,
          );
        }
        return {
          thread: {
            id: 'thread-empty-rollout',
            status: 'idle',
            cwd: workspaceRoot,
            turns: [{ id: 'turn-empty-rollout', status: 'interrupted', items: [] }],
          },
        };
      }
      if (method === 'turn/interrupt') {
        internals.pendingRunThreadIds.delete('thread-empty-rollout');
        internals.activeTurnIds.delete('thread-empty-rollout');
        return {};
      }
      throw new Error(`Unexpected method ${method}`);
    });
    Object.defineProperty(backend, 'request', { value: request });

    await expect(backend.cancel('thread-empty-rollout')).resolves.toMatchObject({
      id: 'thread-empty-rollout',
      status: 'idle',
    });
    expect(reads).toBe(3);
    expect(request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-empty-rollout',
      turnId: 'turn-empty-rollout',
    });
  });

  it('does not retry unrelated thread-read failures during pending startup', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const internals = backend as unknown as { pendingRunThreadIds: Set<string> };
    internals.pendingRunThreadIds.add('thread-real-failure');
    const request = vi.fn(async () => {
      throw new Error('failed to read thread: permission denied');
    });
    Object.defineProperty(backend, 'request', { value: request });

    await expect(backend.cancel('thread-real-failure')).rejects.toThrow('permission denied');
    expect(request).toHaveBeenCalledOnce();
  });

  it('treats cancellation of an idle contained thread as a no-op', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    const request = vi.fn().mockResolvedValue({
      thread: { id: 'thread-1', status: 'idle', cwd: workspaceRoot, turns: [] },
    });
    Object.defineProperty(backend, 'request', { value: request });

    await expect(backend.cancel('thread-1')).resolves.toMatchObject({
      id: 'thread-1',
      status: 'idle',
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-1',
      includeTurns: true,
    });
  });

  it('rejects junction or symlink redirects in requested and returned workspace paths', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codex-backend-symlink-'));
    try {
      const root = join(base, 'root');
      const outside = join(base, 'outside');
      const escape = join(root, 'escape');
      await mkdir(root);
      await mkdir(outside);
      await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
      const backend = new CodexAppServerBackend({ workspaceRoot: root });
      const request = vi.fn(async (method: string) =>
        method === 'thread/list'
          ? { data: [{ id: 'escaped-list', status: 'idle', cwd: escape }] }
          : { thread: { id: 'escaped-thread', status: 'idle', cwd: escape, turns: [] } },
      );
      Object.defineProperty(backend, 'request', { value: request });

      await expect(backend.spawn({ workspacePath: escape })).rejects.toThrow(
        /outside configured|symbolic link|junction|unsafe/i,
      );
      await expect(backend.spawn({ workspacePath: root })).rejects.toThrow(
        /outside configured|symbolic link|junction|unsafe/i,
      );
      await expect(backend.list({ limit: 20 })).resolves.toEqual([]);
      await expect(backend.inspect('escaped-thread')).rejects.toThrow(
        /outside configured|symbolic link|junction|unsafe/i,
      );
      await expect(backend.cancel('escaped-thread')).rejects.toThrow(
        /outside configured|symbolic link|junction|unsafe/i,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects a backend thread without an explicit cwd instead of defaulting to process cwd', async () => {
    const backend = new CodexAppServerBackend({ workspaceRoot });
    Object.defineProperty(backend, 'request', {
      value: vi.fn(async () => ({ thread: { id: 'missing-cwd', status: 'idle' } })),
    });

    await expect(backend.spawn({ workspacePath: workspaceRoot })).rejects.toThrow(
      /cwd must be a non-empty path/i,
    );
    await expect(backend.inspect('missing-cwd')).rejects.toThrow(
      /cwd must be a non-empty path/i,
    );
    await expect(backend.cancel('missing-cwd')).rejects.toThrow(
      /cwd must be a non-empty path/i,
    );
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
