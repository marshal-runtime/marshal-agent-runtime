import type { Disposable } from './contracts.js';
import type {
  RuntimeEventBus,
  RuntimeEventEnvelope,
  RuntimeEventMap,
  RuntimeEventListener,
} from './events.js';
import type {
  RuntimeEventCheckpointStore,
  RuntimeEventJournal,
} from './journal.js';

const DEFAULT_BATCH_SIZE = 1_000;
const MAX_BATCH_SIZE = 10_000;

export interface RuntimeEventSubscriptionOptions<
  TMap extends RuntimeEventMap = RuntimeEventMap,
> {
  readonly journal: RuntimeEventJournal<TMap>;
  readonly checkpoints: RuntimeEventCheckpointStore;
  readonly bus: Pick<RuntimeEventBus<TMap>, 'subscribe'>;
  readonly streamId: string;
  readonly consumerId: string;
  readonly handle: RuntimeEventListener<TMap>;
  readonly batchSize?: number;
}

export type RuntimeDurableEventConsumerOptions<
  TMap extends RuntimeEventMap = RuntimeEventMap,
> = Pick<RuntimeEventSubscriptionOptions<TMap>, 'consumerId' | 'handle' | 'batchSize'>;

export interface RuntimeEventSubscription extends Disposable {
  readonly ready: Promise<void>;
}

function assertText(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
    throw new TypeError(
      `${name} must be a non-empty string of at most 1024 characters.`,
    );
  }
}

function assertBatchSize(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_BATCH_SIZE) {
    throw new RangeError(
      `batchSize must be between 1 and ${MAX_BATCH_SIZE}.`,
    );
  }
}

/**
 * Replays a checkpointed stream and atomically hands processing over to live
 * events by subscribing before taking the replay boundary.
 */
export function createRuntimeEventSubscription<
  TMap extends RuntimeEventMap,
>(
  options: RuntimeEventSubscriptionOptions<TMap>,
): RuntimeEventSubscription {
  assertText(options.streamId, 'streamId');
  assertText(options.consumerId, 'consumerId');
  if (typeof options.handle !== 'function') {
    throw new TypeError('Runtime event handler must be a function.');
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  assertBatchSize(batchSize);

  let disposed = false;
  let active = false;
  let checkpointPosition = 0;
  let buffered: RuntimeEventEnvelope<TMap>[] = [];
  let liveQueue: RuntimeEventEnvelope<TMap>[] = [];
  let draining: Promise<void> | undefined;
  let listener: Disposable | undefined;

  const saveCheckpoint = async (event: RuntimeEventEnvelope<TMap>): Promise<void> => {
    await options.checkpoints.save({
      streamId: options.streamId,
      consumerId: options.consumerId,
      position: event.position,
      updatedAt: new Date().toISOString(),
    });
    checkpointPosition = event.position;
  };

  const handleEvent = async (event: RuntimeEventEnvelope<TMap>): Promise<void> => {
    if (disposed || event.position <= checkpointPosition) return;
    await options.handle(event);
    await saveCheckpoint(event);
  };

  const drainLive = async (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      while (!disposed && liveQueue.length > 0) {
        const throughPosition = Math.max(
          ...liveQueue.map((event) => event.position),
        );
        const events = await options.journal.read(
          options.streamId,
          checkpointPosition,
          batchSize,
          throughPosition,
        );
        if (events.length === 0) {
          liveQueue.shift();
          continue;
        }
        for (const event of events) {
          await handleEvent(event);
        }
        liveQueue = liveQueue.filter(
          (event) => event.position > checkpointPosition,
        );
      }
    })();
    try {
      await draining;
    } finally {
      draining = undefined;
    }
  };

  const onLiveEvent: RuntimeEventListener<TMap> = async (event) => {
    if (disposed) return;
    if (!active) {
      buffered.push(event);
      return;
    }
    liveQueue.push(event);
    await drainLive();
  };

  const ready = (async () => {
    try {
      listener = options.bus.subscribe('*', onLiveEvent);
      const checkpoint = await options.checkpoints.get(
        options.streamId,
        options.consumerId,
      );
      checkpointPosition = checkpoint?.position ?? 0;
      const boundary = await options.journal.tail(options.streamId);
      let cursor = checkpointPosition;

      while (cursor < boundary) {
        const events = await options.journal.read(
          options.streamId,
          cursor,
          batchSize,
          boundary,
        );
        if (events.length === 0) break;
        for (const event of events) {
          await handleEvent(event);
          cursor = event.position;
        }
      }

      active = true;
      const pending = buffered
        .sort((left, right) => left.position - right.position)
        .splice(0);
      liveQueue.push(...pending);
      await drainLive();
    } catch (error) {
      disposed = true;
      listener?.dispose();
      buffered = [];
      liveQueue = [];
      throw error;
    }
  })();

  return {
    ready,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listener?.dispose();
      buffered = [];
      liveQueue = [];
    },
  };
}
