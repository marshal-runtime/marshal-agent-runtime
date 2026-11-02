import type {
  RuntimeEventEnvelope,
  RuntimeEventInput,
  RuntimeEventMap,
  RuntimeJsonValue,
} from './events.js';
import { cloneRuntimeJson } from './json.js';
import type { RuntimeEventJournal } from './journal.js';
import {
  COMPACTED_JOURNAL_BYTES,
  JournalFileAppender,
  MAX_JOURNAL_FILE_BYTES,
  removeAbandonedJournalTemporaries,
  rewriteJournalLines,
  scanJournalFile,
} from './journalFile.js';
import {
  MAX_PATH_LENGTH,
  assertText,
  createEnvelope,
  createExclusiveQueue,
  isNotFound,
  sameEvent,
  validateEvent,
  validateRead,
} from './journalShared.js';

/**
 * Events per stream kept in memory, for duplicate-ID checks and cheap reads. Holding every event
 * (364k, 509 MB on disk) put the Marshal main process past its heap limit; older events are read
 * from the file, which itself stays under MAX_JOURNAL_FILE_BYTES.
 */
export const RECENT_EVENTS_PER_STREAM = 1_000;

/** The newest lines within a byte budget, collected while a journal streams past. */
class NewestLines {
  #lines: { text: string; bytes: number; streamId: string }[] = [];
  #head = 0;
  #bytes = 0;

  constructor(private readonly budget: number) {}

  push(text: string, streamId: string): void {
    const bytes = Buffer.byteLength(text) + 1;
    this.#lines.push({ text, bytes, streamId });
    this.#bytes += bytes;
    while (this.#bytes > this.budget && this.#lines.length - this.#head > 1) {
      this.#bytes -= this.#lines[this.#head]!.bytes;
      this.#head++;
    }
    if (this.#head > 4_096 && this.#head * 2 > this.#lines.length) {
      this.#lines = this.#lines.slice(this.#head);
      this.#head = 0;
    }
  }

  /** The kept lines, preceded by the last line of every stream that has none kept, so positions continue. */
  compacted(lastLineByStream: ReadonlyMap<string, string>): string[] {
    const kept = this.#lines.slice(this.#head);
    const keptStreams = new Set(kept.map((line) => line.streamId));
    return [
      ...[...lastLineByStream].filter(([streamId]) => !keptStreams.has(streamId)).map(([, text]) => text),
      ...kept.map((line) => line.text),
    ];
  }
}

function streamIdOf(entry: unknown): string {
  return String((entry as { streamId?: unknown }).streamId);
}

export async function createFileRuntimeEventJournal<
  TMap extends RuntimeEventMap,
>(path: string): Promise<RuntimeEventJournal<TMap>> {
  assertText(path, 'path', MAX_PATH_LENGTH);
  type Envelope = RuntimeEventEnvelope<TMap>;
  const tails = new Map<string, number>();
  const recent = new Map<string, Envelope[]>();
  const recentById = new Map<string, Envelope>();
  const runExclusive = createExclusiveQueue();
  const appender = new JournalFileAppender(path);
  let fileBytes = 0;

  const remember = (event: Envelope) => {
    const window = recent.get(event.streamId) ?? [];
    window.push(event);
    recent.set(event.streamId, window);
    recentById.set(event.eventId, event);
    while (window.length > RECENT_EVENTS_PER_STREAM) recentById.delete(window.shift()!.eventId);
  };

  try {
    const loaded = new Map<string, RuntimeEventInput<RuntimeEventMap>[]>();
    const seen = new Set<string>();
    const newest = new NewestLines(COMPACTED_JOURNAL_BYTES);
    const lastLine = new Map<string, string>();
    const scanned = await scanJournalFile(path, (candidate, text) => {
      if (candidate === null || typeof candidate !== 'object') {
        throw new Error('Journal contains an invalid event.');
      }
      const event = candidate as RuntimeEventInput<RuntimeEventMap>;
      validateEvent(event);
      if (event.position === undefined) throw new Error('Journal contains an event without a position.');
      // A compacted journal starts each stream wherever its oldest kept event is.
      const previous = tails.get(event.streamId);
      if (previous !== undefined && event.position !== previous + 1) {
        throw new Error(`Journal stream ${event.streamId} expected position ${previous + 1}.`);
      }
      if (seen.has(event.eventId)) throw new Error(`Journal contains duplicate event ID ${event.eventId}.`);
      seen.add(event.eventId);
      tails.set(event.streamId, event.position);
      const window = loaded.get(event.streamId) ?? [];
      window.push(event);
      if (window.length >= 2 * RECENT_EVENTS_PER_STREAM) window.splice(0, window.length - RECENT_EVENTS_PER_STREAM);
      loaded.set(event.streamId, window);
      newest.push(text, event.streamId);
      lastLine.set(event.streamId, text);
    });
    for (const window of loaded.values())
      for (const event of window.slice(-RECENT_EVENTS_PER_STREAM))
        remember(createEnvelope(event as RuntimeEventInput<TMap>, event.position!) as Envelope);
    fileBytes = scanned?.bytes ?? 0;
    if (scanned && (scanned.rewrite || scanned.bytes > MAX_JOURNAL_FILE_BYTES))
      fileBytes = await rewriteJournalLines(path, newest.compacted(lastLine));
  } catch (error) {
    if (!isNotFound(error)) {
      throw new Error(`Runtime event journal corruption: ${String(error)}`, { cause: error });
    }
  }
  await removeAbandonedJournalTemporaries(path);

  const compact = async () => {
    const newest = new NewestLines(COMPACTED_JOURNAL_BYTES);
    const lastLine = new Map<string, string>();
    await scanJournalFile(path, (entry, text) => {
      newest.push(text, streamIdOf(entry));
      lastLine.set(streamIdOf(entry), text);
    });
    await appender.close();
    fileBytes = await rewriteJournalLines(path, newest.compacted(lastLine));
  };

  /** Events older than the in-memory window, straight from the file. */
  const readFromFile = async (
    streamId: string,
    afterPosition: number,
    beforePosition: number,
    limit: number,
  ): Promise<Envelope[]> => {
    const events: Envelope[] = [];
    await scanJournalFile(path, (entry) => {
      const event = entry as RuntimeEventInput<TMap>;
      if (
        events.length < limit &&
        event.streamId === streamId &&
        event.position! > afterPosition &&
        event.position! < beforePosition
      )
        events.push(createEnvelope(event, event.position!) as Envelope);
    });
    return events;
  };

  return {
    append: <TType extends keyof TMap & string>(input: RuntimeEventInput<TMap, TType>) =>
      runExclusive(async () => {
        const safeInput = {
          ...input,
          payload: cloneRuntimeJson(input.payload as RuntimeJsonValue),
        } as RuntimeEventInput<TMap, TType>;
        validateEvent(safeInput);
        const existing = recentById.get(safeInput.eventId);
        if (existing) {
          if (!sameEvent(existing as RuntimeEventEnvelope, safeInput)) {
            throw new Error(`Conflicting runtime event ID: ${safeInput.eventId}`);
          }
          return existing as RuntimeEventEnvelope<TMap, TType>;
        }
        const position = (tails.get(safeInput.streamId) ?? 0) + 1;
        if (safeInput.position !== undefined && safeInput.position !== position) {
          throw new RangeError(`Runtime event position for ${input.streamId} must be ${position}.`);
        }
        const event = createEnvelope(safeInput, position);
        const text = JSON.stringify(event);
        await appender.appendLine(text);
        fileBytes += Buffer.byteLength(text) + 1;
        tails.set(safeInput.streamId, position);
        remember(event as Envelope);
        if (fileBytes > MAX_JOURNAL_FILE_BYTES) {
          // The event is already durable; a failed compaction is retried on the next append.
          await compact().catch(() => undefined);
        }
        return event;
      }),
    read: (streamId, afterPosition, limit, throughPosition) =>
      runExclusive(async () => {
        validateRead(streamId, afterPosition, limit, throughPosition);
        const upper = throughPosition ?? Number.MAX_SAFE_INTEGER;
        const window = recent.get(streamId) ?? [];
        const oldestInMemory = window[0]?.position ?? (tails.get(streamId) ?? 0) + 1;
        const older =
          afterPosition + 1 < oldestInMemory
            ? await readFromFile(streamId, afterPosition, Math.min(oldestInMemory, upper + 1), limit)
            : [];
        const current = window.filter((event) => event.position > afterPosition && event.position <= upper);
        return Object.freeze([...older, ...current].slice(0, limit));
      }),
    tail: (streamId) =>
      runExclusive(async () => {
        assertText(streamId, 'streamId');
        return tails.get(streamId) ?? 0;
      }),
  };
}
