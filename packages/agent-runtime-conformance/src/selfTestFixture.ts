import type {
  AdapterCallContext,
  AdapterCancellationHandle,
  AdapterConformanceCaseName,
  AdapterConformanceEnvironment,
  AdapterConformanceFixture,
  AdapterConformanceLegacyAliasManifest,
  AdapterConformanceManifest,
  AdapterConformanceObservations,
  AdapterExecutionRequest,
  JsonRecord,
} from './contracts.js';

export interface SelfTestConformanceFixtureOptions {
  readonly name?: string;
  readonly legacyAliases?: AdapterConformanceLegacyAliasManifest;
}

/** A deterministic in-memory adapter used to prove the assertions themselves. */
export function createSelfTestConformanceFixture(
  options: SelfTestConformanceFixtureOptions = {},
): AdapterConformanceFixture {
  const capabilities = {
    echo: 'conformance.echo',
    denied: 'conformance.denied',
    approval: 'conformance.approval',
    cancellable: 'conformance.cancellable',
    scopeWrite: 'conformance.scope.write',
    scopeRead: 'conformance.scope.read',
    nativeEffects: 'runtime.effects.execute',
  };
  const manifest: AdapterConformanceManifest = {
    supportedProtocolVersion: '1.0.0',
    unsupportedProtocolVersion: '2.0.0',
    capabilities,
    primaryContext: {
      principalId: 'self-test-agent',
      requestId: 'self-test-primary',
      scope: {
        workspaceId: 'self-test-workspace',
        projectId: 'self-test-project',
        sessionId: 'self-test-session-a',
      },
    },
    isolatedContext: {
      principalId: 'self-test-agent',
      requestId: 'self-test-isolated',
      scope: {
        workspaceId: 'self-test-workspace',
        projectId: 'self-test-project',
        sessionId: 'self-test-session-b',
      },
    },
    resourceFallback: {
      toolName: 'runtime_exec',
      input: { targetType: 'operation', target: capabilities.echo, input: { value: 'resource-fallback' } },
      expectedOutput: { value: 'resource-fallback' },
    },
    unsupportedEffectKind: 'self-test.unsupported-effect',
    legacyAliases: options.legacyAliases ?? { operation: true, implicitTarget: true },
  };
  return {
    name: options.name ?? 'self-test-adapter',
    manifest,
    create: (caseName) => createEnvironment(manifest, caseName),
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

  const inspect = (): AdapterConformanceObservations => ({
    capabilityInvocations: { ...capabilityInvocations },
    lifecycleApplications: { ...lifecycleApplications },
    resourceToolAttempts: { ...resourceToolAttempts },
    runtimeToolFallbacks: { ...runtimeToolFallbacks },
  });

  return {
    port: {
      search(request, context) {
        assertProtocol(request.protocolVersion, manifest);
        const known = new Set(Object.values(manifest.capabilities));
        const selected = request.name
          ? (known.has(request.name) ? [request.name] : [])
          : [...known].filter((name) => !request.query || name.includes(request.query));
        return {
          protocolVersion: manifest.supportedProtocolVersion,
          query: request.query ?? request.name ?? '',
          matches: selected.map((name) => ({
            protocolVersion: manifest.supportedProtocolVersion,
            capability: {
              protocolVersion: manifest.supportedProtocolVersion,
              name,
              version: '1.0.0',
              description: `Self-test capability ${name}`,
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object', properties: {}, additionalProperties: false },
              provider: { id: 'self-test-provider', version: '1.0.0' },
            },
            score: 1,
            matchedTerms: [name],
            matchedFields: ['name'],
          })),
          context: context.requestId,
        };
      },
      execute(request, context) {
        assertProtocol(request.protocolVersion, manifest);
        const normalized = normalizeExecution(request, manifest);
        const target = normalized.target;
        if (isAborted(context.signal)) {
          return response('cancelled', target, context, nextId, {
            error: { code: 'execution_cancelled', message: 'Execution was cancelled.' },
          });
        }
        if (target === manifest.capabilities.denied) {
          return response('denied', target, context, nextId, {
            error: { code: 'permission_denied', message: 'Denied by the self-test policy.' },
            permission: { decision: 'deny', code: 'permission_denied' },
          });
        }
        if (target === manifest.capabilities.approval) {
          const approval = {
            decision: 'approval',
            approvalId: 'self-test-approval',
            reason: 'Self-test approval is required.',
          };
          return response('approval_required', target, context, nextId, {
            approval,
            permission: approval,
          });
        }
        const known = new Set(Object.values(manifest.capabilities));
        if (!known.has(target)) {
          return response('not_found', target, context, nextId, {
            error: { code: 'capability_not_found', message: `Capability ${target} was not found.` },
          });
        }

        increment(capabilityInvocations, target);
        if (target === manifest.capabilities.scopeWrite) {
          const input = record(normalized.input);
          const key = requiredString(input.key, 'key');
          const values = scopedValues.get(scopeKey(context)) ?? new Map<string, unknown>();
          values.set(key, input.value);
          scopedValues.set(scopeKey(context), values);
          return response('success', target, context, nextId, { output: { stored: true } });
        }
        if (target === manifest.capabilities.scopeRead) {
          const key = requiredString(record(normalized.input).key, 'key');
          const values = scopedValues.get(scopeKey(context));
          return response('success', target, context, nextId, {
            output: values?.has(key) ? { found: true, value: values.get(key) } : { found: false },
          });
        }
        if (target === manifest.capabilities.nativeEffects) {
          const input = record(normalized.input);
          const kind = requiredString(input.kind, 'kind');
          const effectReceipt = {
            protocolVersion: manifest.supportedProtocolVersion,
            receiptId: nextId('effect-receipt'),
            effectId: nextId('effect'),
            kind,
            status: 'unsupported',
            principalId: context.principalId ?? 'self-test-agent',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:00.000Z',
            durationMs: 0,
          };
          return response('success', target, context, nextId, {
            output: {
              protocolVersion: manifest.supportedProtocolVersion,
              status: 'unsupported',
              reason: `No adapter handler supports effect ${kind}.`,
              receipt: effectReceipt,
            },
            providerReceipt: effectReceipt,
          });
        }
        return response('success', target, context, nextId, { output: normalized.input });
      },
      lifecycle: {
        start(request) {
          assertProtocol(request.protocolVersion, manifest);
          applyLifecycle(request.eventId, lifecycleEvents, lifecycleApplications);
          return { status: 'success', sessionId: request.sessionId };
        },
        observe(request) {
          assertProtocol(request.protocolVersion, manifest);
          applyLifecycle(request.eventId, lifecycleEvents, lifecycleApplications);
          return { status: 'success', sessionId: request.sessionId };
        },
        end(request) {
          assertProtocol(request.protocolVersion, manifest);
          applyLifecycle(request.eventId, lifecycleEvents, lifecycleApplications);
          return { status: 'success', sessionId: request.sessionId };
        },
      },
      callTool(name) {
        if (name === manifest.resourceFallback.toolName) {
          increment(runtimeToolFallbacks, name);
          return { output: manifest.resourceFallback.expectedOutput };
        }
        increment(resourceToolAttempts, name);
        throw Object.assign(new Error(`Unknown self-test tool ${name}.`), { code: 'tool_not_found' });
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
    dispose() {},
  };

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence}`;
  }
}

function normalizeExecution(
  request: AdapterExecutionRequest,
  manifest: AdapterConformanceManifest,
): { target: string; input?: unknown } {
  if ('targetType' in request) return { target: request.target, input: request.input };
  if ('operation' in request) {
    if (!manifest.legacyAliases?.operation) throw unsupportedAlias('operation');
    return { target: request.operation, input: request.input };
  }
  if (!manifest.legacyAliases?.implicitTarget) throw unsupportedAlias('implicit target');
  return { target: request.target, input: request.input };
}

function response(
  status: string,
  target: string,
  context: AdapterCallContext,
  nextId: (prefix: string) => string,
  options: {
    output?: unknown;
    error?: JsonRecord;
    approval?: JsonRecord;
    permission?: JsonRecord;
    providerReceipt?: unknown;
  },
): JsonRecord {
  const executionId = nextId('execution');
  return {
    protocolVersion: '1.0.0',
    status,
    result: options.output === undefined ? undefined : {
      output: options.output,
      receipt: options.providerReceipt,
    },
    error: options.error,
    approval: options.approval,
    receipt: {
      protocolVersion: '1.0.0',
      receiptId: nextId('receipt'),
      executionId,
      target,
      provider: { id: 'self-test-provider', version: '1.0.0' },
      capabilityVersion: '1.0.0',
      principalId: context.principalId ?? 'self-test-agent',
      scope: { ...context.scope },
      lineage: { rootExecutionId: executionId, depth: 0 },
      status,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      permission: options.permission ?? { decision: 'allow' },
      providerReceipt: options.providerReceipt,
    },
  };
}

function assertProtocol(version: string, manifest: AdapterConformanceManifest): void {
  if (version.split('.')[0] !== manifest.supportedProtocolVersion.split('.')[0]) {
    throw Object.assign(
      new Error(`Unsupported protocol version ${version}.`),
      { code: 'unsupported_protocol_version' },
    );
  }
}

function applyLifecycle(
  eventId: string,
  seen: Set<string>,
  applications: Record<string, number>,
): void {
  if (seen.has(eventId)) return;
  seen.add(eventId);
  increment(applications, eventId);
}

function increment(values: Record<string, number>, key: string): void {
  values[key] = (values[key] ?? 0) + 1;
}

function isAborted(signal: unknown): boolean {
  return Boolean(record(signal).aborted);
}

function scopeKey(context: AdapterCallContext): string {
  return JSON.stringify(Object.entries(context.scope).sort(([left], [right]) => left.localeCompare(right)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required.`);
  return value;
}

function unsupportedAlias(label: string): Error {
  return Object.assign(new Error(`The ${label} alias is not enabled.`), { code: 'invalid_execution_request' });
}
