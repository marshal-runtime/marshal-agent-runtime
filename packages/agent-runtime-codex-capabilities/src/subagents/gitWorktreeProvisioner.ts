import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertContainedPath, resolveContainedPath, safeSegment } from '../pathSafety.js';
import type { WorktreeProvisioner } from './types.js';

const execFileAsync = promisify(execFile);

export interface GitWorktreeProvisionerOptions {
  workspaceRoot: string;
  worktreeRoot: string;
  gitExecutable?: string;
  branchPrefix?: string;
}

export type WorktreeCreationErrorCategory = 'capacity' | 'transient';

export interface WorktreeCreationErrorOptions {
  readonly category: WorktreeCreationErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class WorktreeCreationError extends Error {
  readonly kind = 'environmental';
  readonly operation = 'worktree.create';
  readonly category: WorktreeCreationErrorCategory;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: WorktreeCreationErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorktreeCreationError';
    this.category = options.category;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export class GitWorktreeProvisioner implements WorktreeProvisioner {
  private readonly workspaceRoot: string;
  private readonly worktreeRoot: string;
  private readonly branchPrefix: string;
  private readonly repositoriesByPath = new Map<string, string>();

  constructor(private readonly options: GitWorktreeProvisionerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    // The allowed worktree root is an explicit trust boundary and may be a
    // sibling of the source repository. Targets are contained under its real path.
    this.worktreeRoot = resolve(options.worktreeRoot);
    this.branchPrefix = options.branchPrefix ?? 'codex/runtime-agent/';
    if (!this.branchPrefix.startsWith('codex/') || !/^[A-Za-z0-9/_-]+\/$/.test(this.branchPrefix)) {
      throw new Error('branchPrefix must be a safe codex/ prefix ending in /');
    }
  }

  async provision(request: {
    workspacePath: string;
    name?: string;
    branchName?: string;
    baseRef?: string;
  }): Promise<{ path: string; branch: string; baseCommit?: string }> {
    const realWorkspaceRoot = await realpath(this.workspaceRoot);
    const workspace = await realpath(
      resolveContainedPath(this.workspaceRoot, request.workspacePath, 'workspacePath'),
    );
    assertContainedPath(realWorkspaceRoot, workspace, 'workspacePath');
    const repository = (
      await execFileAsync(this.options.gitExecutable ?? 'git', [
        '-C',
        workspace,
        'rev-parse',
        '--show-toplevel',
      ])
    ).stdout.trim();
    assertContainedPath(this.workspaceRoot, await realpath(repository), 'git repository');
    const baseCommit = (
      await execFileAsync(this.options.gitExecutable ?? 'git', [
        '-C',
        repository,
        'rev-parse',
        '--verify',
        `${request.baseRef ?? 'HEAD'}^{commit}`,
      ])
    ).stdout.trim();
    await runCreationStep(() => mkdir(this.worktreeRoot, { recursive: true }));
    const realWorktreeRoot = await runCreationStep(() => realpath(this.worktreeRoot));
    const slug = safeSegment(
      slugify(request.name ?? basename(workspace)) || 'agent',
      'worktree name',
    );
    const suffix = randomBytes(5).toString('hex');
    const directory = `${slug}-${suffix}`;
    const path = resolveContainedPath(
      realWorktreeRoot,
      resolve(realWorktreeRoot, directory),
      'worktree path',
    );
    const branch = request.branchName ?? `${this.branchPrefix}${directory}`;
    if (
      !branch.startsWith(this.branchPrefix) ||
      !/^[A-Za-z0-9][A-Za-z0-9/._-]{1,180}$/.test(branch)
    ) {
      throw new Error(`branchName must use the configured ${this.branchPrefix} prefix`);
    }
    await runCreationStep(() =>
      execFileAsync(this.options.gitExecutable ?? 'git', [
        '-C',
        repository,
        'worktree',
        'add',
        '-b',
        branch,
        path,
        baseCommit,
      ]),
    );
    const realCreatedPath = await runCreationStep(() => realpath(path));
    assertContainedPath(realWorktreeRoot, realCreatedPath, 'created worktree path');
    this.repositoriesByPath.set(path, repository);
    return { path, branch, baseCommit };
  }

  async release(
    worktree: { path: string; branch: string },
    _reason: 'spawn_failed' | 'run_failed' | 'cancelled',
  ): Promise<void> {
    const realWorktreeRoot = await realpath(this.worktreeRoot);
    const path = resolveContainedPath(realWorktreeRoot, worktree.path, 'worktree path');
    const repository = this.repositoriesByPath.get(path);
    if (!repository) return;
    if (
      !worktree.branch.startsWith(this.branchPrefix) ||
      !/^[A-Za-z0-9][A-Za-z0-9/._-]{1,180}$/.test(worktree.branch)
    ) {
      throw new Error(`branch must use the configured ${this.branchPrefix} prefix`);
    }
    if (await pathExists(path)) {
      await execFileAsync(this.options.gitExecutable ?? 'git', [
        '-C',
        repository,
        'worktree',
        'remove',
        '--force',
        path,
      ]);
    }
    await execFileAsync(this.options.gitExecutable ?? 'git', [
      '-C',
      repository,
      'branch',
      '-D',
      worktree.branch,
    ]);
    this.repositoriesByPath.delete(path);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function slugify(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function runCreationStep<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw classifyRetryableCreationError(error) ?? error;
  }
}

function classifyRetryableCreationError(error: unknown): WorktreeCreationError | undefined {
  if (error instanceof WorktreeCreationError) return error.retryable ? error : undefined;
  const nativeCode = errorCode(error);
  const classified = (nativeCode === undefined ? undefined : classifyCode(nativeCode))
    ?? classifyGitError(errorText(error));
  if (!classified) return undefined;
  return new WorktreeCreationError(errorMessage(error), {
    ...classified,
    retryable: true,
    cause: error,
  });
}

function classifyCode(
  code: string,
): Pick<WorktreeCreationErrorOptions, 'category' | 'code'> | undefined {
  const normalized = code.toUpperCase();
  if (['ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'ENOMEM'].includes(normalized)) {
    return { category: 'capacity', code: normalized };
  }
  if (['EAGAIN', 'EBUSY', 'ETXTBSY'].includes(normalized)) {
    return { category: 'transient', code: normalized };
  }
  return undefined;
}

function classifyGitError(
  text: string,
): Pick<WorktreeCreationErrorOptions, 'category' | 'code'> | undefined {
  if (/\bENOSPC\b|no space left on device/i.test(text)) {
    return { category: 'capacity', code: 'ENOSPC' };
  }
  if (/\bEDQUOT\b|disk quota exceeded/i.test(text)) {
    return { category: 'capacity', code: 'EDQUOT' };
  }
  if (/resource temporarily unavailable/i.test(text)) {
    return { category: 'transient', code: 'EAGAIN' };
  }
  if (/device or resource busy/i.test(text)) {
    return { category: 'transient', code: 'EBUSY' };
  }
  if (/index\.lock.*file exists|another git process seems to be running/i.test(text)) {
    return { category: 'transient', code: 'ELOCKED' };
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const record = error as {
    readonly message?: unknown;
    readonly stderr?: unknown;
    readonly stdout?: unknown;
  };
  return [record.message, record.stderr, record.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const text = errorText(error).trim();
  return text || String(error);
}
