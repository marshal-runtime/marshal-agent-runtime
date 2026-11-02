import * as fs from 'node:fs';
import path from 'node:path';
import type {
  RuntimeScheduleState,
  RuntimeScheduleTiming,
  RuntimeScheduledTask,
  RuntimeScope,
} from '@marshal/agent-runtime-core';
import { codedError, requireKey } from './json.js';

const RECORD_SUFFIX = '.json';
const LOCK_DIRECTORY = '.lock';
const LOCK_POLL_MS = 10;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 15_000;
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;

export interface ScheduleClaim {
  readonly owner: string;
  readonly fireId: string;
  readonly expiresAt: string;
}

export interface StoredSchedule {
  readonly scheduleId: string;
  readonly principalId: string;
  readonly scope?: RuntimeScope;
  readonly state: RuntimeScheduleState;
  readonly timing: RuntimeScheduleTiming;
  readonly task: RuntimeScheduledTask;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly fireCount: number;
  readonly attempts: number;
  readonly lastError?: string;
  readonly claim?: ScheduleClaim;
}

export interface ScheduleStore {
  get(scheduleId: string): Promise<StoredSchedule | undefined>;
  list(): Promise<readonly StoredSchedule[]>;
  /** Runs `change` while holding the store lock so a caller can read, decide, and write several records. */
  transaction<T>(change: (tx: ScheduleTransaction) => T | Promise<T>): Promise<T>;
}

export interface ScheduleTransaction {
  list(): readonly StoredSchedule[];
  get(scheduleId: string): StoredSchedule | undefined;
  put(record: StoredSchedule): void;
  delete(scheduleId: string): void;
}

export interface FileScheduleStoreOptions {
  readonly rootDirectory: string;
  readonly maxRecordBytes?: number;
}

/** Durable schedule records, one JSON file each, safe for several processes sharing one root. */
export class FileScheduleStore implements ScheduleStore {
  private readonly root: string;
  private readonly maxRecordBytes: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileScheduleStoreOptions) {
    if (!path.isAbsolute(options.rootDirectory)) throw new Error('rootDirectory must be absolute.');
    this.root = options.rootDirectory;
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  get(scheduleId: string): Promise<StoredSchedule | undefined> {
    requireKey(scheduleId, 'scheduleId');
    return this.locked(() => this.read(scheduleId));
  }

  list(): Promise<readonly StoredSchedule[]> {
    return this.locked(() => this.readAll());
  }

  transaction<T>(change: (tx: ScheduleTransaction) => T | Promise<T>): Promise<T> {
    return this.lockedAsync(async () => {
      const cache = new Map(this.readAll().map((record) => [record.scheduleId, record]));
      const dirty = new Set<string>();
      const deleted = new Set<string>();
      const tx: ScheduleTransaction = {
        list: () => [...cache.values()],
        get: (scheduleId) => cache.get(scheduleId),
        put: (record) => {
          cache.set(record.scheduleId, record);
          dirty.add(record.scheduleId);
          deleted.delete(record.scheduleId);
        },
        delete: (scheduleId) => {
          cache.delete(scheduleId);
          dirty.delete(scheduleId);
          deleted.add(scheduleId);
        },
      };
      const result = await change(tx);
      dirty.forEach((scheduleId) => this.write(cache.get(scheduleId)!));
      deleted.forEach((scheduleId) => fs.rmSync(this.recordPath(scheduleId), { force: true }));
      return result;
    });
  }

  private locked<T>(action: () => T): Promise<T> {
    return this.lockedAsync(async () => action());
  }

  private lockedAsync<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const release = await this.acquireProcessLock();
      try {
        return await action();
      } finally {
        release();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async acquireProcessLock(): Promise<() => void> {
    const lockPath = path.join(this.root, LOCK_DIRECTORY);
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        return () => fs.rmSync(lockPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.breakStaleLock(lockPath);
        if (Date.now() > deadline) {
          throw codedError('SCHEDULE_STORE_BUSY', 'Timed out waiting for the schedule store lock.');
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
  }

  private breakStaleLock(lockPath: string): void {
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {
      return;
    }
  }

  private recordPath(scheduleId: string): string {
    return path.join(this.root, `${scheduleId}${RECORD_SUFFIX}`);
  }

  private read(scheduleId: string): StoredSchedule | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.recordPath(scheduleId), 'utf8')) as StoredSchedule;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private readAll(): StoredSchedule[] {
    return fs
      .readdirSync(this.root)
      .filter((name) => name.endsWith(RECORD_SUFFIX))
      .flatMap((name) => {
        const record = this.read(name.slice(0, -RECORD_SUFFIX.length));
        return record ? [record] : [];
      });
  }

  private write(record: StoredSchedule): void {
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxRecordBytes) {
      throw codedError('VALUE_TOO_LARGE', `schedule exceeds ${this.maxRecordBytes} bytes.`);
    }
    const target = this.recordPath(record.scheduleId);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, serialized, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
}
