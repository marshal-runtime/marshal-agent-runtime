import { describe, expect, it } from 'vitest';
import {
  buildRuntimeReceiptForest,
  createRuntimeExecutionCorrelation,
  normalizeRuntimeExecutionCorrelations,
  RUNTIME_PROTOCOL_VERSION,
  resolveExecutionLineage,
  type RuntimeExecutionReceipt,
} from '../src/index.js';

function receipt(
  executionId: string,
  lineage: RuntimeExecutionReceipt['lineage'],
): RuntimeExecutionReceipt {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    receiptId: `receipt-${executionId}`,
    executionId,
    target: 'test.run',
    principalId: 'agent',
    lineage,
    status: 'success',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.001Z',
    durationMs: 1,
  };
}

describe('execution receipt lineage', () => {
  it('creates a root once and preserves explicit nested ancestry', () => {
    expect(resolveExecutionLineage('root', {
      principal: { id: 'agent', kind: 'agent' },
    })).toEqual({ rootExecutionId: 'root', depth: 0 });
    expect(resolveExecutionLineage('child', {
      principal: { id: 'agent', kind: 'agent' },
      lineage: { rootExecutionId: 'root', parentExecutionId: 'root', depth: 1 },
    })).toEqual({ rootExecutionId: 'root', parentExecutionId: 'root', depth: 1 });
  });

  it('reconstructs a deterministic tree and exposes missing parents', () => {
    const root = {
      ...receipt('root', { rootExecutionId: 'root', depth: 0 }),
      correlations: [createRuntimeExecutionCorrelation('mcpRequestId', 7)],
    };
    const child = receipt('child', {
      rootExecutionId: 'root',
      parentExecutionId: 'root',
      depth: 1,
    });
    const grandchild = receipt('grandchild', {
      rootExecutionId: 'root',
      parentExecutionId: 'child',
      depth: 2,
    });
    const orphan = receipt('orphan', {
      rootExecutionId: 'root',
      parentExecutionId: 'missing',
      depth: 1,
    });

    const forest = buildRuntimeReceiptForest([grandchild, orphan, child, root]);
    expect(forest.roots).toHaveLength(1);
    expect(forest.roots[0]?.receipt.executionId).toBe('root');
    expect(forest.roots[0]?.receipt.correlations).toEqual(root.correlations);
    expect(forest.roots[0]?.children[0]?.receipt.executionId).toBe('child');
    expect(forest.roots[0]?.children[0]?.children[0]?.receipt.executionId).toBe('grandchild');
    expect(forest.orphans.map((node) => node.receipt.executionId)).toEqual(['orphan']);
  });

  it('rejects duplicate, self-parented, and cyclic receipt sets', () => {
    const root = receipt('root', { rootExecutionId: 'root', depth: 0 });
    expect(() => buildRuntimeReceiptForest([root, root])).toThrow(/duplicate/i);
    expect(() => buildRuntimeReceiptForest([
      receipt('self', { rootExecutionId: 'self', parentExecutionId: 'self', depth: 1 }),
    ])).toThrow(/parent itself/i);
    expect(() => buildRuntimeReceiptForest([
      receipt('a', { rootExecutionId: 'a', parentExecutionId: 'b', depth: 1 }),
      receipt('b', { rootExecutionId: 'a', parentExecutionId: 'a', depth: 2 }),
    ])).toThrow(/cycle/i);
  });

  it('bounds and validates persisted correlation records', () => {
    expect(() =>
      createRuntimeExecutionCorrelation('mcpRequestId', 'x'.repeat(16_385))
    ).toThrow(/at most 16384 characters/i);
    expect(() => normalizeRuntimeExecutionCorrelations([
      {
        name: 'mcpRequestId',
        authority: 'untrusted-correlation',
        type: 'string',
        value: 'forged',
      },
    ])).toThrow(/authority is invalid/i);
    expect(() => normalizeRuntimeExecutionCorrelations([
      createRuntimeExecutionCorrelation('mcpRequestId', 1),
      createRuntimeExecutionCorrelation('mcpRequestId', 2),
    ])).toThrow(/duplicate mcpRequestId/i);
  });
});
