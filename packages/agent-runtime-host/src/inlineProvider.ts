import { randomUUID } from 'node:crypto';
import type {
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  InvocationContext,
  PermissionApprovalDecision,
  ProvenanceRecord,
  RuntimeExecResponse,
  RuntimeExecuteRequest,
  RuntimeExecutionReceipt,
  RuntimeKernel,
  RuntimeModuleSourceReference,
  RuntimeSearchRequest,
  RuntimeSearchResponse,
} from '@marshal/agent-runtime-core';
import {
  INLINE_MODULE_EXECUTOR_CAPABILITY,
  MODULE_EXECUTOR_CAPABILITY,
  requireRuntimeCatalogId,
  RUNTIME_PROTOCOL_VERSION,
} from '@marshal/agent-runtime-core';
export {
  INLINE_MODULE_EXECUTOR_CAPABILITY,
  MODULE_EXECUTOR_CAPABILITY,
} from '@marshal/agent-runtime-core';
import {
  createTypeScriptExecutor,
  appServicePublicName,
  createAppServicesDeclarationText,
  resolveTypeScriptModuleSource,
  type ArtifactSourceReadResult,
  type JsonValue,
  type RuntimeCapabilityBroker,
  type RuntimeBrokerCallContext,
  type TypeScriptExecutionDiagnostic,
  type TypeScriptModuleSourceReference,
  type TypeScriptSourceProvenance,
} from '@marshal/agent-runtime-typescript';
import type { RuntimeHostImportPolicy } from './types.js';
import type {
  RuntimeCompositionRegistry,
  RuntimeServiceContainer,
} from '@marshal/agent-runtime-composer';

const PROVIDER_ID = 'marshal.inline-module';
export const TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY = 'runtime.inline_module.execute.trusted';
export const TRUSTED_MODULE_EXECUTOR_CAPABILITY = 'runtime.module.execute.trusted';
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_BROKER_SEARCH_RESULTS = 50;
const DEFAULT_MAX_BROKER_INVOCATIONS = 64;
const DEFAULT_MAX_CONCURRENT_BROKER_INVOCATIONS = 8;

export interface InlineModuleProviderOptions {
  readonly runtime?: InlineModuleRuntimeBroker;
  /** @deprecated Pass runtime; retained for direct embedded-kernel callers. */
  readonly kernel?: RuntimeKernel;
  readonly workspacePath: string;
  readonly nodeExecutable?: string;
  readonly importPolicy?: RuntimeHostImportPolicy;
  readonly maxOutputBytes?: number;
  /** Legacy name retained for host compatibility; interpreted as a UTF-8 byte limit. */
  readonly maxSourceCharacters?: number;
  readonly maxSourceBytes?: number;
  /** Maximum nested capability invocations made by one module execution. */
  readonly maxBrokerInvocations?: number;
  /** Maximum nested capability invocations that may be in flight at once. */
  readonly maxConcurrentBrokerInvocations?: number;
  readonly compositionRegistry?: RuntimeCompositionRegistry;
  readonly serviceContainer?: RuntimeServiceContainer;
}

export interface InlineModuleRuntimeBroker {
  search(
    request: RuntimeSearchRequest,
    context: InvocationContext,
  ): Promise<RuntimeSearchResponse>;
  execute(
    request: RuntimeExecuteRequest,
    context: InvocationContext,
  ): Promise<RuntimeExecResponse>;
}

const BROKERED_INLINE_DESCRIPTOR: CapabilityDescriptor = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  name: INLINE_MODULE_EXECUTOR_CAPABILITY,
  version: '1.2.0',
  title: 'Execute a brokered inline TypeScript module',
  description:
    'Compile and execute inline TypeScript in a child process with recursive runtime.search and runtime.invoke access.',
  tags: ['runtime', 'typescript', 'execution', 'brokered', 'inline'],
  permissions: [
    {
      permission: 'runtime.inline_module.execute',
      reason: 'Executes agent-authored inline source under host-owned limits.',
      risk: 'medium',
    },
  ],
  inputSchema: inlineInputSchema(),
  outputSchema: executionOutputSchema(DEFAULT_MAX_OUTPUT_BYTES),
};

const TRUSTED_INLINE_DESCRIPTOR: CapabilityDescriptor = {
  ...BROKERED_INLINE_DESCRIPTOR,
  name: TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY,
  title: 'Execute a trusted inline TypeScript module',
  description:
    'Compile and execute trusted inline TypeScript with only host-configured package and builtin imports.',
  tags: ['runtime', 'typescript', 'execution', 'trusted', 'inline'],
  permissions: [
    {
      permission: 'runtime.inline_module.execute.trusted',
      reason: 'Trusted source can access host-approved packages and Node builtins.',
      risk: 'high',
    },
  ],
};

const BROKERED_MODULE_DESCRIPTOR: CapabilityDescriptor = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  name: MODULE_EXECUTOR_CAPABILITY,
  version: '1.1.0',
  title: 'Execute an editable TypeScript module',
  description:
    'Resolve and execute inline, contained workspace-file, or runtime-artifact TypeScript source with source receipts.',
  tags: ['runtime', 'typescript', 'execution', 'brokered', 'file', 'artifact', 'editable'],
  permissions: [
    {
      permission: 'runtime.module.execute',
      reason: 'Reads and executes an explicitly referenced module under host-owned limits.',
      risk: 'medium',
    },
  ],
  inputSchema: moduleInputSchema(),
  outputSchema: executionOutputSchema(DEFAULT_MAX_OUTPUT_BYTES),
};

const TRUSTED_MODULE_DESCRIPTOR: CapabilityDescriptor = {
  ...BROKERED_MODULE_DESCRIPTOR,
  name: TRUSTED_MODULE_EXECUTOR_CAPABILITY,
  title: 'Execute a trusted editable TypeScript module',
  description:
    'Resolve and execute trusted inline, workspace-file, or artifact TypeScript with host-approved imports.',
  tags: ['runtime', 'typescript', 'execution', 'trusted', 'file', 'artifact', 'editable'],
  permissions: [
    {
      permission: 'runtime.module.execute.trusted',
      reason: 'Trusted module source can access host-approved packages and Node builtins.',
      risk: 'high',
    },
  ],
};

const BASE_DESCRIPTORS = [
  BROKERED_INLINE_DESCRIPTOR,
  TRUSTED_INLINE_DESCRIPTOR,
  BROKERED_MODULE_DESCRIPTOR,
  TRUSTED_MODULE_DESCRIPTOR,
] as const;

/**
 * Portable TypeScript capability provider. Its historical export name remains
 * supported, but it now owns inline, workspace-file, and artifact modules.
 */
export function createBrokeredInlineModuleProvider(
  options: InlineModuleProviderOptions,
): CapabilityProvider & { dispose(): Promise<void> } {
  const runtime = options.runtime ?? options.kernel;
  if (!runtime) throw new Error('TypeScript module provider requires a runtime broker.');
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const maxSourceBytes = positiveInteger(
    options.maxSourceBytes ?? options.maxSourceCharacters,
    DEFAULT_MAX_SOURCE_BYTES,
  );
  const maxBrokerInvocations = positiveInteger(
    options.maxBrokerInvocations,
    DEFAULT_MAX_BROKER_INVOCATIONS,
  );
  const maxConcurrentBrokerInvocations = Math.min(
    maxBrokerInvocations,
    positiveInteger(
      options.maxConcurrentBrokerInvocations,
      DEFAULT_MAX_CONCURRENT_BROKER_INVOCATIONS,
    ),
  );
  const executor = createTypeScriptExecutor({
    mode: 'brokered',
    maxOutputBytes,
    workingDirectory: options.workspacePath,
    nodeExecutable: options.nodeExecutable,
    allowedPackages: [...(options.importPolicy?.allowedPackages ?? [])],
    allowedBuiltins: [...(options.importPolicy?.allowedBuiltins ?? [])],
  });
  const descriptors = BASE_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    inputSchema: isInlineExecutorCapability(descriptor.name)
      ? inlineInputSchema()
      : moduleInputSchema(),
    outputSchema: executionOutputSchema(maxOutputBytes),
  }));

  return {
    id: PROVIDER_ID,
    version: '1.2.0',
    list: () => descriptors,
    get: (name) => descriptors.find((descriptor) => descriptor.name === name),
    async invoke(name, rawInput, context): Promise<CapabilityInvocationResult> {
      if (!isExecutorCapability(name)) throw new Error(`Unknown module capability: ${name}`);
      const input = asRecord(rawInput);
      const reference = moduleReference(input);
      const resolved = await resolveTypeScriptModuleSource(reference, {
        workspaceRoot: options.workspacePath,
        maxSourceBytes,
        readArtifact: (artifact) => readArtifactSource(runtime, artifact, context),
      });
      const brokerJournal = createRecursiveBroker(runtime, context, {
        maxInvocations: maxBrokerInvocations,
        maxConcurrency: maxConcurrentBrokerInvocations,
      });
      const appServices = options.compositionRegistry && options.serviceContainer
        ? createAppServicesBroker(options.compositionRegistry, options.serviceContainer, context)
        : undefined;
      const signal = isAbortSignal(context.signal) ? context.signal : undefined;
      const mode = isTrustedCapability(name) ? 'trusted' : 'brokered';
      const execution = await executor.execute(
        {
          source: resolved.source,
          sourceIdentity: resolved.identity,
          input: toJsonValue(input.input ?? null),
          filename: resolved.filename,
          entrypoint: resolved.entrypoint,
          mode,
          maxOutputBytes,
          workingDirectory: options.workspacePath,
        },
        { broker: appServices ? { ...brokerJournal.broker, appServices } : brokerJournal.broker, signal },
      );
      const approval = brokerJournal.approval();
      if (approval) throw approvalRequiredError(approval);
      const broker = brokerJournal.summary();
      const provenance = sourceProvenance(execution.source);
      return {
        output: execution,
        provenance,
        diagnostics: execution.diagnostics.map(toCoreDiagnostic),
        metadata: {
          executionId: execution.executionId,
          mode: execution.mode,
          durationMs: execution.durationMs,
          source: execution.source,
          environment: execution.environment,
          broker,
        },
        receipt: {
          id: randomUUID(),
          providerId: PROVIDER_ID,
          capability: name,
          source: execution.source,
          environment: execution.environment,
          maxOutputBytes,
          executionId: execution.executionId,
          broker,
          completedAt: new Date().toISOString(),
        },
      };
    },
    dispose: () => executor.dispose(),
  };
}

export const createTypeScriptModuleProvider = createBrokeredInlineModuleProvider;

function createAppServicesBroker(
  registry: RuntimeCompositionRegistry,
  serviceContainer: RuntimeServiceContainer,
  parentContext: InvocationContext,
): NonNullable<RuntimeCapabilityBroker['appServices']> {
  const snapshot = () => {
    const activeServices = registry.list()
      .filter(({ selectedProviderId }) => selectedProviderId !== undefined);
    const selected = activeServices.map(({ service }) => ({
        name: appServicePublicName(
          {
            name: service.contract.name,
            token: service.key,
            ...(service.publicName === undefined ? {} : { publicName: service.publicName }),
          },
          activeServices.map(({ service: candidate }) => ({
            name: candidate.contract.name,
            token: candidate.key,
            ...(candidate.publicName === undefined ? {} : { publicName: candidate.publicName }),
          })),
        ),
        token: service.key,
        ...(service.publicName === undefined ? {} : { publicName: service.publicName }),
        ...(service.contract.declaration === undefined ? {} : { declaration: service.contract.declaration }),
        methods: service.contract.methods.map((method) => ({
          name: method.name,
          ...(method.input === undefined ? {} : { input: method.input }),
          ...(method.output === undefined ? {} : { output: method.output }),
          ...(method.description === undefined ? {} : { description: method.description }),
          ...(method.links === undefined ? {} : { links: method.links }),
          ...(method.examples === undefined ? {} : { examples: method.examples }),
        })),
      }));
    return { services: selected };
  };
  const currentSnapshot = () => {
    const value = snapshot();
    return { ...value, declarations: createAppServicesDeclarationText(value) };
  };
  return {
    get: () => null,
    get snapshot() {
      return currentSnapshot();
    },
    async invoke(token, input) {
      const current = registry.list().find(({ service }) => service.key === token);
      if (!current?.selectedProviderId) {
        throw new Error(`Application service "${token}" is not active.`);
      }
      const request = asRecord(input);
      const method = typeof request.method === 'string' ? request.method : '';
      const args = Array.isArray(request.args) ? request.args : [];
      if (!current.service.contract.methods.some((declared) => declared.name === method)) {
        throw new Error(`Application service method "${method}" is not declared.`);
      }
      const service = serviceContainer.get(current.service.token);
      const member = (service as { readonly [key: string]: unknown })[method];
      if (typeof member !== 'function') {
        throw new Error(`Application service method "${method}" is unavailable.`);
      }
      return toJsonValue(await (member as (...values: unknown[]) => unknown).apply(service, [...args, parentContext]));
    },
  };
}

async function readArtifactSource(
  runtime: InlineModuleRuntimeBroker,
  reference: Extract<TypeScriptModuleSourceReference, { kind: 'artifact' }>,
  parentContext: InvocationContext,
): Promise<ArtifactSourceReadResult> {
  const requestId = randomUUID();
  const response = await runtime.execute(
    {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      targetType: 'operation',
      target: 'artifacts.read',
      input: {
        path: reference.path,
        scope: reference.scope,
        encoding: 'utf8',
      },
      requestId,
      approval: parentContext.approval,
    },
    {
      ...parentContext,
      metadata: {
        ...(parentContext.metadata ?? {}),
        moduleSourceRead: true,
        moduleSourceRequestId: requestId,
      },
    },
  );
  if (response.status !== 'success' || !response.result) {
    throw nestedExecutionError(
      response,
      'ARTIFACT_SOURCE_READ_FAILED',
      `Artifact source read ended with ${response.status}.`,
    );
  }
  const output = asRecord(response.result.output);
  if (typeof output.content !== 'string' || output.encoding !== 'utf8') {
    throw codedError(
      'INVALID_ARTIFACT_SOURCE',
      'artifacts.read did not return UTF-8 text content.',
    );
  }
  return {
    content: output.content,
    uri: response.result.provenance?.[0]?.uri,
    provenance: response.result.provenance?.map((record) => ({ ...record })),
  };
}

function moduleReference(input: Record<string, unknown>): TypeScriptModuleSourceReference {
  if (typeof input.source === 'string') {
    return {
      kind: 'inline',
      source: requireString(input.source, 'source'),
      filename: optionalString(input.filename),
      export: optionalString(input.export),
    };
  }
  const value = asRecord(input.module);
  const kind = value.kind;
  if (kind === 'inline') {
    return {
      kind,
      source: requireString(value.source, 'module.source'),
      filename: optionalString(value.filename),
      export: optionalString(value.export),
    };
  }
  if (kind === 'workspace_file') {
    return {
      kind,
      path: requireString(value.path, 'module.path'),
      export: optionalString(value.export),
    };
  }
  if (kind === 'artifact') {
    const scope = value.scope;
    if (
      scope !== undefined &&
      scope !== 'workspace' &&
      scope !== 'project' &&
      scope !== 'session'
    ) {
      throw new TypeError('module.scope must be workspace, project, or session.');
    }
    return {
      kind,
      path: requireString(value.path, 'module.path'),
      scope,
      export: optionalString(value.export),
    };
  }
  throw new TypeError('Provide source or a module with kind inline, workspace_file, or artifact.');
}

function sourceProvenance(source: {
  kind: string;
  identifier: string;
  uri?: string;
  contentDigest: string;
  sizeBytes: number;
  provenance?: readonly TypeScriptSourceProvenance[];
}): readonly ProvenanceRecord[] {
  const inherited: ProvenanceRecord[] = (source.provenance ?? []).map((record) => ({ ...record }));
  return [
    {
      source: `marshal.module-source.${source.kind}`,
      uri: source.uri,
      contentDigest: source.contentDigest,
      trust: 'authoritative',
      metadata: { identifier: source.identifier, sizeBytes: source.sizeBytes },
    },
    ...inherited,
  ];
}

interface BrokerLimits {
  readonly maxInvocations: number;
  readonly maxConcurrency: number;
}

interface BrokerChildReceipt {
  readonly sequence: number;
  readonly parentExecutionId: string;
  readonly requestId: string;
  readonly target: string;
  readonly receiptId: string;
  readonly executionId: string;
  readonly status: RuntimeExecutionReceipt['status'];
  readonly provider?: RuntimeExecutionReceipt['provider'];
  readonly capabilityVersion?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

interface RecursiveBrokerJournal {
  readonly broker: RuntimeCapabilityBroker;
  approval(): PermissionApprovalDecision | undefined;
  summary(): {
    readonly maxInvocations: number;
    readonly maxConcurrency: number;
    readonly invocationCount: number;
    readonly peakConcurrency: number;
    readonly children: readonly BrokerChildReceipt[];
  };
}

interface BrokerWaiter {
  readonly resume: () => void;
  readonly onAbort: () => void;
}

function createRecursiveBroker(
  runtime: InlineModuleRuntimeBroker,
  parentContext: InvocationContext,
  limits: BrokerLimits,
): RecursiveBrokerJournal {
  const parentExecutionId = parentContext.executionId ?? 'module-execution';
  const children: BrokerChildReceipt[] = [];
  const approvals: Array<{ sequence: number; decision: PermissionApprovalDecision }> = [];
  const waiting: BrokerWaiter[] = [];
  let invocationCount = 0;
  let activeInvocations = 0;
  let peakConcurrency = 0;

  const brokerContext = (
    call: RuntimeBrokerCallContext,
  ): InvocationContext => ({
    ...parentContext,
    signal: call.signal,
    metadata: {
      ...(parentContext.metadata ?? {}),
      brokerRequestId: call.requestId,
    },
  });
  const enter = (): void => {
    activeInvocations += 1;
    peakConcurrency = Math.max(peakConcurrency, activeInvocations);
  };
  const acquire = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw codedError('BROKER_CALL_ABORTED', 'Capability call was aborted.');
    if (activeInvocations < limits.maxConcurrency) {
      enter();
      return;
    }
    await new Promise<void>((resolvePromise, reject) => {
      const waiter: BrokerWaiter = {
        onAbort: () => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(codedError('BROKER_CALL_ABORTED', 'Capability call was aborted while queued.'));
        },
        resume: () => {
          signal.removeEventListener('abort', waiter.onAbort);
          enter();
          resolvePromise();
        },
      };
      waiting.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  };
  const release = (): void => {
    activeInvocations -= 1;
    const waiter = waiting.shift();
    if (waiter) waiter.resume();
  };
  const broker: RuntimeCapabilityBroker = {
    async search(query, call) {
      const request = parseBrokerSearch(query);
      const response = await runtime.search(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          query: request.query,
          name: request.name,
          catalogId: request.catalogId,
          detail: request.detail,
          tags: request.tags,
          limit: request.limit,
        },
        brokerContext(call),
      );
      return toJsonValue(response);
    },
    async invoke(capability, input, call) {
      if (isExecutorCapability(capability)) {
        throw codedError('RECURSIVE_MODULE_DENIED', 'Modules cannot invoke module executors.');
      }
      if (invocationCount >= limits.maxInvocations) {
        throw codedError(
          'BROKER_INVOCATION_LIMIT_EXCEEDED',
          `Module exceeded its limit of ${limits.maxInvocations} nested capability invocations.`,
        );
      }
      invocationCount += 1;
      const sequence = invocationCount;
      const requestId = `${call.executionId}:${call.requestId}`;
      await acquire(call.signal);
      try {
        const response = await runtime.execute(
          {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            targetType: 'operation',
            target: capability,
            input,
            requestId,
            approval: parentContext.approval,
          },
          brokerContext(call),
        );
        children.push(childReceipt(sequence, parentExecutionId, response.receipt));
        if (response.status === 'approval_required' && response.approval) {
          approvals.push({ sequence, decision: response.approval });
        }
        return unwrapExecution(response);
      } finally {
        release();
      }
    },
  };
  return {
    broker,
    approval: () =>
      [...approvals].sort((left, right) => left.sequence - right.sequence)[0]?.decision,
    summary: () => ({
      maxInvocations: limits.maxInvocations,
      maxConcurrency: limits.maxConcurrency,
      invocationCount,
      peakConcurrency,
      children: [...children].sort((left, right) => left.sequence - right.sequence),
    }),
  };
}

function childReceipt(
  sequence: number,
  parentExecutionId: string,
  receipt: RuntimeExecutionReceipt,
): BrokerChildReceipt {
  return {
    sequence,
    parentExecutionId,
    requestId: receipt.requestId ?? receipt.executionId,
    target: receipt.target,
    receiptId: receipt.receiptId,
    executionId: receipt.executionId,
    status: receipt.status,
    provider: receipt.provider,
    capabilityVersion: receipt.capabilityVersion,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    durationMs: receipt.durationMs,
  };
}

function parseBrokerSearch(value: JsonValue): {
  query: string;
  name?: string;
  catalogId?: string;
  detail?: 'summary' | 'full';
  tags?: string[];
  limit: number;
} {
  if (typeof value === 'string') return { query: value.slice(0, 4_000), limit: 20 };
  const record = asRecord(value);
  const rawQuery = typeof record.query === 'string' ? record.query : '';
  const rawName = typeof record.name === 'string' ? record.name.trim() : '';
  const catalogId = record.catalogId === undefined
    ? undefined
    : requireRuntimeCatalogId(record.catalogId, 'Brokered runtime catalog id');
  const detail = record.detail === 'summary' || record.detail === 'full'
    ? record.detail
    : undefined;
  const tags = Array.isArray(record.tags)
    ? record.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .slice(0, 20)
        .map((tag) => tag.slice(0, 128))
    : undefined;
  const rawLimit = numericInteger(record.limit, 20);
  return {
    query: rawQuery.slice(0, 4_000),
    ...(rawName ? { name: rawName.slice(0, 1_024) } : {}),
    ...(catalogId ? { catalogId } : {}),
    ...(detail ? { detail } : {}),
    tags,
    limit: Math.min(MAX_BROKER_SEARCH_RESULTS, Math.max(1, rawLimit)),
  };
}

function unwrapExecution(response: RuntimeExecResponse): JsonValue {
  if (response.status === 'success' && response.result) return toJsonValue(response.result.output);
  throw nestedExecutionError(
    response,
    response.status.toLocaleUpperCase(),
    `Capability invocation ended with ${response.status}.`,
  );
}

function nestedExecutionError(
  response: RuntimeExecResponse,
  fallbackCode: string,
  fallbackMessage: string,
): Error & { code: string; approval?: PermissionApprovalDecision } {
  const error = codedError(
    response.error?.code ?? fallbackCode,
    response.error?.message ?? fallbackMessage,
  );
  return response.status === 'approval_required' && response.approval
    ? Object.assign(error, { approval: response.approval })
    : error;
}

function approvalRequiredError(
  approval: PermissionApprovalDecision,
): Error & { code: string; approval: PermissionApprovalDecision } {
  return Object.assign(codedError('APPROVAL_REQUIRED', approval.reason), { approval });
}

function toCoreDiagnostic(diagnostic: TypeScriptExecutionDiagnostic) {
  return {
    level: diagnostic.level,
    code: diagnostic.code,
    message: diagnostic.message,
    path: diagnostic.location?.file,
    details: {
      stage: diagnostic.stage,
      line: diagnostic.location?.line,
      column: diagnostic.location?.column,
    },
  } as const;
}

function executionOutputSchema(maxOutputBytes: number): Readonly<Record<string, unknown>> {
  const provenance = {
    type: 'object',
    properties: {
      source: { type: 'string', maxLength: 1_024 }, uri: { type: 'string', maxLength: 8_192 },
      retrievedAt: { type: 'string', maxLength: 64 }, contentDigest: { type: 'string', maxLength: 128 },
      trust: { enum: ['unverified', 'low', 'medium', 'high', 'authoritative'] },
      metadata: { type: 'object', maxProperties: 256 },
    },
    required: ['source'],
    additionalProperties: false,
  } as const;
  const sourceReceipt = {
    type: 'object',
    properties: {
      kind: { enum: ['inline', 'workspace_file', 'artifact'] },
      identifier: { type: 'string', maxLength: 4_096 },
      uri: { type: 'string', maxLength: 8_192 },
      provenance: { type: 'array', maxItems: 10_000, items: provenance },
      contentDigest: { type: 'string', maxLength: 128 },
      sizeBytes: { type: 'integer', minimum: 0 },
    },
    required: ['kind', 'identifier', 'contentDigest', 'sizeBytes'],
    additionalProperties: false,
  } as const;
  const diagnostic = {
    type: 'object',
    properties: {
      level: { enum: ['info', 'warning', 'error'] }, code: { type: 'string', maxLength: 128 },
      message: { type: 'string', maxLength: 8_192 }, stage: { enum: ['validation', 'compile', 'execute', 'broker'] },
      location: {
        type: 'object', properties: {
          file: { type: 'string', maxLength: 4_096 }, line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1 },
        }, additionalProperties: false,
      },
    },
    required: ['level', 'code', 'message', 'stage'],
    additionalProperties: false,
  } as const;
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      status: { enum: ['succeeded', 'compile_failed', 'runtime_failed', 'aborted', 'output_limit_exceeded'] },
      executionId: { type: 'string', maxLength: 256 }, value: {},
      error: {
        type: 'object', properties: {
          code: { type: 'string', maxLength: 128 }, message: { type: 'string', maxLength: 8_192 },
          stage: { enum: ['validation', 'compile', 'execute', 'broker'] }, stack: { type: 'string', maxLength: 64_000 },
        }, required: ['code', 'message', 'stage'], additionalProperties: false,
      },
      diagnostics: { type: 'array', maxItems: 1_000, items: diagnostic },
      stdout: { type: 'string', maxLength: maxOutputBytes }, stderr: { type: 'string', maxLength: maxOutputBytes },
      durationMs: { type: 'number', minimum: 0 }, compileDurationMs: { type: 'number', minimum: 0 },
      executionDurationMs: { type: 'number', minimum: 0 }, outputBytes: { type: 'integer', minimum: 0 },
      mode: { enum: ['brokered', 'trusted'] }, source: sourceReceipt,
      environment: {
        type: 'object', properties: {
          nodeVersion: { type: 'string', maxLength: 128 }, platform: { type: 'string', maxLength: 64 }, architecture: { type: 'string', maxLength: 64 },
          importedPackages: { type: 'array', maxItems: 1_000, items: { type: 'object', properties: { name: { type: 'string', maxLength: 512 }, version: { type: 'string', maxLength: 128 } }, required: ['name'], additionalProperties: false } },
          importedBuiltins: { type: 'array', maxItems: 1_000, items: { type: 'string', maxLength: 512 } },
          sourceFiles: { type: 'array', maxItems: 10_000, items: sourceReceipt },
          moduleDigest: { type: 'string', maxLength: 128 }, fingerprint: { type: 'string', maxLength: 128 },
        }, required: ['nodeVersion', 'platform', 'architecture', 'importedPackages', 'importedBuiltins', 'sourceFiles', 'moduleDigest', 'fingerprint'], additionalProperties: false,
      },
      compilation: {
        type: 'object', properties: {
          cacheKey: { type: 'string', maxLength: 256 }, cacheStatus: { enum: ['hit', 'miss', 'disabled'] }, dependencyGraphValidated: { type: 'boolean' },
        }, required: ['cacheKey', 'cacheStatus', 'dependencyGraphValidated'], additionalProperties: false,
      },
    },
    required: ['ok', 'status', 'executionId', 'diagnostics', 'stdout', 'stderr', 'durationMs', 'compileDurationMs', 'executionDurationMs', 'outputBytes', 'mode', 'source'],
    additionalProperties: false,
  };
}

function inlineInputSchema() {
  return {
    type: 'object',
    required: ['source'],
    properties: {
      source: { type: 'string' },
      filename: { type: 'string' },
      export: { type: 'string' },
      input: {},
    },
    additionalProperties: true,
  } as const;
}

function moduleInputSchema() {
  return {
    type: 'object',
    required: ['module'],
    properties: {
      module: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'source'],
            properties: { kind: { const: 'inline' }, source: { type: 'string' } },
          },
          {
            type: 'object',
            required: ['kind', 'path'],
            properties: { kind: { const: 'workspace_file' }, path: { type: 'string' } },
          },
          {
            type: 'object',
            required: ['kind', 'path'],
            properties: {
              kind: { const: 'artifact' },
              path: { type: 'string' },
              scope: { enum: ['workspace', 'project', 'session'] },
            },
          },
        ],
      },
      input: {},
    },
    additionalProperties: true,
  } as const;
}

function isExecutorCapability(value: string): boolean {
  return (
    value === INLINE_MODULE_EXECUTOR_CAPABILITY ||
    value === TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY ||
    value === MODULE_EXECUTOR_CAPABILITY ||
    value === TRUSTED_MODULE_EXECUTOR_CAPABILITY
  );
}

function isInlineExecutorCapability(value: string): boolean {
  return (
    value === INLINE_MODULE_EXECUTOR_CAPABILITY ||
    value === TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY
  );
}

function isTrustedCapability(value: string): boolean {
  return (
    value === TRUSTED_INLINE_MODULE_EXECUTOR_CAPABILITY ||
    value === TRUSTED_MODULE_EXECUTOR_CAPABILITY
  );
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw codedError('NOT_SERIALIZABLE', 'Value is not JSON-serializable.');
  return JSON.parse(serialized) as JsonValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, 'value');
}

function numericInteger(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value as number) : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof (value as AbortSignal).addEventListener === 'function'
  );
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
