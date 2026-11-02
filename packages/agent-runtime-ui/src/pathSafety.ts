import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sameStableFileIdentity, sameStableFileSnapshot } from '@marshal/agent-runtime-core';

const SUPPORTED_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js']);

export async function resolveWorkspaceSource(
  workspaceRoot: string,
  requestedPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  if (!requestedPath.trim()) throw new Error('entryPath must be a non-empty workspace path');
  if (isAbsolute(requestedPath)) throw new Error('entryPath must be relative to the workspace');
  const root = await realpath(resolve(workspaceRoot));
  const candidate = resolve(root, requestedPath);
  assertContained(root, candidate, 'entryPath');
  const info = await lstat(candidate);
  if (!info.isFile()) throw new Error('entryPath must resolve to a regular file');
  if (info.isSymbolicLink()) throw new Error('entryPath may not be a symbolic link');
  const canonical = await realpath(candidate);
  assertContained(root, canonical, 'entryPath');
  const extension = canonical.slice(canonical.lastIndexOf('.')).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error('entryPath must end in .tsx, .ts, .jsx, or .js');
  }
  return { absolutePath: canonical, relativePath: normalizePath(relative(root, canonical)) };
}

export async function assertBuildInputsContained(
  workspaceRoot: string,
  inputs: readonly string[],
  _trustedDependencyRoots: readonly string[] = [],
): Promise<string[]> {
  const root = await realpath(resolve(workspaceRoot));
  const contained: string[] = [];
  for (const input of inputs) {
    const absolute = resolve(root, input);
    const canonical = await realpath(absolute);
    assertContained(root, canonical, 'component dependency');
    if (isNodeModulesPath(root, canonical)) {
      throw new Error('component dependency in node_modules requires compiler package identity authorization');
    }
    contained.push(normalizePath(relative(root, canonical)));
  }
  return contained.sort();
}

export function assertContained(root: string, target: string, field: string): void {
  if (isContained(root, target)) return;
  throw new Error(`${field} resolves outside the workspace`);
}

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

export function safeSegment(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${field} contains unsafe path characters`);
  }
  return value;
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
  assertContained(root, directory, field);
  await assertRealDirectory(root, root, field);
  const segments = relative(root, resolve(directory)).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await assertRealDirectory(root, current, field);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current).catch((mkdirError: NodeJS.ErrnoException) => {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      });
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
  assertContained(root, target, field);
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
  assertContained(root, canonical, field);
  return canonical;
}

export async function assertContainedFileTarget(
  root: string,
  target: string,
  field: string,
): Promise<void> {
  assertContained(root, target, field);
  try {
    await resolveContainedExistingPath(root, target, field, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Read one bounded internal record through a stable descriptor. The pathname is
 * re-attested to the opened file before and after the read; a lock that vanishes
 * after it was observed is retried briefly instead of surfacing Windows EBADF.
 */
export async function readContainedFileStable(
  root: string,
  target: string,
  field: string,
  maxBytes = 64 * 1024,
): Promise<string | undefined> {
  let observed = false;
  for (let attempt = 0; attempt <= 10; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const canonical = await resolveContainedExistingPath(root, target, field, 'file');
      observed = true;
      const before = await lstat(canonical);
      handle = await open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      const afterOpen = await lstat(canonical);
      if (
        before.isSymbolicLink() || !before.isFile() || !opened.isFile() ||
        !sameStableFileIdentity(before, opened) || !sameStableFileIdentity(opened, afterOpen)
      ) {
        throw Object.assign(new Error(`${field} changed identity while it was opened`), {
          code: 'UI_STABLE_FILE_IDENTITY_CHANGED',
        });
      }
      if (opened.size > maxBytes) throw new Error(`${field} exceeds its size limit`);
      const content = await handle.readFile({ encoding: 'utf8' });
      const afterDescriptorRead = await handle.stat();
      const afterRead = await lstat(canonical);
      const canonicalAfter = await resolveContainedExistingPath(root, target, field, 'file');
      if (
        !sameStableFileSnapshot(opened, afterDescriptorRead) ||
        !sameStableFileIdentity(afterDescriptorRead, afterRead) ||
        !sameCanonicalPath(canonical, canonicalAfter)
      ) {
        throw Object.assign(new Error(`${field} changed while it was read`), {
          code: 'UI_STABLE_FILE_IDENTITY_CHANGED',
        });
      }
      if (Buffer.byteLength(content, 'utf8') > maxBytes) {
        throw new Error(`${field} exceeds its size limit`);
      }
      return content;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT' && !observed) return undefined;
      if (
        attempt < 10 &&
        (
          code === 'ENOENT' ||
          code === 'UI_STABLE_FILE_IDENTITY_CHANGED' ||
          ['EBADF', 'EPERM', 'EACCES', 'EBUSY', 'ESTALE'].includes(code)
        )
      ) {
        await transientFileDelay();
        continue;
      }
      if (code === 'ENOENT') return undefined;
      throw error;
    } finally {
      await handle?.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EBADF') throw error;
      });
    }
  }
  return undefined;
}

async function assertRealDirectory(root: string, directory: string, field: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${field} contains a symbolic link or non-directory component`);
  }
  const canonical = await realpath(directory);
  assertContained(root, canonical, field);
}

function isContained(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(
    process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot,
    process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget,
  );
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function transientFileDelay(): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
}

function isNodeModulesPath(root: string, target: string): boolean {
  const rel = normalizePath(relative(root, target));
  return rel === 'node_modules' || rel.startsWith('node_modules/');
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}
