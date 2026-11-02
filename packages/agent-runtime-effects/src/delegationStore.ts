import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DelegationRecord,
  DelegationStore,
} from '@marshal/agent-runtime-delegation';

export interface FileDelegationStoreOptions {
  readonly rootDirectory: string;
}

/** Durable JSON storage for minimal delegation transport records. */
export class FileDelegationStore implements DelegationStore {
  private readonly rootPromise: Promise<string>;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: FileDelegationStoreOptions) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new Error('rootDirectory must be absolute.');
    }
    this.rootPromise = initializeRoot(options.rootDirectory);
  }

  async get(delegationId: string): Promise<DelegationRecord | undefined> {
    const root = await this.rootPromise;
    try {
      return await readRecord(recordPath(root, delegationId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<readonly DelegationRecord[]> {
    const root = await this.rootPromise;
    const entries = await fs.readdir(root, { withFileTypes: true });
    const records: DelegationRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      records.push(await readRecord(path.join(root, entry.name)));
    }
    return records;
  }

  create(record: DelegationRecord): Promise<void> {
    return this.serial(async () => {
      const root = await this.rootPromise;
      const target = recordPath(root, record.delegationId);
      try {
        await fs.writeFile(target, JSON.stringify(record), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`Delegation "${record.delegationId}" already exists.`);
        }
        throw error;
      }
    });
  }

  update(record: DelegationRecord): Promise<void> {
    return this.serial(async () => {
      const root = await this.rootPromise;
      const target = recordPath(root, record.delegationId);
      try {
        await fs.lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Delegation "${record.delegationId}" was not found.`);
        }
        throw error;
      }
      await atomicWrite(root, target, record);
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function initializeRoot(configured: string): Promise<string> {
  await fs.mkdir(configured, { recursive: true });
  const stat = await fs.lstat(configured);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Delegation root must be a real directory.');
  }
  return fs.realpath(configured);
}

function recordPath(root: string, delegationId: string): string {
  if (!delegationId || /[\\/]/.test(delegationId)) {
    throw new TypeError('delegationId must be a non-empty path segment.');
  }
  const target = path.join(root, `${delegationId}.json`);
  assertContained(root, target);
  return target;
}

async function readRecord(target: string): Promise<DelegationRecord> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Delegation record is not a regular file.');
  }
  const value = JSON.parse(await fs.readFile(target, 'utf8')) as DelegationRecord;
  if (
    !value ||
    typeof value.delegationId !== 'string' ||
    typeof value.state !== 'string' ||
    (value.changeRefs !== undefined && !Array.isArray(value.changeRefs))
  ) {
    throw new Error('Delegation record is invalid.');
  }
  return value;
}

async function atomicWrite(
  root: string,
  target: string,
  record: DelegationRecord,
): Promise<void> {
  const temp = path.join(root, `.delegation-${randomUUID()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  try {
    await fs.rename(temp, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Delegation target is unsafe.');
    }
    await fs.unlink(target);
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Delegation path escaped its root.');
  }
}
