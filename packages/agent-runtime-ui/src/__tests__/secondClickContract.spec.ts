import { describe, expect, it, vi } from 'vitest';
import type { InvocationContext, RuntimeExecResponse } from '@marshal/agent-runtime-core';
import { UiActionDispatcher } from '../actionDispatcher.js';
import type {
  UiActionIdempotencyClaim,
  UiActionIdempotencyLease,
  UiActionIdempotencyRecord,
  UiApplicationManifest,
  UiStateScope,
} from '../applicationTypes.js';

/**
 * Second-click contract pinning (runtime-click-findings.md §1-§3): these are
 * the INTENTIONAL semantics — fresh key per intent re-executes; same key with
 * the same request replays without re-executing; same key with a DIFFERENT
 * request (e.g. a varying nonce in the input) is a hard reuse error, not a
 * retry; inputs cross the dispatcher as-is (objects stay objects, declared
 * string inputs stay strings); action outputs are never recursively
 * unwrapped, so legitimate nested `value`/`output` objects survive verbatim.
 */

function manifest(overrides?: Partial<UiApplicationManifest['actions'][number]>): UiApplicationManifest {
  return {
    version: '1.0.0',
    presentationModes: ['inline'],
    actions: [{
      id: 'acknowledge',
      version: '1.0.0',
      target: { kind: 'capability', capability: 'incidents.acknowledge' },
      inputSchema: {
        type: 'object',
        properties: { incidentId: { type: 'string' }, nonce: { type: 'string' } },
        required: ['incidentId'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
      allowedScopes: ['project'],
      requiredPermissions: [],
      risk: 'write',
      idempotency: 'required',
      ...overrides,
    }],
    tools: [],
    localState: { scope: 'project', schemaVersion: '1.0.0' },
  };
}

function context(): InvocationContext {
  return {
    principal: { id: 'agent', kind: 'agent' },
    scope: { workspaceId: 'workspace', projectId: 'project-a', sessionId: 'session' },
  };
}

function executionResponse(output: unknown): RuntimeExecResponse {
  return {
    protocolVersion: '1.0.0',
    status: 'success',
    result: { output },
    receipt: {
      protocolVersion: '1.0.0', receiptId: 'target-receipt', executionId: 'execution',
      target: 'incidents.acknowledge', principalId: 'agent',
      lineage: { rootExecutionId: 'execution', depth: 0 }, status: 'success',
      startedAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-08-01T00:00:00.000Z', durationMs: 0,
    },
  };
}

class MemoryIdempotencyStore {
  private readonly records = new Map<string, UiActionIdempotencyRecord>();
  private readonly leases = new Map<string, UiActionIdempotencyLease>();
  private sequence = 0;
  async get(key: string): Promise<UiActionIdempotencyRecord | undefined> { return this.records.get(key); }
  async put(key: string, _scope: UiStateScope, record: UiActionIdempotencyRecord): Promise<void> {
    this.records.set(key, record);
  }
  async claim(
    key: string,
    _scope: UiStateScope,
    requestDigest: string,
    leaseMs: number,
  ): Promise<UiActionIdempotencyClaim> {
    const record = this.records.get(key);
    if (record) {
      if (record.requestDigest !== requestDigest) {
        throw new Error('UI action idempotency key was reused with a different request');
      }
      return { status: 'replay', record };
    }
    const current = this.leases.get(key);
    if (current && Date.parse(current.expiresAt) > Date.now()) {
      if (current.requestDigest !== requestDigest) {
        throw new Error('UI action idempotency key was reused with a different request');
      }
      return { status: 'busy', retryAfterMs: Date.parse(current.expiresAt) - Date.now() };
    }
    const lease = {
      ownerId: `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, '0')}`,
      requestDigest,
      expiresAt: new Date(Date.now() + leaseMs).toISOString(),
    };
    this.leases.set(key, lease);
    return { status: 'acquired', lease };
  }
  async renew(
    key: string,
    _scope: UiStateScope,
    lease: UiActionIdempotencyLease,
    leaseMs: number,
  ): Promise<UiActionIdempotencyLease | undefined> {
    const current = this.leases.get(key);
    if (current?.ownerId !== lease.ownerId) return undefined;
    const renewed = { ...current, expiresAt: new Date(Date.now() + leaseMs).toISOString() };
    this.leases.set(key, renewed);
    return renewed;
  }
  async complete(
    key: string,
    _scope: UiStateScope,
    lease: UiActionIdempotencyLease,
    record: UiActionIdempotencyRecord,
  ): Promise<UiActionIdempotencyRecord> {
    if (this.leases.get(key)?.ownerId !== lease.ownerId) throw new Error('lease lost');
    this.records.set(key, record);
    this.leases.delete(key);
    return record;
  }
  async release(key: string, _scope: UiStateScope, lease: UiActionIdempotencyLease): Promise<void> {
    if (this.leases.get(key)?.ownerId === lease.ownerId) this.leases.delete(key);
  }
}

function dispatcher(recordedInputs: unknown[], output: unknown = { acknowledged: true }, app = manifest()) {
  const execute = vi.fn(async (request: { input: unknown }) => {
    recordedInputs.push(request.input);
    return executionResponse(output);
  });
  return {
    execute,
    dispatcher: new UiActionDispatcher({
      loadApplication: async () => app,
      authorize: { authorize: () => ({ decision: 'allow' }) },
      executor: { execute },
      idempotencyStore: new MemoryIdempotencyStore(),
    }),
  };
}

const renderId = 'a'.repeat(64);

describe('second-click idempotency contract', () => {
  it('a fresh key per click executes every click', async () => {
    const inputs: unknown[] = [];
    const { execute, dispatcher: actions } = dispatcher(inputs);
    const first = await actions.invoke({
      renderId, actionId: 'acknowledge', input: { incidentId: 'i-1' },
      scope: 'project', idempotencyKey: 'click-1',
    }, context());
    const second = await actions.invoke({
      renderId, actionId: 'acknowledge', input: { incidentId: 'i-1' },
      scope: 'project', idempotencyKey: 'click-2',
    }, context());
    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('the same key with the SAME request replays the recorded result without re-executing', async () => {
    const inputs: unknown[] = [];
    const { execute, dispatcher: actions } = dispatcher(inputs);
    const request = {
      renderId, actionId: 'acknowledge', input: { incidentId: 'i-1' },
      scope: 'project' as const, idempotencyKey: 'double-click',
    };
    const first = await actions.invoke(request, context());
    const second = await actions.invoke(request, context());
    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    expect(second.output).toEqual(first.output);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('the same key with a DIFFERENT request (varying nonce) is a hard reuse error — intentional', async () => {
    const inputs: unknown[] = [];
    const { execute, dispatcher: actions } = dispatcher(inputs);
    await actions.invoke({
      renderId, actionId: 'acknowledge', input: { incidentId: 'i-1', nonce: 'n-1' },
      scope: 'project', idempotencyKey: 'fixed-key',
    }, context());
    const conflicting = actions.invoke({
      renderId, actionId: 'acknowledge', input: { incidentId: 'i-1', nonce: 'n-2' },
      scope: 'project', idempotencyKey: 'fixed-key',
    }, context());
    await expect(conflicting).rejects.toThrow(
      'UI action idempotency key was reused with a different request',
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('action input wire fidelity through the dispatcher', () => {
  it('object inputs reach the executor as objects for capability and module targets', async () => {
    for (const target of [
      { kind: 'capability' as const, capability: 'incidents.acknowledge' },
      { kind: 'module' as const, module: { kind: 'workspace_file' as const, path: 'backend.ts' } },
    ]) {
      const inputs: unknown[] = [];
      const { dispatcher: actions } = dispatcher(inputs, { acknowledged: true }, manifest({ target }));
      await actions.invoke({
        renderId, actionId: 'acknowledge', input: { incidentId: 'i-9', nonce: 'n' },
        scope: 'project', idempotencyKey: `object-${target.kind}`,
      }, context());
      expect(inputs).toHaveLength(1);
      expect(typeof inputs[0]).toBe('object');
      expect(inputs[0]).toEqual({ incidentId: 'i-9', nonce: 'n' });
    }
  });

  it('a declared string input stays a string — intentional, never coerced', async () => {
    const inputs: unknown[] = [];
    const { dispatcher: actions } = dispatcher(inputs, { acknowledged: true }, manifest({
      inputSchema: { type: 'string' },
      idempotency: 'supported',
    }));
    await actions.invoke({
      renderId, actionId: 'acknowledge', input: 'raw-string-payload',
      scope: 'project',
    }, context());
    expect(inputs).toEqual(['raw-string-payload']);
  });
});

describe('action result envelope', () => {
  it('preserves legitimate nested value/output objects verbatim — no recursive unwrap', async () => {
    const nested = {
      value: { output: { deep: 1 } },
      output: { value: 'legit' },
      summary: 'nested keys are data here',
    };
    const inputs: unknown[] = [];
    const { dispatcher: actions } = dispatcher(inputs, nested);
    const result = await actions.invoke({
      renderId, actionId: 'acknowledge', input: { incidentId: 'i-1' },
      scope: 'project', idempotencyKey: 'nested',
    }, context());
    expect(result.status).toBe('success');
    // Single envelope: result.output IS the capability output, untouched.
    expect(result.output).toEqual(nested);
  });
});
