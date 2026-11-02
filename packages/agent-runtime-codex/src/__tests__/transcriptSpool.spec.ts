import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptSpool } from '../transcriptSpool.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-transcript-'));
  roots.push(root);
  return root;
}

describe('TranscriptSpool', () => {
  it('orders bounded JSONL events and seals idempotently', async () => {
    const root = await createRoot();
    const spool = new TranscriptSpool({
      rootDirectory: path.join(root, 'spool'),
      maxEventBytes: 4_096,
      maxEpochBytes: 32_768,
      maxEpochEvents: 10,
    });
    const input = {
      eventId: 'event-1',
      sessionId: 'session-1',
      kind: 'user_message' as const,
      content: 'hello',
    };
    const first = await spool.append(input);
    const duplicate = await spool.append(input);
    expect(duplicate).toMatchObject({ epochId: first.epochId, sequence: first.sequence, duplicate: true });

    await spool.append({
      eventId: 'event-2',
      sessionId: 'session-1',
      kind: 'assistant_turn',
      content: 'world',
    });
    const sealed = await spool.seal('session-1');
    expect(await spool.seal('session-1')).toEqual(sealed);
    expect(sealed.eventCount).toBe(2);
    expect(sealed.sha256).toMatch(/^[a-f0-9]{64}$/);

    const lines = (await fs.readFile(sealed.sealedPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { sequence: number });
    expect(lines.map((line) => line.sequence)).toEqual([0, 1, 2]);
  });

  it('reuses a terminal event seal after restart without weakening event identity', async () => {
    const root = await createRoot();
    const rootDirectory = path.join(root, 'spool');
    const first = new TranscriptSpool({ rootDirectory });
    await first.append({
      eventId: 'message',
      sessionId: 'replayed-session',
      kind: 'user_message',
      content: 'preserve this epoch',
    });
    const ending = {
      eventId: 'session-end',
      sessionId: 'replayed-session',
      kind: 'session_end' as const,
      content: 'completed',
    };
    const sealed = await first.sealWithEvent(ending);
    const restarted = new TranscriptSpool({ rootDirectory });

    expect(await restarted.sealWithEvent(ending)).toEqual(sealed);
    await expect(restarted.sealWithEvent({
      ...ending,
      content: 'different',
    })).rejects.toThrow(/collision/);
    expect((await fs.readdir(rootDirectory)).filter((name) => name.endsWith('.seal.json')))
      .toHaveLength(1);
  });

  it('rejects event collisions, oversized events, and symlink roots', async () => {
    const root = await createRoot();
    const spool = new TranscriptSpool({
      rootDirectory: path.join(root, 'spool'),
      maxEventBytes: 512,
      maxEpochBytes: 1_024,
    });
    await spool.append({
      eventId: 'collision',
      sessionId: 'session-2',
      kind: 'user_message',
      content: 'one',
    });
    await expect(spool.append({
      eventId: 'collision',
      sessionId: 'session-2',
      kind: 'user_message',
      content: 'two',
    })).rejects.toThrow(/collision/);
    await expect(spool.append({
      eventId: 'large',
      sessionId: 'session-2',
      kind: 'user_message',
      content: 'x'.repeat(2_000),
    })).rejects.toThrow(/exceeds/);

    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    await fs.mkdir(target);
    await fs.symlink(target, link, 'junction');
    await expect(new TranscriptSpool({ rootDirectory: link }).append({
      eventId: 'unsafe',
      sessionId: 'session-3',
      kind: 'user_message',
      content: 'x',
    })).rejects.toThrow(/real directory|symbolic link|junction/);
  });

  it('recovers stale open epochs as abandoned descriptors', async () => {
    const root = await createRoot();
    let now = new Date();
    const spool = new TranscriptSpool({
      rootDirectory: path.join(root, 'spool'),
      staleAfterMs: 1_000,
      now: () => now,
    });
    await spool.append({
      eventId: 'stale',
      sessionId: 'session-4',
      kind: 'user_message',
      content: 'recover me',
    });
    now = new Date(now.getTime() + 60_000);
    const recovered = await spool.recoverAbandoned();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      kind: 'transcript_abandoned',
      sessionId: 'session-4',
    });
    await expect(spool.seal('session-4')).rejects.toThrow(/No open transcript epoch/);
  });

  it('recovers a stale lock only when its recorded owner process is dead', async () => {
    const root = await createRoot();
    const rootDirectory = path.join(root, 'spool');
    await fs.mkdir(rootDirectory);
    const deadOwner = spawn(process.execPath, ['--eval', 'process.exit(0)']);
    const deadOwnerPid = deadOwner.pid;
    if (!deadOwnerPid) throw new Error('Expected the child process to have a PID.');
    await new Promise<void>((resolve, reject) => {
      deadOwner.once('exit', () => resolve());
      deadOwner.once('error', reject);
    });
    const lockPath = path.join(rootDirectory, '.spool.lock');
    await fs.writeFile(lockPath, `${deadOwnerPid}\n`, 'utf8');

    await new TranscriptSpool({ rootDirectory }).append({
      eventId: 'after-stale-lock',
      sessionId: 'stale-lock-session',
      kind: 'user_message',
      content: 'recovered',
    });

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains contention when the recorded lock owner process is alive', async () => {
    const root = await createRoot();
    const rootDirectory = path.join(root, 'spool');
    await fs.mkdir(rootDirectory);
    const lockPath = path.join(rootDirectory, '.spool.lock');
    await fs.writeFile(lockPath, `${process.pid}\n`, 'utf8');

    await expect(new TranscriptSpool({ rootDirectory }).append({
      eventId: 'during-live-lock',
      sessionId: 'live-lock-session',
      kind: 'user_message',
      content: 'must remain blocked',
    })).rejects.toThrow('Transcript spool lock could not be acquired.');
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(`${process.pid}\n`);
  });

  it('resumes abandoned delivery after the durable per-epoch cursor', async () => {
    const root = await createRoot();
    let now = new Date();
    const rootDirectory = path.join(root, 'spool');
    const spool = new TranscriptSpool({
      rootDirectory,
      staleAfterMs: 1_000,
      now: () => now,
    });
    const first = await spool.append({
      eventId: 'first',
      sessionId: 'cursor-session',
      kind: 'user_message',
      content: 'already delivered',
    });
    const delivered: string[] = [];
    await spool.deliverUndelivered({
      sessionId: 'cursor-session',
      epochId: first.epochId,
    }, async ({ eventId }) => {
      delivered.push(eventId);
    });
    await spool.append({
      eventId: 'second',
      sessionId: 'cursor-session',
      kind: 'assistant_turn',
      content: 'still pending',
    });

    now = new Date(now.getTime() + 60_000);
    const [abandoned] = await new TranscriptSpool({
      rootDirectory,
      staleAfterMs: 1_000,
      now: () => now,
    }).recoverAbandoned();
    if (!abandoned) throw new Error('Expected an abandoned transcript descriptor.');
    await spool.deliverUndelivered(abandoned, async ({ eventId }) => {
      delivered.push(eventId);
    });
    await spool.deliverUndelivered(abandoned, async ({ eventId }) => {
      delivered.push(eventId);
    });

    expect(delivered).toEqual(['first', 'second']);
  });

  it('keeps compaction segments in one epoch with bounded original ranges', async () => {
    const root = await createRoot();
    const spool = new TranscriptSpool({ rootDirectory: path.join(root, 'spool') });
    await spool.startSession({ eventId: 'start', sessionId: 'compact-session' });
    await spool.append({
      eventId: 'message-1',
      sessionId: 'compact-session',
      kind: 'user_message',
      content: 'Keep the original evidence.',
    });
    const segment = await spool.appendCompactionSegment({
      eventId: 'compact-1',
      sessionId: 'compact-session',
      segmentId: 'segment-1',
      summary: 'Bounded compaction summary.',
    });
    const sealed = await spool.seal('compact-session');
    const observations = await spool.observations(sealed);

    expect(segment.epochId).toBe((await spool.seal('compact-session')).epochId);
    expect(sealed.compactionSegmentCount).toBe(1);
    expect(observations).toContainEqual(expect.objectContaining({
      eventId: 'compact-1',
      kind: 'tool_result',
      toolName: 'transcript.compaction',
      content: 'Bounded compaction summary.',
      metadata: expect.objectContaining({
        compactionSegment: 1,
        compactionSegmentId: 'segment-1',
        compactionFromSequence: 1,
        compactionToSequence: 2,
      }),
    }));
  });
});
