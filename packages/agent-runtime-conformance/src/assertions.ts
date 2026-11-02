import {
  ADAPTER_CONFORMANCE_CASES,
  type AdapterCallContext,
  type AdapterConformanceCaseName,
  type AdapterConformanceCaseResult,
  type AdapterConformanceEnvironment,
  type AdapterConformanceFixture,
  type AdapterConformanceReport,
  type AdapterExecutionRequest,
  type JsonRecord,
} from './contracts.js';

type ConformanceAssertion = (fixture: AdapterConformanceFixture) => Promise<void>;

export class AdapterConformanceError extends Error {
  constructor(
    readonly caseName: AdapterConformanceCaseName | 'suite',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdapterConformanceError';
  }
}

export async function assertProtocolNegotiation(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'protocol-negotiation', async ({ port }) => {
    const { manifest } = fixture;
    const supported = asRecord(await port.search({
      protocolVersion: manifest.supportedProtocolVersion,
      name: manifest.capabilities.echo,
    }, manifest.primaryContext), 'protocol-negotiation', 'Supported search response');
    check(
      'protocol-negotiation',
      supported.protocolVersion === manifest.supportedProtocolVersion,
      'The adapter did not return the negotiated protocol version.',
      supported,
    );

    let unsupportedCode: string | undefined;
    try {
      const response = await port.search({
        protocolVersion: manifest.unsupportedProtocolVersion,
        name: manifest.capabilities.echo,
      }, manifest.primaryContext);
      unsupportedCode = errorCode(response);
    } catch (error) {
      unsupportedCode = errorCode(error);
    }
    check(
      'protocol-negotiation',
      unsupportedCode === 'unsupported_protocol_version',
      'An unsupported major protocol version must fail with unsupported_protocol_version.',
      { unsupportedCode },
    );
  });
}

export async function assertExactLookup(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'exact-lookup', async ({ port }) => {
    const { manifest } = fixture;
    const response = asRecord(await port.search({
      protocolVersion: manifest.supportedProtocolVersion,
      name: manifest.capabilities.echo,
      query: 'deliberately unrelated semantic query',
      limit: 20,
    }, manifest.primaryContext), 'exact-lookup', 'Search response');
    const matches = asArray(response.matches, 'exact-lookup', 'Search matches');
    check('exact-lookup', matches.length === 1, 'Exact lookup must return exactly one match.', matches);
    const match = asRecord(matches[0], 'exact-lookup', 'Search match');
    const capability = asRecord(match.capability, 'exact-lookup', 'Matched capability');
    check(
      'exact-lookup',
      capability.name === manifest.capabilities.echo,
      'Exact lookup returned a different capability.',
      capability,
    );
  });
}

export async function assertOperationExecution(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'operation-execution', async ({ port }) => {
    const nonce = 'operation-execution-nonce';
    const response = executionResponse(await port.execute(operationRequest(
      fixture,
      fixture.manifest.capabilities.echo,
      { value: nonce },
    ), fixture.manifest.primaryContext), 'operation-execution');
    check('operation-execution', response.status === 'success', 'Operation execution did not succeed.', response);
    check(
      'operation-execution',
      sameJson(executionOutput(response, 'operation-execution'), { value: nonce }),
      'The operation output was not preserved through the adapter.',
      response,
    );
  });
}

export async function assertDenial(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'denial', async (environment) => {
    const { manifest } = fixture;
    const response = executionResponse(await environment.port.execute(operationRequest(
      fixture,
      manifest.capabilities.denied,
      { value: 'must-not-run' },
    ), manifest.primaryContext), 'denial');
    check('denial', response.status === 'denied', 'Denied execution must preserve the denied status.', response);
    check('denial', Boolean(errorCode(response)), 'Denied execution must include a stable error code.', response);
    check('denial', receiptStatus(response) === 'denied', 'The denial receipt status is missing or incorrect.', response);
    const observations = await environment.inspect();
    check(
      'denial',
      count(observations.capabilityInvocations, manifest.capabilities.denied) === 0,
      'The denied capability was invoked.',
      observations,
    );
  });
}

export async function assertApproval(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'approval', async (environment) => {
    const { manifest } = fixture;
    const response = executionResponse(await environment.port.execute(operationRequest(
      fixture,
      manifest.capabilities.approval,
      { value: 'requires-approval' },
    ), manifest.primaryContext), 'approval');
    check(
      'approval',
      response.status === 'approval_required',
      'Approval must preserve approval_required rather than becoming a generic failure.',
      response,
    );
    const approval = asRecord(response.approval, 'approval', 'Approval payload');
    check('approval', typeof approval.reason === 'string' && approval.reason.length > 0, 'Approval reason is required.', approval);
    check('approval', receiptStatus(response) === 'approval_required', 'The approval receipt status is incorrect.', response);
    const observations = await environment.inspect();
    check(
      'approval',
      count(observations.capabilityInvocations, manifest.capabilities.approval) === 0,
      'The approval-gated capability ran before approval.',
      observations,
    );
  });
}

export async function assertCancellation(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'cancellation', async (environment) => {
    const { manifest } = fixture;
    const cancellation = environment.port.createCancellation();
    cancellation.abort('conformance cancellation');
    const context: AdapterCallContext = { ...manifest.primaryContext, signal: cancellation.signal };
    const response = executionResponse(await environment.port.execute(operationRequest(
      fixture,
      manifest.capabilities.cancellable,
      { value: 'must-not-run' },
    ), context), 'cancellation');
    check('cancellation', response.status === 'cancelled', 'Cancellation status was not preserved.', response);
    check('cancellation', receiptStatus(response) === 'cancelled', 'The cancellation receipt status is incorrect.', response);
    const observations = await environment.inspect();
    check(
      'cancellation',
      count(observations.capabilityInvocations, manifest.capabilities.cancellable) === 0,
      'A pre-cancelled operation reached its provider.',
      observations,
    );
  });
}

export async function assertLifecycleIdempotency(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'lifecycle-idempotency', async (environment) => {
    const { manifest } = fixture;
    const sessionId = manifest.primaryContext.scope.sessionId ?? 'conformance-session';
    const events = {
      start: 'lifecycle-start-event',
      observe: 'lifecycle-observe-event',
      end: 'lifecycle-end-event',
    };
    const start = {
      protocolVersion: manifest.supportedProtocolVersion,
      eventId: events.start,
      sessionId,
    };
    const observe = {
      protocolVersion: manifest.supportedProtocolVersion,
      eventId: events.observe,
      sessionId,
      kind: 'user_message' as const,
      content: 'Remember the idempotency marker.',
    };
    const end = {
      protocolVersion: manifest.supportedProtocolVersion,
      eventId: events.end,
      sessionId,
      outcome: 'complete',
    };
    await environment.port.lifecycle.start(start, manifest.primaryContext);
    await environment.port.lifecycle.start(start, manifest.primaryContext);
    await environment.port.lifecycle.observe(observe, manifest.primaryContext);
    await environment.port.lifecycle.observe(observe, manifest.primaryContext);
    await environment.port.lifecycle.end(end, manifest.primaryContext);
    await environment.port.lifecycle.end(end, manifest.primaryContext);

    const observations = await environment.inspect();
    for (const eventId of Object.values(events)) {
      check(
        'lifecycle-idempotency',
        count(observations.lifecycleApplications, eventId) === 1,
        `Lifecycle event ${eventId} was not applied exactly once.`,
        observations,
      );
    }
  });
}

export async function assertScopeIsolation(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'scope-isolation', async ({ port }) => {
    const { manifest } = fixture;
    const key = 'scope-isolation-key';
    const value = 'scope-isolation-value';
    const write = executionResponse(await port.execute(operationRequest(
      fixture,
      manifest.capabilities.scopeWrite,
      { key, value },
    ), manifest.primaryContext), 'scope-isolation');
    check('scope-isolation', write.status === 'success', 'Scoped write failed.', write);

    const primary = executionResponse(await port.execute(operationRequest(
      fixture,
      manifest.capabilities.scopeRead,
      { key },
    ), manifest.primaryContext), 'scope-isolation');
    const isolated = executionResponse(await port.execute(operationRequest(
      fixture,
      manifest.capabilities.scopeRead,
      { key },
    ), manifest.isolatedContext), 'scope-isolation');
    check(
      'scope-isolation',
      sameJson(executionOutput(primary, 'scope-isolation'), { found: true, value }),
      'The value was not readable in its owning scope.',
      primary,
    );
    check(
      'scope-isolation',
      sameJson(executionOutput(isolated, 'scope-isolation'), { found: false }),
      'Scoped state leaked into an isolated context.',
      isolated,
    );
  });
}

export async function assertResourceFallback(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'resource-fallback', async (environment) => {
    const { manifest } = fixture;
    const fallback = manifest.resourceFallback;
    const response = await environment.port.callTool(
      fallback.toolName,
      fallback.input,
      manifest.primaryContext,
    );
    check(
      'resource-fallback',
      sameJson(transportOutput(response), fallback.expectedOutput),
      'A resource-plane miss did not fall through to the runtime tool handler.',
      response,
    );
    const observations = await environment.inspect();
    check(
      'resource-fallback',
      count(observations.resourceToolAttempts, fallback.toolName) === 0,
      'A reserved runtime tool was offered to the resource plane before core dispatch.',
      observations,
    );
    check(
      'resource-fallback',
      count(observations.runtimeToolFallbacks, fallback.toolName) === 1,
      'The runtime tool fallback was not invoked exactly once.',
      observations,
    );
  });
}

export async function assertUnsupportedNativeEffects(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'unsupported-native-effects', async ({ port }) => {
    const { manifest } = fixture;
    const response = executionResponse(await port.execute(operationRequest(
      fixture,
      manifest.capabilities.nativeEffects,
      {
        kind: manifest.unsupportedEffectKind,
        input: { marker: 'unsupported-effect' },
        idempotencyKey: 'conformance-unsupported-effect',
      },
    ), manifest.primaryContext), 'unsupported-native-effects');
    check('unsupported-native-effects', response.status === 'success', 'The effect provider operation failed.', response);
    const output = asRecord(executionOutput(response, 'unsupported-native-effects'), 'unsupported-native-effects', 'Effect response');
    check(
      'unsupported-native-effects',
      output.status === 'unsupported',
      'An unsupported native effect must remain explicit.',
      output,
    );
    const receipt = asRecord(output.receipt, 'unsupported-native-effects', 'Effect receipt');
    check('unsupported-native-effects', receipt.status === 'unsupported', 'The effect receipt status is incorrect.', receipt);
    check('unsupported-native-effects', receipt.kind === manifest.unsupportedEffectKind, 'The effect receipt kind is incorrect.', receipt);
  });
}

export async function assertReceipts(fixture: AdapterConformanceFixture): Promise<void> {
  await withEnvironment(fixture, 'receipts', async ({ port }) => {
    const { manifest } = fixture;
    const response = executionResponse(await port.execute(operationRequest(
      fixture,
      manifest.capabilities.echo,
      { value: 'receipt-marker' },
    ), manifest.primaryContext), 'receipts');
    check('receipts', response.status === 'success', 'Receipt probe execution failed.', response);
    const receipt = asRecord(response.receipt, 'receipts', 'Execution receipt');
    const requiredStrings = ['receiptId', 'executionId', 'principalId', 'startedAt', 'completedAt'] as const;
    for (const field of requiredStrings) {
      check('receipts', typeof receipt[field] === 'string' && receipt[field].length > 0, `Receipt ${field} is required.`, receipt);
    }
    check('receipts', receipt.protocolVersion === manifest.supportedProtocolVersion, 'Receipt protocol version is incorrect.', receipt);
    check('receipts', receipt.target === manifest.capabilities.echo, 'Receipt target is incorrect.', receipt);
    check('receipts', receipt.status === 'success', 'Receipt status is incorrect.', receipt);
    const lineage = asRecord(receipt.lineage, 'receipts', 'Receipt lineage');
    check(
      'receipts',
      lineage.rootExecutionId === receipt.executionId && lineage.depth === 0,
      'A top-level receipt must declare itself as the depth-zero execution root.',
      lineage,
    );
    check(
      'receipts',
      typeof receipt.durationMs === 'number' && Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0,
      'Receipt durationMs must be a finite non-negative number.',
      receipt,
    );
    for (const field of ['startedAt', 'completedAt'] as const) {
      check('receipts', !Number.isNaN(Date.parse(String(receipt[field]))), `Receipt ${field} is not an ISO timestamp.`, receipt);
    }
  });
}

export async function assertLegacyAliasNormalization(fixture: AdapterConformanceFixture): Promise<void> {
  const aliases = fixture.manifest.legacyAliases;
  if (!aliases?.operation && !aliases?.implicitTarget) return;
  await withEnvironment(fixture, 'legacy-alias-normalization', async ({ port }) => {
    const { manifest } = fixture;
    const requests: AdapterExecutionRequest[] = [];
    if (aliases.operation) {
      requests.push({
        protocolVersion: manifest.supportedProtocolVersion,
        operation: manifest.capabilities.echo,
        input: { value: 'legacy-operation-alias' },
      });
    }
    if (aliases.implicitTarget) {
      requests.push({
        protocolVersion: manifest.supportedProtocolVersion,
        target: manifest.capabilities.echo,
        input: { value: 'legacy-implicit-target' },
      });
    }
    for (const request of requests) {
      const response = executionResponse(await port.execute(request, manifest.primaryContext), 'legacy-alias-normalization');
      check('legacy-alias-normalization', response.status === 'success', 'Advertised legacy alias was not normalized.', response);
      check(
        'legacy-alias-normalization',
        sameJson(executionOutput(response, 'legacy-alias-normalization'), request.input),
        'Legacy alias normalization changed the operation input or output.',
        response,
      );
    }
  });
}

export const ADAPTER_CONFORMANCE_ASSERTIONS: Readonly<
  Record<AdapterConformanceCaseName, ConformanceAssertion>
> = {
  'protocol-negotiation': assertProtocolNegotiation,
  'exact-lookup': assertExactLookup,
  'operation-execution': assertOperationExecution,
  denial: assertDenial,
  approval: assertApproval,
  cancellation: assertCancellation,
  'lifecycle-idempotency': assertLifecycleIdempotency,
  'scope-isolation': assertScopeIsolation,
  'resource-fallback': assertResourceFallback,
  'unsupported-native-effects': assertUnsupportedNativeEffects,
  receipts: assertReceipts,
  'legacy-alias-normalization': assertLegacyAliasNormalization,
};

export async function runAdapterConformanceSuite(
  fixture: AdapterConformanceFixture,
): Promise<AdapterConformanceReport> {
  const cases: AdapterConformanceCaseResult[] = [];
  for (const name of ADAPTER_CONFORMANCE_CASES) {
    if (name === 'legacy-alias-normalization' && !hasLegacyAliases(fixture)) {
      cases.push({ name, status: 'skipped', durationMs: 0 });
      continue;
    }
    const started = Date.now();
    try {
      await ADAPTER_CONFORMANCE_ASSERTIONS[name](fixture);
      cases.push({ name, status: 'passed', durationMs: Date.now() - started });
    } catch (error) {
      cases.push({
        name,
        status: 'failed',
        durationMs: Date.now() - started,
        error: {
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof AdapterConformanceError ? error.details : undefined,
        },
      });
    }
  }
  const passed = cases.filter(({ status }) => status === 'passed').length;
  const failed = cases.filter(({ status }) => status === 'failed').length;
  const skipped = cases.filter(({ status }) => status === 'skipped').length;
  return { adapterName: fixture.name, ok: failed === 0, passed, failed, skipped, cases };
}

export async function assertAdapterConformance(
  fixture: AdapterConformanceFixture,
): Promise<AdapterConformanceReport> {
  const report = await runAdapterConformanceSuite(fixture);
  if (!report.ok) {
    const failures = report.cases
      .filter(({ status }) => status === 'failed')
      .map(({ name, error }) => `${name}: ${error?.message ?? 'failed'}`)
      .join('; ');
    throw new AdapterConformanceError('suite', `Adapter ${fixture.name} failed conformance: ${failures}`, report);
  }
  return report;
}

async function withEnvironment(
  fixture: AdapterConformanceFixture,
  caseName: AdapterConformanceCaseName,
  assertion: (environment: AdapterConformanceEnvironment) => Promise<void>,
): Promise<void> {
  const environment = await fixture.create(caseName);
  try {
    await assertion(environment);
  } finally {
    await environment.dispose?.();
  }
}

function operationRequest(
  fixture: AdapterConformanceFixture,
  target: string,
  input: unknown,
): AdapterExecutionRequest {
  return {
    protocolVersion: fixture.manifest.supportedProtocolVersion,
    targetType: 'operation',
    target,
    input,
  };
}

function executionResponse(value: unknown, caseName: AdapterConformanceCaseName): JsonRecord {
  const response = asRecord(value, caseName, 'Execution response');
  check(caseName, typeof response.status === 'string', 'Execution response status is required.', response);
  return response;
}

function executionOutput(response: JsonRecord, caseName: AdapterConformanceCaseName): unknown {
  return asRecord(response.result, caseName, 'Execution result').output;
}

function transportOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ('result' in value && isRecord(value.result) && 'output' in value.result) return value.result.output;
  if ('output' in value) return value.output;
  if ('structuredContent' in value) return value.structuredContent;
  return value;
}

function receiptStatus(response: JsonRecord): unknown {
  return isRecord(response.receipt) ? response.receipt.status : undefined;
}

function errorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.code === 'string') return value.code;
  if (isRecord(value.error) && typeof value.error.code === 'string') return value.error.code;
  return undefined;
}

function asRecord(
  value: unknown,
  caseName: AdapterConformanceCaseName,
  label: string,
): JsonRecord {
  check(caseName, isRecord(value), `${label} must be an object.`, value);
  return value as JsonRecord;
}

function asArray(
  value: unknown,
  caseName: AdapterConformanceCaseName,
  label: string,
): readonly unknown[] {
  check(caseName, Array.isArray(value), `${label} must be an array.`, value);
  return value as readonly unknown[];
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function count(values: Readonly<Record<string, number>>, key: string): number {
  return values[key] ?? 0;
}

function hasLegacyAliases(fixture: AdapterConformanceFixture): boolean {
  return Boolean(
    fixture.manifest.legacyAliases?.operation ||
    fixture.manifest.legacyAliases?.implicitTarget,
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function check(
  caseName: AdapterConformanceCaseName,
  condition: unknown,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new AdapterConformanceError(caseName, message, details);
}
