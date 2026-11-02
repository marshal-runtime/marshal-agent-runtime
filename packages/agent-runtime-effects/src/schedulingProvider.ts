import { randomUUID } from 'node:crypto';
import {
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SCHEDULE_EFFECT_KINDS,
  type CapabilityDescriptor,
  type CapabilityInvocationResult,
  type CapabilityProvider,
  type RuntimeEffectApprovalGrant,
  type RuntimeEffectRequest,
  type RuntimeScheduleOperation,
} from '@marshal/agent-runtime-core';
import type { EffectDispatcher } from './effects.js';

export const RUNTIME_SCHEDULE_CREATE_CAPABILITY = 'runtime.schedules.create';
export const RUNTIME_SCHEDULE_GET_CAPABILITY = 'runtime.schedules.get';
export const RUNTIME_SCHEDULE_LIST_CAPABILITY = 'runtime.schedules.list';
export const RUNTIME_SCHEDULE_UPDATE_CAPABILITY = 'runtime.schedules.update';
export const RUNTIME_SCHEDULE_PAUSE_CAPABILITY = 'runtime.schedules.pause';
export const RUNTIME_SCHEDULE_RESUME_CAPABILITY = 'runtime.schedules.resume';
export const RUNTIME_SCHEDULE_CANCEL_CAPABILITY = 'runtime.schedules.cancel';

const CAPABILITY_TO_OPERATION: Readonly<Record<string, RuntimeScheduleOperation>> = {
  [RUNTIME_SCHEDULE_CREATE_CAPABILITY]: 'create',
  [RUNTIME_SCHEDULE_GET_CAPABILITY]: 'get',
  [RUNTIME_SCHEDULE_LIST_CAPABILITY]: 'list',
  [RUNTIME_SCHEDULE_UPDATE_CAPABILITY]: 'update',
  [RUNTIME_SCHEDULE_PAUSE_CAPABILITY]: 'pause',
  [RUNTIME_SCHEDULE_RESUME_CAPABILITY]: 'resume',
  [RUNTIME_SCHEDULE_CANCEL_CAPABILITY]: 'cancel',
};

const READ_OPERATIONS = new Set<RuntimeScheduleOperation>(['get', 'list']);
const SCHEDULE_STATES = new Set(['active', 'paused', 'completed', 'cancelled', 'failed']);
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface RuntimeSchedulingProviderOptions {
  readonly effects: EffectDispatcher;
  readonly providerId?: string;
  readonly createId?: () => string;
}

/**
 * Projects harness-native scheduling into portable capabilities. Mutation
 * replay remains durable and idempotent; get/list bypass replay so state never
 * becomes stale. Adapters implement only the fixed runtime.schedule.* effects.
 */
export function createRuntimeSchedulingProvider(
  options: RuntimeSchedulingProviderOptions,
): CapabilityProvider {
  const createId = options.createId ?? randomUUID;
  return {
    id: options.providerId ?? 'marshal.scheduling',
    version: '1.0.0',
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((descriptor) => descriptor.name === name),
    async invoke(name, rawInput, context): Promise<CapabilityInvocationResult> {
      const operation = CAPABILITY_TO_OPERATION[name];
      if (!operation) throw new Error(`Unsupported scheduling capability: ${name}`);
      const input = asRecord(rawInput);
      validateOperationInput(operation, input);
      const readOnly = READ_OPERATIONS.has(operation);
      const response = await options.effects.execute(
        scheduleEffectRequest(operation, input, readOnly ? createId() : undefined),
        context,
        { replay: !readOnly },
      );
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
    },
  };
}

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor(
    RUNTIME_SCHEDULE_CREATE_CAPABILITY,
    'Create a harness-native schedule',
    'Create a scoped one-time, interval, or cron schedule for an adapter-owned task kind. The adapter clock remains authoritative.',
    'runtime.schedules.create',
    createSchema(),
    'medium',
  ),
  descriptor(
    RUNTIME_SCHEDULE_GET_CAPABILITY,
    'Inspect a schedule',
    'Read the current adapter-owned schedule state without replaying a cached result.',
    'runtime.schedules.read',
    scheduleIdSchema(false),
    'low',
  ),
  descriptor(
    RUNTIME_SCHEDULE_LIST_CAPABILITY,
    'List schedules',
    'List current schedules visible to the principal and runtime scope.',
    'runtime.schedules.read',
    listSchema(),
    'low',
  ),
  descriptor(
    RUNTIME_SCHEDULE_UPDATE_CAPABILITY,
    'Update a schedule',
    'Update the timing, task, or metadata of one scoped schedule idempotently.',
    'runtime.schedules.update',
    updateSchema(),
    'medium',
  ),
  descriptor(
    RUNTIME_SCHEDULE_PAUSE_CAPABILITY,
    'Pause a schedule',
    'Pause a scoped schedule idempotently when the host supports pausing.',
    'runtime.schedules.pause',
    scheduleIdSchema(true),
    'medium',
  ),
  descriptor(
    RUNTIME_SCHEDULE_RESUME_CAPABILITY,
    'Resume a schedule',
    'Resume a scoped schedule idempotently when the host supports resuming.',
    'runtime.schedules.resume',
    scheduleIdSchema(true),
    'medium',
  ),
  descriptor(
    RUNTIME_SCHEDULE_CANCEL_CAPABILITY,
    'Cancel a schedule',
    'Cancel a scoped schedule idempotently through the harness adapter.',
    'runtime.schedules.cancel',
    scheduleIdSchema(true),
    'medium',
  ),
];

function descriptor(
  name: string,
  title: string,
  description: string,
  permission: string,
  inputSchema: CapabilityDescriptor['inputSchema'],
  risk: 'low' | 'medium',
): CapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    title,
    description,
    tags: ['runtime', 'schedule', 'scheduling', 'automation', name.split('.').at(-1) ?? ''],
    permissions: [{ permission, risk }],
    inputSchema,
    outputSchema: scheduleResponseSchema(),
  };
}

function scheduleEffectRequest(
  operation: RuntimeScheduleOperation,
  input: Record<string, unknown>,
  readId?: string,
): RuntimeEffectRequest {
  const { idempotencyKey, effectId, approval, ...payload } = input;
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    kind: RUNTIME_SCHEDULE_EFFECT_KINDS[operation],
    input: payload,
    idempotencyKey:
      readId === undefined
        ? requireString(idempotencyKey, 'idempotencyKey')
        : `schedule-read:${operation}:${readId}`,
    effectId: optionalString(effectId, 'effectId'),
    approval: approvalGrant(approval),
  };
}

function validateOperationInput(
  operation: RuntimeScheduleOperation,
  input: Record<string, unknown>,
): void {
  const allowedFields: Readonly<Record<RuntimeScheduleOperation, readonly string[]>> = {
    create: ['timing', 'task', 'idempotencyKey', 'effectId', 'approval', 'metadata'],
    get: ['scheduleId'],
    list: ['state', 'limit', 'cursor'],
    update: [
      'scheduleId',
      'timing',
      'task',
      'idempotencyKey',
      'effectId',
      'approval',
      'metadata',
    ],
    pause: ['scheduleId', 'idempotencyKey', 'effectId', 'approval'],
    resume: ['scheduleId', 'idempotencyKey', 'effectId', 'approval'],
    cancel: ['scheduleId', 'idempotencyKey', 'effectId', 'approval'],
  };
  rejectUnknownKeys(input, allowedFields[operation], `${operation} input`);

  if (operation === 'create' || operation === 'update') {
    if (operation === 'update') {
      requireBoundedString(input.scheduleId, 'scheduleId', 256);
      if (input.timing === undefined && input.task === undefined && input.metadata === undefined) {
        throw new TypeError('update requires timing, task, or metadata.');
      }
    }
    if (operation === 'create' || input.timing !== undefined) validateTiming(input.timing);
    if (operation === 'create' || input.task !== undefined) validateTask(input.task);
  } else if (operation !== 'list') {
    requireBoundedString(input.scheduleId, 'scheduleId', 256);
  } else {
    if (input.state !== undefined) {
      const state = requireString(input.state, 'state');
      if (!SCHEDULE_STATES.has(state)) throw new TypeError('state is invalid.');
    }
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)
    ) {
      throw new TypeError('limit must be an integer from 1 to 100.');
    }
    if (input.cursor !== undefined) requireBoundedString(input.cursor, 'cursor', 512);
  }
  if (!READ_OPERATIONS.has(operation)) {
    requireBoundedString(input.idempotencyKey, 'idempotencyKey', 256);
    if (input.effectId !== undefined) requireBoundedString(input.effectId, 'effectId', 256);
    approvalGrant(input.approval);
  }
  if (input.metadata !== undefined) optionalRecord(input.metadata, 'metadata');
}

function validateTiming(value: unknown): void {
  const timing = asRecord(value);
  const kind = requireString(timing.kind, 'timing.kind');
  if (kind === 'once') {
    rejectUnknownKeys(timing, ['kind', 'at'], 'timing');
    requireIsoDate(timing.at, 'timing.at');
  } else if (kind === 'interval') {
    rejectUnknownKeys(timing, ['kind', 'everyMs', 'startsAt', 'endsAt'], 'timing');
    if (!Number.isSafeInteger(timing.everyMs) || Number(timing.everyMs) < 1_000) {
      throw new TypeError('timing.everyMs must be an integer of at least 1000.');
    }
  } else if (kind === 'cron') {
    rejectUnknownKeys(
      timing,
      ['kind', 'expression', 'timezone', 'startsAt', 'endsAt'],
      'timing',
    );
    requireBoundedString(timing.expression, 'timing.expression', 256);
    if (timing.timezone !== undefined) {
      requireBoundedString(timing.timezone, 'timing.timezone', 128);
    }
  } else throw new TypeError('timing.kind must be once, interval, or cron.');
  for (const field of ['startsAt', 'endsAt'] as const) {
    if (timing[field] !== undefined) requireIsoDate(timing[field], `timing.${field}`);
  }
  if (
    timing.startsAt !== undefined &&
    timing.endsAt !== undefined &&
    Date.parse(String(timing.startsAt)) > Date.parse(String(timing.endsAt))
  ) {
    throw new TypeError('timing.startsAt must not be after timing.endsAt.');
  }
}

function validateTask(value: unknown): void {
  const task = asRecord(value);
  rejectUnknownKeys(task, ['kind', 'input'], 'task');
  requireBoundedString(task.kind, 'task.kind', 256);
}

function createSchema() {
  return objectSchema(
    {
      timing: timingSchema(),
      task: taskSchema(),
      idempotencyKey: keySchema(),
      effectId: { type: 'string', minLength: 1, maxLength: 256 },
      approval: approvalSchema(),
      metadata: { type: 'object' },
    },
    ['timing', 'task', 'idempotencyKey'],
  );
}

function updateSchema() {
  return {
    ...objectSchema(
    {
      scheduleId: idSchema(),
      timing: timingSchema(),
      task: taskSchema(),
      idempotencyKey: keySchema(),
      effectId: { type: 'string', minLength: 1, maxLength: 256 },
      approval: approvalSchema(),
      metadata: { type: 'object' },
    },
    ['scheduleId', 'idempotencyKey'],
    ),
    anyOf: [{ required: ['timing'] }, { required: ['task'] }, { required: ['metadata'] }],
  } as const;
}

function scheduleIdSchema(mutation: boolean) {
  return objectSchema(
    {
      scheduleId: idSchema(),
      ...(mutation
        ? {
            idempotencyKey: keySchema(),
            effectId: { type: 'string', minLength: 1, maxLength: 256 },
            approval: approvalSchema(),
          }
        : {}),
    },
    mutation ? ['scheduleId', 'idempotencyKey'] : ['scheduleId'],
  );
}

function listSchema() {
  return objectSchema(
    {
      state: { enum: ['active', 'paused', 'completed', 'cancelled', 'failed'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', minLength: 1, maxLength: 512 },
    },
    [],
  );
}

function timingSchema() {
  return {
    oneOf: [
      objectSchema(
        { kind: { const: 'once' }, at: { type: 'string', format: 'date-time' } },
        ['kind', 'at'],
      ),
      objectSchema(
        {
          kind: { const: 'interval' },
          everyMs: { type: 'integer', minimum: 1_000 },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
        },
        ['kind', 'everyMs'],
      ),
      objectSchema(
        {
          kind: { const: 'cron' },
          expression: { type: 'string', minLength: 1, maxLength: 256 },
          timezone: { type: 'string', minLength: 1, maxLength: 128 },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
        },
        ['kind', 'expression'],
      ),
    ],
  } as const;
}

function taskSchema() {
  return objectSchema({ kind: { type: 'string', minLength: 1, maxLength: 256 }, input: {} }, [
    'kind',
  ]);
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[]) {
  return { type: 'object', required, properties, additionalProperties: false } as const;
}

function idSchema() {
  return { type: 'string', minLength: 1, maxLength: 256 } as const;
}

function keySchema() {
  return { type: 'string', minLength: 1, maxLength: 256 } as const;
}

function approvalSchema() {
  return objectSchema(
    {
      approvalId: { type: 'string', minLength: 1, maxLength: 256 },
      grantedBy: { type: 'string', minLength: 1, maxLength: 256 },
      grantedAt: { type: 'string', format: 'date-time' },
      token: { type: 'string', minLength: 1, maxLength: 4096 },
      metadata: { type: 'object' },
    },
    ['approvalId'],
  );
}

function scheduleResponseSchema() {
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
      receipt: {
        type: 'object',
        required: [
          'receiptId',
          'effectId',
          'kind',
          'idempotencyKey',
          'requestDigest',
          'principalId',
          'status',
          'startedAt',
          'completedAt',
          'durationMs',
          'replayed',
        ],
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  } as const;
}

function approvalGrant(value: unknown): RuntimeEffectApprovalGrant | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  rejectUnknownKeys(
    record,
    ['approvalId', 'grantedBy', 'grantedAt', 'token', 'metadata'],
    'approval',
  );
  if (record.grantedAt !== undefined) requireIsoDate(record.grantedAt, 'approval.grantedAt');
  return {
    approvalId: requireBoundedString(record.approvalId, 'approval.approvalId', 256),
    grantedBy: optionalBoundedString(record.grantedBy, 'approval.grantedBy', 256),
    grantedAt: optionalString(record.grantedAt, 'approval.grantedAt'),
    token: optionalBoundedString(record.token, 'approval.token', 4096),
    metadata: optionalRecord(record.metadata, 'approval.metadata'),
  };
}

function requireIsoDate(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!ISO_DATE_TIME.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new TypeError(`${label} must be an ISO date-time.`);
  }
  return text;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new TypeError(`${label} contains unknown field "${unknown}".`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
  return value;
}

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  const text = requireString(value, label);
  if (text.length > maxLength) throw new TypeError(`${label} must not exceed ${maxLength} characters.`);
  return text;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requireBoundedString(value, label, maxLength);
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
