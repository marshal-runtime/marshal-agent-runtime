import { createRuntimeServiceToken } from './services.js';
import {
  createRuntimeCompositionServiceDescriptor,
  type RuntimeCompositionServiceDescriptor,
} from './compositionRegistry.js';
import {
  createFileRuntimeEventCheckpointStore,
  createFileRuntimeEventJournal,
  createInMemoryRuntimeEventCheckpointStore,
  createInMemoryRuntimeEventJournal,
  createRuntimeEventBus,
  createRuntimeLifecycleEventPublisher,
  type RuntimeEventCheckpointStore,
  type RuntimeEventJournal,
  type RuntimeEventBus,
  type RuntimeLifecycleEventMap,
  type RuntimeLifecyclePublisher,
} from '@marshal/agent-runtime-core';
import type {
  RuntimeServiceBinding,
} from './services.js';

export const RUNTIME_EVENT_PUBLISHER = createRuntimeServiceToken<RuntimeLifecyclePublisher>('@marshal/runtime/events:publisher');
export const RUNTIME_EVENT_JOURNAL = createRuntimeServiceToken<RuntimeEventJournal<RuntimeLifecycleEventMap>>('@marshal/runtime/events:journal');
export const RUNTIME_EVENT_CHECKPOINT_STORE = createRuntimeServiceToken<RuntimeEventCheckpointStore>('@marshal/runtime/events:checkpoint-store');
export const RUNTIME_EVENT_BUS = createRuntimeServiceToken<RuntimeEventBus<RuntimeLifecycleEventMap>>('@marshal/runtime/events:bus');

const publisherContract = {
  name: '@marshal/runtime/events:publisher',
  version: '1',
  methods: [{ name: 'publish', version: '1' }],
} as const;
const journalContract = {
  name: '@marshal/runtime/events:journal',
  version: '1',
  methods: [
    { name: 'append', version: '1' },
    { name: 'read', version: '1' },
    { name: 'tail', version: '1' },
  ],
} as const;
const checkpointStoreContract = {
  name: '@marshal/runtime/events:checkpoint-store',
  version: '1',
  methods: [
    { name: 'get', version: '1' },
    { name: 'save', version: '1' },
  ],
} as const;
const busContract = {
  name: '@marshal/runtime/events:bus',
  version: '1',
  methods: [
    { name: 'publish', version: '1' },
    { name: 'subscribe', version: '1' },
  ],
} as const;

export const RUNTIME_EVENT_PUBLISHER_SERVICE: RuntimeCompositionServiceDescriptor<RuntimeLifecyclePublisher> =
  createRuntimeCompositionServiceDescriptor('@marshal/runtime/events:publisher', publisherContract);
export const RUNTIME_EVENT_JOURNAL_SERVICE: RuntimeCompositionServiceDescriptor<RuntimeEventJournal<RuntimeLifecycleEventMap>> =
  createRuntimeCompositionServiceDescriptor('@marshal/runtime/events:journal', journalContract);
export const RUNTIME_EVENT_CHECKPOINT_STORE_SERVICE: RuntimeCompositionServiceDescriptor<RuntimeEventCheckpointStore> =
  createRuntimeCompositionServiceDescriptor('@marshal/runtime/events:checkpoint-store', checkpointStoreContract);
export const RUNTIME_EVENT_BUS_SERVICE: RuntimeCompositionServiceDescriptor<RuntimeEventBus<RuntimeLifecycleEventMap>> =
  createRuntimeCompositionServiceDescriptor('@marshal/runtime/events:bus', busContract);

export interface RuntimeEventBindingOptions {
  readonly journal?: RuntimeEventJournal<RuntimeLifecycleEventMap>;
  readonly checkpointStore?: RuntimeEventCheckpointStore;
  readonly journalPath?: string;
  readonly checkpointPath?: string;
  readonly streamId?: string;
}

export interface RuntimeEventBindings {
  readonly journal: RuntimeServiceBinding<RuntimeEventJournal<RuntimeLifecycleEventMap>>;
  readonly checkpointStore: RuntimeServiceBinding<RuntimeEventCheckpointStore>;
  readonly publisher: RuntimeServiceBinding<RuntimeLifecyclePublisher>;
  readonly eventBus: RuntimeServiceBinding<RuntimeEventBus<RuntimeLifecycleEventMap>>;
}

/**
 * Creates durable event services with process-local defaults. File-backed stores
 * are selected only when their corresponding paths are supplied.
 */
export async function createRuntimeEventBindings(
  options: RuntimeEventBindingOptions = {},
): Promise<RuntimeEventBindings> {
  if (options.journal !== undefined && options.journalPath !== undefined) {
    throw new Error('Specify either journal or journalPath, not both.');
  }
  if (
    options.checkpointStore !== undefined &&
    options.checkpointPath !== undefined
  ) {
    throw new Error(
      'Specify either checkpointStore or checkpointPath, not both.',
    );
  }

  const journal =
    options.journal ??
    (options.journalPath === undefined
      ? createInMemoryRuntimeEventJournal<RuntimeLifecycleEventMap>()
      : await createFileRuntimeEventJournal<RuntimeLifecycleEventMap>(
          options.journalPath,
        ));
  const checkpointStore =
    options.checkpointStore ??
    (options.checkpointPath === undefined
      ? createInMemoryRuntimeEventCheckpointStore()
      : await createFileRuntimeEventCheckpointStore(options.checkpointPath));
  const eventBus = createRuntimeEventBus<RuntimeLifecycleEventMap>({ journal });
  const publisher = createRuntimeLifecycleEventPublisher({
    eventBus,
    streamId: options.streamId,
  });

  return Object.freeze({
    journal: {
      useValue: journal,
    },
    checkpointStore: { useValue: checkpointStore },
    publisher: {
      useValue: publisher,
    },
    eventBus: { useValue: eventBus },
  });
}
