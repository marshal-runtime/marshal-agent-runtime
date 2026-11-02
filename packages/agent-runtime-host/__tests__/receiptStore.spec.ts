import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeExecutionCorrelation,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeExecutionReceipt,
} from '@marshal/agent-runtime-core';
import { BoundedFileRuntimeReceiptStore } from '../src/index.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

function receipt(
  executionId: string,
  rootExecutionId = executionId,
  parentExecutionId?: string,
): RuntimeExecutionReceipt {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    receiptId: `receipt-${executionId}`,
    executionId,
    target: 'test.run',
    principalId: 'agent-1',
    lineage: {
      rootExecutionId,
      ...(parentExecutionId ? { parentExecutionId } : {}),
      depth: parentExecutionId ? 1 : 0,
    },
    status: 'success',
    startedAt: `2026-01-01T00:00:0${executionId.length}.000Z`,
    completedAt: `2026-01-01T00:00:0${executionId.length}.001Z`,
    durationMs: 1,
  };
}

describe('BoundedFileRuntimeReceiptStore', () => {
  it('survives restart, deduplicates receipt delivery, and reconstructs a tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-receipts-'));
    cleanup.push(root);
    const filePath = path.join(root, 'receipts.jsonl');
    const correlations = [
      createRuntimeExecutionCorrelation('mcpRequestId', 7),
      createRuntimeExecutionCorrelation(
        'codexToolUseId',
        `${'shared-prefix-'.padEnd(513, 'x')}a`,
      ),
    ];
    const first = new BoundedFileRuntimeReceiptStore({ filePath });
    await first.record({ ...receipt('root'), correlations });
    await first.record(receipt('child', 'root', 'root'));
    await first.record(receipt('child', 'root', 'root'));

    const restarted = new BoundedFileRuntimeReceiptStore({ filePath });
    const restartedReceipts = await restarted.list({ rootExecutionId: 'root' });
    expect(restartedReceipts).toHaveLength(2);
    expect(restartedReceipts[0]?.correlations).toEqual(correlations);
    const tree = await restarted.tree('root');
    expect(tree.roots[0]?.receipt.executionId).toBe('root');
    expect(tree.roots[0]?.children[0]?.receipt.executionId).toBe('child');
    expect(tree.orphans).toEqual([]);
  });

  it('compacts to the configured entry bound', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-receipts-'));
    cleanup.push(root);
    const store = new BoundedFileRuntimeReceiptStore({
      filePath: path.join(root, 'receipts.jsonl'),
      maxEntries: 2,
    });
    await store.record(receipt('one'));
    await store.record(receipt('two'));
    await store.record(receipt('three'));
    expect((await store.list()).map((item) => item.executionId)).toEqual(['two', 'three']);
  });

  it('compacts in batches while listing only the bound', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marshal-receipts-'));
    cleanup.push(root);
    const filePath = path.join(root, 'receipts.jsonl');
    const store = new BoundedFileRuntimeReceiptStore({ filePath, maxEntries: 20 });
    const lineCount = async () => (await fs.readFile(filePath, 'utf8')).trim().split('\n').length;
    for (let index = 0; index < 22; index += 1) await store.record(receipt(`exec-${index}`));
    expect(await lineCount()).toBe(22);
    expect(await store.list()).toHaveLength(20);
    expect((await store.list()).at(0)?.executionId).toBe('exec-2');

    await store.record(receipt('exec-22'));
    expect(await lineCount()).toBe(20);
    const restarted = new BoundedFileRuntimeReceiptStore({ filePath, maxEntries: 20 });
    await restarted.record(receipt('exec-22'));
    expect((await restarted.list()).map((item) => item.executionId).at(-1)).toBe('exec-22');
    expect(await lineCount()).toBe(20);
  });
});
