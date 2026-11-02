import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveProtectedLifecycleResultRoot,
  resolveRuntimeState,
  resolveWorktreeRoot,
} from '../src/index.js';

const cleanup: string[] = [];

afterEach(async () => {
  for (const target of cleanup.splice(0)) {
    await fs.rm(target, { recursive: true, force: true });
  }
});

describe('runtime state containment', () => {
  it('creates stable state inside the workspace and worktrees outside it', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-state-'));
    cleanup.push(parent);
    const workspace = path.join(parent, 'workspace');
    await fs.mkdir(workspace);
    const first = await resolveRuntimeState(workspace);
    const second = await resolveRuntimeState(workspace);
    expect(first).toEqual(second);
    expect(first.stateRoot).toBe(path.join(await fs.realpath(workspace), '.marshal', 'runtime'));
    expect(first.projectId).toMatch(/^project-/);

    const worktrees = await resolveWorktreeRoot(first.workspacePath, first.workspaceId);
    expect(path.relative(first.workspacePath, worktrees)).toMatch(/^\.\./);
  });

  it('rejects state traversal and in-workspace worktree roots', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-state-'));
    cleanup.push(parent);
    const workspace = path.join(parent, 'workspace');
    await fs.mkdir(workspace);
    await expect(resolveRuntimeState(workspace, '../escape')).rejects.toThrow(/unsafe|inside/i);
    const state = await resolveRuntimeState(workspace);
    await expect(
      resolveWorktreeRoot(state.workspacePath, state.workspaceId, path.join(workspace, 'trees')),
    ).rejects.toThrow(/outside/i);
  });

  it('requires a real protected lifecycle root outside the workspace', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-state-private-'));
    cleanup.push(parent);
    const workspace = path.join(parent, 'workspace');
    await fs.mkdir(workspace);
    const canonicalWorkspace = await fs.realpath(workspace);

    await expect(resolveProtectedLifecycleResultRoot(canonicalWorkspace, undefined)).rejects.toThrow(
      /required/i,
    );
    await expect(
      resolveProtectedLifecycleResultRoot(canonicalWorkspace, path.join(workspace, 'private')),
    ).rejects.toThrow(/outside/i);

    const external = await resolveProtectedLifecycleResultRoot(
      canonicalWorkspace,
      path.join(parent, 'private'),
    );
    expect(path.relative(canonicalWorkspace, external)).toMatch(/^\.\./);

    const linked = path.join(parent, 'linked-private');
    await fs.symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveProtectedLifecycleResultRoot(canonicalWorkspace, linked)).rejects.toThrow(
      /real directory|symbolic link|junction/i,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'keeps case-distinct POSIX workspace scopes distinct',
    async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-state-case-'));
      cleanup.push(parent);
      const upper = path.join(parent, 'Repo');
      const lower = path.join(parent, 'repo');
      await fs.mkdir(upper);
      await fs.mkdir(lower);

      const upperState = await resolveRuntimeState(upper);
      const lowerState = await resolveRuntimeState(lower);
      expect(upperState.workspacePath).not.toBe(lowerState.workspacePath);
      expect(upperState.workspaceId).not.toBe(lowerState.workspaceId);
      expect(upperState.projectId).not.toBe(lowerState.projectId);
    },
  );
});
