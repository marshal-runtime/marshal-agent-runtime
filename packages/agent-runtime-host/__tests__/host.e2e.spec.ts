import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_CATALOG_ID_MAX_LENGTH,
  RUNTIME_RESOURCE_URI_MAX_LENGTH,
  RuntimeKernel,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
  type PermissionBroker,
  type RuntimeBackgroundJobHandler,
  type RuntimeCatalogProvider,
  type RuntimeExecutionReceipt,
} from '@marshal/agent-runtime-core';
import { BackgroundJobManager } from '@marshal/agent-runtime-effects';
import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
  INLINE_MODULE_EXECUTOR_CAPABILITY,
  TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY,
  type AgentRuntimeHostOptions,
  type RuntimeCallContext,
  type RuntimeHostFactoryContext,
  type RuntimeHostProviderBundle,
  type RuntimeHostProviderSource,
  type RuntimeLifecyclePort,
  type RuntimeScopedResourcePort,
} from '../src/index.js';
import {
  createRuntimeServiceContainer,
  getRuntimeServiceContainer,
} from '@marshal/agent-runtime-composer';

const cleanup: string[] = [];

afterEach(async () => {
  for (const target of cleanup.splice(0)) {
    await fs.rm(target, { recursive: true, force: true });
  }
});

const allowAll: PermissionBroker = { decide: () => ({ decision: 'allow' }) };

type TestAgentRuntimeOptions = AgentRuntimeHostOptions
  & { readonly loadDefaultProviders?: boolean; readonly isolated?: boolean };

function createTestAgentRuntime(options: TestAgentRuntimeOptions) {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  const loadDefaultProviders = options.loadDefaultProviders !== false;
  const privateRoot =
    options.protectedLifecycleResultRoot
    ?? path.join(path.dirname(workspacePath), '.marshal-test-private');
  const {
    loadDefaultProviders: _loadDefaultProviders,
    providerSources = [],
    ...hostOptions
  } = options;
  const serviceContainer = options.serviceContainer
    ?? (options.isolated ? createRuntimeServiceContainer() : getRuntimeServiceContainer());
  const builtins = createRuntimeBuiltinsSource({
    artifacts: loadDefaultProviders,
    importPolicy: options.importPolicy,
    inlineTimeoutMs: options.inlineTimeoutMs,
    inlineMaxTimeoutMs: options.inlineMaxTimeoutMs,
    inlineMaxOutputBytes: options.inlineMaxOutputBytes,
    inlineMaxSourceCharacters: options.inlineMaxSourceCharacters,
    moduleMaxSourceBytes: options.moduleMaxSourceBytes,
    moduleMaxBrokerInvocations: options.moduleMaxBrokerInvocations,
    moduleMaxConcurrentBrokerInvocations: options.moduleMaxConcurrentBrokerInvocations,
    effectHandler: options.effectHandler,
    effectApprovalVerifier: options.effectApprovalVerifier,
  });
  return createAgentRuntime({
    ...hostOptions,
    serviceContainer,
    codeIntelligence: options.codeIntelligence ?? (options.isolated ? false : undefined),
    workspacePath,
    protectedLifecycleResultRoot: privateRoot,
    permissionPatterns: options.permissionPatterns,
    trustedPermissionPatterns: options.trustedPermissionPatterns,
    providerSources: [
      builtins,
      ...providerSources,
    ],
  });
}

function echoProvider(count = 1): CapabilityProvider {
  const descriptors: CapabilityDescriptor[] = Array.from({ length: count }, (_, index) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: index === 0 ? 'test.echo' : `test.echo.${index}`,
    version: '1.0.0',
    description: 'Echo a JSON value.',
    tags: ['test', 'echo'],
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
    },
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
      additionalProperties: false,
    },
    annotations: { category: 'test' },
    permissions: [{ permission: 'test.echo', risk: 'low' }],
  }));
  const names = new Set(descriptors.map((descriptor) => descriptor.name));
  return {
    id: 'test.echo-provider',
    list: () => descriptors,
    get: (name) => descriptors.find((descriptor) => descriptor.name === name),
    invoke: async (name, input) => {
      if (!names.has(name)) throw new Error('unknown echo capability');
      return { output: input };
    },
  };
}

async function workspace(): Promise<{ parent: string; workspacePath: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-host-'));
  cleanup.push(parent);
  const workspacePath = path.join(parent, 'workspace');
  await fs.mkdir(workspacePath);
  return { parent, workspacePath };
}

describe('createAgentRuntime', () => {
  it('preserves an injected service container by exact identity', async () => {
    const serviceContainer = createRuntimeServiceContainer();
    let observedContainer: unknown;
    const runtime = await createTestAgentRuntime({
      loadDefaultProviders: false,
      serviceContainer,
      providerSources: [
        (context) => {
          observedContainer = context.serviceContainer;
          return [];
        },
      ],
    });
    cleanup.push(runtime.stateRoot);

    expect(runtime.serviceContainer).toBe(serviceContainer);
    expect(observedContainer).toBe(serviceContainer);
    await runtime.dispose();
  });

  it('starts with no domain capabilities when no provider sources are selected', async () => {
    const location = await workspace();
    const privateRoot = path.join(location.parent, 'private-empty');
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      protectedLifecycleResultRoot: privateRoot,
      loadDefaultProviders: false,
      isolated: true,
      codeIntelligence: false,
      permissionBroker: allowAll,
      providerSources: [],
    });
    try {
      await expect(runtime.kernel.search(
        { query: 'anything' },
        { sessionId: 'empty' },
      )).resolves.toMatchObject({ matches: [] });
      await expect(runtime.kernel.execute(
        { targetType: 'operation', target: 'missing.operation' },
        { sessionId: 'empty' },
      )).resolves.toMatchObject({ status: 'not_found' });
      expect(runtime.providers.every((provider) =>
        !/brain|memory|attachment/i.test(provider.id),
      )).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('composes catalog and resource ports and exposes the shared source context', async () => {
    const location = await workspace();
    const longResourceUri =
      `resource://${'界'.repeat(RUNTIME_RESOURCE_URI_MAX_LENGTH - 'resource://'.length)}`;
    let capturedJobManager: BackgroundJobManager | undefined;
    const catalog: RuntimeCatalogProvider = {
      id: 'test.catalog',
      list: () => [
        {
          id: 'skill://test/runtime',
          kind: 'skill',
          title: 'Runtime test skill',
          description: 'Use the runtime test provider.',
          tags: ['runtime', 'test', 'skill'],
          action: { type: 'resource_read', uri: 'skill://test/runtime' },
        },
        {
          id: 'host-tool://test/runtime_tool',
          kind: 'host_tool',
          title: 'Runtime test host tool',
          description: 'Use the runtime test harness tool.',
          tags: ['runtime', 'test', 'host_tool'],
          action: { type: 'host_tool', toolId: 'runtime_tool' },
        },
        {
          id: 'ui://test/runtime-application',
          kind: 'ui_application',
          title: 'Runtime test application',
          description: 'Open the runtime test application.',
          tags: ['runtime', 'test', 'ui'],
          action: {
            type: 'ui_render',
            renderId: 'runtime-application',
            resourceUri: 'ui://test/runtime-application/index.html',
          },
        },
      ],
    };
    const resource = (
      uri: string,
      toolName: string,
    ): RuntimeScopedResourcePort => ({
      listResources: async (context) =>
        context.scope.sessionId === 'catalog'
          ? [{
              uri,
              name: `Runtime test resource ${uri}`,
              description: 'Context-visible runtime test resource.',
              mimeType: 'text/plain',
            }]
          : [],
      readResource: async () => ({ uri, mimeType: 'text/plain', text: uri }),
      listRenderTools: async () => [{
        name: toolName,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
      invokeRenderTool: async (name) =>
        name === toolName
          ? { content: [{ type: 'text', text: `called:${name}` }] }
          : undefined,
    });

    const searchProxyProvider = (sourceContext: RuntimeHostFactoryContext): CapabilityProvider => ({
      id: 'test.search-proxy',
      list: () => [{
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'test.search-proxy',
        version: '1.0.0',
        description: 'Invoke runtime search through the provider-source context.',
        outputSchema: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
          additionalProperties: false,
        },
      }],
      async invoke(_name, _input, invocationContext) {
        const search = await sourceContext.operationInvoker.search(
          { query: 'echo' },
          invocationContext,
        );
        return { output: { count: search.matches.length } };
      },
    });
    const nestedChildContexts: InvocationContext[] = [];
    const executeProxyProvider = (
      sourceContext: RuntimeHostFactoryContext,
    ): CapabilityProvider => ({
      id: 'test.execute-proxy',
      list: () => [
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          name: 'test.execute-proxy',
          version: '1.0.0',
          description: 'Invoke a child operation through the provider-source context.',
          outputSchema: {
            type: 'object',
            properties: {
              children: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    executionId: { type: 'string' },
                    requestId: { type: 'string' },
                  },
                  required: ['executionId', 'requestId'],
                  additionalProperties: false,
                },
              },
            },
            required: ['children'],
            additionalProperties: false,
          },
        },
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          name: 'test.execute-child',
          version: '1.0.0',
          description: 'Capture child execution context.',
          outputSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      ],
      async invoke(name, input, invocationContext) {
        if (name === 'test.execute-child') {
          nestedChildContexts.push(invocationContext);
          return { output: { ok: true } };
        }
        const requestIds =
          input
          && typeof input === 'object'
          && 'requestIds' in input
          && Array.isArray(input.requestIds)
            ? input.requestIds.filter((value): value is string => typeof value === 'string')
            : [];
        const responses = await Promise.all(
          (requestIds.length > 0 ? requestIds : [undefined]).map((requestedId) =>
            sourceContext.operationInvoker.execute(
              {
                targetType: 'operation',
                target: 'test.execute-child',
                ...(requestedId ? { requestId: requestedId } : {}),
              },
              invocationContext,
            )),
        );
        return {
          output: {
            children: responses.map((response) => ({
              executionId: response.receipt.executionId,
              requestId: response.receipt.requestId ?? response.receipt.executionId,
            })),
          },
        };
      },
    });
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      providerSources: [
        (context) => {
          capturedJobManager = context.jobManager;
          return {
            providers: [
              echoProvider(),
              searchProxyProvider(context),
              executeProxyProvider(context),
            ],
            catalog,
            resources: resource('resource://one', 'render_one'),
          };
        },
        async () => ({
          providers: [],
          resources: resource('resource://two', 'render_two'),
        }),
        async () => ({
          providers: [],
          resources: resource(longResourceUri, 'render_long'),
        }),
      ],
    });
    try {
      expect(capturedJobManager).toBeInstanceOf(BackgroundJobManager);
      const search = await runtime.kernel.search(
        { query: 'runtime test' },
        { sessionId: 'catalog' },
      );
      expect([...new Set(search.discoveries?.map((match) => match.entry.kind))].sort()).toEqual([
        'host_tool',
        'resource',
        'skill',
        'ui_application',
      ]);
      const projectedResource = search.discoveries?.find(
        ({ entry }) =>
          entry.kind === 'resource'
          && entry.action.type === 'resource_read'
          && entry.action.uri === 'resource://two',
      );
      expect(projectedResource).toBeDefined();
      expect(projectedResource).toMatchObject({
        entry: {
          id:
            `catalog://marshal.runtime-resource-catalog/resource/${
              encodeURIComponent('resource://two')
            }`,
          metadata: {
            owner: {
              type: 'catalog_provider',
              id: 'marshal.runtime-resource-catalog',
            },
          },
        },
      });
      const longProjectedResource = search.discoveries?.find(
        ({ entry }) =>
          entry.kind === 'resource'
          && entry.action.type === 'resource_read'
          && entry.action.uri === longResourceUri,
      );
      expect(longProjectedResource?.entry.id.length).toBeGreaterThan(512);
      expect(longProjectedResource?.entry.id.length).toBeLessThanOrEqual(
        RUNTIME_CATALOG_ID_MAX_LENGTH,
      );
      await expect(runtime.kernel.search(
        { catalogId: longProjectedResource!.entry.id },
        { sessionId: 'catalog' },
      )).resolves.toMatchObject({
        matches: [],
        discoveries: [
          expect.objectContaining({
            entry: expect.objectContaining({
              id: longProjectedResource!.entry.id,
              action: { type: 'resource_read', uri: longResourceUri },
            }),
          }),
        ],
      });
      const brokeredLongCatalog = await runtime.kernel.execute(
        {
          targetType: 'inline_module',
          source: `
            export default async (input, context) => {
              const found = await context.runtime.search({ catalogId: input.catalogId });
              return found.discoveries[0].entry.id;
            };
          `,
          input: { catalogId: longProjectedResource!.entry.id },
        },
        { sessionId: 'catalog', requestId: 'long-catalog-broker' },
      );
      expect(brokeredLongCatalog.result?.output).toMatchObject({
        ok: true,
        value: longProjectedResource!.entry.id,
      });
      const overboundCatalogId = 'x'.repeat(RUNTIME_CATALOG_ID_MAX_LENGTH + 1);
      await expect(runtime.kernel.search(
        { catalogId: overboundCatalogId },
        { sessionId: 'catalog' },
      )).rejects.toThrow(`at most ${RUNTIME_CATALOG_ID_MAX_LENGTH} characters`);
      const brokeredOverboundCatalog = await runtime.kernel.execute(
        {
          targetType: 'inline_module',
          source: `
            export default async (input, context) =>
              context.runtime.search({ catalogId: input.catalogId });
          `,
          input: { catalogId: overboundCatalogId },
        },
        { sessionId: 'catalog', requestId: 'overbound-catalog-broker' },
      );
      expect(brokeredOverboundCatalog.result?.output).toMatchObject({
        ok: false,
        error: {
          code: 'BROKER_ERROR',
          message: expect.stringContaining(
            `at most ${RUNTIME_CATALOG_ID_MAX_LENGTH} characters`,
          ),
        },
      });
      await expect(runtime.kernel.search(
        { catalogId: projectedResource!.entry.id },
        { sessionId: 'catalog' },
      )).resolves.toMatchObject({
        matches: [],
        discoveries: [
          expect.objectContaining({
            entry: expect.objectContaining({
              kind: 'resource',
              action: { type: 'resource_read', uri: 'resource://two' },
            }),
          }),
        ],
      });
      const hiddenResource = await runtime.kernel.search(
        { catalogId: projectedResource!.entry.id },
        { sessionId: 'hidden' },
      );
      expect(hiddenResource.matches).toEqual([]);
      expect(hiddenResource.discoveries ?? []).toEqual([]);
      await expect(runtime.resources?.listResources({ sessionId: 'catalog' })).resolves.toEqual(
        expect.arrayContaining([
        expect.objectContaining({ uri: 'resource://one' }),
        expect.objectContaining({ uri: 'resource://two' }),
        expect.objectContaining({ uri: longResourceUri }),
        ]),
      );
      await expect(runtime.resources?.readResource(
        'resource://two',
        { sessionId: 'catalog' },
      )).resolves.toMatchObject({ text: 'resource://two' });
      await expect(runtime.resources?.listTools?.({ sessionId: 'catalog' })).resolves.toEqual([
        expect.objectContaining({ name: 'render_one' }),
        expect.objectContaining({ name: 'render_two' }),
        expect.objectContaining({ name: 'render_long' }),
      ]);
      await expect(runtime.resources?.callTool?.(
        'render_two',
        {},
        { sessionId: 'catalog' },
      )).resolves.toMatchObject({ content: [{ text: 'called:render_two' }] });
      await expect(runtime.kernel.execute(
        { targetType: 'operation', target: 'test.search-proxy' },
        { sessionId: 'catalog' },
      )).resolves.toMatchObject({ status: 'success', result: { output: { count: 1 } } });
      const nested = await runtime.kernel.execute(
        {
          targetType: 'operation',
          target: 'test.execute-proxy',
          requestId: 'execute-parent',
          approval: { grant: 'parent-approval' },
        },
        { sessionId: 'catalog' },
      );
      expect(nested.status).toBe('success');
      expect(nested.result?.output).toMatchObject({
        children: [{
          executionId: expect.not.stringMatching(/^execute-parent$/),
          requestId: expect.any(String),
        }],
      });
      expect(nestedChildContexts[0]).toMatchObject({
        approval: { grant: 'parent-approval' },
        lineage: {
          rootExecutionId: 'execute-parent',
          parentExecutionId: 'execute-parent',
          depth: 1,
        },
        scope: { parentExecutionId: 'execute-parent' },
        metadata: { parentExecutionId: 'execute-parent' },
      });
      expect(nestedChildContexts[0]?.executionId).not.toBe('execute-parent');
      const duplicateRequestedId = 'execute-duplicate-child';
      const longRequestedId = 'r'.repeat(600);
      const explicitChildren = await runtime.kernel.execute(
        {
          targetType: 'operation',
          target: 'test.execute-proxy',
          input: {
            requestIds: [
              'execute-explicit-parent',
              duplicateRequestedId,
              duplicateRequestedId,
              longRequestedId,
            ],
          },
          requestId: 'execute-explicit-parent',
          approval: { grant: 'explicit-parent-approval' },
        },
        { sessionId: 'catalog' },
      );
      const explicitOutput = explicitChildren.result?.output as
        | { children?: Array<{ executionId: string; requestId: string }> }
        | undefined;
      const childIds = explicitOutput?.children?.map((child) => child.executionId) ?? [];
      expect(childIds).toHaveLength(4);
      expect(new Set(childIds).size).toBe(4);
      expect(explicitOutput?.children?.every(
        (child) => child.requestId === child.executionId,
      )).toBe(true);
      expect(childIds).not.toContain('execute-explicit-parent');
      expect(childIds).not.toContain(duplicateRequestedId);
      const explicitContexts = nestedChildContexts.slice(1);
      expect(explicitContexts.map((context) => context.metadata?.requestedRequestId)).toEqual([
        'execute-explicit-parent',
        duplicateRequestedId,
        duplicateRequestedId,
        longRequestedId.slice(0, 512),
      ]);
      expect(explicitContexts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            lineage: {
              rootExecutionId: 'execute-explicit-parent',
              parentExecutionId: 'execute-explicit-parent',
              depth: 1,
            },
          }),
        ]),
      );
      const initialTree = await runtime.receipts.tree('execute-parent');
      expect(initialTree.orphans).toEqual([]);
      expect(initialTree.roots[0]?.children).toHaveLength(1);
      const siblingTree = await runtime.receipts.tree('execute-explicit-parent');
      expect(siblingTree.orphans).toEqual([]);
      expect(siblingTree.roots).toHaveLength(1);
      expect(siblingTree.roots[0]?.children.map(
        (child) => child.receipt.executionId,
      ).sort()).toEqual([...childIds].sort());
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects duplicate provider job handlers without partial registrations and disposes bundles in reverse order', async () => {
    const location = await workspace();
    const jobKind = 'test.duplicate-provider-job';
    const events: string[] = [];
    const lifecycleDisposed = { first: false, second: false };
    let bindings: Awaited<ReturnType<typeof createAgentRuntime>> | undefined;
    const jobRegistration = vi.spyOn(BackgroundJobManager.prototype, 'register');
    const providerRegistration = vi.spyOn(RuntimeKernel.prototype, 'register');
    const source = (name: 'first' | 'second'): RuntimeHostProviderSource => async () => {
      events.push(`create:${name}`);
      const lifecycle: RuntimeLifecyclePort = {
        startSession: async () => ({}),
        observeTurn: async () => ({}),
        endSession: async () => ({}),
      };
      return {
        providers: [{
          id: `test.job-collision.${name}`,
          list: () => [],
          invoke: async () => ({ output: null }),
        }],
        lifecycle,
        jobHandlers: [{
          kind: jobKind,
          start: async () => ({ status: 'succeeded', result: name }),
        }],
        dispose() {
          lifecycleDisposed[name] = true;
          events.push(`dispose:${name}`);
        },
      };
    };

    try {
      const creation = createTestAgentRuntime({
        isolated: true,
        workspacePath: location.workspacePath,
        protectedLifecycleResultRoot: path.join(location.parent, 'private-job-collisions'),
        loadDefaultProviders: false,
        permissionBroker: allowAll,
        providerSources: [source('first'), source('second')],
      }).then((runtime) => {
        bindings = runtime;
        return runtime;
      });

      await expect(creation).rejects.toThrow(
        `Duplicate runtime job handler kind: ${jobKind}`,
      );
      expect(bindings).toBeUndefined();
      expect(jobRegistration).not.toHaveBeenCalled();
      expect(providerRegistration).not.toHaveBeenCalled();
      expect(lifecycleDisposed).toEqual({ first: true, second: true });
      expect(events).toEqual([
        'create:first',
        'create:second',
        'dispose:second',
        'dispose:first',
      ]);
    } finally {
      jobRegistration.mockRestore();
      providerRegistration.mockRestore();
      await bindings?.dispose();
    }
  });

  it.each([
    ['host option', true],
    ['returned bundle', false],
  ] as const)(
    'rejects a source-direct job handler duplicated by a %s before live registration',
    async (_collisionKind, duplicateFromHost) => {
      const location = await workspace();
      const jobKind = `test.direct-job-collision.${duplicateFromHost ? 'host' : 'bundle'}`;
      const events: string[] = [];
      const disposed = { first: false, second: false };
      let bindings: Awaited<ReturnType<typeof createAgentRuntime>> | undefined;
      let capturedJobManager: BackgroundJobManager | undefined;
      const jobRegistration = vi.spyOn(BackgroundJobManager.prototype, 'register');
      const providerRegistration = vi.spyOn(RuntimeKernel.prototype, 'register');
      const handler = (result: string): RuntimeBackgroundJobHandler => ({
        kind: jobKind,
        start: async () => ({ status: 'succeeded', result }),
      });
      const source = (
        name: 'first' | 'second',
        direct = false,
      ): RuntimeHostProviderSource => async (context) => {
        events.push(`create:${name}`);
        if (direct) {
          capturedJobManager = context.jobManager;
          context.jobManager.register(handler('direct'));
        }
        return {
          providers: [{
            id: `test.direct-job-collision.${name}`,
            list: () => [],
            invoke: async () => ({ output: null }),
          }],
          ...(name === 'second' && !duplicateFromHost
            ? { jobHandlers: [handler('bundle')] }
            : {}),
          dispose() {
            disposed[name] = true;
            events.push(`dispose:${name}`);
          },
        };
      };

      try {
        const creation = createTestAgentRuntime({
          isolated: true,
          workspacePath: location.workspacePath,
          protectedLifecycleResultRoot: path.join(
            location.parent,
            `private-direct-job-collision-${duplicateFromHost ? 'host' : 'bundle'}`,
          ),
          permissionBroker: allowAll,
          providerSources: [source('first', true), source('second')],
          ...(duplicateFromHost ? { jobHandlers: [handler('host')] } : {}),
        }).then((runtime) => {
          bindings = runtime;
          return runtime;
        });

        await expect(creation).rejects.toThrow(
          `Duplicate runtime job handler kind: ${jobKind}`,
        );
        expect(bindings).toBeUndefined();
        expect(jobRegistration).not.toHaveBeenCalled();
        expect(providerRegistration).not.toHaveBeenCalled();
        expect(() => capturedJobManager?.register(handler('late'))).toThrow(
          /registration closed/i,
        );
        expect(disposed).toEqual({ first: true, second: true });
        expect(events).toEqual([
          'create:first',
          'create:second',
          'dispose:second',
          'dispose:first',
        ]);
      } finally {
        jobRegistration.mockRestore();
        providerRegistration.mockRestore();
        await bindings?.dispose();
      }
    },
  );

  // TODO(#11): Restore with the module timeout and host fixes.
  it.skip('commits a unique source-direct job handler onto the shared runtime manager', async () => {
    const location = await workspace();
    const kind = 'test.direct-job-unique';
    let capturedJobManager: BackgroundJobManager | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const jobRegistration = vi.spyOn(BackgroundJobManager.prototype, 'register');
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      loadDefaultProviders: false,
      isolated: true,
      permissionBroker: allowAll,
      providerSources: [
        (context) => {
          capturedJobManager = context.jobManager;
          context.jobManager.register({
            kind,
            async start() {
              markStarted();
              return { status: 'succeeded', result: { registered: true } };
            },
          });
          return { providers: [] };
        },
      ],
    });
    try {
      expect(capturedJobManager).toBeInstanceOf(BackgroundJobManager);
      expect(jobRegistration).toHaveBeenCalledTimes(1);
      expect(() => capturedJobManager?.register({
        kind: 'test.direct-job-late',
        start: async () => ({ status: 'succeeded', result: null }),
      })).toThrow(/registration closed/i);
      const execution = await runtime.kernel.execute({
        targetType: 'operation',
        target: 'runtime.jobs.start',
        input: { kind, idempotencyKey: 'direct-job-unique', input: null },
      }, { sessionId: 'direct-job-unique' });
      expect(execution.status).toBe('success');
      await started;
      await runtime.dispose();
      expect(() => capturedJobManager?.register({
        kind: 'test.direct-job-after-dispose',
        start: async () => ({ status: 'succeeded', result: null }),
      })).toThrow(/registration closed/i);
    } finally {
      jobRegistration.mockRestore();
      await runtime.dispose();
    }
  });

  // TODO(#11): Restore with the module timeout and host fixes.
  it.skip('keeps source registration closed after a post-commit startup failure', async () => {
    const location = await workspace();
    const events: string[] = [];
    let capturedJobManager: BackgroundJobManager | undefined;
    const registration = vi.spyOn(BackgroundJobManager.prototype, 'register');
    const duplicateResources: RuntimeScopedResourcePort = {
      listResources: async () => [
        { uri: 'resource://post-commit-duplicate', name: 'one' },
        { uri: 'resource://post-commit-duplicate', name: 'two' },
      ],
      readResource: async (uri) => ({ uri, text: '' }),
    };
    const source = (
      name: 'first' | 'second',
      configure: (context: RuntimeHostFactoryContext) => RuntimeHostProviderBundle,
    ): RuntimeHostProviderSource => async (context) => {
      events.push(`create:${name}`);
      const bundle = configure(context);
      return {
        ...bundle,
        dispose() {
          events.push(`dispose:${name}`);
          return bundle.dispose?.();
        },
      };
    };

    try {
      const creation = createTestAgentRuntime({
        isolated: true,
        workspacePath: location.workspacePath,
        protectedLifecycleResultRoot: path.join(
          location.parent,
          'private-post-commit-job-registration',
        ),
        permissionBroker: allowAll,
        providerSources: [
          source('first', (context) => {
            capturedJobManager = context.jobManager;
            context.jobManager.register({
              kind: 'test.post-commit-job',
              start: async () => ({ status: 'succeeded', result: null }),
            });
            return { providers: [] };
          }),
          source('second', () => ({
            providers: [],
            resources: duplicateResources,
          })),
        ],
      });

      await expect(creation).rejects.toThrow(/duplicate runtime resource uri/i);
      expect(registration).toHaveBeenCalledTimes(1);
      expect(() => capturedJobManager?.register({
        kind: 'test.post-commit-late',
        start: async () => ({ status: 'succeeded', result: null }),
      })).toThrow(/registration closed/i);
      expect(events).toEqual([
        'create:first',
        'create:second',
        'dispose:second',
        'dispose:first',
      ]);
    } finally {
      registration.mockRestore();
    }
  });

  it('rejects duplicate resource and render-tool identities before returning bindings', async () => {
    const location = await workspace();
    let returnedBindings = false;
    const duplicateResources: RuntimeScopedResourcePort = {
      listResources: async () => [
        { uri: 'resource://duplicate', name: 'one' },
        { uri: 'resource://duplicate', name: 'two' },
      ],
      readResource: async (uri) => ({ uri, text: '' }),
    };
    const duplicateResourceCreation = createTestAgentRuntime({
      isolated: true,
      workspacePath: location.workspacePath,
      protectedLifecycleResultRoot: path.join(location.parent, 'private-collisions'),
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      providerSources: [async () => ({ providers: [], resources: duplicateResources })],
    }).then((runtime) => {
      returnedBindings = true;
      return runtime;
    });
    await expect(duplicateResourceCreation).rejects.toThrow(/duplicate runtime resource uri/i);
    expect(returnedBindings).toBe(false);

    const duplicateTools: RuntimeScopedResourcePort = {
      listResources: async () => [],
      readResource: async (uri) => ({ uri, text: '' }),
      listRenderTools: async () => [
        { name: 'duplicate_tool', inputSchema: {} },
        { name: 'duplicate_tool', inputSchema: {} },
      ],
    };
    const duplicateToolCreation = createTestAgentRuntime({
      isolated: true,
      workspacePath: location.workspacePath,
      protectedLifecycleResultRoot: path.join(location.parent, 'private-tool-collisions'),
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      providerSources: [async () => ({ providers: [], resources: duplicateTools })],
    }).then((runtime) => {
      returnedBindings = true;
      return runtime;
    });
    await expect(duplicateToolCreation).rejects.toThrow(/duplicate runtime render tool name/i);
    expect(returnedBindings).toBe(false);
  });

  it('rejects resource URIs beyond the shared catalog limit before returning bindings', async () => {
    const location = await workspace();
    const overboundUri = `resource://${'x'.repeat(RUNTIME_RESOURCE_URI_MAX_LENGTH)}`;
    let returnedBindings = false;
    const creation = createTestAgentRuntime({
      isolated: true,
      workspacePath: location.workspacePath,
      protectedLifecycleResultRoot: path.join(
        location.parent,
        'private-overbound-resource-uri',
      ),
      permissionBroker: allowAll,
      providerSources: [async () => ({
        providers: [],
        resources: {
          listResources: async () => [{
            uri: overboundUri,
            name: 'Over-bound resource',
          }],
          readResource: async (uri) => ({ uri, text: '' }),
        },
      })],
    }).then((runtime) => {
      returnedBindings = true;
      return runtime;
    });

    await expect(creation).rejects.toThrow(
      `at most ${RUNTIME_RESOURCE_URI_MAX_LENGTH} characters`,
    );
    expect(returnedBindings).toBe(false);
  });

  it('uses a unique per-host fallback scope and preserves explicit thread identity', async () => {
    const location = await workspace();
    const captured: InvocationContext[] = [];
    const createCapturingProvider = (): CapabilityProvider => {
      const base = echoProvider();
      return {
        ...base,
        async invoke(name, input, context) {
          captured.push(context);
          return base.invoke(name, input, context);
        },
      };
    };

    const execute = async (context: RuntimeCallContext) => {
      const runtime = await createTestAgentRuntime({
        workspacePath: location.workspacePath,
        loadDefaultProviders: false,
        permissionBroker: allowAll,
        providerSources: [async () => [createCapturingProvider()]],
      });
      try {
        await runtime.kernel.execute({
          targetType: 'operation',
          target: 'test.echo',
          input: { value: 1 },
        }, context);
      } finally {
        await runtime.dispose();
      }
    };

    await execute({});
    await execute({});
    await execute({ sessionId: 'session-explicit', threadId: 'thread-explicit' });

    expect(captured[0]?.scope.sessionId).toMatch(/^runtime-[0-9a-f-]{36}$/);
    expect(captured[0]?.scope.threadId).toBe(captured[0]?.scope.sessionId);
    expect(captured[1]?.scope.sessionId).toMatch(/^runtime-[0-9a-f-]{36}$/);
    expect(captured[1]?.scope.sessionId).not.toBe(captured[0]?.scope.sessionId);
    expect(captured[2]?.scope).toMatchObject({
      sessionId: 'session-explicit',
      threadId: 'thread-explicit',
    });
  });

  it('coalesces periodic job recovery instead of building an interval backlog', async () => {
    const location = await workspace();
    let releaseRecovery!: (value: readonly string[]) => void;
    const blockedRecovery = new Promise<readonly string[]>((resolve) => {
      releaseRecovery = resolve;
    });
    let recoveryCalls = 0;
    const recovery = vi.spyOn(BackgroundJobManager.prototype, 'recoverAll')
      .mockImplementation(async () => {
        recoveryCalls += 1;
        return recoveryCalls === 1 ? [] : blockedRecovery;
      });
    vi.useFakeTimers();
    let runtime: Awaited<ReturnType<typeof createTestAgentRuntime>> | undefined;
    try {
      runtime = await createTestAgentRuntime({
        workspacePath: location.workspacePath,
        loadDefaultProviders: false,
        permissionBroker: allowAll,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recovery).toHaveBeenCalledTimes(2);
    } finally {
      releaseRecovery([]);
      await blockedRecovery;
      vi.useRealTimers();
      await runtime?.dispose();
      recovery.mockRestore();
    }
  });

  it('restores the original invocation metadata when recovering a job', async () => {
    const location = await workspace();
    let resolver: Parameters<BackgroundJobManager['recoverAll']>[0] | undefined;
    const recovery = vi.spyOn(BackgroundJobManager.prototype, 'recoverAll')
      .mockImplementation(async (resolveContext) => {
        resolver = resolveContext;
        return [];
      });
    let runtime: Awaited<ReturnType<typeof createTestAgentRuntime>> | undefined;
    try {
      runtime = await createTestAgentRuntime({
        workspacePath: location.workspacePath,
        loadDefaultProviders: false,
        permissionBroker: allowAll,
      });
      const context = resolver?.({
        handle: { jobId: 'job-1', kind: 'test.kind', idempotencyKey: 'key-1', createdAt: '' },
        principalId: 'principal-1',
        agentId: 'agent-1',
        scope: { sessionId: 'session-1', workspaceId: 'workspace-1' },
        metadata: {
          principalKind: 'agent',
          invocationMetadata: { hostWorkspaceName: 'marshal', recoveredJobId: 'spoofed', nested: {} },
        },
      } as unknown as Parameters<NonNullable<typeof resolver>>[0]);
      expect(context?.scope).toEqual({ sessionId: 'session-1', workspaceId: 'workspace-1' });
      expect(context?.metadata).toEqual({ hostWorkspaceName: 'marshal', recoveredJobId: 'job-1' });
    } finally {
      await runtime?.dispose();
      recovery.mockRestore();
    }
  });

  it('aborts and drains active background jobs before disposing provider state', async () => {
    const location = await workspace();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let aborted = false;
    let finalized = false;
    const handler: RuntimeBackgroundJobHandler = {
      kind: 'test.dispose-drain',
      async start(_request, _context, control) {
        markStarted();
        await new Promise<void>((resolve) => {
          control.signal.addEventListener('abort', () => {
            aborted = true;
            setTimeout(() => {
              finalized = true;
              resolve();
            }, 20);
          }, { once: true });
        });
        return { status: 'succeeded', result: { finalized: true } };
      },
    };
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      jobHandlers: [handler],
    });
    const start = await runtime.kernel.execute({
      targetType: 'operation',
      target: 'runtime.jobs.start',
      input: { kind: handler.kind, idempotencyKey: 'dispose-drain', input: null },
    }, { sessionId: 'dispose-drain' }) as { status: string };
    expect(start.status).toBe('success');
    await started;

    await runtime.dispose();
    expect(aborted).toBe(true);
    expect(finalized).toBe(true);
  });

  it('composes search, operation execution, and recursively brokered TypeScript', async () => {
    const location = await workspace();
    const brokerCatalog: RuntimeCatalogProvider = {
      id: 'test.broker-catalog',
      list: () => [{
        id: 'skill://test/brokered-catalog',
        kind: 'skill',
        title: 'Brokered catalog skill',
        description: 'Exact catalog lookup through brokered TypeScript.',
        action: {
          type: 'resource_read',
          uri: 'skill://test/brokered-catalog',
        },
      }],
    };
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      identity: {
        harnessId: 'test-harness',
        installationId: 'install-1',
        profileId: 'profile-1',
      },
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      providerSources: [async () => ({
        providers: [echoProvider(75)],
        catalog: brokerCatalog,
      })],
    });
    try {
      const search = (await runtime.kernel.search(
        { query: 'echo', limit: 10_000 },
        { sessionId: 'session-e2e', workspacePath: location.workspacePath },
      )) as {
        detail: string;
        matches: Array<{ capability: { name: string; inputSchema?: unknown; annotations?: unknown } }>;
      };
      expect(search.matches).toHaveLength(50);
      expect(search.detail).toBe('summary');
      expect(search.matches[0]?.capability).not.toHaveProperty('inputSchema');
      expect(search.matches[0]?.capability).not.toHaveProperty('annotations');

      const exact = (await runtime.kernel.search(
        { name: 'test.echo', detail: 'summary' },
        { sessionId: 'session-e2e', workspacePath: location.workspacePath },
      )) as {
        detail: string;
        matches: Array<{ capability: { inputSchema?: unknown; outputSchema?: unknown } }>;
      };
      expect(exact.detail).toBe('full');
      expect(exact.matches[0]?.capability.inputSchema).toBeDefined();
      expect(exact.matches[0]?.capability.outputSchema).toBeDefined();

      const operation = (await runtime.kernel.execute(
        { targetType: 'operation', target: 'test.echo', input: { value: 21 } },
        { sessionId: 'session-e2e', workspacePath: 'C:\\untrusted-override' },
      )) as { status: string; result?: { output?: unknown }; receipt: RuntimeExecutionReceipt };
      expect(operation.status).toBe('success');
      expect(operation.result?.output).toEqual({ value: 21 });
      expect(operation.receipt.scope).toMatchObject({
        workspaceId: expect.stringMatching(/^workspace-/),
        projectId: expect.stringMatching(/^project-/),
        sessionId: 'session-e2e',
        workspacePath: runtime.workspacePath,
      });
      expect(operation.receipt).toMatchObject({
        identity: {
          harnessId: 'test-harness',
          installationId: 'install-1',
          profileId: 'profile-1',
        },
        lineage: { depth: 0 },
      });
      expect(await runtime.receipts.list({ rootExecutionId: operation.receipt.lineage.rootExecutionId }))
        .toContainEqual(expect.objectContaining({ executionId: operation.receipt.executionId }));

      const inline = (await runtime.kernel.execute(
        {
          targetType: 'inline_module',
          source: `
            export default async (input, context) => {
              const found = await context.runtime.search({ query: 'test.echo', limit: 9999 });
              const catalog = await context.runtime.search({
                catalogId: 'skill://test/brokered-catalog'
              });
              const echoed = await context.runtime.invoke('test.echo', { value: input.value * 2 });
              return {
                matchCount: found.matches.length,
                catalogId: catalog.discoveries[0].entry.id,
                echoed
              };
            };
          `,
          input: { value: 21 },
          timeoutMs: 60_000,
        },
        { sessionId: 'session-e2e', requestId: 'inline-request' },
      )) as {
        status: string;
        result?: { output?: { ok: boolean; value?: unknown; mode: string } };
      };
      expect(inline.status).toBe('success');
      expect(inline.result?.output).toMatchObject({
        ok: true,
        mode: 'brokered',
        value: {
          matchCount: 50,
          catalogId: 'skill://test/brokered-catalog',
          echoed: { value: 42 },
        },
      });
      expect(runtime.providers.map((provider) => provider.id)).toContain('marshal.inline-module');
      expect(runtime.stateRoot).toBe(
        path.join(await fs.realpath(location.workspacePath), '.marshal', 'runtime'),
      );
    } finally {
      await runtime.dispose?.();
    }
  });

  // TODO(#11): Restore with the module timeout and host fixes.
  it.skip('keeps import policy host-owned and exposes trusted execution separately', async () => {
    const location = await workspace();
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      providerSources: [async () => [echoProvider()]],
      importPolicy: { allowedBuiltins: [] },
    });
    try {
      const brokered = (await runtime.kernel.execute(
        {
          targetType: 'inline_module',
          source: `import fs from 'node:fs'; export default () => Boolean(fs);`,
          input: null,
          allowedBuiltins: ['fs'],
        },
        { sessionId: 'session-policy' },
      )) as { result?: { output?: { ok: boolean; diagnostics: Array<{ code: string }> } } };
      expect(brokered.result?.output?.ok).toBe(false);
      expect(brokered.result?.output?.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'IMPORT_DENIED' })]),
      );

      const trusted = (await runtime.kernel.execute(
        {
          targetType: 'inline_module',
          executionMode: 'trusted_node',
          source: `export default () => ({ hasProcess: typeof process === 'object' });`,
        },
        { sessionId: 'session-policy' },
      )) as {
        receipt: { target: string };
        result?: { output?: { mode: string; value?: unknown } };
      };
      expect(trusted.receipt.target).toBe(TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY);
      expect(trusted.result?.output).toMatchObject({
        mode: 'trusted',
        value: { hasProcess: true },
      });

      const capabilities = await runtime.core.list({
        principal: { id: 'agent-runtime', kind: 'agent' },
      });
      expect(capabilities.map((capability) => capability.name)).toEqual(
        expect.arrayContaining([
          INLINE_MODULE_EXECUTOR_CAPABILITY,
          TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY,
        ]),
      );
    } finally {
      await runtime.dispose?.();
    }
  });

  it('bounds nested module calls and records a parent-linked receipt tree', async () => {
    const location = await workspace();
    let active = 0;
    let peak = 0;
    const provider: CapabilityProvider = {
      id: 'test.bounded-provider',
      list: () => [
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          name: 'test.bounded',
          version: '1.0.0',
          description: 'Delayed echo used to verify broker bounds.',
          outputSchema: {
            type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false,
          },
          permissions: [{ permission: 'test.bounded', risk: 'low' }],
        },
      ],
      async invoke(_name, input) {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
          return { output: input };
        } finally {
          active -= 1;
        }
      },
    };
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      providerSources: [async () => [provider]],
      moduleMaxBrokerInvocations: 2,
      moduleMaxConcurrentBrokerInvocations: 1,
    });
    try {
      const bounded = (await runtime.kernel.execute(
        {
          targetType: 'inline_module',
          source: `
            export default async (_input, context) => Promise.all([
              context.runtime.invoke('test.bounded', { value: 1 }),
              context.runtime.invoke('test.bounded', { value: 2 }),
            ]);
          `,
        },
        { sessionId: 'session-bounds', requestId: 'bounded-parent' },
      )) as {
        result?: { output?: { ok: boolean; value?: unknown }; receipt?: { broker?: unknown } };
      };
      expect(bounded.result?.output).toMatchObject({
        ok: true,
        value: [{ value: 1 }, { value: 2 }],
      });
      expect(bounded.result?.receipt?.broker).toMatchObject({
        maxInvocations: 2,
        maxConcurrency: 1,
        invocationCount: 2,
        peakConcurrency: 1,
        children: [
          {
            sequence: 1,
            parentExecutionId: 'bounded-parent',
            target: 'test.bounded',
            status: 'success',
          },
          {
            sequence: 2,
            parentExecutionId: 'bounded-parent',
            target: 'test.bounded',
            status: 'success',
          },
        ],
      });
      expect(peak).toBe(1);
      const receiptTree = await runtime.receipts.tree('bounded-parent');
      expect(receiptTree.orphans).toEqual([]);
      expect(receiptTree.roots).toHaveLength(1);
      expect(receiptTree.roots[0]?.receipt.executionId).toBe('bounded-parent');
      expect(receiptTree.roots[0]?.children.map((child) => child.receipt.target)).toEqual([
        'test.bounded',
        'test.bounded',
      ]);

      const limited = (await runtime.kernel.execute(
        {
          targetType: 'inline_module',
          source: `
            export default async (_input, context) => {
              await context.runtime.invoke('test.bounded', { value: 1 });
              await context.runtime.invoke('test.bounded', { value: 2 });
              return context.runtime.invoke('test.bounded', { value: 3 });
            };
          `,
        },
        { sessionId: 'session-bounds', requestId: 'limited-parent' },
      )) as {
        result?: { output?: { ok: boolean; error?: { code: string } } };
      };
      expect(limited.result?.output).toMatchObject({
        ok: false,
        error: { code: 'BROKER_INVOCATION_LIMIT_EXCEEDED' },
      });
    } finally {
      await runtime.dispose?.();
    }
  });

  it('shortens the critical path by overlapping heterogeneous programmable work', async () => {
    const location = await workspace();
    const delays = new Map([
      ['test.brain-recall', 90],
      ['test.agent-review', 130],
      ['test.artifact-prepare', 170],
    ]);
    const spans: Array<{ name: string; startedAt: number; completedAt: number }> = [];
    let active = 0;
    let peak = 0;
    const provider: CapabilityProvider = {
      id: 'test.programmable-concurrency-provider',
      list: () => [...delays].map(([name]) => ({
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name,
        version: '1.0.0',
        description: `Bounded ${name} fixture.`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        permissions: [{ permission: 'test.programmable-concurrency', risk: 'low' }],
      })),
      get: (name) => provider.list().find((descriptor) => descriptor.name === name),
      async invoke(name) {
        const delayMs = delays.get(name);
        if (!delayMs) throw new Error(`Unknown concurrency fixture: ${name}`);
        const span = { name, startedAt: performance.now(), completedAt: 0 };
        spans.push(span);
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
          span.completedAt = performance.now();
          return { output: { name } };
        } finally {
          active -= 1;
        }
      },
    };
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      providerSources: [async () => [provider]],
      moduleMaxBrokerInvocations: 3,
      moduleMaxConcurrentBrokerInvocations: 3,
    });
    try {
      const execution = await runtime.kernel.execute(
        {
          targetType: 'inline_module',
          source: `
            export default async (_input, context) => {
              const [memory, agent, artifact] = await Promise.all([
                context.runtime.invoke('test.brain-recall', {}),
                context.runtime.invoke('test.agent-review', {}),
                context.runtime.invoke('test.artifact-prepare', {}),
              ]);
              return { memory, agent, artifact };
            };
          `,
        },
        { sessionId: 'session-programmable-concurrency', requestId: 'programmable-concurrency-root' },
      ) as { result?: { output?: { ok: boolean }; receipt?: { broker?: { peakConcurrency?: number } } } };

      expect(execution.result?.output?.ok).toBe(true);
      expect(execution.result?.receipt?.broker?.peakConcurrency).toBe(3);
      expect(peak).toBe(3);
      expect(spans).toHaveLength(3);
      const criticalPathMs = Math.max(...spans.map((span) => span.completedAt))
        - Math.min(...spans.map((span) => span.startedAt));
      const sequentialSumMs = [...delays.values()].reduce((sum, delayMs) => sum + delayMs, 0);
      console.info('marshal-programmable-concurrency', {
        criticalPathMs: Number(criticalPathMs.toFixed(3)),
        sequentialSumMs,
        speedup: Number((sequentialSumMs / criticalPathMs).toFixed(3)),
        peakConcurrency: peak,
      });
      expect(criticalPathMs).toBeLessThan(sequentialSumMs * 0.7);
      expect(Math.max(...spans.map((span) => span.startedAt)) - Math.min(...spans.map((span) => span.startedAt)))
        .toBeLessThan(50);

      const tree = await runtime.receipts.tree('programmable-concurrency-root');
      expect(tree.orphans).toEqual([]);
      expect(tree.roots[0]?.children.map((child) => child.receipt.target).sort()).toEqual([
        'test.agent-review',
        'test.artifact-prepare',
        'test.brain-recall',
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  // TODO(#11): Restore with the module timeout and host fixes.
  it.skip('discovers and enforces the configured module timeout policy without silent clamping', async () => {
    const location = await workspace();
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      inlineTimeoutMs: 1_234,
      inlineMaxTimeoutMs: 5_678,
    });
    try {
      const discovery = (await runtime.kernel.search(
        { name: 'runtime.module.execute' },
        { sessionId: 'session-timeout-policy' },
      )) as {
        matches: Array<{
          capability: {
            inputSchema?: {
              properties?: {
                timeoutMs?: { default?: number; maximum?: number; description?: string };
              };
            };
          };
        }>;
      };
      expect(discovery.matches[0]?.capability.inputSchema?.properties?.timeoutMs).toMatchObject({
        default: 1_234,
        maximum: 5_678,
      });
      expect(discovery.matches[0]?.capability.inputSchema?.properties?.timeoutMs?.description)
        .toContain('nested capabilities');
      expect(discovery.matches[0]?.capability.inputSchema?.properties?.timeoutMs?.description)
        .toContain('Nested timeouts do not extend this outer budget');

      const defaulted = await runtime.kernel.execute(
        {
          targetType: 'module',
          module: { kind: 'inline', source: 'export default () => "ready";' },
        },
        { sessionId: 'session-timeout-policy', requestId: 'defaulted-timeout' },
      );
      expect(defaulted).toMatchObject({
        status: 'success',
        result: { output: { ok: true, value: 'ready' } },
        receipt: { providerReceipt: { timeoutMs: 1_234 } },
      });

      const rejected = await runtime.kernel.execute(
        {
          targetType: 'module',
          module: { kind: 'inline', source: 'export default () => "must-not-run";' },
          timeoutMs: 5_679,
        },
        { sessionId: 'session-timeout-policy', requestId: 'over-limit-timeout' },
      );
      expect(rejected).toMatchObject({
        status: 'failed',
        error: {
          code: 'TIMEOUT_LIMIT_EXCEEDED',
          message: 'timeoutMs 5679 exceeds the host ceiling of 5678.',
        },
      });
      expect(rejected.result).toBeUndefined();
    } finally {
      await runtime.dispose?.();
    }
  });

  // TODO(#11): Restore with the module timeout and host fixes.
  it.skip('requires the outer module budget to cover a nested capability wait', async () => {
    const location = await workspace();
    const nestedWait: CapabilityProvider = {
      id: 'test.nested-wait-provider',
      list: () => [{
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'test.nested-wait',
        version: '1.0.0',
        description: 'Waits for the requested bounded duration.',
        inputSchema: {
          type: 'object',
          properties: { waitMs: { type: 'integer', minimum: 1, maximum: 1_000 } },
          required: ['waitMs'],
        },
        outputSchema: {
          type: 'object', properties: { waitedMs: { type: 'number', minimum: 1, maximum: 1_000 } }, required: ['waitedMs'], additionalProperties: false,
        },
        permissions: [{ permission: 'test.nested-wait', risk: 'low' }],
      }],
      invoke: async (_name, rawInput, context) => {
        const waitMs = Number((rawInput as { waitMs?: unknown })?.waitMs);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ output: { waitedMs: waitMs } }), waitMs);
          const abort = () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('nested wait aborted'), { code: 'NESTED_WAIT_ABORTED' }));
          };
          context.signal?.addEventListener?.('abort', abort, { once: true });
        });
      },
    };
    const runtime = await createTestAgentRuntime({
      workspacePath: location.workspacePath,
      loadDefaultProviders: false,
      permissionBroker: allowAll,
      providerSources: [async () => [nestedWait]],
      inlineTimeoutMs: 100,
      inlineMaxTimeoutMs: 1_200,
    });
    const source = `
      export default async (_input, context) =>
        context.runtime.invoke('test.nested-wait', { waitMs: 250 });
    `;
    try {
      const defaulted = await runtime.kernel.execute(
        { targetType: 'inline_module', source },
        { sessionId: 'session-nested-timeout', requestId: 'nested-default' },
      );
      expect(defaulted).toMatchObject({
        status: 'success',
        result: { output: { ok: false, status: 'timed_out', error: { code: 'TIMED_OUT' } } },
        receipt: { providerReceipt: { timeoutMs: 100 } },
      });

      const explicit = await runtime.kernel.execute(
        { targetType: 'inline_module', source, timeoutMs: 1_000 },
        { sessionId: 'session-nested-timeout', requestId: 'nested-explicit' },
      );
      expect(explicit).toMatchObject({
        status: 'success',
        result: { output: { ok: true, value: { waitedMs: 250 } } },
        receipt: { providerReceipt: { timeoutMs: 1_000 } },
      });
    } finally {
      await runtime.dispose?.();
    }
  });

});

function lastTranscriptMemoryId(transcript: string): string {
  const id = [...transcript.matchAll(/"id":"([a-zA-Z0-9-]{1,128})"/g)].at(-1)?.[1];
  if (!id) throw new Error('Scripted reasoner did not receive a memory id.');
  return id;
}
