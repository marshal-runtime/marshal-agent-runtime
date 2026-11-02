import type {
  InvocationContext,
  RuntimeExecutionLineage,
  RuntimeExecutionReceipt,
} from './contracts.js';

export interface RuntimeReceiptTreeNode {
  readonly receipt: RuntimeExecutionReceipt;
  readonly children: readonly RuntimeReceiptTreeNode[];
}

export interface RuntimeReceiptForest {
  readonly roots: readonly RuntimeReceiptTreeNode[];
  /** Receipts whose declared parent is absent from the supplied set. */
  readonly orphans: readonly RuntimeReceiptTreeNode[];
}

/**
 * Resolve ancestry for a new execution. The root is assigned once and carried
 * explicitly through every nested capability or delegation call.
 */
export function resolveExecutionLineage(
  executionId: string,
  context: InvocationContext,
): RuntimeExecutionLineage {
  if (context.lineage) {
    assertLineage(context.lineage);
    return context.lineage;
  }
  const legacyParent = context.scope?.parentExecutionId;
  return legacyParent
    ? { rootExecutionId: legacyParent, parentExecutionId: legacyParent, depth: 1 }
    : { rootExecutionId: executionId, depth: 0 };
}

/** Build a deterministic receipt forest and reject ambiguous or cyclic traces. */
export function buildRuntimeReceiptForest(
  receipts: readonly RuntimeExecutionReceipt[],
): RuntimeReceiptForest {
  const byExecution = new Map<string, RuntimeExecutionReceipt>();
  for (const receipt of receipts) {
    assertLineage(receipt.lineage);
    if (byExecution.has(receipt.executionId)) {
      throw new TypeError(`Duplicate execution receipt ${receipt.executionId}.`);
    }
    byExecution.set(receipt.executionId, receipt);
  }

  const children = new Map<string, RuntimeExecutionReceipt[]>();
  const roots: RuntimeExecutionReceipt[] = [];
  const orphans: RuntimeExecutionReceipt[] = [];
  for (const receipt of receipts) {
    const parentId = receipt.lineage.parentExecutionId;
    if (!parentId) {
      roots.push(receipt);
      continue;
    }
    if (parentId === receipt.executionId) {
      throw new TypeError(`Execution receipt ${receipt.executionId} cannot parent itself.`);
    }
    if (!byExecution.has(parentId)) {
      orphans.push(receipt);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(receipt);
    children.set(parentId, siblings);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const build = (receipt: RuntimeExecutionReceipt): RuntimeReceiptTreeNode => {
    if (visiting.has(receipt.executionId)) {
      throw new TypeError(`Receipt ancestry contains a cycle at ${receipt.executionId}.`);
    }
    visiting.add(receipt.executionId);
    const childReceipts = sortReceipts(children.get(receipt.executionId) ?? []);
    const nested = childReceipts.map(build);
    for (const child of childReceipts) {
      if (child.lineage.rootExecutionId !== receipt.lineage.rootExecutionId) {
        throw new TypeError(`Receipt ${child.executionId} changed execution roots.`);
      }
      if (child.lineage.depth !== receipt.lineage.depth + 1) {
        throw new TypeError(`Receipt ${child.executionId} has an inconsistent lineage depth.`);
      }
    }
    visiting.delete(receipt.executionId);
    visited.add(receipt.executionId);
    return { receipt, children: nested };
  };

  for (const root of roots) {
    if (root.lineage.rootExecutionId !== root.executionId) {
      throw new TypeError(`Root receipt ${root.executionId} has a different rootExecutionId.`);
    }
  }
  const rootNodes = sortReceipts(roots).map(build);
  const orphanNodes = sortReceipts(orphans).map(build);
  for (const receipt of receipts) {
    if (!visited.has(receipt.executionId)) build(receipt);
  }
  return { roots: rootNodes, orphans: orphanNodes };
}

function sortReceipts(receipts: readonly RuntimeExecutionReceipt[]): RuntimeExecutionReceipt[] {
  return [...receipts].sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.executionId.localeCompare(right.executionId),
  );
}

function assertLineage(lineage: RuntimeExecutionLineage): void {
  if (!lineage.rootExecutionId.trim()) throw new TypeError('Receipt rootExecutionId is required.');
  if (lineage.parentExecutionId !== undefined && !lineage.parentExecutionId.trim()) {
    throw new TypeError('Receipt parentExecutionId must be non-empty when supplied.');
  }
  if (!Number.isSafeInteger(lineage.depth) || lineage.depth < 0) {
    throw new TypeError('Receipt lineage depth must be a non-negative safe integer.');
  }
  if (lineage.depth === 0 && lineage.parentExecutionId) {
    throw new TypeError('A root receipt cannot declare a parent execution.');
  }
  if (lineage.depth > 0 && !lineage.parentExecutionId) {
    throw new TypeError('A nested receipt must declare a parent execution.');
  }
}
