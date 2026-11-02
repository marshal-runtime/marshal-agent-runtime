import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  buildRuntimeReceiptForest,
  normalizeRuntimeExecutionCorrelations,
  type RuntimeExecutionReceipt,
  type RuntimeReceiptForest,
  type RuntimeReceiptQuery,
  type RuntimeReceiptStore,
} from '@marshal/agent-runtime-core';

export interface BoundedFileRuntimeReceiptStoreOptions {
  readonly filePath: string;
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
}

/** Restart-safe, idempotent JSONL receipt journal for the portable local host. */
export class BoundedFileRuntimeReceiptStore implements RuntimeReceiptStore {
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private queue: Promise<void> = Promise.resolve();
  private knownReceiptIds: Set<string> | undefined;

  constructor(private readonly options: BoundedFileRuntimeReceiptStoreOptions) {
    if (!path.isAbsolute(options.filePath)) throw new TypeError('Receipt filePath must be absolute.');
    this.maxEntries = boundedInteger(options.maxEntries, 50_000, 1, 1_000_000, 'maxEntries');
    this.maxEntryBytes = boundedInteger(
      options.maxEntryBytes,
      1_048_576,
      1_024,
      16_777_216,
      'maxEntryBytes',
    );
  }

  record(receipt: RuntimeExecutionReceipt): Promise<void> {
    const operation = this.queue.then(() => this.recordNow(receipt));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async list(query: RuntimeReceiptQuery = {}): Promise<readonly RuntimeExecutionReceipt[]> {
    await this.queue;
    const limit = boundedInteger(query.limit, this.maxEntries, 1, this.maxEntries, 'limit');
    const entries = (await this.readAll())
      .filter((receipt) =>
        query.rootExecutionId === undefined ||
        receipt.lineage.rootExecutionId === query.rootExecutionId,
      )
      .filter((receipt) =>
        query.parentExecutionId === undefined ||
        receipt.lineage.parentExecutionId === query.parentExecutionId,
      )
      .filter((receipt) =>
        query.principalId === undefined || receipt.principalId === query.principalId,
      );
    return entries.slice(Math.max(0, entries.length - limit));
  }

  async tree(rootExecutionId: string): Promise<RuntimeReceiptForest> {
    if (!rootExecutionId.trim()) throw new TypeError('rootExecutionId is required.');
    return buildRuntimeReceiptForest(await this.list({ rootExecutionId, limit: this.maxEntries }));
  }

  private async recordNow(receipt: RuntimeExecutionReceipt): Promise<void> {
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
    if (!this.knownReceiptIds) {
      this.knownReceiptIds = new Set((await this.readAll()).map((item) => item.receiptId));
    }
    if (this.knownReceiptIds.has(receipt.receiptId)) return;
    const correlations = normalizeRuntimeExecutionCorrelations(receipt.correlations);
    const storedReceipt = correlations ? { ...receipt, correlations } : receipt;
    const encoded = `${JSON.stringify(storedReceipt)}\n`;
    if (Buffer.byteLength(encoded) > this.maxEntryBytes) {
      throw new RangeError(`Receipt ${receipt.receiptId} exceeds maxEntryBytes.`);
    }
    await fs.appendFile(this.options.filePath, encoded, 'utf8');
    this.knownReceiptIds.add(receipt.receiptId);
    // The file keeps up to 10% slack past the bound (list() still returns only maxEntries),
    // so compaction rereads the journal once per slack window instead of on every record.
    if (this.knownReceiptIds.size <= this.maxEntries + compactionSlack(this.maxEntries)) return;
    const entries = await this.readAll();
    const retained = entries.slice(Math.max(0, entries.length - this.maxEntries));
    await fs.writeFile(
      this.options.filePath,
      retained.map((item) => JSON.stringify(item)).join('\n') + '\n',
      'utf8',
    );
    this.knownReceiptIds = new Set(retained.map((item) => item.receiptId));
  }

  private async readAll(): Promise<RuntimeExecutionReceipt[]> {
    let source: string;
    try {
      source = await fs.readFile(this.options.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const receipts: RuntimeExecutionReceipt[] = [];
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as RuntimeExecutionReceipt;
      if (!value || typeof value !== 'object' || typeof value.receiptId !== 'string') {
        throw new TypeError('Receipt journal contains an invalid entry.');
      }
      const correlations = normalizeRuntimeExecutionCorrelations(value.correlations);
      const legacyParent = value.scope?.parentExecutionId;
      const normalizedValue = correlations ? { ...value, correlations } : value;
      receipts.push(normalizedValue.lineage
        ? normalizedValue
        : {
            ...normalizedValue,
            lineage: legacyParent
              ? { rootExecutionId: legacyParent, parentExecutionId: legacyParent, depth: 1 }
              : { rootExecutionId: normalizedValue.executionId, depth: 0 },
          });
    }
    return receipts;
  }
}

function compactionSlack(maxEntries: number): number {
  return Math.max(1, Math.floor(maxEntries / 10));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return resolved;
}
