import { describe, expect, it, vi } from 'vitest';
import {
  DuplicateCapabilityError,
  DuplicateProviderError,
  createAllowAllPermissionBroker,
  createRuntimeExecutionCorrelation,
  createRuntimeReceiptCorrelationContext,
  INLINE_MODULE_EXECUTOR_CAPABILITY,
  INTERNAL_CAPABILITY_TAG,
  MODULE_EXECUTOR_CAPABILITY,
  RUNTIME_CATALOG_ID_MAX_LENGTH,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeKernel,
  UnsupportedProtocolVersionError,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
  type PermissionDecision,
  type RuntimeCatalogEntry,
  type RuntimeCatalogProvider,
  type RuntimeReceiptCorrelationContext,
} from '../src/index.js';

const context: InvocationContext = {
  principal: { id: 'agent-1', kind: 'agent' },
  scope: { workspaceId: 'workspace-1', sessionId: 'session-1' },
  metadata: { harness: 'test' },
};

function descriptor(
  name: string,
  overrides: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    description: `Capability ${name}`,
    outputSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...overrides,
  };
}

function provider(
  id: string,
  descriptors: readonly CapabilityDescriptor[],
  invoke = vi.fn(async () => ({ output: {} })),
): CapabilityProvider {
  return {
    id,
    version: '2.0.0',
    list: vi.fn(async () => descriptors),
    invoke,
  };
}

function deterministicKernel(
  options: ConstructorParameters<typeof RuntimeKernel>[0] = {},
): RuntimeKernel {
  let id = 0;
  const times = [
    new Date('2026-01-01T00:00:00.000Z'),
    new Date('2026-01-01T00:00:00.025Z'),
    new Date('2026-01-01T00:00:00.050Z'),
  ];
  return new RuntimeKernel({
    ...options,
    permissionBroker: options.permissionBroker ?? createAllowAllPermissionBroker(),
    createId: options.createId ?? ((kind) => `${kind}-${++id}`),
    now: options.now ?? (() => times.shift() ?? new Date('2026-01-01T00:00:00.050Z')),
  });
}

describe('RuntimeKernel provider registry', () => {
  it('rejects descriptors without a strict semantic output schema', async () => {
    const kernel = deterministicKernel();
    const missingSchema = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name: 'broken.output',
      version: '1.0.0',
      description: 'Broken descriptor',
    } as unknown as CapabilityDescriptor;
    kernel.register(provider('broken', [missingSchema]));

    await expect(kernel.list(context)).rejects.toThrow(/must declare an outputSchema/i);
  });

  it('registers, lists, gets, and idempotently disposes contextual providers', async () => {
    const seenContexts: InvocationContext[] = [];
    const testProvider: CapabilityProvider = {
      id: 'memory',
      version: '1.2.3',
      list: (received) => {
        seenContexts.push(received);
        return [descriptor('memory.search')];
      },
      get: (name, received) => {
        seenContexts.push(received);
        return name === 'memory.search' ? descriptor(name) : undefined;
      },
      invoke: async () => ({ output: {} }),
    };
    const kernel = deterministicKernel();
    const registration = kernel.register(testProvider);

    expect(await kernel.list(context)).toEqual([
      expect.objectContaining({
        name: 'memory.search',
        provider: { id: 'memory', version: '1.2.3' },
      }),
    ]);
    expect((await kernel.get('memory.search', context))?.provider.id).toBe('memory');
    expect(seenContexts).toEqual([context, context]);

    registration.dispose();
    registration.dispose();
    expect(await kernel.list(context)).toEqual([]);
  });

  it('rejects duplicate providers and contextual duplicate capability names', async () => {
    const kernel = deterministicKernel();
    kernel.register(provider('one', [descriptor('shared.name')]));
    expect(() => kernel.register(provider('one', []))).toThrow(DuplicateProviderError);
    kernel.register(provider('two', [descriptor('shared.name')]));
    await expect(kernel.list(context)).rejects.toThrow(DuplicateCapabilityError);
    await expect(kernel.get('shared.name', context)).rejects.toThrow(DuplicateCapabilityError);
  });

  it('lets a fallback provider yield to any provider that declares the same capability, before or after it registers', async () => {
    const kernel = deterministicKernel();
    const fallback = { ...provider('stub', [descriptor('knowledge.search'), descriptor('knowledge.status')]), fallback: true };
    kernel.register(fallback);
    expect((await kernel.list(context)).map((entry) => [entry.name, entry.provider.id])).toEqual([
      ['knowledge.search', 'stub'],
      ['knowledge.status', 'stub'],
    ]);

    const registration = await kernel.registerContributions({
      providers: [provider('extension', [descriptor('knowledge.search'), descriptor('knowledge.schema')])],
    }, context);
    expect((await kernel.list(context)).map((entry) => [entry.name, entry.provider.id])).toEqual([
      ['knowledge.schema', 'extension'],
      ['knowledge.search', 'extension'],
      ['knowledge.status', 'stub'],
    ]);
    expect((await kernel.get('knowledge.search', context))?.provider.id).toBe('extension');

    registration.dispose();
    expect((await kernel.get('knowledge.search', context))?.provider.id).toBe('stub');
  });

  it('still reports two providers that both declare a capability when neither is a fallback, or both are', async () => {
    const kernel = deterministicKernel();
    kernel.register({ ...provider('stub-one', [descriptor('knowledge.search')]), fallback: true });
    kernel.register({ ...provider('stub-two', [descriptor('knowledge.search')]), fallback: true });
    await expect(kernel.list(context)).rejects.toThrow(DuplicateCapabilityError);
    await expect(kernel.registerContributions({
      providers: [provider('extension-one', [descriptor('other.name')]), provider('extension-two', [descriptor('other.name')])],
    }, context)).rejects.toThrow(DuplicateCapabilityError);
  });

  it('keeps internal capabilities out of broad search but reachable by exact name', async () => {
    const kernel = deterministicKernel();
    kernel.register(provider('index', [
      descriptor('code.index.status', { tags: [INTERNAL_CAPABILITY_TAG] }),
      descriptor('knowledge.status'),
    ]));

    const broad = await kernel.runtimeSearch({ protocolVersion: RUNTIME_PROTOCOL_VERSION, query: 'status' }, context);
    const exact = await kernel.runtimeSearch({ protocolVersion: RUNTIME_PROTOCOL_VERSION, name: 'code.index.status' }, context);
    const tagged = await kernel.runtimeSearch({ protocolVersion: RUNTIME_PROTOCOL_VERSION, query: 'status', tags: ['internal'] }, context);

    expect(broad.matches.map((match) => match.capability.name)).toEqual(['knowledge.status']);
    expect(exact.matches.map((match) => match.capability.name)).toEqual(['code.index.status']);
    expect(tagged.matches.map((match) => match.capability.name)).toEqual(['code.index.status']);
  });
});

describe('RuntimeKernel atomic contribution registry', () => {
  it('replaces capability and catalog providers atomically without stale ownership', async () => {
    const kernel = deterministicKernel();
    const first = await kernel.registerContributions({
      providers: [provider('extension.provider', [descriptor('extension.echo', {
        version: '1.0.0',
      })])],
      catalogProviders: [{
        id: 'extension.catalog',
        list: () => [{
          id: 'resource://extension/v1',
          kind: 'resource',
          title: 'Extension v1',
          description: 'First extension resource.',
          action: { type: 'resource_read', uri: 'resource://extension/v1' },
        }],
      }],
    }, context);

    const second = await first.replace({
      providers: [provider('extension.provider', [descriptor('extension.echo', {
        version: '2.0.0',
      })])],
      catalogProviders: [{
        id: 'extension.catalog',
        list: () => [{
          id: 'resource://extension/v2',
          kind: 'resource',
          title: 'Extension v2',
          description: 'Second extension resource.',
          action: { type: 'resource_read', uri: 'resource://extension/v2' },
        }],
      }],
    }, context);

    first.dispose();
    await expect(kernel.runtimeSearch({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name: 'extension.echo',
    }, context)).resolves.toMatchObject({
      matches: [{ capability: { version: '2.0.0' } }],
    });
    await expect(kernel.runtimeSearch({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: 'Extension',
    }, context)).resolves.toMatchObject({
      discoveries: [{ entry: { id: 'resource://extension/v2' } }],
    });
    const staleCatalog = await kernel.runtimeSearch({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      catalogId: 'resource://extension/v1',
    }, context);
    expect(staleCatalog.discoveries).toBeUndefined();

    second.dispose();
    expect(await kernel.list(context)).toEqual([]);
    const removedCatalog = await kernel.runtimeSearch({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: 'Extension',
    }, context);
    expect(removedCatalog.discoveries).toBeUndefined();
  });

  it('keeps the previous contribution set active when replacement validation fails', async () => {
    const kernel = deterministicKernel();
    const first = await kernel.registerContributions({
      providers: [provider('extension.provider', [descriptor('extension.echo')])],
    }, context);
    kernel.register(provider('other.provider', [descriptor('other.echo')]));

    await expect(first.replace({
      providers: [provider('extension.next', [descriptor('other.echo')])],
    }, context)).rejects.toThrow(DuplicateCapabilityError);
    await expect(kernel.runtimeSearch({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name: 'extension.echo',
    }, context)).resolves.toMatchObject({
      matches: [{ capability: { provider: { id: 'extension.provider' } } }],
    });
  });

  it('does not change live registrations when replacement is cancelled', async () => {
    const kernel = deterministicKernel();
    const first = await kernel.registerContributions({
      providers: [provider('extension.provider', [descriptor('extension.echo')])],
    }, context);

    await expect(first.replace({
      providers: [provider('extension.next', [descriptor('extension.next')])],
    }, {
      ...context,
      signal: { aborted: true, reason: 'cancelled by test' },
    })).rejects.toThrow(/cancelled/i);
    expect((await kernel.get('extension.echo', context))?.provider.id).toBe(
      'extension.provider',
    );
    expect(await kernel.get('extension.next', context)).toBeUndefined();
  });
});

describe('RuntimeKernel.runtimeSearch', () => {
  it('adds non-capability discoveries without changing capability matches', async () => {
    const catalogEntries = [
      {
        id: 'skill://marshal.runtime/use-runtime',
        kind: 'skill',
        title: 'Use the runtime',
        description: 'Read the runtime skill.',
        tags: ['runtime', 'skill'],
        action: { type: 'resource_read', uri: 'skill://marshal.runtime/use-runtime' },
      },
      {
        id: 'resource:resource://marshal/runtime-guide',
        kind: 'resource',
        title: 'Runtime guide resource',
        description: 'Read the runtime guide resource.',
        tags: ['runtime', 'resource'],
        action: { type: 'resource_read', uri: 'resource://marshal/runtime-guide' },
      },
      {
        id: 'host-tool://codex/runtime_exec',
        kind: 'host_tool',
        title: 'Runtime execution host tool',
        description: 'Invoke the runtime execution tool.',
        tags: ['runtime', 'host_tool'],
        action: { type: 'host_tool', toolId: 'runtime_exec' },
      },
      {
        id: 'ui://marshal/runtime-dashboard',
        kind: 'ui_application',
        title: 'Runtime dashboard',
        description: 'Open the runtime dashboard application.',
        tags: ['runtime', 'ui', 'application'],
        action: {
          type: 'ui_render',
          renderId: 'runtime-dashboard',
          resourceUri: 'ui://marshal/runtime-dashboard/index.html',
        },
      },
    ] satisfies readonly RuntimeCatalogEntry[];
    const catalog: RuntimeCatalogProvider = {
      id: 'docs',
      list: () => catalogEntries,
      get: (id) => catalogEntries.find((entry) => entry.id === id),
    };
    const capabilities = [
      descriptor('runtime.inspect', {
        title: 'Inspect runtime',
        tags: ['runtime'],
      }),
    ];
    const baseline = deterministicKernel();
    baseline.register(provider('runtime', capabilities));
    const kernel = deterministicKernel({ catalogProviders: [catalog] });
    kernel.register(provider('runtime', capabilities));

    const request = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      query: 'runtime',
    } as const;
    const [baselineResponse, response] = await Promise.all([
      baseline.runtimeSearch(request, context),
      kernel.runtimeSearch(request, context),
    ]);
    expect(response.matches).toEqual(baselineResponse.matches);
    expect(response.discoveries?.map((match) => match.entry.kind).sort()).toEqual([
      'host_tool',
      'resource',
      'skill',
      'ui_application',
    ]);

    const exactCapability = await kernel.runtimeSearch(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'runtime.inspect',
      },
      context,
    );
    expect(exactCapability.matches).toHaveLength(1);
    expect(exactCapability.discoveries).toBeUndefined();

    for (const entry of catalogEntries) {
      const exactCatalog = await kernel.runtimeSearch(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          catalogId: entry.id,
        },
        context,
      );
      expect(exactCatalog.matches).toEqual([]);
      expect(exactCatalog.discoveries).toEqual([
        expect.objectContaining({
          entry: expect.objectContaining({ id: entry.id, kind: entry.kind }),
        }),
      ]);
    }

    const longCatalogId = `catalog://test/${'界'.repeat(700)}`;
    expect(longCatalogId.length).toBeGreaterThan(512);
    const longCatalogKernel = deterministicKernel({
      catalogProviders: [{
        id: 'long-catalog',
        list: () => [{
          id: longCatalogId,
          kind: 'resource',
          title: 'Long catalog resource',
          description: 'A valid exact catalog ID beyond generic identifier bounds.',
          action: { type: 'resource_read', uri: 'resource://long-catalog' },
        }],
      }],
    });
    await expect(longCatalogKernel.runtimeSearch(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        catalogId: longCatalogId,
      },
      context,
    )).resolves.toMatchObject({
      discoveries: [
        expect.objectContaining({
          entry: expect.objectContaining({ id: longCatalogId }),
        }),
      ],
    });
    await expect(longCatalogKernel.runtimeSearch(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        catalogId: 'x'.repeat(RUNTIME_CATALOG_ID_MAX_LENGTH + 1),
      },
      context,
    )).rejects.toThrow(`at most ${RUNTIME_CATALOG_ID_MAX_LENGTH} characters`);
    const overboundEntryKernel = deterministicKernel({
      catalogProviders: [{
        id: 'overbound-catalog',
        list: () => [{
          id: 'x'.repeat(RUNTIME_CATALOG_ID_MAX_LENGTH + 1),
          kind: 'resource',
          title: 'Over-bound catalog resource',
          description: 'Must fail catalog validation.',
          action: { type: 'resource_read', uri: 'resource://overbound-catalog' },
        }],
      }],
    });
    await expect(overboundEntryKernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: 'over-bound' },
      context,
    )).rejects.toThrow(`exceeds ${RUNTIME_CATALOG_ID_MAX_LENGTH} characters`);
  });

  it('rejects duplicate catalog provider and entry identities', async () => {
    const entry = {
      id: 'resource://shared',
      kind: 'resource' as const,
      title: 'Shared resource',
      description: 'Duplicate catalog fixture.',
      action: { type: 'resource_read' as const, uri: 'resource://shared' },
    };
    const providerOne: RuntimeCatalogProvider = { id: 'one', list: () => [entry] };
    const providerTwo: RuntimeCatalogProvider = { id: 'two', list: () => [entry] };
    expect(() => deterministicKernel({
      catalogProviders: [providerOne, { ...providerTwo, id: 'one' }],
    })).toThrow(DuplicateProviderError);
    const kernel = deterministicKernel({ catalogProviders: [providerOne, providerTwo] });
    await expect(kernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: 'shared' },
      context,
    )).rejects.toThrow(DuplicateCapabilityError);
  });

  it('ranks, filters, limits, and deterministically orders capabilities', async () => {
    const kernel = deterministicKernel();
    kernel.register(
      provider('memory', [
        descriptor('memory.search', {
          title: 'Memory search',
          tags: ['memory', 'read'],
          description: 'Search durable memory.',
        }),
        descriptor('memory.store', {
          tags: ['memory', 'write'],
          description: 'Store durable memory.',
        }),
      ]),
    );
    kernel.register(
      provider('code', [
        descriptor('code.search', {
          tags: ['code', 'read'],
          description: 'Search indexed code.',
        }),
      ]),
    );

    const response = await kernel.runtimeSearch(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        query: 'search',
        tags: ['read'],
        limit: 2,
      },
      context,
    );
    expect(response.matches.map((match) => match.capability.name)).toEqual([
      'memory.search',
      'code.search',
    ]);
    expect(response.matches.every((match) => match.score > 0)).toBe(true);
    expect(response.detail).toBe('summary');

    const onlyMemory = await kernel.runtimeSearch(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        providerIds: ['memory'],
        limit: 10,
      },
      context,
    );
    expect(onlyMemory.matches.map((match) => match.capability.name)).toEqual([
      'memory.search',
      'memory.store',
    ]);
  });

  it('keeps broad discovery compact while exact and explicit full lookups retain schemas', async () => {
    const kernel = deterministicKernel();
    const largeSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`field${index}`, { type: 'string' }]),
      ),
    };
    kernel.register(provider('applications', [
      descriptor('ui.render', {
        title: 'Render application',
        tags: ['ui', 'write'],
        inputSchema: largeSchema,
        outputSchema: {
          type: 'object',
          properties: { renderId: { type: 'string' } },
          additionalProperties: false,
        },
        permissions: [{ permission: 'ui.render', risk: 'low' }],
        annotations: { examples: Array.from({ length: 50 }, (_, index) => `example-${index}`) },
      }),
    ]));

    const broad = await kernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: 'render application' },
      context,
    );
    expect(broad).toMatchObject({ detail: 'summary' });
    expect(broad.matches[0]?.capability).toMatchObject({
      name: 'ui.render',
      tags: ['ui', 'write'],
      permissions: [{ permission: 'ui.render', risk: 'low' }],
      provider: { id: 'applications' },
    });
    expect(broad.matches[0]?.capability).not.toHaveProperty('inputSchema');
    expect(broad.matches[0]?.capability).not.toHaveProperty('outputSchema');
    expect(broad.matches[0]?.capability).not.toHaveProperty('annotations');

    const explicitFull = await kernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: 'render', detail: 'full' },
      context,
    );
    expect(explicitFull.detail).toBe('full');
    expect(explicitFull.matches[0]?.capability.inputSchema).toEqual(largeSchema);
    expect(explicitFull.matches[0]?.capability.annotations).toBeDefined();

    const exact = await kernel.runtimeSearch(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'ui.render',
        detail: 'summary',
      },
      context,
    );
    expect(exact.detail).toBe('full');
    expect(exact.matches[0]?.capability.inputSchema).toEqual(largeSchema);
    expect(JSON.stringify(broad).length).toBeLessThan(JSON.stringify(exact).length / 4);
  });

  it('rejects incompatible request versions', async () => {
    const kernel = deterministicKernel();
    await expect(kernel.runtimeSearch({ protocolVersion: '2.0.0' }, context)).rejects.toThrow(
      UnsupportedProtocolVersionError,
    );
  });

  it('rejects an unknown discovery detail at the portable boundary', async () => {
    const kernel = deterministicKernel();
    await expect(kernel.runtimeSearch(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        query: 'memory',
        detail: 'everything' as 'full',
      },
      context,
    )).rejects.toThrow(/detail.*summary.*full/i);
  });

  it('resolves exact capability names without depending on semantic query ranking', async () => {
    const kernel = deterministicKernel();
    kernel.register(provider('memory', [
      descriptor('memory.search', { tags: ['memory', 'read'] }),
      descriptor('memory.store', { tags: ['memory', 'write'] }),
    ]));

    const response = await kernel.runtimeSearch(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'memory.search',
        query: 'completely unrelated prose',
      },
      context,
    );
    expect(response.matches).toHaveLength(1);
    expect(response.detail).toBe('full');
    expect(response.matches[0]).toMatchObject({
      capability: { name: 'memory.search' },
      matchedFields: expect.arrayContaining(['name']),
    });

    const missing = await kernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, name: 'memory.missing' },
      context,
    );
    expect(missing.matches).toEqual([]);
    await expect(kernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, name: '  ' },
      context,
    )).rejects.toThrow(/non-empty/i);
  });
});

describe('RuntimeKernel.runtimeExec', () => {
  it('fails closed when semantic output violates the declared schema', async () => {
    const kernel = deterministicKernel();
    kernel.register(provider(
      'broken-output',
      [descriptor('broken.output', {
        outputSchema: {
          type: 'object',
          properties: { count: { type: 'integer', minimum: 0 } },
          required: ['count'],
          additionalProperties: false,
        },
      })],
      vi.fn(async () => ({ output: { count: 'unbounded', secret: 'must not escape' } })),
    ));

    const response = await kernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'broken.output' },
      context,
    );

    expect(response).toMatchObject({
      status: 'failed',
      error: { code: 'capability_output_schema_mismatch' },
      receipt: { status: 'failed' },
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).not.toContain('must not escape');
  });

  it('denies execution by default unless the host explicitly supplies a broker', async () => {
    const invoke = vi.fn(async () => ({ output: 'must-not-run' }));
    const kernel = new RuntimeKernel();
    kernel.register(provider('tools', [descriptor('tools.echo')], invoke));

    await expect(kernel.runtimeExec(
      { protocolVersion: '1.0.0', target: 'tools.echo', input: { value: 'hello' } },
      context,
    )).resolves.toMatchObject({
      status: 'denied',
      error: { code: 'permission_broker_required' },
      receipt: { permission: { decision: 'deny', code: 'permission_broker_required' } },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exposes adapter aliases and routes inline source through an executor provider', async () => {
    const invoke = vi.fn(async (_name: string, input: unknown) => ({ output: input }));
    const kernel = deterministicKernel();
    kernel.register(provider('executor', [descriptor(INLINE_MODULE_EXECUTOR_CAPABILITY, {
      outputSchema: {
        type: 'object',
        properties: { source: {}, input: {}, timeoutMs: {}, executionMode: {} },
        required: ['source'],
        additionalProperties: false,
      },
    })], invoke));

    const search = await kernel.search(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: 'inline module' },
      context,
    );
    expect(search.matches[0]?.capability.name).toBe(INLINE_MODULE_EXECUTOR_CAPABILITY);

    const result = await kernel.execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        targetType: 'inline_module',
        source: 'export default input => input.value * 2',
        input: { value: 21 },
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(invoke).toHaveBeenCalledWith(
      INLINE_MODULE_EXECUTOR_CAPABILITY,
      {
        source: 'export default input => input.value * 2',
        input: { value: 21 },
        timeoutMs: undefined,
        executionMode: undefined,
      },
      expect.objectContaining({ principal: context.principal }),
    );
  });

  it('routes portable workspace and artifact module references without resolving them in core', async () => {
    const invoke = vi.fn(async (_name: string, input: unknown) => ({ output: input }));
    const kernel = deterministicKernel();
    kernel.register(provider('executor', [descriptor(MODULE_EXECUTOR_CAPABILITY, {
      outputSchema: {
        type: 'object',
        properties: { module: {}, input: {}, timeoutMs: {}, executionMode: {} },
        required: ['module'],
        additionalProperties: false,
      },
    })], invoke));

    const module = {
      kind: 'workspace_file' as const,
      path: '.agent/execution/analyze.ts',
      export: 'run',
    };
    const result = await kernel.execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        targetType: 'module',
        module,
        input: { query: 'auth' },
      },
      context,
    );

    expect(result.status).toBe('success');
    expect(invoke).toHaveBeenCalledWith(
      MODULE_EXECUTOR_CAPABILITY,
      {
        module,
        input: { query: 'auth' },
      },
      expect.objectContaining({ principal: context.principal }),
    );
  });

  it('invokes with context and preserves output, evidence, and provider receipt', async () => {
    const provenance = [{ source: 'brain', trust: 'high' as const }];
    const diagnostics = [
      { level: 'info' as const, code: 'cache_hit', message: 'Used cached index.' },
    ];
    const artifacts = [{ id: 'artifact-1', kind: 'report' }];
    const providerReceipt = { sourceRequestId: 'source-1' };
    const invoke = vi.fn(async () => ({
      output: { answer: 42 },
      provenance,
      diagnostics,
      artifacts,
      receipt: providerReceipt,
    }));
    const kernel = deterministicKernel();
    kernel.register(provider('brain', [descriptor('memory.search', {
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'number' } },
        required: ['answer'],
        additionalProperties: false,
      },
    })], invoke));

    const response = await kernel.runtimeExec<{ answer: number }>(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        target: 'memory.search',
        input: { query: 'answer' },
        requestId: 'request-1',
      },
      context,
    );

    expect(response.status).toBe('success');
    expect(response.result?.output).toEqual({ answer: 42 });
    expect(response.result?.provenance).toBe(provenance);
    expect(response.result?.diagnostics).toBe(diagnostics);
    expect(response.receipt).not.toHaveProperty('correlations');
    expect(response.receipt).toMatchObject({
      executionId: 'request-1',
      requestId: 'request-1',
      target: 'memory.search',
      provider: { id: 'brain', version: '2.0.0' },
      capabilityVersion: '1.0.0',
      principalId: 'agent-1',
      status: 'success',
      durationMs: 25,
      provenance,
      diagnostics,
      artifacts,
      providerReceipt,
    });
    expect(invoke).toHaveBeenCalledWith(
      'memory.search',
      { query: 'answer' },
      expect.objectContaining({ executionId: 'request-1', principal: context.principal }),
    );
  });

  it('records stable identity and explicit parent-child lineage in an observational sink', async () => {
    const receipts: unknown[] = [];
    const kernel = deterministicKernel({
      receiptSink: { record: (receipt) => { receipts.push(receipt); } },
    });
    kernel.register(provider('test', [descriptor('test.run')]));

    const response = await kernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.run', requestId: 'child' },
      {
        ...context,
        identity: {
          harnessId: 'test-harness',
          installationId: 'install-1',
          profileId: 'profile-1',
          agentId: 'agent-1',
        },
        lineage: { rootExecutionId: 'root', parentExecutionId: 'root', depth: 1 },
      },
    );

    expect(response.receipt).toMatchObject({
      identity: { harnessId: 'test-harness', installationId: 'install-1' },
      lineage: { rootExecutionId: 'root', parentExecutionId: 'root', depth: 1 },
    });
    expect(receipts).toEqual([response.receipt]);
  });

  it('records only correlations carried through the trusted opaque context', async () => {
    const kernel = deterministicKernel();
    kernel.register(provider('test', [descriptor('test.run')]));
    const longId = `${'shared-prefix-'.padEnd(513, 'x')}a`;
    const correlations = [
      createRuntimeExecutionCorrelation('mcpRequestId', 7),
      createRuntimeExecutionCorrelation('callerRequestId', '7'),
      createRuntimeExecutionCorrelation('codexToolUseId', longId),
    ];

    const trusted = await kernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.run' },
      {
        ...context,
        receiptCorrelationContext: createRuntimeReceiptCorrelationContext(correlations),
        metadata: {
          correlations: [{ authority: 'transport-correlation', value: 'forged' }],
          secret: 'must-not-persist',
        },
      },
    );
    expect(trusted.receipt.correlations).toEqual(correlations);
    expect(trusted.receipt).not.toHaveProperty('metadata');

    const forged = await kernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.run' },
      {
        ...context,
        receiptCorrelationContext:
          {} as unknown as RuntimeReceiptCorrelationContext,
        metadata: {
          mcpRequestId: { type: 'string', value: 'forged' },
        },
      },
    );
    expect(forged.receipt).not.toHaveProperty('correlations');
  });

  it('does not let receipt-sink failures alter a completed execution', async () => {
    const kernel = deterministicKernel({
      receiptSink: { record: () => { throw new Error('disk unavailable'); } },
    });
    kernel.register(provider('test', [descriptor('test.run')]));
    await expect(kernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.run' },
      context,
    )).resolves.toMatchObject({ status: 'success' });
  });

  it.each<{
    decision: PermissionDecision;
    status: 'denied' | 'approval_required';
  }>([
    {
      decision: { decision: 'deny', reason: 'Not granted.', code: 'no_grant' },
      status: 'denied',
    },
    {
      decision: {
        decision: 'approval',
        reason: 'Destructive operation.',
        approvalId: 'approval-1',
        prompt: 'Allow deletion?',
      },
      status: 'approval_required',
    },
  ])('does not invoke when permission result is $status', async ({ decision, status }) => {
    const invoke = vi.fn(async () => ({ output: true }));
    const permissionBroker = { decide: vi.fn(async () => decision) };
    const kernel = deterministicKernel({ permissionBroker });
    kernel.register(
      provider(
        'files',
        [
          descriptor('files.delete', {
            permissions: [{ permission: 'filesystem.delete', risk: 'high' }],
          }),
        ],
        invoke,
      ),
    );

    const response = await kernel.runtimeExec(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        target: 'files.delete',
      },
      context,
    );
    expect(response.status).toBe(status);
    expect(response.receipt.permission).toBe(decision);
    expect(response.approval).toBe(decision.decision === 'approval' ? decision : undefined);
    expect(invoke).not.toHaveBeenCalled();
    expect(permissionBroker.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        requirements: [{ permission: 'filesystem.delete', risk: 'high' }],
      }),
    );
  });

  it('returns standardized not-found, broker, provider, and cancellation failures', async () => {
    const missingKernel = deterministicKernel();
    const missing = await missingKernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'missing' },
      context,
    );
    expect(missing).toMatchObject({
      status: 'not_found',
      error: { code: 'capability_not_found' },
      receipt: { status: 'not_found', target: 'missing' },
    });

    const brokerKernel = deterministicKernel({
      permissionBroker: { decide: () => Promise.reject(new Error('policy offline')) },
    });
    brokerKernel.register(provider('test', [descriptor('test.run')]));
    const brokerFailure = await brokerKernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.run' },
      context,
    );
    expect(brokerFailure).toMatchObject({
      status: 'failed',
      error: { code: 'permission_broker_failed', message: 'policy offline' },
    });

    const failingKernel = deterministicKernel();
    failingKernel.register(
      provider(
        'test',
        [descriptor('test.run')],
        vi.fn(async () => {
          throw new Error('provider exploded');
        }),
      ),
    );
    const providerFailure = await failingKernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.run' },
      context,
    );
    expect(providerFailure).toMatchObject({
      status: 'failed',
      error: { code: 'capability_execution_failed', message: 'provider exploded' },
    });

    const typedFailureKernel = deterministicKernel();
    typedFailureKernel.register(
      provider(
        'test',
        [descriptor('test.typed-failure')],
        vi.fn(async () => {
          throw Object.assign(new Error('configured limit exceeded'), {
            code: 'CONFIGURED_LIMIT_EXCEEDED',
          });
        }),
      ),
    );
    const typedFailure = await typedFailureKernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.typed-failure' },
      context,
    );
    expect(typedFailure).toMatchObject({
      status: 'failed',
      error: { code: 'CONFIGURED_LIMIT_EXCEEDED', message: 'configured limit exceeded' },
    });

    const cancelled = await missingKernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'anything' },
      { ...context, signal: { aborted: true, reason: 'user' } },
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      error: { code: 'execution_cancelled' },
    });
  });

  it('does not invoke a provider when a structural signal aborts during permission checks', async () => {
    const signal: { aborted: boolean; reason?: unknown } = { aborted: false };
    let permissionReached!: () => void;
    let releasePermission!: (decision: PermissionDecision) => void;
    const reachedPermission = new Promise<void>((resolve) => {
      permissionReached = resolve;
    });
    const pendingPermission = new Promise<PermissionDecision>((resolve) => {
      releasePermission = resolve;
    });
    const invoke = vi.fn(async () => ({ output: true }));
    const kernel = deterministicKernel({
      permissionBroker: {
        decide: vi.fn(() => {
          permissionReached();
          return pendingPermission;
        }),
      },
    });
    kernel.register(provider('test', [descriptor('test.run')], invoke));

    const pendingExecution = kernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.run' },
      { ...context, signal },
    );
    await reachedPermission;
    signal.aborted = true;
    signal.reason = 'user';
    releasePermission({ decision: 'allow' });

    await expect(pendingExecution).resolves.toMatchObject({
      status: 'cancelled',
      error: { code: 'execution_cancelled' },
      receipt: { status: 'cancelled' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('discards a provider result when a structural signal aborts during invocation', async () => {
    const signal: { aborted: boolean; reason?: unknown } = { aborted: false };
    let invocationReached!: () => void;
    let releaseInvocation!: () => void;
    const reachedInvocation = new Promise<void>((resolve) => {
      invocationReached = resolve;
    });
    const pendingInvocation = new Promise<void>((resolve) => {
      releaseInvocation = resolve;
    });
    const invoke = vi.fn(async () => {
      invocationReached();
      await pendingInvocation;
      return { output: { stale: true } };
    });
    const kernel = deterministicKernel();
    kernel.register(provider('test', [descriptor('test.run')], invoke));

    const pendingExecution = kernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.run' },
      { ...context, signal },
    );
    await reachedInvocation;
    signal.aborted = true;
    signal.reason = 'user';
    releaseInvocation();

    const response = await pendingExecution;
    expect(response).toMatchObject({
      status: 'cancelled',
      error: { code: 'execution_cancelled' },
      receipt: { status: 'cancelled' },
    });
    expect(response.result).toBeUndefined();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('emits lifecycle events in execution order without allowing listeners to break execution', async () => {
    const events: string[] = [];
    const kernel = deterministicKernel();
    kernel.observeLifecycle((event) => {
      events.push(event.type);
      if (event.type === 'runtime.execution.started') {
        throw new Error('observer failed');
      }
    });
    kernel.register(provider('test', [descriptor('test.run')]));
    const response = await kernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: 'test.run' },
      context,
    );

    expect(response.status).toBe('success');
    expect(events).toEqual([
      'runtime.provider.registered',
      'runtime.execution.permission',
      'runtime.execution.started',
      'runtime.execution.completed',
    ]);
  });

  it('drains lifecycle emissions started by synchronous registration disposal', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const kernel = deterministicKernel({
      lifecycle: {
        async publish(event) {
          events.push(event.type);
          await gate;
        },
      },
    });
    const registration = kernel.register(provider('test', [descriptor('test.run')]));
    registration.dispose();

    let drained = false;
    const draining = kernel.drainLifecycleEmissions().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await draining;
    expect(events).toEqual([
      'runtime.provider.registered',
      'runtime.provider.disposed',
    ]);
  });
});
