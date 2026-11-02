import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ target: '', mutation: '', armed: false, opens: 0, mtimeDriftMs: 5_000 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (target: Parameters<typeof actual.open>[0], ...args: unknown[]) => {
      const handle = await (actual.open as (...values: unknown[]) => Promise<Awaited<ReturnType<typeof actual.open>>>)(target, ...args);
      if (String(target) === race.target) race.opens += 1;
      if (race.armed && String(target) === race.target) {
        race.armed = false;
        const readFile = handle.readFile.bind(handle) as (...values: unknown[]) => Promise<unknown>;
        Object.defineProperty(handle, 'readFile', {
          configurable: true,
          value: async (...readArgs: unknown[]) => {
            const result = await readFile(...readArgs);
            await actual.writeFile(race.target, race.mutation, 'utf8');
            const drifted = new Date(Date.now() + race.mtimeDriftMs);
            await actual.utimes(race.target, drifted, drifted);
            return result;
          },
        });
      }
      return handle;
    },
  };
});

const fs = await import('node:fs/promises');
const { readContainedFileStable } = await import('../pathSafety.js');
const roots: string[] = [];

afterEach(async () => {
  race.target = '';
  race.mutation = '';
  race.armed = false;
  race.opens = 0;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('bounded UI stable-file reads', () => {
  it('retries same-inode snapshot drift instead of returning the stale read', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-ui-stable-read-')));
    roots.push(root);
    race.target = path.join(root, 'owner.json');
    const original = '{"owner":"alpha"}';
    race.mutation = '{"owner":"bravo"}';
    await fs.writeFile(race.target, original, 'utf8');
    const before = await fs.lstat(race.target);
    race.armed = true;

    await expect(readContainedFileStable(root, race.target, 'UI owner record')).resolves.toBe(race.mutation);
    expect(race.opens).toBeGreaterThanOrEqual(2);
    expect((await fs.lstat(race.target)).ino).toBe(before.ino);
  });
});
