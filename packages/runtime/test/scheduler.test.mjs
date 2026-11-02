import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MCP_CLI = new URL('../dist/mcp-cli.js', import.meta.url).pathname;
const SCHEDULER_CLI = new URL('../dist/scheduler-cli.js', import.meta.url).pathname;
const WAKE_DELAY_MS = 2_500;
const WAKE_DEADLINE_MS = 20_000;
const POLL_MS = 100;
const TICK_MS = 200;
const SESSION_ID = 'session-the-agent-set-this-from';
const WAKE_MESSAGE = 'check the deploy and report';

async function waitFor(read, description) {
  const deadline = Date.now() + WAKE_DEADLINE_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

test('a wakeup an agent schedules through the runtime fires from the scheduler daemon after the agent session ended', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'marshal-runtime-schedule-')));
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const scheduleRoot = join(root, 'schedules');
  const wakeLog = join(root, 'wakes.jsonl');
  const wakeScript = join(root, 'record-wake.mjs');
  await writeFile(
    wakeScript,
    "import { appendFileSync } from 'node:fs'; let body = '';"
      + "process.stdin.on('data', (chunk) => { body += chunk; });"
      + "process.stdin.on('end', () => appendFileSync(process.argv[2], JSON.stringify({ firedAt: new Date().toISOString(),"
      + " env: { sessionId: process.env.MARSHAL_WAKE_SESSION_ID, message: process.env.MARSHAL_WAKE_MESSAGE }, body: JSON.parse(body) }) + '\\n'));",
  );
  const daemon = spawn(process.execPath, [SCHEDULER_CLI], {
    env: {
      ...process.env,
      MARSHAL_RUNTIME_SCHEDULER_CONFIG: JSON.stringify({
        rootDirectory: scheduleRoot,
        tickMs: TICK_MS,
        wake: { command: [process.execPath, wakeScript, wakeLog] },
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let daemonOutput = '';
  daemon.stdout.on('data', (chunk) => { daemonOutput += chunk; });
  daemon.stderr.on('data', (chunk) => { daemonOutput += chunk; });
  try {
    await waitFor(() => (daemonOutput.includes('"event":"started"') ? true : undefined), 'the scheduler daemon');

    const client = new Client({ name: 'agent', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [MCP_CLI],
      env: {
        ...process.env,
        MARSHAL_RUNTIME_MCP_CONFIG: JSON.stringify({
          workspacePath, privateRoot: join(root, 'private'), principalId: 'agent-1',
          harnessId: 'generic-test', sessionId: 'session-a', codeIntelligence: false,
          permissionPatterns: ['runtime.schedules.create', 'runtime.schedules.read'],
          schedule: { rootDirectory: scheduleRoot },
        }),
      },
    }));
    const createdAt = Date.now();
    const created = await client.callTool({ name: 'runtime_exec', arguments: {
      targetType: 'operation', target: 'runtime.schedules.create',
      input: {
        idempotencyKey: 'wake-me-once',
        timing: { kind: 'once', at: new Date(createdAt + WAKE_DELAY_MS).toISOString() },
        task: { kind: 'agent.wake', input: { target: { sessionId: SESSION_ID }, message: WAKE_MESSAGE } },
      },
    } });
    assert.equal(created.structuredContent.status, 'success', JSON.stringify(created.structuredContent));
    const schedule = created.structuredContent.result.output.output;
    assert.equal(schedule.state, 'active');

    const listed = await client.callTool({ name: 'runtime_exec', arguments: {
      targetType: 'operation', target: 'runtime.schedules.list', input: {},
    } });
    assert.equal(listed.structuredContent.result.output.output.schedules.length, 1);
    await client.close();

    const fired = JSON.parse(await waitFor(async () => {
      const text = await readFile(wakeLog, 'utf8').catch(() => '');
      return text.trim() ? text.trim().split('\n')[0] : undefined;
    }, 'the wake'));
    assert.equal(fired.body.scheduleId, schedule.scheduleId);
    assert.equal(fired.body.principalId, 'agent-1');
    assert.deepEqual(fired.body.target, { sessionId: SESSION_ID });
    assert.equal(fired.body.message, WAKE_MESSAGE);
    assert.equal(fired.env.sessionId, SESSION_ID);
    assert.ok(Date.parse(fired.firedAt) >= createdAt + WAKE_DELAY_MS - 1_000);
    assert.ok(Date.parse(fired.firedAt) < createdAt + WAKE_DELAY_MS + 10_000);

    await new Promise((resolve) => setTimeout(resolve, TICK_MS * 4));
    const lines = (await readFile(wakeLog, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1, 'a one-off wakeup fires exactly once');
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((resolve) => daemon.once('close', resolve));
    await rm(root, { recursive: true, force: true });
  }
});
