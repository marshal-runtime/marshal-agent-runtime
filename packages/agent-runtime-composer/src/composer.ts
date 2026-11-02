import {
  assertSupportedProtocolVersion,
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
  type RuntimeExecuteRequest,
  type RuntimePrincipal,
  type RuntimeHarnessIdentity,
  type RuntimeSearchRequest,
} from '@marshal/agent-runtime-core';
import type {
  ComposeAgentRuntimeOptions,
  RuntimeBindingContext,
  RuntimeBindingExecuteRequest,
  RuntimeBindingSearchRequest,
  RuntimeComposerBindings,
  RuntimeLifecycleBindings,
  RuntimeResourceBindings,
  RuntimeSessionEndRequest,
  RuntimeSessionStartRequest,
  RuntimeTurnObservation,
  TrustedRuntimeAuthority,
} from './contracts.js';

const MAX_IDENTIFIER_LENGTH = 1_024;
const MAX_CLAIMS_DEPTH = 32;
const MAX_CLAIMS_ENTRIES = 10_000;
const MAX_CLAIMS_INPUT = 1_000_000;

/** Compose transport-facing bindings without constructing or owning capabilities. */
export function composeAgentRuntime(options: ComposeAgentRuntimeOptions): RuntimeComposerBindings {
  const hasPrincipal = options.principal !== undefined;
  const hasPrincipalProvider = options.principalProvider !== undefined;
  const hasAuthority = options.authority !== undefined;
  const hasAuthorityProvider = options.authorityProvider !== undefined;
  const hasIdentity = options.identity !== undefined;
  const hasIdentityProvider = options.identityProvider !== undefined;
  if (hasPrincipal === hasPrincipalProvider) {
    throw new Error('Exactly one of principal or principalProvider must be provided.');
  }
  if (hasAuthority === hasAuthorityProvider) {
    throw new Error('Exactly one of authority or authorityProvider must be provided.');
  }
  if (hasIdentity && hasIdentityProvider) {
    throw new Error('At most one of identity or identityProvider may be provided.');
  }
  const principal = freezePrincipal(
    options.principalProvider !== undefined
      ? options.principalProvider.resolvePrincipal()
      : options.principal,
  );
  const identity = freezeIdentity(
    options.identityProvider !== undefined
      ? options.identityProvider.resolveIdentity()
      : options.identity,
  );
  const authority = freezeAuthority(
    options.authorityProvider !== undefined
      ? options.authorityProvider.resolveAuthority()
      : options.authority,
  );
  const invocationContext = (context: RuntimeBindingContext = {}, sessionId?: string) =>
    createInvocationContext(principal, identity, authority, context, sessionId);

  const kernel = {
    async search(request: RuntimeBindingSearchRequest, context: RuntimeBindingContext = {}) {
      const normalized: RuntimeSearchRequest = {
        ...request,
        protocolVersion: normalizeProtocolVersion(request.protocolVersion),
      };
      return options.kernel.search(normalized, invocationContext(context));
    },
    async execute<TOutput = unknown>(
      request: RuntimeBindingExecuteRequest,
      context: RuntimeBindingContext = {},
    ) {
      const requestId = request.requestId ?? context.requestId;
      const normalized = {
        ...request,
        protocolVersion: normalizeProtocolVersion(request.protocolVersion),
        ...(requestId ? { requestId } : {}),
      } as RuntimeExecuteRequest;
      return options.kernel.execute<TOutput>(normalized, invocationContext(context));
    },
  };

  return Object.freeze({
    kernel,
    ...(options.lifecycle
      ? { lifecycle: createLifecycleBindings(options.lifecycle, invocationContext) }
      : {}),
    ...(options.resources
      ? { resources: createResourceBindings(options.resources, invocationContext) }
      : {}),
    principal,
    ...(identity ? { identity } : {}),
    authority,
    core: options.kernel,
  });
}

function createLifecycleBindings(
  port: NonNullable<ComposeAgentRuntimeOptions['lifecycle']>,
  invocationContext: (context?: RuntimeBindingContext, sessionId?: string) => InvocationContext,
): RuntimeLifecycleBindings {
  return {
    async startSession(request, context = {}) {
      return port.startSession(
        normalizeLifecycleRequest(request),
        invocationContext(context, request.sessionId),
      );
    },
    async observeTurn(request, context = {}) {
      return port.observeTurn(
        normalizeLifecycleRequest(request),
        invocationContext(context, request.sessionId),
      );
    },
    async endSession(request, context = {}) {
      return port.endSession(
        normalizeLifecycleRequest(request),
        invocationContext(context, request.sessionId),
      );
    },
  };
}

function createResourceBindings(
  port: NonNullable<ComposeAgentRuntimeOptions['resources']>,
  invocationContext: (context?: RuntimeBindingContext) => InvocationContext,
): RuntimeResourceBindings {
  return {
    async listResources(context = {}) {
      return port.listResources(invocationContext(context));
    },
    async readResource(uri, context = {}) {
      return port.readResource(uri, invocationContext(context));
    },
    ...(port.listTools
      ? {
          listTools: async (context: RuntimeBindingContext = {}) =>
            port.listTools!(invocationContext(context)),
        }
      : {}),
    ...(port.callTool
      ? {
          callTool: async (
            name: string,
            input: Readonly<Record<string, unknown>>,
            context: RuntimeBindingContext = {},
          ) => port.callTool!(name, input, invocationContext(context)),
        }
      : {}),
  };
}

function normalizeLifecycleRequest<
  T extends RuntimeSessionStartRequest | RuntimeTurnObservation | RuntimeSessionEndRequest,
>(request: T): T & { readonly protocolVersion: string } {
  validateIdentifier(request.sessionId, 'sessionId');
  if (request.eventId !== undefined) validateIdentifier(request.eventId, 'eventId');
  return {
    ...request,
    protocolVersion: normalizeProtocolVersion(request.protocolVersion),
  };
}

function normalizeProtocolVersion(version: string | undefined): string {
  const normalized = version ?? RUNTIME_PROTOCOL_VERSION;
  assertSupportedProtocolVersion(normalized);
  return normalized;
}

function createInvocationContext(
  principal: RuntimePrincipal,
  identity: RuntimeHarnessIdentity | undefined,
  authority: TrustedRuntimeAuthority,
  context: RuntimeBindingContext,
  requiredSessionId?: string,
): InvocationContext {
  const sessionId = requiredSessionId ?? context.sessionId;
  if (
    requiredSessionId !== undefined &&
    context.sessionId !== undefined &&
    context.sessionId !== requiredSessionId
  ) {
    throw new Error('Lifecycle request sessionId must match the binding context sessionId.');
  }
  for (const [field, value] of [
    ['sessionId', sessionId],
    ['threadId', context.threadId],
    ['parentExecutionId', context.parentExecutionId],
    ['requestId', context.requestId],
  ] as const) {
    if (value !== undefined) validateIdentifier(value, field);
  }
  return {
    principal,
    ...(identity ? { identity } : {}),
    scope: {
      workspaceId: authority.workspaceId,
      projectId: authority.projectId,
      ...(sessionId ? { sessionId } : {}),
      ...(context.threadId ? { threadId: context.threadId } : {}),
      ...(context.parentExecutionId
        ? { parentExecutionId: context.parentExecutionId }
        : {}),
    },
    ...(context.requestId ? { executionId: context.requestId } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.metadata ? { metadata: context.metadata } : {}),
  };
}

function freezePrincipal(principal: RuntimePrincipal): RuntimePrincipal {
  if (principal === null || typeof principal !== 'object') {
    throw new TypeError('principal must be an object.');
  }
  validateIdentifier(principal.id, 'principal.id');
  validateIdentifier(principal.kind, 'principal.kind');
  const claimsDescriptor = Object.getOwnPropertyDescriptor(principal, 'claims');
  if (claimsDescriptor?.get || claimsDescriptor?.set) {
    throw new TypeError('principal.claims must be a data property.');
  }
  const claims = claimsDescriptor?.value;
  return Object.freeze({
    id: principal.id,
    kind: principal.kind,
    ...(claims !== undefined ? { claims: cloneFreezeClaims(claims) } : {}),
  });
}

function cloneFreezeClaims(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('principal.claims must be a plain JSON object.');
  }
  const state = { entries: 0, input: 0, active: new Set<object>() };
  return cloneClaimsObject(value, 0, state);
}

type ClaimsCloneState = {
  entries: number;
  input: number;
  active: Set<object>;
};

function cloneClaimsValue(value: unknown, depth: number, state: ClaimsCloneState): unknown {
  if (++state.entries > MAX_CLAIMS_ENTRIES || depth > MAX_CLAIMS_DEPTH) {
    throw new TypeError('principal.claims is too large or deeply nested.');
  }
  if (typeof value === 'string') {
    state.input += value.length;
    if (state.input > MAX_CLAIMS_INPUT) {
      throw new TypeError('principal.claims is too large.');
    }
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('principal.claims contains a non-finite number.');
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('principal.claims must contain only JSON-compatible values.');
  }
  if (state.active.has(value)) {
    throw new TypeError('principal.claims must be acyclic.');
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
    if (value.length > MAX_CLAIMS_ENTRIES) {
      throw new TypeError('principal.claims array is too large.');
    }
    const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new TypeError('principal.claims arrays must contain data properties.');
        }
        result.push(cloneClaimsValue(descriptor.value, depth + 1, state));
      }
      for (const key of validateClaimKeys(value, new Set(['length']))) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError('principal.claims arrays cannot contain extra properties.');
        }
      }
      return Object.freeze(result);
    }
    return cloneClaimsObject(value, depth, state);
  } finally {
    state.active.delete(value);
  }
}

function cloneClaimsObject(
  value: object,
  depth: number,
  state: ClaimsCloneState,
): Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('principal.claims must contain only plain JSON objects.');
  }
  const result: Record<string, unknown> = {};
  for (const key of validateClaimKeys(value)) {
    state.input += key.length;
    if (state.input > MAX_CLAIMS_INPUT) {
      throw new TypeError('principal.claims is too large.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      throw new TypeError('principal.claims must contain only data properties.');
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloneClaimsValue(descriptor.value, depth + 1, state),
      writable: true,
    });
  }
  return Object.freeze(result);
}

function validateClaimKeys(value: object, allowedNonEnumerable = new Set<string>()): string[] {
  const keys = Reflect.ownKeys(value);
  const stringKeys: string[] = [];
  for (const key of keys) {
    if (typeof key === 'symbol') {
      throw new TypeError('principal.claims cannot contain symbol properties.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!descriptor.enumerable && !allowedNonEnumerable.has(key)) {
      throw new TypeError('principal.claims cannot contain non-enumerable properties.');
    }
    stringKeys.push(key);
  }
  return stringKeys.filter((key) => !allowedNonEnumerable.has(key));
}

function freezeIdentity(
  identity: RuntimeHarnessIdentity | undefined,
): RuntimeHarnessIdentity | undefined {
  if (identity === undefined) return undefined;
  if (identity === null || typeof identity !== 'object') {
    throw new TypeError('identity must be an object when provided.');
  }
  validateIdentifier(identity.harnessId, 'identity.harnessId');
  for (const [field, value] of [
    ['installationId', identity.installationId],
    ['profileId', identity.profileId],
    ['userId', identity.userId],
    ['agentId', identity.agentId],
  ] as const) {
    if (value !== undefined) validateIdentifier(value, `identity.${field}`);
  }
  return Object.freeze({ ...identity });
}

function freezeAuthority(authority: TrustedRuntimeAuthority): TrustedRuntimeAuthority {
  if (authority === null || typeof authority !== 'object') {
    throw new TypeError('authority must be an object.');
  }
  validateIdentifier(authority.workspaceId, 'authority.workspaceId');
  validateIdentifier(authority.projectId, 'authority.projectId');
  return Object.freeze({
    workspaceId: authority.workspaceId,
    projectId: authority.projectId,
  });
}

function validateIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`${field} must be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} characters.`);
  }
}
