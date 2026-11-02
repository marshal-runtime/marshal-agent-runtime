import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCommandWakePort,
  createHttpWakePort,
  wakePayload,
  type AgentWakeRequest,
} from '../src/index.js';

const request: AgentWakeRequest = {
  target: { sessionId: 'session-1' },
  message: 'check the deploy',
  fire: {
    fireId: 'fire-1',
    scheduleId: 'sch-1',
    scheduledFor: '2026-10-26T10:00:00.000Z',
    attempt: 1,
    principalId: 'agent-a',
    scope: { workspaceId: 'workspace-a' },
    timing: { kind: 'once', at: '2026-10-26T10:00:00.000Z' },
    task: { kind: 'agent.wake' },
  },
};

const cleanup: string[] = [];
afterEach(async () => {
  for (const target of cleanup.splice(0)) await fs.rm(target, { recursive: true, force: true });
});

describe('wake ports', () => {
  it('runs the host command with the wake on stdin and in the environment', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-port-'));
    cleanup.push(dir);
    const out = path.join(dir, 'out.json');
    const script =
      "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],JSON.stringify({b:JSON.parse(b),s:process.env.MARSHAL_WAKE_SESSION_ID,m:process.env.MARSHAL_WAKE_MESSAGE,a:process.env.MARSHAL_WAKE_AGENT_ID})))";
    await createCommandWakePort({ command: [process.execPath, '-e', script, out] }).wake(request);
    expect(JSON.parse(await fs.readFile(out, 'utf8'))).toEqual({
      b: wakePayload(request),
      s: 'session-1',
      m: 'check the deploy',
      a: '',
    });
  });

  it('rejects when the command exits non-zero, cannot start, or runs too long', async () => {
    await expect(
      createCommandWakePort({ command: [process.execPath, '-e', 'console.error("no"); process.exit(3)'] }).wake(request),
    ).rejects.toThrow('exited 3: no');
    await expect(createCommandWakePort({ command: ['/nonexistent/wake-binary'] }).wake(request)).rejects.toThrow();
    await expect(
      createCommandWakePort({ command: [process.execPath, '-e', 'setTimeout(()=>{},5000)'], timeoutMs: 100 }).wake(request),
    ).rejects.toThrow('exceeded');
  });

  it('posts the wake as JSON and treats only 2xx as delivered', async () => {
    const send = vi.fn(async () => new Response('ok', { status: 202 }));
    await createHttpWakePort({ url: 'https://example.test/wake', headers: { authorization: 'Bearer t' }, fetch: send }).wake(request);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/wake');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
    expect(JSON.parse(String(init.body))).toEqual(wakePayload(request));
    const failing = vi.fn(async () => new Response('no', { status: 503 }));
    await expect(createHttpWakePort({ url: 'https://example.test/wake', fetch: failing }).wake(request)).rejects.toThrow('503');
  });
});
