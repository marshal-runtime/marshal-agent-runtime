import {
  createAllowAllPermissionBroker,
  createRuntimeKernel,
  RUNTIME_PROTOCOL_VERSION,
  UnsupportedProtocolVersionError,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import { describe, expect, it, vi } from 'vitest';
import {
  composeAgentRuntime,
  createStaticRuntimeAuthorityProvider,
  createStaticRuntimeIdentityProvider,
  createStaticRuntimePrincipalProvider,
  type RuntimeBindingContext,
  type RuntimeScopedLifecyclePort,
  type RuntimeScopedResourcePort,
} from '../src/index.js';

const principal = { id: 'agent-main', kind: 'agent' } as const;
const authority = { workspaceId: 'workspace-1', projectId: 'project-1' } as const;

describe('composeAgentRuntime', () => {
  it('fixes authority while preserving protocol, cancellation, output, and receipts', async () => {
    const seen: InvocationContext[] = [];
    const invoke = vi.fn(async (_name: string, input: unknown, context: InvocationContext) => {
      seen.push(context);
      return { output: input, receipt: { providerRequest: 'provider-1' } };
    });
    const kernel = createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() });
    kernel.register({
      id: 'echo-provider',
      list(context) {
        seen.push(context);
        return [{
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          name: 'echo.run',
          version: '1.0.0',
          description: 'Echo input.',
          tags: ['test'],
          outputSchema: {
            type: 'object',
            required: ['value'],
            properties: { value: { type: 'number' } },
            additionalProperties: false,
          },
        }];
      },
      invoke,
    });
    const runtime = composeAgentRuntime({ kernel, principal, authority });
    const signal = { aborted: false, reason: undefined as unknown };
    const metadata = { transport: 'test' };
    const context: RuntimeBindingContext = {
      sessionId: 'session-1',
      threadId: 'thread-1',
      requestId: 'request-1',
      signal,
      metadata,
    };

    const search = await runtime.kernel.search({ name: 'echo.run' }, context);
    const execution = await runtime.kernel.execute<{ value: number }>({
      protocolVersion: '1.7.0',
      targetType: 'operation',
      target: 'echo.run',
      input: { value: 42 },
    }, context);

    expect(search.matches[0]?.capability.name).toBe('echo.run');
    expect(execution.status).toBe('success');
    expect(execution.result).toEqual({
      output: { value: 42 },
      receipt: { providerRequest: 'provider-1' },
    });
    expect(execution.receipt).toMatchObject({
      requestId: 'request-1',
      principalId: 'agent-main',
      scope: {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        threadId: 'thread-1',
      },
      providerReceipt: { providerRequest: 'provider-1' },
    });
    expect(seen.at(-1)?.signal).toBe(signal);
    expect(seen.at(-1)?.metadata).toBe(metadata);
    expect(runtime.core).toBe(kernel);
    expect(runtime.lifecycle).toBeUndefined();
    expect(runtime.resources).toBeUndefined();
  });

  it('passes structural cancellation and rejects unsupported protocol majors', async () => {
    const invoke = vi.fn(async () => ({ output: true }));
    const kernel = createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() });
    kernel.register({
      id: 'test-provider',
      list: () => [{
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        name: 'test.run',
        version: '1.0.0',
        description: 'Test.',
      }],
      invoke,
    });
    const runtime = composeAgentRuntime({ kernel, principal, authority });
    const cancelled = await runtime.kernel.execute(
      { targetType: 'operation', target: 'test.run' },
      { signal: { aborted: true, reason: 'user' } },
    );

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      receipt: { status: 'cancelled' },
    });
    expect(invoke).not.toHaveBeenCalled();
    await expect(
      runtime.kernel.search({ protocolVersion: '2.0.0', query: 'test' }),
    ).rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
  });

  it('normalizes lifecycle and resources through the same fixed context', async () => {
    const contexts: InvocationContext[] = [];
    const lifecycle: RuntimeScopedLifecyclePort = {
      startSession: (request, context) => (contexts.push(context), request),
      observeTurn: (request, context) => (contexts.push(context), request),
      endSession: (request, context) => (contexts.push(context), request),
    };
    const resourceResult = { content: [{ type: 'text', text: 'rendered' }] };
    const resources: RuntimeScopedResourcePort = {
      listResources: (context) => (contexts.push(context), [{ uri: 'ui://one', name: 'One' }]),
      readResource: (uri, context) => (contexts.push(context), { uri, text: '<p>One</p>' }),
      listTools: (context) => (contexts.push(context), [{ name: 'ui.render', inputSchema: {} }]),
      callTool: (_name, _input, context) => (contexts.push(context), resourceResult),
    };
    const runtime = composeAgentRuntime({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      principal,
      authority,
      lifecycle,
      resources,
    });
    const signal = { aborted: false };
    const context = { sessionId: 'session-1', signal };

    const started = await runtime.lifecycle!.startSession(
      { sessionId: 'session-1', eventId: 'event-1' },
      context,
    );
    await runtime.lifecycle!.observeTurn(
      { sessionId: 'session-1', kind: 'user_message', content: 'hello' },
      context,
    );
    await runtime.lifecycle!.endSession({ sessionId: 'session-1' }, context);
    await runtime.resources!.listResources(context);
    await runtime.resources!.readResource('ui://one', context);
    await runtime.resources!.listTools!(context);
    expect(await runtime.resources!.callTool!('ui.render', {}, context)).toBe(resourceResult);

    expect(started).toMatchObject({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      eventId: 'event-1',
    });
    for (const observed of contexts) {
      expect(observed).toMatchObject({
        principal,
        scope: { ...authority, sessionId: 'session-1' },
      });
      expect(observed.signal).toBe(signal);
    }
    await expect(runtime.lifecycle!.startSession(
      { sessionId: 'session-1' },
      { sessionId: 'different-session' },
    )).rejects.toThrow('must match');
  });

  it('resolves each provider once and projects immutable identity into every context', async () => {
    const identity = {
      harnessId: 'test-harness',
      installationId: 'installation-1',
      profileId: 'profile-1',
    } as const;
    const principalProvider = {
      resolvePrincipal: vi.fn(() => ({ id: 'provider-agent', kind: 'agent', claims: { role: 'test' } })),
    };
    const identityProvider = {
      resolveIdentity: vi.fn(() => identity),
    };
    const authorityProvider = {
      resolveAuthority: vi.fn(() => authority),
    };
    const contexts: InvocationContext[] = [];
    const runtime = composeAgentRuntime({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      principalProvider,
      identityProvider,
      authorityProvider,
      resources: {
        listResources: (context) => (contexts.push(context), []),
        readResource: (_uri, context) => (contexts.push(context), { uri: 'x' }),
      },
    });
    await runtime.resources!.listResources();
    await runtime.resources!.readResource('x');
    expect(principalProvider.resolvePrincipal).toHaveBeenCalledOnce();
    expect(identityProvider.resolveIdentity).toHaveBeenCalledOnce();
    expect(authorityProvider.resolveAuthority).toHaveBeenCalledOnce();
    expect(runtime.identity).toEqual(identity);
    expect(contexts[0]).toMatchObject({ identity, principal: { id: 'provider-agent' }, scope: authority });
    expect(Object.isFrozen(runtime.identity)).toBe(true);
    expect(Object.isFrozen(runtime.principal)).toBe(true);
  });

  it('clones and recursively freezes provider claims', async () => {
    const claims = { profile: { roles: ['reader'] }, flags: { beta: true } };
    const principalProvider = {
      resolvePrincipal: vi.fn(() => ({ id: 'provider-agent', kind: 'agent', claims })),
    };
    const contexts: InvocationContext[] = [];
    const runtime = composeAgentRuntime({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      principalProvider,
      authority,
      resources: {
        listResources: (context) => (contexts.push(context), []),
        readResource: (_uri, context) => (contexts.push(context), { uri: 'x' }),
      },
    });

    claims.profile.roles.push('writer');
    claims.flags.beta = false;
    await runtime.resources!.listResources();

    expect(runtime.principal.claims).toEqual({
      profile: { roles: ['reader'] },
      flags: { beta: true },
    });
    expect(contexts[0]?.principal.claims).toBe(runtime.principal.claims);
    expect(Object.isFrozen(runtime.principal.claims)).toBe(true);
    const copiedClaims = runtime.principal.claims as {
      readonly profile: { readonly roles: readonly string[] };
    };
    expect(Object.isFrozen(copiedClaims.profile)).toBe(true);
    expect(Object.isFrozen(copiedClaims.profile.roles)).toBe(true);
  });

  it('rejects unsafe provider claim values', () => {
    const compose = (claims: unknown) => composeAgentRuntime({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      principalProvider: { resolvePrincipal: () => ({ id: 'provider-agent', kind: 'agent', claims }) },
      authority,
    });
    const cases: unknown[] = [
      { get value() { return true; } },
      { nested: Symbol('claim') },
      Object.assign({}, { nested: true }, { [Symbol('claim')]: true }),
      { nested: Number.POSITIVE_INFINITY },
      (() => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        return cycle;
      })(),
      new Date(),
      ['not', 'an', 'object'],
      { oversized: 'x'.repeat(1_000_001) },
      Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`claim-${index}`, true])),
      { ['x'.repeat(1_000_001)]: true },
    ];
    for (const claims of cases) {
      expect(() => compose(claims)).toThrow();
    }
  });

  it('supports static provider helpers and rejects invalid identifiers or duplicate sources', () => {
    expect(composeAgentRuntime({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      principalProvider: createStaticRuntimePrincipalProvider(principal),
      authorityProvider: createStaticRuntimeAuthorityProvider(authority),
      identity: undefined,
    }).principal).toEqual(principal);
    expect(composeAgentRuntime({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      principal,
      authority,
      identityProvider: createStaticRuntimeIdentityProvider(undefined),
    }).identity).toBeUndefined();
    expect(() => composeAgentRuntime({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      principal,
      principalProvider: createStaticRuntimePrincipalProvider(principal),
      authority,
    } as never)).toThrow('Exactly one');
    expect(() => composeAgentRuntime({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      principal: { id: '', kind: 'agent' },
      authority,
    })).toThrow('principal.id');
    expect(() => composeAgentRuntime({
      kernel: createRuntimeKernel({ permissionBroker: createAllowAllPermissionBroker() }),
      principal,
      authority,
      identity: null,
    } as never)).toThrow('identity must be an object');
  });
});
