import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION, type InvocationContext } from '@marshal/agent-runtime-core';

const race = vi.hoisted(() => ({
  target: '',
  replacement: '',
  mutation: '',
  mode: 'replacement' as 'replacement' | 'mutation',
  armed: false,
  mutatedDescriptor: undefined as number | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (target: Parameters<typeof actual.openSync>[0], ...args: unknown[]) => {
      if (race.armed && race.mode === 'replacement' && String(target) === race.target) {
        race.armed = false;
        actual.renameSync(race.target, `${race.target}.original`);
        actual.renameSync(race.replacement, race.target);
      }
      const descriptor = (actual.openSync as (...values: unknown[]) => number)(target, ...args);
      if (race.armed && race.mode === 'mutation' && String(target) === race.target) {
        race.armed = false;
        race.mutatedDescriptor = descriptor;
      }
      return descriptor;
    },
    readFileSync: (source: unknown, ...args: unknown[]) => {
      const result = (actual.readFileSync as (...values: unknown[]) => unknown)(source, ...args);
      if (race.mutatedDescriptor !== undefined && source === race.mutatedDescriptor) {
        race.mutatedDescriptor = undefined;
        actual.writeFileSync(race.target, race.mutation, 'utf8');
      }
      return result;
    },
  };
});

const fs = await import('node:fs/promises');
const { BackgroundJobManager, BoundedFileJobStore } = await import('../src/jobs.js');
const roots: string[] = [];

afterEach(async () => {
  race.target = '';
  race.replacement = '';
  race.mutation = '';
  race.mode = 'replacement';
  race.armed = false;
  race.mutatedDescriptor = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('durable job stable-file reads', () => {
  it('rejects a pathname replacement between lstat and open', async () => {
    const rootDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-job-race-')));
    roots.push(rootDirectory);
    const store = new BoundedFileJobStore({ rootDirectory });
    const manager = new BackgroundJobManager({ store });
    const context: InvocationContext = {
      principal: { id: 'job-race-principal', kind: 'agent' },
      identity: { harnessId: 'test', agentId: 'job-race-agent' },
      scope: { workspaceId: 'job-race-workspace', projectId: 'job-race-project', sessionId: 'job-race-session' },
    };
    const queued = await manager.enqueue({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'race.test',
      idempotencyKey: 'race-key',
      input: { value: 1 },
    }, context);
    race.target = path.join(rootDirectory, `${queued.handle!.jobId}.json`);
    race.replacement = path.join(rootDirectory, 'attacker.json');
    await fs.writeFile(race.replacement, JSON.stringify({ secret: 'ATTACKER-CANARY' }), 'utf8');
    race.armed = true;

    await expect(store.get(queued.handle!.jobId)).rejects.toMatchObject({ code: 'JOB_RECORD_IDENTITY_CHANGED' });
  });

  it('rejects a same-inode content mutation during the descriptor read', async () => {
    const rootDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-job-mutation-')));
    roots.push(rootDirectory);
    const store = new BoundedFileJobStore({ rootDirectory });
    const manager = new BackgroundJobManager({ store });
    const context: InvocationContext = {
      principal: { id: 'job-race-principal', kind: 'agent' },
      identity: { harnessId: 'test', agentId: 'job-race-agent' },
      scope: { workspaceId: 'job-race-workspace', projectId: 'job-race-project', sessionId: 'job-race-session' },
    };
    const queued = await manager.enqueue({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      kind: 'race.test',
      idempotencyKey: 'mutation-key',
      input: { value: 1 },
    }, context);
    race.target = path.join(rootDirectory, `${queued.handle!.jobId}.json`);
    const original = await fs.readFile(race.target, 'utf8');
    const before = await fs.lstat(race.target);
    race.mutation = original.replace('"queued"', '"failed"');
    expect(Buffer.byteLength(race.mutation)).toBe(Buffer.byteLength(original));
    race.mode = 'mutation';
    race.armed = true;

    await expect(store.get(queued.handle!.jobId))
      .rejects.toMatchObject({ code: 'JOB_RECORD_IDENTITY_CHANGED' });
    expect((await fs.lstat(race.target)).ino).toBe(before.ino);
  });
});
