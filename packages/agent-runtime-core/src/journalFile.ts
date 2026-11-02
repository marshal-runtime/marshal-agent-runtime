import { createReadStream, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// The event journal is JSON Lines: an append writes one line, so its cost no longer
// grows with the journal. Journals written before this change are one JSON array.

/** The journal file never grows past this; a 509 MB journal once took the main process out of memory. */
export const MAX_JOURNAL_FILE_BYTES = 10 * 1024 * 1024;
/** What a compaction keeps (the newest events), so compactions stay rare. */
export const COMPACTED_JOURNAL_BYTES = 5 * 1024 * 1024;

export interface ScannedJournalFile {
  readonly bytes: number;
  /** The file is a legacy array or ends in an unterminated line, and should be rewritten as JSON Lines. */
  readonly rewrite: boolean;
}

/** Streams the journal's entries in file order without holding the file as one string. */
export async function scanJournalFile(
  path: string,
  onEntry: (entry: unknown, text: string) => void,
): Promise<ScannedJournalFile | undefined> {
  let size: number;
  let legacy: boolean;
  try {
    const handle = await fs.open(path, 'r');
    try {
      size = (await handle.stat()).size;
      const probe = Buffer.alloc(Math.min(size, 256));
      await handle.read(probe, 0, probe.length, 0);
      legacy = probe.toString('utf8').trimStart().startsWith('[');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (legacy) {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('Journal root must be an array.');
    for (const entry of parsed) onEntry(entry, JSON.stringify(entry));
    return { bytes: size, rewrite: true };
  }
  let rest = '';
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    const lines = (rest + (chunk as string)).split('\n');
    rest = lines.pop()!;
    for (const line of lines) {
      const text = line.trim();
      if (text) onEntry(JSON.parse(text), text);
    }
  }
  const tail = rest.trim();
  if (!tail) return { bytes: size, rewrite: false };
  // Only an unterminated final line can be a crash mid-append; it is kept if whole, dropped if torn.
  let entry: unknown;
  try {
    entry = JSON.parse(tail);
  } catch {
    return { bytes: size, rewrite: true };
  }
  onEntry(entry, tail);
  return { bytes: size, rewrite: true };
}

/** Atomically replaces the journal with these serialized entries; returns the new file size. */
export async function rewriteJournalLines(path: string, lines: readonly string[]): Promise<number> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.rewrite.tmp`;
  const handle = await fs.open(temporaryPath, 'w');
  let bytes = 0;
  try {
    for (let start = 0; start < lines.length; start += 1_000) {
      const text = lines.slice(start, start + 1_000).map((line) => `${line}\n`).join('');
      bytes += Buffer.byteLength(text);
      await handle.write(text);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, path);
  await syncDirectory(dirname(path));
  return bytes;
}

export class JournalFileAppender {
  #handle: fs.FileHandle | undefined;

  constructor(private readonly path: string) {}

  async appendLine(text: string): Promise<void> {
    if (!this.#handle) {
      await fs.mkdir(dirname(this.path), { recursive: true });
      this.#handle = await fs.open(this.path, 'a');
      await syncDirectory(dirname(this.path));
    }
    await this.#handle.write(`${text}\n`);
    await this.#handle.sync();
  }

  /** A rewrite replaces the file; the next append must open the new one, not the old inode. */
  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close();
  }
}

/** Removes temp files that dead processes left mid-rewrite (each a full journal copy). */
export async function removeAbandonedJournalTemporaries(path: string): Promise<void> {
  const prefix = `${basename(path)}.`;
  let names: string[];
  try {
    names = await fs.readdir(dirname(path));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const pid = Number(name.slice(prefix.length).split('.')[0]);
    if (!Number.isSafeInteger(pid) || pid === process.pid || processIsAlive(pid)) continue;
    await fs.rm(join(dirname(path), name), { force: true }).catch(() => undefined);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const directory = await fs.open(directoryPath, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the file itself was synced.
  }
}
