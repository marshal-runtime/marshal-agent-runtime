import { join, resolve } from 'node:path';
import type { RuntimeCatalogProvider } from '@marshal/agent-runtime-core';
import { DeclarativeUiMcpAppsResourceAdapter } from './mcpAppsResourceAdapter.js';
import { DeclarativeUiProvider } from './provider.js';
import {
  DeclarativeUiStore,
  type DeclarativeUiStoreOptions,
} from './store.js';
import type { UiOperationInvoker } from './types.js';

export interface CreateDeclarativeUiCapabilitiesOptions {
  readonly stateRoot: string;
  readonly storeLimits?: Omit<DeclarativeUiStoreOptions, 'storageRoot'>;
  readonly operationInvoker?: UiOperationInvoker;
  readonly allowedOperations?: readonly string[];
  readonly allowOperation?: (operation: string) => boolean;
}

export function createDeclarativeUiCapabilities(
  options: CreateDeclarativeUiCapabilitiesOptions,
) {
  const store = new DeclarativeUiStore({
    storageRoot: join(resolve(options.stateRoot), 'declarative-ui'),
    ...options.storeLimits,
  });
  const resources = new DeclarativeUiMcpAppsResourceAdapter(store);
  const provider = new DeclarativeUiProvider({
    store,
    resources,
    operationInvoker: options.operationInvoker,
    allowedOperations: options.allowedOperations,
    allowOperation: options.allowOperation,
  });
  const catalog: RuntimeCatalogProvider = {
    id: 'marshal.declarative-ui-catalog',
    async list(context) {
      return (await store.list(context)).map((artifact) => ({
        id: `ui://marshal-declarative/artifact/${artifact.id}`,
        kind: 'ui_application' as const,
        title: artifact.title,
        description: artifact.description ?? `Declarative UI revision ${artifact.revision}.`,
        tags: ['ui', 'application', 'declarative'],
        action: {
          type: 'ui_render' as const,
          renderId: artifact.id,
          resourceUri: artifact.resourceUri,
        },
        metadata: {
          revision: artifact.revision,
          updatedAt: artifact.updatedAt,
          presentationModes: ['inline'],
        },
      }));
    },
  };
  return { provider, providers: [provider], store, resources, catalog };
}
