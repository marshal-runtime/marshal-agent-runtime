import { randomBytes } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { HmacReactUiRecordAuthenticator } from '@marshal/agent-runtime-ui';

export interface FileBackedReactUiRecordAuthorityOptions {
  keyPath: string;
  authorityId?: string;
}

/**
 * Codex adapter key holder. The portable UI package only receives the HMAC
 * port; path choice and key lifecycle remain a harness responsibility.
 */
export function createFileBackedReactUiRecordAuthenticator(
  options: FileBackedReactUiRecordAuthorityOptions,
): HmacReactUiRecordAuthenticator {
  const keyPath = resolve(options.keyPath);
  let keyPromise: Promise<Uint8Array> | undefined;
  return new HmacReactUiRecordAuthenticator({
    authorityId: options.authorityId ?? 'codex-local-ui-v1',
    key: () => keyPromise ??= loadOrCreateKey(keyPath),
  });
}

async function loadOrCreateKey(keyPath: string): Promise<Uint8Array> {
  const directory = dirname(keyPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realpath(directory);
  try {
    const created = await open(keyPath, 'wx', 0o600);
    try {
      await created.writeFile(randomBytes(32));
      await created.sync();
    } finally {
      await created.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const canonicalKeyPath = await realpath(keyPath);
  if (!isContained(canonicalDirectory, canonicalKeyPath)) {
    throw new Error('React UI authority key resolves outside its harness-owned directory');
  }
  const handle = await open(canonicalKeyPath, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('React UI authority key is not a regular file');
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new Error('React UI authority key permissions must deny group and other access');
    }
    const key = await handle.readFile();
    if (key.byteLength !== 32) throw new Error('React UI authority key must contain exactly 32 bytes');
    return key;
  } finally {
    await handle.close();
  }
}

function isContained(root: string, target: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const normalizedTarget = process.platform === 'win32' ? resolve(target).toLowerCase() : resolve(target);
  const value = relative(normalizedRoot, normalizedTarget);
  return value === '' || (!value.startsWith('..') && !value.startsWith('/') && !value.startsWith('\\'));
}
