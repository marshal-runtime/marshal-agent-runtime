import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface RuntimeStateLocation {
  readonly workspacePath: string;
  readonly stateRoot: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

export async function resolveRuntimeState(
  workspaceInput: string | undefined,
  stateDirectory = '.marshal/runtime',
  trustedProjectId?: string,
): Promise<RuntimeStateLocation> {
  const workspaceCandidate = path.resolve(workspaceInput ?? process.cwd());
  const workspaceStat = await fs.lstat(workspaceCandidate);
  if (!workspaceStat.isDirectory()) throw new Error('workspacePath must be a directory.');
  const workspacePath = await fs.realpath(workspaceCandidate);
  validateRelativeStateDirectory(stateDirectory);
  const stateCandidate = path.resolve(workspacePath, stateDirectory);
  if (!isContained(workspacePath, stateCandidate)) {
    throw new Error('Runtime state directory must remain inside workspacePath.');
  }
  await ensureContainedDirectory(workspacePath, stateCandidate);
  const stateRoot = await fs.realpath(stateCandidate);
  if (!isContained(workspacePath, stateRoot)) {
    throw new Error('Runtime state directory escaped workspacePath.');
  }
  return {
    workspacePath,
    stateRoot,
    workspaceId: stableScopeId('workspace', workspacePath),
    projectId: stableScopeId('project', trustedProjectId?.trim() || workspacePath),
  };
}

function stableScopeId(kind: string, value: string): string {
  const normalized = process.platform === 'win32' ? value.toLowerCase() : value;
  return `${kind}-${createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 24)}`;
}

export function scopeFileName(kind: string, id: string): string {
  const digest = createHash('sha256').update(`${kind}\0${id}`).digest('hex');
  return `${kind}-${digest}.jsonl`;
}

export async function resolveWorktreeRoot(
  workspacePath: string,
  workspaceId: string,
  configured?: string,
): Promise<string> {
  const candidate = configured
    ? path.resolve(configured)
    : path.join(path.dirname(workspacePath), '.marshal-worktrees', workspaceId);
  if (configured && !path.isAbsolute(configured)) {
    throw new Error('worktreeRoot must be absolute when supplied.');
  }
  if (isContained(workspacePath, candidate)) {
    throw new Error('worktreeRoot must be outside workspacePath.');
  }
  await fs.mkdir(candidate, { recursive: true });
  const resolved = await fs.realpath(candidate);
  if (isContained(workspacePath, resolved)) {
    throw new Error('worktreeRoot resolved inside workspacePath.');
  }
  return resolved;
}

/** Resolve a harness-private lifecycle root and fail closed on workspace containment or links. */
export async function resolveProtectedLifecycleResultRoot(
  workspacePath: string,
  configured: string | undefined,
): Promise<string> {
  if (!configured?.trim()) {
    throw new Error(
      'protectedLifecycleResultRoot is required and must be an absolute harness-private directory outside workspacePath.',
    );
  }
  if (!path.isAbsolute(configured)) {
    throw new Error('protectedLifecycleResultRoot must be absolute when supplied.');
  }
  const candidate = path.resolve(configured);
  if (isContained(workspacePath, candidate)) {
    throw new Error('protectedLifecycleResultRoot must be outside workspacePath.');
  }
  await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('protectedLifecycleResultRoot must be a real directory.');
  }
  const canonical = await fs.realpath(candidate);
  if (!samePath(candidate, canonical)) {
    throw new Error('protectedLifecycleResultRoot cannot traverse a symbolic link or junction.');
  }
  if (isContained(workspacePath, canonical)) {
    throw new Error('protectedLifecycleResultRoot resolved inside workspacePath.');
  }
  return canonical;
}

/** Resolve any external harness-private directory with the same fail-closed link checks. */
export async function resolveExternalPrivateDirectory(
  workspacePath: string,
  configured: string | undefined,
  label: string,
): Promise<string> {
  if (!configured?.trim() || !path.isAbsolute(configured)) {
    throw new Error(`${label} is required and must be an absolute harness-private directory outside workspacePath.`);
  }
  const candidate = path.resolve(configured);
  if (isContained(workspacePath, candidate)) throw new Error(`${label} must be outside workspacePath.`);
  await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory.`);
  const canonical = await fs.realpath(candidate);
  if (!samePath(candidate, canonical) || isContained(workspacePath, canonical)) {
    throw new Error(`${label} cannot traverse a symbolic link or junction or resolve inside workspacePath.`);
  }
  return canonical;
}

export function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function validateRelativeStateDirectory(value: string): void {
  if (!value.trim() || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error('stateDirectory must be a non-empty relative path.');
  }
  const segments = value.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('stateDirectory contains an unsafe path segment.');
  }
}

async function ensureContainedDirectory(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Runtime state component is not a real directory: ${segment}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(current);
    }
    const real = await fs.realpath(current);
    if (!isContained(root, real)) throw new Error('Runtime state escaped through a symbolic link.');
  }
}
