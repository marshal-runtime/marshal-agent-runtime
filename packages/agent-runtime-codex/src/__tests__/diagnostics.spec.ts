import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCodexAdapterDiagnostics,
  safeErrorIdentity,
} from '../diagnostics.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('Codex adapter process diagnostics', () => {
  it('writes only bounded metadata and fingerprints errors without persisting secrets', async () => {
    const root = await temporaryRoot();
    const diagnostics = createCodexAdapterDiagnostics({
      rootPath: root,
      now: () => new Date('2026-08-03T15:19:49.859Z'),
      uptime: () => 12.345,
      pid: 31415,
    });
    const secret = 'authorization=Bearer super-secret-token C:/Users/private/workspace';
    diagnostics.record('top_level_error', {
      ...safeErrorIdentity(Object.assign(new Error(secret), { code: 'EPIPE' })),
      workspacePath: secret,
      arbitrary: secret,
    });

    const content = readFileSync(diagnostics.filePath, 'utf8');
    expect(content).not.toContain('super-secret-token');
    expect(content).not.toContain('Users/private');
    expect(JSON.parse(content)).toMatchObject({
      version: 1,
      timestamp: '2026-08-03T15:19:49.859Z',
      event: 'top_level_error',
      pid: 31415,
      uptimeMs: 12345,
      errorName: 'Error',
      errorCode: 'EPIPE',
      messageBytes: Buffer.byteLength(secret),
      errorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('keeps a bounded number of process journals', async () => {
    const root = await temporaryRoot();
    mkdirSync(root, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      const path = join(root, `adapter-process-${index + 1}-${index + 1}.jsonl`);
      writeFileSync(path, '{}\n');
      const old = new Date(1_000 + index * 1_000);
      utimesSync(path, old, old);
    }

    const diagnostics = createCodexAdapterDiagnostics({
      rootPath: root,
      maxFiles: 3,
      pid: 99,
      now: () => new Date(9_999),
    });
    diagnostics.record('process_start');

    const journals = readdirSync(root).filter((name) => name.startsWith('adapter-process-'));
    expect(journals).toHaveLength(3);
    expect(journals).toContain('adapter-process-99-9999.jsonl');
    expect(journals).not.toContain('adapter-process-1-1.jsonl');
    expect(journals).not.toContain('adapter-process-2-2.jsonl');
    expect(journals).not.toContain('adapter-process-3-3.jsonl');
  });

  it('drops records that would cross the per-process byte limit', async () => {
    const root = await temporaryRoot();
    const diagnostics = createCodexAdapterDiagnostics({
      rootPath: root,
      maxFileBytes: 180,
      pid: 7,
      now: () => new Date(7),
      uptime: () => 0,
    });
    diagnostics.record('process_start');
    diagnostics.record('server_ready');
    const lines = readFileSync(diagnostics.filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'marshal-codex-diagnostics-'));
  temporaryRoots.push(root);
  return root;
}
