import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectReceipts,
  exportTraceAndReceipts,
  parseRecords,
} from '../demo-capture/export-trace-receipts.mjs';
import {
  buildDerivativeCommands,
  validateEditManifest,
} from '../demo-capture/generate-derivatives.mjs';
import { reconcileAttemptLedger } from '../demo-capture/verify-evidence-set.mjs';

test('trace export preserves canonical events and extracts only existing receipt objects with provenance', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'marshal-trace-export-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'raw-thread.jsonl');
  const target = join(root, 'demo');
  const receipt = { protocolVersion: '1.0.0', receiptId: 'receipt-1', executionId: 'execution-1', target: 'runtime.exec', status: 'success' };
  await writeFile(source, `${JSON.stringify({ event: 'tool', result: { receipt } })}\n${JSON.stringify({ event: 'done' })}\n`);

  const result = await exportTraceAndReceipts(source, target);
  assert.equal(result.manifest.source.format, 'jsonl');
  assert.equal(result.manifest.source.recordCount, 2);
  assert.deepEqual(result.manifest.receiptExtraction.receiptIds, ['receipt-1']);
  assert.equal((await readFile(join(target, 'trace.jsonl'), 'utf8')).split('\n').filter(Boolean).length, 2);
  assert.deepEqual(JSON.parse(await readFile(join(target, 'receipts.export.jsonl'), 'utf8')), receipt);
  assert.match(result.manifest.source.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(() => exportTraceAndReceipts(source, target), /Refusing to overwrite/);
});

test('trace parser rejects malformed JSONL and receipt extraction rejects conflicting duplicate IDs', () => {
  assert.throws(() => parseRecords('{"ok":true}\nnot-json\n'), /line 2/);
  assert.throws(() => collectReceipts([{
    a: { receiptId: 'same', status: 'success', target: 'one' },
    b: { receiptId: 'same', status: 'failed', target: 'two' },
  }]), /Conflicting receipt/);
});

test('derivative command plan discloses every source range and produces deterministic no-overwrite video-only commands', () => {
  const edits = validateEditManifest({
    schemaVersion: '1.0.0',
    demoId: 'ui-actions-and-modes',
    edits: [
      { sourceStartMs: 1250, sourceEndMs: 3500, purpose: 'inline action' },
      { sourceStartMs: 8000, sourceEndMs: 10250, purpose: 'mode outcome' },
    ],
  }, 'ui-actions-and-modes');
  const commands = buildDerivativeCommands(edits);
  for (const args of [commands.gif, commands.mp4]) {
    assert.ok(args.includes('-n'));
    assert.ok(args.includes('-an'));
    assert.ok(args.includes('screen.webm'));
    assert.match(args[args.indexOf('-filter_complex') + 1], /trim=start=1\.250:end=3\.500/);
    assert.match(args[args.indexOf('-filter_complex') + 1], /trim=start=8\.000:end=10\.250/);
    assert.match(args[args.indexOf('-filter_complex') + 1], /concat=n=2:v=1:a=0/);
  }
  assert.ok(commands.mp4.includes('+bitexact'));
  assert.throws(() => validateEditManifest({ schemaVersion: '1.0.0', demoId: 'x', edits: [] }, 'x'), /at least one edit/);
});

test('derivative commands produce real GIF and MP4 media when external FFmpeg is available', async (context) => {
  const available = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', shell: false, windowsHide: true });
  if (available.status !== 0) return context.skip('external FFmpeg is not installed');
  const root = await mkdtemp(join(tmpdir(), 'marshal-ffmpeg-smoke-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-t', '3', '-an', '-c:v', 'libvpx-vp9', 'screen.webm',
  ], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(source.status, 0, source.stderr);
  const commands = buildDerivativeCommands([
    { sourceStartMs: 200, sourceEndMs: 1000, purpose: 'first' },
    { sourceStartMs: 1600, sourceEndMs: 2400, purpose: 'second' },
  ]);
  for (const args of [commands.gif, commands.mp4]) {
    const result = spawnSync('ffmpeg', args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const { validMediaSignature } = await import('../demo-capture/verify-evidence.mjs');
  assert.equal(validMediaSignature(await readFile(join(root, '.marshal-preview.tmp.gif')), 'gif'), true);
  assert.equal(validMediaSignature(await readFile(join(root, '.marshal-short.tmp.mp4')), 'mp4'), true);
});

test('aggregate ledger reconciles every demo attempt and preserves failed outcomes without turning them into passes', () => {
  const manifest = {
    attempts: [
      { bundle: 'round-1', demoId: 'ordinary-typescript', captureAttemptId: 'attempt-a', outcome: 'succeeded', notes: [] },
      { bundle: 'round-1', demoId: 'ui-actions-and-modes', captureAttemptId: 'attempt-b', outcome: 'failed', notes: ['typed host denial'] },
    ],
  };
  const result = reconcileAttemptLedger(manifest, [{
    bundle: 'round-1',
    verification: {
      index: { attempts: [
        { demoId: 'ordinary-typescript', captureAttemptId: 'attempt-a', files: [] },
        { demoId: 'ui-actions-and-modes', captureAttemptId: 'attempt-b', files: [] },
      ] },
    },
  }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.attempts.find((item) => item.captureAttemptId === 'attempt-b').outcome, 'failed');

  const omitted = reconcileAttemptLedger({ attempts: manifest.attempts.slice(0, 1) }, [{
    bundle: 'round-1',
    verification: { index: { attempts: [
      { demoId: 'ordinary-typescript', captureAttemptId: 'attempt-a', files: [] },
      { demoId: 'ui-actions-and-modes', captureAttemptId: 'attempt-b', files: [] },
    ] } },
  }]);
  assert.ok(omitted.errors.some((error) => error.includes('absent from all-attempt ledger')));
});
