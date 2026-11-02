import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createFileRuntimeEventCheckpointStore,
  createFileRuntimeEventJournal,
  createInMemoryRuntimeEventCheckpointStore,
  createInMemoryRuntimeEventJournal,
  createRuntimeEventBus,
  replayRuntimeEvents,
  type RuntimeEventMap,
  type RuntimeExternalEffectConsumer,
} from '../src/index.js';

interface TestEvents extends RuntimeEventMap {
  readonly 'test.recorded': {
    readonly value: number;
    readonly label?: string;
  };
}

const event = (
  eventId: string,
  value: number,
  label?: string,
) => ({
  streamId: 'stream-1',
  eventId,
  type: 'test.recorded' as const,
  occurredAt: '2026-01-01T00:00:00.000Z',
  payload: {
    value,
    ...(label === undefined ? {} : { label }),
  },
});

describe('runtime events and journal', () => {
  it('appends before delivery, freezes payloads, and isolates observer failures', async () => {
    const journal = createInMemoryRuntimeEventJournal<TestEvents>();
    const listenerPositions: number[] = [];
    const healthy = vi.fn();
    const bus = createRuntimeEventBus<TestEvents>({
      journal,
      onListenerError: () => undefined,
    });
    bus.subscribe('test.recorded', async (recorded) => {
      listenerPositions.push(await journal.tail(recorded.streamId));
      throw new Error('observer failed');
    });
    bus.subscribe('*', healthy);

    const published = await bus.publish(event('event-1', 1));

    expect(published.position).toBe(1);
    expect(listenerPositions).toEqual([1]);
    expect(healthy).toHaveBeenCalledWith(published);
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.payload)).toBe(true);
  });

  it('assigns ordered positions and enforces idempotent event and checkpoint writes', async () => {
    const journal = createInMemoryRuntimeEventJournal<TestEvents>();
    const first = await journal.append(event('event-1', 1, 'one'));
    const second = await journal.append(event('event-2', 2));
    const duplicate = await journal.append({
      ...event('event-1', 1),
      payload: { label: 'one', value: 1 },
    });

    expect([first.position, second.position]).toEqual([1, 2]);
    expect(duplicate).toBe(first);
    await expect(
      journal.append(event('event-1', 99)),
    ).rejects.toThrow(/conflicting runtime event id/i);
    await expect(journal.read('stream-1', 0, 0)).rejects.toThrow(/limit/i);
    expect(await journal.read('stream-1', 0, 1)).toEqual([first]);

    const checkpoints = createInMemoryRuntimeEventCheckpointStore();
    await checkpoints.save({
      streamId: 'stream-1',
      consumerId: 'consumer-1',
      position: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(
      checkpoints.save({
        streamId: 'stream-1',
        consumerId: 'consumer-1',
        position: 1,
        updatedAt: '2026-01-01T00:00:01.000Z',
      }),
    ).rejects.toThrow(/cannot regress/i);
  });

  it('keeps checkpoint keys collision-free', async () => {
    const checkpoints = createInMemoryRuntimeEventCheckpointStore();
    await checkpoints.save({
      streamId: 'a',
      consumerId: 'b:c',
      position: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await checkpoints.save({
      streamId: 'a:b',
      consumerId: 'c',
      position: 2,
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    expect(
      await checkpoints.get('a', 'b:c'),
    ).toMatchObject({ position: 1 });
    expect(
      await checkpoints.get('a:b', 'c'),
    ).toMatchObject({ position: 2 });
  });

  it('migrates legacy NUL-delimited checkpoint keys on load', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-checkpoints-'));
    const checkpointPath = join(directory, 'checkpoints.json');
    try {
      await writeFile(
        checkpointPath,
        JSON.stringify({
          'stream-1\0consumer-1': {
            streamId: 'stream-1',
            consumerId: 'consumer-1',
            position: 3,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        }),
        'utf8',
      );
      const checkpoints =
        await createFileRuntimeEventCheckpointStore(checkpointPath);
      expect(
        await checkpoints.get('stream-1', 'consumer-1'),
      ).toMatchObject({ position: 3 });
      expect(await readFile(checkpointPath, 'utf8')).toContain(
        '"8:stream-1consumer-1"',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects oversized sparse payload arrays before allocation', async () => {
    const sparse: unknown[] = [];
    sparse.length = 10_001;
    const bus = createRuntimeEventBus<TestEvents>({
      journal: createInMemoryRuntimeEventJournal<TestEvents>(),
    });
    await expect(
      bus.publish({ ...event('sparse-event', 1), payload: sparse as never }),
    ).rejects.toThrow(/array is too large/i);
  });

  it('rejects accessor payloads before journaling and delivery', async () => {
    const journal = createInMemoryRuntimeEventJournal<TestEvents>();
    const bus = createRuntimeEventBus<TestEvents>({ journal });
    let value = 1;
    const payload = {};
    Object.defineProperty(payload, 'value', {
      enumerable: true,
      get: () => value,
    });
    const delivered = vi.fn();
    bus.subscribe('*', delivered);

    await expect(
      bus.publish({ ...event('accessor-event', value), payload: payload as never }),
    ).rejects.toThrow(/accessors/i);
    value = 99;

    expect(delivered).not.toHaveBeenCalled();
    await expect(
      journal.append({
        ...event('accessor-journal', 0),
        payload: payload as TestEvents['test.recorded'],
      }),
    ).rejects.toThrow(/accessors/i);
  });

  it('rejects event input properties outside the declared envelope', async () => {
    const journal = createInMemoryRuntimeEventJournal<TestEvents>();
    const bus = createRuntimeEventBus<TestEvents>({ journal });
    await expect(
      bus.publish({ ...event('extra-event', 1), extra: true } as never),
    ).rejects.toThrow(/unexpected properties/i);
    const symbol = Symbol('extra');
    const withSymbol = event('symbol-event', 1) as Record<PropertyKey, unknown>;
    withSymbol[symbol] = true;
    await expect(bus.publish(withSymbol as never)).rejects.toThrow(/unexpected properties/i);
    await expect(
      journal.append({ ...event('journal-extra', 1), extra: true } as never),
    ).rejects.toThrow(/unexpected properties/i);
  });

  it('does not read beyond the replay target snapshot', async () => {
    const events = [
      { ...event('event-1', 1), position: 1 },
      { ...event('event-2', 2), position: 2 },
    ];
    let reads = 0;
    const journal = {
      append: async (input: typeof events[number]) => ({
        ...input,
        position: 1,
      }),
      tail: async () => 1,
      read: async (
        _streamId: string,
        _after: number,
        _limit: number,
        through?: number,
      ) => {
        reads = through ?? -1;
        return events;
      },
    };
    const checkpoints = createInMemoryRuntimeEventCheckpointStore();
    const result = await replayRuntimeEvents(
      journal,
      checkpoints,
      'stream-1',
      'consumer-snapshot',
      { handle: () => undefined },
      { maxEvents: 10 },
    );
    expect(reads).toBe(1);
    expect(result.handled).toBe(1);
  });

  it('keeps local stream positions monotonic after an older event is republished', async () => {
    const bus = createRuntimeEventBus<TestEvents>({
      journal: createInMemoryRuntimeEventJournal<TestEvents>(),
    });
    const first = await bus.publish(event('event-1', 1));
    await bus.publish(event('event-2', 2));
    expect(await bus.publish(event('event-1', 1))).toBe(first);

    expect((await bus.publish(event('event-3', 3))).position).toBe(3);
  });

  it('advances checkpoints only after success and passes stable effect keys on retry', async () => {
    const journal = createInMemoryRuntimeEventJournal<TestEvents>();
    const checkpoints = createInMemoryRuntimeEventCheckpointStore();
    await journal.append(event('event-1', 1));
    await journal.append(event('event-2', 2));
    let failSecond = true;
    const attempts: Array<{ eventId: string; key: string }> = [];
    const consumer: RuntimeExternalEffectConsumer<TestEvents> = {
      idempotencyKey: (recorded) => `effect:${recorded.eventId}`,
      handle: (recorded, key) => {
        attempts.push({ eventId: recorded.eventId, key });
        if (recorded.position === 2 && failSecond) {
          failSecond = false;
          throw new Error('effect failed');
        }
      },
    };

    await expect(
      replayRuntimeEvents(
        journal,
        checkpoints,
        'stream-1',
        'consumer-1',
        consumer,
        { maxEvents: 2 },
      ),
    ).rejects.toThrow('effect failed');
    expect(
      await checkpoints.get('stream-1', 'consumer-1'),
    ).toMatchObject({ position: 1 });

    const retried = await replayRuntimeEvents(
      journal,
      checkpoints,
      'stream-1',
      'consumer-1',
      consumer,
      { maxEvents: 2 },
    );

    expect(retried).toMatchObject({
      status: 'caught_up',
      startPosition: 1,
      handled: 1,
      checkpointPosition: 2,
    });
    expect(attempts.filter(({ eventId }) => eventId === 'event-2')).toEqual([
      { eventId: 'event-2', key: 'effect:event-2' },
      { eventId: 'event-2', key: 'effect:event-2' },
    ]);

    const exactLimit = await replayRuntimeEvents(
      journal,
      checkpoints,
      'stream-1',
      'consumer-2',
      { handle: () => undefined },
      { maxEvents: 2 },
    );
    expect(exactLimit.status).toBe('caught_up');
  });

  it('persists ordered journals and monotonic checkpoints across restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-events-'));
    const journalPath = join(directory, 'nested', 'journal.json');
    const checkpointPath = join(directory, 'nested', 'checkpoints.json');
    try {
      const journal = await createFileRuntimeEventJournal<TestEvents>(
        journalPath,
      );
      const [first, second] = await Promise.all([
        journal.append(event('event-1', 1)),
        journal.append(event('event-2', 2)),
      ]);
      expect([first.position, second.position]).toEqual([1, 2]);

      const checkpoints = await createFileRuntimeEventCheckpointStore(
        checkpointPath,
      );
      await checkpoints.save({
        streamId: 'stream-1',
        consumerId: 'consumer-1',
        position: 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const reopenedJournal =
        await createFileRuntimeEventJournal<TestEvents>(journalPath);
      const reopenedCheckpoints =
        await createFileRuntimeEventCheckpointStore(checkpointPath);
      expect(await reopenedJournal.read('stream-1', 0, 10)).toHaveLength(2);
      expect(
        await reopenedCheckpoints.get('stream-1', 'consumer-1'),
      ).toMatchObject({ position: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('appends one line per event instead of rewriting the journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-events-'));
    const journalPath = join(directory, 'journal.json');
    try {
      const journal = await createFileRuntimeEventJournal<TestEvents>(journalPath);
      await journal.append(event('event-1', 1));
      await journal.append(event('event-2', 2));
      await journal.append(event('event-3', 3));
      const lines = (await readFile(journalPath, 'utf8')).split('\n');
      expect(lines.at(-1)).toBe('');
      expect(lines.slice(0, -1).map((line) => JSON.parse(line).eventId)).toEqual([
        'event-1',
        'event-2',
        'event-3',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('loads a legacy array journal and converts it to lines on the next append', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-events-'));
    const journalPath = join(directory, 'journal.json');
    try {
      const writer = await createFileRuntimeEventJournal<TestEvents>(join(directory, 'seed.json'));
      const legacy = [
        await writer.append(event('event-1', 1)),
        await writer.append(event('event-2', 2)),
      ];
      await writeFile(journalPath, JSON.stringify(legacy), 'utf8');

      const journal = await createFileRuntimeEventJournal<TestEvents>(journalPath);
      expect(await journal.read('stream-1', 0, 10)).toHaveLength(2);
      await journal.append(event('event-3', 3));
      const source = await readFile(journalPath, 'utf8');
      expect(source.startsWith('[')).toBe(false);
      expect(source.trim().split('\n')).toHaveLength(3);

      const reopened = await createFileRuntimeEventJournal<TestEvents>(journalPath);
      expect(
        (await reopened.read('stream-1', 0, 10)).map((item) => item.position),
      ).toEqual([1, 2, 3]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drops a torn final line and keeps later appends on their own lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-events-'));
    const journalPath = join(directory, 'journal.json');
    try {
      const seedPath = join(directory, 'seed.json');
      const writer = await createFileRuntimeEventJournal<TestEvents>(seedPath);
      await writer.append(event('event-1', 1));
      await writeFile(
        journalPath,
        `${await readFile(seedPath, 'utf8')}{"eventId":"event-2","pos`,
        'utf8',
      );

      const journal = await createFileRuntimeEventJournal<TestEvents>(journalPath);
      expect(await journal.read('stream-1', 0, 10)).toHaveLength(1);
      await journal.append(event('event-2', 2));
      await journal.append(event('event-3', 3));

      const reopened = await createFileRuntimeEventJournal<TestEvents>(journalPath);
      expect(
        (await reopened.read('stream-1', 0, 10)).map((item) => item.eventId),
      ).toEqual(['event-1', 'event-2', 'event-3']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports corruption for an unreadable line before the end', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-events-'));
    const journalPath = join(directory, 'journal.json');
    try {
      const writer = await createFileRuntimeEventJournal<TestEvents>(journalPath);
      await writer.append(event('event-1', 1));
      await writeFile(
        journalPath,
        `not json\n${await readFile(journalPath, 'utf8')}`,
        'utf8',
      );
      await expect(
        createFileRuntimeEventJournal<TestEvents>(journalPath),
      ).rejects.toThrow('Runtime event journal corruption');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
