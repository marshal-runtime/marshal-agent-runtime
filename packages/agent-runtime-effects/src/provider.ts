import {
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SCHEDULE_EFFECT_KINDS,
  type CapabilityDescriptor,
  type CapabilityInvocationResult,
  type CapabilityProvider,
  type RuntimeBackgroundJobStartRequest,
  type RuntimeEffectApprovalGrant,
  type RuntimeEffectRequest,
} from '@marshal/agent-runtime-core';
import type { EffectDispatcher } from './effects.js';
import type { BackgroundJobManager } from './jobs.js';
import { codedError } from './json.js';

export const RUNTIME_EFFECT_EXECUTE_CAPABILITY = 'runtime.effects.execute';
export const RUNTIME_JOB_START_CAPABILITY = 'runtime.jobs.start';
export const RUNTIME_JOB_STATUS_CAPABILITY = 'runtime.jobs.status';
export const RUNTIME_JOB_CANCEL_CAPABILITY = 'runtime.jobs.cancel';
export const RUNTIME_JOB_RESUME_CAPABILITY = 'runtime.jobs.resume';

const RESERVED_TYPED_EFFECT_KINDS = new Set<string>(
  Object.values(RUNTIME_SCHEDULE_EFFECT_KINDS),
);

export interface RuntimeEffectsProviderOptions {
  readonly effects: EffectDispatcher;
  readonly jobs: BackgroundJobManager;
  readonly providerId?: string;
}

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: RUNTIME_EFFECT_EXECUTE_CAPABILITY,
    version: '1.0.0',
    title: 'Execute a harness-native effect',
    description:
      'Request an idempotent adapter-owned native effect and receive success, unsupported, approval, failure, or cancellation with a receipt.',
    tags: ['runtime', 'effects', 'native', 'adapter', 'idempotent'],
    permissions: [
      {
        permission: 'runtime.effects.execute',
        reason: 'Requests a harness-native effect through the configured adapter callback.',
        risk: 'medium',
      },
    ],
    inputSchema: {
      type: 'object',
      required: ['kind', 'idempotencyKey'],
      properties: {
        kind: { type: 'string', minLength: 1 },
        input: {},
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 },
        effectId: { type: 'string' },
        approval: { type: 'object', required: ['approvalId'] },
        metadata: { type: 'object' },
      },
      additionalProperties: false,
    },
    outputSchema: effectResponseSchema(),
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: RUNTIME_JOB_START_CAPABILITY,
    version: '1.0.0',
    title: 'Start a durable background job',
    description: 'Start an adapter-independent durable job and return its idempotent handle.',
    tags: ['runtime', 'jobs', 'background', 'durable', 'start'],
    permissions: [{ permission: 'runtime.jobs.start', risk: 'medium' }],
    inputSchema: jobStartSchema(),
    outputSchema: jobResponseSchema(),
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: RUNTIME_JOB_STATUS_CAPABILITY,
    version: '1.0.0',
    title: 'Inspect a durable background job',
    description:
      'Read the scoped state, progress, checkpoint, result, or failure for a job handle.',
    tags: ['runtime', 'jobs', 'background', 'durable', 'status'],
    permissions: [{ permission: 'runtime.jobs.read', risk: 'low' }],
    inputSchema: jobHandleSchema(),
    outputSchema: jobResponseSchema(),
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: RUNTIME_JOB_CANCEL_CAPABILITY,
    version: '1.0.0',
    title: 'Cancel a durable background job',
    description: 'Request cancellation and signal the currently registered job callback.',
    tags: ['runtime', 'jobs', 'background', 'durable', 'cancel'],
    permissions: [{ permission: 'runtime.jobs.cancel', risk: 'medium' }],
    inputSchema: jobHandleSchema(),
    outputSchema: jobResponseSchema(),
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: RUNTIME_JOB_RESUME_CAPABILITY,
    version: '1.0.0',
    title: 'Resume a durable background job',
    description:
      'Resume a paused, failed, interrupted, or orphaned job by calling its currently registered resume callback with the durable checkpoint.',
    tags: ['runtime', 'jobs', 'background', 'durable', 'resume'],
    permissions: [{ permission: 'runtime.jobs.resume', risk: 'medium' }],
    inputSchema: jobHandleSchema(),
    outputSchema: jobResponseSchema(),
  },
];

/** Makes effects and jobs discoverable/invocable through any RuntimeKernel adapter. */
export function createRuntimeEffectsProvider(
  options: RuntimeEffectsProviderOptions,
): CapabilityProvider {
  const providerId = options.providerId ?? 'marshal.effects-jobs';
  return {
    id: providerId,
    version: '1.0.0',
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((descriptor) => descriptor.name === name),
    async invoke(name, rawInput, context): Promise<CapabilityInvocationResult> {
      const input = asRecord(rawInput);
      switch (name) {
        case RUNTIME_EFFECT_EXECUTE_CAPABILITY: {
          const response = await options.effects.execute(effectRequest(input), context);
          return {
            output: response,
            provenance: response.status === 'success' ? response.provenance : undefined,
            diagnostics:
              response.status === 'success' || response.status === 'failed'
                ? response.diagnostics
                : undefined,
            artifacts: response.status === 'success' ? response.artifacts : undefined,
            receipt: response.receipt,
          };
        }
        case RUNTIME_JOB_START_CAPABILITY: {
          const response = await options.jobs.start(jobStartRequest(input), context);
          return { output: response, receipt: response.receipt };
        }
        case RUNTIME_JOB_STATUS_CAPABILITY: {
          const response = await options.jobs.status(requireString(input.jobId, 'jobId'), context);
          return { output: response, receipt: response.receipt };
        }
        case RUNTIME_JOB_CANCEL_CAPABILITY: {
          const response = await options.jobs.cancel(requireString(input.jobId, 'jobId'), context);
          return { output: response, receipt: response.receipt };
        }
        case RUNTIME_JOB_RESUME_CAPABILITY: {
          const response = await options.jobs.resume(requireString(input.jobId, 'jobId'), context);
          return { output: response, receipt: response.receipt };
        }
        default:
          throw new Error(`Unsupported effects/jobs capability: ${name}`);
      }
    },
  };
}

function effectRequest(input: Record<string, unknown>): RuntimeEffectRequest {
  const kind = requireString(input.kind, 'kind');
  if (RESERVED_TYPED_EFFECT_KINDS.has(kind)) {
    throw codedError(
      'RESERVED_EFFECT_KIND',
      `Effect kind "${kind}" must be invoked through its runtime.schedules.* capability.`,
    );
  }
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind,
    input: input.input,
    idempotencyKey: requireString(input.idempotencyKey, 'idempotencyKey'),
    effectId: optionalString(input.effectId, 'effectId'),
    approval: approvalGrant(input.approval),
    metadata: optionalRecord(input.metadata, 'metadata'),
  };
}

function jobStartRequest(input: Record<string, unknown>): RuntimeBackgroundJobStartRequest {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: requireString(input.kind, 'kind'),
    input: input.input,
    idempotencyKey: requireString(input.idempotencyKey, 'idempotencyKey'),
    metadata: optionalRecord(input.metadata, 'metadata'),
  };
}

function approvalGrant(value: unknown): RuntimeEffectApprovalGrant | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  return {
    approvalId: requireString(record.approvalId, 'approval.approvalId'),
    grantedBy: optionalString(record.grantedBy, 'approval.grantedBy'),
    grantedAt: optionalString(record.grantedAt, 'approval.grantedAt'),
    token: optionalString(record.token, 'approval.token'),
    metadata: optionalRecord(record.metadata, 'approval.metadata'),
  };
}

function jobStartSchema() {
  return {
    type: 'object',
    required: ['kind', 'idempotencyKey'],
    properties: {
      kind: { type: 'string', minLength: 1 },
      input: {},
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 },
      metadata: { type: 'object' },
    },
    additionalProperties: false,
  } as const;
}

function jobHandleSchema() {
  return {
    type: 'object',
    required: ['jobId'],
    properties: { jobId: { type: 'string', minLength: 1, maxLength: 256 } },
    additionalProperties: false,
  } as const;
}

function effectResponseSchema() {
  return {
    type: 'object',
    required: ['protocolVersion', 'status', 'receipt'],
    properties: {
      protocolVersion: { const: RUNTIME_PROTOCOL_VERSION },
      status: { enum: ['success', 'unsupported', 'approval_required', 'failed', 'cancelled'] },
      output: {},
      provenance: { type: 'array' },
      diagnostics: { type: 'array' },
      artifacts: { type: 'array' },
      metadata: { type: 'object' },
      reason: { type: 'string' },
      supportedKinds: { type: 'array', items: { type: 'string' } },
      approval: { type: 'object' },
      error: { type: 'object' },
      receipt: { type: 'object' },
    },
    additionalProperties: false,
  } as const;
}

function jobResponseSchema() {
  return {
    type: 'object',
    required: ['protocolVersion', 'status', 'receipt'],
    properties: {
      protocolVersion: { const: RUNTIME_PROTOCOL_VERSION },
      status: {
        enum: ['accepted', 'success', 'not_found', 'conflict', 'unsupported', 'failed'],
      },
      handle: { type: 'object' },
      job: { type: 'object' },
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 },
      replayed: { type: 'boolean' },
      error: { type: 'object' },
      receipt: { type: 'object' },
    },
    additionalProperties: false,
  } as const;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function optionalRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}
