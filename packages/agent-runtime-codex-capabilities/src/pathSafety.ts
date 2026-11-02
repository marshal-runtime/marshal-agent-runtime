import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function resolveContainedPath(
  root: string,
  candidate: string | undefined,
  field: string,
): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate ?? resolvedRoot);
  const child = relative(resolvedRoot, resolvedCandidate);
  if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) return resolvedCandidate;
  throw new Error(`${field} must stay within configured root ${resolvedRoot}`);
}

export function assertContainedPath(root: string, candidate: string, field: string): void {
  resolveContainedPath(root, candidate, field);
}

/**
 * Resolve an existing directory below a configured root without permitting a
 * symbolic-link or junction component to redirect the path outside that root.
 * The returned path is canonical and is therefore suitable for passing across
 * a harness boundary.
 */
export async function resolveContainedExistingDirectory(
  root: string,
  candidate: string,
  field: string,
): Promise<string> {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error(`${field} must be a non-empty directory path`);
  }
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolveContainedPath(resolvedRoot, candidate, field);
  const rootInfo = await lstat(resolvedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`${field} root must be a real directory`);
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const segments = relative(resolvedRoot, resolvedCandidate).split(sep).filter(Boolean);
  let current = canonicalRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${field} contains a symbolic link, junction, or non-directory component`);
    }
    const canonical = await realpath(current);
    resolveContainedPath(canonicalRoot, canonical, field);
    current = canonical;
  }
  return current;
}

export async function initializeSafeDirectory(configuredRoot: string, field: string): Promise<string> {
  const resolvedRoot = resolve(configuredRoot);
  await mkdir(resolvedRoot, { recursive: true });
  const info = await lstat(resolvedRoot);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${field} must be a real directory`);
  }
  return realpath(resolvedRoot);
}

export async function ensureContainedDirectory(
  root: string,
  directory: string,
  field: string,
): Promise<void> {
  resolveContainedPath(root, directory, field);
  await assertRealDirectory(root, root, field);
  const segments = relative(root, resolve(directory)).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await assertRealDirectory(root, current, field);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current);
      await assertRealDirectory(root, current, field);
    }
  }
}

export async function resolveContainedExistingPath(
  root: string,
  target: string,
  field: string,
  expected: 'file' | 'directory',
): Promise<string> {
  resolveContainedPath(root, target, field);
  const segments = relative(root, resolve(target)).split(sep).filter(Boolean);
  let current = root;
  await assertRealDirectory(root, current, field);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in ${field}`);
    const isTarget = index === segments.length - 1;
    if (!isTarget && !info.isDirectory()) throw new Error(`${field} contains a non-directory component`);
    if (isTarget && expected === 'file' && !info.isFile()) throw new Error(`${field} is not a regular file`);
    if (isTarget && expected === 'directory' && !info.isDirectory()) {
      throw new Error(`${field} is not a directory`);
    }
  }
  const canonical = await realpath(current);
  resolveContainedPath(root, canonical, field);
  return canonical;
}

export async function assertContainedFileTarget(
  root: string,
  target: string,
  field: string,
): Promise<void> {
  resolveContainedPath(root, target, field);
  try {
    await resolveContainedExistingPath(root, target, field, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function assertRealDirectory(root: string, directory: string, field: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${field} contains a symbolic link or non-directory component`);
  }
  const canonical = await realpath(directory);
  resolveContainedPath(root, canonical, field);
}

export function safeSegment(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${field} contains unsafe path characters`);
  }
  return value;
}
