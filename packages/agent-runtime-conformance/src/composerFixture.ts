import {
  composeAgentRuntime,
  type RuntimeBindingContext,
  type RuntimeScopedLifecyclePort,
  type RuntimeScopedResourcePort,
} from '@marshal/agent-runtime-composer';
import {
  createRuntimeKernel,
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type InvocationContext,
  type PermissionBroker,
  type RuntimeAbortSignal,
} from '@marshal/agent-runtime-core';
import type {
  AdapterCallContext,
  AdapterCancellationHandle,
  AdapterConformanceCaseName,
  AdapterConformanceEnvironment,
  AdapterConformanceFixture,
  AdapterConformanceManifest,
  AdapterConformanceObservations,
  AdapterExecutionRequest,
  JsonRecord,
} from './contracts.js';

const CAPABILITIES = {
  echo: 'conformance.echo',
  denied: 'conformance.denied',
  approval: 'conformance.approval',
  cancellable: 'conformance.cancellable',
  scopeWrite: 'conformance.scope.write',
  scopeRead: 'conformance.scope.read',
  nativeEffects: 'runtime.effects.execute',
} as const;

const COMPOSER_MANIFEST: AdapterConformanceManifest = {
  supportedProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  unsupportedProtocolVersion: '2.0.0',
  capabilities: CAPABILITIES,
  primaryContext: {
    principalId: 'composer-agent',
    requestId: 'composer-primary',
    scope: {
      workspaceId: 'composer-workspace',
      projectId: 'composer-project',
      sessionId: 'composer-session-a',
    },
  },
  isolatedContext: {
    principalId: 'composer-agent',
    requestId: 'composer-isolated',
    scope: {
      workspaceId: 'composer-workspace',
      projectId: 'composer-project',
      sessionId: 'composer-session-b',
    },
  },
  resourceFallback: {
    toolName: 'runtime_exec',
    input: {
      targetType: 'operation',
      target: CAPABILITIES.echo,
      input: { value: 'composer-resource-fallback' },
    },
    expectedOutput: { value: 'composer-resource-fallback' },
  },
  unsupportedEffectKind: 'composer.unsupported-effect',
  legacyAliases: {},
};

/** Exercises conformance through the real core kernel and generic composer. */
export function createComposerConformanceFixture(): AdapterConformanceFixture {
  return {
    name: 'generic-composer',
    manifest: COMPOSER_MANIFEST,
    create: (caseName) => createEnvironment(COMPOSER_MANIFEST, caseName),
  };
}

function createEnvironment(
  manifest: AdapterConformanceManifest,
  _caseName: AdapterConformanceCaseName,
): AdapterConformanceEnvironment {
  const capabilityInvocations: Record<string, number> = {};
  const lifecycleApplications: Record<string, number> = {};
  const resourceToolAttempts: Record<string, number> = {};
  const runtimeToolFallbacks: Record<string, number> = {};
  const lifecycleEvents = new Set<string>();
  const scopedValues = new Map<string, Map<string, unknown>>();
  let sequence = 0;

  const permissionBroker: PermissionBroker = {
    decide(check) {
      if (check.capability.name === manifest.capabilities.denied) {
        return {
          decision: 'deny',
          code: 'permission_denied',
          reason: 'Denied by the composer conformance policy.',
        };
      }
      if (check.capability.name === manifest.capabilities.approval) {
        return {
          decision: 'approval',
          approvalId: 'composer-approval',
          reason: 'Composer conformance approval is required.',
        };
      }
      return { decision: 'allow', reason: 'Allowed by the composer conformance policy.' };
    },
  };
  const kernel = createRuntimeKernel({
    permissionBroker,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    createId(kind) {
      sequence += 1;
      return `${kind}-${sequence}`;
    },
  });
  const registration = kernel.register({
    id: 'composer-conformance-provider',
    version: '1.0.0',
    list: () => descriptors(manifest),
    invoke(name, input, context) {
      increment(capabilityInvocations, name);
      if (name === manifest.capabilities.scopeWrite) {
        const values = scopedValues.get(scopeKey(context)) ?? new Map<string, unknown>();
        const request = record(input);
        values.set(requiredString(request.key, 'key'), request.value);
        scopedValues.set(scopeKey(context), values);
        return { output: { stored: true } };
      }
      if (name === manifest.capabilities.scopeRead) {
        const key = requiredString(record(input).key, 'key');
        const values = scopedValues.get(scopeKey(context));
        return {
          output: values?.has(key)
            ? { found: true, value: values.get(key) }
            : { found: false },
        };
      }
      if (name === manifest.capabilities.nativeEffects) {
        const kind = requiredString(record(input).kind, 'kind');
        const effectReceipt = {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          receiptId: nextId('effect-receipt'),
          effectId: nextId('effect'),
          kind,
          status: 'unsupported',
          principalId: context.principal.id,
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.000Z',
          durationMs: 0,
        };
        return {
          output: {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            status: 'unsupported',
            reason: `No native handler supports effect ${kind}.`,
            receipt: effectReceipt,
          },
          receipt: effectReceipt,
        };
      }
      return { output: input };
    },
  });

  const lifecycle: RuntimeScopedLifecyclePort = {
    startSession: (request) => applyLifecycle(request.eventId),
    observeTurn: (request) => applyLifecycle(request.eventId),
    endSession: (request) => applyLifecycle(request.eventId),
  };
  const resources: RuntimeScopedResourcePort = {
    listResources: () => [],
    readResource: (uri) => ({ uri, text: '' }),
    callTool(name) {
      increment(resourceToolAttempts, name);
      return undefined;
    },
  };
  const runtime = composeAgentRuntime({
    kernel,
    principal: { id: 'composer-agent', kind: 'agent' },
    authority: {
      workspaceId: requiredString(manifest.primaryContext.scope.workspaceId, 'workspaceId'),
      projectId: requiredString(manifest.primaryContext.scope.projectId, 'projectId'),
    },
    lifecycle,
    resources,
  });

  const inspect = (): AdapterConformanceObservations => ({
    capabilityInvocations: { ...capabilityInvocations },
    lifecycleApplications: { ...lifecycleApplications },
    resourceToolAttempts: { ...resourceToolAttempts },
    runtimeToolFallbacks: { ...runtimeToolFallbacks },
  });

  return {
    port: {
      search(request, context) {
        return runtime.kernel.search(request, bindingContext(context));
      },
      execute(request, context) {
        return runtime.kernel.execute(normalizeExecution(request), bindingContext(context));
      },
      lifecycle: {
        start: (request, context) => runtime.lifecycle!.startSession(request, bindingContext(context)),
        observe: (request, context) => runtime.lifecycle!.observeTurn(request, bindingContext(context)),
        end: (request, context) => runtime.lifecycle!.endSession(request, bindingContext(context)),
      },
      async callTool(name, input, context) {
        const callContext = bindingContext(context);
        if (name === manifest.resourceFallback.toolName) {
          increment(runtimeToolFallbacks, name);
          return runtime.kernel.execute(normalizeToolExecution(input), callContext);
        }
        const resourceResult = await runtime.resources!.callTool?.(name, input, callContext);
        if (resourceResult !== undefined) return resourceResult;
        throw Object.assign(new Error(`Unknown composer tool ${name}.`), {
          code: 'tool_not_found',
        });
      },
      createCancellation(): AdapterCancellationHandle {
        const signal: { aborted: boolean; reason?: unknown } = { aborted: false };
        return {
          signal,
          abort(reason) {
            signal.aborted = true;
            signal.reason = reason;
          },
        };
      },
    },
    inspect,
    dispose() {
      registration.dispose();
    },
  };

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence}`;
  }

  function applyLifecycle(eventId: string | undefined): { status: 'success' } {
    const id = requiredString(eventId, 'eventId');
    if (!lifecycleEvents.has(id)) {
      lifecycleEvents.add(id);
      increment(lifecycleApplications, id);
    }
    return { status: 'success' };
  }
}

function descriptors(manifest: AdapterConformanceManifest): readonly CapabilityDescriptor[] {
  return Object.values(manifest.capabilities).map((name) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    description: `Composer conformance capability ${name}.`,
    inputSchema: { type: 'object' },
    outputSchema: conformanceOutputSchema(name, manifest),
    ...(name === manifest.capabilities.denied
      ? { permissions: [{ permission: 'conformance.denied', risk: 'high' as const }] }
      : {}),
    ...(name === manifest.capabilities.approval
      ? { permissions: [{ permission: 'conformance.approval', risk: 'high' as const }] }
      : {}),
  }));
}

function conformanceOutputSchema(
  name: string,
  manifest: AdapterConformanceManifest,
): CapabilityDescriptor['outputSchema'] {
  if (name === manifest.capabilities.echo || name === manifest.capabilities.cancellable) {
    return {
      type: 'object', properties: { value: {} }, required: ['value'], additionalProperties: false,
    };
  }
  if (name === manifest.capabilities.scopeWrite) {
    return {
      type: 'object', properties: { stored: { type: 'boolean' } }, required: ['stored'], additionalProperties: false,
    };
  }
  if (name === manifest.capabilities.scopeRead) {
    return {
      type: 'object', properties: { found: { type: 'boolean' }, value: {} }, required: ['found'], additionalProperties: false,
    };
  }
  if (name === manifest.capabilities.nativeEffects) {
    return {
      type: 'object',
      properties: {
        protocolVersion: { const: RUNTIME_PROTOCOL_VERSION }, status: { const: 'unsupported' },
        reason: { type: 'string', maxLength: 4_000 },
        receipt: {
          type: 'object', properties: {
            protocolVersion: { const: RUNTIME_PROTOCOL_VERSION }, receiptId: { type: 'string', maxLength: 256 },
            effectId: { type: 'string', maxLength: 256 }, kind: { type: 'string', maxLength: 256 },
            status: { const: 'unsupported' }, principalId: { type: 'string', maxLength: 256 },
            startedAt: { type: 'string', maxLength: 64 }, completedAt: { type: 'string', maxLength: 64 },
            durationMs: { type: 'number', minimum: 0 },
          },
          required: ['protocolVersion', 'receiptId', 'effectId', 'kind', 'status', 'principalId', 'startedAt', 'completedAt', 'durationMs'],
          additionalProperties: false,
        },
      },
      required: ['protocolVersion', 'status', 'reason', 'receipt'],
      additionalProperties: false,
    };
  }
  return { type: 'object', properties: {}, additionalProperties: false };
}

function normalizeExecution(request: AdapterExecutionRequest) {
  if (!('targetType' in request)) {
    throw Object.assign(new Error('Generic composer requires an explicit operation targetType.'), {
      code: 'invalid_execution_request',
    });
  }
  return request;
}

function normalizeToolExecution(input: JsonRecord) {
  if (input.targetType !== 'operation') {
    throw Object.assign(new Error('runtime_exec requires targetType operation.'), {
      code: 'invalid_execution_request',
    });
  }
  return {
    protocolVersion:
      typeof input.protocolVersion === 'string' ? input.protocolVersion : RUNTIME_PROTOCOL_VERSION,
    targetType: 'operation' as const,
    target: requiredString(input.target, 'target'),
    input: input.input,
  };
}

function bindingContext(context: AdapterCallContext): RuntimeBindingContext {
  return {
    sessionId: context.scope.sessionId,
    threadId: context.scope.threadId,
    parentExecutionId: context.scope.parentExecutionId,
    requestId: context.requestId,
    signal: asAbortSignal(context.signal),
    metadata: context.metadata,
  };
}

function asAbortSignal(value: unknown): RuntimeAbortSignal | undefined {
  if (!value || typeof value !== 'object' || !('aborted' in value)) return undefined;
  const signal = value as { readonly aborted: unknown; readonly reason?: unknown };
  if (typeof signal.aborted !== 'boolean') return undefined;
  return { get aborted() { return signal.aborted as boolean; }, get reason() { return signal.reason; } };
}

function scopeKey(context: InvocationContext): string {
  return JSON.stringify(Object.entries(context.scope ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function increment(values: Record<string, number>, key: string): void {
  values[key] = (values[key] ?? 0) + 1;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}
