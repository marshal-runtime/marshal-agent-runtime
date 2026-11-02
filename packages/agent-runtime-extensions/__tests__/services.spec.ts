import { describe, expect, it } from 'vitest';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import {
  RUNTIME_EXTENSION_CATALOG_SERVICE,
  RUNTIME_EXTENSION_CATALOG_SOURCE,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  RUNTIME_EXTENSION_STATUS_SERVICE,
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  RUNTIME_AUTHORED_UI_PROMOTION_SERVICE,
  type RuntimeExtensionCatalogService,
  type RuntimeExtensionCatalogOrigin,
  type RuntimeExtensionCatalogSearchRequest,
  type RuntimeExtensionUiPublicationRevision,
  type RuntimeExtensionUiPublicationService,
  type RuntimeAuthoredUiPromotionService,
} from '../src/index.js';

describe('runtime extension service contracts', () => {
  it('uses stable package-qualified service token identities', () => {
    expect(RUNTIME_EXTENSION_LIFECYCLE_SERVICE).toBe(
      Symbol.for('@marshal/agent-runtime-extensions:lifecycle'),
    );
    expect(RUNTIME_EXTENSION_CATALOG_SOURCE).toBe(
      Symbol.for('@marshal/agent-runtime-extensions:catalog-source'),
    );
    expect(RUNTIME_EXTENSION_CATALOG_SERVICE).toBe(
      Symbol.for('@marshal/agent-runtime-extensions:catalog'),
    );
    expect(RUNTIME_EXTENSION_STATUS_SERVICE).toBe(
      Symbol.for('@marshal/agent-runtime-extensions:status'),
    );
    expect(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE).toBe(
      Symbol.for('@marshal/agent-runtime-extensions:ui-publication'),
    );
    expect(RUNTIME_AUTHORED_UI_PROMOTION_SERVICE).toBe(
      Symbol.for('@marshal/agent-runtime-extensions:authored-ui-promotion'),
    );
  });

  it('exposes the three supported catalog origins and bounded search shape', () => {
    const origins: readonly RuntimeExtensionCatalogOrigin[] = [
      'native',
      'dsh',
      'authored-typescript',
    ];
    const request: RuntimeExtensionCatalogSearchRequest = {
      origins,
      tags: ['portable'],
      installation: 'not-installed',
      limit: 10,
    };

    expect(request.origins).toEqual(origins);
  });

  it('exposes context-aware catalog and revision-safe publication contracts', () => {
    const context: InvocationContext = {
      principal: { id: 'contract-test', kind: 'agent' },
      scope: { workspaceId: 'workspace-1' },
    };
    const catalog: RuntimeExtensionCatalogService = {
      discover: async () => [],
      get: async () => undefined,
      search: async () => ({ query: '', matches: [] }),
      install: async () => {
        throw new Error('not implemented');
      },
      update: async () => {
        throw new Error('not implemented');
      },
      enable: async () => {
        throw new Error('not implemented');
      },
      disable: async () => {
        throw new Error('not implemented');
      },
      remove: async () => {},
      listInstalled: () => [],
    };
    const revision: RuntimeExtensionUiPublicationRevision = {
      ownerId: 'owner',
      revisionId: 'revision',
      applications: [],
      placements: [],
    };
    const publication: RuntimeExtensionUiPublicationService = {
      preparePublicationRevision: async () => revision,
      listApplications: async () => [],
      resolvePlacementState: async () => ({ placements: [] }),
      revoke: async () => {},
      rollback: async () => {},
    };

    expect(catalog.listInstalled(context)).toEqual([]);
    expect(publication).toBeDefined();
  });

  it('exposes the authored UI promotion boundary', () => {
    const promotion: RuntimeAuthoredUiPromotionService = {
      catalogSource: {
        id: 'authored-ui',
        label: 'Authored UI',
        list: async () => [],
      },
      promote: async (request) => ({
        ...request,
        action: 'unchanged',
      }),
    };

    expect(promotion.catalogSource.id).toBe('authored-ui');
  });
});
