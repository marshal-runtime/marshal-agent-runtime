import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCodexHook } from '../hooks.js';
import type { RuntimeLifecyclePort } from '../ports.js';
import { TranscriptSpool } from '../transcriptSpool.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Codex transcript hook integration', () => {
  it('checkpoints Stop observations without sealing or ending the session', async () => {
    const { root, spool } = await fixture();
    const target = lifecycle();
    const options = { transcriptSpool: spool };
    await handleCodexHook(
      { hook_event_name: 'UserPromptSubmit', session_id: 'live', prompt: 'First prompt.' },
      target,
      options,
    );
    await handleCodexHook(
      { hook_event_name: 'PostToolUse', session_id: 'live', tool_name: 'read', tool_response: 'ok' },
      target,
      options,
    );
    await handleCodexHook(
      { hook_event_name: 'Stop', session_id: 'live', last_assistant_message: 'First answer.' },
      target,
      options,
    );

    const epochId = await spool.openEpochId('live');
    expect(epochId).toEqual(expect.any(String));
    expect(target.observeTurn).toHaveBeenCalledTimes(3);
    expect(target.endSession).not.toHaveBeenCalled();

    await handleCodexHook(
      { hook_event_name: 'UserPromptSubmit', session_id: 'live', prompt: 'Second prompt.' },
      target,
      options,
    );
    vi.mocked(target.observeTurn).mockImplementationOnce(async () => {
      expect((await fs.readdir(path.join(root, 'spool')))
        .filter((name) => name.endsWith('.open.jsonl'))).toHaveLength(1);
      return {};
    });
    await handleCodexHook(
      { hook_event_name: 'SessionEnd', session_id: 'live', reason: 'completed' },
      target,
      options,
    );

    expect(target.observeTurn).toHaveBeenCalledTimes(4);
    expect(target.observeTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'user_message',
      content: 'Second prompt.',
    }));
    expect(target.endSession).toHaveBeenCalledOnce();
    expect(await spool.openEpochId('live')).toBeUndefined();
  });

  it('maps compact session starts to one segment in the existing epoch', async () => {
    const { root, spool } = await fixture();
    const target = lifecycle();
    await handleCodexHook(
      { hook_event_name: 'SessionStart', session_id: 'compact', cwd: root },
      target,
      { transcriptSpool: spool },
    );
    const epochId = await spool.openEpochId('compact');
    await handleCodexHook(
      { hook_event_name: 'UserPromptSubmit', session_id: 'compact', prompt: 'Original evidence.' },
      target,
      { transcriptSpool: spool },
    );
    await handleCodexHook(
      {
        hook_event_name: 'SessionStart',
        session_id: 'compact',
        source: 'compact',
        summary: 'Compacted context summary.',
      },
      target,
      { transcriptSpool: spool },
    );
    expect(await spool.openEpochId('compact')).toBe(epochId);
    const sealed = await spool.seal('compact');
    expect(sealed.compactionSegmentCount).toBe(1);
    expect(await spool.observations(sealed)).toContainEqual(expect.objectContaining({
      toolName: 'transcript.compaction',
      content: 'Compacted context summary.',
    }));
  });

  it('writes bounded child completion references into the parent transcript', async () => {
    const { root, spool } = await fixture();
    const target = lifecycle();
    const options = { transcriptSpool: spool };
    await handleCodexHook(
      { hook_event_name: 'SessionStart', session_id: 'parent', cwd: root },
      target,
      options,
    );
    await handleCodexHook(
      { hook_event_name: 'SubagentStart', session_id: 'parent', subagent_id: 'child' },
      target,
      options,
    );
    expect(target.startSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'child',
      parentSessionId: 'parent',
    }));
    await handleCodexHook(
      {
        hook_event_name: 'SubagentStop',
        session_id: 'parent',
        subagent_id: 'child',
        outcome: 'completed',
        conclusion: 'Child conclusion reference.',
      },
      target,
      options,
    );
    const parent = await spool.seal('parent');
    const completion = (await spool.observations(parent)).find(
      ({ toolName }) => toolName === 'transcript.subagent_end',
    );
    expect(completion).toMatchObject({
      kind: 'tool_result',
      content: {
        childSessionId: 'child',
        childEpochId: expect.any(String),
        descriptorId: expect.any(String),
        idempotencyKey: expect.any(String),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        eventCount: expect.any(Number),
        outcome: 'completed',
        conclusionReference: 'Child conclusion reference.',
      },
    });
    expect(JSON.stringify(completion)).not.toContain('.sealed.jsonl');
  });
});

async function fixture(): Promise<{ readonly root: string; readonly spool: TranscriptSpool }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-transcript-hooks-'));
  roots.push(root);
  return {
    root,
    spool: new TranscriptSpool({ rootDirectory: path.join(root, 'spool') }),
  };
}

function lifecycle(): RuntimeLifecyclePort {
  return {
    startSession: vi.fn(async () => ({})),
    observeTurn: vi.fn(async () => ({})),
    endSession: vi.fn(async () => ({})),
  };
}
