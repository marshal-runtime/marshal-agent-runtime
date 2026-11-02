import {
  requireRuntimeCatalogId,
  RUNTIME_RESOURCE_URI_MAX_LENGTH,
  type RuntimeCatalogEntry,
  type RuntimeCatalogProvider,
} from '@marshal/agent-runtime-core';
import type {
  RuntimeResourceDescriptor,
  RuntimeScopedResourcePort,
} from './types.js';

const RUNTIME_RESOURCE_CATALOG_PROVIDER_ID = 'marshal.runtime-resource-catalog';
const RUNTIME_RESOURCE_CATALOG_ID_PREFIX =
  `catalog://${RUNTIME_RESOURCE_CATALOG_PROVIDER_ID}/resource/`;

/** Projects context-visible registered resources into additive runtime_search entries. */
export function createRuntimeResourceCatalogProvider(
  resources: RuntimeScopedResourcePort,
): RuntimeCatalogProvider {
  return {
    id: RUNTIME_RESOURCE_CATALOG_PROVIDER_ID,
    async list(context) {
      return (await resources.listResources(context)).map(resourceCatalogEntry);
    },
    async get(id, context) {
      const descriptor = (await resources.listResources(context))
        .find((resource) => resourceCatalogId(resource.uri) === id);
      return descriptor ? resourceCatalogEntry(descriptor) : undefined;
    },
  };
}

function resourceCatalogEntry(descriptor: RuntimeResourceDescriptor): RuntimeCatalogEntry {
  const title = descriptor.name.trim() || descriptor.uri;
  const description =
    descriptor.description?.trim() || `Read the runtime resource "${title}".`;
  const owner = descriptor.catalog?.owner ?? {
    type: 'catalog_provider' as const,
    id: RUNTIME_RESOURCE_CATALOG_PROVIDER_ID,
  };
  return {
    id: resourceCatalogId(descriptor.uri),
    kind: 'resource',
    title,
    description,
    tags: [
      'resource',
      ...(descriptor.mimeType ? [descriptor.mimeType] : []),
    ],
    action: { type: 'resource_read', uri: descriptor.uri },
    metadata: {
      ...(descriptor.catalog?.metadata ?? {}),
      owner,
      resourceUri: descriptor.uri,
      ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
    },
  };
}

function resourceCatalogId(uri: string): string {
  if (!uri.trim()) throw new TypeError('Runtime resource URI must be non-empty.');
  if (uri.length > RUNTIME_RESOURCE_URI_MAX_LENGTH) {
    throw new TypeError(
      `Runtime resource URI must be at most ${RUNTIME_RESOURCE_URI_MAX_LENGTH} characters.`,
    );
  }
  return requireRuntimeCatalogId(
    `${RUNTIME_RESOURCE_CATALOG_ID_PREFIX}${encodeURIComponent(uri)}`,
    'Runtime resource catalog id',
  );
}
