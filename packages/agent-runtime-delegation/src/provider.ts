import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityInvocationResult,
  type CapabilityProvider,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import type { DelegationManager } from './manager.js';
import type { DelegationContext, DelegationSpawnRequest, JsonValue } from './types.js';

export const RUNTIME_DELEGATION_SPAWN = 'runtime.delegation.spawn';
export const RUNTIME_DELEGATION_CONTINUE = 'runtime.delegation.continue';
export const RUNTIME_DELEGATION_RECOVER = 'runtime.delegation.recover';
export const RUNTIME_DELEGATION_WAIT = 'runtime.delegation.wait';
export const RUNTIME_DELEGATION_COMPLETE = 'runtime.delegation.complete';
export const RUNTIME_DELEGATION_PAUSE = 'runtime.delegation.pause';
export const RUNTIME_DELEGATION_CANCEL = 'runtime.delegation.cancel';

const VERSION = '2.0.0';

export interface RuntimeDelegationProviderOptions {
  readonly manager: DelegationManager;
  readonly providerId?: string;
}

export function createRuntimeDelegationProvider(
  options: RuntimeDelegationProviderOptions,
): CapabilityProvider {
  return {
    id: options.providerId ?? 'marshal.delegation',
    version: VERSION,
    list: () => DESCRIPTORS,
    get: (name) => DESCRIPTORS.find((descriptor) => descriptor.name === name),
    async invoke(name, rawInput, invocation): Promise<CapabilityInvocationResult> {
      const input = asRecord(rawInput);
      const context = delegationContext(invocation);
      switch (name) {
        case RUNTIME_DELEGATION_SPAWN:
          return { output: await options.manager.spawn(spawnRequest(input), context) };
        case RUNTIME_DELEGATION_CONTINUE:
          return {
            output: await options.manager.continue(
              {
                delegationId: string(input.delegationId, 'delegationId'),
                prompt: string(input.prompt, 'prompt'),
              },
              context,
            ),
          };
        case RUNTIME_DELEGATION_RECOVER:
          return { output: await options.manager.recover({
            delegationId: string(input.delegationId, 'delegationId'),
            expectedError: jsonValue(input.expectedError),
            reason: string(input.reason, 'reason'),
            idempotencyKey: string(input.idempotencyKey, 'idempotencyKey'),
          }, context) };
        case RUNTIME_DELEGATION_WAIT:
          return {
            output: await options.manager.wait(
              { delegationId: string(input.delegationId, 'delegationId') },
              context,
            ),
          };
        case RUNTIME_DELEGATION_COMPLETE:
          return {
            output: await options.manager.complete(
              { delegationId: string(input.delegationId, 'delegationId') },
              context,
            ),
          };
        case RUNTIME_DELEGATION_PAUSE:
          return {
            output: await options.manager.pause(
              {
                delegationId: string(input.delegationId, 'delegationId'),
                reason: string(input.reason, 'reason'),
              },
              context,
            ),
          };
        case RUNTIME_DELEGATION_CANCEL:
          return {
            output: {
              cancellations: await options.manager.cancel(
                {
                  delegationId: string(input.delegationId, 'delegationId'),
                  recursive: optionalBoolean(input.recursive, 'recursive'),
                },
                context,
              ),
            },
          };
        default:
          throw new Error(`Unsupported delegation capability: ${name}`);
      }
    },
  };
}

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor(
    'spawn',
    'Spawn a delegated agent',
    'Spawn a native agent and return its runtime identity and host session handle.',
    spawnInputSchema(),
    recordSchema(),
    'runtime.delegation.spawn',
    'high',
  ),
  descriptor(
    'continue',
    'Continue delegated work',
    'Start another turn on an existing delegation.',
    objectSchema(
      {
        delegationId: identifierSchema(),
        prompt: { type: 'string', minLength: 1 },
      },
      ['delegationId', 'prompt'],
    ),
    recordSchema(true),
    'runtime.delegation.continue',
    'high',
  ),
  descriptor(
    'recover',
    'Recover an existing delegated execution',
    'Explicitly reconcile a classified failed delegation with its existing live host execution; never launch or send a turn.',
    objectSchema({ delegationId: identifierSchema(), expectedError: {},
      reason: { type: 'string', minLength: 1, maxLength: 2000 },
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 },
    }, ['delegationId', 'expectedError', 'reason', 'idempotencyKey']),
    recordSchema(),
    'runtime.delegation.continue',
    'high',
  ),
  descriptor(
    'wait',
    'Wait for delegated work',
    'Wait until a delegation reaches a terminal state.',
    objectSchema(
      {
        delegationId: identifierSchema(),
      },
      ['delegationId'],
    ),
    recordSchema(),
    'runtime.delegation.wait',
    'low',
  ),
  descriptor(
    'complete',
    'Finalize delegated work',
    'Explicitly finalize assigned work through the host, independently of conversational turn completion.',
    objectSchema({ delegationId: identifierSchema() }, ['delegationId']),
    recordSchema(),
    'runtime.delegation.complete',
    'high',
  ),
  descriptor(
    'pause',
    'Pause delegated work',
    'Cooperatively pause a delegation without changing its lifecycle state.',
    objectSchema(
      {
        delegationId: identifierSchema(),
        reason: { type: 'string', minLength: 1 },
      },
      ['delegationId', 'reason'],
    ),
    recordSchema(),
    'runtime.delegation.pause',
    'high',
  ),
  descriptor(
    'cancel',
    'Cancel delegated work',
    'Cancel one delegation or its recorded descendants.',
    objectSchema(
      {
        delegationId: identifierSchema(),
        recursive: { type: 'boolean' },
      },
      ['delegationId'],
    ),
    objectSchema(
      {
        cancellations: { type: 'array', items: recordSchema() },
      },
      ['cancellations'],
    ),
    'runtime.delegation.cancel',
    'high',
  ),
];

function descriptor(
  suffix: 'spawn' | 'continue' | 'wait' | 'complete' | 'pause' | 'cancel' | 'recover',
  title: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  outputSchema: Readonly<Record<string, unknown>>,
  permission: string,
  risk: 'low' | 'high',
): CapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: `runtime.delegation.${suffix}`,
    version: VERSION,
    title,
    description,
    tags: ['runtime', 'delegation', suffix],
    inputSchema,
    outputSchema,
    permissions: [{ permission, risk }],
  };
}

function spawnInputSchema(): Readonly<Record<string, unknown>> {
  return objectSchema(
    {
      prompt: { type: 'string', minLength: 1 },
      backend: { type: 'string', minLength: 1 },
      scope: { type: 'string', minLength: 1 },
      parentDelegationId: identifierSchema(),
      idempotencyKey: identifierSchema(),
      delegationId: identifierSchema(),
      role: { type: 'string', minLength: 1 },
      model: { type: 'string', minLength: 1 },
      reasoningEffort: { type: 'string', minLength: 1 },
      workspaceMode: { enum: ['shared', 'isolated'] },
      baseRef: { type: 'string', minLength: 1 },
      systemPrompt: { type: 'string', minLength: 1 },
      tools: { type: 'array', items: { type: 'string', minLength: 1 } },
      attachments: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
    ['prompt'],
  );
}

function recordSchema(continuation = false): Readonly<Record<string, unknown>> {
  return objectSchema(
    {
      ...(continuation ? { continuationDelivery: { enum: ['held', 'accepted'] } } : {}),
      delegationId: identifierSchema(),
      parentDelegationId: identifierSchema(),
      adapterHandle: { type: 'string' },
      state: { enum: ['pending', 'running', 'done', 'failed'] },
      result: {},
      error: {},
      changeRefs: { type: 'array', items: { type: 'string', minLength: 1 } },
      sessionId: identifierSchema(),
      executionId: identifierSchema(),
      transcriptRef: identifierSchema(),
      model: identifierSchema(),
      reasoningEffort: identifierSchema(),
      usage: objectSchema({
        inputTokens: { type: 'number', minimum: 0 },
        outputTokens: { type: 'number', minimum: 0 },
        cachedInputTokens: { type: 'number', minimum: 0 },
        costUsd: { type: 'number', minimum: 0 },
      }, []),
      usageByModel: { type: 'array', items: objectSchema({
        model: identifierSchema(),
        usage: objectSchema({
          inputTokens: { type: 'number', minimum: 0 },
          outputTokens: { type: 'number', minimum: 0 },
          cachedInputTokens: { type: 'number', minimum: 0 },
          costUsd: { type: 'number', minimum: 0 },
        }, []),
      }, ['usage']) },
      spawnFingerprint: identifierSchema(),
      finalized: { type: 'boolean' },
      recovery: objectSchema({ idempotencyKey: identifierSchema(), reason: identifierSchema(), previousError: {} }, ['idempotencyKey', 'reason', 'previousError']),
      ownerSessionId: identifierSchema(),
      ownerPrincipalId: identifierSchema(),
    },
    ['delegationId', 'state'],
  );
}

function spawnRequest(input: Record<string, unknown>): DelegationSpawnRequest {
  return {
    prompt: string(input.prompt, 'prompt'),
    backend: optionalString(input.backend, 'backend'),
    scope: optionalString(input.scope, 'scope'),
    parentDelegationId: optionalString(input.parentDelegationId, 'parentDelegationId'),
    idempotencyKey: optionalString(input.idempotencyKey, 'idempotencyKey'),
    delegationId: optionalString(input.delegationId, 'delegationId'),
    role: optionalString(input.role, 'role'),
    model: optionalString(input.model, 'model'),
    reasoningEffort: optionalString(input.reasoningEffort, 'reasoningEffort'),
    workspaceMode: optionalWorkspaceMode(input.workspaceMode),
    baseRef: optionalString(input.baseRef, 'baseRef'),
    systemPrompt: optionalString(input.systemPrompt, 'systemPrompt'),
    tools: optionalStringArray(input.tools, 'tools'),
    attachments: optionalStringArray(input.attachments, 'attachments'),
  };
}

function delegationContext(invocation: InvocationContext): DelegationContext {
  return { scope: invocation.scope, signal: invocation.signal, invocation };
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function identifierSchema(): Readonly<Record<string, unknown>> {
  return { type: 'string', minLength: 1 };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Delegation input must be an object.');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of non-empty strings.`);
  return value.map((item, index) => string(item, `${field}[${index}]`));
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean.`);
  return value;
}

function optionalWorkspaceMode(
  value: unknown,
): DelegationSpawnRequest['workspaceMode'] {
  if (value === undefined) return undefined;
  if (value !== 'shared' && value !== 'isolated') {
    throw new TypeError('workspaceMode must be "shared" or "isolated".');
  }
  return value;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  throw new TypeError('expectedError must be a JSON value.');
}
