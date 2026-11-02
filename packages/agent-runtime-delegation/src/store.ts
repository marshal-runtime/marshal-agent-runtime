import type { DelegationRecord, DelegationStore } from './types.js';

/** In-memory reference store. Production hosts may supply a durable implementation. */
export class InMemoryDelegationStore implements DelegationStore {
  private readonly records = new Map<string, DelegationRecord>();
  private queue: Promise<void> = Promise.resolve();

  async get(delegationId: string): Promise<DelegationRecord | undefined> {
    return clone(this.records.get(delegationId));
  }

  async list(): Promise<readonly DelegationRecord[]> {
    return [...this.records.values()].map((record) => clone(record)!);
  }

  create(record: DelegationRecord): Promise<void> {
    return this.serial(async () => {
      if (this.records.has(record.delegationId)) {
        throw new Error(`Delegation "${record.delegationId}" already exists.`);
      }
      this.records.set(record.delegationId, clone(record)!);
    });
  }

  update(record: DelegationRecord): Promise<void> {
    return this.serial(async () => {
      if (!this.records.has(record.delegationId)) {
        throw new Error(`Delegation "${record.delegationId}" was not found.`);
      }
      this.records.set(record.delegationId, clone(record)!);
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
