import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_NEEDLES = 1024;
const MAX_NEEDLE_LENGTH = 64 * 1024;
const SCAN_PAGE_ENTRIES = 10_000;
const MAX_SCAN_PAGES = 1_000;
const RESULT_BODY = /^[0-9a-f]{64}\.result\.json$/;
const TEMPORARY_RESULT = /^\..+\.result\.json\.[0-9a-f-]+\.tmp$/i;

export interface LifecycleResultPurgeFilter {
  /**
   * Remove every stored result body whose result contains one of these strings in any string
   * value (object keys included). Matching runs on the parsed values, so text that JSON escapes
   * (quotes, newlines) matches as written.
   */
  readonly containing?: readonly string[];
  /** Remove every stored result body last written at least this long ago. */
  readonly olderThanMs?: number;
  /** Remove every stored result body. */
  readonly all?: boolean;
}

export interface LifecycleResultPurgeReceipt {
  readonly scanned: number;
  readonly removed: number;
  /** Unreadable or oversized bodies, removed because they cannot be checked. */
  readonly removedUnreadable: number;
  /** Interrupted-write leftovers older than `temporaryOlderThanMs`. */
  readonly removedTemporary: number;
  /** True only when the directory outgrew the scan bound while it was being purged. */
  readonly truncated: boolean;
}

export interface LifecycleResultPurgeOptions {
  readonly now?: number;
  /**
   * Temporary files younger than this may belong to a write in progress (a body is written to a
   * temporary file, then renamed), so they are left alone. Defaults to five minutes.
   */
  readonly temporaryOlderThanMs?: number;
  /**
   * Advance the directory's purge epoch before scanning (default). A coordinator whose callback
   * started under an older epoch then drops its body instead of writing it after the purge.
   * Retention sweeps pass false: expiring old bodies must not drop in-flight ones.
   */
  readonly advanceEpoch?: boolean;
}

const PURGE_EPOCH_FILE = 'purge-epoch.json';
const EPOCH_RENAME_ATTEMPTS = 20;
const EPOCH_RENAME_RETRY_MS = 10;
const EPOCH_RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** An opaque token that changes on every epoch-advancing purge of this result directory. */
export async function readLifecycleResultPurgeEpoch(resultDirectory: string): Promise<string> {
  try {
    return await fs.readFile(path.join(resultDirectory, PURGE_EPOCH_FILE), 'utf8');
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') return '';
    throw error;
  }
}

async function advancePurgeEpoch(root: string): Promise<void> {
  const target = path.join(root, PURGE_EPOCH_FILE);
  const temporary = path.join(root, `.${PURGE_EPOCH_FILE}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify({ epoch: randomUUID(), advancedAt: new Date().toISOString() }), {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await renameOverReader(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

/** Windows refuses a rename onto a file that a reader holds open, so retry briefly. */
async function renameOverReader(source: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.rename(source, target);
    } catch (error) {
      const code = readErrorCode(error);
      if (attempt >= EPOCH_RENAME_ATTEMPTS || code === undefined || !EPOCH_RENAME_RETRYABLE_CODES.has(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, EPOCH_RENAME_RETRY_MS));
    }
  }
}

export const LIFECYCLE_RESULT_TEMPORARY_GRACE_MS = 5 * 60 * 1000;

/**
 * Deletes lifecycle result bodies from a coordinator's result directory. Journal receipts keep
 * only a reference and a digest, so a later replay of a purged event returns the receipt with
 * `resultUnavailable: true` instead of the body; the callback is never reapplied. The directory
 * is scanned in sorted pages until every entry has been visited.
 */
export async function purgeLifecycleResults(
  resultDirectory: string,
  filter: LifecycleResultPurgeFilter,
  options: LifecycleResultPurgeOptions = {},
): Promise<LifecycleResultPurgeReceipt> {
  if (!path.isAbsolute(resultDirectory)) throw new TypeError('Lifecycle result root must be absolute.');
  const needles = validateNeedles(filter.containing);
  const olderThanMs = filter.olderThanMs;
  if (olderThanMs !== undefined && (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)) {
    throw new TypeError('olderThanMs must be a non-negative integer.');
  }
  if (!filter.all && needles.length === 0 && olderThanMs === undefined) {
    throw new TypeError('A lifecycle result purge needs containing, olderThanMs, or all.');
  }
  const temporaryOlderThanMs = options.temporaryOlderThanMs ?? LIFECYCLE_RESULT_TEMPORARY_GRACE_MS;
  if (!Number.isSafeInteger(temporaryOlderThanMs) || temporaryOlderThanMs < 0) {
    throw new TypeError('temporaryOlderThanMs must be a non-negative integer.');
  }
  const now = options.now ?? Date.now();
  const root = path.resolve(resultDirectory);
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Lifecycle result root must be a real directory.');
    }
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') {
      return { scanned: 0, removed: 0, removedUnreadable: 0, removedTemporary: 0, truncated: false };
    }
    throw error;
  }
  if (options.advanceEpoch !== false) await advancePurgeEpoch(root);
  let scanned = 0;
  let removed = 0;
  let removedUnreadable = 0;
  let removedTemporary = 0;
  let cursor = '';
  let pages = 0;
  while (true) {
    const page = (await fs.readdir(root))
      .filter((name) => name > cursor)
      .sort()
      .slice(0, SCAN_PAGE_ENTRIES);
    if (page.length === 0) break;
    if (pages === MAX_SCAN_PAGES) {
      return { scanned, removed, removedUnreadable, removedTemporary, truncated: true };
    }
    pages += 1;
    cursor = page[page.length - 1]!;
    for (const name of page) {
      const target = path.join(root, name);
      const temporary = TEMPORARY_RESULT.test(name);
      if (!temporary && !RESULT_BODY.test(name)) continue;
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch (error) {
        if (readErrorCode(error) === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isFile()) continue;
      if (temporary) {
        if (now - stat.mtimeMs >= temporaryOlderThanMs && await removeFile(target)) removedTemporary += 1;
        continue;
      }
      scanned += 1;
      if (filter.all || (olderThanMs !== undefined && now - stat.mtimeMs >= olderThanMs)) {
        if (await removeFile(target)) removed += 1;
        continue;
      }
      if (needles.length === 0) continue;
      let value: unknown;
      try {
        if (stat.size > MAX_RESULT_BYTES) throw new Error('oversized');
        value = JSON.parse(await fs.readFile(target, 'utf8'));
      } catch (error) {
        if (readErrorCode(error) === 'ENOENT') continue;
        if (await removeFile(target)) removedUnreadable += 1;
        continue;
      }
      if (containsNeedle(value, needles) && await removeFile(target)) removed += 1;
    }
  }
  return { scanned, removed, removedUnreadable, removedTemporary, truncated: false };
}

function validateNeedles(containing: readonly string[] | undefined): readonly string[] {
  if (containing === undefined) return [];
  if (!Array.isArray(containing) || containing.length > MAX_NEEDLES) {
    throw new TypeError(`containing must be an array of at most ${MAX_NEEDLES} strings.`);
  }
  for (const needle of containing) {
    if (typeof needle !== 'string' || needle.length === 0 || needle.length > MAX_NEEDLE_LENGTH) {
      throw new TypeError(`Each containing entry must be a non-empty string of at most ${MAX_NEEDLE_LENGTH} characters.`);
    }
  }
  return containing;
}

function containsNeedle(value: unknown, needles: readonly string[]): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (needles.some((needle) => current.includes(needle))) return true;
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        pending.push(key, child);
      }
    }
  }
  return false;
}

async function removeFile(target: string): Promise<boolean> {
  try {
    await fs.unlink(target);
    return true;
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}
