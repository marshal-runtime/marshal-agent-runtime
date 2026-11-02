import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function resolveGitTrustedProjectId(workspacePath: string): Promise<string | undefined> {
  const remote = await gitOutput(workspacePath, ['config', '--get', 'remote.origin.url']);
  if (remote !== undefined) {
    const localSource = await localGitSourceIdentity(workspacePath, remote);
    if (localSource) return opaqueGitProjectId('local-source', localSource);
    const remoteIdentity = normalizeGitRemoteIdentity(remote);
    if (remoteIdentity) return opaqueGitProjectId('remote', remoteIdentity);
  }

  const commonDir = await gitOutput(workspacePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!commonDir || !isAbsolute(commonDir)) return undefined;
  return opaqueGitProjectId('local-source', await canonicalLocalPath(commonDir));
}

async function localGitSourceIdentity(
  workspacePath: string,
  remote: string,
): Promise<string | undefined> {
  const localPath = localRemotePath(workspacePath, remote);
  if (!localPath) return undefined;
  const commonDir = await gitOutput(localPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!commonDir || !isAbsolute(commonDir)) return undefined;
  try {
    return await canonicalLocalPath(commonDir);
  } catch (error) {
    if (isNodeError(error) && ['EACCES', 'ENOENT', 'ENOTDIR'].includes(error.code)) return undefined;
    throw error;
  }
}

function localRemotePath(workspacePath: string, remote: string): string | undefined {
  const value = remote.trim();
  if (!value || /[\0\r\n]/u.test(value)) return undefined;
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) return resolve(value);
  if (value.startsWith('file://')) {
    try {
      return resolve(fileURLToPath(value));
    } catch (error) {
      if (error instanceof TypeError) return undefined;
      throw error;
    }
  }
  if (value.startsWith('./') || value.startsWith('../')) return resolve(workspacePath, value);
  return undefined;
}

async function canonicalLocalPath(value: string): Promise<string> {
  const canonical = await realpath(resolve(value));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function gitOutput(
  workspacePath: string,
  arguments_: readonly string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', arguments_, {
      cwd: resolve(workspacePath),
      shell: false,
    });
    const output = stdout.trim();
    return output || undefined;
  } catch (error) {
    if (isGitCommandFailure(error)) return undefined;
    throw error;
  }
}

function normalizeGitRemoteIdentity(remote: string): string | undefined {
  const value = remote.trim();
  if (!value || /[\0\r\n]/u.test(value)) return undefined;
  if (URL.canParse(value)) {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${normalizeGitPathname(url.pathname)}`;
  }
  const scpLike = /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/u.exec(value);
  if (!scpLike) return undefined;
  return `ssh://${scpLike[1]!.toLowerCase()}/${normalizeGitPathname(scpLike[2]!)}`;
}

function isGitCommandFailure(error: unknown): error is { readonly code: unknown } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException & { readonly code: string } {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function normalizeGitPathname(value: string): string {
  return value.replace(/\/+$/u, '').replace(/\.git$/iu, '');
}

function opaqueGitProjectId(kind: 'remote' | 'local-source', identity: string): string {
  return `codex-git-${kind}-${createHash('sha256').update(identity).digest('hex')}`;
}
