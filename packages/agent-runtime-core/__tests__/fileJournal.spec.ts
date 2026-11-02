import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/journalFile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/journalFile.js')>()),
  MAX_JOURNAL_FILE_BYTES: 256 * 1024,
  COMPACTED_JOURNAL_BYTES: 128 * 1024,
}));

const { createFileRuntimeEventJournal, RECENT_EVENTS_PER_STREAM } = await import('../src/fileJournal.js');

const line = (position: number) =>
  JSON.stringify({
    streamId: 'runtime.lifecycle',
    eventId: `event-${position}`,
    type: 'test.recorded',
    occurredAt: '2026-09-30T00:00:00.000Z',
    payload: { value: position, label: 'x'.repeat(40) },
    position,
  });
const input = (position: number) => ({
  streamId: 'runtime.lifecycle',
  eventId: `event-${position}`,
  type: 'test.recorded' as const,
  occurredAt: '2026-09-30T00:00:00.000Z',
  payload: { value: position, label: 'x'.repeat(40) },
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function journalFile(lines: number) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-journal-'));
  directories.push(directory);
  const path = join(directory, 'journal.jsonl');
  if (lines) await writeFile(path, Array.from({ length: lines }, (_, index) => `${line(index + 1)}\n`).join(''));
  return path;
}

describe('bounded file journal', () => {
  it('trims an oversized journal at startup and keeps positions going', async () => {
    const path = await journalFile(4_000);
    expect((await stat(path)).size).toBeGreaterThan(256 * 1024);

    const journal = await createFileRuntimeEventJournal(path);
    expect((await stat(path)).size).toBeLessThanOrEqual(128 * 1024);
    expect(await journal.tail('runtime.lifecycle')).toBe(4_000);
    expect((await journal.read('runtime.lifecycle', 3_995, 10)).map((event) => event.position)).toEqual([
      3_996, 3_997, 3_998, 3_999, 4_000,
    ]);
    expect((await journal.append(input(4_001))).position).toBe(4_001);

    const reopened = await createFileRuntimeEventJournal(path);
    expect(await reopened.tail('runtime.lifecycle')).toBe(4_001);
  });

  it('compacts while appending, never passing the cap, and reopens where it left off', async () => {
    const path = await journalFile(1_900);
    const journal = await createFileRuntimeEventJournal(path);
    for (let position = 1_901; position <= 2_300; position++) {
      await journal.append(input(position));
      expect((await stat(path)).size).toBeLessThanOrEqual(256 * 1024);
    }
    const reopened = await createFileRuntimeEventJournal(path);
    expect(await reopened.tail('runtime.lifecycle')).toBe(2_300);
    expect((await reopened.append(input(2_301))).position).toBe(2_301);
  });

  it('holds only the recent window in memory and reads older kept events from the file', async () => {
    const path = await journalFile(RECENT_EVENTS_PER_STREAM + 50);
    const journal = await createFileRuntimeEventJournal(path);
    const oldest = await journal.read('runtime.lifecycle', 0, 3);
    expect(oldest.map((event) => event.position)).toEqual([1, 2, 3]);
    expect(Object.isFrozen(oldest[0]!.payload)).toBe(true);
    const across = await journal.read('runtime.lifecycle', 45, 10);
    expect(across.map((event) => event.position)).toEqual([46, 47, 48, 49, 50, 51, 52, 53, 54, 55]);
  });

  it('still answers a retried append of a recent event with the stored event', async () => {
    const path = await journalFile(0);
    const journal = await createFileRuntimeEventJournal(path);
    const first = await journal.append(input(1));
    expect(await journal.append(input(1))).toEqual(first);
    await expect(journal.append({ ...input(1), payload: { value: 2 } })).rejects.toThrow('Conflicting runtime event ID');
  });
});
