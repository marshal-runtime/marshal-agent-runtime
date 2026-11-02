import { describe, expect, it } from 'vitest';

import {
  createRuntimeCompositionResourcePort,
  toRuntimeCompositionCatalogEntry,
  type RuntimeCompositionSnapshot,
} from '../src/compositionCatalog.js';

const context = { sessionId: 'test-session' } as never;

function largeCompositionFixture(): RuntimeCompositionSnapshot {
  const declaration = (name: string) =>
    `export interface ${name} {\n${Array.from({ length: 20 }, (_, line) => `  field${line}: string; // ${name} declaration line ${line}`).join('\n')}\n}`;
  const methodSchema = (name: string) => ({
    input: {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `${name}Param${index}`,
          { type: 'string', description: `Schema description for ${name} parameter ${index}` },
        ]),
      ),
    },
    output: { type: 'object', properties: { result: { type: 'string' } } },
    description: `Method ${name} does something specific.`,
  });
  const services = Array.from({ length: 13 }, (_, index) => ({
    id: `service.symbol.${index}`,
    name: `marshal.service${index}`,
    publicName: `service${index}`,
    version: '1.0.0',
    declaration: declaration(`Service${index}`),
    type: 'service',
    contractId: `marshal.service${index}`,
    selectedProvider: `provider.${index}`,
    alternativeProviders: [],
    methods: Object.fromEntries(
      Array.from({ length: 4 }, (_, m) => [`method${index}n${m}`, methodSchema(`method${index}n${m}`)]),
    ),
  }));
  const contracts = services.map((service) => ({
    id: service.name,
    name: service.name,
    publicName: service.publicName,
    version: service.version,
    declaration: service.declaration,
    type: 'contract',
    methods: service.methods,
  }));
  const providers = services.map((service, index) => ({
    id: `provider.${index}`,
    name: service.name,
    publicName: service.publicName,
    version: service.version,
    type: 'provider',
    serviceId: service.id,
    contractId: service.name,
    selected: true,
    health: 'unknown' as const,
    methods: service.methods,
  }));
  return {
    id: 'runtime-composition',
    name: 'Runtime composition',
    type: 'composition',
    services,
    contracts,
    providers,
    selectedProviders: providers.map((provider) => provider.id),
    alternativeProviders: [],
    health: 'healthy',
    metadata: { overrides: [] },
  };
}

describe('toRuntimeCompositionCatalogEntry', () => {
  it('keeps identity terms searchable without flattening method schemas into the description', () => {
    const entry = toRuntimeCompositionCatalogEntry(largeCompositionFixture());
    expect(entry.description).toContain('runtime-composition');
    expect(entry.description).toContain('marshal.service0');
    expect(entry.description).toContain('service12');
    expect(entry.description).toContain('method12n3');
    expect(entry.description).not.toContain('Schema description for');
    expect(entry.description).not.toContain('"type"');
    expect(entry.description).not.toContain('declaration line');
  });

  it('deduplicates repeated searchable terms', () => {
    const entry = toRuntimeCompositionCatalogEntry(largeCompositionFixture());
    const occurrences = entry.description.split('marshal.service0').length - 1;
    expect(occurrences).toBe(1);
  });

  it('carries no declaration or method schema payload in the entry itself', () => {
    const entry = toRuntimeCompositionCatalogEntry(largeCompositionFixture());
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.publicMethodSchemas).toBeUndefined();
    expect(metadata.composition).toBeUndefined();
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('declaration line');
    expect(serialized).not.toContain('Schema description for');
  });

  it('preserves the readback action, identity metadata, and app services snippet', () => {
    const entry = toRuntimeCompositionCatalogEntry(largeCompositionFixture());
    expect(entry.action).toEqual({
      type: 'resource_read',
      uri: 'runtime://composition/runtime-composition',
    });
    const metadata = entry.metadata as {
      serviceIdentity: readonly { id: string }[];
      contractIdentity: readonly { id: string }[];
      appServicesSnippet: string;
      overrides: unknown;
    };
    expect(metadata.serviceIdentity).toHaveLength(13);
    expect(metadata.contractIdentity).toHaveLength(13);
    expect(metadata.serviceIdentity[0]?.id).toBe('service.symbol.0');
    expect(metadata.appServicesSnippet).toContain('AppServices');
    expect(metadata.overrides).toEqual([]);
  });

  it('bounds the entry payload while the resource read stays complete', async () => {
    const snapshot = largeCompositionFixture();
    const entry = toRuntimeCompositionCatalogEntry(snapshot);
    const document = JSON.stringify(entry);
    // The same fixture serialized above 250KB before the searchable corpus,
    // publicMethodSchemas, and inline composition document were removed.
    expect(document.length).toBeLessThan(20_000);

    const port = createRuntimeCompositionResourcePort(snapshot);
    const resource = await port.readResource('runtime://composition/runtime-composition', context);
    const readback = JSON.parse(resource.text) as {
      services: readonly { declaration?: string; methods?: Record<string, { description?: string }> }[];
    };
    expect(readback.services).toHaveLength(13);
    expect(readback.services[0]?.declaration).toContain('Service0 declaration line 0');
    expect(readback.services[0]?.methods?.method0n0?.description).toBe('Method method0n0 does something specific.');
  });
});
