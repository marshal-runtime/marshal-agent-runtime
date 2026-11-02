import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type {
  RuntimeEventEnvelope,
  RuntimeEventInput,
  RuntimeEventMap,
  RuntimeJsonValue,
} from './events.js';
import { cloneRuntimeJson } from './json.js';
import {
  MAX_PATH_LENGTH,
  MAX_READ_LIMIT,
  assertPosition,
  assertText,
  createEnvelope,
  createExclusiveQueue,
  isNotFound,
  sameEvent,
  validateEvent,
  validateRead,
} from './journalShared.js';

export { createFileRuntimeEventJournal } from './fileJournal.js';

export interface RuntimeEventJournal<
  TMap extends RuntimeEventMap = RuntimeEventMap,
> {
  append<TType extends keyof TMap & string>(
    event: RuntimeEventInput<TMap, TType>,
  ): Promise<RuntimeEventEnvelope<TMap, TType>>;
  read(
    streamId: string,
    afterPosition: number,
    limit: number,
    throughPosition?: number,
  ): Promise<readonly RuntimeEventEnvelope<TMap>[]>;
  tail(streamId: string): Promise<number>;
}

export interface RuntimeEventCheckpoint {
  readonly streamId: string;
  readonly consumerId: string;
  readonly position: number;
  readonly updatedAt: string;
}

export interface RuntimeEventCheckpointStore {
  get(
    streamId: string,
    consumerId: string,
  ): Promise<RuntimeEventCheckpoint | undefined>;
  save(checkpoint: RuntimeEventCheckpoint): Promise<RuntimeEventCheckpoint>;
}

let temporaryFileSequence = 0;

function validateCheckpoint(checkpoint: RuntimeEventCheckpoint): void {
  assertText(checkpoint.streamId, 'streamId');
  assertText(checkpoint.consumerId, 'consumerId');
  assertPosition(checkpoint.position, 'Runtime event checkpoint', true);
  assertText(checkpoint.updatedAt, 'updatedAt');
}

function checkpointKey(streamId: string, consumerId: string): string {
  return `${streamId.length}:${streamId}${consumerId}`;
}

function legacyCheckpointKey(streamId: string, consumerId: string): string {
  return `${streamId}\0${consumerId}`;
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${++temporaryFileSequence}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value), 'utf8');
    const temporary = await fs.open(temporaryPath, 'r+');
    try {
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await renameWithWindowsTransientRetry(temporaryPath, path);
    let directoryPath = dirname(path);
    while (true) {
      try {
        const directory = await fs.open(directoryPath, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (
          code !== 'EINVAL' &&
          code !== 'ENOTSUP' &&
          code !== 'EISDIR' &&
          code !== 'EPERM'
        ) {
          throw error;
        }
      }

      const parentPath = dirname(directoryPath);
      if (parentPath === directoryPath) break;
      directoryPath = parentPath;
    }
  } catch (error) {
    try {
      await fs.rm(temporaryPath, { force: true });
    } catch {
      // The original write error remains authoritative.
    }
    throw error;
  }
}

const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;

async function renameWithWindowsTransientRetry(
  temporaryPath: string,
  destinationPath: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporaryPath, destinationPath);
      return;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      const delay = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')
        ? WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]
        : undefined;
      if (delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function createInMemoryRuntimeEventJournal<
  TMap extends RuntimeEventMap,
>(): RuntimeEventJournal<TMap> {
  const streams = new Map<string, RuntimeEventEnvelope<TMap>[]>();
  const eventsById = new Map<string, RuntimeEventEnvelope<TMap>>();
  return {
    async append<TType extends keyof TMap & string>(input: RuntimeEventInput<TMap, TType>) {
      const safeInput = {
        ...input,
        payload: cloneRuntimeJson(input.payload as RuntimeJsonValue),
      } as RuntimeEventInput<TMap, TType>;
      validateEvent(safeInput);
      const existing = eventsById.get(safeInput.eventId);
      if (existing) {
        if (
          !sameEvent(
            existing as RuntimeEventEnvelope,
            safeInput,
          )
        ) {
          throw new Error(`Conflicting runtime event ID: ${safeInput.eventId}`);
        }
        return existing as RuntimeEventEnvelope<TMap, typeof safeInput.type>;
      }
      const stream = streams.get(safeInput.streamId) ?? [];
      const position = stream.length + 1;
      if (safeInput.position !== undefined && safeInput.position !== position) {
        throw new RangeError(
          `Runtime event position for ${input.streamId} must be ${position}.`,
        );
      }
      const event = createEnvelope(safeInput, position);
      stream.push(event);
      streams.set(safeInput.streamId, stream);
      eventsById.set(safeInput.eventId, event);
      return event;
    },
    async read(streamId, afterPosition, limit, throughPosition) {
      validateRead(streamId, afterPosition, limit, throughPosition);
      return Object.freeze(
        (streams.get(streamId) ?? [])
          .filter(
            (event) =>
              event.position > afterPosition &&
              (throughPosition === undefined ||
                event.position <= throughPosition),
          )
          .slice(0, limit),
      );
    },
    async tail(streamId) {
      assertText(streamId, 'streamId');
      return (streams.get(streamId) ?? []).length;
    },
  };
}

export function createInMemoryRuntimeEventCheckpointStore(): RuntimeEventCheckpointStore {
  const checkpoints = new Map<string, RuntimeEventCheckpoint>();
  return {
    async get(streamId, consumerId) {
      assertText(streamId, 'streamId');
      assertText(consumerId, 'consumerId');
      return checkpoints.get(checkpointKey(streamId, consumerId));
    },
    async save(checkpoint) {
      validateCheckpoint(checkpoint);
      const key = checkpointKey(
        checkpoint.streamId,
        checkpoint.consumerId,
      );
      const existing = checkpoints.get(key);
      if (existing && checkpoint.position < existing.position) {
        throw new Error('Runtime event checkpoint cannot regress.');
      }
      const saved = Object.freeze({ ...checkpoint });
      checkpoints.set(key, saved);
      return saved;
    },
  };
}

export async function createFileRuntimeEventCheckpointStore(
  path: string,
): Promise<RuntimeEventCheckpointStore> {
  assertText(path, 'path', MAX_PATH_LENGTH);
  const checkpoints = new Map<string, RuntimeEventCheckpoint>();
  let persisted: Record<string, RuntimeEventCheckpoint> = {};
  let migratedLegacyKeys = false;
  const runExclusive = createExclusiveQueue();

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Checkpoint root must be an object.');
    }
    for (const [key, candidate] of Object.entries(parsed)) {
      if (candidate === null || typeof candidate !== 'object') {
        throw new Error('Checkpoint file contains an invalid checkpoint.');
      }
      const checkpoint = candidate as RuntimeEventCheckpoint;
      validateCheckpoint(checkpoint);
      const expectedKey = checkpointKey(
        checkpoint.streamId,
        checkpoint.consumerId,
      );
      const isLegacyKey =
        key === legacyCheckpointKey(checkpoint.streamId, checkpoint.consumerId);
      if (key !== expectedKey && !isLegacyKey) {
        throw new Error('Checkpoint file contains a mismatched key.');
      }
      const frozen = Object.freeze({ ...checkpoint });
      if (checkpoints.has(expectedKey)) {
        throw new Error('Checkpoint file contains duplicate checkpoint identities.');
      }
      checkpoints.set(expectedKey, frozen);
      persisted[expectedKey] = frozen;
      migratedLegacyKeys ||= isLegacyKey;
    }
    if (migratedLegacyKeys) {
      await writeJsonAtomically(path, persisted);
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw new Error(
        `Runtime checkpoint corruption: ${String(error)}`,
        { cause: error },
      );
    }
  }

  return {
    get: (streamId, consumerId) =>
      runExclusive(async () => {
        assertText(streamId, 'streamId');
        assertText(consumerId, 'consumerId');
        return checkpoints.get(checkpointKey(streamId, consumerId));
      }),
    save: (checkpoint) =>
      runExclusive(async () => {
        validateCheckpoint(checkpoint);
        const key = checkpointKey(
          checkpoint.streamId,
          checkpoint.consumerId,
        );
        const existing = checkpoints.get(key);
        if (existing && checkpoint.position < existing.position) {
          throw new Error('Runtime event checkpoint cannot regress.');
        }
        const saved = Object.freeze({ ...checkpoint });
        const nextPersisted = { ...persisted, [key]: saved };
        await writeJsonAtomically(path, nextPersisted);
        persisted = nextPersisted;
        checkpoints.set(key, saved);
        return saved;
      }),
  };
}

export interface RuntimeEventConsumer<
  TMap extends RuntimeEventMap = RuntimeEventMap,
> {
  handle(event: RuntimeEventEnvelope<TMap>): Promise<void> | void;
}

export interface RuntimeExternalEffectConsumer<
  TMap extends RuntimeEventMap = RuntimeEventMap,
> {
  idempotencyKey(event: RuntimeEventEnvelope<TMap>): string;
  handle(
    event: RuntimeEventEnvelope<TMap>,
    idempotencyKey: string,
  ): Promise<void> | void;
}

export interface RuntimeReplayResult {
  readonly status: 'caught_up' | 'limit_reached';
  readonly startPosition: number;
  readonly tailPosition: number;
  readonly handled: number;
  readonly checkpointPosition: number;
}

function isExternalEffectConsumer<TMap extends RuntimeEventMap>(
  consumer:
    | RuntimeEventConsumer<TMap>
    | RuntimeExternalEffectConsumer<TMap>,
): consumer is RuntimeExternalEffectConsumer<TMap> {
  return (
    typeof (consumer as Partial<RuntimeExternalEffectConsumer<TMap>>)
      .idempotencyKey === 'function'
  );
}

export async function replayRuntimeEvents<TMap extends RuntimeEventMap>(
  journal: RuntimeEventJournal<TMap>,
  checkpoints: RuntimeEventCheckpointStore,
  streamId: string,
  consumerId: string,
  consumer:
    | RuntimeEventConsumer<TMap>
    | RuntimeExternalEffectConsumer<TMap>,
  options: {
    readonly maxEvents: number;
    readonly throughPosition?: number;
  },
): Promise<RuntimeReplayResult> {
  assertText(streamId, 'streamId');
  assertText(consumerId, 'consumerId');
  if (
    !Number.isInteger(options.maxEvents) ||
    options.maxEvents <= 0 ||
    options.maxEvents > MAX_READ_LIMIT
  ) {
    throw new RangeError(
      `maxEvents must be between 1 and ${MAX_READ_LIMIT}.`,
    );
  }
  if (options.throughPosition !== undefined) {
    assertPosition(
      options.throughPosition,
      'Runtime event replay upper bound',
      true,
    );
  }

  const checkpoint = await checkpoints.get(streamId, consumerId);
  const startPosition = checkpoint?.position ?? 0;
  const tailPosition = await journal.tail(streamId);
  const targetPosition = Math.min(
    tailPosition,
    options.throughPosition ?? tailPosition,
  );
  const events = await journal.read(
    streamId,
    startPosition,
    options.maxEvents,
    targetPosition,
  );

  let handled = 0;
  let checkpointPosition = startPosition;
  for (const event of events) {
    if (event.position > targetPosition) break;
    if (isExternalEffectConsumer(consumer)) {
      const idempotencyKey = consumer.idempotencyKey(event);
      assertText(idempotencyKey, 'idempotencyKey');
      await consumer.handle(event, idempotencyKey);
    } else {
      await consumer.handle(event);
    }
    checkpointPosition = event.position;
    await checkpoints.save({
      streamId,
      consumerId,
      position: checkpointPosition,
      updatedAt: new Date().toISOString(),
    });
    handled++;
  }

  return {
    status:
      checkpointPosition >= targetPosition
        ? 'caught_up'
        : 'limit_reached',
    startPosition,
    tailPosition,
    handled,
    checkpointPosition,
  };
}
