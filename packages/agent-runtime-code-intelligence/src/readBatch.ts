import { AsyncLocalStorage } from 'node:async_hooks';

/** The scope the Spanner reader of Quillstone merges same-statement reads under; shared by symbol so this package need not import it. A Quillstone without the reader ignores it. */
const READ_BATCH_KEY = Symbol.for('quillstone.spanner-read-batch');

interface ReadBatchScope {
  readonly coalescers: Map<string, unknown>;
}

const readBatch = (): AsyncLocalStorage<ReadBatchScope> => {
  const shared = globalThis as unknown as Record<symbol, AsyncLocalStorage<ReadBatchScope> | undefined>;
  return (shared[READ_BATCH_KEY] ??= new AsyncLocalStorage<ReadBatchScope>());
};

export type SettledRead<Value> =
  | { readonly status: 'ok'; readonly value: Value }
  | { readonly status: 'error'; readonly message: string };

/**
 * Runs `read` for every item side by side, each one exactly as it would run alone, inside a
 * batch scope so an index that can merge the statements of reads that run together does.
 * A failing item fails alone.
 */
export const readTogether = <Item, Value>(
  items: readonly Item[],
  read: (item: Item) => Promise<Value>,
): Promise<readonly SettledRead<Value>[]> =>
  readBatch().run({ coalescers: new Map() }, () =>
    Promise.all(
      items.map(async (item): Promise<SettledRead<Value>> => {
        try {
          return { status: 'ok', value: await read(item) };
        } catch (error) {
          return { status: 'error', message: error instanceof Error ? error.message : String(error) };
        }
      }),
    ),
  );
