import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorktreeProvisioner } from '../subagents/gitWorktreeProvisioner.js';

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Git worktree provisioning', () => {
  it('creates a codex-prefixed branch below a separately trusted sibling root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'agent-worktree-test-'));
    roots.push(base);
    const workspaceRoot = join(base, 'workspace');
    const repository = join(workspaceRoot, 'repo');
    const worktreeRoot = join(base, 'worktrees');
    await exec('git', ['init', repository]);
    await writeFile(join(repository, 'README.md'), 'test\n');
    await exec('git', ['-C', repository, 'add', 'README.md']);
    await exec('git', [
      '-C',
      repository,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'initial',
    ]);
    const provisioner = new GitWorktreeProvisioner({ workspaceRoot, worktreeRoot });
    const created = await provisioner.provision({ workspacePath: repository, name: 'UI reviewer' });

    expect(created.path.startsWith(resolve(worktreeRoot))).toBe(true);
    expect(created.branch).toMatch(/^codex\/runtime-agent\/ui-reviewer-/);
    expect(
      (await exec('git', ['-C', created.path, 'branch', '--show-current'])).stdout.trim(),
    ).toBe(created.branch);

    await provisioner.release(created, 'cancelled');

    await expect(access(created.path)).rejects.toThrow();
    expect(
      (await exec('git', ['-C', repository, 'worktree', 'list', '--porcelain'])).stdout,
    ).not.toContain(created.path);
    expect((await exec('git', ['-C', repository, 'branch', '--list', created.branch])).stdout.trim()).toBe('');
    await expect(provisioner.release(created, 'cancelled')).resolves.toBeUndefined();
  });
});
