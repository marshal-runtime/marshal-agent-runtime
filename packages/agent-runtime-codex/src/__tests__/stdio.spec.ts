import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('standalone Codex MCP executable', () => {
  it('serves runtime and lifecycle calls over real stdio', async () => {
    const diagnosticRoot = await mkdtemp(join(tmpdir(), 'marshal-stdio-diagnostics-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve(packageRoot, 'dist/cli.js'),
        '--kernel-module',
        resolve(packageRoot, 'dist/__tests__/fixtures/fakeRuntimeBindings.js'),
        '--workspace',
        'C:/stdio-workspace',
      ],
      cwd: packageRoot,
      stderr: 'pipe',
      env: { MARSHAL_RUNTIME_DIAGNOSTIC_ROOT: diagnosticRoot },
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('runtime_exec');

      const started = await client.callTool({
        name: 'runtime_session_start',
        arguments: { sessionId: 'stdio-session' },
      });
      expect(started.structuredContent).toEqual({
        sessionId: 'stdio-session',
        observed: true,
        lifecycleResult: { memoryContext: ['stdio fixture memory'] },
      });

      const searched = await client.callTool({
        name: 'runtime_search',
        arguments: { query: 'stdio fixture' },
      });
      expect(searched.structuredContent).toEqual({
        result: [expect.objectContaining({ name: 'test.echo' })],
      });

      const executed = await client.callTool({
        name: 'runtime_exec',
        arguments: {
          targetType: 'operation',
          target: 'test.echo',
          input: { through: 'stdio' },
        },
      });
      expect(executed.structuredContent).toEqual({ echoed: { through: 'stdio' } });
    } finally {
      await client.close();
      await expect.poll(() => {
        const journal = readdirSync(diagnosticRoot).find((name) => name.endsWith('.jsonl'));
        return journal ? readFileSync(join(diagnosticRoot, journal), 'utf8') : '';
      }).toContain('"event":"process_exit"');
      const journal = readdirSync(diagnosticRoot).find((name) => name.endsWith('.jsonl'))!;
      const events = readFileSync(join(diagnosticRoot, journal), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event);
      expect(events).toEqual([
        'process_start',
        'server_ready',
        'shutdown_started',
        'shutdown_complete',
        'process_exit',
      ]);
      await rm(diagnosticRoot, { force: true, recursive: true });
    }
  });

  it('persists a redacted top-level startup failure before exiting', async () => {
    const diagnosticRoot = await mkdtemp(join(tmpdir(), 'marshal-stdio-failure-'));
    try {
      const child = spawn(process.execPath, [resolve(packageRoot, 'dist/cli.js'), '--invalid'], {
        cwd: packageRoot,
        env: {
          ...process.env,
          MARSHAL_RUNTIME_DIAGNOSTIC_ROOT: diagnosticRoot,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
        child.once('error', reject);
        child.once('close', resolvePromise);
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown argument');

      const journal = readdirSync(diagnosticRoot).find((name) => name.endsWith('.jsonl'))!;
      const records = readFileSync(join(diagnosticRoot, journal), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.event)).toEqual([
        'process_start',
        'top_level_error',
        'process_exit',
      ]);
      expect(records[1]).toMatchObject({
        errorName: 'Error',
        messageBytes: expect.any(Number),
        errorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(records)).not.toContain('invalid');
      expect(JSON.stringify(records)).not.toContain('Unknown argument');
    } finally {
      await rm(diagnosticRoot, { force: true, recursive: true });
    }
  });
});
